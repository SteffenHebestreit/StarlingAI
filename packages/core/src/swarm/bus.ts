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
import { traceContextCarrier } from "../observability/tracing.js";

const log = childLogger("swarm:bus");

// ── Event schema ────────────────────────────────────────────────────────────

export type SwarmEventType =
  | "task_announced"  // orchestrator is seeking an agent for this task
  | "task_bid"        // an agent/runtime published a ranked bid for a task
  | "task_claimed"    // an agent has started working on the task
  | "task_completed"  // agent finished successfully
  | "task_partial"    // agent returned a partial / incomplete result
  | "task_failed"     // agent returned a failure or weak result
  | "task_requeued"   // task re-queued after heartbeat loss / container timeout
  | "agent_promoted"  // ephemeral agent auto-promoted to the permanent catalog
  | "agent_message"   // direct message from one agent to another within a session
  | "agent_broadcast" // broadcast message within a session
  | "agent_capability_announce" // agent heartbeat with capabilities and load
  | "graph_started"   // task graph execution started
  | "graph_node_ready"   // a graph node's dependencies are satisfied, execution starting
  | "graph_node_blocked" // a graph node is blocked due to failed dependency
  | "graph_node_reused"  // a node was satisfied from the durable ledger (prior completed run) without re-executing
  | "graph_completed"    // task graph execution finished
  // Tool development & self-improvement events
  | "tool_dev_session_started"    // a tool dev sandbox session started
  | "tool_dev_iteration"          // a dev session iteration completed
  | "tool_dev_session_completed"  // a dev session finished (approved/rejected)
  | "tool_dev_session_stuck"      // a dev session was marked stuck or terminated
  | "tool_deployed"               // a self-developed tool was hot-deployed
  | "tool_undeployed"             // a self-developed tool was rolled back
  | "tool_promotion_nominated"    // a selfdev__ tool reached promotion eligibility threshold
  | "tool_promoted"               // a selfdev__ tool was approved and promoted to catalog
  | "capability_gap_detected"     // a new capability gap was recorded
  // Long-running task checkpoint events
  | "task_checkpoint_created"     // a long-running task started and registered a checkpoint
  | "task_checkpoint_paused"      // a task was paused mid-execution (timeout or explicit suspend)
  | "task_checkpoint_resumed"     // a paused task was resumed
  // Distributed control plane (CTL-205)
  | "session_cancel_requested"    // cancel command for a session's active turn — every process checks ownership
  | "session_cancel_applied";     // the owning process aborted the turn (ack for observability)

export interface SwarmEvent {
  id: string;
  type: SwarmEventType;
  ts: string;            // ISO 8601
  sessionId?: string;
  agentName?: string;
  taskId?: string;
  task?: string;         // first 120 chars of the task description
  data?: Record<string, unknown>;
  /** W3C trace-context carrier (traceparent/tracestate), stamped only on the
   *  causal bidding-chain events so a consumer can open a span LINKED to the
   *  producer's span. Absent when tracing is disabled or for high-volume
   *  event types (heartbeats etc.) that would blow up trace cardinality. */
  trace?: Record<string, string>;
}

/** Event types that form the causal delegation/bidding chain — the only ones
 *  we stamp with trace context (announce → bid → claim → complete). Heartbeats
 *  (agent_capability_announce), graph-node churn, and tool-dev events are
 *  deliberately excluded: they are high-volume and would explode span links. */
const CAUSAL_TRACE_EVENT_TYPES: ReadonlySet<SwarmEventType> = new Set<SwarmEventType>([
  "task_announced",
  "task_bid",
  "task_claimed",
  "task_completed",
]);

// ── Internal state ──────────────────────────────────────────────────────────

const REDIS_CHANNEL = "starlingai:swarm:events";

const _emitter = new EventEmitter();
_emitter.setMaxListeners(100);

 
let _publisher: any = null;
 
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

  // Stamp trace context on causal-chain events so a consumer can span-LINK back
  // to this producer. Never let a serialization hiccup break delegation — the
  // bus contract is "delegation never fails due to bus unavailability".
  if (!event.trace && CAUSAL_TRACE_EVENT_TYPES.has(type)) {
    try {
      const carrier = traceContextCarrier();
      if (carrier) event.trace = carrier;
    } catch { /* tracing is best-effort — never block the emit */ }
  }

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
