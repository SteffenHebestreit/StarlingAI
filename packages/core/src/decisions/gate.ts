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
 */

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
}

/** "de", "en" or "other" — the languages kept apart. */
export type LanguageBucket = "de" | "en" | "other";

export function languageBucket(code: string | null | undefined): LanguageBucket {
  return code === "de" || code === "en" ? code : "other";
}

const samples = new Map<string, Sample[]>();
/** The qualified level per key and settings, until the next sample for that key arrives. */
const levelCache = new Map<string, number | null>();

function sampleKey(point: string, language: LanguageBucket, answer: string): string {
  return `${point}|${language}|${answer}`;
}

/** Record one case where both answered. */
export function recordAgreementSample(point: string, language: LanguageBucket, layaAnswer: string, top: number, agree: boolean): void {
  if (!Number.isFinite(top)) return;
  const key = sampleKey(point, language, layaAnswer);
  const list = samples.get(key) ?? [];
  list.push({ top, agree });
  if (list.length > MAX_SAMPLES_PER_KEY) list.splice(0, list.length - MAX_SAMPLES_PER_KEY);
  samples.set(key, list);
  for (const cached of levelCache.keys()) if (cached.startsWith(`${key}|`)) levelCache.delete(cached);
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

/** The lowest confidence at which Laya's `answer` may be taken, or null while none qualifies. */
export function qualifiedLevel(point: string, language: LanguageBucket, answer: string, settings: GateSettings): number | null {
  const key = sampleKey(point, language, answer);
  const cacheKey = `${key}|${settings.targetAgreement}|${settings.minSamples}`;
  const cached = levelCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const list = samples.get(key) ?? [];
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
    if (wilsonLowerBound(agree, n) >= settings.targetAgreement) {
      level = candidate;
      break;
    }
  }
  levelCache.set(cacheKey, level);
  return level;
}

/** May Laya's `answer`, given with probability `top`, be taken for this point and language? */
export function layaMayDecide(point: string, language: LanguageBucket, answer: string, top: number, settings: GateSettings): boolean {
  const level = qualifiedLevel(point, language, answer, settings);
  return level !== null && top >= level;
}

/** What the gate knows, for the report and the health check. */
export function gateSnapshot(settings: GateSettings): Array<{
  point: string;
  language: LanguageBucket;
  answer: string;
  samples: number;
  agreement: number;
  qualifiedLevel: number | null;
}> {
  return [...samples.entries()].map(([key, list]) => {
    const [point, language, answer] = key.split("|") as [string, LanguageBucket, string];
    const agree = list.filter((sample) => sample.agree).length;
    return {
      point,
      language,
      answer,
      samples: list.length,
      agreement: list.length > 0 ? agree / list.length : 0,
      qualifiedLevel: qualifiedLevel(point, language, answer, settings),
    };
  }).sort((a, b) => a.point.localeCompare(b.point) || a.language.localeCompare(b.language) || a.answer.localeCompare(b.answer));
}

/** Test-only: forget every sample. */
export function resetGateForTests(): void {
  samples.clear();
  levelCache.clear();
}
