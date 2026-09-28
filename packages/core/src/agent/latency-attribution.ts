/**
 * Where a turn's time goes, and what each latency lever could take off it — from audit rows alone.
 *
 * The audit log already records every model call (provider_model_call: call site, agent, duration,
 * time to first token, prompt and completion tokens), every tool call, every sub-agent run, every
 * human wait and the turn's own performance and scorecard rows. This module turns those rows into
 * one attribution per turn, without calling anything:
 *
 * - The TURN is the span from the user's message (message_received) to the reply (message_sent), per
 *   top-level session. A sub-agent's rows (session `sub:<parent>:<agent>:<ts>`) belong to the turn of
 *   their parent session that was open when they were written. Rows with no session (the cache
 *   warm-keeper, warden alerts) belong to no turn and are reported apart, and so do cache warm-up
 *   calls that carry one (callSite cache_warm: a sub-agent's head re-warm) and the intent readout's
 *   post-turn shadow (callSite intent_shadow, and its intent_readout_shadow row).
 * - Each model call is split into prefill, decode and overhead: from llama.cpp's own `timings` when
 *   the row carries them, else from the time to first token (stream calls), else as its duration
 *   minus completionTokens at the decode rate (complete calls, whose per-call overhead then sits
 *   inside "prefill"). Each call is classed cold, partial or warm by the share of its prompt it
 *   re-processed; a prompt too small for a full prefill to stand out from the per-call overhead is
 *   "indeterminate" rather than guessed.
 * - Each LEVER returns the time intervals on the turn it could remove, with a weight (1 for a
 *   restructuring, the coverage parameter for a classifier that must first be trusted). A lever's
 *   saving is the measure of its intervals. The COMBINED saving counts every instant once, at the
 *   largest weight any lever claims for it — never the sum — and every pair of levers that claims
 *   the same instants is listed with the seconds they share. So "Laya takes the gate calls" and "a
 *   pre-router dispatches directly" cannot both be credited with the same second.
 *
 * What the numbers are not. A saving here is an upper bound on the seconds a lever could remove if
 * it worked perfectly on these turns: whether it keeps the answer as good is a separate, live
 * question (pass^k, the decision bench). And these turns are whatever the audit holds — often a
 * handful of sessions of one user on one topic — so the report states its scope before any number.
 *
 * Privacy: rows can hold the user's words (queries, delegated tasks, tool arguments). Nothing here
 * copies a string out of a row except identifiers — ids, agent, tool and call-site names, enums such
 * as an outcome status — and message lengths. The test suite enforces this with canary strings.
 */
import {
  FAST_LANE,
  GOAL_MET,
  RUN_DRIFTING,
  SLICES_DISAGREE,
  SOURCE_SENSITIVE,
  UNGROUNDED_DRAFT,
  type DecisionPointId,
} from "../decisions/points.js";
import { isBenchPoint } from "./decisions-bench.js";

// ── Input ────────────────────────────────────────────────────────────────────────────────────

/** One audit row as the audit log writes it (audit/schema.ts AuditEvent, minus what is not read). */
export interface AuditRow {
  id: string;
  timestamp: string;
  type: string;
  sessionId?: string;
  data: Record<string, unknown>;
}

/**
 * Parse an audit JSONL text. Blank lines and `//` comment lines are skipped (dataset files carry a
 * comment header); a line that is not a row object is counted, not thrown on — a truncated last
 * line of a live log must not cost the whole report.
 */
export function parseAuditJsonl(text: string): { rows: AuditRow[]; malformedLines: number } {
  const rows: AuditRow[] = [];
  let malformedLines = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("//")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformedLines += 1;
      continue;
    }
    const row = asRecord(parsed);
    if (!row || typeof row["id"] !== "string" || typeof row["timestamp"] !== "string" || typeof row["type"] !== "string"
      || !Number.isFinite(Date.parse(row["timestamp"]))) {
      malformedLines += 1;
      continue;
    }
    rows.push({
      id: row["id"],
      timestamp: row["timestamp"],
      type: row["type"],
      ...(typeof row["sessionId"] === "string" ? { sessionId: row["sessionId"] } : {}),
      data: asRecord(row["data"]) ?? {},
    });
  }
  return { rows, malformedLines };
}

/** Rows with the same id are the same event (the live log, its Postgres mirror and session exports overlap). */
export function dedupeRows(rows: readonly AuditRow[]): { rows: AuditRow[]; duplicates: number } {
  const seen = new Set<string>();
  const out: AuditRow[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return { rows: out, duplicates: rows.length - out.length };
}

// ── Parameters ───────────────────────────────────────────────────────────────────────────────

export interface LatencyParams {
  /** Decode speed for splitting a complete-mode call without timings, tokens/s. 56.1 measured on the
   *  "qwen" station (p10–p90 55.3–57.5 over 146 stream calls, 2026-09-21..25). */
  decodeTokensPerSec: number;
  /** Cold prefill speed, tokens/s: what processing a whole prompt costs. 780–909 measured cold (the
   *  boot warm-up processed 12,991 tokens in ~14.3 s). */
  coldPrefillTokensPerSec: number;
  /** A call re-processed at least this share of its prompt: cold. */
  coldShare: number;
  /** A call re-processed at most this share of its prompt: warm. */
  warmShare: number;
  /** Below this many prompt tokens a full cold prefill (≤ ~1.7 s at 900 tok/s) is within the per-call
   *  overhead measured on small calls (1.0–2.2 s for 384–547 tokens), so cold and warm cannot be told
   *  apart without timings. */
  indeterminateBelowTokens: number;
  /** Share of a classifier lever's claims that could be handed over (1 = every case: an upper bound).
   *  The real figure is what decisions:bench measures per point, language and class. */
  coverage: number;
  /** What a Laya decision costs instead of the call it replaces (17–21 ms measured on the RTX 4080). */
  layaMs: number;
  /** Time to first token of a sub-agent's first call when its head is already cached. */
  subagentWarmTtftMs: number;
  /** Time to first token of an orchestrator call whose head is cached: p50 2.5 s over 71 calls at ~13.9k prompt
   *  tokens (2026-09-21..25), the tail after the cached head re-prefilled. */
  orchestratorWarmTtftMs: number;
  /** What search_agents / list_agents take with a warm reranker (3.7 s measured once, f4ebf47b turn 1). */
  agentSearchWarmMs: number;
  /** Output a structured vision answer would still decode (a short list of named elements). */
  visionStructuredTokens: number;
  /** Tools whose time is image rendering: reported apart, never claimed by a lever. */
  renderTools: readonly string[];
  /** Fewer turns than this: every figure is printed as anecdotal. */
  thinDataTurns: number;
}

export const DEFAULT_LATENCY_PARAMS: Readonly<LatencyParams> = Object.freeze({
  decodeTokensPerSec: 56,
  coldPrefillTokensPerSec: 900,
  coldShare: 0.8,
  warmShare: 0.1,
  indeterminateBelowTokens: 1_500,
  coverage: 1,
  layaMs: 20,
  subagentWarmTtftMs: 1_500,
  orchestratorWarmTtftMs: 2_500,
  agentSearchWarmMs: 3_700,
  visionStructuredTokens: 64,
  renderTools: Object.freeze(["generate_image", "transform_image"]),
  thinDataTurns: 30,
});

// ── Small helpers ────────────────────────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A string field that names something (an agent, a tool, a status) — never free text. */
function ident(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function tsMs(row: AuditRow): number {
  return Date.parse(row.timestamp);
}

/**
 * The top-level session a row belongs to. A sub-agent's session is `sub:<parent>:<agent>:<ts>`, and
 * the parent may be another sub-agent's (nested) or carry colons of its own (`mcp:<caller>:<id>`,
 * `fed:…`, `workflow:…`), so each level drops its `sub:` and its last two segments; cutting at the
 * first colon would merge every MCP session into one called "mcp".
 */
export function rootSessionId(sessionId: string): string {
  let id = sessionId;
  for (;;) {
    // sub-agent.ts: sub:<parent>:<agent>:<ts>. tools/workflow-catalog.ts: workflow:<parent>:<scene or job>:<uuid>,
    // whose sub-agents are sub:workflow:<parent>:<name>:<uuid>:<agent>:<ts> — both nest, in any order.
    const prefix = id.startsWith("sub:") ? "sub:" : id.startsWith("workflow:") ? "workflow:" : null;
    if (!prefix) break;
    const parts = id.slice(prefix.length).split(":");
    // Not a shape either writer produces: leave it as it is rather than guess a parent.
    if (parts.length < 3) break;
    id = parts.slice(0, -2).join(":");
  }
  return id;
}

/** A sub-agent the orchestrator delegated to itself, not one a sub-agent delegated to. */
function isDirectSubSession(sessionId: string): boolean {
  return sessionId.startsWith("sub:") && !sessionId.startsWith("sub:sub:");
}

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

/** Nearest-rank percentile; null for no values. */
function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1] ?? null;
}

function round(value: number): number {
  return Math.round(value);
}

function ratio(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 10_000) / 10_000 : null;
}

// ── Intervals ────────────────────────────────────────────────────────────────────────────────

interface Interval {
  start: number;
  end: number;
}

function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals.filter((iv) => iv.end > iv.start).sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else merged.push({ start: iv.start, end: iv.end });
  }
  return merged;
}

function measure(intervals: readonly Interval[]): number {
  return sum(mergeIntervals(intervals).map((iv) => iv.end - iv.start));
}

/** Measure of the union of `a` outside the union of `b`. */
function measureOutside(a: readonly Interval[], b: readonly Interval[]): number {
  const cut = mergeIntervals(b);
  let total = 0;
  for (const iv of mergeIntervals(a)) {
    let covered = 0;
    for (const c of cut) covered += Math.max(0, Math.min(iv.end, c.end) - Math.max(iv.start, c.start));
    total += iv.end - iv.start - covered;
  }
  return total;
}

/** A stretch of a turn a lever could remove, at a weight (1 = all of it, coverage = that share). */
export interface LeverClaim {
  lever: LeverId;
  startMs: number;
  endMs: number;
  weight: number;
}

/**
 * The seconds a set of claims removes, each instant counted once at the largest weight claimed for
 * it. Two levers claiming the same second at weights 1 and 0.5 remove one second, not one and a half.
 */
export function weightedUnionMs(claims: readonly LeverClaim[]): number {
  return integrate(claims, (weights) => Math.max(0, ...weights));
}

/**
 * The seconds two levers both claim: at each instant the smaller of the two levers' weights — what
 * adding their separate totals would count twice.
 */
export function weightedOverlapMs(a: readonly LeverClaim[], b: readonly LeverClaim[]): number {
  const tagged = [...a.map((c) => ({ ...c, side: 0 })), ...b.map((c) => ({ ...c, side: 1 }))];
  const bounds = [...new Set(tagged.flatMap((c) => [c.startMs, c.endMs]))].sort((x, y) => x - y);
  let total = 0;
  for (let i = 0; i + 1 < bounds.length; i += 1) {
    const lo = bounds[i]!;
    const hi = bounds[i + 1]!;
    const mid = (lo + hi) / 2;
    let wa = 0;
    let wb = 0;
    for (const c of tagged) {
      if (c.startMs <= mid && mid < c.endMs) {
        if (c.side === 0) wa = Math.max(wa, c.weight);
        else wb = Math.max(wb, c.weight);
      }
    }
    total += (hi - lo) * Math.min(wa, wb);
  }
  return total;
}

function integrate(claims: readonly LeverClaim[], combine: (weights: number[]) => number): number {
  const live = claims.filter((c) => c.endMs > c.startMs && c.weight > 0);
  const bounds = [...new Set(live.flatMap((c) => [c.startMs, c.endMs]))].sort((x, y) => x - y);
  let total = 0;
  for (let i = 0; i + 1 < bounds.length; i += 1) {
    const lo = bounds[i]!;
    const hi = bounds[i + 1]!;
    const mid = (lo + hi) / 2;
    const weights = live.filter((c) => c.startMs <= mid && mid < c.endMs).map((c) => c.weight);
    if (weights.length > 0) total += (hi - lo) * combine(weights);
  }
  return total;
}

// ── Model calls ──────────────────────────────────────────────────────────────────────────────

/** llama.cpp's own accounting of one call, when the provider row carries it. */
export interface ServerTimings {
  /** Prompt tokens processed by this call (not reused from the cache). */
  promptN: number;
  /** Prompt tokens reused from the cache, when reported. */
  cacheN: number | null;
  promptMs: number;
  predictedMs: number | null;
}

