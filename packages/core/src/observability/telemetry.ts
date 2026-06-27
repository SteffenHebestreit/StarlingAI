/**
 * Time-series telemetry → QuestDB.
 *
 * Mirrors system metrics from the audit bus into QuestDB so they survive
 * restarts and can be queried as proper time-series. The in-process cost
 * aggregator (observability/cost.ts) only keeps bounded rings that reset when
 * the process restarts; QuestDB is the durable, query-friendly home for the
 * same numbers — which is the whole reason the TSDB is in the stack.
 *
 * No-op when QUESTDB_URL is unset (the writes simply never fire).
 *
 * Measurements (InfluxDB line protocol):
 *   llm_usage     tags: model, agent, session   fields: prompt_tokens, completion_tokens, total_tokens, cost_usd
 *   tool_latency  tags: tool, ok                fields: duration_ms, output_chars
 *   sub_agent_run tags: agent, model, outcome   fields: duration_ms, iterations, total_tokens, cost_usd
 *
 * Field typing note: token/duration/iteration fields are written as integers
 * (`i` suffix → QuestDB LONG); cost_usd is always written with a decimal so the
 * column is inferred as DOUBLE and never flips type between an exact-zero and a
 * fractional write.
 */
import { subscribeToAudit } from "../audit/logger.js";
import type { AuditEvent } from "../audit/schema.js";
import { isQuestDbAvailable, questWrite, questQuery, escapeLineTag } from "../db/questdb.js";
import { estimateCostUsd } from "./cost.js";
import type { CostSummary, CostByDayEntry, CostBySourceEntry } from "./cost.js";
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";

const log = childLogger("telemetry");

let _unsub: (() => void) | null = null;

// ── Lifecycle ─────────────────────────────────────────────────────────────────

/** Start mirroring audit metrics to QuestDB. Idempotent; no-op without QuestDB. */
export function startTimeseriesTelemetry(): void {
  if (_unsub) return;
  if (!isQuestDbAvailable()) {
    log.debug("QUESTDB_URL not set — time-series telemetry disabled");
    return;
  }
  _unsub = subscribeToAudit(handleEvent);
  log.info("Time-series telemetry started — mirroring metrics to QuestDB");
}

/** Stop and detach the audit subscription. Flushes any buffered lines first. */
export function stopTimeseriesTelemetry(): void {
  if (_unsub) { _unsub(); _unsub = null; }
  flushTelemetry();
}

// ── Emission ───────────────────────────────────────────────────────────────────

function handleEvent(event: AuditEvent): void {
  try {
    switch (event.type) {
      case "turn_performance":
        emitLlmUsage(event, "orchestrator");
        return;
      case "sub_agent_completed":
        emitSubAgentRun(event);
        return;
      case "tool_call_completed":
      case "tool_call_failed":
        emitToolLatency(event);
        return;
      default:
        return;
    }
  } catch (err) {
    log.debug({ err, type: event.type }, "telemetry emit skipped");
  }
}

// A busy multi-agent turn emits dozens of metric lines; firing one POST per line
// opens dozens of racing connections and wastes QuestDB's newline-batch ingest.
// Buffer and flush on a short timer (or at MAX_BATCH), so a turn's metrics ship in
// ~1 write. ≤1s of crash-window loss is acceptable for disposable telemetry.
const TELEMETRY_FLUSH_MS = 1000;
const TELEMETRY_MAX_BATCH = 100;
let _buf: string[] = [];
let _flushTimer: ReturnType<typeof setTimeout> | null = null;

/** Flush buffered telemetry lines to QuestDB in one batched write. Exported for tests + shutdown. */
export function flushTelemetry(): void {
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  if (_buf.length === 0) return;
  const lines = _buf;
  _buf = [];
  // Fire-and-forget: a QuestDB write must never disturb a turn.
  void questWrite(lines).catch(() => {});
}

function emit(line: string): void {
  _buf.push(line);
  if (_buf.length >= TELEMETRY_MAX_BATCH) { flushTelemetry(); return; }
  if (!_flushTimer) {
    _flushTimer = setTimeout(flushTelemetry, TELEMETRY_FLUSH_MS);
    _flushTimer.unref?.();
  }
}

function emitLlmUsage(event: AuditEvent, agentName: string): void {
  const data = event.data;
  const usage = extractUsage(data["usage"]);
  if (!usage || usage.totalTokens <= 0) return;
  let model = readModel(data);
  // turn_performance events don't carry the model; fall back to the configured
  // primary so orchestrator usage is attributed to a model rather than "unknown".
  if (model === "unknown" && agentName === "orchestrator") {
    model = getConfig().agents.defaults.model.primary || "unknown";
  }
  const cost = estimateCostUsd(model, usage.promptTokens, usage.completionTokens);
  const ts = nsTimestamp(event.timestamp);
  emit(
    `llm_usage,model=${tag(model)},agent=${tag(agentName)},session=${tag(event.sessionId)}` +
    ` prompt_tokens=${int(usage.promptTokens)},completion_tokens=${int(usage.completionTokens)},` +
    `total_tokens=${int(usage.totalTokens)},cost_usd=${float(cost)} ${ts}`,
  );
}

