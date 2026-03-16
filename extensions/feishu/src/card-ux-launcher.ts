import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk/feishu";
import { sendCardFeishu } from "./send.js";
import {
  createFeishuCardInteractionEnvelope,
  type FeishuCardInteractionEnvelope,
} from "./card-interaction.js";
import { FEISHU_APPROVAL_REQUEST_ACTION } from "./card-ux-approval.js";

export const FEISHU_QUICK_ACTION_CARD_TTL_MS = 10 * 60_000;

const QUICK_ACTION_MENU_KEYS = new Set(["quick-actions", "quick_actions", "launcher"]);

function buildButton(params: {
  label: string;
  value: FeishuCardInteractionEnvelope;
  type?: "default" | "primary" | "danger";
}) {
  return {
    tag: "button",
    text: {
      tag: "plain_text",
      content: params.label,
    },
    type: params.type ?? "default",
    value: params.value,
  };
}

function buildInteractionContext(params: {
  operatorOpenId: string;
  chatId?: string;
  expiresAt: number;
  chatType?: "p2p" | "group";
  sessionKey?: string;
}) {
  return {
    u: params.operatorOpenId,
    ...(params.chatId ? { h: params.chatId } : {}),
    ...(params.sessionKey ? { s: params.sessionKey } : {}),
    e: params.expiresAt,
    ...(params.chatType ? { t: params.chatType } : {}),
  };
}

export function isFeishuQuickActionMenuEventKey(eventKey: string): boolean {
  return QUICK_ACTION_MENU_KEYS.has(eventKey.trim().toLowerCase());
}

export function createQuickActionLauncherCard(params: {
  operatorOpenId: string;
  chatId?: string;
  expiresAt: number;
  chatType?: "p2p" | "group";
  sessionKey?: string;
}): Record<string, unknown> {
  const context = buildInteractionContext(params);
  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
    },
    header: {
      title: {
        tag: "plain_text",
        content: "Quick actions",
      },
      template: "indigo",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: "Run common actions without typing raw commands.",
        },
        {
          tag: "action",
          actions: [
            buildButton({
              label: "Help",
              value: createFeishuCardInteractionEnvelope({
                k: "quick",
                a: "feishu.quick_actions.help",
                q: "/help",
                c: context,
              }),
            }),
            buildButton({
              label: "New session",
              type: "primary",
              value: createFeishuCardInteractionEnvelope({
                k: "meta",
                a: FEISHU_APPROVAL_REQUEST_ACTION,
                m: {
                  command: "/new",
                  prompt: "Start a fresh session? This will reset the current chat context.",
                },
                c: context,
              }),
            }),
            buildButton({
              label: "Reset",
              type: "danger",
              value: createFeishuCardInteractionEnvelope({
                k: "meta",
                a: FEISHU_APPROVAL_REQUEST_ACTION,
                m: {
                  command: "/reset",
                  prompt: "Reset this session now? Any active conversation state will be cleared.",
                },
                c: context,
              }),
            }),
          ],
        },
      ],
    },
  };
}

export async function maybeHandleFeishuQuickActionMenu(params: {
  cfg: ClawdbotConfig;
  eventKey: string;
  operatorOpenId: string;
  runtime?: RuntimeEnv;
  accountId?: string;
  now?: number;
}): Promise<boolean> {
  if (!isFeishuQuickActionMenuEventKey(params.eventKey)) {
    return false;
  }

  const expiresAt = (params.now ?? Date.now()) + FEISHU_QUICK_ACTION_CARD_TTL_MS;
  try {
    await sendCardFeishu({
      cfg: params.cfg,
      to: `user:${params.operatorOpenId}`,
      card: createQuickActionLauncherCard({
        operatorOpenId: params.operatorOpenId,
        expiresAt,
        chatType: "p2p",
      }),
      accountId: params.accountId,
    });
  } catch (err) {
    params.runtime?.log?.(
      `feishu[${params.accountId ?? "default"}]: failed to open quick-action launcher for ${params.operatorOpenId}: ${String(err)}`,
    );
    return false;
  }
  params.runtime?.log?.(
    `feishu[${params.accountId ?? "default"}]: opened quick-action launcher for ${params.operatorOpenId}`,
  );
  return true;
}
