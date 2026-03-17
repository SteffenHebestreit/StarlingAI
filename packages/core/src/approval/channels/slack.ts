/**
 * Slack approval channel adapter.
 *
 * Posts a Block Kit message to a Slack Incoming Webhook URL.
 * The message contains formatted approval details and two one-click links
 * (Approve / Deny) that resolve the pending approval when the user visits them.
 *
 * No Slack app or interactive components are required — just an Incoming Webhook.
 * gateway.publicUrl must be configured so the link URLs can be constructed.
 */
import type { SlackApprovalChannelSchema } from "../../config/schema.js";
import type { z } from "zod";
import { getConfig } from "../../config/loader.js";
import { childLogger } from "../../logger.js";

const log = childLogger("approval:slack");

type SlackChannelConfig = z.infer<typeof SlackApprovalChannelSchema>;

function buildApprovalLinks(
  approvalId: string,
  secret: string,
  publicUrl: string
): { approveUrl: string; denyUrl: string } {
  const base = `${publicUrl.replace(/\/$/, "")}/api/approval/${approvalId}`;
  const approveUrl = `${base}?approved=true&secret=${encodeURIComponent(secret)}`;
  const denyUrl   = `${base}?approved=false&secret=${encodeURIComponent(secret)}`;
  return { approveUrl, denyUrl };
}

export async function sendSlackApproval(
  approvalId: string,
  secret: string,
  toolName: string,
  args: Record<string, unknown>,
  sceneName: string | undefined,
  _config: SlackChannelConfig
): Promise<void> {
  const gatewayConfig = getConfig().gateway;
  const publicUrl = gatewayConfig.publicUrl;
  if (!publicUrl) {
    log.error("gateway.publicUrl is not set — cannot construct Slack approval links");
    return;
  }

  const { approveUrl, denyUrl } = buildApprovalLinks(approvalId, secret, publicUrl);

  const argsText = Object.entries(args)
    .map(([k, v]) => `• *${k}*: ${String(v).substring(0, 200)}`)
    .join("\n") || "_no arguments_";

  const sceneNote = sceneName ? `  Scene: \`${sceneName}\`` : "";

  const payload = {
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "⚠️ Agent Approval Required", emoji: true },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `The agent wants to call \`${toolName}\`${sceneNote ? `\n${sceneNote}` : ""}`,
        },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `*Arguments:*\n${argsText}` },
      },
      { type: "divider" },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `Click a link to respond (expires in ${_config.timeoutMs / 60_000} min):\n<${approveUrl}|✅ Approve>  |  <${denyUrl}|❌ Deny>`,
        },
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `Approval ID: \`${approvalId}\`` }],
      },
    ],
  };

  try {
    const res = await fetch(_config.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      log.error({ status: res.status }, "Slack Incoming Webhook POST failed");
    } else {
      log.info({ approvalId, toolName }, "Slack approval request sent");
    }
  } catch (err) {
    log.error({ err, approvalId }, "Failed to send Slack approval request");
  }
}
