/**
 * Cost governance — aggregates token usage from audit events into
 * time-bucketed rollups, prices each bucket against the configured
 * per-model rate card, and emits `cost_budget_threshold` audit events
 * when a deployment is approaching or has crossed its daily/monthly cap.
 *
 * The data flows through the existing audit bus — `turn_performance`
 * (orchestrator turns) and `sub_agent_completed` (delegated specialists)
 * both carry `{ usage: {promptTokens, completionTokens, totalTokens},
 * model }`.  We sum them in-process with bounded rings; persisting the
 * full audit log to disk remains the source of truth for replay.
 *
 * No-op when `cost.enabled` is false.
 */

import { subscribeToAudit, logAudit } from "../audit/logger.js";
import type { AuditEvent } from "../audit/schema.js";
import { getConfig } from "../config/loader.js";
import type { CostConfig } from "../config/schema.js";
import { childLogger } from "../logger.js";

const log = childLogger("cost");

const MS_PER_DAY = 86_400_000;
const DEFAULT_DAY_BUCKET_CAP = 90;
const DEFAULT_HOUR_BUCKET_CAP = 168; // 1 week of hours

// ── Default rate card ─────────────────────────────────────────────────────────
//
// Per-1M-token rates in USD as of 2026-04.  Operators override via
// config.cost.models[] — a regex that matches the `model` field in stats.
// First match wins; an empty rate card means cost stays $0 even though token
// totals are still tracked (sometimes operators just want the volume view).

const DEFAULT_RATE_CARD: { matches: string; promptPer1m: number; completionPer1m: number; label?: string }[] = [
  // Claude 4.x family — verified Anthropic rates (2026). Opus / Sonnet / Haiku differ;
  // the previous single `^claude-(opus|sonnet|haiku)-?4` row billed Opus AND Haiku at
  // the Sonnet $3/$15 rate (Opus ~40% undercount, and budget alerts fired off it).
  // First match wins, so the bare 4.x ids resolve here before the Claude-3 rows.
  { matches: "^claude-opus-4", promptPer1m: 5, completionPer1m: 25, label: "Claude Opus 4.x" },
  { matches: "^claude-sonnet-4", promptPer1m: 3, completionPer1m: 15, label: "Claude Sonnet 4.x" },
  { matches: "^claude-haiku-4", promptPer1m: 1, completionPer1m: 5, label: "Claude Haiku 4.x" },
  // Claude Fable 5: public rate not wired here yet — add a row when known (no match = $0).
  { matches: "^claude-3-5-sonnet", promptPer1m: 3, completionPer1m: 15 },
  { matches: "^claude-3-5-haiku", promptPer1m: 1, completionPer1m: 5 },
  { matches: "^claude-3-(opus|sonnet)", promptPer1m: 15, completionPer1m: 75 },
  { matches: "^gpt-4o-mini", promptPer1m: 0.15, completionPer1m: 0.6 },
  { matches: "^gpt-4o", promptPer1m: 2.5, completionPer1m: 10 },
  { matches: "^gpt-4-turbo", promptPer1m: 10, completionPer1m: 30 },
  { matches: "^gpt-4", promptPer1m: 30, completionPer1m: 60 },
  { matches: "^gpt-3.5", promptPer1m: 0.5, completionPer1m: 1.5 },
  { matches: "^o1-preview", promptPer1m: 15, completionPer1m: 60 },
  { matches: "^o1-mini", promptPer1m: 3, completionPer1m: 12 },
  // Locally-served models cost $0 — label them so the dashboard distinguishes a free
  // LOCAL model from an unpriced/unknown cloud one (which also shows $0 via no-match).
  // Last so the anchored cloud rows above always win for cloud ids.
  { matches: "(qwen|glm|deepseek|gpt-oss|gemma|llama|mistral|mixtral|phi|command-r)", promptPer1m: 0, completionPer1m: 0, label: "Local model" },
];

// ── State ─────────────────────────────────────────────────────────────────────

interface UsageRecord {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCost: number;
  /** Number of contributing audit events.  Useful for averaging. */
  count: number;
}

interface DayBucket extends UsageRecord {
  /** ISO date `YYYY-MM-DD` (UTC). */
  day: string;
  bySource: Map<string, UsageRecord>; // session / agent / model
}

interface HourBucket extends UsageRecord {
  /** ISO hour `YYYY-MM-DDTHH` (UTC). */
  hour: string;
}

