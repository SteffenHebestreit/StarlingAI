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
import { buildTurnQualityScorecard, createTurnQualitySignals, type TurnQualitySignals } from "./turn-scorecard.js";
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
  injectedTrajectoryIdentity: { normalizedQuery: string; finishedAt: string } | null;
  userMessage: string;
  guardrailEvents: TurnOutput["guardrailEvents"];
  artifactCount?: number;
  qualitySignals?: TurnQualitySignals;
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
  });
  // G33: Write trajectory for future cache reuse
  if (shareFindingCount > 0 && finalResponse.length > 50) {
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

  // E26: close the graph-memory retrieval feedback loop for this turn.
  // A non-blocked turn that produced a substantive answer is treated as a
  // successful outcome — memories retrieved during the turn get credited
  // (wasUseful=true + importance boost). Same signal the sub-agent uses.
  // An apology or stub answer is treated as an unhelpful outcome: the
  // memories were retrieved and still didn't help, so mark them
  // wasUseful=false and apply a modest importance penalty. This is the
  // negative-signal counterpart that closes the E26 loop in both
  // directions rather than relying solely on slow decay.
  const isApology = finalResponse.toLowerCase().startsWith("i apologize");
  // Phase 3: credit/penalize the skills injected into this turn so retrieval
  // reliability is learned. Success graduates drafts to active in the store.
  // Only attribute on turns that actually did multi-step work — skills are
  // procedures, so a direct single-shot answer is not evidence the procedure
  // was followed (avoids inflating success rates on trivial turns).
  // Fire-and-forget async writes — never block the turn return.
  // LRN-403 contamination guard: eval-channel turns (gateway-routed harness
  // runs, trap fixtures) must NEVER feed the learning loop — eval traffic in
  // the skill stats is training/eval overlap, and a trap case that deliberately
  // provokes failure would poison the success rates of whatever skill matched.
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
  if (!isEvalTraffic && (injectedSkillSlugs.length > 0 || heldOutSkillSlugs.length > 0) && delegationCount > 0) {
    const outcome = finalResponse.length > 50 && !isApology ? "success" : "failure";
    const skillWorkspace = session.getWorkspacePath();
    for (const slug of injectedSkillSlugs) {
      void recordSkillOutcomeAsync(skillWorkspace, slug, outcome).catch(() => { /* non-critical */ });
    }
    // Held-out matches record the counterfactual baseline so skillLift can
    // tell whether injecting the skill actually moves the outcome.
    for (const slug of heldOutSkillSlugs) {
      void recordSkillHoldoutOutcomeAsync(skillWorkspace, slug, outcome).catch(() => { /* non-critical */ });
    }
  }
  if (finalResponse.length > 50 && !isApology) {
    graphMarkSessionRetrievalsUseful(session.id, { boost: 0.04 }).catch(() => {});
    // Phase 2: distill a reusable skill from this successful multi-step turn
    // (gated by skillLibrary.autoAuthor). Best-effort — never blocks the turn.
    // LRN-403: never distill from eval traffic — a skill learned from a trap
    // fixture IS the training/eval overlap the holdout framework exists to prevent.
    if (!isEvalTraffic) maybeDistillSkillFromTurn({
      workspacePath: session.getWorkspacePath(),
      sessionId: session.id,
      objective: userMessage,
      finalAnswer: finalResponse,
      delegationCount,
      sharedFindings: sharedFindingsThisTurn,
      swarmState: getTurnSwarmState(),
      loadedSkillSlugs: injectedSkillSlugs,
    }).catch(() => undefined);
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
  } else if (finalResponse.length <= 50 || isApology) {
    graphMarkSessionRetrievalsUnhelpful(session.id, { penalty: 0.02 }).catch(() => {});
    // G33 follow-up: if a cached trajectory was injected and the turn
    // still ended in apology / stub, the cached evidence is almost
    // certainly stale or wrong. Invalidate it so future similar
    // queries don't keep inheriting the same bad outcome.
    if (injectedTrajectoryIdentity) {
      invalidateTrajectory(session.getWorkspacePath(), injectedTrajectoryIdentity);
      logAudit(
        "trajectory_cache_invalidated",
        {
          normalizedQuery: injectedTrajectoryIdentity.normalizedQuery.slice(0, 200),
          finishedAt: injectedTrajectoryIdentity.finishedAt,
          reason: isApology ? "apology" : "stub_response",
          finalAnswerChars: finalResponse.length,
        },
        { sessionId: session.id, channel: session.channel, severity: "warn" },
      );
    }
  }

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
