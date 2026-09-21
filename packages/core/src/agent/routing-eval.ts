/**
 * Routing evaluation — turn "the routing feels right" into a number that can gate a change.
 *
 * Two modes, because the two things worth measuring fail in different ways:
 *
 *  - DECISION mode is offline and deterministic. A case supplies the candidates and the
 *    verdict directly, and the eval runs `fuseRouting` alone. It guards the RULE ORDER and
 *    the thresholds — the part of routing that is pure logic and therefore belongs in CI.
 *  - LIVE mode runs the real resolver against the real catalog and embedding backend. It
 *    guards the part that logic cannot: whether the right entry is actually retrieved.
 *
 * Three honesty rules are built in, each of them a defect this repo has already shipped:
 *
 *  1. A GATED result is a MISS, never an exclusion from the denominator. The previous
 *     routing benchmark ran at `minConfidence: "low"` and measured ranking while the
 *     production gate is absolute — it could not have observed the e1151d8 floor
 *     regression, in which the ranking stayed perfect and 0 of 49 queries matched.
 *  2. Zero scored cases is INCONCLUSIVE, not a pass. A suite that measures nothing
 *     reports green, which is worse than reporting nothing.
 *  3. A case whose query reuses the target entry's own vocabulary is flagged. Such a case
 *     measures string overlap wearing a semantic-routing costume, and it passes whether or
 *     not routing works. They are reported separately and a second accuracy number is
 *     computed without them.
 */

import {
  DEFAULT_FUSION_TUNING,
  fuseRouting,
  type FusionTuning,
  type RoutedDecision,
  type RoutingBranch,
  type RoutingCandidate,
  type StructuralFlags,
} from "./routing-fusion.js";
import type { TriageVerdict } from "./triage.js";

export interface RoutingEvalExpectation {
  /** The branch the fusion must choose. Only checkable when a verdict is available. */
  branch?: RoutingBranch;
  /** The entry that must be dispatched (the decision's `target`). */
  target?: string;
  /** The entry that must rank first in the shortlist. */
  top?: string;
  /** Any of these ranking in the top K is a hit — for cases with genuinely equivalent targets. */
  acceptable?: string[];
  /** Entries that must NOT be the dispatch target. The topic-over-intent regressions live here. */
  notTarget?: string[];
  /** Branches the fusion must not choose. */
  notBranch?: RoutingBranch[];
  /** The expected source-sensitivity verdict. */
  sourceSensitive?: boolean;
  /** The query must be admitted at the production floor — the floor-regression guard. */
  admitted?: boolean;
  /**
   * Upper bound on the shortlist size.
   *
   * K is what decides how many entries a coordinator is handed, so it is a first-class
   * outcome and not a detail: a decisive field that still returns five candidates has
   * failed at the job the adaptive-K step exists to do.
   */
  maxShortlist?: number;
  /** Lower bound on the leader's margin, in fit units. */
  minMargin?: number;
}

export interface RoutingEvalCase {
  id: string;
  /** The user's turn, verbatim. In decision mode it is documentation; the candidates are given. */
  query: string;
  /** Why this case exists — ideally the incident it reproduces. */
  note?: string;
  language?: "en" | "de" | "other";
  flags?: StructuralFlags;
  /** DECISION mode: the already-admitted candidates, on their families' own scales. */
  candidates?: RoutingCandidate[];
  /** DECISION mode: the classifier verdict to fuse with. `null` exercises the legacy path. */
  verdict?: TriageVerdict | null;
  expect: RoutingEvalExpectation;
  tags?: string[];
}

