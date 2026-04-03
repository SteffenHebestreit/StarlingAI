/**
 * Swarm Event Bus — Redis Pub/Sub with in-process EventEmitter fallback.
 *
 * Publishes lifecycle events for all swarm task transitions so any component
 * (Warden, analytics, future autonomous bidding agents) can react without
 * polling or coupling to the delegation internals.
 *
 * Gracefully degrades: if REDIS_URL is absent or Redis is unreachable, all
 * events are delivered in-process only. The delegation path never fails due
 * to bus unavailability.
 */
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { childLogger } from "../logger.js";

const log = childLogger("swarm:bus");

// ── Event schema ────────────────────────────────────────────────────────────

export type SwarmEventType =
  | "task_announced"  // orchestrator is seeking an agent for this task
  | "task_bid"        // an agent/runtime published a ranked bid for a task
  | "task_claimed"    // an agent has started working on the task
  | "task_completed"  // agent finished successfully
  | "task_failed"     // agent returned a failure or weak result
  | "task_requeued"   // task re-queued after heartbeat loss / container timeout
  | "agent_promoted"  // ephemeral agent auto-promoted to the permanent catalog
  | "agent_message"   // direct message from one agent to another within a session
  | "agent_broadcast" // broadcast message within a session
  | "agent_capability_announce" // agent heartbeat with capabilities and load
  | "graph_started"   // task graph execution started
  | "graph_node_ready"   // a graph node's dependencies are satisfied, execution starting
  | "graph_node_blocked" // a graph node is blocked due to failed dependency
  | "graph_completed"    // task graph execution finished
  // Tool development & self-improvement events
  | "tool_dev_session_started"    // a tool dev sandbox session started
  | "tool_dev_iteration"          // a dev session iteration completed
  | "tool_dev_session_completed"  // a dev session finished (approved/rejected)
  | "tool_dev_session_stuck"      // a dev session was marked stuck or terminated
  | "tool_deployed"               // a self-developed tool was hot-deployed
  | "tool_undeployed"             // a self-developed tool was rolled back
  | "capability_gap_detected";    // a new capability gap was recorded

export interface SwarmEvent {
  id: string;
  type: SwarmEventType;
  ts: string;            // ISO 8601
  sessionId?: string;
  agentName?: string;
  taskId?: string;
  task?: string;         // first 120 chars of the task description
  data?: Record<string, unknown>;
}

// ── Internal state ──────────────────────────────────────────────────────────

const REDIS_CHANNEL = "starlingai:swarm:events";

const _emitter = new EventEmitter();
_emitter.setMaxListeners(100);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _publisher: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _subscriber: any = null;
let _redisAvailable = false;

// ── Lifecycle ────────────────────────────────────────────────────────────────

export async function startSwarmBus(): Promise<void> {
  const url = process.env["REDIS_URL"];
  if (!url) {
    log.info("REDIS_URL not set — swarm bus running in-process only");
    return;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ioredis = await import("ioredis") as any;
    const IORedis = ioredis.default ?? ioredis;

    // Separate connections: ioredis enters subscriber-mode on .subscribe()
    _publisher = new IORedis(url, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
    _subscriber = new IORedis(url, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });

    await Promise.all([
      (_publisher as { connect: () => Promise<void> }).connect(),
      (_subscriber as { connect: () => Promise<void> }).connect(),
    ]);

    await (_subscriber as { subscribe: (ch: string) => Promise<void> }).subscribe(REDIS_CHANNEL);

    (_subscriber as EventEmitter).on("message", (channel: string, message: string) => {
      if (channel !== REDIS_CHANNEL) return;
      try {
        const event = JSON.parse(message) as SwarmEvent;
        // Prevent re-emitting events we published ourselves (loop prevention)
        _emitter.emit("remote", event);
      } catch {
        log.warn({ message }, "Failed to parse swarm bus message");
      }
    });

    _redisAvailable = true;
    log.info("Swarm bus started (Redis Pub/Sub)");
  } catch (err) {
    log.warn({ err }, "Swarm bus Redis connection failed — running in-process only");
    _publisher = null;
    _subscriber = null;
    _redisAvailable = false;
  }
}

export async function stopSwarmBus(): Promise<void> {
  _emitter.removeAllListeners();
  if (_subscriber) {
    try { await (_subscriber as { quit: () => Promise<void> }).quit(); } catch { /* ignore */ }
    _subscriber = null;
  }
  if (_publisher) {
    try { await (_publisher as { quit: () => Promise<void> }).quit(); } catch { /* ignore */ }
    _publisher = null;
  }
  _redisAvailable = false;
}

// ── Emit ─────────────────────────────────────────────────────────────────────

export function emitSwarmEvent(
  type: SwarmEventType,
  payload: Omit<SwarmEvent, "id" | "type" | "ts">,
): void {
  const event: SwarmEvent = {
    id: randomUUID(),
    type,
    ts: new Date().toISOString(),
    ...payload,
    // Truncate task description to avoid bloating Redis messages
    ...(payload.task && { task: payload.task.slice(0, 120) }),
  };

  // Always emit locally first
  _emitter.emit("event", event);

  // Broadcast to Redis if available
  if (_redisAvailable && _publisher) {
    (_publisher as { publish: (ch: string, msg: string) => Promise<void> })
      .publish(REDIS_CHANNEL, JSON.stringify(event))
      .catch((err: unknown) => {
        log.warn({ err, type }, "Failed to publish swarm event to Redis");
      });
  }

  log.debug({ type, agentName: event.agentName, taskId: event.taskId }, "Swarm event emitted");
}

// ── Subscribe ────────────────────────────────────────────────────────────────

/**
 * Subscribe to swarm events.
 * The handler receives both locally emitted and remote (Redis) events.
 * Returns an unsubscribe function.
 */
export function onSwarmEvent(handler: (event: SwarmEvent) => void): () => void {
  _emitter.on("event", handler);
  _emitter.on("remote", handler);
  return () => {
    _emitter.off("event", handler);
    _emitter.off("remote", handler);
  };
}

/** Returns true if the swarm bus has an active Redis connection. */
export function isSwarmBusConnected(): boolean {
  return _redisAvailable;
}

/** Reset all state — for use in tests only. */
export function resetSwarmBusForTests(): void {
  _emitter.removeAllListeners();
  _publisher = null;
  _subscriber = null;
  _redisAvailable = false;
}
