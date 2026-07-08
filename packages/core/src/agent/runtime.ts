/**
 * Agent Runtime — the main agent loop.
 * LLM call → parse tool calls → execute (with guardrails) → loop → final response
 */
import { getChatProvider, getChatProviderForTier, getChatProviderWithOverride } from "../providers/index.js";
import { salvageToolCallArguments } from "../providers/lmstudio.js";
import type { ChatProvider, LLMMessage, LLMResponse, StreamChunk } from "../providers/lmstudio.js";
import { assembleTurnSystemMessages } from "./turn-system-prompt.js";
import { markOrchestratorActivity, markOrchestratorIdle } from "./cache-warmer.js";
import { getToolsAsLLMDefs, executeTool, normalizeToolCall, type SwarmState, type ToolContext } from "../tools/registry.js";
import { isToolAllowed } from "../guardrails/tool-tiers.js";
import { loadTurnPlan, decidePlanContinuation, renderPlanContinuationDirective } from "./turn-plan.js";
import { runQaDeliveryLoop, parseQaVerdict, type QaVerdict } from "./qa-delivery-loop.js";
import {
  buildDeliverableConsistencyCheckMessages,
  buildDeliverableConsistencyRepairInstruction,
  DELIVERABLE_CONSISTENCY_CRITERION,
} from "./deliverable-consistency.js";
import { scanOutput } from "../guardrails/output.js";
import { checkRateLimit } from "../guardrails/rate-limiter.js";
import { logAudit } from "../audit/logger.js";
import { getConfig } from "../config/loader.js";
import {
  runWithEffortContext,
  resolveEffortProfile,
  currentEffortProfile,
  effectiveOrchestration,
  effectiveOrchestratorMaxToolIterations,
  currentEffortTier,
} from "../runtime/effort-context.js";
import {
  classifyTurnProgress,
  buildTurnOversightPrompt,
  parseTurnOversightVerdict,
  TURN_OVERSIGHT_CHECK_INTERVAL_MS,
  type TurnProgressSample,
} from "./turn-oversight.js";
import { childLogger } from "../logger.js";
import type { AgentSession, SessionHistoryMessage } from "./session.js";
import { classifyToolIntervention } from "./interventions.js";
import { getMainAssistantToolNames, type MainAssistantToolMode } from "./default-tools.js";
import { longRunningGenerationManager } from "./long-running-generation.js";
import { turnSteeringManager } from "./turn-steering.js";
import { registerSessionAbortController, deregisterSessionAbortController } from "./warden.js";
import { lookupTrajectory } from "../memory/trajectory-cache.js";
import { artifactFileLooksTruncated, runSubAgent } from "./sub-agent.js";
import { collectJudgeableArtifactRefs, runQaToolJudgeCheck, type QaJudgeArtifactRef } from "./qa-tool-judge.js";
import { join } from "node:path";
import {
  runCorrectiveBuild as runCorrectiveBuildImpl,
  runCorrectiveReroute as runCorrectiveRerouteImpl,
  type CorrectiveContext,
} from "./turn-corrective.js";
// Tool-output post-processing sub-phase of the main loop's per-tool-call body
// (god-file seam): secret redaction → prompt-injection screen → moderation → sig
// cache → callbacks → model-visible framing → append. Carries no loop control.
import { postProcessToolResult, type ToolResultPostProcessContext } from "./turn-tool-execution.js";
import { beginFactTurn } from "../swarm/memory.js";
import {
  buildDynamicTurnGuidance,
  toSoftRoutingHint,
} from "./intent-classifier.js";
import { buildEffectiveResearchSubject } from "./source-sensitive-delegation.js";
import { looksLikeDegenerateRepetition, collapseRepeatedMarkdownSections, looksLikeDegenerateLineRepetition, collapseRepeatedLines } from "./text-dedup.js";
import {
  classifyDeliverableIntent,
  looksLikeInlinedAppDocument,
} from "./deliverable-intent.js";

// Re-export the deliverable-intent module so existing imports from runtime.js
// (tests, tools) keep working after the god-file extraction.
export {
  looksLikeArtifactCreationRequest,
  selectAutoBuildBuilderAgent,
  shouldSuppressRelayForUnbuiltApp,
  looksLikeComposedGuideRequest,
  looksLikeArtifactMutationRequest,
  claimsArtifactWrittenButUnproduced,
  looksLikeFabricatedToolDeliveryLink,
  looksLikeInlinedArtifactFabrication,
  looksLikeInlinedAppDocument,
  extractInlineHtmlDocument,
  looksLikeCompleteHtmlDocument,
  stripLargeCodeFences,
  classifyDeliverableIntent,
  type DeliverableIntent,
} from "./deliverable-intent.js";

// Foundational leaf utilities (god-file seam): small PURE shared helpers moved to
// ./runtime-utils.ts so the runtime.ts ↔ evidence-recovery.ts import cycle is broken.
// runtime-utils.ts imports ONLY leaf modules (types, container-failure); it never
// imports from this file or any runtime-cluster module.
import {
  stableSerialize,
  looksLikeRegurgitatedPriorAnswer,
  looksLikeOrchestrationOnlyEvidence,
} from "./runtime-utils.js";

// Re-export the runtime-utils helpers that external consumers (tests) import from
// runtime.js, so those imports keep working unchanged after the extraction.
export { looksLikeRegurgitatedPriorAnswer } from "./runtime-utils.js";

// Model-visible tool-result framing (god-file seam): buildModelVisibleToolResult
// rewrites raw tool/sub-agent output into the canonical "Delegated result …" frame,
// plus the small pure text helpers it needs. classifyPostOrchestrationDisposition
// (which stays here) uses looksLikeDelegatedFailureEvidence from this module.
import {
  buildModelVisibleToolResult,
  looksLikeDelegatedFailureEvidence,
} from "./tool-result-format.js";

// Re-export the originally-exported buildModelVisibleToolResult so existing imports
// from runtime.js (runtime-delegation-loop.test.ts, runtime-guidance.test.ts) keep working.
export { buildModelVisibleToolResult } from "./tool-result-format.js";

// Turn-preparation phases + the blocked() early-exit builder (god-file seam): the
// pre-loop setup phases of _runTurn and the shared blocked() TurnOutput builder live
// in ./turn-prepare.ts now. They thread state explicitly and depend on no main-loop
// closure; runtime.ts imports them back (one-directional edge, no cycle).
import {
  blocked,
  prepareRateLimit,
  prepareInputGuardrails,
  recordUserTurnMessage,
  prepareReceptionistFastLane,
  prepareDocumentRag,
} from "./turn-prepare.js";

// Terminal user-facing response sanitize/rewrite cluster (god-file seam): pure
// detectors that decide whether a turn's final text needs sanitizing, resynthesis,
// or terminal rewriting, plus recovery-evidence fallback inspectors. The three
// functions that need runtime singletons (rewriteTerminalResponseIfNeeded,
// finalizeUserFacingAssistantResponse, resolveEmptyAssistantResponseFallback) stay
// in this file.
import {
  sanitizeUserFacingAssistantResponse,
  EMPTY_ASSISTANT_RESPONSE_FALLBACK,
  looksLikeGenericNoUsableReply,
  shouldResynthesizeUserFacingResponse,
  looksLikeContinuationPromise,
  looksLikeMaintenanceExecutionPromise,
  shouldRewriteTerminalResponse,
  hasRecentUnresolvedDelegatedAction,
  hasRecentWorkflowAuthoringMaintenanceContext,
  isForcedSynthesisSystemMessage,
  hasRecentForcedSynthesisNudge,
  findRecentJunkDelegationResult,
  findRecentFailedDelegation,
} from "./response-finalization.js";

// Required-research fallback routing + search-agents-no-match cluster (god-file
// seam): pure routing helpers that push a stalled source-sensitive turn into a
// research delegation, build the canonical fallback route/prompt, and enforce it.
import {
  extractAgentRoutingSuggestionFromMetadata,
  searchAgentsReturnedNoMatch,
  buildRequiredResearchFallbackRoute,
  buildSearchAgentsNoMatchFallbackPrompt,
  enforceRequiredResearchFallbackRouteOnToolCall,
  isExplicitAgentCatalogRequest,
  type RequiredResearchFallbackRoute,
} from "./research-fallback-routing.js";

// Re-export the originally-exported research-fallback route builder so existing
// imports from runtime.js (research-fallback-route-scoped.test.ts) keep working.
export { buildRequiredResearchFallbackRoute } from "./research-fallback-routing.js";

// Pure raw-evidence/shared-facts dump detectors + formatters (god-file seam).
import {
  looksLikeRawSharedFactsDump,
  looksLikeRawWorkspaceToolDump,
  looksLikeRawToolEvidenceDump,
} from "./runtime-evidence-dump.js";

// Re-export the originally-exported detectors so existing imports from runtime.js
// (tests, tools) keep working after the extraction.
export {
  isJunkEvidenceValue,
  looksLikeRawSharedFactsDump,
  looksLikeRawWorkspaceToolDump,
  looksLikeRawToolEvidenceDump,
  stripLeadingDelegateLabelEcho,
} from "./runtime-evidence-dump.js";

// Pure honesty / source-caveat / synthesis-directive text helpers (god-file seam).
import {
  buildSynthesisRequiredDirective,
  userMessageCarriesActionableUrl,
  looksLikeUnsourcedSpecificClaims,
  prependTurnIncompleteCaveat,
} from "./citation-honesty.js";

// Re-export the originally-exported honesty helpers so existing imports from
// runtime.js (tests, tools) keep working after the extraction.
export {
  buildSynthesisRequiredDirective,
  prependUnverifiedSourceCaveat,
  answerPresentsSourceCitations,
  stripFabricatedCitations,
} from "./citation-honesty.js";

// Terminal honesty/guard blocks that fire on the assembled finalResponse (god-file seam).
import { applyTerminalResponseGuards, type TerminalGuardContext } from "./turn-finalize-guards.js";
// Clean-success terminal tail (god-file seam).
import { finalizeSuccessfulTurn } from "./turn-success-finalize.js";

// D5 delegation-wait budget math (shared with the gateway hard-timeout layer; kept out of this
// heavily-mocked module so gateway/rpc.ts can import it without going through runtime.js).
import { DELEGATION_WAIT_CEILING_MS, extendDeadlineForDelegationWait } from "./delegation-budget.js";

// Pure response/tool-call collapsing + delegation arg helpers (god-file seam).
import {
  deriveDelegationTaskFromArgs,
  getPerTurnToolCallLimit,
  buildDelegationLoopResponse,
  collapseDuplicateToolCallsInResponse,
  collapseExcessDirectDelegationsInResponse,
  collapseMixedOrchestrationLaunchersInResponse,
  collapseMixedDiscoveryAndOrchestrationToolsInResponse,
  buildRepeatedOutputFingerprint,
  PERSISTED_SWARM_STATE_TOOL_NAMES,
  AGENT_DISCOVERY_TOOL_NAMES,
} from "./delegation-response-collapse.js";

// Re-export the originally-exported delegation-arg + response-collapse helpers so
// existing imports from runtime.js (tests, tools) keep working after the extraction.
export {
  deriveDelegationTaskFromArgs,
  getPerTurnToolCallLimit,
  buildDelegationLoopResponse,
  buildRepeatedOutputFingerprint,
} from "./delegation-response-collapse.js";

// Single-deliverable relay shortcut + meta-preamble strip + truncated-code detector
// (god-file seam). The functions still called here are imported; the originally-exported
// ones are re-exported so existing imports from runtime.js (tests) keep working.
import {
  extractSingleRelayableDeliverable,
} from "./deliverable-relay.js";

export {
  stripLeadingReasoningPreamble,
  looksLikeTruncatedCodeDeliverable,
  extractSingleRelayableDeliverable,
} from "./deliverable-relay.js";

// Prior-evidence reuse-don't-re-research nudges (god-file seam). The functions still
// called here are imported; the originally-exported ones are re-exported so existing
// imports from runtime.js (tests) keep working.
import {
  shouldReusePriorDelegateEvidenceForSourceFollowUp,
  buildPriorEvidenceFollowUpPrompt,
  shouldNudgeSessionEvidenceReuse,
  buildSessionEvidenceReuseNudge,
} from "./evidence-reuse-nudge.js";

export {
  shouldNudgeSessionEvidenceReuse,
  buildSessionEvidenceReuseNudge,
} from "./evidence-reuse-nudge.js";

// Workflow-catalog + approved-run routing cluster (god-file seam): catalog
// signal detection / guidance / execution-enforcement prompts and the
// approved-RUN_CANDIDATE follow-up detector all live in their own module now.
import {
  detectWorkflowCatalogSignal,
  buildWorkflowCatalogGuidance,
  isWorkflowCatalogToolName,
  extractWorkflowCatalogMatchesFromMetadata,
  mergeWorkflowCatalogMatches,
  shouldRequireWorkflowExecutionAfterSearch,
  formatWorkflowExecutionPromptFromSearch,
  isWorkflowNameResolutionFailureMessage,
  formatWorkflowExecutionCorrectionPromptFromSearch,
  detectApprovedRunCandidateFollowUp,
  buildApprovedRunCandidateGuidance,
  isApprovedRunCandidateToolCall,
  type WorkflowCatalogMatch,
} from "./workflow-catalog-routing.js";

// Re-export the originally-exported workflow helper + the test-only internals
// object so existing imports from runtime.js (tests) keep working unchanged.
export { shouldRequireWorkflowExecutionAfterSearch, __workflowCatalog } from "./workflow-catalog-routing.js";

// Source-sensitive enforcement cluster (god-file seam): rewrites outgoing
// delegation tool calls on a source-sensitive turn into the verified-evidence-first
// frame while honoring coordinator/builder choices.
import {
  enforceSourceSensitiveOriginalRequestOnToolCall,
  extractPriorTurnContext,
} from "./source-sensitive-enforcement.js";

// Re-export the originally-exported source-sensitive enforcement helpers so
// existing imports from runtime.js (tests) keep working after the extraction.
export {
  enforceSourceSensitiveOriginalRequestOnToolCall,
  ephemeralAgentSpecLacksWebTools,
  hasRecentSourceSensitivePartialDelegation,
} from "./source-sensitive-enforcement.js";

// Interrupted/partial delegation evidence-recovery cluster (god-file seam):
// recovers usable evidence from an interrupted sub-agent's surfaced output and
// finds the richest recent delegate/workflow result to use as a synthesis backstop.
import {
  EVIDENCE_SECTION_RE,
  looksLikeInterruptedDelegationWithoutUsableEvidence,
  measureEvidenceCoverage,
  findRecentDelegateEvidence,
} from "./interrupted-delegation-evidence.js";

// Turn metrics & prompt-sizing cluster (god-file seam): pure, non-loop helpers that
// measure prompt size, perform last-resort base-prompt compaction, and assemble the
// TurnPerformanceMetrics record. The per-stage phase-timing AsyncLocalStorage lives
// there too (runtime.ts wraps each turn in runWithPhaseTimings()).
import {
  runWithPhaseTimings,
  buildTurnPerformanceMetrics,
} from "./turn-metrics.js";

// Re-export the originally-exported metrics symbols so existing imports from
// runtime.js (compactBasePromptUnderPressure test; TurnPerformanceMetrics type used
// by scene-worker.ts + jobs.ts) keep working after the extraction.
export { compactBasePromptUnderPressure } from "./turn-metrics.js";
export type { TurnPerformanceMetrics } from "./turn-metrics.js";

// Turn-failure & never-empty-output cluster (god-file seam): pure, non-loop helpers
// that classify a turn failure, render its marker text, persist a failure record,
// and enforce the never-empty-response invariant on the runTurn boundary.
import {
  classifyTurnFailure,
  recordTurnFailure,
  finalizeTurnOutput,
} from "./turn-failure.js";

// Re-export the originally-exported turn-failure helpers so existing imports from
// runtime.js (runtime-turn-failure.test.ts, runtime-finalize.test.ts) keep working.
export {
  classifyTurnFailure,
  turnFailureMarkerText,
  recordTurnFailure,
  finalizeTurnOutput,
  type TurnFailureKind,
} from "./turn-failure.js";

const log = childLogger("agent:runtime");

const DEFAULT_MAX_TOOL_ITERATIONS = 20;
const MAX_LENGTH_CONTINUATION_ATTEMPTS = 2;
const MAX_CONTINUATION_OVERLAP_CHARS = 400;
// The public turn input/output shapes (RunTurnOptions, TurnOutput) were extracted
// to the leaf module ./turn-types.ts (god-file seam) so the turn-preparation
// helpers can depend on them without importing runtime.js. Re-exported here so
// every external `import { TurnOutput } from ".../runtime.js"` keeps working.
import type { RunTurnOptions, TurnOutput } from "./turn-types.js";
export type { RunTurnOptions, TurnOutput } from "./turn-types.js";

// Shared-facts / evidence / recovery-backstop cluster moved to ./evidence-recovery.ts
// (god-file seam). The functions runtime.ts still calls internally are imported below;
// the originally-exported ones are re-exported so existing imports from runtime.js
// (tests, tools) keep working unchanged.
import {
  formatSharedFactsForFinalSynthesis,
  getSharedFactsEvidenceForFinalSynthesis,
  formatRecoveryEvidenceForFinalUser,
  buildRecoveryEvidenceUserMessage,
  buildResearchGatheredFallback,
  formatSourceSensitiveEvidenceBackstop,
  looksLikeWeakRecoveryEvidence,
  chooseBetterRecoveryEvidence,
} from "./evidence-recovery.js";

export {
  getSharedFactsEvidenceForFinalSynthesis,
  formatSourceSensitiveEvidenceBackstop,
  answerNeedsEvidenceAnchoringRepair,
  chooseBetterRecoveryEvidence,
} from "./evidence-recovery.js";

// Deliverable-intent classifiers + answer-side honesty detectors moved to
// ./deliverable-intent.ts (god-file seam). Re-exported below so existing imports
// from runtime.js (tests, tools) keep working unchanged.


// Source-sensitive evidence anchoring (sourceSensitiveEvidenceTokens,
// looksEvidenceAnchored, extractSpecTokensFromDraft, isClaimNegatedIn,
// NEGATION_MARKERS) was extracted to ./evidence-anchoring.ts (first god-file
// decomposition seam). looksEvidenceAnchored is imported at the top.

// Source-sensitive enforcement cluster (defaultResearchFallbackAgentsFor,
// withDefaultResearchFallbackAgents, hasRecentSourceSensitivePartialDelegation,
// hasRecentSparseSourceSensitiveMemoryReuse, extractPriorTurnContext,
// ephemeralAgentSpecLacksWebTools, sourceSensitiveSliceKeepsOwnTask,
// enforceSourceSensitiveOriginalRequestOnToolCall) was extracted to
// ./source-sensitive-enforcement.ts (god-file seam). The functions still called
// here are imported at the top; the originally-exported ones are re-exported there.

const __swarmStateContinuity = {
  loadPreviousTurnSwarmTasks,
  buildPersistableSwarmTaskDelta,
};

export { __swarmStateContinuity };

async function rewriteTerminalResponseIfNeeded(
  response: string,
  toolIterations: number,
  session: AgentSession,
  provider: ChatProvider,
  signal: AbortSignal,
): Promise<string> {
  if (!shouldRewriteTerminalResponse(response, toolIterations)) {
    return response;
  }

  const rewritten = await forceSynthesis(
    session,
    provider,
    signal,
    "Write the final user-facing answer for this turn now. This turn is ending. Do NOT promise that you will do another tool call, delegation, orchestration step, or investigation next. Do NOT say 'I will now', 'next orchestration', or similar future-action phrasing unless that action already happened. Do NOT turn a proposed next step into a completed action: phrases in delegated evidence like 'I will now attempt...' or 'the next step...' are not proof that the action ran, and you must not say a next step 'has been executed' unless this turn includes the completed tool result for that action. Either give the best current answer from the gathered evidence or ask one concise user-facing question if a user decision is required.",
  );

  const cleaned = sanitizeUserFacingAssistantResponse(rewritten ?? "", 0);
  if (!cleaned) return response;
  // When the original is substantive (> 300 chars), only replace it with
  // the rewrite if the rewrite is itself substantive relative to the
  // original.  The common failure mode: delegated-evidence text that
  // incidentally contains "I will …" / "ich werde …" triggers a rewrite
  // call, but forceSynthesis returns a short apology (≤ 100–200 chars)
  // because the model has nothing new to add.  In that situation the
  // original evidence is far more useful than the stub.
  if (response.length > 300 && cleaned.length < Math.max(200, Math.ceil(response.length * 0.25))) {
    return response;
  }
  return cleaned;
}

async function finalizeUserFacingAssistantResponse(
  rawResponse: string,
  toolIterations: number,
  session: AgentSession,
  provider: ChatProvider,
  signal: AbortSignal,
): Promise<string> {
  const cleaned = sanitizeUserFacingAssistantResponse(rawResponse, toolIterations);
  let resolved: string;
  if (!shouldResynthesizeUserFacingResponse(rawResponse, cleaned, toolIterations)) {
    const stableResponse = resolveEmptyAssistantResponseFallback(rawResponse, cleaned, session);
    resolved = await rewriteTerminalResponseIfNeeded(stableResponse, toolIterations, session, provider, signal);
  } else {
    const synthesized = await forceSynthesis(
      session,
      provider,
      signal,
      "You have already executed the necessary tools. Write the final user-facing answer now."
      + " Synthesize the tool results and [SHARED FINDINGS AVAILABLE] entries into a complete, well-structured answer in the user's language."
      + " Do NOT echo raw shared-finding key names (e.g. auto_xxx_yyy) — convert them into readable sentences."
      + " Do NOT narrate searches, fetches, document generation, or tool calls. Never include literal [Tool: ...] traces.",
    );
    if (synthesized) {
      const cleanedSynthesized = sanitizeUserFacingAssistantResponse(synthesized, 0);
      if (cleanedSynthesized) {
        resolved = await rewriteTerminalResponseIfNeeded(cleanedSynthesized, toolIterations, session, provider, signal);
      } else {
        const fallback = resolveEmptyAssistantResponseFallback(rawResponse, cleaned, session);
        resolved = await rewriteTerminalResponseIfNeeded(fallback, toolIterations, session, provider, signal);
      }
    } else {
      const fallback = resolveEmptyAssistantResponseFallback(rawResponse, cleaned, session);
      resolved = await rewriteTerminalResponseIfNeeded(fallback, toolIterations, session, provider, signal);
    }
  }

  return await enforceDelegateCoverage(resolved, toolIterations, session, provider, signal);
}


function resolveEmptyAssistantResponseFallback(
  rawResponse: string,
  cleaned: string,
  session: AgentSession,
): string {
  const stableResponse = cleaned || rawResponse.trim();
  if (stableResponse) return stableResponse;

  const history = session.getHistory();
  if (hasRecentForcedSynthesisNudge(history)) {
    const evidence = findRecentDelegateEvidence(history);
    if (evidence) {
      logAudit(
        "guardrail_flagged",
        {
          type: "empty_response_evidence_backstop",
          evidenceLength: evidence.evidence.length,
          evidenceItems: evidence.itemCount,
        },
        { sessionId: session.id, channel: session.channel, severity: "warn" },
      );
      // Format the evidence before returning — raw shared-fact key dumps
      // (auto_xxx_yyy: "...") and orchestration scaffolding must not reach
      // the user verbatim; formatRecoveryEvidenceForFinalUser renders them
      // into a bilingual partial-answer preamble that is at least readable.
      return formatRecoveryEvidenceForFinalUser(evidence.evidence);
    }
  }

  // Diagnostic fallback: when the model produced no usable text AND the
  // most recent tool result is a failed delegation, the generic "please
  // try again" placeholder is unhelpful — the user gets no signal about
  // WHY their request couldn't be answered.  Surface a short diagnostic
  // that names the failed agent and the failure reason instead, so they
  // can decide whether to retry, rephrase, or ask for a different path.
  // Common case: a containerized sub-agent crashed (Docker daemon down,
  // image missing, OOM) and the model couldn't recover synthesis on its
  // own (typical when the request needed live evidence the user couldn't
  // provide inline).
  const recentFailedDelegation = findRecentFailedDelegation(history);
  if (recentFailedDelegation) {
    logAudit(
      "guardrail_flagged",
      {
        type: "empty_response_failed_delegation_diagnostic",
        agentName: recentFailedDelegation.agentName,
        reason: recentFailedDelegation.reason.slice(0, 200),
      },
      { sessionId: session.id, channel: session.channel, severity: "warn" },
    );
    return recentFailedDelegation.message;
  }

  return EMPTY_ASSISTANT_RESPONSE_FALLBACK;
}

// Interrupted/partial delegation evidence-recovery cluster
// (stripInterruptedSubAgentBoilerplate, stripRecoveredSnippetToolLabel,
// stripDelegationProgressPrefix, collectInterruptedDelegationSnippets,
// extractUsefulInterruptedDelegationEvidence,
// looksLikeInterruptedDelegationWithoutUsableEvidence, measureEvidenceCoverage,
// lastUserMessageIndex, findRecentDelegateEvidence) + the WORKFLOW_TOOL_RESULT_RE /
// EVIDENCE_SECTION_RE constants were extracted to ./interrupted-delegation-evidence.ts
// (god-file seam). The four functions + two regexes still used here are imported at
// the top.

// Single-deliverable relay shortcut + meta-preamble strip + truncated-code detector
// (stripLeadingReasoningPreamble, looksLikeTruncatedCodeDeliverable,
// extractSingleRelayableDeliverable) moved to ./deliverable-relay.ts (god-file seam).
// The functions still called here are imported at the top; the originally-exported ones
// are re-exported there.

// Repetition-collapse helpers live in ./text-dedup.js so the runtime relay/final
// sanitizer AND the sub-agent passthrough share one guard. Re-exported here to keep
// the existing public import surface (tests, callers) stable.
export { looksLikeDegenerateRepetition, collapseRepeatedMarkdownSections, looksLikeDegenerateLineRepetition, collapseRepeatedLines };

// Prior-evidence reuse-don't-re-research nudges
// (shouldReusePriorDelegateEvidenceForSourceFollowUp, buildPriorEvidenceFollowUpPrompt,
// shouldNudgeSessionEvidenceReuse, buildSessionEvidenceReuseNudge) moved to
// ./evidence-reuse-nudge.ts (god-file seam). The functions still called here are imported
// at the top; the originally-exported ones are re-exported there.

/**
 * Decide whether to skip the LLM synthesis call entirely and surface the
 * delegated evidence verbatim.  Fires when either the model has been
 * caught looping on rejected tool calls (`synthesis_required_tool_call_rejected`)
 * or the runtime hit max iterations with substantial evidence already in
 * the transcript.  The threshold deliberately accepts modest evidence
 * payloads — operators repeatedly hit the failure mode where 1-2 KB of
 * tool output exists but the synthesis call returns 50-100 chars of
 * apology, leaving the user with effectively no answer.
 */
/**
 * Terminal finish reasons that indicate the runtime is "giving up" after
 * a tool/orchestration loop — there's no useful work left to do, but we
 * still owe the user the evidence we already have.  Extends beyond the
 * original `synthesis_required_tool_call_rejected` to cover:
 *
 *  - `all_tool_calls_blocked`: model kept retrying tools that hit
 *    per-turn caps — operator-visible 73-char "I can't" replies.
 *  - `max_tool_iterations`: hit the iteration cap; the previous fallback
 *    message ("I've gathered partial results...") is technically truthful
 *    but throws away the partial results.
 */
const EVIDENCE_BACKSTOP_GIVE_UP_REASONS = new Set([
  "synthesis_required_tool_call_rejected",
  "all_tool_calls_blocked",
  "max_tool_iterations",
  // Warden hard-stop after two consecutive delegation failures: same contract — the
  // runtime is giving up on orchestration, so surface the evidence already gathered
  // (e.g. shared findings) instead of a generic synthesis (audit 0602f246).
  "delegation_failures_terminal",
]);

/**
 * ALLOWLIST of tools that actually ADVANCE a "must orchestrate before answering"
 * turn — delegation launchers + the discovery tools that feed them. When the
 * runtime forces a tool call to COMPEL orchestration (cost-center 1), the forced
 * candidate set is restricted to THESE only.
 *
 * This is deliberately an allowlist, not a blocklist: tool_choice:"required" forces
 * SOME tool, and the slow local model otherwise satisfies it with whatever cheap
 * no-op tool is in scope and loops on it without ever delegating — first
 * memory_store (audit be828e39: ×3 → max_tool_iterations → unsourced fabrication),
 * then record_plan (audit, 5-mic probe: ×3 → "writing final from evidence" with
 * zero research). A blocklist just moves the escape hatch to the next no-op tool;
 * an allowlist closes them all, including any added later. Memory/self/plan/state
 * tools (memory_*, recall_context, record_plan, get_swarm_state, …) are excluded
 * by omission — they're still freely available on non-forced iterations.
 */
const FORCE_ORCHESTRATION_TOOLS = new Set([
  "delegate_to_agent",
  "parallel_delegate",
  "swarm_delegate",
  "run_workflow",
  "run_task_graph",
  "search_agents",
  "search_workflows",
  "list_agents",
  "create_ephemeral_agent",
]);

/** Keep only orchestration/delegation tools so a forced tool call can ONLY be
 * satisfied by an action that advances the turn. Exported for testing. */
export function filterForcedOrchestrationTools<T extends { name: string }>(tools: readonly T[]): T[] {
  return tools.filter((tool) => FORCE_ORCHESTRATION_TOOLS.has(tool.name));
}

function shouldBypassTerminalSynthesisWithEvidence(
  finishReason: string,
  evidence: { evidence: string; itemCount: number } | null,
): boolean {
  if (!evidence) return false;
  if (!EVIDENCE_BACKSTOP_GIVE_UP_REASONS.has(finishReason)) return false;
  // Threshold: anything materially structured (>= 4 items) OR >= 800 chars
  // is good enough to stand on its own as a backstop answer.  The previous
  // 4000-char / 12-item bar excluded most real-world delegated outputs and
  // forced the runtime through a synthesis path that consistently produced
  // empty / apologetic 50–100 char replies.
  return evidence.itemCount >= 4 || evidence.evidence.length >= 800;
}

/**
 * Catch the post-synthesis case the bypass missed: the synthesis call ran,
 * but came back with a suspiciously short reply while substantial evidence
 * is still sitting in the transcript.  In that situation the answer the
 * user actually wants is the evidence — not whatever 50-100 char fragment
 * the synthesis produced.
 */
