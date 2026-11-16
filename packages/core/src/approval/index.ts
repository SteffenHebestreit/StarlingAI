/**
 * Approval channel dispatcher.
 *
 * Given a channel name (from scene.approvalChannel), looks up the configured
 * adapter, creates a pending approval entry, fires the notification, and
 * returns a Promise<boolean> that resolves when the user responds or times out.
 *
 * Used for scene runs with no WebSocket/dashboard connection (REST, webhook and
 * job runs, and a run_workflow with no caller to ask), and for the
 * humanInLoopSteps of a scene that declares a channel when a chat `/run` or
 * run_workflow starts it. Other webchat approvals are handled directly in rpc.ts.
 */
import { randomUUID } from "node:crypto";
import { getConfig } from "../config/loader.js";
import { cancelPendingApproval, createPendingApproval } from "./store.js";
import { durableApprovalsEnabled, lookupApprovalDecision } from "./durable-store.js";
import { sendSlackApproval } from "./channels/slack.js";
import { sendOutboundWebhookApproval } from "./channels/outbound-webhook.js";
import { sendSyncWebhookApproval } from "./channels/sync-webhook.js";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";
import type { ApprovalCallback } from "../tools/registry.js";

const log = childLogger("approval");

/**
 * Request human approval via the named channel.
 *
 * `signal` is the run that asks. Once it stops (Stop, a superseding message, a timeout, a cancelled
 * job), nothing waits for the answer: the call is refused, and a request still pending is
 * withdrawn, so its link and the dashboard answer that it is no longer pending instead of taking a
 * decision that changes nothing.
 *
 * Returns:
 *   true  — user approved
 *   false — user denied, timed out, the run stopped, channel misconfigured, or no approval channel set
 */
export async function requestApprovalViaChannel(
  channelName: string,
  toolName: string,
  args: Record<string, unknown>,
  sceneName?: string,
  approvalTimeoutMs?: number,
  idempotencyKey?: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false;
  const config = getConfig();
  const channelConfig = config.approvalChannels?.[channelName];

  if (!channelConfig) {
    log.error({ channelName }, "Approval channel not found in config — denying");
    return false;
  }

  // Durable decision cache (opt-in, async channels): if this exact approval
  // (stable job+tool+args key) was already decided — including under a different
  // id before a gateway restart — honour that decision instead of re-prompting.
  // Fail-closed: an expired/absent decision falls through to a fresh prompt.
  if (durableApprovalsEnabled() && idempotencyKey && (channelConfig.type === "slack" || channelConfig.type === "outbound_webhook")) {
    const cached = lookupApprovalDecision(idempotencyKey);
    if (cached !== undefined) {
      logAudit("approval_resolved", {
        toolName, sceneName, approved: cached, reason: "durable_decision_reused",
      }, { severity: cached ? "info" : "warn" });
      log.info({ toolName, sceneName, approved: cached }, "Reused durable approval decision (no re-prompt)");
      return cached;
    }
  }

  switch (channelConfig.type) {
    case "slack": {
      const secret = randomUUID();
      const { id, promise } = createPendingApproval({
        toolName, args, sceneName, secret, idempotencyKey,
        timeoutMs: approvalTimeoutMs ?? channelConfig.timeoutMs,
      });
      const decision = withdrawnOnAbort(id, promise, signal);
      await sendSlackApproval(id, secret, toolName, args, sceneName, channelConfig);
      return decision;
    }

    case "outbound_webhook": {
      // Use the channel-configured secret (resolved from env if needed)
      let secret = channelConfig.secret;
      if (secret.startsWith("$")) {
        const envVal = process.env[secret.slice(1)];
        if (!envVal) {
          log.error({ envVar: secret.slice(1) }, "Approval webhook secret references unset env var — denying");
          return false;
        }
        secret = envVal;
      }
      const { id, promise } = createPendingApproval({
        toolName, args, sceneName, secret, idempotencyKey,
        timeoutMs: approvalTimeoutMs ?? channelConfig.timeoutMs,
      });
      const decision = withdrawnOnAbort(id, promise, signal);
      await sendOutboundWebhookApproval(id, secret, toolName, args, sceneName, channelConfig);
      return decision;
    }

    case "sync_webhook": {
      // Sync: no pending store entry needed — result comes back in the HTTP response
      const decision = sendSyncWebhookApproval(toolName, args, sceneName, channelConfig);
      return signal ? raceAgainstAbort(decision, signal) : decision;
    }

    default:
      log.error({ channelConfig }, "Unknown approval channel type — denying");
      return false;
  }
}

