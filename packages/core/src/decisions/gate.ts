/**
 * When Laya may decide on its own: measured, never assumed.
 *
 * Every case where both Laya and the incumbent answered is one sample: Laya's top probability and
 * whether the two agreed. Samples are kept per decision point, language and LAYA'S ANSWER — the
 * answer, because a model is often reliable saying one thing and not the other (a confident "task"
 * can be trustworthy while its "small talk" is not), and the language, because Laya is weakest in
 * German and English cases must not vouch for German ones.
 *
 * A confidence level qualifies when the lower bound (Wilson, 95%) of the agreement of the cases at
 * or above it reaches `targetAgreement`. The lower bound rather than the plain rate, so that 10 of
 * 10 does not qualify where 290 of 300 does. The levels are tested as one FIXED SEQUENCE, from the
 * highest down, and the first that fails ends it (Learn-then-Test): the lowest level reached is
 * used, which hands Laya the most cases the evidence supports. Taking the lowest level that passes
 * in any order, re-tested after every new case, as this gate did until 2026-09-26, tests up to nine
 * levels at once and again after each case, and opens on luck: simulated on 1,000 streams of 2,000
 * cases whose true agreement is 0.87 (target 0.9), it opened 8.9% of them; this sequence with the
 * confirmation below opens 1.8%, and a stream at 0.96 needs 1.21 times as many cases on average to
 * open (tests/decisions-gate-statistics.test.ts replays it on 500 seeded streams: 51 opened, now 6).
 *
 * A level with too few cases to be worth testing is skipped, not failed: since it holds fewer cases
 * than every level below it, failing it would close levels the evidence does support. The lowest
 * level hides no level below it and is tested from `minSamples`; every higher one only once it
 * holds as many cases as a level agreeing halfway between the target and perfect agreement needs
 * to pass nine times in ten (levelSampleFloor: 200 at a target of 0.9). The price: a higher level
 * alone — Laya right when sure, wrong when unsure — qualifies later than it did.
 *
 * A key opens only when its level also qualified CONFIRM_SAMPLES of its own cases earlier, and it
 * closes while its newest cases at that level drift (the last DRIFT_WINDOW agree less than the
 * target minus DRIFT_TOLERANCE; right after such a window, until one reaches the target itself).
 * Both are read from the cases alone, so the gateway, a restart that rebuilds the gate from the
 * ledger and decisions:report reach the same answer however often each asked.
 *
 * And per MODEL VERSION — the checkpoint that answered (the sidecar names it in every answer). A
 * fine-tuned checkpoint is a different model: what its predecessor proved says nothing about it, so
 * it earns its handover from its own cases.
 *
 * Agreement of Laya's answer is precision, and precision alone cannot protect a rare answer: when
 * the incumbent says "no" 99 times in 100, a Laya that always says "no" agrees 99% of the time and
 * misses every "yes". So a point names the answer whose misses cost quality (`protect`, e.g. "yes,
 * research first"), and Laya's other answers qualify at a level only when, among the cases the
 * incumbent answered `protect`, Laya gave the other answer at that level or above in so few that
 * the lower bound of the protected answer's recall also reaches `targetAgreement` — over at least
 * `minSamples` such cases. On traffic where the protected answer is rare this takes long, and it
 * should: until then the incumbent decides.
 *
 * `minSamples` is a floor, not the number needed: 30 of 30 has a lower bound of 0.886, so a 0.9
 * target needs 35 flawless cases (53 with one disagreement), and with the confirmation 38.
 */

import { DECISION_POINTS, type DecisionPointId } from "./points.js";

/** The confidence levels considered, lowest first. */
export const GATE_LEVELS = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.98] as const;

/** Per key, only the most recent cases count: the model and the incumbent both change over time. */
const MAX_SAMPLES_PER_KEY = 2_000;
/** For a replay of the gate (scripts/decisions-report.ts): the cases it keeps per key. */
export const GATE_MAX_SAMPLES_PER_KEY = MAX_SAMPLES_PER_KEY;

/**
 * A key opens only when the fixed sequence also qualified it without its newest CONFIRM_SAMPLES
 * cases, and at the higher of the two levels: a pass on a lucky run must survive three more cases.
 * The adoption plan asked for 10. Simulated (3 x 500 seeded streams at 0.96, 1,000 at 0.87), the
 * mean cases until a stream at 0.96 opens, against the old rule's: 1.12 times with no confirmation,
 * 1.21 with 3, 1.27 with 5, 1.38 with 10 — beyond the plan's own bound of 1.3; the false opens at
 * 0.87 go from 2.1% (none) to 1.8% (3), 1.6% (5), 1.3% (10), against 8.9% for the old rule. The
 * fixed sequence does most of the work. (The median moves in steps — the Wilson bound passes at 35
 * flawless cases, 53 with one miss, 69, 84 — so it is 72 or 87 for 3 depending on the seeds.) An
 * anytime-valid bound (a mixture martingale) opened no stream at 0.87 but needed about twice the
 * cases at 0.96.
 */