export interface RoutingEvalObservation {
  decision: RoutedDecision;
  /** Every admitted candidate in rank order, BEFORE the cut to K — the basis of recall@K. */
  ranked: string[];
  /** The resolver returned nothing above the floor. */
  gated: boolean;
  /**
   * What the DISCOVERY CAPSULE would actually render — the entries the orchestrator reads.
   *
   * `ranked` is every admitted candidate, which answers "did retrieval find it". That is not
   * the number that ships. Production hands the orchestrator a capsule of at most four
   * agents, meta-factory agents removed, so a case whose target is admitted at rank six is a
   * miss in the only place it matters. Reporting the wider figure as the outcome is this
   * project's characteristic defect, and an adversarial review called the gap fatal for any
   * gate written against it.
   */
  capsule?: string[];
  /** LIVE mode: the catalog text the expected target advertises, for the leakage check. */
  targetText?: string;
  /** True when a real classifier verdict was available, so branch checks are meaningful. */
  hasVerdict: boolean;
  elapsedMs?: number;
  /**
   * The English-restatement retrieval pass, when the run asked for it.
   *
   * Reported separately from the totals because it answers a question of its own: how many
   * turns that retrieved NOTHING from the user's own words are rescued by routing on the
   * classifier's restatement. Measured on 25 matched pairs, every German collapse had an
   * English twin that cleared the floor, so this is the mechanism that gap implies.
   */
  secondPass?: {
    attempted: boolean;
    restatement: string;
    /** Candidates the RAW query admitted, before the second pass added any. */
    rawAdmitted: number;
    added: string[];
  };
}

export type RoutingEvalResolver = (evalCase: RoutingEvalCase) => Promise<RoutingEvalObservation>;

export interface RoutingCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface RoutingCaseResult {
  id: string;
  language: string;
  checks: RoutingCheck[];
  /** A case with no applicable checks is not a pass — it is unscored, and counted as such. */
  scored: boolean;
  passed: boolean;
  gated: boolean;
  branch: RoutingBranch;
  target?: string;
  top?: string;
  ranked: string[];
  /** What the capsule would render, when the resolver reports it. */
  capsule?: string[];
  /** Token overlap between the query and the expected target's own catalog text, in [0,1]. */
  lexicalOverlap: number | null;
  elapsedMs?: number;
  secondPass?: RoutingEvalObservation["secondPass"];
  skippedChecks: string[];
}

export interface RoutingEvalThresholds {
  /** Minimum share of target-bearing cases whose expected entry is the dispatch target. */
  minTargetRate: number;
  /** Minimum share of target-bearing cases whose expected entry appears in the shortlist. */
  minRecallRate: number;
  /** Minimum share of branch-bearing cases whose branch matches. */
  minBranchRate: number;
  /** Maximum share of cases the resolver gated away entirely. */
  maxGatedRate: number;
  /**
   * Minimum share of cases whose expected entry survives into the capsule.
   *
   * The gate that describes production. Set below `minRecallRate` on purpose: recall over
   * the whole admitted set is an upper bound the capsule cut can only lower.
   */
  minCapsuleRecallRate: number;
  /** Above this query-to-catalog token overlap a case is flagged as lexically leaked. */
  leakOverlap: number;
}

export const DEFAULT_EVAL_THRESHOLDS: RoutingEvalThresholds = {
  minTargetRate: 0.75,
  minRecallRate: 0.90,
  minBranchRate: 0.80,
  maxGatedRate: 0.10,
  minCapsuleRecallRate: 0.75,
  leakOverlap: 0.5,
};

export interface RoutingEvalSlice {
  cases: number;
  scored: number;
  passed: number;
  gated: number;
}

export interface RoutingEvalReport {
  mode: "decision" | "live";
  results: RoutingCaseResult[];
  total: number;
  scored: number;
  passed: number;
  gated: number;
  gatedRate: number;
  targetScored: number;
  targetCorrect: number;
  recallScored: number;
  recallHit: number;
  /**
   * Recall measured on the capsule the orchestrator actually reads, not on the full admitted
   * set. Zero-scored when the resolver does not report a capsule (decision mode).
   */
  capsuleRecallScored: number;
  capsuleRecallHit: number;
  /** How many entries the capsule rendered, summed — the prompt cost of the shortlist. */
  capsuleEntries: number;
  branchScored: number;
  branchCorrect: number;
  sourceScored: number;
  sourceCorrect: number;
  /** expected branch -> observed branch -> count. Empty when no case names a branch. */
  confusion: Record<string, Record<string, number>>;
  byLanguage: Record<string, RoutingEvalSlice>;
  /** Ids whose query reuses the target's own vocabulary above the threshold. */
  leaked: string[];
  /** Populated only on a --second-pass run. */
  secondPass?: {
    attempted: number;
    /** Cases the raw query admitted NOTHING for, and the restatement admitted something. */
    rescued: string[];
    /** Cases that were already passing and the restatement widened anyway. */
    widened: number;
    /** Cases the raw query admitted nothing for, and the restatement did not help either. */
    stillEmpty: string[];
  };
  /** Pass rate over the cases that are NOT lexically leaked, or null when none remain. */
  cleanPassRate: number | null;
  thresholds: RoutingEvalThresholds;
  failures: string[];
  passedGate: boolean;
  /** True when nothing could be scored — report INCONCLUSIVE, never green. */
  inconclusive: boolean;
}

