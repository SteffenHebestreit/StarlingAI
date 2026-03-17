/**
 * Outbound webhook approval channel adapter.
 *
 * POSTs a rich JSON payload to any URL — perfect for n8n workflows that then
 * fan out to WhatsApp (via Twilio / Meta Cloud API), email, SMS, or any other
 * messaging platform.
 *
 * The payload includes:
 *   - approveUrl / denyUrl  — one-click links the end-user can tap directly
 *   - callbackUrl           — programmatic POST-back URL for the receiving system
 *   - callbackSecret        — must be sent back as X-Approval-Secret header
 *
 * gateway.publicUrl must be configured so these URLs can be constructed.
 */
import type { OutboundWebhookApprovalChannelSchema } from "../../config/schema.js";
import type { z } from "zod";
import { getConfig } from "../../config/loader.js";
import { childLogger } from "../../logger.js";

const log = childLogger("approval:outbound-webhook");

type OutboundConfig = z.infer<typeof OutboundWebhookApprovalChannelSchema>;

export async function sendOutboundWebhookApproval(
  approvalId: string,
  secret: string,
  toolName: string,
  args: Record<string, unknown>,
  sceneName: string | undefined,
  config: OutboundConfig
): Promise<void> {
  const publicUrl = getConfig().gateway.publicUrl;
  if (!publicUrl) {
    log.error("gateway.publicUrl is not set — cannot construct approval callback URLs");
    return;
  }

  const base = `${publicUrl.replace(/\/$/, "")}/api/approval/${approvalId}`;
  const callbackUrl = base;
  const approveUrl  = `${base}?approved=true&secret=${encodeURIComponent(secret)}`;
  const denyUrl     = `${base}?approved=false&secret=${encodeURIComponent(secret)}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(config.headers ?? {}),
  };
  // Resolve $ENV_VAR references in header values
  for (const [k, v] of Object.entries(headers)) {
    if (v.startsWith("$")) headers[k] = process.env[v.slice(1)] ?? "";
  }

  const payload = {
    approvalId,
    toolName,
    args,
    sceneName,
    message: `Approval required: the agent wants to call \`${toolName}\`${sceneName ? ` (scene: ${sceneName})` : ""}`,
    callbackUrl,
    callbackSecret: secret,
    approveUrl,
    denyUrl,
    expiresInMs: config.timeoutMs,
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(config.url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      log.error({ status: res.status, approvalId }, "Outbound approval webhook POST failed");
    } else {
      log.info({ approvalId, toolName, url: config.url }, "Outbound approval webhook sent");
    }
  } catch (err) {
    log.error({ err, approvalId }, "Failed to send outbound approval webhook");
  }
}
