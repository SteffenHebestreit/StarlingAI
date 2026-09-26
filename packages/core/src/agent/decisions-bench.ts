/**
 * The decision bench's arithmetic: whether Laya pays off at a decision point, measured on labelled cases.
 *
 * Agreement alone cannot say it. The adaptive gate (decisions/gate.ts) counts how often Laya's answer matches the
 * incumbent's, per point, language and answer, so it measures the PRECISION of the answer Laya gives. On traffic
 * where the rare class hardly occurs (the source judge said "clear" on 25 of 25 real turns) a Laya that always says
 * the common answer agrees almost every time. Where a point names a protected answer (decisions/points.ts), the gate
 * also requires Laya's recall of it before any other answer qualifies; where it names none (fast_lane, whose miss
 * costs time), precision is all it checks. So every figure here is reported beside the rare class's recall and the
 * always-majority baseline, and the gate, recall guard included, is replayed on held-out cases with the rare-class
 * miss rate counted where it happens.
 *
 * What is computed, per point, labelled language and Laya checkpoint:
 * - accuracy of each arm against the gold label, Laya's agreement with the incumbent, precision and recall per
 *   answer (against gold, and Laya against the incumbent), the always-majority baselines, latency;
 * - the gate replayed as decisions/gate.ts runs it: levels qualified on a calibration half, applied to the other
 *   half, reporting coverage, the error rate among the cases Laya would take, and the rare-class miss rate;
 * - the projected seconds saved per 100 turns, for today's concurrent start (decisions/decide.ts starts the
 *   incumbent and Laya together) and for a Laya-first order that starts the incumbent only when Laya is not taken.
 *
 * Pure: the live run is scripts/decisions-bench.ts.
 */
import { createHash } from "node:crypto";
import { GATE_LEVELS, languageBucket, wilsonLowerBound, type LanguageBucket } from "../decisions/gate.js";
import type { LedgerRow } from "../decisions/ledger.js";
import { DECISION_POINTS, type DecisionPointId } from "../decisions/points.js";

// ── The points the bench can run ────────────────────────────────────────────────────────────────────

/** The points whose case is the user's message alone, so a labelled message is a complete case. */
export type BenchPointId = "fast_lane" | "source_sensitive";

export interface BenchPointProfile {
  point: BenchPointId;
  /** The answer that is rare on real traffic and costly to lose. */
  rareClass: string;
  /** The answers Laya may take on its own, as the point's decide() call passes them; null for all. */
  layaMayTake: readonly string[] | null;
  /**
   * The answer the gate protects (decisions/points.ts `protect`): Laya's other answers qualify only once its recall
   * of this one holds. Absent where the point protects none.
   */
  protect?: string;
  /** How often a turn asks this point. */
  frequencyPerTurn: number;
  /** The incumbent's time when a run did not measure it. */
  incumbentMsFallback: number;
  /** What a rare case costs downstream when Laya takes the other answer, in ms (0: the cost is not time). */
  missPenaltyMs: number;
  /** What a rare-class miss costs: a slower turn, or a worse answer. */
  missHarm: "latency" | "quality";
  /** The rare class's share of real traffic, for the projection. */
  rareClassPrior: number;
}

/** The point's protected answer as decide() hands it to the gate, read from the point itself so the replay cannot drift. */
function protectOf(point: BenchPointId): { protect?: string } {
  const protect = DECISION_POINTS[point].protect;
  return protect !== undefined ? { protect } : {};
}

/**
 * The defaults come from the 25 attributed turns of 2026-09-21..25 (one user, image requests only): thin, and
 * overridable per run. The priors are the observed rates with one pseudo-case on each side, because 0 of 15 and
 * 0 of 25 do not mean the rare class never occurs.
 */
export const BENCH_PROFILES: Readonly<Record<BenchPointId, BenchPointProfile>> = Object.freeze({
  fast_lane: Object.freeze({
    point: "fast_lane",
    rareClass: "small_talk",
    // agent/receptionist.ts: only the model can write the small-talk reply, so Laya may only send a message on.
    layaMayTake: Object.freeze(["task"]),
    ...protectOf("fast_lane"),
    // The front desk asked its model on 15 of 25 turns; it skips long messages without a call.
    frequencyPerTurn: 0.6,
    // The receptionist's p50.
    incumbentMsFallback: 1_844,
    // Small talk Laya sends on waits for the full path instead of the front desk's reply: at least the time to
    // the orchestrator's first token, p50 8.2 s.
    missPenaltyMs: 8_200,
    missHarm: "latency",
    rareClassPrior: (0 + 1) / (15 + 2),
  }),
  source_sensitive: Object.freeze({
    point: "source_sensitive",
    rareClass: "yes",
    // agent/runtime.ts passes no restriction: Laya may say either, but "no" only once its "yes" recall holds.
    layaMayTake: null,
    ...protectOf("source_sensitive"),
    // The up-front judge ran on 25 of 25 turns.
    frequencyPerTurn: 1,
    // The judge's p50.
    incumbentMsFallback: 1_819,
    // A missed "yes" costs no time: the turn answers from memory instead of researching first.
    missPenaltyMs: 0,
    missHarm: "quality",
    rareClassPrior: (0 + 1) / (25 + 2),
  }),
});

export function isBenchPoint(point: string): point is BenchPointId {
  return Object.prototype.hasOwnProperty.call(BENCH_PROFILES, point);
}

/** The option keys of a point, in the order the point defines them. */
export function pointOptions(point: string): string[] {
  const definition = DECISION_POINTS[point as DecisionPointId];
  return definition ? Object.keys(definition.options) : [];
}

// ── Cases ───────────────────────────────────────────────────────────────────────────────────────────

export interface DecisionBenchCase {
  id: string;
  point: string;
  /** "de" or "en", as labelled. */
  language: string;
  /** What Laya reads, as the turn builds it: `{ message }` for both bench points. */
  state: Record<string, unknown>;
  /** The right answer, an option key of the point. */
  gold?: string;
  tags?: string[];
  note?: string;
}

