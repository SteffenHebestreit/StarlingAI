/**
 * Pre-router bench — could a fast categorisation at message arrival replace the orchestrator's
 * routing round?
 *
 * On real turns (2026-09-22..25) the orchestrator's first call only routed in 17 of 19: a
 * search_agents, one delegation or a one-step plan, at 4.9-12.4 s a turn. A classifier that
 * answers in milliseconds could take that round away IF it names the right specialist often
 * enough, and knows when it does, that its pick can be taken without the orchestrator. This module
 * builds the question Laya is asked and scores the answers; scripts/pre-router-bench.ts runs it
 * against the live embedding capsule and the Laya sidecar.
 *
 * The question offers the embedding ranking's top K agents (production capsule first) plus "none":
 * no single listed specialist fits, so the orchestrator keeps the turn. "none" is never an error
 * and never a skip — the turn simply costs what it costs today.
 *
 * What is reported, and why each number is there:
 *  - capsule and option recall: whether a right agent was offered at all. Laya chooses among the
 *    options; it cannot find a missing one, so these cap everything below them.
 *  - Laya's top-1 beside two baselines that cost nothing: the embedding's own first choice and the
 *    corpus' most common label. A "same agent as last turn" baseline measured best on real
 *    follow-ups (11 of 12), but it needs a session, and these cases are single messages.
 *  - per-label accuracy and pick concentration: a classifier that answers one label for everything
 *    can look accurate on a skewed corpus, and the adaptive gate measures precision, not recall.
 *  - a gate simulation that mirrors decisions/gate.ts: the confidence level at which a pick may be
 *    taken is set on one half of the cases and applied to the other half (and back), so the share
 *    of turns whose routing round could be skipped, and the error rate among them, are never read
 *    off the cases that chose the threshold. The same simulation runs for a plain threshold on the
 *    embedding score, which is what Laya has to beat to be worth a sidecar.
 *
 * `--backend readout` asks the same question of the resident model instead, read by its logits
 * (decisions/logit-readout.ts: the options under the same letters, one token, thinking off). Laya
 * measured 30% on routing (JevBench) and weak German; the readout is the model the orchestrator
 * routes with. Its answer takes Laya's place in every figure, and because it has log-scores per
 * option, the report adds what a pre-router's stage 1 waits for (plan C8): top-1 at 85% or more,
 * the lower bound of "none" recall at 0.95 or more — a wrong specialist costs a failed delegation
 * and a retry, minutes — and the calibration error before and after a temperature fitted on the
 * other fold.
 */

import { createHash } from "node:crypto";

import { GATE_LEVELS, languageBucket, wilsonLowerBound, type LanguageBucket } from "../decisions/gate.js";
import { applyTemperature, expectedCalibrationError, fitTemperature, type ReadoutResult, type TemperatureSample } from "../decisions/logit-readout.js";
import {
  DEFAULT_CANDIDATES,
  LAYA_WINDOW_TOKENS,
  MAX_CANDIDATES,
  MAX_LAYA_OPTIONS,
  NONE_KEY,
  PRE_ROUTE_POINT,
  type BuiltPreRouteQuestion,
  type DescriptionSource,
} from "../decisions/pre-route-question.js";
import type { TrainingItem } from "../scripts/decisions-export.js";
import type { RoutingEvalCase } from "./routing-eval.js";

// ── The question ─────────────────────────────────────────────────────────────────────────────────

// The question lives in decisions/pre-route-question.ts, where the production readout asks it
// too; every name stays exported from here, so the bench, its script and its tests are unchanged.
export {
  agentDescriptionText,
  buildPreRouteQuestion,
  DEFAULT_CANDIDATES,
  estimateTokens,
  LAYA_WINDOW_TOKENS,
  MAX_CANDIDATES,
  MAX_LAYA_OPTIONS,
  mergeCandidates,
  NONE_DESCRIPTION,
  NONE_KEY,
  OPTION_TOKEN_LIMIT,
  PRE_ROUTE_POINT,
  PRE_ROUTE_QUESTION,
  shortenToTokens,
  type BuiltPreRouteQuestion,
  type DescribableAgent,
  type DescriptionSource,
  type PreRouteQuestion,
} from "../decisions/pre-route-question.js";

/**
 * `prefetchCapabilityCandidates`'s `maxAgents` default, which its only production caller does not
 * override (routing-eval-cli.ts names the same number for the same reason).
 */
export const CAPSULE_MAX_AGENTS = 4;

/**
 * turn-system-prompt.ts: the prompt build waits this long for the discovery prefetch and then
 * drops the capsule. A local constant there, so it is named here rather than imported.
 */
export const DISCOVERY_PREFETCH_BUDGET_MS = 2_500;

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * The options as Laya reads them: under neutral letters, in the order sent. This is
 * generic.to_laya's `{LETTERS[i]: options[key] for i, key in enumerate(keys)}`, and Python keeps a
 * JSON object's key order, so letter i is the i-th key of the object as serialised here.
 */
export function servedCriteria(options: Readonly<Record<string, string>>): { keys: string[]; criteria: Record<string, string> } {
  const keys = Object.keys(options);
  return { keys, criteria: Object.fromEntries(keys.map((key, i) => [LETTERS[i]!, options[key]!])) };
}

// ── The cases ────────────────────────────────────────────────────────────────────────────────────

/** What a right pick is: one of these agents, or leaving the turn to the orchestrator. */
export type PreRouteGold = { kind: "agents"; acceptable: string[] } | { kind: "none" };

/**
 * The gold a routing-eval case carries for a pre-router, or why it has none.
 *
 * A case with an acceptable set, a target or a top wants one of those agents. A case that expects
 * NOTHING admitted (`admitted: false`, no agent named) is a message no specialist fits — the
 * orchestrator's turn, so "none" is right. A directive names its own agent and is routed by the
 * user's words, never by a pre-router.
 */
export function preRouteGold(evalCase: RoutingEvalCase): { gold: PreRouteGold } | { skip: string } {
  const directive = evalCase.flags?.directiveAgent;
  if (directive) return { skip: `the user named ${directive}: a directive is routed by the user's own words` };
  const named = [...(evalCase.expect.acceptable ?? []), evalCase.expect.target, evalCase.expect.top];
  const acceptable = [...new Set(named.filter((name): name is string => typeof name === "string" && name.length > 0))];
  if (acceptable.length > 0) return { gold: { kind: "agents", acceptable } };
  if (evalCase.expect.admitted === false) return { gold: { kind: "none" } };
  return { skip: "names no agent and does not expect admitted:false, so no pick can be scored" };
}

export type Split = "calibration" | "test";
export type SplitSelection = Split | "all";

function hash32(text: string): number {
  return createHash("sha256").update(text, "utf8").digest().readUInt32BE(0);
}

/**
 * The half a case belongs to, from its id alone: adding or reordering cases never moves another
 * one between halves, so a checkpoint fine-tuned on the calibration half is always tested on cases
 * it has not seen.
 */
export function splitOf(id: string): Split {
  return (hash32(id) & 1) === 0 ? "calibration" : "test";
}

/** The cross-fitting fold, from a different bit of the same hash than the split. */
export function foldOf(id: string): 0 | 1 {
  return ((hash32(id) >>> 1) & 1) === 0 ? 0 : 1;
}

export function inSplit(id: string, selection: SplitSelection): boolean {
  return selection === "all" || splitOf(id) === selection;
}

// ── Laya's answer ────────────────────────────────────────────────────────────────────────────────

export interface LayaPick {
  choice: string;
  top: number;
  probabilities: Record<string, number>;
}

/**
 * One answer from /v1/decide, checked against the options it was asked: a choice among them, a
 * finite probability for every one, and the choice their argmax. Anything else is a broken
 * contract, not an answer — the same rule decisions/laya-client.ts applies in production.
 */