function looksLikeUnderpoweredSynthesis(synthesized: string | null): boolean {
  if (synthesized === null) return true;
  const trimmed = synthesized.trim();
  if (trimmed.length === 0) return true;
  // 300 chars is roughly two paragraphs of substantive text — anything
  // shorter for a turn that did real tool work is almost certainly an
  // apology, an empty acknowledgement, or a refusal.
  if (trimmed.length < 300) return true;
  if (looksLikeGenericNoUsableReply(trimmed)) return true;
  // Refusal / apology shapes that don't carry information.
  if (/^(?:i\s+(?:am\s+)?(?:sorry|unable|can(?:not|'?t)|wasn'?t\s+able)|sorry,\s+i)\b/i.test(trimmed)
    && trimmed.length < 600) {
    return true;
  }
  return false;
}

async function enforceDelegateCoverage(
  finalResponse: string,
  toolIterations: number,
  session: AgentSession,
  provider: ChatProvider,
  signal: AbortSignal,
): Promise<string> {
  if (toolIterations === 0) return finalResponse;
  if (!finalResponse || finalResponse.length < 50) return finalResponse;

  // Coverage is about THIS turn's delegated evidence only — never a prior
  // turn's deliverable (which would otherwise win the richness score).
  const evidence = findRecentDelegateEvidence(session.getHistory(), { scopeToCurrentTurn: true });
  if (!evidence) return finalResponse;

  const initialCoverage = measureEvidenceCoverage(finalResponse, evidence);
  const finalItems = initialCoverage.textItems;
  const itemShortfall = initialCoverage.itemShortfall;
  const lengthShortfall = initialCoverage.lengthShortfall;

  if (!itemShortfall && !lengthShortfall) return finalResponse;

  // A15: Action-task exemption. Delete, move, archive, send, and similar
  // mutation tasks produce short confirmation responses that legitimately
  // do not enumerate all evidence items — the evidence is an intermediate
  // listing the agent fetched before acting, not the deliverable itself.
  // Replacing a valid "I deleted 3 emails" confirmation with the raw email
  // listing confuses the user and makes it look like nothing happened.
  const ACTION_COMPLETION_RE =
    /\b(deleted?|gelöscht|archiv(?:iert|ed?)|moved?|verschoben|sent|gesendet|forwarded?|weitergeleitet|replied?|beantwortet|created?|erstellt|cleared?|geleert|removed?|entfernt|marked?|markiert|emptied?|erfolgreich|successfully|abgeschlossen|erledigt|fertig)\b/i;
  const TRUNCATION_CLAIM_QUICK_RE =
    /\b(abgeschnitten|truncated|cut off|nicht sichtbar|cannot see)\b/i;
  if (ACTION_COMPLETION_RE.test(finalResponse) && !TRUNCATION_CLAIM_QUICK_RE.test(finalResponse)) {
    return finalResponse;
  }

  // I14: Hallucinated-truncation detector. When the model's draft answer
  // CLAIMS the evidence is truncated, cut off, abgeschnitten, or "not
  // visible in my context" while substantial structured evidence is
  // actually sitting in the most recent tool result, no amount of
  // re-prompting will fix it — the model has convinced itself the data
  // is gone. Detect that pattern and present the evidence verbatim
  // instead of going through another LLM round-trip that will produce
  // the same hallucination.
  const HALLUCINATED_TRUNCATION_RE =
    /\b(abgeschnitten|truncated|cut off|nicht sichtbar|in meinem Kontext nicht|not visible|content (is|was) (truncated|missing|cut)|Ergebnis(?:blöcke|inhalt) (?:wurden?|ist|sind)\s+(?:hier\s+)?(?:abgeschnitten|nicht)|cannot see|kann (?:ich)? (?:die|den)\s+\w+\s+nicht (?:sehen|finden))/i;
  // Evidence is "rich" when EITHER it has many structured items OR it
  // is large in absolute terms relative to the draft. The item-only
  // gate misses unstructured prose deliverables and bold-numbered
  // headlines that the counter previously missed.
  const evidenceIsRich =
    (evidence.evidence.length >= 1500 && evidence.itemCount >= 5)
    || (evidence.evidence.length >= 1500
        && finalResponse.length < Math.ceil(evidence.evidence.length * 0.3));
  const draftClaimsTruncation = HALLUCINATED_TRUNCATION_RE.test(finalResponse);
  if (evidenceIsRich && draftClaimsTruncation) {
    logAudit(
      "hallucinated_truncation_bypass",
      {
        evidenceLength: evidence.evidence.length,
        evidenceItems: evidence.itemCount,
        finalLength: finalResponse.length,
        finalItems,
        bypassReason: "model_claimed_truncation_with_evidence_present",
      },
      { sessionId: session.id, channel: session.channel, severity: "warn" },
    );
    return evidence.evidence;
  }

  logAudit(
    "coverage_shortfall_resynthesis",
    {
      evidenceLength: evidence.evidence.length,
      evidenceItems: evidence.itemCount,
      finalLength: finalResponse.length,
      finalItems,
      itemShortfall,
      lengthShortfall,
    },
    { sessionId: session.id, channel: session.channel, severity: "warn" },
  );

  // E24: structured synthesis template with evidence enumeration. We give
  // the model a fill-in-the-blanks checklist so it has to visibly account
  // for each item rather than drift into a summary that drops rows.
  const enumerationTemplate = evidence.itemCount >= 3
    ? ` Use this structure:\n\n### All items from the evidence\n1. <first item — full text with source>\n2. <second item — full text with source>\n... continue for all ${evidence.itemCount} items.\n\n### Summary\n<one short paragraph>\n\n`
    : "";
  const instruction = [
    "COVERAGE CORRECTION: Your previous draft answer dropped material from the most recent delegated tool result.",
    `The delegated evidence contained ${evidence.itemCount} structured items (bullets, numbered list rows, or table rows) and ${evidence.evidence.length} characters of content,`,
    `but your draft contained only ${finalItems} items and ${finalResponse.length} characters.`,
    "Rewrite the answer NOW so it includes EVERY item, headline, source, URL, name, number, and source attribution from the delegated evidence above.",
    "If the evidence covers multiple sources (e.g. several news outlets, several repositories, several findings), your answer MUST visibly cover ALL of them \u2014 do not keep only the first source.",
    "Preserve the structure (numbered list, bullets, table) and headings of the evidence.",
    "Do NOT summarize, do NOT trim, do NOT collapse rows into 'and others', do NOT add markers like '(truncated)' or '(abgeschnitten)'.",
    "Do NOT claim the evidence is truncated, cut off, abgeschnitten, or invisible \u2014 the FULL evidence is in the tool result above and you MUST relay it verbatim.",
    "Do NOT call any tools \u2014 the evidence is already collected. Just rewrite the user-facing answer.",
    enumerationTemplate ? `\n\nREQUIRED OUTPUT TEMPLATE:${enumerationTemplate}` : "",
  ].filter(Boolean).join(" ");

  const resynth = await forceSynthesis(session, provider, signal, instruction);
  if (!resynth) {
    // Resynthesis failed entirely (e.g. local GPU returned null/empty after
    // a long session).  When rich evidence exists, always prefer surfacing the
    // coordinator's full answer over keeping the under-synthesized draft —
    // regardless of whether the draft claimed truncation.
    if (evidenceIsRich) {
      return evidence.evidence;
    }
    return finalResponse;
  }
  const cleanedResynth = sanitizeUserFacingAssistantResponse(resynth, 0);
  if (!cleanedResynth) return finalResponse;
  // I14: If the resynthesis ALSO claims truncation while rich evidence
  // exists, the model is locked into the hallucination. Bypass to the
  // raw evidence rather than ship either bad draft.
  if (evidenceIsRich && HALLUCINATED_TRUNCATION_RE.test(cleanedResynth)) {
    logAudit(
      "hallucinated_truncation_bypass",
      {
        evidenceLength: evidence.evidence.length,
        evidenceItems: evidence.itemCount,
        finalLength: finalResponse.length,
        finalItems,
        resynthLength: cleanedResynth.length,
        bypassReason: "resynthesis_repeated_truncation_claim",
      },
      { sessionId: session.id, channel: session.channel, severity: "warn" },
    );
    return evidence.evidence;
  }
  // Only accept if the resynthesis genuinely improved coverage.
  const resynthCoverage = measureEvidenceCoverage(cleanedResynth, evidence);
  const newItems = resynthCoverage.textItems;
  const improved = cleanedResynth.length > finalResponse.length * 1.2 || newItems > finalItems;
  if (!improved) {
    // Resynthesis did not materially improve the undercovered answer.
    // When rich delegated evidence exists, prefer that evidence over
    // keeping the incomplete summary that triggered correction.
    if (evidenceIsRich) {
      return evidence.evidence;
    }
    return finalResponse;
  }
  if (resynthCoverage.itemShortfall || resynthCoverage.lengthShortfall) {
    logAudit(
      "hallucinated_truncation_bypass",
      {
        evidenceLength: evidence.evidence.length,
        evidenceItems: evidence.itemCount,
        finalLength: finalResponse.length,
        finalItems,
        resynthLength: cleanedResynth.length,
        resynthItems: newItems,
        bypassReason: "resynthesis_still_under_coverage_threshold",
      },
      { sessionId: session.id, channel: session.channel, severity: "warn" },
    );
    return evidence.evidence;
  }
  return await rewriteTerminalResponseIfNeeded(cleanedResynth, toolIterations, session, provider, signal);
}

const CONTINUATION_CUE_RE = /\b(next (logical )?(step|action)|n[äa]chste (logische )?(schritt|aktion)|before summarizing|continue orchestration|continue with|drill down|inspect the contents|fetch the contents|final required action|determine the actual data file format|extract the raw numerical values)\b/i;
const USER_INTERACTION_CUE_RE = /\b(please confirm|confirm .* before|approval required|needs approval|ask the user|missing .* from the user|which one|which option|clarify|need the user to|authorization reference|approved target scope)\b/i;

type PostOrchestrationDisposition = "continue" | "synthesize" | "ask_user" | "failure" | "none";

/** D2: a run_task_graph tool result carries {completed,failed,blocked} arrays. It is a failure when
 * the result is a genuine graph (has a `completed` array) and ANY node failed or was blocked — such a
 * graph did NOT deliver its objective. Pure/exported for direct unit testing; the classifier only
 * consults it when orchestration.taskGraphFailureDisposition is on. */
export function taskGraphResultIsFailure(metadata: Record<string, unknown>): boolean {
  if (!Array.isArray(metadata["completed"])) return false;
  const failed = Array.isArray(metadata["failed"]) && (metadata["failed"] as unknown[]).length > 0;
  const blocked = Array.isArray(metadata["blocked"]) && (metadata["blocked"] as unknown[]).length > 0;
  return failed || blocked;
}

export function classifyPostOrchestrationDisposition(
  toolResultMessages: Array<LLMMessage & { metadata?: Record<string, unknown> }>,
): PostOrchestrationDisposition {
  // D2 (run e3cf6c22): a run_task_graph with failed/blocked nodes emits "Task graph finished with
  // incomplete status" (tool-result-format.ts) — the success-only "Task graph completed" match below
  // misses it, so a FAILED graph was dropped from disposition entirely (→ none) and the failed-research
  // honesty backstop never armed. When the flag is on, recognize the incomplete-graph result too.
  const taskGraphFailureDisposition = getConfig().orchestration?.taskGraphFailureDisposition === true;
  const orchestrationResults = toolResultMessages.filter((message) => {
    const text = typeof message.content === "string" ? message.content : "";
    const isWorkflowExecutionResult = /^Workflow\s+.+\s+\[[^\]]+\]\s+(blocked|completed)\./i.test(text);
    const isIncompleteTaskGraph = taskGraphFailureDisposition && text.includes("Task graph finished with incomplete status");
    return text.includes("Observed evidence:")
      && (
        text.includes("Delegated result from")
        || text.includes("Parallel delegation completed")
        || text.includes("Task graph completed")
        || isIncompleteTaskGraph
        || isWorkflowExecutionResult
        || text.includes("Ephemeral agent ")
      );
  });

  if (orchestrationResults.length === 0) {
    return "none";
  }

  let sawContinuationCue = false;

  for (const message of orchestrationResults) {
    const text = typeof message.content === "string" ? message.content : "";
    const metadata = message.metadata ?? {};
    const agentName = typeof metadata["agentName"] === "string"
      ? String(metadata["agentName"])
      : (text.match(/^Delegated result from\s+([^\s—]+)/m)?.[1] ?? "");
    const terminalState = typeof metadata["terminalState"] === "string" ? String(metadata["terminalState"]) : undefined;
    const delegationSucceeded = metadata["delegationSucceeded"] !== false;
    const delegationOutcome = typeof metadata["delegationOutcome"] === "string" ? String(metadata["delegationOutcome"]) : undefined;
    const delegationPartial = delegationOutcome === "partial";
    const evidenceMatch = EVIDENCE_SECTION_RE.exec(text);
    const observedEvidence = evidenceMatch
      ? text.slice(evidenceMatch.index + evidenceMatch[0].length).trim()
      : text;
    const hasInterruptedShape = /Partial progress before interruption:|Recovered evidence snippets from completed tools:/i.test(observedEvidence);
    const interruptedPartialWithoutUsableEvidence = agentName !== "computer_use_agent"
      && delegationPartial
      && (looksLikeInterruptedDelegationWithoutUsableEvidence(text) || (!hasInterruptedShape && looksLikeOrchestrationOnlyEvidence(observedEvidence)));

    if (USER_INTERACTION_CUE_RE.test(text)) {
      return "ask_user";
    }

    if (/^Delegated result from .+ — TASK FAILED\./m.test(text)) {
      return "failure";
    }

    if (/^Ephemeral agent .+ failed\./m.test(text)) {
      return "failure";
    }

    // D2: a run_task_graph result carries {completed,failed,blocked} arrays. A graph with ANY failed
    // or blocked node did NOT deliver its objective — classify as a delegation failure so the
    // failed-research honesty backstop arms (else the turn synthesizes a confident from-memory answer
    // as if the graph had succeeded). Structural (metadata arrays), gated. The completed-array check
    // scopes this to genuine graph results, and a fully-successful graph (empty failed+blocked) falls
    // through to the normal success handling below.
    if (taskGraphFailureDisposition && taskGraphResultIsFailure(metadata)) {
      return "failure";
    }

    // run_workflow results carry the runtime's own structured verdict — trust
    // it over text heuristics. The completed-workflow instruction preamble
    // contains phrases like "marks as incomplete" that the failure-keyword
    // sniff below misreads as failure evidence (audit 802d4791: a fully
    // successful sourced_presentation run was branded "[DELEGATION FAILED]",
    // the model re-ran the entire 10-minute job, and the warden then
    // force-stopped two SUCCESSFUL runs as "consecutive failures").
    if (/^Workflow\s+\S+\s+\[[^\]]+\]\s+(?:blocked|completed)\./i.test(text)) {
      if (metadata["blocked"] === true || /^Workflow\s+\S+\s+\[[^\]]+\]\s+blocked\./i.test(text)) {
        return "failure";
      }
      const stepCount = typeof metadata["stepCount"] === "number" ? metadata["stepCount"] : undefined;
      const executedSteps = typeof metadata["executedSteps"] === "number" ? metadata["executedSteps"] : undefined;
      const artifactCount = Array.isArray(metadata["artifacts"]) ? (metadata["artifacts"] as unknown[]).length : 0;
      const fullyExecuted = stepCount !== undefined && stepCount > 0 && executedSteps !== undefined && executedSteps >= stepCount;
      if (fullyExecuted || artifactCount > 0) {
        if (CONTINUATION_CUE_RE.test(observedEvidence)) {
          sawContinuationCue = true;
        }
        continue;
      }
    }

    if (
      interruptedPartialWithoutUsableEvidence
      || !delegationSucceeded
      || delegationOutcome === "failure"
      || (!delegationPartial && terminalState && terminalState !== "completed")
      // Sniff only the delegated EVIDENCE, never the harness-built instruction
      // preamble above it — preamble wording must not be classifiable as a
      // failure signal (same defect class as the workflow case above).
      || (!delegationPartial && looksLikeDelegatedFailureEvidence(observedEvidence))
    ) {
      return "failure";
    }

    // A timed-out partial result carries enough evidence to synthesize from.
    // Force "synthesize" immediately rather than letting the model re-delegate.
    if (delegationPartial && terminalState === "timeout") {
      return "synthesize";
    }

    if (CONTINUATION_CUE_RE.test(text)) {
      sawContinuationCue = true;
    }
  }

  return sawContinuationCue ? "continue" : "synthesize";
}

// buildModelVisibleToolResult + its small pure text helpers (truncateForContext,
// truncatePlainText, escapeRegExp, stripAgentPrefix, stripWorkflowPreamble,
// looksLikeDelegatedFailureEvidence) were extracted to ./tool-result-format.ts
// (god-file seam). They touch no main-loop closure. Imported + re-exported above;
// classifyPostOrchestrationDisposition uses looksLikeDelegatedFailureEvidence from there.

export function buildTemporalContextPrompt(now: Date = new Date()): string {
  const formattedDate = now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const isoDate = now.toISOString().slice(0, 10);
  return [
    `Authoritative temporal context for this turn: today's date is ${formattedDate} (${isoDate}). Current year: ${now.getFullYear()}.`,
    "If the answer mentions the current date, year, recency, deadlines, schedules, or terms like today, latest, current, next, or recent, it must be consistent with this date.",
    "When tool results provide dated evidence, prefer the freshest dated evidence and never fall back to older model memory.",
  ].join(" ");
}

export async function runTurn(opts: RunTurnOptions): Promise<TurnOutput> {
  // Tell the prompt-cache warm-keeper the orchestrator model is busy (abort any
  // in-flight warm-up so it never queues ahead of this turn); re-arm on completion.
  markOrchestratorActivity();
  try {
    // Establish a fresh per-turn phase-timing store, then run the turn inside it so
    // timedPhase() calls anywhere in the turn record into THIS turn's map.
    return await runWithPhaseTimings(() => runTurnImpl(opts));
  } finally {
    markOrchestratorIdle();
  }
}

/** Tools where the orchestrator BLOCKS awaiting delegated children — their wall-clock duration is the
 *  "parent waiting for kids" time excluded from the turn budget by D5 (excludeDelegationWaitFromTurnBudget). */
const DELEGATION_WAIT_TOOL_NAMES = new Set([
  "delegate_to_agent", "swarm_delegate", "parallel_delegate", "run_task_graph", "run_workflow",
]);

async function runTurnImpl(opts: RunTurnOptions): Promise<TurnOutput> {
  const config = getConfig();
  // Per-turn timeout — inline override wins, then the active effort profile's timeout
  // (0 = unlimited), then config, then default 15 min. An explicit override of 0
  // disables the timeout entirely. (The gateway normally folds the profile timeout
  // into turnTimeoutOverrideMs already; this fallback covers non-gateway callers.)
  const effortProfileTimeout = resolveEffortProfile(opts.effortTier).turnTimeoutMs;
  const resolvedTurnTimeoutMs = opts.turnTimeoutOverrideMs ?? effortProfileTimeout ?? config.gateway?.turnTimeoutMs ?? 1_800_000;
  const turnTimeoutMs = resolvedTurnTimeoutMs > 0 ? resolvedTurnTimeoutMs : undefined;
  const turnAbort = turnTimeoutMs ? new AbortController() : undefined;
  const inertAbort = new AbortController();
  const turnStartMs = Date.now();
  // Absolute deadline for this turn — captured when the abort timer is armed so a delegated sub-agent
  // can clamp to the parent's REMAINING budget (D3). MUTABLE: the delegation-wait exclusion (D5) pushes
  // it out while the orchestrator is BLOCKED awaiting a child, but never past turnDeadlineCeilingMs.
  let turnDeadlineMs = turnTimeoutMs ? turnStartMs + turnTimeoutMs : undefined;
  const turnDeadlineCeilingMs = turnTimeoutMs ? turnStartMs + DELEGATION_WAIT_CEILING_MS : undefined;
  let timeoutHandle = turnAbort && turnTimeoutMs
    ? setTimeout(() => turnAbort.abort(), turnTimeoutMs)
    : undefined;
  // D5 (orchestration.excludeDelegationWaitFromTurnBudget): push the turn deadline out by `ms` (the
  // wall-clock the orchestrator sat BLOCKED awaiting a delegated child) and re-arm the abort, so the
  // tier budget bounds the parent's OWN work — not its children's. Bounded by the absolute ceiling;
  // a no-op when there is no timeout (max effort). Returns the new deadline to mirror onto the ctx.
  const extendTurnDeadlineForDelegationWait = (ms: number): number | undefined => {
    if (!turnAbort || turnDeadlineMs === undefined || turnDeadlineCeilingMs === undefined || ms <= 0) {
      return turnDeadlineMs;
    }
    turnDeadlineMs = extendDeadlineForDelegationWait(turnDeadlineMs, ms, turnDeadlineCeilingMs);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    timeoutHandle = setTimeout(() => turnAbort.abort(), Math.max(0, turnDeadlineMs - Date.now()));
    return turnDeadlineMs;
  };

  // Warden abort: allows the Warden to cancel this turn mid-flight on severe anomalies.
  const wardenAbort = new AbortController();
  const sessionId = opts.session.id;
  registerSessionAbortController(sessionId, wardenAbort);
  // Fresh turn: clear any per-turn "operator stopped" latch so a stop in a
  // previous turn never auto-stops this one's long-running generations.
  longRunningGenerationManager.clearStopRequested(sessionId);
  // Mark this turn live so the user can steer it mid-flight (drained in the loop);
  // cleared in the finally below so the active flag never leaks across turns.
  turnSteeringManager.markTurnActive(sessionId);

  // Merge caller signal + timeout signal + warden signal: any source can cancel the turn.
  const allSignals: AbortSignal[] = [];
  if (opts.signal) allSignals.push(opts.signal);
  if (turnAbort) allSignals.push(turnAbort.signal);
  allSignals.push(wardenAbort.signal);
  const signal: AbortSignal = allSignals.length === 1
    ? allSignals[0]!
    : AbortSignal.any(allSignals);

  try {
    // Activate the effort profile for the whole turn so the scattered
    // getConfig().orchestration reads (via effectiveOrchestration()) and the
    // reasoning/prompt/iteration knobs pick it up without threading a parameter
    // through every helper.
    const out = await runWithEffortContext(opts.effortTier, () =>
      _runTurn(opts, signal, turnAbort?.signal ?? inertAbort.signal, {
        deadlineMs: turnDeadlineMs,
        extendForDelegationWait: extendTurnDeadlineForDelegationWait,
      }));
    return finalizeTurnOutput(out, sessionId);
  } catch (err) {
    // A thrown/aborted turn (provider hard-timeout, the per-turn timeout abort, a
    // Warden cancel, or any unexpected throw) bypasses finalizeTurnOutput's
    // never-empty guard AND, historically, left no trace in the session record:
    // no audit event and no assistant message, so the failed turn was invisible
    // in exports/history (the user just saw their question hang). Record the
    // failure so it is always visible, then rethrow to preserve the gateway's
    // error contract (it surfaces status:error to the live client). Intentional
    // cancels (user stop / a superseding newer turn) are not recorded.
    const kind = classifyTurnFailure({
      callerAborted: opts.signal?.aborted === true,
      turnTimedOut: turnAbort?.signal.aborted === true,
      wardenAborted: wardenAbort.signal.aborted === true,
    });
    recordTurnFailure(opts.session, err, kind);
    throw err;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    deregisterSessionAbortController(sessionId);
    turnSteeringManager.markTurnDone(sessionId);
  }
}

// ── Turn-preparation phases ──────────────────────────────────────────────────
// The cleanly-separable pre-loop setup phases (prepareRateLimit,
// prepareInputGuardrails, recordUserTurnMessage, prepareReceptionistFastLane,
// prepareDocumentRag) and the blocked() TurnOutput builder were extracted to
// ./turn-prepare.ts (god-file seam). They thread state explicitly and depend on
// no main-loop closure. Imported above; _runTurn calls them exactly as before.

