import type { QaVerdictStatus } from "./qa-delivery-loop.js";
import type { ArtifactVerificationStatus } from "./artifact-verification-gate.js";

export type ScorecardQaStatus = QaVerdictStatus | "not_run";
export type ArtifactProbeStatus = "not_requested" | "not_applicable" | "pass" | "fail" | "unverified" | "error";
export type ScorecardOutcomeStatus = "completed" | "partial" | "failed" | "blocked" | "cancelled";

export interface TurnQualitySignals {
  criteriaTotal: number;
  criteriaCovered: number | null;
  qaStatus: ScorecardQaStatus;
  qaRounds: number;
  qaEvidencePresent: boolean;
  artifactProbeStatus: ArtifactProbeStatus;
  artifactProbeCount: number;
  /** Verdict of the plan-independent artifact verification gate. */
  artifactVerificationStatus: ArtifactVerificationStatus;
  /**
   * Why the turn's answer was withheld, when a terminal guard shipped its honest fallback in the
   * answer's place (agent/runtime.ts): the last-resort guard took it for a raw tool dump
   * (raw_tool_evidence_dump_suppressed), or the inline-artifact guard for a document written inline
   * instead of built (inline_artifact_fabrication_suppressed). Null when the answer shipped.
   */
  answerWithheld: AnswerWithheldReason | null;
}

export type AnswerWithheldReason = "raw_tool_output" | "fabricated_inline_artifact";

export interface TurnQualityScorecard {
  version: 2;
  delegationCount: number;
  shareFindingCount: number;
  evidenceCount: number;
  forcedSynthesisFired: boolean;
  wardenFailureCount: number;
  finalAnswerLength: number;
  toolIterations: number;
  finishReason: string;
  blocked: boolean;
  criteriaTotal: number;
  criteriaCovered: number | null;
  criteriaStatus: ScorecardQaStatus;
  qaStatus: ScorecardQaStatus;
  qaRounds: number;
  qaEvidencePresent: boolean;
  artifactCount: number;
  artifactProbeStatus: ArtifactProbeStatus;
  artifactProbeCount: number;
  outcomeStatus: ScorecardOutcomeStatus;
  partialOrFailureReason: string | null;
}

export interface BuildTurnQualityScorecardInput {
  delegationCount: number;
  shareFindingCount: number;
  forcedSynthesisFired: boolean;
  wardenFailureCount: number;
  finalAnswerLength: number;
  toolIterations: number;
  finishReason: string;
  blocked: boolean;
  failed?: boolean;
  artifactCount: number;
  quality?: TurnQualitySignals;
  /** The turn's latest delegation masked figures no tool had returned (its run record). */
  delegatedFiguresUnobserved?: boolean;
}

export function createTurnQualitySignals(): TurnQualitySignals {
  return {
    criteriaTotal: 0,
    criteriaCovered: null,
    qaStatus: "not_run",
    qaRounds: 0,
    qaEvidencePresent: false,
    artifactProbeStatus: "not_requested",
    artifactProbeCount: 0,
    artifactVerificationStatus: "not_requested",
    answerWithheld: null,
  };
}

function toNonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function outcomeFor(input: BuildTurnQualityScorecardInput, quality: TurnQualitySignals): {
  status: ScorecardOutcomeStatus;
  reason: string | null;
} {
  if (input.blocked) return { status: "blocked", reason: input.finishReason };
  if (input.failed) return { status: "failed", reason: input.finishReason };
  if (input.finishReason === "cancelled") return { status: "cancelled", reason: "cancelled" };
  // What shipped is the fallback, not an answer: the E2E turn whose listing was withheld as a "dump"
  // and replaced by a bare heading was recorded "completed".
  if (quality.answerWithheld) return { status: "partial", reason: `answer_withheld_${quality.answerWithheld}` };
  if (quality.qaStatus === "fail") return { status: "partial", reason: "qa_failed" };
  if (quality.qaStatus === "unverified") return { status: "partial", reason: "qa_unverified" };
  // A turn that shipped a file which failed its integrity check is NOT "completed",
  // however clean the prose was. The user got a broken deliverable.
  if (quality.artifactVerificationStatus === "fail") return { status: "partial", reason: "artifact_verification_failed" };
  // The figures the user asked for were never computed: whatever the answer says about them, the
  // turn did not complete (E2E 2026-10-07 recorded the fabricated primes turn as "completed").
  if (input.delegatedFiguresUnobserved) return { status: "partial", reason: "delegated_figures_unobserved" };
  if (input.wardenFailureCount > 0) return { status: "partial", reason: "delegation_failures" };
  if (input.forcedSynthesisFired) return { status: "partial", reason: input.finishReason };
  return { status: "completed", reason: null };
}

/** Build the single canonical quality payload carried by every terminal turn_scorecard event. */
export function buildTurnQualityScorecard(input: BuildTurnQualityScorecardInput): TurnQualityScorecard {
  const quality = input.quality ?? createTurnQualitySignals();
  const criteriaTotal = toNonNegativeInteger(quality.criteriaTotal);
  const criteriaCovered = quality.qaStatus === "pass"
    ? criteriaTotal
    : quality.criteriaCovered === null ? null : Math.min(criteriaTotal, toNonNegativeInteger(quality.criteriaCovered));
  const outcome = outcomeFor(input, quality);

  return {
    version: 2,
    delegationCount: toNonNegativeInteger(input.delegationCount),
    shareFindingCount: toNonNegativeInteger(input.shareFindingCount),
    evidenceCount: toNonNegativeInteger(input.shareFindingCount),
    forcedSynthesisFired: input.forcedSynthesisFired,
    wardenFailureCount: toNonNegativeInteger(input.wardenFailureCount),
    finalAnswerLength: toNonNegativeInteger(input.finalAnswerLength),
    toolIterations: toNonNegativeInteger(input.toolIterations),
    finishReason: input.finishReason || "unknown",
    blocked: input.blocked,
    criteriaTotal,
    criteriaCovered,
    criteriaStatus: quality.qaStatus,
    qaStatus: quality.qaStatus,
    qaRounds: toNonNegativeInteger(quality.qaRounds),
    qaEvidencePresent: quality.qaEvidencePresent,
    artifactCount: toNonNegativeInteger(input.artifactCount),
    artifactProbeStatus: quality.artifactProbeStatus,
    artifactProbeCount: toNonNegativeInteger(quality.artifactProbeCount),
    outcomeStatus: outcome.status,
    partialOrFailureReason: outcome.reason,
  };
}