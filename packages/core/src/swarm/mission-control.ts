/**
 * UX-502: mission control operations (domain layer).
 *
 * Cancel semantics live here, not in the HTTP handler, so every surface — REST,
 * WS, an agent tool — shares one invariant: a mission is only marked terminally
 * `cancelled` when the cancel was actually CONFIRMED to take effect. A cancel
 * that could not be delivered (multi-process deployment, the owning turn on
 * another node, and `mission.control.distributedCancel` disabled) returns
 * `unconfirmed` and leaves the mission running — never a false terminal that
 * blocks every retry.
 */
import { getConfig } from "../config/loader.js";
import { logAudit } from "../audit/logger.js";
import { getMissionStore, type MissionStatus } from "./mission-store.js";
import { requestDistributedSessionCancel } from "./control.js";

export type CancelMissionResult =
  | { outcome: "cancelled"; commandId: string; abortedLocally: boolean }
  | { outcome: "unconfirmed"; commandId: string; reason: string }
  | { outcome: "already_terminal"; status: MissionStatus }
  | { outcome: "not_found" };

function isTerminal(status: MissionStatus): boolean {
  return status === "cancelled" || status === "completed" || status === "failed";
}

/**
 * Cancel a mission by distributed-cancelling its root session, and record a
 * terminal `mission_cancelled` event ONLY when the cancel is confirmed to take
 * effect. Idempotent: a mission already terminal is a no-op success.
 */
export async function cancelMission(
  missionId: string,
  opts: { actor: string; reason?: string },
): Promise<CancelMissionResult> {
  const store = await getMissionStore();
  const mission = await store.getMission(missionId);
  if (!mission) return { outcome: "not_found" };
  if (isTerminal(mission.status)) return { outcome: "already_terminal", status: mission.status };

  const reason = opts.reason?.trim() ? opts.reason.trim().slice(0, 200) : "operator_cancel";

  // requestDistributedSessionCancel always writes the durable marker, emits the
  // bus command, and aborts locally if THIS process owns the turn. Whether any
  // OTHER process will honor it depends on the distributedCancel flag (it gates
  // both the bus subscriber and the turn-start catch-up). So the cancel is
  // confirmed when we aborted it here, or when the flag guarantees delivery.
  const distributedEnabled = getConfig().mission.control?.distributedCancel === true;
  const cancel = await requestDistributedSessionCancel(mission.rootSessionId, { reason, actor: opts.actor });
  const confirmed = cancel.abortedLocally || distributedEnabled;

  if (!confirmed) {
    const detail = "the owning turn is on another process and mission.control.distributedCancel is disabled — the turn was not stopped";
    logAudit("mission_cancel_unconfirmed", {
      missionId, rootSessionId: mission.rootSessionId, actor: opts.actor, reason, commandId: cancel.commandId,
    }, { sessionId: mission.rootSessionId, severity: "warn" });
    return { outcome: "unconfirmed", commandId: cancel.commandId, reason: detail };
  }

  // Terminal event is idempotency-keyed, so a retry cannot append a second one.
  await store.appendMissionEvent(missionId, {
    type: "mission_cancelled",
    actor: opts.actor,
    payload: { reason, commandId: cancel.commandId, abortedLocally: cancel.abortedLocally },
    idempotencyKey: `mission_cancelled:${missionId}`,
  }).catch(() => { /* projection append is best-effort; the cancel command already fired */ });

  logAudit("mission_cancelled_by_operator", {
    missionId, rootSessionId: mission.rootSessionId, actor: opts.actor, reason, commandId: cancel.commandId,
  }, { sessionId: mission.rootSessionId, severity: "warn" });

  return { outcome: "cancelled", commandId: cancel.commandId, abortedLocally: cancel.abortedLocally };
}