export function parseLayaAnswer(raw: unknown, keys: readonly string[]): LayaPick | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const choice = record["choice"];
  const probabilitiesRaw = record["probabilities"];
  if (typeof choice !== "string" || !keys.includes(choice)) return null;
  if (!probabilitiesRaw || typeof probabilitiesRaw !== "object") return null;
  const probabilities: Record<string, number> = {};
  for (const key of keys) {
    const value = (probabilitiesRaw as Record<string, unknown>)[key];
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    probabilities[key] = value;
  }
  const top = probabilities[choice]!;
  if (Object.values(probabilities).some((p) => p > top + 1e-9)) return null;
  return { choice, top, probabilities };
}

// ── Training data ────────────────────────────────────────────────────────────────────────────────

/**
 * The option a fine-tune should learn for this question: the first right agent in the order
 * offered, or "none" when the gold is none — or when no right agent was offered at all, because
 * then dispatching any listed one is wrong and handing the turn back is the right move.
 */
export function trainingLabelKey(gold: PreRouteGold, keys: readonly string[]): string {
  if (gold.kind === "none") return NONE_KEY;
  return keys.find((key) => key !== NONE_KEY && gold.acceptable.includes(key)) ?? NONE_KEY;
}

/** One case as a typed-decisions training item, in the format scripts/decisions-export.ts writes. */
export function buildPreRouteTrainingItem(built: BuiltPreRouteQuestion, gold: PreRouteGold, language: LanguageBucket): TrainingItem {
  const { keys, criteria } = servedCriteria(built.request.options);
  const label = LETTERS[keys.indexOf(trainingLabelKey(gold, keys))]!;
  return {
    point: PRE_ROUTE_POINT,
    language,
    state: JSON.stringify(built.request.state),
    questions: { [PRE_ROUTE_POINT]: { type: "choice", instructions: built.request.question, criteria } },
    gold: {
      [PRE_ROUTE_POINT]: {
        label,
        probabilities: Object.fromEntries(Object.keys(criteria).map((letter) => [letter, letter === label ? 1 : 0])),
      },
    },
  };
}

// ── Scoring ──────────────────────────────────────────────────────────────────────────────────────

/** One case after the capsule was built and (maybe) Laya was asked. */
export interface PreRouteObservation {
  id: string;
  language: LanguageBucket;
  split: Split;
  fold: 0 | 1;
  gold: PreRouteGold;
  /** What the production capsule holds: at most four floor-admitted agents, meta-factory removed. */
  capsule: string[];
  /** The whole candidate order, capsule first: the basis of recall at every K. */
  order: string[];
  /** The agents offered to Laya, in the order served ("none" follows them). */
  options: string[];
  /** Each option's embedding score, normalised as routing normalises it; null when unknown. */
  optionScores: Array<number | null>;
  /** How long the production capsule took to resolve for this message. */
  capsuleMs?: number;
  /**
   * The answerer's pick: Laya's, or with `--backend readout` the resident model's read by its
   * logits — then with `logScores`, per option in the order served ("none" last), before any
   * temperature: what the calibration is fitted on.
   */
  laya?: { choice: string; top: number; ms: number; serverMs?: number; model: string; logScores?: number[] };
  layaError?: string;
}

// ── The readout backend ──────────────────────────────────────────────────────────────────────────

/** Who answers the question: the Laya sidecar, or the resident model read by its logits. */
export type PreRouteBackend = "laya" | "readout";

/** The name the report gives the answerer. */
export function answererName(backend: PreRouteBackend | undefined): string {
  return backend === "readout" ? "Readout" : "Laya";
}

/**
 * A readout's answer as an observation's pick, over the question's own keys: the same shape Laya's
 * answer has, plus the log-scores. A miss is an error, as a failed Laya answer is — the turn would
 * go to the orchestrator.
 */
export function pickFromReadout(result: ReadoutResult, keys: readonly string[], model: string): NonNullable<PreRouteObservation["laya"]> | { error: string } {
  if (!result.ok) return { error: `readout: ${result.reason}${result.topToken !== undefined ? ` (top token ${JSON.stringify(result.topToken)})` : ""}${result.error ? `: ${result.error}` : ""}` };
  const { answer } = result;
  if (!keys.includes(answer.choice) || keys.some((key) => !Number.isFinite(answer.logScores[key]))) {
    return { error: "readout: the answer does not fit the options" };
  }
  return { choice: answer.choice, top: answer.top, ms: answer.ms, model, logScores: keys.map((key) => answer.logScores[key]!) };
}

/**
 * A failed answer that says the answerer is down or broken — every failed Laya answer, a readout
 * that got no top list, failed or ran out of time — as opposed to a readout that read no answer
 * off the list it got (no option letter on it, a control token on top, too little mass on the
 * letters). The second is a measured miss: it proves the model answers, so it neither trips the
 * run's breaker nor stops the run at its warm-up, however many come in a row.
 */
export function isAnswererOutage(error: string): boolean {
  return !/^readout: (no_letter|control_token|low_mass)\b/.test(error);
}

export interface PreRouteCalibrationSlice {
  /** Answered cases with log-scores. */
  cases: number;
  /** Top-1 confidence against whether the pick was right, at T = 1 and at each fold's fitted T. */
  eceBefore: number | null;
  eceAfter: number | null;
  /** Per fold: the temperature fitted on the OTHER fold's cases. */
  folds: Array<{ fold: 0 | 1; temperature: number; clamped: boolean; fittedOn: number }>;
}

/** The option a case's temperature sample is labelled with: the one a fine-tune would learn. */
function calibrationSample(o: PreRouteObservation): TemperatureSample | null {
  const scores = o.laya?.logScores;
  const keys = [...o.options, NONE_KEY];
  if (!scores || scores.length !== keys.length) return null;
  return { logScores: scores, label: keys.indexOf(trainingLabelKey(o.gold, keys)) };
}

function topOf(scores: readonly number[], temperature: number): { index: number; p: number } {
  const p = applyTemperature(scores, temperature);
  let index = 0;
  for (let i = 1; i < p.length; i += 1) if (p[i]! > p[index]!) index = i;
  return { index, p: p[index]! };
}

/**
 * The readout's calibration, cross-fitted like the gate: each fold's cases are scored at the
 * temperature fitted on the other fold, so the "after" figure is never read off the cases that set
 * it. Right means right by the gold (any acceptable agent, or none), as everywhere in this report.
 */
export function preRouteCalibration(observations: readonly PreRouteObservation[]): PreRouteCalibrationSlice | null {
  const usable = observations.flatMap((o) => {
    const sample = calibrationSample(o);
    return sample ? [{ o, sample, keys: [...o.options, NONE_KEY] }] : [];
  });
  if (usable.length === 0) return null;
  const before: Array<{ confidence: number; correct: boolean }> = [];
  const after: Array<{ confidence: number; correct: boolean }> = [];
  const folds: PreRouteCalibrationSlice["folds"] = [];
  for (const fold of [0, 1] as const) {
    const fitOn = usable.filter((entry) => entry.o.fold !== fold).map((entry) => entry.sample);
    const fit = fitTemperature(fitOn);
    folds.push({ fold, temperature: fit.temperature, clamped: fit.clamped, fittedOn: fit.samples });
    for (const entry of usable.filter((candidate) => candidate.o.fold === fold)) {
      const raw = topOf(entry.sample.logScores, 1);
      const scaled = topOf(entry.sample.logScores, fit.temperature);
      before.push({ confidence: raw.p, correct: isHit(entry.keys[raw.index], entry.o.gold) });
      after.push({ confidence: scaled.p, correct: isHit(entry.keys[scaled.index], entry.o.gold) });
    }
  }
  return { cases: usable.length, eceBefore: expectedCalibrationError(before), eceAfter: expectedCalibrationError(after), folds };
}

/**
 * What stage 1 (a tail hint, flag-gated) waits for: top-1 at 85% on the gold-agent cases and the
 * "none" recall's lower bound at 0.95.
 *
 * Two class-wise criteria, never one pooled top-1: a pooled rate moves with the corpus's share of
 * gold-none cases, which is whatever the case files hold. With the 138 live cases and the 79 of
 * none-cases.example.jsonl, an answerer right on 78% of the specialist cases and on every "none"
 * pooled to 86% and met a pooled 85% — the none cases, easy by design, carried it over.
 */
