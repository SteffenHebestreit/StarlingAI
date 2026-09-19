/**
 * Routing fusion — merge the embedding shortlist with the triage verdict, then decide.
 *
 * This is the "merge two matching strategies" half of the redesign, and it is pure: given a
 * scored shortlist, a verdict and the turn's structural flags, it returns the branch. No I/O,
 * no config reads, no clock — so every rule below is a fixture in the test file.
 *
 * THE ONE INVARIANT, stated first because everything else is subordinate to it:
 *
 *   THE FACETS NEVER ADMIT AND NEVER EVICT. The family floor is applied to the raw embedding
 *   score BEFORE fusion; the taxonomy bonus only re-orders candidates that already cleared it,
 *   and licenses a dispatch. It cannot lift a below-floor entry over the gate, and it cannot
 *   push an above-floor entry under it.
 *
 * That is not caution for its own sake. The 0.72 floor is an ABSOLUTE gate on a rescaled
 * cosine, calibrated and reachable; commit e1151d8 moved scores against it while leaving the
 * ranking intact and took production down — 0 of 49 agents matched anything. A fusion that
 * can move a score across that gate reintroduces exactly that failure mode, now driven by a
 * small model's label instead of an embedding prefix. Two of the four candidate designs
 * proposed precisely that (a signed ±0.10, and a "rescue" 0.05 below the floor); both were
 * rejected for this reason.
 *
 * SCALES. Agents score on rescaled (cos+1)/2 with a 0.72 floor; workflows use a raw-cosine
 * standout rule with its own floor. Those numbers are not comparable, so nothing compares
 * them: each family is converted to FIT — distance above its OWN floor, normalised to [0,1] —
 * and fit is the only cross-family quantity.
 */

import type { RoutingTaxonomy } from "../config/schema.js";
import { facetAgreement, modesCompatible, type RequestFacets, type ResolvedTaxonomy } from "./routing-taxonomy.js";
import type { TriageVerdict } from "./triage.js";

export type CandidateFamily = "agent" | "workflow" | "skill";

export interface RoutingCandidate {
  name: string;
  family: CandidateFamily;
  /** Score on the FAMILY's own scale, as its scorer produced it. */
  score: number;
  /** The family's admission floor, as its scorer applies it. */
  floor: number;
  taxonomy?: ResolvedTaxonomy;
  /** One-line description for the brief. */
  oneLiner?: string;
  /**
   * True when the RAW user query admitted this candidate (as opposed to only the English
   * restatement doing so). An English-restatement-only match may re-order the brief but must
   * never license a mechanical dispatch: the restatement is written by the same small model
   * that produced the labels, so trusting both is one signal counted twice.
   */
  admittedByRawQuery?: boolean;
  /** Workflow-only: every parameter without a default is present or derivable. */
  paramsSatisfied?: boolean;
}

/** Language-independent facts about the turn. No topic signals, no word lists. */
export interface StructuralFlags {
  /** Retrieval returned document context for this turn (an attachment or the corpus). */
  documentGrounded?: boolean;
  /** The user pasted substantial technical content and is asking about it. */
  inlineAnalyticalContent?: boolean;
  /** This turn reuses evidence a previous delegation already gathered. */
  reusePriorEvidence?: boolean;
  hasUrl?: boolean;
  hasAttachments?: boolean;
  /** `--auto`: the user is not present to answer a question. */
  autonomous?: boolean;
  /** The previous turn asked a clarifying question. */
  afterClarify?: boolean;
  /** An explicit agent grant (a one-element allowedAgents from the `--agent` flag). */
  directiveAgent?: string;
}

export interface FusionTuning {
  /** Bonus weights in FIT units. The cap below is what bounds the whole mechanism. */
  modeBonus: number;
  domainBonus: number;
  deliverableBonus: number;
  /** Hard ceiling on the total facet bonus, in fit units. */
  maxBonus: number;
  /** Margins over which K collapses to one or two candidates. */
  decisiveMargin: number;
  closeMargin: number;
  /** Candidates within this much fit of the leader stay in the shortlist. */
  clusterWidth: number;
  maxK: number;
  maxKMulti: number;
  /** Fit a single agent must reach before the branch is single_agent. */
  dispatchFit: number;
  /** Top-1 raw score above which a request is treated as well-covered, so a clarify is
   *  not worth a round trip. */
  clarifyBlockingScore: number;
  minClarifyConfidence: number;
  /** Agreement at or above this reads as "the two signals agree". */
  strongAgreement: number;
  weakAgreement: number;
}

