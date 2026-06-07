/**
 * Recovery-net metrics — make the orchestration autopilots VISIBLE.
 *
 * The runtime rewrites/blocks/forces the model's tool calls through ~34 distinct
 * recovery "nets" (source-sensitive enforcement, required-research rerouting,
 * parallel-slice collapse, coordinator-recursion blocks, synthesis forcing, LRG
 * timeouts, evidence backstops, …). Each one already emits an audit event, but
 * there is no aggregated view of WHICH nets actually fire — so nobody can tell a
 * load-bearing net from dead scaffolding, and the thicket only grows. The
 * architecture audit's prescription was exactly this: "treat backstops as
 * removable scaffolding with audit counters."
 *
 * This module is a passive subscriber on the audit stream (no edits to the 34
 * call sites). It counts firings per net key so the dashboard / an endpoint can
 * show, over a run's lifetime, which nets fire, how often, and how recently —
 * the evidence needed to retire the dead ones with confidence.
 */
import type { AuditEvent } from "../audit/schema.js";
import { subscribeToAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";

const log = childLogger("observability:recovery-metrics");

/** Audit event types that represent a recovery/intervention "net" firing. */
const RECOVERY_EVENT_TYPES = new Set<string>([
  "tool_call_recovered",
  "tool_call_blocked",
  "guardrail_flagged",
  "guardrail_blocked",
  "tool_output_blocked",
  "delegation_coordinator_recursion_blocked",
  "delegation_halted_partial_evidence",
  "delegation_render_research_redirect_skipped",
  "sub_agent_synthesis_forced",
  "sub_agent_max_iterations",
  "long_running_generation_timeout",
  "long_running_generation_auto_stopped",
  "event_loop_lag",
  "provider_stall",
]);

const MAX_KEYS = 300;

export interface RecoveryNetStat {
  key: string;
  count: number;
  firstFiredAt: string;
  lastFiredAt: string;
  /** Distinct turn/root sessions that saw this net fire (capped sample). */
  sessions: number;
}

interface InternalStat {
  count: number;
  firstFiredAt: string;
  lastFiredAt: string;
  sessions: Set<string>;
}

const _stats = new Map<string, InternalStat>();
let _unsubscribe: (() => void) | null = null;
let _startedAt: string | null = null;

/** Derive a stable per-net key from an audit event, or null if it isn't a net. */
export function deriveNetKey(event: Pick<AuditEvent, "type" | "data">): string | null {
  const { type, data } = event;
  const d = (data ?? {}) as Record<string, unknown>;

  // A sub-agent tool call only counts when it was itself a recovery rewrite.
  if (type === "sub_agent_tool_call") {
    if (d["phase"] === "recovered" && typeof d["reason"] === "string") {
      return `sub_agent_tool_call:recovered:${d["reason"]}`;
    }
    return null;
  }

  if (!RECOVERY_EVENT_TYPES.has(type)) return null;

  // Pick the most specific sub-discriminator the event carries.
  const sub = [d["reason"], d["type"], d["details"], d["appliedOutcome"], d["state"]]
    .find((v): v is string => typeof v === "string" && v.length > 0);
  return sub ? `${type}:${sub}` : type;
}

function record(event: AuditEvent): void {
  const key = deriveNetKey(event);
  if (!key) return;
  const now = event.timestamp || new Date().toISOString();
  let stat = _stats.get(key);
  if (!stat) {
    if (_stats.size >= MAX_KEYS) return; // bounded; never grows unbounded
    stat = { count: 0, firstFiredAt: now, lastFiredAt: now, sessions: new Set() };
    _stats.set(key, stat);
  }
  stat.count += 1;
  stat.lastFiredAt = now;
  if (event.sessionId && stat.sessions.size < 50) stat.sessions.add(event.sessionId);
}

export function startRecoveryMetrics(): void {
  if (_unsubscribe) return;
  _startedAt = new Date().toISOString();
  _unsubscribe = subscribeToAudit(record);
  log.info("Recovery-net metrics subscriber started");
}

export function stopRecoveryMetrics(): void {
  if (_unsubscribe) {
    _unsubscribe();
    _unsubscribe = null;
  }
}

export interface RecoveryMetricsSnapshot {
  since: string | null;
  distinctNets: number;
  totalFirings: number;
  nets: RecoveryNetStat[];
}

/** Snapshot of all tracked nets, busiest first. */
export function getRecoveryMetricsSnapshot(): RecoveryMetricsSnapshot {
  const nets: RecoveryNetStat[] = [..._stats.entries()]
    .map(([key, s]) => ({ key, count: s.count, firstFiredAt: s.firstFiredAt, lastFiredAt: s.lastFiredAt, sessions: s.sessions.size }))
    .sort((a, b) => b.count - a.count);
  return {
    since: _startedAt,
    distinctNets: nets.length,
    totalFirings: nets.reduce((sum, n) => sum + n.count, 0),
    nets,
  };
}

/** Reset for tests. */
export function resetRecoveryMetricsForTests(): void {
  stopRecoveryMetrics();
  _stats.clear();
  _startedAt = null;
}