export const STAGE_ONE_MIN_TOP1 = 0.85;
export const STAGE_ONE_MIN_NONE_RECALL_LOWER_BOUND = 0.95;

export interface StageCriteria {
  /** Top-1 on the answered gold-agent cases. */
  top1: number | null;
  noneRecallLowerBound: number | null;
  met: boolean;
  reasons: string[];
}

export function stageOneCriteria(score: PreRouteScore): StageCriteria {
  const { top1Agents, noneRecall } = score.laya;
  const top1Rate = top1Agents.of > 0 ? top1Agents.hit / top1Agents.of : null;
  const noneLower = noneRecall.of > 0 ? wilsonLowerBound(noneRecall.hit, noneRecall.of) : null;
  const reasons: string[] = [];
  if (top1Rate === null) reasons.push("no gold-agent case was answered");
  else if (top1Rate < STAGE_ONE_MIN_TOP1) reasons.push(`top-1 on the gold-agent cases ${pct(top1Rate)} is below ${pct(STAGE_ONE_MIN_TOP1)}`);
  if (noneLower === null) reasons.push("no gold-none case was answered, so the protection of \"none\" is unmeasured");
  else if (noneLower < STAGE_ONE_MIN_NONE_RECALL_LOWER_BOUND) reasons.push(`the lower bound of "none" recall is ${noneLower.toFixed(3)}, below ${STAGE_ONE_MIN_NONE_RECALL_LOWER_BOUND}`);
  return { top1: top1Rate, noneRecallLowerBound: noneLower, met: reasons.length === 0, reasons };
}

export function isHit(pick: string | undefined, gold: PreRouteGold): boolean {
  if (pick === undefined) return false;
  return gold.kind === "none" ? pick === NONE_KEY : gold.acceptable.includes(pick);
}

/** Was a right answer among the options? "none" is always offered, so a gold none always is. */
export function reachable(observation: PreRouteObservation): boolean {
  const { gold } = observation;
  return gold.kind === "none" || observation.options.some((name) => gold.acceptable.includes(name));
}

export interface Rate {
  hit: number;
  of: number;
}

function rate(pairs: Iterable<boolean>): Rate {
  let hit = 0;
  let of = 0;
  for (const ok of pairs) {
    of += 1;
    if (ok) hit += 1;
  }
  return { hit, of };
}

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

function labelsOf(gold: PreRouteGold): string[] {
  return gold.kind === "none" ? [NONE_KEY] : gold.acceptable;
}

function mostCommon(values: Iterable<string>): { label: string; count: number } | null {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: { label: string; count: number } | null = null;
  for (const [label, count] of counts) {
    if (!best || count > best.count || (count === best.count && label < best.label)) best = { label, count };
  }
  return best;
}

/**
 * Two-sided exact McNemar test on the discordant pairs: how likely a split at least this uneven is
 * if neither predictor is better. Summed in log space so a large corpus cannot underflow it.
 */
export function mcnemarExactP(onlyA: number, onlyB: number): number {
  const n = onlyA + onlyB;
  if (n === 0) return 1;
  const k = Math.min(onlyA, onlyB);
  const logTerms: number[] = [];
  let logTerm = n * Math.log(0.5);
  logTerms.push(logTerm);
  for (let i = 1; i <= k; i += 1) {
    logTerm += Math.log(n - i + 1) - Math.log(i);
    logTerms.push(logTerm);
  }
  const max = Math.max(...logTerms);
  const tail = Math.exp(max) * logTerms.reduce((sum, value) => sum + Math.exp(value - max), 0);
  return Math.min(1, 2 * tail);
}

export interface PreRouteScore {
  cases: number;
  goldAgents: number;
  goldNone: number;
  /** Gold-agent cases whose production capsule held a right agent. */
  capsuleRecall: Rate;
  /** Gold-agent cases whose options held a right agent: the ceiling of anything Laya can do. */
  optionRecall: Rate;
  /** The capsule's first agent, or "none" for an empty capsule. */
  capsuleTop1: Rate;
  /** The first option: what an embedding-only pre-router would dispatch. */
  embeddingTop1: Rate;
  /** Always the population's most common label. */
  majority: Rate & { label: string | null };
  /** The most common label's share of the cases: how skewed the gold is. */
  goldTopShare: { label: string; share: number } | null;
  laya: {
    asked: number;
    answered: number;
    failed: number;
    /** Every answered case, gold none included: moves with the corpus's share of gold none. */
    top1: Rate;
    /** Answered gold-agent cases: whether a right specialist was picked (stage 1's top-1). */
    top1Agents: Rate;
    /** Answered gold-agent cases where a right agent was among the options. */
    givenOptions: Rate;
    /** Answered gold-agent cases with no right agent offered: did Laya hand the turn back? */
    abstainWhenUnreachable: Rate;
    /** Answered gold-none cases: did Laya leave them to the orchestrator? */
    noneRecall: Rate;
    pickedNone: number;
    /** Discordant pairs against the embedding's first choice, on the cases Laya answered. */
    versusEmbedding: { layaOnly: number; embeddingOnly: number; pExact: number };
    topPick: { label: string; share: number } | null;
    msP50: number | null;
    msP90: number | null;
    serverMsP50: number | null;
    models: string[];
  };
  capsuleMs: { p50: number | null; p90: number | null; overBudget: number; of: number };
  /** Per label: the cases it is right for, and how many each predictor got right. */
  perLabel: Array<{ label: string; support: number; laya: Rate; embedding: Rate }>;
}

export function scorePreRoute(observations: readonly PreRouteObservation[]): PreRouteScore {
  const goldAgents = observations.filter((o) => o.gold.kind === "agents");
  const answered = observations.filter((o) => o.laya);
  const majorityLabel = mostCommon(observations.flatMap((o) => labelsOf(o.gold)));
  const perLabel = new Map<string, { support: number; laya: Rate; embedding: Rate }>();
  for (const o of observations) {
    for (const label of labelsOf(o.gold)) {
      const row = perLabel.get(label) ?? { support: 0, laya: { hit: 0, of: 0 }, embedding: { hit: 0, of: 0 } };
      row.support += 1;
      row.embedding.of += 1;
      if (isHit(o.options[0], o.gold)) row.embedding.hit += 1;
      if (o.laya) {
        row.laya.of += 1;
        if (isHit(o.laya.choice, o.gold)) row.laya.hit += 1;
      }
      perLabel.set(label, row);
    }
  }
  let layaOnly = 0;
  let embeddingOnly = 0;
  for (const o of answered) {
    const layaRight = isHit(o.laya!.choice, o.gold);
    const embeddingRight = isHit(o.options[0], o.gold);
    if (layaRight && !embeddingRight) layaOnly += 1;
    if (embeddingRight && !layaRight) embeddingOnly += 1;
  }
  const topPick = mostCommon(answered.map((o) => o.laya!.choice));
  const capsuleTimes = observations.flatMap((o) => (o.capsuleMs === undefined ? [] : [o.capsuleMs]));
  return {
    cases: observations.length,
    goldAgents: goldAgents.length,
    goldNone: observations.length - goldAgents.length,
    capsuleRecall: rate(goldAgents.map((o) => o.capsule.some((name) => labelsOf(o.gold).includes(name)))),
    optionRecall: rate(goldAgents.map((o) => reachable(o))),
    capsuleTop1: rate(observations.map((o) => isHit(o.capsule[0] ?? NONE_KEY, o.gold))),
    embeddingTop1: rate(observations.map((o) => isHit(o.options[0], o.gold))),
    majority: {
      ...rate(observations.map((o) => majorityLabel !== null && isHit(majorityLabel.label, o.gold))),
      label: majorityLabel?.label ?? null,
    },
    goldTopShare: majorityLabel && observations.length > 0
      ? { label: majorityLabel.label, share: majorityLabel.count / observations.length }
      : null,
    laya: {
      asked: observations.filter((o) => o.laya || o.layaError).length,
      answered: answered.length,
      failed: observations.filter((o) => !o.laya && o.layaError).length,
      top1: rate(answered.map((o) => isHit(o.laya!.choice, o.gold))),
      top1Agents: rate(answered.filter((o) => o.gold.kind === "agents").map((o) => isHit(o.laya!.choice, o.gold))),
      givenOptions: rate(answered.filter((o) => o.gold.kind === "agents" && reachable(o)).map((o) => isHit(o.laya!.choice, o.gold))),
      abstainWhenUnreachable: rate(answered.filter((o) => !reachable(o)).map((o) => o.laya!.choice === NONE_KEY)),
      noneRecall: rate(answered.filter((o) => o.gold.kind === "none").map((o) => o.laya!.choice === NONE_KEY)),
      pickedNone: answered.filter((o) => o.laya!.choice === NONE_KEY).length,
      versusEmbedding: { layaOnly, embeddingOnly, pExact: mcnemarExactP(layaOnly, embeddingOnly) },
      topPick: topPick ? { label: topPick.label, share: topPick.count / answered.length } : null,
      msP50: percentile(answered.map((o) => o.laya!.ms), 0.5),
      msP90: percentile(answered.map((o) => o.laya!.ms), 0.9),
      serverMsP50: percentile(answered.flatMap((o) => (o.laya!.serverMs === undefined ? [] : [o.laya!.serverMs])), 0.5),
      models: [...new Set(answered.map((o) => o.laya!.model))].sort(),
    },
    capsuleMs: {
      p50: percentile(capsuleTimes, 0.5),
      p90: percentile(capsuleTimes, 0.9),
      overBudget: capsuleTimes.filter((ms) => ms > DISCOVERY_PREFETCH_BUDGET_MS).length,
      of: capsuleTimes.length,
    },
    perLabel: [...perLabel.entries()]
      .map(([label, row]) => ({ label, ...row }))
      .sort((a, b) => b.support - a.support || a.label.localeCompare(b.label)),
  };
}

