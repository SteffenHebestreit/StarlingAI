/**
 * Approval channel dispatcher.
 *
 * Given a channel name (from scene.approvalChannel), looks up the configured
 * adapter, creates a pending approval entry, fires the notification, and
 * returns a Promise<boolean> that resolves when the user responds or times out.
 *
 * Used exclusively for webhook-triggered scenes where no WebSocket/dashboard
 * connection is available.  Webchat approvals are handled directly in rpc.ts.
 */
import { randomUUID } from "node:crypto";
import { getConfig } from "../config/loader.js";
import { createPendingApproval } from "./store.js";
import { sendSlackApproval } from "./channels/slack.js";
import { sendOutboundWebhookApproval } from "./channels/outbound-webhook.js";
import { sendSyncWebhookApproval } from "./channels/sync-webhook.js";
import { childLogger } from "../logger.js";

const log = childLogger("approval");

/**
 * Request human approval via the named channel.
 *
 * Returns:
 *   true  — user approved
 *   false — user denied, timed out, channel misconfigured, or no approval channel set
 */
export async function requestApprovalViaChannel(
  channelName: string,
  toolName: string,
  args: Record<string, unknown>,
  sceneName?: string
): Promise<boolean> {
  const config = getConfig();
  const channelConfig = config.approvalChannels?.[channelName];

  if (!channelConfig) {
    log.error({ channelName }, "Approval channel not found in config — denying");
    return false;
  }

  switch (channelConfig.type) {
    case "slack": {
      const secret = randomUUID();
      const { id, promise } = createPendingApproval({
        toolName, args, sceneName, secret,
        timeoutMs: channelConfig.timeoutMs,
      });
      await sendSlackApproval(id, secret, toolName, args, sceneName, channelConfig);
      return promise;
    }

    case "outbound_webhook": {
      // Use the channel-configured secret (resolved from env if needed)
      const secret = channelConfig.secret.startsWith("$")
        ? (process.env[channelConfig.secret.slice(1)] ?? channelConfig.secret)
        : channelConfig.secret;
      const { id, promise } = createPendingApproval({
        toolName, args, sceneName, secret,
        timeoutMs: channelConfig.timeoutMs,
      });
      await sendOutboundWebhookApproval(id, secret, toolName, args, sceneName, channelConfig);
      return promise;
    }

    case "sync_webhook":
      // Sync: no pending store entry needed — result comes back in the HTTP response
      return sendSyncWebhookApproval(toolName, args, sceneName, channelConfig);

    default:
      log.error({ channelConfig }, "Unknown approval channel type — denying");
      return false;
  }
}