export const CONFIRM_SAMPLES = 3;
/**
 * Drift: the key closes while its newest DRIFT_WINDOW cases at its level agree less than the
 * target minus DRIFT_TOLERANCE, and while the window before them did, until the newest reach the
 * target itself — the hysteresis that keeps a key agreeing just above the target from flapping.
 * The level's own cases only: after a handover those are the audited ones (auditRate), so at 0.1
 * a window takes ten times as many decisions to fill. On the test's 500 seeded streams, a key that
 * drifts from 0.96 to 0.8 after 1,000 cases closes after a median 58 cases (95% within 97; the
 * slowest, open at a high level whose cases come rarely, 198); the old rule took a median 399.
 */
export const DRIFT_WINDOW = 100;
export const DRIFT_TOLERANCE = 0.03;
/** z of the power a higher level must have before it is tested (levelSampleFloor): nine times in ten. */
const LEVEL_POWER_Z = 1.2816;

export interface GateSettings {
  targetAgreement: number;
  minSamples: number;
}

interface Sample {
  top: number;
  agree: boolean;
  /** The incumbent's answer, when it was recorded: what the recall guard counts. */
  incumbent?: string;
}

/** Per level (index into GATE_LEVELS): the cases at or above it, and how many of them agreed. */
interface LevelCounts {
  n: number[];
  agree: number[];
}

function emptyCounts(): LevelCounts {
  return { n: GATE_LEVELS.map(() => 0), agree: GATE_LEVELS.map(() => 0) };
}

/** Add (`sign` 1) or remove (-1) one case from the per-level counts. */
function count(counts: LevelCounts, sample: { top: number; agree: boolean }, sign: 1 | -1): void {
  for (let j = 0; j < GATE_LEVELS.length && sample.top >= GATE_LEVELS[j]!; j += 1) {
    counts.n[j]! += sign;
    if (sample.agree) counts.agree[j]! += sign;
  }
}

/**
 * The fewest cases a level above the lowest must hold before it is tested: enough that a level
 * whose true agreement lies halfway between the target and 1 passes the Wilson bound nine times in
 * ten (normal approximation). 200 at a target of 0.9, 410 at 0.95, 95 at 0.8; never below
 * `minSamples`. Below it a level is skipped: a failure there would say more about its few cases
 * than about its agreement, and would close every level below it.
 */
export function levelSampleFloor(settings: GateSettings): number {
  const halfway = (1 + settings.targetAgreement) / 2;
  const gap = halfway - settings.targetAgreement;
  if (!(gap > 0)) return Number.POSITIVE_INFINITY;
  const needed = Math.ceil((((LEVEL_POWER_Z + 1.96) * Math.sqrt(halfway * (1 - halfway))) / gap) ** 2);
  return Math.max(settings.minSamples, needed);
}

/** The protected cases of a recall guard: how many there are, and per level how many this answer took. */
interface GuardCounts {
  cases: number;
  missed: number[];
}

function guardCounts(answer: string, protectedCases: ReadonlyArray<{ answer: string; top: number }>): GuardCounts {
  const missed = GATE_LEVELS.map(() => 0);
  for (const seen of protectedCases) {
    if (seen.answer !== answer) continue;
    for (let j = 0; j < GATE_LEVELS.length && seen.top >= GATE_LEVELS[j]!; j += 1) missed[j]! += 1;
  }
  return { cases: protectedCases.length, missed };
}

/**
 * The fixed sequence: from the highest level down, skipping levels with too few cases, until the
 * first that fails its agreement or the recall guard. The lowest level reached, or null.
 */
function fixedSequence(counts: LevelCounts, settings: GateSettings, guard: GuardCounts | null): number | null {
  // Too few protected cases seen: their recall is unknown at every level.
  if (guard && guard.cases < settings.minSamples) return null;
  const floor = levelSampleFloor(settings);
  let level: number | null = null;
  for (let j = GATE_LEVELS.length - 1; j >= 0; j -= 1) {
    const n = counts.n[j]!;
    if (n < (j === 0 ? settings.minSamples : floor)) continue;
    if (wilsonLowerBound(counts.agree[j]!, n) < settings.targetAgreement) break;
    if (guard && wilsonLowerBound(guard.cases - guard.missed[j]!, guard.cases) < settings.targetAgreement) break;
    level = GATE_LEVELS[j]!;
  }
  return level;
}

