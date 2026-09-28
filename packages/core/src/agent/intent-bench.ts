/**
 * The intent bench's arithmetic: how well the intent readout (decisions/intent-readout.ts) reads each
 * facet of a request, measured on hand-labelled synthetic cases (eval/intent/intent.example.jsonl).
 *
 * The readout asks every facet of triage's IDCM taxonomy in one grammar-bound call and reads each
 * facet's letter off the model's top list. Before any consumer reads it — the workflow-forcing gate,
 * the orchestration module's inclusion, the pre-router — each facet has to be shown to carry signal,
 * per language, and to know when it does. So per facet and language this computes:
 *
 *   - accuracy against gold, beside the always-majority baseline: a facet whose gold is 88% "no"
 *     (multi) scores 88% by answering "no" every time, and only accuracy above that is signal;
 *   - with --with-triage, the generative triage (agent/triage.ts, the incumbent) on the same case:
 *     its accuracy, the readout's on the same cases, and the exact McNemar test on the cases only
 *     one of them got right — the readout replaces triage only where it is not worse;
 *   - the confusion matrix, gold against the readout, and recall per gold value;
 *   - calibration: ECE on the test half at T = 1 and at a temperature fitted on the calibration
 *     half (split by a hash of the case id, never read off the cases that fitted it);
 *   - coverage and accuracy above each confidence level and each margin level: what a consumer
 *     gating on top ≥ x (or top − runner-up ≥ y) would take and get right;
 *   - with --order-swap, how often the choice changes when each facet's options are offered in
 *     reverse order (letter-position bias, which a letter readout can have and a word answer not),
 *     how often the two orders agree, and the reversed pass alone and the two passes averaged per
 *     option (as askIntentReadout `bothOrders` combines them) scored as the main pass is: accuracy,
 *     ECE and coverage, with the verdict the averaged readout would get as an extra column — the
 *     run's verdicts and exit code stay the main pass's;
 *   - wall time per call, and per language whether the restatement (query_en) came back non-empty —
 *     the idcm-1 note measured triage writing one on 9 of 15 German requests.
 *
 * Nothing here holds or reports the user's words or the restatement: an arm keeps letters,
 * probabilities, lengths and times. Pure: the live run is scripts/intent-bench.ts.
 */
import { createHash } from "node:crypto";

import {
  averageOrderReadings,
  INTENT_FACET_BY_NAME,
  INTENT_FACETS,
  INTENT_READOUT_VERSION,
  triageVerdictKeys,
  type IntentFacetName,
  type IntentFacetOrders,
  type IntentReadoutResult,
  type IntentTemperatures,
} from "../decisions/intent-readout.js";
import { wilsonLowerBound, type LanguageBucket } from "../decisions/gate.js";
import {
  applyTemperature,
  expectedCalibrationError,
  fitTemperature,
  meanNll,
  MAX_TOP_LOGPROBS,
  DEFAULT_MIN_LETTER_MASS,
  type TemperatureFit,
  type TemperatureSample,
} from "../decisions/logit-readout.js";
import { benchSplit, distribution, SLICE_LANGUAGES, type BenchSplit, type Distribution, type Rate, type ServerTimings, type SliceLanguage } from "./decisions-bench.js";
import { mcnemarExactP } from "./pre-router-bench.js";
import type { TriageOutcome } from "./triage.js";

// ── Cases ────────────────────────────────────────────────────────────────────────────────────────

/** The facets in the order the readout writes them. */
export const INTENT_FACET_NAMES: readonly IntentFacetName[] = Object.freeze(INTENT_FACETS.map((definition) => definition.name));

/** One gold value per facet, each an option key of the facet (INTENT_FACETS). */
export type IntentGold = Record<IntentFacetName, string>;

export interface IntentBenchCase {
  id: string;
  /** "de" or "en", as labelled. */
  language: string;
  /** The request, in the user's voice. */
  message: string;
  /** The prior turn's two-line digest, for a follow-up (triage's priorTurnDigest). */
  prior?: string;
  gold: IntentGold;
  tags?: string[];
  note?: string;
}

/**
 * What triage and the readout read of a message (agent/triage.ts buildTriageMessages): the gold
 * labels the whole message, so a case must fit in it.
 */
export const MAX_CASE_MESSAGE_CHARS = 1_200;
/** triage's cut of the prior-turn digest. */
export const MAX_CASE_PRIOR_CHARS = 400;