/**
 * Read `timings` from a provider row: a `timings` object (camelCase, or llama-server's own
 * snake_case) or the same fields flat on the row.
 */
export function readServerTimings(data: Record<string, unknown>): ServerTimings | null {
  const source = asRecord(data["timings"]) ?? data;
  const promptN = num(source["promptN"] ?? source["prompt_n"]);
  const promptMs = num(source["promptMs"] ?? source["prompt_ms"]);
  if (promptN === null || promptMs === null) return null;
  return {
    promptN,
    cacheN: num(source["cacheN"] ?? source["cache_n"]),
    promptMs,
    predictedMs: num(source["predictedMs"] ?? source["predicted_ms"]),
  };
}

export type PrefillClass = "cold" | "partial" | "warm" | "indeterminate" | "unknown";

export interface CallEstimate {
  prefillMs: number;
  decodeMs: number;
  /** Only separable with timings; otherwise inside prefillMs (complete) or unknown (stream). */
  overheadMs: number;
  basis: "timings" | "ttft" | "decode_rate" | "none";
  prefillClass: PrefillClass;
}

/**
 * Split one call into prefill, decode and overhead, and class its prefill.
 *
 * Without timings the class compares the prefill time with what processing the WHOLE prompt cold
 * would take (promptTokens at the cold rate): at least `coldShare` of it is cold, at most
 * `warmShare` is warm. For a stream call the prefill time is the time to first token, which also
 * holds the per-call floor, so a warm call reads a little higher than it is.
 */
export function estimateCall(
  call: { durationMs: number; ttftMs: number | null; promptTokens: number | null; completionTokens: number | null; timings: ServerTimings | null },
  params: LatencyParams,
): CallEstimate {
  const { durationMs, ttftMs, promptTokens, completionTokens, timings } = call;
  if (timings) {
    const decodeMs = timings.predictedMs ?? (completionTokens !== null ? (completionTokens / params.decodeTokensPerSec) * 1_000 : 0);
    const prefillMs = timings.promptMs;
    const processedShare = timings.cacheN !== null && timings.promptN + timings.cacheN > 0
      ? timings.promptN / (timings.promptN + timings.cacheN)
      : null;
    return {
      prefillMs,
      decodeMs,
      overheadMs: Math.max(0, durationMs - prefillMs - decodeMs),
      basis: "timings",
      prefillClass: processedShare === null
        ? classByTime(prefillMs, promptTokens, params)
        : processedShare >= params.coldShare ? "cold" : processedShare <= params.warmShare ? "warm" : "partial",
    };
  }
  if (ttftMs !== null) {
    const prefillMs = Math.min(ttftMs, durationMs);
    return { prefillMs, decodeMs: durationMs - prefillMs, overheadMs: 0, basis: "ttft", prefillClass: classByTime(prefillMs, promptTokens, params) };
  }
  if (completionTokens !== null) {
    const decodeMs = Math.min(durationMs, (completionTokens / params.decodeTokensPerSec) * 1_000);
    const prefillMs = durationMs - decodeMs;
    return { prefillMs, decodeMs, overheadMs: 0, basis: "decode_rate", prefillClass: classByTime(prefillMs, promptTokens, params) };
  }
  return { prefillMs: 0, decodeMs: 0, overheadMs: durationMs, basis: "none", prefillClass: "unknown" };
}

function classByTime(prefillMs: number, promptTokens: number | null, params: LatencyParams): PrefillClass {
  if (promptTokens === null || promptTokens <= 0) return "unknown";
  if (promptTokens < params.indeterminateBelowTokens) return "indeterminate";
  const share = prefillMs / ((promptTokens / params.coldPrefillTokensPerSec) * 1_000);
  return share >= params.coldShare ? "cold" : share <= params.warmShare ? "warm" : "partial";
}

/** The yes/no decision each routing-tier judge makes, as a Laya point (decisions/points.ts). */
const DECISION_POINT_BY_AGENT: Readonly<Record<string, DecisionPointId>> = Object.freeze({
  receptionist: FAST_LANE.id,
  source_sensitivity_judge: SOURCE_SENSITIVE.id,
  ungrounded_claim_judge: UNGROUNDED_DRAFT.id,
  disagreement_check: SLICES_DISAGREE.id,
  goal_met_oversight: GOAL_MET.id,
  progress_judge: RUN_DRIFTING.id,
});

/** The call that rewrites an answer after a QA verdict failed it: a verdict followed by one was a FAIL. */
const QA_REPAIR_AGENTS: ReadonlySet<string> = new Set(["qa_improve", "consistency_repair"]);

/**
 * Tools that only find or plan the route. A turn whose only tools before its dispatch are these is
 * one a pre-router could have dispatched directly; any other tool (a search, a file read) did work
 * the task may have needed.
 */
const ROUTING_BOOKKEEPING_TOOLS: ReadonlySet<string> = new Set(["search_agents", "list_agents", "agent_catalog", "search_tools", "record_plan"]);

/** Tools that look for an agent, and wait on the embedding reranker to do it. */
const AGENT_SEARCH_TOOLS: ReadonlySet<string> = new Set(["search_agents", "list_agents"]);

/** The tool that makes vision calls. Builds before 2026-09-26 wrote no model-call row for them. */
const VISION_TOOL = "analyze_image";

export interface CallRecord {
  rowId: string;
  sessionId: string | null;
  subSession: boolean;
  callSite: string;
  agentName: string;
  /** What the call does in the turn: "orchestrator", "sub_agent", a judge's name, "synthesis", … */
  role: string;
  /** Pre-2026-09-25 builds stamped the receptionist main/main_turn; relabelled from its position. */
  relabelled: boolean;
  decisionPoint: DecisionPointId | null;
  mode: string | null;
  startMs: number;
  endMs: number;
  durationMs: number;
  ttftMs: number | null;
  /** Stream rows timed from the send carry the time until the response headers arrived; rows
   *  without it (builds before 2026-09-26) started their clock at the headers. */
  headersMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  toolCount: number | null;
  finishReason: string | null;
  timings: ServerTimings | null;
  estimate: CallEstimate;
}

function toCallRecord(row: AuditRow, params: LatencyParams): CallRecord | null {
  const durationMs = num(row.data["durationMs"]);
  if (durationMs === null || durationMs < 0) return null;
  const endMs = tsMs(row);
  const callSite = ident(row.data["callSite"]) ?? "-";
  const agentName = ident(row.data["agentName"]) ?? "-";
  const toolCount = num(row.data["toolCount"]);
  const ttftMs = num(row.data["ttftMs"]);
  const promptTokens = num(row.data["promptTokens"]);
  const completionTokens = num(row.data["completionTokens"]);
  const timings = readServerTimings(row.data);
  const sessionId = row.sessionId ?? null;
  return {
    rowId: row.id,
    sessionId,
    subSession: sessionId?.startsWith("sub:") ?? false,
    callSite,
    agentName,
    role: roleOf(callSite, agentName, toolCount),
    relabelled: false,
    decisionPoint: callSite === "routing_tier" ? DECISION_POINT_BY_AGENT[agentName] ?? null : null,
    mode: ident(row.data["mode"]),
    startMs: endMs - durationMs,
    endMs,
    durationMs,
    ttftMs,
    headersMs: num(row.data["headersMs"]),
    promptTokens,
    completionTokens,
    toolCount,
    finishReason: ident(row.data["finishReason"]),
    timings,
    estimate: estimateCall({ durationMs, ttftMs, promptTokens, completionTokens, timings }, params),
  };
}

function roleOf(callSite: string, agentName: string, toolCount: number | null): string {
  switch (callSite) {
    // The orchestrator always sends its tool array (tool_choice none keeps it); a main_turn call
    // without tools is something else stamped with the orchestrator's label by an older build.
    case "main_turn": return toolCount !== null && toolCount > 0 ? "orchestrator" : "main_no_tools";
    case "sub_agent": return "sub_agent";
    case "routing_tier":
    case "qa": return agentName;
    case "synthesis": return agentName === "main" || agentName === "-" ? "synthesis" : agentName;
    case "vision": return "vision";
    default: return `${callSite}/${agentName}`;
  }
}

// ── Turns ────────────────────────────────────────────────────────────────────────────────────

export interface ToolRecord {
  rowId: string;
  tool: string;
  sessionId: string;
  level: "orchestrator" | "sub_agent";
  startMs: number;
  endMs: number;
  durationMs: number;
  success: boolean | null;
}

export interface SubAgentSpan {
  sessionId: string;
  agentName: string;
  direct: boolean;
  startMs: number;
  endMs: number;
  completed: boolean;
  outcome: string | null;
}

export interface RequestedTool {
  tool: string;
  atMs: number;
}

/** Everything the levers read about one turn, on the absolute clock (epoch ms). */
export interface TurnContext {
  sessionId: string;
  startMs: number;
  endMs: number;
  /** "fast_lane_reply": the receptionist answered, and its verdict row ends the turn (see buildTurn). */
  ended: "message_sent" | "fast_lane_reply" | "no_message_sent";
  messageChars: number | null;
  /** The receptionist answered the message itself (fast lane); null when the build did not say. */
  fastLane: boolean | null;
  escalateReason: string | null;
  calls: CallRecord[];
  tools: ToolRecord[];
  requested: RequestedTool[];
  spans: SubAgentSpan[];
  humanWaits: Array<{ startMs: number; endMs: number }>;
  plans: Array<{ atMs: number; stepCount: number | null }>;
  /** Loop rows of the turn's sub-agent runs (sub_agent_tool_loop_enforced / _detected), in time order. */
  loopSignals: Array<{ sessionId: string; atMs: number }>;
  performance: Record<string, unknown> | null;
  scorecard: Record<string, unknown> | null;
}

function isTurnStart(row: AuditRow): boolean {
  if (row.type !== "message_received" || !row.sessionId || row.sessionId.startsWith("sub:")) return false;
  // The runtime writes message_received twice per turn (agent/turn-prepare.ts): once on arrival
  // ({length} of the user's message) and once with the receptionist's verdict — {fastLane: false,
  // escalateReason} on a miss, {fastLane: true, length} on a hit, where length is the front desk's
  // reply. Only the arrival row opens a turn; a verdict row never does, whatever else it carries.
  return !("fastLane" in row.data) && !("escalateReason" in row.data);
}

/**
 * Group rows into turns: per top-level session, from each message_received that opens a turn to
 * the next one. Sub-agent rows join the turn of their parent that is open when they are written.
 */
export function buildTurnContexts(rows: readonly AuditRow[], params: LatencyParams = DEFAULT_LATENCY_PARAMS): {
  turns: TurnContext[];
  offTurnCalls: CallRecord[];
  offTurnRows: number;
} {
  // Stable sort: rows written in the same millisecond keep their written order.
  const sorted = rows.map((row, index) => ({ row, index, at: tsMs(row) }))
    .filter((entry) => Number.isFinite(entry.at))
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .map((entry) => entry.row);
  const open = new Map<string, AuditRow[]>();
  const groups: AuditRow[][] = [];
  const offTurnCalls: CallRecord[] = [];
  let offTurnRows = 0;
  for (const row of sorted) {
    // A cache warm-up is on no turn's critical path, whatever session it carries: the warm-keeper's
    // carry none, and a sub-agent's head re-warm (agent/sub-agent-head-rewarm.ts) carries the run
    // it follows, so it can be traced to that run. It goes out as the run ends and nothing in the
    // turn waits on it (a dispatch that joins it shows the wait as a gap before its own first
    // call). Counted in the turn, its time would be added to the turn's model time although it ran
    // beside the turn, and it would read as one more call of the run it follows.
    const warmUp = row.type === "provider_model_call" && row.data["callSite"] === "cache_warm";
    // The intent readout's shadow (agent/intent-shadow.ts) carries the turn it measures, and is
    // asked after that turn's reply went out and aborted by the next one: its calls and its row sit
    // after message_sent, where a turn without that row would otherwise run on to them.
    const intentShadow = (row.type === "provider_model_call" && row.data["callSite"] === "intent_shadow")
      || row.type === "intent_readout_shadow";
    if (!row.sessionId || warmUp || intentShadow) {
      offTurnRows += 1;
      if (row.type === "provider_model_call") {
        const call = toCallRecord(row, params);
        if (call) offTurnCalls.push(call);
      }
      continue;
    }
    const root = rootSessionId(row.sessionId);
    if (isTurnStart(row)) {
      const group = [row];
      open.set(root, group);
      groups.push(group);
      continue;
    }
    const group = open.get(root);
    if (group) group.push(row);
    else offTurnRows += 1;
  }
  return { turns: groups.map((group) => buildTurn(group, params)), offTurnCalls, offTurnRows };
}

