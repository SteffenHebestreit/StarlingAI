// The clean-success terminal tail of runTurnImpl (runtime.ts), extracted verbatim
// into a sibling module (HELPER-LIFT god-file seam, same technique as
// turn-finalize-guards.ts). This is the span that runs AFTER the terminal guards
// have produced `finalResponse` on a normally-completed turn: it persists the
// assistant turn state, builds the turn-performance metrics, emits the
// turn_performance / message_sent / turn_scorecard audits, fires every
// fire-and-forget post-turn learning signal (G33 trajectory write, E26 graph
// retrieval credit/penalty, Phase-3 skill-outcome + holdout recording, Phase-2
// skill distillation, trajectory-cache used/invalidated), and RETURNS the TurnOutput.
//
// Behavior-preserving: the body is moved unchanged — same audit events, ordering,
// and fire-and-forget (`.catch()`) semantics. Runtime-private helpers (the swarm-
// state getter and the turn-state persister) are passed as callbacks, so this
// module — like turn-finalize-guards.ts — deliberately does NOT import from
// runtime.js. All other callees are their own sibling/service modules.
import { logAudit } from "../audit/logger.js";
import { buildTurnPerformanceMetrics } from "./turn-metrics.js";
import { recordSkillOutcomeAsync, recordSkillHoldoutOutcomeAsync } from "../skills/store.js";
import { sweepEvidenceMigrationParity } from "../swarm/evidence-migration.js";
import { maybeDistillSkillFromTurn } from "../skills/distiller.js";
import { writeTrajectory, invalidateTrajectory } from "../memory/trajectory-cache.js";
import { graphMarkSessionRetrievalsUseful, graphMarkSessionRetrievalsUnhelpful } from "../memory/graph-service.js";
import type { SwarmState } from "../tools/registry.js";
import type { AgentSession } from "./session.js";
import { buildTurnQualityScorecard, createTurnQualitySignals, turnLearningSignal, type TurnQualityScorecard, type TurnQualitySignals } from "./turn-scorecard.js";
import { getConfig } from "../config/loader.js";
import type { TurnOutput } from "./turn-types.js";

export interface FinalizeSuccessfulTurnParams {
  session: AgentSession;
  /** The user-facing answer already produced by the terminal guards. */
  finalResponse: string;
  /** Runtime-private: persist the assistant message + this turn's artifacts + swarm state. */
  persistTurnState: (session: AgentSession, content: string, swarmState?: SwarmState) => void;
  /** Runtime-private: read the LIVE turn swarm state (mutable across the turn). */
  getTurnSwarmState: () => SwarmState | undefined;

  // --- turn-performance inputs ---
  turnStartedAt: number;
  firstModelResponseMs?: number;
  llmCalls: number;
  llmTimeMs: number;
  toolCallsRequested: number;
  toolExecutionTimeMs: number;
  lastPromptMetrics: {
    systemPromptChars: number;
    collapsedHistoryMessages: number;
    collapsedHistoryChars: number;
    promptChars: number;
  };
  finishReason: string;
  iterationCount: number;
  totalUsage: { promptTokens: number; completionTokens: number; totalTokens: number };

  // --- scorecard + learning-signal inputs ---
  delegationCount: number;
  shareFindingCount: number;
  forcedSynthesisFired: boolean;
  consecutiveDelegationFailures: number;
  sharedFindingsThisTurn: string[];
  /** initialDynamicGuidance?.freshnessSensitive — the only field the span reads. */
  freshnessSensitive: boolean;
  injectedSkillSlugs: string[];
  heldOutSkillSlugs: string[];
  /**
   * The cached trajectory the model was SHOWN this turn (in the prompt as sent, after the budget
   * trimmer), or null. The runtime passes only that one: a lookup hit that was never injected —
   * every hit under leanContextInjection, or one the trimmer dropped — took no part in the answer,
   * so it is neither logged as used nor invalidated by it (finding 2026-10-05).
   */
  injectedTrajectoryIdentity: { normalizedQuery: string; finishedAt: string } | null;
  userMessage: string;
  guardrailEvents: TurnOutput["guardrailEvents"];
  artifactCount?: number;
  qualitySignals?: TurnQualitySignals;
  /** The turn's latest delegation masked figures no tool had returned (see buildTurnQualityScorecard). */
  delegatedFiguresUnobserved?: boolean;
}

