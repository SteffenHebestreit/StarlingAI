import { describe, expect, it } from "vitest";
import { buildTurnQualityScorecard, createTurnQualitySignals, turnLearningSignal } from "../agent/turn-scorecard.js";

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

  // The last-resort terminal guard withheld the answer as a raw tool dump and shipped its fallback:
  // the E2E turn guards-list-files-on-a-file was recorded "completed" with a bare heading as reply.
  it("a turn whose answer the raw-dump guard withheld is partial, not completed", () => {
    const quality = createTurnQualitySignals();
    expect(quality.answerWithheld).toBeNull();
    quality.answerWithheld = "raw_tool_output";

    expect(buildTurnQualityScorecard({ ...base, quality })).toMatchObject({
      outcomeStatus: "partial",
      partialOrFailureReason: "answer_withheld_raw_tool_output",
    });
    // The inline-artifact fabrication guard withholds an answer the same way.
    expect(buildTurnQualityScorecard({ ...base, quality: { ...quality, answerWithheld: "fabricated_inline_artifact" } })).toMatchObject({
      outcomeStatus: "partial",
      partialOrFailureReason: "answer_withheld_fabricated_inline_artifact",
    });
    expect(buildTurnQualityScorecard({ ...base, quality: createTurnQualitySignals() })).toMatchObject({
      outcomeStatus: "completed",
      partialOrFailureReason: null,
    });
  });

  it("a turn whose delegation masked figures no tool returned is partial, not completed (E2E 2026-10-07)", () => {
    expect(buildTurnQualityScorecard({ ...base, delegatedFiguresUnobserved: true })).toMatchObject({
      version: 2,
      outcomeStatus: "partial",
      partialOrFailureReason: "delegated_figures_unobserved",
    });
    expect(buildTurnQualityScorecard({ ...base, delegatedFiguresUnobserved: false })).toMatchObject({
      outcomeStatus: "completed",
      partialOrFailureReason: null,
    });
  });
});
describe("turn learning outcome", () => {
  const qa = (qaStatus: "pass" | "fail" | "unverified") => ({ ...createTurnQualitySignals(), criteriaTotal: 2, qaStatus });

  it("is a success only when a QA verdict passed the answer", () => {
    expect(buildTurnQualityScorecard({ ...base, quality: qa("pass") })).toMatchObject({
      learningOutcome: "success", learningBasis: "qa_pass",
    });
    // Completing, however long the answer, is not evidence of having helped.
    expect(buildTurnQualityScorecard({ ...base, finalAnswerLength: 4_000 })).toMatchObject({
      outcomeStatus: "completed", learningOutcome: "unknown", learningBasis: "no_verdict",
    });
  });

  it("is a failure on every defect the turn recorded", () => {
    const withheld = { ...createTurnQualitySignals(), answerWithheld: "raw_tool_output" as const };
    const cases: Array<[Parameters<typeof buildTurnQualityScorecard>[0], string]> = [
      [{ ...base, quality: qa("fail") }, "qa_failed"],
      [{ ...base, quality: withheld }, "answer_withheld_raw_tool_output"],
      [{ ...base, delegatedFiguresUnobserved: true }, "delegated_figures_unobserved"],
      [{ ...base, wardenFailureCount: 2 }, "delegation_failures"],
      [{ ...base, forcedSynthesisFired: true, finishReason: "loop_brake" }, "loop_brake"],
      [{ ...base, failed: true, finishReason: "timeout" }, "timeout"],
    ];
    for (const [input, basis] of cases) {
      expect(buildTurnQualityScorecard(input)).toMatchObject({ learningOutcome: "failure", learningBasis: basis });
    }
  });

  it("an undecided verdict is no evidence, but does not hide a defect behind it", () => {
    expect(buildTurnQualityScorecard({ ...base, quality: qa("unverified") })).toMatchObject({
      outcomeStatus: "partial", learningOutcome: "unknown", learningBasis: "qa_unverified",
    });
    const artifactFailed = { ...qa("unverified"), artifactVerificationStatus: "fail" as const };
    expect(buildTurnQualityScorecard({ ...base, quality: artifactFailed })).toMatchObject({
      partialOrFailureReason: "qa_unverified",
      learningOutcome: "failure",
      learningBasis: "artifact_verification_failed",
    });
  });

  it("a blocked or cancelled turn is no evidence", () => {
    expect(buildTurnQualityScorecard({ ...base, blocked: true })).toMatchObject({ learningOutcome: "unknown", learningBasis: "blocked" });
    expect(buildTurnQualityScorecard({ ...base, finishReason: "cancelled" })).toMatchObject({ learningOutcome: "unknown", learningBasis: "cancelled" });
  });
});

describe("turnLearningSignal", () => {
  const card = (learningOutcome: "success" | "failure" | "unknown", learningBasis: string, finalAnswerLength = 400) =>
    ({ learningOutcome, learningBasis, finalAnswerLength });

  it("records judged turns the same under both rules", () => {
    for (const rule of ["verified", "substantive"] as const) {
      expect(turnLearningSignal(card("success", "qa_pass"), rule)).toBe("success");
      expect(turnLearningSignal(card("failure", "qa_failed"), rule)).toBe("failure");
    }
  });

  it("verified: a turn nothing judged records nothing", () => {
    expect(turnLearningSignal(card("unknown", "no_verdict"), "verified")).toBeNull();
    expect(turnLearningSignal(card("unknown", "qa_unverified"), "verified")).toBeNull();
  });

  it("substantive: a turn nothing judged counts by the substance of its answer, whatever its language", () => {
    expect(turnLearningSignal(card("unknown", "no_verdict", 51), "substantive")).toBe("success");
    expect(turnLearningSignal(card("unknown", "qa_unverified", 400), "substantive")).toBe("success");
    expect(turnLearningSignal(card("unknown", "no_verdict", 50), "substantive")).toBe("failure");
    // Blocked and cancelled turns stay out under either rule.
    expect(turnLearningSignal(card("unknown", "blocked"), "substantive")).toBeNull();
    expect(turnLearningSignal(card("unknown", "cancelled"), "substantive")).toBeNull();
  });
});