function buildTurn(group: readonly AuditRow[], params: LatencyParams): TurnContext {
  const first = group[0]!;
  const sessionId = first.sessionId!;
  const startMs = tsMs(first);
  const sent = group.find((row) => row.type === "message_sent" && row.sessionId === sessionId);
  const marker = group.find((row) => row.type === "message_received" && row.sessionId === sessionId
    && ("fastLane" in row.data || "escalateReason" in row.data));
  // A turn the front desk answered returns before the reply is logged: no message_sent, and the
  // verdict row, written as the reply goes out, is its end. Otherwise the turn would run on to
  // whatever row of the session came next, minutes later.
  const fastLaneReply = !sent && marker?.data["fastLane"] === true ? marker : undefined;
  const last = group[group.length - 1]!;
  const endMs = tsMs(sent ?? fastLaneReply ?? last);

  const calls: CallRecord[] = [];
  for (const row of group) {
    if (row.type !== "provider_model_call") continue;
    const call = toCallRecord(row, params);
    if (!call) continue;
    // An older build's receptionist: a tool-less main_turn call in the top-level session that
    // finished before the receptionist's verdict row was written.
    if (call.role === "main_no_tools" && !call.subSession && marker && call.endMs <= tsMs(marker)) {
      call.role = "receptionist";
      call.relabelled = true;
      call.decisionPoint = FAST_LANE.id;
    }
    calls.push(call);
  }
  calls.sort((a, b) => a.startMs - b.startMs);

  const tools: ToolRecord[] = [];
  const pendingSubTools = new Map<string, AuditRow>();
  const requested: RequestedTool[] = [];
  const spans: SubAgentSpan[] = [];
  const openSpans = new Map<string, SubAgentSpan[]>();
  const waitRequests = new Map<string, number>();
  const humanWaits: Array<{ startMs: number; endMs: number }> = [];
  const plans: Array<{ atMs: number; stepCount: number | null }> = [];
  const loopSignals: Array<{ sessionId: string; atMs: number }> = [];
  let performance: Record<string, unknown> | null = null;
  let scorecard: Record<string, unknown> | null = null;

  for (const row of group) {
    const at = tsMs(row);
    const rowSession = row.sessionId!;
    switch (row.type) {
      case "tool_call_completed":
      case "tool_call_failed": {
        const durationMs = num(row.data["durationMs"]);
        const tool = ident(row.data["tool"]);
        if (durationMs === null || !tool) break;
        tools.push({
          rowId: row.id, tool, sessionId: rowSession,
          level: rowSession.startsWith("sub:") ? "sub_agent" : "orchestrator",
          startMs: at - durationMs, endMs: at, durationMs,
          success: typeof row.data["success"] === "boolean" ? row.data["success"] : row.type === "tool_call_completed",
        });
        break;
      }
      case "sub_agent_tool_call": {
        const callId = ident(row.data["toolCallId"]);
        const tool = ident(row.data["tool"]);
        if (!callId || !tool) break;
        const key = `${rowSession}|${callId}`;
        if (row.data["phase"] === "start") pendingSubTools.set(key, row);
        else if (row.data["phase"] === "done" && pendingSubTools.has(key)) {
          const started = pendingSubTools.get(key)!;
          pendingSubTools.delete(key);
          const startAt = tsMs(started);
          tools.push({
            rowId: row.id, tool, sessionId: rowSession, level: "sub_agent",
            startMs: startAt, endMs: at, durationMs: at - startAt,
            success: typeof row.data["success"] === "boolean" ? row.data["success"] : null,
          });
        }
        break;
      }
      case "tool_call_requested": {
        const tool = ident(row.data["tool"]);
        if (tool && rowSession === sessionId) requested.push({ tool, atMs: at });
        break;
      }
      case "sub_agent_started": {
        const span: SubAgentSpan = {
          sessionId: rowSession,
          agentName: ident(row.data["agentName"]) ?? "-",
          direct: isDirectSubSession(rowSession),
          startMs: at,
          endMs: endMs,
          completed: false,
          outcome: null,
        };
        spans.push(span);
        openSpans.set(rowSession, [...(openSpans.get(rowSession) ?? []), span]);
        break;
      }
      case "sub_agent_completed": {
        const queue = openSpans.get(rowSession);
        const span = queue?.shift();
        if (span) {
          span.endMs = at;
          span.completed = true;
          span.outcome = ident(row.data["outcome"]);
        }
        break;
      }
      case "user_input_requested": {
        const inputId = ident(row.data["inputId"]);
        if (inputId) waitRequests.set(inputId, at);
        break;
      }
      case "user_input_resolved": {
        const inputId = ident(row.data["inputId"]);
        const waited = num(row.data["waitedMs"]);
        const requestedAt = inputId ? waitRequests.get(inputId) : undefined;
        const waitStart = waited !== null ? at - waited : requestedAt;
        if (waitStart !== undefined) humanWaits.push({ startMs: waitStart, endMs: at });
        break;
      }
      case "flow_plan_recorded":
        if (rowSession === sessionId) plans.push({ atMs: at, stepCount: num(row.data["stepCount"]) });
        break;
      case "turn_performance":
        if (rowSession === sessionId && !performance) performance = row.data;
        break;
      case "turn_scorecard":
        if (rowSession === sessionId && !scorecard) scorecard = row.data;
        break;
      case "sub_agent_tool_loop_enforced":
      case "sub_agent_tool_loop_detected":
        if (rowSession.startsWith("sub:")) loopSignals.push({ sessionId: rowSession, atMs: at });
        break;
      default:
        break;
    }
  }
  tools.sort((a, b) => a.startMs - b.startMs);

  return {
    sessionId,
    startMs,
    endMs,
    ended: sent ? "message_sent" : fastLaneReply ? "fast_lane_reply" : "no_message_sent",
    messageChars: num(first.data["length"]),
    fastLane: marker && typeof marker.data["fastLane"] === "boolean" ? marker.data["fastLane"] : null,
    escalateReason: marker ? ident(marker.data["escalateReason"]) : null,
    calls,
    tools,
    requested,
    spans,
    humanWaits,
    plans,
    loopSignals,
    performance,
    scorecard,
  };
}

// ── Turn anatomy ─────────────────────────────────────────────────────────────────────────────

function orchestratorCalls(turn: TurnContext): CallRecord[] {
  return turn.calls.filter((call) => !call.subSession && call.role === "orchestrator");
}

/** A tool call that ran a sub-agent (delegate_to_agent, execute_plan, a fan-out): it holds that time, it is not leaf work. */
function spansInside(turn: TurnContext, tool: ToolRecord): SubAgentSpan[] {
  // 50 ms of slack: the tool's start is derived from its duration, the span's from its own row.
  return turn.spans.filter((span) => span.startMs >= tool.startMs - 50 && span.endMs <= tool.endMs + 50);
}

export interface DispatchInfo {
  tool: string;
  /** Sub-agents the orchestrator started directly inside the dispatching tool call. */
  directSubAgents: number;
  /** Steps of the plan recorded before it, when one was. */
  planSteps: number | null;
  /** One sub-agent, and no plan or a one-step plan. */
  single: boolean;
  /** Orchestrator tools that ran before the dispatch, in order. */
  toolsBefore: string[];
  /** Only routing bookkeeping (agent search, planning) ran before it: a pre-router could have dispatched. */
  preRoutable: boolean;
  startMs: number;
}

/** The turn's first dispatch: the first orchestrator tool call during which a sub-agent it started ran. */
export function findDispatch(turn: TurnContext): DispatchInfo | null {
  const orchestratorTools = turn.tools.filter((tool) => tool.level === "orchestrator");
  const dispatch = orchestratorTools.find((tool) => spansInside(turn, tool).some((span) => span.direct && span.sessionId.startsWith(`sub:${turn.sessionId}:`)));
  if (!dispatch) return null;
  const direct = spansInside(turn, dispatch).filter((span) => span.direct).length;
  const plan = [...turn.plans].reverse().find((marker) => marker.atMs <= dispatch.startMs);
  const planSteps = plan?.stepCount ?? null;
  const toolsBefore = orchestratorTools.filter((tool) => tool !== dispatch && tool.startMs < dispatch.startMs).map((tool) => tool.tool);
  const single = direct === 1 && (!plan || planSteps === 1);
  return {
    tool: dispatch.tool,
    directSubAgents: direct,
    planSteps,
    single,
    toolsBefore,
    preRoutable: single && toolsBefore.every((name) => ROUTING_BOOKKEEPING_TOOLS.has(name)),
    startMs: dispatch.startMs,
  };
}

// ── Levers ───────────────────────────────────────────────────────────────────────────────────

export const LEVER_IDS = [
  "laya_gate_calls",
  "pre_router_dispatch",
  "plan_round_fold",
  "subagent_prewarm",
  "prefix_cache_kept",
  "agent_search_wait",
  "qa_verdict_candidate",
  "vision_structuring",
  "loop_brake",
] as const;
export type LeverId = typeof LEVER_IDS[number];

export interface LeverDefinition {
  readonly id: LeverId;
  readonly title: string;
  /** "classifier": a decision has to be made instead, so its claims are scaled by coverage.
   *  "restructure": the time goes away by doing things in another order or shape. */
  readonly kind: "classifier" | "restructure";
  assumption(params: LatencyParams): string;
  claims(turn: TurnContext, params: LatencyParams): LeverClaim[];
}

function claim(lever: LeverId, startMs: number, endMs: number, weight: number): LeverClaim[] {
  return endMs > startMs && weight > 0 ? [{ lever, startMs, endMs, weight }] : [];
}

const LAYA_GATE_CALLS: LeverDefinition = {
  id: "laya_gate_calls",
  title: "Laya answers the routing-tier yes/no judges",
  kind: "classifier",
  assumption: (p) => `Every routing-tier call that decides a Laya point (receptionist → fast_lane, source judge → source_sensitive, `
    + `ungrounded-claim judge, disagreement check, goal-met oversight, progress judge) is replaced by a ${p.layaMs} ms Laya answer, `
    + `in ${Math.round(p.coverage * 100)}% of cases. A receptionist that answered the message itself is not claimed: Laya may only say "task" there. `
    + "The progress judge's \"drifting\" is not Laya's to say either, but its row does not record the verdict, so every progress-judge call is "
    + "claimed. A judge that ran beside work the turn still waits for (document RAG beside the source judge) saves only what that work "
    + "did not cover; the audit does not place that work on the clock, so the judge is claimed in full. "
    + "Triage and restatement rescue write text, not a choice, and are not claimed. Where Laya is asked first (a point that has "
    + "qualified, decisions.layaFirstMs) a taken answer never sends the incumbent request; everywhere else decide() starts both, "
    + "and there this saves wall time, not model-server load.",
  claims: (turn, p) => turn.calls.flatMap((call) => {
    if (!call.decisionPoint) return [];
    if (call.decisionPoint === FAST_LANE.id && turn.fastLane === true) return [];
    return claim("laya_gate_calls", call.startMs + p.layaMs, call.endMs, p.coverage);
  }),
};

const PRE_ROUTER_DISPATCH: LeverDefinition = {
  id: "pre_router_dispatch",
  title: "A pre-router dispatches the single specialist directly",
  kind: "classifier",
  assumption: (p) => "On a turn whose first dispatch starts ONE sub-agent (a delegation or a one-step plan) and whose only earlier tools "
    + "are agent search or planning, a router in front of the orchestrator starts that sub-agent itself. Claimed: the span from the "
    + `first orchestrator call to the dispatch (its calls and the search or plan tools between them), less ${p.layaMs} ms, in `
    + `${Math.round(p.coverage * 100)}% of cases. The gate calls before the first orchestrator call are not claimed again. It assumes the `
    + "router picks the same agent and that the specialist does not need the orchestrator's rewritten task: follow-up tasks carry "
    + "context from earlier turns, which a router must pass on. The orchestrator's closing call after the delegation stays.",
  claims: (turn, p) => {
    const dispatch = findDispatch(turn);
    const first = orchestratorCalls(turn)[0];
    if (!dispatch?.preRoutable || !first || first.startMs >= dispatch.startMs) return [];
    return claim("pre_router_dispatch", first.startMs + p.layaMs, dispatch.startMs, p.coverage);
  },
};

