import {
  createFeishuCardInteractionEnvelope,
  type FeishuCardInteractionEnvelope,
} from "./card-interaction.js";

export const FEISHU_APPROVAL_REQUEST_ACTION = "feishu.quick_actions.request_approval";
export const FEISHU_APPROVAL_CONFIRM_ACTION = "feishu.approval.confirm";
export const FEISHU_APPROVAL_CANCEL_ACTION = "feishu.approval.cancel";

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

export function createApprovalCard(params: {
  operatorOpenId: string;
  chatId?: string;
  command: string;
  prompt: string;
  expiresAt: number;
  chatType?: "p2p" | "group";
  sessionKey?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}): Record<string, unknown> {
  const context = {
    u: params.operatorOpenId,
    ...(params.chatId ? { h: params.chatId } : {}),
    ...(params.sessionKey ? { s: params.sessionKey } : {}),
    e: params.expiresAt,
    ...(params.chatType ? { t: params.chatType } : {}),
  };

  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
    },
    header: {
      title: {
        tag: "plain_text",
        content: "Confirm action",
      },
      template: "orange",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: params.prompt,
        },
        {
          tag: "action",
          actions: [
            buildButton({
              label: params.confirmLabel ?? "Confirm",
              type: "primary",
              value: createFeishuCardInteractionEnvelope({
                k: "quick",
                a: FEISHU_APPROVAL_CONFIRM_ACTION,
                q: params.command,
                c: context,
              }),
            }),
            buildButton({
              label: params.cancelLabel ?? "Cancel",
              value: createFeishuCardInteractionEnvelope({
                k: "button",
                a: FEISHU_APPROVAL_CANCEL_ACTION,
                c: context,
              }),
            }),
          ],
        },
      ],
    },
  };
}