export const DEFAULT_FUSION_TUNING: FusionTuning = {
  modeBonus: 0.10,
  domainBonus: 0.15,
  deliverableBonus: 0.05,
  maxBonus: 0.30,
  decisiveMargin: 0.20,
  closeMargin: 0.10,
  clusterWidth: 0.15,
  maxK: 5,
  maxKMulti: 7,
  dispatchFit: 0.25,
  clarifyBlockingScore: 0.80,
  minClarifyConfidence: 0.6,
  strongAgreement: 0.7,
  weakAgreement: 0.4,
};

export type RoutingBranch =
  | "answer_direct"
  | "single_agent"
  | "workflow"
  | "coordinate"
  | "clarify"
  | "directive"
  | "general"
  | "legacy";

export type AgreementClass = "strong" | "weak" | "none" | "unknown";

export interface ScoredCandidate extends RoutingCandidate {
  /** Distance above the candidate's own floor, normalised to [0,1]. */
  fit: number;
  /** fit + the facet bonus, capped at 1. The ordering key. */
  fusedFit: number;
  /** Facet agreement in [0,1], or null when there is no verdict to agree with. */
  agreement: number | null;
}

export interface RoutedDecision {
  branch: RoutingBranch;
  /** The entry to dispatch, when the branch names one. */
  target?: string;
  targetFamily?: CandidateFamily;
  /** Ranked, already-admitted candidates, cut to K. */
  shortlist: ScoredCandidate[];
  k: number;
  margin: number;
  agreementClass: AgreementClass;
  /** Whether the turn needs externally-sourced facts — the switch that arms forced research. */
  sourceSensitive: boolean;
  /** Ordered, human-readable reasons. The first is the rule that fired. */
  reasons: string[];
}

export interface FusionInput {
  candidates: readonly RoutingCandidate[];
  verdict: TriageVerdict | null;
  flags?: StructuralFlags;
  tuning?: FusionTuning;
}

function toFit(candidate: RoutingCandidate): number {
  const span = 1 - candidate.floor;
  if (span <= 0) return candidate.score >= candidate.floor ? 1 : 0;
  return Math.max(0, Math.min(1, (candidate.score - candidate.floor) / span));
}

function verdictAsFacets(verdict: TriageVerdict): RequestFacets {
  return {
    mode: verdict.mode,
    domain: verdict.domain,
    ...(verdict.deliverable !== "none" ? { deliverable: verdict.deliverable } : {}),
  };
}

/** The bonus for one candidate, in fit units, scaled by the classifier's own confidence. */
function facetBonus(
  taxonomy: RoutingTaxonomy | undefined,
  verdict: TriageVerdict,
  tuning: FusionTuning,
): { bonus: number; agreement: number | null } {
  if (!taxonomy) return { bonus: 0, agreement: null };
  const facets = verdictAsFacets(verdict);
  const agreement = facetAgreement(facets, taxonomy);
  let bonus = 0;
  if (modesCompatible(facets.mode, taxonomy.mode)) bonus += tuning.modeBonus;
  if (taxonomy.domain.includes("cross_domain") || facets.domain.some((domain) => taxonomy.domain.includes(domain))) {
    bonus += tuning.domainBonus;
  }
  if (facets.deliverable && taxonomy.deliverable.includes(facets.deliverable)) bonus += tuning.deliverableBonus;
  return { bonus: Math.min(tuning.maxBonus, bonus) * verdict.confidence, agreement };
}

/**
 * Structural coordinate criteria.
 *
 * Deliberately about SHAPE, not subject: how many domains the work touches, whether the
 * parts are independent, whether the deliverable crosses a specialist boundary. The
 * literature is blunt about the cost of getting this wrong in either direction — coordination
 * gains a lot on decomposable work and loses most of it on sequential work — so the test is
 * "does this genuinely need more than one specialist", never "does this sound complicated".
 */
export function needsCoordination(
  verdict: TriageVerdict,
  shortlist: readonly ScoredCandidate[],
): { coordinate: boolean; reason?: string } {
  if (verdict.decision === "coordinate") return { coordinate: true, reason: "classifier chose coordinate" };
  if (verdict.mode === "ORCHESTRATE") return { coordinate: true, reason: "request itself asks for orchestration" };
  if (verdict.domain.length >= 2) return { coordinate: true, reason: `spans ${verdict.domain.length} domains` };
  if (verdict.multi) {
    // A multi-part request whose parts all land on the SAME specialist is not a coordination
    // problem — it is one specialist with a list. Sending it to a coordinator buys two
    // orchestrator calls and a plan for nothing, which is the over-planning failure mode.
    const leaders = new Set(
      shortlist.filter((candidate) => candidate.family === "agent").slice(0, 3).map((candidate) => candidate.name),
    );
    if (leaders.size > 1) return { coordinate: true, reason: `${verdict.parts.length} parts needing different specialists` };
  }
  const top = shortlist[0];
  if (top?.taxonomy?.executionShape === "needs_coordination") {
    return { coordinate: true, reason: `best match ${top.name} is a coordinator` };
  }
  return { coordinate: false };
}