const PLAN_ROUND_FOLD: LeverDefinition = {
  id: "plan_round_fold",
  title: "record_plan goes out with the step it plans",
  kind: "restructure",
  assumption: () => "When an orchestrator response did nothing but record a plan, the next orchestrator call exists only to act on it. "
    + "Folding the plan into the acting response removes that round: from the end of the call that recorded the plan to the end of "
    + "the next orchestrator call.",
  claims: (turn) => {
    const orchestrator = orchestratorCalls(turn);
    return turn.plans.flatMap((plan) => {
      const before = [...orchestrator].reverse().find((call) => call.endMs <= plan.atMs);
      const after = orchestrator.find((call) => call.startMs >= plan.atMs);
      if (!before || !after) return [];
      const asked = turn.requested.filter((req) => req.atMs >= before.endMs && req.atMs <= after.startMs);
      if (asked.length === 0 || asked.some((req) => req.tool !== "record_plan")) return [];
      return claim("plan_round_fold", before.endMs, after.endMs, 1);
    });
  },
};

const SUBAGENT_PREWARM: LeverDefinition = {
  id: "subagent_prewarm",
  title: "The sub-agent's head is prefilled before it is needed",
  kind: "restructure",
  assumption: (p) => "A sub-agent's first call that processed its prompt cold would reach its first token as fast as a warm one "
    + `(${p.subagentWarmTtftMs} ms) had its head (tools + system prompt) been prefilled while the orchestrator was still deciding. `
    + "Claimed: the first call's prefill time above that. A wrong prediction costs model-server time, which this does not count. "
    + "The prefill hides behind the routing that precedes the dispatch; with pre_router_dispatch and laya_gate_calls also taken, less "
    + "of that routing is left to hide it behind, which the combined figure does not model: it counts shared instants once, not "
    + "levers that shrink each other's room.",
  claims: (turn, p) => turn.spans.flatMap((span) => {
    const first = turn.calls.find((call) => call.sessionId === span.sessionId && call.endMs > span.startMs && call.endMs <= span.endMs + 1);
    if (!first || first.estimate.prefillClass !== "cold") return [];
    const excess = first.estimate.prefillMs - p.subagentWarmTtftMs;
    return claim("subagent_prewarm", first.startMs, first.startMs + excess, 1);
  }),
};

const PREFIX_CACHE_KEPT: LeverDefinition = {
  id: "prefix_cache_kept",
  title: "Prompt prefixes stay cached",
  kind: "restructure",
  assumption: (p) => "An orchestrator call, or a sub-agent call after the first one of its kind in the run, that processed its prompt "
    + `cold would have found its prefix cached and reached its first token in ${p.orchestratorWarmTtftMs} ms (orchestrator) or `
    + `${p.subagentWarmTtftMs} ms (sub-agent). Claimed: its prefill above that. Cold here means the prefix changed or was pushed out: `
    + "a different tool list (the forced subset after the source judge said yes), a head that differs from the warmed one (the "
    + "orchestration module on artifact turns), or eviction by concurrent calls on the server's few slots. A sub-agent's calls are "
    + "grouped by their tool count, so a run's own side calls (distillation, forced answers: other prompts, no tools) are not its "
    + "loop's lost cache; the first call of each group is subagent_prewarm's or the side call's own. The restructurings behind it — "
    + "one stable tool block with the subset enforced at the call, a byte-stable head, fewer concurrent calls pushing prefixes out — "
    + "have costs of their own, which this does not count.",
  claims: (turn, p) => turn.calls.flatMap((call, index) => {
    if (call.estimate.prefillClass !== "cold") return [];
    let warmMs: number;
    if (!call.subSession && call.role === "orchestrator") {
      warmMs = p.orchestratorWarmTtftMs;
    } else if (call.subSession) {
      const sameKindEarlier = turn.calls.slice(0, index)
        .some((earlier) => earlier.sessionId === call.sessionId && earlier.toolCount === call.toolCount);
      if (!sameKindEarlier) return [];
      warmMs = p.subagentWarmTtftMs;
    } else {
      return [];
    }
    return claim("prefix_cache_kept", call.startMs, call.startMs + call.estimate.prefillMs - warmMs, 1);
  }),
};

const AGENT_SEARCH_WAIT: LeverDefinition = {
  id: "agent_search_wait",
  title: "Agent search answers at warm speed",
  kind: "restructure",
  assumption: (p) => `search_agents and list_agents take no longer than with a warm reranker (${p.agentSearchWarmMs} ms); the rest `
    + "(a cold reranker's load, a 15 s rerank timeout) is claimed. The extra orchestrator round an empty discovery capsule causes is "
    + "not claimed here; pre_router_dispatch claims it on turns a router could have dispatched.",
  claims: (turn, p) => turn.tools.flatMap((tool) => AGENT_SEARCH_TOOLS.has(tool.tool)
    ? claim("agent_search_wait", tool.startMs + p.agentSearchWarmMs, tool.endMs, 1)
    : []),
};

const QA_VERDICT_CANDIDATE: LeverDefinition = {
  id: "qa_verdict_candidate",
  title: "Laya passes QA verdicts it is sure of (candidate point)",
  kind: "classifier",
  assumption: (p) => `A QA verdict call that passed the answer is replaced by a ${p.layaMs} ms Laya "pass", in ${Math.round(p.coverage * 100)}% `
    + "of cases. A verdict followed by an improve call failed the answer and is not claimed: a candidate point may only take \"pass\". "
    + "The improve round and the second verdict a false FAIL causes are not claimed either. No such Laya point exists yet.",
  claims: (turn, p) => {
    const topLevel = turn.calls.filter((call) => !call.subSession);
    return topLevel.flatMap((call, index) => {
      if (call.callSite !== "qa") return [];
      const next = topLevel.slice(index + 1).find((later) => later.callSite === "qa" || QA_REPAIR_AGENTS.has(later.agentName));
      if (next && QA_REPAIR_AGENTS.has(next.agentName)) return [];
      return claim("qa_verdict_candidate", call.startMs + p.layaMs, call.endMs, p.coverage);
    });
  },
};

const VISION_STRUCTURING: LeverDefinition = {
  id: "vision_structuring",
  title: "Vision calls answer in a short structure, not prose",
  kind: "restructure",
  assumption: (p) => `A vision call (call site "vision") that decoded prose answers in about ${p.visionStructuredTokens} tokens instead; `
    + "claimed: its decode time above that. Only rows with call site \"vision\" count: analyze_image calls without a model-call row are "
    + "listed in the notes, not claimed.",
  claims: (turn, p) => turn.calls.flatMap((call) => {
    if (call.callSite !== "vision") return [];
    const saved = call.estimate.decodeMs - (p.visionStructuredTokens / p.decodeTokensPerSec) * 1_000;
    return claim("vision_structuring", call.endMs - saved, call.endMs, 1);
  }),
};

/**
 * What a run spent after its first loop row. Run c297c5ea's content_writer runs logged their first
 * loop detection within minutes and then circled for up to 20 more: the brake (agents.performance.
 * loopBrake) exists to end a run there, and this lever says how much turn time that is worth on
 * the turns measured. On builds with the brake, its refusal row is the signal; before it, the
 * detections the loop only logged.
 */
const LOOP_BRAKE: LeverDefinition = {
  id: "loop_brake",
  title: "A looping sub-agent run ends at its first loop signal",
  kind: "restructure",
  assumption: () => "A sub-agent run that logged a loop row — the brake's refusal (sub_agent_tool_loop_enforced) or a loop detection "
    + "(sub_agent_tool_loop_detected: the same arguments again, a write loop, the blocked-iteration stop) — ends at its first one. "
    + "Claimed: the run's time from that row to its end. An upper bound: the synthesis a stopped run still makes is claimed too, a "
    + "detection that was not a loop is claimed anyway, and the run's time only shortens the turn where nothing else of the turn ran "
    + "beside it (runs side by side are counted once, not as the sum). A run the brake already ended claims only the call after its "
    + "first refusal and its synthesis.",
  claims: (turn) => turn.spans.flatMap((span) => {
    const first = turn.loopSignals.find((signal) => signal.sessionId === span.sessionId
      && signal.atMs >= span.startMs && signal.atMs <= span.endMs);
    return first ? claim("loop_brake", first.atMs, span.endMs, 1) : [];
  }),
};

export const LEVERS: readonly LeverDefinition[] = Object.freeze([
  LAYA_GATE_CALLS,
  PRE_ROUTER_DISPATCH,
  PLAN_ROUND_FOLD,
  SUBAGENT_PREWARM,
  PREFIX_CACHE_KEPT,
  AGENT_SEARCH_WAIT,
  QA_VERDICT_CANDIDATE,
  VISION_STRUCTURING,
  LOOP_BRAKE,
]);

/** A lever's claims on one turn, cut to the turn's own span. */
export function leverClaims(lever: LeverDefinition, turn: TurnContext, params: LatencyParams): LeverClaim[] {
  return lever.claims(turn, params).flatMap((c) => claim(c.lever, Math.max(c.startMs, turn.startMs), Math.min(c.endMs, turn.endMs), c.weight));
}

/** The critical-path milliseconds one lever could remove from one turn. */
export function leverSavingMs(lever: LeverDefinition, turn: TurnContext, params: LatencyParams): number {
  return weightedUnionMs(leverClaims(lever, turn, params));
}

// ── Output ───────────────────────────────────────────────────────────────────────────────────

export interface TimelineEntry {
  kind: "model_call" | "tool_call" | "sub_agent" | "human_wait";
  /** Role for a model call, tool name for a tool, agent name for a sub-agent run. */
  label: string;
  level: "top" | "sub";
  startOffsetMs: number;
  endOffsetMs: number;
  durationMs: number;
  callSite?: string;
  agentName?: string;
  ttftMs?: number | null;
  headersMs?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  prefillMs?: number;
  decodeMs?: number;
  overheadMs?: number;
  basis?: CallEstimate["basis"];
  prefillClass?: PrefillClass;
  timings?: ServerTimings | null;
  relabelled?: boolean;
}

export interface TurnAttribution {
  index: number;
  sessionId: string;
  startedAt: string;
  ended: TurnContext["ended"];
  messageChars: number | null;
  fastLane: boolean | null;
  escalateReason: string | null;
  outcome: {
    outcomeStatus: string | null;
    finishReason: string | null;
    qaStatus: string | null;
    criteriaStatus: string | null;
    artifactProbeStatus: string | null;
    forcedSynthesisFired: boolean | null;
  };
  wallMs: number;
  renderMs: number;
  humanWaitMs: number;
  nonRenderMs: number;
  preOrchestrator: {
    /** Message arrival to the first orchestrator call's start (its request is sent a little earlier: see notes). */
    totalMs: number;
    routingTierMs: number;
    phasesMs: Record<string, number>;
    restMs: number;
    firstOrchestratorTtftMs: number | null;
    toFirstOrchestratorTokenMs: number | null;
  } | null;
  firstModelResponseMs: number | null;
  untrackedMs: number | null;
  llm: {
    calls: number;
    prefillMs: number;
    decodeMs: number;
    overheadMs: number;
    /** Call time that ran alongside another call of the turn (counted in each). */
    concurrentMs: number;
    withTimings: number;
  };
  dispatch: (Omit<DispatchInfo, "startMs"> & {
    /** From the first orchestrator call to the dispatch, unscaled: the routing round a pre-router would skip. */
    routeSpanMs: number | null;
  }) | null;
  levers: Record<LeverId, number>;
  combinedMs: number;
  timeline: TimelineEntry[];
}

export interface CallSiteStats {
  label: string;
  callSite: string;
  agentName: string;
  offTurn: boolean;
  calls: number;
  p50DurationMs: number | null;
  p90DurationMs: number | null;
  p50TtftMs: number | null;
  p50PromptTokens: number | null;
  cold: number;
  partial: number;
  warm: number;
  indeterminate: number;
  unknown: number;
  withTimings: number;
  prefillMs: number;
  decodeMs: number;
}

