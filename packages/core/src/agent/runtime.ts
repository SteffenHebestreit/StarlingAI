/**
 * Agent Runtime — the main agent loop.
 * LLM call → parse tool calls → execute (with guardrails) → loop → final response
 */
import { getChatProvider, getChatProviderForTier, getChatProviderWithOverride } from "../providers/index.js";
import { salvageToolCallArguments } from "../providers/lmstudio.js";
import type { ChatProvider, LLMMessage, LLMResponse, StreamChunk } from "../providers/lmstudio.js";
import { tryReceptionistFastLane, buildMemoryCapsule } from "./receptionist.js";
import { markOrchestratorActivity, markOrchestratorIdle } from "./cache-warmer.js";
import { getToolsAsLLMDefs, executeTool, normalizeToolCall, type SwarmState, type ToolContext } from "../tools/registry.js";
import { isToolAllowed, requiresApproval } from "../guardrails/tool-tiers.js";
import { loadTurnPlan, classifyTurnRisk } from "./turn-plan.js";
import { runQaDeliveryLoop, parseQaVerdict, type QaVerdict } from "./qa-delivery-loop.js";
import {
  shouldCheckDeliverableConsistency,
  collectUserStatements,
  buildDeliverableConsistencyCheckMessages,
  buildDeliverableConsistencyRepairInstruction,
  DELIVERABLE_CONSISTENCY_CRITERION,
} from "./deliverable-consistency.js";
import { prefetchCapabilityCandidates } from "./discovery-prefetch.js";
import { buildUserProfileEvidence, buildProfileBiasedQuery } from "./user-profile-prefetch.js";
import { checkInput, checkToolOutput } from "../guardrails/input.js";
import { moderateInputText, moderateToolResultText } from "../guardrails/moderation.js";
import { scanOutput } from "../guardrails/output.js";
import { checkRateLimit } from "../guardrails/rate-limiter.js";
import { logAudit } from "../audit/logger.js";
import { getConfig } from "../config/loader.js";
import {
  runWithEffortContext,
  resolveEffortProfile,
  currentEffortProfile,
  effectiveOrchestration,
  effectiveMaxDelegatedResultChars,
  effectiveOrchestratorMaxToolIterations,
  effectiveOrchestratorTurnSloMs,
  currentEffortTier,
} from "../runtime/effort-context.js";
import {
  classifyTurnProgress,
  buildTurnOversightPrompt,
  parseTurnOversightVerdict,
  TURN_OVERSIGHT_CHECK_INTERVAL_MS,
  type TurnProgressSample,
} from "./turn-oversight.js";
import type { EffortTier } from "../config/schema.js";
import { childLogger } from "../logger.js";
import type { AgentSession, SessionHistoryMessage, SessionTranscriptAttachment } from "./session.js";
import { splitOrchestrationModule } from "./session.js";
import { classifyToolIntervention, type InterventionNotice } from "./interventions.js";
import { getMainAssistantToolNames, type MainAssistantToolMode } from "./default-tools.js";
import { longRunningGenerationManager } from "./long-running-generation.js";
import { turnSteeringManager } from "./turn-steering.js";
import { registerSessionAbortController, deregisterSessionAbortController } from "./warden.js";
import { formatFlowMemoryGuidance } from "./flow-memory.js";
import { looksLikeProviderErrorEcho, looksLikeHallucinatedTruncationClaim } from "./container-failure.js";
import { sanitizeAssistantContent, NARRATED_TOOL_TEXT_RE } from "./sanitize-response.js";
import { formatScopedMemoryGuidance } from "../memory/service.js";
import { retrieveSkillGuidance } from "../skills/service.js";
import { recordSkillOutcomeAsync, recordSkillHoldoutOutcomeAsync } from "../skills/store.js";
import { maybeDistillSkillFromTurn } from "../skills/distiller.js";
import { formatUserModelGuidance } from "../user-model/service.js";
import { lookupTrajectory, writeTrajectory, invalidateTrajectory } from "../memory/trajectory-cache.js";
import { graphMarkSessionRetrievalsUseful, graphMarkSessionRetrievalsUnhelpful } from "../memory/graph-service.js";
import type { SubAgentProgressEvent } from "./sub-agent.js";
import { artifactFileLooksTruncated } from "./sub-agent.js";
import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { beginFactTurn } from "../swarm/memory.js";
import {
  buildDynamicTurnGuidance,
  extractAssistantName,
  type DynamicTurnGuidance,
  buildLanguageAndIdentityTurnGuidance,
  WORKFLOW_HINT_TERMS,
  WORKFLOW_REQUEST_PATTERNS,
  toSoftRoutingHint,
  looksMultiDomainResearch,
} from "./intent-classifier.js";
import { buildSourceSensitiveOriginalRequestTask, deriveSourceSensitiveDelegationFocus, buildEffectiveResearchSubject, buildSourceSensitiveCoordinatorTask } from "./source-sensitive-delegation.js";
import { looksEvidenceAnchored } from "./evidence-anchoring.js";
import { looksLikeDegenerateRepetition, collapseRepeatedMarkdownSections, looksLikeDegenerateLineRepetition, collapseRepeatedLines } from "./text-dedup.js";
import {
  classifyDeliverableIntent,
  claimsArtifactWrittenButUnproduced,
  looksLikeFabricatedToolDeliveryLink,
  looksLikeInlinedArtifactFabrication,
  looksLikeInlinedAppDocument,
  extractInlineHtmlDocument,
  looksLikeCompleteHtmlDocument,
  stripLargeCodeFences,
  looksLikeArtifactCreationRequest,
  looksLikeComposedGuideRequest,
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
  BUILDER_AGENT_ROLE_RE,
  looksLikeRegurgitatedPriorAnswer,
  DELEGATE_TOOL_RESULT_RE,
  looksLikeDelegateMetadata,
  countStructuredItems,
  stripToolEvidencePrefix,
  looksLikeOrchestrationOnlyEvidence,
  collapseWhitespace,
  stripPresentationFormatting,
  looksLikeDelegationTaskEcho,
} from "./runtime-utils.js";

// Re-export the runtime-utils helpers that external consumers (tests) import from
// runtime.js, so those imports keep working unchanged after the extraction.
export { looksLikeRegurgitatedPriorAnswer } from "./runtime-utils.js";

// Pure raw-evidence/shared-facts dump detectors + formatters (god-file seam).
import {
  isJunkEvidenceValue,
  looksLikeRawSharedFactsDump,
  looksLikeRawWorkspaceToolDump,
  formatRawWorkspaceToolDumpFailure,
  looksLikeRawToolEvidenceDump,
  stripLeadingDelegateLabelEcho,
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
  looksLikeTransparentIncompleteReport,
  isBroadSourceSensitiveAdvisoryRequest,
  buildSynthesisRequiredDirective,
  prependUnverifiedSourceCaveat,
  answerPresentsSourceCitations,
  stripFabricatedCitations,
} from "./citation-honesty.js";

// Re-export the originally-exported honesty helpers so existing imports from
// runtime.js (tests, tools) keep working after the extraction.
export {
  buildSynthesisRequiredDirective,
  prependUnverifiedSourceCaveat,
  answerPresentsSourceCitations,
  stripFabricatedCitations,
} from "./citation-honesty.js";

// Pure response/tool-call collapsing + delegation arg helpers (god-file seam).
import {
  stripUntrustedDelegationContext,
  deriveDelegationTaskFromArgs,
} from "./delegation-response-collapse.js";

// Re-export the originally-exported delegation-arg helper so existing imports
// from runtime.js (tests, tools) keep working after the extraction.
export { deriveDelegationTaskFromArgs } from "./delegation-response-collapse.js";

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

const log = childLogger("agent:runtime");

// Turn-scoped accumulator for per-stage wall-clock (A1). A turn runs inside one
// runTurn() invocation, but the gateway runs turns concurrently — so this MUST be
// AsyncLocalStorage (a module-level singleton would cross-contaminate turns), not a
// shared mutable. timedPhase() records the elapsed ms of a stage into the active
// turn's store; buildTurnPerformanceMetrics() reads it and computes untrackedMs.
const _phaseTimingsStore = new AsyncLocalStorage<Record<string, number>>();
async function timedPhase<T>(phase: string, fn: () => Promise<T>): Promise<T> {
  const store = _phaseTimingsStore.getStore();
  if (!store) return fn();
  const start = Date.now();
  try {
    return await fn();
  } finally {
    store[phase] = (store[phase] ?? 0) + (Date.now() - start);
  }
}

const DEFAULT_MAX_TOOL_ITERATIONS = 20;
const MAX_LENGTH_CONTINUATION_ATTEMPTS = 2;
const MAX_CONTINUATION_OVERLAP_CHARS = 400;
const PER_TURN_TOOL_CALL_LIMITS: Partial<Record<string, number>> = {
  delegate_to_agent: 5,
  search_agents: 4,
  search_workflows: 2,
  run_workflow: 2,
  create_ephemeral_agent: 1,
  computer_session_start: 1,
  computer_focus_window: 2,
  computer_snapshot: 3,
  computer_list_windows: 2,
  computer_click: 8,
  computer_type: 6,
  computer_hotkey: 6,
  computer_scroll: 4,
  computer_move_mouse: 4,
  computer_wait: 3,
  vscode_focus_panel: 2,
  vscode_run_terminal_command: 3,
};
export interface RunTurnOptions {
  session: AgentSession;
  userMessage: string;
  userDisplayContent?: string;
  userAttachments?: SessionTranscriptAttachment[];
  onChunk?: (text: string) => void;
  /** Live chain-of-thought tokens for the main assistant turn. Streams ahead
   * of the answer; the UI shows it in a collapsible panel that auto-collapses
   * once the first answer token arrives. */
  onReasoning?: (text: string) => void;
  onStatus?: (status: { phase: string; message: string; iteration?: number }) => void;
  onToolCall?: (toolCallId: string, name: string, args: Record<string, unknown>) => void;
  onToolResult?: (toolCallId: string, name: string, result: string, metadata?: Record<string, unknown>) => void;
  onSubAgentProgress?: (event: SubAgentProgressEvent) => void;
  onComputerAction?: (action: { computerSessionId: string; actionType: string; [key: string]: unknown }) => void;
  onComputerScreenshot?: (screenshot: { computerSessionId: string; dataUrl: string; width: number; height: number; [key: string]: unknown }) => void;
  onComputerSessionState?: (sessionState: { computerSessionId: string; state: string; [key: string]: unknown }) => void;
  onIntervention?: (notice: InterventionNotice) => void;
  onSwarmState?: (state: SwarmState) => void;
  approvalCallback?: (toolName: string, args: Record<string, unknown>) => Promise<boolean>;
  inputCallback?: (question: string, choices?: string[], timeoutMs?: number) => Promise<string>;
  signal?: AbortSignal;
  /** Sub-agents this turn is allowed to delegate to (undefined = no restriction) */
  allowedAgents?: string[];
  /** Tool names that must pause for human approval this turn (enforced unconditionally) */
  humanInLoopSteps?: string[];
  /** Auto-approve all tool calls this turn — skips the approvalCallback gate entirely. */
  autoApprove?: boolean;
  /** Override sub-agent maxIterations for delegated tasks this turn. 0 disables the cap. */
  maxIterationsOverride?: number;
  /** When set, this turn is a tool-dev session — iteration limits are lifted. */
  _toolDevSessionId?: string;
  /** Active reusable workflow execution stack for nested workflow/self-reentry guards. Internal. */
  _workflowExecutionStack?: string[];
  /** Override the per-turn timeout in ms (replaces config gateway.turnTimeoutMs). 0 disables the timeout. */
  turnTimeoutOverrideMs?: number;
  /** Per-message Qwen3.5 thinking toggle. true = on, false = off, undefined = model default. */
  enableThinking?: boolean;
  /** Effort tier for this turn (low | medium | high | max). Selects an effort profile
   *  that overlays the orchestration/latency/reasoning knobs. Undefined → config default. */
  effortTier?: EffortTier;
}

export interface TurnOutput {
  response: string;
  toolCallsExecuted: number;
  guardrailEvents: Array<{ type: string; details: string }>;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  blocked: boolean;
  swarmState?: SwarmState;
  performance?: TurnPerformanceMetrics;
}

export interface TurnPerformanceMetrics {
  turnDurationMs: number;
  firstModelResponseMs?: number;
  llmCalls: number;
  llmTimeMs: number;
  toolCallsRequested: number;
  toolExecutionTimeMs: number;
  systemPromptChars: number;
  collapsedHistoryMessages: number;
  collapsedHistoryChars: number;
  promptChars: number;
  completionChars: number;
  toolIterations: number;
  finishReason: string;
  blocked: boolean;
  /** Effective orchestrator turn-SLO budget for this turn (ms), reflecting the
   *  active effort profile. The Warden reads it off the turn_performance event so a
   *  high/max-effort turn doesn't trip a spurious SLO-breach alert — without the
   *  Warden having to import the session store (avoids a module cycle). */
  effortSloBudgetMs?: number;
  /** Per-stage wall-clock (ms) for work that runs OUTSIDE llmTimeMs/toolExecutionTimeMs —
   *  e.g. discoveryPrefetch, documentRag, qaDeliveryLoop, receptionistFastLane. Lets the
   *  Warden + eval attribute turn latency to a stage instead of treating turnDurationMs as
   *  a black box. */
  phaseTimingsMs?: Record<string, number>;
  /** turnDurationMs minus llmTimeMs, toolExecutionTimeMs, and all tracked phase timings —
   *  the residual that surfaces the next unmeasured cost. */
  untrackedMs?: number;
}

export function getPerTurnToolCallLimit(toolName: string): number | undefined {
  const cfgOverride = getConfig().orchestration?.perTurnCaps?.[toolName];
  if (cfgOverride !== undefined) return cfgOverride;
  return PER_TURN_TOOL_CALL_LIMITS[toolName];
}

export function buildDelegationLoopResponse(
  session: AgentSession,
  latestOutput: string,
  reason: "identical-output" | "limit" = "identical-output",
): string {
  const normalized = latestOutput.trim() || "The delegated agent returned no usable output.";
  const evidence = findRecentDelegateEvidence(session.getHistory());
  const bestAvailable = evidence?.evidence?.trim() || normalized;

  if (reason === "limit") {
    const intro = evidence
      ? "I stopped here because the delegation limit for this turn was reached. Here is the best grounded result collected so far:"
      : "I stopped here because the delegation limit for this turn was reached before a grounded final answer could be completed.";
    return `${intro}\n\n${bestAvailable}\n\nIf you want me to continue past this limit, tell me to raise the delegation limit for this task. Otherwise, we can stop here.`;
  }

  return [
    "Delegation loop detected. I stopped the repeated delegation and am using the best grounded result collected so far.",
    "",
    bestAvailable,
    "",
    "If you want another attempt, tell me to try a different strategy. Otherwise, we can stop here.",
  ].join("\n");
}

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
  answerNeedsEvidenceAnchoringRepair,
  synthesizeSourceSensitiveEvidenceBackstop,
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

function defaultResearchFallbackAgentsFor(agentName: string | undefined, guidance: DynamicTurnGuidance | null | undefined): string[] {
  const preferredAgents = guidance?.freshnessSensitive && !guidance?.sourceSensitive
    ? ["web_task_coordinator", "researcher", "mission_coordinator"]
    : ["mission_coordinator", "researcher"];
  return preferredAgents
    .filter((candidate) => candidate !== agentName)
    .filter((candidate) => chooseConfiguredAgent([candidate]) === candidate);
}

function withDefaultResearchFallbackAgents(
  args: Record<string, unknown>,
  guidance: DynamicTurnGuidance | null | undefined,
): Record<string, unknown> {
  const agentName = typeof args["agentName"] === "string" ? String(args["agentName"]).trim() : undefined;
  if (!agentName) return args;
  const existingFallbacks = Array.isArray(args["fallbackAgents"])
    ? args["fallbackAgents"].map(String).filter(Boolean)
    : [];
  if (existingFallbacks.length > 0) return args;
  const fallbackAgents = defaultResearchFallbackAgentsFor(agentName, guidance);
  return fallbackAgents.length > 0 ? { ...args, fallbackAgents } : args;
}

export function hasRecentSourceSensitivePartialDelegation(
  history: readonly { role: string; content?: string | null; metadata?: Record<string, unknown> }[],
): boolean {
  const recent = [...history].reverse().slice(0, 12);

  for (const message of recent) {
    if (message.role !== "tool") continue;
    const content = String(message.content ?? "");
    const meta = message.metadata ?? {};
    if (!DELEGATE_TOOL_RESULT_RE.test(content) && !looksLikeDelegateMetadata(meta)) continue;

    const delegationOutcome = typeof meta["delegationOutcome"] === "string"
      ? String(meta["delegationOutcome"]).toLowerCase()
      : "";

    if (delegationOutcome === "failure") return true;
    // Any PARTIAL outcome means the swarm did not fully cover the request, so the
    // curated shared findings must ground the final synthesis — regardless of
    // terminalState. A coordinator that synthesizes after its inner researchers time
    // out reports outcome "partial" with terminalState "completed"; the old list
    // (timeout/max_iterations/cancelled/empty) excluded that case, so the backstop
    // never fired and a confident training-data answer shipped that CONTRADICTED the
    // verified finding (audit 1ba15cb5: shared finding = IM73A135V01 is analog; the
    // answer said "digital PDM").
    if (delegationOutcome === "partial") return true;
  }

  return false;
}

function hasRecentSparseSourceSensitiveMemoryReuse(
  history: readonly { role: string; content?: string | null; metadata?: Record<string, unknown> }[],
  userMessage: string,
): boolean {
  if (!isBroadSourceSensitiveAdvisoryRequest(userMessage)) return false;

  const recent = [...history].reverse().slice(0, 12);

  for (const message of recent) {
    if (message.role !== "tool") continue;
    const content = String(message.content ?? "");
    const meta = message.metadata ?? {};
    if (!DELEGATE_TOOL_RESULT_RE.test(content) && !looksLikeDelegateMetadata(meta)) continue;

    const reusedFromSessionMemory = meta["reusedFromSessionMemory"] === true;
    const factCount = typeof meta["factCount"] === "number" ? Number(meta["factCount"]) : 0;
    const partialCount = typeof meta["partialCount"] === "number" ? Number(meta["partialCount"]) : 0;
    if (reusedFromSessionMemory && factCount > 0 && factCount <= 3 && partialCount === 0) {
      return true;
    }
  }

  return false;
}

/** Pull the prior turn's topic + answer from history so a contextless follow-up
 *  ("validate your response") can be delegated with the real subject folded in. */
function extractPriorTurnContext(
  history: readonly SessionHistoryMessage[],
  currentMessage: string,
): { priorUserRequest?: string; priorAssistantAnswer?: string } {
  const current = currentMessage.trim();
  let priorAssistantAnswer: string | undefined;
  let priorUserRequest: string | undefined;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i]!;
    const content = typeof message.content === "string" ? message.content.trim() : "";
    const hasToolCalls = Array.isArray((message as { tool_calls?: unknown[] }).tool_calls)
      && (((message as { tool_calls?: unknown[] }).tool_calls?.length ?? 0) > 0);
    if (!priorAssistantAnswer && message.role === "assistant" && content.length > 40 && !hasToolCalls) {
      priorAssistantAnswer = content;
    }
    if (!priorUserRequest && message.role === "user" && content && content !== current) {
      priorUserRequest = content;
    }
    if (priorAssistantAnswer && priorUserRequest) break;
  }
  return { priorUserRequest, priorAssistantAnswer };
}

/**
 * True when a create_ephemeral_agent spec grants WRITE/artifact tools but no
 * web-reaching tools (web_search / web_fetch / browser_*). Such an agent renders
 * already-gathered evidence — it is NOT a researcher — so the source-sensitive
 * "WEB RESEARCH TASK — gather datasheets/sourcing/pricing" preamble must not be
 * injected into its task: that boilerplate both mis-frames the writer AND is the
 * exact trigger for the agent-factory research-capability gate, which then rejects
 * the writer for lacking web tools (audit 74e49d90: presentation_builder rejected,
 * artifact never built, turn shipped a raw evidence dump). Mirrors the gate's own
 * web-tool set (web_search/web_fetch/browser_*; url_inspect does not count).
 * Empty/omitted tools ⇒ inherits all (may include web) ⇒ do not skip.
 */
export function ephemeralAgentSpecLacksWebTools(args: Record<string, unknown>): boolean {
  const tools = Array.isArray(args["tools"])
    ? args["tools"].filter((t): t is string => typeof t === "string")
    : null;
  if (!tools || tools.length === 0) return false;
  return !tools.some((t) => /^web_search$/i.test(t) || /^web_fetch$/i.test(t) || /^browser_/i.test(t));
}

/**
 * A parallel-slice / task-graph node whose target agent BUILDS or COORDINATES must keep its
 * OWN instruction in a source-sensitive turn. Rewriting it into the "use web_search/web_fetch
 * and STOP and report" research frame means a builder (which has no web tools) never produces
 * the artifact, and a coordinator can't decompose+build — audit 0602f246: a content_writer
 * BUILD slice in a research+build parallel_delegate was flattened to a research task and the
 * app was never built. The research is the sibling research slice's job. Keyed on the agent
 * the LLM chose (role), not on matching keywords in the user's message — same accepted signal
 * as the single-delegate coordinator exemption below.
 */
function sourceSensitiveSliceKeepsOwnTask(agentName: string): boolean {
  return BUILDER_AGENT_ROLE_RE.test(agentName) || /(?:coordinator|planner)/i.test(agentName);
}