/** Recall of the candidate order at every K up to `maxK`, over the gold-agent cases. */
export function recallAtK(observations: readonly PreRouteObservation[], maxK: number): Array<{ k: number } & Rate> {
  const ranks = observations
    .filter((o) => o.gold.kind === "agents")
    .map((o) => o.order.findIndex((name) => labelsOf(o.gold).includes(name)));
  const rows: Array<{ k: number } & Rate> = [];
  for (let k = 1; k <= maxK; k += 1) {
    rows.push({ k, hit: ranks.filter((rank) => rank >= 0 && rank < k).length, of: ranks.length });
  }
  return rows;
}

// ── The gate ─────────────────────────────────────────────────────────────────────────────────────

export interface BenchGateSettings {
  targetAgreement: number;
  minSamples: number;
}

/** "language" pools every answer of a language; "answer" keys each answer apart, as production does. */
export type GateKeying = "language" | "answer";

export interface GatePolicy {
  name: string;
  pick: (observation: PreRouteObservation) => string | undefined;
  confidence: (observation: PreRouteObservation) => number | undefined;
  /** Candidate thresholds, lowest first, or every confidence seen in the calibration cases. */
  levels: readonly number[] | "observed";
}

export const LAYA_POLICY: GatePolicy = {
  name: "laya",
  pick: (o) => o.laya?.choice,
  confidence: (o) => o.laya?.top,
  levels: GATE_LEVELS,
};

/**
 * The embedding's first choice, taken when its score clears a threshold set the same way: the
 * pre-router that needs no sidecar at all, since the prefetch already computes it.
 */
export const EMBEDDING_POLICY: GatePolicy = {
  name: "embedding top-1 score",
  pick: (o) => o.options[0],
  confidence: (o) => o.optionScores[0] ?? undefined,
  levels: "observed",
};

/**
 * The lowest level whose cases at or above it number at least `minSamples` with a Wilson lower
 * bound at `targetAgreement`, over given samples instead of the process-wide ones. This is the
 * decision gate's rule as it was until 2026-09-26: decisions/gate.ts levelFromCases now also tests
 * the levels as one fixed sequence from the top, skips a higher level until it holds
 * levelSampleFloor cases, and asks for confirmation without the newest CONFIRM_SAMPLES. No runtime
 * pre-router exists yet, so this bench keeps the simpler rule; one built on this gate would open
 * no sooner, and at no lower level, than these figures say.
 */
export function qualifyLevel(
  samples: ReadonlyArray<{ confidence: number; agree: boolean }>,
  levels: readonly number[],
  settings: BenchGateSettings,
): number | null {
  for (const level of levels) {
    let n = 0;
    let agree = 0;
    for (const sample of samples) {
      if (sample.confidence < level) continue;
      n += 1;
      if (sample.agree) agree += 1;
    }
    // Fewer cases at every higher level: once too few remain, no higher level can qualify.
    if (n < settings.minSamples) break;
    if (wilsonLowerBound(agree, n) >= settings.targetAgreement) return level;
  }
  return null;
}

export interface GateSimulation {
  policy: string;
  keying: GateKeying;
  settings: BenchGateSettings;
  /** Cases the policy answered, all of which were evaluated once, by the other fold's threshold. */
  evaluated: number;
  /** Picks taken: the turns whose routing round would have been skipped. */
  taken: number;
  correct: number;
  errors: number;
  /** Taken picks on a gold-none case: a specialist dispatched where the orchestrator should answer. */
  takenGoldNone: number;
  /** Taken picks where no right agent was offered at all. */
  takenUnreachable: number;
  coverage: number;
  errorRate: number | null;
  /** The upper end of the error rate's 95% Wilson interval. */
  errorRateUpper: number | null;
  /**
   * The most samples any one bucket could have held where a level was set, had every pick been
   * right: the gold decides it, not the answers. Below the flawless count the target needs, no
   * answerer, however good, could have qualified, so a coverage of 0 says nothing about it.
   */
  capacity: number;
  byLanguage: Record<string, { evaluated: number; taken: number; correct: number }>;
  folds: Array<{ fold: 0 | 1; calibrationCases: number; qualified: Record<string, number> }>;
}

/**
 * The gate, cross-fitted: each fold's thresholds come from the other fold's cases only, then both
 * folds' outcomes are summed. A "none" pick is never taken and never counts against the policy —
 * the turn goes to the orchestrator as it does today. Agreement is agreement with the LABEL, where
 * production's gate counts agreement with the incumbent (the orchestrator's own routing).
 */
