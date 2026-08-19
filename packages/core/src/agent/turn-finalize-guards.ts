// The terminal response-guard run of the no-tool-calls turn pipeline, extracted verbatim
// from runTurnImpl (runtime.ts) into a module function driven by an explicit context
// object. This is the span that takes the model's `rawResponse` plus this turn's state
// and produces the final, user-facing `finalResponse`: it finalizes the raw draft, runs
// the general + source-sensitive shared-facts backstops, the unverified-source caveat,
// the (already-extracted) citation-honesty guard, the false-completion guard, risk-gated
// QA, the QA-delivery loop, the deliverable-consistency gate, the completion QA gate,
// output redaction, the zero-work fabrication guard, and the last-line honesty banner.
//
// This file deliberately does NOT import from runtime.js. Every runtime-private dependency
// — the finalizer, forceSynthesis, collectTurnArtifactAttachments, the two QA gates, and
// the two bounded corrective closures — is supplied as a callback on TerminalGuardContext.
// Late-bound / mutable enclosing state (the shared qaCorrectiveBuildUsed latch, the per-turn
// delegation counter, and the mutated guardrailEvents array) is read/written through
// getter / mutation callbacks and a shared array reference, so the moved body observes and
// mutates live turn state exactly as the original inline span did. Pure helpers are imported
// straight from their sibling modules (never through runtime.js), so the audit events,
// severities, conditions, and ordering are byte-identical to the inline original.

import { logAudit } from "../audit/logger.js";
import { findUnfilledStubFiles, findBrokenBuiltPages } from "./sub-agent.js";
import { getConfig } from "../config/loader.js";
import { effectiveOrchestration } from "../runtime/effort-context.js";
import { executeTool, type ToolContext } from "../tools/registry.js";
import { scanOutput } from "../guardrails/output.js";
import { requiresApproval } from "../guardrails/tool-tiers.js";
import type { ChatProvider } from "../providers/lmstudio.js";
import type { AgentSession } from "./session.js";
import type { DeliverableIntent } from "./deliverable-intent.js";
import type { DynamicTurnGuidance } from "./intent-classifier.js";
import { timedPhase } from "./turn-metrics.js";
import {
  runArtifactVerificationGate,
  buildFailureCaveat,
  buildUnverifiableCaveat,
} from "./artifact-verification-gate.js";
import type { TurnQualitySignals } from "./turn-scorecard.js";
import { loadTurnPlan, classifyTurnRisk } from "./turn-plan.js";
import {
  shouldCheckDeliverableConsistency,
  collectUserStatements,
} from "./deliverable-consistency.js";
import { looksEvidenceAnchored } from "./evidence-anchoring.js";
import {
  claimsArtifactWrittenButUnproduced,
  looksLikeFabricatedToolDeliveryLink,
  looksLikeInlinedAppDocument,
} from "./deliverable-intent.js";
import {
  looksLikeRegurgitatedPriorAnswer,
  looksLikeOrchestrationOnlyEvidence,
  stripPresentationFormatting,
} from "./runtime-utils.js";
import { sanitizeUserFacingAssistantResponse } from "./response-finalization.js";
import { looksLikeRawSharedFactsDump } from "./runtime-evidence-dump.js";
import {
  looksLikeTransparentIncompleteReport,
  looksLikeUnsourcedSpecificClaims,
  prependUnverifiedSourceCaveat,
  prependUnverifiedQaCaveat,
} from "./citation-honesty.js";
import { applyCitationHonestyGuard } from "./turn-terminal-guards.js";
import { findRecentDelegateEvidence } from "./interrupted-delegation-evidence.js";
import {
  hasRecentSourceSensitivePartialDelegation,
} from "./source-sensitive-enforcement.js";
import {
  getSharedFactsEvidenceForFinalSynthesis,
  formatRecoveryEvidenceForFinalUser,
  formatSourceSensitiveEvidenceBackstop,
  answerNeedsEvidenceAnchoringRepair,
  synthesizeSourceSensitiveEvidenceBackstop,
  looksLikeWeakRecoveryEvidence,
  chooseBetterRecoveryEvidence,
} from "./evidence-recovery.js";

/** Structural result shape of runQaDeliveryGate (declared locally to avoid a runtime.js import). */
interface QaDeliveryGateResult {
  answer: string;
  changed: boolean;
  rounds: number;
  passed: boolean;
  status: "pass" | "fail" | "unverified";
  evidence?: string;
  artifactProbeStatus: "not_requested" | "not_applicable" | "pass" | "fail" | "unverified" | "error";
  artifactProbeCount: number;
  escalated: boolean;
  unverified: boolean;
}

/** Structural result shape of runDeliverableConsistencyGate (declared locally). */
interface DeliverableConsistencyGateResult {
  answer: string;
  changed: boolean;
  rounds: number;
  passed: boolean;
}

/**
 * Explicit dependency carrier for the terminal guard run. Read-only fields are stable for
 * the (no-tool-calls) tail of the turn; getter callbacks read live mutable / late-bound
 * turn state; the mutation callbacks and the shared guardrailEvents array write turn state
 * back through the same references the inline span used; the function callbacks are
 * runtime-private helpers / closures that cannot be imported here.
 */
export interface TerminalGuardContext {
  // --- read-only, stable for the tail of the turn ---
  readonly signal: AbortSignal;
  readonly session: AgentSession;
  readonly provider: ChatProvider;
  readonly userMessage: string;
  readonly toolContext: ToolContext;
  readonly deliverableIntent: DeliverableIntent;
  readonly initialDynamicGuidance: DynamicTurnGuidance | null;

  /** The finalized raw model draft entering this run (only .length is read, in audits). */
  readonly rawResponse: string;
  readonly iterationCount: number;
  readonly effectiveToolIterations: number;
  readonly terminalFinishReason: string;
  readonly toolCallsRequested: number;

  /**
   * True on the max-iterations backstop path, where `rawResponse` is a message
   * the runtime already CONSTRUCTED from gathered evidence (corrective build /
   * evidence-gathered fallback) rather than a raw model draft. That construction
   * IS the evidence recovery, so the two draft-recovery stages below must not
   * re-run synthesis on it — but every downstream check (citation honesty, the QA
   * delivery gate, deliverable consistency, redaction, the honesty banner) still
   * applies. Default/undefined = normal path = recovery stages active.
   */
  readonly skipDraftRecovery?: boolean;