export function enforceSourceSensitiveOriginalRequestOnToolCall(
  toolCall: LLMResponse["tool_calls"][number],
  userMessage: string,
  guidance: DynamicTurnGuidance | null | undefined,
  sessionId: string,
  guardrailEvents: Array<{ type: string; details: string }>,
  /**
   * Receives the model's OWN build-task text when the research-first rewrite is about
   * to discard it (a delegate to content_writer/web_coder/backend_coder on a
   * source-sensitive turn). The orchestrator often writes an excellent spec — features,
   * data shape, UI behaviour — and throwing it away leaves the later corrective build
   * with only generic facts (audit c2f76a00: a detailed 100-question quiz-app spec was
   * rewritten to research; the eventual build shipped a 4KB welcome page). The caller
   * stashes it and feeds it back into the corrective build as the blueprint.
   */
  onDiscardedBuilderTask?: (spec: string) => void,
): void {
  if (!guidance?.sourceSensitive) return;
  // A source-sensitive task may still spawn a downstream WRITER to render the
  // gathered evidence into an artifact. Don't rewrite a write-only ephemeral
  // agent's task into a research-gather preamble — it would be rejected for
  // lacking web tools and the artifact would never be produced.
  if (toolCall.name === "create_ephemeral_agent" && ephemeralAgentSpecLacksWebTools(toolCall.arguments ?? {})) {
    return;
  }
  const originalArgs = toolCall.arguments ?? {};
  let nextArgs: Record<string, unknown> | null = null;
  let recoveryReason = "source_sensitive_original_request_enforced";

  if (toolCall.name === "delegate_to_agent" || toolCall.name === "swarm_delegate" || toolCall.name === "create_ephemeral_agent") {
    // When the orchestrator LLM CHOSE a coordinator (mission_coordinator / *_planner),
    // it has decided this request needs multiple steps. Honor that decision: give the
    // coordinator a source-disciplined frame that lets it decompose + build + review,
    // NOT the research-only "gather and STOP and report" rewrite below (which flattens
    // the whole thing to research and blocks any build phase — audit 1740fb0c). This is
    // keyed only on the agent the LLM picked — no message keyword-matching, no forced
    // routing; the multi-step decision stays the model's.
    const chosenAgent = typeof originalArgs["agentName"] === "string" ? String(originalArgs["agentName"]) : "";
    if (
      (toolCall.name === "delegate_to_agent" || toolCall.name === "swarm_delegate")
      && /(?:coordinator|planner)/i.test(chosenAgent)
    ) {
      nextArgs = stripUntrustedDelegationContext({
        ...originalArgs,
        task: buildSourceSensitiveCoordinatorTask(userMessage),
      });
      recoveryReason = "source_sensitive_coordinator_frame";
    } else {
      const originalTask = typeof originalArgs["task"] === "string" ? String(originalArgs["task"]) : "";
      // Preserve the model's build spec before the research-first rewrite discards it.
      if (BUILDER_AGENT_ROLE_RE.test(chosenAgent) && originalTask.trim().length >= 200) {
        onDiscardedBuilderTask?.(originalTask.trim());
      }
      const focus = deriveSourceSensitiveDelegationFocus(originalTask, userMessage);
      nextArgs = withDefaultResearchFallbackAgents(
        stripUntrustedDelegationContext({ ...originalArgs, task: buildSourceSensitiveOriginalRequestTask(userMessage, undefined, focus) }),
        guidance,
      );
    }
  } else if (toolCall.name === "parallel_delegate") {
    const rawTasks = Array.isArray(originalArgs["tasks"])
      ? originalArgs["tasks"].filter((taskSpec): taskSpec is Record<string, unknown> => Boolean(taskSpec) && typeof taskSpec === "object")
      : [];
    if (rawTasks.length > 0) {
      nextArgs = {
        ...originalArgs,
        tasks: rawTasks.map((taskSpec, index) => {
          const sliceAgent = typeof taskSpec["agentName"] === "string" ? String(taskSpec["agentName"]) : "";
          // Builder/coordinator slice: keep its own BUILD/decompose instruction — the
          // research is the sibling research slice's job (audit 0602f246).
          if (sourceSensitiveSliceKeepsOwnTask(sliceAgent)) {
            return stripUntrustedDelegationContext({ ...taskSpec });
          }
          return withDefaultResearchFallbackAgents(
            stripUntrustedDelegationContext({
              ...taskSpec,
              task: buildSourceSensitiveOriginalRequestTask(
                userMessage,
                `SLICE ${index + 1}/${rawTasks.length}`,
                deriveSourceSensitiveDelegationFocus(typeof taskSpec["task"] === "string" ? String(taskSpec["task"]) : "", userMessage),
              ),
            }),
            guidance,
          );
        }),
      };
    }
  } else if (toolCall.name === "run_task_graph") {
    const rawNodes = Array.isArray(originalArgs["nodes"])
      ? originalArgs["nodes"].filter((node): node is Record<string, unknown> => Boolean(node) && typeof node === "object")
      : [];
    if (rawNodes.length > 0) {
      nextArgs = {
        ...originalArgs,
        objective: userMessage,
        nodes: rawNodes.map((node, index) => {
          const nodeAgent = typeof node["agentName"] === "string" ? String(node["agentName"]) : "";
          // Builder/coordinator node: keep its own BUILD/decompose instruction (audit 0602f246).
          if (sourceSensitiveSliceKeepsOwnTask(nodeAgent)) {
            return stripUntrustedDelegationContext({ ...node });
          }
          return withDefaultResearchFallbackAgents(
            stripUntrustedDelegationContext({
              ...node,
              task: buildSourceSensitiveOriginalRequestTask(
                userMessage,
                `GRAPH NODE ${index + 1}/${rawNodes.length}`,
                deriveSourceSensitiveDelegationFocus(typeof node["task"] === "string" ? String(node["task"]) : "", userMessage),
              ),
            }),
            guidance,
          );
        }),
      };
    }
  }

  if (!nextArgs || stableSerialize(nextArgs) === stableSerialize(originalArgs)) return;
  toolCall.arguments = nextArgs;
  guardrailEvents.push({ type: "delegation_required", details: `${toolCall.name}:${recoveryReason}` });
  logAudit("tool_call_recovered", {
    originalTool: toolCall.name,
    rewrittenTo: toolCall.name,
    reason: recoveryReason,
  }, { sessionId, severity: "info" });
}

function collapseDuplicateToolCallsInResponse(
  toolCalls: LLMResponse["tool_calls"],
  sessionId: string,
  guardrailEvents: Array<{ type: string; details: string }>,
): LLMResponse["tool_calls"] {
  const seenFingerprints = new Set<string>();
  const filtered: LLMResponse["tool_calls"] = [];

  for (const toolCall of toolCalls) {
    const fingerprint = `${toolCall.name}|${stableSerialize(toolCall.arguments ?? {})}`;
    if (seenFingerprints.has(fingerprint)) {
      logAudit("tool_call_blocked", {
        tool: toolCall.name,
        reason: "duplicate_same_response",
        args: toolCall.arguments,
      }, {
        sessionId,
        severity: "warn",
      });
      guardrailEvents.push({ type: "tool_blocked", details: `${toolCall.name}:duplicate_same_response` });
      continue;
    }

    seenFingerprints.add(fingerprint);
    filtered.push(toolCall);
  }

  return filtered;
}

function collapseExcessDirectDelegationsInResponse(
  toolCalls: LLMResponse["tool_calls"],
  sessionId: string,
  guardrailEvents: Array<{ type: string; details: string }>,
  onDiscardedBuilderTask?: (spec: string) => void,
): LLMResponse["tool_calls"] {
  let seenDirectDelegation = false;
  const filtered: LLMResponse["tool_calls"] = [];

  for (const toolCall of toolCalls) {
    if (toolCall.name !== "delegate_to_agent") {
      filtered.push(toolCall);
      continue;
    }

    if (!seenDirectDelegation) {
      seenDirectDelegation = true;
      filtered.push(toolCall);
      continue;
    }

    // When the dropped surplus delegation is a BUILD task to a builder agent, its task
    // text is the model's own build spec — preserve it for the corrective build instead
    // of losing it (audit c2f76a00: the model emitted research + a detailed content_writer
    // quiz-app spec in one response; the spec was dropped here and the eventual corrective
    // build, running on generic facts only, shipped a 4KB welcome page).
    const droppedAgent = typeof toolCall.arguments?.["agentName"] === "string" ? String(toolCall.arguments["agentName"]) : "";
    const droppedTask = typeof toolCall.arguments?.["task"] === "string" ? String(toolCall.arguments["task"]) : "";
    if (BUILDER_AGENT_ROLE_RE.test(droppedAgent) && droppedTask.trim().length >= 200) {
      onDiscardedBuilderTask?.(droppedTask.trim());
    }

    logAudit("tool_call_blocked", {
      tool: toolCall.name,
      reason: "multiple_direct_delegations_same_response",
      args: toolCall.arguments,
    }, {
      sessionId,
      severity: "warn",
    });
    guardrailEvents.push({ type: "tool_blocked", details: `${toolCall.name}:multiple_direct_delegations_same_response` });
  }

  return filtered;
}

const ORCHESTRATION_LAUNCHER_TOOL_NAMES = new Set([
  "delegate_to_agent",
  "parallel_delegate",
  "run_task_graph",
  "run_workflow",
  "create_ephemeral_agent",
]);
const PERSISTED_SWARM_STATE_TOOL_NAMES = new Set([
  ...ORCHESTRATION_LAUNCHER_TOOL_NAMES,
  "swarm_delegate",
]);
const AGENT_DISCOVERY_TOOL_NAMES = new Set([
  "search_agents",
  "list_agents",
  "search_tools",
  "search_workflows",
]);

function extractAgentRoutingSuggestionFromMetadata(
  metadata: Record<string, unknown> | undefined,
): { agentName: string; query?: string; fallbackAgents?: string[] } | undefined {
  const agentName = typeof metadata?.["topResult"] === "string"
    ? String(metadata["topResult"]).trim()
    : "";
  if (!agentName) return undefined;

  const query = typeof metadata?.["query"] === "string"
    ? String(metadata["query"]).trim()
    : "";
  const fallbackAgents = Array.isArray(metadata?.["suggestedFallbackAgents"])
    ? (metadata?.["suggestedFallbackAgents"] as unknown[])
      .map((value) => typeof value === "string" ? value.trim() : "")
      .filter((value): value is string => Boolean(value) && value !== agentName)
    : [];

  return {
    agentName,
    query: query || undefined,
    fallbackAgents: fallbackAgents.length > 0 ? fallbackAgents : undefined,
  };
}

function searchAgentsReturnedNoMatch(metadata: Record<string, unknown> | undefined): boolean {
  const resultCount = typeof metadata?.["resultCount"] === "number" ? metadata["resultCount"] : 0;
  const topResult = typeof metadata?.["topResult"] === "string" ? metadata["topResult"].trim() : "";
  return resultCount === 0 && !topResult;
}

function chooseConfiguredAgent(candidates: readonly string[]): string | undefined {
  const configuredAgents = getConfig().subAgents ?? {};
  return candidates.find((name) => name in configuredAgents);
}

type RequiredResearchFallbackRoute = {
  toolName: "delegate_to_agent" | "create_ephemeral_agent";
  args: Record<string, unknown>;
  label: string;
};

export function buildRequiredResearchFallbackRoute(
  userMessage: string,
  guidance: DynamicTurnGuidance | null | undefined,
  allowedToolNameSet: Set<string>,
  allowedAgents?: string[] | null,
): RequiredResearchFallbackRoute | null {
  // De-layer single-domain research: a coordinator only earns its extra hop when
  // the task genuinely spans multiple areas (Anthropic/Cognition consensus).
  // Otherwise route straight to the researcher specialist. Freshness single-shot
  // lookups keep web_task_coordinator (its purpose-built lane).
  const multiDomain = looksMultiDomainResearch(userMessage);
  const basePreference = guidance?.freshnessSensitive && !guidance?.sourceSensitive
    ? ["web_task_coordinator", "researcher", "mission_coordinator"]
    : (multiDomain ? ["mission_coordinator", "researcher"] : ["researcher", "mission_coordinator"]);
  // Inside a scoped scene/job step the session restricts which agents may run. Routing
  // to an agent outside that set hard-fails ("not permitted in this scene"), so respect
  // it: keep only allowed preferences, and when none of the default research agents are
  // allowed, fall back to the step's OWN allowed agents (the step task names them — e.g.
  // an image step's only agent is image_sourcer). Unrestricted turns keep the old list.
  const allowSet = allowedAgents && allowedAgents.length > 0 ? new Set(allowedAgents) : null;
  const preferredAgents = allowSet
    ? (basePreference.filter((name) => allowSet.has(name)).concat(allowedAgents!.filter((name) => !basePreference.includes(name))))
    : basePreference;
  if (preferredAgents.length === 0) return null;
  const selectedAgent = chooseConfiguredAgent(preferredAgents) ?? preferredAgents[0]!;
  const fallbackAgents = preferredAgents.filter((agentName) => agentName !== selectedAgent && chooseConfiguredAgent([agentName]));

  if (allowedToolNameSet.has("delegate_to_agent")) {
    return {
      toolName: "delegate_to_agent",
      label: selectedAgent,
      args: {
        agentName: selectedAgent,
        fallbackAgents,
        task: userMessage,
      },
    };
  }

  if (allowedToolNameSet.has("create_ephemeral_agent")) {
    return {
      toolName: "create_ephemeral_agent",
      label: "ephemeral_research_specialist",
      args: {
        agentName: "ephemeral_research_specialist",
        description: "Purpose-built specialist for source-grounded research and product/component verification.",
        systemPrompt: [
          "You are a source-grounded research specialist.",
          "Use web_search and web_fetch to gather evidence before answering.",
          "Return concise findings with source URLs and be explicit about uncertainty.",
          "Do not invent product names, specifications, or artifact paths.",
        ].join(" "),
        tools: ["web_search", "web_fetch", "read_shared_facts", "share_finding"],
        maxIterations: 5,
        // Leaf sub-agents default to `subAgentTurnSloMs` (60 s), which is far
        // too short for a research specialist doing 5 web_search iterations.
        // Grant 5 minutes — the same budget as the configured researcher agent.
        timeoutMs: 300_000,
        task: userMessage,
      },
    };
  }

  return null;
}

function buildSearchAgentsNoMatchFallbackPrompt(route: RequiredResearchFallbackRoute): string {
  if (route.toolName === "delegate_to_agent") {
    const fallbackAgents = Array.isArray(route.args["fallbackAgents"]) ? route.args["fallbackAgents"].map(String).filter(Boolean) : [];
    return [
      "ROUTING FALLBACK: search_agents returned no usable specialist candidates for this source-sensitive request.",
      "Do NOT call search_agents or list_agents again in this turn.",
      `You MUST call delegate_to_agent now with agentName="${route.label}"${fallbackAgents.length ? ` and fallbackAgents=[${fallbackAgents.map((name) => `"${name}"`).join(",")}]` : ""} using the original user request as the task.`,
      "A further discovery-only response is invalid; delegation must happen before any final answer.",
    ].join(" ");
  }

  return [
    "ROUTING FALLBACK: search_agents returned no usable specialist candidates for this source-sensitive request.",
    "Do NOT call search_agents or list_agents again in this turn.",
    "You MUST call create_ephemeral_agent now using the provided research-specialist shape and the original user request as the task.",
    "A further discovery-only response is invalid; orchestration must happen before any final answer.",
  ].join(" ");
}

function enforceRequiredResearchFallbackRouteOnToolCall(
  toolCall: LLMResponse["tool_calls"][number],
  route: RequiredResearchFallbackRoute,
  sessionId: string,
  guardrailEvents: Array<{ type: string; details: string }>,
): void {
  const discoveryRetryTools = new Set(["search_agents", "list_agents", "search_workflows"]);
  const shouldRewriteDiscoveryRetry = discoveryRetryTools.has(toolCall.name);
  const shouldEnforceCanonicalRouteArgs = toolCall.name === route.toolName;
  if (!shouldRewriteDiscoveryRetry && !shouldEnforceCanonicalRouteArgs) return;

  const originalTool = toolCall.name;
  const originalArgs = toolCall.arguments ?? {};
  const routeArgs = { ...route.args };
  const changed = originalTool !== route.toolName || stableSerialize(originalArgs) !== stableSerialize(routeArgs);
  if (!changed) return;

  toolCall.name = route.toolName;
  toolCall.arguments = routeArgs;
  guardrailEvents.push({ type: "delegation_required", details: "required_research_original_task_enforced" });
  logAudit("tool_call_recovered", {
    originalTool,
    rewrittenTo: route.toolName,
    reason: shouldRewriteDiscoveryRetry
      ? "required_research_discovery_retry_rewritten"
      : "required_research_original_task_enforced",
    recoveredAgentName: route.label,
  }, { sessionId, severity: shouldRewriteDiscoveryRetry ? "warn" : "info" });
}

function isExplicitAgentCatalogRequest(message: string): boolean {
  return /\b(list|show|display|print|enumerate|inspect|browse|catalog|catalogue|katalog|liste|auflisten|anzeigen)\b[\s\S]{0,80}\b(agents?|sub[- ]?agents?|specialists?|spezialisten|agenten|catalog|catalogue|katalog)\b/i.test(message)
    || /\b(agents?|sub[- ]?agents?|specialists?|spezialisten|agenten|catalog|catalogue|katalog)\b[\s\S]{0,80}\b(list|show|display|print|enumerate|inspect|browse|liste|auflisten|anzeigen)\b/i.test(message);
}

const __swarmStateContinuity = {
  loadPreviousTurnSwarmTasks,
  buildPersistableSwarmTaskDelta,
};

function collapseMixedOrchestrationLaunchersInResponse(
  toolCalls: LLMResponse["tool_calls"],
  sessionId: string,
  guardrailEvents: Array<{ type: string; details: string }>,
): LLMResponse["tool_calls"] {
  let firstLauncherName: string | null = null;
  const filtered: LLMResponse["tool_calls"] = [];

  for (const toolCall of toolCalls) {
    if (!ORCHESTRATION_LAUNCHER_TOOL_NAMES.has(toolCall.name)) {
      filtered.push(toolCall);
      continue;
    }

    if (!firstLauncherName) {
      firstLauncherName = toolCall.name;
      filtered.push(toolCall);
      continue;
    }

    logAudit("tool_call_blocked", {
      tool: toolCall.name,
      reason: "multiple_orchestration_launchers_same_response",
      keptTool: firstLauncherName,
      args: toolCall.arguments,
    }, {
      sessionId,
      severity: "warn",
    });
    guardrailEvents.push({ type: "tool_blocked", details: `${toolCall.name}:multiple_orchestration_launchers_same_response` });
  }

  return filtered;
}

function collapseMixedDiscoveryAndOrchestrationToolsInResponse(
  toolCalls: LLMResponse["tool_calls"],
  sessionId: string,
  guardrailEvents: Array<{ type: string; details: string }>,
): LLMResponse["tool_calls"] {
  const selectedPhase: "discovery" | "orchestration" | null = toolCalls.some((toolCall) =>
    ORCHESTRATION_LAUNCHER_TOOL_NAMES.has(toolCall.name)
  )
    ? "orchestration"
    : toolCalls.some((toolCall) => AGENT_DISCOVERY_TOOL_NAMES.has(toolCall.name))
      ? "discovery"
      : null;
  const filtered: LLMResponse["tool_calls"] = [];

  for (const toolCall of toolCalls) {
    const phase = ORCHESTRATION_LAUNCHER_TOOL_NAMES.has(toolCall.name)
      ? "orchestration"
      : AGENT_DISCOVERY_TOOL_NAMES.has(toolCall.name)
        ? "discovery"
        : null;

    if (!phase) {
      filtered.push(toolCall);
      continue;
    }

    if (selectedPhase === phase) {
      filtered.push(toolCall);
      continue;
    }

    logAudit("tool_call_blocked", {
      tool: toolCall.name,
      reason: "mixed_discovery_and_orchestration_same_response",
      keptPhase: selectedPhase,
      args: toolCall.arguments,
    }, {
      sessionId,
      severity: "warn",
    });
    guardrailEvents.push({ type: "tool_blocked", details: `${toolCall.name}:mixed_discovery_and_orchestration_same_response` });
  }

  return filtered;
}

export function buildRepeatedOutputFingerprint(toolName: string, args: Record<string, unknown>, resultText: string): string {
  return `${toolName}|${stableSerialize(args)}|${resultText.slice(0, 500)}`;
}

export { __swarmStateContinuity };

function sanitizeUserFacingAssistantResponse(value: string, toolIterations: number): string {
  const cleaned = sanitizeAssistantContent(value, toolIterations > 0);
  // Final safety net: a slow local model can collapse into a repetition loop during
  // synthesis and emit the same section many times. Never ship that verbatim — keep
  // the first occurrence of each unique section (audit 9fd16384: 17× repeated block).
  return looksLikeDegenerateRepetition(cleaned) ? collapseRepeatedMarkdownSections(cleaned) : cleaned;
}

const EMPTY_ASSISTANT_RESPONSE_FALLBACK = "I wasn't able to generate a usable reply for that turn. Please try again.";

function looksLikeGenericNoUsableReply(value: string): boolean {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized === EMPTY_ASSISTANT_RESPONSE_FALLBACK
    || /^i wasn'?t able to generate a usable reply\b/i.test(normalized)
    || /^please try again\.?$/i.test(normalized);
}

function shouldResynthesizeUserFacingResponse(raw: string, cleaned: string, toolIterations: number): boolean {
  if (!raw.trim() || cleaned.length === 0) return true;
  if (toolIterations > 0 && looksLikeGenericNoUsableReply(cleaned)) return true;
  if (toolIterations === 0) return false;
  if (!NARRATED_TOOL_TEXT_RE.test(raw)) return false;
  return cleaned.length === 0 || cleaned.length < Math.min(120, Math.ceil(raw.length / 3));
}