export function simulateGate(
  observations: readonly PreRouteObservation[],
  policy: GatePolicy,
  settings: BenchGateSettings,
  keying: GateKeying = "language",
): GateSimulation {
  const usable = observations.filter((o) => policy.pick(o) !== undefined && Number.isFinite(policy.confidence(o)));
  const bucketOf = (o: PreRouteObservation): string => (keying === "language" ? o.language : `${o.language}|${policy.pick(o)}`);
  const result: GateSimulation = {
    policy: policy.name,
    keying,
    settings,
    evaluated: 0,
    taken: 0,
    correct: 0,
    errors: 0,
    takenGoldNone: 0,
    takenUnreachable: 0,
    coverage: 0,
    errorRate: null,
    errorRateUpper: null,
    capacity: 0,
    byLanguage: {},
    folds: [],
  };
  for (const fold of [0, 1] as const) {
    const calibration = usable.filter((o) => o.fold !== fold);
    // What a perfect answerer would have gathered: a gold-none case gives it no sample (it says
    // none), and keyed per answer it could at best put every case a given agent is right for
    // into that agent's bucket.
    const reachableSamples = new Map<string, number>();
    for (const o of calibration) {
      if (o.gold.kind !== "agents") continue;
      const buckets = keying === "language" ? [o.language] : o.gold.acceptable.map((name) => `${o.language}|${name}`);
      for (const bucket of buckets) reachableSamples.set(bucket, (reachableSamples.get(bucket) ?? 0) + 1);
    }
    result.capacity = Math.max(result.capacity, ...reachableSamples.values());
    const samples = new Map<string, Array<{ confidence: number; agree: boolean }>>();
    for (const o of calibration) {
      const pick = policy.pick(o)!;
      if (pick === NONE_KEY) continue;
      const list = samples.get(bucketOf(o)) ?? [];
      list.push({ confidence: policy.confidence(o)!, agree: isHit(pick, o.gold) });
      samples.set(bucketOf(o), list);
    }
    const qualified = new Map<string, number>();
    for (const [bucket, list] of samples) {
      const levels = policy.levels === "observed"
        ? [...new Set(list.map((sample) => sample.confidence))].sort((a, b) => a - b)
        : policy.levels;
      const level = qualifyLevel(list, levels, settings);
      if (level !== null) qualified.set(bucket, level);
    }
    result.folds.push({ fold, calibrationCases: calibration.length, qualified: Object.fromEntries(qualified) });
    for (const o of usable.filter((candidate) => candidate.fold === fold)) {
      const slice = result.byLanguage[o.language] ?? (result.byLanguage[o.language] = { evaluated: 0, taken: 0, correct: 0 });
      result.evaluated += 1;
      slice.evaluated += 1;
      const pick = policy.pick(o)!;
      const level = qualified.get(bucketOf(o));
      if (pick === NONE_KEY || level === undefined || policy.confidence(o)! < level) continue;
      result.taken += 1;
      slice.taken += 1;
      if (isHit(pick, o.gold)) {
        result.correct += 1;
        slice.correct += 1;
      } else {
        result.errors += 1;
        if (o.gold.kind === "none") result.takenGoldNone += 1;
        else if (!reachable(o)) result.takenUnreachable += 1;
      }
    }
  }
  result.coverage = result.evaluated === 0 ? 0 : result.taken / result.evaluated;
  if (result.taken > 0) {
    result.errorRate = result.errors / result.taken;
    result.errorRateUpper = 1 - wilsonLowerBound(result.correct, result.taken);
  }
  return result;
}

/**
 * How many cases at this precision a Wilson lower bound needs to reach `target` — null when the
 * precision itself is not above it, or when more than `cap` would be needed. At 100% and a 0.9
 * target it is 35, which is why 30 flawless cases do not qualify.
 */
export function samplesNeeded(precision: number, target: number, cap = 20_000): number | null {
  if (!(precision > target)) return null;
  for (let n = 1; n <= cap; n += 1) {
    if (wilsonLowerBound(precision * n, n) >= target) return n;
  }
  return null;
}

/**
 * The fewest cases with which a bucket can qualify at all: flawless ones, and never fewer than
 * `minSamples`. Null when no number can (a target of 1: the lower bound never reaches it).
 */
export function flawlessSamplesNeeded(settings: BenchGateSettings): number | null {
  const needed = samplesNeeded(1, settings.targetAgreement);
  return needed === null ? null : Math.max(settings.minSamples, needed);
}

export interface CurveRow {
  level: number;
  taken: number;
  correct: number;
  lowerBound: number;
  coverage: number;
  samplesNeeded: number | null;
}

/**
 * Laya's picks at every gate level over ALL answered cases: descriptive only. A threshold read off
 * this table is fitted to the very cases it describes; the cross-fitted simulation is the figure
 * to act on. The cases needed never fall below `minSamples`, the gate's own floor.
 */
export function confidenceCurve(observations: readonly PreRouteObservation[], target: number, minSamples = 1): CurveRow[] {
  const answered = observations.filter((o) => o.laya);
  return GATE_LEVELS.map((level) => {
    const taken = answered.filter((o) => o.laya!.choice !== NONE_KEY && o.laya!.top >= level);
    const correct = taken.filter((o) => isHit(o.laya!.choice, o.gold)).length;
    const needed = taken.length === 0 ? null : samplesNeeded(correct / taken.length, target);
    return {
      level,
      taken: taken.length,
      correct,
      lowerBound: wilsonLowerBound(correct, taken.length),
      coverage: answered.length === 0 ? 0 : taken.length / answered.length,
      samplesNeeded: needed === null ? null : Math.max(minSamples, needed),
    };
  });
}

// ── The report ───────────────────────────────────────────────────────────────────────────────────

export interface SavingsEstimate {
  /** The routing round's assumed cost; the bench does not measure it. */
  roundMs: number;
  per100Turns: {
    skippedCorrectly: number;
    wrongDispatches: number;
    grossSecondsSaved: number;
    layaSecondsSpent: number;
    netSeconds: number;
  } | null;
}

/**
 * Seconds per 100 turns of this mix. Only a correct pick is credited with a saved round: a wrong
 * dispatch skipped the round too, but what it costs afterwards (a failed delegation, a recovery
 * round) is not measured here, so it is counted apart rather than netted. Laya is charged on every
 * turn, taken or not. The capsule is not charged: the prompt build already waits for it today.
 */
export function estimateSavings(gate: GateSimulation, layaMsP50: number | null, roundMs: number): SavingsEstimate {
  if (gate.evaluated === 0) return { roundMs, per100Turns: null };
  const per = 100 / gate.evaluated;
  const skippedCorrectly = gate.correct * per;
  const grossSecondsSaved = (skippedCorrectly * roundMs) / 1000;
  const layaSecondsSpent = ((layaMsP50 ?? 0) * 100) / 1000;
  return {
    roundMs,
    per100Turns: {
      skippedCorrectly,
      wrongDispatches: gate.errors * per,
      grossSecondsSaved,
      layaSecondsSpent,
      netSeconds: grossSecondsSaved - layaSecondsSpent,
    },
  };
}

export interface BenchVerdict {
  code: 0 | 1 | 2 | 3;
  status: "PASS" | "FAIL" | "INCONCLUSIVE" | "ENVIRONMENT-SUSPECT";
  reasons: string[];
}

/** Share of Laya calls (or embedding searches) that may fail before the run describes the failures more than the pre-router. */
const MAX_FAILURE_SHARE = 0.1;

export function benchVerdict(input: {
  /** Who answered, as the reasons name it; default Laya. */
  answerer?: string;
  layaSkipped: boolean;
  /** Cases observed: ranked, whether or not Laya was asked. */
  observed: number;
  /**
   * Cases left out because the embedding search returned nothing. The ranking holds every agent
   * when the search works, so each of these is an outage, not a routing miss — and a run that
   * silently loses them is scored on whatever the outage left.
   */
  unrouted: number;
  asked: number;
  answered: number;
  gate: GateSimulation;
  minCoverage: number;
}): BenchVerdict {
  const { gate } = input;
  const who = input.answerer ?? "Laya";
  if (input.unrouted > 0 && input.unrouted / (input.observed + input.unrouted) > MAX_FAILURE_SHARE) {
    return {
      code: 3,
      status: "ENVIRONMENT-SUSPECT",
      reasons: [`the embedding search failed on ${input.unrouted} of ${input.observed + input.unrouted} cases: the numbers describe the outage, not the pre-router`],
    };
  }
  if (input.layaSkipped) {
    return { code: 2, status: "INCONCLUSIVE", reasons: [`${who} was not asked (--no-laya): only the capsule and the baselines were measured`] };
  }
  if (input.asked === 0) return { code: 2, status: "INCONCLUSIVE", reasons: ["no case was scored"] };
  if (input.answered === 0) {
    return { code: 3, status: "ENVIRONMENT-SUSPECT", reasons: [`${who} answered none of ${input.asked} questions`] };
  }
  const failed = input.asked - input.answered;
  if (failed / input.asked > MAX_FAILURE_SHARE) {
    return {
      code: 3,
      status: "ENVIRONMENT-SUSPECT",
      reasons: [`${who} failed on ${failed} of ${input.asked} questions: the numbers describe ${who === "Laya" ? "the sidecar's" : "its"} failures, not the pre-router`],
    };
  }
  const target = gate.settings.targetAgreement;
  const reasons: string[] = [];
  if (gate.taken === 0) {
    const needed = flawlessSamplesNeeded(gate.settings);
    if (needed === null || gate.capacity < needed) {
      // Even a perfect answerer would have skipped nothing: the cases, not Laya, set the result.
      return {
        code: 2,
        status: "INCONCLUSIVE",
        reasons: [`no bucket could have qualified, whatever ${who} answered: the largest held ${gate.capacity} case(s) where a level was set, `
          + `and a ${target} target needs ${needed === null ? "more than any number of" : `at least ${needed}`} flawless ones. Compare the accuracy rows instead`],
      };
    }
    reasons.push(`no pick qualified: at ${target} agreement over at least ${gate.settings.minSamples} cases, no routing round could be skipped`);
  } else {
    // Exactly the error the target allows is within it (1 - 0.9 is 0.0999… in floating point).
    if (gate.errorRate !== null && gate.errorRate - (1 - target) > 1e-12) {
      reasons.push(`the skipped turns were wrong ${gate.errors} of ${gate.taken} times, more than the ${Math.round((1 - target) * 100)}% the target allows`);
    }
    if (gate.coverage < input.minCoverage) {
      reasons.push(`coverage ${pct(gate.coverage)} is below the required ${pct(input.minCoverage)}`);
    }
  }
  if (reasons.length > 0) return { code: 1, status: "FAIL", reasons };
  return {
    code: 0,
    status: "PASS",
    reasons: [`${gate.taken} of ${gate.evaluated} turns (${pct(gate.coverage)}) could skip the routing round, ${gate.errors} of them wrongly`],
  };
}