const _byDay = new Map<string, DayBucket>();
const _byHour = new Map<string, HourBucket>();
const _bySession = new Map<string, UsageRecord & { lastSeen: string }>();
const _byAgent = new Map<string, UsageRecord & { lastSeen: string }>();
const _byModel = new Map<string, UsageRecord & { lastSeen: string }>();

let _subscribeUnsub: (() => void) | null = null;
let _lastBudgetWarn: { day: string; bucket: "soft" | "hard" } | null = null;
let _lastMonthlyBudgetWarn: { month: string; bucket: "soft" | "hard" } | null = null;

// ── Public API ────────────────────────────────────────────────────────────────

export interface CostBucket {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCost: number;
  count: number;
}

export interface CostByDayEntry extends CostBucket {
  day: string;
}

export interface CostBySourceEntry extends CostBucket {
  source: string;
  lastSeen: string;
}

export interface CostSummary {
  rangeDays: number;
  totalTokens: number;
  totalCost: number;
  currency: string;
  byDay: CostByDayEntry[];
  byAgent: CostBySourceEntry[];
  byModel: CostBySourceEntry[];
  bySession: CostBySourceEntry[];
}

export interface CostProjection {
  windowDays: number;
  averageDailyCost: number;
  projectedMonthlyCost: number;
  currency: string;
}

/** Start the aggregator.  Idempotent — safe to call from bootstrap and tests. */
export function startCostAggregator(): void {
  if (_subscribeUnsub) return;
  const startedAt = Date.now();
  _subscribeUnsub = subscribeToAudit(handleEvent);
  // Rehydrate the day/month rollups from the persisted audit log so a restart doesn't
  // silently reset the (potentially HARD) budget gate to $0 — the in-memory rings are
  // otherwise empty on boot, so cost.enforce would re-open a spent monthly cap and a
  // crash-looping gateway would never enforce it at all. Only events strictly BEFORE
  // this start are replayed, so live events (which are also appended to the log) can't
  // be double-counted. Best-effort + async: a missing log just means the gate starts cold.
  void rehydrateFromAuditLog(startedAt).catch((err) =>
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "cost rehydration failed — budget gate starts from empty"));
  log.debug("Cost aggregator started — subscribed to audit bus");
}

/** Replay usage events from the persisted audit log into the in-memory rollups.
 *  Streams the JSONL log line-by-line (bounded memory) and ingests only usage-bearing
 *  events older than `before` and within the day-bucket retention window. */
async function rehydrateFromAuditLog(before: number): Promise<void> {
  if (!getConfig().cost.enabled) return;
  const { resolveAuditLogPath } = await import("../audit/logger.js");
  const { existsSync, createReadStream } = await import("node:fs");
  const { createInterface } = await import("node:readline");
  const path = resolveAuditLogPath();
  if (!existsSync(path)) return;
  const cutoff = before - DEFAULT_DAY_BUCKET_CAP * MS_PER_DAY;
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf-8" }), crlfDelay: Infinity });
  let replayed = 0;
  for await (const line of rl) {
    if (!line) continue;
    let event: AuditEvent;
    try { event = JSON.parse(line) as AuditEvent; } catch { continue; }
    if (event.type !== "turn_performance" && event.type !== "sub_agent_completed") continue;
    const ts = new Date(event.timestamp).getTime();
    if (!Number.isFinite(ts) || ts >= before || ts < cutoff) continue;
    handleEvent(event, { rehydrate: true });
    replayed++;
  }
  if (replayed > 0) log.info({ replayed }, "Cost aggregator rehydrated rollups from the audit log");
}

/** Stop the aggregator and detach the audit subscription. */
export function stopCostAggregator(): void {
  if (_subscribeUnsub) { _subscribeUnsub(); _subscribeUnsub = null; }
}

/** Test-only — await a rehydration pass directly (startCostAggregator fires it async). */
export function _rehydrateFromAuditLogForTests(before: number): Promise<void> {
  return rehydrateFromAuditLog(before);
}

/** Test-only — wipe all bucket state. */
export function _resetCostStateForTests(): void {
  _byDay.clear();
  _byHour.clear();
  _bySession.clear();
  _byAgent.clear();
  _byModel.clear();
  _lastBudgetWarn = null;
  _lastMonthlyBudgetWarn = null;
  if (_subscribeUnsub) { _subscribeUnsub(); _subscribeUnsub = null; }
}