async function _runTurn(
  opts: RunTurnOptions,
  signal: AbortSignal,
  timeoutSignal: AbortSignal,
  turnBudget?: { deadlineMs?: number; extendForDelegationWait: (ms: number) => number | undefined },
): Promise<TurnOutput> {
  const { session, userMessage } = opts;
  const guardrailEvents: TurnOutput["guardrailEvents"] = [];
  const turnStartedAt = Date.now();
  // Scope the delegation reuse short-circuit to THIS turn's gathered facts:
  // a fresh user query must not be served stale facts from an earlier turn
  // (audit 2f4f5fe6). Sub-agent runs do not pass through _runTurn, so their
  // share_finding calls correctly accumulate into the current turn's set.
  beginFactTurn(session.id);
  let firstModelResponseMs: number | undefined;
  let llmCalls = 0;
  let llmTimeMs = 0;
  let toolCallsRequested = 0;
  let toolExecutionTimeMs = 0;
  let lastPromptMetrics = {
    systemPromptChars: 0,
    collapsedHistoryMessages: 0,
    collapsedHistoryChars: 0,
    promptChars: 0,
  };

  // ── Rate limit check ──────────────────────────────────────────────────────
  const rateLimited = await prepareRateLimit(session);
  if (rateLimited) return rateLimited;

  // ── Input guardrail ───────────────────────────────────────────────────────
  const inputBlocked = await prepareInputGuardrails(userMessage, session, guardrailEvents);
  if (inputBlocked) return inputBlocked;

  // ── Build message history + deterministic assistant-rename persistence ──────
  await recordUserTurnMessage(opts, session, userMessage);

  const detectedDynamicGuidance = buildDynamicTurnGuidance(userMessage);
  const hasTurnAttachments = Boolean(opts.userAttachments?.length);

  // ── Receptionist fast lane ────────────────────────────────────────────────
  // Opt-in first-contact gatekeeper (config.receptionist.enabled). When no task
  // intent was detected, try answering a trivial conversational turn with a tiny
  // routing-tier model + a compressed memory capsule, skipping the full system
  // prompt, tool loading, and the swarm loop. Any miss — registered escalate
  // term, no routing tier, model escalation, error — returns null and falls
  // through to the full path below, so this only ever shortcuts trivial turns.
  // The user message is already recorded and input guardrails have already run.
  // Runs BEFORE document-RAG augmentation so a trivial "hi" never pays the
  // (CPU-bound) engram search cost; turns WITH attachments skip the fast lane so
  // their files are always ingested + injected below.
  const fastLaneOutput = await prepareReceptionistFastLane({
    eligible: detectedDynamicGuidance === null && !hasTurnAttachments && getConfig().receptionist?.enabled === true,
    userMessage,
    signal,
    opts,
    session,
    guardrailEvents,
    turnStartedAt,
  });
  if (fastLaneOutput) return fastLaneOutput;

  // ── Document RAG augmentation ───────────────────────────────────────────────
  // Runs AFTER the fast lane, so trivial turns never pay the engram search cost.
  // Auto-ingests files attached this turn into the session corpus (engram, via
  // the file-MCP extractor) and injects the most relevant excerpts as a transient
  // [DOCUMENT CONTEXT] system message so the assistant answers from the source.
  // No-op when documentRag is disabled / engram is unreachable. Never fatal.
  const { documentRagFoundDocs } = await prepareDocumentRag({
    detectedDynamicGuidance,
    userMessage,
    opts,
    session,
  });

  const priorDelegateEvidenceForFollowUp = findRecentDelegateEvidence(session.getHistory());
  const reusePriorDelegateEvidenceForFollowUp = shouldReusePriorDelegateEvidenceForSourceFollowUp(
    userMessage,
    detectedDynamicGuidance,
    priorDelegateEvidenceForFollowUp,
  );
  const effectiveToolMode: MainAssistantToolMode | undefined = detectedDynamicGuidance?.computerAccessSensitive && !detectedDynamicGuidance?.pentestSensitive
    ? "delegate_only"
    : ((detectedDynamicGuidance?.freshnessSensitive || (detectedDynamicGuidance?.sourceSensitive && !reusePriorDelegateEvidenceForFollowUp) || detectedDynamicGuidance?.artifactSensitive)
        ? "orchestration_only"
        : undefined);
  const initialDynamicGuidance = reusePriorDelegateEvidenceForFollowUp
    ? null
    : effectiveToolMode
    ? (buildDynamicTurnGuidance(userMessage, effectiveToolMode) ?? detectedDynamicGuidance)
    : detectedDynamicGuidance;
  // Canonical research subject for source-sensitive / required-research
  // delegations. A bare follow-up like "validate your response" carries no
  // topic; fold in the prior turn's request + answer so the specialist
  // researches the right thing instead of bouncing with "what should I
  // research?" (regression: session 3a35cff0).
  const { priorUserRequest, priorAssistantAnswer } = extractPriorTurnContext(session.getHistory(), userMessage);
  const researchSubject = buildEffectiveResearchSubject(userMessage, priorUserRequest, priorAssistantAnswer);
  // The turn's deliverable intent, classified ONCE. Every finalization gate below
  // (auto-build, relay suppression, false-completion nets) consumes this single
  // object — N gates independently re-classifying the same message is exactly how
  // the two-autopilot conflicts of v0.30/v0.31 happened.
  const deliverableIntent = classifyDeliverableIntent(userMessage);
  // The model's OWN build spec, rescued when the research-first rewrite or the
  // surplus-delegation filter discards a builder delegation. The corrective build
  // uses it as the blueprint instead of running on generic facts alone (audit
  // c2f76a00: a detailed quiz-app spec was dropped → 4KB welcome page got built).
  let stashedBuilderTaskSpec: string | null = null;
  const stashDiscardedBuilderTask = (spec: string): void => {
    if (!stashedBuilderTaskSpec) stashedBuilderTaskSpec = spec;
  };
  const priorEvidenceFollowUpPrompt = reusePriorDelegateEvidenceForFollowUp && priorDelegateEvidenceForFollowUp
    ? buildPriorEvidenceFollowUpPrompt(priorDelegateEvidenceForFollowUp)
    : "";
  // Reuse-don't-re-research nudge (audit 17f53ed0): broader, structural sibling of the
  // narrow source-sensitive reuse path above — keeps a refinement turn from re-running
  // the full research mission whose evidence is already in this session's history.
  const sessionEvidenceReuseNudge = shouldNudgeSessionEvidenceReuse({
    enabled: effectiveOrchestration().reuseSessionEvidenceOnRefinement === true,
    narrowReuseAlreadyFired: reusePriorDelegateEvidenceForFollowUp,
    priorEvidence: priorDelegateEvidenceForFollowUp,
    userMessage,
  })
    ? buildSessionEvidenceReuseNudge(priorDelegateEvidenceForFollowUp!)
    : "";
  if (sessionEvidenceReuseNudge && priorDelegateEvidenceForFollowUp) {
    logAudit("session_evidence_reuse_nudged", {
      evidenceChars: priorDelegateEvidenceForFollowUp.evidence.length,
      evidenceItems: priorDelegateEvidenceForFollowUp.itemCount,
    }, { sessionId: session.id });
  }
  let allowedToolNames = getMainAssistantToolNames(effectiveToolMode);
  const suppressAgentCatalogTool = Boolean(
    (initialDynamicGuidance?.freshnessSensitive || initialDynamicGuidance?.sourceSensitive || initialDynamicGuidance?.artifactSensitive)
    && !isExplicitAgentCatalogRequest(userMessage),
  );
  if (suppressAgentCatalogTool) {
    allowedToolNames = allowedToolNames.filter((toolName) => toolName !== "list_agents");
  }
  const allowedToolNameSet = new Set(allowedToolNames);
  const recentWorkflowAuthoringMaintenanceContext = hasRecentWorkflowAuthoringMaintenanceContext(session.getHistory());
  const workflowCatalogSignal = detectWorkflowCatalogSignal(userMessage);
  const approvedRunCandidateFollowUp = detectApprovedRunCandidateFollowUp(session.getHistory(), userMessage);
  const tools = getToolsAsLLMDefs(allowedToolNames);
  // Register tool schema size on the session so the history trimmer accounts
  // for the full actual prompt cost (system + tool schemas + history), and the
  // context window of the model actually running this turn so the trimmer
  // budgets against the real window rather than the global default.
  session.setToolSchemasChars(JSON.stringify(tools).length);
  session.setContextWindow(getConfig().agents.defaults.model.contextWindow);
  const resolvedApprovalCallback = opts.autoApprove
    ? async (_toolName: string, _args: Record<string, unknown>) => true
    : opts.approvalCallback;

  const carriedSwarmTasks = loadPreviousTurnSwarmTasks(session.getHistory());
  const carriedSwarmTaskFingerprint = stableSerialize(carriedSwarmTasks);
  const toolContext: ToolContext = {
    sessionId: session.id,
    workspacePath: session.getWorkspacePath(),
    userId: session.userId,
    approvalCallback: resolvedApprovalCallback,
    inputCallback: opts.inputCallback,
    onSubAgentProgress: opts.onSubAgentProgress,
    onComputerAction: opts.onComputerAction,
    onComputerScreenshot: opts.onComputerScreenshot,
    onComputerSessionState: opts.onComputerSessionState,
    allowedAgents: opts.allowedAgents,
    allowedTools: allowedToolNames,
    humanInLoopSteps: opts.humanInLoopSteps,
    autoApprove: opts.autoApprove,
    maxIterationsOverride: opts.maxIterationsOverride,
    turnTimeoutOverrideMs: opts.turnTimeoutOverrideMs,
    onSwarmState: opts.onSwarmState,
    signal,
    _turnDeadlineMs: turnBudget?.deadlineMs,
    _workflowExecutionStack: opts._workflowExecutionStack,
    swarmState: {
      objective: userMessage,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // Seed from previous turn so retries reuse completed research instead of
      // running the same sub-agent tasks from scratch.
      tasks: carriedSwarmTasks,
    },
  };
  let turnUsedSwarmTools = false;
  const getTurnSwarmState = (): SwarmState | undefined => selectPersistableSwarmState(
    toolContext.swarmState,
    carriedSwarmTasks,
    carriedSwarmTaskFingerprint,
    turnUsedSwarmTools,
  );

  const totalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let iterationCount = 0;
  // Per-tool output tracking within this turn — detects stuck loops (same result ≥N times).
  const _recentOutputsByTool = new Map<string, string[]>();
  const _turnToolCallCounts = new Map<string, number>();
  const _lastToolResultByName = new Map<string, string>();
  const _lastToolCallSig = new Map<string, { args: string; result: string; metadata?: Record<string, unknown> }>();
  const IDENTICAL_OUTPUT_LOOP_THRESHOLD = 3;
  // Iteration-level loop detection — tracks tool-name sets across iterations.
  const _iterationToolSets: string[] = [];
  const ITERATION_LOOP_THRESHOLD = 4;
  // Assistant text repetition detection — catches the LLM re-emitting identical text each iteration.
  let _lastAssistantContent = "";
  // Per-tool consecutive-iteration streak — catches tools re-appearing even when the full set varies.
  const _toolIterationStreak = new Map<string, number>();
  const TOOL_STREAK_THRESHOLD = 3;
  // Consecutive iterations where every tool call was blocked (per-turn limit / not-allowed).
  let _consecutiveFullyBlockedIterations = 0;
  // D16: Consecutive delegation failures — when ≥2, escalate to warden-stop synthesis.
  let _consecutiveDelegationFailures = 0;
  // Max-effort turn oversight (turn-oversight.ts): at `max` the watchdog + final-QA gate
  // are off, so a turn that keeps re-delegating a dying build can churn forever. These
  // track the windowed turn-wide progress sample + whether a corrective redirect has
  // already been injected, so a second stuck window escalates to the never-empty floor.
  let _oversightLastCheckAt = Date.now();
  let _oversightLastSample: TurnProgressSample = { completionTokens: 0, toolCalls: 0, delegations: 0, artifacts: 0, delegationFailures: 0 };
  let _oversightRedirectIssued = false;
  // I8: Reused-delegation counter — `executeDelegationWithFallback` returns
  // metadata.reused=true when a coordinator paraphrases a task whose
  // signature already completed in this session. After 2 reuses in one turn
  // the coordinator is clearly stuck re-asking for finished work; we stop and
  // synthesize from the cached output instead of burning more LLM iterations.
  let _turnReusedDelegationCount = 0;
  const REUSED_DELEGATION_LOOP_THRESHOLD = 2;
  // F29: Turn-level scorecard accumulators
  let _turnDelegationCount = 0;
  let _turnShareFindingCount = 0;
  let _forcedSynthesisFired = false;
  // Final-response QA gate: at most ONE corrective build per turn (shared latch across both
  // finalization paths — normal-stop and forced-terminal).
  let qaCorrectiveBuildUsed = false;

  // Dependency carrier for the two bounded corrective bodies (extracted verbatim to
  // ./turn-corrective.ts). Read-only fields are the turn's stable values; the getter
  // callbacks read live mutable/late-bound enclosing state (iterationCount, the chat
  // provider defined later this turn, the shared qaCorrectiveBuildUsed latch, the
  // per-turn delegation counter, the stashed builder spec); the function callbacks are
  // runtime-private helpers/closures the moved bodies still call. The call sites read
  // qaCorrectiveBuildUsed back off the same latch the setter mutates here.
  const correctiveCtx: CorrectiveContext = {
    signal,
    session,
    userMessage,
    deliverableIntent,
    toolContext,
    onStatus: opts.onStatus,
    getIterationCount: () => iterationCount,
    getProvider: () => provider,
    getStashedBuilderTaskSpec: () => stashedBuilderTaskSpec,
    getQaCorrectiveBuildUsed: () => qaCorrectiveBuildUsed,
    setQaCorrectiveBuildUsed: (v) => { qaCorrectiveBuildUsed = v; },
    incrementDelegationCount: () => { _turnDelegationCount += 1; },
    forceSynthesis,
    selectCorrectiveResumeTarget,
    collectTurnArtifactAttachments,
    extractArtifactsFromMetadata,
    logWarn: (obj, msg) => log.warn(obj, msg),
  };
  // One bounded corrective build for the completion QA gate: when the user asked to BUILD an
  // artifact and none was produced, delegate to the right builder, record the assistant+tool
  // pair so the artifact surfaces as a download, and synthesize a confirmation. Returns the
  // confirmation message if a real artifact was produced, else null (caller keeps its draft).
  const runCorrectiveBuild = (buildContext: string): Promise<string | null> => runCorrectiveBuildImpl(buildContext, correctiveCtx);

  // One bounded corrective RE-ROUTE for the zero-work fabrication guard on NON-artifact
  // requests: the model fabricated a tool-minted deliverable for a question that never
  // asked for an artifact (e.g. a mail/lookup request answered with an invented link).
  // A BUILD TASK would compound the fabrication with a deliverable nobody wanted
  // (session 24826c33: "Schau mal ob ich neue Emails habe" → BUILD TASK → researcher →
  // canned "Der Bau ist fehlgeschlagen"). Instead, re-dispatch the ORIGINAL request once
  // through autonomous delegation (no agentName — bidding/semantic routing picks the
  // specialist, the same path the user's manual follow-up would take) and ship the
  // specialist's answer. Returns the deliverable text, or null when the delegation
  // failed or returned nothing shippable (the caller then sends an honest denial).
  const runCorrectiveReroute = (): Promise<string | null> => runCorrectiveRerouteImpl(correctiveCtx);
  // G33: Collected share_finding texts for trajectory cache write
  const sharedFindingsThisTurn: string[] = [];
  // Phase 3: skills injected into the planner this turn — outcomes recorded at
  // turn end so retrieval reliability is learned (success rate drives ranking).
  let injectedSkillSlugs: string[] = [];
  // Skills that matched this turn but were deliberately held out (not injected)
  // for lift measurement — their outcome is recorded as a baseline at turn end.
  let heldOutSkillSlugs: string[] = [];
  // Shared findings injected into the main LLM context after delegations complete.
  // Populated once after the first delegation tool result arrives so the main
  // orchestrator's final synthesis call sees verified sub-agent findings rather
  // than falling back to training-data hallucinations.
  let _sharedFindingsSystemMessage = "";
  const FULLY_BLOCKED_ITERATION_THRESHOLD = 2;
  // Soft routing enforcement (Flaw 2): when on, the routing-class enforcement
  // prompts (maintenance / workflow-catalog / search-no-match) are injected as
  // advisory hints rather than hard "You MUST … this turn" gates, and the hard
  // search_agents tool-removal gate is relaxed. Anti-hallucination (source-
  // sensitive research) and correctness (unresolved clarification) enforcement
  // stay hard. Default off — flipping it on changes tuned routing behavior and
  // should be gated on live-model eval.
  const softRoutingEnforcement = getConfig().agents.performance.softRoutingEnforcement === true;
  const applyRoutingTone = (text: string): string =>
    softRoutingEnforcement && text ? toSoftRoutingHint(text) : text;
  // A workflow-channel session is a scoped scene/job STEP: the author already wrote its
  // task (which names the exact agent) and its allowedAgents. The top-level source-sensitive
  // TASK rewrite must NOT fire here — it re-frames the step's delegation as a generic "WEB
  // RESEARCH TASK" and appends researcher/mission_coordinator fallbacks the step forbids,
  // so e.g. the image step gets routed to researcher and hard-fails (audit 158f1435). The
  // research-routing NUDGE stays on, but its fallback route is now allowedAgents-aware
  // (buildRequiredResearchFallbackRoute) so it targets the step's OWN agent, never an agent
  // outside the scene. The TOP-LEVEL launching turn (user channel) keeps full enforcement.
  const inWorkflowStep = session.channel === "workflow";
  // Anti-hallucination: a freshness- OR source-sensitive turn must run real
  // research — never a tool-free answer from training memory. Freshness used to
  // be exempted (advisory-only) because its keyword heuristic was a false-positive
  // magnet (weak terms "jetzt"/"now"). Those weak terms were removed from
  // FRESHNESS_HINT_TERMS, so the flag is now high-precision (heute, aktuell, news,
  // latest, current, recent, today, neueste, year) and a query carrying one that
  // the model answers tool-free is fabricating current state (audit fe496ec5:
  // "news von heute" → a 2.5KB invented bulletin — DAX 24.000, EZB 3,75 %, IPCC,
  // ESA Artemis, all hallucinated, zero delegations). The model still gets to
  // answer first; this only catches a tool-free draft and routes it through the
  // re-nudge → autoResearchOnRefusal path, which ends with REAL searched results
  // and never dead-ends empty. (`trustModelRouting` governs only soft routing
  // nudges now; it no longer exempts this correctness gate.)
  const requiresDelegatedResearch = effectiveToolMode === "orchestration_only"
    && Boolean(
      initialDynamicGuidance?.sourceSensitive
      || initialDynamicGuidance?.freshnessSensitive,
    );
  const requiresArtifactDelegation = effectiveToolMode === "orchestration_only"
    && Boolean(initialDynamicGuidance?.artifactSensitive);
  const activeMainAssistantToolMode = effectiveToolMode ?? getConfig().agents.mainAssistant.toolMode;
  // Structural URL-fetch enforcement (orchestration.urlFetchEnforcement, default off). A URL in
  // the user's message means they handed the assistant a page to READ. The de-lex hardwired
  // sourceSensitive off, which silently starved the force-fetch enforcement below and let the model
  // invent a page's contents + claim it "loaded" the link (live session 29796f86). Re-arm it from a
  // purely STRUCTURAL signal — a URL regex on the message, no topic/language keywords — so a
  // tool-free answer about the page is rejected and a real fetch is forced (reusing the intact
  // nudge → auto-delegate → grounded-synthesis path). Orchestration mode only (the orchestrator
  // must delegate to fetch); hybrid/direct assistants read the URL with their own web tools.
  const requiresUrlFetch = getConfig().orchestration?.urlFetchEnforcement === true
    && activeMainAssistantToolMode === "orchestration_only"
    && userMessageCarriesActionableUrl(userMessage)
    // Exempt a message that also PASTED substantial inline content (the page body alongside its
    // URL): the answer can be grounded in what the user already handed over, so forcing a re-fetch
    // is a needless delegation. Structural (same inline-content signal answered-from elsewhere);
    // can only make the guard fire LESS, never more.
    && !initialDynamicGuidance?.inlineAnalyticalContent;
  const requiresSwarmMaintenanceDelegation = activeMainAssistantToolMode !== "hybrid"
    && Boolean(initialDynamicGuidance?.swarmMaintenanceSensitive)
    && allowedToolNameSet.has("delegate_to_agent");
  const requiresMaintenanceFollowUpDelegation = recentWorkflowAuthoringMaintenanceContext
    && (allowedToolNameSet.has("delegate_to_agent")
      || allowedToolNameSet.has("parallel_delegate")
      || allowedToolNameSet.has("run_task_graph")
      || allowedToolNameSet.has("create_ephemeral_agent"));
  const requiresMaintenanceDelegation = requiresSwarmMaintenanceDelegation || requiresMaintenanceFollowUpDelegation;
  let delegatedResearchRetryUsed = false;
  let delegatedResearchEnforcementPrompt = "";
  let maintenanceDelegationRetryUsed = false;
  let maintenanceMisrouteRetryUsed = false;
  let maintenanceDelegationEnforcementPrompt = "";
  let unresolvedDelegationContinuationRetryUsed = false;
  let unresolvedDelegationEnforcementPrompt = "";
  // Synthesis-required-after-junk recovery retry. The synthesis-required
  // guardrail rejects further tool calls once a forced-synthesis nudge is in
  // history — the right behavior when the prior delegation actually returned
  // substantial evidence. But when the prior delegation TIMED OUT and what
  // the model received was a truncated stub, the model's recovery delegation
  // is correct: there is nothing useful to synthesize from. Allow ONE such
  // recovery retry per turn (Fix 3).
  let synthesisRequiredRecoveryRetryUsed = false;
  let synthesisRequiredBuilderBuildUsed = false;
  const isWorkflowExecutionTurn = session.channel === "workflow" || (opts._workflowExecutionStack?.length ?? 0) > 0;
  const workflowCatalogSuppressedForMaintenance = Boolean(
    initialDynamicGuidance?.swarmMaintenanceSensitive || recentWorkflowAuthoringMaintenanceContext,
  );
  const workflowCatalogGuidance = !isWorkflowExecutionTurn && !workflowCatalogSuppressedForMaintenance && workflowCatalogSignal.required
    ? buildWorkflowCatalogGuidance(workflowCatalogSignal)
    : "";
  const approvedRunCandidateGuidance = !isWorkflowExecutionTurn && approvedRunCandidateFollowUp
    ? buildApprovedRunCandidateGuidance(approvedRunCandidateFollowUp)
    : "";
  const workflowCatalogRequired = Boolean(
    (allowedToolNameSet.has("search_workflows") || allowedToolNameSet.has("run_workflow"))
    && !isWorkflowExecutionTurn
    && !initialDynamicGuidance?.pentestMethodologySensitive
    && !workflowCatalogSuppressedForMaintenance
    && workflowCatalogSignal.required
    // Uncertain matches advise the model to ASK the user; they do NOT enforce
    // that a workflow tool must be called this turn.
    && workflowCatalogSignal.reason !== "uncertain_match",
  );
  let workflowCatalogRetryUsed = false;
  let workflowCatalogEnforcementPrompt = "";
  // Seed from history: if the previous turn already ran search_workflows / run_workflow in this
  // session, skip the catalog-check enforcement on the follow-up turn (e.g. "try again").
  // We only look in messages that belong to the immediately prior completed turn — between the
  // second-to-last user message and the current (most recent) user message.
  const workflowCatalogAttemptedInPriorTurn = (() => {
    if (!workflowCatalogRequired) return false;
    const hist = session.getHistory();
    let foundCurrentUser = false;
    for (let i = hist.length - 1; i >= Math.max(0, hist.length - 40); i--) {
      const msg = hist[i];
      if (msg?.role === "user") {
        if (!foundCurrentUser) { foundCurrentUser = true; continue; }
        // Reached the start of the prior turn — stop here
        break;
      }
      if (msg?.role === "assistant" && Array.isArray(msg.tool_calls)) {
        if (msg.tool_calls.some((tc) => isWorkflowCatalogToolName(tc.function.name))) {
          return true;
        }
      }
    }
    return false;
  })();
  let workflowCatalogAttemptedThisTurn = workflowCatalogAttemptedInPriorTurn;
  let workflowExecutionRetryUsed = false;
  let workflowExecutionForceUsed = false;
  let workflowRedirectUsed = false;
  let workflowExecutionCorrectionRetryUsed = false;
  let workflowExecutionEnforcementPrompt = "";
  let approvedRunCandidateRetryUsed = false;
  let approvedRunCandidateEnforcementPrompt = "";
  let workflowSearchMatches: WorkflowCatalogMatch[] = [];
  let workflowRunCompletedThisTurn = false;
  // Track the most recent assistant text content that we suppressed because
  // the model emitted it alongside (rejected-or-not) tool calls.  When the
  // turn ends in a give-up state (synthesis loop, all tool calls blocked,
  // max iterations) AND the synthesis call itself comes back empty / short,
  // the suppressed text is still the closest thing we have to a real
  // answer the model wrote — better than the 73-char apology that
  // operators have been reporting.
  let lastSuppressedAssistantText: string | null = null;
  let pendingSearchAgentSuggestion: { agentName: string; query?: string; fallbackAgents?: string[] } | undefined;
  let searchAgentsNoMatchCount = 0;
  let requiredResearchFallbackRoute: RequiredResearchFallbackRoute | null = null;
  let searchAgentsNoMatchFallbackPrompt = "";
  // Reasoning controls: an explicit per-message thinking toggle wins; otherwise the
  // active effort profile drives enableThinking + reasoningEffort for this turn.
  const turnEffortProfile = currentEffortProfile();
  const turnThinking = opts.enableThinking ?? turnEffortProfile?.enableThinking;
  const turnReasoningEffort = turnEffortProfile?.reasoningEffort;
  const provider = (turnThinking !== undefined || turnReasoningEffort !== undefined)
    ? getChatProviderWithOverride({
        ...(turnThinking !== undefined ? { enableThinking: turnThinking } : {}),
        ...(turnReasoningEffort !== undefined ? { reasoningEffort: turnReasoningEffort } : {}),
      })
    : getChatProvider();
  // Tool development sessions have no iteration cap — they use convergence-based completion
  // and lease/heartbeat oversight via the tool-dev-warden instead.
  const isToolDevSession = !!opts._toolDevSessionId;
  const maxToolIterations = isToolDevSession
    ? Number.MAX_SAFE_INTEGER
    : (opts.maxIterationsOverride === 0
        ? Number.MAX_SAFE_INTEGER
        : (opts.maxIterationsOverride ?? effectiveOrchestratorMaxToolIterations() ?? getConfig().agents.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS));
  // Lean, droppable effort prompt-chunk (high/max tiers) — nudges the model toward
  // depth/completeness for the whole turn. Empty for low/medium.
  const effortPromptAddendum = currentEffortProfile()?.promptAddendum ?? "";
  let terminalSynthesisInstruction =
    "You have reached the tool-call limit for this turn. Using ONLY the information gathered in the tool results above, write a complete, useful response to the original request. Do NOT call any more tools. If data is incomplete, acknowledge it and provide the best answer possible with what you have.";
  let terminalFinishReason = "max_tool_iterations";
  // ── G33: Trajectory cache lookup ─────────────────────────────────────────
  // Before the first LLM call, check if we have a cached trajectory for a
  // semantically similar recent query.  If yes, inject it as extra system context
  // so the model can decide whether to reuse or re-research the evidence.
  let trajectoryInjectionContext = "";
  let injectedTrajectoryIdentity: { normalizedQuery: string; finishedAt: string } | null = null;
  try {
    const cachedHit = await lookupTrajectory(
      userMessage,
      session.getWorkspacePath(),
      initialDynamicGuidance?.freshnessSensitive ?? false,
    );
    const cachedTrajectory = cachedHit?.entry ?? null;
    if (cachedTrajectory && cachedTrajectory.finalAnswer.length > 50) {
      const evidence = cachedTrajectory.sharedFindings.length > 0
        ? `\n\nEvidence gathered:\n${cachedTrajectory.sharedFindings.slice(0, 5).map(f => `• ${f.slice(0, 300)}`).join("\n")}`
        : "";
      trajectoryInjectionContext =
        `[CACHED RECENT EVIDENCE — verify before reuse, cached at ${cachedTrajectory.finishedAt}]\n${cachedTrajectory.finalAnswer.slice(0, 1500)}${evidence}`;
      injectedTrajectoryIdentity = {
        normalizedQuery: cachedTrajectory.normalizedQuery,
        finishedAt: cachedTrajectory.finishedAt,
      };
      logAudit(
        "trajectory_cache_hit",
        {
          similarity: Number(cachedHit!.similarity.toFixed(3)),
          ageMs: Date.now() - new Date(cachedTrajectory.finishedAt).getTime(),
          findingsCount: cachedTrajectory.sharedFindings.length,
          finalAnswerChars: cachedTrajectory.finalAnswer.length,
        },
        { sessionId: session.id, channel: session.channel },
      );
    }
  } catch { /* best-effort — never block the turn */ }

  // ── Main agent loop ───────────────────────────────────────────────────────
  while (iterationCount < maxToolIterations) {
    if (signal.aborted) {
      // Only synthesize when the INTERNAL timeout fired — not when the caller (WS) disconnected.
      // Synthesising after a WS close wastes LLM budget: the result can never be delivered.
      const wasInternalTimeout = timeoutSignal.aborted;
      if (wasInternalTimeout && iterationCount > 0) {
        const synthesized = await forceSynthesis(
          session, provider, signal,
          "The request timed out mid-turn. Using ONLY the tool results gathered so far, write the most useful partial response you can. Be explicit about what was completed and what was not.",
        );
        if (synthesized) {
          // This early-return timeout path does NOT reach applyTerminalResponseGuards below, so a
          // from-memory partial can ship fabricated "verified against sources" specifics unchecked
          // (session e3cf6c22). The timeout firing is itself proof the work is incomplete/unverified —
          // stamp it honestly, unconditionally (structural, no topic/keyword matching).
          const cleaned = sanitizeUserFacingAssistantResponse(synthesized, iterationCount) || synthesized;
          const finalResponse = prependTurnIncompleteCaveat(cleaned);
          persistAssistantTurnState(session, finalResponse, getTurnSwarmState());
          if (opts.onChunk) opts.onChunk(finalResponse);
          const performance = buildTurnPerformanceMetrics({
            turnStartedAt, firstModelResponseMs, llmCalls, llmTimeMs, toolCallsRequested,
            toolExecutionTimeMs, lastPromptMetrics, completionChars: finalResponse.length,
            finishReason: "aborted_synthesized", blocked: false, toolIterations: iterationCount,
          });
          return {
            response: finalResponse, toolCallsExecuted: iterationCount,
            guardrailEvents, usage: totalUsage, blocked: false,
            swarmState: getTurnSwarmState(), performance,
          };
        }
      }
      return blocked(
        "Request cancelled or timed out",
        getTurnSwarmState(),
        buildTurnPerformanceMetrics({
          turnStartedAt,
          firstModelResponseMs,
          llmCalls,
          llmTimeMs,
          toolCallsRequested,
          toolExecutionTimeMs,
          lastPromptMetrics,
          completionChars: 0,
          finishReason: "aborted",
          blocked: true,
          toolIterations: iterationCount,
        }),
      );
    }

    // Mid-turn user steering: fold any messages the user sent WHILE this turn
    // has been running into the conversation as authoritative guidance before the
    // next model call, so they redirect the remaining work without aborting (Stop
    // is the abort path). Drains the per-turn queue; a no-op on iteration 0 (the
    // queue was cleared at turn start). Opt-out via orchestration.midTurnSteering.
    if (getConfig().orchestration?.midTurnSteering ?? true) {
      const steering = turnSteeringManager.drain(session.id);
      if (steering.length > 0) {
        const joined = steering.map((s) => `- ${s}`).join("\n");
        session.addMessage({
          role: "user",
          content: "[USER STEERING — sent mid-turn] The user added the following while you were working. "
            + "Take it into account in the REMAINING steps of this turn: adjust course, drop now-irrelevant work, and prioritise it. "
            + "Do not restart from scratch or re-do already-completed steps.\n" + joined,
        });
        logAudit("turn_steering_injected", {
          count: steering.length,
          iteration: iterationCount,
        }, { sessionId: session.id, channel: session.channel, severity: "info" });
        opts.onStatus?.({ phase: "steering", message: "Folding in your mid-turn message…", iteration: iterationCount });
      }
    }

    // Max-effort turn oversight: at `max` agents run unbounded with the final-QA gate +
    // never-empty watchdog OFF, so a turn that keeps re-delegating a dying build can churn
    // for minutes and deliver nothing. Once per window, sample the WHOLE turn's forward
    // progress; if it is churning/stalled, ask a small bounded oversight agent for a
    // verdict + ONE corrective directive. `redirect` injects the directive so the turn
    // re-plans (e.g. resume a truncated partial via append); a second stuck window — or a
    // `stuck` verdict — forces the best-available delivery so max ALWAYS finishes. Gated,
    // max-only, fail-open (any judge error leaves the run untouched).
    if (
      currentEffortTier() === "max"
      && effectiveOrchestration().maxEffortTurnOversight === true
      && iterationCount > 0
      && Date.now() - _oversightLastCheckAt >= TURN_OVERSIGHT_CHECK_INTERVAL_MS
    ) {
      _oversightLastCheckAt = Date.now();
      const turnArtifacts = collectTurnArtifactAttachments(session);
      const curSample: TurnProgressSample = {
        completionTokens: totalUsage.completionTokens,
        toolCalls: toolCallsRequested,
        delegations: _turnDelegationCount,
        artifacts: turnArtifacts.length,
        delegationFailures: _consecutiveDelegationFailures,
      };
      const progressSignal = classifyTurnProgress(_oversightLastSample, curSample);
      _oversightLastSample = curSample;
      if (progressSignal !== "progressing") {
        const wsRoot = typeof toolContext.workspacePath === "string" ? toolContext.workspacePath : "";
        const artifactState = turnArtifacts.length === 0
          ? "no artifacts produced yet"
          : turnArtifacts.map((a) => {
              const rel = typeof a["relativePath"] === "string" ? a["relativePath"] : "";
              const name = rel || (typeof a["filename"] === "string" ? a["filename"] : "artifact");
              const trunc = wsRoot && rel ? artifactFileLooksTruncated({ path: join(wsRoot, rel), filename: rel }) : null;
              return `${name}${trunc ? " (appears truncated/incomplete)" : ""}`;
            }).join(", ");
        // Last failure reason, if any — the most recent tool result that reads as an error.
        let lastFailure: string | undefined;
        const hist = session.getHistory();
        for (let i = hist.length - 1, scanned = 0; i >= 0 && scanned < 12; i--, scanned++) {
          const m = hist[i] as unknown as { role: string; content?: unknown };
          if (m.role !== "tool" || typeof m.content !== "string") continue;
          if (/\b(error|failed|interrupted|timed out|cancelled)\b/i.test(m.content)) {
            lastFailure = m.content.slice(0, 400);
            break;
          }
        }
        const oversightPlan = await loadTurnPlan(session.id);
        const recentActivity = [
          _lastAssistantContent.trim() ? `Latest orchestrator output:\n${_lastAssistantContent.slice(0, 1000)}` : "",
          _iterationToolSets.length ? `Recent tool calls by iteration: ${_iterationToolSets.slice(-6).join(" | ")}` : "",
          `Delegations dispatched: ${_turnDelegationCount}; consecutive delegation failures: ${_consecutiveDelegationFailures}`,
        ].filter(Boolean).join("\n\n") || "(no orchestrator output or tool calls yet)";
        let oversight = { verdict: "on_track" as "on_track" | "stuck" | "redirect", directive: "", reason: "" };
        try {
          const judgeProvider = getChatProviderForTier("routing") ?? provider;
          const oversightResp = await judgeProvider.complete(
            buildTurnOversightPrompt({
              objective: oversightPlan?.objective?.trim() || userMessage,
              ...(oversightPlan?.acceptanceCriteria?.length ? { acceptanceCriteria: oversightPlan.acceptanceCriteria } : {}),
              recentActivity,
              artifactState,
              ...(lastFailure ? { lastFailure } : {}),
              signal: progressSignal,
            }),
            [],
            signal,
          );
          oversight = parseTurnOversightVerdict(oversightResp.content);
        } catch {
          // fail-open: an oversight error must never derail a healthy run.
        }
        if (oversight.verdict === "redirect" && oversight.directive && !_oversightRedirectIssued) {
          // RE-PLAN: inject ONE corrective directive and let the turn try again.
          _oversightRedirectIssued = true;
          session.addMessage({
            role: "user",
            content: "[OVERSIGHT — max-effort progress check] A progress monitor judged this turn is not converging on the deliverable. "
              + "Apply this correction in your NEXT step — do NOT restart from scratch or re-do finished work:\n" + oversight.directive,
          });
          logAudit("turn_oversight_redirected", {
            iteration: iterationCount,
            signal: progressSignal,
            reason: oversight.reason,
            directive: oversight.directive.slice(0, 300),
          }, { sessionId: session.id, channel: session.channel, severity: "warn" });
          opts.onStatus?.({ phase: "oversight", message: "Fortschritts-Check: Ich korrigiere den Kurs, um den Auftrag noch abzuschließen.", iteration: iterationCount });
        } else if (oversight.verdict !== "on_track") {
          // STUCK, or a redirect was already tried and the turn is STILL not progressing →
          // never-empty floor: deliver the best result obtainable from what already exists.
          logAudit("turn_oversight_floor", {
            iteration: iterationCount,
            signal: progressSignal,
            verdict: oversight.verdict,
            reason: oversight.reason,
            redirectAlreadyTried: _oversightRedirectIssued,
            artifacts: turnArtifacts.length,
          }, { sessionId: session.id, channel: session.channel, severity: "warn" });
          const synthesized = await forceSynthesis(
            session, provider, signal,
            "A progress monitor determined this max-effort turn can no longer make progress. "
            + "Using ONLY what has already been gathered and any files already produced this turn, deliver the most complete, useful result you can NOW, in the user's language. "
            + "If a file was produced but is incomplete, say so plainly and give its path. Be explicit about what is done and what is not. Do NOT paste large code blocks.",
          );
          if (synthesized) {
            // Same guard-bypass hole as the timeout path: this early return does NOT reach
            // applyTerminalResponseGuards, so a stuck-turn from-memory synthesis could ship fabricated
            // "verified" specifics. The forced floor delivery is itself proof the work is incomplete —
            // stamp it honestly (cause-neutral caveat, structural).
            const cleaned = sanitizeUserFacingAssistantResponse(synthesized, iterationCount) || synthesized;
            const finalResponse = prependTurnIncompleteCaveat(cleaned);
            persistAssistantTurnState(session, finalResponse, getTurnSwarmState());
            if (opts.onChunk) opts.onChunk(finalResponse);
            const performance = buildTurnPerformanceMetrics({
              turnStartedAt, firstModelResponseMs, llmCalls, llmTimeMs, toolCallsRequested,
              toolExecutionTimeMs, lastPromptMetrics, completionChars: finalResponse.length,
              finishReason: "oversight_floor_synthesized", blocked: false, toolIterations: iterationCount,
            });
            return {
              response: finalResponse, toolCallsExecuted: iterationCount,
              guardrailEvents, usage: totalUsage, blocked: false,
              swarmState: getTurnSwarmState(), performance,
            };
          }
          // Synthesis came back empty — fall through and keep looping (never worse than today).
        }
      }
    }

    const {
      messages,
      collapsedHistory,
      dynamicGuidance,
      lastPromptMetrics: assembledPromptMetrics,
      injectedSkillSlugs: assembledInjectedSkillSlugs,
      heldOutSkillSlugs: assembledHeldOutSkillSlugs,
    } = await assembleTurnSystemMessages({
      session,
      iterationCount,
      userMessage,
      initialDynamicGuidance,
      documentRagFoundDocs,
      trajectoryInjectionContext,
      sharedFindingsSystemMessage: _sharedFindingsSystemMessage,
      priorEvidenceFollowUpPrompt,
      sessionEvidenceReuseNudge,
      effortPromptAddendum,
      workflowCatalogGuidance,
      approvedRunCandidateGuidance,
      delegatedResearchEnforcementPrompt,
      searchAgentsNoMatchFallbackPrompt,
      maintenanceDelegationEnforcementPrompt,
      unresolvedDelegationEnforcementPrompt,
      workflowCatalogEnforcementPrompt,
      approvedRunCandidateEnforcementPrompt,
      workflowExecutionEnforcementPrompt,
      injectedSkillSlugs,
      heldOutSkillSlugs,
      applyRoutingTone,
      buildTemporalContextPrompt,
      lastPromptMetrics,
    });
    // Re-bind the loop-mutable outer state from the assembly result: the prompt
    // metrics and skill slugs the loop reads on later iterations / later in this
    // iteration (skill-stickiness audit, prompt-size scorecard).
    lastPromptMetrics = assembledPromptMetrics;
    injectedSkillSlugs = assembledInjectedSkillSlugs;
    heldOutSkillSlugs = assembledHeldOutSkillSlugs;

    if (iterationCount === 0 && dynamicGuidance) {
      logAudit("turn_guidance_applied", {
        sourceSensitive: dynamicGuidance.sourceSensitive,
        freshnessSensitive: dynamicGuidance.freshnessSensitive,
      }, { sessionId: session.id, severity: "info" });
    } else if (iterationCount === 0 && priorEvidenceFollowUpPrompt) {
      logAudit("turn_guidance_applied", {
        sourceSensitive: false,
        freshnessSensitive: false,
        reusedPriorDelegatedEvidence: true,
        originalSourceSensitive: detectedDynamicGuidance?.sourceSensitive ?? false,
      }, { sessionId: session.id, severity: "info" });
    }

    let llmResponse: LLMResponse;
    const llmStartedAt = Date.now();
    llmCalls += 1;
    try {
      const suppressInitialInlineStreaming = iterationCount === 0 && (
        requiresDelegatedResearch
        || requiresArtifactDelegation
        || workflowCatalogRequired
        || requiresMaintenanceDelegation
      );
      const chunkSink = iterationCount === 0 && !suppressInitialInlineStreaming ? opts.onChunk : undefined;
      if (!chunkSink) {
        opts.onStatus?.({
          phase: suppressInitialInlineStreaming ? "routing" : "synthesizing",
          message: suppressInitialInlineStreaming
            ? "Selecting the required specialist path before drafting the answer."
            : "Reviewing completed tool results and preparing the final response.",
          iteration: iterationCount,
        });
      }
      // After a search_agents no-match, the hard gate removes the discovery
      // tools so the model cannot loop on broader keyword retries. Under soft
      // routing enforcement we keep them available and rely on the (softened)
      // fallback hint instead — trust-the-LLM over a hard tool removal.
      const activeTools = (searchAgentsNoMatchFallbackPrompt && !softRoutingEnforcement)
        ? tools.filter((tool) => tool.name !== "search_agents" && tool.name !== "list_agents")
        : tools;
      // Cost-center 1 (audit 5d51862f): while the turn still MUST orchestrate and has NOT
      // yet delegated, force a tool call so the slow local model can't burn ~2 min drafting
      // a tool-free prose answer that the source-sensitive / required-research guardrail
      // then rejects and re-runs. Gated on !delegatedResearchRetryUsed so it releases the
      // moment the routing-nudge fallback path takes over (no dead-end), and on
      // _turnDelegationCount===0 so the model can synthesize freely once a specialist ran.
      // #3 (audit 763394da): `--auto` (autoApprove) means "run autonomously" — a
      // tool-free clarifying question / "I can't create files" refusal (plus a
      // false "I gathered and verified" claim with zero tool calls) is never an
      // acceptable answer to an --auto artifact build. When autonomousModeAntiRefusal
      // is on, an autoApprove turn whose deliverable-intent classifier saw an
      // artifact request also forces the first tool call, even if the narrower
      // requiresArtifactDelegation signal did not fire. Structural (autoApprove +
      // wantsArtifact); no topic/keywords.
      const autonomousArtifactBuild =
        (getConfig().orchestration?.autonomousModeAntiRefusal ?? false)
        && opts.autoApprove === true
        && deliverableIntent.wantsArtifact;
      const mustOrchestrateBeforeAnswering =
        (requiresDelegatedResearch || requiresArtifactDelegation || workflowCatalogRequired || requiresMaintenanceDelegation || autonomousArtifactBuild)
        && !inWorkflowStep
        && !delegatedResearchRetryUsed
        && _turnDelegationCount === 0
        && !workflowRunCompletedThisTurn
        && ((_turnToolCallCounts.get("run_workflow") ?? 0) === 0);
      const wantForceToolChoice = mustOrchestrateBeforeAnswering
        && activeTools.length > 0
        && (getConfig().orchestration?.forceToolChoiceWhenOrchestrationRequired ?? true);
      // When forcing a tool call to compel orchestration, drop the always-available
      // direct memory/self tools so tool_choice:"required" can only be satisfied by a
      // real orchestration/delegation tool. Without this the slow model loops on
      // memory_store and never delegates (audit be828e39).
      const forcedTools = wantForceToolChoice ? filterForcedOrchestrationTools(activeTools) : activeTools;
      const forceToolChoice = wantForceToolChoice && forcedTools.length > 0;
      const streamTools = forceToolChoice ? forcedTools : activeTools;
      llmResponse = await collectStream(
        provider.stream(messages, streamTools, signal, forceToolChoice ? { toolChoice: "required" } : undefined),
        chunkSink,
        {
          deferTextUntilToolDecision: streamTools.length > 0,
          onReasoning: opts.onReasoning,
        },
      );
      const llmDurationMs = Date.now() - llmStartedAt;
      llmTimeMs += llmDurationMs;
      if (firstModelResponseMs === undefined) {
        firstModelResponseMs = Date.now() - turnStartedAt;
      }
      if (llmResponse.reasoning && llmResponse.reasoning.trim()) {
        const reasoningText = llmResponse.reasoning.trim();
        logAudit("agent_reasoning", {
          iteration: iterationCount,
          reasoningChars: reasoningText.length,
          reasoningPreview: reasoningText.slice(0, 2000),
        }, { sessionId: session.id, channel: session.channel, severity: "info" });
      }
      if (llmResponse.tool_calls.length === 0 && llmResponse.finishReason === "length") {
        const continued = await continueLengthLimitedResponse(provider, messages, llmResponse, signal, chunkSink);
        llmResponse = continued.response;
        llmCalls += continued.additionalCalls;
        llmTimeMs += continued.additionalTimeMs;
        if (continued.runawayInlineArtifact) {
          // Orchestrator inlined a giant code block instead of delegating to
          // an artifact-writing specialist. We stopped the length-continuation
          // loop early so the partial doesn't balloon further, but the
          // partial itself is still going out — flag it so the scorecard
          // doesn't claim a clean turn.
          guardrailEvents.push({ type: "runaway_inline_artifact", details: `orchestrator inlined ${llmResponse.content?.length ?? 0} chars of code instead of delegating` });
          logAudit("guardrail_flagged", {
            type: "runaway_inline_artifact",
            completionChars: llmResponse.content?.length ?? 0,
            iteration: iterationCount,
            finishReason: "length",
          }, { sessionId: session.id, channel: session.channel, severity: "warn" });
        }
      } else if (
        llmResponse.tool_calls.length === 0
        && typeof llmResponse.content === "string"
        && looksLikeRunawayInlineArtifact(llmResponse.content)
      ) {
        // Same shape as the length-continuation case, but the model finished
        // cleanly within the completion budget. Observed live in session
        // 006ca6bf turn 12:49: completionChars=40857, finishReason="stop",
        // toolCallsRequested=0 — the orchestrator dumped 40 KB of HTML into
        // chat in one shot and the scorecard reported a clean turn. Flag it
        // here so the audit catches both finishReason="length" AND
        // finishReason="stop" variants of the same failure.
        guardrailEvents.push({ type: "runaway_inline_artifact", details: `orchestrator inlined ${llmResponse.content.length} chars of code in one shot instead of delegating` });
        logAudit("guardrail_flagged", {
          type: "runaway_inline_artifact",
          completionChars: llmResponse.content.length,
          iteration: iterationCount,
          finishReason: llmResponse.finishReason ?? "stop",
        }, { sessionId: session.id, channel: session.channel, severity: "warn" });
      }
    } catch (err) {
      log.error({ err, sessionId: session.id }, "LLM call failed");
      const delegateEvidence = findRecentDelegateEvidence(session.getHistory());
      const sharedFactsEvidence = await getSharedFactsEvidenceForFinalSynthesis(session.id);
      const recoveryEvidence = chooseBetterRecoveryEvidence(delegateEvidence, sharedFactsEvidence, { preferHigherScore: false });
      if (recoveryEvidence) {
        const finalResponse = formatRecoveryEvidenceForFinalUser(recoveryEvidence.evidence, {
          sourceSensitive: initialDynamicGuidance?.sourceSensitive ?? false,
        });
        persistAssistantTurnState(session, finalResponse, getTurnSwarmState());
        if (opts.onChunk) opts.onChunk(finalResponse);
        const performance = buildTurnPerformanceMetrics({
          turnStartedAt,
          firstModelResponseMs,
          llmCalls,
          llmTimeMs,
          toolCallsRequested,
          toolExecutionTimeMs,
          lastPromptMetrics,
          completionChars: finalResponse.length,
          finishReason: "llm_error_evidence_backstop",
          blocked: false,
          toolIterations: iterationCount,
        });
        logAudit("guardrail_flagged", {
          type: "llm_error_evidence_backstop",
          error: String(err).slice(0, 300),
          evidenceLength: recoveryEvidence.evidence.length,
          evidenceItems: recoveryEvidence.itemCount,
        }, { sessionId: session.id, channel: session.channel, severity: "warn" });
        logAudit("turn_performance", { ...performance, usage: totalUsage }, {
          sessionId: session.id,
          channel: session.channel,
          severity: "info",
        });
        logAudit("message_sent", { length: finalResponse.length, toolCalls: iterationCount, usage: totalUsage, performance }, {
          sessionId: session.id,
          channel: session.channel,
          severity: "info",
        });
        logAudit("turn_scorecard", {
          delegationCount: _turnDelegationCount,
          shareFindingCount: _turnShareFindingCount,
          forcedSynthesisFired: _forcedSynthesisFired,
          wardenFailureCount: _consecutiveDelegationFailures,
          finalAnswerLength: finalResponse.length,
          toolIterations: iterationCount,
          finishReason: "llm_error_evidence_backstop",
        }, { sessionId: session.id, channel: session.channel, severity: "info" });
        return {
          response: finalResponse,
          toolCallsExecuted: iterationCount,
          guardrailEvents,
          usage: totalUsage,
          blocked: false,
          swarmState: getTurnSwarmState(),
          performance,
        };
      }
      return blocked(
        `LLM error: ${String(err)}`,
        getTurnSwarmState(),
        buildTurnPerformanceMetrics({
          turnStartedAt,
          firstModelResponseMs,
          llmCalls,
          llmTimeMs,
          toolCallsRequested,
          toolExecutionTimeMs,
          lastPromptMetrics,
          completionChars: 0,
          finishReason: "llm_error",
          blocked: true,
          toolIterations: iterationCount,
        }),
      );
    }

    totalUsage.promptTokens += llmResponse.usage.promptTokens;
    totalUsage.completionTokens += llmResponse.usage.completionTokens;
    totalUsage.totalTokens += llmResponse.usage.totalTokens;

    for (const tc of llmResponse.tool_calls) normalizeToolCall(tc);
    llmResponse.tool_calls = collapseDuplicateToolCallsInResponse(llmResponse.tool_calls, session.id, guardrailEvents);
    llmResponse.tool_calls = collapseExcessDirectDelegationsInResponse(llmResponse.tool_calls, session.id, guardrailEvents, stashDiscardedBuilderTask);
    llmResponse.tool_calls = collapseMixedOrchestrationLaunchersInResponse(llmResponse.tool_calls, session.id, guardrailEvents);
    llmResponse.tool_calls = collapseMixedDiscoveryAndOrchestrationToolsInResponse(llmResponse.tool_calls, session.id, guardrailEvents);
    // Scope the "evidence already exists" check to THIS turn: the gate means
    // "only rewrite the FIRST delegation, before this turn has gathered any
    // evidence." Reaching across turns let a PRIOR turn's deliverable disable the
    // rewrite, so the orchestrator's assumption-laden elaboration passed straight
    // through instead of being re-anchored on the user's verbatim request (audit
    // c33e65dd: a "Fable 5" question delegated as "Fable, das neue Spiel von
    // Playground Games/Xbox …" — fabricated specifics the user never gave).
    const sourceSensitiveOriginalRequestEnforcementActive = Boolean(
      initialDynamicGuidance?.sourceSensitive
      && !inWorkflowStep
      && (!findRecentDelegateEvidence(session.getHistory(), { scopeToCurrentTurn: true }) || _consecutiveDelegationFailures > 0),
    );
    if (sourceSensitiveOriginalRequestEnforcementActive) {
      for (const tc of llmResponse.tool_calls) {
        enforceSourceSensitiveOriginalRequestOnToolCall(tc, researchSubject, initialDynamicGuidance, session.id, guardrailEvents, stashDiscardedBuilderTask);
      }
    }
    if (requiredResearchFallbackRoute) {
      for (const tc of llmResponse.tool_calls) {
        enforceRequiredResearchFallbackRouteOnToolCall(tc, requiredResearchFallbackRoute, session.id, guardrailEvents);
      }
    }

    if (llmResponse.tool_calls.length > 0 && llmResponse.content?.trim()) {
      logAudit("assistant_text_with_tool_calls_suppressed", {
        contentChars: llmResponse.content.length,
        toolNames: llmResponse.tool_calls.map((toolCall) => toolCall.name),
        finishReason: llmResponse.finishReason,
      }, { sessionId: session.id, severity: "warn" });
      guardrailEvents.push({ type: "assistant_text_suppressed", details: "tool_call_response" });
      // Keep the text in scope for the terminal-exit evidence backstop.
      // Only retain meaningfully-long content (>= 200 chars) — anything
      // shorter is almost certainly narration like "I'll call X next".
      const trimmedContent = llmResponse.content.trim();
      if (trimmedContent.length >= 200) {
        lastSuppressedAssistantText = trimmedContent;
      }
      llmResponse = { ...llmResponse, content: null };
    }

    // ── Pre-emptive synthesis: every requested tool is already at its
    // per-turn cap.  Without this guard the runtime invokes each tool,
    // gets blocked with reason=per_turn_limit, accumulates blocked
    // results, and only forces synthesis after FULLY_BLOCKED_ITERATION_THRESHOLD
    // (= 2) consecutive zero-execution iterations — burning two LLM calls
    // worth of latency and tokens for no gain.  When we can predict
    // every call will be blocked, skip directly to the terminal synthesis
    // path with the same finishReason the post-hoc detector would emit.
    //
    // Exclusion: orchestration launchers (delegate_to_agent and friends)
    // have richer cap-hit handling further down in the per-tool-call loop
    // — buildDelegationLoopResponse emits a "best grounded result collected
    // so far" message with the harvested evidence plus an explicit "raise
    // the limit / stop here" question to the user.  Pre-empting on those
    // would replace that targeted UX with the generic evidence-backstop,
    // which is strictly worse for the operator.
    const ORCHESTRATION_LAUNCHER_PREEMPT_EXCLUSIONS = new Set([
      "delegate_to_agent",
      "parallel_delegate",
      "swarm_delegate",
      "run_task_graph",
      "run_workflow",
    ]);
    if (
      llmResponse.tool_calls.length > 0
      && llmResponse.tool_calls.every((tc) => {
        if (ORCHESTRATION_LAUNCHER_PREEMPT_EXCLUSIONS.has(tc.name)) return false;
        const limit = getPerTurnToolCallLimit(tc.name);
        if (!limit) return false;
        const current = _turnToolCallCounts.get(tc.name) ?? 0;
        return current >= limit;
      })
    ) {
      const blockedNames = [...new Set(llmResponse.tool_calls.map((tc) => tc.name))];
      logAudit("tool_loop_detected", {
        reason: "all_tool_calls_capped_preempt",
        blockedTools: blockedNames,
        iterations: iterationCount,
      }, { sessionId: session.id, severity: "warn" });
      guardrailEvents.push({ type: "synthesis_required", details: "preempt_all_capped" });
      terminalFinishReason = "all_tool_calls_blocked";
      terminalSynthesisInstruction =
        "Every tool the model attempted in this iteration has already hit its per-turn cap. Stop trying tools. Using ONLY the evidence already present in the conversation, write the best possible final answer now. Do NOT invent missing information.";
      _forcedSynthesisFired = true;
      log.warn(
        { iterationCount, blockedTools: blockedNames },
        "Pre-emptive synthesis: all requested tools already at per-turn cap",
      );
      break;
    }

    const workflowCatalogToolRequested = llmResponse.tool_calls.some((toolCall) => isWorkflowCatalogToolName(toolCall.name));
    const runWorkflowRequested = llmResponse.tool_calls.some((toolCall) => toolCall.name === "run_workflow");
    const approvedRunCandidateToolRequested = approvedRunCandidateFollowUp
      ? llmResponse.tool_calls.some((toolCall) => isApprovedRunCandidateToolCall(toolCall, approvedRunCandidateFollowUp))
      : false;
    if (workflowCatalogToolRequested) {
      workflowCatalogAttemptedThisTurn = true;
    }

    const maintenanceDelegationToolRequested = llmResponse.tool_calls.some((toolCall) =>
      toolCall.name === "delegate_to_agent"
      || toolCall.name === "parallel_delegate"
      || toolCall.name === "run_task_graph"
      || toolCall.name === "create_ephemeral_agent"
    );
    if (requiresSwarmMaintenanceDelegation && !maintenanceDelegationToolRequested && llmResponse.tool_calls.length > 0) {
      if (!maintenanceMisrouteRetryUsed) {
        maintenanceMisrouteRetryUsed = true;
        maintenanceDelegationEnforcementPrompt = [
          "COMPLIANCE CORRECTION: This is StarlingAI swarm maintenance or scene/job authoring, not a request to discover or execute reusable workflows.",
          "Do NOT call search_workflows, run_workflow, search_agents, list_agents, or unavailable file-listing pseudo-tools for this request.",
          "You MUST call delegate_to_agent now with agentName='swarm_maintainer' and pass the full user request as the task.",
          "A workflow-search-only response is invalid for this turn.",
        ].join(" ");
        guardrailEvents.push({ type: "delegation_required", details: "maintenance_misroute_rejected" });
        logAudit("guardrail_flagged", {
          type: "maintenance_misroute_rejected",
          toolNames: llmResponse.tool_calls.map((toolCall) => toolCall.name),
          swarmMaintenanceSensitive: initialDynamicGuidance?.swarmMaintenanceSensitive ?? false,
        }, { sessionId: session.id, severity: "warn" });
        opts.onStatus?.({ phase: "guardrail", message: "This is a StarlingAI maintenance request, so I am routing it to the swarm maintainer instead of workflow discovery.", iteration: iterationCount });
        continue;
      }

      guardrailEvents.push({ type: "delegation_required", details: "maintenance_misroute_released" });
      logAudit("guardrail_flagged", {
        type: "maintenance_misroute_released",
        toolNames: llmResponse.tool_calls.map((toolCall) => toolCall.name),
      }, { sessionId: session.id, severity: "info" });
    }

    if (approvedRunCandidateFollowUp && !workflowRunCompletedThisTurn && !approvedRunCandidateToolRequested) {
      if (!approvedRunCandidateRetryUsed) {
        approvedRunCandidateRetryUsed = true;
        approvedRunCandidateEnforcementPrompt = [
          "COMPLIANCE CORRECTION: the user just approved a recent n8n RUN_CANDIDATE follow-up.",
          `You MUST call run_workflow now with name \"${approvedRunCandidateFollowUp.workflowName}\", workflowType \"${approvedRunCandidateFollowUp.workflowType}\", and params.workflowName \"${approvedRunCandidateFollowUp.candidateName}\".`,
          "Do NOT call search_agents, search_workflows, delegate_to_agent, parallel_delegate, run_task_graph, or give a tool-free answer first.",
          "Any response that skips this exact run_workflow call is invalid for this turn.",
        ].join(" ");
        guardrailEvents.push({ type: "workflow_required", details: "approved_run_candidate_follow_up_rejected" });
        logAudit("guardrail_flagged", {
          type: "approved_run_candidate_follow_up_rejected",
          candidateName: approvedRunCandidateFollowUp.candidateName,
          toolNames: llmResponse.tool_calls.map((toolCall) => toolCall.name),
        }, { sessionId: session.id, severity: "warn" });
        continue;
      }

      return blocked(
        "This turn required running the approved n8n workflow candidate, but the model still skipped the required run_workflow call.",
        getTurnSwarmState(),
        buildTurnPerformanceMetrics({
          turnStartedAt,
          firstModelResponseMs,
          llmCalls,
          llmTimeMs,
          toolCallsRequested,
          toolExecutionTimeMs,
          lastPromptMetrics,
          completionChars: 0,
          finishReason: "missing_approved_run_candidate_execution",
          blocked: true,
          toolIterations: iterationCount,
        }),
      );
    }

    // Set when the deterministic workflow-run force (below) rewrites this iteration's
    // tool calls into a single run_workflow. That forced call must be exempt from the
    // synthesis-required / user-response-required terminal guards further down — running
    // the curated workflow IS the deliverable path, not a re-research loop (audit
    // b8e3b68f: the force fired but was rejected by the synthesis-required guard).
    let forcedWorkflowRunThisIteration = false;

    // WRONG-WORKFLOW REDIRECT: the model can run a DIFFERENT workflow than the one the
    // user's request high-precision-matches. detectWorkflowCatalogSignal.strongestMatch
    // is derived from the USER MESSAGE via author-declared catalogTriggers (action-verb
    // gated) — the authoritative "this request IS this workflow" signal — whereas the
    // model often biases its OWN search_workflows query and then runs the top-ranked
    // result (audit e0cf4ca8: a reveal.js-presentation request with verified images and
    // sources biased the query to "deep research paper" and ran deep_research_packet,
    // which builds a paper-only dossier with NO deck/slides/notes). When the model runs a
    // run_workflow whose name differs from the strong catalog match, rewrite it to the
    // catalog match (once; the existing force-release path covers a later failure).
    const catalogPinnedMatch = workflowCatalogSignal.reason === "catalog_match"
      ? workflowCatalogSignal.strongestMatch
      : undefined;
    if (catalogPinnedMatch && !workflowRedirectUsed && !workflowRunCompletedThisTurn) {
      const runWorkflowCall = llmResponse.tool_calls.find((toolCall) => toolCall.name === "run_workflow");
      const chosenWorkflowName = runWorkflowCall
        ? String((runWorkflowCall.arguments as Record<string, unknown>)?.["name"] ?? "").trim()
        : "";
      if (runWorkflowCall && chosenWorkflowName && chosenWorkflowName !== catalogPinnedMatch.name) {
        workflowRedirectUsed = true;
        forcedWorkflowRunThisIteration = true;
        const redirectArgs = runWorkflowCall.arguments as Record<string, unknown>;
        redirectArgs["name"] = catalogPinnedMatch.name;
        redirectArgs["workflowType"] = catalogPinnedMatch.workflowType;
        if (!redirectArgs["context"]) redirectArgs["context"] = userMessage;
        // The dropped params targeted the other workflow; the catalog-matched job derives
        // its topic from the user request carried in `context` (same as the force path).
        delete redirectArgs["params"];
        guardrailEvents.push({ type: "workflow_required", details: "workflow_redirected_to_catalog_match" });
        logAudit("tool_call_recovered", {
          originalTool: "run_workflow",
          rewrittenTo: "run_workflow",
          reason: "workflow_redirected_to_catalog_match",
          from: chosenWorkflowName,
          workflowName: catalogPinnedMatch.name,
          workflowType: catalogPinnedMatch.workflowType,
        }, { sessionId: session.id, severity: "warn" });
      }
    }

    const nonWorkflowOrchestrationRequested = llmResponse.tool_calls.some((toolCall) =>
      // Use the broader swarm-state set, not just ORCHESTRATION_LAUNCHER_TOOL_NAMES, so
      // swarm_delegate counts too: otherwise the model bypasses the workflow-run force by
      // delegating research directly (audit b8e3b68f: 2x swarm_delegate ran the source
      // research first, forcing synthesis BEFORE the late run_workflow force could fire,
      // so the sourced_presentation scene never ran and the deck shipped guessed images).
      PERSISTED_SWARM_STATE_TOOL_NAMES.has(toolCall.name) && toolCall.name !== "run_workflow"
    );
    const nonWorkflowDiscoveryRequested = llmResponse.tool_calls.some((toolCall) =>
      AGENT_DISCOVERY_TOOL_NAMES.has(toolCall.name) && toolCall.name !== "search_workflows"
    );
    const repeatedWorkflowSearchRequested = llmResponse.tool_calls.some((toolCall) => toolCall.name === "search_workflows");
    if (
      !workflowCatalogSuppressedForMaintenance
      &&
      shouldRequireWorkflowExecutionAfterSearch(workflowSearchMatches)
      && !workflowRunCompletedThisTurn
      && !runWorkflowRequested
      && (nonWorkflowOrchestrationRequested || nonWorkflowDiscoveryRequested || repeatedWorkflowSearchRequested)
    ) {
      if (!workflowExecutionRetryUsed) {
        workflowExecutionRetryUsed = true;
        workflowExecutionEnforcementPrompt = formatWorkflowExecutionPromptFromSearch(workflowSearchMatches);
        guardrailEvents.push({ type: "workflow_required", details: "workflow_run_required_after_search" });
        logAudit("guardrail_flagged", {
          type: "workflow_run_required_after_search",
          toolNames: llmResponse.tool_calls.map((toolCall) => toolCall.name),
          workflowMatches: workflowSearchMatches.slice(0, 3),
        }, { sessionId: session.id, severity: "warn" });
        continue;
      }

      // Nudged once but the model STILL chose a non-workflow path (e.g. direct
      // delegation) despite a strong reusable match. The slow local model often
      // won't comply with a prompt nudge, and the source-sensitive auto-research
      // /auto-build path it falls into here ships a worse result than the curated
      // workflow — e.g. the `sourced_presentation` scene verifies image URLs via
      // fetch_image instead of letting an auto-build embed guessed hotlinks. So on
      // the SECOND miss, deterministically rewrite the orchestration call to the
      // strong match's run_workflow, mirroring the source-sensitive original-request
      // rewrite (which also can't rely on the model's compliance). The original user
      // request rides along as `context` so the scene's agents see the real topic
      // even though the scene template only carries default param placeholders.
      // Prefer the high-precision catalog-trigger match (from the user message) over the
      // model's own search ranking, which it can bias with a slanted query.
      const forcedWorkflowMatch = catalogPinnedMatch ?? workflowSearchMatches[0];
      if (!workflowExecutionForceUsed && forcedWorkflowMatch) {
        workflowExecutionForceUsed = true;
        forcedWorkflowRunThisIteration = true;
        workflowExecutionEnforcementPrompt = "";
        const forcedToolCallId = llmResponse.tool_calls[0]?.id ?? `forced_run_workflow_${iterationCount}`;
        llmResponse.tool_calls = [{
          id: forcedToolCallId,
          name: "run_workflow",
          arguments: {
            name: forcedWorkflowMatch.name,
            workflowType: forcedWorkflowMatch.workflowType,
            context: userMessage,
          },
        }];
        guardrailEvents.push({ type: "workflow_required", details: "workflow_run_forced_after_search" });
        logAudit("tool_call_recovered", {
          originalTool: "non_workflow_orchestration",
          rewrittenTo: "run_workflow",
          reason: "workflow_run_forced_after_search",
          workflowName: forcedWorkflowMatch.name,
          workflowType: forcedWorkflowMatch.workflowType,
          score: forcedWorkflowMatch.score,
        }, { sessionId: session.id, severity: "warn" });
        // Fall through (no `continue`): the rewritten run_workflow call executes
        // in this iteration via the tool-dispatch loop below. On success this sets
        // workflowRunCompletedThisTurn so this block never re-fires; on a concrete
        // failure the model pivots and the `else` arm below releases.
      } else {
        // Already forced once and we're back here — the forced workflow run did
        // not resolve the turn (it failed for a concrete reason and the model
        // pivoted to ad-hoc delegation). Trust that choice rather than dead-ending.
        workflowExecutionEnforcementPrompt = "";
        guardrailEvents.push({ type: "workflow_required", details: "workflow_run_released_after_search" });
        logAudit("guardrail_flagged", {
          type: "workflow_run_released_after_search",
          toolNames: llmResponse.tool_calls.map((toolCall) => toolCall.name),
          workflowMatches: workflowSearchMatches.slice(0, 3),
        }, { sessionId: session.id, severity: "info" });
      }
    }

    if (workflowCatalogRequired && !workflowCatalogAttemptedThisTurn && llmResponse.tool_calls.length > 0) {
      if (!workflowCatalogRetryUsed) {
        workflowCatalogRetryUsed = true;
        workflowCatalogEnforcementPrompt = [
          "COMPLIANCE CORRECTION: This request is workflow-shaped and reusable workflow tools are available.",
          "Do NOT jump straight to delegate_to_agent or a direct natural-language answer.",
          "You MUST inspect the workflow catalog first.",
          ...(workflowCatalogSignal.strongestMatch
            ? [`Strong reusable match: ${workflowCatalogSignal.strongestMatch.name} [${workflowCatalogSignal.strongestMatch.workflowType}].`]
            : []),
          "If the exact reusable scene, job, or workflow is already known, call run_workflow now.",
          "Otherwise call search_workflows now, then either run_workflow or explain the catalog matches honestly.",
          "A catalog-free response is invalid for this turn.",
        ].join(" ");
        guardrailEvents.push({ type: "workflow_required", details: "workflow_catalog_check_rejected" });
        logAudit("guardrail_flagged", {
          type: "workflow_catalog_check_rejected",
          toolNames: llmResponse.tool_calls.map((toolCall) => toolCall.name),
          strongestMatch: workflowCatalogSignal.strongestMatch,
          reason: workflowCatalogSignal.reason,
        }, { sessionId: session.id, severity: "warn" });
        continue;
      }

      // Already nudged once this turn. The workflow-catalog check is a soft
      // routing heuristic, not a hard gate — trust the model's tool calls
      // instead of dead-ending into an empty answer. Let the requested tools
      // (e.g. delegate_to_agent, rag_ingest/rag_search) execute.
      workflowCatalogEnforcementPrompt = "";
      guardrailEvents.push({ type: "workflow_required", details: "workflow_catalog_check_released" });
      logAudit("guardrail_flagged", {
        type: "workflow_catalog_check_released",
        toolNames: llmResponse.tool_calls.map((toolCall) => toolCall.name),
        reason: workflowCatalogSignal.reason,
      }, { sessionId: session.id, severity: "info" });
    }

    const synthesisRequiredInHistory = collapsedHistory.some((message) => isForcedSynthesisSystemMessage(message));
    const userResponseRequiredInHistory = collapsedHistory.some((message) =>
      message.role === "system"
      && typeof message.content === "string"
      && message.content.startsWith("[USER RESPONSE REQUIRED]"),
    );

    if (synthesisRequiredInHistory && llmResponse.tool_calls.length > 0 && !forcedWorkflowRunThisIteration) {
      // Fix 3: If the prior delegation was a partial/timeout whose surfaced
      // substance is below the usability floor (e.g. 900-char truncation
      // stub), the model's recovery delegation is the correct response —
      // there is no real evidence to synthesize from. Allow ONE retry per
      // turn so the swarm can recover the lost work instead of being locked
      // into "answer from a stub" mode. Subsequent tool calls in the same
      // turn still fall through to the original block-and-synthesize path.
      const junkPriorDelegation = synthesisRequiredRecoveryRetryUsed
        ? null
        : findRecentJunkDelegationResult(collapsedHistory);
      // Builder-build exception (audit a438ef4a): right after research, the model itself
      // delegated the BUILD step (content_writer with its own spec) — exactly what the
      // user asked for — and this gate rejected it, only for the corrective-build net to
      // re-do the same build minutes later. When the turn wants an artifact and none has
      // been produced yet, the model's OWN builder delegation is the plan working, not a
      // tool-call loop: let it through once per turn.
      const builderRoleRe = /^(?:content_writer|web_coder|backend_coder)$/i;
      const isBuilderDelegationCall = (toolCall: typeof llmResponse.tool_calls[number]): boolean => {
        if (builderRoleRe.test(toolCall.name)) return true; // agent-name-as-tool shape, rewritten downstream
        if (/^(?:delegate_to_agent|swarm_delegate)$/.test(toolCall.name)) {
          const agentName = typeof toolCall.arguments?.["agentName"] === "string" ? String(toolCall.arguments["agentName"]) : "";
          return builderRoleRe.test(agentName);
        }
        return false;
      };
      const builderBuildCall = !synthesisRequiredBuilderBuildUsed
        && (deliverableIntent.isAppBuild || deliverableIntent.wantsArtifact)
        && collectTurnArtifactAttachments(session).length === 0
        ? llmResponse.tool_calls.find(isBuilderDelegationCall)
        : undefined;
      if (junkPriorDelegation) {
        synthesisRequiredRecoveryRetryUsed = true;
        logAudit("guardrail_flagged", {
          type: "synthesis_required_recovery_allowed",
          priorAgent: junkPriorDelegation.agentName,
          priorSubstanceChars: junkPriorDelegation.substanceChars,
          priorTerminalState: junkPriorDelegation.terminalState,
          retryToolNames: llmResponse.tool_calls.map((toolCall) => toolCall.name),
        }, { sessionId: session.id, severity: "info" });
        guardrailEvents.push({ type: "synthesis_required", details: "recovery_retry_allowed" });
        log.info(
          {
            sessionId: session.id,
            priorAgent: junkPriorDelegation.agentName,
            priorSubstanceChars: junkPriorDelegation.substanceChars,
            priorTerminalState: junkPriorDelegation.terminalState,
          },
          "Synthesis-required guardrail granted one recovery retry — prior delegation produced sub-floor evidence",
        );
        // Fall through to normal tool-call processing this iteration.
      } else if (builderBuildCall) {
        synthesisRequiredBuilderBuildUsed = true;
        logAudit("guardrail_flagged", {
          type: "synthesis_required_builder_build_allowed",
          toolName: builderBuildCall.name,
          agentName: typeof builderBuildCall.arguments?.["agentName"] === "string" ? builderBuildCall.arguments["agentName"] : builderBuildCall.name,
        }, { sessionId: session.id, severity: "info" });
        guardrailEvents.push({ type: "synthesis_required", details: "builder_build_allowed" });
        log.info(
          { sessionId: session.id, toolName: builderBuildCall.name },
          "Synthesis-required guardrail allowed the model's own builder delegation — artifact wanted and none built yet",
        );
        // Fall through to normal tool-call processing this iteration.
      } else {
        logAudit("guardrail_flagged", {
          type: "tool_calls_after_synthesis_required",
          toolNames: llmResponse.tool_calls.map((toolCall) => toolCall.name),
          recoveryRetryUsed: synthesisRequiredRecoveryRetryUsed,
        }, { sessionId: session.id, severity: "warn" });
        guardrailEvents.push({ type: "synthesis_required", details: "post_orchestration_tool_call_rejected" });
        _forcedSynthesisFired = true;
        terminalFinishReason = "synthesis_required_tool_call_rejected";
        // When the orchestration ALREADY produced attached artifacts, the work is
        // DONE — telling the model "research incomplete, write a partial answer"
        // made it relay the deliverable's truncated head as the final message
        // (audit 2445da2e: a completed 4/4-step workflow ended as 1600 chars of
        // the paper's TOC ending in "…"). Pivot to a completion summary.
        const rejectedTurnArtifacts = collectTurnArtifactAttachments(session);
        terminalSynthesisInstruction = rejectedTurnArtifacts.length > 0
          ? "THE WORK IS COMPLETE — WRITE THE FINAL SUMMARY NOW. The deliverables were already built and are ATTACHED to this message as files. Do NOT call any more tools and do NOT paste the documents' contents into the chat. Write a SHORT final answer in the user's language that: (1) states what was completed, (2) lists every attached artifact path with a one-line description ("
            + rejectedTurnArtifacts.map((artifact) => String(artifact["relativePath"] ?? artifact["filename"] ?? "artifact")).slice(0, 12).join(", ")
            + "), and (3) notes anything the evidence explicitly marks as incomplete. Nothing more."
          : "RESEARCH INCOMPLETE — WRITE A PARTIAL ANSWER NOW. The delegated research ran out of time before covering all topics. Do NOT call any more tools. Do NOT write raw search snippets or tool-trace text. Instead write a proper user-facing answer in the user's language that: (1) clearly states the research was incomplete and which topics still need verification, (2) presents every concrete verified fact that IS in the tool results and shared findings above as a structured answer (component names, specs, prices, sources — whatever was found), (3) explicitly marks sections as [unverifiziert — Recherche unvollständig] when no evidence was found for them, and (4) asks the user whether to retry the missing sections. Never dump raw 'Web Search Results for:' blocks. Convert all search snippet evidence into readable prose or a structured list.";
        opts.onStatus?.({ phase: "synthesizing", message: "Stopping repeated tool calls and writing the answer from gathered evidence.", iteration: iterationCount });
        log.warn({ sessionId: session.id, toolCalls: llmResponse.tool_calls.map((toolCall) => toolCall.name) }, "Model attempted more tool calls after synthesis was required — forcing synthesis");
        break;
      }
    }

    if (userResponseRequiredInHistory && llmResponse.tool_calls.length > 0 && !forcedWorkflowRunThisIteration) {
      logAudit("guardrail_flagged", {
        type: "tool_calls_after_user_response_required",
        toolNames: llmResponse.tool_calls.map((toolCall) => toolCall.name),
      }, { sessionId: session.id, severity: "warn" });
      guardrailEvents.push({ type: "synthesis_required", details: "post_orchestration_tool_call_rejected" });
      _forcedSynthesisFired = true;
      terminalFinishReason = "user_response_required_tool_call_rejected";
      terminalSynthesisInstruction =
        "A previous delegated result requires a user response, clarification, authorization, or approval, but the model attempted another tool call. Reject that tool call. Ask the user the required question in one concise message using only the evidence already present above. Do NOT call tools, delegate, search, browse, or promise automatic continuation.";
      opts.onStatus?.({ phase: "synthesizing", message: "Stopping extra tool calls and preparing the required user-facing question.", iteration: iterationCount });
      log.warn({ sessionId: session.id, toolCalls: llmResponse.tool_calls.map((toolCall) => toolCall.name) }, "Model attempted more tool calls after delegated results required a user response — forcing synthesis");
      break;
    }

    // ── No tool calls — final response ────────────────────────────────────
    // NOTE: do NOT short-circuit on finishReason === "stop" here — many quantized
    // models (LM Studio, Ollama) return finish_reason:"stop" even when they include
    // tool_calls in the same response.  Only treat the turn as complete when there
    // are literally zero tool calls to process.
    if (llmResponse.tool_calls.length === 0) {
      let rawResponse = llmResponse.content ?? "";
      // Trust-the-LLM never-empty guarantee. The routing guardrails below each
      // nudge the model ONCE to use an orchestration/workflow tool. If it still
      // answers tool-free after that nudge, we no longer dead-end the turn into
      // an empty `blocked()` response — we release its draft answer through the
      // normal finalization path (which still runs the security output scan +
      // redactor). Once a terminal decides to release, this flag short-circuits
      // the remaining routing terminals so the draft falls straight through.
      let releasedAfterRoutingNudge = false;
      // Set when a source-sensitive answer is released after the research nudge
      // without any research evidence having been gathered this turn — the
      // answer then gets an explicit unverified caveat (anti-hallucination).
      let releasedWithoutResearchEvidence = false;
      const releaseAfterRoutingNudge = (original: string): void => {
        releasedAfterRoutingNudge = true;
        guardrailEvents.push({ type: "routing_nudge_released", details: original });
        logAudit("guardrail_flagged", {
          type: "routing_nudge_released",
          original,
          reason: "model answered directly after one delegation nudge; releasing draft instead of blocking",
        }, { sessionId: session.id, severity: "info" });
      };
      const unresolvedDelegatedActionInHistory = hasRecentUnresolvedDelegatedAction(session.getHistory());
      const promisedContinuationWithoutTools = looksLikeContinuationPromise(rawResponse);
      const promisedMaintenanceExecutionWithoutTools = requiresMaintenanceDelegation
        && looksLikeMaintenanceExecutionPromise(rawResponse);

      if (!releasedAfterRoutingNudge && promisedMaintenanceExecutionWithoutTools) {
        if (!maintenanceDelegationRetryUsed) {
          maintenanceDelegationRetryUsed = true;
          maintenanceDelegationEnforcementPrompt = [
            "COMPLIANCE CORRECTION: This is follow-up information for an ongoing workflow-authoring maintenance request.",
            "Do NOT claim that you are creating, generating, or delegating the workflow unless this response actually includes the orchestration tool call.",
            "You MUST call an orchestration tool now.",
            "Prefer delegate_to_agent with swarm_maintainer when available.",
            "A tool-free promise to create the workflow is invalid for this turn.",
          ].join(" ");
          guardrailEvents.push({ type: "delegation_required", details: "tool_free_maintenance_answer_rejected" });
          logAudit("guardrail_flagged", {
            type: "tool_free_maintenance_answer_rejected",
            recentWorkflowAuthoringMaintenanceContext,
          }, { sessionId: session.id, severity: "warn" });
          continue;
        }

        releaseAfterRoutingNudge("tool_free_maintenance_answer_rejected");
      }

      if (!releasedAfterRoutingNudge && workflowCatalogRequired && !workflowCatalogAttemptedThisTurn) {
        if (!workflowCatalogRetryUsed) {
          workflowCatalogRetryUsed = true;
          workflowCatalogEnforcementPrompt = [
            "COMPLIANCE CORRECTION: This request is workflow-shaped and reusable workflow tools are available.",
            "Do NOT answer from memory or promise delegation before checking the workflow catalog.",
            ...(workflowCatalogSignal.strongestMatch
              ? [`Strong reusable match: ${workflowCatalogSignal.strongestMatch.name} [${workflowCatalogSignal.strongestMatch.workflowType}].`]
              : []),
            "You MUST call search_workflows or run_workflow now.",
            "If no reusable workflow matches, explain that only after the catalog check completes.",
            "A tool-free answer is invalid for this turn.",
          ].join(" ");
          guardrailEvents.push({ type: "workflow_required", details: "tool_free_workflow_answer_rejected" });
          logAudit("guardrail_flagged", {
            type: "tool_free_workflow_answer_rejected",
            strongestMatch: workflowCatalogSignal.strongestMatch,
            reason: workflowCatalogSignal.reason,
          }, { sessionId: session.id, severity: "warn" });
          continue;
        }

        releaseAfterRoutingNudge("tool_free_workflow_answer_rejected");
      }

      if (
        !releasedAfterRoutingNudge
        && !workflowCatalogSuppressedForMaintenance
        &&
        shouldRequireWorkflowExecutionAfterSearch(workflowSearchMatches)
        && !workflowRunCompletedThisTurn
      ) {
        if (!workflowExecutionRetryUsed) {
          workflowExecutionRetryUsed = true;
          workflowExecutionEnforcementPrompt = formatWorkflowExecutionPromptFromSearch(workflowSearchMatches);
          guardrailEvents.push({ type: "workflow_required", details: "tool_free_workflow_run_rejected" });
          logAudit("guardrail_flagged", {
            type: "tool_free_workflow_run_rejected",
            workflowMatches: workflowSearchMatches.slice(0, 3),
          }, { sessionId: session.id, severity: "warn" });
          continue;
        }

        releaseAfterRoutingNudge("tool_free_workflow_run_rejected");
      }

      if (promisedContinuationWithoutTools && unresolvedDelegatedActionInHistory && !unresolvedDelegationContinuationRetryUsed) {
        unresolvedDelegationContinuationRetryUsed = true;
        unresolvedDelegationEnforcementPrompt = [
          "COMPLIANCE CORRECTION: The session already contains an unfinished delegated action from a previous turn.",
          "The user's latest message is follow-up guidance for that unfinished work.",
          "Do NOT write that you will now do something unless this response actually includes the tool call.",
          "You MUST either call the required tool or orchestration tool now, or explicitly state that no action is being executed in this turn.",
          "For server administration follow-ups, prefer delegate_to_agent(agentName: \"shell_agent\", task: \"...\") or ops_triage when diagnosis is needed.",
          "A tool-free continuation promise is invalid for this turn.",
        ].join(" ");
        guardrailEvents.push({ type: "delegation_required", details: "tool_free_continuation_promise_rejected" });
        logAudit("guardrail_flagged", {
          type: "tool_free_continuation_promise_rejected",
          serverAccessSensitive: initialDynamicGuidance?.serverAccessSensitive ?? false,
          computerAccessSensitive: initialDynamicGuidance?.computerAccessSensitive ?? false,
        }, { sessionId: session.id, severity: "warn" });
        continue;
      }

      // A run_workflow that returned workflowNotFound is a NO-OP routing miss, not executed
      // orchestration — but _turnToolCallCounts is bumped for every call regardless of success,
      // so counting the raw run_workflow call here made a failed workflow masquerade as real
      // orchestration. That poisoned boolean disabled the entire honesty chain (research
      // enforcement, the unverified caveat, the source-sensitive backstop) for a sourceSensitive
      // turn — letting an answer with fabricated 404 citations + a false "verified against N
      // sources" claim ship with ZERO web/research execution (audit 1303e254). Use only the
      // honest "real execution" signals: a real delegation, or a run_workflow that actually
      // SUCCEEDED (workflowRunCompletedThisTurn, set on result.success).
      const currentTurnHasExecutableOrchestration = _turnDelegationCount > 0
        || workflowRunCompletedThisTurn;

      if (!releasedAfterRoutingNudge && requiresArtifactDelegation && !currentTurnHasExecutableOrchestration) {
        if (!delegatedResearchRetryUsed) {
          delegatedResearchRetryUsed = true;
          delegatedResearchEnforcementPrompt = [
            "COMPLIANCE CORRECTION: This request asks for a durable downloadable or viewable artifact.",
            "Do NOT paste the full artifact source into chat.",
            "You MUST call an orchestration tool now so a specialist can write/export the artifact file.",
            "For HTML pages, how-to blogs, documentation pages, or static websites, prefer delegate_to_agent with agentName='content_writer'.",
            "Ask the specialist to save the file as an artifact and publish the artifact path/download details. The final chat answer should be only a concise summary and artifact reference.",
            "A tool-free artifact dump is invalid for this turn.",
          ].join(" ");
          guardrailEvents.push({ type: "delegation_required", details: "tool_free_artifact_answer_rejected" });
          logAudit("guardrail_flagged", {
            type: "tool_free_artifact_answer_rejected",
            artifactSensitive: initialDynamicGuidance?.artifactSensitive ?? false,
          }, { sessionId: session.id, severity: "warn" });
          opts.onStatus?.({ phase: "guardrail", message: "The draft skipped artifact creation, so I am retrying with the required specialist workflow.", iteration: iterationCount });
          continue;
        }

        releaseAfterRoutingNudge("tool_free_artifact_answer_rejected");
      }

      let autoResearchAnswer: string | null = null;
      // General force-real-research (orchestration.ungroundedFactualAnswerGuard, default off): the
      // no-URL sibling of requiresUrlFetch. The de-lex hardwired sourceSensitive/freshnessSensitive
      // off, so requiresDelegatedResearch is always false — a factual/current-events question can be
      // answered tool-free from training memory and shipped as fact (audit fe496ec5: a fabricated
      // "news von heute" bulletin, zero delegations). Re-arm from a STRUCTURAL draft signal: a
      // substantial, specifics-dense tool-free draft (looksLikeUnsourcedSpecificClaims — a count of
      // number+unit / currency / percent / year / date / code tokens, no topic/language keyword
      // table). Reuses the same reject → autoResearchOnRefusal → grounded-synthesis path below, so it
      // never dead-ends and a released draft still gets the unverified caveat.
      // EXCLUDE answers grounded in the user's OWN retrieved data — an attached CV/profile injected as
      // [DOCUMENT CONTEXT] (documentRagFoundDocs) or shared findings this turn. Such a specifics-dense
      // answer is legitimately grounded, not memory-recited; forcing web research on it would find
      // nothing (private CV is not on the web) and REPLACE a correct grounded answer with a worse one —
      // the exact turn the userOwnFacts prompt guidance tells the model to answer from the retrieved CV.
      // ALSO exclude when the model itself RETRIEVED grounding content this turn via a document/profile
      // tool: search_documents (attached-file RAG) or recall_context (memory/profile facts). Those are
      // CONTENT-retrieval calls, so the specifics are sourced, not fabricated — the over-fire the run
      // repro'd (session d9ed5ea2 t4: a correct search_documents-grounded CV answer force-delegated to a
      // 0-iteration researcher). list_documents is deliberately NOT excluded — listing filenames is not
      // content grounding, so a bare list must not license unsourced specifics. Purely structural
      // (per-turn tool-call counts already tracked in _turnToolCallCounts); this can only make the guard
      // fire LESS, never more.
      const requiresUngroundedFactualResearch = getConfig().orchestration?.ungroundedFactualAnswerGuard === true
        && activeMainAssistantToolMode === "orchestration_only"
        && !documentRagFoundDocs
        && (_turnToolCallCounts.get("search_documents") ?? 0) === 0
        && (_turnToolCallCounts.get("recall_context") ?? 0) === 0
        && _turnShareFindingCount === 0
        && looksLikeUnsourcedSpecificClaims(rawResponse);
      if (!releasedAfterRoutingNudge && (requiresDelegatedResearch || requiresUrlFetch || requiresUngroundedFactualResearch) && !currentTurnHasExecutableOrchestration) {
        if (!delegatedResearchRetryUsed) {
          delegatedResearchRetryUsed = true;
          const route: RequiredResearchFallbackRoute | null = requiredResearchFallbackRoute ?? buildRequiredResearchFallbackRoute(researchSubject, initialDynamicGuidance, allowedToolNameSet, opts.allowedAgents);
          if (route) {
            requiredResearchFallbackRoute = route;
            searchAgentsNoMatchFallbackPrompt ||= buildSearchAgentsNoMatchFallbackPrompt(route);
          }
          // URL-fetch path (structural URL trigger, no source-sensitive research classification):
          // a GENERAL nudge that forces the page to be READ before answering — never overfit to a
          // topic/host (any http(s) URL). The research path keeps its own nudge below.
          delegatedResearchEnforcementPrompt = (requiresUrlFetch && !requiresDelegatedResearch)
            ? [
                "COMPLIANCE CORRECTION: The user's message references a web page by URL.",
                "You have NOT fetched it this turn. Do NOT describe, summarize, quote, or evaluate the page's contents from memory — that is fabrication.",
                "Delegate now (e.g. delegate_to_agent with researcher) to fetch and read the URL, THEN answer strictly from what it actually returns.",
                "If you genuinely cannot fetch it, say so plainly instead of inventing its contents.",
                "A tool-free answer that speaks to the URL's content is invalid for this turn.",
              ].join(" ")
            : route
            ? buildSearchAgentsNoMatchFallbackPrompt(route)
            : [
                "COMPLIANCE CORRECTION: This request requires specialist-agent orchestration.",
                "Do NOT answer directly from memory.",
                "You MUST call an orchestration tool now instead of writing a natural-language answer.",
                "For a simple web lookup, prefer delegate_to_agent with researcher.",
                "For broader multi-step online research, hardware/product verification, component recommendations, or source-backed reports, prefer delegate_to_agent with mission_coordinator. Use web_task_coordinator only for live single-shot lookups or browser-heavy workflows.",
                "A tool-free answer before delegation is invalid for this turn.",
              ].join(" ");
          guardrailEvents.push({ type: "delegation_required", details: "tool_free_research_answer_rejected" });
          logAudit("guardrail_flagged", {
            type: "tool_free_research_answer_rejected",
            freshnessSensitive: initialDynamicGuidance?.freshnessSensitive ?? false,
            sourceSensitive: initialDynamicGuidance?.sourceSensitive ?? false,
          }, { sessionId: session.id, severity: "warn" });
          opts.onStatus?.({ phase: "guardrail", message: "The draft skipped required research orchestration, so I am retrying with a specialist agent.", iteration: iterationCount });
          continue;
        }

        // Source-sensitive turn, model refused to delegate even after the nudge.
        // Operator policy (orchestration.autoResearchOnRefusal): do NOT ship a
        // training-data answer — auto-run ONE research delegation and synthesize from
        // the gathered findings; fall back to the caveated draft only if that yields
        // nothing. Enforces the source-sensitive correctness invariant without
        // dead-ending (audit bdbace34: a hardware build shipped fabricated mic specs
        // with zero delegations after the single nudge release).
        const autoRoute = (effectiveOrchestration().autoResearchOnRefusal && !signal.aborted)
          ? (requiredResearchFallbackRoute ?? buildRequiredResearchFallbackRoute(researchSubject, initialDynamicGuidance, allowedToolNameSet, opts.allowedAgents))
          : null;
        if (autoRoute) {
          logAudit("guardrail_flagged", {
            type: "source_sensitive_auto_research_delegated",
            tool: autoRoute.toolName,
            agent: autoRoute.label,
          }, { sessionId: session.id, severity: "warn" });
          opts.onStatus?.({ phase: "guardrail", message: "The draft ran no research — fetching sourced evidence via a research specialist now. / Der Entwurf hat keine Recherche ausgeführt — ich hole jetzt belegte Quellen über einen Spezialisten.", iteration: iterationCount });
          try {
            await executeTool(autoRoute.toolName, autoRoute.args, toolContext);
            _turnDelegationCount += 1;
          } catch (err) {
            log.warn({ err, sessionId: session.id }, "Auto-research delegation on refusal failed");
          }
          const autoEvidence = await getSharedFactsEvidenceForFinalSynthesis(session.id);
          const autoDelegateEvidence = findRecentDelegateEvidence(session.getHistory());
          const recovery = chooseBetterRecoveryEvidence(autoDelegateEvidence, autoEvidence, { preferHigherScore: true });
          if (recovery && !looksLikeWeakRecoveryEvidence(recovery.evidence)) {
            const synthesized = await forceSynthesis(
              session,
              provider,
              signal,
              "WEB RESEARCH RESULTS — synthesize the final answer now. A research specialist gathered the findings below for the user's request. "
              + "Write the complete answer in the SAME language as the user's request, grounded ONLY in these findings and this conversation's tool results. "
              + "Do not invent any specifics — names, numbers, dates, sources, or claims — beyond the findings; mark anything the findings do not cover as still to verify.\n"
              + "Findings:\n" + recovery.evidence.slice(0, 6_000),
            );
            const candidate = synthesized ? sanitizeUserFacingAssistantResponse(synthesized, 0) : null;
            autoResearchAnswer = candidate && candidate.trim().length >= 200
              ? candidate
              : formatSourceSensitiveEvidenceBackstop(recovery.evidence);
            logAudit("guardrail_flagged", {
              type: "source_sensitive_auto_research_synthesized",
              evidenceItems: recovery.itemCount,
              evidenceLength: recovery.evidence.length,
              synthesized: Boolean(candidate && candidate.trim().length >= 200),
            }, { sessionId: session.id, severity: "warn" });
          }
        }

        if (!autoResearchAnswer) {
          releaseAfterRoutingNudge("tool_free_research_answer_rejected");
          // No delegation/orchestration ran and no findings were shared, yet the
          // turn is source/freshness-sensitive — the released draft is unverified.
          if (!currentTurnHasExecutableOrchestration && _turnShareFindingCount === 0) {
            releasedWithoutResearchEvidence = true;
          }
        }
      }

      // Normal-completion regurgitation guard. The model answered tool-free and
      // the draft is a near-verbatim copy of an EARLIER assistant answer, while
      // NOTHING was delegated/built this turn — shipping it re-prints the prior
      // turn's deliverable as if the user's NEW request had been carried out.
      // The terminal-path guard below only covers blocked/synthesis/max-iteration
      // finishes, so a clean `stop` slipped straight through (audit c97a9907 turn 3:
      // "jetzt erstelle mir die webapp-lernplattform" → 0 tool calls, the entire
      // prior curriculum re-pasted verbatim). High-bar duplicate detector + the
      // "no orchestration this turn" gate keep this off legitimate direct answers.
      if (
        !autoResearchAnswer
        && !currentTurnHasExecutableOrchestration
        && looksLikeRegurgitatedPriorAnswer(rawResponse, session.getHistory())
      ) {
        logAudit("guardrail_flagged", {
          type: "tool_free_regurgitated_prior_answer",
          finishReason: llmResponse.finishReason,
          draftLength: rawResponse.length,
        }, { sessionId: session.id, channel: session.channel, severity: "warn" });
        const honest = await forceSynthesis(
          session, provider, signal,
          "Your draft re-pasted an earlier turn's answer almost verbatim, which falsely implies the user's NEW request in THIS turn was already carried out — but this turn neither produced nor delegated anything. Do NOT ship that stale copy. "
          + "Reply briefly and honestly IN THE USER'S LANGUAGE: state that the requested deliverable was NOT built or changed in this turn, and offer to delegate it now to the right specialist (for an HTML/web learning app, content_writer or web_coder). "
          + "Do NOT re-paste the earlier answer, do NOT invent a file path, and do NOT claim a success you cannot point to in this turn's own results.",
        );
        const honestClean = honest ? sanitizeUserFacingAssistantResponse(honest, iterationCount) : null;
        rawResponse = (honestClean && honestClean.trim().length > 0 && !looksLikeRegurgitatedPriorAnswer(honestClean, session.getHistory()))
          ? honestClean
          : "Ich habe die Lernplattform/das Artefakt in diesem Schritt nicht tatsächlich gebaut und gebe die vorherige Antwort nicht erneut als erledigt aus. Bestätige kurz, dann delegiere ich den Bau an den passenden Spezialisten (content_writer bzw. web_coder).\n\nI did not actually build the platform/artifact this turn and won't re-post the previous answer as if it were done. Confirm and I'll delegate the build to the right specialist (content_writer / web_coder).";
      }

      // Output guardrail scan
      const outputScan = scanOutput(rawResponse);
      const effectiveToolIterations = promisedContinuationWithoutTools && unresolvedDelegatedActionInHistory
        ? Math.max(iterationCount, 1)
        : iterationCount;
      // Terminal response-guard run (unverified caveat → citation-honesty guard → false-completion
      // → general/source-sensitive evidence backstops → risk-gated QA → QA-delivery loop →
      // deliverable-consistency gate → completion QA gate → output redaction → zero-work
      // fabrication guard → last-line honesty banner) — extracted verbatim to
      // agent/turn-finalize-guards.ts (god-file seam). It finalizes rawResponse and produces the
      // user-facing finalResponse; the two QA gates + finalizer + the corrective closures are
      // passed as callbacks (the module never imports runtime.js). guardrailEvents is mutated in
      // place and the shared delegation counter is bumped through incrementDelegationCount, so the
      // rest of the turn reads that state back exactly as the inline original left it.
      const terminalGuardCtx: TerminalGuardContext = {
        signal,
        session,
        provider,
        userMessage,
        toolContext,
        deliverableIntent,
        initialDynamicGuidance,
        rawResponse,
        iterationCount,
        effectiveToolIterations,
        terminalFinishReason,
        toolCallsRequested,
        currentTurnHasExecutableOrchestration,
        forcedSynthesisFired: _forcedSynthesisFired,
        consecutiveDelegationFailures: _consecutiveDelegationFailures,
        turnToolCallCounts: _turnToolCallCounts,
        turnShareFindingCount: _turnShareFindingCount,
        workflowRunCompletedThisTurn,
        releasedWithoutResearchEvidence,
        autoResearchAnswer,
        outputScan,
        getTurnDelegationCount: () => _turnDelegationCount,
        getQaCorrectiveBuildUsed: () => qaCorrectiveBuildUsed,
        incrementDelegationCount: () => { _turnDelegationCount += 1; },
        guardrailEvents,
        finalizeUserFacingAssistantResponse,
        forceSynthesis,
        collectTurnArtifactAttachments,
        runQaDeliveryGate,
        runDeliverableConsistencyGate,
        runCorrectiveBuild,
        runCorrectiveReroute,
        logWarn: (obj, msg) => log.warn(obj, msg),
      };
      const finalResponse = await applyTerminalResponseGuards(terminalGuardCtx);

      // Clean-success terminal tail extracted to turn-success-finalize.ts (god-file
      // seam): persist state, emit turn_performance/message_sent/turn_scorecard, fire
      // the post-turn learning signals, and return the TurnOutput. Behavior-preserving.
      return finalizeSuccessfulTurn({
        session,
        finalResponse,
        persistTurnState: persistAssistantTurnState,
        getTurnSwarmState,
        turnStartedAt,
        firstModelResponseMs,
        llmCalls,
        llmTimeMs,
        toolCallsRequested,
        toolExecutionTimeMs,
        lastPromptMetrics,
        finishReason: llmResponse.finishReason,
        iterationCount,
        totalUsage,
        delegationCount: _turnDelegationCount,
        shareFindingCount: _turnShareFindingCount,
        forcedSynthesisFired: _forcedSynthesisFired,
        consecutiveDelegationFailures: _consecutiveDelegationFailures,
        sharedFindingsThisTurn,
        freshnessSensitive: initialDynamicGuidance?.freshnessSensitive ?? false,
        injectedSkillSlugs,
        heldOutSkillSlugs,
        injectedTrajectoryIdentity,
        userMessage,
        guardrailEvents,
      });
    }

    // ── Assistant text repetition detection ────────────────────────────────
    // If the LLM regenerates nearly identical text across iterations while also
    // requesting tool calls, it is stuck in a regeneration loop.  Break early.
    // Only update _lastAssistantContent when the model actually produced text;
    // tool-only iterations (content=null) should NOT reset the comparison.
    // Whitespace-only content (e.g. "\n\n" left after stripping Qwen3 thinking
    // tags) is not meaningful text — skip the check to avoid false positives.
    if (llmResponse.content && llmResponse.content.trim() && iterationCount >= 2) {
      if (_lastAssistantContent) {
        const curPrefix = llmResponse.content.slice(0, 200);
        const prevPrefix = _lastAssistantContent.slice(0, 200);
        if (curPrefix === prevPrefix) {
          logAudit("tool_loop_detected", {
            reason: "assistant_text_repetition",
            iterations: iterationCount,
            contentPrefix: curPrefix.slice(0, 100),
          }, { sessionId: session.id, severity: "warn" });
          log.warn({ iterationCount }, "Assistant text repeated across iterations — forcing synthesis");
          break; // falls through to forceSynthesis below
        }
      }
      _lastAssistantContent = llmResponse.content;
    }

    // ── Process tool calls ────────────────────────────────────────────────

    session.addMessage({
      role: "assistant",
      content: llmResponse.content,
      tool_calls: llmResponse.tool_calls.map(tc => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    });

    const toolResultMessages: Array<LLMMessage & { metadata?: Record<string, unknown> }> = [];
    let workflowExecutionCorrectionPending = false;
    let workflowExecutionCorrectionExhausted = false;

    for (const tc of llmResponse.tool_calls) {
      if (signal.aborted) break;

      if (requiredResearchFallbackRoute && (tc.name === "search_agents" || tc.name === "list_agents")) {
        const originalTool = tc.name;
        tc.name = requiredResearchFallbackRoute.toolName;
        tc.arguments = { ...requiredResearchFallbackRoute.args };
        logAudit("tool_call_recovered", {
          originalTool,
          rewrittenTo: requiredResearchFallbackRoute.toolName,
          reason: "search_agents_no_match_fallback",
          recoveredAgentName: requiredResearchFallbackRoute.label,
          noMatchCount: searchAgentsNoMatchCount,
        }, { sessionId: session.id, severity: "warn" });
        guardrailEvents.push({ type: "tool_recovered", details: `${originalTool}:search_agents_no_match_fallback` });
      }

      toolCallsRequested += 1;
      // F29: Count delegation and share_finding calls for the turn scorecard
      if (
        tc.name === "delegate_to_agent" ||
        tc.name === "parallel_delegate" ||
        tc.name === "run_task_graph" ||
        tc.name === "swarm_delegate" ||
        tc.name === "create_ephemeral_agent"
      ) {
        _turnDelegationCount += 1;
      } else if (tc.name === "share_finding") {
        _turnShareFindingCount += 1;
        // G33: Collect finding text for trajectory cache
        const findingText = typeof tc.arguments?.["finding"] === "string"
          ? (tc.arguments["finding"] as string).slice(0, 500)
          : typeof tc.arguments?.["content"] === "string"
            ? (tc.arguments["content"] as string).slice(0, 500)
            : "";
        if (findingText) sharedFindingsThisTurn.push(findingText);
      }
      const nextToolCallCount = (_turnToolCallCounts.get(tc.name) ?? 0) + 1;
      _turnToolCallCounts.set(tc.name, nextToolCallCount);
      const perTurnToolLimit = getPerTurnToolCallLimit(tc.name);

      if (perTurnToolLimit && nextToolCallCount > perTurnToolLimit) {
        logAudit("tool_call_blocked", {
          tool: tc.name,
          reason: "per_turn_limit",
          limit: perTurnToolLimit,
          attemptedCallNumber: nextToolCallCount,
        }, {
          sessionId: session.id,
          severity: "warn",
        });
        guardrailEvents.push({ type: "tool_blocked", details: `${tc.name}:per_turn_limit` });

        const limitMessage = `Error: Tool '${tc.name}' call limit (${perTurnToolLimit}) reached for this turn. Stop calling this tool and synthesize your findings or ask the user for the missing information directly.`;
        if (opts.onToolResult) opts.onToolResult(tc.id, tc.name, limitMessage);

        if (tc.name === "delegate_to_agent") {
          const finalResponse = buildDelegationLoopResponse(session, _lastToolResultByName.get(tc.name) ?? "", "limit");
          persistAssistantTurnState(session, finalResponse, getTurnSwarmState());

          const performance = buildTurnPerformanceMetrics({
            turnStartedAt,
            firstModelResponseMs,
            llmCalls,
            llmTimeMs,
            toolCallsRequested,
            toolExecutionTimeMs,
            lastPromptMetrics,
            completionChars: finalResponse.length,
            finishReason: "delegate_loop_terminated",
            blocked: false,
            toolIterations: iterationCount,
          });

          logAudit("turn_performance", { ...performance, usage: totalUsage }, {
            sessionId: session.id,
            channel: session.channel,
            severity: "info",
          });

          logAudit("message_sent", { length: finalResponse.length, toolCalls: iterationCount, usage: totalUsage, performance }, {
            sessionId: session.id,
            channel: session.channel,
            severity: "info",
          });

          // F29: Per-turn quality scorecard (delegate-loop-terminated path)
          logAudit("turn_scorecard", {
            delegationCount: _turnDelegationCount,
            shareFindingCount: _turnShareFindingCount,
            forcedSynthesisFired: _forcedSynthesisFired,
            wardenFailureCount: _consecutiveDelegationFailures,
            finalAnswerLength: finalResponse.length,
            toolIterations: iterationCount,
            finishReason: "delegate_loop_terminated",
          }, { sessionId: session.id, channel: session.channel, severity: "info" });

          return {
            response: finalResponse,
            toolCallsExecuted: iterationCount,
            guardrailEvents,
            usage: totalUsage,
            blocked: false,
            swarmState: getTurnSwarmState(),
            performance,
          };
        }

        toolResultMessages.push({
          role: "tool",
          content: limitMessage,
          tool_call_id: tc.id,
        });
        continue;
      }

      // Rate limit tool calls
      const toolRl = await checkRateLimit(session.id, "tool_call");
      if (!toolRl.allowed) {
        const rateLimitMessage = "Error: Rate limit exceeded for tool calls. Please reduce frequency.";
        if (opts.onToolResult) opts.onToolResult(tc.id, tc.name, rateLimitMessage);
        toolResultMessages.push({
          role: "tool",
          content: rateLimitMessage,
          tool_call_id: tc.id,
        });
        continue;
      }

      if (!allowedToolNameSet.has(tc.name)) {
        // ── Agent-name-as-tool recovery ──────────────────────────────────────
        // Local LLMs sometimes call "computer_use_agent(...)" as if it were a
        // tool, instead of delegate_to_agent(agentName: "computer_use_agent").
        // If the unrecognised tool name matches a configured sub-agent AND
        // delegate_to_agent is available, silently rewrite the call.
        const knownAgents = getConfig().subAgents ?? {};
        if (tc.name in knownAgents && allowedToolNameSet.has("delegate_to_agent")) {
          const recoveredAgentName = tc.name;
          const recoveredTask = deriveDelegationTaskFromArgs(tc.arguments);
          if (!recoveredTask) {
            // The model named a sub-agent as a tool but supplied no usable task
            // (empty or malformed arguments). Do NOT fabricate a task by
            // stringifying the raw arguments — that previously delegated the
            // literal `{"_parse_error":true,"_raw":""}` sentinel. Reject so the
            // model retries with a real task, matching delegate_to_agent's own
            // "task is required" guard.
            logAudit("tool_call_blocked", {
              tool: recoveredAgentName,
              reason: "agent_name_as_tool_missing_task",
              args: tc.arguments,
            }, { sessionId: session.id, severity: "warn" });
            guardrailEvents.push({ type: "tool_blocked", details: `${recoveredAgentName}:agent_name_as_tool_missing_task` });
            const missingTaskMessage = `Error: You called '${recoveredAgentName}' as if it were a tool but provided no task. To delegate, call delegate_to_agent with agentName: "${recoveredAgentName}" and a task string describing exactly what it should do.`;
            if (opts.onToolResult) opts.onToolResult(tc.id, tc.name, missingTaskMessage);
            toolResultMessages.push({
              role: "tool",
              content: missingTaskMessage,
              tool_call_id: tc.id,
            });
            continue;
          }
          tc.arguments = { agentName: recoveredAgentName, task: recoveredTask };
          tc.name = "delegate_to_agent";
          logAudit("tool_call_recovered", {
            originalTool: recoveredAgentName,
            rewrittenTo: "delegate_to_agent",
            reason: "agent_name_as_tool",
          }, { sessionId: session.id, severity: "info" });
        } else {
        logAudit("tool_call_blocked", { tool: tc.name, reason: "not_in_turn_toolset" }, {
          sessionId: session.id,
          severity: "warn",
        });
        guardrailEvents.push({ type: "tool_blocked", details: `${tc.name}:not_in_turn_toolset` });
        const unavailableMessage = tc.name === "write_file" || tc.name === "export_workspace_artifact"
          ? `Error: Direct artifact tool '${tc.name}' is not available in this turn. Do not retry it directly. Use delegate_to_agent with content_writer or another artifact-capable specialist, or synthesize from existing evidence if no artifact tool is available.`
          : `Error: Tool '${tc.name}' is not available in this turn. Use only the tools that were provided for this request. If this is a desktop-control task, delegate to computer_use_agent instead of calling direct computer_* or browser_* tools.`;
        if (opts.onToolResult) opts.onToolResult(tc.id, tc.name, unavailableMessage);
        toolResultMessages.push({
          role: "tool",
          content: unavailableMessage,
          tool_call_id: tc.id,
        });
        continue;
        }
      }

      // Block disallowed tools
      if (!isToolAllowed(tc.name)) {
        logAudit("tool_call_blocked", { tool: tc.name, reason: "not_allowed" }, {
          sessionId: session.id,
          severity: "warn",
        });
        guardrailEvents.push({ type: "tool_blocked", details: tc.name });
        const blockedMessage = `Error: Tool '${tc.name}' is blocked by security policy.`;
        if (opts.onToolResult) opts.onToolResult(tc.id, tc.name, blockedMessage);
        toolResultMessages.push({
          role: "tool",
          content: blockedMessage,
          tool_call_id: tc.id,
        });
        continue;
      }

      logAudit("tool_call_requested", { tool: tc.name, args: tc.arguments }, { sessionId: session.id });
      if (opts.onToolCall) opts.onToolCall(tc.id, tc.name, tc.arguments);

      // Reject tool calls with unparseable arguments from the LLM
      if (tc.arguments && "_parse_error" in tc.arguments) {
        const rawArgs = (tc.arguments as Record<string, unknown>)["_raw"];
        const intervention = classifyToolIntervention({
          toolName: tc.name,
          success: false,
          error: "Malformed JSON arguments produced by the model",
          malformedArguments: true,
        });
        logAudit("tool_call_failed", {
          tool: tc.name,
          reason: "invalid_arguments",
          raw: String(rawArgs).slice(0, 200),
          issueCode: intervention?.reasonCode,
          intervention,
        }, {
          sessionId: session.id, severity: "warn",
        });
        if (intervention) opts.onIntervention?.(intervention);
        const parseErrorMessage = `Error: Could not parse arguments for tool '${tc.name}'. The arguments were malformed JSON. Do not retry the same large inline payload; synthesize from existing evidence or use a smaller valid tool call.`;
        if (opts.onToolResult) opts.onToolResult(tc.id, tc.name, parseErrorMessage);
        toolResultMessages.push({
          role: "tool",
          content: parseErrorMessage,
          tool_call_id: tc.id,
        });
        continue;
      }

      if (tc.name === "delegate_to_agent") {
        const requestedAgentName = typeof tc.arguments?.["agentName"] === "string"
          ? String(tc.arguments["agentName"]).trim()
          : "";
        if (!requestedAgentName && pendingSearchAgentSuggestion?.agentName) {
          tc.arguments = {
            ...(tc.arguments ?? {}),
            agentName: pendingSearchAgentSuggestion.agentName,
            fallbackAgents: Array.isArray(tc.arguments?.["fallbackAgents"]) && tc.arguments["fallbackAgents"].length > 0
              ? tc.arguments["fallbackAgents"]
              : pendingSearchAgentSuggestion.fallbackAgents,
          };
          logAudit("tool_call_recovered", {
            originalTool: "delegate_to_agent",
            rewrittenTo: "delegate_to_agent",
            reason: "reuse_search_agents_top_result",
            recoveredAgentName: pendingSearchAgentSuggestion.agentName,
            routingQuery: pendingSearchAgentSuggestion.query ?? null,
            recoveredFallbackAgents: pendingSearchAgentSuggestion.fallbackAgents ?? [],
          }, {
            sessionId: session.id,
            severity: "info",
          });
        }
      } else if (tc.name === "swarm_delegate" && pendingSearchAgentSuggestion?.agentName && allowedToolNameSet.has("delegate_to_agent")) {
        tc.name = "delegate_to_agent";
        tc.arguments = {
          ...(tc.arguments ?? {}),
          agentName: pendingSearchAgentSuggestion.agentName,
          fallbackAgents: Array.isArray(tc.arguments?.["fallbackAgents"]) && tc.arguments["fallbackAgents"].length > 0
            ? tc.arguments["fallbackAgents"]
            : pendingSearchAgentSuggestion.fallbackAgents,
        };
        logAudit("tool_call_recovered", {
          originalTool: "swarm_delegate",
          rewrittenTo: "delegate_to_agent",
          reason: "reuse_search_agents_top_result",
          recoveredAgentName: pendingSearchAgentSuggestion.agentName,
          routingQuery: pendingSearchAgentSuggestion.query ?? null,
          recoveredFallbackAgents: pendingSearchAgentSuggestion.fallbackAgents ?? [],
        }, {
          sessionId: session.id,
          severity: "info",
        });
      }

      const argsSig = JSON.stringify(tc.arguments ?? {});
      const cachedToolCall = _lastToolCallSig.get(tc.name);
      if (tc.name !== "delegate_to_agent" && cachedToolCall && cachedToolCall.args === argsSig) {
        const cachedResultText = `${cachedToolCall.result}\n\n[Note: This is a cached result — you already called '${tc.name}' with identical arguments earlier in this turn. Do NOT call it again. Use this result and move to a different step.]`;
        _lastToolResultByName.set(tc.name, cachedToolCall.result);

        logAudit("tool_call_completed", {
          tool: tc.name,
          success: true,
          outputChars: cachedToolCall.result.length,
          metadata: cachedToolCall.metadata,
          cachedResult: true,
          suspiciousReturn: false,
          intervention: null,
        }, {
          sessionId: session.id,
          severity: "warn",
        });

        if (opts.onToolResult) opts.onToolResult(tc.id, tc.name, cachedResultText, cachedToolCall.metadata);

        toolResultMessages.push({
          role: "tool",
          content: buildModelVisibleToolResult(tc.name, cachedResultText, cachedToolCall.metadata),
          tool_call_id: tc.id,
          metadata: cachedToolCall.metadata,
        });

        pendingSearchAgentSuggestion = tc.name === "search_agents"
          ? extractAgentRoutingSuggestionFromMetadata(cachedToolCall.metadata)
          : undefined;

        if (tc.name === "search_agents" && requiresDelegatedResearch && searchAgentsReturnedNoMatch(cachedToolCall.metadata)) {
          searchAgentsNoMatchCount += 1;
          const route: RequiredResearchFallbackRoute | null = requiredResearchFallbackRoute ?? buildRequiredResearchFallbackRoute(researchSubject, initialDynamicGuidance, allowedToolNameSet, opts.allowedAgents);
          if (route) {
            requiredResearchFallbackRoute = route;
            searchAgentsNoMatchFallbackPrompt = buildSearchAgentsNoMatchFallbackPrompt(route);
            logAudit("guardrail_flagged", {
              type: "agent_discovery_no_match_fallback",
              noMatchCount: searchAgentsNoMatchCount,
              fallbackTool: route.toolName,
              fallbackAgent: route.label,
              cachedResult: true,
            }, { sessionId: session.id, severity: "warn" });
            opts.onStatus?.({ phase: "guardrail", message: "Agent discovery returned no usable match, so I am falling back to a required research specialist instead of searching again.", iteration: iterationCount });
          }
        }
        continue;
      }

      const toolStartedAt = Date.now();
      const result = await executeTool(tc.name, tc.arguments, toolContext);
      const toolDurationMs = Date.now() - toolStartedAt;
      if (PERSISTED_SWARM_STATE_TOOL_NAMES.has(tc.name)) {
        turnUsedSwarmTools = true;
      }
      toolExecutionTimeMs += toolDurationMs;
      // D5: the orchestrator was BLOCKED for toolDurationMs awaiting this delegation's children —
      // exclude that from the turn budget by pushing BOTH timeout layers' deadlines out (the runtime
      // abort here, the gateway hard timeout via onDelegationWaitMs), so the tier budget bounds the
      // parent's own work, not its children's (run e3cf6c22). Bounded by the absolute ceiling.
      if (
        DELEGATION_WAIT_TOOL_NAMES.has(tc.name)
        && toolDurationMs > 0
        && getConfig().orchestration?.excludeDelegationWaitFromTurnBudget !== false
      ) {
        const extendedDeadline = turnBudget?.extendForDelegationWait(toolDurationMs);
        if (extendedDeadline !== undefined) toolContext._turnDeadlineMs = extendedDeadline;
        opts.onDelegationWaitMs?.(toolDurationMs);
      }
      const intervention = classifyToolIntervention({
        toolName: tc.name,
        success: result.success,
        output: result.output,
        error: result.error,
      });

      logAudit(
        result.success ? "tool_call_completed" : "tool_call_failed",
        {
          tool: tc.name,
          success: result.success,
          error: result.error,
          outputChars: result.output.length,
          durationMs: toolDurationMs,
          metadata: result.metadata,
          issueCode: intervention?.reasonCode,
          suspiciousReturn: result.success && Boolean(intervention),
          intervention,
        },
        { sessionId: session.id, severity: result.success ? "info" : "warn" }
      );

      let resultText = result.success
        ? result.output
        : (result.error?.trim()
            ? `Error: ${result.error}`
            : (result.output.trim() || "Error: Unknown error"));

      const workflowMatchesFromResult = extractWorkflowCatalogMatchesFromMetadata(result.metadata);

      if (tc.name === "search_workflows") {
        workflowSearchMatches = result.success
          ? extractWorkflowCatalogMatchesFromMetadata(result.metadata)
          : [];
      } else if (tc.name === "run_workflow" && workflowMatchesFromResult.length > 0) {
        workflowSearchMatches = mergeWorkflowCatalogMatches(workflowSearchMatches, workflowMatchesFromResult);
      } else if (tc.name === "run_workflow" && result.success) {
        workflowRunCompletedThisTurn = true;
      }

      pendingSearchAgentSuggestion = tc.name === "search_agents"
        ? extractAgentRoutingSuggestionFromMetadata(result.metadata)
        : undefined;

      if (tc.name === "search_agents" && requiresDelegatedResearch && searchAgentsReturnedNoMatch(result.metadata)) {
        searchAgentsNoMatchCount += 1;
        const route: RequiredResearchFallbackRoute | null = requiredResearchFallbackRoute ?? buildRequiredResearchFallbackRoute(researchSubject, initialDynamicGuidance, allowedToolNameSet, opts.allowedAgents);
        if (route) {
          requiredResearchFallbackRoute = route;
          searchAgentsNoMatchFallbackPrompt = buildSearchAgentsNoMatchFallbackPrompt(route);
          logAudit("guardrail_flagged", {
            type: "agent_discovery_no_match_fallback",
            noMatchCount: searchAgentsNoMatchCount,
            fallbackTool: route.toolName,
            fallbackAgent: route.label,
          }, { sessionId: session.id, severity: "warn" });
          opts.onStatus?.({ phase: "guardrail", message: "Agent discovery returned no usable match, so I am falling back to a required research specialist instead of searching again.", iteration: iterationCount });
        }
      }

      if (
        tc.name === "run_workflow"
        && !result.success
      ) {
        const workflowCorrectionMatches = mergeWorkflowCatalogMatches(workflowSearchMatches, workflowMatchesFromResult);
        const workflowErrorText = result.error?.trim() || resultText;
        if (
          isWorkflowNameResolutionFailureMessage(workflowErrorText)
          && !workflowCatalogSuppressedForMaintenance
          && shouldRequireWorkflowExecutionAfterSearch(workflowCorrectionMatches)
        ) {
          if (!workflowExecutionCorrectionRetryUsed) {
            workflowExecutionCorrectionRetryUsed = true;
            workflowExecutionEnforcementPrompt = formatWorkflowExecutionCorrectionPromptFromSearch(workflowCorrectionMatches, workflowErrorText);
            workflowExecutionCorrectionPending = true;
            guardrailEvents.push({ type: "workflow_required", details: "workflow_run_correction_required" });
            logAudit("guardrail_flagged", {
              type: "workflow_run_correction_required",
              attemptedWorkflowName: typeof tc.arguments?.["name"] === "string" ? tc.arguments["name"] : undefined,
              error: workflowErrorText,
              workflowMatches: workflowCorrectionMatches.slice(0, 3),
            }, { sessionId: session.id, severity: "warn" });
          } else {
            workflowExecutionCorrectionExhausted = true;
          }
        }
      }

      _lastToolResultByName.set(tc.name, resultText);

      // ── Reused-delegation loop detection ─────────────────────────────────
      // When a coordinator keeps paraphrasing the same task, the underlying
      // signature still matches and `executeDelegationWithFallback` returns
      // the cached output with metadata.reused=true. Counting these in-turn
      // catches semantic loops that the byte-equality fingerprint below
      // misses (because each paraphrase mutates the args).
      if (
        tc.name === "delegate_to_agent"
        && result.success
        && (result.metadata as { reused?: unknown } | undefined)?.reused === true
      ) {
        _turnReusedDelegationCount += 1;
        if (_turnReusedDelegationCount >= REUSED_DELEGATION_LOOP_THRESHOLD) {
          logAudit(
            "tool_call_completed",
            {
              tool: tc.name,
              success: true,
              outputChars: result.output.length,
              reusedDelegationLoop: true,
              reusedDelegationCount: _turnReusedDelegationCount,
            },
            { sessionId: session.id, severity: "warn" },
          );
          const finalResponse = buildDelegationLoopResponse(session, result.output, "identical-output");
          persistAssistantTurnState(session, finalResponse, getTurnSwarmState());
          const performance = buildTurnPerformanceMetrics({
            turnStartedAt,
            firstModelResponseMs,
            llmCalls,
            llmTimeMs,
            toolCallsRequested,
            toolExecutionTimeMs,
            lastPromptMetrics,
            completionChars: finalResponse.length,
            finishReason: "delegate_loop_terminated",
            blocked: false,
            toolIterations: iterationCount,
          });
          return {
            response: finalResponse,
            toolCallsExecuted: toolCallsRequested,
            guardrailEvents,
            usage: totalUsage,
            blocked: false,
            swarmState: getTurnSwarmState(),
            performance,
          };
        }
      }

      // ── Identical output loop detection ──────────────────────────────────
      // Track BOTH successes and failures — repeated errors are loops too.
      {
        const outputFingerprint = buildRepeatedOutputFingerprint(tc.name, tc.arguments, resultText);
        const prev = _recentOutputsByTool.get(tc.name) ?? [];
        prev.push(outputFingerprint);
        if (prev.length > IDENTICAL_OUTPUT_LOOP_THRESHOLD) prev.shift();
        _recentOutputsByTool.set(tc.name, prev);

        if (
          prev.length >= IDENTICAL_OUTPUT_LOOP_THRESHOLD &&
          prev.every(o => o === prev[0])
        ) {
          const loopIntervention = classifyToolIntervention({
            toolName: tc.name,
            success: result.success,
            output: result.output,
            error: result.error,
            repeatedIdenticalOutput: true,
          });
          logAudit(
            "tool_call_completed",
            {
              tool: tc.name,
              success: result.success,
              outputChars: result.output.length,
              suspiciousReturn: true,
              repeatedIdenticalOutput: true,
              issueCode: loopIntervention?.reasonCode,
              intervention: loopIntervention,
            },
            { sessionId: session.id, severity: "warn" },
          );

          if (tc.name === "delegate_to_agent") {
            const finalResponse = buildDelegationLoopResponse(session, result.output, "identical-output");
            persistAssistantTurnState(session, finalResponse, getTurnSwarmState());

            const performance = buildTurnPerformanceMetrics({
              turnStartedAt,
              firstModelResponseMs,
              llmCalls,
              llmTimeMs,
              toolCallsRequested,
              toolExecutionTimeMs,
              lastPromptMetrics,
              completionChars: finalResponse.length,
              finishReason: "delegate_loop_terminated",
              blocked: false,
              toolIterations: iterationCount,
            });

            logAudit("turn_performance", { ...performance, usage: totalUsage }, {
              sessionId: session.id,
              channel: session.channel,
              severity: "info",
            });

            logAudit("message_sent", { length: finalResponse.length, toolCalls: iterationCount, usage: totalUsage, performance }, {
              sessionId: session.id,
              channel: session.channel,
              severity: "info",
            });

            // F29: Per-turn quality scorecard (identical-output loop terminated path)
            logAudit("turn_scorecard", {
              delegationCount: _turnDelegationCount,
              shareFindingCount: _turnShareFindingCount,
              forcedSynthesisFired: _forcedSynthesisFired,
              wardenFailureCount: _consecutiveDelegationFailures,
              finalAnswerLength: finalResponse.length,
              toolIterations: iterationCount,
              finishReason: "delegate_loop_terminated",
            }, { sessionId: session.id, channel: session.channel, severity: "info" });

            return {
              response: finalResponse,
              toolCallsExecuted: iterationCount,
              guardrailEvents,
              usage: totalUsage,
              blocked: false,
              swarmState: getTurnSwarmState(),
              performance,
            };
          }

          resultText +=
            `\n\n[System notice: ${tc.name} has returned identical output ${IDENTICAL_OUTPUT_LOOP_THRESHOLD} times in a row. ` +
            `You are stuck in a loop. Do NOT call this tool again. Summarise what you have found so far and report it to the user, or try a clearly different approach.]`;
          if (loopIntervention) opts.onIntervention?.(loopIntervention);
          _recentOutputsByTool.set(tc.name, []); // reset so alert fires at most once per burst
        }
      }

      // Tool-output post-processing sub-phase (secret redaction → prompt-injection
      // screen → moderation → sig cache → callbacks → model-visible framing → append).
      // Lifted verbatim into ./turn-tool-execution.ts; it mutates the shared collectors
      // (guardrailEvents, _lastToolCallSig, toolResultMessages) and returns the final,
      // possibly-redacted/blocked resultText so it reads back exactly as inline.
      const toolResultPostProcessContext: ToolResultPostProcessContext = {
        toolCall: tc,
        result,
        intervention,
        argsSig,
        session,
        onIntervention: opts.onIntervention,
        onToolResult: opts.onToolResult,
        guardrailEvents,
        lastToolCallSig: _lastToolCallSig,
        toolResultMessages,
      };
      resultText = await postProcessToolResult(resultText, toolResultPostProcessContext);

      if (workflowExecutionCorrectionExhausted) {
        session.addMessages(toolResultMessages);
        return blocked(
          "This turn searched the workflow catalog but still failed to call run_workflow with one of the returned workflow names.",
          getTurnSwarmState(),
          buildTurnPerformanceMetrics({
            turnStartedAt,
            firstModelResponseMs,
            llmCalls,
            llmTimeMs,
            toolCallsRequested,
            toolExecutionTimeMs,
            lastPromptMetrics,
            completionChars: 0,
            finishReason: "invalid_workflow_name_after_search",
            blocked: true,
            toolIterations: iterationCount,
          }),
        );
      }

    }

    session.addMessages(toolResultMessages);

    if (workflowExecutionCorrectionPending) {
      continue;
    }

    // ── Post-orchestration synthesis nudge ─────────────────────────────────
    // When orchestration returns grounded evidence, inject a strong nudge
    // telling the model to synthesize NOW instead of re-delegating for the same data.
    {
      const disposition = classifyPostOrchestrationDisposition(toolResultMessages);
      if (disposition === "synthesize") {
        _consecutiveDelegationFailures = 0;
        // #1 (audit 763394da): before synthesizing/relaying after a successful
        // delegation, honor a recorded MULTI-step plan — a 3-deliverable request
        // (paper → slides → notes) must not ship only the paper. Bounded by the
        // per-turn delegate cap and only extends on success, so it cannot loop.
        if (getConfig().orchestration?.planDrivenContinuation ?? false) {
          const continuationPlan = await loadTurnPlan(session.id);
          const delegateCap = getConfig().orchestration?.perTurnCaps?.["delegate_to_agent"] ?? 5;
          const planDecision = decidePlanContinuation({
            plan: continuationPlan,
            executedDelegations: _turnDelegationCount,
            delegationCap: delegateCap,
            lastDelegationSucceeded: true,
            enabled: true,
          });
          if (planDecision.continue && continuationPlan) {
            logAudit("guardrail_flagged", {
              type: "plan_driven_continuation",
              done: planDecision.done,
              total: planDecision.total,
            }, { sessionId: session.id, channel: session.channel, severity: "info" });
            session.addMessage({
              role: "system",
              content: renderPlanContinuationDirective(continuationPlan, planDecision.done, planDecision.total),
            });
            continue;
          }
        }
        // Cost-center 2 (audit 5d51862f): if this turn's ONLY orchestration was a single
        // delegation that returned a complete, presentable deliverable, surface it directly
        // instead of paying for a SECOND full synthesis pass on the slow local model (which
        // also caused coordinator↔assistant divergence). Strictly gated to the clean
        // single-deliverable case; everything else still synthesizes below.
        // A single-deliverable relay is a shortcut for a COMPLETE deliverable. But when the
        // user asked to BUILD an interactive app / served app (web_coder/backend_coder class)
        // and NO real artifact was produced this turn, the relayed text is research + a
        // *concept*, not the built app — relaying it ships "here's how it could work" and
        // short-circuits the auto-build backstop entirely (audit 9ad34ef9: a "WebApp" turn
        // relayed the researcher's fact-sheet + concept and never built anything). Suppress the
        // relay in that case so the turn falls through to autoBuildAfterResearch, which builds
        // the actual app file. Scoped to app/served deliverables so plain reports/decks (which
        // are fine inline) still relay.
        const turnNeedsUnbuiltAppArtifact =
          deliverableIntent.wantsArtifact
          && deliverableIntent.isAppBuild
          && collectTurnArtifactAttachments(session).length === 0;
        if (turnNeedsUnbuiltAppArtifact) {
          logAudit("guardrail_flagged", {
            type: "single_deliverable_relay_suppressed_unbuilt_app",
            builderAgent: deliverableIntent.builder,
          }, { sessionId: session.id, channel: session.channel, severity: "warn" });
        }
        const relayDeliverable = (getConfig().orchestration?.relaySingleDeliverable ?? true) && !turnNeedsUnbuiltAppArtifact
          ? extractSingleRelayableDeliverable(toolResultMessages, _turnDelegationCount)
          : null;
        if (relayDeliverable) {
          const finalResponse = sanitizeUserFacingAssistantResponse(relayDeliverable, iterationCount);
          persistAssistantTurnState(session, finalResponse, getTurnSwarmState());
          if (opts.onChunk) opts.onChunk(finalResponse);
          const performance = buildTurnPerformanceMetrics({
            turnStartedAt,
            firstModelResponseMs,
            llmCalls,
            llmTimeMs,
            toolCallsRequested,
            toolExecutionTimeMs,
            lastPromptMetrics,
            completionChars: finalResponse.length,
            finishReason: "single_deliverable_relayed",
            blocked: false,
            toolIterations: iterationCount,
          });
          logAudit("delegated_deliverable_relayed", {
            chars: finalResponse.length,
            toolIterations: iterationCount,
            delegationCount: _turnDelegationCount,
          }, { sessionId: session.id, channel: session.channel, severity: "info" });
          logAudit("turn_performance", { ...performance, usage: totalUsage }, { sessionId: session.id, channel: session.channel });
          logAudit("message_sent", { length: finalResponse.length, toolCalls: iterationCount, usage: totalUsage, performance }, { sessionId: session.id, channel: session.channel });
          logAudit("turn_scorecard", {
            delegationCount: _turnDelegationCount,
            shareFindingCount: _turnShareFindingCount,
            forcedSynthesisFired: _forcedSynthesisFired,
            wardenFailureCount: _consecutiveDelegationFailures,
            finalAnswerLength: finalResponse.length,
            toolIterations: iterationCount,
            finishReason: "single_deliverable_relayed",
          }, { sessionId: session.id, channel: session.channel });
          return {
            response: finalResponse,
            toolCallsExecuted: iterationCount,
            guardrailEvents,
            usage: totalUsage,
            blocked: false,
            swarmState: getTurnSwarmState(),
            performance,
          };
        }
        // Artifact-aware variant: when the orchestration produced attached files,
        // the final answer is a completion SUMMARY (paths + what was built), never
        // a relay of the documents' contents (audit 2445da2e).
        const synthesisArtifacts = collectTurnArtifactAttachments(session);
        // Honesty floor (audit 0dc158ad): on a turn whose research came back partial/
        // cancelled/below the substance floor, the normal "copy the exact names and
        // numbers from the evidence" directive oversells thin evidence and the model
        // fabricates specifics (it claimed an analog mic has an I2S interface). Swap in an
        // honesty directive on exactly that failure condition. The de-lex hardwired
        // sourceSensitive off, killing this guard; restored here from PURELY STRUCTURAL
        // signals — real orchestration ran this turn AND it came back junk/partial
        // (findRecentJunkDelegationResult reads delegation-outcome metadata, no keywords) —
        // so it only fires when evidence is thin and good turns are untouched.
        const partialEvidenceSynthesis =
          synthesisArtifacts.length === 0
          && getConfig().orchestration?.honestSynthesisOnPartialEvidence === true
          && _turnDelegationCount > 0
          && findRecentJunkDelegationResult(toolResultMessages) !== null;
        if (partialEvidenceSynthesis) {
          logAudit("guardrail_flagged", {
            type: "honest_synthesis_partial_evidence",
          }, { sessionId: session.id, channel: session.channel, severity: "warn" });
        }
        session.addMessage({
          role: "system",
          content: buildSynthesisRequiredDirective({
            artifactPaths: synthesisArtifacts.map((artifact) => String(artifact["relativePath"] ?? artifact["filename"] ?? "artifact")),
            partialEvidence: partialEvidenceSynthesis,
          }),
        });
      } else if (disposition === "continue") {
        _consecutiveDelegationFailures = 0;
        session.addMessage({
          role: "system",
          content:
            "[CONTINUE ORCHESTRATION] The latest delegated evidence identifies a concrete follow-up action that has not yet been executed. " +
            "You may continue in this same turn if the next action is materially different from prior delegations and directly advances the request. " +
            "Do NOT repeat the same delegation, and do NOT ask for information already present in the evidence. " +
            "Treat delegated phrases like 'I will now attempt...' or 'the next step...' as proposed follow-up work, not proof that it already happened. Do NOT tell the user a next step 'has been executed' unless this turn includes the completed tool result for that action.",
        });
      } else if (disposition === "ask_user") {
        _consecutiveDelegationFailures = 0;
        session.addMessage({
          role: "system",
          content:
            "[USER RESPONSE REQUIRED] The latest delegated evidence indicates that further progress requires clarification, authorization, approval, or another user decision. " +
            "Ask the user yourself in one concise message and do NOT call more tools until they respond.",
        });
      } else if (disposition === "failure") {
        _consecutiveDelegationFailures += 1;
        if (_consecutiveDelegationFailures >= 2) {
          // D16: Warden escalation. The system message alone relied on the model to obey
          // "stop delegating" — a model that keeps delegating (or varies the delegation
          // TOOL between the uncapped parallel_delegate / run_task_graph so neither the
          // per-turn cap nor the identical-output / tool-set loop detectors trip) churns
          // to the iteration cap. At max effort (turnTimeoutMs:0) that is a multi-minute
          // run with sustained event-loop lag and no final answer (audit 0602f246). Make
          // the warden's terminal intent REAL: break to the forceSynthesis path now, the
          // same way the all-blocked-iterations guard does. Structural (keyed on the
          // failure counter, which resets to 0 on any successful delegation — so this only
          // fires when two delegations failed with no intervening progress), not on the
          // message text, agent name, or language.
          _forcedSynthesisFired = true; // F29
          session.addMessage({
            role: "system",
            content:
              "[WARDEN STOP — FORCED SYNTHESIS] Two or more consecutive delegation attempts have failed. " +
              "You MUST stop delegating and respond to the user now. " +
              "If any partial evidence exists in the evidence blocks above, synthesize it into the best possible answer. " +
              "If there is no usable evidence, tell the user honestly that the information could not be retrieved at this time and suggest what they could do next. " +
              "Do NOT call any more delegation tools in this turn.",
          });
          terminalFinishReason = "delegation_failures_terminal";
          terminalSynthesisInstruction =
            "Two or more consecutive delegation attempts failed this turn, so no further delegation will be attempted. " +
            "Using ONLY the evidence already gathered in this conversation (including any shared findings), write the best possible final answer NOW, in the user's language. " +
            "If no usable evidence exists, tell the user honestly that the information could not be retrieved and suggest a concrete next step. " +
            "Do NOT re-paste an earlier turn's answer as if new work was completed.";
          break;
        } else {
          session.addMessage({
            role: "system",
            content:
              "[DELEGATION FAILED] The latest delegated action failed or did not return useful evidence. " +
              "Do NOT retry the same exact delegation. You may attempt a different strategy or ask the user for guidance.",
          });
        }
      }

      if (toolResultMessages.length > 0) {
        session.addMessage({
          role: "system",
          content:
            "[USER INTERACTION OWNERSHIP] The main assistant owns all user-facing interaction. " +
            "If the latest delegated results require clarification, authorization, approval, or another user decision, ask the user yourself in one concise message and stop delegating until they respond. " +
            "If meaningful intermediate results were confirmed and more work still remains, provide a short progress update summarizing what is already known and what remains open. " +
            "Only describe a next action if you are actually going to call another tool in this same turn. Never restate a proposed follow-up from delegated evidence as already executed unless a completed tool result in this turn proves it happened. If synthesis is required or the turn is ending, do not promise automatic continuation.",
        });
      }
    }

    iterationCount++;

    // After each iteration that included a delegation, refresh the shared-findings
    // system message so the next LLM call (which may be the final synthesis) sees
    // any facts that sub-agents published to shared session memory.  This prevents
    // the orchestrator from hallucinating training-data values (e.g. wrong mic
    // interface type) when a researcher has already verified and shared the truth.
    if (_turnDelegationCount > 0) {
      _sharedFindingsSystemMessage = await formatSharedFactsForFinalSynthesis(session.id);
    }

    // ── All-blocked iteration guard ────────────────────────────────────────
    // If every tool call in this iteration was blocked (per-turn limit, not-allowed,
    // or parse error) the model is stuck — force synthesis after N such iterations.
    {
      const executed = toolResultMessages.filter(m => {
        const txt = typeof m.content === "string" ? m.content : "";
        return !txt.startsWith("Error:") && !txt.includes("blocked by security policy") && !txt.includes("call limit");
      });
      if (executed.length === 0 && toolResultMessages.length > 0) {
        _consecutiveFullyBlockedIterations++;
      } else {
        _consecutiveFullyBlockedIterations = 0;
      }
      if (_consecutiveFullyBlockedIterations >= FULLY_BLOCKED_ITERATION_THRESHOLD) {
        logAudit("tool_loop_detected", {
          reason: "all_tool_calls_blocked",
          consecutiveBlockedIterations: _consecutiveFullyBlockedIterations,
          iterations: iterationCount,
        }, { sessionId: session.id, severity: "warn" });
        terminalFinishReason = "all_tool_calls_blocked";
        terminalSynthesisInstruction =
          "The model repeatedly attempted tool calls that were blocked or unavailable, so NOTHING was created or changed this turn. Stop trying tools. Using ONLY the evidence already present in the conversation, write the best possible final answer now. If the user asked you to create or modify an artifact and you have no direct file tool, say plainly that you could not apply the change and offer to delegate it — do NOT invent an artifact path, and do NOT repeat or re-paste an earlier turn's answer as if the change had been applied.";
        _forcedSynthesisFired = true;
        log.warn({ iterationCount, blocked: _consecutiveFullyBlockedIterations }, "All tool calls blocked for consecutive iterations — forcing synthesis");
        break;
      }
    }

    // ── Iteration-level loop detection ──────────────────────────────────────
    // (a) Identical tool-name set repeating N iterations in a row → force-synthesise.
    const iterToolNames = llmResponse.tool_calls.map(tc => tc.name);
    const iterToolSet = [...iterToolNames].sort().join(",");
    const iterToolSetFullyBoundedByPerTurnCaps = iterToolNames.length > 0
      && iterToolNames.every((toolName) => getPerTurnToolCallLimit(toolName) !== undefined);
    _iterationToolSets.push(iterToolSet);
    if (_iterationToolSets.length > ITERATION_LOOP_THRESHOLD) _iterationToolSets.shift();
    if (
      !iterToolSetFullyBoundedByPerTurnCaps &&
      _iterationToolSets.length >= ITERATION_LOOP_THRESHOLD &&
      _iterationToolSets.every(s => s === _iterationToolSets[0])
    ) {
      logAudit("tool_loop_detected", {
        reason: "iteration_tool_set_repeat",
        toolSet: iterToolSet,
        iterations: iterationCount,
      }, { sessionId: session.id, severity: "warn" });
      log.warn({ iterationCount, toolSet: iterToolSet }, "Same tool-call set repeated across iterations — forcing synthesis");
      break; // falls through to forceSynthesis below
    }

    // (b) Per-tool consecutive-iteration streak — catches "growing" patterns where the
    //     overall tool set changes each iteration but the same core tools keep appearing.
    //     Skip tools that already have a per-turn limit — those are bounded by the limit
    //     and handled by the all-blocked-iterations guard above.
    {
      const currentIterTools = new Set(llmResponse.tool_calls.map(tc => tc.name));
      for (const toolName of currentIterTools) {
        if (!getPerTurnToolCallLimit(toolName)) {
          _toolIterationStreak.set(toolName, (_toolIterationStreak.get(toolName) ?? 0) + 1);
        }
      }
      // Reset streak for tools NOT called in this iteration
      for (const [toolName] of _toolIterationStreak) {
        if (!currentIterTools.has(toolName)) _toolIterationStreak.delete(toolName);
      }
      let streakLoop = false;
      for (const [toolName, streak] of _toolIterationStreak) {
        if (streak >= TOOL_STREAK_THRESHOLD) {
          logAudit("tool_loop_detected", {
            reason: "tool_streak_across_iterations",
            tool: toolName,
            consecutiveIterations: streak,
            iterations: iterationCount,
          }, { sessionId: session.id, severity: "warn" });
          log.warn({ toolName, streak, iterationCount }, "Tool repeated across too many consecutive iterations — forcing synthesis");
          streakLoop = true;
          break;
        }
      }
      if (streakLoop) break; // falls through to forceSynthesis below
    }
  }

  // Exceeded max iterations (or iteration-level loop) — force a synthesis response from the LLM
  opts.onStatus?.({ phase: "synthesizing", message: "Writing the final response from the evidence gathered so far.", iteration: iterationCount });
  const terminalDelegateEvidence = findRecentDelegateEvidence(session.getHistory());
  const terminalSharedFactsEvidence = await getSharedFactsEvidenceForFinalSynthesis(session.id);
  const terminalEvidenceBackstop = chooseBetterRecoveryEvidence(
    terminalDelegateEvidence,
    terminalSharedFactsEvidence,
    { preferHigherScore: false },
  );
  const bypassTerminalSynthesis = shouldBypassTerminalSynthesisWithEvidence(terminalFinishReason, terminalEvidenceBackstop);
  let synthesized = bypassTerminalSynthesis
    ? null
    : await forceSynthesis(
        session, provider, signal, terminalSynthesisInstruction,
      );
  // Honesty guard for terminal turns that did NOT deliver the user's NEW request,
  // yet "answer" by re-pasting an EARLIER turn's deliverable summary almost verbatim —
  // shipping a stale false success. First seen on all_tool_calls_blocked (audit
  // 43b3ec65 turn 3), but the SAME reship happens when a turn ends with tool calls
  // rejected after synthesis was required (audit f6e10341 turn 2: "add images"
  // produced only a sidecar JSON yet the answer re-pasted the turn-1 "presentation
  // created" summary) or hits the iteration limit. So fire across that whole "nothing
  // was actually delivered for THIS request" terminal set, not just the blocked path.
  // The corrective pass keeps the user's language and does NOT assert "nothing was
  // created" (a sidecar may have been written) — only that the prior deliverable was
  // not updated as the stale copy implied.
  const REGURGITATION_GUARD_REASONS = new Set([
    "all_tool_calls_blocked",
    "synthesis_required_tool_call_rejected",
    "max_tool_iterations",
    "delegation_failures_terminal",
  ]);
  if (
    REGURGITATION_GUARD_REASONS.has(terminalFinishReason)
    && synthesized
    && looksLikeRegurgitatedPriorAnswer(synthesized, session.getHistory())
  ) {
    logAudit("guardrail_flagged", {
      type: "blocked_turn_regurgitated_prior_answer",
      finishReason: terminalFinishReason,
      synthesizedLength: synthesized.length,
    }, { sessionId: session.id, channel: session.channel, severity: "warn" });
    const honest = await forceSynthesis(
      session, provider, signal,
      "Your previous draft re-pasted an earlier turn's answer almost verbatim, which falsely implies the user's NEW request in THIS turn was already carried out. Do NOT ship that stale copy. "
      + "Reply briefly and honestly IN THE USER'S LANGUAGE: describe only what actually happened in THIS turn (what, if anything, was produced or attempted this turn), and if the requested change was NOT applied to the deliverable, say so plainly and offer to delegate it to the right specialist so it gets done. "
      + "Do NOT re-paste the earlier deliverable as if it had been updated, do NOT invent a file path, and do NOT claim a success you cannot point to in this turn's own results.",
    );
    synthesized = (honest && !looksLikeRegurgitatedPriorAnswer(honest, session.getHistory()))
      ? honest
      : "I didn't actually apply that change in this turn, and I won't restate the earlier result as if it had been updated. Confirm and I'll delegate the work to the right specialist so it gets done.\n\nIch habe die Änderung in diesem Schritt nicht tatsächlich angewendet und gebe das frühere Ergebnis nicht als aktualisiert aus. Bestätige bitte, dann delegiere ich die Arbeit an den passenden Spezialisten.";
  }
  // When we have evidence in scope, prefer it over the generic
  // "I've gathered partial results" message — that string was correct
  // about what happened but threw away the partial results.  Only fall
  // back to the static message when no usable evidence exists.
  // The bypass evidence is often a raw shared-facts dump (`- auto_xxx_xxx:
  // <tool tag> <content>` with mid-word "..." cuts). Surfacing that
  // verbatim looks like debug output to the user. Reformat it into a
  // readable list with a clear "research was interrupted" preamble before
  // it becomes the final answer.
  const fallbackMsg = (bypassTerminalSynthesis && terminalEvidenceBackstop)
    ? (looksLikeRawSharedFactsDump(terminalEvidenceBackstop.evidence)
        ? buildRecoveryEvidenceUserMessage(terminalEvidenceBackstop.evidence)
        : terminalEvidenceBackstop.evidence)
    : terminalFinishReason === "max_tool_iterations"
      ? "I've gathered partial results but reached the tool-call limit. Please review the tool outputs above for details."
      : resolveEmptyAssistantResponseFallback("", "", session);
  // Second-chance evidence backstop.  Even when the synthesis call ran,
  // it often comes back with an apologetic 50-200 char reply while
  // substantial structured evidence sits in the transcript — the exact
  // "all the info, no answer" failure mode operators report.  When the
  // synthesis is underpowered AND we have evidence available, prefer the
  // evidence.  Strictly post-hoc — doesn't change cases where synthesis
  // genuinely produced a real answer.
  //
  // Raw-dump guard (Fix 4 — audit bcb417e4): the backstop evidence is often a raw
  // tool-result dump (raw web search block, recovered page chrome, or a delegate
  // preview whose tool-result content was selected instead of a curated summary).
  // When the synthesis call ran but produced nothing, the old code shipped that
  // dump verbatim to the user as the "answer". The same trap exists for the
  // suppressed-text path below. Disable the backstop when its candidate looks
  // like a raw dump; the later `looksLikeRawToolEvidenceDump` guard will then
  // reformat the (now raw) final candidate into the honest research-gathered
  // fallback, and the "raw_tool_evidence_dump_suppressed" audit event fires.
  const evidenceLooksRaw = terminalEvidenceBackstop
    ? (looksLikeRawSharedFactsDump(terminalEvidenceBackstop.evidence)
        || looksLikeRawToolEvidenceDump(terminalEvidenceBackstop.evidence)
        || looksLikeRawWorkspaceToolDump(terminalEvidenceBackstop.evidence))
    : false;
  const suppressedTextLooksRaw = lastSuppressedAssistantText !== null
    && lastSuppressedAssistantText.length >= 200
    && looksLikeRawToolEvidenceDump(lastSuppressedAssistantText);
  if (evidenceLooksRaw) {
    logAudit("guardrail_flagged", {
      type: "raw_evidence_backstop_disabled",
      finishReason: terminalFinishReason,
      evidenceLength: terminalEvidenceBackstop?.evidence.length ?? 0,
      evidenceItems: terminalEvidenceBackstop?.itemCount ?? 0,
    }, { sessionId: session.id, severity: "warn" });
  }
  if (suppressedTextLooksRaw) {
    logAudit("guardrail_flagged", {
      type: "raw_suppressed_text_backstop_disabled",
      finishReason: terminalFinishReason,
      suppressedTextLength: lastSuppressedAssistantText?.length ?? 0,
    }, { sessionId: session.id, severity: "warn" });
  }
  const useEvidenceOverSynthesis = !bypassTerminalSynthesis
    && terminalEvidenceBackstop
    && !evidenceLooksRaw
    && looksLikeUnderpoweredSynthesis(synthesized);
  // Last-resort: the runtime suppresses the model's text when it's
  // emitted alongside tool calls (correct in the common case — that text
  // is usually narration like "I'll call X next").  But after several
  // iterations of suppression the most recent suppressed content is
  // typically the closest thing to a real answer the model produced.
  // When BOTH the synthesis call AND the evidence backstop are unavailable
  // (or when synthesis is underpowered AND no delegate evidence exists),
  // surface that suppressed text as the response.
  const useSuppressedTextOverSynthesis = !bypassTerminalSynthesis
    && !useEvidenceOverSynthesis
    && lastSuppressedAssistantText !== null
    && !suppressedTextLooksRaw
    && lastSuppressedAssistantText.length >= 200
    && looksLikeUnderpoweredSynthesis(synthesized);
  if (useEvidenceOverSynthesis && terminalEvidenceBackstop) {
    logAudit("sub_agent_synthesis_forced", {
      reason: "underpowered_synthesis_replaced_with_evidence",
      finishReason: terminalFinishReason,
      synthesizedLength: synthesized?.length ?? 0,
      evidenceLength: terminalEvidenceBackstop.evidence.length,
      evidenceItems: terminalEvidenceBackstop.itemCount,
    }, { sessionId: session.id, severity: "warn" });
  } else if (useSuppressedTextOverSynthesis && lastSuppressedAssistantText !== null) {
    logAudit("sub_agent_synthesis_forced", {
      reason: "underpowered_synthesis_replaced_with_suppressed_text",
      finishReason: terminalFinishReason,
      synthesizedLength: synthesized?.length ?? 0,
      suppressedTextLength: lastSuppressedAssistantText.length,
    }, { sessionId: session.id, severity: "warn" });
  }
  const evidenceForUserDisplay = terminalEvidenceBackstop
    && looksLikeRawSharedFactsDump(terminalEvidenceBackstop.evidence)
    ? buildRecoveryEvidenceUserMessage(terminalEvidenceBackstop.evidence)
    : terminalEvidenceBackstop?.evidence;
  const finalCandidate = useEvidenceOverSynthesis && evidenceForUserDisplay
    ? evidenceForUserDisplay
    : useSuppressedTextOverSynthesis && lastSuppressedAssistantText !== null
      ? lastSuppressedAssistantText
      : (synthesized ?? fallbackMsg);
  const normalizedFinalMsg = sanitizeUserFacingAssistantResponse(finalCandidate, iterationCount) || fallbackMsg;
  const evidenceBackstopMsg = looksLikeGenericNoUsableReply(normalizedFinalMsg)
    ? (evidenceForUserDisplay ?? resolveEmptyAssistantResponseFallback("", "", session))
    : normalizedFinalMsg;
  // Auto-build-after-research (orchestration.autoBuildAfterResearch): on a slow backend,
  // research alone can consume the whole turn and the forced terminal synthesis then
  // ships the gathered evidence without ever reaching the artifact-build step. When the
  // user's ORIGINAL request asked to create a concrete artifact, the turn is
  // source-sensitive, research produced curated findings, and NO artifact was produced
  // this turn, auto-run ONE content_writer build from the gathered facts before shipping
  // (audit 33df2aec: a "create a verified reveal.js deck" turn spent ~7 min researching,
  // then shipped a raw search dump and never built the deck). Mirrors autoResearchOnRefusal;
  // degrades to the honest research-gathered fallback if the build produces nothing.
  let autoBuildFinalMsg: string | null = null;
  const curatedForBuild = terminalSharedFactsEvidence
    && !looksLikeRawToolEvidenceDump(terminalSharedFactsEvidence.evidence)
    ? terminalSharedFactsEvidence.evidence
    : null;
  // Completion QA gate (terminal path): the user asked to CREATE an artifact and NONE was
  // produced this turn → run ONE corrective build before shipping (via the shared
  // runCorrectiveBuild helper, which picks web_coder / backend_coder / content_writer by
  // deliverable type). A source-sensitive turn must have gathered ≥3 curated facts first
  // (never build from nothing and risk fabrication); a non-source-sensitive build request
  // can build directly. Degrades to the honest research-gathered fallback below if the build
  // still produces nothing.
  {
    const turnWantsArtifact = deliverableIntent.wantsArtifact || deliverableIntent.wantsComposedGuide;
    const isAppBuild = deliverableIntent.isAppBuild;
    // Best facts to build from: curated shared facts if present, else the assembled research
    // answer this turn produced (the delegated researcher's result, full of sourced facts).
    // This matters because an architect-fallback EPHEMERAL researcher's auto-shared findings
    // do NOT land in the parent's shared-facts store (audit 9b5196ad: bestAutoMatchScore 0.25
    // → ephemeral → terminalSharedFactsEvidence empty → the build gate was starved and the app
    // never got built), yet the facts ARE in the assembled answer. Build from that.
    const buildContext = curatedForBuild
      ?? (evidenceBackstopMsg && !looksLikeRawToolEvidenceDump(evidenceBackstopMsg) ? evidenceBackstopMsg : "");
    const hasResearchBackedFacts = !!curatedForBuild && (terminalSharedFactsEvidence?.itemCount ?? 0) >= 3;
    // An interactive/served APP MUST end as a real file. Build it whenever we have ANY non-dump
    // context to build from — do NOT require curated shared facts (gated by finalResponseQaGate).
    // A non-app source-sensitive deliverable (sourced doc/deck) keeps the conservative
    // gather-facts-first rule under autoBuildAfterResearch to avoid fabricating a sourced
    // document. Non-source-sensitive artifact requests build directly.
    const effOrch = effectiveOrchestration();
    const buildEnabled = initialDynamicGuidance?.sourceSensitive
      ? (isAppBuild
          ? (effOrch.finalResponseQaGate && buildContext.trim().length > 0)
          : (effOrch.autoBuildAfterResearch && hasResearchBackedFacts))
      : effOrch.finalResponseQaGate;
    if (
      buildEnabled
      && turnWantsArtifact
      && collectTurnArtifactAttachments(session).length === 0
      && !signal.aborted
    ) {
      autoBuildFinalMsg = await runCorrectiveBuild(buildContext);
    }
  }

  // Last-resort guard: a raw tool-result dump (web_fetch page chrome, search-result
  // blocks, recovered-evidence scaffolding) must never be the user-facing answer
  // (audit 003f5aeb: every Dresden run, when the artifact build failed, shipped the raw
  // Dresden_Castle Wikipedia nav menu verbatim). Replace it with the curated, sourced
  // findings under an honest could-not-finish preamble, or an honest status when nothing
  // clean was gathered. Structural detection only — topic- and site-agnostic.
  let presentableFinalMsg: string = autoBuildFinalMsg ?? evidenceBackstopMsg;
  if (!autoBuildFinalMsg && looksLikeRawToolEvidenceDump(presentableFinalMsg)) {
    const curated = terminalSharedFactsEvidence
      && !looksLikeRawToolEvidenceDump(terminalSharedFactsEvidence.evidence)
      ? terminalSharedFactsEvidence.evidence
      : null;
    logAudit("guardrail_flagged", {
      type: "raw_tool_evidence_dump_suppressed",
      finishReason: terminalFinishReason,
      dumpLength: presentableFinalMsg.length,
      curatedFacts: terminalSharedFactsEvidence?.itemCount ?? 0,
    }, { sessionId: session.id, channel: session.channel, severity: "warn" });
    presentableFinalMsg = buildResearchGatheredFallback(curated, deliverableIntent.wantsArtifact);
  }
  // Fabricated-inline-artifact guard: a turn that RESEARCHED (≥1 curated shared fact) but
  // produced NO real artifact (the build was stopped/blocked/never ran) sometimes has the
  // model hand-write the whole deliverable inline (a full <!DOCTYPE html> application
  // document) from training data and present it as the verified result (audit 453a263e: the
  // operator Stopped mid-research, the auto-build was correctly blocked, and synthesis pasted
  // a fabricated reveal.js deck repeating the Permoser→Neumann error + an invented source URL
  // — no workspace file, false "verified" claim). Replace it with the honest curated-facts
  // fallback: the verified findings + real sources, stating the file was not built this turn.
  // Trigger is PURELY STRUCTURAL — curated-facts count + zero attachments + no build ran + a
  // full inlined HTML document (looksLikeInlinedAppDocument, the never-legit-inline signal, so
  // no bilingual wantsArtifact keyword gate is needed to keep it precise). The de-lex hardwired
  // sourceSensitive off, killing this guard; revived here without that dead gate. Default OFF
  // (it replaces an answer) — pass^k-gated via inlineArtifactFabricationGuard.
  if (
    getConfig().orchestration?.inlineArtifactFabricationGuard === true
    && !autoBuildFinalMsg
    && (terminalSharedFactsEvidence?.itemCount ?? 0) >= 1
    && collectTurnArtifactAttachments(session).length === 0
    && looksLikeInlinedAppDocument(presentableFinalMsg)
  ) {
    const curatedForHonest = terminalSharedFactsEvidence
      && !looksLikeRawToolEvidenceDump(terminalSharedFactsEvidence.evidence)
      ? terminalSharedFactsEvidence.evidence
      : null;
    if (curatedForHonest) {
      logAudit("guardrail_flagged", {
        type: "inline_artifact_fabrication_suppressed",
        answerLength: presentableFinalMsg.length,
        curatedFacts: terminalSharedFactsEvidence?.itemCount ?? 0,
      }, { sessionId: session.id, channel: session.channel, severity: "warn" });
      presentableFinalMsg = buildResearchGatheredFallback(curatedForHonest);
    }
  }
  const finalMsg = await rewriteTerminalResponseIfNeeded(presentableFinalMsg, iterationCount, session, provider, signal);
  persistAssistantTurnState(session, finalMsg, getTurnSwarmState());
  if (opts.onChunk) opts.onChunk(finalMsg);

  const performance = buildTurnPerformanceMetrics({
    turnStartedAt,
    firstModelResponseMs,
    llmCalls,
    llmTimeMs,
    toolCallsRequested,
    toolExecutionTimeMs,
    lastPromptMetrics,
    completionChars: finalMsg.length,
    finishReason: terminalFinishReason,
    blocked: false,
    toolIterations: iterationCount,
  });
  logAudit("turn_performance", { ...performance, usage: totalUsage }, {
    sessionId: session.id,
    channel: session.channel,
    severity: "info",
  });
  logAudit("message_sent", { length: finalMsg.length, toolCalls: iterationCount, usage: totalUsage, performance }, {
    sessionId: session.id,
    channel: session.channel,
    severity: "info",
  });
  logAudit("turn_scorecard", {
    delegationCount: _turnDelegationCount,
    shareFindingCount: _turnShareFindingCount,
    forcedSynthesisFired: _forcedSynthesisFired,
    wardenFailureCount: _consecutiveDelegationFailures,
    finalAnswerLength: finalMsg.length,
    toolIterations: iterationCount,
    finishReason: terminalFinishReason,
  }, { sessionId: session.id, channel: session.channel, severity: "info" });
  return {
    response: finalMsg,
    toolCallsExecuted: iterationCount,
    guardrailEvents,
    usage: totalUsage,
    blocked: false,
    swarmState: getTurnSwarmState(),
    performance,
  };
}

/**
 * Inject a synthesis prompt and make one final LLM call with no tools.
 * Used when the turn hits max iterations or is cancelled mid-flight.
 * Returns null if the synthesis call itself fails or is aborted.
 */
/**
 * Compact system prompt for a TERMINAL synthesis call (forceSynthesis, no tools).
 * Such a call cannot route or delegate, so the full ~24.7K orchestrator prompt
 * (routing, swarm rules, tool discipline, agent/tool discovery, orchestration
 * strategy, memory mechanics) is pure prefill weight on a slow local model. This
 * keeps only what shaping the FINAL answer needs: identity/voice, language
 * mirroring, output format, and the grounding / full-coverage / no-truncation
 * rules that stop the synthesis from hallucinating or dropping sourced facts
 * (the spirit of the base prompt's Core Principles + full-coverage-synthesis
 * rules). S1 of staged orchestration (docs/staged-orchestration.md); gated by
 * orchestration.leanSynthesisPrompt (default off; pass^k before default-on).
 */
export function buildLeanSynthesisPrompt(opts: { assistantName?: string } = {}): string {
  return [
    "You are the main assistant inside StarlingAI. The orchestration for this turn is done — you are now writing the FINAL answer for the user from the evidence already gathered in this conversation (tool results and shared findings). You have no tools in this step: do not plan, route, delegate, or describe next actions; just deliver the answer.",
    opts.assistantName ? `Be direct, accurate, and concise. If asked your name, you are "${opts.assistantName}".` : "Be direct, accurate, and concise.",
    "Reply in the user's language. Format in Markdown — use headings, lists, tables, and fenced code blocks with language tags where they add clarity.",
    "GROUNDING: copy exact facts, names, numbers, values, statuses, and URLs from the tool-result evidence; never substitute values from your own knowledge. If a claim is not supported by the evidence in this conversation, omit it or mark it unverified.",
    "FULL COVERAGE: when the evidence is a list, table, or multi-source set, include EVERY item and EVERY source — do not keep only the first, drop the second half, or replace items with 'and others'.",
    "Never claim the evidence is 'truncated', 'cut off', 'abgeschnitten', or 'not visible' — the full results are in your context; relay every item, number, and URL, and do not append markers like '(truncated)'.",
  ].join("\n\n");
}

export async function forceSynthesis(
  session: AgentSession,
  provider: ChatProvider,
  signal: AbortSignal,
  instruction: string,
): Promise<string | null> {
  try {
    // Don't attempt synthesis if already aborted and we have nothing
    if (signal.aborted && session.getHistory().length < 3) return null;
    const sharedFindingsPrompt = await formatSharedFactsForFinalSynthesis(session.id);

    // S1 (staged orchestration): a forced-synthesis call runs with NO tools — it
    // cannot route or delegate — so the full ~24.7K orchestrator system prompt is
    // dead prefill weight. When orchestration.leanSynthesisPrompt is on, swap in a
    // compact synthesis-only prompt. Default off until pass^k-validated.
    let synthSystemPrompt = session.getSystemPrompt();
    if (getConfig().orchestration?.leanSynthesisPrompt) {
      let assistantName: string | undefined;
      try {
        const { loadMainAssistantPersonality } = await import("../personality/service.js");
        assistantName = loadMainAssistantPersonality().identity?.name || undefined;
      } catch { /* unnamed → omit */ }
      synthSystemPrompt = buildLeanSynthesisPrompt({ assistantName });
    }

    // Inject a synthesize-now user message (not stored in permanent history)
    const messages: LLMMessage[] = [
      { role: "system", content: synthSystemPrompt },
      { role: "system", content: buildTemporalContextPrompt() },
      ...(sharedFindingsPrompt ? [{ role: "system" as const, content: sharedFindingsPrompt }] : []),
      ...session.getCollapsedHistory(),
      { role: "user", content: `[SYSTEM INSTRUCTION — RESPOND NOW]: ${instruction} Before drafting, verify every assumption against the tool results and shared findings in this conversation. If a claim is not supported there, omit it or mark it unverified.` },
    ];

    // No hard timeout on the synthesis call — the provider (LMStudio / API)
    // is responsible for its own request deadline, and large local GPU models
    // may need several minutes for a full context. A fixed JS timer here
    // aborts a still-running synthesis and returns null, causing the user to
    // see a raw evidence dump instead of a real answer.
    const synthAbort = new AbortController();

    // E25: prefer the synthesis-tier provider when configured — smaller,
    // instruction-tuned models produce tighter final answers and avoid the
    // reasoning-model tendency to re-narrate tool calls during rewrite.
    const synthesisProvider = getChatProviderForTier("synthesis") ?? provider;

    try {
      const response = await synthesisProvider.complete(messages, [], synthAbort.signal);
      const text = response.content?.trim();
      return text || null;
    } finally {
      synthAbort.abort(); // release resources if call is still open
    }
  } catch {
    return null;
  }
}

/**
 * Final QA delivery gate (staged orchestration — docs/staged-orchestration.md).
 * After the existing correctness gates have refined `answer`, verify it against the
 * turn plan's acceptance criteria and loop ONE improvement pass per unmet round until
 * a QA check passes or the round budget is spent. The bounded fail-open loop lives in
 * qa-delivery-loop.ts; this supplies model-backed check (a verdict-only call on the
 * synthesis tier) and improve (the established forceSynthesis repair). Any error or
 * empty improvement ships the best answer so far — the gate never blocks delivery.
 */
async function runQaDeliveryGate(
  session: AgentSession,
  provider: ChatProvider,
  signal: AbortSignal,
  answer: string,
  criteria: string[],
  maxRounds: number,
  escalate?: (current: string, flaws: string, crit: string[]) => Promise<string | null>,
  requireEvidence = false,
): Promise<{ answer: string; changed: boolean; rounds: number; passed: boolean; escalated: boolean; unverified: boolean }> {
  const verdictProvider = getChatProviderForTier("synthesis") ?? provider;

  // Tool-equipped clean-context judge (orchestration.qaToolJudge): when this turn produced
  // inspectable artifacts, the verdict comes from a FRESH-context sub-agent that must OPEN
  // them (read_file/verify_app/url_inspect) instead of rating the answer's prose. Bounded
  // (one run, capped iterations/timeout), read-only tools, and fail-open: any error falls
  // back to the prose check below. Uses the same evidence-bearing verdict contract, so a
  // judge that never inspected anything yields a bare PASS → the requireEvidence gate
  // downgrades it to unverified like any other rubber stamp.
  const qaToolJudgeOn = effectiveOrchestration().qaToolJudge;
  // Enabling qaToolJudge forces evidence discipline on its OWN: an uninspected bare PASS from the
  // judge must still be downgraded to unverified, which previously only happened if the separate
  // qaEvidenceRequired flag was also on — contradicting the judge's contract. OR them here.
  const effectiveRequireEvidence = requireEvidence || qaToolJudgeOn;
  const toolJudgeCheck = async (current: string, crit: string[], refs: QaJudgeArtifactRef[]): Promise<QaVerdict> =>
    runQaToolJudgeCheck(current, crit, refs, async (task, allowedTools) =>
      runSubAgent({
        agentName: "qa_tool_judge",
        task,
        parentSessionId: session.id,
        workspacePath: session.getWorkspacePath(),
        userId: session.userId,
        signal,
        maxIterationsOverride: 5,
        turnTimeoutOverrideMs: 120_000,
        inlineConfig: {
          description: "Independent QA verifier with read-only inspection tools (fresh context)",
          capabilities: [],
          tags: [],
          systemPrompt: "You are a rigorous, independent QA verifier. Inspect every deliverable with your tools BEFORE judging; never trust the answer's own claims. Output ONLY the single-line verdict you were asked for.",
          tools: [...allowedTools],
          maxIterations: 5,
          container: { disabled: true, enabled: false, image: "starlingai/agent-worker:dev", memoryMb: 512, cpus: 0.5, timeoutMs: 60_000 },
        },
      }));

  const check = async (current: string, crit: string[]): Promise<QaVerdict> => {
    if (signal.aborted) return { pass: true }; // fail open on abort
    // Recompute the artifact refs EACH round from the live session, so a coordinator-escalation
    // round that rebuilt the deliverable to a new artifact path is inspected — not the superseded
    // originals frozen at gate entry.
    const toolJudgeRefs = qaToolJudgeOn
      ? collectJudgeableArtifactRefs(collectTurnArtifactAttachments(session))
      : [];
    if (toolJudgeRefs.length > 0) {
      try {
        return await toolJudgeCheck(current, crit, toolJudgeRefs);
      } catch (err) {
        log.debug({ err, sessionId: session.id }, "qa tool judge failed — falling back to prose verdict");
      }
    }
    // No-PASS-without-evidence (orchestration.qaEvidenceRequired / implied by qaToolJudge): ask the
    // reviewer to ground a PASS in a concrete verifiable fact. A PASS with no evidence is downgraded
    // to "unverified" (ships with a caveat) by the loop — killing rubber-stamp passes.
    const passLine = effectiveRequireEvidence
      ? "Reply on a SINGLE line. If every criterion is fully met and the answer is internally consistent, reply exactly: PASS — evidence: <one concrete verifiable fact from the answer's tool results / artifacts that proves the criteria are met>. A PASS with no such concrete evidence will NOT be trusted."
      : "Reply on a SINGLE line. If every criterion is fully met and the answer is internally consistent, reply exactly: PASS";
    const instruction = [
      "You are a strict QA reviewer. Judge ONLY whether the ANSWER below satisfies EVERY acceptance criterion for the user's task. Do not rewrite it.",
      "Acceptance criteria:",
      ...crit.map((c, i) => `${i + 1}. ${c}`),
      "",
      "ANSWER:",
      current,
      "",
      passLine,
      "Otherwise reply: FAIL: <one concise sentence naming each unmet criterion / concrete flaw>.",
    ].join("\n");
    const messages: LLMMessage[] = [
      { role: "system", content: "You are a concise QA reviewer. Output only a verdict (PASS or FAIL: …), never a rewritten answer." },
      { role: "user", content: instruction },
    ];
    const abort = new AbortController();
    try {
      const resp = await verdictProvider.complete(messages, [], abort.signal);
      return parseQaVerdict(resp.content ?? "");
    } finally {
      abort.abort();
    }
  };

  const improve = async (current: string, flaws: string): Promise<string | null> => {
    if (signal.aborted) return null;
    const instruction = "QA REVIEW found that your previous answer does not yet meet the task's acceptance criteria. "
      + "Fix ONLY these flaws while keeping everything that was already correct, in the SAME language as the user's request:\n"
      + flaws
      + "\nReturn the COMPLETE corrected answer (not a diff, not a note). Ground every claim in this conversation's tool results and shared findings; do not invent facts to satisfy a criterion — if something genuinely cannot be verified, mark it unverified rather than fabricating it.";
    const improved = await forceSynthesis(session, provider, signal, instruction);
    if (!improved) return null;
    const candidate = sanitizeUserFacingAssistantResponse(improved, 0);
    // Reject a catastrophic shrink (the improver collapsed the answer to a stub).
    if (candidate.trim().length < Math.min(200, Math.floor(current.trim().length * 0.5))) return null;
    return candidate;
  };

  const result = await runQaDeliveryLoop(answer, criteria, { check, improve, maxRounds, requireEvidence: effectiveRequireEvidence, ...(escalate ? { escalate } : {}) });
  return {
    answer: result.answer,
    changed: result.answer.trim() !== answer.trim(),
    rounds: result.rounds,
    passed: result.passed,
    escalated: result.escalated,
    unverified: result.unverified,
  };
}

/**
 * Deliverable self-consistency gate — the plan-less complement to runQaDeliveryGate. Reuses
 * the same bounded check→improve loop, but the CHECK audits the answer for internal
 * contradictions (its own figures/arithmetic) + contradictions of what the user explicitly
 * stated, and the REPAIR fixes only those. See deliverable-consistency.ts (audit 17f53ed0).
 * Fails open throughout.
 */
async function runDeliverableConsistencyGate(
  session: AgentSession,
  provider: ChatProvider,
  signal: AbortSignal,
  answer: string,
  userStatements: string,
  maxRounds: number,
): Promise<{ answer: string; changed: boolean; rounds: number; passed: boolean }> {
  const verdictProvider = getChatProviderForTier("synthesis") ?? provider;

  const check = async (current: string): Promise<QaVerdict> => {
    if (signal.aborted) return { pass: true }; // fail open on abort
    const messages = buildDeliverableConsistencyCheckMessages(current, userStatements);
    const abort = new AbortController();
    try {
      const resp = await verdictProvider.complete(messages, [], abort.signal);
      return parseQaVerdict(resp.content ?? "");
    } finally {
      abort.abort();
    }
  };

  const improve = async (current: string, flaws: string): Promise<string | null> => {
    if (signal.aborted) return null;
    const improved = await forceSynthesis(session, provider, signal, buildDeliverableConsistencyRepairInstruction(flaws));
    if (!improved) return null;
    const candidate = sanitizeUserFacingAssistantResponse(improved, 0);
    // Reject a catastrophic shrink (the fixer collapsed the answer to a stub).
    if (candidate.trim().length < Math.min(200, Math.floor(current.trim().length * 0.5))) return null;
    return candidate;
  };

  const result = await runQaDeliveryLoop(answer, [DELIVERABLE_CONSISTENCY_CRITERION], {
    check: (a) => check(a),
    improve,
    maxRounds,
  });
  return {
    answer: result.answer,
    changed: result.answer.trim() !== answer.trim(),
    rounds: result.rounds,
    passed: result.passed,
  };
}

// blocked() — the early-exit TurnOutput builder — moved to ./turn-prepare.ts with
// the prepare-phases that also use it (god-file seam). Imported above; the main
// loop calls it exactly as before.

/**
 * Walk backward through session history and extract completed/partial swarm
 * tasks from the most recent assistant message that has persisted swarm state.
 *
 * These are seeded into the new turn's swarmState.tasks so that, on a retry,
 * sub-agents see prior research and skip re-running identical tasks instead of
 * doing all the work from scratch.
 *
 * Only `completed` and `partial` tasks are carried forward. `failed`, `running`,
 * `pending`, and `blocked` tasks are dropped so they can be re-attempted cleanly.
 */
function loadPreviousTurnSwarmTasks(history: readonly SessionHistoryMessage[]): SwarmState["tasks"] {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i]!;
    if (msg.role !== "assistant") continue;
    const raw = msg.metadata?.["swarmState"];
    if (!raw || typeof raw !== "object") continue;
    const prev = raw as SwarmState;
    if (!prev.tasks) continue;
    const carried: SwarmState["tasks"] = {};
    for (const [id, task] of Object.entries(prev.tasks)) {
      if (task.status === "completed" || task.status === "partial") {
        carried[id] = task;
      }
    }
    // Only return if there is something worth carrying forward
    if (Object.keys(carried).length > 0) return carried;
  }
  return {};
}