export interface PreRouteBenchSettings {
  k: number;
  split: SplitSelection;
  describe: DescriptionSource;
  keying: GateKeying;
  target: number;
  minSamples: number;
  roundMs: number;
  minCoverage: number;
  layaUrl: string | null;
  casesFile: string;
  casesSha256?: string;
  /** Who answered; absent means Laya. */
  backend?: PreRouteBackend;
  /** With the readout backend: the model it read. */
  readoutModel?: string;
}

export interface PreRouteBenchReport {
  kind: "pre-router-bench";
  version: 1;
  generatedAt: string;
  settings: PreRouteBenchSettings;
  counts: {
    loaded: number;
    skipped: Array<{ id: string; reason: string }>;
    observed: number;
    asked: number;
    answered: number;
    failed: number;
    /** Cases the embedding search could not rank (an outage: the ranking holds every agent otherwise). */
    noCandidates: string[];
    overWindow: number;
  };
  slices: Record<string, PreRouteScore>;
  recallAtK: Array<{ k: number } & Rate>;
  gate: {
    /** The simulation the verdict reads, chosen by `settings.keying`. */
    headline: "laya" | "layaPerAnswer";
    laya: GateSimulation;
    layaPerAnswer: GateSimulation;
    embedding: GateSimulation;
    /** The test half alone, cross-fitted within it: comparable with a run after fine-tuning. */
    layaTestHalf?: GateSimulation;
  };
  curve: CurveRow[];
  savings: SavingsEstimate;
  /** Stage 1's two thresholds, on every answered case. */
  stage: StageCriteria;
  /** Cross-fitted calibration per slice, where the answers carry log-scores (the readout backend). */
  calibration?: Record<string, PreRouteCalibrationSlice>;
  environment: Record<string, unknown>;
  warnings: string[];
  verdict: BenchVerdict;
  observations: PreRouteObservation[];
}

function slicesOf(observations: readonly PreRouteObservation[]): Record<string, PreRouteScore> {
  const slices: Record<string, PreRouteScore> = { all: scorePreRoute(observations) };
  const languages = [...new Set(observations.map((o) => o.language))].sort();
  for (const language of languages) slices[language] = scorePreRoute(observations.filter((o) => o.language === language));
  const test = observations.filter((o) => o.split === "test");
  if (test.length > 0 && test.length < observations.length) {
    slices["test"] = scorePreRoute(test);
    for (const language of languages) {
      const part = test.filter((o) => o.language === language);
      if (part.length > 0) slices[`test/${language}`] = scorePreRoute(part);
    }
  }
  return slices;
}

export function buildPreRouteReport(input: {
  settings: PreRouteBenchSettings;
  observations: readonly PreRouteObservation[];
  loaded: number;
  skipped: Array<{ id: string; reason: string }>;
  noCandidates: string[];
  overWindow: number;
  layaSkipped: boolean;
  environment?: Record<string, unknown>;
  warnings?: string[];
  generatedAt?: string;
}): PreRouteBenchReport {
  const { settings } = input;
  const observations = [...input.observations];
  const gateSettings: BenchGateSettings = { targetAgreement: settings.target, minSamples: settings.minSamples };
  const answered = observations.filter((o) => o.laya);
  // Both policies are simulated over the same cases, so a coverage difference is the policies'.
  const population = answered.length > 0 ? answered : observations;
  const laya = simulateGate(answered, LAYA_POLICY, gateSettings, "language");
  const layaPerAnswer = simulateGate(answered, LAYA_POLICY, gateSettings, "answer");
  const embedding = simulateGate(population, EMBEDDING_POLICY, gateSettings, "language");
  const testAnswered = answered.filter((o) => o.split === "test");
  const layaTestHalf = testAnswered.length > 0 && testAnswered.length < answered.length
    ? simulateGate(testAnswered, LAYA_POLICY, gateSettings, settings.keying)
    : undefined;
  const headline = settings.keying === "answer" ? "layaPerAnswer" : "laya";
  const headlineGate = headline === "laya" ? laya : layaPerAnswer;
  const all = scorePreRoute(observations);
  const warnings = [...(input.warnings ?? [])];
  const who = answererName(settings.backend);
  if (all.goldNone === 0) {
    warnings.push(`The cases hold no gold-none message (a direct answer or a multi-step request): whether ${who} leaves such turns to the orchestrator is untested, and every skipped turn here was bound for a specialist.`);
  }
  if (all.laya.models.length > 1) {
    warnings.push(`${who} answered as ${all.laya.models.length} different versions (${all.laya.models.join(", ")}) during one run: the gate keeps a version's evidence apart, and these numbers mix them.`);
  }
  // Laya's window; the resident model reads the whole question.
  if (input.overWindow > 0 && settings.backend !== "readout") {
    warnings.push(`${input.overWindow} question(s) are estimated over Laya's ${LAYA_WINDOW_TOKENS}-token window even with shortened options: the model cut something of its own choosing.`);
  }
  const maxK = Math.max(settings.k, ...observations.map((o) => Math.min(o.order.length, MAX_CANDIDATES)));
  const calibration: Record<string, PreRouteCalibrationSlice> = {};
  const calibrationSlices: Array<[string, PreRouteObservation[]]> = [["all", answered]];
  for (const language of [...new Set(answered.map((o) => o.language))].sort()) {
    calibrationSlices.push([language, answered.filter((o) => o.language === language)]);
  }
  for (const [slice, members] of calibrationSlices) {
    const block = preRouteCalibration(members);
    if (block) calibration[slice] = block;
  }
  return {
    kind: "pre-router-bench",
    version: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    settings,
    counts: {
      loaded: input.loaded,
      skipped: input.skipped,
      observed: observations.length,
      asked: all.laya.asked,
      answered: all.laya.answered,
      failed: all.laya.failed,
      noCandidates: input.noCandidates,
      overWindow: input.overWindow,
    },
    slices: slicesOf(observations),
    recallAtK: recallAtK(observations, maxK),
    gate: { headline, laya, layaPerAnswer, embedding, ...(layaTestHalf ? { layaTestHalf } : {}) },
    curve: confidenceCurve(observations, settings.target, settings.minSamples),
    savings: estimateSavings(headlineGate, all.laya.msP50, settings.roundMs),
    stage: stageOneCriteria(all),
    ...(Object.keys(calibration).length > 0 ? { calibration } : {}),
    environment: input.environment ?? {},
    warnings,
    verdict: benchVerdict({
      answerer: answererName(settings.backend),
      layaSkipped: input.layaSkipped,
      observed: observations.length,
      unrouted: input.noCandidates.length,
      asked: all.laya.asked,
      answered: all.laya.answered,
      gate: headlineGate,
      minCoverage: settings.minCoverage,
    }),
    observations,
  };
}

