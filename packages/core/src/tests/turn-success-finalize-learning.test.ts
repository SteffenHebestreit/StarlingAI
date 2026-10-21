import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ outcomeEvidence: "verified" as "verified" | "substantive" }));

vi.mock("../config/loader.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../config/loader.js")>();
  return {
    ...original,
    getConfig: () => {
      const config = original.getConfig();
      return { ...config, skillLibrary: { ...config.skillLibrary, outcomeEvidence: state.outcomeEvidence } };
    },
  };
});
vi.mock("../skills/store.js", () => ({
  recordSkillOutcomeAsync: vi.fn(async () => undefined),
  recordSkillHoldoutOutcomeAsync: vi.fn(async () => undefined),
}));
vi.mock("../skills/distiller.js", () => ({ maybeDistillSkillFromTurn: vi.fn(async () => undefined) }));
vi.mock("../memory/trajectory-cache.js", () => ({
  writeTrajectory: vi.fn(async () => undefined),
  invalidateTrajectory: vi.fn(),
}));
vi.mock("../memory/graph-service.js", () => ({
  graphMarkSessionRetrievalsUseful: vi.fn(async () => 0),
  graphMarkSessionRetrievalsUnhelpful: vi.fn(async () => 0),
}));
vi.mock("../swarm/evidence-migration.js", () => ({ sweepEvidenceMigrationParity: vi.fn(async () => undefined) }));
vi.mock("../audit/logger.js", () => ({ logAudit: vi.fn() }));

import { earlyReturnTeaches, finalizeSuccessfulTurn, recordTurnLearning, type FinalizeSuccessfulTurnParams } from "../agent/turn-success-finalize.js";
import { buildTurnQualityScorecard, createTurnQualitySignals } from "../agent/turn-scorecard.js";
import { recordSkillHoldoutOutcomeAsync, recordSkillOutcomeAsync } from "../skills/store.js";
import { maybeDistillSkillFromTurn } from "../skills/distiller.js";
import { invalidateTrajectory, writeTrajectory } from "../memory/trajectory-cache.js";
import { graphMarkSessionRetrievalsUnhelpful, graphMarkSessionRetrievalsUseful } from "../memory/graph-service.js";
import { logAudit } from "../audit/logger.js";
import { resetUserCorrectionForTests, takeLearnedTurn } from "../agent/user-correction.js";
import type { AgentSession } from "../agent/session.js";

function params(overrides: Partial<FinalizeSuccessfulTurnParams> & { channel?: string } = {}): FinalizeSuccessfulTurnParams {
  const { channel = "web", ...rest } = overrides;
  const session = { id: "sess-1", channel, getWorkspacePath: () => "/tmp/ws" } as unknown as AgentSession;
  return {
    session,
    finalResponse: "A long and complete answer that walks through every step the user asked about in detail.",
    persistTurnState: () => undefined,
    getTurnSwarmState: () => undefined,
    turnStartedAt: Date.now() - 1_000,
    llmCalls: 2,
    llmTimeMs: 500,
    toolCallsRequested: 3,
    toolExecutionTimeMs: 200,
    lastPromptMetrics: { systemPromptChars: 1, collapsedHistoryMessages: 0, collapsedHistoryChars: 0, promptChars: 1 },
    finishReason: "stop",
    iterationCount: 3,
    totalUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    delegationCount: 3,
    shareFindingCount: 2,
    forcedSynthesisFired: false,
    consecutiveDelegationFailures: 0,
    sharedFindingsThisTurn: ["finding"],
    freshnessSensitive: false,
    injectedSkillSlugs: ["cited-report"],
    heldOutSkillSlugs: ["held-skill"],
    injectedTrajectoryIdentity: { normalizedQuery: "q", finishedAt: "2026-10-19T00:00:00.000Z" },
    userMessage: "Write the report",
    guardrailEvents: [],
    ...rest,
  };
}

const qa = (qaStatus: "pass" | "fail" | "unverified") => ({ ...createTurnQualitySignals(), criteriaTotal: 2, qaStatus });

