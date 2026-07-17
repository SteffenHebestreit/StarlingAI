import { describe, expect, it } from "vitest";
import { buildTurnQualityScorecard, createTurnQualitySignals } from "../agent/turn-scorecard.js";

const base = {
  delegationCount: 2,
  shareFindingCount: 3,
  forcedSynthesisFired: false,
  wardenFailureCount: 0,
  finalAnswerLength: 420,
  toolIterations: 4,
  finishReason: "stop",
  blocked: false,
  artifactCount: 1,
};

describe("turn quality scorecard", () => {
  it("preserves existing counters and marks an ordinary terminal response complete", () => {
    const scorecard = buildTurnQualityScorecard(base);
    expect(scorecard).toMatchObject({
      version: 2,
      delegationCount: 2,
      shareFindingCount: 3,
      evidenceCount: 3,
      criteriaStatus: "not_run",
      artifactProbeStatus: "not_requested",
      outcomeStatus: "completed",
      partialOrFailureReason: null,
    });
  });

  it("credits all criteria only for an evidence-backed QA pass", () => {
    const quality = createTurnQualitySignals();
    quality.criteriaTotal = 4;
    quality.qaStatus = "pass";
    quality.qaRounds = 2;
    quality.qaEvidencePresent = true;
    quality.artifactProbeStatus = "pass";
    quality.artifactProbeCount = 1;

    const scorecard = buildTurnQualityScorecard({ ...base, quality });
    expect(scorecard.criteriaCovered).toBe(4);
    expect(scorecard.qaStatus).toBe("pass");
    expect(scorecard.qaEvidencePresent).toBe(true);
    expect(scorecard.artifactProbeStatus).toBe("pass");
    expect(scorecard.outcomeStatus).toBe("completed");
  });

  it("keeps unverified and failed QA distinct from verified completion", () => {
    const unverified = createTurnQualitySignals();
    unverified.criteriaTotal = 2;
    unverified.qaStatus = "unverified";
    const failed = { ...unverified, qaStatus: "fail" as const };

    expect(buildTurnQualityScorecard({ ...base, quality: unverified })).toMatchObject({
      criteriaCovered: null,
      outcomeStatus: "partial",
      partialOrFailureReason: "qa_unverified",
    });
    expect(buildTurnQualityScorecard({ ...base, quality: failed })).toMatchObject({
      criteriaCovered: null,
      outcomeStatus: "partial",
      partialOrFailureReason: "qa_failed",
    });
  });

  it("marks a blocked terminal result distinctly", () => {
    const scorecard = buildTurnQualityScorecard({ ...base, blocked: true, finishReason: "rate_limited" });
    expect(scorecard.outcomeStatus).toBe("blocked");
    expect(scorecard.partialOrFailureReason).toBe("rate_limited");
  });
});