/**
 * The decision on the pending request `id`; when `signal` stops the run first, the request is
 * withdrawn (cancelPendingApproval), which refuses the call.
 */
function withdrawnOnAbort(id: string, decision: Promise<boolean>, signal: AbortSignal | undefined): Promise<boolean> {
  if (!signal) return decision;
  const withdraw = () => { cancelPendingApproval(id); };
  signal.addEventListener("abort", withdraw, { once: true });
  return decision.finally(() => signal.removeEventListener("abort", withdraw));
}

/** What a run of a scene needs to send approvals to the scene's approval channel. */
export interface SceneApprovalRoute {
  name: string;
  approvalChannel?: string;
  humanInLoopSteps?: readonly string[];
  approvalTimeoutMs?: number;
}

/**
 * The approval callback of a run of a scene that declares an approvalChannel and humanInLoopSteps:
 * each call it is asked about goes to that channel, and a run that is stopped stops waiting (the
 * call is refused and the request withdrawn). Undefined when the scene has no channel or no step to
 * ask about. The scene worker (REST, webhook and job runs) uses it for every approval of the run;
 * routeSceneStepsToChannel uses it for the scene's steps.
 *
 * `idempotencyKey` keys a call in the durable decision cache (orchestration.durableApprovals), so a
 * run that resumes after a restart is not asked again for a call already granted. Only a run that
 * can resume, under an id the server chose, passes one. A key built from an id the caller picks
 * would let that caller replay a grant: after a restart, the same id and the same call would be
 * approved with nobody asked.
 */
export function sceneChannelApprovalCallback(scene: SceneApprovalRoute, opts: {
  idempotencyKey?: (toolName: string, args: Record<string, unknown>) => string | undefined;
  signal?: AbortSignal;
} = {}): ((toolName: string, args: Record<string, unknown>) => Promise<boolean>) | undefined {
  const channel = scene.approvalChannel;
  if (!channel || !scene.humanInLoopSteps?.length) return undefined;
  return async (toolName, args) => requestApprovalViaChannel(
    channel, toolName, args, scene.name, scene.approvalTimeoutMs, opts.idempotencyKey?.(toolName, args), opts.signal,
  );
}

/**
 * The approval callback of a run of `scene` started by someone who answers its other approvals
 * (`fallback`): the chat's `/run`, and run_workflow from a turn or a sub-agent. A call the scene
 * names in humanInLoopSteps goes to the scene's approvalChannel, as on a REST, webhook or job run
 * of the scene, and not to whoever started the run; `onChannelRequest` hears of it. Every other
 * call goes to `fallback`. With no scene, or one that declares no channel or no step, this is
 * `fallback` itself. No durable-decision key: such a run does not resume after a restart.
 */
export function routeSceneStepsToChannel(
  scene: SceneApprovalRoute | undefined,
  fallback: ApprovalCallback,
  opts: { signal?: AbortSignal; onChannelRequest?: (channelName: string, toolName: string) => void } = {},
): ApprovalCallback {
  const viaChannel = scene ? sceneChannelApprovalCallback(scene, { signal: opts.signal }) : undefined;
  if (!scene || !viaChannel) return fallback;
  return async (toolName, args, request) => {
    if (!scene.humanInLoopSteps?.includes(toolName)) return fallback(toolName, args, request);
    opts.onChannelRequest?.(scene.approvalChannel!, toolName);
    return viaChannel(toolName, args);
  };
}

async function raceAgainstAbort(promise: Promise<boolean>, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;

  return new Promise<boolean>((resolve, reject) => {
    const onAbort = () => resolve(false);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}