const WORD_RE = /[a-z0-9]{4,}/g;

function tokenise(text: string): Set<string> {
  return new Set(text.toLowerCase().match(WORD_RE) ?? []);
}

/**
 * Jaccard overlap between a query and an entry's own catalog text.
 *
 * The number itself is not a verdict; a legitimate query about "kubernetes" will share that
 * word with the infra agent's description. It is a flag for the case where a query was
 * written BY reading the description, which produces a case that passes under any routing
 * implementation that does substring matching — including one that is broken.
 */
export function lexicalOverlap(query: string, entryText: string): number {
  const a = tokenise(query);
  const b = tokenise(entryText);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : Number((shared / union).toFixed(4));
}

/** Build the resolver for DECISION mode: no catalog, no backend, no network. */
export function decisionResolver(tuning: FusionTuning = DEFAULT_FUSION_TUNING): RoutingEvalResolver {
  return async (evalCase) => {
    const candidates = evalCase.candidates ?? [];
    const decision = fuseRouting({
      candidates,
      verdict: evalCase.verdict ?? null,
      ...(evalCase.flags ? { flags: evalCase.flags } : {}),
      tuning,
    });
    // "Gated" in decision mode means the case supplied nothing above its own floor — the same
    // condition the live resolver reports, expressed in the data the case carries.
    const admitted = candidates.filter((candidate) => candidate.score >= candidate.floor);
    return {
      decision,
      ranked: decision.shortlist.map((candidate) => candidate.name),
      gated: admitted.length === 0,
      hasVerdict: Boolean(evalCase.verdict),
    };
  };
}

function checkCase(evalCase: RoutingEvalCase, observation: RoutingEvalObservation): {
  checks: RoutingCheck[];
  skipped: string[];
} {
  const checks: RoutingCheck[] = [];
  const skipped: string[] = [];
  const { decision } = observation;
  const expect = evalCase.expect;
  const top = decision.shortlist[0]?.name;

  if (expect.admitted !== undefined) {
    checks.push({
      name: "admitted",
      ok: !observation.gated === expect.admitted,
      detail: observation.gated
        ? "nothing cleared the family floor"
        : `${observation.ranked.length} candidate(s) admitted`,
    });
  }
  if (expect.target !== undefined) {
    checks.push({
      name: "target",
      ok: decision.target === expect.target,
      detail: `target=${decision.target ?? "none"} expected=${expect.target}`,
    });
  }
  if (expect.top !== undefined) {
    checks.push({
      name: "top",
      ok: top === expect.top,
      detail: `top=${top ?? "none"} expected=${expect.top}`,
    });
  }
  if (expect.acceptable !== undefined) {
    const hit = observation.ranked.find((name) => expect.acceptable!.includes(name));
    checks.push({
      name: "acceptable",
      ok: Boolean(hit),
      detail: hit
        ? `shortlisted ${hit}`
        : `none of [${expect.acceptable.join(", ")}] in [${observation.ranked.join(", ") || "empty"}]`,
    });
  }
  if (expect.notTarget !== undefined) {
    const violated = Boolean(decision.target && expect.notTarget.includes(decision.target));
    checks.push({
      name: "notTarget",
      ok: !violated,
      detail: violated ? `dispatched the excluded ${decision.target}` : `target=${decision.target ?? "none"}`,
    });
  }
  if (expect.notBranch !== undefined) {
    const violated = expect.notBranch.includes(decision.branch);
    checks.push({
      name: "notBranch",
      ok: !violated,
      detail: violated ? `chose the excluded branch ${decision.branch}` : `branch=${decision.branch}`,
    });
  }
  if (expect.maxShortlist !== undefined) {
    checks.push({
      name: "maxShortlist",
      ok: decision.k <= expect.maxShortlist,
      detail: `k=${decision.k} allowed<=${expect.maxShortlist}`,
    });
  }
  if (expect.minMargin !== undefined) {
    checks.push({
      name: "minMargin",
      ok: decision.margin >= expect.minMargin,
      detail: `margin=${decision.margin} required>=${expect.minMargin}`,
    });
  }
  // A branch or source-sensitivity expectation is only meaningful with a verdict: without one
  // the fusion returns `legacy` by contract, and asserting against that would measure the
  // absence of a classifier rather than the quality of one.
  if (expect.branch !== undefined) {
    if (!observation.hasVerdict) {
      skipped.push("branch (no verdict — run with the classifier enabled)");
    } else {
      checks.push({
        name: "branch",
        ok: decision.branch === expect.branch,
        detail: `branch=${decision.branch} expected=${expect.branch} (${decision.reasons[0] ?? "no reason"})`,
      });
    }
  }
  if (expect.sourceSensitive !== undefined) {
    if (!observation.hasVerdict) {
      skipped.push("sourceSensitive (no verdict)");
    } else {
      checks.push({
        name: "sourceSensitive",
        ok: decision.sourceSensitive === expect.sourceSensitive,
        detail: `sourceSensitive=${decision.sourceSensitive} expected=${expect.sourceSensitive}`,
      });
    }
  }
  return { checks, skipped };
}