/**
 * Can this workflow be dispatched mechanically?
 *
 * Deliverable agreement is MANDATORY, not one of two alternatives. The classifier is
 * catalog-blind — it cannot know which workflows exist — so its "workflow" vote says only
 * that a pipeline shape would fit, never that THIS pipeline is the one. Accepting that vote
 * in place of deliverable agreement is how a hardware design question became a twelve-slide
 * deck job once already. Side-effecting workflows are excluded entirely: a broadcast that
 * should not have run cannot be taken back.
 */
export function workflowDispatchable(
  candidate: ScoredCandidate,
  verdict: TriageVerdict,
): { ok: boolean; reason?: string } {
  if (candidate.family !== "workflow") return { ok: false, reason: "not a workflow" };
  const taxonomy = candidate.taxonomy;
  if (!taxonomy) return { ok: false, reason: "unlabelled workflow" };
  if (verdict.deliverable === "none" || !taxonomy.deliverable.includes(verdict.deliverable)) {
    return { ok: false, reason: `deliverable mismatch (request wants ${verdict.deliverable}, workflow produces ${taxonomy.deliverable.join("/") || "nothing declared"})` };
  }
  if (!modesCompatible(verdict.mode, taxonomy.mode)) {
    return { ok: false, reason: `mode mismatch (${verdict.mode} vs ${taxonomy.mode})` };
  }
  if (taxonomy.riskTier === "external_send" || taxonomy.riskTier === "mutating_external") {
    return { ok: false, reason: "workflow has external side effects — the model confirms it, the router does not" };
  }
  if (taxonomy.surface.includes("user_channel")) {
    return { ok: false, reason: "workflow sends to a user channel" };
  }
  if (candidate.paramsSatisfied === false) return { ok: false, reason: "required parameters are not derivable" };
  return { ok: true };
}

/**
 * Fuse and decide. The last rule always yields a branch that behaves like today, so no
 * combination of inputs can leave a turn without a path.
 */
