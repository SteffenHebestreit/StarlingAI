/**
 * When does a run differ from its baseline? A scenario's attempts are trials of one pass rate, and
 * until 2026-10 any lower rate than the baseline's counted as a regression. At k=1 and 95 %
 * per-attempt reliability that gives an unchanged 52-scenario suite at least one false
 * "regression" in about 92 % of comparisons, so a regression list nobody could act on.
 *
 * Per scenario, a change now counts only when the 95 % interval of the pass-rate difference
 * (Agresti–Caffo, the interval the agent harness compares pass counts with) excludes zero. Short of
 * that, a scenario that both passed and failed within one run reads flaky; one whose runs were each
 * uniform but disagree (1/1 then 0/1) reads inconclusive: too few attempts to tell a change from
 * chance.
 *
 * At k=1 no single scenario can show a decisive change, so the suite is compared as a whole: an
 * exact sign test over the scenarios run with equally many trials in both runs. Without a change,
 * each of them is as likely to end lower as higher; far more lower than higher is a regression.
 */
import { proportionDiffCI } from "../skills/lift.js";

/** One run of one scenario: the attempts that ended on a verdict (harness errors excluded) and how many passed. */
export interface AttemptTally {
  passed: number;
  trials: number;
}

export type ScenarioChange = "regressed" | "improved" | "flaky" | "inconclusive" | "unchanged";

export interface ScenarioChangeVerdict {
  change: ScenarioChange;
  /** 95 % interval of the pass-rate difference (now − baseline); null when a run has no trial. */
  ci: { low: number; high: number } | null;
}

export type SuiteChange = "regressed" | "improved" | "inconclusive" | "unchanged";

export interface SuiteChangeVerdict {
  change: SuiteChange;
  /** Scenarios with equally many trials in both runs whose pass count fell, rose, or stayed. */
  lower: number;
  higher: number;
  same: number;
  /** Scenarios left out of the test: their trial counts differ between the runs. */
  unpaired: number;
  /** One-sided exact sign-test p-value in the direction of the larger count (1 when nothing moved). */
  pValue: number;
}

/** z of a two-sided 95 % interval; each direction errs at most 2.5 %. */
const Z_95 = 1.96;
/** The sign test's one-sided level, matching one side of the 95 % interval. */
const SUITE_ALPHA = 0.025;

const clamp = (value: number): number => Math.min(1, Math.max(-1, value));

/** A scenario's run against its baseline run. */
export function compareTallies(baseline: AttemptTally, now: AttemptTally): ScenarioChangeVerdict {
  if (baseline.trials === 0 || now.trials === 0) return { change: "inconclusive", ci: null };
  const interval = proportionDiffCI(now.passed, now.trials, baseline.passed, baseline.trials, Z_95);
  // A difference of two rates lies in [-1, 1]; clamping the display never moves a bound across 0.
  const ci = { low: clamp(interval.low), high: clamp(interval.high) };
  if (interval.high < 0) return { change: "regressed", ci };
  if (interval.low > 0) return { change: "improved", ci };
  const mixed = (tally: AttemptTally): boolean => tally.passed > 0 && tally.passed < tally.trials;
  if (mixed(baseline) || mixed(now)) return { change: "flaky", ci };
  return { change: baseline.passed / baseline.trials === now.passed / now.trials ? "unchanged" : "inconclusive", ci };
}

/** P(X ≥ k) for X ~ Binomial(n, ½): the exact one-sided sign-test p-value. */
export function signTestPValue(k: number, n: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  let logChoose = 0;
  let tail = 0;
  for (let i = 0; i <= n; i += 1) {
    if (i > 0) logChoose += Math.log(n - i + 1) - Math.log(i);
    if (i >= k) tail += Math.exp(logChoose - n * Math.LN2);
  }
  return Math.min(1, tail);
}

/** The scenarios run in both runs, taken together. */
export function compareSuite(pairs: ReadonlyArray<{ baseline: AttemptTally; now: AttemptTally }>): SuiteChangeVerdict {
  let lower = 0;
  let higher = 0;
  let same = 0;
  let unpaired = 0;
  for (const { baseline, now } of pairs) {
    // Unequal attempt counts are not exchangeable: more attempts see a failure more often.
    if (baseline.trials === 0 || baseline.trials !== now.trials) {
      unpaired += 1;
      continue;
    }
    if (now.passed < baseline.passed) lower += 1;
    else if (now.passed > baseline.passed) higher += 1;
    else same += 1;
  }
  const moved = lower + higher;
  // Nothing comparable is not "unchanged".
  if (moved === 0) return { change: same > 0 ? "unchanged" : "inconclusive", lower, higher, same, unpaired, pValue: 1 };
  const pValue = signTestPValue(Math.max(lower, higher), moved);
  const change: SuiteChange = lower === higher || pValue > SUITE_ALPHA ? "inconclusive" : lower > higher ? "regressed" : "improved";
  return { change, lower, higher, same, unpaired, pValue };
}