function buildPersistableSwarmTaskDelta(
  currentTasks: SwarmState["tasks"],
  carriedTasks: SwarmState["tasks"],
): SwarmState["tasks"] {
  const delta: SwarmState["tasks"] = {};

  for (const [taskId, task] of Object.entries(currentTasks)) {
    const carriedTask = carriedTasks[taskId];
    if (!carriedTask) {
      delta[taskId] = task;
      continue;
    }

    const carriedAttempts = carriedTask.attempts ?? [];
    const currentAttempts = task.attempts ?? [];
    const nextAttempts = currentAttempts.slice(carriedAttempts.length);
    const carriedOutput = typeof carriedTask.output === "string" ? carriedTask.output : "";
    const currentOutput = typeof task.output === "string" ? task.output : "";
    const carriedError = typeof carriedTask.error === "string" ? carriedTask.error : "";
    const currentError = typeof task.error === "string" ? task.error : "";
    const outputChanged = currentOutput !== carriedOutput;
    const errorChanged = currentError !== carriedError;
    const statusChanged = task.status !== carriedTask.status;

    if (nextAttempts.length === 0 && !outputChanged && !errorChanged && !statusChanged) {
      continue;
    }

    delta[taskId] = {
      ...task,
      attempts: nextAttempts,
      output: outputChanged ? task.output : undefined,
      error: errorChanged ? task.error : undefined,
    };
  }

  return delta;
}