/** JSONL with `//` comment lines, as eval/decisions and eval/routing. A line that is not JSON is an error, loudly. */
export function parseIntentCases(text: string): IntentBenchCase[] {
  const cases: IntentBenchCase[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!line || line.startsWith("//")) continue;
    try {
      cases.push(JSON.parse(line) as IntentBenchCase);
    } catch (err) {
      throw new Error(`case file line ${index + 1} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return cases;
}

/**
 * Everything that would make a case measure nothing or the wrong thing: a duplicate id, a language
 * outside the two the report slices, an empty or over-long message, a facet without gold or with a
 * gold value the readout cannot write (it could never be matched), a facet the readout does not ask.
 */
export function lintIntentCases(cases: readonly IntentBenchCase[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const benchCase of cases) {
    const id = typeof benchCase.id === "string" ? benchCase.id : "";
    if (!id) problems.push("a case has no id");
    else if (seen.has(id)) problems.push(`duplicate case id: ${id}`);
    else seen.add(id);
    const label = id || "?";
    if (benchCase.language !== "de" && benchCase.language !== "en") problems.push(`[${label}] language must be "de" or "en"`);
    if (typeof benchCase.message !== "string" || !benchCase.message.trim()) problems.push(`[${label}] message is empty`);
    else if (benchCase.message.trim().length > MAX_CASE_MESSAGE_CHARS) problems.push(`[${label}] message is over the ${MAX_CASE_MESSAGE_CHARS} characters the readout reads`);
    if (benchCase.prior !== undefined && (typeof benchCase.prior !== "string" || !benchCase.prior.trim() || benchCase.prior.trim().length > MAX_CASE_PRIOR_CHARS)) {
      problems.push(`[${label}] prior must be a non-empty digest of at most ${MAX_CASE_PRIOR_CHARS} characters`);
    }
    const gold = benchCase.gold as Record<string, unknown> | undefined;
    if (!gold || typeof gold !== "object") {
      problems.push(`[${label}] has no gold`);
    } else {
      for (const name of INTENT_FACET_NAMES) {
        const value = gold[name];
        if (value === undefined) problems.push(`[${label}] has no gold for ${name}`);
        else if (typeof value !== "string" || !INTENT_FACET_BY_NAME[name].keys.includes(value)) problems.push(`[${label}] gold ${name} "${String(value)}" is not an option of ${name}`);
      }
      for (const key of Object.keys(gold)) {
        if (!(INTENT_FACET_NAMES as readonly string[]).includes(key)) problems.push(`[${label}] gold names ${key}, which the readout does not ask`);
      }
    }
    if (benchCase.tags !== undefined && (!Array.isArray(benchCase.tags) || benchCase.tags.some((tag) => typeof tag !== "string"))) {
      problems.push(`[${label}] tags must be a list of strings`);
    }
  }
  return problems;
}

export interface IntentDatasetProfile {
  cases: number;
  byLanguage: Record<string, number>;
  germanShare: number;
  /** Per facet, how many cases hold each gold value (every option listed, 0 where none does). */
  perFacet: Record<IntentFacetName, Record<string, number>>;
}

export function profileIntentCases(cases: readonly IntentBenchCase[]): IntentDatasetProfile {
  const byLanguage = countBy(cases.map((benchCase) => benchCase.language));
  const perFacet = Object.fromEntries(INTENT_FACET_NAMES.map((name) => {
    const counts = Object.fromEntries(INTENT_FACET_BY_NAME[name].keys.map((key) => [key, 0]));
    for (const benchCase of cases) {
      const value = benchCase.gold?.[name];
      if (value !== undefined && value in counts) counts[value]! += 1;
    }
    return [name, counts];
  })) as Record<IntentFacetName, Record<string, number>>;
  return { cases: cases.length, byLanguage, germanShare: cases.length ? (byLanguage["de"] ?? 0) / cases.length : 0, perFacet };
}

/** --order-swap's facets, each one's options reversed: the readout's own (its `bothOrders` second pass asks the same). */
export { reversedFacets } from "../decisions/intent-readout.js";

// ── One case's arms ──────────────────────────────────────────────────────────────────────────────

/** One facet as the readout read it: letters and numbers only. */
export interface FacetReading {
  choice: string;
  top: number;
  margin: number;
  runnerUp?: string;
  /** Per option key, before any temperature: what a temperature is fitted on. */
  logScores: Record<string, number>;
  /** The option the reply actually wrote at the slot. */
  sampled?: string;
  /** An averaged reading's two passes (averagedArm); absent on one pass's. */
  orders?: IntentFacetOrders;
}

export interface ReadoutArm {
  ms: number;
  /** The call came back with a token list to read. */
  ok: boolean;
  /** Why it did not. */
  failure?: "no_logprobs" | "error" | "aborted";
  error?: string;
  facets: Partial<Record<IntentFacetName, FacetReading>>;
  /** Per facet that could not be read, why (IntentFacetMiss). */
  misses: Partial<Record<IntentFacetName, string>>;
  /** The restatement's length. Never its text: it is the user's request in other words. */
  queryEnChars: number;
  tokens: number;
  /** The language bucket the readout detected (it looks its temperatures up under it). */
  detected?: string;
  /** llama-server's own account of the call, where the provider recorded it. */
  timings?: ServerTimings;
}

/** A readout's result as the bench keeps it: no text. Pure. */
export function readoutArmFrom(result: IntentReadoutResult): ReadoutArm {
  if (!result.ok) {
    return {
      ms: result.ms,
      ok: false,
      failure: result.reason,
      ...(result.error !== undefined ? { error: result.error } : {}),
      facets: {},
      misses: {},
      queryEnChars: 0,
      tokens: 0,
    };
  }
  const { readout } = result;
  const facets: ReadoutArm["facets"] = {};
  for (const [name, read] of Object.entries(readout.facets) as Array<[IntentFacetName, NonNullable<(typeof readout.facets)[IntentFacetName]>]>) {
    facets[name] = {
      choice: read.choice,
      top: read.top,
      margin: read.margin,
      ...(read.runnerUp !== undefined ? { runnerUp: read.runnerUp } : {}),
      logScores: read.logScores,
      ...(read.sampled !== undefined ? { sampled: read.sampled } : {}),
    };
  }
  const misses: ReadoutArm["misses"] = {};
  for (const [name, miss] of Object.entries(readout.misses) as Array<[IntentFacetName, { reason: string }]>) misses[name] = miss.reason;
  return { ms: readout.ms, ok: true, facets, misses, queryEnChars: readout.queryEn.length, tokens: readout.tokens, detected: readout.language };
}

export interface TriageArm {
  ms: number;
  attempts: number;
  /** Triage's verdict in the readout's keys (triageVerdictKeys). */
  verdict?: Record<IntentFacetName, string>;
  /** "timeout" | "parse_failed" | "error" | … when there is no verdict. */
  failure?: string;
  /** The restatement's length; triage leaves it empty for a request already in English. */
  queryEnChars?: number;
  timings?: ServerTimings;
}

/** A triage outcome as the bench keeps it: no text. Pure. */
export function triageArmFrom(outcome: TriageOutcome): TriageArm {
  if (!outcome.verdict) return { ms: outcome.elapsedMs, attempts: outcome.attempts, failure: outcome.failureReason ?? "no_verdict" };
  return { ms: outcome.elapsedMs, attempts: outcome.attempts, verdict: triageVerdictKeys(outcome.verdict), queryEnChars: outcome.verdict.queryEn.length };
}

export interface IntentBenchResult {
  caseId: string;
  language: string;
  split: BenchSplit;
  gold: IntentGold;
  tags?: readonly string[];
  /** With --with-triage, which arm went first (they alternate). */
  first?: "readout" | "triage";
  readout?: ReadoutArm;
  /** --order-swap: the readout with every facet's options reversed. */
  swapped?: ReadoutArm;
  triage?: TriageArm;
}

/**
 * The two passes of --order-swap combined as askIntentReadout `bothOrders` combines its two calls
 * (decisions/intent-readout.ts combineOrderReadouts), from the arms the bench keeps: per facet the
 * two readings averaged per option (averageOrderReadings, at T = 1), a facet one pass missed that
 * pass's alone, a facet both missed the main pass's miss. The same rule for the passes: the main
 * pass failing is the averaged readout failing; a swapped pass that failed leaves every facet the
 * main pass's alone, one aborted (its timeout) leaves no reading. No swapped pass, no averaged
 * reading. Time and tokens are the two passes' sum. Pure.
 */
export function averagedArm(main: ReadoutArm | undefined, swapped: ReadoutArm | undefined): ReadoutArm | undefined {
  if (!main || !swapped) return undefined;
  if (!main.ok) return main;
  if (!swapped.ok && swapped.failure === "aborted") return { ms: main.ms + swapped.ms, ok: false, failure: "aborted", facets: {}, misses: {}, queryEnChars: 0, tokens: 0 };
  const facets: ReadoutArm["facets"] = {};
  const misses: ReadoutArm["misses"] = {};
  for (const facet of INTENT_FACET_NAMES) {
    const averaged = averageOrderReadings(INTENT_FACET_BY_NAME[facet].keys, main.facets[facet], swapped.ok ? swapped.facets[facet] : undefined);
    if (!averaged) {
      const miss = main.misses[facet] ?? swapped.misses[facet];
      if (miss !== undefined) misses[facet] = miss;
      continue;
    }
    facets[facet] = {
      choice: averaged.choice,
      top: averaged.top,
      margin: averaged.margin,
      ...(averaged.runnerUp !== undefined ? { runnerUp: averaged.runnerUp } : {}),
      logScores: averaged.logScores,
      orders: averaged.orders,
    };
  }
  const { timings: _timings, ...rest } = main;
  return { ...rest, facets, misses, ms: main.ms + swapped.ms, tokens: main.tokens + swapped.tokens };
}

/**
 * --order-swap: every case that was asked again, with the reversed pass, or the two averaged
 * (averagedArm), in the main pass's place — so the main pass's own scoring reads it unchanged,
 * triage comparison included. Pure.
 */
export function orderSwapView(results: readonly IntentBenchResult[], arm: "swapped" | "averaged"): IntentBenchResult[] {
  return results.flatMap((result) => {
    if (!result.swapped) return [];
    const { readout: main, swapped, first: _first, ...rest } = result;
    const readout = arm === "swapped" ? swapped : averagedArm(main, swapped);
    return [{ ...rest, ...(readout ? { readout } : {}) }];
  });
}

// ── Small statistics ─────────────────────────────────────────────────────────────────────────────

function rateOf(hits: number, n: number): Rate {
  return { hits, n, rate: n > 0 ? hits / n : null };
}

function countBy(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

/** The option's probability at temperature T, from the log-scores in the facet's own key order. */
function probabilitiesAt(reading: FacetReading, keys: readonly string[], temperature: number): Record<string, number> | null {
  if (keys.some((key) => !Number.isFinite(reading.logScores[key]))) return null;
  const p = applyTemperature(keys.map((key) => reading.logScores[key]!), temperature);
  return Object.fromEntries(keys.map((key, i) => [key, p[i]!]));
}

// ── Per facet and language ───────────────────────────────────────────────────────────────────────

/** Coverage and accuracy for a consumer that takes a reading only at or above a level. */
export interface CurveRow {
  level: number;
  taken: number;
  correct: number;
  /** Taken among the facet's readings. */
  coverage: number;
  /** Right among the taken; null when nothing was taken. */
  accuracy: number | null;
}

/** Top probability levels: 0.85 is the readout's default gate (DEFAULT_CONFIDENCE). */
export const CONFIDENCE_LEVELS: readonly number[] = Object.freeze([0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.99]);
/** Margin levels (top − runner-up): 0.15 is the ecosystem recipe's (pi-laya-router, DecisionKit). */
export const MARGIN_LEVELS: readonly number[] = Object.freeze([0, 0.1, 0.15, 0.2, 0.3, 0.5, 0.7, 0.9]);

export interface IntentCalibration {
  calibrationCases: number;
  testCases: number;
  /** Fitted on the calibration half, against gold. */
  fit: TemperatureFit;
  /** On the test half, at T = 1 and at the fitted T. */
  eceBefore: number | null;
  eceAfter: number | null;
  nllBefore: number | null;
  nllAfter: number | null;
}

export interface TriageComparison {
  /** Triage against gold, on every case it answered. */
  accuracy: Rate;
  /** On the cases both answered: the readout right, triage right. */
  readoutOnBoth: Rate;
  triageOnBoth: Rate;
  /** The two gave the same answer, on the cases both answered: what a shadow run counts. */
  agreement: Rate;
  /** Discordant pairs: only the readout right, only triage right, and the exact McNemar p. */
  readoutOnly: number;
  triageOnly: number;
  pExact: number;
}

export interface IntentFacetSlice {
  facet: IntentFacetName;
  language: SliceLanguage;
  /** Cases whose readout call came back with a token list. */
  asked: number;
  /** Of those, the facet was read. */
  read: Rate;
  /** Why it was not, per reason. */
  misses: Record<string, number>;
  /** The readout against gold, on the cases it read, with the Wilson lower bound. */
  accuracy: Rate & { lowerBound: number | null };
  /**
   * The always-majority baseline on the same cases: the most common gold value (ties to the first
   * option), in-sample — the most a constant answer could score here, so beating it is the floor.
   * Paired with the readout case by case: only the readout right (the gold is a minority value it
   * read), only the constant right (a majority case it misread), and the exact McNemar p on those.
   */
  majority: Rate & { label: string | null; readoutOnly: number; constantOnly: number; pExact: number };
  /** Per gold value: how often the readout gave it (recall). */
  perGold: Record<string, Rate>;
  /** Rows gold, columns the readout's choice, both in the facet's option order. */
  confusion: { keys: string[]; counts: number[][] };
  calibration: IntentCalibration | null;
  confidenceCurve: CurveRow[];
  marginCurve: CurveRow[];
  /** Readings whose written letter was not the argmax: 0 at the default sampling temperature 0. */
  sampledDiffers: number;
  /** --order-swap: the choice changed with the options reversed, and the mean change of the first choice's probability. */
  flips: Rate & { meanTopShift: number | null };
  triage: TriageComparison | null;
}

function sliceResults(results: readonly IntentBenchResult[], language: SliceLanguage): IntentBenchResult[] {
  return language === "all" ? [...results] : results.filter((result) => result.language === language);
}

function curve(readings: ReadonlyArray<{ value: number; correct: boolean }>, levels: readonly number[]): CurveRow[] {
  return levels.map((level) => {
    const taken = readings.filter((reading) => reading.value >= level - 1e-12);
    const correct = taken.filter((reading) => reading.correct).length;
    return {
      level,
      taken: taken.length,
      correct,
      coverage: readings.length ? taken.length / readings.length : 0,
      accuracy: taken.length ? correct / taken.length : null,
    };
  });
}

function sampleOf(reading: FacetReading, keys: readonly string[], gold: string): TemperatureSample | null {
  const label = keys.indexOf(gold);
  if (label < 0 || keys.some((key) => !Number.isFinite(reading.logScores[key]))) return null;
  return { logScores: keys.map((key) => reading.logScores[key]!), label };
}

function eceAt(samples: readonly TemperatureSample[], temperature: number): number | null {
  return expectedCalibrationError(samples.map((sample) => {
    const p = applyTemperature(sample.logScores, temperature);
    let best = 0;
    for (let i = 1; i < p.length; i += 1) if (p[i]! > p[best]!) best = i;
    return { confidence: p[best]!, correct: best === sample.label };
  }));
}

/**
 * A temperature fitted on the calibration half against gold, and the calibration error on the test
 * half before and after it. Null when either half holds no reading.
 */
export function facetCalibration(results: readonly IntentBenchResult[], facet: IntentFacetName): IntentCalibration | null {
  const keys = INTENT_FACET_BY_NAME[facet].keys;
  const labelled = results.flatMap((result) => {
    const reading = result.readout?.facets[facet];
    const sample = reading ? sampleOf(reading, keys, result.gold[facet]) : null;
    return sample ? [{ split: result.split, sample }] : [];
  });
  const calibration = labelled.filter((entry) => entry.split === "calibration").map((entry) => entry.sample);
  const test = labelled.filter((entry) => entry.split === "test").map((entry) => entry.sample);
  if (calibration.length === 0 || test.length === 0) return null;
  const fit = fitTemperature(calibration);
  return {
    calibrationCases: calibration.length,
    testCases: test.length,
    fit,
    eceBefore: eceAt(test, 1),
    eceAfter: eceAt(test, fit.temperature),
    nllBefore: meanNll(test, 1),
    nllAfter: meanNll(test, 1 / fit.temperature),
  };
}

export function scoreFacetSlice(results: readonly IntentBenchResult[], facet: IntentFacetName, language: SliceLanguage): IntentFacetSlice {
  const keys = [...INTENT_FACET_BY_NAME[facet].keys];
  const mine = sliceResults(results, language);
  const asked = mine.filter((result) => result.readout?.ok);
  const read = asked.filter((result) => result.readout!.facets[facet] !== undefined);
  const misses: Record<string, number> = {};
  for (const result of asked) {
    const miss = result.readout!.misses[facet];
    if (miss !== undefined) misses[miss] = (misses[miss] ?? 0) + 1;
  }
  const right = read.filter((result) => result.readout!.facets[facet]!.choice === result.gold[facet]).length;
  const goldCounts = countBy(read.map((result) => result.gold[facet]));
  let majorityLabel: string | null = null;
  for (const key of keys) if ((goldCounts[key] ?? 0) > (majorityLabel === null ? 0 : goldCounts[majorityLabel] ?? 0)) majorityLabel = key;
  const readoutBeatsConstant = read.filter((result) => result.gold[facet] !== majorityLabel && result.readout!.facets[facet]!.choice === result.gold[facet]).length;
  const constantBeatsReadout = read.filter((result) => result.gold[facet] === majorityLabel && result.readout!.facets[facet]!.choice !== result.gold[facet]).length;
  const perGold: Record<string, Rate> = {};
  for (const key of keys) {
    const given = read.filter((result) => result.gold[facet] === key);
    perGold[key] = rateOf(given.filter((result) => result.readout!.facets[facet]!.choice === key).length, given.length);
  }
  const counts = keys.map(() => keys.map(() => 0));
  for (const result of read) {
    const row = keys.indexOf(result.gold[facet]);
    const column = keys.indexOf(result.readout!.facets[facet]!.choice);
    if (row >= 0 && column >= 0) counts[row]![column]! += 1;
  }
  const points = read.map((result) => {
    const reading = result.readout!.facets[facet]!;
    return { top: reading.top, margin: reading.margin, correct: reading.choice === result.gold[facet] };
  });

  // --order-swap
  const swapped = asked.filter((result) => result.readout!.facets[facet] !== undefined && result.swapped?.facets[facet] !== undefined);
  let flipped = 0;
  const shifts: number[] = [];
  for (const result of swapped) {
    const first = result.readout!.facets[facet]!;
    const again = result.swapped!.facets[facet]!;
    if (first.choice !== again.choice) flipped += 1;
    const before = probabilitiesAt(first, keys, 1);
    const after = probabilitiesAt(again, keys, 1);
    if (before && after) shifts.push(Math.abs(before[first.choice]! - after[first.choice]!));
  }

  // --with-triage
  let triage: TriageComparison | null = null;
  const triaged = mine.filter((result) => result.triage !== undefined);
  if (triaged.length > 0) {
    const answered = triaged.filter((result) => result.triage!.verdict !== undefined);
    const both = answered.filter((result) => result.readout?.facets[facet] !== undefined);
    const readoutRight = (result: IntentBenchResult) => result.readout!.facets[facet]!.choice === result.gold[facet];
    const triageRight = (result: IntentBenchResult) => result.triage!.verdict![facet] === result.gold[facet];
    const readoutOnly = both.filter((result) => readoutRight(result) && !triageRight(result)).length;
    const triageOnly = both.filter((result) => triageRight(result) && !readoutRight(result)).length;
    triage = {
      accuracy: rateOf(answered.filter(triageRight).length, answered.length),
      readoutOnBoth: rateOf(both.filter(readoutRight).length, both.length),
      triageOnBoth: rateOf(both.filter(triageRight).length, both.length),
      agreement: rateOf(both.filter((result) => result.readout!.facets[facet]!.choice === result.triage!.verdict![facet]).length, both.length),
      readoutOnly,
      triageOnly,
      pExact: mcnemarExactP(readoutOnly, triageOnly),
    };
  }

  return {
    facet,
    language,
    asked: asked.length,
    read: rateOf(read.length, asked.length),
    misses,
    accuracy: { ...rateOf(right, read.length), lowerBound: read.length > 0 ? wilsonLowerBound(right, read.length) : null },
    majority: {
      ...rateOf(majorityLabel === null ? 0 : goldCounts[majorityLabel]!, read.length),
      label: majorityLabel,
      readoutOnly: readoutBeatsConstant,
      constantOnly: constantBeatsReadout,
      pExact: mcnemarExactP(readoutBeatsConstant, constantBeatsReadout),
    },
    perGold,
    confusion: { keys, counts },
    calibration: facetCalibration(read, facet),
    confidenceCurve: curve(points.map((point) => ({ value: point.top, correct: point.correct })), CONFIDENCE_LEVELS),
    marginCurve: curve(points.map((point) => ({ value: point.margin, correct: point.correct })), MARGIN_LEVELS),
    sampledDiffers: read.filter((result) => {
      const reading = result.readout!.facets[facet]!;
      return reading.sampled !== undefined && reading.sampled !== reading.choice;
    }).length,
    flips: { ...rateOf(flipped, swapped.length), meanTopShift: shifts.length ? shifts.reduce((sum, value) => sum + value, 0) / shifts.length : null },
    triage,
  };
}

// ── Per language ─────────────────────────────────────────────────────────────────────────────────

export interface IntentLanguageSlice {
  language: SliceLanguage;
  cases: number;
  /** Readout calls that came back with a token list. */
  readoutOk: Rate;
  /** Why the others did not, per reason. */
  readoutFailures: Record<string, number>;
  ms: { readout: Distribution | null; swapped: Distribution | null; triage: Distribution | null };
  /** Generated tokens per readout. */
  tokens: Distribution | null;
  /** llama-server's prompt tokens processed and reused per readout call, where recorded. */
  promptTokens: Distribution | null;
  cachedTokens: Distribution | null;
  /** A non-empty restatement: the readout's (its grammar demands one) and triage's (empty for English by its prompt). */
  queryEn: { readout: Rate; triage: Rate | null };
  /** Readouts whose detected language bucket is not the labelled one: they would look up another temperature. */
  detectedElsewhere: number;
  triage: { answered: Rate; failures: Record<string, number> } | null;
}

export function scoreLanguageSlice(results: readonly IntentBenchResult[], language: SliceLanguage): IntentLanguageSlice {
  const mine = sliceResults(results, language);
  const called = mine.filter((result) => result.readout !== undefined);
  const ok = called.filter((result) => result.readout!.ok);
  const readoutFailures: Record<string, number> = {};
  for (const result of called) {
    const failure = result.readout!.failure;
    if (failure) readoutFailures[failure] = (readoutFailures[failure] ?? 0) + 1;
  }
  const triaged = mine.filter((result) => result.triage !== undefined);
  const triageFailures: Record<string, number> = {};
  for (const result of triaged) {
    const failure = result.triage!.failure;
    if (failure) triageFailures[failure] = (triageFailures[failure] ?? 0) + 1;
  }
  const triageAnswered = triaged.filter((result) => result.triage!.verdict !== undefined);
  const timingOf = (field: keyof ServerTimings) => distribution(ok.flatMap((result) => {
    const value = result.readout!.timings?.[field];
    return typeof value === "number" ? [value] : [];
  }));
  return {
    language,
    cases: mine.length,
    readoutOk: rateOf(ok.length, called.length),
    readoutFailures,
    ms: {
      readout: distribution(ok.map((result) => result.readout!.ms)),
      swapped: distribution(mine.flatMap((result) => (result.swapped?.ok ? [result.swapped.ms] : []))),
      triage: distribution(triaged.flatMap((result) => (result.triage!.failure === "error" ? [] : [result.triage!.ms]))),
    },
    tokens: distribution(ok.map((result) => result.readout!.tokens)),
    promptTokens: timingOf("promptN"),
    cachedTokens: timingOf("cacheN"),
    queryEn: {
      readout: rateOf(ok.filter((result) => result.readout!.queryEnChars > 0).length, ok.length),
      triage: triaged.length > 0 ? rateOf(triageAnswered.filter((result) => (result.triage!.queryEnChars ?? 0) > 0).length, triageAnswered.length) : null,
    },
    detectedElsewhere: ok.filter((result) => result.readout!.detected !== undefined && result.readout!.detected !== result.language).length,
    triage: triaged.length > 0 ? { answered: rateOf(triageAnswered.length, triaged.length), failures: triageFailures } : null,
  };
}

// ── Verdict and temperatures ─────────────────────────────────────────────────────────────────────

/** Below this many answered calls (and then readings) a facet's accuracy says too little to judge it. */
export const MIN_SCORED_PER_FACET = 20;
/** The McNemar p below which triage's lead on the discordant cases counts. */
export const TRIAGE_SIGNIFICANCE = 0.05;
/** The McNemar p below which the readout's lead over the constant answer counts. */
export const MAJORITY_SIGNIFICANCE = 0.05;
/**
 * A facet read on fewer than this share of a language's answered calls is not read in that
 * language: its accuracy describes the few replies it could read, not the language.
 */
export const MIN_READ_SHARE = 0.5;
/** Below this share of a language's answered calls, the report warns that a facet is often unread. */
export const READ_SHARE_WARNING = 0.9;

/**
 * holds; below_majority: no better than the constant answer, in both languages together or in one;
 * unproven: better on the point estimate, but not significantly (a facet whose gold is 92% "yes"
 * holds at 93% by one case); unread: the calls came back but the facet was read on too few of them;
 * below_triage; inconclusive: too few calls, or none in a language. Every verdict but holds and
 * inconclusive fails the run.
 */
export type IntentFacetVerdict = "holds" | "below_majority" | "unproven" | "unread" | "below_triage" | "inconclusive";

/** The verdicts that fail the run (exit 1). */
export const FAILING_FACET_VERDICTS: ReadonlySet<IntentFacetVerdict> = new Set(["below_majority", "unproven", "unread", "below_triage"]);

/**
 * A facet holds when the readout reads it in both languages, better than a constant answer in each
 * and significantly so in both together, and, with triage run, not significantly worse than triage.
 *
 * Inconclusive means too little was ASKED: fewer than MIN_SCORED_PER_FACET answered calls, or none in
 * one language. A facet that was asked and not read is `unread`, never inconclusive: counted as
 * inconclusive, a facet the readout could not read in German at all left the run at exit 0 beside
 * six that held.
 */
export function facetVerdict(slices: readonly IntentFacetSlice[]): { verdict: IntentFacetVerdict; reasons: string[] } {
  const all = slices.find((slice) => slice.language === "all")!;
  const reasons = [`accuracy ${ratio(all.accuracy)} against always-${all.majority.label ?? "?"} ${ratio(all.majority)}`];
  if (all.asked < MIN_SCORED_PER_FACET) return { verdict: "inconclusive", reasons: [...reasons, `fewer than ${MIN_SCORED_PER_FACET} answered calls`] };
  const languages: IntentFacetSlice[] = [];
  for (const language of ["de", "en"] as const) {
    const slice = slices.find((entry) => entry.language === language);
    if (!slice || slice.asked === 0) return { verdict: "inconclusive", reasons: [...reasons, `no ${language} call answered`] };
    languages.push(slice);
  }
  const unread = languages.filter((slice) => slice.read.rate! < MIN_READ_SHARE);
  if (unread.length > 0 || all.accuracy.n < MIN_SCORED_PER_FACET) {
    return {
      verdict: "unread",
      reasons: [...reasons, ...(unread.length > 0
        ? unread.map((slice) => `read on ${ratio(slice.read)} of the ${slice.language} calls that answered`)
        : [`read on only ${all.accuracy.n} calls`])],
    };
  }
  for (const slice of [all, ...languages]) {
    if (slice.accuracy.rate! <= slice.majority.rate!) {
      const where = slice.language === "all" ? "" : ` in ${slice.language} (${ratio(slice.accuracy)} against always-${slice.majority.label ?? "?"} ${ratio(slice.majority)})`;
      return { verdict: "below_majority", reasons: [...reasons, `no better than the constant answer${where}`] };
    }
  }
  if (all.triage) {
    reasons.push(`triage ${ratio(all.triage.triageOnBoth)} on the same cases (only readout right ${all.triage.readoutOnly}, only triage right ${all.triage.triageOnly}, p ${all.triage.pExact.toFixed(3)})`);
    if (all.triage.triageOnly > all.triage.readoutOnly && all.triage.pExact < TRIAGE_SIGNIFICANCE) return { verdict: "below_triage", reasons };
  }
  const versus = `only readout right ${all.majority.readoutOnly}, only the constant right ${all.majority.constantOnly}, p ${all.majority.pExact.toFixed(3)}`;
  if (!(all.majority.readoutOnly > all.majority.constantOnly && all.majority.pExact < MAJORITY_SIGNIFICANCE)) {
    return { verdict: "unproven", reasons: [...reasons, `not significantly better than the constant answer (${versus})`] };
  }
  return { verdict: "holds", reasons: [...reasons, `against the constant: ${versus}`] };
}

// ── The order swap, scored ───────────────────────────────────────────────────────────────────────

/** One arm of --order-swap in one language, scored as the main pass's slice is (a subset of its figures). */
export type OrderArmSlice = Pick<IntentFacetSlice, "language" | "asked" | "read" | "accuracy" | "majority" | "calibration" | "confidenceCurve" | "marginCurve" | "triage"> & {
  /** Averaged readings that are one pass's alone: the other pass missed the facet or failed. */
  singlePass: number;
};

export interface OrderSwapFacet {
  /** Per language: both passes read the facet and chose the same option (the complement of `flips`). */
  agreement: Array<Rate & { language: SliceLanguage }>;
  /** The reversed pass alone. */
  swapped: OrderArmSlice[];
  /**
   * The two passes averaged per option (averagedArm), with the verdict that readout would get: an
   * extra column. The run's verdict and exit code are the main pass's.
   */
  averaged: { verdict: IntentFacetVerdict; reasons: string[]; slices: OrderArmSlice[] };
}

function orderArmSlice(slice: IntentFacetSlice, singlePass: number): OrderArmSlice {
  return {
    language: slice.language,
    asked: slice.asked,
    read: slice.read,
    accuracy: slice.accuracy,
    majority: slice.majority,
    calibration: slice.calibration,
    confidenceCurve: slice.confidenceCurve,
    marginCurve: slice.marginCurve,
    triage: slice.triage,
    singlePass,
  };
}

/**
 * One facet's --order-swap figures, from the main pass's slices (for the agreement) and the two
 * views of the results (orderSwapView). Pure.
 */
export function scoreOrderSwap(
  facet: IntentFacetName,
  mainSlices: readonly IntentFacetSlice[],
  swappedView: readonly IntentBenchResult[],
  averagedView: readonly IntentBenchResult[],
): OrderSwapFacet {
  const singlePassIn = (view: readonly IntentBenchResult[], language: SliceLanguage) => sliceResults(view, language)
    .filter((result) => result.readout?.ok && result.readout.facets[facet]?.orders?.singlePass !== undefined).length;
  const swappedSlices = SLICE_LANGUAGES.map((language) => scoreFacetSlice(swappedView, facet, language));
  const averagedSlices = SLICE_LANGUAGES.map((language) => scoreFacetSlice(averagedView, facet, language));
  return {
    agreement: mainSlices.map((slice) => ({ language: slice.language, ...rateOf(slice.flips.n - slice.flips.hits, slice.flips.n) })),
    swapped: swappedSlices.map((slice) => orderArmSlice(slice, 0)),
    averaged: {
      ...facetVerdict(averagedSlices),
      slices: averagedSlices.map((slice) => orderArmSlice(slice, singlePassIn(averagedView, slice.language))),
    },
  };
}

export interface SuggestedTemperatures {
  /** Per facet and detected language bucket, fitted on every reading against gold. */
  fits: Partial<Record<IntentFacetName, Partial<Record<LanguageBucket, TemperatureFit>>>>;
  /** What askIntentReadout takes (`temperatures`), unclamped fits only. */
  intentTemperatures: IntentTemperatures;
  /** The same under decisions.readout.temperatures, keyed `intent.<facet>`: nothing reads these keys yet. */
  config: Record<string, Record<string, number>>;
}

/** The buckets askIntentReadout looks a temperature up under (decisions/gate.ts languageBucket). */
const TEMPERATURE_BUCKETS: readonly LanguageBucket[] = ["de", "en", "other"];

/**
 * The temperatures to hand the readout: fitted on every case of the facet and language, since the
 * held-out figures already say whether a fit helps. A fit on the range's end is left out.
 *
 * Keyed by the bucket the readout DETECTED, not the labelled language: askIntentReadout looks a
 * temperature up under the detected bucket, and a short message ("ok cool", "Hallo!") is detected
 * as "other". Fitted on the labels, those readings tuned the de/en temperature they never receive,
 * and "other" got none. The labelled language stands in for an arm that recorded no bucket.
 */
export function suggestTemperatures(results: readonly IntentBenchResult[]): SuggestedTemperatures {
  const fits: SuggestedTemperatures["fits"] = {};
  const intentTemperatures: IntentTemperatures = {};
  const config: Record<string, Record<string, number>> = {};
  for (const facet of INTENT_FACET_NAMES) {
    const keys = INTENT_FACET_BY_NAME[facet].keys;
    for (const language of TEMPERATURE_BUCKETS) {
      const samples = results.flatMap((result) => {
        const bucket = result.readout?.detected ?? result.language;
        const reading = bucket === language ? result.readout?.facets[facet] : undefined;
        const sample = reading ? sampleOf(reading, keys, result.gold[facet]) : null;
        return sample ? [sample] : [];
      });
      if (samples.length === 0) continue;
      const fit = fitTemperature(samples);
      (fits[facet] ??= {})[language] = fit;
      if (fit.clamped) continue;
      const rounded = Math.round(fit.temperature * 1000) / 1000;
      (intentTemperatures[facet] ??= {})[language] = rounded;
      (config[`intent.${facet}`] ??= {})[language] = rounded;
    }
  }
  return { fits, intentTemperatures, config };
}

// ── The report ───────────────────────────────────────────────────────────────────────────────────

export interface IntentBenchSettings {
  casesFiles: string[];
  casesSha256?: string;
  split: "all" | BenchSplit;
  withTriage: boolean;
  orderSwap: boolean;
  samplingTemperature: number;
  topLogprobs: number;
  minMass: number;
  triageTimeoutMs?: number;
  model?: string;
}

export interface IntentBenchReport {
  kind: "intent-bench";
  version: 1;
  readoutVersion: string;
  settings: IntentBenchSettings;
  counts: { cases: number; readoutAsked: number; readoutOk: number; swappedAsked: number; triageAsked: number; triageAnswered: number };
  /** `orderSwap` only when some case was asked again with the options reversed. */
  facets: Array<{ facet: IntentFacetName; verdict: IntentFacetVerdict; reasons: string[]; slices: IntentFacetSlice[]; orderSwap?: OrderSwapFacet }>;
  languages: IntentLanguageSlice[];
  suggestedTemperatures: SuggestedTemperatures;
  warnings: string[];
  exitCode: 0 | 1 | 2;
}

export function buildIntentBenchReport(results: readonly IntentBenchResult[], settings: IntentBenchSettings): IntentBenchReport {
  const swapAsked = results.some((result) => result.swapped !== undefined);
  const swappedView = swapAsked ? orderSwapView(results, "swapped") : [];
  const averagedView = swapAsked ? orderSwapView(results, "averaged") : [];
  const facets = INTENT_FACET_NAMES.map((facet) => {
    const slices = SLICE_LANGUAGES.map((language) => scoreFacetSlice(results, facet, language));
    // The verdict is the main pass's alone; the order swap's figures only sit beside it.
    return { facet, ...facetVerdict(slices), slices, ...(swapAsked ? { orderSwap: scoreOrderSwap(facet, slices, swappedView, averagedView) } : {}) };
  });
  const languages = SLICE_LANGUAGES.map((language) => scoreLanguageSlice(results, language));
  const readoutAsked = results.filter((result) => result.readout !== undefined).length;
  const readoutOk = results.filter((result) => result.readout?.ok).length;
  const warnings: string[] = [];
  if (settings.withTriage) {
    warnings.push("The readout's and triage's system prefixes alternate on the server case by case. With one server slot each call re-prefills its prefix, so both arms' ms are the switching figure, not the warm one: run without --with-triage for the readout's warm time.");
  }
  if (settings.orderSwap) {
    warnings.push("The swapped pass runs after the main pass, on its own prefix: its ms describe that prefix, and it does not disturb the main pass's cache.");
    warnings.push("The averaged column combines the two passes as askIntentReadout bothOrders does, but not its time: here each pass ran with its own prefix warm, while bothOrders asks the two prefixes back to back on every request. Its verdict is an extra column; the run's verdict and exit code are the main pass's.");
  }
  const differs = facets.reduce((sum, entry) => sum + entry.slices.find((slice) => slice.language === "all")!.sampledDiffers, 0);
  if (differs > 0) {
    warnings.push(`${differs} reading(s) wrote a letter other than the argmax${settings.samplingTemperature > 0 ? ` (sampling temperature ${settings.samplingTemperature})` : ", at sampling temperature 0: the server did not sample greedily"}: later slots on those replies were read after a runner-up.`);
  }
  if (settings.split !== "all") warnings.push(`Split ${settings.split}: the calibration rows split this half again, so each side holds about a quarter of the cases.`);
  const sparse = INTENT_FACET_NAMES.flatMap((facet) => {
    const perGold = facets.find((entry) => entry.facet === facet)!.slices.find((slice) => slice.language === "all")!.perGold;
    return Object.entries(perGold).filter(([, rate]) => rate.n > 0 && rate.n < 8).map(([key]) => `${facet}=${key}`);
  });
  if (sparse.length > 0) warnings.push(`Fewer than 8 readings for ${sparse.join(", ")}: their recall is anecdotal.`);
  const thin = facets.flatMap((entry) => entry.slices
    .filter((slice) => slice.language !== "all" && slice.asked > 0 && slice.read.rate! < READ_SHARE_WARNING)
    .map((slice) => `${entry.facet} ${slice.language} ${ratio(slice.read)}`));
  if (thin.length > 0) warnings.push(`Read on fewer than ${pct(READ_SHARE_WARNING)} of the calls that answered: ${thin.join(", ")}. Accuracy there is on the replies that could be read.`);
  const noLists = readoutAsked > 0 && results.every((result) => !result.readout || result.readout.failure === "no_logprobs" || result.readout.failure === "error" || result.readout.failure === "aborted")
    && results.some((result) => result.readout?.failure === "no_logprobs");
  const verdicts = facets.map((entry) => entry.verdict);
  const exitCode: 0 | 1 | 2 = noLists
    ? 1
    : readoutOk === 0 || verdicts.every((verdict) => verdict === "inconclusive")
      ? 2
      : verdicts.some((verdict) => FAILING_FACET_VERDICTS.has(verdict)) ? 1 : 0;
  if (noLists) warnings.push("No readout call came back with a token list: the server does not send logprobs, so there is no readout.");
  return {
    kind: "intent-bench",
    version: 1,
    readoutVersion: INTENT_READOUT_VERSION,
    settings,
    counts: {
      cases: results.length,
      readoutAsked,
      readoutOk,
      swappedAsked: results.filter((result) => result.swapped !== undefined).length,
      triageAsked: results.filter((result) => result.triage !== undefined).length,
      triageAnswered: results.filter((result) => result.triage?.verdict !== undefined).length,
    },
    facets,
    languages,
    suggestedTemperatures: suggestTemperatures(results),
    warnings,
    exitCode,
  };
}

// ── Markdown ─────────────────────────────────────────────────────────────────────────────────────

function pct(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

function ratio(rate: Rate): string {
  return rate.rate === null ? "n/a" : `${rate.hits}/${rate.n} (${pct(rate.rate)})`;
}

function ms(value: Distribution | null): string {
  return value ? `${Math.round(value.p50)} / ${Math.round(value.p90)}` : "n/a";
}

function num(value: number | null, digits = 3): string {
  return value === null || !Number.isFinite(value) ? "n/a" : value.toFixed(digits);
}

function calibrationCell(block: IntentCalibration | null): string {
  if (!block) return "n/a";
  return `${num(block.eceBefore)} → ${num(block.eceAfter)} (T ${block.fit.temperature.toFixed(2)}${block.fit.clamped ? ", clamped" : ""}; ${block.calibrationCases}/${block.testCases})`;
}

function curveCell(rows: readonly CurveRow[], level: number): string {
  const row = rows.find((entry) => entry.level === level);
  return row ? `${pct(row.coverage)} · ${row.accuracy === null ? "n/a" : pct(row.accuracy)}` : "n/a";
}

/**
 * The averaged readout's verdict and accuracy beside one order's, and how often the two orders
 * agreed, all languages: the verdict table's extra column and the console's. Null without
 * --order-swap.
 */
export function orderSwapCell(entry: IntentBenchReport["facets"][number]): string | null {
  const swap = entry.orderSwap;
  if (!swap) return null;
  const averaged = swap.averaged.slices.find((slice) => slice.language === "all")!;
  const main = entry.slices.find((slice) => slice.language === "all")!;
  const agreement = swap.agreement.find((rate) => rate.language === "all")!;
  return `${swap.averaged.verdict.replace(/_/g, " ")} · ${ratio(averaged.accuracy)} against one order's ${ratio(main.accuracy)}; orders agree ${ratio(agreement)}`;
}

export function renderIntentBenchMarkdown(report: IntentBenchReport, header: readonly string[] = []): string {
  const lines: string[] = ["# Intent readout bench", "", ...header, ""];
  lines.push(`Readout ${report.readoutVersion}; ${report.counts.cases} cases, ${report.counts.readoutOk}/${report.counts.readoutAsked} readouts came back with a token list`
    + `${report.settings.withTriage ? `, triage answered ${report.counts.triageAnswered}/${report.counts.triageAsked}` : ""}`
    + `${report.settings.orderSwap ? `, ${report.counts.swappedAsked} asked again with the options reversed` : ""}. `
    + `Sampling temperature ${report.settings.samplingTemperature}, top ${report.settings.topLogprobs}, min letter mass ${report.settings.minMass}.`, "");

  if (report.facets.some((entry) => entry.orderSwap)) {
    // The averaged readout's verdict sits beside the main pass's; it decides nothing here.
    lines.push("## Verdict per facet", "", "| facet | verdict | why | both orders averaged (extra column, not the verdict) |", "|---|---|---|---|");
    for (const entry of report.facets) lines.push(`| ${entry.facet} | **${entry.verdict.replace(/_/g, " ")}** | ${entry.reasons.join("; ")} | ${orderSwapCell(entry) ?? "n/a"} |`);
  } else {
    lines.push("## Verdict per facet", "", "| facet | verdict | why |", "|---|---|---|");
    for (const entry of report.facets) lines.push(`| ${entry.facet} | **${entry.verdict.replace(/_/g, " ")}** | ${entry.reasons.join("; ")} |`);
  }
  lines.push("");

  lines.push("## Per language", "");
  const columns = report.languages.map((slice) => slice.language);
  const languageRow = (label: string, cell: (slice: IntentLanguageSlice) => string) => `| ${label} | ${report.languages.map(cell).join(" | ")} |`;
  lines.push(`| | ${columns.join(" | ")} |`, `|---|${columns.map(() => "---").join("|")}|`);
  lines.push(languageRow("cases", (s) => String(s.cases)));
  lines.push(languageRow("readout came back with a token list", (s) => ratio(s.readoutOk)));
  lines.push(languageRow("readout failures", (s) => Object.entries(s.readoutFailures).map(([reason, count]) => `${reason} ${count}`).join(", ") || "none"));
  lines.push(languageRow("readout ms p50 / p90", (s) => ms(s.ms.readout)));
  lines.push(languageRow("tokens generated p50 / p90", (s) => ms(s.tokens)));
  lines.push(languageRow("prompt tokens processed / reused p50", (s) => `${s.promptTokens ? Math.round(s.promptTokens.p50) : "n/a"} / ${s.cachedTokens ? Math.round(s.cachedTokens.p50) : "n/a"}`));
  lines.push(languageRow("query_en non-empty, readout", (s) => ratio(s.queryEn.readout)));
  if (report.settings.withTriage) {
    lines.push(languageRow("query_en non-empty, triage", (s) => (s.queryEn.triage ? ratio(s.queryEn.triage) : "n/a")));
    lines.push(languageRow("triage answered", (s) => (s.triage ? ratio(s.triage.answered) : "n/a")));
    lines.push(languageRow("triage failures", (s) => (s.triage ? Object.entries(s.triage.failures).map(([reason, count]) => `${reason} ${count}`).join(", ") || "none" : "n/a")));
    lines.push(languageRow("triage ms p50 / p90", (s) => ms(s.ms.triage)));
  }
  if (report.settings.orderSwap) lines.push(languageRow("swapped readout ms p50 / p90", (s) => ms(s.ms.swapped)));
  lines.push(languageRow("detected language not the labelled one", (s) => String(s.detectedElsewhere)));
  lines.push("");

  for (const entry of report.facets) {
    lines.push(`## ${entry.facet}: ${entry.verdict.replace(/_/g, " ").toUpperCase()}`, "");
    const facetColumns = entry.slices.map((slice) => slice.language);
    const row = (label: string, cell: (slice: IntentFacetSlice) => string) => `| ${label} | ${entry.slices.map(cell).join(" | ")} |`;
    lines.push(`| | ${facetColumns.join(" | ")} |`, `|---|${facetColumns.map(() => "---").join("|")}|`);
    lines.push(row("read", (s) => ratio(s.read)));
    lines.push(row("misses", (s) => Object.entries(s.misses).map(([reason, count]) => `${reason} ${count}`).join(", ") || "none"));
    lines.push(row("**accuracy vs gold**", (s) => `${ratio(s.accuracy)}${s.accuracy.lowerBound !== null ? `, ≥${pct(s.accuracy.lowerBound)}` : ""}`));
    lines.push(row("always the majority", (s) => `${ratio(s.majority)}${s.majority.label ? ` ${s.majority.label}` : ""}`));
    lines.push(row("only readout / only constant right (p)", (s) => `${s.majority.readoutOnly} / ${s.majority.constantOnly} (${s.majority.pExact.toFixed(3)})`));
    if (entry.slices.some((slice) => slice.triage)) {
      lines.push(row("triage vs gold", (s) => (s.triage ? ratio(s.triage.accuracy) : "n/a")));
      lines.push(row("readout / triage on the same cases", (s) => (s.triage ? `${ratio(s.triage.readoutOnBoth)} / ${ratio(s.triage.triageOnBoth)}` : "n/a")));
      lines.push(row("only readout / only triage right (p)", (s) => (s.triage ? `${s.triage.readoutOnly} / ${s.triage.triageOnly} (${s.triage.pExact.toFixed(3)})` : "n/a")));
      lines.push(row("agrees with triage", (s) => (s.triage ? ratio(s.triage.agreement) : "n/a")));
    }
    lines.push(row("ECE vs gold, T=1 → fitted (cal/test)", (s) => calibrationCell(s.calibration)));
    for (const level of [0.85, 0.95]) lines.push(row(`top ≥ ${level}: coverage · accuracy`, (s) => curveCell(s.confidenceCurve, level)));
    for (const level of [0.15, 0.5]) lines.push(row(`margin ≥ ${level}: coverage · accuracy`, (s) => curveCell(s.marginCurve, level)));
    if (report.settings.orderSwap) lines.push(row("flips with the options reversed (mean shift)", (s) => `${ratio(s.flips)}${s.flips.meanTopShift !== null ? ` (${s.flips.meanTopShift.toFixed(3)})` : ""}`));
    const swap = entry.orderSwap;
    if (swap) {
      const armRow = (label: string, arm: readonly OrderArmSlice[], cell: (slice: OrderArmSlice) => string) => row(label, (s) => {
        const slice = arm.find((entryOfArm) => entryOfArm.language === s.language);
        return slice ? cell(slice) : "n/a";
      });
      lines.push(row("orders agree", (s) => {
        const agreement = swap.agreement.find((rate) => rate.language === s.language);
        return agreement ? ratio(agreement) : "n/a";
      }));
      lines.push(armRow("accuracy, options reversed", swap.swapped, (s) => ratio(s.accuracy)));
      lines.push(armRow("**accuracy, both orders averaged**", swap.averaged.slices, (s) => `${ratio(s.accuracy)}${s.accuracy.lowerBound !== null ? `, ≥${pct(s.accuracy.lowerBound)}` : ""}${s.singlePass > 0 ? `; ${s.singlePass} from one order only` : ""}`));
      if (swap.averaged.slices.some((slice) => slice.triage)) {
        lines.push(armRow("averaged / triage on the same cases", swap.averaged.slices, (s) => (s.triage ? `${ratio(s.triage.readoutOnBoth)} / ${ratio(s.triage.triageOnBoth)}` : "n/a")));
      }
      lines.push(armRow("averaged: ECE vs gold, T=1 → fitted (cal/test)", swap.averaged.slices, (s) => calibrationCell(s.calibration)));
      lines.push(armRow("averaged: top ≥ 0.85: coverage · accuracy", swap.averaged.slices, (s) => curveCell(s.confidenceCurve, 0.85)));
      lines.push(armRow("averaged: margin ≥ 0.15: coverage · accuracy", swap.averaged.slices, (s) => curveCell(s.marginCurve, 0.15)));
    }
    lines.push("");

    const all = entry.slices.find((slice) => slice.language === "all")!;
    lines.push("Recall per gold value (all): " + Object.entries(all.perGold).filter(([, rate]) => rate.n > 0).map(([key, rate]) => `${key} ${rate.hits}/${rate.n}`).join(", "), "");
    // Only the rows with gold and the columns the readout used, so 15 deliverables stay readable.
    const { keys, counts } = all.confusion;
    const rows = keys.map((_, i) => i).filter((i) => counts[i]!.some((count) => count > 0));
    const cols = keys.map((_, j) => j).filter((j) => counts.some((countsRow) => countsRow[j]! > 0));
    if (rows.length > 0) {
      lines.push("Confusion (all; rows gold, columns readout):", "");
      lines.push(`| gold \\ read | ${cols.map((j) => keys[j]).join(" | ")} |`, `|---|${cols.map(() => "---").join("|")}|`);
      for (const i of rows) lines.push(`| ${keys[i]} | ${cols.map((j) => (i === j ? `**${counts[i]![j]}**` : String(counts[i]![j]))).join(" | ")} |`);
      lines.push("");
    }
    lines.push("Coverage · accuracy by level (all):", "");
    lines.push(`| top ≥ | ${all.confidenceCurve.map((point) => point.level).join(" | ")} |`, `|---|${all.confidenceCurve.map(() => "---").join("|")}|`);
    lines.push(`| taken | ${all.confidenceCurve.map((point) => `${point.taken} · ${point.accuracy === null ? "n/a" : pct(point.accuracy)}`).join(" | ")} |`);
    lines.push("", `| margin ≥ | ${all.marginCurve.map((point) => point.level).join(" | ")} |`, `|---|${all.marginCurve.map(() => "---").join("|")}|`);
    lines.push(`| taken | ${all.marginCurve.map((point) => `${point.taken} · ${point.accuracy === null ? "n/a" : pct(point.accuracy)}`).join(" | ")} |`, "");
  }

  const fitted = Object.entries(report.suggestedTemperatures.fits);
  if (fitted.length > 0) {
    lines.push("## Temperatures fitted on every reading against gold, per detected language bucket", "");
    for (const [facet, byLanguage] of fitted) {
      for (const [language, fit] of Object.entries(byLanguage ?? {})) {
        lines.push(`- ${facet} / ${language}: T = ${fit.temperature.toFixed(3)} over ${fit.samples} readings, NLL ${num(fit.nllAtOne)} → ${num(fit.nll)}${fit.clamped ? " — CLAMPED at the range's end: left out below" : ""}`);
      }
    }
    lines.push("", "As askIntentReadout's `temperatures`:", "", "```json", JSON.stringify(report.suggestedTemperatures.intentTemperatures, null, 2), "```", "");
    lines.push("As a config snippet (keys `intent.<facet>` under decisions.readout.temperatures; nothing reads them yet):", "", "```jsonc",
      JSON.stringify({ decisions: { readout: { temperatures: report.suggestedTemperatures.config } } }, null, 2), "```", "");
  }

  lines.push("## Not measured", "");
  lines.push("- Real traffic: every case is synthetic and hand-labelled (eval/intent/README.md). The mix is enriched with the rare values; accuracy on live turns weighs the common ones more.");
  lines.push("- The readout beside a turn's other calls: here each call runs alone, one after another.");
  lines.push("- Hysteresis across turns: each case is one message, with at most the prior turn's digest.");
  lines.push("- The curves are at T = 1, the model's own distribution; a fitted temperature moves the levels, not the order within a facet.");
  lines.push("");
  if (report.warnings.length > 0) lines.push("## Warnings", "", ...report.warnings.map((warning) => `- ${warning}`), "");
  return lines.join("\n");
}

// ── Arguments ────────────────────────────────────────────────────────────────────────────────────

export class IntentBenchUsageError extends Error {}

export interface IntentBenchArgs {
  /** Case files, in order, scored as one corpus; default the deployment's own, else the example. */
  cases?: string[];
  withTriage: boolean;
  orderSwap: boolean;
  split: "all" | BenchSplit;
  limit?: number;
  topLogprobs: number;
  minMass: number;
  samplingTemperature: number;
  /** triage's wall-clock bound; default the turn's (agent/runtime.ts TRIAGE_TIMEOUT_MS). */
  triageTimeoutMs: number;
  /** Per readout call. */
  timeoutMs: number;
  out?: string;
}

/** agent/runtime.ts TRIAGE_TIMEOUT_MS, a local constant there: the bound a turn gives triage. */
export const TURN_TRIAGE_TIMEOUT_MS = 8_000;
export const DEFAULT_READOUT_TIMEOUT_MS = 60_000;

const VALUE_FLAGS = new Set(["cases", "split", "limit", "top-logprobs", "min-mass", "sampling-temperature", "triage-timeout-ms", "timeout-ms", "out"]);
const SWITCHES = new Set(["with-triage", "order-swap"]);

function numberIn(flag: string, raw: string, min: number, max: number, integer = false): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new IntentBenchUsageError(`--${flag} takes ${integer ? "a whole number" : "a number"} from ${min} to ${max} (got "${raw}")`);
  }
  return value;
}

