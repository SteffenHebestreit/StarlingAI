/**
 * decisions:readout — does the incumbent read by its logits answer as the incumbent does?
 *
 * The logit readout (decisions/logit-readout.ts) asks a decision point's question as one letter
 * and reads the model's probabilities over the option letters. Before any point runs it, even in
 * shadow, five things have to be known, per point and language, and this module computes them from
 * one run's results (scripts/decisions-readout.ts sends the calls):
 *
 *   (a) whether the server sends a top list at all: without one there is no readout, only misses;
 *   (b) how often the readout's answer is the parsed incumbent's — target 95%: it replaces that
 *       call, so it must first say what that call says;
 *   (c) what one readout costs against one parsed call, wall time per call;
 *   (d) how calibrated its probabilities are (ECE), before and after a temperature fitted on the
 *       calibration half and applied to the test half — never read off the cases that fitted it;
 *   (e) how often the answer flips when the option order is swapped: letter-position bias, which a
 *       one-token readout could have where a written verdict does not.
 *
 * The reference is the parsed incumbent for (b) and (d), since that is what the readout would
 * replace, and the gold label beside it where a hand-labelled case has one. Only the two points
 * whose case is the user's message alone have cases today (eval/decisions/*.example.jsonl and the
 * bootstrap ledger's synthetic messages); the others have no parsed incumbent this bench can run.
 */
import { createHash } from "node:crypto";

import { languageBucket, wilsonLowerBound, type LanguageBucket } from "../decisions/gate.js";
import type { LedgerRow } from "../decisions/ledger.js";
import {
  applyTemperature,
  expectedCalibrationError,
  fitTemperature,
  meanNll,
  type ReadoutResult,
  type TemperatureFit,
  type TemperatureSample,
} from "../decisions/logit-readout.js";
import {
  caseMessage,
  distribution,
  isBenchPoint,
  pointOptions,
  SLICE_LANGUAGES,
  type BenchPointId,
  type BenchSplit,
  type DecisionBenchCase,
  type Distribution,
  type Rate,
  type SliceLanguage,
} from "./decisions-bench.js";

/** The agreement with the parsed incumbent a point must reach before its readout may even shadow. */
export const DEFAULT_AGREEMENT_TARGET = 0.95;

/** Per point and language, as the plan's live check asks: 20 German and 20 English cases. */
export const DEFAULT_PER_LANGUAGE = 20;

function rateOf(hits: number, n: number): Rate {
  return { hits, n, rate: n > 0 ? hits / n : null };
}

// ── Cases ────────────────────────────────────────────────────────────────────────────────────────

export interface ReadoutBenchCase {
  id: string;
  point: BenchPointId;
  language: LanguageBucket;
  state: Record<string, unknown>;
  gold?: string;
  source: "fixture" | "bootstrap";
}

/** The hand-labelled cases of the points the bench can run. */
export function casesFromFixtures(cases: readonly DecisionBenchCase[]): ReadoutBenchCase[] {
  return cases.flatMap((benchCase) => (isBenchPoint(benchCase.point)
    ? [{
        id: benchCase.id,
        point: benchCase.point,
        language: languageBucket(benchCase.language),
        state: benchCase.state,
        ...(benchCase.gold !== undefined ? { gold: benchCase.gold } : {}),
        source: "fixture" as const,
      }]
    : []));
}

/**
 * The bootstrap ledger's synthetic messages (decisions:bootstrap), without their recorded label:
 * the parsed incumbent is asked again in this run, beside the readout, so both see the same server.
 * Their id is a hash of point and state, so a case keeps its id, and its split, across runs.
 */
export function casesFromBootstrap(rows: readonly LedgerRow[]): ReadoutBenchCase[] {
  return rows.flatMap((row) => {
    if (!isBenchPoint(row.point) || typeof row.state?.["message"] !== "string") return [];
    const digest = createHash("sha256").update(`${row.point}\u0000${JSON.stringify(row.state)}`).digest("hex").slice(0, 12);
    return [{ id: `boot-${row.point}-${digest}`, point: row.point, language: row.language, state: row.state, source: "bootstrap" as const }];
  });
}

/**
 * Per point and language, the first `perLanguage` cases (0: all), hand-labelled ones first; the
 * same message twice is one case. Languages other than German and English are left out: the
 * temperatures are fitted per language and the plan measures these two.
 */