function selectPersistableSwarmState(
  swarmState: SwarmState | undefined,
  carriedTasks: SwarmState["tasks"],
  carriedTaskFingerprint: string,
  usedSwarmTools: boolean,
): SwarmState | undefined {
  if (!swarmState) return undefined;
  const currentTasks = swarmState.tasks ?? {};
  if (Object.keys(currentTasks).length === 0) return undefined;
  const persistableTasks = buildPersistableSwarmTaskDelta(currentTasks, carriedTasks);
  if (Object.keys(persistableTasks).length === 0) {
    return undefined;
  }
  if (!usedSwarmTools && stableSerialize(currentTasks) === carriedTaskFingerprint) {
    return undefined;
  }
  return {
    ...swarmState,
    tasks: persistableTasks,
  };
}

function persistAssistantTurnState(session: AgentSession, content: string, swarmState?: SwarmState): void {
  // Pull all artifacts produced during the current turn (since the last user
  // message) onto the final assistant message. The frontend already extracts
  // artifacts from each tool call's metadata on the iteration messages, but
  // (a) those intermediate messages can be pruned by history trimming over
  // long sessions, and (b) the final synthesis message is the durable
  // "here's what I made for you" surface — having attachments live there
  // keeps the artifact list reachable as long as the message itself exists.
  const attachments = collectTurnArtifactAttachments(session);
  const metadata: Record<string, unknown> = {};
  if (swarmState) metadata["swarmState"] = structuredClone(swarmState);
  if (attachments.length > 0) metadata["attachments"] = attachments;

  if (Object.keys(metadata).length > 0) {
    session.addMessage({ role: "assistant", content, metadata });
    return;
  }
  session.addMessage({ role: "assistant", content });
}

