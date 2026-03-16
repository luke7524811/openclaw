import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk/feishu";
import { resolveFeishuAccount } from "./accounts.js";
import { handleFeishuMessage, type FeishuMessageEvent } from "./bot.js";
import { decodeFeishuCardAction, buildFeishuCardActionTextFallback } from "./card-interaction.js";
import {
  createApprovalCard,
  FEISHU_APPROVAL_CANCEL_ACTION,
  FEISHU_APPROVAL_CONFIRM_ACTION,
  FEISHU_APPROVAL_REQUEST_ACTION,
} from "./card-ux-approval.js";
import { sendCardFeishu, sendMessageFeishu } from "./send.js";

export type FeishuCardActionEvent = {
  operator: {
    open_id: string;
    user_id: string;
    union_id: string;
  };
  token: string;
  action: {
    value: Record<string, unknown>;
    tag: string;
  };
  context: {
    open_id: string;
    user_id: string;
    chat_id: string;
  };
};

const FEISHU_APPROVAL_CARD_TTL_MS = 5 * 60_000;
const FEISHU_CARD_ACTION_TOKEN_TTL_MS = 15 * 60_000;
const processedCardActionTokens = new Map<string, number>();

function pruneProcessedCardActionTokens(now: number): void {
  for (const [key, expireAt] of processedCardActionTokens.entries()) {
    if (expireAt <= now) {
      processedCardActionTokens.delete(key);
    }
  }
}

function claimFeishuCardActionToken(params: {
  token: string;
  accountId: string;
  now?: number;
}): boolean {
  const now = params.now ?? Date.now();
  pruneProcessedCardActionTokens(now);
  const normalizedToken = params.token.trim();
  if (!normalizedToken) {
    return true;
  }
  const key = `${params.accountId}:${normalizedToken}`;
  const existing = processedCardActionTokens.get(key);
  if (existing && existing > now) {
    return false;
  }
  processedCardActionTokens.set(key, now + FEISHU_CARD_ACTION_TOKEN_TTL_MS);
  return true;
}

function buildSyntheticMessageEvent(
  event: FeishuCardActionEvent,
  content: string,
  chatType?: "p2p" | "group",
): FeishuMessageEvent {
  return {
    sender: {
      sender_id: {
        open_id: event.operator.open_id,
        user_id: event.operator.user_id,
        union_id: event.operator.union_id,
      },
    },
    message: {
      message_id: `card-action-${event.token}`,
      chat_id: event.context.chat_id || event.operator.open_id,
      chat_type: chatType ?? (event.context.chat_id ? "group" : "p2p"),
      message_type: "text",
      content: JSON.stringify({ text: content }),
    },
  };
}

function resolveCallbackTarget(event: FeishuCardActionEvent): string {
  const chatId = event.context.chat_id?.trim();
  if (chatId) {
    return `chat:${chatId}`;
  }
  return `user:${event.operator.open_id}`;
}

async function dispatchSyntheticCommand(params: {
  cfg: ClawdbotConfig;
  event: FeishuCardActionEvent;
  command: string;
  botOpenId?: string;
  runtime?: RuntimeEnv;
  accountId?: string;
  chatType?: "p2p" | "group";
}): Promise<void> {
  await handleFeishuMessage({
    cfg: params.cfg,
    event: buildSyntheticMessageEvent(params.event, params.command, params.chatType),
    botOpenId: params.botOpenId,
    runtime: params.runtime,
    accountId: params.accountId,
  });
}

async function sendInvalidInteractionNotice(params: {
  cfg: ClawdbotConfig;
  event: FeishuCardActionEvent;
  reason: "malformed" | "stale" | "wrong_user" | "wrong_conversation";
  accountId?: string;
}): Promise<void> {
  const reasonText =
    params.reason === "stale"
      ? "This card action has expired. Open a fresh launcher card and try again."
      : params.reason === "wrong_user"
        ? "This card action belongs to a different user."
        : params.reason === "wrong_conversation"
          ? "This card action belongs to a different conversation."
          : "This card action payload is invalid.";

  await sendMessageFeishu({
    cfg: params.cfg,
    to: resolveCallbackTarget(params.event),
    text: `⚠️ ${reasonText}`,
    accountId: params.accountId,
  });
}