export interface LeverSummary {
  id: LeverId;
  title: string;
  kind: LeverDefinition["kind"];
  assumption: string;
  turnsAffected: number;
  totalMs: number;
  meanMsPerTurn: number | null;
  meanMsPerAffectedTurn: number | null;
  shareOfWall: number | null;
  shareOfNonRender: number | null;
}

export interface LatencyAttribution {
  scope: {
    turns: number;
    sessions: number;
    firstTurnAt: string | null;
    lastTurnAt: string | null;
    days: string[];
    subAgents: Array<{ agentName: string; runs: number }>;
    callSites: string[];
    turnsWithoutMessageSent: number;
    /** Turns in the rows that no figure includes, and why. */
    leftOut: { turns: number; sessions: string[]; reason: string };
    /** The audit records neither what a turn was about nor its language. */
    topics: "unknown";
    languages: "unknown";
    thin: boolean;
    rows: { total: number; offTurn: number };
  };
  params: LatencyParams;
  totals: {
    wallMs: number;
    renderMs: number;
    humanWaitMs: number;
    nonRenderMs: number;
    llmCalls: number;
    llmPrefillMs: number;
    llmDecodeMs: number;
    llmOverheadMs: number;
    llmConcurrentMs: number;
    llmWithTimings: number;
    preOrchestratorMs: number;
    turnsWithOrchestrator: number;
    offTurnCalls: number;
    offTurnCallMs: number;
    unattributedVision: { calls: number; ms: number };
    relabelledCalls: number;
  };
  callSites: CallSiteStats[];
  /**
   * Leaf tool calls by tool: the time the turns spent in tools that are not model calls and ran no
   * sub-agent (delegate_to_agent, execute_plan and run_workflow hold their sub-agents' calls and tools,
   * which are counted where they happen). Rendering is reported apart. Tools that ran side by side add
   * up past the wall clock.
   */
  tools: ToolStats[];
  turns: TurnAttribution[];
  levers: LeverSummary[];
  combined: {
    naiveSumMs: number;
    combinedMs: number;
    doubleCountedMs: number;
    meanMsPerTurn: number | null;
    shareOfWall: number | null;
    shareOfNonRender: number | null;
  };
  overlaps: Array<{ a: LeverId; b: LeverId; ms: number; turns: number }>;
  /** The routing-tier judges that decide a Laya point: how often each is asked and what it costs. */
  decisionPoints: Array<{
    point: DecisionPointId;
    calls: number;
    turns: number;
    perTurn: number | null;
    p50Ms: number | null;
    meanMs: number | null;
    /** Calls Laya's allowed answers could take (a receptionist that answered itself cannot be). */
    claimable: number;
  }>;
  /** What layer 3 needs from these turns, measured rather than assumed. */
  handoff: {
    /** decisions:bench --frequency: decisions per attributed turn, per point. */
    frequencyPerTurn: Partial<Record<DecisionPointId, number>>;
    /** routing:prerouter --round-ms: the span a pre-router would skip, on the turns it could take. */
    preRouterRoundMs: { turns: number; p50: number | null; mean: number | null };
  };
  /** What rewriting a run's history mid-run cost the call after it (see historyBreakReport). */
  historyBreaks: HistoryBreakReport;
  notes: string[];
}

const PRE_ORCHESTRATOR_PHASES = ["discoveryPrefetch", "documentRag", "userProfilePrefetch"] as const;

function scoreString(record: Record<string, unknown> | null, key: string): string | null {
  return record ? ident(record[key]) : null;
}

function attributeTurn(turn: TurnContext, index: number, params: LatencyParams): { view: TurnAttribution; claims: Map<LeverId, LeverClaim[]> } {
  const wallMs = Math.max(0, turn.endMs - turn.startMs);
  const window: Interval = { start: turn.startMs, end: turn.endMs };
  const clip = (iv: Interval): Interval => ({ start: Math.max(iv.start, window.start), end: Math.min(iv.end, window.end) });
  const human = turn.humanWaits.map((w) => clip({ start: w.startMs, end: w.endMs }));
  const renderTools = new Set(params.renderTools);
  const renders = turn.tools.filter((tool) => renderTools.has(tool.tool)).map((tool) => clip({ start: tool.startMs, end: tool.endMs }));
  const renderMs = measureOutside(renders, human);
  const humanWaitMs = measure(human);
  const nonRenderMs = Math.max(0, wallMs - renderMs - humanWaitMs);

  const orchestrator = orchestratorCalls(turn);
  const firstOrchestrator = orchestrator[0];
  const perf = turn.performance;
  const phaseTimings = asRecord(perf?.["phaseTimingsMs"]);
  let preOrchestrator: TurnAttribution["preOrchestrator"] = null;
  if (firstOrchestrator) {
    const totalMs = Math.max(0, firstOrchestrator.startMs - turn.startMs);
    // A union, not a sum: the receptionist and the source judge may run side by side.
    const routingTierMs = measure(turn.calls
      .filter((call) => !call.subSession && (call.callSite === "routing_tier" || call.relabelled) && call.endMs <= firstOrchestrator.startMs + 1)
      .map((call) => ({ start: Math.max(call.startMs, turn.startMs), end: call.endMs })));
    const phasesMs: Record<string, number> = {};
    for (const phase of PRE_ORCHESTRATOR_PHASES) {
      const value = num(phaseTimings?.[phase]);
      if (value !== null) phasesMs[phase] = value;
    }
    const firstTtft = firstOrchestrator.ttftMs ?? (firstOrchestrator.estimate.basis === "none" ? null : firstOrchestrator.estimate.prefillMs);
    preOrchestrator = {
      totalMs: round(totalMs),
      routingTierMs: round(routingTierMs),
      phasesMs,
      restMs: round(Math.max(0, totalMs - routingTierMs - sum(Object.values(phasesMs)))),
      firstOrchestratorTtftMs: firstTtft === null ? null : round(firstTtft),
      toFirstOrchestratorTokenMs: firstTtft === null ? null : round(totalMs + firstTtft),
    };
  }

  const callIntervals = turn.calls.map((call) => clip({ start: call.startMs, end: call.endMs }));
  const llmWallMs = sum(callIntervals.map((iv) => Math.max(0, iv.end - iv.start)));
  const dispatch = findDispatch(turn);

  const claims = new Map<LeverId, LeverClaim[]>();
  const levers = {} as Record<LeverId, number>;
  for (const lever of LEVERS) {
    const own = leverClaims(lever, turn, params);
    claims.set(lever.id, own);
    levers[lever.id] = round(weightedUnionMs(own));
  }
  const combinedMs = round(weightedUnionMs([...claims.values()].flat()));

  const offset = (ms: number): number => round(ms - turn.startMs);
  const timeline: TimelineEntry[] = [
    ...turn.calls.map((call): TimelineEntry => ({
      kind: "model_call",
      label: call.role,
      level: call.subSession ? "sub" : "top",
      startOffsetMs: offset(call.startMs),
      endOffsetMs: offset(call.endMs),
      durationMs: round(call.durationMs),
      callSite: call.callSite,
      agentName: call.agentName,
      ttftMs: call.ttftMs,
      headersMs: call.headersMs,
      promptTokens: call.promptTokens,
      completionTokens: call.completionTokens,
      prefillMs: round(call.estimate.prefillMs),
      decodeMs: round(call.estimate.decodeMs),
      overheadMs: round(call.estimate.overheadMs),
      basis: call.estimate.basis,
      prefillClass: call.estimate.prefillClass,
      timings: call.timings,
      ...(call.relabelled ? { relabelled: true } : {}),
    })),
    ...turn.tools.map((tool): TimelineEntry => ({
      kind: "tool_call",
      label: tool.tool,
      level: tool.level === "orchestrator" ? "top" : "sub",
      startOffsetMs: offset(tool.startMs),
      endOffsetMs: offset(tool.endMs),
      durationMs: round(tool.durationMs),
    })),
    ...turn.spans.map((span): TimelineEntry => ({
      kind: "sub_agent",
      label: span.agentName,
      level: "sub",
      startOffsetMs: offset(span.startMs),
      endOffsetMs: offset(span.endMs),
      durationMs: round(span.endMs - span.startMs),
    })),
    ...turn.humanWaits.map((w): TimelineEntry => ({
      kind: "human_wait",
      label: "human_wait",
      // A settings dialog a sub-agent's tool opened belongs under that tool, not beside it.
      level: turn.spans.some((span) => w.startMs >= span.startMs && w.endMs <= span.endMs + 50) ? "sub" : "top",
      startOffsetMs: offset(w.startMs),
      endOffsetMs: offset(w.endMs),
      durationMs: round(w.endMs - w.startMs),
    })),
  ].sort((a, b) => a.startOffsetMs - b.startOffsetMs || a.endOffsetMs - b.endOffsetMs);

  const scorecard = turn.scorecard;
  const view: TurnAttribution = {
    index,
    sessionId: turn.sessionId,
    startedAt: new Date(turn.startMs).toISOString(),
    ended: turn.ended,
    messageChars: turn.messageChars,
    fastLane: turn.fastLane,
    escalateReason: turn.escalateReason,
    outcome: {
      outcomeStatus: scoreString(scorecard, "outcomeStatus"),
      finishReason: scoreString(scorecard, "finishReason") ?? scoreString(perf, "finishReason"),
      qaStatus: scoreString(scorecard, "qaStatus"),
      criteriaStatus: scoreString(scorecard, "criteriaStatus"),
      artifactProbeStatus: scoreString(scorecard, "artifactProbeStatus"),
      forcedSynthesisFired: typeof scorecard?.["forcedSynthesisFired"] === "boolean" ? scorecard["forcedSynthesisFired"] : null,
    },
    wallMs: round(wallMs),
    renderMs: round(renderMs),
    humanWaitMs: round(humanWaitMs),
    nonRenderMs: round(nonRenderMs),
    preOrchestrator,
    firstModelResponseMs: num(perf?.["firstModelResponseMs"]),
    untrackedMs: num(perf?.["untrackedMs"]),
    llm: {
      calls: turn.calls.length,
      prefillMs: round(sum(turn.calls.map((call) => call.estimate.prefillMs))),
      decodeMs: round(sum(turn.calls.map((call) => call.estimate.decodeMs))),
      overheadMs: round(sum(turn.calls.map((call) => call.estimate.overheadMs))),
      concurrentMs: round(llmWallMs - measure(callIntervals)),
      withTimings: turn.calls.filter((call) => call.timings !== null).length,
    },
    dispatch: dispatch ? {
      tool: dispatch.tool,
      directSubAgents: dispatch.directSubAgents,
      planSteps: dispatch.planSteps,
      single: dispatch.single,
      toolsBefore: dispatch.toolsBefore,
      preRoutable: dispatch.preRoutable,
      routeSpanMs: firstOrchestrator && firstOrchestrator.startMs < dispatch.startMs ? round(dispatch.startMs - firstOrchestrator.startMs) : null,
    } : null,
    levers,
    combinedMs,
    timeline,
  };
  return { view, claims };
}

function callSiteStats(calls: readonly CallRecord[], offTurn: boolean): CallSiteStats[] {
  const groups = new Map<string, CallRecord[]>();
  for (const call of calls) {
    const label = call.relabelled
      ? `routing_tier/${call.role} (relabelled from main_turn)`
      : call.role === "main_no_tools" ? `${call.callSite}/${call.agentName} (no tools)`
        : call.callSite === "-" && call.agentName === "-" ? "(unattributed)" : `${call.callSite}/${call.agentName}`;
    groups.set(label, [...(groups.get(label) ?? []), call]);
  }
  return [...groups.entries()].map(([label, group]) => {
    const durations = group.map((call) => call.durationMs);
    const ttfts = group.flatMap((call) => (call.ttftMs !== null ? [call.ttftMs] : []));
    const prompts = group.flatMap((call) => (call.promptTokens !== null ? [call.promptTokens] : []));
    const count = (cls: PrefillClass): number => group.filter((call) => call.estimate.prefillClass === cls).length;
    return {
      label: offTurn ? `${label} (off turn)` : label,
      callSite: group[0]!.callSite,
      agentName: group[0]!.agentName,
      offTurn,
      calls: group.length,
      p50DurationMs: percentile(durations, 0.5),
      p90DurationMs: percentile(durations, 0.9),
      p50TtftMs: percentile(ttfts, 0.5),
      p50PromptTokens: percentile(prompts, 0.5),
      cold: count("cold"),
      partial: count("partial"),
      warm: count("warm"),
      indeterminate: count("indeterminate"),
      unknown: count("unknown"),
      withTimings: group.filter((call) => call.timings !== null).length,
      prefillMs: round(sum(group.map((call) => call.estimate.prefillMs))),
      decodeMs: round(sum(group.map((call) => call.estimate.decodeMs))),
    };
  }).sort((a, b) => b.calls - a.calls || a.label.localeCompare(b.label));
}