/**
 * Walk the current turn's tool-role messages (since the last user message) and
 * extract every artifact reference into a normalized `SessionTranscriptAttachment`
 * list. Recurses into nested `artifacts[]` arrays (the shape used by
 * `delegate_to_agent` to bubble sub-agent artifacts back up). Dedupes by the
 * fields that the transcript builder also uses, so the final-message
 * attachments don't get duplicated when a single artifact bubbles through
 * multiple delegation hops.
 */
/**
 * Best-available delivery when the gateway turn watchdog fires (audit b6f8336e,
 * 0dc158ad turn 2): the hard turn timeout aborts the runtime mid-flight, so the
 * normal synthesis never runs and the gateway used to ship `status:error` with no
 * text — the user saw an empty bubble. This recovers something useful from the
 * session so the turn NEVER dead-ends into silence (the documented never-empty
 * invariant the watchdog path bypassed):
 *   - any assistant text already produced THIS turn → relay it with a stopped note;
 *   - else → an honest notice that the turn hit its time budget (most often a slow
 *     build/research step that needs more than the current effort tier allows),
 *     listing any partial artifact saved, plus the actionable retry hint.
 * Pure + synchronous so the watchdog can call it without awaiting anything.
 */
export function buildTimeoutDeliveryMessage(
  session: AgentSession,
  opts: { effortTier?: string; timeoutMs: number },
): { response: string; recoveredAssistantText: boolean } {
  const history = session.getHistory() as ReadonlyArray<{ role: string; content?: string | null }>;
  let lastUserIdx = -1;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]!.role === "user") { lastUserIdx = i; break; }
  }
  // Substantial assistant text produced AFTER this turn's opening user message.
  let turnAssistantText = "";
  for (let i = history.length - 1; i > lastUserIdx; i -= 1) {
    const m = history[i]!;
    if (m.role === "assistant" && typeof m.content === "string" && m.content.trim().length > 80) {
      turnAssistantText = m.content.trim();
      break;
    }
  }
  const artifacts = collectTurnArtifactAttachments(session);
  const seconds = Math.round(opts.timeoutMs / 1000);
  const budget = seconds >= 120 ? `${Math.round(seconds / 60)} min` : `${seconds}s`;
  const tierNote = opts.effortTier && opts.effortTier !== "medium" ? ` (effort: ${opts.effortTier})` : "";

  if (turnAssistantText) {
    return {
      response: `${turnAssistantText}\n\n> ⏱️ This turn was stopped at its ${budget} time budget${tierNote} before it could fully finish — the answer above is the best result gathered so far. Re-send with a higher effort tier or a longer \`--timeout\` for the complete version.`,
      recoveredAssistantText: true,
    };
  }

  const lines = [
    `⏱️ This turn hit its ${budget} time budget${tierNote} before producing a final answer — usually a build or research step that needs more time than this effort tier allows. Nothing was lost.`,
  ];
  if (artifacts.length > 0) {
    lines.push("", "A partial deliverable was saved this turn:");
    for (const a of artifacts) {
      lines.push(`- ${String(a["relativePath"] ?? a["filename"] ?? "artifact")}`);
    }
  }
  lines.push("", "To get the full result, re-send the request with a higher effort tier (e.g. medium or high) or a longer `--timeout`.");
  return { response: lines.join("\n"), recoveredAssistantText: false };
}