/**
 * Finalize a normally-completed (non-blocked, non-early-return) turn: persist
 * state, emit the terminal audits + learning signals, and return the TurnOutput.
 * Synchronous by construction — every learning-signal write is fire-and-forget.
 */
export function finalizeSuccessfulTurn(p: FinalizeSuccessfulTurnParams): TurnOutput {
  const {
    session, finalResponse, persistTurnState, getTurnSwarmState,
    turnStartedAt, firstModelResponseMs, llmCalls, llmTimeMs, toolCallsRequested,
    toolExecutionTimeMs, lastPromptMetrics, finishReason, iterationCount, totalUsage,
    delegationCount, shareFindingCount, forcedSynthesisFired, consecutiveDelegationFailures,
    sharedFindingsThisTurn, freshnessSensitive, injectedSkillSlugs, heldOutSkillSlugs,
    injectedTrajectoryIdentity, userMessage, guardrailEvents, artifactCount, qualitySignals,
    delegatedFiguresUnobserved,
  } = p;

  persistTurnState(session, finalResponse, getTurnSwarmState());

  const performance = buildTurnPerformanceMetrics({
    turnStartedAt,
    firstModelResponseMs,
    llmCalls,
    llmTimeMs,
    toolCallsRequested,
    toolExecutionTimeMs,
    lastPromptMetrics,
    completionChars: finalResponse.length,
    finishReason,
    blocked: false,
    toolIterations: iterationCount,
  });

  logAudit("turn_performance", { ...performance, usage: totalUsage }, {
    sessionId: session.id,
    channel: session.channel,
  });

  logAudit("message_sent", { length: finalResponse.length, toolCalls: iterationCount, usage: totalUsage, performance }, {
    sessionId: session.id,
    channel: session.channel,
  });

  const qualityScorecard = buildTurnQualityScorecard({
    delegationCount,
    shareFindingCount,
    forcedSynthesisFired,
    wardenFailureCount: consecutiveDelegationFailures,
    finalAnswerLength: finalResponse.length,
    toolIterations: iterationCount,
    finishReason,
    blocked: false,
    artifactCount: artifactCount ?? 0,
    quality: qualitySignals ?? createTurnQualitySignals(),
    // Most turns are scored here, at their normal ending, so the flag has to reach this builder
    // too: without it the turn of E2E 2026-10-07 still scored "completed" after its honest
    // synthesis, because only the runtime's early returns read the flag.
    delegatedFiguresUnobserved,
  });
  recordTurnLearning({
    session, qualityScorecard, finalResponse, iterationCount, delegationCount, shareFindingCount,
    sharedFindingsThisTurn, freshnessSensitive, injectedSkillSlugs, heldOutSkillSlugs,
    injectedTrajectoryIdentity, userMessage, getTurnSwarmState,
  });

  return {
    response: finalResponse,
    toolCallsExecuted: iterationCount,
    guardrailEvents,
    usage: totalUsage,
    blocked: false,
    swarmState: getTurnSwarmState(),
    performance,
    qualityScorecard,
  };
}

/** What the learning loops read from a finished turn (recordTurnLearning). */
export type TurnLearningInput = Pick<FinalizeSuccessfulTurnParams,
  | "session" | "finalResponse" | "iterationCount" | "delegationCount" | "shareFindingCount" | "sharedFindingsThisTurn"
  | "freshnessSensitive" | "injectedSkillSlugs" | "heldOutSkillSlugs" | "injectedTrajectoryIdentity" | "userMessage"
  | "getTurnSwarmState"> & { qualityScorecard: TurnQualityScorecard };

