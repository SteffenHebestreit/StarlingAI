/**
 * When Laya may decide on its own: measured, never assumed.
 *
 * Every case where both Laya and the incumbent answered is one sample: Laya's top probability and
 * whether the two agreed. Samples are kept per decision point, language and LAYA'S ANSWER — the
 * answer, because a model is often reliable saying one thing and not the other (a confident "task"
 * can be trustworthy while its "small talk" is not), and the language, because Laya is weakest in
 * German and English cases must not vouch for German ones.
 *
 * A confidence level qualifies when the cases at or above it number at least `minSamples` and the
 * lower bound of their agreement (Wilson, 95%) reaches `targetAgreement`. The lowest qualifying
 * level is used, which hands Laya the most cases the evidence supports. The lower bound rather than
 * the plain rate, so that 10 of 10 does not qualify where 290 of 300 does.
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
 * target needs 35 flawless cases (53 with one disagreement).
 */

import { DECISION_POINTS, type DecisionPointId } from "./points.js";

/** The confidence levels considered, lowest first. */
export const GATE_LEVELS = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.98] as const;

/** Per key, only the most recent cases count: the model and the incumbent both change over time. */
const MAX_SAMPLES_PER_KEY = 2_000;

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

/** "de", "en" or "other" — the languages kept apart. */
export type LanguageBucket = "de" | "en" | "other";

export function languageBucket(code: string | null | undefined): LanguageBucket {
  return code === "de" || code === "en" ? code : "other";
}

const samples = new Map<string, Sample[]>();
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
  list.push({ top, agree, ...(incumbent !== undefined ? { incumbent } : {}) });
  if (list.length > MAX_SAMPLES_PER_KEY) list.splice(0, list.length - MAX_SAMPLES_PER_KEY);
  samples.set(key, list);
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
 * The lowest confidence at which `model`'s `answer` may be taken, or null while none qualifies. With
 * `protect` (the point's costly-to-miss answer), any other answer must also leave the protected
 * answer's recall above the target at that level.
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
  const guarded = guard !== undefined ? protectedCases(point, language, model, guard) : null;
  let level: number | null = null;
  for (const candidate of GATE_LEVELS) {
    let n = 0;
    let agree = 0;
    for (const sample of list) {
      if (sample.top < candidate) continue;
      n += 1;
      if (sample.agree) agree += 1;
    }
    // Fewer cases at every higher level: once too few remain, no higher level can qualify.
    if (n < settings.minSamples) break;
    if (wilsonLowerBound(agree, n) < settings.targetAgreement) continue;
    if (guarded) {
      // Too few protected cases seen: their recall is unknown at every level.
      if (guarded.length < settings.minSamples) break;
      const missed = guarded.filter((seen) => seen.answer === answer && seen.top >= candidate).length;
      if (wilsonLowerBound(guarded.length - missed, guarded.length) < settings.targetAgreement) continue;
    }
    level = candidate;
    break;
  }
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
  levelCache.clear();
}