/**
 * A partial deliverable from THIS turn that the one bounded corrective build should
 * FINISH in place (read + append/edit) instead of regenerating — the user's "if files
 * are produced we can finish unfinished files … not regenerate the whole file" path.
 * `truncationProbe` returns a human reason when the file at the given workspace-relative
 * path genuinely looks cut off mid-document, else null (the runtime passes the fs-backed
 * artifactFileLooksTruncated; tests pass a stub). Keys off file-incompleteness, not the
 * deliverable's topic: a complete-but-wrong file probes null → caller does a fresh build.
 */
export interface CorrectiveResumeTarget {
  relativePath: string;
  filename: string;
  truncationReason: string;
}
export function selectCorrectiveResumeTarget(
  attachments: Array<Record<string, unknown>>,
  truncationProbe: (relativePath: string) => string | null,
): CorrectiveResumeTarget | null {
  for (const a of attachments) {
    if (a["isDirectory"] === true) continue;
    const relativePath = typeof a["relativePath"] === "string" ? a["relativePath"].trim() : "";
    if (!relativePath) continue; // external-URL-only artifacts have no local file to resume
    const reason = truncationProbe(relativePath);
    if (reason) {
      const filename = typeof a["filename"] === "string" && a["filename"] ? a["filename"].trim() : relativePath;
      return { relativePath, filename, truncationReason: reason };
    }
  }
  return null;
}