/** Build the rolling-window summary used by the dashboard endpoint. */
export function getCostSummary(rangeDays = 30): CostSummary {
  const cfg = getConfig().cost;
  const windowMs = Math.max(1, rangeDays) * MS_PER_DAY;
  const cutoff = Date.now() - windowMs;
  const cutoffDay = formatDay(new Date(cutoff));

  const byDay: CostByDayEntry[] = [];
  let totalTokens = 0;
  let totalCost = 0;
  for (const [day, bucket] of _byDay) {
    if (day < cutoffDay) continue;
    byDay.push({ day, ...emitBucket(bucket) });
    totalTokens += bucket.totalTokens;
    totalCost += bucket.estimatedCost;
  }
  byDay.sort((a, b) => a.day.localeCompare(b.day));

  return {
    rangeDays,
    totalTokens,
    totalCost: round2(totalCost),
    currency: cfg.currency,
    byDay,
    byAgent: topBySource(_byAgent, cutoff, 25),
    byModel: topBySource(_byModel, cutoff, 25),
    bySession: topBySource(_bySession, cutoff, 25),
  };
}

/**
 * Project monthly cost from the average of the last `windowDays` days of
 * spend.  Conservative — uses days that have already happened (not the
 * trailing partial day) so a single spike doesn't extrapolate to the moon.
 */
export function getCostProjection(windowDays = 7): CostProjection {
  const cfg = getConfig().cost;
  const today = formatDay(new Date());
  const cutoff = formatDay(new Date(Date.now() - Math.max(1, windowDays) * MS_PER_DAY));
  let total = 0;
  let counted = 0;
  for (const [day, bucket] of _byDay) {
    if (day === today) continue; // skip in-progress day
    if (day < cutoff) continue;
    total += bucket.estimatedCost;
    counted += 1;
  }
  const avg = counted > 0 ? total / counted : 0;
  return {
    windowDays: counted,
    averageDailyCost: round2(avg),
    projectedMonthlyCost: round2(avg * 30),
    currency: cfg.currency,
  };
}

// ── Budget enforcement gate ────────────────────────────────────────────────────

export interface BudgetGateStatus {
  /** True when a hard budget has been reached and enforcement is on. */
  blocked: boolean;
  scope?: "daily" | "monthly";
  spend?: number;
  budget?: number;
  currency?: string;
}

const NOT_BLOCKED: BudgetGateStatus = { blocked: false };

/**
 * Pre-turn cost gate. Returns `{ blocked: true, ... }` when cost tracking AND
 * enforcement are both enabled and the current day's OR month's priced spend has
 * reached the corresponding hard budget. A $0 budget for a scope is "no limit"
 * and never blocks. Alert-only deployments (`enforce: false`) always return
 * not-blocked — the audit thresholds still fire independently. Pure read of the
 * in-process rollups; no side effects, safe to call on every turn.
 */
export function getBudgetGateStatus(now: Date = new Date()): BudgetGateStatus {
  const cfg = getConfig().cost;
  if (!cfg.enabled || !cfg.enforce) return NOT_BLOCKED;

  const today = formatDay(now);
  // Daily takes precedence — it is the tighter window and resets sooner.
  if (cfg.budgets.dailyUsd > 0) {
    const spend = _byDay.get(today)?.estimatedCost ?? 0;
    if (spend >= cfg.budgets.dailyUsd) {
      return { blocked: true, scope: "daily", spend: round2(spend), budget: cfg.budgets.dailyUsd, currency: cfg.currency };
    }
  }
  if (cfg.budgets.monthlyUsd > 0) {
    const monthKey = today.slice(0, 7);
    let monthSpend = 0;
    for (const [day, bucket] of _byDay) {
      if (day.startsWith(monthKey)) monthSpend += bucket.estimatedCost;
    }
    if (monthSpend >= cfg.budgets.monthlyUsd) {
      return { blocked: true, scope: "monthly", spend: round2(monthSpend), budget: cfg.budgets.monthlyUsd, currency: cfg.currency };
    }
  }
  return NOT_BLOCKED;
}

// ── Event ingestion ──────────────────────────────────────────────────────────