export async function handleFeishuCardAction(params: {
  cfg: ClawdbotConfig;
  event: FeishuCardActionEvent;
  botOpenId?: string;
  runtime?: RuntimeEnv;
  accountId?: string;
}): Promise<void> {
  const { cfg, event, runtime, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  const log = runtime?.log ?? console.log;
  const decoded = decodeFeishuCardAction({ event });
  const claimedToken = claimFeishuCardActionToken({
    token: event.token,
    accountId: account.accountId,
  });
  if (!claimedToken) {
    log(`feishu[${account.accountId}]: skipping duplicate card action token ${event.token}`);
    return;
  }

  if (decoded.kind === "invalid") {
    log(
      `feishu[${account.accountId}]: rejected card action from ${event.operator.open_id}: ${decoded.reason}`,
    );
    await sendInvalidInteractionNotice({
      cfg,
      event,
      reason: decoded.reason,
      accountId,
    });
    return;
  }

  if (decoded.kind === "structured") {
    const { envelope } = decoded;
    log(
      `feishu[${account.accountId}]: handling structured card action ${envelope.a} from ${event.operator.open_id}`,
    );

    if (envelope.a === FEISHU_APPROVAL_REQUEST_ACTION) {
      const command = typeof envelope.m?.command === "string" ? envelope.m.command.trim() : "";
      if (!command) {
        await sendInvalidInteractionNotice({
          cfg,
          event,
          reason: "malformed",
          accountId,
        });
        return;
      }
      const prompt =
        typeof envelope.m?.prompt === "string" && envelope.m.prompt.trim()
          ? envelope.m.prompt
          : `Run \`${command}\` in this Feishu conversation?`;
      await sendCardFeishu({
        cfg,
        to: resolveCallbackTarget(event),
        card: createApprovalCard({
          operatorOpenId: event.operator.open_id,
          chatId: event.context.chat_id || undefined,
          command,
          prompt,
          sessionKey: envelope.c?.s,
          expiresAt: Date.now() + FEISHU_APPROVAL_CARD_TTL_MS,
          chatType: envelope.c?.t ?? (event.context.chat_id ? "group" : "p2p"),
          confirmLabel: command === "/reset" ? "Reset" : "Confirm",
        }),
        accountId,
      });
      return;
    }

    if (envelope.a === FEISHU_APPROVAL_CANCEL_ACTION) {
      await sendMessageFeishu({
        cfg,
        to: resolveCallbackTarget(event),
        text: "Cancelled.",
        accountId,
      });
      return;
    }

    if (envelope.a === FEISHU_APPROVAL_CONFIRM_ACTION || envelope.k === "quick") {
      const command = envelope.q?.trim();
      if (!command) {
        await sendInvalidInteractionNotice({
          cfg,
          event,
          reason: "malformed",
          accountId,
        });
        return;
      }
      await dispatchSyntheticCommand({
        cfg,
        event,
        command,
        botOpenId: params.botOpenId,
        runtime,
        accountId,
        chatType: envelope.c?.t ?? (event.context.chat_id ? "group" : "p2p"),
      });
      return;
    }

    await sendInvalidInteractionNotice({
      cfg,
      event,
      reason: "malformed",
      accountId,
    });
    return;
  }

  const content = buildFeishuCardActionTextFallback(event);

  log(
    `feishu[${account.accountId}]: handling card action from ${event.operator.open_id}: ${content}`,
  );

  await dispatchSyntheticCommand({
    cfg,
    event,
    command: content,
    botOpenId: params.botOpenId,
    runtime,
    accountId,
  });
}
