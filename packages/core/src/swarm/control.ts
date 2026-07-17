/**
 * Distributed control plane — cross-process session cancellation (CTL-205).
 *
 * The Warden's abort-controller registry is process-local: a cancel issued in
 * process A could never stop a turn owned by process B. This module gives every
 * cancel two delivery paths:
 *   1. IMMEDIATE — a `session_cancel_requested` swarm-bus event; every process
 *      checks ownership and only the owner aborts (then acks on the bus).
 *   2. DURABLE — a Redis marker with a TTL, checked at turn start, so a command
 *      issued while the owner was restarting still lands (catch-up).
 * Commands are idempotent (commandId dedup per process) and leave a mission
 * event when the mission store is enabled. Flag-gated: mission.control.distributedCancel.
 */
import { randomUUID } from "node:crypto";
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";
import { logAudit } from "../audit/logger.js";
import { abortSessionTurnLocally } from "../agent/warden.js";
import { emitSwarmEvent, onSwarmEvent, type SwarmEvent } from "./bus.js";
import { getMissionStore } from "./mission-store.js";
import { deriveSharedSessionId } from "../tools/memory.js";

const log = childLogger("swarm:control");

// Short TTL bounds the blast radius of a marker that outlives its target turn:
// a 10-minute marker could abort the user's NEXT unrelated turn. 30s covers the
// restart-catch-up window without ambushing future work.
const CANCEL_TTL_S = 30;
const cancelKey = (sessionId: string) => `starlingai:control:cancel:${sessionId}`;

export interface SessionCancelCommand {
  commandId: string;
  sessionId: string;
  reason: string;
  actor: string;
  ts: string;
}

// ── Redis (durable marker) ───────────────────────────────────────────────────

let _redis: any = null;
let _redisReady = false;
let _redisConnecting: Promise<unknown | null> | null = null;