function handleEvent(event: AuditEvent, opts?: { rehydrate?: boolean }): void {
  const cfg = getConfig().cost;
  if (!cfg.enabled) return;

  let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
  let agentName: string | null = null;
  let model: string | null = null;

  if (event.type === "sub_agent_completed") {
    const data = event.data;
    usage = extractUsage(data["usage"]);
    if (typeof data["agentName"] === "string") agentName = data["agentName"];
    if (typeof data["model"] === "string") model = data["model"];
  } else if (event.type === "turn_performance") {
    const data = event.data;
    usage = extractUsage(data["usage"]);
    // Orchestrator runs surface as agent="orchestrator" so the rollup
    // separates them from delegated specialists.
    agentName = "orchestrator";
    if (typeof data["model"] === "string") {
      model = data["model"];
    } else {
      // turn_performance often nests model under performance metadata; best-
      // effort scan a couple known shapes without throwing.
      const perf = data["performance"] as Record<string, unknown> | undefined;
      if (perf && typeof perf["model"] === "string") model = perf["model"];
    }
  } else {
    return;
  }

  if (!usage || usage.totalTokens <= 0) return;

  const cost = priceUsage(model ?? "", usage.promptTokens, usage.completionTokens, cfg);
  const day = formatDay(new Date(event.timestamp));
  const hour = formatHour(new Date(event.timestamp));
  const sessionId = event.sessionId ?? "unknown";

  ingestDay(day, usage, cost);
  ingestHour(hour, usage, cost);
  ingestSource(_bySession, sessionId, usage, cost, event.timestamp);
  if (agentName) ingestSource(_byAgent, agentName, usage, cost, event.timestamp);
  if (model) ingestSource(_byModel, model, usage, cost, event.timestamp);
  // Per-day bySource map (currently unused but cheap to populate so we have
  // it on hand if a future endpoint wants per-day-per-agent slicing)
  const dayBucket = _byDay.get(day);
  if (dayBucket) {
    accumulate(getOrCreate(dayBucket.bySource, sessionId), usage, cost);
    if (agentName) accumulate(getOrCreate(dayBucket.bySource, `agent:${agentName}`), usage, cost);
    if (model) accumulate(getOrCreate(dayBucket.bySource, `model:${model}`), usage, cost);
  }

  // Don't re-fire historical budget alerts while replaying the audit log at boot.
  if (!opts?.rehydrate) void maybeFireBudgetAlert(cfg, day);
}

function extractUsage(raw: unknown): { promptTokens: number; completionTokens: number; totalTokens: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  const prompt = Number(u["promptTokens"]);
  const completion = Number(u["completionTokens"]);
  const total = Number(u["totalTokens"]);
  if (!Number.isFinite(prompt) || !Number.isFinite(completion) || !Number.isFinite(total)) return null;
  return {
    promptTokens: Math.max(0, prompt),
    completionTokens: Math.max(0, completion),
    totalTokens: Math.max(0, total),
  };
}

function ingestDay(day: string, usage: { promptTokens: number; completionTokens: number; totalTokens: number }, cost: number): void {
  let bucket = _byDay.get(day);
  if (!bucket) {
    bucket = { day, promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0, count: 0, bySource: new Map() };
    _byDay.set(day, bucket);
    if (_byDay.size > DEFAULT_DAY_BUCKET_CAP) evictOldest(_byDay);
  }
  accumulate(bucket, usage, cost);
}

function ingestHour(hour: string, usage: { promptTokens: number; completionTokens: number; totalTokens: number }, cost: number): void {
  let bucket = _byHour.get(hour);
  if (!bucket) {
    bucket = { hour, promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0, count: 0 };
    _byHour.set(hour, bucket);
    if (_byHour.size > DEFAULT_HOUR_BUCKET_CAP) evictOldest(_byHour);
  }
  accumulate(bucket, usage, cost);
}

function ingestSource(
  store: Map<string, UsageRecord & { lastSeen: string }>,
  key: string,
  usage: { promptTokens: number; completionTokens: number; totalTokens: number },
  cost: number,
  timestamp: string,
): void {
  let bucket = store.get(key);
  if (!bucket) {
    bucket = { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0, count: 0, lastSeen: timestamp };
    store.set(key, bucket);
  }
  accumulate(bucket, usage, cost);
  bucket.lastSeen = timestamp;
}

function accumulate(bucket: UsageRecord, usage: { promptTokens: number; completionTokens: number; totalTokens: number }, cost: number): void {
  bucket.promptTokens += usage.promptTokens;
  bucket.completionTokens += usage.completionTokens;
  bucket.totalTokens += usage.totalTokens;
  bucket.estimatedCost += cost;
  bucket.count += 1;
}

function getOrCreate(map: Map<string, UsageRecord>, key: string): UsageRecord {
  let v = map.get(key);
  if (!v) {
    v = { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0, count: 0 };
    map.set(key, v);
  }
  return v;
}

function emitBucket(b: UsageRecord): CostBucket {
  return {
    promptTokens: b.promptTokens,
    completionTokens: b.completionTokens,
    totalTokens: b.totalTokens,
    estimatedCost: round2(b.estimatedCost),
    count: b.count,
  };
}

