/**
 * Sync webhook approval channel adapter.
 *
 * POSTs the approval request and expects the server to respond synchronously
 * with { approved: boolean }.  Useful for internal approval systems (e.g. a
 * rules engine, a manager dashboard that evaluates the request on load, or a
 * test harness).
 *
 * The call blocks until the response arrives or the timeout fires (→ denied).
 */
import type { SyncWebhookApprovalChannelSchema } from "../../config/schema.js";
import type { z } from "zod";
import { childLogger } from "../../logger.js";

const log = childLogger("approval:sync-webhook");

type SyncConfig = z.infer<typeof SyncWebhookApprovalChannelSchema>;

export async function sendSyncWebhookApproval(
  toolName: string,
  args: Record<string, unknown>,
  sceneName: string | undefined,
  config: SyncConfig
): Promise<boolean> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(config.headers ?? {}),
  };
  for (const [k, v] of Object.entries(headers)) {
    if (v.startsWith("$")) headers[k] = process.env[v.slice(1)] ?? "";
  }

  const payload = {
    toolName,
    args,
    sceneName,
    message: `Approval required: the agent wants to call \`${toolName}\`${sceneName ? ` (scene: ${sceneName})` : ""}`,
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    const res = await fetch(config.url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      log.error({ status: res.status, toolName }, "Sync approval webhook returned error — denying");
      return false;
    }

    const body = await res.json() as { approved?: boolean };
    const approved = body.approved === true;
    log.info({ toolName, sceneName, approved }, "Sync approval webhook responded");
    return approved;
  } catch (err) {
    log.error({ err, toolName }, "Sync approval webhook failed — denying");
    return false;
  }
}