export interface ToolStats {
  tool: string;
  /** Where it ran: called by the orchestrator, or inside a sub-agent. */
  level: "orchestrator" | "sub_agent";
  calls: number;
  totalMs: number;
  p50Ms: number | null;
  p90Ms: number | null;
  failed: number;
}

function toolStats(turns: readonly TurnContext[], params: LatencyParams): ToolStats[] {
  const renderTools = new Set(params.renderTools);
  const groups = new Map<string, ToolRecord[]>();
  for (const turn of turns) {
    for (const tool of turn.tools) {
      if (renderTools.has(tool.tool) || spansInside(turn, tool).length > 0) continue;
      const key = `${tool.level}|${tool.tool}`;
      groups.set(key, [...(groups.get(key) ?? []), tool]);
    }
  }
  return [...groups.values()].map((group) => {
    const durations = group.map((tool) => tool.durationMs);
    return {
      tool: group[0]!.tool,
      level: group[0]!.level,
      calls: group.length,
      totalMs: round(sum(durations)),
      p50Ms: percentile(durations, 0.5),
      p90Ms: percentile(durations, 0.9),
      failed: group.filter((tool) => tool.success === false).length,
    };
  }).sort((a, b) => b.totalMs - a.totalMs || a.tool.localeCompare(b.tool));
}

/** Attribute every turn in these rows. Deterministic: the same rows and parameters give the same report. */
export function attributeLatency(rows: readonly AuditRow[], paramsIn: Partial<LatencyParams> = {}): LatencyAttribution {
  const params: LatencyParams = { ...DEFAULT_LATENCY_PARAMS, ...paramsIn };
  const { turns: allTurns, offTurnCalls, offTurnRows } = buildTurnContexts(rows, params);
  // A turn without a single model-call row cannot be attributed (builds before 2026-09-21 wrote
  // provider rows without a session): its wall time would only dilute every share, so it is left out
  // of every figure and counted in the scope instead.
  const turns = allTurns.filter((turn) => turn.calls.length > 0);
  const leftOut = allTurns.filter((turn) => turn.calls.length === 0);
  const attributed = turns.map((turn, index) => attributeTurn(turn, index + 1, params));
  const views = attributed.map((entry) => entry.view);

  const totalWall = sum(views.map((turn) => turn.wallMs));
  const totalNonRender = sum(views.map((turn) => turn.nonRenderMs));
  const perTurn = (ms: number): number | null => (views.length > 0 ? round(ms / views.length) : null);

  const levers: LeverSummary[] = LEVERS.map((lever) => {
    const values = views.map((turn) => turn.levers[lever.id]);
    const affected = values.filter((value) => value > 0);
    const totalMs = sum(values);
    return {
      id: lever.id,
      title: lever.title,
      kind: lever.kind,
      assumption: lever.assumption(params),
      turnsAffected: affected.length,
      totalMs,
      meanMsPerTurn: perTurn(totalMs),
      meanMsPerAffectedTurn: affected.length > 0 ? round(totalMs / affected.length) : null,
      shareOfWall: ratio(totalMs, totalWall),
      shareOfNonRender: ratio(totalMs, totalNonRender),
    };
  });

  const overlaps: LatencyAttribution["overlaps"] = [];
  for (let i = 0; i < LEVER_IDS.length; i += 1) {
    for (let j = i + 1; j < LEVER_IDS.length; j += 1) {
      const a = LEVER_IDS[i]!;
      const b = LEVER_IDS[j]!;
      let ms = 0;
      let affected = 0;
      for (const entry of attributed) {
        const shared = weightedOverlapMs(entry.claims.get(a) ?? [], entry.claims.get(b) ?? []);
        if (shared > 0) {
          ms += shared;
          affected += 1;
        }
      }
      if (round(ms) > 0) overlaps.push({ a, b, ms: round(ms), turns: affected });
    }
  }

  const naiveSumMs = sum(levers.map((lever) => lever.totalMs));
  const combinedMs = sum(views.map((turn) => turn.combinedMs));

  const inTurnCalls = turns.flatMap((turn) => turn.calls);
  // An analyze_image run with a vision model-call row inside it is attributed; one without is not.
  const visionTools = turns.flatMap((turn) => turn.tools.filter((tool) => tool.tool === VISION_TOOL
    && !turn.calls.some((call) => call.callSite === "vision" && call.startMs >= tool.startMs - 50 && call.endMs <= tool.endMs + 50)));
  const unattributedVision = { calls: visionTools.length, ms: round(sum(visionTools.map((tool) => tool.durationMs))) };

  const pointGroups = new Map<DecisionPointId, Array<{ call: CallRecord; turn: TurnContext }>>();
  for (const turn of turns) {
    for (const call of turn.calls) {
      if (call.decisionPoint) pointGroups.set(call.decisionPoint, [...(pointGroups.get(call.decisionPoint) ?? []), { call, turn }]);
    }
  }
  const decisionPoints: LatencyAttribution["decisionPoints"] = [...pointGroups.entries()].map(([point, group]) => ({
    point,
    calls: group.length,
    turns: new Set(group.map((entry) => entry.turn)).size,
    perTurn: ratio(group.length, turns.length),
    p50Ms: percentile(group.map((entry) => entry.call.durationMs), 0.5),
    meanMs: round(sum(group.map((entry) => entry.call.durationMs)) / group.length),
    claimable: group.filter((entry) => !(point === FAST_LANE.id && entry.turn.fastLane === true)).length,
  })).sort((a, b) => b.calls - a.calls || a.point.localeCompare(b.point));
  const routeSpans = views.flatMap((turn) => (turn.dispatch?.preRoutable && turn.dispatch.routeSpanMs !== null ? [turn.dispatch.routeSpanMs] : []));
  const handoff: LatencyAttribution["handoff"] = {
    frequencyPerTurn: Object.fromEntries(decisionPoints.flatMap((entry) => (entry.perTurn !== null ? [[entry.point, entry.perTurn]] : []))),
    preRouterRoundMs: {
      turns: routeSpans.length,
      p50: percentile(routeSpans, 0.5),
      mean: routeSpans.length > 0 ? round(sum(routeSpans) / routeSpans.length) : null,
    },
  };

  const subAgentRuns = new Map<string, number>();
  for (const turn of turns) for (const span of turn.spans) subAgentRuns.set(span.agentName, (subAgentRuns.get(span.agentName) ?? 0) + 1);

  const totals: LatencyAttribution["totals"] = {
    wallMs: totalWall,
    renderMs: sum(views.map((turn) => turn.renderMs)),
    humanWaitMs: sum(views.map((turn) => turn.humanWaitMs)),
    nonRenderMs: totalNonRender,
    llmCalls: inTurnCalls.length,
    llmPrefillMs: sum(views.map((turn) => turn.llm.prefillMs)),
    llmDecodeMs: sum(views.map((turn) => turn.llm.decodeMs)),
    llmOverheadMs: sum(views.map((turn) => turn.llm.overheadMs)),
    llmConcurrentMs: sum(views.map((turn) => turn.llm.concurrentMs)),
    llmWithTimings: inTurnCalls.filter((call) => call.timings !== null).length,
    preOrchestratorMs: sum(views.map((turn) => turn.preOrchestrator?.totalMs ?? 0)),
    turnsWithOrchestrator: views.filter((turn) => turn.preOrchestrator !== null).length,
    offTurnCalls: offTurnCalls.length,
    offTurnCallMs: round(sum(offTurnCalls.map((call) => call.durationMs))),
    unattributedVision,
    relabelledCalls: inTurnCalls.filter((call) => call.relabelled).length,
  };

  const starts = views.map((turn) => turn.startedAt).sort();
  const scope: LatencyAttribution["scope"] = {
    turns: views.length,
    sessions: new Set(views.map((turn) => turn.sessionId)).size,
    firstTurnAt: starts[0] ?? null,
    lastTurnAt: starts[starts.length - 1] ?? null,
    days: [...new Set(starts.map((iso) => iso.slice(0, 10)))],
    subAgents: [...subAgentRuns.entries()].map(([agentName, runs]) => ({ agentName, runs })).sort((a, b) => b.runs - a.runs || a.agentName.localeCompare(b.agentName)),
    callSites: [...new Set(inTurnCalls.map((call) => call.callSite))].sort(),
    turnsWithoutMessageSent: views.filter((turn) => turn.ended === "no_message_sent").length,
    leftOut: {
      turns: leftOut.length,
      sessions: [...new Set(leftOut.map((turn) => turn.sessionId))],
      reason: "no model-call row in the turn",
    },
    topics: "unknown",
    languages: "unknown",
    thin: views.length < params.thinDataTurns,
    rows: { total: rows.length, offTurn: offTurnRows },
  };

  return {
    scope,
    params,
    totals,
    callSites: [...callSiteStats(inTurnCalls, false), ...callSiteStats(offTurnCalls, true)],
    tools: toolStats(turns, params),
    turns: views,
    levers,
    combined: {
      naiveSumMs,
      combinedMs,
      doubleCountedMs: naiveSumMs - combinedMs,
      meanMsPerTurn: perTurn(combinedMs),
      shareOfWall: ratio(combinedMs, totalWall),
      shareOfNonRender: ratio(combinedMs, totalNonRender),
    },
    overlaps,
    decisionPoints,
    handoff,
    historyBreaks: historyBreakReport(rows, turns),
    notes: buildNotes(inTurnCalls, totals, scope, params),
  };
}

function buildNotes(calls: readonly CallRecord[], totals: LatencyAttribution["totals"], scope: LatencyAttribution["scope"], params: LatencyParams): string[] {
  const notes: string[] = [];
  if (scope.thin) {
    notes.push(`THIN DATA: ${scope.turns} turn(s) in ${scope.sessions} session(s), below the ${params.thinDataTurns} turns a figure here needs `
      + "before it means more than an anecdote. Topics and languages are not in the audit.");
  }
  const headerClocked = calls.filter((call) => call.mode === "stream" && call.headersMs === null).length;
  if (headerClocked > 0) {
    notes.push(`${headerClocked} stream call(s) were timed from their response headers (builds before 2026-09-26), complete calls from `
      + "the send. Those stream calls' connect, proxy hop and queueing are not in their duration; they show up as the gap before them "
      + "(inside preOrchestrator.restMs for the first orchestrator call), and their durations are not comparable with complete calls'.");
  }
  if (calls.some((call) => call.headersMs !== null)) {
    notes.push("Stream calls carrying headersMs were timed from the send. headersMs is shown, not used to split the call: whether "
      + "the server answers before or after processing the prompt decides what it holds (latency:probe measures that).");
  }
  if (totals.llmCalls > 0 && totals.llmWithTimings === 0) {
    notes.push("No model call carries llama.cpp timings, so prefill and decode are estimates: the time to first token for stream calls, "
      + `duration minus completionTokens at ${params.decodeTokensPerSec} tok/s for complete calls (their per-call overhead sits in "prefill"). `
      + "Queueing on a busy model server reads as prefill.");
  } else if (totals.llmWithTimings < totals.llmCalls) {
    notes.push(`${totals.llmWithTimings} of ${totals.llmCalls} model calls carry llama.cpp timings; the rest are estimated.`);
  }
  if (totals.unattributedVision.calls > 0) {
    notes.push(`analyze_image ran ${totals.unattributedVision.calls} time(s) for ${(totals.unattributedVision.ms / 1_000).toFixed(1)} s without a `
      + "model-call row: a vision model call on the same server whose prefill and decode cannot be told apart. vision_structuring "
      + "claims nothing for it.");
  }
  notes.push("Embedding calls (discovery prefetch, search_agents, tool rerank) run on the same model server and are not audited as model "
    + "calls: their time sits in tool durations, phase timings and gaps.");
  if (totals.offTurnCalls > 0) {
    notes.push(`${totals.offTurnCalls} model call(s) with no session or a cache warm-up (the warm-keeper, a sub-agent's head re-warm) took `
      + `${(totals.offTurnCallMs / 1_000).toFixed(1)} s of model-server time outside any turn. They are on no turn's critical path, but they share `
      + "the server with the turns.");
  }
  if (totals.relabelledCalls > 0) {
    notes.push(`${totals.relabelledCalls} tool-less main_turn call(s) that finished before the receptionist's verdict row were counted as `
      + "the receptionist (builds before 2026-09-25 stamped it main/main_turn).");
  }
  if (totals.llmConcurrentMs > 0) {
    notes.push(`${(totals.llmConcurrentMs / 1_000).toFixed(1)} s of model-call time ran alongside another call of the same turn and is counted `
      + "in each call's prefill and decode sums; lever claims count such seconds once.");
  }
  return notes;
}

