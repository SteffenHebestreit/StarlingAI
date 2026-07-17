/**
 * LRN-403: statistically honest skill-lift measurement.
 *
 * The Phase-3 loop retired skills on a POINT ESTIMATE of lift (injected minus
 * held-out success rate) with as few as 3 samples per arm — at that size a
 * genuinely helpful skill has a large chance of a negative sample estimate, so
 * retirement was partly a coin flip. This module puts a confidence interval on
 * the difference of proportions so decisions fire only when the data actually
 * supports them.
 *
 * Method: Agresti–Caffo interval for the difference of two proportions (add
 * one success and one failure to each arm, then use the normal approximation).
 * Chosen over Wald for honest small-sample coverage and over bootstrap/exact
 * methods because it is closed-form, dependency-free, and monotone in n.
 */
import type { SkillMeta } from "./store.js";

export interface ProportionDiffCI {
  /** Point estimate of p1 − p2 (raw, not the adjusted estimate). */
  estimate: number;
  /** Lower/upper bounds of the CI on p1 − p2. */
  low: number;
  high: number;
}

/** Agresti–Caffo CI for (x1/n1) − (x2/n2). z defaults to 1.96 (~95%). */
export function proportionDiffCI(x1: number, n1: number, x2: number, n2: number, z = 1.96): ProportionDiffCI {
  const estimate = (n1 > 0 ? x1 / n1 : 0) - (n2 > 0 ? x2 / n2 : 0);
  const p1 = (x1 + 1) / (n1 + 2);
  const p2 = (x2 + 1) / (n2 + 2);
  const variance = (p1 * (1 - p1)) / (n1 + 2) + (p2 * (1 - p2)) / (n2 + 2);
  const margin = z * Math.sqrt(variance);
  const adjusted = p1 - p2;
  return { estimate, low: adjusted - margin, high: adjusted + margin };
}

export interface SkillLiftDecision {
  /** Point estimate of the lift (injected − held-out success rate). */
  estimate: number;
  ci: { low: number; high: number };
  samples: { injected: number; holdout: number };
  /** True when the CI excludes zero — the lift's SIGN is supported by the data. */
  decisive: boolean;
}

/**
 * Lift with a confidence interval, or null until both arms carry at least
 * `minSamplesPerArm` observations. Callers act on `decisive` + the CI bound in
 * the direction they care about (retirement: `high <= 0`), never on the raw
 * estimate alone.
 */
export function skillLiftDecision(
  meta: SkillMeta,
  opts: { minSamplesPerArm: number; z?: number },
): SkillLiftDecision | null {
  const holdoutUses = meta.holdoutUses ?? 0;
  if (meta.uses < opts.minSamplesPerArm || holdoutUses < opts.minSamplesPerArm) return null;
  const ci = proportionDiffCI(meta.successes, meta.uses, meta.holdoutSuccesses ?? 0, holdoutUses, opts.z ?? 1.96);
  return {
    estimate: ci.estimate,
    ci: { low: ci.low, high: ci.high },
    samples: { injected: meta.uses, holdout: holdoutUses },
    decisive: ci.low > 0 || ci.high < 0,
  };
}