export function fuseRouting(input: FusionInput): RoutedDecision {
  const tuning = input.tuning ?? DEFAULT_FUSION_TUNING;
  const flags = input.flags ?? {};
  const verdict = input.verdict;

  // STEP 1-3: admission is the SCORER's business; anything handed here already cleared its
  // family floor. Convert to fit so families are comparable.
  const admitted = input.candidates.filter((candidate) => candidate.score >= candidate.floor);

  // STEP 4: the bonus re-orders within the admitted set. Nothing enters or leaves.
  const scored: ScoredCandidate[] = admitted.map((candidate) => {
    const fit = toFit(candidate);
    const { bonus, agreement } = verdict
      ? facetBonus(candidate.taxonomy, verdict, tuning)
      : { bonus: 0, agreement: null };
    return { ...candidate, fit, fusedFit: Math.min(1, fit + bonus), agreement };
  }).sort((a, b) => (b.fusedFit - a.fusedFit) || a.name.localeCompare(b.name));

  // STEP 5: adaptive K. A decisive margin means one candidate; a flat field means the cluster.
  const margin = scored.length >= 2 ? Number((scored[0]!.fusedFit - scored[1]!.fusedFit).toFixed(4)) : scored.length === 1 ? 1 : 0;
  const maxK = verdict?.multi ? tuning.maxKMulti : tuning.maxK;
  let k: number;
  if (scored.length === 0) k = 0;
  else if (margin >= tuning.decisiveMargin) k = 1;
  else if (margin >= tuning.closeMargin) k = Math.min(2, scored.length);
  else k = Math.min(maxK, scored.filter((candidate) => candidate.fusedFit >= scored[0]!.fusedFit - tuning.clusterWidth).length);
  const shortlist = scored.slice(0, k);

  const topAgreement = shortlist[0]?.agreement ?? null;
  const agreementClass: AgreementClass = topAgreement === null
    ? "unknown"
    : topAgreement >= tuning.strongAgreement ? "strong"
      : topAgreement >= tuning.weakAgreement ? "weak" : "none";

  const decide = (branch: RoutingBranch, reason: string, target?: ScoredCandidate): RoutedDecision => ({
    branch,
    ...(target ? { target: target.name, targetFamily: target.family } : {}),
    shortlist,
    k,
    margin,
    agreementClass,
    sourceSensitive: verdict?.sourceSensitive ?? false,
    reasons: [reason],
  });

  // RULE 1 — no verdict: behave exactly as the turn does today. A missing classifier must
  // never be a different product, only an unlabelled one.
  if (!verdict) {
    return {
      branch: "legacy",
      shortlist,
      k,
      margin,
      agreementClass: "unknown",
      sourceSensitive: false,
      reasons: ["no triage verdict — proceeding on today's path"],
    };
  }

  // RULE 2 — an explicit directive is the user's own decision and outranks every signal.
  if (flags.directiveAgent) {
    return {
      ...decide("directive", `user named ${flags.directiveAgent} explicitly`),
      target: flags.directiveAgent,
      targetFamily: "agent",
    };
  }

  // RULE 3 — the answer is already in the turn. Document context, pasted content and reused
  // evidence are exactly the cases where the source-sensitivity judge is deliberately SKIPPED
  // today, because forcing a web lookup for a question about an attachment is the wrong move.
  // The verdict is kept for its labels but cannot arm research or ask a question here.
  if (flags.documentGrounded || flags.inlineAnalyticalContent || flags.reusePriorEvidence) {
    const reason = flags.documentGrounded
      ? "answer is grounded in this turn's document context"
      : flags.inlineAnalyticalContent
        ? "the user pasted the content being asked about"
        : "this turn reuses evidence already gathered";
    return { ...decide("answer_direct", reason), sourceSensitive: false };
  }

  // RULE 4 — the classifier says no specialist is needed, and nothing structural contradicts
  // it. Placed AHEAD of single_agent deliberately: a topically-close agent must not capture a
  // conceptual question just because it embeds near the subject. The branch is a hint, not a
  // gate — the delegation tools stay on the wire.
  const directModes = verdict.mode === "converse" || verdict.mode === "GATHER";
  if (
    verdict.decision === "answer_direct"
    && !verdict.sourceSensitive
    && directModes
    && !flags.hasUrl
    && !flags.hasAttachments
  ) {
    return decide("answer_direct", "classifier: answerable directly, no external facts required");
  }

  // RULE 5 — a prebuilt workflow that is literally what was asked for.
  const workflowCandidate = shortlist.find((candidate) => candidate.family === "workflow");
  if (workflowCandidate) {
    const check = workflowDispatchable(workflowCandidate, verdict);
    if (check.ok) return decide("workflow", `workflow ${workflowCandidate.name} matches the requested deliverable`, workflowCandidate);
  }

  // RULE 6 — coordination, on structural grounds.
  const coordination = needsCoordination(verdict, shortlist);
  if (coordination.coordinate) {
    const coordinator = shortlist.find((candidate) => candidate.taxonomy?.executionShape === "needs_coordination");
    return decide("coordinate", coordination.reason ?? "needs coordination", coordinator);
  }

  // RULE 7 — one specialist can do the whole thing.
  const top = shortlist[0];
  if (
    top
    && top.family === "agent"
    && verdict.alone
    && top.fusedFit >= tuning.dispatchFit
    && (k === 1 || margin >= tuning.closeMargin)
    && top.admittedByRawQuery !== false
    && top.taxonomy
    && modesCompatible(verdict.mode, top.taxonomy.mode)
    && (top.taxonomy.domain.includes("cross_domain") || verdict.domain.some((domain) => top.taxonomy!.domain.includes(domain)))
    && top.taxonomy.executionShape !== "needs_coordination"
  ) {
    return decide("single_agent", `${top.name} covers this alone (fit ${top.fusedFit.toFixed(2)}, margin ${margin.toFixed(2)})`, top);
  }

  // RULE 8 — ask, but only when asking is the only way forward and someone is there to answer.
  if (
    verdict.decision === "clarify"
    && verdict.missing.length > 0
    && verdict.confidence >= tuning.minClarifyConfidence
    && !flags.autonomous
    && !flags.afterClarify
    && (!top || top.score < tuning.clarifyBlockingScore)
  ) {
    return decide("clarify", `missing: ${verdict.missing.join(", ")}`);
  }

  // RULE 9 — nothing decisive. Today's path, with the discovery tools present.
  return decide(
    "general",
    shortlist.length === 0
      ? "no candidate cleared its floor — search, plan or answer"
      : "no rule decisive — proceeding with the shortlist as a hint",
  );
}