// ── History breaks ───────────────────────────────────────────────────────────────────────────

/**
 * Rows that rewrite a run's history in the middle of the run. Every message behind the rewritten
 * one is new to the server, so the next call of that run re-prefills from the last checkpoint that
 * still matches — in c297c5ea at exactly cacheN 7,591, the end of content_writer's head: 18.6 s,
 * 39.6 s (30,269 tokens) and 51.5 s (35,399 tokens) for three such calls, about 110-120 s of the
 * turn, more than the first-call prewarm the plan had ranked above it. How often that happens is
 * what the report has to say before anything is redesigned (C3' of the cache plan, "N1").
 */
export const HISTORY_BREAK_ROW_TYPES: readonly string[] = ["sub_agent_history_digested", "sub_agent_history_trimmed", "history_compacted"];

/** Slack for a break row written just before the send its call's start is derived from (end − duration). */
const HISTORY_BREAK_JOIN_SLACK_MS = 250;

export interface HistoryBreakCall {
  rowId: string;
  durationMs: number;
  ttftMs: number | null;
  promptTokens: number | null;
  promptN: number | null;
  cacheN: number | null;
  promptMs: number | null;
}

export interface HistoryBreak {
  /** The turn's index in report.turns (1-based). */
  turn: number;
  sessionId: string;
  agentName: string | null;
  /** The row types that announced this break (a digest and a trim on one iteration are one break). */
  rowTypes: string[];
  /** digestTrigger on a digest row: "batch" (one break per batch of stale mass) or "overflow". */
  trigger: string | null;
  atOffsetMs: number;
  /** The run's next model call after the break: the one that re-prefilled. */
  next: HistoryBreakCall | null;
  /** The run's call before the break, for what a call cost when its prefix was still cached. */
  previous: HistoryBreakCall | null;
  /** Prompt processing of the next call: llama.cpp's prompt_ms, else its time to first token. */
  reprefillMs: number | null;
  /** reprefillMs above the previous call's prompt processing: what the break itself cost. */
  excessMs: number | null;
}

export interface HistoryBreakReport {
  breaks: HistoryBreak[];
  perTurn: Array<{ turn: number; sessionId: string; breaks: number; reprefillMs: number; excessMs: number; reprocessedTokens: number }>;
  totals: {
    breaks: number;
    turnsAffected: number;
    reprefillMs: number;
    excessMs: number;
    /** promptN of the calls after a break: tokens processed again. */
    reprocessedTokens: number;
    /** Breaks with llama.cpp timings on their next call (the others fall back to its TTFT). */
    withTimings: number;
    /** Breaks whose run made no further call (the run ended, or its next call left no row). */
    withoutNextCall: number;
  };
}

function breakCall(call: CallRecord): HistoryBreakCall {
  return {
    rowId: call.rowId,
    durationMs: round(call.durationMs),
    ttftMs: call.ttftMs,
    promptTokens: call.promptTokens,
    promptN: call.timings?.promptN ?? null,
    cacheN: call.timings?.cacheN ?? null,
    promptMs: call.timings ? round(call.timings.promptMs) : null,
  };
}

/** A run's own loop call: the orchestrator's for the top-level session, the sub-agent's for a run. */
function isLoopCall(call: CallRecord): boolean {
  return call.role === "orchestrator" || call.role === "sub_agent";
}

/**
 * Join every history break with the call it made expensive: the next model call of the same run
 * (same session, a loop call, started at or after the break), and the run's call before it.
 * Rows outside any attributed turn are left out, like every other figure here.
 */
export function historyBreakReport(rows: readonly AuditRow[], turns: readonly TurnContext[]): HistoryBreakReport {
  const types = new Set(HISTORY_BREAK_ROW_TYPES);
  const byNextCall = new Map<string, HistoryBreak>();
  const breaks: HistoryBreak[] = [];
  const sorted = rows.filter((row) => types.has(row.type) && row.sessionId).sort((a, b) => tsMs(a) - tsMs(b));
  for (const row of sorted) {
    const at = tsMs(row);
    const sessionId = row.sessionId!;
    const root = rootSessionId(sessionId);
    const turnIndex = turns.findIndex((turn) => turn.sessionId === root && at >= turn.startMs && at <= turn.endMs);
    if (turnIndex < 0) continue;
    const turn = turns[turnIndex]!;
    const runCalls = turn.calls.filter((call) => call.sessionId === sessionId && isLoopCall(call));
    const nextCall = runCalls.find((call) => call.startMs >= at - HISTORY_BREAK_JOIN_SLACK_MS);
    const previousCall = [...runCalls].reverse().find((call) => call.endMs <= at + HISTORY_BREAK_JOIN_SLACK_MS && call !== nextCall);
    const trigger = ident(row.data["digestTrigger"]);
    // One iteration can write a digest row and a trim row; both announce the same rewrite and the
    // same expensive call, so they are one break.
    const joined = nextCall ? byNextCall.get(nextCall.rowId) : undefined;
    if (joined) {
      if (!joined.rowTypes.includes(row.type)) joined.rowTypes.push(row.type);
      joined.trigger ??= trigger;
      continue;
    }
    const reprefill = nextCall ? (nextCall.timings?.promptMs ?? nextCall.ttftMs) : null;
    const before = previousCall ? (previousCall.timings?.promptMs ?? previousCall.ttftMs) : null;
    const entry: HistoryBreak = {
      turn: turnIndex + 1,
      sessionId,
      agentName: ident(row.data["agentName"]),
      rowTypes: [row.type],
      trigger,
      atOffsetMs: round(at - turn.startMs),
      next: nextCall ? breakCall(nextCall) : null,
      previous: previousCall ? breakCall(previousCall) : null,
      reprefillMs: reprefill === null ? null : round(reprefill),
      excessMs: reprefill === null ? null : round(Math.max(0, reprefill - (before ?? 0))),
    };
    breaks.push(entry);
    if (nextCall) byNextCall.set(nextCall.rowId, entry);
  }
  const perTurnMap = new Map<number, HistoryBreakReport["perTurn"][number]>();
  for (const entry of breaks) {
    const slot = perTurnMap.get(entry.turn) ?? { turn: entry.turn, sessionId: turns[entry.turn - 1]!.sessionId, breaks: 0, reprefillMs: 0, excessMs: 0, reprocessedTokens: 0 };
    slot.breaks += 1;
    slot.reprefillMs += entry.reprefillMs ?? 0;
    slot.excessMs += entry.excessMs ?? 0;
    slot.reprocessedTokens += entry.next?.promptN ?? 0;
    perTurnMap.set(entry.turn, slot);
  }
  const perTurn = [...perTurnMap.values()].sort((a, b) => a.turn - b.turn);
  return {
    breaks,
    perTurn,
    totals: {
      breaks: breaks.length,
      turnsAffected: perTurn.length,
      reprefillMs: sum(perTurn.map((slot) => slot.reprefillMs)),
      excessMs: sum(perTurn.map((slot) => slot.excessMs)),
      reprocessedTokens: sum(perTurn.map((slot) => slot.reprocessedTokens)),
      withTimings: breaks.filter((entry) => entry.next?.promptMs !== null && entry.next?.promptMs !== undefined).length,
      withoutNextCall: breaks.filter((entry) => entry.next === null).length,
    },
  };
}

// ── Markdown ─────────────────────────────────────────────────────────────────────────────────

export interface ReportInputs {
  files: Array<{ path: string; rows: number; malformedLines: number }>;
  duplicates: number;
}

function secs(ms: number | null | undefined): string {
  return ms === null || ms === undefined ? "–" : (ms / 1_000).toFixed(1);
}

function pct(value: number | null): string {
  return value === null ? "–" : `${(value * 100).toFixed(1)}%`;
}

function cell(value: string | number | boolean | null | undefined): string {
  return value === null || value === undefined ? "–" : String(value).replace(/\|/g, "\\|");
}