/** Is the key drifting at `level`? Its own cases, oldest first; see DRIFT_WINDOW. */
function drifting(cases: ReadonlyArray<{ top: number; agree: boolean }>, level: number, settings: GateSettings): boolean {
  let newest = 0;
  let newestAgree = 0;
  let before = 0;
  let beforeAgree = 0;
  for (let i = cases.length - 1; i >= 0 && before < DRIFT_WINDOW; i -= 1) {
    const sample = cases[i]!;
    if (sample.top < level) continue;
    if (newest < DRIFT_WINDOW) {
      newest += 1;
      if (sample.agree) newestAgree += 1;
    } else {
      before += 1;
      if (sample.agree) beforeAgree += 1;
    }
  }
  // A window not yet full says less than the lower bound the level already passed.
  if (newest < DRIFT_WINDOW) return false;
  const floor = settings.targetAgreement - DRIFT_TOLERANCE;
  if (newestAgree / DRIFT_WINDOW < floor) return true;
  return before === DRIFT_WINDOW && beforeAgree / DRIFT_WINDOW < floor && newestAgree / DRIFT_WINDOW < settings.targetAgreement;
}

/**
 * The level of one key from its own cases (oldest first, at most the newest MAX_SAMPLES_PER_KEY)
 * and their per-level counts: the fixed sequence on all of them, confirmed on all but the newest
 * CONFIRM_SAMPLES (the higher of the two levels), and null while the newest drift.
 */
function levelOfKey(cases: ReadonlyArray<{ top: number; agree: boolean }>, counts: LevelCounts, settings: GateSettings, guard: GuardCounts | null): number | null {
  const now = fixedSequence(counts, settings, guard);
  if (now === null) return null;
  const earlier: LevelCounts = { n: [...counts.n], agree: [...counts.agree] };
  for (let i = Math.max(0, cases.length - CONFIRM_SAMPLES); i < cases.length; i += 1) count(earlier, cases[i]!, -1);
  const then = fixedSequence(earlier, settings, guard);
  if (then === null) return null;
  const level = Math.max(now, then);
  return drifting(cases, level, settings) ? null : level;
}

/**
 * The level the gate gives these cases of one key, recorded in this order — for a replay that
 * must decide exactly as the gate does (agent/decisions-bench.ts). `guard`: for an answer other
 * than the point's protected one, the cases whose incumbent answer was the protected one, with
 * what Laya answered them.
 */
export function levelFromCases(
  cases: ReadonlyArray<{ top: number; agree: boolean }>,
  settings: GateSettings,
  guard?: { answer: string; protectedCases: ReadonlyArray<{ answer: string; top: number }> },
): number | null {
  const kept = cases.filter((sample) => Number.isFinite(sample.top)).slice(-MAX_SAMPLES_PER_KEY);
  const counts = emptyCounts();
  for (const sample of kept) count(counts, sample, 1);
  return levelOfKey(kept, counts, settings, guard ? guardCounts(guard.answer, guard.protectedCases) : null);
}

/** "de", "en" or "other" — the languages kept apart. */
export type LanguageBucket = "de" | "en" | "other";

export function languageBucket(code: string | null | undefined): LanguageBucket {
  return code === "de" || code === "en" ? code : "other";
}

const samples = new Map<string, Sample[]>();
/** Per key, its samples' per-level counts, kept with the list so a level costs no pass over it. */
const sampleCounts = new Map<string, LevelCounts>();
/** The qualified level per key and settings, until the next sample for that key arrives. */
const levelCache = new Map<string, number | null>();

function sampleKey(point: string, language: LanguageBucket, answer: string, model: string): string {
  return `${point}|${language}|${answer}|${model}`;
}

/** Record one case where both answered; `model` is the version that answered, `incumbent` what the incumbent said. */
export function recordAgreementSample(
  point: string,
  language: LanguageBucket,
  layaAnswer: string,
  top: number,
  agree: boolean,
  model = "",
  incumbent?: string,
): void {
  if (!Number.isFinite(top)) return;
  const key = sampleKey(point, language, layaAnswer, model);
  const list = samples.get(key) ?? [];
  const counts = sampleCounts.get(key) ?? emptyCounts();
  const sample: Sample = { top, agree, ...(incumbent !== undefined ? { incumbent } : {}) };
  list.push(sample);
  count(counts, sample, 1);
  while (list.length > MAX_SAMPLES_PER_KEY) count(counts, list.shift()!, -1);
  samples.set(key, list);
  sampleCounts.set(key, counts);
  // Every answer of this point and language: the recall guard of one answer reads the others' samples.
  const prefix = `${point}|${language}|`;
  for (const cached of levelCache.keys()) if (cached.startsWith(prefix)) levelCache.delete(cached);
}