// ── Markdown ─────────────────────────────────────────────────────────────────────────────────────

function pct(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

function ratio(r: Rate): string {
  return r.of === 0 ? "n/a" : `${r.hit}/${r.of} (${pct(r.hit / r.of)})`;
}

function ms(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value)} ms`;
}

function gateRow(name: string, gate: GateSimulation): string {
  const levels = gate.folds
    .map((fold) => {
      const entries = Object.entries(fold.qualified);
      return `fold ${fold.fold}: ${entries.length === 0 ? "none" : entries.map(([bucket, level]) => `${bucket}≥${Math.round(level * 1000) / 1000}`).join(", ")}`;
    })
    .join("; ");
  const errors = gate.taken === 0
    ? "n/a"
    : `${gate.errors} (${pct(gate.errorRate ?? 0)}, ≤${pct(gate.errorRateUpper ?? 0)})`;
  return `| ${name} | ${gate.evaluated} | ${gate.taken} (${pct(gate.coverage)}) | ${errors} | ${gate.capacity} | ${levels} |`;
}

export function formatPreRouteMarkdown(report: PreRouteBenchReport): string {
  const { settings, counts, verdict } = report;
  const who = answererName(settings.backend);
  const lines: string[] = [];
  lines.push("# Pre-router bench", "");
  lines.push(`**${verdict.status}** — ${verdict.reasons.join("; ")}`, "");
  lines.push(`Cases: \`${settings.casesFile}\`${settings.casesSha256 ? ` (sha256 ${settings.casesSha256.slice(0, 12)})` : ""}, `
    + `${counts.observed} observed of ${counts.loaded} loaded, split ${settings.split}. `
    + `K = ${settings.k} agents + none, descriptions from ${settings.describe}. `
    + (settings.backend === "readout"
      ? `Readout of ${settings.readoutModel ?? "the routing tier"} (one token, the option letters' top list), ${counts.answered}/${counts.asked} answered`
      : `Laya: ${settings.layaUrl ?? "not asked"}, ${counts.answered}/${counts.asked} answered`)
    + `${report.slices["all"]?.laya.models.length ? ` by ${report.slices["all"]!.laya.models.join(", ")}` : ""}. Generated ${report.generatedAt}.`, "");

  const columns = Object.keys(report.slices);
  const row = (label: string, cell: (score: PreRouteScore) => string) =>
    `| ${label} | ${columns.map((column) => cell(report.slices[column]!)).join(" | ")} |`;
  lines.push("## Accuracy", "");
  lines.push(`| | ${columns.join(" | ")} |`, `|---|${columns.map(() => "---").join("|")}|`);
  lines.push(row("cases (gold none)", (s) => `${s.cases} (${s.goldNone})`));
  lines.push(row(`capsule recall (≤${CAPSULE_MAX_AGENTS}, production)`, (s) => ratio(s.capsuleRecall)));
  lines.push(row(`option recall (K=${settings.k})`, (s) => ratio(s.optionRecall)));
  lines.push(row("capsule top-1", (s) => ratio(s.capsuleTop1)));
  lines.push(row("embedding top-1", (s) => ratio(s.embeddingTop1)));
  lines.push(row("always the majority label", (s) => `${ratio(s.majority)}${s.majority.label ? ` ${s.majority.label}` : ""}`));
  lines.push(row(`**${who} top-1**`, (s) => ratio(s.laya.top1)));
  lines.push(row(`${who} top-1 on gold-agent cases (stage 1)`, (s) => ratio(s.laya.top1Agents)));
  lines.push(row(`${who}, right agent offered`, (s) => ratio(s.laya.givenOptions)));
  lines.push(row(`${who} says none when no right agent was offered`, (s) => ratio(s.laya.abstainWhenUnreachable)));
  lines.push(row(`${who} says none on gold none`, (s) => ratio(s.laya.noneRecall)));
  lines.push(row(`… its lower bound (Wilson, 95%)`, (s) => (s.laya.noneRecall.of === 0 ? "n/a" : wilsonLowerBound(s.laya.noneRecall.hit, s.laya.noneRecall.of).toFixed(3))));
  lines.push(row(`${who} ms p50 / p90`, (s) => `${ms(s.laya.msP50)} / ${ms(s.laya.msP90)}`));
  lines.push(row("capsule ms p50 / p90", (s) => `${ms(s.capsuleMs.p50)} / ${ms(s.capsuleMs.p90)}`));
  lines.push("");
  const all = report.slices["all"];
  if (all && all.laya.answered > 0) {
    const versus = all.laya.versusEmbedding;
    lines.push(`${who} against the embedding's first choice: ${who} alone right ${versus.layaOnly}, embedding alone right ${versus.embeddingOnly} `
      + `(exact McNemar p = ${versus.pExact.toFixed(3)}). ${who} picked none ${all.laya.pickedNone} times; its most common pick `
      + `${all.laya.topPick ? `${all.laya.topPick.label} took ${pct(all.laya.topPick.share)}` : "n/a"} of its answers, `
      + `the most common label ${all.goldTopShare ? `${all.goldTopShare.label} ${pct(all.goldTopShare.share)}` : "n/a"} of the cases.`, "");
  }

  lines.push("## Gate simulation (cross-fitted)", "");
  const flawless = flawlessSamplesNeeded({ targetAgreement: settings.target, minSamples: settings.minSamples });
  lines.push(`Target ${settings.target} agreement (Wilson lower bound) over at least ${settings.minSamples} cases; `
    + `levels set on one fold, applied to the other. The verdict reads **${report.gate.headline}**. `
    + `"Largest bucket" is the most cases one bucket could have gathered where a level was set, had every pick been right: `
    + `below ${flawless ?? "any number"} no answerer could have qualified there.`, "");
  lines.push("| policy | evaluated | skipped (coverage) | wrong (rate, upper bound) | largest bucket | qualified levels |", "|---|---|---|---|---|---|");
  lines.push(gateRow(`${who}, per language`, report.gate.laya));
  lines.push(gateRow(`${who}, per language and answer (as production keys it)`, report.gate.layaPerAnswer));
  lines.push(gateRow("embedding top-1 score threshold", report.gate.embedding));
  if (report.gate.layaTestHalf) lines.push(gateRow(`${who}, test half only`, report.gate.layaTestHalf));
  lines.push("");

  // Coverage against misroutes: what a dispatch above each level would take, and get wrong.
  lines.push(`## ${who} confidence curve (in-sample, descriptive)`, "");
  lines.push("| level | taken | right | misrouted | lower bound | coverage | cases needed at this precision |", "|---|---|---|---|---|---|---|");
  for (const curveRow of report.curve) {
    lines.push(`| ${curveRow.level} | ${curveRow.taken} | ${curveRow.correct} | ${curveRow.taken - curveRow.correct} | ${curveRow.lowerBound.toFixed(3)} | ${pct(curveRow.coverage)} | `
      + `${curveRow.samplesNeeded ?? (curveRow.taken === 0 ? "n/a" : "never")} |`);
  }
  lines.push("");

  lines.push("## Stage 1 (a tail hint): what it waits for", "");
  lines.push(`Top-1 on the gold-agent cases at least ${pct(STAGE_ONE_MIN_TOP1)} and the lower bound of "none" recall at least ${STAGE_ONE_MIN_NONE_RECALL_LOWER_BOUND}: `
    + `top-1 on the gold-agent cases ${report.stage.top1 === null ? "n/a" : pct(report.stage.top1)}, "none" recall lower bound ${report.stage.noneRecallLowerBound === null ? "n/a" : report.stage.noneRecallLowerBound.toFixed(3)} — `
    + `${report.stage.met ? "**met**" : `**not met**: ${report.stage.reasons.join("; ")}`}.`, "");

  if (report.calibration) {
    lines.push("## Calibration (cross-fitted: each fold at the temperature fitted on the other)", "");
    lines.push("| slice | cases | ECE at T=1 | ECE at fitted T | T fold 0 / fold 1 |", "|---|---|---|---|---|");
    for (const [slice, block] of Object.entries(report.calibration)) {
      const temperatures = block.folds.map((fold) => `${fold.temperature.toFixed(2)}${fold.clamped ? " (clamped)" : ""}`).join(" / ");
      lines.push(`| ${slice} | ${block.cases} | ${block.eceBefore === null ? "n/a" : block.eceBefore.toFixed(3)} | ${block.eceAfter === null ? "n/a" : block.eceAfter.toFixed(3)} | ${temperatures} |`);
    }
    lines.push("");
  }

  const recall = report.recallAtK.filter((r) => [1, 2, 3, 4, 5, 8, 12, 16, 19].includes(r.k));
  if (recall.length > 0) {
    lines.push("## Recall of the candidate order", "", recall.map((r) => `@${r.k} ${ratio(r)}`).join(" · "), "");
  }

  lines.push("## What a skipped round would save (estimate)", "");
  const per100 = report.savings.per100Turns;
  if (per100) {
    lines.push(`Per 100 turns of this mix, at an assumed ${(report.savings.roundMs / 1000).toFixed(1)} s routing round: `
      + `${per100.skippedCorrectly.toFixed(1)} rounds skipped correctly = ${per100.grossSecondsSaved.toFixed(1)} s; `
      + `${who} on every turn costs ${per100.layaSecondsSpent.toFixed(1)} s; net ${per100.netSeconds.toFixed(1)} s. `
      + `${per100.wrongDispatches.toFixed(1)} wrong dispatches, whose cost is not measured here.`, "");
  } else {
    lines.push("Nothing was evaluated.", "");
  }

  if (all) {
    const missed = all.perLabel.filter((entry) => entry.support >= 2 && entry.laya.of > 0 && entry.laya.hit === 0);
    if (missed.length > 0) {
      lines.push(`## Labels ${who} never got right (2+ cases)`, "", missed.map((entry) => `${entry.label} (${entry.laya.of})`).join(", "), "");
    }
  }

  lines.push("## Not measured", "");
  lines.push("- A \"same agent as last turn\" baseline: the cases are single messages without a session.");
  lines.push("- Context a follow-up needs (earlier turns, file paths): a pre-router that skips the orchestrator must still pass it on.");
  lines.push("- The routing round's own cost and whole-turn wall time: the savings line assumes a round, it does not time one.");
  if (counts.skipped.length > 0) lines.push(`- ${counts.skipped.length} case(s) skipped: ${counts.skipped.map((s) => `${s.id} (${s.reason})`).join("; ")}.`);
  if (counts.noCandidates.length > 0) lines.push(`- ${counts.noCandidates.length} case(s) could not be ranked, because the embedding search failed, and are in no figure above: ${counts.noCandidates.join(", ")}.`);
  lines.push("");

  if (report.warnings.length > 0) {
    lines.push("## Warnings", "", ...report.warnings.map((warning) => `- ${warning}`), "");
  }
  return lines.join("\n");
}