describe("finalizeSuccessfulTurn — what the learning loops record", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.outcomeEvidence = "verified";
  });

  it("verified: a turn nothing judged leaves skill statistics and distillation alone", () => {
    const out = finalizeSuccessfulTurn(params());
    expect(out.qualityScorecard).toMatchObject({ learningOutcome: "unknown", learningBasis: "no_verdict" });
    expect(recordSkillOutcomeAsync).not.toHaveBeenCalled();
    expect(recordSkillHoldoutOutcomeAsync).not.toHaveBeenCalled();
    expect(maybeDistillSkillFromTurn).not.toHaveBeenCalled();
    // Retrieval credit keeps the substantive rule: a pending retrieval would decay as unused.
    expect(graphMarkSessionRetrievalsUseful).toHaveBeenCalledWith("sess-1", { boost: 0.04 });
  });

  it("a passed QA verdict credits both arms and distills from the turn", () => {
    finalizeSuccessfulTurn(params({ qualitySignals: qa("pass") }));
    expect(recordSkillOutcomeAsync).toHaveBeenCalledWith("/tmp/ws", "cited-report", "success");
    expect(recordSkillHoldoutOutcomeAsync).toHaveBeenCalledWith("/tmp/ws", "held-skill", "success");
    expect(maybeDistillSkillFromTurn).toHaveBeenCalledWith(expect.objectContaining({ outcomeBasis: "qa_pass" }));
    expect(writeTrajectory).toHaveBeenCalled();
  });

  it("a failed verdict is a failure however long the answer, under either rule", () => {
    for (const rule of ["verified", "substantive"] as const) {
      vi.clearAllMocks();
      state.outcomeEvidence = rule;
      finalizeSuccessfulTurn(params({ qualitySignals: qa("fail"), finalResponse: "x".repeat(3_000) }));
      expect(recordSkillOutcomeAsync).toHaveBeenCalledWith("/tmp/ws", "cited-report", "failure");
      expect(recordSkillHoldoutOutcomeAsync).toHaveBeenCalledWith("/tmp/ws", "held-skill", "failure");
      expect(maybeDistillSkillFromTurn).not.toHaveBeenCalled();
      expect(graphMarkSessionRetrievalsUnhelpful).toHaveBeenCalled();
      expect(graphMarkSessionRetrievalsUseful).not.toHaveBeenCalled();
      expect(writeTrajectory).not.toHaveBeenCalled();
      expect(invalidateTrajectory).toHaveBeenCalled();
      expect(logAudit).toHaveBeenCalledWith("trajectory_cache_invalidated", expect.objectContaining({ reason: "qa_failed" }), expect.anything());
    }
  });

  it("substantive: an apology in any language is judged like any other answer, not by a keyword", () => {
    state.outcomeEvidence = "substantive";
    finalizeSuccessfulTurn(params({ finalResponse: "I apologize, but here is the complete comparison you asked for, with all three offers." }));
    finalizeSuccessfulTurn(params({ finalResponse: "Entschuldigung, hier ist der vollständige Vergleich der drei Angebote, wie gewünscht." }));
    expect(vi.mocked(recordSkillOutcomeAsync).mock.calls.map((c) => c[2])).toEqual(["success", "success"]);
  });

  it("eval traffic moves neither skill statistics nor memory importance", () => {
    finalizeSuccessfulTurn(params({ channel: "eval", qualitySignals: qa("pass") }));
    finalizeSuccessfulTurn(params({ channel: "eval", qualitySignals: qa("fail") }));
    expect(recordSkillOutcomeAsync).not.toHaveBeenCalled();
    expect(maybeDistillSkillFromTurn).not.toHaveBeenCalled();
    expect(graphMarkSessionRetrievalsUseful).not.toHaveBeenCalled();
    expect(graphMarkSessionRetrievalsUnhelpful).not.toHaveBeenCalled();
  });
});

describe("an early return teaches the learning loops too", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.outcomeEvidence = "verified";
  });

  // A turn the loop brake ended: delegations kept failing, so its scorecard records a defect.
  const loopBrake = buildTurnQualityScorecard({
    delegationCount: 3, shareFindingCount: 0, forcedSynthesisFired: true, wardenFailureCount: 3,
    finalAnswerLength: 400, toolIterations: 6, finishReason: "delegate_loop_terminated", blocked: false, artifactCount: 0,
  });

  it("the loop brake's turn counts against the skills it ran with", () => {
    expect(loopBrake).toMatchObject({ learningOutcome: "failure" });
    const p = params();
    recordTurnLearning({ ...p, qualityScorecard: loopBrake });
    expect(recordSkillOutcomeAsync).toHaveBeenCalledWith("/tmp/ws", "cited-report", "failure");
    expect(recordSkillHoldoutOutcomeAsync).toHaveBeenCalledWith("/tmp/ws", "held-skill", "failure");
    expect(graphMarkSessionRetrievalsUnhelpful).toHaveBeenCalled();
  });

  it("is no evidence after a model or provider error, or an abort", () => {
    expect(earlyReturnTeaches("delegate_loop_terminated")).toBe(true);
    expect(earlyReturnTeaches("single_deliverable_relayed")).toBe(true);
    expect(earlyReturnTeaches("oversight_floor_synthesized")).toBe(true);
    expect(earlyReturnTeaches("llm_error_partial_salvaged")).toBe(false);
    expect(earlyReturnTeaches("llm_error_evidence_backstop")).toBe(false);
    expect(earlyReturnTeaches("aborted_synthesized")).toBe(false);
  });
});

describe("what the next message can still correct", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetUserCorrectionForTests();
    state.outcomeEvidence = "verified";
  });

  it("keeps what the turn recorded for its skills until the session's next message", () => {
    finalizeSuccessfulTurn(params({ qualitySignals: qa("pass") }));
    expect(takeLearnedTurn("sess-1")).toMatchObject({ injectedSkillSlugs: ["cited-report"], heldOutSkillSlugs: ["held-skill"], recorded: "success", workspacePath: "/tmp/ws" });
    // A turn nothing judged recorded nothing, and is kept as that: a correction records a failure for it.
    finalizeSuccessfulTurn(params());
    expect(takeLearnedTurn("sess-1")).toMatchObject({ recorded: null });
  });

  it("keeps nothing for eval traffic, and a turn without skill evidence forgets the one before", () => {
    finalizeSuccessfulTurn(params({ channel: "eval", qualitySignals: qa("pass") }));
    expect(takeLearnedTurn("sess-1")).toBeUndefined();
    finalizeSuccessfulTurn(params({ qualitySignals: qa("pass") }));
    finalizeSuccessfulTurn(params({ delegationCount: 0 }));
    expect(takeLearnedTurn("sess-1")).toBeUndefined();
  });
});