/** The cases the incumbent answered `protect`, with what Laya answered them and how sure it was. */
function protectedCases(point: string, language: LanguageBucket, model: string, protect: string): Array<{ answer: string; top: number }> {
  const prefix = `${point}|${language}|`;
  const out: Array<{ answer: string; top: number }> = [];
  for (const [key, list] of samples) {
    if (!key.startsWith(prefix)) continue;
    // The version may itself contain "|": it is everything after the third.
    const [, , answer, ...rest] = key.split("|") as [string, string, string, ...string[]];
    if (rest.join("|") !== model) continue;
    for (const sample of list) {
      // A sample recorded without the incumbent's answer still says it when the two agreed.
      const incumbent = sample.incumbent ?? (sample.agree ? answer : undefined);
      if (incumbent === protect) out.push({ answer, top: sample.top });
    }
  }
  return out;
}

/**
 * The lower bound of a 95% Wilson score interval for `agree` successes in `n` cases: how low the
 * true agreement could plausibly be. 0 for no cases.
 */
export function wilsonLowerBound(agree: number, n: number, z = 1.96): number {
  if (n <= 0) return 0;
  const p = agree / n;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (centre - margin) / (1 + z2 / n));
}

/**
 * The lowest confidence at which `model`'s `answer` may be taken, or null while none qualifies: the
 * fixed sequence, confirmed and drift-checked (see the top of this file). With `protect` (the
 * point's costly-to-miss answer), any other answer must also leave the protected answer's recall
 * above the target at that level.
 */
export function qualifiedLevel(
  point: string,
  language: LanguageBucket,
  answer: string,
  settings: GateSettings,
  model = "",
  protect?: string,
): number | null {
  const key = sampleKey(point, language, answer, model);
  const guard = protect !== undefined && protect !== answer ? protect : undefined;
  const cacheKey = `${key}|${settings.targetAgreement}|${settings.minSamples}|${guard ?? ""}`;
  const cached = levelCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const list = samples.get(key) ?? [];
  const counts = sampleCounts.get(key) ?? emptyCounts();
  const guarded = guard !== undefined ? guardCounts(answer, protectedCases(point, language, model, guard)) : null;
  const level = levelOfKey(list, counts, settings, guarded);
  levelCache.set(cacheKey, level);
  return level;
}

/** The model versions with samples for this point, language and answer. */
export function modelsWithSamples(point: string, language: LanguageBucket, answer: string): string[] {
  const prefix = `${point}|${language}|${answer}|`;
  return [...samples.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
}

/** May `model`'s `answer`, given with probability `top`, be taken for this point and language? */
export function layaMayDecide(
  point: string,
  language: LanguageBucket,
  answer: string,
  top: number,
  settings: GateSettings,
  model = "",
  protect?: string,
): boolean {
  const level = qualifiedLevel(point, language, answer, settings, model, protect);
  return level !== null && top >= level;
}

/**
 * What the gate knows, for the report and the health check. `protectOf` names each point's protected
 * answer, so a qualified level here is the one decide() would use; default: the decision points' own.
 */
export function gateSnapshot(
  settings: GateSettings,
  protectOf: (point: string) => string | undefined = (point) => DECISION_POINTS[point as DecisionPointId]?.protect,
): Array<{
  point: string;
  language: LanguageBucket;
  answer: string;
  model: string;
  samples: number;
  agreement: number;
  qualifiedLevel: number | null;
}> {
  return [...samples.entries()].map(([key, list]) => {
    // The version may itself contain "|": it is everything after the third.
    const [point, language, answer, ...rest] = key.split("|") as [string, LanguageBucket, string, ...string[]];
    const model = rest.join("|");
    const agree = list.filter((sample) => sample.agree).length;
    return {
      point,
      language,
      answer,
      model,
      samples: list.length,
      agreement: list.length > 0 ? agree / list.length : 0,
      qualifiedLevel: qualifiedLevel(point, language, answer, settings, model, protectOf(point)),
    };
  }).sort((a, b) => a.point.localeCompare(b.point) || a.language.localeCompare(b.language) || a.answer.localeCompare(b.answer) || a.model.localeCompare(b.model));
}

/** Test-only: forget every sample. */
export function resetGateForTests(): void {
  samples.clear();
  sampleCounts.clear();
  levelCache.clear();
}