export function collectTurnArtifactAttachments(session: AgentSession): Array<Record<string, unknown>> {
  const history = session.getHistory();
  const attachments: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();

  type RawMessage = { role: string; metadata?: Record<string, unknown> };
  // Walk backwards from the end until we hit the user message that opened
  // this turn. We only want artifacts from THIS turn — not from previously
  // persisted assistant turns.
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i] as unknown as RawMessage;
    if (msg.role === "user") break;
    if (msg.role !== "tool") continue;
    if (!msg.metadata || typeof msg.metadata !== "object") continue;
    extractArtifactsFromMetadata(msg.metadata, attachments, seen);
  }
  return attachments;
}

function extractArtifactsFromMetadata(
  metadata: Record<string, unknown>,
  out: Array<Record<string, unknown>>,
  seen: Set<string>,
): void {
  const filename = typeof metadata["filename"] === "string" ? metadata["filename"].trim() : "";
  const outputPath = typeof metadata["outputPath"] === "string" ? metadata["outputPath"].trim() : "";
  const externalUrl = typeof metadata["externalUrl"] === "string" ? metadata["externalUrl"].trim() : "";

  if (filename || outputPath || externalUrl) {
    const key = [outputPath, externalUrl, filename, typeof metadata["sourceTool"] === "string" ? metadata["sourceTool"] : ""].join("::");
    if (!seen.has(key)) {
      seen.add(key);
      // A `filename` is required by the transcript builder. Derive one when
      // only a path is available. `pop()` can yield an empty string for a
      // trailing-slash path (e.g. "subdir/") — fall back to the raw path
      // so the transcript builder never sees an empty filename.
      const derivedFilename = filename
        || (outputPath ? (outputPath.split("/").pop() || outputPath) : "")
        || externalUrl;
      const entry: Record<string, unknown> = { filename: derivedFilename };
      if (outputPath) entry["relativePath"] = outputPath;
      if (externalUrl) entry["externalUrl"] = externalUrl;
      if (typeof metadata["contentType"] === "string") entry["contentType"] = metadata["contentType"];
      if (typeof metadata["previewMode"] === "string") entry["previewMode"] = metadata["previewMode"];
      if (typeof metadata["size"] === "number") entry["size"] = metadata["size"];
      else if (typeof metadata["bytes"] === "number") entry["size"] = metadata["bytes"];
      if (metadata["isDirectory"] === true) entry["isDirectory"] = true;
      if (typeof metadata["title"] === "string" && metadata["title"]) entry["title"] = metadata["title"];
      if (typeof metadata["sourceTool"] === "string" && metadata["sourceTool"]) entry["sourceTool"] = metadata["sourceTool"];
      out.push(entry);
    }
  }

  const nested = metadata["artifacts"];
  if (Array.isArray(nested)) {
    for (const item of nested) {
      if (item && typeof item === "object") {
        extractArtifactsFromMetadata(item as Record<string, unknown>, out, seen);
      }
    }
  }
}

function appendNonDuplicatedContinuation(existing: string, continuation: string): string {
  if (!continuation) return existing;
  if (!existing) return continuation;
  if (existing.endsWith(continuation)) return existing;

  const maxOverlap = Math.min(existing.length, continuation.length, MAX_CONTINUATION_OVERLAP_CHARS);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (existing.slice(-size) === continuation.slice(0, size)) {
      return `${existing}${continuation.slice(size)}`;
    }
  }

  return `${existing}${continuation}`;
}

/**
 * Recognise the "model is dumping a giant artifact inline as a chat code
 * block" failure mode. Observed live: orchestrator falls back to writing the
 * full HTML in chat when a delegated content_writer fails to call write_file,
 * the response hits the token cap mid-document, and the length-continuation
 * loop stitches it back together — eventually a 50 KB cut-off chat reply
 * with no artifact persisted anywhere.
 *
 * Heuristic: a single ```html / ```javascript / ```css / ```vue fence with
 * a body larger than INLINE_ARTIFACT_FENCE_BYTES, OR the unclosed-fence
 * shape that happens when the cap fires mid-block. Plain prose, even very
 * long, isn't flagged; tutorial answers with multiple small snippets aren't
 * flagged.
 */
const INLINE_ARTIFACT_FENCE_BYTES = 5000;
const INLINE_ARTIFACT_LANGS = ["html", "javascript", "js", "ts", "tsx", "jsx", "css", "vue", "svelte", "xml"];

export function looksLikeRunawayInlineArtifact(content: string): boolean {
  if (content.length < INLINE_ARTIFACT_FENCE_BYTES) return false;
  const fenceRe = /```([a-zA-Z0-9_+\-]*)\n([\s\S]*?)(?:```|$)/g;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(content)) !== null) {
    const lang = (match[1] ?? "").toLowerCase();
    const body = match[2] ?? "";
    if (!INLINE_ARTIFACT_LANGS.includes(lang)) continue;
    if (body.length >= INLINE_ARTIFACT_FENCE_BYTES) return true;
    // Cap fired mid-fence → the regex's `|$` branch matched; the body
    // length reflects everything from the opener to EOF, so the size
    // check above already covers it. No extra logic needed.
  }
  return false;
}

async function continueLengthLimitedResponse(
  provider: ChatProvider,
  baseMessages: readonly LLMMessage[],
  initialResponse: LLMResponse,
  signal: AbortSignal,
  onChunk?: (text: string) => void,
): Promise<{ response: LLMResponse; additionalCalls: number; additionalTimeMs: number; runawayInlineArtifact: boolean }> {
  let response: LLMResponse = { ...initialResponse, tool_calls: [...initialResponse.tool_calls] };
  let additionalCalls = 0;
  let additionalTimeMs = 0;
  let runawayInlineArtifact = false;

  for (let attempt = 0; attempt < MAX_LENGTH_CONTINUATION_ATTEMPTS; attempt += 1) {
    if (response.finishReason !== "length" || response.tool_calls.length > 0 || signal.aborted) {
      break;
    }

    const partialContent = response.content ?? "";
    if (!partialContent.trim()) {
      break;
    }

    // If the partial already looks like a runaway inline-artifact dump,
    // stop stitching. Continuing would just append more lines of the same
    // truncated HTML; the user is better served by a visible failure than
    // a 50 KB cut-off chat reply that pretends to be a working app.
    if (looksLikeRunawayInlineArtifact(partialContent)) {
      runawayInlineArtifact = true;
      break;
    }

    const continuationMessages: LLMMessage[] = [
      ...baseMessages,
      { role: "assistant", content: partialContent },
      {
        role: "user",
        content: [
          "Continue your previous response exactly where it stopped.",
          "Return only the next continuation chunk.",
          "Do not restart the answer, do not repeat earlier lines, do not add a new introduction, and do not call tools.",
        ].join(" "),
      },
    ];

    const continuationStartedAt = Date.now();
    const continuationResponse = await collectStream(provider.stream(continuationMessages, [], signal), onChunk);
    additionalCalls += 1;
    additionalTimeMs += Date.now() - continuationStartedAt;

    response = {
      content: appendNonDuplicatedContinuation(partialContent, continuationResponse.content ?? ""),
      tool_calls: continuationResponse.tool_calls,
      usage: {
        promptTokens: response.usage.promptTokens + continuationResponse.usage.promptTokens,
        completionTokens: response.usage.completionTokens + continuationResponse.usage.completionTokens,
        totalTokens: response.usage.totalTokens + continuationResponse.usage.totalTokens,
      },
      finishReason: continuationResponse.finishReason,
    };
  }

  return { response, additionalCalls, additionalTimeMs, runawayInlineArtifact };
}

/**
 * Consume a streaming LLM generator into a complete LLMResponse.
 * Optionally defers text until the response is known not to contain tool calls.
 */
async function collectStream(
  generator: AsyncGenerator<StreamChunk>,
  onChunk?: (text: string) => void,
  options: { deferTextUntilToolDecision?: boolean; onReasoning?: (text: string) => void } = {},
): Promise<LLMResponse> {
  let content = "";
  let reasoning = "";
  const toolCallBuffers = new Map<string, { id: string; name: string; args: string }>();
  let finishReason = "stop";
  let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let sawToolCall = false;

  for await (const chunk of generator) {
    if (chunk.type === "reasoning_delta" && chunk.content) {
      reasoning += chunk.content;
      // Reasoning always streams live — it precedes the answer and the UI
      // collapses it once the first answer token arrives.
      options.onReasoning?.(chunk.content);
    } else if (chunk.type === "text_delta" && chunk.content) {
      content += chunk.content;
      if (!options.deferTextUntilToolDecision) {
        onChunk?.(chunk.content);
      }
    } else if (chunk.type === "tool_call_start" && chunk.toolCallId && chunk.toolName) {
      sawToolCall = true;
      toolCallBuffers.set(chunk.toolCallId, { id: chunk.toolCallId, name: chunk.toolName, args: "" });
    } else if (chunk.type === "tool_call_delta" && chunk.toolCallId && chunk.argumentsDelta) {
      const buf = toolCallBuffers.get(chunk.toolCallId);
      if (buf) buf.args += chunk.argumentsDelta;
    } else if (chunk.type === "done") {
      if (chunk.finishReason) finishReason = chunk.finishReason;
      if (chunk.usage) usage = chunk.usage;
    }
  }

  const tool_calls = [...toolCallBuffers.values()].map(buf => ({
    id: buf.id,
    name: buf.name,
    // Mirror the lmstudio streaming parser: an empty argument body is a
    // no-argument call (→ {}), not a parse error; salvage malformed-but-
    // recoverable JSON before falling back to the _parse_error sentinel.
    arguments: (() => {
      if (!buf.args.trim()) return {} as Record<string, unknown>;
      const salvaged = salvageToolCallArguments(buf.args);
      if (salvaged) return salvaged;
      return { _parse_error: true, _raw: buf.args } as Record<string, unknown>;
    })(),
  }));

  if (options.deferTextUntilToolDecision && onChunk && !sawToolCall && content) {
    onChunk(content);
  }

  return { content: content || null, ...(reasoning ? { reasoning } : {}), tool_calls, usage, finishReason };
}
