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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AuditEvent } from "../audit/schema.js";
import { subscribeToAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";

import { PRODUCT } from "../product/index.js";

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
  /** Distinct-session count carried over from previous runs (ids not retained). */
  sessionsBaseline: number;
}

const _stats = new Map<string, InternalStat>();
let _unsubscribe: (() => void) | null = null;
let _startedAt: string | null = null;
let _persistedSince: string | null = null;
let _persistPath: string | null = null;
let _dirty = false;
let _saveTimer: ReturnType<typeof setInterval> | null = null;

const PERSIST_INTERVAL_MS = 60_000;
const PERSIST_VERSION = 1;

interface PersistedNetStat {
  count: number;
  firstFiredAt: string;
  lastFiredAt: string;
  sessions: number;
}

interface PersistedRecoveryStats {
  version: number;
  /** When counting first began (survives restarts). */
  since: string;
  savedAt: string;
  nets: Record<string, PersistedNetStat>;
}

function resolveStatsPath(): string {
  const explicit = process.env["SAI_RECOVERY_NET_STATS"]?.trim();
  if (explicit) return resolve(explicit);
  return resolve(process.cwd(), PRODUCT.stateDirName, "recovery-net-stats.json");
}

function loadPersistedStats(path: string): void {
  if (!existsSync(path)) return;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as PersistedRecoveryStats;
    if (parsed.version !== PERSIST_VERSION || !parsed.nets) return;
    _persistedSince = typeof parsed.since === "string" ? parsed.since : null;
    for (const [key, s] of Object.entries(parsed.nets)) {
      if (_stats.size >= MAX_KEYS) break;
      if (typeof s?.count !== "number") continue;
      _stats.set(key, {
        count: s.count,
        firstFiredAt: s.firstFiredAt,
        lastFiredAt: s.lastFiredAt,
        sessions: new Set(),
        sessionsBaseline: typeof s.sessions === "number" ? s.sessions : 0,
      });
    }
    log.info({ path, nets: _stats.size, since: _persistedSince }, "Recovery-net stats restored from disk");
  } catch (err) {
    log.warn({ err, path }, "Could not restore recovery-net stats — starting fresh");
  }
}

function savePersistedStats(): void {
  if (!_persistPath || !_dirty) return;
  try {
    const nets: Record<string, PersistedNetStat> = {};
    for (const [key, s] of _stats.entries()) {
      nets[key] = {
        count: s.count,
        firstFiredAt: s.firstFiredAt,
        lastFiredAt: s.lastFiredAt,
        sessions: s.sessionsBaseline + s.sessions.size,
      };
    }
    const payload: PersistedRecoveryStats = {
      version: PERSIST_VERSION,
      since: _persistedSince ?? _startedAt ?? new Date().toISOString(),
      savedAt: new Date().toISOString(),
      nets,
    };
    mkdirSync(dirname(_persistPath), { recursive: true });
    writeFileSync(_persistPath, JSON.stringify(payload, null, 2), "utf-8");
    _dirty = false;
  } catch (err) {
    log.warn({ err, path: _persistPath }, "Could not persist recovery-net stats");
  }
}

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
    stat = { count: 0, firstFiredAt: now, lastFiredAt: now, sessions: new Set(), sessionsBaseline: 0 };
    _stats.set(key, stat);
  }
  stat.count += 1;
  stat.lastFiredAt = now;
  if (event.sessionId && stat.sessions.size < 50) stat.sessions.add(event.sessionId);
  _dirty = true;
}

/**
 * @param options.persist Persist counters to `.starlingai/recovery-net-stats.json`
 * (or `SAI_RECOVERY_NET_STATS`) and restore them on start. Retiring a net needs
 * "this net has not fired in N weeks" — evidence that must SURVIVE gateway
 * restarts, otherwise every redeploy resets the clock and nothing can ever be
 * retired with confidence. Long-running entrypoints pass true; unit tests stay
 * in-memory by default.
 */
export function startRecoveryMetrics(options?: { persist?: boolean }): void {
  if (_unsubscribe) return;
  _startedAt = new Date().toISOString();
  if (options?.persist) {
    _persistPath = resolveStatsPath();
    loadPersistedStats(_persistPath);
    _saveTimer = setInterval(savePersistedStats, PERSIST_INTERVAL_MS);
    _saveTimer.unref?.();
  }
  _unsubscribe = subscribeToAudit(record);
  log.info({ persist: Boolean(options?.persist) }, "Recovery-net metrics subscriber started");
}

export function stopRecoveryMetrics(): void {
  if (_unsubscribe) {
    _unsubscribe();
    _unsubscribe = null;
  }
  if (_saveTimer) {
    clearInterval(_saveTimer);
    _saveTimer = null;
  }
  savePersistedStats();
  _persistPath = null;
  _persistedSince = null;
}

export interface RecoveryMetricsSnapshot {
  /** Process-start of the current subscriber. */
  since: string | null;
  /** When counting FIRST began across restarts (persisted mode only). */
  persistedSince: string | null;
  distinctNets: number;
  totalFirings: number;
  nets: RecoveryNetStat[];
}

/** Snapshot of all tracked nets, busiest first. */
export function getRecoveryMetricsSnapshot(): RecoveryMetricsSnapshot {
  const nets: RecoveryNetStat[] = [..._stats.entries()]
    .map(([key, s]) => ({ key, count: s.count, firstFiredAt: s.firstFiredAt, lastFiredAt: s.lastFiredAt, sessions: s.sessionsBaseline + s.sessions.size }))
    .sort((a, b) => b.count - a.count);
  return {
    since: _startedAt,
    persistedSince: _persistedSince,
    distinctNets: nets.length,
    totalFirings: nets.reduce((sum, n) => sum + n.count, 0),
    nets,
  };
}

export interface StaleNetsReport {
  windowDays: number;
  /** Counting must have covered at least the window for "stale" to mean anything. */
  windowCovered: boolean;
  /** Nets that fired historically but NOT within the window — retirement candidates. */
  staleNets: RecoveryNetStat[];
  activeNets: number;
}

/**
 * Retirement-candidate view: nets whose LAST firing is older than the window.
 * This is the enforcement half of the anti-accretion discipline — a recovery net
 * is removable scaffolding once the audit counter shows the root cause it patched
 * no longer occurs. Only meaningful once counting has covered the full window
 * (windowCovered), otherwise a fresh install would mark everything "stale".
 */
export function getStaleNetsReport(windowDays = 30): StaleNetsReport {
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const countingSince = Date.parse(_persistedSince ?? _startedAt ?? new Date().toISOString());
  const windowCovered = Number.isFinite(countingSince) && countingSince <= cutoff;
  const staleNets: RecoveryNetStat[] = [];
  let activeNets = 0;
  for (const [key, s] of _stats.entries()) {
    const last = Date.parse(s.lastFiredAt);
    if (Number.isFinite(last) && last < cutoff) {
      staleNets.push({ key, count: s.count, firstFiredAt: s.firstFiredAt, lastFiredAt: s.lastFiredAt, sessions: s.sessionsBaseline + s.sessions.size });
    } else {
      activeNets += 1;
    }
  }
  staleNets.sort((a, b) => Date.parse(a.lastFiredAt) - Date.parse(b.lastFiredAt));
  return { windowDays, windowCovered, staleNets, activeNets };
}

/** Reset for tests. */
export function resetRecoveryMetricsForTests(): void {
  stopRecoveryMetrics();
  _stats.clear();
  _startedAt = null;
  _dirty = false;
}