/** The command line, checked; an unknown flag is an error, so a typo never runs the defaults. */
export function parseIntentBenchArgs(argv: readonly string[]): IntentBenchArgs {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  const caseFiles: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    // pnpm passes a separating "--" through to the script.
    if (token === "--") continue;
    if (!token.startsWith("--")) throw new IntentBenchUsageError(`unexpected argument "${token}"`);
    const name = token.slice(2);
    if (SWITCHES.has(name)) {
      switches.add(name);
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new IntentBenchUsageError(`unknown option ${token}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new IntentBenchUsageError(`${token} needs a value`);
    if (name === "cases") caseFiles.push(value);
    else values.set(name, value);
    index += 1;
  }
  const split = values.get("split") ?? "all";
  if (split !== "all" && split !== "calibration" && split !== "test") throw new IntentBenchUsageError(`--split takes all, calibration or test (got "${split}")`);
  if (new Set(caseFiles).size !== caseFiles.length) throw new IntentBenchUsageError("a --cases file is given twice");
  const args: IntentBenchArgs = {
    withTriage: switches.has("with-triage"),
    orderSwap: switches.has("order-swap"),
    split,
    topLogprobs: numberIn("top-logprobs", values.get("top-logprobs") ?? String(MAX_TOP_LOGPROBS), 2, MAX_TOP_LOGPROBS, true),
    minMass: numberIn("min-mass", values.get("min-mass") ?? String(DEFAULT_MIN_LETTER_MASS), 0, 1),
    samplingTemperature: numberIn("sampling-temperature", values.get("sampling-temperature") ?? "0", 0, 2),
    triageTimeoutMs: numberIn("triage-timeout-ms", values.get("triage-timeout-ms") ?? String(TURN_TRIAGE_TIMEOUT_MS), 1, 600_000, true),
    timeoutMs: numberIn("timeout-ms", values.get("timeout-ms") ?? String(DEFAULT_READOUT_TIMEOUT_MS), 1, 600_000, true),
  };
  if (caseFiles.length > 0) args.cases = caseFiles;
  const limit = values.get("limit");
  if (limit !== undefined) args.limit = numberIn("limit", limit, 1, 1_000_000, true);
  const out = values.get("out");
  if (out !== undefined) args.out = out;
  return args;
}

/**
 * The cases a run asks: the chosen half (by the id alone, benchSplit), then `limit` of them spread over
 * the file in an order hashed from their ids, kept in file order. The file is grouped by language and
 * kind, so its first 12 lines were 12 German greetings (offline smoke run, 2026-09-28): a limited run
 * must sample the file, not read its head. The same ids give the same sample every run.
 */
export function selectIntentCases(cases: readonly IntentBenchCase[], split: IntentBenchArgs["split"], limit?: number): IntentBenchCase[] {
  const chosen = cases.filter((benchCase) => split === "all" || benchSplit(benchCase.id) === split);
  if (limit === undefined || limit >= chosen.length) return chosen;
  const rank = (id: string) => createHash("sha256").update(`intent-bench-limit\u0000${id}`).digest("hex");
  const taken = new Set([...chosen].sort((a, b) => rank(a.id).localeCompare(rank(b.id))).slice(0, limit));
  return chosen.filter((benchCase) => taken.has(benchCase));
}

/** A digest of the case files as read, in order: a report names exactly which cases it measured. */
export function casesDigest(texts: readonly string[]): string {
  return createHash("sha256").update(texts.map((text) => createHash("sha256").update(text).digest("hex")).join("\n")).digest("hex");
}