export function selectCases(cases: readonly ReadoutBenchCase[], points: readonly string[], perLanguage: number): ReadoutBenchCase[] {
  const seen = new Set<string>();
  const taken = new Map<string, number>();
  const ordered = [...cases.filter((c) => c.source === "fixture"), ...cases.filter((c) => c.source !== "fixture")];
  const out: ReadoutBenchCase[] = [];
  for (const benchCase of ordered) {
    if (!points.includes(benchCase.point) || (benchCase.language !== "de" && benchCase.language !== "en")) continue;
    const key = `${benchCase.point}\u0000${caseMessage(benchCase)}`;
    if (seen.has(key)) continue;
    const slot = `${benchCase.point}|${benchCase.language}`;
    if (perLanguage > 0 && (taken.get(slot) ?? 0) >= perLanguage) continue;
    seen.add(key);
    taken.set(slot, (taken.get(slot) ?? 0) + 1);
    out.push(benchCase);
  }
  return out;
}

/** The options in reverse: for two options, A and B swapped. */
export function swappedOrder(point: string): string[] {
  return [...pointOptions(point)].reverse();
}

// ── Results ──────────────────────────────────────────────────────────────────────────────────────

export interface ReadoutArm {
  ms: number;
  /** The answer carried a top list. False for a call that failed as well: nothing arrived. */
  logprobs: boolean;
  choice?: string;
  top?: number;
  /** Per option key, before any temperature: what a temperature is fitted on. */
  logScores?: Record<string, number>;
  mass?: number;
  /** Why there was no answer. */
  miss?: string;
  topToken?: string;
  error?: string;
}