export async function runRoutingEval(
  cases: readonly RoutingEvalCase[],
  resolve: RoutingEvalResolver,
  options: {
    mode: "decision" | "live";
    thresholds?: RoutingEvalThresholds;
    /** LIVE mode: entry name -> its catalog text, used for the leakage flag. */
    catalogText?: Record<string, string>;
  },
): Promise<RoutingEvalReport> {
  const thresholds = options.thresholds ?? DEFAULT_EVAL_THRESHOLDS;
  const results: RoutingCaseResult[] = [];
  const confusion: Record<string, Record<string, number>> = {};
  const byLanguage: Record<string, RoutingEvalSlice> = {};
  let targetScored = 0;
  let targetCorrect = 0;
  let recallScored = 0;
  let recallHit = 0;
  let branchScored = 0;
  let branchCorrect = 0;
  let sourceScored = 0;
  let sourceCorrect = 0;
  let capsuleRecallScored = 0;
  let capsuleRecallHit = 0;
  let capsuleEntries = 0;
  let gated = 0;

  for (const evalCase of cases) {
    const observation = await resolve(evalCase);
    const { checks, skipped } = checkCase(evalCase, observation);
    const language = evalCase.language ?? "en";
    const expectedEntry = evalCase.expect.target ?? evalCase.expect.top;
    const entryText = observation.targetText
      ?? (expectedEntry ? options.catalogText?.[expectedEntry] : undefined);
    const overlap = entryText ? lexicalOverlap(evalCase.query, entryText) : null;

    const scored = checks.length > 0;
    const passed = scored && checks.every((check) => check.ok);
    if (observation.gated) gated += 1;

    for (const check of checks) {
      if (check.name === "target" || check.name === "top") {
        targetScored += 1;
        if (check.ok) targetCorrect += 1;
      }
      if (check.name === "acceptable") {
        recallScored += 1;
        if (check.ok) recallHit += 1;
      }
      if (check.name === "branch") {
        branchScored += 1;
        if (check.ok) branchCorrect += 1;
      }
      if (check.name === "sourceSensitive") {
        sourceScored += 1;
        if (check.ok) sourceCorrect += 1;
      }
    }
    // Recall is also satisfied by an exact target hit — a case that names one entry is a
    // recall case with a set of size one, and counting it only under `target` would make the
    // recall figure describe a different, smaller population than the accuracy figure.
    //
    // Except when the target is the user's OWN named agent. A directive bypasses retrieval
    // entirely, so scoring it as a retrieval miss would charge the recall figure for a
    // candidate the router was never asked to find.
    // A directive bypasses retrieval entirely, so scoring it as a retrieval miss would charge
    // the recall figures for a candidate the router was never asked to find. It counts when
    // the expectation is ONLY that agent — either as the named target, or as a single-element
    // acceptable set. A wider acceptable set still asks a retrieval question about the others.
    const directive = evalCase.flags?.directiveAgent;
    const acceptable = evalCase.expect.acceptable;
    const directiveTarget = directive !== undefined && (
      directive === expectedEntry
      || (acceptable !== undefined && acceptable.length === 1 && acceptable[0] === directive)
    );
    if (evalCase.expect.acceptable === undefined && expectedEntry !== undefined && !directiveTarget) {
      recallScored += 1;
      if (observation.ranked.includes(expectedEntry)) recallHit += 1;
    }

    // RECALL AT THE CAPSULE — the number that describes production.
    //
    // Counted over the same population as recall@K so the two are comparable: a case that
    // names an entry, or a set of acceptable ones, and is not a user directive. The capsule
    // is whatever the resolver says the orchestrator would actually be handed; a resolver
    // that reports none (decision mode) contributes nothing rather than a zero.
    if (observation.capsule && !directiveTarget) {
      const wanted = evalCase.expect.acceptable ?? (expectedEntry ? [expectedEntry] : []);
      if (wanted.length > 0) {
        capsuleRecallScored += 1;
        if (wanted.some((name) => observation.capsule!.includes(name))) capsuleRecallHit += 1;
      }
      capsuleEntries += observation.capsule.length;
    }

    if (evalCase.expect.branch !== undefined && observation.hasVerdict) {
      const row = confusion[evalCase.expect.branch] ?? (confusion[evalCase.expect.branch] = {});
      row[observation.decision.branch] = (row[observation.decision.branch] ?? 0) + 1;
    }

    const slice = byLanguage[language] ?? (byLanguage[language] = { cases: 0, scored: 0, passed: 0, gated: 0 });
    slice.cases += 1;
    if (scored) slice.scored += 1;
    if (passed) slice.passed += 1;
    if (observation.gated) slice.gated += 1;

    results.push({
      id: evalCase.id,
      language,
      checks,
      scored,
      passed,
      gated: observation.gated,
      branch: observation.decision.branch,
      ...(observation.decision.target ? { target: observation.decision.target } : {}),
      ...(observation.ranked[0] ? { top: observation.ranked[0] } : {}),
      ranked: observation.ranked,
      ...(observation.capsule ? { capsule: observation.capsule } : {}),
      lexicalOverlap: overlap,
      ...(observation.elapsedMs !== undefined ? { elapsedMs: observation.elapsedMs } : {}),
      ...(observation.secondPass ? { secondPass: observation.secondPass } : {}),
      skippedChecks: skipped,
    });
  }

  const total = results.length;
  const scored = results.filter((result) => result.scored).length;
  const passed = results.filter((result) => result.passed).length;
  const leaked = results
    .filter((result) => result.lexicalOverlap !== null && result.lexicalOverlap >= thresholds.leakOverlap)
    .map((result) => result.id);
  const secondPassRuns = results.filter((result) => result.secondPass?.attempted);
  const secondPass = secondPassRuns.length === 0 ? undefined : {
    attempted: secondPassRuns.length,
    rescued: secondPassRuns
      .filter((result) => result.secondPass!.rawAdmitted === 0 && result.ranked.length > 0)
      .map((result) => result.id),
    widened: secondPassRuns.filter(
      (result) => result.secondPass!.rawAdmitted > 0 && result.secondPass!.added.length > 0,
    ).length,
    stillEmpty: secondPassRuns
      .filter((result) => result.secondPass!.rawAdmitted === 0 && result.ranked.length === 0)
      .map((result) => result.id),
  };
  const clean = results.filter((result) => result.scored && !leaked.includes(result.id));
  const cleanPassRate = clean.length > 0
    ? Number((clean.filter((result) => result.passed).length / clean.length).toFixed(4))
    : null;

  const failures: string[] = [];
  const rate = (hit: number, of: number): number => (of === 0 ? 1 : hit / of);
  if (targetScored > 0 && rate(targetCorrect, targetScored) < thresholds.minTargetRate) {
    failures.push(`target accuracy ${targetCorrect}/${targetScored} below ${thresholds.minTargetRate}`);
  }
  if (recallScored > 0 && rate(recallHit, recallScored) < thresholds.minRecallRate) {
    failures.push(`recall ${recallHit}/${recallScored} below ${thresholds.minRecallRate}`);
  }
  if (branchScored > 0 && rate(branchCorrect, branchScored) < thresholds.minBranchRate) {
    failures.push(`branch accuracy ${branchCorrect}/${branchScored} below ${thresholds.minBranchRate}`);
  }
  const gatedRate = total === 0 ? 0 : Number((gated / total).toFixed(4));
  if (total > 0 && gatedRate > thresholds.maxGatedRate) {
    failures.push(`gated ${gated}/${total} (${gatedRate}) above ${thresholds.maxGatedRate}`);
  }
  if (capsuleRecallScored > 0 && rate(capsuleRecallHit, capsuleRecallScored) < thresholds.minCapsuleRecallRate) {
    failures.push(
      `capsule recall ${capsuleRecallHit}/${capsuleRecallScored} below ${thresholds.minCapsuleRecallRate}`
      + " — this is the figure the orchestrator actually sees",
    );
  }
  for (const result of results) {
    if (result.scored && !result.passed) {
      const broken = result.checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.detail}`);
      failures.push(`[${result.id}] ${broken.join(" | ")}`);
    }
  }

  const inconclusive = scored === 0;
  return {
    mode: options.mode,
    results,
    total,
    scored,
    passed,
    gated,
    gatedRate,
    targetScored,
    targetCorrect,
    recallScored,
    recallHit,
    branchScored,
    branchCorrect,
    sourceScored,
    sourceCorrect,
    capsuleRecallScored,
    capsuleRecallHit,
    capsuleEntries,
    confusion,
    byLanguage,
    leaked,
    ...(secondPass ? { secondPass } : {}),
    cleanPassRate,
    thresholds,
    failures,
    // An INCONCLUSIVE run is never a pass: a suite that scored nothing has not shown anything.
    passedGate: !inconclusive && failures.length === 0,
    inconclusive,
  };
}

function pct(hit: number, of: number): string {
  if (of === 0) return "n/a";
  return `${hit}/${of} (${Math.round((hit / of) * 100)}%)`;
}

export function formatRoutingEvalReport(report: RoutingEvalReport): string {
  const lines: string[] = [];
  lines.push(`Routing eval — ${report.mode} mode`);
  lines.push(`  cases            ${report.total} (${report.scored} scored, ${report.passed} passed)`);
  lines.push(`  target accuracy  ${pct(report.targetCorrect, report.targetScored)}`);
  lines.push(`  recall@K         ${pct(report.recallHit, report.recallScored)}   (every admitted candidate)`);
  if (report.capsuleRecallScored > 0) {
    const mean = (report.capsuleEntries / report.capsuleRecallScored).toFixed(1);
    lines.push(`  recall AT CAPSULE${pct(report.capsuleRecallHit, report.capsuleRecallScored)}   `
      + `(what the orchestrator reads; ${mean} entries on average)`);
    const lost = report.recallHit - report.capsuleRecallHit;
    if (lost > 0) {
      lines.push(`    ${lost} case(s) were retrieved but cut before the orchestrator saw them.`);
    }
  }
  lines.push(`  branch accuracy  ${pct(report.branchCorrect, report.branchScored)}`);
  lines.push(`  source-sensitive ${pct(report.sourceCorrect, report.sourceScored)}`);
  lines.push(`  gated            ${pct(report.gated, report.total)}  (a gated case is a MISS, not an exclusion)`);
  if (report.cleanPassRate !== null && report.leaked.length > 0) {
    lines.push(`  pass rate without the ${report.leaked.length} lexically-leaked case(s): ${Math.round(report.cleanPassRate * 100)}%`);
  }

  if (report.secondPass) {
    const sp = report.secondPass;
    lines.push(`  English-restatement second pass, on ${sp.attempted} non-English case(s):`);
    lines.push(`    rescued (raw admitted nothing, restatement did): ${sp.rescued.length}`);
    if (sp.rescued.length > 0) lines.push(`      ${sp.rescued.join(", ")}`);
    lines.push(`    widened an already-working case: ${sp.widened}`);
    lines.push(`    still empty after the restatement: ${sp.stillEmpty.length}`);
    if (sp.stillEmpty.length > 0) lines.push(`      ${sp.stillEmpty.join(", ")}`);
  }

  const languages = Object.keys(report.byLanguage).sort();
  if (languages.length > 1) {
    lines.push("  by language:");
    for (const language of languages) {
      const slice = report.byLanguage[language]!;
      lines.push(`    ${language.padEnd(6)} ${pct(slice.passed, slice.scored)}  gated ${slice.gated}/${slice.cases}`);
    }
  }

  const expectedBranches = Object.keys(report.confusion).sort();
  if (expectedBranches.length > 0) {
    lines.push("  branch confusion (expected then observed):");
    for (const expected of expectedBranches) {
      const row = report.confusion[expected]!;
      const parts = Object.entries(row).sort().map(([got, n]) => `${got} x${n}`);
      lines.push(`    ${expected.padEnd(14)} ${parts.join("  ")}`);
    }
  }

  if (report.leaked.length > 0) {
    lines.push(`  LEXICALLY LEAKED (query reuses the target's own wording, at or above ${report.thresholds.leakOverlap}):`);
    for (const id of report.leaked) {
      const result = report.results.find((candidate) => candidate.id === id)!;
      lines.push(`    ${id} — overlap ${result.lexicalOverlap}`);
    }
    lines.push("    Such a case passes under a broken router too. Rewrite it in the user's own words.");
  }

  const skipped = report.results.filter((result) => result.skippedChecks.length > 0);
  if (skipped.length > 0) {
    lines.push(`  ${skipped.length} case(s) had checks skipped for want of a classifier verdict:`);
    for (const result of skipped.slice(0, 5)) {
      lines.push(`    ${result.id} — ${result.skippedChecks.join(", ")}`);
    }
  }

  if (report.inconclusive) {
    lines.push("  INCONCLUSIVE: no case produced a single applicable check.");
  } else if (report.failures.length === 0) {
    lines.push("  PASS");
  } else {
    lines.push("  FAIL:");
    for (const failure of report.failures) lines.push(`    - ${failure}`);
  }
  return lines.join("\n");
}

/** Parse a case file: one JSON object per line (.jsonl) or a JSON array. */
export function parseCaseFile(text: string): RoutingEvalCase[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) return JSON.parse(trimmed) as RoutingEvalCase[];
  const cases: RoutingEvalCase[] = [];
  const lines = trimmed.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line.length === 0 || line.startsWith("//")) continue;
    try {
      cases.push(JSON.parse(line) as RoutingEvalCase);
    } catch (err) {
      throw new Error(
        `case file line ${index + 1} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return cases;
}

/**
 * Reject a case file that cannot measure anything, loudly and before the run.
 *
 * A duplicate id silently overwrites its twin in any by-id reporting, and a case with an
 * empty `expect` contributes a row to the totals while asserting nothing — both produce a
 * suite that looks larger than the evidence it carries.
 */
export function lintCases(cases: readonly RoutingEvalCase[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const evalCase of cases) {
    if (!evalCase.id) problems.push("a case has no id");
    else if (seen.has(evalCase.id)) problems.push(`duplicate case id: ${evalCase.id}`);
    else seen.add(evalCase.id);
    if (!evalCase.query) problems.push(`[${evalCase.id}] has no query`);
    const expect = evalCase.expect ?? {};
    if (Object.keys(expect).length === 0) problems.push(`[${evalCase.id}] asserts nothing`);
    for (const candidate of evalCase.candidates ?? []) {
      if (candidate.floor >= 1) problems.push(`[${evalCase.id}] candidate ${candidate.name} has floor >= 1`);
    }
  }
  return problems;
}