/** The report as Markdown: scope first, so thin data is never mistaken for proof. */
export function renderLatencyMarkdown(report: LatencyAttribution, inputs?: ReportInputs): string {
  const { scope, totals, params } = report;
  const lines: string[] = ["# Latency attribution", ""];

  lines.push("## Data scope", "");
  if (scope.thin) lines.push(`> **THIN DATA — ${scope.turns} turn(s), ${scope.sessions} session(s).** Treat every figure below as an anecdote, not a measurement.`, "");
  lines.push(`- Turns: **${scope.turns}** in **${scope.sessions}** session(s); ${scope.turnsWithoutMessageSent} without a reply row (aborted or cut off)`);
  if (scope.leftOut.turns > 0) {
    lines.push(`- Left out of every figure: ${scope.leftOut.turns} turn(s) with ${scope.leftOut.reason} `
      + `(sessions ${scope.leftOut.sessions.map((id) => id.slice(0, 8)).join(", ")})`);
  }
  lines.push(`- Date range: ${scope.firstTurnAt ?? "–"} → ${scope.lastTurnAt ?? "–"} (${scope.days.length} day(s))`);
  lines.push(`- Sub-agents seen: ${scope.subAgents.length ? scope.subAgents.map((s) => `${s.agentName} (${s.runs})`).join(", ") : "none"}`);
  lines.push(`- Call sites seen: ${scope.callSites.join(", ") || "none"}`);
  lines.push("- Topics: **unknown**, languages: **unknown** (the audit records neither)");
  lines.push(`- Rows: ${scope.rows.total} (${scope.rows.offTurn} outside any turn)`);
  if (inputs) {
    for (const file of inputs.files) lines.push(`- Input: \`${file.path}\` — ${file.rows} rows, ${file.malformedLines} malformed line(s)`);
    lines.push(`- Duplicate row ids dropped: ${inputs.duplicates}`);
  }
  lines.push(`- Parameters: decode ${params.decodeTokensPerSec} tok/s, cold prefill ${params.coldPrefillTokensPerSec} tok/s, cold ≥ ${params.coldShare}, `
    + `warm ≤ ${params.warmShare} of the prompt, indeterminate below ${params.indeterminateBelowTokens} tokens, coverage ${params.coverage}, `
    + `Laya ${params.layaMs} ms, sub-agent warm TTFT ${params.subagentWarmTtftMs} ms, warm agent search ${params.agentSearchWarmMs} ms`);
  lines.push("");

  lines.push("## Where the time goes", "");
  lines.push("| | seconds | share of wall | share of non-render |", "|---|---:|---:|---:|");
  const row = (name: string, ms: number): string => `| ${name} | ${secs(ms)} | ${pct(ratio(ms, totals.wallMs))} | ${pct(ratio(ms, totals.nonRenderMs))} |`;
  lines.push(`| Wall time (message → reply) | ${secs(totals.wallMs)} | 100% | – |`);
  lines.push(`| Image rendering | ${secs(totals.renderMs)} | ${pct(ratio(totals.renderMs, totals.wallMs))} | – |`);
  lines.push(`| Human waits | ${secs(totals.humanWaitMs)} | ${pct(ratio(totals.humanWaitMs, totals.wallMs))} | – |`);
  lines.push(`| Non-render time | ${secs(totals.nonRenderMs)} | ${pct(ratio(totals.nonRenderMs, totals.wallMs))} | 100% |`);
  lines.push(row("Model prefill (estimated)", totals.llmPrefillMs));
  lines.push(row("Model decode (estimated)", totals.llmDecodeMs));
  lines.push(row("Model overhead (timings only)", totals.llmOverheadMs));
  lines.push(row(`Before the first orchestrator call (${totals.turnsWithOrchestrator} turns)`, totals.preOrchestratorMs));
  lines.push("");

  lines.push("## Levers", "");
  lines.push("Critical-path seconds each lever could remove if it worked perfectly on these turns. Classifier levers are scaled by coverage.", "");
  lines.push("| lever | kind | turns | total s | mean s/turn | mean s/affected turn | % wall | % non-render |", "|---|---|---:|---:|---:|---:|---:|---:|");
  for (const lever of report.levers) {
    lines.push(`| ${lever.id} | ${lever.kind} | ${lever.turnsAffected} | ${secs(lever.totalMs)} | ${secs(lever.meanMsPerTurn)} | ${secs(lever.meanMsPerAffectedTurn)} | ${pct(lever.shareOfWall)} | ${pct(lever.shareOfNonRender)} |`);
  }
  const combined = report.combined;
  lines.push(`| **combined, each second once** | | | **${secs(combined.combinedMs)}** | **${secs(combined.meanMsPerTurn)}** | | **${pct(combined.shareOfWall)}** | **${pct(combined.shareOfNonRender)}** |`);
  lines.push("");
  lines.push(`Adding the levers up would give ${secs(combined.naiveSumMs)} s; ${secs(combined.doubleCountedMs)} s of that is claimed by more than one lever. `
    + "The combined figure counts each instant once, at the largest weight any lever claims for it.", "");
  if (report.overlaps.length > 0) {
    lines.push("Overlaps (seconds both levers claim):", "");
    for (const overlap of report.overlaps) lines.push(`- ${overlap.a} × ${overlap.b}: ${secs(overlap.ms)} s in ${overlap.turns} turn(s)`);
    lines.push("");
  }
  lines.push("Assumptions:", "");
  for (const lever of report.levers) lines.push(`- **${lever.id}** — ${lever.assumption}`);
  lines.push("");

  lines.push("## Decision points on these turns", "");
  if (report.decisionPoints.length === 0) lines.push("No routing-tier judge that decides a Laya point ran on these turns.", "");
  else {
    lines.push("| point | calls | turns | per turn | p50 s | mean s | Laya could take |", "|---|---:|---:|---:|---:|---:|---:|");
    for (const point of report.decisionPoints) {
      lines.push(`| ${point.point} | ${point.calls} | ${point.turns} | ${point.perTurn ?? "–"} | ${secs(point.p50Ms)} | ${secs(point.meanMs)} | ${point.claimable} |`);
    }
    lines.push("");
  }
  // decisions:bench refuses a point it has no cases for, so a pasted flag carrying one would fail:
  // those points are listed beside it instead.
  const frequencies = Object.entries(report.handoff.frequencyPerTurn);
  const frequency = frequencies.filter(([point]) => isBenchPoint(point)).map(([point, value]) => `${point}=${value}`).join(",");
  const unbenched = frequencies.filter(([point]) => !isBenchPoint(point)).map(([point, value]) => `${point} ${value}`);
  const routeRound = report.handoff.preRouterRoundMs;
  lines.push("Measured inputs for layer 3 (eval/latency/README.md):", "");
  lines.push(`- \`decisions:bench --frequency ${frequency || "<none measured>"}\``);
  if (unbenched.length > 0) lines.push(`- Per turn, points decisions:bench has no cases for yet: ${unbenched.join(", ")}`);
  lines.push(routeRound.p50 === null
    ? "- `routing:prerouter --round-ms`: no turn here a pre-router could have taken"
    : `- \`routing:prerouter --round-ms ${routeRound.p50}\` (median of ${routeRound.turns} turn(s) a pre-router could have taken; mean ${routeRound.mean} ms)`);
  lines.push("");

  lines.push("## Turns", "");
  lines.push("| # | session | started | msg chars | outcome | wall s | render s | human s | non-render s | before 1st orch s | to 1st orch token s | prefill s | decode s | combined lever s |",
    "|---:|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const turn of report.turns) {
    const outcome = [turn.outcome.outcomeStatus, turn.outcome.finishReason, turn.outcome.qaStatus && turn.outcome.qaStatus !== "not_run" ? `qa ${turn.outcome.qaStatus}` : null]
      .filter(Boolean).join(", ") || (turn.ended === "no_message_sent" ? "no reply row" : turn.ended === "fast_lane_reply" ? "fast lane" : "–");
    lines.push(`| ${turn.index} | ${turn.sessionId.slice(0, 8)} | ${turn.startedAt.slice(0, 19)}Z | ${cell(turn.messageChars)} | ${cell(outcome)} | ${secs(turn.wallMs)} | ${secs(turn.renderMs)} | `
      + `${secs(turn.humanWaitMs)} | ${secs(turn.nonRenderMs)} | ${secs(turn.preOrchestrator?.totalMs)} | ${secs(turn.preOrchestrator?.toFirstOrchestratorTokenMs)} | `
      + `${secs(turn.llm.prefillMs)} | ${secs(turn.llm.decodeMs)} | ${secs(turn.combinedMs)} |`);
  }
  lines.push("");
  lines.push(`| # | ${LEVER_IDS.join(" | ")} |`, `|---:|${LEVER_IDS.map(() => "---:").join("|")}|`);
  for (const turn of report.turns) lines.push(`| ${turn.index} | ${LEVER_IDS.map((id) => secs(turn.levers[id])).join(" | ")} |`);
  lines.push("");
  lines.push("Before the first orchestrator call:", "");
  for (const turn of report.turns) {
    const pre = turn.preOrchestrator;
    if (!pre) {
      lines.push(`- ${turn.index}: no orchestrator call${turn.fastLane ? " (answered by the fast lane)" : ""}`);
      continue;
    }
    const phases = Object.entries(pre.phasesMs).map(([name, ms]) => `${name} ${secs(ms)}`).join(", ");
    lines.push(`- ${turn.index}: ${secs(pre.totalMs)} s = routing-tier calls ${secs(pre.routingTierMs)}${phases ? `, ${phases}` : ""}, rest ${secs(pre.restMs)}`
      + `; first orchestrator TTFT ${secs(pre.firstOrchestratorTtftMs)} s; dispatch: ${turn.dispatch ? `${turn.dispatch.tool} (${turn.dispatch.single ? "single" : "not single"}`
        + `${turn.dispatch.toolsBefore.length ? `, after ${turn.dispatch.toolsBefore.join(", ")}` : ""})` : "none"}`);
  }
  lines.push("");

  lines.push("Timelines (top level; sub-agent work summarised under the tool that ran it):", "");
  for (const turn of report.turns) lines.push(`- ${turn.index}: ${timelineLine(turn)}`);
  lines.push("");

  lines.push("## Call sites", "");
  lines.push("| call site / agent | calls | p50 s | p90 s | p50 TTFT s | p50 prompt tok | cold | partial | warm | indeterminate | with timings |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const stat of report.callSites) {
    lines.push(`| ${cell(stat.label)} | ${stat.calls} | ${secs(stat.p50DurationMs)} | ${secs(stat.p90DurationMs)} | ${secs(stat.p50TtftMs)} | ${cell(stat.p50PromptTokens)} | `
      + `${stat.cold} | ${stat.partial} | ${stat.warm} | ${stat.indeterminate} | ${stat.withTimings} |`);
  }
  lines.push("");

  lines.push("## Tool time", "");
  lines.push("Leaf tools only: a tool that ran a sub-agent is left out (its time is that sub-agent's calls and tools); rendering is "
    + "reported above. Tools that ran side by side add up past the wall clock.", "");
  lines.push("| tool | where | calls | total s | p50 s | p90 s | failed |", "|---|---|---:|---:|---:|---:|---:|");
  for (const stat of report.tools.slice(0, 15)) {
    lines.push(`| ${cell(stat.tool)} | ${stat.level === "orchestrator" ? "orchestrator" : "sub-agent"} | ${stat.calls} | ${secs(stat.totalMs)} | `
      + `${secs(stat.p50Ms)} | ${secs(stat.p90Ms)} | ${stat.failed} |`);
  }
  if (report.tools.length > 15) lines.push(`| … ${report.tools.length - 15} more | | | ${secs(sum(report.tools.slice(15).map((stat) => stat.totalMs)))} | | | |`);
  lines.push("");

  const hb = report.historyBreaks;
  lines.push("## Re-prefill after history rewrites", "");
  lines.push("A digest or trim mid-run rewrites the run's history, so its next model call processes everything behind the last "
    + "matching checkpoint again. Re-prefill = that call's prompt processing (llama.cpp prompt_ms, else its TTFT); excess = above the run's "
    + "call before the break. Not a lever: no fix is claimed, this is the size of the problem.", "");
  if (hb.totals.breaks === 0) {
    lines.push("No history rewrite on these turns.", "");
  } else {
    lines.push(`**${hb.totals.breaks}** break(s) in ${hb.totals.turnsAffected} turn(s): re-prefill ${secs(hb.totals.reprefillMs)} s, excess `
      + `${secs(hb.totals.excessMs)} s, ${hb.totals.reprocessedTokens} tokens processed again; ${hb.totals.withTimings} with llama.cpp timings, `
      + `${hb.totals.withoutNextCall} without a following call.`, "");
    lines.push("| turn | session | breaks | re-prefill s | excess s | tokens again |", "|---:|---|---:|---:|---:|---:|");
    for (const slot of hb.perTurn) {
      lines.push(`| ${slot.turn} | ${slot.sessionId.slice(0, 8)} | ${slot.breaks} | ${secs(slot.reprefillMs)} | ${secs(slot.excessMs)} | ${slot.reprocessedTokens} |`);
    }
    lines.push("");
    lines.push("| turn | at s | agent | rows | trigger | next promptN | next cacheN | re-prefill s | before s | excess s |", "|---:|---:|---|---|---|---:|---:|---:|---:|---:|");
    for (const entry of hb.breaks) {
      const before = entry.previous ? (entry.previous.promptMs ?? entry.previous.ttftMs) : null;
      lines.push(`| ${entry.turn} | ${secs(entry.atOffsetMs)} | ${cell(entry.agentName)} | ${entry.rowTypes.join(", ")} | ${cell(entry.trigger)} | `
        + `${cell(entry.next?.promptN)} | ${cell(entry.next?.cacheN)} | ${secs(entry.reprefillMs)} | ${secs(before)} | ${secs(entry.excessMs)} |`);
    }
    lines.push("");
  }

  lines.push("## Notes", "");
  for (const note of report.notes) lines.push(`- ${note}`);
  lines.push("");
  return lines.join("\n");
}

function timelineLine(turn: TurnAttribution): string {
  const top = turn.timeline.filter((entry) => entry.level === "top");
  const parts: string[] = [];
  let cursor = 0;
  for (const entry of top) {
    if (entry.startOffsetMs - cursor >= 500) parts.push(`gap ${secs(entry.startOffsetMs - cursor)}`);
    if (entry.kind === "model_call") {
      const ttft = entry.ttftMs !== null && entry.ttftMs !== undefined ? ` ttft ${secs(entry.ttftMs)}` : "";
      parts.push(`${entry.label}${entry.relabelled ? "*" : ""} ${secs(entry.durationMs)}${ttft} [${entry.prefillClass}]`);
    } else if (entry.kind === "tool_call") {
      const inside = turn.timeline.filter((sub) => sub.level === "sub" && sub.startOffsetMs >= entry.startOffsetMs && sub.endOffsetMs <= entry.endOffsetMs + 50);
      const subCalls = inside.filter((sub) => sub.kind === "model_call");
      const subTools = inside.filter((sub) => sub.kind === "tool_call");
      const subWaits = inside.filter((sub) => sub.kind === "human_wait");
      const detail = subCalls.length || subTools.length
        ? ` (${subCalls.length} sub-agent call(s) ${secs(sum(subCalls.map((c) => c.durationMs)))}`
          + `${subTools.length ? `; ${subTools.map((t) => `${t.label} ${secs(t.durationMs)}`).join(", ")}` : ""}`
          + `${subWaits.length ? `; incl. human ${secs(sum(subWaits.map((w) => w.durationMs)))}` : ""})`
        : "";
      parts.push(`${entry.label} ${secs(entry.durationMs)}${detail}`);
    } else if (entry.kind === "human_wait") {
      parts.push(`human ${secs(entry.durationMs)}`);
    }
    cursor = Math.max(cursor, entry.endOffsetMs);
  }
  if (turn.wallMs - cursor >= 500) parts.push(`gap ${secs(turn.wallMs - cursor)}`);
  return parts.join(" > ") || "no rows";
}