function topBySource(store: Map<string, UsageRecord & { lastSeen: string }>, cutoff: number, limit: number): CostBySourceEntry[] {
  const entries: CostBySourceEntry[] = [];
  for (const [source, bucket] of store) {
    const lastSeenMs = new Date(bucket.lastSeen).getTime();
    if (Number.isFinite(lastSeenMs) && lastSeenMs < cutoff) continue;
    entries.push({ source, lastSeen: bucket.lastSeen, ...emitBucket(bucket) });
  }
  entries.sort((a, b) => b.totalTokens - a.totalTokens);
  return entries.slice(0, limit);
}

function evictOldest(store: Map<string, unknown>): void {
  const firstKey = store.keys().next().value;
  if (typeof firstKey === "string") store.delete(firstKey);
}

// ── Pricing ──────────────────────────────────────────────────────────────────

/**
 * Public pricing helper for the time-series telemetry emitter — prices a single
 * usage record against the active rate card without touching aggregator state.
 */
export function estimateCostUsd(model: string, promptTokens: number, completionTokens: number): number {
  return priceUsage(model, promptTokens, completionTokens, getConfig().cost);
}

function priceUsage(model: string, promptTokens: number, completionTokens: number, cfg: CostConfig): number {
  const card = cfg.models.length > 0 ? cfg.models : DEFAULT_RATE_CARD;
  for (const entry of card) {
    let regex: RegExp;
    try { regex = new RegExp(entry.matches); } catch { continue; }
    if (regex.test(model)) {
      const promptCost = (promptTokens / 1_000_000) * entry.promptPer1m;
      const completionCost = (completionTokens / 1_000_000) * entry.completionPer1m;
      return promptCost + completionCost;
    }
  }
  return 0;
}

// ── Budgets ──────────────────────────────────────────────────────────────────

async function maybeFireBudgetAlert(cfg: CostConfig, today: string): Promise<void> {
  // Daily
  if (cfg.budgets.dailyUsd > 0) {
    const todayBucket = _byDay.get(today);
    const spend = todayBucket?.estimatedCost ?? 0;
    const softThreshold = cfg.budgets.dailyUsd * 0.75;
    const hard = cfg.budgets.dailyUsd;
    if (spend >= hard && _lastBudgetWarn?.bucket !== "hard") {
      logAudit("cost_budget_threshold", {
        scope: "daily",
        spend: round2(spend),
        budget: hard,
        currency: cfg.currency,
        bucket: "hard",
        day: today,
      }, { severity: "error" });
      _lastBudgetWarn = { day: today, bucket: "hard" };
    } else if (spend >= softThreshold && (!_lastBudgetWarn || (_lastBudgetWarn.day !== today))) {
      logAudit("cost_budget_threshold", {
        scope: "daily",
        spend: round2(spend),
        budget: hard,
        currency: cfg.currency,
        bucket: "soft",
        day: today,
      }, { severity: "warn" });
      _lastBudgetWarn = { day: today, bucket: "soft" };
    }
  }

  // Monthly
  if (cfg.budgets.monthlyUsd > 0) {
    const monthKey = today.slice(0, 7);
    let monthSpend = 0;
    for (const [day, bucket] of _byDay) {
      if (day.startsWith(monthKey)) monthSpend += bucket.estimatedCost;
    }
    const softThreshold = cfg.budgets.monthlyUsd * 0.75;
    const hard = cfg.budgets.monthlyUsd;
    if (monthSpend >= hard && _lastMonthlyBudgetWarn?.bucket !== "hard") {
      logAudit("cost_budget_threshold", {
        scope: "monthly",
        spend: round2(monthSpend),
        budget: hard,
        currency: cfg.currency,
        bucket: "hard",
        month: monthKey,
      }, { severity: "error" });
      _lastMonthlyBudgetWarn = { month: monthKey, bucket: "hard" };
    } else if (monthSpend >= softThreshold && (!_lastMonthlyBudgetWarn || (_lastMonthlyBudgetWarn.month !== monthKey))) {
      logAudit("cost_budget_threshold", {
        scope: "monthly",
        spend: round2(monthSpend),
        budget: hard,
        currency: cfg.currency,
        bucket: "soft",
        month: monthKey,
      }, { severity: "warn" });
      _lastMonthlyBudgetWarn = { month: monthKey, bucket: "soft" };
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatDay(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function formatHour(d: Date): string {
  return `${formatDay(d)}T${pad(d.getUTCHours())}`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Test-only — directly inject an audit-style event into the aggregator. */
export function _injectEventForTests(event: AuditEvent): void {
  handleEvent(event);
}