export function readoutArm(result: ReadoutResult): ReadoutArm {
  if (result.ok) {
    const { answer } = result;
    return { ms: answer.ms, logprobs: true, choice: answer.choice, top: answer.top, logScores: answer.logScores, mass: answer.mass, topToken: answer.topToken };
  }
  return {
    ms: result.ms,
    // A list arrived but held no usable answer: the list itself was there.
    logprobs: result.reason === "no_letter" || result.reason === "control_token" || result.reason === "low_mass",
    miss: result.reason,
    ...(result.topToken !== undefined ? { topToken: result.topToken } : {}),
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
}

export interface ReadoutBenchResult {
  caseId: string;
  point: BenchPointId;
  language: LanguageBucket;
  split: BenchSplit;
  source: ReadoutBenchCase["source"];
  gold?: string;
  /** The front desk would not have handed the message to its model: neither arm was asked. */
  gated?: boolean;
  parsed?: { choice?: string; ms: number; error?: string };
  readout?: ReadoutArm;
  /** The same question with the options in reverse order. */
  swapped?: ReadoutArm;
}

// ── Scores ───────────────────────────────────────────────────────────────────────────────────────

export interface CalibrationBlock {
  /** What "right" means: the parsed incumbent's answer, or the hand label. */
  reference: "parsed" | "gold";
  calibrationCases: number;
  testCases: number;
  /** Fitted on the calibration half. */
  fit: TemperatureFit;
  /** On the test half, at T = 1 and at the fitted T. */
  eceBefore: number | null;
  eceAfter: number | null;
  nllBefore: number | null;
  nllAfter: number | null;
}

export interface ReadoutSlice {
  point: BenchPointId;
  language: SliceLanguage;
  cases: number;
  gated: number;
  /** (a) Readout calls whose answer carried a top list. */
  logprobsArrived: Rate;
  /** Readout calls that gave an answer. */
  coverage: Rate;
  misses: Record<string, number>;
  failed: { parsed: number; readout: number };
  /** (b) The readout's answer is the parsed incumbent's, over the cases both answered. */
  agreement: Rate & { lowerBound: number | null };
  /** Per parsed answer: how often the readout said the same (a skewed mix can hide a missed rare answer). */
  agreementByParsed: Record<string, Rate>;
  goldAccuracy: { parsed: Rate; readout: Rate };
  /** (c) Wall time per call. */
  ms: { parsed: Distribution | null; readout: Distribution | null };
  /** (d) */
  calibration: { parsed: CalibrationBlock | null; gold: CalibrationBlock | null };
  /** (e) The answer changed when the options were given in reverse order. */
  flips: Rate;
}

function sliceOf(results: readonly ReadoutBenchResult[], language: SliceLanguage): ReadoutBenchResult[] {
  return language === "all" ? [...results] : results.filter((result) => result.language === language);
}

/** A case's temperature sample: the readout's log-scores in the point's option order, labelled by `reference`. */
function sampleOf(result: ReadoutBenchResult, label: string | undefined): TemperatureSample | null {
  const scores = result.readout?.logScores;
  if (!scores || label === undefined) return null;
  const keys = pointOptions(result.point);
  const index = keys.indexOf(label);
  if (index < 0 || keys.some((key) => !Number.isFinite(scores[key]))) return null;
  return { logScores: keys.map((key) => scores[key]!), label: index };
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
 * (d) A temperature fitted on the calibration half, and the calibration error on the test half
 * before and after it. Null when either half holds no usable case.
 */
export function calibrationBlock(results: readonly ReadoutBenchResult[], reference: "parsed" | "gold"): CalibrationBlock | null {
  const labelled = results.flatMap((result) => {
    const sample = sampleOf(result, reference === "parsed" ? result.parsed?.choice : result.gold);
    return sample ? [{ split: result.split, sample }] : [];
  });
  const calibration = labelled.filter((entry) => entry.split === "calibration").map((entry) => entry.sample);
  const test = labelled.filter((entry) => entry.split === "test").map((entry) => entry.sample);
  if (calibration.length === 0 || test.length === 0) return null;
  const fit = fitTemperature(calibration);
  return {
    reference,
    calibrationCases: calibration.length,
    testCases: test.length,
    fit,
    eceBefore: eceAt(test, 1),
    eceAfter: eceAt(test, fit.temperature),
    nllBefore: meanNll(test, 1),
    nllAfter: meanNll(test, 1 / fit.temperature),
  };
}

export function scoreReadoutSlice(results: readonly ReadoutBenchResult[], point: BenchPointId, language: SliceLanguage): ReadoutSlice {
  const mine = sliceOf(results.filter((result) => result.point === point), language);
  const asked = mine.filter((result) => !result.gated);
  const readouts = asked.flatMap((result) => (result.readout ? [result.readout] : []));
  const called = readouts.filter((arm) => arm.miss !== "error" && arm.miss !== "aborted");
  const both = asked.filter((result) => result.readout?.choice !== undefined && result.parsed?.choice !== undefined);
  const agree = both.filter((result) => result.readout!.choice === result.parsed!.choice).length;
  const misses: Record<string, number> = {};
  for (const arm of readouts) if (arm.miss) misses[arm.miss] = (misses[arm.miss] ?? 0) + 1;
  const agreementByParsed: Record<string, Rate> = {};
  for (const option of pointOptions(point)) {
    const given = both.filter((result) => result.parsed!.choice === option);
    agreementByParsed[option] = rateOf(given.filter((result) => result.readout!.choice === option).length, given.length);
  }
  const withGold = asked.filter((result) => result.gold !== undefined);
  const parsedGold = withGold.filter((result) => result.parsed?.choice !== undefined);
  const readoutGold = withGold.filter((result) => result.readout?.choice !== undefined);
  const swapped = asked.filter((result) => result.readout?.choice !== undefined && result.swapped?.choice !== undefined);
  return {
    point,
    language,
    cases: mine.length,
    gated: mine.length - asked.length,
    logprobsArrived: rateOf(called.filter((arm) => arm.logprobs).length, called.length),
    coverage: rateOf(readouts.filter((arm) => arm.choice !== undefined).length, readouts.length),
    misses,
    failed: {
      parsed: asked.filter((result) => result.parsed?.error !== undefined).length,
      readout: readouts.filter((arm) => arm.miss === "error").length,
    },
    agreement: { ...rateOf(agree, both.length), lowerBound: both.length > 0 ? wilsonLowerBound(agree, both.length) : null },
    agreementByParsed,
    goldAccuracy: {
      parsed: rateOf(parsedGold.filter((result) => result.parsed!.choice === result.gold).length, parsedGold.length),
      readout: rateOf(readoutGold.filter((result) => result.readout!.choice === result.gold).length, readoutGold.length),
    },
    ms: {
      parsed: distribution(asked.flatMap((result) => (result.parsed && result.parsed.error === undefined ? [result.parsed.ms] : []))),
      readout: distribution(called.map((arm) => arm.ms)),
    },
    calibration: { parsed: calibrationBlock(asked, "parsed"), gold: calibrationBlock(asked, "gold") },
    flips: rateOf(swapped.filter((result) => result.swapped!.choice !== result.readout!.choice).length, swapped.length),
  };
}

/**
 * The temperature to configure per point and language (decisions.readout.temperatures): fitted on
 * every case the parsed incumbent answered, since the held-out figures above already say whether
 * a fit helps. Absent where there was nothing to fit on.
 */
export function suggestedTemperatures(results: readonly ReadoutBenchResult[]): Record<string, Record<string, TemperatureFit>> {
  const out: Record<string, Record<string, TemperatureFit>> = {};
  for (const point of new Set(results.map((result) => result.point))) {
    for (const language of ["de", "en"] as const) {
      const samples = results
        .filter((result) => result.point === point && result.language === language && !result.gated)
        .flatMap((result) => {
          const sample = sampleOf(result, result.parsed?.choice);
          return sample ? [sample] : [];
        });
      if (samples.length === 0) continue;
      (out[point] ??= {})[language] = fitTemperature(samples);
    }
  }
  return out;
}

export type ReadoutPointVerdict = "meets_target" | "below_target" | "no_logprobs" | "inconclusive";

export function pointVerdict(all: ReadoutSlice, target: number): { verdict: ReadoutPointVerdict; reasons: string[] } {
  if (all.logprobsArrived.n > 0 && all.logprobsArrived.hits === 0) {
    return { verdict: "no_logprobs", reasons: [`no top list arrived in ${all.logprobsArrived.n} readout calls: the server does not send top_logprobs, so there is no readout`] };
  }
  if (all.agreement.n === 0 || all.agreement.rate === null) {
    return { verdict: "inconclusive", reasons: ["no case was answered by both the readout and the parsed incumbent"] };
  }
  const reasons = [`agreement ${pct(all.agreement.rate)} (${all.agreement.hits}/${all.agreement.n}, lower bound ${pct(all.agreement.lowerBound ?? 0)})`];
  if (all.coverage.rate !== null && all.coverage.rate < 1) reasons.push(`the readout answered ${all.coverage.hits} of ${all.coverage.n}`);
  return all.agreement.rate >= target
    ? { verdict: "meets_target", reasons }
    : { verdict: "below_target", reasons: [...reasons, `below the ${pct(target)} target`] };
}

export interface ReadoutBenchReport {
  kind: "decisions-readout";
  version: 1;
  target: number;
  points: Array<{
    point: BenchPointId;
    verdict: ReadoutPointVerdict;
    reasons: string[];
    slices: ReadoutSlice[];
  }>;
  suggestedTemperatures: Record<string, Record<string, TemperatureFit>>;
  exitCode: 0 | 1 | 2;
}

export function buildReadoutReport(results: readonly ReadoutBenchResult[], target = DEFAULT_AGREEMENT_TARGET): ReadoutBenchReport {
  const points = [...new Set(results.map((result) => result.point))].sort();
  const report = points.map((point) => {
    const slices = SLICE_LANGUAGES.map((language) => scoreReadoutSlice(results, point, language));
    const { verdict, reasons } = pointVerdict(slices.find((slice) => slice.language === "all")!, target);
    return { point, verdict, reasons, slices };
  });
  const verdicts = report.map((entry) => entry.verdict);
  const exitCode: 0 | 1 | 2 = verdicts.length === 0 || verdicts.every((verdict) => verdict === "inconclusive")
    ? 2
    : verdicts.some((verdict) => verdict === "below_target" || verdict === "no_logprobs") ? 1 : 0;
  return { kind: "decisions-readout", version: 1, target, points: report, suggestedTemperatures: suggestedTemperatures(results), exitCode };
}

// ── Markdown ─────────────────────────────────────────────────────────────────────────────────────

function pct(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

function ratio(rate: Rate): string {
  return rate.rate === null ? "n/a" : `${rate.hits}/${rate.n} (${pct(rate.rate)})`;
}

function ms(value: Distribution | null): string {
  return value ? `${Math.round(value.p50)} / ${Math.round(value.p90)} ms` : "n/a";
}

function num(value: number | null, digits = 3): string {
  return value === null || !Number.isFinite(value) ? "n/a" : value.toFixed(digits);
}

function calibrationCell(block: CalibrationBlock | null): string {
  if (!block) return "n/a";
  return `${num(block.eceBefore)} → ${num(block.eceAfter)} (T ${block.fit.temperature.toFixed(2)}${block.fit.clamped ? ", clamped" : ""}; ${block.calibrationCases}/${block.testCases})`;
}

export function renderReadoutMarkdown(report: ReadoutBenchReport, header: readonly string[] = []): string {
  const lines: string[] = ["# Incumbent logit readout", "", ...header, ""];
  lines.push(`Target: the readout's answer is the parsed incumbent's in at least ${pct(report.target)} of the cases both answered.`, "");
  for (const entry of report.points) {
    lines.push(`## ${entry.point}: ${entry.verdict.replace(/_/g, " ").toUpperCase()}`, "", entry.reasons.join("; "), "");
    const columns = entry.slices.map((slice) => slice.language);
    const row = (label: string, cell: (slice: ReadoutSlice) => string) => `| ${label} | ${entry.slices.map(cell).join(" | ")} |`;
    lines.push(`| | ${columns.join(" | ")} |`, `|---|${columns.map(() => "---").join("|")}|`);
    lines.push(row("cases (gated)", (s) => `${s.cases} (${s.gated})`));
    lines.push(row("(a) top list arrived", (s) => ratio(s.logprobsArrived)));
    lines.push(row("readout answered", (s) => ratio(s.coverage)));
    lines.push(row("readout misses", (s) => Object.entries(s.misses).map(([reason, count]) => `${reason} ${count}`).join(", ") || "none"));
    lines.push(row("**(b) agrees with parsed**", (s) => `${ratio(s.agreement)}${s.agreement.lowerBound !== null ? `, ≥${pct(s.agreement.lowerBound)}` : ""}`));
    for (const option of Object.keys(entry.slices[0]?.agreementByParsed ?? {})) {
      lines.push(row(`… when parsed said ${option}`, (s) => ratio(s.agreementByParsed[option]!)));
    }
    lines.push(row("gold accuracy parsed / readout", (s) => `${ratio(s.goldAccuracy.parsed)} / ${ratio(s.goldAccuracy.readout)}`));
    lines.push(row("(c) ms p50 / p90 parsed", (s) => ms(s.ms.parsed)));
    lines.push(row("(c) ms p50 / p90 readout", (s) => ms(s.ms.readout)));
    lines.push(row("(d) ECE vs parsed, T=1 → fitted (cal/test)", (s) => calibrationCell(s.calibration.parsed)));
    lines.push(row("(d) ECE vs gold, T=1 → fitted (cal/test)", (s) => calibrationCell(s.calibration.gold)));
    lines.push(row("(e) flips when the order is swapped", (s) => ratio(s.flips)));
    lines.push("");
  }
  const suggested = Object.entries(report.suggestedTemperatures);
  if (suggested.length > 0) {
    lines.push("## Temperatures fitted on every case (decisions.readout.temperatures)", "");
    const config: Record<string, Record<string, number>> = {};
    for (const [point, byLanguage] of suggested) {
      for (const [language, fit] of Object.entries(byLanguage)) {
        lines.push(`- ${point} / ${language}: T = ${fit.temperature.toFixed(3)} over ${fit.samples} cases, NLL ${num(fit.nllAtOne)} → ${num(fit.nll)}${fit.clamped ? " — CLAMPED at the range's end: the fit found no T that explains the answers" : ""}`);
        if (!fit.clamped) (config[point] ??= {})[language] = Math.round(fit.temperature * 1000) / 1000;
      }
    }
    lines.push("", "```jsonc", JSON.stringify({ decisions: { readout: { temperatures: config } } }, null, 2), "```", "");
  }
  lines.push("## Not measured", "");
  lines.push("- The points without a message-only case (ungrounded_draft, slices_disagree, goal_met, finding_relevant, run_drifting): there are no labelled cases for them yet, so their parsed incumbents are not run here. Their readout agreement comes from `shadow` on real turns (.starlingai/decisions/readout-ledger.jsonl).");
  lines.push("- A readout's cost inside a turn, beside the turn's other calls: here each call runs alone.");
  lines.push("");
  return lines.join("\n");
}