function emitSubAgentRun(event: AuditEvent): void {
  const data = event.data;
  const agentName = typeof data["agentName"] === "string" ? data["agentName"] : "unknown";
  const model = readModel(data);
  const outcome = typeof data["outcome"] === "string" ? data["outcome"] : "unknown";
  const durationMs = num(data["durationMs"]);
  const iterations = num(data["iterations"]);
  const usage = extractUsage(data["usage"]);
  const cost = usage ? estimateCostUsd(model, usage.promptTokens, usage.completionTokens) : 0;
  const ts = nsTimestamp(event.timestamp);
  emit(
    `sub_agent_run,agent=${tag(agentName)},model=${tag(model)},outcome=${tag(outcome)}` +
    ` duration_ms=${int(durationMs)},iterations=${int(iterations)},` +
    `total_tokens=${int(usage?.totalTokens ?? 0)},cost_usd=${float(cost)} ${ts}`,
  );

  // The sub-agent's own LLM spend also belongs in the llm_usage series so the
  // cost dashboard sums orchestrator + specialists from one measurement.
  if (usage && usage.totalTokens > 0) {
    emit(
      `llm_usage,model=${tag(model)},agent=${tag(agentName)},session=${tag(event.sessionId)}` +
      ` prompt_tokens=${int(usage.promptTokens)},completion_tokens=${int(usage.completionTokens)},` +
      `total_tokens=${int(usage.totalTokens)},cost_usd=${float(cost)} ${ts}`,
    );
  }
}

function emitToolLatency(event: AuditEvent): void {
  const data = event.data;
  const tool = typeof data["tool"] === "string" ? data["tool"] : "unknown";
  const ok = data["success"] === true;
  const durationMs = num(data["durationMs"]);
  const outputChars = num(data["outputChars"]);
  // Skip cached tool calls (no real latency) — they carry cachedResult: true.
  if (data["cachedResult"] === true) return;
  const ts = nsTimestamp(event.timestamp);
  emit(
    `tool_latency,tool=${tag(tool)},ok=${tag(ok ? "true" : "false")}` +
    ` duration_ms=${int(durationMs)},output_chars=${int(outputChars)} ${ts}`,
  );
}

// ── Durable cost summary (QuestDB-backed) ──────────────────────────────────────

/**
 * Build the dashboard cost summary from the QuestDB `llm_usage` series instead
 * of the in-process rings, so it survives restarts and reflects full history.
 * Returns null when QuestDB is unavailable or the series is empty/unreadable so
 * the caller can fall back to the in-memory aggregator.
 */
export async function getCostSummaryFromTimeseries(rangeDays = 30): Promise<CostSummary | null> {
  if (!isQuestDbAvailable()) return null;
  const days = Math.max(1, Math.floor(rangeDays));
  const currency = getConfig().cost.currency;
  const since = `dateadd('d', -${days}, now())`;

  try {
    const byDayRows = await questQuery(
      `SELECT timestamp, sum(prompt_tokens) p, sum(completion_tokens) c, sum(total_tokens) t, ` +
      `sum(cost_usd) cost, count() n FROM llm_usage WHERE timestamp >= ${since} SAMPLE BY 1d ALIGN TO CALENDAR`,
    );
    if (byDayRows.length === 0) return null;

    const byDay: CostByDayEntry[] = byDayRows.map((row) => ({
      day: String(row["timestamp"] ?? "").slice(0, 10),
      promptTokens: num(row["p"]),
      completionTokens: num(row["c"]),
      totalTokens: num(row["t"]),
      estimatedCost: round2(num(row["cost"])),
      count: num(row["n"]),
    })).filter((entry) => entry.day);
    byDay.sort((a, b) => a.day.localeCompare(b.day));

    const totalTokens = byDay.reduce((sum, d) => sum + d.totalTokens, 0);
    const totalCost = round2(byDay.reduce((sum, d) => sum + d.estimatedCost, 0));

    const [byAgent, byModel, bySession] = await Promise.all([
      bySource("agent", since),
      bySource("model", since),
      bySource("session", since),
    ]);

    return { rangeDays: days, totalTokens, totalCost, currency, byDay, byAgent, byModel, bySession };
  } catch (err) {
    log.debug({ err }, "QuestDB cost summary unavailable; falling back to in-memory");
    return null;
  }
}

async function bySource(column: "agent" | "model" | "session", since: string): Promise<CostBySourceEntry[]> {
  const rows = await questQuery(
    `SELECT ${column}, sum(prompt_tokens) p, sum(completion_tokens) c, sum(total_tokens) t, ` +
    `sum(cost_usd) cost, count() n, max(timestamp) last FROM llm_usage ` +
    `WHERE timestamp >= ${since} GROUP BY ${column} ORDER BY t DESC LIMIT 25`,
  );
  return rows.map((row) => ({
    source: String(row[column] ?? "unknown"),
    lastSeen: String(row["last"] ?? ""),
    promptTokens: num(row["p"]),
    completionTokens: num(row["c"]),
    totalTokens: num(row["t"]),
    estimatedCost: round2(num(row["cost"])),
    count: num(row["n"]),
  }));
}

// ── Helpers ────────────────────────────────────────────────────────────────────

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

function readModel(data: Record<string, unknown>): string {
  if (typeof data["model"] === "string" && data["model"]) return data["model"];
  const perf = data["performance"] as Record<string, unknown> | undefined;
  if (perf && typeof perf["model"] === "string" && perf["model"]) return perf["model"];
  return "unknown";
}

function tag(value: string | undefined): string {
  return escapeLineTag(value && value.length > 0 ? value : "unknown");
}

function int(value: number): string {
  return `${Math.round(Number.isFinite(value) ? value : 0)}i`;
}

/** Always emit a decimal so QuestDB infers the column as DOUBLE, not LONG. */
function float(value: number): string {
  const v = Number.isFinite(value) ? value : 0;
  return Number.isInteger(v) ? `${v}.0` : String(v);
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function nsTimestamp(iso: string): bigint {
  const ms = new Date(iso).getTime();
  return BigInt(Number.isFinite(ms) ? ms : Date.now()) * 1_000_000n;
}