  // --- turn-state signals, read-only within this run ---
  readonly currentTurnHasExecutableOrchestration: boolean;
  readonly forcedSynthesisFired: boolean;
  readonly consecutiveDelegationFailures: number;
  readonly turnToolCallCounts: Map<string, number>;
  readonly turnShareFindingCount: number;
  readonly workflowRunCompletedThisTurn: boolean;
  readonly releasedWithoutResearchEvidence: boolean;
  readonly autoResearchAnswer: string | null;

  // --- output guardrail scan result (precomputed on rawResponse, read back for redaction) ---
  readonly outputScan: ReturnType<typeof scanOutput>;

  // --- live reads of mutable / latched turn state ---
  getTurnDelegationCount: () => number;
  getQaCorrectiveBuildUsed: () => boolean;
  /** Mutable terminal-quality facts consumed by the centralized turn scorecard. */
  scorecardSignals?: TurnQualitySignals;

  // --- per-turn delegation counter mutation (qaEscalate + corrective closures share it) ---
  incrementDelegationCount: () => void;

  // --- guardrail events array — appended to in place (mutated), mirroring the inline span ---
  guardrailEvents: Array<{ type: string; details: string }>;

  // --- runtime-private helpers / closures (passed as callbacks, never imported) ---
  finalizeUserFacingAssistantResponse: (
    rawResponse: string,
    toolIterations: number,
    session: AgentSession,
    provider: ChatProvider,
    signal: AbortSignal,
  ) => Promise<string>;
  forceSynthesis: (session: AgentSession, provider: ChatProvider, signal: AbortSignal, instruction: string) => Promise<string | null>;
  collectTurnArtifactAttachments: (session: AgentSession) => Array<Record<string, unknown>>;
  runQaDeliveryGate: (
    session: AgentSession,
    provider: ChatProvider,
    signal: AbortSignal,
    answer: string,
    criteria: string[],
    maxRounds: number,
    escalate?: (current: string, flaws: string, crit: string[]) => Promise<string | null>,
    requireEvidence?: boolean,
  ) => Promise<QaDeliveryGateResult>;
  runDeliverableConsistencyGate: (
    session: AgentSession,
    provider: ChatProvider,
    signal: AbortSignal,
    answer: string,
    userStatements: string,
    maxRounds: number,
  ) => Promise<DeliverableConsistencyGateResult>;
  runCorrectiveBuild: (buildContext: string) => Promise<string | null>;
  runCorrectiveReroute: () => Promise<string | null>;
  logWarn: (obj: Record<string, unknown>, msg: string) => void;
}

/**
 * Run the terminal response-guard sequence and return the corrected, user-facing answer.
 * `ctx.guardrailEvents` is appended in place and `ctx.incrementDelegationCount()` bumps the
 * shared per-turn counter, exactly as the inline original did — so the caller reads that
 * mutated state back after the call. Every branch, condition, audit event, severity, and the
 * ordering are the inline span moved verbatim (only enclosing free-var reads became ctx.x).
 */