async function getRedis(): Promise<unknown | null> {
  if (_redisReady) return _redis;
  if (_redisConnecting) return _redisConnecting;
  const url = process.env["REDIS_URL"];
  if (!url) return null;
  _redisConnecting = (async () => {
    try {
      const ioredis = await import("ioredis") as any;
      const IORedis = ioredis.default ?? ioredis;
      _redis = new IORedis(url, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
      await (_redis as { connect: () => Promise<void> }).connect();
      _redisReady = true;
      return _redis;
    } catch (error) {
      log.warn({ error }, "Control plane Redis connection failed — bus-only delivery");
      try { (_redis as { disconnect?: () => void } | null)?.disconnect?.(); } catch { /* ignore */ }
      _redis = null;
      return null;
    } finally {
      _redisConnecting = null;
    }
  })();
  return _redisConnecting;
}

// ── Command issue side ───────────────────────────────────────────────────────

/**
 * Request cancellation of a session's active turn, wherever it runs. Applies
 * locally at once when this process is the owner; otherwise the bus event and
 * the durable marker reach the owner (or its restart).
 */
export async function requestDistributedSessionCancel(
  sessionId: string,
  opts: { reason?: string; actor?: string } = {},
): Promise<{ commandId: string; abortedLocally: boolean }> {
  const command: SessionCancelCommand = {
    commandId: randomUUID(),
    sessionId,
    reason: opts.reason ?? "operator_cancel",
    actor: opts.actor ?? "operator",
    ts: new Date().toISOString(),
  };
  _seenCommands.add(command.commandId); // never re-apply our own bus echo

  // Durable marker first (survives a bus miss), then the immediate bus command.
  const redis = await getRedis();
  if (redis) {
    try {
      await (redis as { set: (...args: unknown[]) => Promise<unknown> })
        .set(cancelKey(sessionId), JSON.stringify(command), "EX", CANCEL_TTL_S);
    } catch (error) {
      log.warn({ error, sessionId }, "Durable cancel marker write failed — bus-only delivery");
    }
  }
  emitSwarmEvent("session_cancel_requested", {
    sessionId,
    data: { commandId: command.commandId, reason: command.reason, actor: command.actor },
  });

  const abortedLocally = abortSessionTurnLocally(sessionId, command.reason);
  if (abortedLocally) await acknowledgeCancelApplied(command);

  logAudit("session_cancel_requested", {
    commandId: command.commandId,
    reason: command.reason,
    actor: command.actor,
    abortedLocally,
  }, { sessionId, severity: "warn" });
  void appendMissionControlEvent(command, "control_cancel_requested");
  return { commandId: command.commandId, abortedLocally };
}

/** Turn-start catch-up: a durable cancel issued while the owner was down/restarting. */
export async function consumePendingSessionCancel(sessionId: string): Promise<SessionCancelCommand | null> {
  if (!distributedCancelEnabled()) return null;
  const redis = await getRedis();
  if (!redis) return null;
  try {
    // Atomic GETDEL: two turns starting concurrently must not both consume,
    // and a plain GET+DEL could erase a NEWER command written between them.
    const raw = await (redis as { getdel: (k: string) => Promise<string | null> }).getdel(cancelKey(sessionId));
    if (!raw) return null;
    const command = JSON.parse(raw) as SessionCancelCommand;
    // Staleness belt: never apply a marker older than the TTL intent.
    if (Date.now() - new Date(command.ts).getTime() > CANCEL_TTL_S * 1_000 * 2) return null;
    return command;
  } catch {
    return null;
  }
}

// ── Command apply side ───────────────────────────────────────────────────────

const _seenCommands = new Set<string>();
let _controlStop: (() => void) | null = null;

function distributedCancelEnabled(): boolean {
  try {
    return getConfig().mission.control.distributedCancel === true;
  } catch {
    return false;
  }
}

async function acknowledgeCancelApplied(command: SessionCancelCommand): Promise<void> {
  emitSwarmEvent("session_cancel_applied", {
    sessionId: command.sessionId,
    data: { commandId: command.commandId, reason: command.reason },
  });
  logAudit("session_cancel_applied", {
    commandId: command.commandId,
    reason: command.reason,
    actor: command.actor,
  }, { sessionId: command.sessionId, severity: "warn" });
  // Clear the durable marker ONLY if it is still THIS command — an unconditional
  // DEL could erase a newer cancel issued after this one was applied.
  const redis = await getRedis();
  if (redis) {
    try {
      await (redis as { eval: (...args: unknown[]) => Promise<unknown> }).eval(
        "local v = redis.call('get', KEYS[1]) if v and string.find(v, ARGV[1], 1, true) then return redis.call('del', KEYS[1]) end return 0",
        1, cancelKey(command.sessionId), command.commandId,
      );
    } catch { /* TTL bounds it */ }
  }
  void appendMissionControlEvent(command, "control_cancel_applied");
}

async function appendMissionControlEvent(command: SessionCancelCommand, type: string): Promise<void> {
  try {
    if (getConfig().mission.store === "off") return;
    const store = await getMissionStore();
    const mission = await store.getOrCreateMissionForSession({ rootSessionId: deriveSharedSessionId(command.sessionId) });
    await store.appendMissionEvent(mission.id, {
      type,
      actor: command.actor,
      payload: { reason: command.reason, sessionId: command.sessionId },
      idempotencyKey: `${type}:${command.commandId}`,
    });
  } catch { /* mission recording is observational */ }
}

/** Subscribe this process to distributed cancel commands (idempotent). */
export function startDistributedControl(): () => void {
  if (_controlStop) return _controlStop;
  const off = onSwarmEvent((event: SwarmEvent) => {
    if (event.type !== "session_cancel_requested" || !event.sessionId) return;
    const commandId = String(event.data?.["commandId"] ?? event.id);
    if (_seenCommands.has(commandId)) return; // idempotent apply
    _seenCommands.add(commandId);
    if (_seenCommands.size > 1_000) {
      const oldest = _seenCommands.values().next().value;
      if (oldest !== undefined) _seenCommands.delete(oldest);
    }
    const command: SessionCancelCommand = {
      commandId,
      sessionId: event.sessionId,
      reason: String(event.data?.["reason"] ?? "distributed_cancel"),
      actor: String(event.data?.["actor"] ?? "remote"),
      ts: event.ts,
    };
    if (abortSessionTurnLocally(command.sessionId, command.reason)) {
      void acknowledgeCancelApplied(command);
    }
  });
  _controlStop = () => {
    off();
    _controlStop = null;
  };
  log.info("Distributed control plane started (session cancel)");
  return _controlStop;
}

/** Config-gated boot hook. */
export function maybeStartDistributedControl(): void {
  if (distributedCancelEnabled()) startDistributedControl();
}

/** Reset for tests. */
export async function resetDistributedControlForTests(): Promise<void> {
  _controlStop?.();
  _seenCommands.clear();
  if (_redis) {
    try { await (_redis as { quit: () => Promise<void> }).quit(); } catch { /* ignore */ }
  }
  _redis = null;
  _redisReady = false;
  _redisConnecting = null;
}