const CONTINUATION_PROMISE_RE = /\b(i(?:'ll| will)(?:\s+now)?|i am going to|ich werde(?:\s+nun)?|ich beauftrage(?:\s+nun)?|n[äa]chste orchestrierung|next orchestration|next logical step|n[äa]chste logische aktion)\b/i;
const IMPLICIT_CONTINUATION_EXECUTION_RE = /\b(?:i(?:\s+have|'ve)[\s\S]{0,80}\b(?:corrected|fixed|updated|adjusted)\b[\s\S]{0,80}\b(?:am\s+)?(?:now\s+)?(?:running|executing|starting|retrying|restarting)\b|ich\s+habe[\s\S]{0,80}\b(?:korrigiert|angepasst|berichtigt)\b[\s\S]{0,80}\b(?:und\s+)?(?:f(?:[üu]hre|uehre)|starte|versuche|sto(?:ss|ß)e)\b[\s\S]{0,40}\b(?:nun|jetzt)\b[\s\S]{0,20}\b(?:aus|an)\b)/i;
const MAINTENANCE_EXECUTION_PROMISE_RE = /\b(?:i(?:'ll| will)\s+(?:create|generate|delegate|build)|ich\s+(?:werde|erstelle|generiere|delegiere|beauftrage)|(?:erstelle|generiere|delegiere|beauftrage)\s+ich(?:\s+nun|\s+jetzt)?)\b/i;
const MISLEADING_EXECUTED_NEXT_STEP_RE = /\b(the next (?:logical )?(?:step|action)|der n[äa]chste(?: logische)?(?: schritt| aktion)|die n[äa]chste(?: logische)? aktion)\b[\s\S]{0,80}\b(which has been executed|has been executed|was executed|has already been executed|wurde(?:\s+bereits)?\s+ausgef[üu]hrt|ist bereits erfolgt)\b/i;
const NEXT_TURN_HANDOFF_RE = /\b(would you like me to (?:initiate|start|retry)|in the next turn|im n[äa]chsten zug|im n[äa]chsten turn|neue[nr]? delegations(?:strategie|versuch)|new delegation attempt|no further tool calls can be made in this turn|keine weiteren tool calls .* in diesem zug)\b/i;

function looksLikeContinuationPromise(value: string): boolean {
  return CONTINUATION_PROMISE_RE.test(value) || IMPLICIT_CONTINUATION_EXECUTION_RE.test(value);
}

function looksLikeMaintenanceExecutionPromise(value: string): boolean {
  return looksLikeContinuationPromise(value) || MAINTENANCE_EXECUTION_PROMISE_RE.test(value);
}

function shouldRewriteTerminalResponse(value: string, toolIterations: number): boolean {
  if (toolIterations === 0) return false;
  return looksLikeContinuationPromise(value)
    || MISLEADING_EXECUTED_NEXT_STEP_RE.test(value)
    || NEXT_TURN_HANDOFF_RE.test(value);
}

function hasRecentUnresolvedDelegatedAction(history: readonly { role: string; content?: string | null; metadata?: Record<string, unknown> }[]): boolean {
  const recentMessages = [...history].reverse().slice(0, 12);

  for (const message of recentMessages) {
    if (message.role !== "tool") continue;

    const metadata = message.metadata ?? {};
    const delegationOutcome = typeof metadata["delegationOutcome"] === "string"
      ? String(metadata["delegationOutcome"]).toLowerCase()
      : undefined;
    const terminalState = typeof metadata["terminalState"] === "string"
      ? String(metadata["terminalState"]).toLowerCase()
      : undefined;
    const content = String(message.content ?? "");

    if (
      delegationOutcome === "partial"
      || delegationOutcome === "failure"
      || terminalState === "max_iterations"
      || terminalState === "timeout"
      || terminalState === "cancelled"
      || /PARTIAL RESULT|max_iterations|timed out|could not complete|delegation limit/i.test(content)
    ) {
      return true;
    }
  }

  return false;
}

function hasRecentWorkflowAuthoringMaintenanceContext(history: readonly { role: string; content?: string | null }[]): boolean {
  let skippedCurrentUser = false;
  let inspectedPriorUserMessages = 0;

  for (const message of [...history].reverse()) {
    if (message.role !== "user") continue;

    const content = String(message.content ?? "").trim();
    if (!content) continue;

    if (!skippedCurrentUser) {
      skippedCurrentUser = true;
      continue;
    }

    inspectedPriorUserMessages += 1;
    const normalized = content.toLowerCase();
    const guidance = buildDynamicTurnGuidance(content);
    const workflowLike = WORKFLOW_REQUEST_PATTERNS.some((pattern) => pattern.test(normalized))
      || WORKFLOW_HINT_TERMS.some((term) => normalized.includes(term));

    if (guidance?.swarmMaintenanceSensitive && workflowLike) {
      return true;
    }

    if (inspectedPriorUserMessages >= 2) {
      break;
    }
  }

  return false;
}

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

const WORKFLOW_TOOL_RESULT_RE = /^Workflow\s+\S+\s+\[[^\]]+\]\s+(?:completed|blocked)\./i;
const EVIDENCE_SECTION_RE = /^Observed evidence:\s*/m;

function isForcedSynthesisSystemMessage(message: { role: string; content?: string | null }): boolean {
  return message.role === "system"
    && typeof message.content === "string"
    && (
      message.content.startsWith("[SYNTHESIS REQUIRED]")
      || message.content.startsWith("[WARDEN STOP — FORCED SYNTHESIS]")
    );
}

const PRIOR_DELEGATION_JUNK_SUBSTANCE_FLOOR = 1500;

/**
 * Walk recent history for the most recent delegation tool result and decide
 * whether it qualifies as "junk" — i.e. a partial/timeout result whose
 * actual substantive evidence is below the usability floor. Used by the
 * synthesis-required guardrail (Fix 3) to allow ONE recovery delegation
 * through instead of locking the model into synthesizing from a truncated
 * stub. Returns null when the most recent delegation is either substantial
 * or absent.
 */
function findRecentJunkDelegationResult(
  history: readonly { role: string; content?: string | null; metadata?: Record<string, unknown> }[],
): { agentName: string; substanceChars: number; terminalState: string | null } | null {
  const recent = [...history].reverse().slice(0, 12);
  for (const message of recent) {
    if (message.role !== "tool") continue;
    const content = String(message.content ?? "");
    const meta = message.metadata ?? {};
    const isDelegate = DELEGATE_TOOL_RESULT_RE.test(content) || looksLikeDelegateMetadata(meta);
    if (!isDelegate) continue;

    const terminalState = typeof meta["terminalState"] === "string" ? String(meta["terminalState"]) : null;
    const delegationOutcome = typeof meta["delegationOutcome"] === "string" ? String(meta["delegationOutcome"]) : null;
    const isPartialOrTimeout = terminalState === "timeout"
      || delegationOutcome === "partial"
      || /—\s*PARTIAL PROGRESS|TIMEOUT|TASK FAILED/i.test(content);
    if (!isPartialOrTimeout) {
      // Most recent delegation succeeded with full evidence — there is no
      // recovery scenario to authorize. Stop walking.
      return null;
    }

    // Measure substantive evidence: strip the "Delegated result from / IMPORTANT / Observed evidence:" wrapper and count the body.
    const evidenceMatch = /Observed evidence:\s*([\s\S]+?)(?:\n\n|$)/.exec(content);
    const body = evidenceMatch ? evidenceMatch[1]!.trim() : content.trim();
    // A body containing the "Recovered delegated specialist body (full):"
    // marker is NOT junk — Fix 2 already surfaced the full delegated answer.
    if (/Recovered delegated specialist body \(full\):/i.test(body)) return null;
    if (body.length >= PRIOR_DELEGATION_JUNK_SUBSTANCE_FLOOR) return null;

    const agentName = typeof meta["agentName"] === "string" && meta["agentName"]
      ? meta["agentName"]
      : (content.match(/Delegated result from\s+([^\s—]+)/)?.[1] ?? "a specialist agent");
    return { agentName, substanceChars: body.length, terminalState };
  }
  return null;
}

function hasRecentForcedSynthesisNudge(
  history: readonly { role: string; content?: string | null }[],
): boolean {
  const recent = [...history].reverse().slice(0, 16);
  return recent.some((message) => isForcedSynthesisSystemMessage(message));
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

/**
 * Walk recent history for a failed delegation tool result.  Returns a
 * short user-facing diagnostic message naming the agent and reason —
 * better UX than the generic empty-response placeholder when the model
 * produced no recoverable text and we already know one specific thing
 * went wrong.  Returns null when the recent transcript shows successful
 * delegations or no delegations at all (in those cases the placeholder
 * remains correct).
 */
function findRecentFailedDelegation(
  history: readonly { role: string; content?: string | null; metadata?: Record<string, unknown> }[],
): { agentName: string; reason: string; message: string } | null {
  const recent = [...history].reverse().slice(0, 8);
  for (const message of recent) {
    if (message.role !== "tool") continue;
    const content = String(message.content ?? "");
    const meta = message.metadata ?? {};
    const isDelegate = DELEGATE_TOOL_RESULT_RE.test(content) || looksLikeDelegateMetadata(meta);
    if (!isDelegate) continue;
    // Only fire on visible-failure shape — the runtime's
    // buildModelVisibleToolResult rewrites the heading to "TASK FAILED"
    // when the underlying output looked like a failure.  Reading that
    // marker keeps us aligned with what the model itself saw.
    if (!/TASK FAILED\b/i.test(content)) {
      // Successful delegation in scope — don't fire a failure diagnostic.
      return null;
    }
    const agentName = typeof meta["agentName"] === "string" && meta["agentName"]
      ? meta["agentName"]
      : (content.match(/Delegated result from\s+([^\s—]+)/)?.[1] ?? "a specialist agent");
    const evidenceMatch = /Observed evidence:\s*([\s\S]+?)(?:\n\n|$)/.exec(content);
    const reason = evidenceMatch ? evidenceMatch[1]!.trim().slice(0, 280) : "";
    const reasonHint = reason ? ` Reason: ${reason}` : "";
    return {
      agentName,
      reason,
      message:
        `I delegated this task to ${agentName} but the attempt failed before producing an answer.${reasonHint} `
        + `Try the request again, or rephrase it so it can be answered without that specialist.`,
    };
  }
  return null;
}

function stripInterruptedSubAgentBoilerplate(text: string): string {
  return text
    // The reason text is sometimes extended with a tail clause such as
    //   "timed out after Nms after finishing the current operation"
    //   "timed out after Nms before starting another tool run"
    // (see sub-agent.ts hard-deadline branches). The original alternation
    // required `\d+ms` to be followed directly by whitespace + "Partial
    // progress before interruption:", which fails for the extended form
    // and leaves the scaffold prefix in the surfaced evidence. Allow any
    // non-newline tail between the duration and the partial-progress
    // header so both shapes get stripped cleanly.
    .replace(
      /Sub-agent '[^']+' timed out after \d+ms[^\n]*\s+Partial progress before interruption:\s*[\s\S]*?(?=Recovered evidence snippets from completed tools:|\n\n---|$)/g,
      "",
    )
    .replace(
      /Sub-agent '[^']+' produced no final response after substantive work\.[^\n]*\s+Partial progress before interruption:\s*[\s\S]*?(?=Recovered evidence snippets from completed tools:|\n\n---|$)/g,
      "",
    )
    .replace(
      /Sub-agent '[^']+' was cancelled[^\n]*\s+Partial progress before interruption:\s*[\s\S]*?(?=Recovered evidence snippets from completed tools:|\n\n---|$)/g,
      "",
    )
    // Also strip a bare "Partial progress before interruption:" stanza
    // that may appear after the extended-reason text was already matched
    // by an earlier regex but the partial-progress block still trails.
    .replace(
      /Partial progress before interruption:\s*[\s\S]*?(?=Recovered evidence snippets from completed tools:|\n\n---|$)/g,
      "",
    )
    .replace(/Sub-agent '[^']+' timed out after \d+ms[^\n]*\n?/g, "")
    .replace(/Sub-agent '[^']+' produced no final response after substantive work\.[^\n]*\n?/g, "")
    .replace(/Sub-agent '[^']+' was cancelled[^\n]*\n?/g, "")
    .trim();
}

function stripRecoveredSnippetToolLabel(text: string): string {
  const stripped = stripToolEvidencePrefix(text);
  return stripped || text.trim();
}

function stripDelegationProgressPrefix(text: string): string {
  return text
    .replace(/^(?:parallel|task)_\d+\s+\[[^\]]+\]\s*/i, "")
    .replace(/^[a-z_]+\s+\[[^\]]+\]\s*/i, "")
    .trim();
}

function collectInterruptedDelegationSnippets(text: string): string[] {
  const cleaned = stripPresentationFormatting(text);
  const snippets: string[] = [];
  const seen = new Set<string>();

  const pushSnippet = (candidate: string) => {
    const normalized = stripInterruptedSubAgentBoilerplate(candidate)
      .replace(/^IMPORTANT:\s.*$/gim, "")
      .trim();
    if (!normalized || normalized.length < 80 || looksLikeOrchestrationOnlyEvidence(normalized)) return;
    if (looksLikeProviderErrorEcho(normalized)) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    snippets.push(normalized);
  };

  // Recovered delegated specialist body — full delegated content surfaced
  // verbatim by the inner agent's interrupt path (Fix 2). Push it FIRST so
  // it ranks ahead of bullet-list snippets and a downstream cap preserves
  // the actual delegated answer rather than a 900-char head.
  const fullBodyMatch = /Recovered delegated specialist body \(full\):\s*\n([\s\S]+?)(?=\nRecovered evidence snippets from completed tools:|$)/i.exec(cleaned);
  if (fullBodyMatch?.[1]) {
    pushSnippet(fullBodyMatch[1].trim());
  }

  const progressMatch = /Partial progress before interruption:\s*([\s\S]*?)(?=\nRecovered (?:delegated specialist body \(full\)|evidence snippets from completed tools):|$)/i.exec(cleaned);
  if (progressMatch?.[1]) {
    for (const rawLine of progressMatch[1].split("\n")) {
      const line = rawLine.trim();
      if (!line.startsWith("- ")) continue;
      const body = line.slice(2).trim();
      if (!body || /^(?:Tool calls executed:|Iterations completed:)/i.test(body)) continue;
      if (/\[(?:running|pending)\]/i.test(body)) continue;
      if (/^(?:parallel|task)_\d+\s+\[[^\]]+\]/i.test(body) && !body.includes(" | ")) continue;
      const normalizedBody = stripDelegationProgressPrefix(body);
      const candidate = normalizedBody.includes(" | ")
        ? normalizedBody.split(/\s+\|\s+/).slice(1).join(" | ")
        : normalizedBody;
      pushSnippet(candidate);
    }
  }

  const recoveredMatch = /Recovered evidence snippets from completed tools:\s*\n([\s\S]+)$/i.exec(cleaned);
  if (recoveredMatch?.[1]) {
    for (const rawLine of recoveredMatch[1].split("\n")) {
      const line = rawLine.trim();
      if (!line.startsWith("- ")) continue;
      const body = line.slice(2).trim();
      const candidate = stripRecoveredSnippetToolLabel(body);
      pushSnippet(candidate);
    }
  }

  return snippets;
}

function extractUsefulInterruptedDelegationEvidence(text: string): string | null {
  if (!/Partial progress before interruption:|Recovered evidence snippets from completed tools:/i.test(text)) {
    return null;
  }
  const snippets = collectInterruptedDelegationSnippets(text);
  if (snippets.length > 0) return snippets.join("\n\n");

  const fallback = stripInterruptedSubAgentBoilerplate(stripPresentationFormatting(text))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^(?:Tool calls executed:|Iterations completed:|Recovered evidence snippets from completed tools:)/i.test(line))
    .filter((line) => !looksLikeOrchestrationOnlyEvidence(line))
    .join("\n");

  if (fallback.length < 120) return null;
  if (looksLikeProviderErrorEcho(fallback)) return null;
  return fallback;
}

function looksLikeInterruptedDelegationWithoutUsableEvidence(text: string): boolean {
  return /Partial progress before interruption:|Recovered evidence snippets from completed tools:/i.test(text)
    && !extractUsefulInterruptedDelegationEvidence(text);
}

function measureEvidenceCoverage(
  text: string,
  evidence: { evidence: string; itemCount: number },
): { textItems: number; itemShortfall: boolean; lengthShortfall: boolean } {
  const textItems = countStructuredItems(text);
  return {
    textItems,
    itemShortfall: evidence.itemCount >= 5
      && textItems < Math.ceil(evidence.itemCount * 0.6),
    lengthShortfall: evidence.evidence.length >= 1500
      && text.length < Math.ceil(evidence.evidence.length * 0.4),
  };
}

/** Index of the most recent `user` message, or -1. Marks the current turn's start. */
function lastUserMessageIndex(
  history: readonly { role: string }[],
): number {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.role === "user") return i;
  }
  return -1;
}