/**
 * Whether an early return's scorecard is evidence for the learning loops. A model or provider error
 * (llm_error_*) and an abort say nothing about a prompt or a skill; the loop brake's
 * (delegate_loop_terminated), the oversight floor's and a relayed deliverable's do.
 */
export function earlyReturnTeaches(finishReason: string): boolean {
  return !/^(?:llm_error|aborted)/.test(finishReason);
}

/**
 * Fire the post-turn learning signals from the turn's scorecard: the skill outcomes and holdout
 * baseline, distillation, retrieval credit, the trajectory cache. Every write is fire-and-forget.
 * A normal ending (finalizeSuccessfulTurn) and the runtime's early returns both come through here:
 * before, a turn the loop brake ended, or one that relayed its deliverable, taught nothing.
 */
export function recordTurnLearning(p: TurnLearningInput): void {
  const {
    session, qualityScorecard, finalResponse, iterationCount, delegationCount, shareFindingCount,
    sharedFindingsThisTurn, freshnessSensitive, injectedSkillSlugs, heldOutSkillSlugs,
    injectedTrajectoryIdentity, userMessage, getTurnSwarmState,
  } = p;
  // What this turn teaches the learning loops comes from its scorecard (turnLearningSignal), never
  // from the answer's wording. Skill statistics and distillation follow the deployment's evidence
  // rule (skillLibrary.outcomeEvidence). Retrieval credit and the trajectory cache keep the
  // substantive rule for a turn nothing judged: a retrieval left pending decays as unused
  // (graphDecayUnusedMemories) or is credited by the session's next judged turn.
  const skillSignal = turnLearningSignal(qualityScorecard, getConfig().skillLibrary.outcomeEvidence);
  const retrievalSignal = turnLearningSignal(qualityScorecard, "substantive");
  // G33: Write trajectory for future cache reuse — never one the turn itself recorded as failed.
  if (shareFindingCount > 0 && finalResponse.length > 50 && qualityScorecard.learningOutcome !== "failure") {
    writeTrajectory(
      {
        channel: session.channel,
        normalizedQuery: userMessage.toLowerCase().trim().slice(0, 300),
        sharedFindings: sharedFindingsThisTurn,
        finalAnswer: finalResponse.slice(0, 2000),
      },
      session.getWorkspacePath(),
      freshnessSensitive,
    ).catch(() => undefined);
  }

  // Phase 3: credit/penalize the skills injected into this turn so retrieval
  // reliability is learned. Success graduates drafts to active in the store.
  // Only attribute on turns that actually did multi-step work — skills are
  // procedures, so a direct single-shot answer is not evidence the procedure
  // was followed (avoids inflating success rates on trivial turns).
  // Fire-and-forget async writes — never block the turn return.
  // A turn that is no evidence under the evidence rule records nothing.
  // LRN-403 contamination guard: eval-channel turns (gateway-routed harness
  // runs, trap fixtures) must NEVER feed the learning loop — eval traffic in
  // the skill stats is training/eval overlap, and a trap case that deliberately
  // provokes failure would poison the success rates of whatever skill matched.
  // The same holds for the importance of the memories an eval turn retrieved.
  const isEvalTraffic = session.channel === "eval";
  if (isEvalTraffic && (injectedSkillSlugs.length > 0 || heldOutSkillSlugs.length > 0)) {
    logAudit("skill_eval_contamination_skipped", {
      injectedSlugs: injectedSkillSlugs,
      heldOutSlugs: heldOutSkillSlugs,
    }, { sessionId: session.id, channel: session.channel });
  }
  // EVD-303: once per successful non-eval turn, measure legacy-facts vs
  // evidence-ledger parity and backfill what the dual-write missed. Fire-and-
  // forget shadow telemetry — never blocks the turn return.
  if (!isEvalTraffic && delegationCount > 0) {
    void sweepEvidenceMigrationParity(session.id).catch(() => { /* shadow telemetry */ });
  }
  if (!isEvalTraffic && skillSignal && (injectedSkillSlugs.length > 0 || heldOutSkillSlugs.length > 0) && delegationCount > 0) {
    const skillWorkspace = session.getWorkspacePath();
    for (const slug of injectedSkillSlugs) {
      void recordSkillOutcomeAsync(skillWorkspace, slug, skillSignal).catch(() => { /* non-critical */ });
    }
    // Held-out matches record the counterfactual baseline so skillLift can
    // tell whether injecting the skill actually moves the outcome.
    for (const slug of heldOutSkillSlugs) {
      void recordSkillHoldoutOutcomeAsync(skillWorkspace, slug, skillSignal).catch(() => { /* non-critical */ });
    }
  }
  // Phase 2: distill a reusable skill from this successful multi-step turn
  // (gated by skillLibrary.autoAuthor). Best-effort — never blocks the turn.
  // LRN-403: never distill from eval traffic — a skill learned from a trap
  // fixture IS the training/eval overlap the holdout framework exists to prevent.
  if (skillSignal === "success" && !isEvalTraffic) {
    maybeDistillSkillFromTurn({
      workspacePath: session.getWorkspacePath(),
      sessionId: session.id,
      objective: userMessage,
      finalAnswer: finalResponse,
      delegationCount,
      sharedFindings: sharedFindingsThisTurn,
      swarmState: getTurnSwarmState(),
      loadedSkillSlugs: injectedSkillSlugs,
      outcomeBasis: qualityScorecard.learningBasis,
    }).catch(() => undefined);
  }
  // E26: close the graph-memory retrieval feedback loop for this turn.
  // A successful turn credits the memories retrieved during it (wasUseful=true
  // + importance boost). A failed one marks them wasUseful=false with a modest
  // importance penalty: the memories were retrieved and still didn't help.
  // This is the negative-signal counterpart that closes the E26 loop in both
  // directions rather than relying solely on slow decay.
  if (retrievalSignal === "success") {
    if (!isEvalTraffic) graphMarkSessionRetrievalsUseful(session.id, { boost: 0.04 }).catch(() => {});
    // G33 follow-up: positive signal — the injected cached trajectory
    // contributed to a successful answer. Pairs with `trajectory_cache_hit`
    // and `trajectory_cache_invalidated` so operators can compute the
    // hit-and-helpful rate from the audit log without further plumbing.
    if (injectedTrajectoryIdentity) {
      logAudit(
        "trajectory_cache_used",
        {
          normalizedQuery: injectedTrajectoryIdentity.normalizedQuery.slice(0, 200),
          finishedAt: injectedTrajectoryIdentity.finishedAt,
          finalAnswerChars: finalResponse.length,
          toolIterations: iterationCount,
        },
        { sessionId: session.id, channel: session.channel },
      );
    }
  } else if (retrievalSignal === "failure") {
    if (!isEvalTraffic) graphMarkSessionRetrievalsUnhelpful(session.id, { penalty: 0.02 }).catch(() => {});
    // G33 follow-up: if a cached trajectory was injected and the turn
    // still failed or ended in a stub, the cached evidence is almost
    // certainly stale or wrong. Invalidate it so future similar
    // queries don't keep inheriting the same bad outcome.
    if (injectedTrajectoryIdentity) {
      invalidateTrajectory(session.getWorkspacePath(), injectedTrajectoryIdentity);
      logAudit(
        "trajectory_cache_invalidated",
        {
          normalizedQuery: injectedTrajectoryIdentity.normalizedQuery.slice(0, 200),
          finishedAt: injectedTrajectoryIdentity.finishedAt,
          reason: qualityScorecard.learningOutcome === "failure" ? qualityScorecard.learningBasis : "stub_response",
          finalAnswerChars: finalResponse.length,
        },
        { sessionId: session.id, channel: session.channel, severity: "warn" },
      );
    }
  }
}