export async function applyTerminalResponseGuards(ctx: TerminalGuardContext): Promise<string> {
  const { signal, session, provider, userMessage, toolContext, deliverableIntent, initialDynamicGuidance, guardrailEvents } = ctx;
  const { rawResponse, iterationCount, effectiveToolIterations, terminalFinishReason, toolCallsRequested } = ctx;
  const { currentTurnHasExecutableOrchestration } = ctx;

  let finalResponse = await ctx.finalizeUserFacingAssistantResponse(rawResponse, effectiveToolIterations, session, provider, signal);

  // General shared-facts synthesis backstop — fires for ALL turns (not just source-sensitive)
  // when the final response looks like a raw dump or is suspiciously short after orchestration
  // ran. The source-sensitive path below handles `sourceSensitive` cases; this catches the
  // general research case (BOM, hardware design, multi-source comparison, etc.) where the
  // researcher gathered good shared facts but forceSynthesis timed out or the model echoed
  // raw auto_xxx_yyy key names instead of synthesizing them into prose.
  if (
    !ctx.skipDraftRecovery
    && currentTurnHasExecutableOrchestration
    && !initialDynamicGuidance?.sourceSensitive
    && (
      looksLikeRawSharedFactsDump(finalResponse)
      || looksLikeOrchestrationOnlyEvidence(finalResponse)
      || (ctx.forcedSynthesisFired && finalResponse.length < 600)
    )
  ) {
    const sharedFactsEvidence = await getSharedFactsEvidenceForFinalSynthesis(session.id, 6_000);
    const delegateEvidence = findRecentDelegateEvidence(session.getHistory());
    const recoveryEvidence = chooseBetterRecoveryEvidence(delegateEvidence, sharedFactsEvidence, { preferHigherScore: true });
    if (recoveryEvidence && !looksLikeWeakRecoveryEvidence(recoveryEvidence.evidence)) {
      const synthesized = await ctx.forceSynthesis(
        session,
        provider,
        signal,
        "Research specialists have gathered findings during this turn. Synthesize all [SHARED FINDINGS AVAILABLE] entries and the recovered evidence below into a complete, well-structured answer in the user's language.\n"
        + "Do NOT echo raw key names (e.g. auto_xxx_yyy). Convert every finding into readable, user-facing prose.\n"
        + "Recovered evidence:\n" + recoveryEvidence.evidence.slice(0, 5_000),
      );
      const candidateResponse = synthesized && sanitizeUserFacingAssistantResponse(synthesized, 0);
      if (candidateResponse && candidateResponse.length > finalResponse.length) {
        finalResponse = candidateResponse;
        logAudit("guardrail_flagged", {
          type: "general_shared_facts_synthesis_backstop",
          evidenceLength: recoveryEvidence.evidence.length,
          evidenceItems: recoveryEvidence.itemCount,
          originalLength: rawResponse.length,
          synthesizedLength: finalResponse.length,
        }, { sessionId: session.id, channel: session.channel, severity: "warn" });
      } else {
        // Synthesis still failed or was too short — format the evidence at minimum
        finalResponse = formatRecoveryEvidenceForFinalUser(recoveryEvidence.evidence);
        logAudit("guardrail_flagged", {
          type: "general_shared_facts_format_backstop",
          evidenceLength: recoveryEvidence.evidence.length,
          evidenceItems: recoveryEvidence.itemCount,
        }, { sessionId: session.id, channel: session.channel, severity: "warn" });
      }
    }
  }

  // De-lexicalized restoration (orchestration.failedResearchHonestyBackstop, default off): this
  // used to gate on initialDynamicGuidance?.sourceSensitive (now hardwired false). Re-armed from
  // STRUCTURAL failure-signals only — real orchestration ran this turn AND it forced synthesis /
  // a delegation failed / a partial delegation was detected. No keywords, no topic classification.
  if (
    !ctx.skipDraftRecovery
    && getConfig().orchestration?.failedResearchHonestyBackstop === true
    && currentTurnHasExecutableOrchestration
    && (
      ctx.forcedSynthesisFired
      || ctx.consecutiveDelegationFailures > 0
      || hasRecentSourceSensitivePartialDelegation(session.getHistory())
    )
  ) {
    const delegateEvidence = findRecentDelegateEvidence(session.getHistory());
    const sharedFactsEvidence = await getSharedFactsEvidenceForFinalSynthesis(session.id);
    const recoveryEvidence = chooseBetterRecoveryEvidence(delegateEvidence, sharedFactsEvidence);
    if (recoveryEvidence) {
      const finalResponseAnchored = looksEvidenceAnchored(stripPresentationFormatting(finalResponse), recoveryEvidence.evidence, getConfig().orchestration?.evidenceAnchoringLengthScaled === true);
      const finalResponseTransparent = looksLikeTransparentIncompleteReport(finalResponse);
      if (!finalResponseAnchored || !finalResponseTransparent) {
        finalResponse = await synthesizeSourceSensitiveEvidenceBackstop(session, provider, signal, recoveryEvidence.evidence)
          ?? formatSourceSensitiveEvidenceBackstop(recoveryEvidence.evidence);
        logAudit("guardrail_flagged", {
          type: "source_sensitive_failed_delegation_evidence_backstop",
          evidenceLength: recoveryEvidence.evidence.length,
          evidenceItems: recoveryEvidence.itemCount,
          originalLength: rawResponse.length,
          finalResponseAnchored,
          finalResponseTransparent,
        }, { sessionId: session.id, severity: "warn" });
      }
    } else if (!looksLikeTransparentIncompleteReport(finalResponse) || looksLikeUnsourcedSpecificClaims(finalResponse)) {
      // Mirror the two-factor logic of the recovery-evidence branch above: a single common word
      // ("failed", "attempted", "unable") must NOT alone mark an answer "transparent" and skip the
      // honest block — a from-memory fabrication that name-drops one while still dumping a dense
      // cluster of unsourced specifics (looksLikeUnsourcedSpecificClaims: ≥4 fact-shape tokens over
      // ≥2 categories) is exactly what must be blocked here.
      finalResponse = [
        "Research did not complete this run before verifiable source/tool evidence was gathered.",
        "I will not state the requested specifics — names, numbers, dates, sources, or claims — without inventing facts, so I am leaving them out.",
        "Please re-run the research, or narrow the scope, so a specialist can gather real evidence.",
        "",
        "Die Recherche ist in diesem Lauf fehlgeschlagen, bevor belastbare Evidenz vorlag — ich stelle die angefragten Detailangaben daher nicht auf, ohne Fakten zu erfinden. Bitte starte die Recherche erneut oder reduziere den Umfang.",
      ].join("\n\n");
      logAudit("guardrail_flagged", {
        type: "source_sensitive_final_answer_without_evidence_blocked",
        originalLength: rawResponse.length,
      }, { sessionId: session.id, severity: "warn" });
    }
  }

  // Auto-research synthesis (source-sensitive refusal): the model refused to
  // delegate, so the runtime ran a research specialist above and synthesized from
  // the gathered findings — that grounded answer replaces the training-data draft.
  if (ctx.autoResearchAnswer) {
    finalResponse = ctx.autoResearchAnswer;
  }

  // Anti-hallucination caveat: a source-sensitive answer that shipped with
  // NO research evidence (model declined to delegate) gets an explicit
  // unverified banner so pre-assumptions aren't read as confirmed facts.
  // Only for substantial answers — a short "it depends" needs no banner.
  if (ctx.releasedWithoutResearchEvidence && finalResponse.trim().length > 400) {
    finalResponse = prependUnverifiedSourceCaveat(finalResponse, userMessage);
    guardrailEvents.push({ type: "guardrail_flagged", details: "unverified_source_sensitive_answer_caveated" });
    logAudit("guardrail_flagged", {
      type: "unverified_source_sensitive_answer_caveated",
      sourceSensitive: initialDynamicGuidance?.sourceSensitive ?? false,
      freshnessSensitive: initialDynamicGuidance?.freshnessSensitive ?? false,
    }, { sessionId: session.id, severity: "warn" });
  }

  // Citation-honesty guard (orchestration.citationHonestyGuard) — extracted verbatim to
  // agent/turn-terminal-guards.ts (god-file seam). FULLY STRUCTURAL: strips fabricated URL
  // citations + prepends the honest unverified caveat when the answer carries URLs but no
  // real web/research execution ran this turn. See that module for the full rationale.
  ({ finalResponse } = await applyCitationHonestyGuard({
    finalResponse,
    userMessage,
    sessionId: session.id,
    turnToolCallCounts: ctx.turnToolCallCounts,
    turnDelegationCount: ctx.getTurnDelegationCount(),
    workflowRunCompletedThisTurn: ctx.workflowRunCompletedThisTurn,
    turnShareFindingCount: ctx.turnShareFindingCount,
    guardrailEvents,
  }));

  // False-completion guard: the turn asked to CREATE or MODIFY an artifact, produced
  // NO artifact this turn (no build delegation surfaced an attachment, no workspace
  // write), yet the answer claims it created/updated/inserted the artifact — ship an
  // honest status instead of the false success (audit 14661623 turn 2: gathered image
  // URLs via one search, never rebuilt the deck, but answered "Die Bilder wurden
  // eingefügt … URLs überprüft"). The three AND-conditions keep real builds (an artifact
  // was produced → skipped) and report-only turns (no claim → skipped) untouched;
  // topic-agnostic. Runs for ALL backends, not only source-sensitive ones.
  const artifactClaimUnbacked = claimsArtifactWrittenButUnproduced(finalResponse);
  const staleArtifactReplay = !artifactClaimUnbacked
    && looksLikeRegurgitatedPriorAnswer(finalResponse, session.getHistory());
  if (
    deliverableIntent.wantsArtifactMutation
    && ctx.collectTurnArtifactAttachments(session).length === 0
    && (artifactClaimUnbacked || staleArtifactReplay)
  ) {
    logAudit("guardrail_flagged", {
      type: "artifact_completion_claim_unbacked_suppressed",
      reason: staleArtifactReplay ? "stale_prior_answer_replayed_on_failed_build" : "false_completion_claim",
      finishReason: terminalFinishReason,
      answerLength: finalResponse.length,
    }, { sessionId: session.id, channel: session.channel, severity: "warn" });
    const honest = await ctx.forceSynthesis(
      session, provider, signal,
      "Your draft claims the requested file/presentation/document was created, updated, inserted, or embedded — OR it re-pastes an earlier turn's answer almost verbatim — but NOTHING was actually written to the workspace in THIS turn (no file was produced). Do NOT claim it was created or changed and do NOT re-post a previous turn's answer as if this turn's request were done. "
      + "Reply briefly and honestly IN THE USER'S LANGUAGE: state plainly that the artifact was NOT created or modified this turn, summarize what you actually DID (e.g. gathered/listed information), and offer to have the content specialist build or update the file now. Do NOT invent a file path and do NOT restate a success you cannot point to in this turn's own results.",
    );
    const candidate = honest ? sanitizeUserFacingAssistantResponse(honest, iterationCount) : null;
    finalResponse = (candidate && candidate.trim().length >= 40
      && !claimsArtifactWrittenButUnproduced(candidate)
      && !looksLikeRegurgitatedPriorAnswer(candidate, session.getHistory()))
      ? candidate
      : "Ich habe die angeforderte Datei in diesem Schritt **nicht** erstellt oder geändert — ich habe nur die angefragten Informationen gesammelt. Bestätige kurz, dann lasse ich den passenden Spezialisten die Datei jetzt damit bauen bzw. aktualisieren.\n\nI did **not** create or modify the requested file in this turn — I only gathered the requested information. Confirm and I'll have the right specialist build or update it now.";
  }

  // Tracks whether an ACCEPTANCE-CRITERIA QA check actually ran this turn (the
  // riskGatedQA criteria-verify or the qaDeliveryLoop) — those fold a consistency check
  // in, so the plan-less deliverable-consistency gate below skips when one did, avoiding
  // a redundant slow-model call. NOT set by the evidence-anchoring path (that checks
  // grounding, not internal consistency), so source-sensitive plan-less turns still get
  // the consistency gate.
  let acceptanceCriteriaQaRan = false;

  // Risk-gated auto-verify QA gate: for high-stakes turns that recorded a
  // plan with acceptance criteria, check the answer against those criteria
  // and repair if it falls short. Source-sensitive turns were already
  // anchored by the evidence backstop above, so they skip the redundant
  // verify call. Low-stakes / chat turns skip QA entirely.
  if (effectiveOrchestration().riskGatedQA) {
    const qaPlan = await loadTurnPlan(session.id);
    const invokedApprovalGatedTool = [...ctx.turnToolCallCounts.keys()].some(requiresApproval);
    const risk = classifyTurnRisk({
      planRiskTier: qaPlan?.riskTier,
      sourceSensitive: initialDynamicGuidance?.sourceSensitive ?? false,
      freshnessSensitive: initialDynamicGuidance?.freshnessSensitive ?? false,
      invokedApprovalGatedTool,
    });
    // Universal grounding gate (orchestration.evidenceAnchoringOnGatheredEvidence, default off).
    // A turn that delegated SUCCESSFULLY can still ship a training-data answer while the verified
    // findings sit unused in shared facts (audit fe496ec5: fabricated news bulletin). The de-lex
    // hardwired the old sourceSensitive/freshnessSensitive gate off, killing this. Re-arm on PURELY
    // STRUCTURAL turn-state — real orchestration ran this turn AND produced curated shared facts the
    // answer does not reference (the cheap deterministic answerNeedsEvidenceAnchoringRepair, evidence-
    // token overlap; no keyword table, no sourceSensitive read). Runs independent of the plan-derived
    // risk tier so a plan-less research turn is covered; when off, control falls through to the
    // acceptance-criteria arm exactly as before.
    const realOrchestrationRan = ctx.getTurnDelegationCount() > 0 || ctx.workflowRunCompletedThisTurn;
    const anchorEvidence = (
      getConfig().orchestration?.evidenceAnchoringOnGatheredEvidence === true
      && effectiveOrchestration().qaEvidenceAnchoring
      && realOrchestrationRan
      && !signal.aborted
    )
      ? await getSharedFactsEvidenceForFinalSynthesis(session.id)
      : null;
    let evidenceAnchoringRepairRan = false;
    if (anchorEvidence && (anchorEvidence.itemCount ?? 0) > 0 && answerNeedsEvidenceAnchoringRepair(finalResponse, anchorEvidence.evidence, getConfig().orchestration?.evidenceAnchoringLengthScaled === true)) {
      evidenceAnchoringRepairRan = true;
      const anchorInstruction = [
        "EVIDENCE-ANCHORING REPAIR:",
        "Your previous answer did not reference the verified findings this run gathered. Re-write the answer so it is grounded in the findings below, in the SAME language as the user's request.",
        "Use ONLY these findings plus this conversation's tool results. Do not invent any specifics — names, numbers, dates, sources, or claims — beyond them. Mark anything the findings do not support as unverified/incomplete.",
        "Keep it a concise, useful answer — do not dump raw tool traces or page snapshots.",
        "Verified findings:",
        anchorEvidence.evidence.trim(),
      ].join("\n");
      const reanchored = await ctx.forceSynthesis(session, provider, signal, anchorInstruction);
      const candidate = reanchored ? sanitizeUserFacingAssistantResponse(reanchored, 0) : null;
      if (
        candidate
        && candidate.trim().length >= Math.min(200, Math.floor(finalResponse.trim().length * 0.5))
        && looksEvidenceAnchored(stripPresentationFormatting(candidate), anchorEvidence.evidence, getConfig().orchestration?.evidenceAnchoringLengthScaled === true)
      ) {
        finalResponse = candidate;
        guardrailEvents.push({ type: "guardrail_flagged", details: "qa_evidence_anchoring_repaired" });
        logAudit("flow_verification_repaired", { reason: "unanchored_to_shared_findings", evidenceItems: anchorEvidence.itemCount }, { sessionId: session.id, severity: "warn" });
      } else {
        logAudit("flow_high_stakes_unverified", { reason: "answer_unanchored_repair_failed", evidenceItems: anchorEvidence.itemCount }, { sessionId: session.id, severity: "warn" });
      }
    }

    if (risk === "high" && !evidenceAnchoringRepairRan) {
      if (qaPlan && qaPlan.acceptanceCriteria.length > 0 && finalResponse.trim().length > 200 && !signal.aborted) {
        acceptanceCriteriaQaRan = true;
        const verifyInstruction = "Before finalizing, verify your answer meets ALL of these acceptance criteria for the user's task:\n"
          + qaPlan.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")
          + "\nIf every criterion is met and every claim is grounded in this conversation's tool results and shared findings, return the SAME answer. "
          + "If a criterion is unmet or a claim is unsupported, return a corrected answer that fixes the gap or transparently marks what could not be verified. Do not add unsupported claims.";
        const verified = await ctx.forceSynthesis(session, provider, signal, verifyInstruction);
        const candidate = verified ? sanitizeUserFacingAssistantResponse(verified, 0) : null;
        // Guard against catastrophic truncation — a legitimate repair may
        // shorten the answer (dropping unsupported claims), so allow down to
        // half the length but never accept a stub.
        if (candidate && candidate.trim().length >= Math.min(200, Math.floor(finalResponse.trim().length * 0.5))) {
          const repaired = candidate.trim() !== finalResponse.trim();
          finalResponse = candidate;
          logAudit(repaired ? "flow_verification_repaired" : "flow_verification_passed",
            { acceptanceCriteria: qaPlan.acceptanceCriteria.length, repaired },
            { sessionId: session.id, severity: repaired ? "warn" : "info" });
          if (repaired) guardrailEvents.push({ type: "guardrail_flagged", details: "risk_gated_qa_repaired" });
        } else {
          logAudit("flow_verification_passed", { reason: "verify_produced_no_better_candidate" }, { sessionId: session.id, severity: "info" });
        }
      } else {
        logAudit("flow_high_stakes_unverified", { reason: qaPlan ? "no_acceptance_criteria" : "no_plan", invokedApprovalGatedTool }, { sessionId: session.id, severity: "info" });
      }
    }
  }

  // Final QA delivery gate (staged orchestration — docs/staged-orchestration.md):
  // loop back to IMPROVE the answer against the plan's acceptance criteria until a
  // QA check passes or the round budget is spent — the "send it back to the
  // coordinator until the QA agent says it's fine" stage. Runs AFTER the one-shot
  // riskGatedQA repair above and BEFORE the downstream safety guards (redaction,
  // fabrication/honesty banners) so an improved answer is re-validated by them.
  // Flag-gated default-off and a no-op without a plan+criteria, so chat / plan-less
  // turns are unaffected; fails open (never blocks delivery).
  if (effectiveOrchestration().qaDeliveryLoop && !signal.aborted && finalResponse.trim().length > 200) {
    const dlPlan = await loadTurnPlan(session.id);
    const criteria = dlPlan?.acceptanceCriteria ?? [];
    if (criteria.length > 0) {
      acceptanceCriteriaQaRan = true;
      // Coordinator escalation (orchestration.qaDeliveryLoopEscalateToCoordinator):
      // when a cheap re-synthesis round has already failed the re-check, the gap
      // needs NEW work, not a rewrite — hand the flaws to the coordinator to make a
      // plan and execute it. Reuses the established post-loop delegation path; the
      // built artifact (if any) surfaces via the recorded assistant+tool pair.
      const qaEscalate = effectiveOrchestration().qaDeliveryLoopEscalateToCoordinator
        ? async (current: string, flaws: string, crit: string[]): Promise<string | null> => {
            if (signal.aborted) return null;
            const task = "QA RE-PLAN — the delivered answer STILL fails these acceptance criteria after a rewrite, "
              + "which means the gap needs real work, not re-wording. Make a focused plan to fix EXACTLY these flaws "
              + "and execute it (re-research or re-build as needed), then return the COMPLETE corrected deliverable in "
              + "the user's language. Ground every claim in tool results; do not fabricate to satisfy a criterion — if "
              + "something genuinely cannot be verified, say so.\n\nUnmet criteria / flaws:\n" + flaws
              + "\n\nAcceptance criteria:\n" + crit.map((c, i) => `${i + 1}. ${c}`).join("\n")
              + "\n\nCurrent answer to improve:\n" + current.slice(0, 6_000);
            try {
              const res = await executeTool("delegate_to_agent", {
                agentName: "mission_coordinator",
                task,
              }, { ...toolContext, allowDelegationAfterOperatorStop: true });
              ctx.incrementDelegationCount();
              // Record the delegation so any artifact the coordinator built surfaces as
              // a download and history stays valid (mirrors the corrective-build path).
              const callId = `qaescalate_${Date.now().toString(36)}`;
              session.addMessage({
                role: "assistant", content: "",
                tool_calls: [{ id: callId, type: "function", function: { name: "delegate_to_agent", arguments: JSON.stringify({ agentName: "mission_coordinator", task: "QA RE-PLAN (coordinator escalation)" }) } }],
              });
              session.addMessage({
                role: "tool",
                content: (res.success ? res.output : (res.error?.trim() ? `Error: ${res.error}` : res.output)).slice(0, 4_000),
                tool_call_id: callId, metadata: res.metadata,
              });
              if (!res.success) return null;
              const candidate = sanitizeUserFacingAssistantResponse(res.output, 0);
              // Reject a catastrophic shrink (a short "I built X" summary must not replace a long answer).
              if (candidate.trim().length < Math.min(200, Math.floor(current.trim().length * 0.5))) return null;
              return candidate;
            } catch (err) {
              ctx.logWarn({ err, sessionId: session.id }, "QA delivery coordinator escalation failed");
              return null;
            }
          }
        : undefined;
      const gate = await timedPhase("qaDeliveryLoop", () => ctx.runQaDeliveryGate(
        session, provider, signal, finalResponse, criteria,
        effectiveOrchestration().qaDeliveryLoopMaxRounds,
        qaEscalate,
        effectiveOrchestration().qaEvidenceRequired,
      ));
      if (gate.changed) {
        finalResponse = gate.answer;
        // The precomputed outputScan only covered the original raw response — re-run
        // the cheap deterministic secret scan on the improved text before it ships.
        const rescan = scanOutput(finalResponse);
        if (!rescan.safe && rescan.redacted) {
          finalResponse = rescan.redacted;
          guardrailEvents.push({ type: "output_redacted", details: (rescan.detectedTypes ?? []).join(", ") });
        }
        guardrailEvents.push({ type: "guardrail_flagged", details: gate.escalated ? "qa_delivery_loop_escalated" : "qa_delivery_loop_improved" });
      }
      // No-PASS-without-evidence (orchestration.qaEvidenceRequired): the answer PASSED but the
      // reviewer cited no verifiable ground — ship it (fail-open preserved) with an honesty
      // caveat rather than presenting it as QA-confirmed. Runs after any improve()/redaction.
      if (gate.unverified) {
        finalResponse = prependUnverifiedQaCaveat(finalResponse);
        guardrailEvents.push({ type: "guardrail_flagged", details: "qa_delivery_loop_unverified" });
      }
      if (ctx.scorecardSignals) {
        ctx.scorecardSignals.criteriaTotal = criteria.length;
        ctx.scorecardSignals.criteriaCovered = gate.status === "pass" ? criteria.length : null;
        ctx.scorecardSignals.qaStatus = gate.status;
        ctx.scorecardSignals.qaRounds = gate.rounds;
        ctx.scorecardSignals.qaEvidencePresent = Boolean(gate.evidence);
        ctx.scorecardSignals.artifactProbeStatus = gate.artifactProbeStatus;
        ctx.scorecardSignals.artifactProbeCount = gate.artifactProbeCount;
      }
      logAudit("flow_verification_passed", {
        reason: "qa_delivery_loop",
        rounds: gate.rounds,
        passed: gate.passed,
        status: gate.status,
        ...(gate.evidence ? { qaEvidence: gate.evidence } : {}),
        unverified: gate.unverified,
        improved: gate.changed,
        escalated: gate.escalated,
        acceptanceCriteria: criteria.length,
      }, { sessionId: session.id, severity: gate.changed || gate.unverified ? "warn" : "info" });
    }
  }

  // A downstream guard that REPLACES the answer after the QA gate ran invalidates the
  // latched QA signals: the scorecard must not describe text QA never saw. Downgrade to
  // unverified rather than clearing — QA did run, but its verdict no longer applies.
  const invalidateQaSignals = (): void => {
    if (ctx.scorecardSignals && ctx.scorecardSignals.qaStatus !== "not_run") {
      ctx.scorecardSignals.qaStatus = "unverified";
      ctx.scorecardSignals.qaEvidencePresent = false;
      ctx.scorecardSignals.criteriaCovered = null;
    }
  };

  // Deliverable self-consistency gate (audit 17f53ed0): plan-less deliverable turns get
  // NO acceptance-criteria QA, so an internally inconsistent answer ships — a price quote
  // recommending 10k for ~10 weeks while itself stating a 90–120 €/h market rate (≈37 €/h),
  // which the user had to correct three times. For a substantive deliverable the
  // acceptance-criteria gates did NOT cover, run one bounded check: do the answer's own
  // figures/arithmetic cohere and contradict nothing the user explicitly stated? Concrete
  // contradictions → a fix-only repair. Structural trigger (length + no acceptance-criteria
  // QA), fails open, flag-gated default-off (one extra synthesis-tier call per plan-less
  // deliverable on the slow local model). Runs BEFORE the downstream safety guards so the
  // repaired text is re-scanned/re-validated by them.
  if (
    shouldCheckDeliverableConsistency({
      enabled: effectiveOrchestration().deliverableConsistencyQa,
      aborted: signal.aborted,
      finalResponse,
      acceptanceCriteriaQaRan,
      delegationCount: ctx.getTurnDelegationCount(),
    })
  ) {
    const userStatements = collectUserStatements(session.getHistory(), 2000);
    const gate = await ctx.runDeliverableConsistencyGate(
      session, provider, signal, finalResponse, userStatements,
      effectiveOrchestration().deliverableConsistencyQaMaxRounds,
    );
    if (gate.changed) {
      finalResponse = gate.answer;
      invalidateQaSignals();
      // The precomputed outputScan only covered the original response — re-run the cheap
      // deterministic secret scan on the corrected text before it ships.
      const rescan = scanOutput(finalResponse);
      if (!rescan.safe && rescan.redacted) {
        finalResponse = rescan.redacted;
        guardrailEvents.push({ type: "output_redacted", details: (rescan.detectedTypes ?? []).join(", ") });
      }
      guardrailEvents.push({ type: "guardrail_flagged", details: "deliverable_consistency_repaired" });
    }
    logAudit(gate.changed ? "deliverable_consistency_repaired" : "deliverable_consistency_passed",
      { rounds: gate.rounds, passed: gate.passed, repaired: gate.changed },
      { sessionId: session.id, severity: gate.changed ? "warn" : "info" });
  }

  // Completion QA gate (normal-stop path): the user asked to BUILD an interactive/served
  // app, the model finished a turn (finishReason stop) describing a CONCEPT, but no real
  // Unfilled markers or a page that does not run, read straight off disk — the same evidence
  // the sub-agent's own resume detection uses, so the corrective build it triggers arrives in
  // repair mode with the fault named rather than starting over.
  const turnLeftAnIncompleteArtifact = (workspacePath: string): boolean => {
    try {
      if (findUnfilledStubFiles(workspacePath).count > 0) return true;
      return findBrokenBuiltPages(workspacePath).length > 0;
    } catch {
      return false;   // a scan failure must never manufacture a rebuild
    }
  };

  // artifact was produced → run ONE corrective build and ship the built app instead of the
  // description. Scoped to app/served deliverables (web_coder/backend_coder) so plain
  // reports/decks the model already wrote inline still ship as-is. Bounded by the shared
  // qaCorrectiveBuildUsed latch. (The forced-terminal path has its own build gate above.)
  if (
    effectiveOrchestration().finalResponseQaGate
    && !ctx.getQaCorrectiveBuildUsed()
    && !signal.aborted
    && deliverableIntent.wantsArtifact
    && deliverableIntent.isAppBuild
    && (
      ctx.collectTurnArtifactAttachments(session).length === 0
      // AN ARTIFACT THAT EXISTS BUT DOES NOT WORK NEEDS THE BUILD JUST AS MUCH.
      //
      // This gate asked only "was an artifact produced", because it was written for the
      // model that DESCRIBES an app instead of building one. The clean-slate validation run
      // hit the other shape: a real 20 KB artifact with two subsystems unwritten, failing its
      // probe and its QA gate — and because a file existed, the one mechanism that could have
      // finished it was skipped, and the turn shipped a partial with an honest apology.
      //
      // The QA loop cannot close this itself: its improve() rewrites the ANSWER, never the
      // file. Only a build can fix a build, and the evidence for needing one is on disk.
      || turnLeftAnIncompleteArtifact(session.getWorkspacePath())
    )
  ) {
    const factsCtx = initialDynamicGuidance?.sourceSensitive
      ? ((await getSharedFactsEvidenceForFinalSynthesis(session.id))?.evidence ?? "")
      : "";
    // A source-sensitive build still needs gathered facts (don't build from nothing).
    if (!initialDynamicGuidance?.sourceSensitive || factsCtx.trim().length > 0) {
      const built = await ctx.runCorrectiveBuild(factsCtx);
      if (built) {
        finalResponse = built;
        invalidateQaSignals();
        guardrailEvents.push({ type: "guardrail_flagged", details: "final_qa_corrective_build_normal_path" });
      }
    }
  }

  // Rescan the CURRENT finalResponse, not the precomputed raw outputScan: synthesis / QA loop /
  // backstop / corrective-build may have rewritten the text since it was scanned, so reusing
  // outputScan.redacted would (a) REVERT every improvement to the redacted RAW draft and (b) MISS
  // a secret a late guard introduced (the raw scan never saw it). Matches the local rescans above.
  const finalScan = scanOutput(finalResponse);
  if (!finalScan.safe && finalScan.redacted) {
    finalResponse = finalScan.redacted;
    guardrailEvents.push({ type: "output_redacted", details: (finalScan.detectedTypes ?? []).join(", ") });
    logAudit("output_redacted", { types: finalScan.detectedTypes }, { sessionId: session.id, severity: "warn" });
  }

  // Zero-work fabrication guard (audit 45d5bae9): a turn that requested NO tool
  // calls and produced NO artifact cannot have built or served anything — yet the
  // slow model sometimes "answers" a build request by FABRICATING a finished
  // deliverable outright: inventing a serve URL (/api/app/3807), a workspace
  // download link, or an "Ich habe die Plattform gebaut" claim, with zero work
  // behind it. This is the worst false-completion (no draft, no file, a link that
  // 404s). Detect it deterministically (no model call) off the conclusive signals —
  // a tool-only link in a zero-tool turn, or a completion claim in a zero-tool/
  // zero-artifact turn — and REPLACE the fabrication (its content is invented, so
  // nothing is worth preserving) with an honest offer to build it for real. Runs
  // before the build-timeout banner so the two never double-process.
  // Third trigger shape (audit 3b7d59a8): the model HAND-WRITES the whole app as an
  // inline HTML document with zero tools — usually truncated by the completion cap
  // (11.4KB, finishReason "length", dead mid-CSS). The runaway_inline_artifact flag
  // is observability-only; THIS is where it gets rerouted into a real build. Scoped
  // to app/artifact-shaped requests so a full-document answer to a genuine "show me
  // the HTML inline" ask in hybrid mode isn't converted against the user's wishes.
  const inlinedAppDocumentInsteadOfBuild =
    (deliverableIntent.isAppBuild || deliverableIntent.wantsArtifact)
    && looksLikeInlinedAppDocument(finalResponse);
  // The completion-claim detector reads only the ANSWER's wording, so scope it to
  // requests that name an artifact at all (noun/filename, no verb needed — the
  // need-phrased audit-13523d73 shape stays covered via mentionsArtifact/isAppBuild).
  // Without this, a plain lookup question gets its answer suppressed over the
  // answer's own phrasing and rerouted into a nonsensical corrective build
  // (session 24826c33: "Schau mal ob ich neue Emails habe" shipped the canned
  // "Der Bau der angeforderten Datei ist fehlgeschlagen" reply). The fabricated
  // tool-link detector stays unscoped: a tool-minted URL is conclusive on any turn.
  const requestIsArtifactShaped =
    deliverableIntent.mentionsArtifact
    || deliverableIntent.wantsArtifactMutation
    || deliverableIntent.isAppBuild;
  if (
    toolCallsRequested === 0
    && ctx.collectTurnArtifactAttachments(session).length === 0
    && (looksLikeFabricatedToolDeliveryLink(finalResponse)
      || (requestIsArtifactShaped && claimsArtifactWrittenButUnproduced(finalResponse))
      || inlinedAppDocumentInsteadOfBuild)
  ) {
    logAudit("guardrail_flagged", {
      type: "fabricated_zero_work_delivery_suppressed",
      hadFabricatedLink: looksLikeFabricatedToolDeliveryLink(finalResponse),
      hadInlinedAppDocument: inlinedAppDocumentInsteadOfBuild,
      answerLength: finalResponse.length,
    }, { sessionId: session.id, channel: session.channel, severity: "warn" });
    guardrailEvents.push({ type: "guardrail_flagged", details: "fabricated_zero_work_delivery_suppressed" });
    // The model FABRICATED a finished deliverable with zero work. When the REQUEST is
    // artifact-shaped, honor the model's own build judgement: actually build it now
    // (one bounded corrective build) instead of only denying. This turns a useless
    // "I built nothing, confirm" first-turn answer into the real app (audit 13523d73:
    // a fresh "brauche eine Lernplattform … Fragekatalog … multiple-choice" turn
    // fabricated "…erstellt" with 0 tools — the user wants the app, not a denial).
    // Keys off the model's own fabrication, so no brittle need-verb routing keyword is
    // required. When the request is NOT artifact-shaped (only the fabricated-link
    // signal can get here then), a build would be nonsense — re-route the original
    // request to a specialist instead. Gated behind finalResponseQaGate + the
    // qaCorrectiveBuildUsed latch (runCorrectiveBuild self-guards re-entry); a
    // source-sensitive turn still needs gathered facts. Falls back to the honest
    // message only when the build/reroute produces nothing.
    let fabricationCorrectiveBuild: string | null = null;
    let fabricationBuildAttempted = false;
    let fabricationReroute: string | null = null;
    let fabricationRerouteAttempted = false;
    if (
      effectiveOrchestration().finalResponseQaGate
      && !ctx.getQaCorrectiveBuildUsed()
      && !signal.aborted
    ) {
      if (requestIsArtifactShaped) {
        const factsCtx = initialDynamicGuidance?.sourceSensitive
          ? ((await getSharedFactsEvidenceForFinalSynthesis(session.id))?.evidence ?? "")
          : "";
        if (!initialDynamicGuidance?.sourceSensitive || factsCtx.trim().length > 0) {
          fabricationBuildAttempted = true;
          fabricationCorrectiveBuild = await ctx.runCorrectiveBuild(factsCtx);
        }
      } else {
        // The request never asked for an artifact (the model fabricated a tool-minted
        // link on e.g. a mail/lookup question) — a BUILD would compound the fabrication
        // with a deliverable nobody wanted. Re-route the ORIGINAL request once instead.
        fabricationRerouteAttempted = true;
        fabricationReroute = await ctx.runCorrectiveReroute();
      }
    }
    if (fabricationCorrectiveBuild) {
      finalResponse = fabricationCorrectiveBuild;
      guardrailEvents.push({ type: "guardrail_flagged", details: "fabricated_zero_work_corrective_build" });
    } else if (fabricationReroute) {
      finalResponse = fabricationReroute;
      guardrailEvents.push({ type: "guardrail_flagged", details: "fabricated_zero_work_corrective_reroute" });
    } else if (fabricationRerouteAttempted) {
      // The reroute produced nothing shippable. NO build ran and none was wanted —
      // the build-framed denials below would invent a "Datei/Bau" that was never
      // part of the request (the session-24826c33 failure shape). Stay in-domain.
      finalResponse = "Meine vorherige Antwort enthielt ein Ergebnis, das durch keine ausgeführte Arbeit gedeckt war — ich habe sie verworfen, und die Weiterleitung an einen Spezialisten hat kein Ergebnis geliefert. Formuliere die Anfrage kurz neu oder bestätige, dann versuche ich es erneut.\n\nMy previous answer referenced a result that no actual work produced — I discarded it, and re-routing the request to a specialist returned nothing either. Rephrase briefly or confirm, and I'll try again.";
    } else if (fabricationBuildAttempted || ctx.getQaCorrectiveBuildUsed()) {
      // A real build WAS attempted and produced no file — saying "no tools ran" here
      // would be its own false statement (audit 0ac7d3fc: the denial claimed nothing
      // ran while a 6-minute corrective build had just failed). Be accurate.
      finalResponse = "Der Bau der angeforderten Datei wurde gestartet, ist aber **fehlgeschlagen** — es wurde keine fertige Datei erstellt, daher existiert ein oben genannter Link/Inhalt nicht. Bestätige kurz, dann starte ich einen neuen Bauversuch.\n\nThe build of the requested file was started but **failed** — no finished file was produced, so any link or deliverable named above does not exist. Confirm and I'll retry the build now.";
    } else {
      finalResponse = "Ich habe in diesem Schritt **nichts** gebaut — es wurden keine Tools ausgeführt und keine Datei oder App erstellt, daher existiert ein oben genannter Link/Inhalt nicht. Bestätige kurz, dann lasse ich den passenden Spezialisten die angeforderte Lösung jetzt **wirklich** bauen.\n\nI did **not** build anything in this turn — no tools ran and no file or app was created, so any link or deliverable named above does not exist. Confirm and I'll have the right specialist actually build it now.";
    }
    // Every branch above replaced the answer wholesale — the latched QA verdict no
    // longer describes the shipped text.
    invalidateQaSignals();
  }

  // Last-line-of-defense honesty net (audit 52c23af8 turn 2): the false-completion
  // guard above tries to rewrite via forceSynthesis, but on the slow local model that
  // re-synthesis can itself re-emit a claiming draft AND the corrected answer was
  // observed getting bypassed before send. This final, deterministic check runs AFTER
  // every synthesis + redaction pass and makes NO model call (the model is already
  // timing out), so it always lands: if the answer STILL asserts it created/updated an
  // artifact for an artifact-mutation request that produced NO file this turn, prepend
  // an honest banner so the user is never told a file was built when none was. Content
  // is preserved (the inline draft is usually correct) — only the false framing is corrected.
  if (
    deliverableIntent.wantsArtifactMutation
    && ctx.collectTurnArtifactAttachments(session).length === 0
    && claimsArtifactWrittenButUnproduced(finalResponse)
  ) {
    finalResponse = "> ⚠️ **Die angeforderte Datei wurde in diesem Schritt NICHT erstellt** (der Build lief in eine Zeitüberschreitung). Der folgende Inhalt ist nur ein Text-Entwurf — bestätige, dann lasse ich den Inhalts-Spezialisten die Datei jetzt bauen.\n> _The requested file was **not** created this turn (the build timed out). The content below is a text draft only — confirm and I'll have the content specialist build the file now._\n\n"
      + finalResponse;
    guardrailEvents.push({ type: "guardrail_flagged", details: "artifact_completion_claim_unbacked_bannered" });
    logAudit("guardrail_flagged", {
      type: "artifact_completion_claim_unbacked_bannered",
      answerLength: finalResponse.length,
    }, { sessionId: session.id, channel: session.channel, severity: "warn" });
  }

  // Artifact verification (orchestration.verifyArtifacts): open every file this turn
  // produced and check it is actually well-formed, rebuilding it when it is not.
  //
  // Runs LAST deliberately. The probes above that could catch this live inside the QA
  // delivery gate, which is a no-op without a plan carrying acceptance criteria — so an
  // ordinary "give me a PDF" turn shipped its file unopened. And the caveat has to be
  // appended after every guard that can REPLACE finalResponse (the consistency gate, the
  // redaction rescan), or an upstream rewrite would silently drop the warning while the
  // broken file still shipped.
  const verification = await runArtifactVerificationGate({
    session,
    signal,
    toolContext,
    collectTurnArtifactAttachments: ctx.collectTurnArtifactAttachments,
    incrementDelegationCount: ctx.incrementDelegationCount,
  });
  if (ctx.scorecardSignals) {
    ctx.scorecardSignals.artifactVerificationStatus = verification.status;
  }
  if (verification.status === "fail") {
    finalResponse += buildFailureCaveat(verification.failures);
    guardrailEvents.push({ type: "guardrail_flagged", details: "artifact_verification_failed" });
    logAudit("guardrail_flagged", {
      type: "artifact_verification_failed",
      failures: verification.failures,
      repairAttempts: verification.repairAttempts,
      probedCount: verification.probedCount,
    }, { sessionId: session.id, channel: session.channel, severity: "error" });
  } else if (verification.status === "repaired") {
    guardrailEvents.push({ type: "guardrail_flagged", details: "artifact_verification_repaired" });
  } else if (verification.status === "unverifiable" && verification.failures) {
    finalResponse += buildUnverifiableCaveat(verification.failures);
    guardrailEvents.push({ type: "guardrail_flagged", details: "artifact_verification_unverifiable" });
  }

  return finalResponse;
}