function findRecentDelegateEvidence(
  history: readonly { role: string; content?: string | null; metadata?: Record<string, unknown> }[],
  options: { scopeToCurrentTurn?: boolean } = {},
): { evidence: string; itemCount: number } | null {
  // When scoped to the current turn, drop everything up to and including the
  // last user message. Without this, the scan reaches back across turns and a
  // PRIOR turn's richer deliverable wins on `length + items*200`, becoming the
  // coverage target — or the dumped fallback — for THIS turn's answer (audit
  // 2f4f5fe6: a Turn-2 news deliverable was force-relayed verbatim as the
  // answer to an unrelated Turn-4 question).
  const scoped = options.scopeToCurrentTurn
    ? history.slice(lastUserMessageIndex(history) + 1)
    : history;
  const recent = [...scoped].reverse().slice(0, 24);
  let bestCandidate: { evidence: string; itemCount: number; score: number } | null = null;

  for (const message of recent) {
    if (message.role !== "tool") continue;
    const content = String(message.content ?? "");
    const meta = message.metadata ?? {};

    // Workflow execution results (run_workflow) carry the same
    // "Observed evidence:" block as delegated results and are an equally
    // valid synthesis backstop when the model misbehaves at the synthesis
    // step (e.g. emits another tool call after [SYNTHESIS REQUIRED]).
    // Recognize them here so the terminal-evidence backstop can prefer
    // the actual workflow dossier over the model's preamble text.
    const isWorkflowResult = WORKFLOW_TOOL_RESULT_RE.test(content)
      || typeof meta["workflowName"] === "string";
    const isDelegate = DELEGATE_TOOL_RESULT_RE.test(content) || looksLikeDelegateMetadata(meta);
    if (!isDelegate && !isWorkflowResult) continue;

    const evidenceMatch = EVIDENCE_SECTION_RE.exec(content);
    const rawEvidence = evidenceMatch
      ? content.slice(evidenceMatch.index + evidenceMatch[0].length).trim()
      : content.trim();
    const evidence = stripLeadingDelegateLabelEcho(extractUsefulInterruptedDelegationEvidence(rawEvidence) ?? rawEvidence);
    const delegationOutcome = typeof meta["delegationOutcome"] === "string"
      ? String(meta["delegationOutcome"]).toLowerCase()
      : "";
    const terminalState = typeof meta["terminalState"] === "string"
      ? String(meta["terminalState"]).toLowerCase()
      : "";
    const partialLike = delegationOutcome === "partial"
      || terminalState === "timeout"
      || /(?:TASK COMPLETED \(PARTIAL|PARTIAL PROGRESS|Partial progress before interruption:)/i.test(content);
    const minimumEvidenceChars = partialLike ? 120 : 400;
    if (!evidence || evidence.length < minimumEvidenceChars) continue;
    // Reject evidence that is just a regurgitated provider/HTTP/HTML error
    // — surfacing an LM Studio 500 page or an "OpenAI-compatible request
    // failed" string as the final answer is worse than the generic
    // "no usable evidence" fallback.
    if (looksLikeProviderErrorEcho(evidence)) continue;
    if (looksLikeRawWorkspaceToolDump(evidence)) continue;
    // Reject evidence whose every non-empty line is interrupted-sub-agent
    // scaffolding ("after finishing the current operation", "- Tool calls
    // executed: N", "- Iterations completed: N"). Without this, the
    // empty-response evidence backstop dumps the scaffold to the user as
    // if it were real findings. A 161-char scaffold is technically above
    // the partial-like 120-char minimum but is zero-information.
    if (looksLikeOrchestrationOnlyEvidence(evidence)) continue;

    const itemCount = countStructuredItems(evidence);
    const score = evidence.length + (itemCount * 200);
    if (!bestCandidate || score > bestCandidate.score) {
      bestCandidate = { evidence, itemCount, score };
    }
  }

  return bestCandidate
    ? { evidence: bestCandidate.evidence, itemCount: bestCandidate.itemCount }
    : null;
}

/**
 * Cost-center 2 (audit 5d51862f): a meta-reasoning preamble the specialist sometimes
 * prepends to its deliverable ("Now I have comprehensive evidence. Let me synthesize…")
 * before the real content. When relaying the deliverable verbatim we strip that short
 * lead-in so the user sees the answer, not the agent's thinking. Conservative: only
 * removes a short (<400 char) meta lead-in that sits before an early `---` rule or `#`
 * heading; otherwise the text is returned unchanged.
 */
const REASONING_PREAMBLE_STARTERS = /^(now\b|let me\b|here(?:'s| is| are)\b|based on\b|i['’]?(?:ll| ve| have)\b|i will\b|i now\b|okay\b|alright\b|sure\b|with (?:the|these|all)\b|to (?:answer|address|fulfil|fulfill|summari[sz]e)\b)/i;

export function stripLeadingReasoningPreamble(text: string): string {
  const t = text.trimStart();
  if (/^(#{1,6}\s|\||[-*+]\s|\d+[.)]\s|>\s)/.test(t)) return t; // already real content
  if (!REASONING_PREAMBLE_STARTERS.test(t)) return t;
  const window = t.slice(0, 800);
  const hr = /\n\s*-{3,}\s*\n/.exec(window);
  const heading = /\n#{1,6}\s/.exec(window);
  let cut = -1;
  if (hr) cut = hr.index + hr[0].length;
  if (heading && (cut === -1 || heading.index + 1 < cut)) cut = heading.index + 1;
  if (cut <= 0 || cut > 400) return t;
  return t.slice(cut).trimStart();
}

// Repetition-collapse helpers live in ./text-dedup.js so the runtime relay/final
// sanitizer AND the sub-agent passthrough share one guard. Re-exported here to keep
// the existing public import surface (tests, callers) stable.
export { looksLikeDegenerateRepetition, collapseRepeatedMarkdownSections, looksLikeDegenerateLineRepetition, collapseRepeatedLines };

/**
 * Decide whether a turn's single delegation already produced a complete, presentable
 * deliverable that can be surfaced AS-IS — so the main assistant does not run a second
 * full synthesis pass over it (the biggest avoidable per-turn cost on the slow local
 * model, and the source of coordinator↔assistant divergence; audit 5d51862f). Returns
 * the clean deliverable text, or null when the normal synthesis path should run.
 *
 * Deliberately strict: exactly ONE successful delegation this turn, its tool result was
 * tagged a long deliverable ("present … VERBATIM"), and the evidence is a real structured
 * answer (headings/table/bullets) that is not a raw dump / provider error / scaffold.
 */
/**
 * True when a deliverable contains an UNTERMINATED fenced code block — an odd number
 * of ``` fences means one was opened and never closed, i.e. the text was cut off
 * mid-code (the slow local model hit its token/time budget while emitting a large
 * code blob). Such a deliverable is broken (truncated HTML/JS/etc.) and must never be
 * relayed as finished. Purely structural — counts fence lines, no language/lexicon.
 */
export function looksLikeTruncatedCodeDeliverable(text: string): boolean {
  const fences = (text.match(/^[ \t]*```/gm) ?? []).length;
  return fences % 2 === 1;
}

export function extractSingleRelayableDeliverable(
  toolResultMessages: readonly { role: string; content?: string | null }[],
  turnDelegationCount: number,
): string | null {
  if (turnDelegationCount !== 1) return null;
  const delegateResults = toolResultMessages.filter(
    (m) => m.role === "tool" && typeof m.content === "string" && DELEGATE_TOOL_RESULT_RE.test(String(m.content)),
  );
  if (delegateResults.length !== 1) return null;
  const content = String(delegateResults[0]!.content ?? "");
  if (!/TASK COMPLETED\b/i.test(content)) return null;
  if (/TASK FAILED|PARTIAL PROGRESS|TASK COMPLETED \(PARTIAL/i.test(content)) return null;
  // Only the long-deliverable formatting carries this marker; short relays still synthesize.
  if (!/Present the full content below VERBATIM/i.test(content)) return null;
  const m = EVIDENCE_SECTION_RE.exec(content);
  if (!m) return null;
  const evidence = stripLeadingReasoningPreamble(content.slice(m.index + m[0].length).trim());
  if (evidence.length < 800) return null;
  // A degenerate, repetition-looped deliverable must NOT be relayed verbatim. Return
  // null so the normal synthesis pass runs and cleans it into a usable answer — the
  // behaviour that worked before this relay shortcut existed (audit 9fd16384: the slow
  // model looped "Microphone Selection: …" 17× and the relay shipped it as-is).
  if (looksLikeDegenerateRepetition(evidence)) return null;
  // A truncated/unterminated code-blob deliverable must NOT be relayed verbatim. A
  // research agent that improvises a build (audit 61683c52: a single "research THEN
  // build a WebApp" task sent to researcher, which authored a 14 KB single-file HTML
  // blob and ran out of budget at the soft deadline) emits an OPENED ``` fence that
  // never closes — the answer literally ends mid-string. Shipping that as a "finished
  // deliverable" both gives the user broken code AND suppresses the auto-build net
  // that would route the build to a real builder. Unbalanced fences = cut off =
  // not shippable; structural + language-independent (no lexicon).
  if (looksLikeTruncatedCodeDeliverable(evidence)) return null;
  if (REASONING_PREAMBLE_STARTERS.test(evidence)) return null; // couldn't clean the lead-in
  if (
    looksLikeRawToolEvidenceDump(evidence)
    || looksLikeRawSharedFactsDump(evidence)
    || looksLikeProviderErrorEcho(evidence)
    || looksLikeRawWorkspaceToolDump(evidence)
    || looksLikeOrchestrationOnlyEvidence(evidence)
  ) return null;
  const tableRows = (evidence.match(/^\s*\|.+\|\s*$/gm) ?? []).length;
  const headings = (evidence.match(/^#{1,6}\s/gm) ?? []).length;
  const bullets = (evidence.match(/^\s*[-*+]\s+\S/gm) ?? []).length;
  if (tableRows < 4 && headings < 2 && bullets < 6) return null;
  return evidence;
}

const EXPLICIT_SOURCE_RECHECK_RE = /\b(verify|verification|check|recheck|validate|validation|source|sources|citation|citations|cite|official|datasheet|spec(?:ification)?s?|price|prices|supplier|suppliers|mouser|digikey|lcsc|aliexpress|search|lookup|look\s+up|find\s+online|recherch|pruef|pruefe|pruefen|verifiz|validier|quelle|quellen|beleg|belege)\b/i;
const CONTEXTUAL_DECISION_FOLLOW_UP_RE = /\b(ok|okay|thx|thanks|thank\s+you|danke|got\s+it|verstanden|we\s+will|we'll|wir\s+werden|wir\s+nutzen|wir\s+nehmen|i\s+will|ich\s+werde|ich\s+nehme|let'?s|lass\s+uns|use\s+them|using\s+them|go\s+with|nehmen\s+wir)\b/i;

function shouldReusePriorDelegateEvidenceForSourceFollowUp(
  userMessage: string,
  guidance: DynamicTurnGuidance | null | undefined,
  priorEvidence: { evidence: string; itemCount: number } | null,
): boolean {
  if (!guidance?.sourceSensitive || guidance.freshnessSensitive || guidance.artifactSensitive) return false;
  if (!priorEvidence || priorEvidence.evidence.length < 400) return false;
  if (EXPLICIT_SOURCE_RECHECK_RE.test(userMessage)) return false;
  if (/[?？]/.test(userMessage)) return false;
  return userMessage.length <= 700 && CONTEXTUAL_DECISION_FOLLOW_UP_RE.test(userMessage);
}

function buildPriorEvidenceFollowUpPrompt(evidence: { evidence: string; itemCount: number }): string {
  return [
    "CONTINUATION FROM PRIOR EVIDENCE: The latest user message appears to accept or refine a previously researched topic, not request fresh verification.",
    "Use the existing delegated evidence and the user's latest decision to answer directly.",
    "Do NOT call tools or delegate again unless the user explicitly asks for new source checks, current prices, supplier availability, or additional external facts.",
    `Prior delegated evidence preview (${evidence.evidence.length} chars, ${evidence.itemCount} structured items): ${truncatePlainText(evidence.evidence, 2200)}`,
  ].join(" ");
}

/**
 * Reuse-don't-re-research nudge (audit 17f53ed0). The narrow
 * `shouldReusePriorDelegateEvidenceForSourceFollowUp` only fires for source-sensitive
 * follow-ups matching a contextual-decision regex, so a plain refinement like "Mache ein
 * ordentliches Angebot" slipped through and the orchestrator re-ran a 15-minute research
 * mission whose evidence was still in the conversation. This is the broader, purely
 * STRUCTURAL gate: substantial delegated evidence already exists in this session AND the
 * new message introduces no new URL to fetch. It does NOT try to detect "same subject"
 * lexically — instead the injected nudge is conditional ("if it can be answered from the
 * existing evidence"), so a genuinely-new follow-up (e.g. an unrelated question not
 * covered by the prior evidence) still delegates fresh. A new URL is the one hard signal
 * of new external work, so its presence disables the nudge.
 */
export function shouldNudgeSessionEvidenceReuse(input: {
  enabled: boolean;
  narrowReuseAlreadyFired: boolean;
  priorEvidence: { evidence: string; itemCount: number } | null;
  userMessage: string;
}): boolean {
  if (!input.enabled) return false;
  // The narrow source-sensitive reuse path injects a stronger directive — don't double up.
  if (input.narrowReuseAlreadyFired) return false;
  // Need a real prior deliverable's worth of evidence, not a one-liner.
  if (!input.priorEvidence || input.priorEvidence.evidence.length < 800) return false;
  // A URL in the new message is a fresh fetch target = genuinely new external work.
  if (/\bhttps?:\/\//i.test(input.userMessage)) return false;
  return true;
}

export function buildSessionEvidenceReuseNudge(evidence: { evidence: string; itemCount: number }): string {
  const approxKb = Math.max(1, Math.round(evidence.evidence.length / 1000));
  return [
    `[SESSION EVIDENCE] Earlier in THIS session you already gathered sourced research evidence (~${approxKb}KB, ${evidence.itemCount} item(s)) — it is still in the conversation above.`,
    "If the latest request can be answered or REFINED from that evidence (e.g. re-pricing, restructuring, correcting, or extending the existing deliverable), reuse it and do NOT re-run the research.",
    "Delegate fresh research ONLY for specific facts the existing evidence does not already cover.",
  ].join(" ");
}

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

function truncateForContext(value: string, maxChars: number): string {
  const normalized = collapseWhitespace(value);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function truncatePlainText(value: string, maxChars: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripAgentPrefix(value: string): string {
  return value.replace(/^\[[^\]]+\]:\s*/i, "").trim();
}

function stripWorkflowPreamble(value: string): string {
  // Remove "Workflow <name> [scene|job] completed/blocked ...\n\n" system prefix
  // so only the actual deliverable content reaches the orchestrator LLM.
  return value.replace(/^Workflow\s+\S+\s+\[(?:scene|job)\]\s+\S[^\n]*\n\n?/, "").trim();
}

function looksLikeDelegatedFailureEvidence(value: string): boolean {
  const preview = value.trim().slice(0, 600);
  if (!preview) return false;
  if (/^sub-agent produced no final response\.?$/i.test(preview)) return true;
  if (/<\|channel\>\w+/i.test(preview)) return true;
  if (looksLikeProviderErrorEcho(preview)) return true;
  return /^error:/i.test(preview)
    || /\b(no results|not found|unable to|failed to|timed out|cancelled|incomplete|max.{0,20}iterations|could not complete|did not complete|cannot complete|cannot proceed|delegation limit|already failed|not permitted|produced no final response|no usable delegated result returned)\b/i.test(preview)
    || /\bis already running via\s+(?:[a-z0-9_:-]*(?:_agent|_coordinator)|researcher|another agent)\b/i.test(preview)
    || /\bNo (?:agents|workflows) matched\b/i.test(preview)
    || /\b(container error|containerized delegation failed|sandbox (?:bootstrap|startup|start) failed|bootstrap failed|runtime crash(?:ed)?|terminated unexpectedly)\b/i.test(preview)
    || /\b(blocker:|missing source data|required .* unavailable|requested .* unavailable|not available in the current workspace|not available in the workspace|could not be fulfilled with exact figures|cannot be generated at this time|please provide the structured json data to proceed|please provide the source data to proceed|please provide .*json data|i need .*structured json.* to proceed|i need .*data to proceed|task cannot be completed|table does not exist|confirmed non-existent|no source provided the specific .* data)\b/i.test(preview);
}

const CONTINUATION_CUE_RE = /\b(next (logical )?(step|action)|n[äa]chste (logische )?(schritt|aktion)|before summarizing|continue orchestration|continue with|drill down|inspect the contents|fetch the contents|final required action|determine the actual data file format|extract the raw numerical values)\b/i;
const USER_INTERACTION_CUE_RE = /\b(please confirm|confirm .* before|approval required|needs approval|ask the user|missing .* from the user|which one|which option|clarify|need the user to|authorization reference|approved target scope)\b/i;

type PostOrchestrationDisposition = "continue" | "synthesize" | "ask_user" | "failure" | "none";

export function classifyPostOrchestrationDisposition(
  toolResultMessages: Array<LLMMessage & { metadata?: Record<string, unknown> }>,
): PostOrchestrationDisposition {
  const orchestrationResults = toolResultMessages.filter((message) => {
    const text = typeof message.content === "string" ? message.content : "";
    const isWorkflowExecutionResult = /^Workflow\s+.+\s+\[[^\]]+\]\s+(blocked|completed)\./i.test(text);
    return text.includes("Observed evidence:")
      && (
        text.includes("Delegated result from")
        || text.includes("Parallel delegation completed")
        || text.includes("Task graph completed")
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

export function buildModelVisibleToolResult(
  toolName: string,
  resultText: string,
  metadata?: Record<string, unknown>,
): string {
  const fallback = truncateForContext(resultText, 600);

  if (toolName === "delegate_to_agent" || toolName === "swarm_delegate") {
    const agentName = typeof metadata?.["agentName"] === "string" ? String(metadata["agentName"]) : "delegated agent";
    const attemptedAgents = Array.isArray(metadata?.["attemptedAgents"])
      ? (metadata?.["attemptedAgents"] as unknown[]).map(String).filter(Boolean)
      : [];
    const routingReason = metadata?.["routingReason"] && typeof metadata["routingReason"] === "object"
      ? metadata["routingReason"] as Record<string, unknown>
      : undefined;
    const cleaned = stripPresentationFormatting(stripAgentPrefix(resultText));
    const delegationOutcome = typeof metadata?.["delegationOutcome"] === "string" ? String(metadata["delegationOutcome"]) : undefined;
    const hasInterruptedShape = /Partial progress before interruption:|Recovered evidence snippets from completed tools:/i.test(cleaned);
    const rawWorkspaceToolDump = looksLikeRawWorkspaceToolDump(cleaned);
    const partialHasNoUsableEvidence = agentName !== "computer_use_agent"
      && delegationOutcome === "partial"
      && (
        rawWorkspaceToolDump
        || looksLikeInterruptedDelegationWithoutUsableEvidence(cleaned)
        || (!hasInterruptedShape && looksLikeOrchestrationOnlyEvidence(cleaned))
      );
    // A "partial" outcome whose surfaced content is just a regurgitated
    // provider/HTTP error (e.g. LM Studio HTTP 500 HTML page that the
    // soft-deadline synthesis quoted back) is not a useful partial — the
    // model has no real evidence to relay.  Treat it as an outright
    // failure so the parent assistant gets a clear failure signal and
    // can ask the user to retry instead of trying to synthesize an
    // answer from an HTML error page.
    const partialIsProviderErrorEcho = delegationOutcome === "partial" && looksLikeProviderErrorEcho(cleaned);
    const delegationPartial = delegationOutcome === "partial"
      && !partialIsProviderErrorEcho
      && !partialHasNoUsableEvidence;
    const delegationFailed = rawWorkspaceToolDump
      || delegationOutcome === "failure"
      || partialIsProviderErrorEcho
      || partialHasNoUsableEvidence
      || (!delegationPartial && (
        metadata?.["delegationSucceeded"] === false
        || /^error:/i.test(cleaned)
        || looksLikeDelegatedFailureEvidence(cleaned)
      ));

    if (agentName === "computer_use_agent") {
      const evidence = truncatePlainText(cleaned, 1600);
      if (delegationFailed) {
        const parts = [
          `Delegated result from ${agentName} — TASK FAILED.`,
          attemptedAgents.length > 1 ? `Attempts: ${attemptedAgents.join(", ")}.` : "",
          routingReason?.["confidence"] ? `Routing confidence: ${String(routingReason["confidence"])}.` : "",
          "IMPORTANT: This delegated attempt failed. Report the failure honestly using only the explicit evidence below.",
          "Do NOT claim the task was completed.",
          "Do NOT invent root causes like connectivity, firewall, permissions, or configuration unless the evidence explicitly says so.",
          "Do NOT delegate again for the same information in this turn.",
          `Observed evidence:\n${evidence || "No usable delegated result returned."}`,
        ].filter(Boolean);
        return parts.join("\n");
      }
      if (delegationPartial) {
        const parts = [
          `Delegated result from ${agentName} — PARTIAL PROGRESS.`,
          attemptedAgents.length > 1 ? `Attempts: ${attemptedAgents.join(", ")}.` : "",
          routingReason?.["confidence"] ? `Routing confidence: ${String(routingReason["confidence"])}.` : "",
          "IMPORTANT: Use the evidence below. State clearly that the desktop run made progress but was interrupted before full completion.",
          "Do NOT ignore the collected evidence.",
          "Do NOT invent root causes like connectivity, firewall, permissions, or configuration unless the evidence explicitly says so.",
          "Do NOT delegate again for the same information in this turn unless the user asks for another attempt.",
          `Observed evidence:\n${evidence || "No usable delegated result returned."}`,
        ].filter(Boolean);
        return parts.join("\n");
      }
      const parts = [
        `Delegated result from ${agentName} — TASK COMPLETED SUCCESSFULLY.`,
        attemptedAgents.length > 1 ? `Attempts: ${attemptedAgents.join(", ")}.` : "",
        routingReason?.["confidence"] ? `Routing confidence: ${String(routingReason["confidence"])}.` : "",
        "IMPORTANT: Relay ALL specific details from the evidence below (names, numbers, sizes, statuses) in your answer. Do NOT omit items, say 'partially visible', or claim information is 'cut off' if the evidence lists it. The evidence is authoritative.",
        "Do NOT delegate again for the same information — it has already been collected.",
        `Observed evidence:\n${evidence || "No usable delegated result returned."}`,
      ].filter(Boolean);
      return parts.join("\n");
    }

    const partialEvidence = rawWorkspaceToolDump ? null : extractUsefulInterruptedDelegationEvidence(cleaned);
    // When the inner agent surfaced its full delegated specialist body via
    // the "Recovered delegated specialist body (full):" marker (Fix 2), the
    // partial evidence IS the actual completed sub-task answer — bump the
    // cap to the long-deliverable budget so it survives wrapping. Otherwise
    // the parent only sees ~1.6 KB of a 13 KB completed answer.
    const partialEvidenceHasFullBody = /Recovered delegated specialist body \(full\):/i.test(cleaned);
    const partialEvidenceCap = partialEvidenceHasFullBody ? 12_000 : 1600;
    const evidence = rawWorkspaceToolDump
      ? formatRawWorkspaceToolDumpFailure()
      : truncatePlainText(partialEvidence ?? cleaned, partialEvidenceCap);
    if (delegationFailed) {
      const parts = [
        `Delegated result from ${agentName} — TASK FAILED.`,
        attemptedAgents.length > 1 ? `Attempts: ${attemptedAgents.join(", ")}.` : "",
        routingReason?.["confidence"] ? `Routing confidence: ${String(routingReason["confidence"])}.` : "",
        "IMPORTANT: This delegated attempt failed. Report the failure honestly using only the explicit evidence below.",
        "Do NOT claim the task was completed or infer extra causes that are not explicitly present in the evidence.",
        `Observed evidence:\n${evidence || "No usable delegated result returned."}`,
      ].filter(Boolean);
      return parts.join("\n");
    }
    if (delegationPartial) {
      const terminalState = typeof metadata?.["terminalState"] === "string" ? String(metadata["terminalState"]) : undefined;
      const timedOut = terminalState === "timeout";
      const importantNote = timedOut
        ? "IMPORTANT: The specialist timed out. Use only the explicit partial evidence below; state what remains unverified or incomplete instead of filling gaps. Do NOT delegate again for this task in this turn."
        : "IMPORTANT: Use the partial evidence below to continue your workflow. Do NOT treat this as a workflow failure. Proceed with any dependent tools.";
      const parts = [
        `Delegated result from ${agentName} — PARTIAL PROGRESS${timedOut ? " (TIMEOUT)" : ""}.`,
        attemptedAgents.length > 1 ? `Attempts: ${attemptedAgents.join(", ")}.` : "",
        routingReason?.["confidence"] ? `Routing confidence: ${String(routingReason["confidence"])}.` : "",
        importantNote,
        `Observed evidence:\n${evidence || "No usable delegated result returned."}`,
      ].filter(Boolean);
      return parts.join("\n");
    }
    // For long completed deliverables (papers, reports, analyses) and
    // structured tabular/list content (markdown tables, numbered lists with
    // many rows) keep markdown intact and pass the full content so the
    // orchestrator LLM can relay it verbatim. Smaller models are otherwise
    // prone to summarising a 27-row headline table down to 2 rows and
    // appending an invented "(truncated)" marker.
    const tableRowCount = (cleaned.match(/^\s*\|.+\|\s*$/gm) ?? []).length;
    const numberedListCount = (cleaned.match(/^\s*\d{1,3}[.)]\s+\S/gm) ?? []).length;
    const bulletListCount = (cleaned.match(/^\s*[-*+]\s+\S/gm) ?? []).length;
    const looksStructured =
      tableRowCount >= 4 || numberedListCount >= 5 || bulletListCount >= 8;
    const isLongDeliverable = cleaned.length > 2500 || looksStructured;
    const successEvidence = isLongDeliverable
      ? truncatePlainText(stripWorkflowPreamble(stripAgentPrefix(resultText)), effectiveMaxDelegatedResultChars())
      : evidence;
    // A runtime-authored research slice returns gathered EVIDENCE, never the
    // user-facing deliverable — the orchestrator must synthesize the actual
    // answer from it. The VERBATIM instruction (and with it the
    // single-deliverable relay shortcut, which keys on that exact string)
    // shipped a component-spec research dump as the entire answer to a device
    // DESIGN request, skipping synthesis completely (audit b5107ae4).
    const researchSlice = metadata?.["researchSlice"] === true;
    const importantNote = researchSlice
      ? "IMPORTANT: This is gathered research EVIDENCE, not the final deliverable. Write the answer to the user's ORIGINAL request yourself, in the user's language, covering EVERY part of what they asked. Ground every concrete spec, name, number, and recommendation in this evidence and keep the source URLs for the claims you use. Do NOT paste this report verbatim and do NOT invent values that are not in the evidence."
      : isLongDeliverable
        ? "IMPORTANT: Present the full content below VERBATIM to the user. Reproduce EVERY row, bullet, list item, table entry, heading, name, number, date, URL, and source exactly as shown. Do NOT summarize, shorten, rephrase, omit any section, collapse rows into 'and others', insert ellipses, or add markers like '(truncated)', '(abgeschnitten)', '(cut off)', '(Zusammenfassung)' — the evidence is the FULL deliverable, not a snippet. Output it exactly as-is, preserving all headings, bullet points, tables, and structure."
        : "IMPORTANT: Relay ALL specific details from the evidence below (names, numbers, values) in your answer. Do NOT paraphrase with different numbers or names. Do NOT add markers like '(truncated)' or '(abgeschnitten)'.";
    const parts = [
      `Delegated result from ${agentName} — TASK COMPLETED.`,
      attemptedAgents.length > 1 ? `Attempts: ${attemptedAgents.join(", ")}.` : "",
      routingReason?.["confidence"] ? `Routing confidence: ${String(routingReason["confidence"])}.` : "",
      importantNote,
      `Observed evidence:\n${successEvidence || "No usable delegated result returned."}`,
    ].filter(Boolean);
    return parts.join("\n");
  }

  if (toolName === "parallel_delegate") {
    const succeeded = Number(metadata?.["succeeded"] ?? 0);
    const failed = Number(metadata?.["failed"] ?? 0);
    const taskCount = Number(metadata?.["taskCount"] ?? succeeded + failed);
    const evidence = truncatePlainText(stripPresentationFormatting(resultText), 1600);
    return [
      `Parallel delegation completed. Successful tasks: ${succeeded}/${taskCount}. Failed tasks: ${failed}.`,
      "IMPORTANT: Relay ALL specific details from the evidence below (names, numbers, values, statuses) in your answer. Do NOT replace them with guessed details.",
      `Observed evidence:\n${evidence || "No usable delegated result returned."}`,
    ].join("\n");
  }

  if (toolName === "run_task_graph") {
    const completed = Array.isArray(metadata?.["completed"]) ? (metadata?.["completed"] as unknown[]).length : 0;
    const failed = Array.isArray(metadata?.["failed"]) ? (metadata?.["failed"] as unknown[]).length : 0;
    const blocked = Array.isArray(metadata?.["blocked"]) ? (metadata?.["blocked"] as unknown[]).length : 0;
    const evidence = truncatePlainText(stripPresentationFormatting(resultText), 1600);
    const taskGraphStatus = failed > 0 || blocked > 0
      ? `Task graph finished with incomplete status. Nodes completed: ${completed}. Failed: ${failed}. Blocked: ${blocked}.`
      : `Task graph completed. Nodes completed: ${completed}. Failed: ${failed}. Blocked: ${blocked}.`;
    return [
      taskGraphStatus,
      "IMPORTANT: Relay ALL specific details from the evidence below (task states, selected agents, values) in your answer. Do NOT replace them with guessed details.",
      `Observed evidence:\n${evidence || "No usable task-graph result returned."}`,
    ].join("\n");
  }

  if (toolName === "run_workflow") {
    // No saved workflow matched (a routing miss, not a completed run and not a failure):
    // relay the tool's routing guidance verbatim instead of the "Workflow completed.
    // Executed steps" framing, so the model delegates rather than treating it as
    // executed evidence (audit bd3d60dc).
    if (metadata?.["workflowNotFound"] === true) {
      return resultText.trim() || "No saved workflow matched this request. Delegate to mission_coordinator or answer the user directly.";
    }
    const workflowName = typeof metadata?.["workflowName"] === "string" ? String(metadata["workflowName"]) : "workflow";
    const workflowType = typeof metadata?.["workflowType"] === "string" ? String(metadata["workflowType"]) : "workflow";
    const blocked = metadata?.["blocked"] === true;
    const stepCount = Number(metadata?.["stepCount"] ?? 1);
    const executedSteps = Number(metadata?.["executedSteps"] ?? stepCount);
    const evidence = truncatePlainText(stripPresentationFormatting(resultText), 1600);
    // Artifact-bearing completion: the deliverables are FILES attached to the
    // turn, not chat text. Without this pivot the model relays the document
    // body verbatim and ships its truncated head as the final answer
    // (audit 2445da2e: 1600 chars of the paper's TOC ending in "…" while the
    // real paper/deck/notes sat in the attachments).
    const workflowArtifactPaths = Array.isArray(metadata?.["artifacts"])
      ? (metadata["artifacts"] as Array<Record<string, unknown>>)
        .map((artifact) => typeof artifact["outputPath"] === "string" ? String(artifact["outputPath"]) : (typeof artifact["filename"] === "string" ? String(artifact["filename"]) : ""))
        .filter(Boolean)
      : [];
    const completedInstruction = workflowArtifactPaths.length > 0
      ? "IMPORTANT: The workflow's deliverables were SAVED AS FILES and are attached to this message — do NOT paste their contents into your answer. Write a SHORT final summary in the user's language: state what was completed, list EVERY artifact path below with a one-line description, and note anything the evidence marks as incomplete. Do NOT start fresh ad hoc delegation or rerun research for the same request.\n"
        + `Artifact files (already attached):\n${workflowArtifactPaths.map((path) => `- ${path}`).join("\n")}`
      : "IMPORTANT: Treat this as executed workflow output, not a plan. Relay the concrete evidence below and do not claim extra steps were run. Do NOT start fresh ad hoc delegation, create_ephemeral_agent, or rerun research for the same request in this turn unless the workflow evidence itself identifies one smallest corrective follow-up.";
    return [
      `Workflow ${workflowName} [${workflowType}] ${blocked ? "blocked" : "completed"}. Executed steps: ${executedSteps}/${stepCount}.`,
      blocked
        ? "IMPORTANT: This workflow did not complete. Treat the evidence below as a failure report, not as completed research. Do NOT jump straight to drafting-only agents like paper_author or summarizer unless earlier evidence was already collected successfully."
        : completedInstruction,
      `Observed evidence:\n${evidence || "No usable workflow result returned."}`,
    ].join("\n");
  }

  if (toolName === "create_ephemeral_agent") {
    const agentName = typeof metadata?.["agentName"] === "string" ? String(metadata["agentName"]) : "ephemeral agent";
    const rejectedTools = Array.isArray(metadata?.["rejectedTools"]) ? (metadata?.["rejectedTools"] as unknown[]).map(String).filter(Boolean) : [];
    const evidence = truncatePlainText(stripPresentationFormatting(stripAgentPrefix(resultText)), 1600);
    const failed = looksLikeDelegatedFailureEvidence(evidence);
    return [
      `Ephemeral agent ${agentName} ${failed ? "failed" : "completed"}.`,
      rejectedTools.length > 0 ? `Rejected tools: ${rejectedTools.join(", ")}.` : "",
      failed
        ? "IMPORTANT: This ephemeral-agent attempt failed. Report the failure honestly using only the explicit evidence below. Do NOT claim the task was completed or delegated successfully."
        : "IMPORTANT: Relay ALL specific details from the evidence below in your answer.",
      `Observed evidence:\n${evidence || "No usable ephemeral-agent result returned."}`,
    ].filter(Boolean).join("\n");
  }

  if (toolName === "search_agents") {
    const evidence = truncatePlainText(stripPresentationFormatting(resultText), 1600);
    return [
      "Agent routing suggestions only. No delegation has happened yet.",
      "IMPORTANT: Treat this as candidate-selection guidance, not as proof that any task was routed or executed.",
      "If this turn ends without a completed delegate_to_agent call, do NOT tell the user that work was routed to any suggested agent.",
      `Observed evidence:\n${evidence || "No routing suggestions returned."}`,
    ].join("\n");
  }

  if (toolName === "search_workflows") {
    const evidence = truncatePlainText(stripPresentationFormatting(resultText), 1600);
    return [
      "Workflow catalog suggestions only. No workflow has been executed yet.",
      "IMPORTANT: Treat this as reusable-workflow discovery, not as proof that any scene or job ran.",
      "If this turn ends without a completed run_workflow call, do NOT tell the user that a workflow was executed.",
      "If concrete matches were returned, prefer run_workflow next instead of delegate_to_agent or other ad hoc orchestration.",
      `Observed evidence:\n${evidence || "No workflow matches returned."}`,
    ].join("\n");
  }

  if (toolName === "list_agents") {
    const evidence = truncatePlainText(stripPresentationFormatting(resultText), 1600);
    return [
      "Agent search results only. No delegation has happened yet.",
      "IMPORTANT: Treat this as candidate-selection guidance, not as proof that any task was routed or executed.",
      "If this turn ends without a completed delegate_to_agent call, do NOT tell the user that work was routed to any suggested agent.",
      `Observed evidence:\n${evidence || "No agent candidates returned."}`,
    ].join("\n");
  }

  // Informational capability directory the user explicitly asked for — relay it
  // in full (generously capped) instead of the small generic fallback. The full
  // list is below; explicitly tell the model not to abbreviate or claim
  // truncation (the slow local model otherwise lists only the first few).
  if (toolName === "agent_catalog") {
    return [
      "Complete specialist agent directory below — it is NOT truncated.",
      "If the user asked which agents exist or what they can do, list EVERY entry below. Do NOT abbreviate, sample, summarize to a few, or claim the list was cut off.",
      truncatePlainText(resultText, 12_000),
    ].join("\n");
  }

  return fallback;
}

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
    return await _phaseTimingsStore.run(Object.create(null) as Record<string, number>, () => runTurnImpl(opts));
  } finally {
    markOrchestratorIdle();
  }
}

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
  const timeoutHandle = turnAbort
    ? setTimeout(() => turnAbort.abort(), turnTimeoutMs)
    : undefined;

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
      _runTurn(opts, signal, turnAbort?.signal ?? inertAbort.signal));
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

/**
 * Why a turn threw — used to decide whether it is a recordable failure or an
 * intentional cancel. A caller-initiated abort with no turn-timeout and no
 * Warden cancel is a user stop or a superseding newer turn (chat.cancel / a
 * fresh message), which must NOT clutter the transcript with a failure marker.
 */
export type TurnFailureKind = "timeout" | "warden_abort" | "error" | "cancelled";

export function classifyTurnFailure(flags: {
  callerAborted: boolean;
  turnTimedOut: boolean;
  wardenAborted: boolean;
}): TurnFailureKind {
  if (flags.turnTimedOut) return "timeout";
  if (flags.wardenAborted) return "warden_abort";
  if (flags.callerAborted) return "cancelled";
  return "error";
}

export function turnFailureMarkerText(kind: TurnFailureKind): string {
  switch (kind) {
    case "timeout":
      return "This turn timed out before it could finish — the request was large or the model was slow. Please retry, lower the effort/scope, or break it into smaller parts.";
    case "warden_abort":
      return "This turn was stopped by the safety monitor before it completed. Please retry, or rephrase the request.";
    default:
      return "I wasn't able to complete this turn due to an error. Please retry, or rephrase the request — breaking a complex task into smaller parts usually helps.";
  }
}

/**
 * Record a turn failure so it is never silently absent from the session record:
 * emit a `turn_failed` audit event AND persist a recoverable assistant marker to
 * the transcript (which also advances the session's updatedAt). Intentional
 * cancels are skipped. Returns the marker text, or null when nothing was recorded.
 */
export function recordTurnFailure(session: AgentSession, err: unknown, kind: TurnFailureKind): string | null {
  if (kind === "cancelled") return null;
  const errorMessage = err instanceof Error ? err.message : String(err);
  logAudit("turn_failed", { kind, error: errorMessage }, {
    sessionId: session.id,
    channel: session.channel,
    severity: "error",
  });
  const text = turnFailureMarkerText(kind);
  session.addMessage({ role: "assistant", content: text, metadata: { turnFailed: true, failureKind: kind } });
  return text;
}

/**
 * Turn invariant — a chat turn must never hand the user a blank response.
 *
 * Most terminals build a non-empty message, but some suppression paths (e.g. a
 * tool call dropped as synthesis-required with no accompanying text, or an
 * unexpected early return) can leave `response` empty. This single chokepoint
 * on the runTurn boundary guarantees the user is never met with silence: an
 * empty/whitespace response is replaced with a graceful, recoverable message
 * and the occurrence is audited so the underlying cause stays visible.
 *
 * Non-empty responses pass through unchanged.
 */
export function finalizeTurnOutput(out: TurnOutput, sessionId: string): TurnOutput {
  if (out.response && out.response.trim().length > 0) return out;
  logAudit("guardrail_flagged", {
    type: "empty_response_recovered",
    blocked: out.blocked,
    finishReason: out.performance?.finishReason ?? "unknown",
  }, { sessionId, severity: "warn" });
  return {
    ...out,
    response: "I wasn't able to produce a complete answer this turn. Please retry, or rephrase the request — breaking a complex task into smaller parts usually helps.",
  };
}

async function _runTurn(opts: RunTurnOptions, signal: AbortSignal, timeoutSignal: AbortSignal): Promise<TurnOutput> {
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
  const rl = await checkRateLimit(session.id, "request");
  if (!rl.allowed) {
    logAudit("rate_limited", { remaining: 0, resetAt: rl.resetAt }, { sessionId: session.id });
    return blocked("Rate limit exceeded. Please wait before sending another message.");
  }

  // ── Input guardrail ───────────────────────────────────────────────────────
  // Scene/job runs carry the operator-authored task text from config as the
  // "message" (channel "scene"). That is trusted input, so the prompt-injection
  // scanner flags but does not block it — otherwise a scene's own security
  // instruction (e.g. "Never expose credential values") would hard-block the run
  // with zero turns. Untrusted channels (chat, telegram, email, webhook, a2a, …)
  // remain strictly blocked.
  const trustedWorkflowInput = session.channel === "scene";
  const inputCheck = checkInput(userMessage, { trusted: trustedWorkflowInput });
  if (!inputCheck.allowed) {
    const details = inputCheck.reason ?? "Prompt injection detected";
    logAudit("guardrail_blocked", { type: "input", reason: details, patterns: inputCheck.detectedPatterns }, {
      sessionId: session.id,
      severity: "warn",
    });
    guardrailEvents.push({ type: "input_blocked", details });
    return blocked(`I can't process that message: ${details}`);
  }

  if (inputCheck.detectedPatterns && inputCheck.detectedPatterns.length > 0) {
    guardrailEvents.push({ type: "input_flagged", details: inputCheck.reason ?? "" });
    logAudit("guardrail_flagged", { patterns: inputCheck.detectedPatterns }, { sessionId: session.id, severity: "warn" });
  }

  const moderatedInput = await moderateInputText(userMessage);
  if (moderatedInput?.blocked) {
    const details = `Model moderation blocked input: ${moderatedInput.summary}`;
    logAudit("guardrail_blocked", { type: "input_model", reason: details, categories: moderatedInput.categories }, {
      sessionId: session.id,
      severity: "warn",
    });
    guardrailEvents.push({ type: "input_model_blocked", details });
    return blocked(`I can't process that message: ${details}`);
  }

  if (moderatedInput?.flagged) {
    const details = `Model moderation flagged input: ${moderatedInput.summary}`;
    guardrailEvents.push({ type: "input_model_flagged", details });
    logAudit("guardrail_flagged", { type: "input_model", categories: moderatedInput.categories }, { sessionId: session.id, severity: "warn" });
  }

  // ── Build message history ─────────────────────────────────────────────────
  const userMetadata: Record<string, unknown> = {};
  if (opts.userDisplayContent?.trim()) {
    userMetadata["displayContent"] = opts.userDisplayContent.trim();
  }
  if (opts.userAttachments?.length) {
    userMetadata["attachments"] = opts.userAttachments;
  }
  session.addMessage({
    role: "user",
    content: userMessage,
    ...(Object.keys(userMetadata).length > 0 ? { metadata: userMetadata } : {}),
  });
  session.pruneTransientTurnSystemMessages();
  session.incrementTurn();

  logAudit("message_received", { length: userMessage.length }, {
    sessionId: session.id,
    channel: session.channel,
    userId: session.userId,
  });

  // ── Deterministic assistant-rename persistence ──────────────────────────────
  // An explicit naming command ("Ab jetzt heißt du Luna", "your name is now …")
  // must actually persist. Local models routinely just acknowledge it ("saved!")
  // without calling assistant_personality_update (audit b71523fb), so we set the
  // name here too — making the name durable AND the model's claim truthful.
  try {
    const namedAs = extractAssistantName(userMessage);
    if (namedAs) {
      const { setMainAssistantName, loadMainAssistantPersonality } = await import("../personality/service.js");
      const before = loadMainAssistantPersonality().identity.name;
      setMainAssistantName(namedAs, "user");
      if (before !== namedAs) log.info({ sessionId: session.id, name: namedAs }, "assistant renamed (deterministic persist)");
    }
  } catch (err) {
    log.warn({ err }, "deterministic assistant-name persist failed");
  }

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
  if (detectedDynamicGuidance === null && !hasTurnAttachments && getConfig().receptionist?.enabled) {
    const fastLane = await timedPhase("receptionistFastLane", () => tryReceptionistFastLane(userMessage, signal).catch(() => null));
    if (fastLane) {
      session.addMessage({ role: "assistant", content: fastLane.response });
      opts.onChunk?.(fastLane.response);
      logAudit("message_received", { fastLane: true, length: fastLane.response.length }, {
        sessionId: session.id,
        channel: session.channel,
        userId: session.userId,
      });
      return {
        response: fastLane.response,
        toolCallsExecuted: 0,
        guardrailEvents,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        blocked: false,
        performance: {
          turnDurationMs: Date.now() - turnStartedAt,
          llmCalls: 1,
          llmTimeMs: 0,
          toolCallsRequested: 0,
          toolExecutionTimeMs: 0,
          systemPromptChars: 0,
          collapsedHistoryMessages: 0,
          collapsedHistoryChars: 0,
          promptChars: userMessage.length,
          completionChars: fastLane.response.length,
          toolIterations: 0,
          finishReason: "receptionist_fast_lane",
          blocked: false,
        },
      };
    }
  }

  // ── Document RAG augmentation ───────────────────────────────────────────────
  // Runs AFTER the fast lane, so trivial turns never pay the engram search cost.
  // Auto-ingests files attached this turn into the session corpus (engram, via
  // the file-MCP extractor) and injects the most relevant excerpts as a transient
  // [DOCUMENT CONTEXT] system message so the assistant answers from the source.
  // No-op when documentRag is disabled / engram is unreachable. Never fatal.
  // On a userOwnFacts turn with the profile prefetch active, the per-turn RAG is the
  // SINGLE document source: it uses the profile-biased query (reliable CV recall) and the
  // prefetch then skips its own duplicate doc retrieval. Captured so the prefetch knows
  // whether the CV was already surfaced — and so it cannot be lost (the [DOCUMENT CONTEXT]
  // here runs first and unconditionally).
  const userOwnFactsTurn = detectedDynamicGuidance?.userOwnFacts === true
    && getConfig().orchestration?.userProfilePrefetch === true;
  const ragQuery = userOwnFactsTurn ? buildProfileBiasedQuery(userMessage) : userMessage;
  let documentRagFoundDocs = false;
  try {
    const { augmentTurnWithDocuments } = await import("../retrieval/document-rag.js");
    const aug = await timedPhase("documentRag", () => augmentTurnWithDocuments({
      ctx: { sessionId: session.id, ...(session.userId ? { userId: session.userId } : {}) },
      workspacePath: session.getWorkspacePath(),
      query: ragQuery,
      attachments: opts.userAttachments,
    }));
    if (aug.ingested > 0 || aug.failed > 0) {
      logAudit("document_rag_ingest", { ingested: aug.ingested, failed: aug.failed }, { sessionId: session.id });
    }
    if (aug.contextBlock) {
      session.addMessage({ role: "system", content: `[DOCUMENT CONTEXT]\n${aug.contextBlock}` });
      documentRagFoundDocs = true;
    }
  } catch (err) {
    log.warn({ err }, "document RAG augmentation failed — continuing without it");
  }

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

  // One bounded corrective build for the completion QA gate: when the user asked to BUILD an
  // artifact and none was produced, delegate to the right builder, record the assistant+tool
  // pair so the artifact surfaces as a download, and synthesize a confirmation. Returns the
  // confirmation message if a real artifact was produced, else null (caller keeps its draft).
  const runCorrectiveBuild = async (buildContext: string): Promise<string | null> => {
    if (qaCorrectiveBuildUsed || signal.aborted) return null;
    qaCorrectiveBuildUsed = true;
    const builderAgent = deliverableIntent.builder;
    logAudit("guardrail_flagged", {
      type: "final_qa_corrective_build_delegated",
      builderAgent,
      contextChars: buildContext.length,
    }, { sessionId: session.id, channel: session.channel, severity: "warn" });
    opts.onStatus?.({ phase: "guardrail", message: "Der QA-Check verlangt das angeforderte Artefakt — ich lasse es jetzt vom passenden Spezialisten erstellen.", iteration: iterationCount });
    // Resume-over-regenerate: if an earlier attempt this turn left a partial deliverable
    // that looks cut off mid-document, finish THAT file in place instead of re-emitting the
    // whole thing — saves the tokens/latency of regeneration and avoids hitting the same
    // cut-off (the user's write_file/resume idea). Gated + structural (file-incompleteness,
    // not topic); a complete-but-wrong file probes null and falls through to a fresh build.
    const resumeTarget = effectiveOrchestration().resumePartialOnCorrectiveBuild
      ? selectCorrectiveResumeTarget(
          collectTurnArtifactAttachments(session),
          (rel) => {
            const wsRoot = typeof toolContext.workspacePath === "string" ? toolContext.workspacePath : "";
            return wsRoot ? artifactFileLooksTruncated({ path: join(wsRoot, rel), filename: rel }) : null;
          },
        )
      : null;
    if (resumeTarget) {
      logAudit("guardrail_flagged", {
        type: "final_qa_corrective_build_resume_partial",
        builderAgent,
        relativePath: resumeTarget.relativePath,
        truncationReason: resumeTarget.truncationReason,
      }, { sessionId: session.id, channel: session.channel, severity: "warn" });
    }
    const buildTask = resumeTarget
      ? ("RESUME TASK — finish the partial deliverable that is ALREADY on disk; do NOT regenerate it. "
        + `The file \`${resumeTarget.relativePath}\` was started by an earlier attempt this turn but is INCOMPLETE (${resumeTarget.truncationReason}). `
        + `FIRST read_file \`${resumeTarget.relativePath}\` to see exactly how far it got, THEN continue it IN PLACE: append the missing remainder with write_file mode:"append" (same path) in SMALL bounded chunks until the document terminates correctly (close every open tag / make the JSON parse), or use edit_file to repair one specific broken region. `
        + "Do NOT rewrite the file from the top, do NOT create a new file, and do NOT call generate_website/generate_presentation — regenerating discards the work already on disk and risks the same cut-off. "
        + "Use ONLY facts present in the context or shared findings; do NOT re-research. "
        + `NEVER paste the file's code into your reply — it is attached. Final reply = a SHORT summary plus the file path (${resumeTarget.relativePath}).\n\nOriginal request:\n`
        + userMessage)
      : builderAgent === "content_writer"
      ? ("BUILD TASK — produce the requested deliverable NOW from the verified findings/context. "
        + "Do NOT re-research. Use ONLY facts present in the context or shared findings; cite source URLs where relevant. "
        + "If it is an HTML page / reveal.js presentation, author compact content and let generate_presentation/generate_website assemble it, or build the file incrementally with write_file mode:\"append\" — never one giant write.\n\nOriginal request:\n"
        + userMessage)
      // The app task mandates ONE self-contained FILE but INCREMENTAL writes: telling the
      // slow model to fit the whole app in one write_file call made it emit the entire app
      // as a single giant tool-call argument, blow the completion cap mid-arguments, and
      // fail with "path is required" — it then fell back to generate_website and shipped a
      // 4KB static welcome page instead of the app (audit c2f76a00). generate_website is
      // explicitly forbidden here: it renders markdown into static pages, never an app.
      : ("BUILD TASK — build the requested app NOW as ONE REAL FILE in the workspace, not as a prose answer. "
        + "Use ONLY facts/content present in the context or shared findings; do NOT re-research. "
        + "Build a SINGLE self-contained index.html: ALL CSS in an inline <style>, ALL JavaScript in an inline <script>, data (questions, items, etc.) embedded INLINE so it runs from the file with no server, and every control functional. Do NOT create or reference separate ./app.js or ./styles.css files — a multi-file build that runs out of time leaves a BROKEN app, whereas one self-contained file always runs. "
        + "WRITE THE FILE IN BOUNDED CHUNKS: first write_file with mode:\"create\" for the head + styles + the opening of the body, then 2-4 write_file calls with mode:\"append\" (same path) for the markup, the data, and the script — each call SMALL enough to finish well within your output budget. NEVER try to emit the entire app in ONE write_file call (the arguments get cut off mid-generation and the write fails), and do NOT use generate_website — it produces a static markdown page, not an interactive app. "
        + "START WRITING IMMEDIATELY: your FIRST tool call is the write_file mode:\"create\" for index.html — no exploratory reads first. If the context above has no usable facts or data, generate representative sample content from your own knowledge of the topic and build with that. "
        + "NEVER paste the app's code into your reply — that is a failure. Your final reply is a SHORT summary plus the entry file path (index.html).\n\nOriginal request:\n"
        + userMessage);
    // Blueprint first (the model's own rescued spec — features, data shape, UI), then the
    // gathered facts. Without the spec the builder only knows the one-line user request.
    const buildContextWithSpec = [
      stashedBuilderTaskSpec ? `BUILD SPEC (written by the orchestrator earlier this turn — implement THIS):\n${stashedBuilderTaskSpec.slice(0, 2_500)}` : "",
      buildContext.trim(),
    ].filter(Boolean).join("\n\n");
    let buildResultMetadata: Record<string, unknown> | undefined;
    let buildResultOutput = "";
    try {
      const buildResult = await executeTool("delegate_to_agent", {
        agentName: builderAgent,
        task: buildTask,
        ...(buildContextWithSpec ? { context: buildContextWithSpec.slice(0, 10_000) } : {}),
        // Operator Stop means "build now from what we gathered," so this one bounded
        // build delegation runs even when the stop latch is set (audit 453a263e).
      }, { ...toolContext, allowDelegationAfterOperatorStop: true });
      _turnDelegationCount += 1;
      buildResultMetadata = buildResult.metadata;
      buildResultOutput = buildResult.success ? buildResult.output : "";
      // executeTool here runs OUTSIDE the main tool loop; record a well-formed assistant+tool
      // pair so the built artifact surfaces as a clickable attachment (collectTurnArtifactAttachments
      // only reads tool-role history) and history stays valid (audit 65f46046).
      const buildCallId = `qabuild_${Date.now().toString(36)}`;
      session.addMessage({
        role: "assistant",
        content: "",
        tool_calls: [{ id: buildCallId, type: "function", function: { name: "delegate_to_agent", arguments: JSON.stringify({ agentName: builderAgent, task: "BUILD TASK (final-QA corrective build)" }) } }],
      });
      session.addMessage({
        role: "tool",
        content: (buildResult.success ? buildResult.output : (buildResult.error?.trim() ? `Error: ${buildResult.error}` : buildResult.output)).slice(0, 4_000),
        tool_call_id: buildCallId,
        metadata: buildResult.metadata,
      });
    } catch (err) {
      log.warn({ err, sessionId: session.id }, "Final-QA corrective build delegation failed");
    }
    const builtArtifacts: Array<Record<string, unknown>> = [];
    if (buildResultMetadata) extractArtifactsFromMetadata(buildResultMetadata, builtArtifacts, new Set<string>());
    if (builtArtifacts.length === 0) {
      for (const a of collectTurnArtifactAttachments(session)) builtArtifacts.push(a);
    }
    let harvestedIncomplete = false;
    if (builtArtifacts.length === 0) {
      // HARVEST (audit 0ac7d3fc): the builder "succeeded" but wrote no file — its timeout
      // synthesis pasted the complete app (15KB <!DOCTYPE html>) into its RESULT text
      // instead. The content exists; writing it to a file is deterministic work the
      // runtime does itself rather than failing the whole turn over a missed tool call.
      const inlineDoc = extractInlineHtmlDocument(buildResultOutput);
      if (inlineDoc) {
        harvestedIncomplete = !looksLikeCompleteHtmlDocument(inlineDoc);
        try {
          const harvestWrite = await executeTool("write_file", { path: "app/index.html", content: inlineDoc }, toolContext);
          if (harvestWrite.success) {
            const harvestCallId = `qaharvest_${Date.now().toString(36)}`;
            session.addMessage({
              role: "assistant",
              content: "",
              tool_calls: [{ id: harvestCallId, type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "app/index.html", note: "harvested from builder's inline draft" }) } }],
            });
            session.addMessage({
              role: "tool",
              content: harvestWrite.output.slice(0, 1_000),
              tool_call_id: harvestCallId,
              metadata: harvestWrite.metadata,
            });
            if (harvestWrite.metadata) extractArtifactsFromMetadata(harvestWrite.metadata, builtArtifacts, new Set<string>());
            logAudit("guardrail_flagged", {
              type: "final_qa_corrective_build_harvested_inline",
              chars: inlineDoc.length,
              complete: !harvestedIncomplete,
            }, { sessionId: session.id, channel: session.channel, severity: "warn" });
          }
        } catch (err) {
          log.warn({ err, sessionId: session.id }, "Harvest write of builder's inline document failed");
        }
      }
    }
    if (builtArtifacts.length === 0) return null;
    const paths = builtArtifacts
      .map((a) => (typeof a["relativePath"] === "string" && a["relativePath"] ? a["relativePath"] : (typeof a["filename"] === "string" ? a["filename"] : "")))
      .filter((p): p is string => Boolean(p));
    // Ground the confirmation in the ARTIFACT FACTS so it cannot advertise features the
    // build never produced (audit c2f76a00: the actual artifact was a 4KB single static
    // page, but the confirmation promised an exam simulator, flashcards, and progress
    // tracking — a false-completion one level down: the file exists but isn't the app).
    const artifactFacts = builtArtifacts
      .map((a) => {
        const name = (typeof a["relativePath"] === "string" && a["relativePath"]) ? a["relativePath"] : (typeof a["filename"] === "string" ? a["filename"] : "artifact");
        const size = typeof a["size"] === "number" ? ` (${Math.max(1, Math.round(Number(a["size"]) / 1024))} KB)` : "";
        return `${String(name)}${String(size)}`;
      })
      .join(", ");
    const synth = await forceSynthesis(
      session, provider, signal,
      "The requested artifact has just been BUILT by the build specialist and is ALREADY attached to this message as a downloadable file. "
      + `ARTIFACT FACTS (the only ground truth about what was built): ${artifactFacts}. `
      + (harvestedIncomplete ? "IMPORTANT: the file was recovered from a draft that was CUT OFF before the end — tell the user plainly that the app file is incomplete (it may not run yet) and offer to finish it. " : "")
      + "Confirm to the user in the SAME language as their request: state that the file was created, give its path(s) and size, and summarize ONLY what the builder's own report explicitly says it implemented — do NOT advertise features (quiz, simulator, flashcards, tracking, …) that the report does not state were built, and if the artifact is small or minimal, say so plainly and offer to extend it. "
      + "Do NOT dump raw evidence and do NOT paste the file's HTML/CSS/JS code or any fenced code block — the file is attached, so inlining its code is redundant and confusing.",
    );
    // Belt-and-suspenders: the slow model sometimes ignores the no-code instruction and
    // pastes a large (often fabricated, non-matching) code block — see audit ce8e2128 where
    // the chat dumped a different inline HTML than the built file. The artifact is already a
    // download, so a big fenced block in the confirmation is always noise; strip it.
    const synthDeFenced = synth ? stripLargeCodeFences(synth) : null;
    const candidate = synthDeFenced ? sanitizeUserFacingAssistantResponse(synthDeFenced, iterationCount) : null;
    logAudit("guardrail_flagged", {
      type: "final_qa_corrective_build_synthesized",
      artifacts: paths.length,
      synthesized: Boolean(candidate && candidate.trim().length >= 80),
    }, { sessionId: session.id, channel: session.channel, severity: "warn" });
    return candidate && candidate.trim().length >= 80
      ? candidate
      : `Die angeforderte Datei wurde erstellt: ${paths.join(", ")}.\n\n(The requested file was built: ${paths.join(", ")}.)`;
  };

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
  const runCorrectiveReroute = async (): Promise<string | null> => {
    if (signal.aborted) return null;
    logAudit("guardrail_flagged", {
      type: "fabricated_zero_work_reroute_delegated",
      userMessageChars: userMessage.length,
    }, { sessionId: session.id, channel: session.channel, severity: "warn" });
    opts.onStatus?.({ phase: "guardrail", message: "Die vorherige Antwort war nicht durch ausgeführte Arbeit gedeckt — ich leite die Anfrage an den passenden Spezialisten weiter.", iteration: iterationCount });
    try {
      const rerouteResult = await executeTool("delegate_to_agent", {
        task: userMessage,
      }, { ...toolContext, allowDelegationAfterOperatorStop: true });
      _turnDelegationCount += 1;
      // Record a well-formed assistant+tool pair (same as the corrective build) so the
      // delegated evidence is in history and any artifacts surface as attachments.
      const rerouteCallId = `qareroute_${Date.now().toString(36)}`;
      session.addMessage({
        role: "assistant",
        content: "",
        tool_calls: [{ id: rerouteCallId, type: "function", function: { name: "delegate_to_agent", arguments: JSON.stringify({ task: "REROUTE (zero-work fabrication guard)" }) } }],
      });
      session.addMessage({
        role: "tool",
        content: (rerouteResult.success ? rerouteResult.output : (rerouteResult.error?.trim() ? `Error: ${rerouteResult.error}` : rerouteResult.output)).slice(0, 4_000),
        tool_call_id: rerouteCallId,
        metadata: rerouteResult.metadata,
      });
      if (!rerouteResult.success) return null;
      const rerouteOutput = rerouteResult.output;
      if (/TASK FAILED|PARTIAL PROGRESS|TASK COMPLETED \(PARTIAL/i.test(rerouteOutput)) return null;
      const evidenceMatch = EVIDENCE_SECTION_RE.exec(rerouteOutput);
      const body = stripLeadingReasoningPreamble(
        (evidenceMatch ? rerouteOutput.slice(evidenceMatch.index + evidenceMatch[0].length) : rerouteOutput).trim(),
      );
      if (!body || looksLikeDegenerateRepetition(body) || looksLikeTruncatedCodeDeliverable(body)) return null;
      return body;
    } catch (err) {
      log.warn({ err, sessionId: session.id }, "Zero-work fabrication reroute delegation failed");
      return null;
    }
  };
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
          const finalResponse = sanitizeUserFacingAssistantResponse(synthesized, iterationCount) || synthesized;
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
            const finalResponse = sanitizeUserFacingAssistantResponse(synthesized, iterationCount) || synthesized;
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

    let systemPrompt = session.getSystemPrompt();
    // Split orchestration prompt (agents.performance.splitOrchestrationPrompt, default off): the
    // ~13KB orchestration block (Swarm Rules → Orchestration Strategy) is only needed on turns that
    // actually orchestrate. Lift it out of the always-on base so a direct-answer turn pays a roughly
    // half-size prompt, and inject it back ONLY when the turn shows orchestration intent (the per-turn
    // classifier fired). The delegation TOOLS stay available regardless, so a misclassified turn loses
    // routing GUIDANCE, not capability; the honesty/core sections stay in the lean base either way.
    // Marker-based + guarded (a custom/absent prompt is left untouched), and the lean core stays the
    // cacheable KV prefix for both paths.
    let orchestrationModuleMsg = "";
    if (getConfig().agents.performance.splitOrchestrationPrompt === true) {
      const { leanBase, orchestrationModule } = splitOrchestrationModule(systemPrompt);
      if (orchestrationModule) {
        systemPrompt = leanBase;
        // Inject the module only on turns that actually ROUTE — a delegation-intent classifier
        // flag, an artifact/app/deck/site build, or a composed multi-part deliverable. The mere
        // PRESENCE of guidance is not enough: the direct-answer classes (userOwnFacts,
        // inlineAnalyticalContent, durableMemorySensitive, assistantNaming) also produce a
        // non-null guidance object, but their prompts say recall/store/answer-directly and never
        // delegate — so gating on `!!initialDynamicGuidance` re-injected the ~13KB module on
        // exactly the turn class the split targets (e.g. a CV-fit question), defeating it. Gate
        // on the orchestration-intent SUBSET instead. Delegation tools stay available regardless,
        // so a misclassified turn loses routing prose, not capability.
        const g = initialDynamicGuidance;
        const orchestrationIntent = !!g && (g.freshnessSensitive || g.sourceSensitive || g.mailSensitive
          || g.computerAccessSensitive || g.serverAccessSensitive || g.pentestMethodologySensitive
          || g.swarmMaintenanceSensitive || g.artifactSensitive);
        const needsOrchestrationModule = orchestrationIntent
          || looksLikeArtifactCreationRequest(userMessage)
          || looksLikeComposedGuideRequest(userMessage);
        if (needsOrchestrationModule) orchestrationModuleMsg = orchestrationModule;
      }
    }
    const temporalContext = buildTemporalContextPrompt();
    const dynamicGuidance = iterationCount === 0 ? initialDynamicGuidance : null;
    // Lean context injection: when on, the heavy per-turn memory/user-model/skill/
    // flow/trajectory blocks are not pushed into the prompt — the model pulls them
    // on demand via recall_context (see config.agents.performance.leanContextInjection).
    // This also skips the retrieval calls entirely, saving latency on turns that
    // don't need that context.
    const leanContextInjection = getConfig().agents.performance.leanContextInjection === true;
    const injectTurnContext = iterationCount === 0 && !leanContextInjection;
    let flowGuidance = injectTurnContext
      ? formatFlowMemoryGuidance(session.getWorkspacePath(), userMessage, { limit: 3 })
      : "";
    const languageAndIdentityGuidance = iterationCount === 0
      ? buildLanguageAndIdentityTurnGuidance(userMessage)
      : "";
    // Memory guidance and procedural-skill guidance are independent and each do a
    // query embedding, so run them concurrently instead of serially on time-to-first
    // -LLM-call. (formatFlowMemoryGuidance above is synchronous — it stays out of the
    // batch.) Skills surface reusable approaches the swarm distilled; guidance only.
    const skillRetrievalEnabled = injectTurnContext && getConfig().skillLibrary.enabled;
    // Discovery prefetch (staged orchestration S4): start it HERE so its embedding
    // round-trip OVERLAPS the memory+skill embeddings below instead of running serially
    // after them — all three independent retrievals fire concurrently, shaving an
    // embedding round-trip off time-to-first-LLM-call on escalated turns. Soft head
    // start (not a gate), compact + droppable, flag-gated default-off; best-effort —
    // never blocks the turn (errors and the timeout both resolve to an empty capsule).
    const DISCOVERY_PREFETCH_BUDGET_MS = 2500;
    const discoveryPrefetchPromise: Promise<string> =
      iterationCount === 0 && getConfig().orchestration?.discoveryPrefetch
        ? timedPhase("discoveryPrefetch", async () => {
            // HARD latency cap: the embedding round-trip behind the capsule can stall on
            // a cold/queued embed backend (observed ~15s on a busy LM Studio). Bound it
            // so a slow prefetch is abandoned (empty capsule) rather than delaying the
            // turn; the model then discovers on demand.
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              return await Promise.race([
                prefetchCapabilityCandidates(userMessage),
                new Promise<string>((resolve) => { timer = setTimeout(() => resolve(""), DISCOVERY_PREFETCH_BUDGET_MS); }),
              ]);
            } finally {
              if (timer) clearTimeout(timer);
            }
          }).catch(() => "")
        : Promise.resolve("");
    // Proactive user-profile prefetch (orchestration.userProfilePrefetch, default-off,
    // eval-gated): on a userOwnFacts turn (a question about the user's OWN background /
    // skills / fit), retrieve their memory records + attached documents (an uploaded
    // CV/profile) up-front and inject the evidence — or an authoritative confirmed-empty
    // marker — so the model answers from a REAL lookup instead of fabricating or admitting
    // blindly (the audited toolCalls=0 "I have no info about you" failure). Started HERE so
    // it OVERLAPS the memory/skill/discovery embeddings; bounded by a hard latency cap so a
    // slow/cold embed backend degrades to "" (the reworded retrieve-first digest then still
    // covers it). Fires ONLY on the narrow self-referential class → trivial turns pay nothing.
    // Generous budget: the engram embedding + Qwen rerank for the profile lookup can
    // take a few seconds, and missing the CV is worse than a slightly slower userOwnFacts
    // turn. Still capped so a stalled embed backend degrades to "" (the per-turn RAG then
    // covers it) rather than hanging the turn.
    const PROFILE_PREFETCH_BUDGET_MS = 8000;
    const userProfilePrefetchPromise: Promise<string> =
      iterationCount === 0
        && dynamicGuidance?.userOwnFacts === true
        && getConfig().orchestration?.userProfilePrefetch === true
        ? timedPhase("userProfilePrefetch", async () => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              return await Promise.race([
                buildUserProfileEvidence(session.getWorkspacePath(), userMessage, session.id, session.userId, {
                  // DEDUP: the per-turn RAG above already retrieved + injected the CV with the
                  // same profile-biased query, so skip the duplicate doc retrieval here and add
                  // only memory + the right confirmed-empty signal.
                  skipDocRetrieval: true,
                  documentsAlreadyInjected: documentRagFoundDocs,
                }),
                new Promise<string>((resolve) => { timer = setTimeout(() => resolve(""), PROFILE_PREFETCH_BUDGET_MS); }),
              ]);
            } finally {
              if (timer) clearTimeout(timer);
            }
          }).catch(() => "")
        : Promise.resolve("");
    const [memoryGuidanceText, skillRetrieved, prefetchedDiscoveryCapsule, userProfileEvidence] = await Promise.all([
      injectTurnContext
        ? formatScopedMemoryGuidance(session.getWorkspacePath(), userMessage, {
            sessionId: session.id,
            scopes: ["session", "workspace", "user"],
            limit: 4,
            maxChars: Math.min(1_400, Math.round(getConfig().agents.performance.promptBudgetChars * 0.08)),
          })
        : Promise.resolve(""),
      skillRetrievalEnabled
        ? retrieveSkillGuidance(session.getWorkspacePath(), userMessage, {
            maxChars: Math.min(1_400, Math.round(getConfig().agents.performance.promptBudgetChars * 0.08)),
          })
        : Promise.resolve(null),
      discoveryPrefetchPromise,
      userProfilePrefetchPromise,
    ]);
    let memoryGuidance = memoryGuidanceText;
    let skillGuidance = "";
    if (skillRetrieved) {
      skillGuidance = skillRetrieved.text;
      injectedSkillSlugs = skillRetrieved.slugs;
      heldOutSkillSlugs = skillRetrieved.heldOutSlugs ?? [];
    }
    // Dialectic user model — small, injected only when populated. Adapts the
    // agent to the user across sessions; droppable under prompt budget.
    let userModelGuidance = injectTurnContext ? formatUserModelGuidance() : "";
    let activeTrajectoryInjectionContext = injectTurnContext ? trajectoryInjectionContext : null;
    // In lean mode, replace the always-on context blocks with a one-line pointer
    // so the model knows to pull what it needs instead of assuming it is in view.
    // Lean-mode context pointer. Even when the fuller context is left to
    // recall_context, the user's DURABLE facts (name/role/preferences/decisions)
    // must be present as authoritative DATA the model can rely on — not left to a
    // tool round-trip, and not papered over with per-question classifier special-
    // cases (user steer: "give it programmatically the user-memory as systemprompt
    // as data to rely on"). Compact + capped (reuses the receptionist capsule) so
    // the prompt stays lean; the user model, session facts, related sessions and
    // skills still come on demand via recall_context.
    let contextRecallDigest = "";
    if (iterationCount === 0 && leanContextInjection) {
      let durableCapsule = "";
      try {
        durableCapsule = buildMemoryCapsule(session.getWorkspacePath(), 600);
      } catch { /* no capsule → recall_context still covers it */ }
      const parts: string[] = [];
      if (durableCapsule.trim()) {
        parts.push(
          "Durable facts the user has had you remember — authoritative; rely on these and do not re-ask or contradict them:",
          durableCapsule,
          "",
        );
      } else if (!userProfileEvidence && !documentRagFoundDocs) {
        // No durable facts are PRELOADED, the proactive profile prefetch did not inject an
        // authoritative result, AND the per-turn document-RAG surfaced no CV/profile this
        // turn. (When ANY of those DID happen — prefetch found a profile / confirmed-empty,
        // OR the [DOCUMENT CONTEXT] carries the CV — this "no facts" marker is suppressed so
        // it can never contradict the retrieved evidence: the "keine gespeicherten
        // Informationen … aber ich sehe Ihren CV" awkwardness.) Make explicit that this is the lean-context
        // default — NOT the result of a lookup — so the model cannot (a) fabricate a profile
        // from nothing, nor (b) read "not preloaded" as "checked and empty" and admit
        // ignorance without retrieving. Structural (keys off an empty capsule), language-independent.
        parts.push(
          "No durable facts, user model, or documents are PRELOADED into this turn — but that is the lean-context default, NOT the result of a lookup: nothing has been searched yet, so absence here is NOT evidence that nothing is stored. If the turn asks about the user's OWN background, experience, skills, employers, education, projects, fit, or identity, you MUST call recall_context (it also returns excerpts from an attached CV/profile) — and search_documents if more is needed — THIS turn BEFORE answering. Only after that retrieval actually returns nothing may you say plainly that you have no stored information and ask them to provide it. Never invent a profile, and never treat 'not preloaded' as 'already checked and empty'. A tool-free 'I have no information about you' is INVALID until the retrieval has run this turn.",
          "",
        );
      }
      parts.push(
        "The user model, this session's working facts, recent related sessions, and learned skills are NOT preloaded — call recall_context(query) to pull those when a turn needs them. Do not assume that deeper context is already in view.",
      );
      contextRecallDigest = parts.join("\n");
    }
    // Plan-first checkpoint: on a genuinely multi-area / multi-step turn, nudge
    // the orchestrator to record a short structured plan before fanning out so
    // the risk-gated QA pass can check the answer against acceptance criteria and
    // the operator dock can surface a high-stakes plan for approval. Soft and
    // droppable; trivial and single-domain turns are unaffected.
    let planGuidance = "";
    if (iterationCount === 0 && (getConfig().orchestration?.planFirst ?? true)) {
      planGuidance = looksMultiDomainResearch(userMessage)
        ? "PLAN FIRST: this spans several steps/areas. Before fanning out, CONSIDER REUSABLE WORKFLOWS: if a 'Strong reusable match' scene/job is noted this turn, plan a reuse step that runs it via run_workflow; otherwise call search_workflows ONCE to check whether an existing scene or job already fits before decomposing into agents. Then call record_plan once with a short plan — objective; the few steps (each tagged reuse | delegate | direct, with agentName for delegate steps and a parallelGroup for genuinely independent work); the acceptance criteria the answer must meet; and stop conditions. Prefer a reuse step (run an existing scene/job/workflow via run_workflow) over decomposing into agents when one fits. Do not over-fan-out — keep parallel work to independent steps only."
        // Plan on every crucial turn, not just multi-domain research: a brief plan
        // gives the risk-gated QA gate explicit acceptance criteria to verify the
        // answer against, and makes the model decide the route before acting. Kept
        // lightweight so a single-domain task isn't taxed — and a pure direct-
        // knowledge answer skips it entirely (DIRECT ANSWER FIRST still holds).
        : "PLAN FIRST: if this needs any tool, delegation, retrieval, or multi-step work, call record_plan ONCE with a SHORT plan before acting — objective; the step(s) (each tagged reuse | delegate | direct, with agentName for delegate steps); the acceptance criteria the final answer must meet; and stop conditions. A one-line objective with one or two acceptance criteria is enough for a simple single-step task — keep it lightweight. Set riskTier 'high' only when the task makes current/sourced factual claims, takes an external/destructive/credential action, or is otherwise consequential. If the request is fully answerable directly from your own knowledge in one reply, SKIP the plan and just answer. Then execute the plan in the same turn.";
    }
    // discoveryCapsule (staged orchestration S4) was prefetched CONCURRENTLY with the
    // memory+skill embeddings above (discoveryPrefetchPromise) so it no longer adds a
    // serial round-trip to first-token. It injects a compact agent+workflow capsule so
    // the coordinator can plan without first spending slow search_agents/search_workflows
    // rounds. Kept as `let` so the prompt-budget trimmer below can drop it; audited here
    // where the rest of the turn-context capsules are assembled.
    let discoveryCapsule = prefetchedDiscoveryCapsule;
    if (discoveryCapsule) {
      logAudit("discovery_prefetch", { capsuleChars: discoveryCapsule.length }, { sessionId: session.id });
    }
    const collapsedHistory = session.getCollapsedHistory();

    // Freshness-honesty guard (orchestration.freshnessHonestyGuard, default-off,
    // eval-gated): a short, language-independent directive that stops the orchestrator
    // dressing a parametric-memory answer up as freshly-sourced data — the "answered
    // directly with 0 tool calls but opened 'based on current market data…'" failure.
    const freshnessHonestyPrompt = getConfig().orchestration?.freshnessHonestyGuard
      ? "HONESTY ON CURRENCY: Do NOT claim or imply your answer is based on current, live, recent, latest, or external data (market data, news, prices, current events, 'as of today/this year') unless you actually retrieved it via a tool THIS turn. If the answer materially depends on such data, route it to a research-capable specialist and validate it — never assert it from memory, and never frame a from-memory answer as if it were freshly sourced."
      : "";

    const buildSystemMessages = (): LLMMessage[] => [
      { role: "system", content: systemPrompt },
      // Orchestration module (split-prompt mode): injected right after the lean base so the base
      // stays the shared, cacheable prefix; present only on orchestration-intent turns.
      ...(orchestrationModuleMsg ? [{ role: "system" as const, content: orchestrationModuleMsg }] : []),
      { role: "system", content: temporalContext },
      ...(languageAndIdentityGuidance ? [{ role: "system" as const, content: languageAndIdentityGuidance }] : []),
      ...(priorEvidenceFollowUpPrompt ? [{ role: "system" as const, content: priorEvidenceFollowUpPrompt }] : []),
      ...(sessionEvidenceReuseNudge ? [{ role: "system" as const, content: sessionEvidenceReuseNudge }] : []),
      ...(dynamicGuidance ? [{ role: "system" as const, content: dynamicGuidance.prompt }] : []),
      ...(freshnessHonestyPrompt ? [{ role: "system" as const, content: freshnessHonestyPrompt }] : []),
      // Proactive user-profile evidence (default-off) leads the general retrieve-first
      // digest: when the prefetch ran it is the AUTHORITATIVE result of a real lookup
      // (found evidence, or a confirmed-empty fact) for a userOwnFacts turn.
      ...(userProfileEvidence ? [{ role: "system" as const, content: userProfileEvidence }] : []),
      ...(contextRecallDigest ? [{ role: "system" as const, content: contextRecallDigest }] : []),
      ...(effortPromptAddendum ? [{ role: "system" as const, content: effortPromptAddendum }] : []),
      ...(planGuidance ? [{ role: "system" as const, content: planGuidance }] : []),
      ...(discoveryCapsule ? [{ role: "system" as const, content: discoveryCapsule }] : []),
      ...(workflowCatalogGuidance ? [{ role: "system" as const, content: workflowCatalogGuidance }] : []),
      ...(approvedRunCandidateGuidance ? [{ role: "system" as const, content: approvedRunCandidateGuidance }] : []),
      ...(delegatedResearchEnforcementPrompt ? [{ role: "system" as const, content: delegatedResearchEnforcementPrompt }] : []),
      ...(searchAgentsNoMatchFallbackPrompt ? [{ role: "system" as const, content: applyRoutingTone(searchAgentsNoMatchFallbackPrompt) }] : []),
      ...(maintenanceDelegationEnforcementPrompt ? [{ role: "system" as const, content: applyRoutingTone(maintenanceDelegationEnforcementPrompt) }] : []),
      ...(unresolvedDelegationEnforcementPrompt ? [{ role: "system" as const, content: unresolvedDelegationEnforcementPrompt }] : []),
      ...(workflowCatalogEnforcementPrompt ? [{ role: "system" as const, content: applyRoutingTone(workflowCatalogEnforcementPrompt) }] : []),
      ...(approvedRunCandidateEnforcementPrompt ? [{ role: "system" as const, content: approvedRunCandidateEnforcementPrompt }] : []),
      ...(workflowExecutionEnforcementPrompt ? [{ role: "system" as const, content: workflowExecutionEnforcementPrompt }] : []),
      ...(flowGuidance ? [{ role: "system" as const, content: flowGuidance }] : []),
      ...(skillGuidance ? [{ role: "system" as const, content: skillGuidance }] : []),
      ...(userModelGuidance ? [{ role: "system" as const, content: userModelGuidance }] : []),
      ...(memoryGuidance ? [{ role: "system" as const, content: memoryGuidance }] : []),
      // G33: Inject cached trajectory evidence on first iteration only
      ...(iterationCount === 0 && activeTrajectoryInjectionContext ? [{ role: "system" as const, content: activeTrajectoryInjectionContext }] : []),
      // Inject shared findings from sub-agents on post-delegation iterations so the
      // main orchestrator's synthesis call sees verified facts instead of hallucinating
      // from training data (e.g. mic interface type, verified part specs, etc.).
      ...(_sharedFindingsSystemMessage ? [{ role: "system" as const, content: _sharedFindingsSystemMessage }] : []),
    ];

    let systemMessages = buildSystemMessages();
    lastPromptMetrics = measurePrompt(systemMessages, collapsedHistory);

    // ── Per-section prompt-size telemetry ─────────────────────────────────
    // Emitted once per turn (iteration 0) so we can see exactly what dominates
    // the system prompt and prove the win from lean context injection. The base
    // template is typically the bulk; memory/skill/user/flow/trajectory are the
    // reducible part that recall_context now covers on demand.
    if (iterationCount === 0) {
      logAudit("prompt_section_sizes", {
        total: lastPromptMetrics.systemPromptChars,
        base: systemPrompt.length,
        temporal: temporalContext.length,
        dynamicGuidance: dynamicGuidance?.prompt.length ?? 0,
        languageIdentity: languageAndIdentityGuidance.length,
        flow: flowGuidance.length,
        skill: skillGuidance.length,
        userModel: userModelGuidance.length,
        memory: memoryGuidance.length,
        plan: planGuidance.length,
        trajectory: activeTrajectoryInjectionContext?.length ?? 0,
        contextDigest: contextRecallDigest.length,
        leanContextInjection,
      }, { sessionId: session.id, severity: "info" });
    }

    // ── Prompt budget enforcement ─────────────────────────────────────────
    // Fix 6: when the system prompt exceeds the configured budget, trim
    // optional/auxiliary sections in priority order (least → most critical)
    // until under budget OR no further drops are available. The previous
    // behavior was to log a warning and ship the over-budget prompt anyway,
    // which never actually reduced any prompt and made the audit a dead
    // signal. We never touch the main systemPrompt or active enforcement
    // prompts — those were set this turn for a reason.
    if (iterationCount === 0) {
      const promptBudget = getConfig().agents.performance.promptBudgetChars;
      if (lastPromptMetrics.systemPromptChars > promptBudget) {
        const initialChars = lastPromptMetrics.systemPromptChars;
        const droppedSections: Array<{ name: string; chars: number }> = [];

        // Priority 1: trajectory injection (cached evidence — helpful but optional)
        if (lastPromptMetrics.systemPromptChars > promptBudget && activeTrajectoryInjectionContext) {
          droppedSections.push({ name: "trajectoryInjectionContext", chars: activeTrajectoryInjectionContext.length });
          activeTrajectoryInjectionContext = null;
          systemMessages = buildSystemMessages();
          lastPromptMetrics = measurePrompt(systemMessages, collapsedHistory);
        }
        // Priority 2: memory guidance (background context — non-critical)
        if (lastPromptMetrics.systemPromptChars > promptBudget && memoryGuidance) {
          droppedSections.push({ name: "memoryGuidance", chars: memoryGuidance.length });
          memoryGuidance = "";
          systemMessages = buildSystemMessages();
          lastPromptMetrics = measurePrompt(systemMessages, collapsedHistory);
        }
        // Priority 2b: skill guidance (procedural memory — non-critical)
        if (lastPromptMetrics.systemPromptChars > promptBudget && skillGuidance) {
          droppedSections.push({ name: "skillGuidance", chars: skillGuidance.length });
          skillGuidance = "";
          systemMessages = buildSystemMessages();
          lastPromptMetrics = measurePrompt(systemMessages, collapsedHistory);
        }
        // Priority 2c: user-model guidance (cross-session adaptation — non-critical)
        if (lastPromptMetrics.systemPromptChars > promptBudget && userModelGuidance) {
          droppedSections.push({ name: "userModelGuidance", chars: userModelGuidance.length });
          userModelGuidance = "";
          systemMessages = buildSystemMessages();
          lastPromptMetrics = measurePrompt(systemMessages, collapsedHistory);
        }
        // Priority 3: flow guidance (workflow memory — non-critical)
        if (lastPromptMetrics.systemPromptChars > promptBudget && flowGuidance) {
          droppedSections.push({ name: "flowGuidance", chars: flowGuidance.length });
          flowGuidance = "";
          systemMessages = buildSystemMessages();
          lastPromptMetrics = measurePrompt(systemMessages, collapsedHistory);
        }
        // Priority 3b: discovery prefetch capsule (a planning head start — the model
        // can still discover on demand, so it yields before the plan-first nudge).
        if (lastPromptMetrics.systemPromptChars > promptBudget && discoveryCapsule) {
          droppedSections.push({ name: "discoveryCapsule", chars: discoveryCapsule.length });
          discoveryCapsule = "";
          systemMessages = buildSystemMessages();
          lastPromptMetrics = measurePrompt(systemMessages, collapsedHistory);
        }
        // Priority 4: plan-first nudge — high value (governs turn structure), so
        // dropped only under the most extreme prompt pressure, after the above.
        if (lastPromptMetrics.systemPromptChars > promptBudget && planGuidance) {
          droppedSections.push({ name: "planGuidance", chars: planGuidance.length });
          planGuidance = "";
          systemMessages = buildSystemMessages();
          lastPromptMetrics = measurePrompt(systemMessages, collapsedHistory);
        }
        // Priority 4 (last resort): compact the base system prompt itself.
        // Until now the trimmer dropped only auxiliary blocks and shipped the
        // base over budget anyway — the base is the dominant consumer, so the
        // audit signal was effectively dead. This strips clearly non-load-bearing
        // verbose sections (response-format/formatting guidance) while preserving
        // Core Principles, Swarm Rules, Tool Use Discipline, and Security. It
        // fires only when everything else has been dropped and we are still over.
        if (lastPromptMetrics.systemPromptChars > promptBudget) {
          const compacted = compactBasePromptUnderPressure(systemPrompt);
          if (compacted.length < systemPrompt.length) {
            droppedSections.push({ name: "basePromptCompaction", chars: systemPrompt.length - compacted.length });
            systemPrompt = compacted;
            systemMessages = buildSystemMessages();
            lastPromptMetrics = measurePrompt(systemMessages, collapsedHistory);
          }
        }

        const stillOver = lastPromptMetrics.systemPromptChars > promptBudget;
        logAudit("prompt_budget_exceeded", {
          systemPromptChars: lastPromptMetrics.systemPromptChars,
          budgetChars: promptBudget,
          initialChars,
          excessChars: Math.max(0, lastPromptMetrics.systemPromptChars - promptBudget),
          agentId: session.id,
          droppedSections: droppedSections.map((section) => section.name),
          droppedChars: droppedSections.reduce((sum, section) => sum + section.chars, 0),
          remainsOverBudget: stillOver,
        }, { sessionId: session.id, severity: stillOver ? "warn" : "info" });
        log.warn({
          initialChars,
          finalChars: lastPromptMetrics.systemPromptChars,
          budget: promptBudget,
          droppedSections: droppedSections.map((section) => section.name),
          remainsOverBudget: stillOver,
        }, stillOver
          ? "System prompt still exceeds budget after trimming optional sections — consider shortening the main system prompt or enforcement messages"
          : "System prompt was over budget; trimmed optional sections to fit");
      }
    }

    const messages: LLMMessage[] = [...systemMessages, ...collapsedHistory];

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
      const mustOrchestrateBeforeAnswering =
        (requiresDelegatedResearch || requiresArtifactDelegation || workflowCatalogRequired || requiresMaintenanceDelegation)
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
          severity: "warn",
        });
        logAudit("message_sent", { length: finalResponse.length, toolCalls: iterationCount, usage: totalUsage, performance }, {
          sessionId: session.id,
          channel: session.channel,
          severity: "warn",
        });
        logAudit("turn_scorecard", {
          delegationCount: _turnDelegationCount,
          shareFindingCount: _turnShareFindingCount,
          forcedSynthesisFired: _forcedSynthesisFired,
          wardenFailureCount: _consecutiveDelegationFailures,
          finalAnswerLength: finalResponse.length,
          toolIterations: iterationCount,
          finishReason: "llm_error_evidence_backstop",
        }, { sessionId: session.id, channel: session.channel, severity: "warn" });
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
      if (!releasedAfterRoutingNudge && requiresDelegatedResearch && !currentTurnHasExecutableOrchestration) {
        if (!delegatedResearchRetryUsed) {
          delegatedResearchRetryUsed = true;
          const route: RequiredResearchFallbackRoute | null = requiredResearchFallbackRoute ?? buildRequiredResearchFallbackRoute(researchSubject, initialDynamicGuidance, allowedToolNameSet, opts.allowedAgents);
          if (route) {
            requiredResearchFallbackRoute = route;
            searchAgentsNoMatchFallbackPrompt ||= buildSearchAgentsNoMatchFallbackPrompt(route);
          }
          delegatedResearchEnforcementPrompt = route
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
          opts.onStatus?.({ phase: "guardrail", message: "Der Entwurf hat keine Recherche ausgeführt — ich hole jetzt belegte Quellen über einen Recherche-Spezialisten.", iteration: iterationCount });
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
              + "Do not invent manufacturer, interface, pricing, part, or layout claims beyond the findings; mark anything the findings do not cover as still to verify.\n"
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
      let finalResponse = await finalizeUserFacingAssistantResponse(rawResponse, effectiveToolIterations, session, provider, signal);

      // General shared-facts synthesis backstop — fires for ALL turns (not just source-sensitive)
      // when the final response looks like a raw dump or is suspiciously short after orchestration
      // ran. The source-sensitive path below handles `sourceSensitive` cases; this catches the
      // general research case (BOM, hardware design, multi-source comparison, etc.) where the
      // researcher gathered good shared facts but forceSynthesis timed out or the model echoed
      // raw auto_xxx_yyy key names instead of synthesizing them into prose.
      if (
        currentTurnHasExecutableOrchestration
        && !initialDynamicGuidance?.sourceSensitive
        && (
          looksLikeRawSharedFactsDump(finalResponse)
          || looksLikeOrchestrationOnlyEvidence(finalResponse)
          || (_forcedSynthesisFired && finalResponse.length < 600)
        )
      ) {
        const sharedFactsEvidence = await getSharedFactsEvidenceForFinalSynthesis(session.id, 6_000);
        const delegateEvidence = findRecentDelegateEvidence(session.getHistory());
        const recoveryEvidence = chooseBetterRecoveryEvidence(delegateEvidence, sharedFactsEvidence, { preferHigherScore: true });
        if (recoveryEvidence && !looksLikeWeakRecoveryEvidence(recoveryEvidence.evidence)) {
          const synthesized = await forceSynthesis(
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

      if (
        initialDynamicGuidance?.sourceSensitive
        && currentTurnHasExecutableOrchestration
        && (
          _forcedSynthesisFired
          || _consecutiveDelegationFailures > 0
          || hasRecentSourceSensitivePartialDelegation(session.getHistory())
          || hasRecentSparseSourceSensitiveMemoryReuse(session.getHistory(), userMessage)
        )
      ) {
        const delegateEvidence = findRecentDelegateEvidence(session.getHistory());
        const sharedFactsEvidence = await getSharedFactsEvidenceForFinalSynthesis(session.id);
        const recoveryEvidence = chooseBetterRecoveryEvidence(delegateEvidence, sharedFactsEvidence);
        if (recoveryEvidence) {
          const finalResponseAnchored = looksEvidenceAnchored(stripPresentationFormatting(finalResponse), recoveryEvidence.evidence);
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
        } else if (!looksLikeTransparentIncompleteReport(finalResponse)) {
          finalResponse = [
            "Die Recherche ist in diesem Lauf fehlgeschlagen, bevor belastbare Quellen- oder Tool-Evidenz vorlag.",
            "Ich kann die angefragten Produkt-, Hersteller-, Schnittstellen-, Preis- und Layout-Aussagen deshalb nicht verifizieren, ohne Fakten zu erfinden.",
            "Bitte starte die Recherche erneut oder reduziere den Umfang auf einen kleineren Teilbereich, damit ein Spezialist echte Quellen sammeln kann.",
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
      if (autoResearchAnswer) {
        finalResponse = autoResearchAnswer;
      }

      // Anti-hallucination caveat: a source-sensitive answer that shipped with
      // NO research evidence (model declined to delegate) gets an explicit
      // unverified banner so pre-assumptions aren't read as confirmed facts.
      // Only for substantial answers — a short "it depends" needs no banner.
      if (releasedWithoutResearchEvidence && finalResponse.trim().length > 400) {
        finalResponse = prependUnverifiedSourceCaveat(finalResponse, userMessage);
        guardrailEvents.push({ type: "guardrail_flagged", details: "unverified_source_sensitive_answer_caveated" });
        logAudit("guardrail_flagged", {
          type: "unverified_source_sensitive_answer_caveated",
          sourceSensitive: initialDynamicGuidance?.sourceSensitive ?? false,
          freshnessSensitive: initialDynamicGuidance?.freshnessSensitive ?? false,
        }, { sessionId: session.id, severity: "warn" });
      }

      // Citation-honesty guard (orchestration.citationHonestyGuard, default-off, eval-gated):
      // a sourceSensitive turn that ran NO real web/research execution but whose answer carries
      // URL citations is FABRICATING sources (audit 1303e254: 7 invented 404 URLs, zero
      // delegation, only a failed run_workflow). Strip the fabricated URLs + prepend the honest
      // unverified caveat so no 404 link ever ships and any "verified" framing is corrected.
      // Detection + strip are STRUCTURAL (URL shape, language-free — works for EN/DE/FR/…); the
      // gate is the HONEST execution signals (a real delegation, a SUCCESSFUL workflow, a direct
      // web tool, shared findings), NOT the orchestration flag, so a genuinely-researched answer
      // keeps its citations. Never empties the answer.
      if (getConfig().orchestration?.citationHonestyGuard === true
        && initialDynamicGuidance?.sourceSensitive === true
        && answerPresentsSourceCitations(finalResponse)) {
        const isWebReachingTool = (t: string) => /^web_search/i.test(t) || /^web_fetch$/i.test(t) || /^browser_/i.test(t);
        const webToolCalledDirectly = [..._turnToolCallCounts.keys()].some(isWebReachingTool);
        const sharedFactsForCitation = await getSharedFactsEvidenceForFinalSynthesis(session.id);
        const hadRealResearch = _turnDelegationCount > 0
          || workflowRunCompletedThisTurn
          || webToolCalledDirectly
          || _turnShareFindingCount > 0
          || (sharedFactsForCitation?.itemCount ?? 0) > 0;
        if (!hadRealResearch) {
          finalResponse = prependUnverifiedSourceCaveat(stripFabricatedCitations(finalResponse), userMessage);
          guardrailEvents.push({ type: "guardrail_flagged", details: "fabricated_citations_stripped" });
          logAudit("guardrail_flagged", {
            type: "fabricated_citations_stripped",
            sourceSensitive: true,
          }, { sessionId: session.id, severity: "warn" });
        }
      }

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
        && collectTurnArtifactAttachments(session).length === 0
        && (artifactClaimUnbacked || staleArtifactReplay)
      ) {
        logAudit("guardrail_flagged", {
          type: "artifact_completion_claim_unbacked_suppressed",
          reason: staleArtifactReplay ? "stale_prior_answer_replayed_on_failed_build" : "false_completion_claim",
          finishReason: terminalFinishReason,
          answerLength: finalResponse.length,
        }, { sessionId: session.id, channel: session.channel, severity: "warn" });
        const honest = await forceSynthesis(
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
        const invokedApprovalGatedTool = [..._turnToolCallCounts.keys()].some(requiresApproval);
        const risk = classifyTurnRisk({
          planRiskTier: qaPlan?.riskTier,
          sourceSensitive: initialDynamicGuidance?.sourceSensitive ?? false,
          freshnessSensitive: initialDynamicGuidance?.freshnessSensitive ?? false,
          invokedApprovalGatedTool,
        });
        if (risk === "high") {
          if (initialDynamicGuidance?.sourceSensitive || initialDynamicGuidance?.freshnessSensitive) {
            // Universal grounding gate (step 5). The failure-path backstop above only
            // fires on a failed/partial run. For a source- OR freshness-sensitive turn
            // that delegated SUCCESSFULLY, the answer was never cross-checked — so a
            // training-data answer can ship while verified facts sit unused in shared
            // findings (audit fe496ec5: fabricated news bulletin). Re-ground it if it
            // references none of them. The check is CHEAP and deterministic
            // (answerNeedsEvidenceAnchoringRepair) — the slow-model repair only fires
            // when the draft is actually unanchored, so clean turns pay nothing.
            const anchorEvidence = effectiveOrchestration().qaEvidenceAnchoring && !signal.aborted
              ? await getSharedFactsEvidenceForFinalSynthesis(session.id)
              : null;
            if (anchorEvidence && answerNeedsEvidenceAnchoringRepair(finalResponse, anchorEvidence.evidence)) {
              const anchorInstruction = [
                "EVIDENCE-ANCHORING REPAIR:",
                "Your previous answer did not reference the verified findings this run gathered. Re-write the answer so it is grounded in the findings below, in the SAME language as the user's request.",
                "Use ONLY these findings plus this conversation's tool results. Do not invent manufacturer, interface, pricing, part, layout, or BOM claims. Mark anything the findings do not support as unverified/incomplete.",
                "Keep it a concise, useful answer — do not dump raw tool traces or page snapshots.",
                "Verified findings:",
                anchorEvidence.evidence.trim(),
              ].join("\n");
              const reanchored = await forceSynthesis(session, provider, signal, anchorInstruction);
              const candidate = reanchored ? sanitizeUserFacingAssistantResponse(reanchored, 0) : null;
              if (
                candidate
                && candidate.trim().length >= Math.min(200, Math.floor(finalResponse.trim().length * 0.5))
                && looksEvidenceAnchored(stripPresentationFormatting(candidate), anchorEvidence.evidence)
              ) {
                finalResponse = candidate;
                guardrailEvents.push({ type: "guardrail_flagged", details: "qa_evidence_anchoring_repaired" });
                logAudit("flow_verification_repaired", { reason: "unanchored_to_shared_findings", evidenceItems: anchorEvidence.itemCount }, { sessionId: session.id, severity: "warn" });
              } else {
                logAudit("flow_high_stakes_unverified", { reason: "answer_unanchored_repair_failed", evidenceItems: anchorEvidence.itemCount }, { sessionId: session.id, severity: "warn" });
              }
            } else {
              logAudit("flow_verification_passed", {
                reason: anchorEvidence ? "answer_anchored_to_shared_findings" : "covered_by_source_sensitive_backstop",
              }, { sessionId: session.id, severity: "info" });
            }
          } else if (qaPlan && qaPlan.acceptanceCriteria.length > 0 && finalResponse.trim().length > 200 && !signal.aborted) {
            acceptanceCriteriaQaRan = true;
            const verifyInstruction = "Before finalizing, verify your answer meets ALL of these acceptance criteria for the user's task:\n"
              + qaPlan.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")
              + "\nIf every criterion is met and every claim is grounded in this conversation's tool results and shared findings, return the SAME answer. "
              + "If a criterion is unmet or a claim is unsupported, return a corrected answer that fixes the gap or transparently marks what could not be verified. Do not add unsupported claims.";
            const verified = await forceSynthesis(session, provider, signal, verifyInstruction);
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
                  _turnDelegationCount += 1;
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
                  log.warn({ err, sessionId: session.id }, "QA delivery coordinator escalation failed");
                  return null;
                }
              }
            : undefined;
          const gate = await timedPhase("qaDeliveryLoop", () => runQaDeliveryGate(
            session, provider, signal, finalResponse, criteria,
            effectiveOrchestration().qaDeliveryLoopMaxRounds,
            qaEscalate,
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
          logAudit("flow_verification_passed", {
            reason: "qa_delivery_loop",
            rounds: gate.rounds,
            passed: gate.passed,
            improved: gate.changed,
            escalated: gate.escalated,
            acceptanceCriteria: criteria.length,
          }, { sessionId: session.id, severity: gate.changed ? "warn" : "info" });
        }
      }

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
          delegationCount: _turnDelegationCount,
        })
      ) {
        const userStatements = collectUserStatements(session.getHistory(), 2000);
        const gate = await runDeliverableConsistencyGate(
          session, provider, signal, finalResponse, userStatements,
          effectiveOrchestration().deliverableConsistencyQaMaxRounds,
        );
        if (gate.changed) {
          finalResponse = gate.answer;
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
      // artifact was produced → run ONE corrective build and ship the built app instead of the
      // description. Scoped to app/served deliverables (web_coder/backend_coder) so plain
      // reports/decks the model already wrote inline still ship as-is. Bounded by the shared
      // qaCorrectiveBuildUsed latch. (The forced-terminal path has its own build gate above.)
      if (
        effectiveOrchestration().finalResponseQaGate
        && !qaCorrectiveBuildUsed
        && !signal.aborted
        && deliverableIntent.wantsArtifact
        && deliverableIntent.isAppBuild
        && collectTurnArtifactAttachments(session).length === 0
      ) {
        const factsCtx = initialDynamicGuidance?.sourceSensitive
          ? ((await getSharedFactsEvidenceForFinalSynthesis(session.id))?.evidence ?? "")
          : "";
        // A source-sensitive build still needs gathered facts (don't build from nothing).
        if (!initialDynamicGuidance?.sourceSensitive || factsCtx.trim().length > 0) {
          const built = await runCorrectiveBuild(factsCtx);
          if (built) {
            finalResponse = built;
            guardrailEvents.push({ type: "guardrail_flagged", details: "final_qa_corrective_build_normal_path" });
          }
        }
      }

      if (!outputScan.safe && outputScan.redacted) {
        finalResponse = outputScan.redacted;
        guardrailEvents.push({ type: "output_redacted", details: (outputScan.detectedTypes ?? []).join(", ") });
        logAudit("output_redacted", { types: outputScan.detectedTypes }, { sessionId: session.id, severity: "warn" });
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
        && collectTurnArtifactAttachments(session).length === 0
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
          && !qaCorrectiveBuildUsed
          && !signal.aborted
        ) {
          if (requestIsArtifactShaped) {
            const factsCtx = initialDynamicGuidance?.sourceSensitive
              ? ((await getSharedFactsEvidenceForFinalSynthesis(session.id))?.evidence ?? "")
              : "";
            if (!initialDynamicGuidance?.sourceSensitive || factsCtx.trim().length > 0) {
              fabricationBuildAttempted = true;
              fabricationCorrectiveBuild = await runCorrectiveBuild(factsCtx);
            }
          } else {
            // The request never asked for an artifact (the model fabricated a tool-minted
            // link on e.g. a mail/lookup question) — a BUILD would compound the fabrication
            // with a deliverable nobody wanted. Re-route the ORIGINAL request once instead.
            fabricationRerouteAttempted = true;
            fabricationReroute = await runCorrectiveReroute();
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
        } else if (fabricationBuildAttempted || qaCorrectiveBuildUsed) {
          // A real build WAS attempted and produced no file — saying "no tools ran" here
          // would be its own false statement (audit 0ac7d3fc: the denial claimed nothing
          // ran while a 6-minute corrective build had just failed). Be accurate.
          finalResponse = "Der Bau der angeforderten Datei wurde gestartet, ist aber **fehlgeschlagen** — es wurde keine fertige Datei erstellt, daher existiert ein oben genannter Link/Inhalt nicht. Bestätige kurz, dann starte ich einen neuen Bauversuch.\n\nThe build of the requested file was started but **failed** — no finished file was produced, so any link or deliverable named above does not exist. Confirm and I'll retry the build now.";
        } else {
          finalResponse = "Ich habe in diesem Schritt **nichts** gebaut — es wurden keine Tools ausgeführt und keine Datei oder App erstellt, daher existiert ein oben genannter Link/Inhalt nicht. Bestätige kurz, dann lasse ich den passenden Spezialisten die angeforderte Lösung jetzt **wirklich** bauen.\n\nI did **not** build anything in this turn — no tools ran and no file or app was created, so any link or deliverable named above does not exist. Confirm and I'll have the right specialist actually build it now.";
        }
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
        && collectTurnArtifactAttachments(session).length === 0
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
        finishReason: llmResponse.finishReason,
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

      // F29: Per-turn quality scorecard
      logAudit("turn_scorecard", {
        delegationCount: _turnDelegationCount,
        shareFindingCount: _turnShareFindingCount,
        forcedSynthesisFired: _forcedSynthesisFired,
        wardenFailureCount: _consecutiveDelegationFailures,
        finalAnswerLength: finalResponse.length,
        toolIterations: iterationCount,
      }, { sessionId: session.id, channel: session.channel });

      // G33: Write trajectory for future cache reuse
      if (_turnShareFindingCount > 0 && finalResponse.length > 50) {
        writeTrajectory(
          {
            channel: session.channel,
            normalizedQuery: userMessage.toLowerCase().trim().slice(0, 300),
            sharedFindings: sharedFindingsThisTurn,
            finalAnswer: finalResponse.slice(0, 2000),
          },
          session.getWorkspacePath(),
          initialDynamicGuidance?.freshnessSensitive ?? false,
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
      if ((injectedSkillSlugs.length > 0 || heldOutSkillSlugs.length > 0) && _turnDelegationCount > 0) {
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
        maybeDistillSkillFromTurn({
          workspacePath: session.getWorkspacePath(),
          sessionId: session.id,
          objective: userMessage,
          finalAnswer: finalResponse,
          delegationCount: _turnDelegationCount,
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
      };
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
            severity: "warn",
          });

          logAudit("message_sent", { length: finalResponse.length, toolCalls: iterationCount, usage: totalUsage, performance }, {
            sessionId: session.id,
            channel: session.channel,
            severity: "warn",
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
          }, { sessionId: session.id, channel: session.channel, severity: "warn" });

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
              severity: "warn",
            });

            logAudit("message_sent", { length: finalResponse.length, toolCalls: iterationCount, usage: totalUsage, performance }, {
              sessionId: session.id,
              channel: session.channel,
              severity: "warn",
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
            }, { sessionId: session.id, channel: session.channel, severity: "warn" });

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

      // Redact any secrets that leaked into the tool output before the LLM ever sees it
      // (DB error messages, SSH banners, etc. can echo credentials back).
      const secretScan = scanOutput(resultText);
      if (!secretScan.safe && secretScan.redacted) {
        resultText = secretScan.redacted;
        guardrailEvents.push({ type: "tool_output_secret_redacted", details: `${tc.name}:${(secretScan.detectedTypes ?? []).join(",")}` });
        logAudit("output_redacted", {
          surface: "tool_output",
          tool: tc.name,
          detectedTypes: secretScan.detectedTypes,
        }, { sessionId: session.id, severity: "warn" });
      }

      // Prevent indirect prompt injection from tool output payloads
      const outCheck = checkToolOutput(resultText);
      if (!outCheck.allowed) {
        const blockedIntervention = classifyToolIntervention({
          toolName: tc.name,
          success: false,
          error: outCheck.reason,
          outputBlocked: true,
        });
        logAudit("tool_output_blocked", {
          tool: tc.name,
          reason: outCheck.reason,
          issueCode: blockedIntervention?.reasonCode,
          intervention: blockedIntervention,
        }, { sessionId: session.id, severity: "error" });
        resultText = "Error: Tool output blocked by guardrails (suspicious payload detected).";
        guardrailEvents.push({ type: "tool_output_blocked", details: tc.name });
        if (blockedIntervention) opts.onIntervention?.(blockedIntervention);
      } else if (intervention) {
        opts.onIntervention?.(intervention);
      }

      if (outCheck.allowed) {
        const moderatedToolResult = await moderateToolResultText(resultText);
        if (moderatedToolResult?.blocked) {
          logAudit("tool_output_blocked", {
            tool: tc.name,
            reason: `Model moderation blocked tool output: ${moderatedToolResult.summary}`,
            categories: moderatedToolResult.categories,
          }, { sessionId: session.id, severity: "error" });
          resultText = "Error: Tool output blocked by model-backed guardrails.";
          guardrailEvents.push({ type: "tool_output_model_blocked", details: tc.name });
        } else if (moderatedToolResult?.flagged) {
          guardrailEvents.push({ type: "tool_output_model_flagged", details: `${tc.name}: ${moderatedToolResult.summary}` });
          logAudit("guardrail_flagged", {
            type: "tool_output_model",
            tool: tc.name,
            categories: moderatedToolResult.categories,
          }, { sessionId: session.id, severity: "warn" });
        }
      }

      _lastToolCallSig.set(tc.name, {
        args: argsSig,
        result: resultText,
        metadata: result.metadata,
      });

      if (opts.onToolResult) opts.onToolResult(tc.id, tc.name, resultText, result.metadata);

      const modelVisibleResultText = buildModelVisibleToolResult(tc.name, resultText, result.metadata);

      toolResultMessages.push({
        role: "tool",
        content: modelVisibleResultText,
        tool_call_id: tc.id,
        metadata: result.metadata,
      });

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
        // Honesty floor (audit 0dc158ad): on a SOURCE-SENSITIVE turn whose research
        // came back partial/cancelled/below the substance floor, the normal "copy the
        // exact names and numbers from the evidence" directive oversells thin evidence
        // and the model fabricates specifics (it claimed an analog mic has an I2S
        // interface). Swap in an honesty directive on exactly that failure condition —
        // structural trigger, only fires when evidence is thin, so good turns are
        // untouched. Enforces the central "never made-up facts" rule.
        const partialEvidenceSynthesis =
          synthesisArtifacts.length === 0
          && (getConfig().orchestration?.honestSynthesisOnPartialEvidence ?? true)
          && !!initialDynamicGuidance?.sourceSensitive
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
  // Fabricated-inline-artifact guard: on a source-sensitive artifact-creation turn that
  // produced NO real artifact (the build was stopped/blocked/never ran), the model
  // sometimes hand-writes the whole deliverable inline (a multi-KB <!DOCTYPE html> /
  // fenced code block) from training data and presents it as the verified result (audit
  // 453a263e: the operator Stopped mid-research, the auto-build was correctly blocked, and
  // synthesis pasted a fabricated reveal.js deck repeating the Permoser→Neumann error + an
  // invented source URL — no workspace file, false "verified" claim). Replace it with the
  // honest curated-facts fallback: the verified findings + real sources, stating the file
  // was not built this turn. Scoped to the no-artifact case so legit builds are untouched.
  if (
    !autoBuildFinalMsg
    && initialDynamicGuidance?.sourceSensitive
    && deliverableIntent.wantsArtifact
    && (terminalSharedFactsEvidence?.itemCount ?? 0) >= 1
    && collectTurnArtifactAttachments(session).length === 0
    && looksLikeInlinedArtifactFabrication(presentableFinalMsg)
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
    severity: "warn",
  });
  logAudit("message_sent", { length: finalMsg.length, toolCalls: iterationCount, usage: totalUsage, performance }, {
    sessionId: session.id,
    channel: session.channel,
    severity: "warn",
  });
  logAudit("turn_scorecard", {
    delegationCount: _turnDelegationCount,
    shareFindingCount: _turnShareFindingCount,
    forcedSynthesisFired: _forcedSynthesisFired,
    wardenFailureCount: _consecutiveDelegationFailures,
    finalAnswerLength: finalMsg.length,
    toolIterations: iterationCount,
    finishReason: terminalFinishReason,
  }, { sessionId: session.id, channel: session.channel, severity: "warn" });
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
): Promise<{ answer: string; changed: boolean; rounds: number; passed: boolean; escalated: boolean }> {
  const verdictProvider = getChatProviderForTier("synthesis") ?? provider;

  const check = async (current: string, crit: string[]): Promise<QaVerdict> => {
    if (signal.aborted) return { pass: true }; // fail open on abort
    const instruction = [
      "You are a strict QA reviewer. Judge ONLY whether the ANSWER below satisfies EVERY acceptance criterion for the user's task. Do not rewrite it.",
      "Acceptance criteria:",
      ...crit.map((c, i) => `${i + 1}. ${c}`),
      "",
      "ANSWER:",
      current,
      "",
      "Reply on a SINGLE line. If every criterion is fully met and the answer is internally consistent, reply exactly: PASS",
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

  const result = await runQaDeliveryLoop(answer, criteria, { check, improve, maxRounds, ...(escalate ? { escalate } : {}) });
  return {
    answer: result.answer,
    changed: result.answer.trim() !== answer.trim(),
    rounds: result.rounds,
    passed: result.passed,
    escalated: result.escalated,
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

function blocked(reason: string, swarmState?: SwarmState, performance?: TurnPerformanceMetrics): TurnOutput {
  return {
    response: reason,
    toolCallsExecuted: 0,
    guardrailEvents: [{ type: "blocked", details: reason }],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    blocked: true,
    swarmState,
    performance,
  };
}

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

function measurePrompt(systemMessages: readonly LLMMessage[], history: readonly LLMMessage[]): {
  systemPromptChars: number;
  collapsedHistoryMessages: number;
  collapsedHistoryChars: number;
  promptChars: number;
} {
  const systemPromptChars = systemMessages.reduce((sum, message) => {
    const contentLength = typeof message.content === "string" ? message.content.length : 0;
    return sum + contentLength;
  }, 0);
  const collapsedHistoryChars = history.reduce((sum, message) => {
    const contentLength = typeof message.content === "string" ? message.content.length : 0;
    return sum + contentLength;
  }, 0);
  return {
    systemPromptChars,
    collapsedHistoryMessages: history.length,
    collapsedHistoryChars,
    promptChars: systemPromptChars + collapsedHistoryChars,
  };
}

/**
 * Last-resort base-prompt compaction, used only when the budget trimmer has
 * already dropped every auxiliary block and the prompt is *still* over budget.
 *
 * Strips clearly non-load-bearing verbose sections — the Markdown "## Response
 * Format" guidance — and collapses runs of blank lines. It deliberately leaves
 * Core Principles, Swarm Rules, Tool Use Discipline, Orchestration Strategy,
 * and Security untouched: those carry behavioral and safety contracts. Returns
 * the prompt unchanged when there is nothing safe to remove.
 */
export function compactBasePromptUnderPressure(prompt: string): string {
  let out = prompt;
  // Remove the "## Response Format" section (heading through to the next "## ").
  // Formatting guidance is the lowest-value block under genuine budget
  // pressure: the model still answers correctly without it.
  out = out.replace(/\n## Response Format\n[\s\S]*?(?=\n## )/, "\n");
  // Collapse 3+ consecutive newlines left behind by removals to a single blank line.
  out = out.replace(/\n{3,}/g, "\n\n");
  return out;
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

function buildTurnPerformanceMetrics(input: {
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
  completionChars: number;
  finishReason: string;
  blocked: boolean;
  toolIterations: number;
}): TurnPerformanceMetrics {
  const turnDurationMs = Date.now() - input.turnStartedAt;
  // Per-stage timings recorded by timedPhase() during this turn (empty when no
  // tracked stage ran). untrackedMs is the residual after LLM + tool + tracked
  // stages — it surfaces the next unmeasured cost.
  const phaseStore = _phaseTimingsStore.getStore();
  const phaseTimingsMs = phaseStore && Object.keys(phaseStore).length > 0 ? { ...phaseStore } : undefined;
  const trackedPhaseMs = phaseTimingsMs ? Object.values(phaseTimingsMs).reduce((a, b) => a + b, 0) : 0;
  const untrackedMs = Math.max(0, turnDurationMs - input.llmTimeMs - input.toolExecutionTimeMs - trackedPhaseMs);
  return {
    turnDurationMs,
    firstModelResponseMs: input.firstModelResponseMs,
    llmCalls: input.llmCalls,
    llmTimeMs: input.llmTimeMs,
    toolCallsRequested: input.toolCallsRequested,
    toolExecutionTimeMs: input.toolExecutionTimeMs,
    systemPromptChars: input.lastPromptMetrics.systemPromptChars,
    collapsedHistoryMessages: input.lastPromptMetrics.collapsedHistoryMessages,
    collapsedHistoryChars: input.lastPromptMetrics.collapsedHistoryChars,
    promptChars: input.lastPromptMetrics.promptChars,
    completionChars: input.completionChars,
    toolIterations: input.toolIterations,
    finishReason: input.finishReason,
    blocked: input.blocked,
    // Resolved within the turn's effort context (or config default outside one).
    effortSloBudgetMs: effectiveOrchestratorTurnSloMs(),
    ...(phaseTimingsMs ? { phaseTimingsMs } : {}),
    untrackedMs,
  };
}