/** JSONL with `//` comment lines, as eval/routing's case files. A line that is not JSON is an error, loudly. */
export function parseDecisionCases(text: string): DecisionBenchCase[] {
  const cases: DecisionBenchCase[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!line || line.startsWith("//")) continue;
    try {
      cases.push(JSON.parse(line) as DecisionBenchCase);
    } catch (err) {
      throw new Error(`case file line ${index + 1} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return cases;
}

export function caseMessage(benchCase: Pick<DecisionBenchCase, "state">): string {
  const message = benchCase.state?.["message"];
  return typeof message === "string" ? message : "";
}

/**
 * Everything that would make a case measure nothing or the wrong thing: a duplicate id (by-id reporting keeps one),
 * a point the bench has no incumbent for, a gold label the point does not offer (it could never be matched), a
 * language outside the two the report slices, an empty message.
 */
export function lintDecisionCases(cases: readonly DecisionBenchCase[], opts: { requireGold?: boolean } = {}): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const benchCase of cases) {
    const id = typeof benchCase.id === "string" ? benchCase.id : "";
    if (!id) problems.push("a case has no id");
    else if (seen.has(id)) problems.push(`duplicate case id: ${id}`);
    else seen.add(id);
    const label = id || "?";
    if (!isBenchPoint(benchCase.point)) problems.push(`[${label}] point "${benchCase.point}" has no bench incumbent`);
    if (benchCase.language !== "de" && benchCase.language !== "en") problems.push(`[${label}] language must be "de" or "en"`);
    if (!caseMessage(benchCase).trim()) problems.push(`[${label}] state.message is empty`);
    if (benchCase.gold === undefined) {
      if (opts.requireGold) problems.push(`[${label}] has no gold label`);
    } else if (!pointOptions(benchCase.point).includes(benchCase.gold)) {
      problems.push(`[${label}] gold "${benchCase.gold}" is not an option of ${benchCase.point}`);
    }
    if (benchCase.tags !== undefined && (!Array.isArray(benchCase.tags) || benchCase.tags.some((tag) => typeof tag !== "string"))) {
      problems.push(`[${label}] tags must be a list of strings`);
    }
  }
  return problems;
}

export interface DatasetProfile {
  point: string;
  cases: number;
  byLanguage: Record<string, number>;
  germanShare: number;
  byGold: Record<string, number>;
  /** The share of cases whose gold is the point's rare class. */
  rareShare: number;
}

export function profileDataset(cases: readonly DecisionBenchCase[]): DatasetProfile[] {
  const points = [...new Set(cases.map((benchCase) => benchCase.point))].sort();
  return points.map((point) => {
    const mine = cases.filter((benchCase) => benchCase.point === point);
    const byLanguage = countBy(mine.map((benchCase) => benchCase.language));
    const byGold = countBy(mine.flatMap((benchCase) => (benchCase.gold ? [benchCase.gold] : [])));
    const rare = isBenchPoint(point) ? byGold[BENCH_PROFILES[point].rareClass] ?? 0 : 0;
    return {
      point,
      cases: mine.length,
      byLanguage,
      germanShare: mine.length ? (byLanguage["de"] ?? 0) / mine.length : 0,
      byGold,
      rareShare: mine.length ? rare / mine.length : 0,
    };
  });
}

// ── The calibration / test split ────────────────────────────────────────────────────────────────────

export type BenchSplit = "calibration" | "test";

/**
 * Which half a case belongs to, from its id alone: a case keeps its half when others are added or removed, so a
 * checkpoint fine-tuned on the calibration half is never scored on a case it was trained on.
 */
export function benchSplit(caseId: string, salt = ""): BenchSplit {
  const first = createHash("sha256").update(`${salt}${caseId}`).digest()[0]!;
  return first % 2 === 0 ? "calibration" : "test";
}

// ── What one case produced ──────────────────────────────────────────────────────────────────────────

/** llama-server's own account of a call. */
export interface ServerTimings {
  promptN?: number;
  cacheN?: number;
  promptMs?: number;
  predictedN?: number;
  predictedMs?: number;
}

const TIMING_FIELDS: ReadonlyArray<readonly [snake: string, camel: keyof ServerTimings]> = [
  ["prompt_n", "promptN"],
  ["cache_n", "cacheN"],
  ["prompt_ms", "promptMs"],
  ["predicted_n", "predictedN"],
  ["predicted_ms", "predictedMs"],
];

/**
 * Timings as llama-server writes them (snake_case) or as the provider's audit row carries them (camelCase);
 * undefined when there are none. A negative value is llama-server's "not measured" and is left out, so that it is
 * not read as a measurement of zero.
 */
export function readTimings(raw: unknown): ServerTimings | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const timings: ServerTimings = {};
  for (const [snake, camel] of TIMING_FIELDS) {
    const value = source[camel] ?? source[snake];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) timings[camel] = value;
  }
  return Object.keys(timings).length > 0 ? timings : undefined;
}

export interface BenchLayaAnswer {
  choice: string;
  probabilities: Record<string, number>;
  top: number;
  ms: number;
  /** The checkpoint version that answered. */
  model: string;
}

export interface BenchIncumbentAnswer {
  /** Undefined when the incumbent gave no answer: its reply held none, or the call failed. */
  choice?: string;
  /** Measured whether or not it answered: a failed call costs its time too. */
  ms: number;
  timings?: ServerTimings;
  /** Provider calls behind the one decision: more than one is a retry or a failover. */
  calls?: number;
  /** The model that answered, as the provider named it. */
  model?: string;
  error?: string;
}

export interface BenchResult {
  caseId: string;
  point: string;
  /** The case's labelled language. */
  language: string;
  /** The bucket the gate keys on: the message's detected language, as a turn detects it. */
  gateLanguage?: LanguageBucket;
  gold?: string;
  split: BenchSplit;
  /** 0 for the first run of the case; repeats measure latency and the incumbent's own consistency. */
  attempt: number;
  tags?: readonly string[];
  /** The front desk would not hand this message to its model: on a turn neither arm is asked. */
  gated?: boolean;
  incumbent?: BenchIncumbentAnswer;
  laya?: BenchLayaAnswer;
  /** Laya was asked and gave no usable answer: its time and why. */
  layaFailure?: { ms: number; error: string };
}

export type BenchRow = LedgerRow & {
  caseId: string;
  caseLanguage: string;
  gold?: string;
  split: BenchSplit;
  attempt: number;
  tags?: readonly string[];
  gated?: boolean;
  incumbentTimings?: ServerTimings;
  incumbentCalls?: number;
  incumbentModel?: string;
  errors?: { incumbent?: string; laya?: string };
};

/**
 * A result as a decision-ledger row, plus the bench's own fields: decisions:report reads it as it reads the
 * ledger, and a fine-tune export takes the incumbent's answers from it. Mode "bench", so no row can pass for a
 * real turn's.
 */
export function benchLedgerRow(result: BenchResult, state: Record<string, unknown>, ts: string): BenchRow {
  const errors = {
    ...(result.incumbent?.error ? { incumbent: result.incumbent.error } : {}),
    ...(result.layaFailure ? { laya: result.layaFailure.error } : {}),
  };
  return {
    ts,
    point: result.point,
    language: result.gateLanguage ?? languageBucket(result.language),
    state,
    mode: "bench",
    ...(result.laya ? {
      laya: { choice: result.laya.choice, top: result.laya.top, probabilities: result.laya.probabilities, ms: result.laya.ms, ...(result.laya.model ? { model: result.laya.model } : {}) },
    } : {}),
    ...(result.incumbent?.choice !== undefined ? { incumbent: { choice: result.incumbent.choice, ms: result.incumbent.ms } } : {}),
    decidedBy: "incumbent",
    sessionId: "bench",
    caseId: result.caseId,
    caseLanguage: result.language,
    ...(result.gold !== undefined ? { gold: result.gold } : {}),
    split: result.split,
    attempt: result.attempt,
    ...(result.tags?.length ? { tags: result.tags } : {}),
    ...(result.gated ? { gated: true } : {}),
    ...(result.incumbent?.timings ? { incumbentTimings: result.incumbent.timings } : {}),
    ...(result.incumbent?.calls !== undefined ? { incumbentCalls: result.incumbent.calls } : {}),
    ...(result.incumbent?.model ? { incumbentModel: result.incumbent.model } : {}),
    ...(Object.keys(errors).length ? { errors } : {}),
  };
}

// ── Small statistics ────────────────────────────────────────────────────────────────────────────────

export interface Rate {
  hits: number;
  n: number;
  /** null when there was nothing to count: never a rate of 0 made up from no cases. */
  rate: number | null;
}

function rateOf(hits: number, n: number): Rate {
  return { hits, n, rate: n > 0 ? hits / n : null };
}

export interface ClassScores {
  /** Of the cases given this answer, how many had it as their reference. */
  precision: Rate;
  /** Of the cases whose reference was this answer, how many were given it. */
  recall: Rate;
}

export function classScores(pairs: ReadonlyArray<{ predicted: string; reference: string }>, options: readonly string[]): Record<string, ClassScores> {
  const out: Record<string, ClassScores> = {};
  for (const option of options) {
    const predicted = pairs.filter((pair) => pair.predicted === option);
    const actual = pairs.filter((pair) => pair.reference === option);
    const both = predicted.filter((pair) => pair.reference === option).length;
    out[option] = { precision: rateOf(both, predicted.length), recall: rateOf(both, actual.length) };
  }
  return out;
}

export interface Distribution {
  n: number;
  p50: number;
  p90: number;
  mean: number;
}

/** Nearest-rank percentiles. */
export function distribution(values: readonly number[]): Distribution | null {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return null;
  const sorted = [...finite].sort((a, b) => a - b);
  const at = (share: number) => sorted[Math.max(0, Math.ceil(share * sorted.length) - 1)]!;
  return { n: sorted.length, p50: at(0.5), p90: at(0.9), mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length };
}

function countBy(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

/** The most frequent value; a tie goes to the option the point lists first, so the answer never depends on order. */
function majorityOf(values: readonly string[], options: readonly string[]): { choice: string; count: number } | null {
  if (values.length === 0) return null;
  const counts = countBy(values);
  const ranked = Object.keys(counts).sort((a, b) => {
    const diff = counts[b]! - counts[a]!;
    if (diff !== 0) return diff;
    const ia = options.indexOf(a);
    const ib = options.indexOf(b);
    return (ia < 0 ? Number.MAX_SAFE_INTEGER : ia) - (ib < 0 ? Number.MAX_SAFE_INTEGER : ib) || a.localeCompare(b);
  });
  const choice = ranked[0]!;
  return { choice, count: counts[choice]! };
}

/**
 * The Laya checkpoint a result counts for. A result Laya did not answer counts for the checkpoint most of the
 * point's answers came from — one run serves one sidecar, and leaving those results out would hide its failures.
 */
function modelAssignments(results: readonly BenchResult[]): Map<BenchResult, string> {
  const dominant = new Map<string, string>();
  for (const point of new Set(results.map((result) => result.point))) {
    const models = results.filter((result) => result.point === point && result.laya).map((result) => result.laya!.model);
    dominant.set(point, majorityOf(models, [])?.choice ?? "");
  }
  return new Map(results.map((result) => [result, result.laya?.model ?? dominant.get(result.point) ?? ""]));
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    out.set(k, [...(out.get(k) ?? []), item]);
  }
  return out;
}

/** One result per case: the first run the front desk did not gate. Repeats are not independent evidence. */
function representatives(results: readonly BenchResult[]): BenchResult[] {
  const byCase = new Map<string, BenchResult>();
  for (const result of results) {
    if (result.gated) continue;
    const kept = byCase.get(result.caseId);
    if (!kept || result.attempt < kept.attempt) byCase.set(result.caseId, result);
  }
  return [...byCase.values()];
}

// ── Per-slice metrics ───────────────────────────────────────────────────────────────────────────────

export type SliceLanguage = "de" | "en" | "all";
export const SLICE_LANGUAGES: readonly SliceLanguage[] = ["de", "en", "all"];

export interface BenchSlice {
  point: string;
  language: SliceLanguage;
  model: string;
  /** Distinct cases, gated ones included. */
  cases: number;
  /** Runs of cases the front desk lets through: every repeat counts. */
  rows: number;
  /** Cases the front desk would not hand to its model: neither arm is scored on them. */
  gatedOut: number;
  gold: Record<string, number>;
  answered: { laya: number; incumbent: number; both: number };
  failures: { laya: number; incumbent: number };
  accuracy: { laya: Rate; incumbent: Rate };
  agreement: Rate;
  perClass: Record<string, { layaVsGold: ClassScores; incumbentVsGold: ClassScores; layaVsIncumbent: ClassScores }>;
  baselines: {
    /** Always answering the most common gold label. */
    majorityGold: { choice: string; accuracy: Rate } | null;
    /** Always answering what the incumbent says most often. */
    majorityIncumbent: { choice: string; agreement: Rate } | null;
  };
  latency: {
    layaMs: Distribution | null;
    incumbentMs: Distribution | null;
    incumbentCallsPerDecision: number | null;
    timings: { promptN: Distribution | null; cacheN: Distribution | null; promptMs: Distribution | null; predictedMs: Distribution | null } | null;
  };
  /** Cases run more than once whose incumbent answer changed between runs. */
  incumbentConsistency: { cases: number; flipped: number } | null;
}

function sliceOf(point: string, language: SliceLanguage, model: string, all: readonly BenchResult[]): BenchSlice {
  const options = pointOptions(point);
  const scored = all.filter((result) => !result.gated);
  const withGold = scored.filter((result) => result.gold !== undefined);
  const laya = scored.filter((result) => result.laya);
  const incumbent = scored.filter((result) => result.incumbent?.choice !== undefined);
  const both = scored.filter((result) => result.laya && result.incumbent?.choice !== undefined);
  const layaGold = withGold.filter((result) => result.laya).map((result) => ({ predicted: result.laya!.choice, reference: result.gold! }));
  const incumbentGold = withGold.filter((result) => result.incumbent?.choice !== undefined).map((result) => ({ predicted: result.incumbent!.choice!, reference: result.gold! }));
  const layaIncumbent = both.map((result) => ({ predicted: result.laya!.choice, reference: result.incumbent!.choice! }));
  const perClass: BenchSlice["perClass"] = {};
  const layaVsGold = classScores(layaGold, options);
  const incumbentVsGold = classScores(incumbentGold, options);
  const layaVsIncumbent = classScores(layaIncumbent, options);
  for (const option of options) {
    perClass[option] = { layaVsGold: layaVsGold[option]!, incumbentVsGold: incumbentVsGold[option]!, layaVsIncumbent: layaVsIncumbent[option]! };
  }
  const goldMajority = majorityOf(withGold.map((result) => result.gold!), options);
  const incumbentMajority = majorityOf(incumbent.map((result) => result.incumbent!.choice!), options);
  const timed = scored.filter((result) => result.incumbent?.timings);
  const timing = (field: keyof ServerTimings) => distribution(timed.flatMap((result) => {
    const value = result.incumbent!.timings![field];
    return value === undefined ? [] : [value];
  }));
  const withCalls = scored.filter((result) => result.incumbent?.calls !== undefined);
  const answersByCase = groupBy(incumbent, (result) => result.caseId);
  const repeated = [...answersByCase.values()].filter((runs) => runs.length > 1);
  return {
    point,
    language,
    model,
    cases: new Set(all.map((result) => result.caseId)).size,
    rows: scored.length,
    gatedOut: new Set(all.filter((result) => result.gated).map((result) => result.caseId)).size,
    gold: countBy(withGold.map((result) => result.gold!)),
    answered: { laya: laya.length, incumbent: incumbent.length, both: both.length },
    failures: {
      laya: scored.filter((result) => result.layaFailure).length,
      incumbent: scored.filter((result) => result.incumbent && result.incumbent.choice === undefined).length,
    },
    accuracy: {
      laya: rateOf(layaGold.filter((pair) => pair.predicted === pair.reference).length, layaGold.length),
      incumbent: rateOf(incumbentGold.filter((pair) => pair.predicted === pair.reference).length, incumbentGold.length),
    },
    agreement: rateOf(layaIncumbent.filter((pair) => pair.predicted === pair.reference).length, layaIncumbent.length),
    perClass,
    baselines: {
      majorityGold: goldMajority ? { choice: goldMajority.choice, accuracy: rateOf(goldMajority.count, withGold.length) } : null,
      majorityIncumbent: incumbentMajority ? { choice: incumbentMajority.choice, agreement: rateOf(incumbentMajority.count, incumbent.length) } : null,
    },
    latency: {
      layaMs: distribution(laya.map((result) => result.laya!.ms)),
      // A failed call's time counts: the turn waited for it.
      incumbentMs: distribution(scored.filter((result) => result.incumbent).map((result) => result.incumbent!.ms)),
      incumbentCallsPerDecision: withCalls.length ? withCalls.reduce((sum, result) => sum + result.incumbent!.calls!, 0) / withCalls.length : null,
      timings: timed.length ? { promptN: timing("promptN"), cacheN: timing("cacheN"), promptMs: timing("promptMs"), predictedMs: timing("predictedMs") } : null,
    },
    incumbentConsistency: repeated.length
      ? { cases: repeated.length, flipped: repeated.filter((runs) => new Set(runs.map((result) => result.incumbent!.choice)).size > 1).length }
      : null,
  };
}

/** Per point, Laya checkpoint and labelled language (German, English, and both together). */
export function summarizeBench(results: readonly BenchResult[]): BenchSlice[] {
  const models = modelAssignments(results);
  const groups = groupBy(results, (result) => `${result.point}\u0000${models.get(result)}`);
  const slices: BenchSlice[] = [];
  for (const [key, group] of groups) {
    const [point, model] = key.split("\u0000") as [string, string];
    for (const language of SLICE_LANGUAGES) {
      slices.push(sliceOf(point, language, model, language === "all" ? group : group.filter((result) => result.language === language)));
    }
  }
  return slices.sort((a, b) => a.point.localeCompare(b.point) || a.model.localeCompare(b.model) || SLICE_LANGUAGES.indexOf(a.language) - SLICE_LANGUAGES.indexOf(b.language));
}

// ── The gate, replayed ──────────────────────────────────────────────────────────────────────────────

export interface GateSettings {
  targetAgreement: number;
  minSamples: number;
}

/**
 * The recall guard of one answer: the cases whose reference was the point's protected answer, in the same language
 * and for the same checkpoint, with what Laya answered them and how sure it was.
 */
export interface RecallGuard {
  /** The answer being qualified: a protected case Laya gave this answer at the level or above is a miss. */
  answer: string;
  protectedCases: ReadonlyArray<{ answer: string; top: number }>;
}

/**
 * The lowest confidence level at which these samples qualify, exactly as decisions/gate.ts qualifiedLevel decides
 * it: the cases at or above the level must number at least `minSamples` and the Wilson lower bound of their
 * agreement must reach the target. Once too few cases remain, no higher level can qualify. With a guard (an answer
 * other than the point's protected one), the protected cases must number at least `minSamples` too, and the lower
 * bound of the protected answer's recall at that level must also reach the target.
 */
export function qualifyLevel(samples: ReadonlyArray<{ top: number; agree: boolean }>, settings: GateSettings, guard?: RecallGuard): number | null {
  for (const level of GATE_LEVELS) {
    let n = 0;
    let agree = 0;
    for (const sample of samples) {
      if (!Number.isFinite(sample.top) || sample.top < level) continue;
      n += 1;
      if (sample.agree) agree += 1;
    }
    if (n < settings.minSamples) break;
    if (wilsonLowerBound(agree, n) < settings.targetAgreement) continue;
    if (guard) {
      // Too few protected cases: their recall is unknown at every level.
      if (guard.protectedCases.length < settings.minSamples) break;
      const missed = guard.protectedCases.filter((seen) => seen.answer === guard.answer && seen.top >= level).length;
      if (wilsonLowerBound(guard.protectedCases.length - missed, guard.protectedCases.length) < settings.targetAgreement) continue;
    }
    return level;
  }
  return null;
}

/**
 * The fewest cases, all agreeing, that can qualify at all: 35 at a target of 0.9, although `minSamples` is 30.
 * Infinity when no number of cases can reach the target.
 */
export function flawlessSamplesNeeded(settings: GateSettings): number {
  for (let n = 1; n <= 100_000; n += 1) {
    if (wilsonLowerBound(n, n) >= settings.targetAgreement) return Math.max(n, settings.minSamples);
  }
  return Number.POSITIVE_INFINITY;
}

/** Whose answer Laya's must match: the incumbent's, as the gate on a turn counts it, or the gold label. */
export type GateReference = "incumbent" | "gold";

/** How a report names the reference. */
export function referenceName(reference: GateReference): string {
  return reference === "gold" ? "gold labels" : "incumbent";
}

function referenceOf(result: BenchResult, reference: GateReference): string | undefined {
  return reference === "gold" ? result.gold : result.incumbent?.choice;
}

function gateLanguageOf(result: BenchResult): LanguageBucket {
  return result.gateLanguage ?? languageBucket(result.language);
}

function mayTake(profile: BenchPointProfile, answer: string): boolean {
  return profile.layaMayTake === null || profile.layaMayTake.includes(answer);
}

export interface GateBucket {
  language: LanguageBucket;
  answer: string;
  samples: number;
  agreeing: number;
  qualifiedLevel: number | null;
  /** Whether the point lets Laya take this answer at all. */
  mayTake: boolean;
  /**
   * The recall guard this answer must pass, null for the protected answer itself and for a point that protects none:
   * how many calibration cases in this language had the protected answer as their reference, and on how many of
   * them Laya gave this answer instead, at any confidence.
   */
  recallGuard: { protect: string; cases: number; answeredThis: number } | null;
}

export interface GateTestSlice {
  language: SliceLanguage;
  cases: number;
  layaAnswered: number;
  taken: number;
  coverage: Rate;
  /** Among the cases Laya would take: its answer differs from the reference. */
  wrongVsReference: Rate;
  wrongVsGold: Rate;
  /** The incumbent's own answer on the same taken cases, against gold: what today's decision gets wrong there. */
  incumbentWrongVsGold: Rate;
  /** Taken cases where the incumbent had gold right and Laya has it wrong: errors the handover would add. */
  regressions: Rate;
  /** Taken cases where the incumbent had gold wrong and Laya has it right. */
  improvements: Rate;
  /** Cases where the rare class was the gold label or the incumbent's answer, and Laya took the other answer. */
  rareMiss: Rate;
  rareMissVsGold: Rate;
  rareMissVsIncumbent: Rate;
}

export interface GateSimulation {
  point: string;
  model: string;
  reference: GateReference;
  settings: GateSettings;
  flawlessSamplesNeeded: number;
  /** The run held one half only (--split), so that half was split again to replay the gate. */
  nestedSplit: boolean;
  calibrationCases: number;
  testCases: number;
  buckets: GateBucket[];
  /**
   * qualified: some answer Laya may take qualified. insufficient_calibration: no answer Laya may take had enough
   * calibration cases to qualify even if every one agreed, counting the protected cases its recall guard needs.
   * not_qualified: enough cases, too little agreement or recall.
   */
  status: "qualified" | "not_qualified" | "insufficient_calibration";
  test: GateTestSlice[];
  /** The test cases Laya would take, by id: the rows behind coverage and the projection. */
  takenCaseIds: string[];
}

/** The level each (gate language, answer) qualifies at on the calibration half. */
function calibrate(calibration: readonly BenchResult[], profile: BenchPointProfile, reference: GateReference, settings: GateSettings): GateBucket[] {
  const samples = new Map<string, Array<{ top: number; agree: boolean }>>();
  // Per gate language, the cases whose reference was the protected answer: what every other answer's guard reads.
  const protectedByLanguage = new Map<LanguageBucket, Array<{ answer: string; top: number }>>();
  for (const result of calibration) {
    const expected = referenceOf(result, reference);
    // The gate records no sample without both answers, nor one whose confidence is not a number.
    if (!result.laya || expected === undefined || !Number.isFinite(result.laya.top)) continue;
    const language = gateLanguageOf(result);
    const key = `${language}\u0000${result.laya.choice}`;
    samples.set(key, [...(samples.get(key) ?? []), { top: result.laya.top, agree: result.laya.choice === expected }]);
    if (profile.protect !== undefined && expected === profile.protect) {
      protectedByLanguage.set(language, [...(protectedByLanguage.get(language) ?? []), { answer: result.laya.choice, top: result.laya.top }]);
    }
  }
  return [...samples.entries()].map(([key, list]) => {
    const [language, answer] = key.split("\u0000") as [LanguageBucket, string];
    const guarded = profile.protect !== undefined && profile.protect !== answer ? profile.protect : undefined;
    const protectedCases = guarded !== undefined ? protectedByLanguage.get(language) ?? [] : [];
    return {
      language,
      answer,
      samples: list.length,
      agreeing: list.filter((sample) => sample.agree).length,
      qualifiedLevel: qualifyLevel(list, settings, guarded !== undefined ? { answer, protectedCases } : undefined),
      mayTake: mayTake(profile, answer),
      recallGuard: guarded !== undefined
        ? { protect: guarded, cases: protectedCases.length, answeredThis: protectedCases.filter((seen) => seen.answer === answer).length }
        : null,
    };
  }).sort((a, b) => a.language.localeCompare(b.language) || a.answer.localeCompare(b.answer));
}

/** Could this bucket qualify at all, were every one of its cases right: its own samples and its guard's. */
function bucketHasEnough(bucket: GateBucket, needed: number): boolean {
  return bucket.samples >= needed && (bucket.recallGuard === null || bucket.recallGuard.cases >= needed);
}

/** Would the calibrated gate hand this case to Laya? */
function takenBy(result: BenchResult, buckets: readonly GateBucket[], profile: BenchPointProfile): boolean {
  if (!result.laya || !mayTake(profile, result.laya.choice)) return false;
  const level = buckets.find((candidate) => candidate.language === gateLanguageOf(result) && candidate.answer === result.laya!.choice)?.qualifiedLevel;
  return level !== null && level !== undefined && result.laya.top >= level;
}

function testSlice(language: SliceLanguage, cases: readonly BenchResult[], taken: ReadonlySet<BenchResult>, profile: BenchPointProfile, reference: GateReference): GateTestSlice {
  const rare = profile.rareClass;
  const took = cases.filter((result) => taken.has(result));
  const missed = (result: BenchResult) => taken.has(result) && result.laya!.choice !== rare;
  const rareCases = cases.filter((result) => result.gold === rare || result.incumbent?.choice === rare);
  const goldRare = cases.filter((result) => result.gold === rare);
  const incumbentRare = cases.filter((result) => result.incumbent?.choice === rare);
  const withReference = took.filter((result) => referenceOf(result, reference) !== undefined);
  const withGold = took.filter((result) => result.gold !== undefined);
  const paired = withGold.filter((result) => result.incumbent?.choice !== undefined);
  return {
    language,
    cases: cases.length,
    layaAnswered: cases.filter((result) => result.laya).length,
    taken: took.length,
    coverage: rateOf(took.length, cases.length),
    wrongVsReference: rateOf(withReference.filter((result) => result.laya!.choice !== referenceOf(result, reference)).length, withReference.length),
    wrongVsGold: rateOf(withGold.filter((result) => result.laya!.choice !== result.gold).length, withGold.length),
    incumbentWrongVsGold: rateOf(paired.filter((result) => result.incumbent!.choice !== result.gold).length, paired.length),
    regressions: rateOf(paired.filter((result) => result.incumbent!.choice === result.gold && result.laya!.choice !== result.gold).length, paired.length),
    improvements: rateOf(paired.filter((result) => result.incumbent!.choice !== result.gold && result.laya!.choice === result.gold).length, paired.length),
    rareMiss: rateOf(rareCases.filter(missed).length, rareCases.length),
    rareMissVsGold: rateOf(goldRare.filter(missed).length, goldRare.length),
    rareMissVsIncumbent: rateOf(incumbentRare.filter(missed).length, incumbentRare.length),
  };
}

/**
 * The adaptive gate replayed on held-out cases, per Laya checkpoint: levels are qualified on the calibration half
 * exactly as the gate qualifies them (per gate language and Laya answer, with the recall guard of the point's
 * protected answer, and only answers the point lets Laya take can be taken), then applied to the test half. One run
 * per case counts; repeats are not independent evidence.
 */
export function simulateGate(
  results: readonly BenchResult[],
  profile: BenchPointProfile,
  settings: GateSettings,
  reference: GateReference = "incumbent",
): GateSimulation[] {
  const models = modelAssignments(results);
  const mine = representatives(results.filter((result) => result.point === profile.point));
  const groups = groupBy(mine, (result) => models.get(result) ?? "");
  const needed = flawlessSamplesNeeded(settings);
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([model, cases]) => {
    let calibration = cases.filter((result) => result.split === "calibration");
    let test = cases.filter((result) => result.split === "test");
    const nestedSplit = calibration.length === 0 || test.length === 0;
    if (nestedSplit) {
      calibration = cases.filter((result) => benchSplit(result.caseId, "nested:") === "calibration");
      test = cases.filter((result) => benchSplit(result.caseId, "nested:") === "test");
    }
    const buckets = calibrate(calibration, profile, reference, settings);
    const takeable = buckets.filter((bucket) => bucket.mayTake);
    const status: GateSimulation["status"] = takeable.some((bucket) => bucket.qualifiedLevel !== null)
      ? "qualified"
      : takeable.some((bucket) => bucketHasEnough(bucket, needed)) ? "not_qualified" : "insufficient_calibration";
    const taken = new Set(test.filter((result) => takenBy(result, buckets, profile)));
    return {
      point: profile.point,
      model,
      reference,
      settings: { ...settings },
      flawlessSamplesNeeded: needed,
      nestedSplit,
      calibrationCases: calibration.length,
      testCases: test.length,
      buckets,
      status,
      test: SLICE_LANGUAGES.map((language) => testSlice(language, language === "all" ? test : test.filter((result) => result.language === language), taken, profile, reference)),
      takenCaseIds: [...taken].map((result) => result.caseId).sort(),
    };
  });
}

export interface LevelPoint {
  level: number;
  cases: number;
  taken: number;
  coverage: Rate;
  wrongVsReference: Rate;
  wrongVsGold: Rate;
  rareMiss: Rate;
}

/**
 * Descriptive, on every case: what one fixed confidence level would do across all languages. Nothing is selected
 * from it, so it may use every case; it shows where the evidence lies when the halves are too small to qualify.
 */
export function levelCurve(results: readonly BenchResult[], profile: BenchPointProfile, reference: GateReference = "incumbent"): Array<{ model: string; levels: LevelPoint[] }> {
  const models = modelAssignments(results);
  const mine = representatives(results.filter((result) => result.point === profile.point));
  const groups = groupBy(mine, (result) => models.get(result) ?? "");
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([model, cases]) => ({
    model,
    levels: GATE_LEVELS.map((level) => {
      const taken = new Set(cases.filter((result) => result.laya && mayTake(profile, result.laya.choice) && result.laya.top >= level));
      const slice = testSlice("all", cases, taken, profile, reference);
      return { level, cases: slice.cases, taken: slice.taken, coverage: slice.coverage, wrongVsReference: slice.wrongVsReference, wrongVsGold: slice.wrongVsGold, rareMiss: slice.rareMiss };
    }),
  }));
}

/**
 * The same results answered by a Laya that always gives the calibration half's most common reference answer, at
 * full confidence: the trivial model the gate must not be fooled by. Its replay shows whether the gate would hand
 * it the point, and what that would miss.
 */
export function alwaysMajorityResults(results: readonly BenchResult[], profile: BenchPointProfile, reference: GateReference = "incumbent"): BenchResult[] {
  const mine = results.filter((result) => result.point === profile.point);
  const options = pointOptions(profile.point);
  const calibration = representatives(mine).filter((result) => result.split === "calibration");
  const pool = calibration.length ? calibration : representatives(mine);
  const majority = majorityOf(pool.flatMap((result) => {
    const expected = referenceOf(result, reference);
    return expected === undefined ? [] : [expected];
  }), options);
  if (!majority) return [];
  const probabilities = Object.fromEntries(options.map((option) => [option, option === majority.choice ? 1 : 0]));
  return mine.map((result) => ({
    ...result,
    laya: { choice: majority.choice, probabilities, top: 1, ms: result.laya?.ms ?? result.layaFailure?.ms ?? 0, model: `always-${majority.choice}` },
  }));
}

// ── What it would save ──────────────────────────────────────────────────────────────────────────────

export interface ProjectionSettings {
  /** decisions.adaptive.auditRate: this share of the cases Laya would take still goes to the incumbent. */
  auditRate: number;
  frequencyPerTurn?: number;
  /** The rare class's share of real traffic, for the reweighed projection; the point's profile by default. */
  rareClassPrior?: number;
  /** The time to the orchestrator's first token (p50 8.2 s over the attributed turns). */
  timeToFirstTokenMs: number;
  /** A whole turn without image renders (p50 46.7 s over the attributed turns). */
  turnMs: number;
}

export const DEFAULT_PROJECTION: Readonly<Omit<ProjectionSettings, "frequencyPerTurn" | "rareClassPrior">> = Object.freeze({
  auditRate: 0.1,
  timeToFirstTokenMs: 8_200,
  turnMs: 46_700,
});

export interface SavingsVariant {
  /** Mean over the point's decisions, taken or not. Negative: the variant costs time. */
  savedMsPerDecision: number;
  secondsPer100Turns: number;
  /** The saving per turn as a share of the time to the orchestrator's first token. */
  shareOfTimeToFirstToken: number;
  /** ... and of a whole turn without renders. */
  shareOfTurn: number;
}

export interface Projection {
  point: string;
  model: string;
  /** "dataset": cases weighed as the dataset mixes them. "prior": reweighed to the rare class's traffic share. */
  mix: "dataset" | "prior";
  rareClassPrior: number | null;
  frequencyPerTurn: number;
  auditRate: number;
  testCases: number;
  /** Test cases the reweighing had to leave out: no gold label and no incumbent answer to weigh them by. */
  unweighted: number;
  coverage: number | null;
  incumbentMs: { source: "measured" | "fallback"; p50: number | null };
  layaMs: number | null;
  /** Today's decide(): incumbent and Laya start together; a taken answer aborts the incumbent. */
  concurrent: SavingsVariant & { abortedIncumbentCallsPer100Turns: number };
  /** Laya first; the incumbent starts only when Laya's answer is not taken. */
  layaFirst: SavingsVariant & { incumbentCallsAvoidedPer100Turns: number };
  /** Rare cases (by gold, else by the incumbent) that Laya would take the other way. */
  rareMissesPer100Turns: number;
}

function projectionFor(
  cases: readonly BenchResult[],
  taken: ReadonlySet<string>,
  profile: BenchPointProfile,
  model: string,
  settings: ProjectionSettings,
  mix: "dataset" | "prior",
): Projection {
  const rare = profile.rareClass;
  const audit = Math.min(1, Math.max(0, settings.auditRate));
  const frequency = settings.frequencyPerTurn ?? profile.frequencyPerTurn;
  const prior = mix === "prior" ? settings.rareClassPrior ?? profile.rareClassPrior : null;
  const classOf = (result: BenchResult) => result.gold ?? result.incumbent?.choice;
  const measured = cases.some((result) => result.incumbent);
  const incumbentMs = (result: BenchResult) => result.incumbent?.ms ?? profile.incumbentMsFallback;
  const layaMs = (result: BenchResult) => result.laya?.ms ?? result.layaFailure?.ms ?? 0;

  // Reweighing: each class weighs its traffic share over its dataset share.
  let unweighted = 0;
  const weight = new Map<BenchResult, number>();
  const classed = cases.filter((result) => classOf(result) !== undefined);
  const datasetRare = classed.length ? classed.filter((result) => classOf(result) === rare).length / classed.length : 0;
  for (const result of cases) {
    if (prior === null) {
      weight.set(result, 1);
      continue;
    }
    const cls = classOf(result);
    if (cls === undefined || datasetRare <= 0 || datasetRare >= 1) {
      unweighted += 1;
      weight.set(result, 0);
      continue;
    }
    weight.set(result, cls === rare ? prior / datasetRare : (1 - prior) / (1 - datasetRare));
  }
  const totalWeight = cases.reduce((sum, result) => sum + weight.get(result)!, 0);

  let concurrent = 0;
  let layaFirst = 0;
  let takenWeight = 0;
  let missWeight = 0;
  for (const result of cases) {
    const w = weight.get(result)!;
    if (w === 0) continue;
    const inc = incumbentMs(result);
    const lay = layaMs(result);
    // What the turn would have done: the incumbent's answer when it was measured, else the gold label.
    const wouldBe = result.incumbent?.choice ?? result.gold;
    const truth = result.gold ?? result.incumbent?.choice;
    if (taken.has(result.caseId)) {
      const penalty = result.laya!.choice !== rare && wouldBe === rare ? profile.missPenaltyMs : 0;
      const decided = inc - lay - penalty;
      concurrent += w * ((1 - audit) * decided + audit * -Math.max(0, lay - inc));
      layaFirst += w * ((1 - audit) * decided + audit * -lay);
      takenWeight += w;
      if (result.laya!.choice !== rare && truth === rare) missWeight += w;
    } else {
      // Concurrent: the incumbent was running anyway; Laya only costs time when it is the slower one.
      concurrent += w * -Math.max(0, lay - inc);
      layaFirst += w * -lay;
    }
  }
  const per = (sum: number) => (totalWeight > 0 ? sum / totalWeight : 0);
  const variant = (savedMsPerDecision: number): SavingsVariant => ({
    savedMsPerDecision,
    secondsPer100Turns: (frequency * 100 * savedMsPerDecision) / 1_000,
    shareOfTimeToFirstToken: settings.timeToFirstTokenMs > 0 ? (frequency * savedMsPerDecision) / settings.timeToFirstTokenMs : 0,
    shareOfTurn: settings.turnMs > 0 ? (frequency * savedMsPerDecision) / settings.turnMs : 0,
  });
  const coverage = totalWeight > 0 ? takenWeight / totalWeight : null;
  const handedOver = frequency * 100 * (coverage ?? 0) * (1 - audit);
  return {
    point: profile.point,
    model,
    mix,
    rareClassPrior: prior,
    frequencyPerTurn: frequency,
    auditRate: audit,
    testCases: cases.length,
    unweighted,
    coverage,
    incumbentMs: {
      source: measured ? "measured" : "fallback",
      p50: measured ? distribution(cases.filter((result) => result.incumbent).map((result) => result.incumbent!.ms))?.p50 ?? null : profile.incumbentMsFallback,
    },
    layaMs: distribution(cases.filter((result) => result.laya).map((result) => result.laya!.ms))?.p50 ?? null,
    concurrent: { ...variant(per(concurrent)), abortedIncumbentCallsPer100Turns: handedOver },
    layaFirst: { ...variant(per(layaFirst)), incumbentCallsAvoidedPer100Turns: handedOver },
    rareMissesPer100Turns: frequency * 100 * per(missWeight),
  };
}

/**
 * Seconds saved per 100 turns on the test half, from the replayed gate's decisions: for every test case, taken or
 * not, what the decision costs against the incumbent alone. A taken case saves the incumbent's time less Laya's, less
 * the downstream penalty when it sends a rare case the slow way; the audited share saves nothing. Reported twice:
 * weighed as the dataset mixes the classes, and reweighed to the rare class's share of real traffic, because the
 * dataset over-represents the rare class on purpose.
 */
export function projectSavings(results: readonly BenchResult[], simulation: GateSimulation, profile: BenchPointProfile, settings: ProjectionSettings): Projection[] {
  const models = modelAssignments(results);
  const cases = representatives(results.filter((result) => result.point === profile.point && models.get(result) === simulation.model));
  const test = cases.filter((result) => (simulation.nestedSplit ? benchSplit(result.caseId, "nested:") : result.split) === "test");
  const taken = new Set(simulation.takenCaseIds);
  return [
    projectionFor(test, taken, profile, simulation.model, settings, "dataset"),
    projectionFor(test, taken, profile, simulation.model, settings, "prior"),
  ];
}

// ── The verdict ─────────────────────────────────────────────────────────────────────────────────────

export type PointVerdict = "pays_off" | "no_payoff" | "unsafe" | "inconclusive";

export interface VerdictSettings {
  targetAgreement: number;
  /** For a point whose rare-class miss costs answer quality: the most misses tolerated among its rare cases. */
  maxRareMiss: number;
}

/**
 * unsafe: on held-out cases, what the replayed gate hands Laya disagrees with the reference more often than the
 * target allows, so the gate's promise does not hold; or, where a miss costs quality, Laya takes more of the rare
 * class the other way than tolerated, counting every case where the rare class was the gold label or the
 * incumbent's answer. Laya's error against gold is not the test: where it only repeats the incumbent's own errors
 * the handover loses nothing, and the report shows both beside the regressions it would add.
 * inconclusive: nothing could be scored, one of the two languages has no scored case, or the calibration half is
 * too small to qualify anything, the recall guard's protected cases included. no_payoff: nothing qualified, or the
 * reweighed projection saves no time.
 * Otherwise pays_off.
 */
export function pointVerdict(simulation: GateSimulation, projection: Projection | undefined, profile: BenchPointProfile, settings: VerdictSettings): { verdict: PointVerdict; reasons: string[] } {
  const reasons: string[] = [];
  const all = simulation.test.find((slice) => slice.language === "all");
  if (!all || all.layaAnswered === 0) return { verdict: "inconclusive", reasons: ["no test case has a Laya answer"] };
  for (const language of ["de", "en"] as const) {
    const slice = simulation.test.find((candidate) => candidate.language === language);
    if (!slice || slice.layaAnswered === 0) reasons.push(`no ${language === "de" ? "German" : "English"} test case has a Laya answer`);
  }
  if (reasons.length) return { verdict: "inconclusive", reasons };
  if (all.taken > 0) {
    const wrong = all.wrongVsReference;
    if (wrong.rate !== null && wrong.rate > 1 - settings.targetAgreement) {
      reasons.push(`${pct(wrong.rate)} of the ${wrong.n} held-out cases Laya would take disagree with the ${referenceName(simulation.reference)}; the target allows ${pct(1 - settings.targetAgreement)}`);
    }
    const miss = all.rareMiss;
    if (profile.missHarm === "quality" && miss.rate !== null && miss.rate > settings.maxRareMiss) {
      reasons.push(`Laya would take ${miss.hits} of ${miss.n} "${profile.rareClass}" cases the other way (${pct(miss.rate)}; at most ${pct(settings.maxRareMiss)} tolerated)`);
    }
    if (reasons.length) return { verdict: "unsafe", reasons };
  }
  if (simulation.status === "insufficient_calibration") {
    const needed = simulation.flawlessSamplesNeeded;
    const takeable = simulation.buckets.filter((bucket) => bucket.mayTake);
    const most = Math.max(0, ...takeable.map((bucket) => bucket.samples));
    const guards = takeable.flatMap((bucket) => (bucket.samples >= needed && bucket.recallGuard ? [bucket.recallGuard] : []));
    const reasons = [`the calibration half holds at most ${most} cases for one language and answer Laya may take; qualifying needs ${needed} even if all agree`];
    if (guards.length) {
      // Enough cases of the answer itself: what is missing are the protected cases its recall guard counts.
      const protect = guards[0]!.protect;
      reasons[0] = `the recall guard needs ${needed} "${protect}" cases in one language before Laya may take any other answer there; the calibration half holds at most ${Math.max(...guards.map((guard) => guard.cases))}`;
    }
    return { verdict: "inconclusive", reasons };
  }
  if (all.taken === 0) return { verdict: "no_payoff", reasons: ["the gate qualified nothing Laya may take"] };
  if (!projection || projection.concurrent.savedMsPerDecision <= 0) {
    return { verdict: "no_payoff", reasons: [`the projection saves no time (${projection ? `${projection.concurrent.savedMsPerDecision.toFixed(0)} ms per decision` : "no projection"})`] };
  }
  return { verdict: "pays_off", reasons: [`${projection.concurrent.secondsPer100Turns.toFixed(1)} s per 100 turns at ${pct(projection.coverage)} coverage`] };
}

/** 1 when a point is unsafe, 2 when no point could be judged, else 0. */
export function benchExitCode(verdicts: readonly PointVerdict[]): 0 | 1 | 2 {
  if (verdicts.includes("unsafe")) return 1;
  if (verdicts.length === 0 || verdicts.every((verdict) => verdict === "inconclusive")) return 2;
  return 0;
}

// ── The report ──────────────────────────────────────────────────────────────────────────────────────

export interface BenchReportSettings {
  gate: GateSettings;
  reference: GateReference;
  projection: ProjectionSettings;
  verdict: VerdictSettings;
  /** Per point: overrides of the profile's frequency per turn and rare-class prior. */
  overrides?: Partial<Record<BenchPointId, { frequencyPerTurn?: number; rareClassPrior?: number }>>;
}

export interface BenchPointReport {
  point: string;
  model: string;
  simulation: GateSimulation;
  /** The same replay for a Laya that always gives the most common answer. */
  alwaysMajority: GateSimulation | null;
  levels: LevelPoint[];
  projections: Projection[];
  verdict: PointVerdict;
  reasons: string[];
}

export interface BenchReport {
  settings: BenchReportSettings;
  slices: BenchSlice[];
  points: BenchPointReport[];
  exitCode: 0 | 1 | 2;
}

export function buildBenchReport(results: readonly BenchResult[], settings: BenchReportSettings): BenchReport {
  const points: BenchPointReport[] = [];
  const present = [...new Set(results.map((result) => result.point))].filter(isBenchPoint).sort();
  for (const id of present) {
    const override = settings.overrides?.[id];
    const profile: BenchPointProfile = {
      ...BENCH_PROFILES[id],
      ...(override?.frequencyPerTurn !== undefined ? { frequencyPerTurn: override.frequencyPerTurn } : {}),
      ...(override?.rareClassPrior !== undefined ? { rareClassPrior: override.rareClassPrior } : {}),
    };
    const projectionSettings: ProjectionSettings = { ...settings.projection, frequencyPerTurn: profile.frequencyPerTurn, rareClassPrior: profile.rareClassPrior };
    const curves = levelCurve(results, profile, settings.reference);
    const baseline = alwaysMajorityResults(results, profile, settings.reference);
    const baselineSimulation = baseline.length ? simulateGate(baseline, profile, settings.gate, settings.reference)[0] ?? null : null;
    for (const simulation of simulateGate(results, profile, settings.gate, settings.reference)) {
      const projections = projectSavings(results, simulation, profile, projectionSettings);
      const judged = pointVerdict(simulation, projections.find((projection) => projection.mix === "prior"), profile, settings.verdict);
      points.push({
        point: id,
        model: simulation.model,
        simulation,
        alwaysMajority: baselineSimulation,
        levels: curves.find((curve) => curve.model === simulation.model)?.levels ?? [],
        projections,
        verdict: judged.verdict,
        reasons: judged.reasons,
      });
    }
  }
  return { settings, slices: summarizeBench(results), points, exitCode: benchExitCode(points.map((point) => point.verdict)) };
}

function pct(value: number | null | undefined): string {
  return value === null || value === undefined ? "–" : `${(value * 100).toFixed(1)}%`;
}

function rateCell(rate: Rate): string {
  return rate.n === 0 ? "–" : `${pct(rate.rate)} (${rate.hits}/${rate.n})`;
}

function ms(value: number | null | undefined): string {
  return value === null || value === undefined ? "–" : `${Math.round(value)} ms`;
}

/** The report as Markdown: the verdicts first, then the evidence behind them. */
export function renderBenchMarkdown(report: BenchReport, header: readonly string[] = []): string {
  const { gate, reference, projection } = report.settings;
  const lines: string[] = ["# Decision bench", "", ...header];
  if (header.length) lines.push("");
  lines.push(`Gate: Wilson lower bound ≥ ${pct(gate.targetAgreement)} over ≥ ${gate.minSamples} cases (${report.points[0]?.simulation.flawlessSamplesNeeded ?? "?"} if all agree), against the ${referenceName(reference)}; where a point protects an answer, its recall must reach the same bound before Laya takes another. Audit rate ${pct(projection.auditRate)}.`, "");
  lines.push("## Verdicts", "", "| point | checkpoint | verdict | why |", "|---|---|---|---|");
  for (const point of report.points) lines.push(`| ${point.point} | ${point.model || "–"} | **${point.verdict}** | ${point.reasons.join("; ")} |`);
  lines.push("");
  for (const point of report.points) {
    const sim = point.simulation;
    lines.push(`## ${point.point} — ${point.model || "no Laya checkpoint"}`, "");
    lines.push("### Against gold, per language", "", "| lang | cases | gated | Laya acc | incumbent acc | agreement | always-majority acc | Laya recall (rare) | incumbent recall (rare) | Laya p50 | incumbent p50 |", "|---|---|---|---|---|---|---|---|---|---|---|");
    const rare = BENCH_PROFILES[point.point as BenchPointId]?.rareClass ?? "";
    for (const slice of report.slices.filter((candidate) => candidate.point === point.point && candidate.model === point.model)) {
      const cls = slice.perClass[rare];
      lines.push(`| ${slice.language} | ${slice.cases} | ${slice.gatedOut} | ${rateCell(slice.accuracy.laya)} | ${rateCell(slice.accuracy.incumbent)} | ${rateCell(slice.agreement)} | ${slice.baselines.majorityGold ? `${rateCell(slice.baselines.majorityGold.accuracy)} "${slice.baselines.majorityGold.choice}"` : "–"} | ${cls ? rateCell(cls.layaVsGold.recall) : "–"} | ${cls ? rateCell(cls.incumbentVsGold.recall) : "–"} | ${ms(slice.latency.layaMs?.p50)} | ${ms(slice.latency.incumbentMs?.p50)} |`);
    }
    lines.push("", `### Gate replay (${sim.status}${sim.nestedSplit ? ", nested split" : ""}): ${sim.calibrationCases} calibration / ${sim.testCases} test cases`, "");
    for (const bucket of sim.buckets) {
      const guard = bucket.recallGuard ? `, recall guard: Laya said "${bucket.answer}" on ${bucket.recallGuard.answeredThis} of ${bucket.recallGuard.cases} "${bucket.recallGuard.protect}" cases` : "";
      lines.push(`- calibration ${bucket.language} "${bucket.answer}": ${bucket.agreeing}/${bucket.samples} agree${guard} → ${bucket.qualifiedLevel === null ? "not qualified" : `qualified from ${bucket.qualifiedLevel}`}${bucket.mayTake ? "" : " (Laya may not take it)"}`);
    }
    lines.push("", "| lang | test cases | taken | coverage | wrong vs reference | Laya wrong vs gold | incumbent wrong vs gold | regressions | improvements | rare-class miss |", "|---|---|---|---|---|---|---|---|---|---|");
    for (const slice of sim.test) {
      lines.push(`| ${slice.language} | ${slice.cases} | ${slice.taken} | ${rateCell(slice.coverage)} | ${rateCell(slice.wrongVsReference)} | ${rateCell(slice.wrongVsGold)} | ${rateCell(slice.incumbentWrongVsGold)} | ${rateCell(slice.regressions)} | ${rateCell(slice.improvements)} | ${rateCell(slice.rareMiss)} |`);
    }
    if (point.alwaysMajority) {
      const all = point.alwaysMajority.test.find((slice) => slice.language === "all");
      lines.push("", `Always-majority Laya (${point.alwaysMajority.model}): ${point.alwaysMajority.status}, coverage ${all ? rateCell(all.coverage) : "–"}, rare-class miss ${all ? rateCell(all.rareMiss) : "–"}.`);
    }
    lines.push("", "### Projection (test half)", "", "| mix | coverage | concurrent: ms/decision | s per 100 turns | share of time to first token | share of turn | Laya-first: ms/decision | s per 100 turns | incumbent calls avoided /100 turns | rare misses /100 turns |", "|---|---|---|---|---|---|---|---|---|---|");
    for (const p of point.projections) {
      lines.push(`| ${p.mix}${p.rareClassPrior !== null ? ` ("${rare}" ${pct(p.rareClassPrior)})` : ""} | ${pct(p.coverage)} | ${p.concurrent.savedMsPerDecision.toFixed(0)} | ${p.concurrent.secondsPer100Turns.toFixed(1)} | ${pct(p.concurrent.shareOfTimeToFirstToken)} | ${pct(p.concurrent.shareOfTurn)} | ${p.layaFirst.savedMsPerDecision.toFixed(0)} | ${p.layaFirst.secondsPer100Turns.toFixed(1)} | ${p.layaFirst.incumbentCallsAvoidedPer100Turns.toFixed(1)} | ${p.rareMissesPer100Turns.toFixed(2)} |`);
    }
    lines.push("", "Per point: the points' savings must not be added to each other (a fast-lane answer skips the source judge) or to other levers'.");
    const incumbentSource = point.projections[0]?.incumbentMs.source;
    if (incumbentSource === "fallback") lines.push("", "The incumbent's time was not measured in this run; the projection uses the attribution's p50.");
    lines.push("", "### Level curve (every case, one fixed level, descriptive)", "", "| level | taken | coverage | wrong vs gold | rare-class miss |", "|---|---|---|---|---|");
    for (const level of point.levels) lines.push(`| ${level.level} | ${level.taken}/${level.cases} | ${pct(level.coverage.rate)} | ${rateCell(level.wrongVsGold)} | ${rateCell(level.rareMiss)} |`);
    lines.push("");
  }
  return lines.join("\n");
}