// ── Arguments ────────────────────────────────────────────────────────────────────────────────────

export interface PreRouterBenchArgs {
  /**
   * Case files, read in this order and scored as one corpus; `--cases` may be given more than once,
   * so the gold-none cases (eval/routing/none-cases.example.jsonl) can join the live ones.
   */
  cases?: string[];
  k: number;
  layaUrl: string;
  out?: string;
  split: SplitSelection;
  trainOut?: string;
  describe: DescriptionSource;
  keying: GateKeying;
  target: number;
  minSamples: number;
  roundMs: number;
  minCoverage: number;
  noLaya: boolean;
  limit?: number;
  /** Absent: Laya. */
  backend?: PreRouteBackend;
}

export class BenchUsageError extends Error {}

export const DEFAULT_LAYA_URL = "http://127.0.0.1:18080";

/**
 * The p50 of the orchestrator's first call on the 10 image turns with full timing (2026-09-22..25).
 * An assumption the report names as such; --round-ms replaces it.
 */
export const DEFAULT_ROUND_MS = 7_900;

const VALUE_FLAGS = new Set([
  "cases", "k", "laya-url", "out", "split", "train-out", "describe", "keying",
  "target", "min-samples", "round-ms", "min-coverage", "limit", "backend",
]);
const BOOLEAN_FLAGS = new Set(["no-laya"]);

function oneOf<T extends string>(flag: string, value: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new BenchUsageError(`--${flag} takes one of ${allowed.join(", ")} (got "${value}")`);
  }
  return value as T;
}

function numberIn(flag: string, value: string, min: number, max: number, integer = false): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max || (integer && !Number.isInteger(parsed))) {
    throw new BenchUsageError(`--${flag} takes ${integer ? "a whole number" : "a number"} from ${min} to ${max} (got "${value}")`);
  }
  return parsed;
}

/** The command line, checked; an unknown flag is an error, so a typo never runs the defaults. */
export function parsePreRouterArgs(argv: readonly string[]): PreRouterBenchArgs {
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  const caseFiles: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    // `pnpm run x -- --flag` may hand the separator itself through.
    if (token === "--") continue;
    if (!token.startsWith("--")) throw new BenchUsageError(`unexpected argument "${token}"`);
    const name = token.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      booleans.add(name);
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new BenchUsageError(`unknown flag ${token}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new BenchUsageError(`${token} needs a value`);
    // Every --cases counts; any other flag given twice keeps its last value, as before.
    if (name === "cases") caseFiles.push(value);
    else values.set(name, value);
    index += 1;
  }
  const kRaw = values.get("k");
  if (kRaw !== undefined && Number(kRaw) === MAX_LAYA_OPTIONS) {
    throw new BenchUsageError(`--k ${MAX_LAYA_OPTIONS} would send ${MAX_LAYA_OPTIONS + 1} options; the sidecar takes at most ${MAX_LAYA_OPTIONS}, so at most ${MAX_CANDIDATES} agents plus "none"`);
  }
  const args: PreRouterBenchArgs = {
    k: kRaw === undefined ? DEFAULT_CANDIDATES : numberIn("k", kRaw, 1, MAX_CANDIDATES, true),
    layaUrl: (values.get("laya-url") ?? DEFAULT_LAYA_URL).replace(/\/+$/, ""),
    split: oneOf("split", values.get("split") ?? "all", ["all", "calibration", "test"] as const),
    describe: oneOf("describe", values.get("describe") ?? "description", ["description", "oneliner"] as const),
    keying: oneOf("keying", values.get("keying") ?? "language", ["language", "answer"] as const),
    target: numberIn("target", values.get("target") ?? "0.9", 0.5, 1),
    minSamples: numberIn("min-samples", values.get("min-samples") ?? "30", 1, 100_000, true),
    roundMs: numberIn("round-ms", values.get("round-ms") ?? String(DEFAULT_ROUND_MS), 0, 600_000),
    minCoverage: numberIn("min-coverage", values.get("min-coverage") ?? "0", 0, 1),
    noLaya: booleans.has("no-laya"),
  };
  if (caseFiles.length > 0) {
    // The same file twice would count its cases twice; the lint would only see duplicate ids.
    const repeated = caseFiles.find((file, i) => caseFiles.indexOf(file) !== i);
    if (repeated !== undefined) throw new BenchUsageError(`--cases ${repeated} is given twice`);
    args.cases = caseFiles;
  }
  const out = values.get("out");
  if (out !== undefined) args.out = out;
  const trainOut = values.get("train-out");
  if (trainOut !== undefined) args.trainOut = trainOut;
  const limit = values.get("limit");
  if (limit !== undefined) args.limit = numberIn("limit", limit, 1, 1_000_000, true);
  const backend = values.get("backend");
  if (backend !== undefined) args.backend = oneOf("backend", backend, ["laya", "readout"] as const);
  return args;
}

/** The language bucket of a routing-eval case, as the gate keeps languages apart. */
export function caseLanguage(evalCase: RoutingEvalCase): LanguageBucket {
  return languageBucket(evalCase.language ?? null);
}
