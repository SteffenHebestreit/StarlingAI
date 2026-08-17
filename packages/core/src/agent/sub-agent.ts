/**
 * Sub-Agent Runner
 *
 * Executes a named sub-agent from config with its own model, system prompt, and
 * restricted tool set.  Called by the delegate_to_agent tool.
 *
 * Each sub-agent is isolated:
 *  - Fresh conversation history (no access to parent session)
 *  - Its own chat provider instance (potentially a different model/backend)
 *  - A restricted tool list derived from its config
 *  - Audit entries tagged with the parent session ID so tracing works
 */

import fs from "node:fs";
// Named import: two local `path` bindings already exist in this module, and an
// unqualified `path` default import would shadow-warn against them.
import { resolve as resolvePath } from "node:path";
import { createHash } from "node:crypto";
import type { LLMMessage, ChatProvider } from "../providers/lmstudio.js";
import { DeadlineAbort } from "../providers/lmstudio.js";
import { trimSubAgentHistory } from "./sub-agent-history.js";
import { getConfig } from "../config/loader.js";
import { currentEffortProfile, effectiveOrchestration, effectiveSubAgentTurnSloMs } from "../runtime/effort-context.js";
import { getToolsAsLLMDefs, rerankToolsForTask, executeTool, normalizeToolCall, type ToolContext, type SwarmState, type ToolResult } from "../tools/registry.js";
import { isToolAllowed } from "../guardrails/tool-tiers.js";
import { scanOutput } from "../guardrails/output.js";
import { neutralizeToolResultFraming } from "../guardrails/input.js";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";
import { createCheckpoint, pauseCheckpoint, completeCheckpoint } from "../swarm/checkpoints.js";
import { withSpan, genAi } from "../observability/tracing.js";
import { runSubAgentInContainer } from "./container-runner.js";
import { looksLikeContainerLevelFailure, looksLikeModelTemplateArtifact, looksLikeProviderErrorEcho, looksLikeHallucinatedTruncationClaim } from "./container-failure.js";
import { appendOutcome, computeAdaptiveSubAgentTimeoutMs, extractTaskKeywords } from "./outcomes.js";
import { formatFlowMemoryGuidance } from "./flow-memory.js";
import { acquireSlot, releaseSlot, DEFAULT_CONCURRENCY } from "../swarm/concurrency.js";
import { applyActiveModelPreset, createChatProvider, getChatProviderForTier, resolveProviderEndpoint } from "../providers/index.js";
import { loadTurnPlan } from "./turn-plan.js";
import { computerSessionManager } from "./computer-session.js";
import { browserSessionManager } from "./browser-session.js";
import {
  longRunningGenerationManager,
  longRunningActionForTier,
  DEFAULT_SOFT_THRESHOLD_MS,
  DEFAULT_SOFT_THRESHOLD_TOKENS,
} from "./long-running-generation.js";
import { currentEffortTier } from "../runtime/effort-context.js";
import {
  classifyRunProgress,
  classifyWriteLoop,
  buildProgressJudgePrompt,
  parseProgressVerdict,
  ARG_SIG_REPEAT_LIMIT,
  EMPTY_PROGRESS_SAMPLE,
  MIN_SUBSTANTIVE_OUTPUT_CHARS,
  PROGRESS_CHECK_INTERVAL_MS,
  type ProgressSample,
} from "./progress-verifier.js";
import { formatScopedMemoryGuidance } from "../memory/service.js";
import { formatSkillGuidance } from "../skills/service.js";
import { graphMarkSessionRetrievalsUseful, graphMarkSessionRetrievalsUnhelpful } from "../memory/graph-service.js";
import { isSessionDegraded } from "./warden.js";
import { claimAgentMessages, readAllFacts, type AgentMessageClaim } from "../swarm/memory.js";
import { sanitizeTranscriptContent } from "./sanitize-response.js";
import { truncateToolResult, extractKeyFacts, extractedFindingIsLowValue, stripEditorialNotes } from "../tools/result-shaping.js";
import { buildDynamicTurnGuidance } from "./intent-classifier.js";
import { looksLikeArtifactCreationRequest } from "./deliverable-intent.js";
import { shareFinding } from "../tools/memory.js";
import { buildCanonicalSourceSensitiveDelegationTask, deriveSourceSensitiveDelegationFocus } from "./source-sensitive-delegation.js";
import { looksLikeDegenerateRepetition, collapseRepeatedMarkdownSections } from "./text-dedup.js";
import {
  ORCHESTRATION_DISCOVERY_TOOL_NAMES,
  getEffectiveToolNames,
  buildTaskModeGuidance,
  isDirectRemoteCliTask,
  buildModelExecutionGuidance,
  isOrchestrationCapableRun,
  buildSubAgentToolInventory,
  buildSubAgentAgentDiscoveryGuidance,
  sanitizeSubAgentTask,
  isStagedArtifactBuildRun,
  buildStagedArtifactBuildGuidance,
  STAGED_BUILD_TASK_CHAR_THRESHOLD,
  STAGED_BUILD_REQUIRED_TOOLS,
} from "./sub-agent-prompt-guidance.js";
import { mergeAgentModelOverride, applyEffortModelOverlay, applyStreamCapOverlay } from "./sub-agent-model-config.js";
import { resolveTurnBudgetMs } from "./sub-agent-turn-budget.js";
import {
  extractInfraFailureSignature,
  liveToolFamily,
  updateInfraFailureStreak,
  buildInfraFamilyBlockedMessage,
  INFRA_FAILURE_BLOCK_THRESHOLD,
  type InfraFailureStreak,
} from "./infra-failure.js";
import {
  PASSTHROUGH_DELEGATION_MIN_BYTES,
  truncateToolAuditText,
  looksLikeInterruptedEvidenceBoilerplate,
  extractUsefulInterruptedToolEvidence,
  buildInterruptedSubAgentOutput,
  resolveInterruptedEvidenceSnippets,
  looksLikeTimeoutLikeError,
  maybePreferWorkflowOutput,
  hasDeliverableArtifact,
  classifyInterruptedOutcome,
  buildArtifactCompletionOutput,
  stripHallucinatedToolTags,
  type SubAgentOutcome,
} from "./sub-agent-interruption.js";
// Re-export pure helpers that were extracted from this module so existing
// importers (and tests) of "../agent/sub-agent.js" keep working unchanged.
export {
  mergeAgentModelOverride,
  applyEffortModelOverlay,
  applyStreamCapOverlay,
  resolveAgentStreamCapMs,
  emitsWholeFileArtifacts,
  canWriteWorkspaceFiles,
} from "./sub-agent-model-config.js";
export { getEffectiveToolNames, compactAgentCatalogDescription } from "./sub-agent-prompt-guidance.js";
// Lazy-import clearSearchSessionState to avoid pulling in web.ts at module
// load time, which would re-register web_search/web_fetch and break tests
// that register their own mocks before importing this module.
let _clearSearchSessionState: ((sessionId: string) => void) | undefined;
async function getSearchCleanup(): Promise<(sessionId: string) => void> {
  if (!_clearSearchSessionState) {
    const web = await import("../tools/web.js");
    _clearSearchSessionState = web.clearSearchSessionState;
  }
  return _clearSearchSessionState;
}

const log = childLogger("agent:sub-agent");

const DEFAULT_MAX_ITERATIONS = 5;
// These thresholds are measured in *extracted* finding bytes — the length of
// what extractKeyFacts() distills and stores as a shared fact (≤ 600 chars each).
// This makes the cap measure actual stored knowledge density, not raw dump volume.
// With web_search capped at 14 calls × ~600 chars = ~8,400 chars max from search
// alone, the strip threshold (12,000) acts as an emergency brake for delegation
// chains rather than a normal research stopper.
const SUFFICIENT_EVIDENCE_NUDGE_BYTES = 4_000;    // ~7 extracted findings
const SUFFICIENT_EVIDENCE_TOOL_STRIP_BYTES = 12_000; // ~20 extracted findings
// Oversight (config.orchestration.oversight): max cheap routing-tier "is the goal
// already met?" checks per sub-agent run. Bounded so the oversight only trims the
// long over-fetch tail, never adds an unbounded series of extra model calls.
const OVERSIGHT_MAX_GOAL_CHECKS = 2;
const EVIDENCE_GATHERING_TOOL_NAMES = new Set([
  "delegate_to_agent",
  "parallel_delegate",
  "swarm_delegate",
  "run_task_graph",
  "web_search",
  "web_fetch",
  "browser_navigate",
  // Browser interaction tools require per-call approval; include them so they
  // are stripped when synthesis is forced and cannot hit the approval gate
  // after the agent already has sufficient evidence.
  "browser_click",
  "browser_type",
  "browser_select_option",
  "site_fill_credentials",
]);

/**
 * Cheap routing-tier oversight check: given the turn's acceptance criteria and
 * the evidence a worker agent has gathered SO FAR, is the goal already met well
 * enough to write the final answer now? Returns true ⇒ stop gathering and
 * finalize. Runs on model.tiers.routing (a small fast model), NOT the worker's
 * model, and only at evidence boundaries — so it trims the long over-fetch tail
 * without adding a parallel load on the main model. Any miss (no routing tier,
 * error, ambiguous reply) returns false, so the existing byte/time ladder still
 * applies; the oversight only ever ENDS work earlier, never prolongs it.
 */
export async function assessOversightGoalMet(
  acceptanceCriteria: string[],
  evidence: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (acceptanceCriteria.length === 0) return false;
  const provider = getChatProviderForTier("routing");
  if (!provider) return false;
  const system =
    "You are a swarm oversight checker. A worker agent is gathering evidence for a task. Given the task's "
    + "acceptance criteria and the evidence it has gathered SO FAR, decide whether the goal is ALREADY met well "
    + "enough to write the final answer now. Bias toward stopping: if the evidence already covers the criteria, the "
    + "worker should STOP gathering more. Reply with EXACTLY one word — DONE if the criteria are already satisfied, "
    + "or CONTINUE if a criterion is clearly not yet covered.";
  const user =
    "Acceptance criteria:\n"
    + acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")
    + "\n\nEvidence gathered so far:\n"
    + (evidence || "(none)").slice(0, 3_000);
  try {
    const res = await provider.complete(
      [{ role: "system", content: system }, { role: "user", content: user }],
      [],
      signal,
    );
    return (res.content ?? "").trim().toUpperCase().startsWith("DONE");
  } catch {
    return false;
  }
}

// Discovery/meta tools whose output is routing metadata about the SWARM, never
// evidence about the user's subject. Excluded from the useful-evidence snippet
// buffer and the auto-share pipeline (audit 1ac79471: a search_agents catalog
// dump was auto-shared as a "finding" and polluted sibling builders' context).
const ROUTING_METADATA_TOOL_NAMES = new Set([
  "search_agents",
  "list_agents",
  "search_workflows",
  "search_skills",
  "list_skills",
  "get_swarm_state",
  "recall_context",
  "read_shared_facts",
]);

// Fetch tools whose results are checked for productivity (cost-center 3): a 404,
// block, rate-limit, error page, or non-extractable PDF yields no evidence.
const FETCH_PRODUCTIVITY_TOOL_NAMES = new Set(["web_fetch", "url_inspect", "browser_navigate"]);
const NON_PRODUCTIVE_FETCH_STREAK_LIMIT = 4;
const NON_PRODUCTIVE_FETCH_RE = /could not be extracted|document-extraction service is unavailable|page not found|404 not found|\b403 forbidden\b|\b429\b|too many requests|access denied|rate.?limit|no content|empty (?:page|response)/i;

/** True when a fetch result carried no usable content (cost-center 3, audit 5d51862f). */
export function fetchResultIsNonProductive(success: boolean, content: string): boolean {
  if (!success) return true;
  const head = content.slice(0, 600);
  if (NON_PRODUCTIVE_FETCH_RE.test(head)) return true;
  // A "successful" fetch that returned almost nothing is also non-productive.
  return content.trim().length < 80;
}

// Tools whose presence does NOT disqualify single-delegation passthrough:
// discovery, memory lookup, shared-fact reads, light bookkeeping. If the
// coordinator only ran these plus one substantial delegation, the delegation
// body is the work product.
const PASSTHROUGH_TRIVIAL_TOOL_NAMES = new Set([
  "search_agents",
  "search_workflows",
  "list_agents",
  "list_files",
  "workspace_search",
  "datetime_arithmetic",
  "memory_search",
  "memory_store",
  "memory_promote",
  "read_shared_facts",
  "share_finding",
  "get_swarm_state",
  "research_notes_read",
  "research_notes_summary",
]);

const PASSTHROUGH_DELEGATION_TOOL_NAMES = new Set([
  "delegate_to_agent",
  "parallel_delegate",
  "swarm_delegate",
  "run_task_graph",
  "run_workflow",
]);

const DELEGATE_TOOL_RESULT_PREFIX_RE = /^(Delegated result from|Parallel delegation completed|Task graph (?:completed|finished)|Workflow\s+\S+\s+\[)/i;

interface SingleDelegationPassthroughCandidate {
  output: string;
  delegationToolName: string;
  bytes: number;
  /** Inferred from the wrapper prefix; mirrored on the coordinator's outcome. */
  inferredOutcome: "success" | "partial" | "failure";
}

/** Detect whether the agent's tool history is "single substantial delegation
 * plus only trivial discovery/bookkeeping calls". Returns the full delegation
 * body when so, otherwise null. The caller is expected to surface the body
 * verbatim instead of running another synthesis LLM pass. */
function tryExtractSingleDelegationPassthrough(params: {
  history: readonly LLMMessage[];
  bytesByTool: ReadonlyMap<string, number>;
  toolNames: ReadonlyArray<string>;
}): SingleDelegationPassthroughCandidate | null {
  let chosenDelegationTool: string | null = null;
  let chosenDelegationBytes = 0;
  let substantialCount = 0;
  for (const [name, bytes] of params.bytesByTool.entries()) {
    if (!PASSTHROUGH_DELEGATION_TOOL_NAMES.has(name)) continue;
    if (bytes < PASSTHROUGH_DELEGATION_MIN_BYTES) continue;
    substantialCount += 1;
    if (bytes > chosenDelegationBytes) {
      chosenDelegationBytes = bytes;
      chosenDelegationTool = name;
    }
  }
  if (substantialCount !== 1 || !chosenDelegationTool) return null;

  for (const name of params.toolNames) {
    if (name === chosenDelegationTool) continue;
    if (PASSTHROUGH_TRIVIAL_TOOL_NAMES.has(name)) continue;
    // A non-trivial, non-chosen tool means the agent did real aggregation work
    // beyond a single delegation — passthrough would discard that work.
    return null;
  }

  for (let i = params.history.length - 1; i >= 0; i--) {
    const msg = params.history[i]!;
    if (msg.role !== "tool") continue;
    const content = typeof msg.content === "string" ? msg.content : "";
    if (!content || content.length < PASSTHROUGH_DELEGATION_MIN_BYTES) continue;
    if (!DELEGATE_TOOL_RESULT_PREFIX_RE.test(content)) continue;

    let inferredOutcome: "success" | "partial" | "failure" = "success";
    if (/—\s*TASK FAILED|—\s*FAILED/i.test(content)) inferredOutcome = "failure";
    else if (/—\s*PARTIAL PROGRESS|—\s*PARTIAL/i.test(content)) inferredOutcome = "partial";

    return {
      output: content,
      delegationToolName: chosenDelegationTool,
      bytes: content.length,
      inferredOutcome,
    };
  }
  return null;
}

/** Return the FULL body of the most-recent substantial delegation tool result
 * in `history`, or null. Used by the timeout/interrupt path to surface the
 * actual delegated specialist's answer instead of a 900-char head snippet. */
function extractMostRecentSubstantialDelegationBody(
  history: readonly LLMMessage[],
  minBytes: number = PASSTHROUGH_DELEGATION_MIN_BYTES,
): { content: string; bytes: number } | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i]!;
    if (msg.role !== "tool") continue;
    const content = typeof msg.content === "string" ? msg.content : "";
    if (!content || content.length < minBytes) continue;
    if (!DELEGATE_TOOL_RESULT_PREFIX_RE.test(content)) continue;
    return { content, bytes: content.length };
  }
  return null;
}

/** Lever #2 (audit 1fd36e04): the most-recent COMPLETE (TASK COMPLETED — not
 * partial/failed) substantial delegation deliverable in `history`, or null.
 * Unlike tryExtractSingleDelegationPassthrough this does NOT require the
 * delegation to be the agent's ONLY substantial work: a coordinator that
 * gathered research AND THEN delegated the write to an author should relay the
 * author's finished deliverable at a terminal point instead of re-condensing it
 * with a rushed/timed-out final synthesis (audit 1fd36e04: a 17 KB content_writer
 * guide was re-written down to 9.7 KB at the coordinator's timeout). Restricted
 * to complete successes so partial/failed delegations still take the normal
 * partial-evidence path. */
export function tryExtractLatestCompleteDeliverable(
  history: readonly LLMMessage[],
  minBytes: number = PASSTHROUGH_DELEGATION_MIN_BYTES,
): { content: string; bytes: number } | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i]!;
    if (msg.role !== "tool") continue;
    const content = typeof msg.content === "string" ? msg.content : "";
    if (!content || content.length < minBytes) continue;
    if (!DELEGATE_TOOL_RESULT_PREFIX_RE.test(content)) continue;
    if (/—\s*TASK FAILED|—\s*FAILED|—\s*PARTIAL PROGRESS|—\s*PARTIAL/i.test(content)) continue;
    return { content, bytes: content.length };
  }
  return null;
}

function chooseConfiguredSubAgent(candidates: readonly string[]): string | undefined {
  const configuredAgents = getConfig().subAgents ?? {};
  return candidates.find((name) => name in configuredAgents);
}

function chooseConfiguredAllowedSubAgent(candidates: readonly string[], allowedAgents?: readonly string[]): string | undefined {
  const allowedSet = Array.isArray(allowedAgents) && allowedAgents.length > 0
    ? new Set(allowedAgents)
    : null;
  const configuredAgents = getConfig().subAgents ?? {};
  return candidates.find((name) => name in configuredAgents && (!allowedSet || allowedSet.has(name)));
}

function defaultSourceSensitiveFallbackAgents(agentName: string | undefined): string[] {
  return ["mission_coordinator", "researcher"]
    .filter((candidate) => candidate !== agentName)
    .filter((candidate) => chooseConfiguredSubAgent([candidate]) === candidate);
}

function buildSourceSensitiveChildTaskTitle(agentName: string | undefined, focus: string | undefined): string {
  const target = agentName?.trim() || "specialist";
  const compactFocus = focus?.replace(/\s+/g, " ").trim();
  const title = compactFocus
    ? `Source-sensitive ${target} task: ${compactFocus}`
    : `Source-sensitive ${target} task`;
  return title.length > 120 ? `${title.slice(0, 117)}...` : title;
}

type SubAgentRequiredResearchFallbackRoute = {
  toolName: "delegate_to_agent";
  label: string;
  args: Record<string, unknown>;
  /**
   * Mutable counter shared across all rewrite sites. Once the rewriter
   * has fired once, further discovery calls from the same agent within
   * the same run get blocked rather than re-rewritten — see
   * `enforceSubAgentRequiredResearchFallbackRouteOnToolCall`.
   *
   * Without this guard the coordinator that originally triggered
   * "no agents matched" loops on (search_agents → rewritten to
   * delegate_to_agent(parent_task) → swarm sees the parent's own
   * running task by signature and returns "Task is already running"),
   * which produces zero progress and burns ~5–10s of LLM time per
   * iteration before the budget runs out.
   */
  applyCount: { value: number };
};

function buildSubAgentRequiredResearchFallbackRoute(params: {
  task: string;
  agentName: string;
  allowedAgents?: readonly string[];
  effectiveToolNames?: readonly string[];
  excludedAgents?: readonly string[];
}): SubAgentRequiredResearchFallbackRoute | null {
  if (!(params.effectiveToolNames ?? []).includes("delegate_to_agent")) return null;

  const excludedAgents = new Set(params.excludedAgents ?? []);
  const preferredAgents = defaultSourceSensitiveFallbackAgents(params.agentName)
    .filter((candidate) => !excludedAgents.has(candidate))
    .filter((candidate) => chooseConfiguredAllowedSubAgent([candidate], params.allowedAgents) === candidate);
  const selectedAgent = preferredAgents[0];
  if (!selectedAgent && Array.isArray(params.allowedAgents) && params.allowedAgents.length > 0) {
    return null;
  }

  const fallbackAgents = preferredAgents.filter((candidate) => candidate !== selectedAgent);
  return {
    toolName: "delegate_to_agent",
    label: selectedAgent ?? "autonomous_routing",
    args: {
      ...(selectedAgent ? { agentName: selectedAgent } : {}),
      ...(fallbackAgents.length > 0 ? { fallbackAgents } : {}),
      task: params.task,
      taskTitle: buildSourceSensitiveChildTaskTitle(selectedAgent, "fallback after agent discovery no-match"),
    },
    applyCount: { value: 0 },
  };
}

function subAgentSearchAgentsReturnedNoMatch(result: ToolResult): boolean {
  const resultCount = typeof result.metadata?.["resultCount"] === "number"
    ? Number(result.metadata["resultCount"])
    : undefined;
  const topResult = typeof result.metadata?.["topResult"] === "string"
    ? String(result.metadata["topResult"]).trim()
    : "";
  if (resultCount === 0 && !topResult) return true;
  return /^No agents matched\b/i.test(result.output.trim());
}

function enforceSubAgentRequiredResearchFallbackRouteOnToolCall(
  toolCall: { name: string; arguments: Record<string, unknown> },
  route: SubAgentRequiredResearchFallbackRoute,
  subSessionId: string,
  agentName: string,
): boolean {
  const discoveryRetryTools = new Set(["search_agents", "list_agents", "search_workflows"]);
  if (!discoveryRetryTools.has(toolCall.name)) return false;

  // Hard cap: only rewrite the FIRST repeated discovery call. On subsequent
  // calls, leave the original tool name intact and let the per-tool cap for
  // search_agents/list_agents/search_workflows surface a structured refusal
  // that the model can act on without burning another LLM round-trip on a
  // guaranteed-no-op delegation.
  if (route.applyCount.value >= 1) {
    logAudit("sub_agent_tool_call", {
      agentName,
      tool: toolCall.name,
      phase: "recovered",
      reason: "required_research_discovery_retry_capped",
      rewriteApplyCount: route.applyCount.value,
    }, { sessionId: subSessionId, severity: "warn" });
    return false;
  }

  const originalTool = toolCall.name;
  toolCall.name = route.toolName;
  toolCall.arguments = { ...route.args };
  route.applyCount.value += 1;
  logAudit("sub_agent_tool_call", {
    agentName,
    tool: originalTool,
    phase: "recovered",
    reason: "required_research_discovery_retry_rewritten",
    rewrittenTo: route.toolName,
    recoveredAgentName: route.label,
  }, { sessionId: subSessionId, severity: "warn" });
  return true;
}

function withDefaultSourceSensitiveFallbackAgents(args: Record<string, unknown>): Record<string, unknown> {
  const agentName = typeof args["agentName"] === "string" ? String(args["agentName"]).trim() : undefined;
  if (!agentName) return args;
  const existingFallbacks = Array.isArray(args["fallbackAgents"])
    ? args["fallbackAgents"].map(String).filter(Boolean)
    : [];
  if (existingFallbacks.length > 0) return args;
  const fallbackAgents = defaultSourceSensitiveFallbackAgents(agentName);
  return fallbackAgents.length > 0 ? { ...args, fallbackAgents } : args;
}

// Built-in default: 2 (safe for single local GPU).
// Configurable at runtime via orchestration.maxParallelSlices in the gateway settings.
const DEFAULT_MAX_SOURCE_SENSITIVE_PARALLEL_SLICES = 2;

// Delegation tools that spawn one or more nested sub-agent turns (so they
// deepen the tree). create_ephemeral_agent only defines an agent — the
// subsequent delegate_to_agent is what actually nests — so it's excluded.
const DELEGATION_TOOL_NAMES = new Set([
  "delegate_to_agent",
  "parallel_delegate",
  "swarm_delegate",
  "run_task_graph",
]);
function isDelegationToolName(name: string): boolean {
  return DELEGATION_TOOL_NAMES.has(name);
}

// How many `sub:` hops deep this session is. The orchestrator is depth 0; its
// direct sub-agents are depth 1; their sub-agents depth 2; and so on (mirrors
// the `deriveRootSessionId` walker). Used to bound the delegation tree.
function delegationDepthFromSessionId(sessionId: string): number {
  let depth = 0;
  let current = sessionId;
  while (current.startsWith("sub:")) {
    depth += 1;
    current = current.slice("sub:".length);
  }
  return depth;
}

// True once an ancestor has already fanned this task into source-sensitive
// cross-check slices (the task arrives pre-wrapped as "…DELEGATION SLICE i/N").
// Both delegation builders only emit the SLICE label when they fanned out, so a
// single canonical hand-off ("…DELEGATION:" with no SLICE) is not treated as a
// prior fan-out.
function wasAlreadySlicedUpstream(parentTask: string): boolean {
  return parentTask.includes("SOURCE-SENSITIVE DELEGATION SLICE");
}

function enforceSourceSensitivePreEvidenceDelegation(
  toolCall: { name: string; arguments: Record<string, unknown> },
  parentTask: string,
  subSessionId: string,
  agentName: string,
): void {
  // Pre-evidence source-sensitive enforcement rewrites every parallel slice to
  // the SAME canonical parent task, so a SECOND fan-out only produces identical
  // copies. The first layer to fan out (orchestrator or a single coordinator)
  // keeps its configured cross-check slices; if THIS task already arrived sliced
  // from upstream, re-slicing here just compounds the tree 2→4→8 and blows the
  // turn budget — so collapse to a single canonical delegation instead.
  const isNested = wasAlreadySlicedUpstream(parentTask);
  const originalArgs = toolCall.arguments ?? {};
  let nextArgs: Record<string, unknown> | null = null;

  if (toolCall.name === "delegate_to_agent" || toolCall.name === "swarm_delegate" || toolCall.name === "create_ephemeral_agent") {
    const originalTask = typeof originalArgs["task"] === "string" ? String(originalArgs["task"]) : "";
    const focus = deriveSourceSensitiveDelegationFocus(originalTask, parentTask);
    const delegatedAgentName = typeof originalArgs["agentName"] === "string" ? String(originalArgs["agentName"]).trim() : undefined;
    nextArgs = withDefaultSourceSensitiveFallbackAgents({
      ...originalArgs,
      task: buildCanonicalSourceSensitiveDelegationTask(parentTask, undefined, focus),
      taskTitle: buildSourceSensitiveChildTaskTitle(delegatedAgentName, focus),
    });
    delete nextArgs["context"];
  } else if (toolCall.name === "parallel_delegate") {
    const rawTasks = Array.isArray(originalArgs["tasks"])
      ? originalArgs["tasks"].filter((taskSpec): taskSpec is Record<string, unknown> => Boolean(taskSpec) && typeof taskSpec === "object")
      : [];
    if (rawTasks.length > 0) {
      const sliceCap = isNested
        ? 1
        : (effectiveOrchestration().maxParallelSlices ?? DEFAULT_MAX_SOURCE_SENSITIVE_PARALLEL_SLICES);
      const cappedTasks = rawTasks.slice(0, sliceCap);
      if (rawTasks.length > cappedTasks.length) {
        logAudit(
          "sub_agent_tool_call",
          {
            agentName,
            tool: "parallel_delegate",
            phase: "recovered",
            reason: isNested ? "source_sensitive_nested_parallel_collapsed" : "source_sensitive_parallel_slice_cap",
            originalTaskCount: rawTasks.length,
            cappedTaskCount: cappedTasks.length,
          },
          { sessionId: subSessionId, severity: isNested ? "warn" : "info" },
        );
      }
      nextArgs = {
        ...originalArgs,
        tasks: cappedTasks.map((taskSpec, index) => {
          const originalTask = typeof taskSpec["task"] === "string" ? String(taskSpec["task"]) : "";
          const focus = deriveSourceSensitiveDelegationFocus(originalTask, parentTask);
          const nextTask = withDefaultSourceSensitiveFallbackAgents({
            ...taskSpec,
            task: buildCanonicalSourceSensitiveDelegationTask(
              parentTask,
              cappedTasks.length > 1 ? `SLICE ${index + 1}/${cappedTasks.length}` : undefined,
              focus,
            ),
          });
          delete nextTask["context"];
          return nextTask;
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
        objective: parentTask,
        nodes: rawNodes.map((node, index) => {
          const originalTask = typeof node["task"] === "string" ? String(node["task"]) : "";
          const focus = deriveSourceSensitiveDelegationFocus(originalTask, parentTask);
          const nextNode = withDefaultSourceSensitiveFallbackAgents({
            ...node,
            task: buildCanonicalSourceSensitiveDelegationTask(parentTask, `GRAPH NODE ${index + 1}/${rawNodes.length}`, focus),
          });
          delete nextNode["context"];
          return nextNode;
        }),
      };
    }
  }

  if (!nextArgs || JSON.stringify(nextArgs) === JSON.stringify(originalArgs)) return;
  toolCall.arguments = nextArgs;
  logAudit("sub_agent_tool_call", {
    agentName,
    tool: toolCall.name,
    phase: "recovered",
    reason: "source_sensitive_pre_evidence_parent_task_enforced",
  }, { sessionId: subSessionId, severity: "info" });
}

function deriveRootSessionId(sessionId: string): string {
  let current = sessionId;
  while (current.startsWith("sub:")) {
    const inner = current.slice("sub:".length);
    const lastColon = inner.lastIndexOf(":");
    if (lastColon === -1) return inner;
    const secondLastColon = inner.lastIndexOf(":", lastColon - 1);
    if (secondLastColon === -1) return inner;
    current = inner.slice(0, secondLastColon);
  }
  return current;
}

function hashSharedFindingKey(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

async function formatSharedFactsContext(sessionId: string, maxChars = 2_400): Promise<{ content: string; signature: string }> {
  try {
    const facts = await readAllFacts(deriveRootSessionId(sessionId));
    const entries = Object.entries(facts)
      .filter(([, value]) => value.trim().length > 0)
      .sort(([left], [right]) => left.localeCompare(right));
    const signature = entries.map(([key, value]) => `${key}:${value}`).join("\n");
    if (entries.length === 0) return { content: "", signature };

    const lines: string[] = [];
    let usedChars = 0;
    for (const [key, value] of entries) {
      const line = `- ${key}: ${value.replace(/\s+/g, " ").trim()}`;
      if (usedChars + line.length > maxChars && lines.length > 0) break;
      lines.push(line.length > maxChars ? `${line.slice(0, maxChars - 3)}...` : line);
      usedChars += line.length;
      if (lines.length >= 12) break;
    }

    return {
      content: [
        "## Shared findings snapshot",
        "Use these before calling more tools. Do not duplicate work already captured here; verify any remaining assumptions against evidence before drafting.",
        ...lines,
      ].join("\n"),
      signature,
    };
  } catch (err) {
    log.debug({ err, sessionId }, "Failed to read shared facts snapshot");
    return { content: "", signature: "" };
  }
}

/**
 * Build the facts-first synthesis prompt: the user's TASK plus the CURATED
 * FINDINGS already gathered this run, instead of the ~20K-token raw history the
 * slow 35B chokes on (audit 1dc806bf: researchers gathered 13-16 findings then
 * "produced no final response"). Pure + exported for tests.
 */
export function buildFactsFirstSynthesisMessages(task: string, curatedFindings: string): LLMMessage[] {
  return [
    {
      role: "system",
      content:
        "You are writing the FINAL answer for the task below. You are given CURATED FINDINGS already gathered and verified during this run. "
        + "Write the complete, well-structured final answer NOW from those findings. "
        + "Include every concrete fact, name, number, spec, price, and source URL the findings contain; never invent anything not present, and mark anything the findings did not establish as unverified. "
        // Anti-conflation: a weak model mixes specs across components — e.g. a run
        // that gathered an ANALOG microphone's specs AND a separate chip's I2S
        // interface concluded the microphone was "I2S/digital" (audit: IM73A135V01).
        + "Attribute every spec to the exact component the findings tie it to; never carry a spec from one component over to another. "
        + "Do NOT call any tools. Do NOT mention deadlines or these instructions. Reply in the user's language.",
    },
    {
      role: "user",
      content:
        `TASK:\n${task.trim()}\n\n`
        + `CURATED FINDINGS (already gathered + verified this run — your source material):\n${curatedFindings}\n\n`
        + "Write the complete final answer now.",
    },
  ];
}

// Returns the extracted finding text that was stored, or null if skipped
// (too short, duplicate, or boilerplate). The caller counts the returned
// length toward cumulativeUsefulEvidenceBytes so the evidence cap tracks
// actual stored knowledge density rather than raw tool output volume.
/**
 * LLM distillation pass for the auto-share path. Given the sub-agent's OBJECTIVE
 * ("what we're looking for") and the raw content a tool returned, extract ONLY the
 * objective-relevant facts/figures/dates/prices and their source URLs as a compact
 * bullet list — dropping navigation, login/cookie boilerplate, and anything off-topic.
 * Returns the distilled text, "" when nothing relevant was found, or null on
 * failure/abort (caller then keeps the heuristic extract — never drops evidence).
 * One short model call; gated + bounded by the caller.
 */
export async function distillFindingForSharedFacts(params: {
  objective: string;
  toolName: string;
  rawEvidence: string;
  provider: ChatProvider;
  signal?: AbortSignal;
}): Promise<string | null> {
  const objective = params.objective.replace(/\s+/g, " ").trim().slice(0, 600);
  const raw = params.rawEvidence.slice(0, 6000);
  const messages: LLMMessage[] = [
    {
      role: "system",
      content:
        "You are an evidence-distillation step in a research pipeline. You are given a research OBJECTIVE "
        + "and RAW CONTENT that a tool returned. Extract ONLY the information in the raw content that is "
        + "relevant to the objective: concrete facts, figures, dates, names, prices, specs, and the source "
        + "URL(s) they came from. Output a compact Markdown bullet list (at most 8 bullets). Preserve exact "
        + "numbers, units, and URLs verbatim. DROP navigation menus, cookie/consent/login banners, site "
        + "chrome, and anything not relevant to the objective. Do NOT add facts that are not in the raw "
        + "content. "
        // Anti-editorializing: a weak model tends to append its own interpretation
        // — e.g. it stored "Manufacturer: Infineon (Note: search results for
        // STMicroelectronics incorrectly attribute this to Infineon)", a confused
        // caveat that is not a fact and pollutes shared facts. Each stored finding
        // must be a clean fact as the source states it, with no commentary.
        + "Copy each value exactly as the source states it. Do NOT add your own notes, caveats, "
        + "corrections, interpretations, or parenthetical commentary, and do NOT try to reconcile or "
        + "explain disagreements between sources — output only the facts themselves, each as a single "
        + "bullet with its value and (where present) its source URL. "
        + "If the raw content contains nothing relevant to the objective, reply with exactly: NONE",
    },
    {
      role: "user",
      content: `OBJECTIVE:\n${objective}\n\nRAW CONTENT (from ${params.toolName}):\n${raw}`,
    },
  ];
  try {
    const response = await params.provider.complete(messages, [], params.signal);
    const distilled = (response.content ?? "").trim();
    if (!distilled || /^NONE\b/i.test(distilled)) return "";
    return distilled;
  } catch {
    return null;
  }
}

async function autoShareUsefulFinding(params: {
  sessionId: string;
  agentName: string;
  toolName: string;
  evidence: string;  // raw (structured) tool output — not whitespace-collapsed
  sharedKeys: Set<string>;
  objective: string;
  provider: ChatProvider;
  signal?: AbortSignal;
  distill?: { enabled: boolean; minChars: number; budget: { remaining: number }; provider?: ChatProvider };
}): Promise<string | null> {
  // Normalize only for length check and dedup key — preserve structure for extraction
  const normalized = params.evidence.replace(/\s+/g, " ").trim();
  if (normalized.length < 180) return null;
  if (params.toolName === "share_finding" || params.toolName === "read_shared_facts") return null;
  if (/^(?:No agents matched|No workflows matched|Tool calls executed:|Iterations completed:)/i.test(normalized)) return null;

  const key = `auto_${params.agentName.replace(/[^a-z0-9_]+/gi, "_").toLowerCase().slice(0, 24)}_${params.toolName.replace(/[^a-z0-9_]+/gi, "_").toLowerCase().slice(0, 24)}_${hashSharedFindingKey(normalized)}`;
  if (params.sharedKeys.has(key)) return null;
  params.sharedKeys.add(key);

  // Extract key facts from the structured (un-normalized) evidence: strips
  // boilerplate headers and bare URLs, extracts title+snippet per search result.
  // This produces a compact, information-dense summary instead of a head-truncated
  // raw dump that wastes shared-facts space on headers and URL lines.
  const extracted = extractKeyFacts(params.evidence, params.toolName);

  // Quality gate (fast, no model call): only the extracted "good stuff" goes into
  // shared facts. If what survived extraction is still raw PDF/binary bytes, a bare
  // HTTP-probe dump, or navigation/login boilerplate, skip the share — it would
  // pollute the shared findings the final synthesis and evidence backstop read from.
  if (extractedFindingIsLowValue(extracted)) {
    params.sharedKeys.delete(key);
    return null;
  }

  // Distillation: for a LARGE web-research extract, hand the objective + raw content to
  // a one-shot model pass that keeps only the objective-relevant facts/URLs. Keeps
  // shared findings dense and shrinks the context the final synthesis must read. Bounded
  // per run; on failure/abort, keep the heuristic extract (never drops evidence).
  // Scoped to web-research tools — that is where scraped page chrome / search-result
  // noise comes from. Structured outputs (ssh_exec, DB queries, delegation results, file
  // contents) are returned as-is: distilling them risks dropping precise data.
  let toShare = extracted;
  const distill = params.distill;
  if (
    distill?.enabled
    && /^(?:web_search|web_fetch|browser_)/i.test(params.toolName)
    && distill.budget.remaining > 0
    && extracted.length >= distill.minChars
  ) {
    distill.budget.remaining -= 1;
    const distilled = await distillFindingForSharedFacts({
      objective: params.objective,
      toolName: params.toolName,
      rawEvidence: params.evidence,
      // Distillation is a lightweight extraction — run it on the routing tier
      // (a smaller/faster model) when one is configured, so the per-finding
      // distill cost stays low on a single GPU. Falls back to the agent's own
      // provider when no routing tier is set (no behavior change).
      provider: distill.provider ?? params.provider,
      signal: params.signal,
    });
    if (distilled === "") {
      // Nothing in this result was relevant to the objective — don't pollute facts.
      params.sharedKeys.delete(key);
      return null;
    }
    if (distilled && !extractedFindingIsLowValue(distilled)) {
      toShare = distilled;
    }
  }

  // Deterministic last line of defense against the distiller editorializing —
  // strip any "(Note: …)" / "Hinweis: …" the model added in its own voice (these
  // are never source facts and on a weak model are often wrong/backwards). If the
  // finding was nothing but a note, it collapses to low-value and is skipped.
  const cleaned = stripEditorialNotes(toShare);
  if (!cleaned || extractedFindingIsLowValue(cleaned)) {
    params.sharedKeys.delete(key);
    return null;
  }

  await shareFinding(
    params.sessionId,
    key,
    `[${params.agentName}/${params.toolName}] ${cleaned}`,
  );
  return cleaned;
}

// Per-tool call caps enforced inside sub-agent runs.
// These prevent a single tool from dominating the iteration budget
// (e.g. repeated computer_session_start after a connection failure).
const SUB_AGENT_PER_TOOL_CAPS: Partial<Record<string, number>> = {
  computer_session_start: 4,
  computer_session_stop: 2,
  computer_session_attach: 2,
  computer_list_nodes: 2,
  computer_list_windows: 3,
  computer_focus_window: 3,
  computer_snapshot: 8,
  web_search: 14,
  web_fetch: 16,
  // KB retrieval can honestly loop like web_search; lifecycle calls cannot.
  search_knowledge_base: 12,
  list_knowledge_bases: 4,
  create_knowledge_base: 2,
  manage_knowledge_base: 3,
  use_knowledge_base: 3, // spawns a worker sub-agent — keep it delegate-tight

  search_workflows: 2,
  search_agents: 2,
  list_agents: 2,
  run_workflow: 2,
  computer_click: 6,
  computer_type: 4,
  computer_hotkey: 4,
  delegate_to_agent: 3,
  swarm_delegate: 3,
  create_ephemeral_agent: 1,
  // Path-keyed cap (see PATH_KEYED_WRITE_TOOLS below). For these tools the
  // cap is per `(tool, path)` rather than per `tool`, so a content_writer
  // building a 4-file website doesn't get blocked at the 3rd file. The
  // number here is the soft TOTAL cap as a backstop; session 2d810e7d
  // (2026-05-28) showed an honest 4-file write blocked at file 4 under
  // the old flat cap of 3.
  // Raised from 12 to accommodate incremental large-file builds (write head +
  // many mode:"append" chunks) without tripping the flat per-tool cap; the
  // content-hash loop rule at the call site remains the real loop guard.
  write_file: 24,
  // Raised 12 -> 24 alongside PER_PATH_EDIT_CAP. This one is a TOTAL across every
  // path, so at 12 it bound tighter than the per-path cap the moment a staged build
  // touched more than one file (index.html + app.js + data.json is three skeletons
  // and three fill sequences sharing the same budget).
  edit_file: 24,
  generate_document: 4,
  generate_website: 2,
  generate_presentation: 2,
  generate_docx: 4,
  generate_pptx: 4,
  generate_pdf: 4,
  render_pdf: 4,
  export_workspace_artifact: 4,
  bundle_artifact_zip: 2,
};

// For these tools the cap is enforced per-(tool, path) so writing N
// different files only counts as 1 call against each path. A real loop
// (same path written repeatedly) still trips the cap at PER_PATH_CAP.
const PATH_KEYED_WRITE_TOOLS = new Set<string>([
  "write_file", "edit_file",
  "generate_document", "generate_docx", "generate_pptx", "generate_pdf", "render_pdf",
  "export_workspace_artifact",
]);
// NOTE: the old flat `PER_PATH_WRITE_CAP = 2` is gone. "Same path twice" is not a
// loop — a builder legitimately rewrites one file several times while converging on
// it — and the cap sat absurdly below its own siblings (append 24, edit 24). What IS
// a loop is same path + same BYTES, or an A→B→A→B oscillation, and both are now
// detected by content hash at the call site (classifyWriteLoop in progress-verifier).
// Plain overwrites fall back to PER_PATH_EDIT_CAP as the far-out backstop.
// write_file(mode:"append") to the same path is the incremental-build path (write
// head → append chunks), so one file legitimately takes many appends. Bound it
// generously to still catch a true runaway, but well above a chunked large file.
const PER_PATH_APPEND_CAP = 24;
/**
 * Per-path ceiling for edit_file. An edit-test-edit loop — locate the failure, change
 * the smallest unique span, re-run the test, repeat — touches ONE file many times by
 * design, which is the whole point of editing in place rather than rewriting. The
 * overwrite cap of 2 exists to catch a model rewriting the same file in circles; it
 * is the wrong instrument for surgical edits, and applying it here capped the loop at
 * a single correction. edit_file is also self-limiting in a way write_file is not: it
 * fails when old_string is absent or ambiguous, so a confused agent stops rather than
 * silently churning. Bounded well above a real convergence run, still far below a
 * runaway.
 *
 * Raised 12 -> 24 for staged artifact builds. A staged build is skeleton (one
 * write_file) + ONE edit_file per subsystem + verification-driven corrections, all
 * against the SAME path, so the passes are the deliverable rather than a loop. The
 * widest builder iteration budget in the workspace is 14 (web_coder, backend_coder),
 * which the directive turns into 11 fill passes — at 12 the cap bit after a single
 * correction, i.e. exactly when the artifact was nearly finished and the work was
 * most expensive to lose. 24 matches the write_file total below and still leaves the
 * ambiguity failure (edit_file rejects an absent or non-unique old_string) as the
 * real brake on a confused agent.
 */
const PER_PATH_EDIT_CAP = 24;
// A FAILED tool call (most often arguments the model can fix by re-emitting them —
// e.g. generate_presentation rejecting a JSON-string `slides` arg) must NOT burn the
// per-tool SUCCESS cap, or a couple of mis-serializations hard-block a build tool
// mid-task (audit 2daf5f54: "slides must be an array" twice → build collapse). Failed
// calls are refunded from the success cap and counted under this separate, bounded
// budget so a genuinely-stuck arg-rejection loop is still capped.
const PER_TOOL_FAILURE_CAP = 4;

// Artifact-persistence tools share a CROSS-TOOL thrash guard. The per-tool FAILURE cap (4)
// already lets a single artifact tool recover from a few arg rejections — e.g. a deck builder
// that mis-serializes `slides` 3× then fixes it (audit 2daf5f54), which must NOT be blocked.
// The distinct failure is a coordinator that fundamentally cannot emit a large deliverable and
// thrashes ACROSS the family (audit 5fec8427: generate_document ×2 "content is required" then
// write_file ×3 "path is required" — the slow 35B hits finishReason:"length" emitting the doc
// inline, so the required arg arrives empty; each tool stays under its own cap and only
// max_iterations stops it, ~6 min wasted, zero artifacts). So we trip only when failures span
// >=2 DISTINCT artifact tools AND total >=3 — then block the family with a nudge to deliver the
// content inline (the correct fallback anyway; the synthesis ships it). Single-tool recovery is
// untouched.
const ARTIFACT_PERSIST_TOOLS = new Set<string>([
  "write_file",
  "generate_document",
  "generate_pdf",
  "render_pdf",
  "generate_website",
  "generate_presentation",
  "export_workspace_artifact",
]);

export interface SalvagedTruncatedWrite {
  path: string;
  mode?: "overwrite" | "append" | "create";
  content: string;
}

function safeJsonUnescape(escaped: string): string | null {
  try {
    return JSON.parse(`"${escaped}"`) as string;
  } catch {
    return null;
  }
}

/**
 * Salvage a write_file call whose JSON arguments were CUT OFF by the model's output
 * limit. The slow local model repeatedly tries to emit an ENTIRE large file as one
 * tool-call argument, hits finishReason:"length" mid-string, and the unparseable
 * args execute as {} → "path is required" → zero bytes written and ~2 minutes of
 * generation wasted (audits 5fec8427, c2f76a00, 77944865 — prompt-level "write in
 * chunks" instructions failed twice, so this is the MECHANICAL fix). Extract the
 * complete "path" (and "mode" when present) plus the partial "content" string,
 * strip any trailing half-finished escape sequence, and return executable args so
 * the truncation becomes a PARTIAL WRITE the model can continue with mode:"append".
 * Returns null when no complete path or no meaningful content can be recovered.
 */
export function salvageTruncatedWriteFileArgs(rawArgs: string): SalvagedTruncatedWrite | null {
  const raw = String(rawArgs ?? "");
  if (raw.length < 64) return null;
  const pathMatch = raw.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const path = pathMatch?.[1] !== undefined ? safeJsonUnescape(pathMatch[1]) : null;
  if (!path || !path.trim()) return null;
  const modeMatch = raw.match(/"mode"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const rawMode = modeMatch?.[1]?.toLowerCase();
  const mode = rawMode === "overwrite" || rawMode === "append" || rawMode === "create" ? rawMode : undefined;
  const contentMatch = raw.match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)/);
  let body = contentMatch?.[1] ?? "";
  // Drop a trailing escape sequence the cut-off left incomplete ("\", "\u12").
  body = body.replace(/\\u[0-9a-fA-F]{0,3}$/, "").replace(/(?<!\\)\\$/, "");
  const content = safeJsonUnescape(body);
  // Below ~200 chars the salvage is not worth a partial file — let the model re-issue.
  if (!content || content.length < 200) return null;
  return { path: path.trim(), ...(mode ? { mode } : {}), content };
}
const ARTIFACT_PERSIST_DISTINCT_TOOLS_TRIP = 2;
const ARTIFACT_PERSIST_TOTAL_FAILURES_TRIP = 3;

const COORDINATOR_SUB_AGENT_PER_TOOL_CAP_OVERRIDES: Partial<Record<string, number>> = {
  delegate_to_agent: 6,
  swarm_delegate: 6,
  // When the I13 cascade-timeout fallback injects web_search / web_fetch into a
  // coordinator that ran out of delegation options, the default cap of 6 is far
  // too low for multi-topic research briefs. Allow coordinators up to 20 direct
  // searches and 25 fetches so they can produce a meaningful synthesis instead of
  // returning a partial answer after hitting the cap mid-task.
  web_search: 20,
  web_fetch: 25,
};

const GATEWAY_BOUND_SERVICE_TOOL_PREFIXES = [
  "mail_",
  "calendar_",
  "contacts_",
  // MCP tools reach their MCP servers through the gateway's host-side MCP
  // registry. The agent-worker container runs with `--network none` and no
  // gateway config, so any mcp__* call (e.g. mcp__code_sandbox__run_js used by
  // `coder`) fails opaquely as "container error: unknown" with zero model
  // progress. Force MCP-using agents in-process. The sandboxing those tools
  // need is provided by the MCP service itself, not the agent-worker container.
  "mcp__",
];

// Tools whose output is deterministic enough within a single sub-agent run that
// re-issuing the call with identical arguments is wasted work. The existing
// `lastToolCallSig` map only catches *consecutive* duplicates (A→A); this set
// powers a broader (name, args) cache that also catches A→B→A loops, which
// account for the majority of iteration-budget burn in research and discovery
// runs. Excluded by design: any tool that reflects mutating state (browser
// session, computer session, swarm state, mail send/draft, file writes) or
// queries that may legitimately need a fresh fetch (get_swarm_state, browser_*).
const IDEMPOTENT_TOOLS = new Set<string>([
  "read_file",
  "list_files",
  "list_agents",
  "search_agents",
  "search_tools",
  "search_workflows",
  "extract_file_content",
  "spreadsheet_read",
  "list_pdf_form_fields",
  "list_tts_voices",
  "web_search",
  "web_fetch",
  "workspace_search",
]);

/**
 * Structural completeness check for a written text artifact, used by the
 * deterministic artifact completion ("done is done"). A run that gets cut by
 * its turn timeout mid-build leaves a half-written file behind; branding that
 * "Deliverable completed" ships a broken app to the user (audit e5b5850b:
 * web_coder wrote the 21KB HTML/CSS skeleton of a quiz platform, the 240s
 * timeout killed it while generating the data/JS chunk, and the run reported
 * the file as a finished deliverable — it ended mid-<script> with no
 * questions, no logic, and no closing tag).
 *
 * Checks are FORMAT-VALIDITY checks, not content heuristics: an .html file
 * must contain a closing </html> tag; a .json file must parse. Returns a short
 * human-readable reason when the file looks truncated, null when it looks
 * complete or cannot be assessed (missing path, unreadable, other formats).
 *
 * `workspaceRoot` resolves RELATIVE artifact paths. write_file's metadata sets
 * `path` to the path the MODEL passed (relative, e.g. "generated/app/index.html")
 * and only `outputPath` to the workspace-relative resolved one — so without a root
 * this existsSync missed the file entirely against the gateway's cwd and returned
 * null, i.e. every half-written write_file artifact was silently reported complete.
 * Callers that already hold an absolute path (runtime.ts, turn-corrective.ts) are
 * unaffected: an absolute path that exists is used as-is.
 */
export function artifactFileLooksTruncated(artifact: Record<string, unknown>, workspaceRoot?: string): string | null {
  try {
    const rawPath = typeof artifact["path"] === "string" ? artifact["path"] : "";
    const relPath = typeof artifact["outputPath"] === "string" ? artifact["outputPath"] : "";
    const candidates = [
      rawPath,
      ...(workspaceRoot ? [rawPath ? resolvePath(workspaceRoot, rawPath) : "", relPath ? resolvePath(workspaceRoot, relPath) : ""] : []),
    ].filter(Boolean);
    const absPath = candidates.find((candidate) => fs.existsSync(candidate)) ?? "";
    if (!absPath) return null;
    const stat = fs.statSync(absPath);
    if (!stat.isFile() || stat.size === 0 || stat.size > 5_000_000) return null;
    const name = (typeof artifact["filename"] === "string" && artifact["filename"]
      ? artifact["filename"]
      : absPath).toLowerCase();
    if (name.endsWith(".html") || name.endsWith(".htm")) {
      const text = fs.readFileSync(absPath, "utf8");
      // Only judge full documents — an HTML fragment/partial template without
      // an <html> open tag has no required terminator.
      if (/<html[\s>]/i.test(text.slice(0, 2000)) && !/<\/html>/i.test(text.slice(-4000))) {
        return "missing closing </html> tag — the file ends mid-document";
      }
      return null;
    }
    if (name.endsWith(".json")) {
      const text = fs.readFileSync(absPath, "utf8");
      try {
        JSON.parse(text);
      } catch {
        return "not valid JSON (parse failed) — the file appears cut off";
      }
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Describe the workspace files a run actually mutated, for the interrupted/cut-off
 * paths. A staged build that dies mid-way has real work on disk — the skeleton plus
 * however many subsystems landed — and the previous salvage saw NONE of it when the
 * fills went through edit_file (whose metadata carries no outputPath, so the artifact
 * recorder skips it). Reporting the paths, their real on-disk size, and their
 * structural completeness is the difference between handing the parent a resumable
 * build and handing it the 37-character "produced no usable output" string that run
 * f08195d2 shipped after 20,129 tokens of work.
 *
 * Reads the filesystem, so it is only called on the terminal paths, never per
 * iteration. Fails open: an unreadable file is reported by path alone.
 */
export function describeMutatedWorkspaceFiles(
  paths: Iterable<string>,
  workspaceRoot: string,
): string[] {
  const lines: string[] = [];
  for (const relPath of paths) {
    if (lines.length >= 6) break;
    let sizeNote = "";
    let truncationNote = "";
    try {
      const abs = resolvePath(workspaceRoot, relPath);
      const stat = fs.existsSync(abs) ? fs.statSync(abs) : null;
      if (!stat?.isFile()) continue;
      sizeNote = ` (${stat.size} bytes on disk)`;
      const reason = artifactFileLooksTruncated({ path: abs, filename: relPath }, workspaceRoot);
      truncationNote = reason ? ` — INCOMPLETE: ${reason}` : "";
    } catch {
      // fall through: name the path even when it cannot be stat'd
    }
    lines.push(`- ${relPath}${sizeNote}${truncationNote}`);
  }
  return lines;
}

/**
 * Tools that observe or mutate LIVE, changing state — a browser page or a remote
 * desktop. Their result is never safe to dedup/cache against an earlier identical
 * call, because the state changes between calls: e.g. after site_fill_credentials
 * submits a login, re-navigating to the same URL or re-snapshotting must fetch the
 * NEW post-login page, not replay the stale pre-login form. Caching these makes a
 * successful login look like it failed (and trips the blocked-iteration loop
 * detector). The loop detector still catches genuinely stuck repeats.
 */
export function isLiveStateTool(name: string): boolean {
  return name.startsWith("browser_") || name.startsWith("computer_");
}

function isApprovalGateFailure(text: string | undefined): boolean {
  if (!text) return false;
  return /\b(?:approval (?:timed out|expired|failed|was not granted|not granted|explicitly denied)|execution denied by user|requires human approval|no approval channel)\b/i.test(text);
}

function buildApprovalRetryBlockedMessage(toolName: string, priorFailure: string): string {
  const normalized = priorFailure.replace(/\s+/g, " ").trim();
  return [
    `Tool '${toolName}' is no longer available in this sub-agent run because its human approval gate was not satisfied.`,
    normalized ? `Earlier approval result: ${normalized}` : "Earlier approval result: approval was not granted.",
    "Do not retry this approval-gated tool in the same run. Report the blocker and ask the user to retry when they can approve the prompt.",
  ].join(" ");
}

function resolveSubAgentToolCap(toolName: string, isCoordinatorAgent: boolean): number | undefined {
  const orchestration = getConfig().orchestration;
  if (isCoordinatorAgent) {
    const cfgOverride = orchestration?.coordinatorToolCaps?.[toolName];
    if (cfgOverride !== undefined) return cfgOverride;
    const builtInOverride = COORDINATOR_SUB_AGENT_PER_TOOL_CAP_OVERRIDES[toolName];
    if (builtInOverride !== undefined) return builtInOverride;
  }
  const cfgOverride = orchestration?.subAgentToolCaps?.[toolName];
  if (cfgOverride !== undefined) return cfgOverride;
  return SUB_AGENT_PER_TOOL_CAPS[toolName];
}

function looksLikeNarratedToolCall(content: string): boolean {
  const preview = content.slice(0, 2000);
  if (!preview.trim()) return false;
  return /<tool_call>|<function=|<parameter=|\[Tool:/i.test(preview);
}

function looksLikeUnsupportedScanClaim(content: string): boolean {
  const preview = content.slice(0, 2000);
  if (!preview.trim()) return false;

  const blockingClaim = /\b(http\s*403|403 forbidden|forbidden|waf|rate limit(?:ing)?|bot detection|access restriction|access restrictions)\b/i.test(preview);
  const attemptedAction = /\b(attempt(?:ing|ed)?|scan(?:ning|ned)?|recon(?:naissance)?|navigat(?:e|ing|ed)|access(?:ing|ed)?|request(?:ing|ed)?)\b/i.test(preview);
  return blockingClaim && attemptedAction;
}

function looksLikeHallucinatedDelegationSummary(content: string): boolean {
  const preview = content.slice(0, 2000);
  if (!preview.trim()) return false;

  if (/let me check the agent outputs directly/i.test(preview)) {
    return true;
  }

  const mentionsAgentCompletion =
    /\b[a-z][a-z0-9_]*_agent\b[\s\S]{0,40}\b(completed|executed|finished)\b/i.test(preview) ||
    /\b(completed|executed|finished)\b[\s\S]{0,40}\b[a-z][a-z0-9_]*_agent\b/i.test(preview);
  if (mentionsAgentCompletion) {
    return true;
  }

  const completionClaim = /\b(task graph completed|all phases were executed|completed phases|engagement has been completed successfully|penetration test complete|pentest complete|test initiated|starting engagement)\b/i.test(preview);
  const referencedAgents = preview.match(/\b[a-z][a-z0-9_]*_agent\b/gi) ?? [];
  return completionClaim && referencedAgents.length >= 2;
}

/**
 * Detect the specific failure mode where a sub-agent's model exhausts its
 * completion budget without ever emitting a callable tool call.
 *
 * Observed live with content_writer + qwen3.6-35b-a3b for HTML SPA artifact
 * tasks: the model attempts to put the entire 30 KB document into a single
 * `write_file(content=...)` argument; the tool-call JSON outgrows the 8192
 * completion-token cap; the provider can't parse the truncated call and
 * returns empty content + empty tool_calls. The sub-agent then exits with
 * `iterations: 0, toolCount: 0, completionTokens >= maxTokens, output:
 * "Sub-agent produced no final response."` — and previously got recorded as
 * "completed/success" because the semantic-outcome heuristic only looked for
 * "not found / unable to / error:" in the empty-ish output.
 *
 * Caller already gates on `toolCount === 0`, so this only fires when no tool
 * ran at all.
 */
export function looksLikeExhaustedBudgetNoTool(output: string, stats: SubAgentExecutionStats): boolean {
  const trimmed = output.trim();
  // Canonical "model returned empty content" marker, or any trivially empty answer.
  const triviallyEmpty = trimmed.length < 60 || trimmed === "Sub-agent produced no final response.";
  if (!triviallyEmpty) return false;
  // Real signal that the model actually tried — a few thousand completion tokens
  // burned but no usable content reached the caller. 1500 is well above any
  // legitimate "the model decided this question had no answer" response, which
  // would normally cost <300 tokens.
  return stats.usage.completionTokens >= 1500;
}

function rejectSuspiciousNoToolOutput(
  opts: SubAgentRunOptions,
  stats: SubAgentExecutionStats,
  output: string,
  turnTimeoutMs: number | undefined,
  runStartedAt: number,
): SubAgentRunResult | null {
  if (stats.toolCount > 0) return null;

  const failureStats: SubAgentExecutionStats = {
    ...stats,
    outcome: "failure",
    terminalState: "error",
  };

  let reason: string | null = null;
  if (looksLikeHallucinatedDelegationSummary(output)) {
    reason = "claimed delegated work completed without executing any tool calls";
  } else if (looksLikeNarratedToolCall(output)) {
    reason = "emitted narrated tool-call text without executing any tool calls";
  } else if (looksLikeUnsupportedScanClaim(output)) {
    reason = "reported scan blocking or HTTP findings without executing any tool calls";
  } else if (looksLikeExhaustedBudgetNoTool(output, stats)) {
    // Qwen failure mode: the model tries to inline a large artifact (HTML/JS/CSS)
    // as a single huge write_file argument. The tool-call JSON exceeds the 8192
    // completion-token cap, the provider can't parse the truncated call, and
    // returns empty content + empty tool_calls. Previously this was misclassified
    // as `outcome: "success", terminalState: "completed"` because the
    // semantic-outcome regex didn't match the canonical
    // "Sub-agent produced no final response." string. Now it's a real failure
    // so the orchestrator surfaces it instead of inlining the artifact as a
    // chat code block.
    // Two different failures land here and the difference decides the fix, so do not
    // assert one. Inlining a large artifact leaves a long OUTPUT; burning the budget
    // on reasoning leaves almost none (observed: 97,714 reasoning characters, 32,768
    // completion tokens, zero tools, 36 minutes — the previous wording blamed
    // inlining and would have sent the next reader after the wrong cause).
    reason = output.trim().length > 400
      ? "exhausted completion budget without calling any tool — the model inlined a large artifact instead of using a focused write_file/generate_website call"
      : "exhausted completion budget without calling any tool and produced almost no output — the budget went on reasoning rather than on a tool call; lower this agent's reasoning effort or raise its token budget";
  }

  if (!reason) return null;

  const error = `Sub-agent error: '${opts.agentName}' ${reason}.`;

  logAudit(
    "sub_agent_completed",
    {
      agentName: opts.agentName,
      iterations: stats.iterations,
      resultLength: output.length,
      promptChars: stats.promptChars,
      userContentChars: stats.userContentChars,
      toolCount: stats.toolCount,
      usage: stats.usage,
      model: stats.model,
      durationMs: Date.now() - runStartedAt,
      outcome: failureStats.outcome,
      terminalState: failureStats.terminalState,
      suspiciousNoToolOutput: true,
      suspiciousNoToolReason: reason,
    },
    { sessionId: stats.sessionId, severity: "warn" }
  );

  appendOutcome(opts.workspacePath, {
    ts: new Date().toISOString(),
    agent: opts.agentName,
    task: opts.task.slice(0, 200),
    outcome: "failure",
    iterations: stats.iterations,
    totalTokens: stats.usage.totalTokens,
    durationMs: Date.now() - runStartedAt,
    timeoutMs: turnTimeoutMs,
    error: reason,
  });

  return { output: error, stats: failureStats };
}

function normalizeSubAgentOutput(content: string | null | undefined): string {
  const normalized = typeof content === "string" ? content.trim() : "";
  return normalized.length > 0 ? normalized : "Sub-agent produced no final response.";
}

function summarizeToolAuditMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;

  const summary: Record<string, unknown> = {};
  for (const key of [
    "query",
    "rewrittenQuery",
    "resultCount",
    "backend",
    "requestedBackend",
    "attemptedBackends",
    "url",
    "fetchMethod",
    "contentType",
    "contentLength",
    "outputPath",
    "filename",
    "previewMode",
  ]) {
    if (key in metadata) {
      summary[key] = metadata[key];
    }
  }

  const ranking = metadata["ranking"];
  if (ranking && typeof ranking === "object") {
    const rankingRecord = ranking as Record<string, unknown>;
    const topResults = Array.isArray(rankingRecord["topResults"])
      ? rankingRecord["topResults"]
          .slice(0, 3)
          .map((entry) => {
            if (typeof entry !== "object" || entry === null) {
              return entry;
            }
            const value = entry as Record<string, unknown>;
            return {
              title: typeof value["title"] === "string" ? value["title"] : undefined,
              url: typeof value["url"] === "string" ? value["url"] : undefined,
              score: typeof value["score"] === "number" ? value["score"] : undefined,
            };
          })
      : [];
    if (topResults.length > 0) {
      summary["ranking"] = { topResults };
    }
  }

  if (Array.isArray(metadata["artifacts"])) {
    summary["artifactCount"] = metadata["artifacts"].length;
  }
  if (Array.isArray(metadata["accounts"])) {
    summary["accountCount"] = metadata["accounts"].length;
  }
  if (Array.isArray(metadata["messages"])) {
    summary["messageCount"] = metadata["messages"].length;
  }

  const message = metadata["message"];
  if (message && typeof message === "object") {
    const value = message as Record<string, unknown>;
    const messageSummary: Record<string, unknown> = {};
    for (const key of ["accountId", "mailbox", "uid", "subject", "from", "date"]) {
      if (key in value) {
        messageSummary[key] = value[key];
      }
    }
    if (Object.keys(messageSummary).length > 0) {
      summary["message"] = messageSummary;
    }
  }

  return Object.keys(summary).length > 0 ? summary : undefined;
}

function buildSubAgentToolAuditPayload(params: {
  agentName: string;
  tool: string;
  phase: "start" | "done";
  args?: Record<string, unknown>;
  toolCallId?: string;
  deterministic?: boolean;
  result?: ToolResult;
  errorText?: string;
  resultPreview?: string;
  successOverride?: boolean;
  cachedResult?: boolean;
  skippedReason?: string;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    agentName: params.agentName,
    tool: params.tool,
    phase: params.phase,
  };

  if (params.toolCallId) payload["toolCallId"] = params.toolCallId;
  if (params.deterministic) payload["deterministic"] = true;
  if (params.args && Object.keys(params.args).length > 0) payload["args"] = params.args;
  if (params.cachedResult) payload["cachedResult"] = true;
  if (params.skippedReason) payload["skippedReason"] = params.skippedReason;

  if (params.phase === "done") {
    const success = params.result ? params.result.success : (params.successOverride ?? !params.errorText);
    payload["success"] = success;

    const error = truncateToolAuditText(params.result?.error ?? params.errorText, 220);
    if (error) payload["error"] = error;

    const metadata = params.result?.metadata && typeof params.result.metadata === "object"
      ? summarizeToolAuditMetadata(params.result.metadata)
      : undefined;
    if (metadata) payload["metadata"] = metadata;

    const outputChars = params.result?.output.length;
    if (typeof outputChars === "number") payload["outputChars"] = outputChars;

    const preview = params.resultPreview
      ?? (params.result?.success
        ? truncateToolAuditText(params.result.output)
        : truncateToolAuditText(params.result?.error ?? params.errorText ?? params.result?.output));
    if (preview) payload["resultPreview"] = preview;
  }

  return payload;
}


/** Floor for the parent-remaining-budget clamp (orchestration.clampSubAgentTimeoutToParent): even
 * when the parent turn is nearly out of time, give a delegated sub-agent at least this long so it can
 * synthesize a usable partial rather than instantly aborting. The parent's abort signal still caps
 * the true wall-clock, so this cannot exceed the turn's hard deadline. */
const SUB_AGENT_MIN_CLAMP_MS = 30_000;

/** Pure clamp for D3: a sub-agent must never be handed more time than the parent turn has LEFT.
 * Returns `min(resolvedMs, max(floorMs, deadlineMs - nowMs))` — never larger than the resolved
 * timeout (a clamp only reduces), never below the floor (so a nearly-exhausted turn still lets the
 * specialist synthesize a partial). No deadline, or an unbounded (≤0) resolved budget, passes through
 * unchanged. Pure/exported for direct unit testing. */
export function clampSubAgentTimeoutToRemaining(
  resolvedMs: number,
  deadlineMs: number | undefined,
  nowMs: number,
  floorMs: number = SUB_AGENT_MIN_CLAMP_MS,
): number {
  if (typeof deadlineMs !== "number" || resolvedMs <= 0) return resolvedMs;
  return Math.min(resolvedMs, Math.max(floorMs, deadlineMs - nowMs));
}

export interface SubAgentRunOptions {
  agentName: string;
  task: string;
  /** Optional human-readable title for this delegation, set by the caller via
   * delegate_to_agent's `taskTitle` argument or by the discovery-fallback
   * rewriter. The runner uses it to detect "this task was routed via the
   * no-specialist-match fallback path", which short-circuits its own
   * discovery passes (Fix 4) — without this signal, every coordinator that
   * receives a fallback-routed task wastes 2 LLM rounds redoing the same
   * search_agents/search_workflows call the parent already failed on. */
  taskTitle?: string;
  context?: string;
  parentSessionId: string;
  workspacePath: string;
  /** Authenticated user that owns the parent turn — propagated so sub-agents
   * enforce the same per-user resource access (mail, credentials, compute). */
  userId?: string;
  /** Owning conversation session for KB scope checks (ephemeral KB workers only) —
   * propagated onto the sub-agent's ToolContext so its KB access resolves against
   * the originating session rather than its rewritten per-run sub-session id. */
  kbAccessSessionId?: string;
  allowedAgents?: string[];
  signal?: AbortSignal;
  approvalCallback?: (toolName: string, args: Record<string, unknown>) => Promise<boolean>;
  onProgress?: (event: SubAgentProgressEvent) => void;
  humanInLoopSteps?: string[];
  onComputerAction?: (action: { computerSessionId: string; actionType: string; [key: string]: unknown }) => void;
  onComputerScreenshot?: (screenshot: { computerSessionId: string; dataUrl: string; width: number; height: number; [key: string]: unknown }) => void;
  onComputerSessionState?: (sessionState: { computerSessionId: string; state: string; [key: string]: unknown }) => void;
  /** Override the agent's configured maxIterations for this invocation. 0 disables the cap. */
  maxIterationsOverride?: number;
  /** Override the agent's timeout for this invocation in ms. 0 disables the timeout. */
  turnTimeoutOverrideMs?: number;
  /** Shared orchestration state for nested delegated runs. Internal. */
  swarmState?: SwarmState;
  /** Optional live callback whenever nested swarm state changes. Internal. */
  onSwarmState?: (state: SwarmState) => void;
  /** Shared turn-local delegation counters for nested runs. Internal. */
  _turnAgentCounts?: Map<string, number>;
  /** Shared per-agent delegation repeat-cap overrides for nested runs. Internal. */
  _turnAgentRepeatLimitOverrides?: Record<string, number>;
  /** Shared total delegation budget override for nested runs. Internal. */
  _turnTotalDelegationLimitOverride?: number;
  /** Active reusable workflow execution stack for nested workflow/self-reentry guards. Internal. */
  _workflowExecutionStack?: string[];
  /** Absolute epoch-ms deadline of the PARENT turn, propagated so this sub-agent can clamp its own
   * timeout to the remaining budget (orchestration.clampSubAgentTimeoutToParent). Internal. */
  _turnDeadlineMs?: number;
  /** Inline config — bypasses config lookup (used by agent_factory for ephemeral agents) */
  inlineConfig?: import("../config/schema.js").SubAgentConfig;
  /**
   * E18: Soft deadline — when Date.now() >= softDeadlineMs the runner injects a
   * wrap-up nudge so the agent calls share_finding and produces a final answer
   * before the hard timeout fires. Set by coordinators to allocate a fraction
   * of their own budget to each delegated specialist.
   */
  softDeadlineMs?: number;
  /**
   * Eval transport only, ignored by the in-process runner: which arm of a
   * pinned-vs-composed comparison this attempt belongs to. "composed" tells the
   * gateway runner to omit the `--agent` override so live routing/bidding picks
   * the agents instead. Absent ⇒ "pinned" ⇒ previous behavior.
   */
  _evalArm?: "pinned" | "composed";
}

export interface SubAgentProgressEvent {
  agentName: string;
  kind: "started" | "thinking" | "tool_start" | "tool_done" | "completed" | "reasoning";
  iteration: number;
  toolName?: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
  result?: string;
  metadata?: Record<string, unknown>;
  summary?: string;
  /** Chain-of-thought text for kind="reasoning" — the model's thinking for
   * this iteration, surfaced to the UI (behind a debug toggle) and audits. */
  reasoning?: string;
}

export interface SubAgentExecutionStats {
  agentName: string;
  sessionId: string;
  promptChars: number;
  userContentChars: number;
  toolCount: number;
  toolNames: string[];
  iterations: number;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  maxIterations: number;
  model: string;
  capabilities: string[];
  outcome?: SubAgentOutcome;
  terminalState?: "completed" | "max_iterations" | "timeout" | "cancelled" | "error" | "missing_config";
  containerColdStartMs?: number;
  containerBootstrapMs?: number;
  containerRuntimeMs?: number;
}

export interface SubAgentRunResult {
  output: string;
  stats: SubAgentExecutionStats;
  artifacts?: Record<string, unknown>[];
  /** QPR-004: the turn's quality scorecard when the transport surfaces one
   *  (gateway-routed eval runs capture the turn_scorecard audit event). */
  qualityScorecard?: import("./turn-scorecard.js").TurnQualityScorecard;
}

export async function runSubAgentWithStats(opts: SubAgentRunOptions): Promise<SubAgentRunResult> {
  // Dual-emit native `starlingai.*` attrs AND standard `gen_ai.*` semconv attrs
  // (with the `invoke_agent {name}` span name + token usage) so a GenAI-aware
  // backend renders this as an agent invocation — additive, nothing removed.
  return withSpan(
    genAi.agentSpanName(opts.agentName),
    {
      ...genAi.agentAttributes(opts.agentName),
      "starlingai.agent.name": opts.agentName,
      "starlingai.session.parent": opts.parentSessionId,
      "starlingai.task.preview": opts.task.slice(0, 240),
    },
    async (span) => {
      const result = await runSubAgentWithStatsInner(opts);
      span.setAttribute("starlingai.agent.iterations", result.stats.iterations);
      span.setAttribute("starlingai.agent.toolCount", result.stats.toolCount);
      if (result.stats.terminalState) {
        span.setAttribute("starlingai.agent.terminalState", result.stats.terminalState);
      }
      span.setAttribute("starlingai.agent.tokens", result.stats.usage.totalTokens);
      span.setAttributes(genAi.usageAttributes(result.stats.usage.promptTokens, result.stats.usage.completionTokens));
      return result;
    },
  );
}

async function runSubAgentWithStatsInner(opts: SubAgentRunOptions): Promise<SubAgentRunResult> {
  const config = getConfig();
  const agentCfg = opts.inlineConfig ?? config.subAgents[opts.agentName];
  const runStartedAt = Date.now();

  opts.onProgress?.({
    agentName: opts.agentName,
    kind: "started",
    iteration: 0,
    summary: `Started delegated work in ${opts.agentName}.`,
  });

  if (!agentCfg) {
    return {
      output: `Sub-agent '${opts.agentName}' is not defined in config.subAgents`,
      stats: {
        agentName: opts.agentName,
        sessionId: `sub:${opts.parentSessionId}:${opts.agentName}:missing`,
        promptChars: 0,
        userContentChars: opts.task.length + (opts.context?.length ?? 0),
        toolCount: 0,
        toolNames: [],
        iterations: 0,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        maxIterations: DEFAULT_MAX_ITERATIONS,
        model: "",
        capabilities: [],
        outcome: "failure",
        terminalState: "missing_config",
      },
    };
  }

  // Coordinator agents (those with run_task_graph / parallel_delegate) orchestrate
  // nested sub-agents whose cumulative runtime can approach the full turn budget.
  // Give them a much higher default floor so adaptive timeouts based on *shorter*
  // prior runs don't prematurely abort in-flight task graphs.
  const COORDINATOR_TOOL_NAMES = ["run_task_graph", "parallel_delegate", "run_workflow"];
  const isCoordinatorAgent = agentCfg.tools?.some((t: string) => COORDINATOR_TOOL_NAMES.includes(t)) ?? false;
  // Leaf timeout default now respects the ACTIVE effort profile (low → 90s, high → 600s, max → ~∞)
  // instead of the flat config value — so a low-effort child is short, not the 600s that let a
  // researcher plan for 10 min under a 120s turn (run e3cf6c22). effectiveSubAgentTurnSloMs falls back
  // to config.agents.performance.subAgentTurnSloMs when no profile field applies (medium = identity).
  const leafDefaultMs = effectiveSubAgentTurnSloMs() || 60_000;
  const coordinatorDefaultMs = Math.round(config.gateway.turnTimeoutMs * 0.85);
  // Per-agent turnTimeoutMs is `number | "unbound" | undefined`. "unbound"
  // disables the turn timeout entirely (no soft/hard deadline, no adaptive
  // budget) for agents whose deliverable legitimately takes a long time — an
  // explicit numeric caller override (turnTimeoutOverrideMs) still wins.
  const agentTurnTimeout = agentCfg.turnTimeoutMs as number | "unbound" | undefined;
  const agentTurnTimeoutMs = typeof agentTurnTimeout === "number" ? agentTurnTimeout : undefined;
  const defaultTimeoutMs = agentTurnTimeoutMs ?? (isCoordinatorAgent ? coordinatorDefaultMs : leafDefaultMs);
  // No adaptive budget when the caller set an override or the agent declared an
  // explicit budget (numeric or "unbound").
  const adaptiveTimeout = opts.turnTimeoutOverrideMs === undefined && agentTurnTimeout === undefined
    ? computeAdaptiveSubAgentTimeoutMs(opts.agentName, opts.workspacePath, defaultTimeoutMs)
    : null;
  // A caller-supplied budget is a CEILING ("do not outlive my turn"), never a GRANT
  // ("you may run this long"), so honour the SMALLER of it and the agent's own declared
  // budget. "unbound" declares no self-limit, so there the caller's ceiling stands alone.
  //
  // THIS IS A POLICY CHOICE, NOT A BUG FIX, and an earlier comment here claimed otherwise:
  // it blamed run f08195d2 on an ephemeral's declared 300_000 being replaced by ~1.5M ms.
  // That was false and is worth recording so it is not re-derived. Neither ephemeral entry
  // point passes turnTimeoutOverrideMs at all — tools/ephemeral-agent-factory.ts puts
  // turnTimeoutMs inside inlineConfig (:403, :798) and calls runSubAgentWithStats with no
  // override — so callerCeilingMs was `undefined` there and the plain `??` chain already
  // resolved 300_000. That run overran because the providers orphaned the abort signal the
  // instant the stream opened, so the deadline was armed and could not reach the transport.
  // That defect is fixed in the providers; this line had nothing to do with it.
  //
  // What it IS: `subAgents.<name>.turnTimeoutMs` was inert on the delegate_to_agent path.
  // gateway/rpc.ts:842 sets turnTimeoutOverrideMs on EVERY turn (the whole gateway turn
  // budget, 1_800_000 by default — not the remaining time), runtime.ts:1399 threads it onto
  // the ToolContext, and tools/sub-agent.ts:1951 forwards it to every delegation. So a
  // documented per-agent knob was silently overwritten on every delegated run: researcher's
  // 600_000 and coder's 900_000 became 1_800_000. Taking the minimum makes the knob mean
  // something. Costs: `--timeout 3600` no longer stretches an agent past its own declaration
  // (use the effort dial or the agent's config, which is where a per-agent budget belongs),
  // and the E18 soft-deadline nudge — derived in a DIFFERENT module — had to move onto the
  // same rule or it would land after a hard deadline that is now often earlier. Both sides
  // now call resolveTurnBudgetMs so they cannot drift again.
  const callerCeilingMs = opts.turnTimeoutOverrideMs;
  const resolvedTurnTimeoutMs = resolveTurnBudgetMs({ callerCeilingMs, agentTurnTimeout })
    ?? adaptiveTimeout?.timeoutMs
    ?? defaultTimeoutMs;
  // D3 (orchestration.clampSubAgentTimeoutToParent, default off): never hand a sub-agent more time
  // than the parent turn has LEFT. A leaf researcher was given 600s under a 120s turn, planned for
  // 10 min, then got guillotined with nothing usable (run e3cf6c22). Clamp to the remaining budget
  // with a small floor so a nearly-exhausted turn still lets the specialist synthesize a partial. An
  // unbounded budget (0) is left alone. A clamp can only REDUCE the timeout.
  const effectiveTurnTimeoutMs = config.orchestration?.clampSubAgentTimeoutToParent === true
    ? clampSubAgentTimeoutToRemaining(resolvedTurnTimeoutMs, opts._turnDeadlineMs, Date.now())
    : resolvedTurnTimeoutMs;
  const turnTimeoutMs = effectiveTurnTimeoutMs && effectiveTurnTimeoutMs > 0 ? effectiveTurnTimeoutMs : undefined;
  const sanitizedTask = sanitizeSubAgentTask(agentCfg.tools, opts.task);
  const sourceSensitiveTask = buildDynamicTurnGuidance(sanitizedTask)?.sourceSensitive === true;
  // Fix 4: detect when this task was routed via the no-specialist-match
  // discovery fallback. The taskTitle marker is set by both the runtime-side
  // rewriter (after main-assistant search_agents returned no match) and the
  // sub-agent-side rewriter (after a sub-agent's own discovery returned no
  // match). When set, the swarm has already attempted discovery and found
  // nothing — running it again here would waste another LLM round on a
  // guaranteed-no-match call.
  const cameViaDiscoveryFallback = typeof opts.taskTitle === "string"
    && /fallback after agent discovery no-match/i.test(opts.taskTitle);
  // I13: Mutable so the cascade-timeout fallback can inject web_search +
  // web_fetch when all delegations have failed and a coordinator agent
  // would otherwise be left with no working capability.
  let effectiveToolNames = getEffectiveToolNames(opts.agentName, agentCfg.tools, sanitizedTask);
  if (cameViaDiscoveryFallback && effectiveToolNames) {
    const beforeCount = effectiveToolNames.length;
    const discoveryStripSet = new Set(["search_agents", "search_workflows", "list_agents"]);
    effectiveToolNames = effectiveToolNames.filter((name) => !discoveryStripSet.has(name));
    if (effectiveToolNames.length < beforeCount) {
      logAudit(
        "sub_agent_started",
        {
          agentName: opts.agentName,
          stage: "discovery_fallback_strip",
          strippedTools: ["search_agents", "search_workflows", "list_agents"]
            .filter((name) => !effectiveToolNames!.includes(name)),
          taskTitle: opts.taskTitle,
        },
        { sessionId: opts.parentSessionId, severity: "info" },
      );
    }
  }
  const subSessionId = `sub:${opts.parentSessionId}:${opts.agentName}:${Date.now()}`;

  let turnTimeoutReached = false;
  // The deadline now ABORTS the in-flight completion instead of only latching a
  // boolean. With the output ceiling gone, a token budget can no longer stop a
  // runaway generation — the wall clock is the only real bound, and a latch read
  // between iterations cannot enforce it against a call that never returns.
  //
  // RE-ARMABLE, deliberately. `turnTimeoutReached` is a boolean that the "unbounded"
  // grant clears below; an aborted AbortController can never be un-aborted. A single
  // permanent controller would therefore turn the grant — the dock's "let it finish
  // naturally", and the max-effort tier's silent equivalent — into a death sentence:
  // every later model call would reject instantly on the already-aborted signal and
  // be reported as the very timeout the grant was supposed to suspend (audit
  // 2445da2e, again). The deadline stays fully in force for every run that was NOT
  // granted unbounded — those never touch either escape hatch below.
  let deadlineAc = new AbortController();
  // Signal for the MAIN model call ONLY. Deliberately not used for tool calls nor
  // for the post-deadline synthesis passes (attemptTimeoutSynthesis /
  // attemptPreDeadlineSynthesis, which compose opts.signal with their own grace
  // controller): those must still run AFTER the deadline fires, or the accumulated
  // evidence is destroyed by the very mechanism meant to preserve it.
  // No turnTimeoutMs means no deadline is ever armed (an agent may declare
  // turnTimeoutMs:"unbound" precisely to say so). Composing deadlineAc in anyway would
  // hand every such call a signal that can never fire — inventing an AbortSignal where
  // the contract is "there is no deadline here", and hiding that the run is unbounded
  // from anything that inspects the signal.
  const composeLlmSignal = (): AbortSignal | undefined => {
    if (!turnTimeoutMs) return opts.signal;
    return opts.signal ? AbortSignal.any([opts.signal, deadlineAc.signal]) : deadlineAc.signal;
  };
  let llmSignal = composeLlmSignal();
  const signal = opts.signal;
  // Escape hatch 1 (grant BEFORE the deadline): never fire at all. Aborting here would
  // kill the completion the operator was just promised would finish.
  const timeoutHandle = turnTimeoutMs
    ? setTimeout(() => {
        if (longRunningGenerationManager.isUnbounded(subSessionId)) {
          log.info(
            { agentName: opts.agentName, runSessionId: subSessionId, turnTimeoutMs },
            "Turn deadline suppressed — this run was granted unbounded budget",
          );
          return;
        }
        turnTimeoutReached = true;
        deadlineAc.abort(new DeadlineAbort(turnTimeoutMs));
      }, turnTimeoutMs)
    : undefined;
  // Escape hatch 2 (grant AFTER the deadline already fired): swap in a fresh, un-aborted
  // controller so the run can actually call the model again. Nothing re-arms the timer —
  // an unbounded grant suspends the deadline for good, exactly as its comment promises;
  // maxIterations, the provider's own stream cap and the progress verifier stay as bounds.
  const rearmDeadlineForUnboundedGrant = (): void => {
    deadlineAc = new AbortController();
    llmSignal = composeLlmSignal();
  };
  // Progress-supervisor sampling timer (assigned just before the agent loop, cleared
  // in this function's `finally`). Declared out here, next to `timeoutHandle`, purely
  // so the teardown can reach it.
  let supervisorTimer: ReturnType<typeof setInterval> | undefined;

  // Open a checkpoint for this run. The resume side of this system was complete —
  // context rebuilding, gateway routes, dashboard — but NOTHING ever wrote one, so
  // none of it could fire. A run that dies with partial work now leaves a record the
  // operator can resume from instead of vanishing. Best-effort by construction: a
  // checkpoint failure must never take down the work it is describing.
  let checkpointTaskId: string | null = null;
  try {
    checkpointTaskId = createCheckpoint({
      agentName: opts.agentName,
      parentSessionId: opts.parentSessionId,
      task: opts.task,
    }).taskId;
  } catch (err) {
    log.warn({ err, agentName: opts.agentName }, "createCheckpoint failed — continuing without one");
  }

  // Surface a live, take-over-able browser preview for the whole browser_agent
  // run (parity with the computer-use session preview). The session is stopped
  // in the finally below; request_human_assist flips it to "needs help" on a
  // CAPTCHA. Only when a browser-vnc backend is actually reachable.
  let browserSessionId: string | undefined;
  if (opts.agentName === "browser_agent" && browserSessionManager.isEnabled()) {
    try {
      browserSessionId = browserSessionManager.register({
        agentName: opts.agentName,
        parentSessionId: opts.parentSessionId,
        runSessionId: subSessionId,
      }).id;
    } catch (err) {
      log.warn({ err }, "Failed to register browser session for live preview");
    }
  }

  try {

    logAudit(
      "sub_agent_started",
      {
        agentName: opts.agentName,
        task: sanitizedTask.slice(0, 120),
        capabilities: agentCfg.capabilities,
        configuredTools: agentCfg.tools ?? [],
        effectiveTools: effectiveToolNames ?? [],
        tags: agentCfg.tags,
        ...(turnTimeoutMs ? { timeoutMs: turnTimeoutMs } : {}),
        ...(adaptiveTimeout ? {
          adaptiveTimeoutMs: adaptiveTimeout.timeoutMs,
          adaptiveTimeoutBaselineMs: adaptiveTimeout.baselineMs,
          adaptiveTimeoutSamples: adaptiveTimeout.sampleSize,
        } : {}),
      },
      { sessionId: subSessionId, userId: undefined, channel: `sub-agent:${opts.agentName}` }
    );

    // Merge defaults with per-agent overrides, then overlay the active model
    // preset (dashboard Local ⇄ Claude switch) — a preset overrides the model
    // identity for EVERY agent, including ones with their own model override,
    // so capability tests run the whole swarm on the preset model.
    // mergeAgentModelOverride drops undefined override keys so a partial
    // override (e.g. an ephemeral agent passing model:{temperature:0.3} with no
    // primary) cannot blank out the default primary (audit c33e65dd).
    // Scope the preset (agents.defaults.modelPresetScope): a sub-agent that named its own model.primary
    // is "explicit"; its role drives the coordinator_qa scope. mergeAgentModelOverride still merges the
    // override — the scope only decides whether the preset then replaces it.
    const baseModelConfig = applyActiveModelPreset(
      mergeAgentModelOverride(config.agents.defaults.model, agentCfg.model),
      config,
      { hasExplicitModel: Boolean(agentCfg.model?.primary), role: agentCfg.role },
    );
    // Overlay the active effort profile onto the resolved model config so delegated
    // sub-agents (in-host AND containerized — this flows into the container payload as
    // resolvedModelConfig) produce larger, more reasoned outputs at high/max effort.
    // maxTokens only ever RAISES (never shrinks an agent's intentional larger budget).
    const effortRunProfile = currentEffortProfile();
    // Same overlay chain, one more layer: the per-agent total-stream backstop. An agent
    // that emits whole files gets 45 min instead of the flat 20 (a ~30 KB artifact is ~26
    // min of generation at the measured ~16.8 tok/s), and every agent's cap is floored
    // above BOTH its own declared budget and the deadline this run resolved, so
    // DeadlineAbort — which salvages AND resynthesizes — reaches the stream first.
    // Riding on ModelConfig means it reaches the containerized worker too (it travels in
    // the container payload as resolvedModelConfig) with no extra plumbing.
    //
    // `declaredTurnTimeoutMs` is passed separately from `turnTimeoutMs` on purpose: the
    // resolved deadline is `undefined` on a max-effort or "unbound" run, and that is
    // precisely the run where this cap is the only wall clock left, so the agent's own
    // declaration must still be visible to it.
    //
    // NOTE: the synthesis-tier provider below is built from agents.defaults.model, not
    // from this object, so a raised cap does NOT apply to the grace/soft-deadline
    // synthesis passes. That is intended — a grace pass must stay short — but it is
    // silent, and it only holds when a synthesis tier is actually configured (otherwise
    // `?? provider` reuses this one).
    const modelConfig = applyStreamCapOverlay(
      applyEffortModelOverlay(baseModelConfig, effortRunProfile),
      { toolNames: effectiveToolNames, turnTimeoutMs, declaredTurnTimeoutMs: agentTurnTimeoutMs },
    );

    const providerEndpoint = resolveProviderEndpoint(modelConfig, config);

    // ── Dispatch to container runner if configured ───────────────────────────
    // An agent is containerized when EITHER:
    //   a) its own config has container.enabled: true  (explicit opt-in), OR
    //   b) agents.defaultContainerized is true globally AND container.disabled !== true
    //      (opt-out model)
    //
    // EXCEPTION: agents whose tool list contains orchestration/discovery tools
    // or gateway-bound service tools must run in-process.
    //
    // Orchestration/discovery tools (delegate_to_agent, swarm_delegate,
    // parallel_delegate, run_task_graph, run_workflow, search_agents,
    // search_workflows, list_agents) require access to the parent process's
    // tool registry and Docker socket.
    //
    // Mail/calendar/contacts tools call the headless mail-service via gateway
    // config and service discovery. Inside the generic agent-worker container
    // they do not inherit the gateway's runtime config and usually run with
    // `--network none`, which turns simple inbox checks into opaque container
    // failures before the deterministic mail fast path can run. The same
    // `--network none` isolation breaks mcp__* tools (they reach their MCP
    // servers via the gateway's host-side registry), so MCP-using agents are
    // forced in-process too — see GATEWAY_BOUND_SERVICE_TOOL_PREFIXES.
    const requiresHostRegistry = (agentCfg.tools ?? []).some((t: string) =>
      ORCHESTRATION_DISCOVERY_TOOL_NAMES.has(t),
    );
    const requiresGatewayServices = (agentCfg.tools ?? []).some((toolName: string) =>
      GATEWAY_BOUND_SERVICE_TOOL_PREFIXES.some((prefix) => toolName.startsWith(prefix)),
    );
    const isContainerized =
      !requiresHostRegistry && !requiresGatewayServices && (
        agentCfg.container?.enabled === true ||
        (config.agents.defaultContainerized === true && agentCfg.container?.disabled !== true)
      );
    if (isContainerized) {
      const maxConcurrent = agentCfg.maxConcurrent ?? DEFAULT_CONCURRENCY;
      await acquireSlot(opts.agentName, maxConcurrent, opts.parentSessionId);
      let containerRun;
      try {
        const containerReason = agentCfg.container?.enabled ? "explicit" : "defaultContainerized";
        log.info({ agentName: opts.agentName, maxConcurrent, containerReason }, "Dispatching to containerized sub-agent");
        containerRun = await runSubAgentInContainer({ ...opts, signal }, agentCfg, modelConfig, providerEndpoint.baseUrl, providerEndpoint.apiKey);
      } finally {
        releaseSlot(opts.agentName);
      }
      // Detect container-level failures (spawn errors, non-zero exits, container
      // crashes, timeouts) that the runner reports as a failure-prefixed string
      // in containerRun.output rather than throwing. Without this, the metadata
      // would claim outcome=success while the visible output reads "container
      // error: unknown", and the rest of the orchestration pipeline (retry
      // cascade, score-keeping, audit telemetry) would treat the call as
      // successful and never fall back to a different agent.
      //
      // Also demote when the container's output is just LLM template special
      // tokens (e.g. `<|mask_end|>`) — Qwen variants under forced synthesis
      // sometimes emit a stray template token instead of real content, and
      // the runtime previously classified that 12-char garbage as success
      // (audit session cb90e56a, May 2026).
      const containerFailed = looksLikeContainerLevelFailure(containerRun.output)
        || looksLikeModelTemplateArtifact(containerRun.output);
      const stats: SubAgentExecutionStats = {
        agentName: opts.agentName,
        sessionId: subSessionId,
        promptChars: 0,
        userContentChars: opts.task.length + (opts.context?.length ?? 0),
        toolCount: 0,
        toolNames: [],
        iterations: 0,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        maxIterations: agentCfg.maxIterations ?? DEFAULT_MAX_ITERATIONS,
        model: modelConfig.primary ?? "",
        capabilities: agentCfg.capabilities ?? [],
        outcome: containerFailed ? "failure" : "success",
        terminalState: containerFailed ? "error" : "completed",
        containerColdStartMs: containerRun.metrics.containerColdStartMs,
        containerBootstrapMs: containerRun.metrics.containerBootstrapMs,
        containerRuntimeMs: containerRun.metrics.containerRuntimeMs,
      };
      logAudit(
        "sub_agent_completed",
        {
          agentName: opts.agentName,
          resultLength: containerRun.output.length,
          outcome: stats.outcome,
          terminalState: stats.terminalState,
          containerized: true,
          ...containerRun.metrics,
        },
        { sessionId: subSessionId },
      );
      return {
        output: containerRun.output,
        stats,
      };
    }

    const provider = createChatProvider(modelConfig, providerEndpoint);
    // E25: prefer the synthesis-tier provider for the three sub-agent
    // synthesis paths (timeout, pre-deadline soft, max-iterations) — same
    // rationale as runtime.ts:3127. Falls back to the primary `provider`
    // when no tier is configured. Resolved once per run so we don't pay
    // the lookup cost in every synthesis branch.
    const synthProvider = getChatProviderForTier("synthesis") ?? provider;

    // Iteration cap: explicit --iter override wins, then the active effort profile's
    // sub-agent budget (0 = unbounded), then the agent's configured cap, then default.
    // Resolved HERE (before the prompt is assembled) because the staged-build directive
    // sizes its pass budget from it — the loop below is the only other consumer.
    const effortSubAgentIterations = effortRunProfile?.subAgentMaxIterations;
    const maxIterations = opts.maxIterationsOverride === 0
      ? Number.MAX_SAFE_INTEGER
      : (opts.maxIterationsOverride
          ?? (effortSubAgentIterations === 0 ? Number.MAX_SAFE_INTEGER : effortSubAgentIterations)
          ?? agentCfg.maxIterations ?? DEFAULT_MAX_ITERATIONS);

    // Build system prompt
    const today = new Date().toLocaleDateString("en-US", {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
    });
    const flowGuidance = formatFlowMemoryGuidance(opts.workspacePath, sanitizedTask, {
      targetAgent: opts.agentName,
      limit: 3,
    });
    const memoryGuidance = await formatScopedMemoryGuidance(opts.workspacePath, sanitizedTask, {
      sessionId: opts.parentSessionId,
      targetAgent: opts.agentName,
      scopes: ["session", "workspace", "user", "agent"],
      limit: 4,
      maxChars: Math.min(1_400, Math.round((config.agents.performance?.promptBudgetChars ?? 32_000) * 0.06)),
    });
    // Procedural memory for specialists: surface relevant learned procedures for
    // this specific delegated task. Relevance-gated (empty when nothing matches)
    // and bounded, mirroring the flow/memory guidance above.
    const skillGuidance = config.skillLibrary.enabled
      ? await formatSkillGuidance(opts.workspacePath, sanitizedTask, {
          maxChars: Math.min(1_200, Math.round((config.agents.performance?.promptBudgetChars ?? 32_000) * 0.06)),
          // Agent-scoped: boost + surface procedures explicitly tagged for this
          // specialist so its own learned skills reliably reach it.
          agent: opts.agentName,
        })
      : "";
    const taskModeGuidance = buildTaskModeGuidance(opts.agentName, sanitizedTask);
    const modelExecutionGuidance = buildModelExecutionGuidance(modelConfig.primary, modelConfig.enableThinking);
    const toolInventoryGuidance = buildSubAgentToolInventory(effectiveToolNames);
    const agentDiscoveryGuidance = isOrchestrationCapableRun(effectiveToolNames)
      ? buildSubAgentAgentDiscoveryGuidance(opts.agentName, opts.allowedAgents)
      : "";
    // Fix 4: discovery-fallback notice. When this run was routed via the
    // no-specialist-match fallback, tell the model that discovery already
    // failed in the parent context, so it should skip search_agents /
    // search_workflows / list_agents (which we have also stripped from its
    // tool set) and proceed directly to delegation or its own work tools.
    const discoveryFallbackNotice = cameViaDiscoveryFallback
      ? "[DISCOVERY FALLBACK CONTEXT] This task was routed to you because the parent's "
        + "search_agents / search_workflows lookups returned no specialist match. "
        + "Discovery has already been attempted — do NOT call search_agents, search_workflows, "
        + "or list_agents (these tools are unavailable). Proceed directly with delegate_to_agent "
        + "(use autonomous routing by omitting agentName, or pick from the explicit fallback list "
        + "if one is offered) or with your own evidence-gathering tools (web_search, web_fetch, etc.)."
      : "";
    // E19 graceful-degradation ladder: short velocity-warning nudge injected
    // when the warden has flagged this session with an imminent storm/flood
    // alert. Tells the model to narrow scope and finish quickly instead of
    // fanning out further. Paired with a tool-list cap below.
    const isDegraded = isSessionDegraded(subSessionId);
    const degradedNudge = isDegraded
      ? "VELOCITY WARNING: Your session is approaching a tool-storm / messaging-flood threshold. "
        + "Narrow scope, batch tool calls, and finish quickly. Do not spawn further delegations "
        + "or parallel tool fan-out unless strictly required to complete the task."
      : "";
    // Staged artifact builds. A write-capable specialist handed a whole-artifact SPEC
    // (rather than an instruction) reasons for tens of thousands of characters and never
    // reaches a tool call — the measured f08195d2 failure: 20,129 completion tokens,
    // ~17,250 of them reasoning, zero tool calls, guillotined by the stream cap. The
    // classifier is structural (holds write_file AND edit_file; task longer than
    // STAGED_BUILD_TASK_CHAR_THRESHOLD) so no topic words decide it, and it is split
    // across two flags: `stagedArtifactBuilds` arms the mechanical half — this audit
    // record and the on-disk salvage reporting on the interrupted paths — while
    // `stagedArtifactBuildDirective` is what actually changes the prompt the model
    // sees. BOTH default ON: run 3959f3ac measured the staged shape working (13
    // iterations, 5 files, reasoning collapsed from 23,876 chars on the plan pass to
    // ~100-1,300 per fill pass) while `directiveInjected: false` proved the directive
    // itself had never reached the model.
    const stagedBuildFlags = effectiveOrchestration();
    const isStagedBuild = stagedBuildFlags.stagedArtifactBuilds !== false
      && isStagedArtifactBuildRun(effectiveToolNames, sanitizedTask);
    const stagedBuildGuidance = isStagedBuild && stagedBuildFlags.stagedArtifactBuildDirective === true
      ? buildStagedArtifactBuildGuidance(maxIterations, PER_PATH_EDIT_CAP)
      : "";
    if (isStagedBuild) {
      logAudit(
        "sub_agent_staged_build_detected",
        {
          agentName: opts.agentName,
          taskChars: sanitizedTask.trim().length,
          threshold: STAGED_BUILD_TASK_CHAR_THRESHOLD,
          maxIterations,
          directiveInjected: stagedBuildGuidance.length > 0,
        },
        { sessionId: subSessionId, severity: "info" },
      );
    }
    // The staged-build directive leads, the agent's own systemPrompt follows. It is
    // GENERIC text and several agent prompts close on a stricter finish contract
    // (backend_coder: serve_app + verify_app + return the live /api/app/<id>/ URL);
    // appended last, the directive's own "FINISH ... report the path" got the final
    // word and told those agents the files on disk were the deliverable.
    const systemPrompt = agentCfg.systemPrompt
      ? `${stagedBuildGuidance ? `${stagedBuildGuidance}\n\n` : ""}${agentCfg.systemPrompt}${modelExecutionGuidance ? `\n\n${modelExecutionGuidance}` : ""}${taskModeGuidance ? `\n\n${taskModeGuidance}` : ""}${toolInventoryGuidance ? `\n\n${toolInventoryGuidance}` : ""}${agentDiscoveryGuidance ? `\n\n${agentDiscoveryGuidance}` : ""}${discoveryFallbackNotice ? `\n\n${discoveryFallbackNotice}` : ""}${degradedNudge ? `\n\n${degradedNudge}` : ""}\n\nAgent name: ${opts.agentName}\nCurrent workspace: ${opts.workspacePath}\nToday's date: ${today}${flowGuidance ? `\n\n${flowGuidance}` : ""}${skillGuidance ? `\n\n${skillGuidance}` : ""}${memoryGuidance ? `\n\n${memoryGuidance}` : ""}`
      : `${stagedBuildGuidance ? `${stagedBuildGuidance}\n\n` : ""}You are a specialized AI sub-agent named "${opts.agentName}". Complete the given task and return your result.${toolInventoryGuidance ? `\n\n${toolInventoryGuidance}` : ""}${agentDiscoveryGuidance ? `\n\n${agentDiscoveryGuidance}` : ""}${discoveryFallbackNotice ? `\n\n${discoveryFallbackNotice}` : ""}${degradedNudge ? `\n\n${degradedNudge}` : ""}\n\nAgent name: ${opts.agentName}\nCurrent workspace: ${opts.workspacePath}\nToday's date: ${today}${flowGuidance ? `\n\n${flowGuidance}` : ""}${skillGuidance ? `\n\n${skillGuidance}` : ""}${memoryGuidance ? `\n\n${memoryGuidance}` : ""}`;

    // Get available tools for this agent. E20: rerank by semantic
    // relevance to the current task so the model sees the most relevant
    // tools first — useful when the tool list is large and the model's
    // attention budget is finite.
    let tools = getToolsAsLLMDefs(effectiveToolNames);
    // Rerank by semantic relevance only above a toolset-size threshold (B24): a small
    // toolset fits the model's attention, so we skip the embed round-trip. The threshold is
    // configurable (orchestration.toolRerankMinTools, default 6 = the long-standing value).
    try {
      tools = await rerankToolsForTask(tools, sanitizedTask, effectiveOrchestration().toolRerankMinTools ?? 6);
    } catch (err) {
      log.debug({ err, agentName: opts.agentName }, "Tool rerank failed — using registration order");
    }

    // E19 graceful-degradation ladder: if the warden flagged this session
    // with an imminent storm/flood alert, tighten the tool budget so the
    // model can't fan out further. Kept after rerank so the top-ranked tools
    // are the ones retained.
    if (isDegraded && tools.length > 6) {
      tools = tools.slice(0, 6);
      log.info(
        { agentName: opts.agentName, subSessionId, remainingTools: tools.length },
        "Sub-agent running in degraded mode — tool list capped",
      );
    }

    const toolContext: ToolContext = {
      sessionId: subSessionId,
      workspacePath: opts.workspacePath,
      // Workspace zoning: working agents see only generated/ + uploads/ (paths
      // outside re-root into generated/, mirroring the write rooting) so they
      // physically cannot wander into the platform's config zones or burn time
      // reading its docs (audit 0ac7d3fc). Core/self-maintenance agents opt in
      // to the whole workspace via workspaceAccess:"full" in their agent config.
      workspaceScope: agentCfg.workspaceAccess === "full" ? "full" : "generated",
      userId: opts.userId,
      ...(opts.kbAccessSessionId ? { kbAccessSessionId: opts.kbAccessSessionId } : {}),
      currentAgentName: opts.agentName,
      allowedAgents: opts.allowedAgents,
      allowedTools: effectiveToolNames,
      approvalCallback: opts.approvalCallback,
      humanInLoopSteps: opts.humanInLoopSteps,
      onComputerAction: opts.onComputerAction,
      onComputerScreenshot: opts.onComputerScreenshot,
      onComputerSessionState: opts.onComputerSessionState,
      swarmState: opts.swarmState,
      onSwarmState: opts.onSwarmState,
      _turnAgentCounts: opts._turnAgentCounts,
      _turnAgentRepeatLimitOverrides: opts._turnAgentRepeatLimitOverrides,
      _turnTotalDelegationLimitOverride: opts._turnTotalDelegationLimitOverride,
      _workflowExecutionStack: opts._workflowExecutionStack,
      // Propagate the parent turn's deadline so this sub-agent's OWN delegations clamp to the same
      // remaining budget (D3). Inherited unchanged — nothing can run past the turn's hard abort.
      _turnDeadlineMs: opts._turnDeadlineMs,
      signal,
    };

    // ── A2A: drain any pending messages addressed to this agent ────────────────
    // Agents can send messages to peers via send_agent_message. Those messages
    // are queued in swarm/memory.ts and delivered here at the start of the next
    // run — giving the agent a chance to act on them without the orchestrator
    // mediating the content.
    let a2aContext = "";
    let a2aMessageClaim: AgentMessageClaim | null = null;
    try {
      // Read from the ROOT session bucket the WRITE side targets: send_agent_message writes via
      // deriveSharedSessionId(ctx.sessionId) (→ root), so draining the per-run CHILD subSessionId
      // here found nothing and peer messages were silently lost. deriveRootSessionId is identical
      // to that write-side derivation, so read and write now hit the same bucket.
      // ADR-003 deferred ack: the claim is held open and acknowledged only when this
      // run records a success/partial outcome — a crashed or failed run leaves the
      // messages pending, so they redeliver instead of being silently lost.
      // Visibility scales with THIS run's budget (2×, capped at 30 min): the claim is
      // held for the whole run, and a static window shorter than the run would let a
      // concurrent same-agent claim re-deliver (duplicate injection) and eventually
      // dead-letter messages a healthy run is still processing.
      const messageVisibilityMs = effectiveTurnTimeoutMs && effectiveTurnTimeoutMs > 0
        ? Math.max(120_000, Math.min(2 * effectiveTurnTimeoutMs, 1_800_000))
        : 1_800_000; // "unbound" agents get the cap
      a2aMessageClaim = await claimAgentMessages(deriveRootSessionId(subSessionId), opts.agentName, { visibilityMs: messageVisibilityMs });
      const pending = a2aMessageClaim.messages;
      if (pending.length > 0) {
        a2aContext = `\n\n## Pending messages from peer agents\n${pending
          .map((m) => {
            // Sanitize message content to prevent prompt injection from peer agents
            const safeContent = sanitizeTranscriptContent("user", m.content, false);
            return `From ${m.fromAgent} [${m.ts}]: ${safeContent}`;
          })
          .join("\n---\n")}`;
        logAudit("a2a_messages_delivered", {
          agentName: opts.agentName,
          count: pending.length,
          fromAgents: [...new Set(pending.map((m) => m.fromAgent))],
        }, { sessionId: subSessionId, severity: "info", channel: "swarm" });
      }
    } catch (err) {
      log.debug({ err, agentName: opts.agentName }, "Failed to consume A2A messages — swarm bus or Redis may be unavailable");
    }

    const initialSharedFacts = await formatSharedFactsContext(subSessionId);
    let lastSharedFactsSignature = initialSharedFacts.signature;
    const sharedFactsContext = initialSharedFacts.content
      ? `\n\n${initialSharedFacts.content}`
      : "";

    // Build initial message
    const userContent = opts.context
      ? `Context:\n${opts.context}${a2aContext}${sharedFactsContext}\n\nTask: ${sanitizedTask}`
      : `${sanitizedTask}${a2aContext}${sharedFactsContext}`;

    const history: LLMMessage[] = [{ role: "user", content: userContent }];

    let iterations = 0;
    let toolCount = 0;
    let successfulToolCount = 0;
    // I11: Pre-emptive soft-deadline synthesis tracking. We fire the
    // soft-deadline synthesis at most once per sub-agent run.
    let softDeadlineSynthesisAttempted = false;
    // Long-running generation soft thresholds — the point past which the run
    // is SURFACED (non-blocking) to the operator dock. Static now that the
    // handoff no longer pauses for an operator "continue" grant.
    const lrgWallThresholdMs = DEFAULT_SOFT_THRESHOLD_MS;
    const lrgTokenThreshold = DEFAULT_SOFT_THRESHOLD_TOKENS;
    // When the operator answers "stop" (polled via isStopRequested), we set
    // this so the next loop iteration goes straight to attemptTimeoutSynthesis
    // instead of making another LLM call.
    let lrgOperatorStop = false;
    // Set when the progress supervisor (not a deadline, not the operator) wound the run
    // down. Read alongside turnTimeoutReached so the wind-down works on runs that have
    // no turnTimeoutMs at all.
    let supervisorStop = false;
    // The effort-tier long-running policy (low→stop / high→continue) is auto-applied
    // ONCE per run; this latches so it doesn't re-audit every subsequent iteration.
    let lrgAutoHandled = false;
    // max-effort silent-unbounded grant state (see progress-verifier.ts).
    let lrgUnboundedGranted = false;            // unbounded budget granted once, silently
    // Progress-supervisor state. Watches EVERY run at EVERY tier — see superviseProgress.
    let lrgLastProgressCheckAt = 0;             // throttle: one progress check per window
    let lrgLastJudgeAt = 0;                     // throttle: one semantic judge call per window
    let lrgConsecutiveStalls = 0;               // no-progress samples in a row
    let lrgLastSample: ProgressSample = EMPTY_PROGRESS_SAMPLE;
    // Cumulative shape counters. reasoningChars was already measured at four sites and
    // consumed at none — it is THE pathology signal and is never counted as progress;
    // outputChars is progress, because a long legitimate emit streams CONTENT.
    let reasoningCharsTotal = 0;
    let outputCharsTotal = 0;
    // "<tool>:<path>" -> content hashes written this run, oldest first. Backs the
    // content-shape loop rule that replaced the blunt per-path overwrite cap.
    const writeHistory = new Map<string, string[]>();
    // (tool, exact-args) repeat counts across the WHOLE run, for EVERY tool. Detection
    // only — the cached-result short-circuit below stays restricted to IDEMPOTENT_TOOLS,
    // because short-circuiting a deliberate re-poll of mutating state would be wrong.
    const argSigRepeats = new Map<string, number>();
    // Fingerprints of this run's substantive assistant turns. An output identical to one
    // an earlier iteration already produced means the run has lost track and is
    // re-emitting rather than advancing.
    const assistantOutputSigs = new Set<string>();
    const artifacts: Record<string, unknown>[] = [];
    const artifactKeys = new Set<string>();
    // Workspace-relative paths this run successfully wrote or edited, in call order.
    // Feeds describeMutatedWorkspaceFiles on the interrupted paths so a cut-off staged
    // build hands back what is on disk instead of discarding it.
    const mutatedWorkspacePaths = new Set<string>();
    const toolNames: string[] = [];
    const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    // Track last tool call signature per tool name for consecutive-duplicate detection
    const lastToolCallSig = new Map<string, { args: string; result: string; success: boolean }>();
    // Broader (name, args) cache for IDEMPOTENT_TOOLS — catches A→B→A loops the
    // consecutive map misses (the second A overwrites the first A's slot, so
    // the third A sees no `prev` match). Bounded only by per-tool caps and the
    // sub-agent run lifetime; both are tight, so an explicit size cap is unnecessary.
    const idempotentCallCache = new Map<string, { result: string; success: boolean; callCount: number }>();
    // Per-tool call counters — prevents a single tool from dominating iteration budget
    const perToolCallCount = new Map<string, number>();
    // Per-(tool, path) counters for path-keyed write tools. A real loop
    // rewrites the same path; a legitimate multi-file project hits distinct
    // paths. Counting per-path lets us catch the loop without blocking a
    // 4-file website build at file 3.
    const perWritePathCount = new Map<string, number>();
    // Per-tool FAILED-call counters, separate from the success cap above. A failed
    // call refunds the success cap and increments this instead; exceeding
    // PER_TOOL_FAILURE_CAP blocks the tool so repeated arg-rejection can't loop forever.
    const perToolFailureCount = new Map<string, number>();
    // Cross-tool artifact-persistence thrash guard (see ARTIFACT_PERSIST_TOOLS): tracks which
    // distinct artifact tools have failed and the total failures. Once failures span >=2 tools
    // AND total >=3, further artifact writes are blocked and the agent is told to deliver the
    // content inline instead of re-trying a write it cannot emit.
    const failedArtifactPersistTools = new Set<string>();
    let artifactPersistFailureCount = 0;
    let workflowPassthroughOutput: string | null = null;
    // Observability: per-tool byte totals for context-budget runaway detection
    const bytesByTool = new Map<string, number>();
    // E21: Source-diversity — detect when research plateaus on repeated domains
    const visitedSourceDomains = new Set<string>();
    let consecutiveStaleDomainFetches = 0;
    // Cost-center 3 (audit 5d51862f): consecutive fetches that returned NO usable content
    // (404 / blocked / non-extractable PDF / error page). These slip past the success-only
    // stale-domain plateau, so the model keeps guessing alternate URLs for the same document
    // until the soft deadline. Bound the streak and nudge it to stop / pivot.
    let nonProductiveFetchStreak = 0;
    let nonProductiveFetchNudged = false;
    // E18: Soft-deadline nudge — fire once when softDeadlineMs is reached
    let softDeadlineInjected = false;
    // E19 wave 2 follow-up: mid-turn graceful-degradation enforcement.
    //   Turn-start `isDegraded` (above) only catches sessions already flagged
    //   when the sub-agent boots. If the warden raises tool_storm_imminent /
    //   agent_message_flood_imminent *while* the loop is mid-flight, the
    //   in-progress iteration would otherwise continue with the full tool
    //   list and no velocity nudge. We re-check per iteration and apply the
    //   same nudge + tool cap once, logging a single transition event.
    let degradedMidTurnApplied = isDegraded;
    // Phase A5: nudge agents to call share_finding after collecting substantive evidence
    let substantiveEvidenceCount = 0;
    let shareFindinCalledThisRun = false;
    // Phase B8: stop heuristic — count share_finding calls to detect "enough evidence collected"
    let shareFindinCallCount = 0;
    // I13: In-loop sufficiency / cascade-failure guard.
    //   • cumulativeTimeoutSignalCount counts "timed out after Nms" markers
    //     observed in delegation tool results across the whole run. When
    //     this hits ≥2, we strip delegation tools and force the agent to
    //     write an honest final answer from whatever fragments exist
    //     instead of dispatching yet another doomed parallel_delegate.
    //   • cumulativeUsefulEvidenceBytes accumulates non-boilerplate bytes
    //     from successful tool results. Once it crosses the sufficiency
    //     threshold, we inject a one-shot nudge telling the agent it has
    //     enough material — answer now unless one specific fact is still
    //     missing. Both flags fire at most once per run.
    let cumulativeTimeoutSignalCount = 0;
    let cumulativeUsefulEvidenceBytes = 0;
    let recentEvidenceSnippets: string[] = [];
    let autoSharedFindingCount = 0;
    const autoSharedFindingKeys = new Set<string>();
    // Distillation budget for the auto-share path: a high SAFETY ceiling, not a
    // compute-saving cap — uncurated raw findings bloat the downstream build/synthesis
    // context far more than the small distill call costs (audit 65f46046), so we curate
    // every eligible web finding. Gated by orchestration.distillSharedFacts.
    const distillSharedFacts = {
      enabled: config.orchestration.distillSharedFacts,
      minChars: config.orchestration.distillSharedFactsMinChars,
      budget: { remaining: config.orchestration.distillSharedFactsMaxPerRun },
      // Run per-finding distillation on the lightweight routing tier when it's
      // configured (smaller/faster model = lower per-call cost on one GPU);
      // falls back to this agent's provider otherwise (no behavior change).
      provider: getChatProviderForTier("routing") ?? provider,
    };
    let cascadeSynthesisForced = false;
    let sufficiencySynthesisNudged = false;
    let sufficiencyToolsStripped = false;
    // Oversight: load the turn's recorded plan acceptance criteria ONCE (from the
    // root orchestrator session — loadTurnPlan strips the sub: hops). The goal-met
    // branch in the loop checks the gathered evidence against them via the cheap
    // routing tier and authoritatively finalizes early once they are satisfied.
    const oversightEnabled = effectiveOrchestration().oversight !== false;
    const oversightCriteria: string[] = oversightEnabled
      ? await loadTurnPlan(subSessionId).then((p) => p?.acceptanceCriteria ?? []).catch(() => [])
      : [];
    let oversightChecksUsed = 0;
    // Evidence-gathering iterations the model has run AFTER the sufficiency
    // nudge told it to answer — past the threshold, the soft nudge escalates
    // to the hard tool strip (see strip condition below).
    let evidenceIterationsSinceNudge = 0;
    const NUDGE_IGNORED_STRIP_ITERATIONS = 3;
    let consecutiveBlockedToolIterations = 0;
    const BLOCKED_TOOL_ITERATION_THRESHOLD = 2;
    // A delegation that "executes" but only reports that the target agent/tool is
    // already exhausted for this turn made NO progress — re-delegating to it is a
    // loop. A coordinator did this for ~20 min (session 44ea5c21) before the
    // per-tool cap finally tripped. Treat such no-progress iterations as blocked
    // so the loop-stop fires after 2 in a row.
    const NO_PROGRESS_DELEGATION_FAILURE_RE = /per-agent delegation cap exhausted|already been delegated to its per-turn maximum|already delegated to its per-turn maximum|has been called \d+ times this run \(limit/i;
    const approvalBlockedTools = new Map<string, string>();
    // Backend-unreachable breaker for live-state tool families (browser_*/computer_*):
    // they are dedup-exempt, so a dead backend (ENOTFOUND browser-vnc, session 8815a45e)
    // was hammered for the whole iteration budget. Two consecutive same-signature
    // infra failures block the family for the rest of the run. See agent/infra-failure.ts.
    const infraFailureStreaks = new Map<string, InfraFailureStreak>();
    const infraBlockedFamilies = new Map<string, string>();
    let requiredResearchFallbackRoute: SubAgentRequiredResearchFallbackRoute | null = null;
    // Track tools stripped by the evidence-cap mechanism so that blocked
    // calls to those tools are classified as "evidence_cap_enforced" rather
    // than "not_in_agent_tools", preventing false-positive warden alerts.
    const evidenceCapStrippedTools = new Set<string>();
    // G32: task-class fingerprint for outcome-weighted routing (written into every appendOutcome call)
    const taskKeywords = extractTaskKeywords(sanitizedTask);

    /** G32: Thin wrapper that auto-injects taskKeywords + sharedFindingsCount.
     *  Also closes the graph-memory retrieval feedback loop on success/partial
     *  outcomes so retrieved memories that led to a real deliverable get
     *  credited (wasUseful=true + importance boost). */
    const recordOutcome = (
      fields: Parameters<typeof appendOutcome>[1],
    ): void => {
      appendOutcome(opts.workspacePath, {
        ...fields,
        taskKeywords,
        sharedFindingsCount: shareFindinCallCount,
      });
      // ADR-003 ack boundary: the run's outcome is durably recorded here. A
      // success/partial outcome means the delivered peer messages were processed
      // by the run — acknowledge them (idempotent). A failure leaves the claim
      // pending so the messages redeliver to the next attempt.
      if ((fields.outcome === "success" || fields.outcome === "partial") && a2aMessageClaim) {
        const claim = a2aMessageClaim;
        a2aMessageClaim = null;
        claim.ack().catch(() => { /* unacked entries redeliver after the visibility timeout */ });
      }
      if (fields.outcome === "success" || fields.outcome === "partial") {
        // Partial outcomes credit less than full success — still positive,
        // because some of the retrieved memories *did* contribute.
        const boost = fields.outcome === "success" ? 0.05 : 0.02;
        graphMarkSessionRetrievalsUseful(subSessionId, { boost }).catch(() => {});
      } else if (fields.outcome === "failure") {
        // Negative signal: the turn terminated in failure with retrieved
        // memories still pending. Mark them wasUseful=false and nudge
        // importance downward — a stronger signal than slow decay because
        // we know the memories were present and still didn't help.
        graphMarkSessionRetrievalsUnhelpful(subSessionId, { penalty: 0.03 }).catch(() => {});
      }
    };

    const buildStats = (
      terminalState: SubAgentExecutionStats["terminalState"] = "completed",
      outcome: SubAgentOutcome = terminalState === "completed" ? "success" : "failure",
    ): SubAgentExecutionStats => ({
      agentName: opts.agentName,
      sessionId: subSessionId,
      // Measured over the LIVE conversation, not the system prompt alone. It was blind
      // to every message the run appended, so a turn whose prompt had grown to fill the
      // context window reported the same number as its first iteration — useless for
      // the one question this stat now has to answer (how much of the window the INPUT
      // ate, and therefore how little was left for the derived output budget).
      promptChars: systemPrompt.length + history.reduce(
        (sum, message) => sum
          + (message.content?.length ?? 0)
          + (message.tool_calls ?? []).reduce((n, call) => n + call.function.arguments.length, 0),
        0,
      ),
      userContentChars: userContent.length,
      toolCount,
      toolNames: [...toolNames],
      iterations,
      usage: { ...usage },
      maxIterations,
      model: modelConfig.primary,
      capabilities: agentCfg.capabilities ?? [],
      outcome,
      terminalState,
    });

    const withArtifacts = (result: { output: string; stats: SubAgentExecutionStats }): SubAgentRunResult => (
      artifacts.length > 0
        ? { ...result, artifacts: artifacts.map((artifact) => ({ ...artifact })) }
        : result
    );

    const logSubAgentCompletionAudit = (
      stats: SubAgentExecutionStats,
      output: string,
      extra: Record<string, unknown> = {},
      severity: "info" | "warn" | "error" = "info",
    ): void => {
      logAudit(
        "sub_agent_completed",
        {
          agentName: opts.agentName,
          iterations: stats.iterations,
          resultLength: output.length,
          promptChars: stats.promptChars,
          userContentChars: stats.userContentChars,
          toolCount: stats.toolCount,
          usage: stats.usage,
          model: stats.model,
          durationMs: Date.now() - runStartedAt,
          outcome: stats.outcome,
          terminalState: stats.terminalState,
          bytesByTool: Object.fromEntries(bytesByTool),
          ...extra,
        },
        { sessionId: subSessionId, severity },
      );

      // Close the checkpoint on the same choke point every terminal outcome flows
      // through. A completed run has nothing to resume; anything else keeps what it
      // produced so the work is recoverable rather than lost.
      if (checkpointTaskId) {
        try {
          if (stats.terminalState === "completed") {
            completeCheckpoint(checkpointTaskId);
          } else {
            pauseCheckpoint(checkpointTaskId, {
              progressNote: `Ended as ${stats.terminalState} after ${stats.iterations} iteration(s). Tools used: ${stats.toolNames.join(", ") || "none"}.`,
              conversationSummary: output,
              elapsedMs: Date.now() - runStartedAt,
              iterationsCompleted: stats.iterations,
            });
          }
        } catch (err) {
          log.warn({ err, taskId: checkpointTaskId }, "closing the checkpoint failed — the run result is unaffected");
        }
      }
    };

    /** Single-delegation passthrough — see PASSTHROUGH_DELEGATION_MIN_BYTES.
     * If this agent's only substantive tool work was one large delegation,
     * return that delegation's body as the agent's own result instead of
     * running another LLM synthesis pass on top of an answer that is already
     * the answer. Returns null when the condition does not apply. */
    const tryReturnSingleDelegationPassthrough = (
      reasonTag: string,
    ): SubAgentRunResult | null => {
      if (signal?.aborted) return null;
      let candidate = tryExtractSingleDelegationPassthrough({
        history,
        bytesByTool,
        toolNames: [...toolNames],
      });
      if (!candidate) {
        // Lever #2: relay the most-recent COMPLETE author deliverable even when
        // research delegations also ran, rather than condensing it with a rushed
        // terminal synthesis (audit 1fd36e04). Bounded to these give-up points
        // (timeout / soft-deadline / evidence-strip / max-iterations): it only
        // fires when a finished deliverable is already in hand, so it can never
        // discard live aggregation work.
        const latest = tryExtractLatestCompleteDeliverable(history);
        if (latest) {
          candidate = {
            output: latest.content,
            delegationToolName: "delegate_to_agent",
            bytes: latest.bytes,
            inferredOutcome: "success",
          };
        }
      }
      if (!candidate) return null;

      // A passthrough/relayed deliverable can itself be a degenerate repetition loop
      // from a child agent (audit 9fd16384). Collapse it here so the loop never
      // propagates to the parent's synthesis input or to the user.
      const result = looksLikeDegenerateRepetition(candidate.output)
        ? collapseRepeatedMarkdownSections(candidate.output)
        : candidate.output;
      const stats = buildStats("completed", candidate.inferredOutcome);

      recordOutcome({
        ts: new Date().toISOString(),
        agent: opts.agentName,
        task: opts.task.slice(0, 200),
        outcome: candidate.inferredOutcome,
        iterations,
        totalTokens: usage.totalTokens,
        durationMs: Date.now() - runStartedAt,
        timeoutMs: turnTimeoutMs,
      });
      logAudit(
        "sub_agent_synthesis_forced",
        {
          agentName: opts.agentName,
          reason: "single_delegation_passthrough",
          passthroughTrigger: reasonTag,
          delegationToolName: candidate.delegationToolName,
          delegationBytes: candidate.bytes,
          inferredOutcome: candidate.inferredOutcome,
          iterations,
        },
        { sessionId: subSessionId, severity: "info" },
      );
      logSubAgentCompletionAudit(
        stats,
        result,
        {
          singleDelegationPassthrough: true,
          passthroughTrigger: reasonTag,
          delegationToolName: candidate.delegationToolName,
          delegationBytes: candidate.bytes,
        },
        candidate.inferredOutcome === "failure" ? "warn" : "info",
      );
      log.info(
        {
          agentName: opts.agentName,
          delegationToolName: candidate.delegationToolName,
          delegationBytes: candidate.bytes,
          reasonTag,
          inferredOutcome: candidate.inferredOutcome,
        },
        "Single-delegation passthrough — returning delegated body verbatim",
      );
      opts.onProgress?.({
        agentName: opts.agentName,
        kind: "completed",
        iteration: iterations,
        summary: `Returned single-delegation result directly from ${opts.agentName}.`,
      });
      return withArtifacts({ output: result, stats });
    };

    /** Closure shorthand for buildInterruptedSubAgentOutput callers in the
     * run function — pre-fills `primaryDelegationBody` from history so the
     * full delegated specialist's body is surfaced verbatim instead of being
     * lost behind 900-char snippets. Returns null when no substantial body
     * was collected, which lets callers preserve their existing snippet flow. */
    const currentPrimaryDelegationBody = (): { content: string; bytes: number } | null =>
      extractMostRecentSubstantialDelegationBody(history);

    /** On-disk salvage lines for the interrupted paths. Gated by the mechanical
     *  staged-build flag (default ON) so it can be switched off wholesale; empty
     *  when the run mutated nothing, which keeps every existing output identical. */
    const currentMutatedFileLines = (): string[] =>
      (effectiveOrchestration().stagedArtifactBuilds !== false && mutatedWorkspacePaths.size > 0
        ? describeMutatedWorkspaceFiles(mutatedWorkspacePaths, opts.workspacePath)
        : []);

    const rescueSanitizedEmptyResult = async (rawResult: string): Promise<string> => {
      const visibleResult = stripHallucinatedToolTags(rawResult);
      if (visibleResult || toolCount === 0 || signal?.aborted) {
        return visibleResult || rawResult;
      }

      try {
        log.warn(
          { agentName: opts.agentName, iterations, toolCalls: toolCount },
          "Sub-agent final output became empty after stripping hallucinated tool markup — forcing synthesis rescue",
        );
        const rescueMessages: LLMMessage[] = [
          {
            role: "system",
            content: systemPrompt +
              "\n\nYour previous final answer contained only invalid tool-call markup and became empty after sanitization. " +
              "DO NOT call any more tools. Produce your COMPLETE final answer now from the evidence already gathered in the conversation. " +
              "Include the key facts, URLs, and extracts you retrieved.",
          },
          ...history,
        ];
        const rescueResponse = await provider.complete(rescueMessages, [], signal);
        usage.promptTokens += rescueResponse.usage.promptTokens;
        usage.completionTokens += rescueResponse.usage.completionTokens;
        usage.totalTokens += rescueResponse.usage.totalTokens;

        if (rescueResponse.tool_calls.length === 0) {
          const rescued = stripHallucinatedToolTags(normalizeSubAgentOutput(rescueResponse.content));
          if (rescued) {
            log.info(
              { agentName: opts.agentName, rescuedLength: rescued.length },
              "Sanitized-empty output rescue succeeded",
            );
            return rescued;
          }
        }
      } catch (rescueErr) {
        log.warn({ rescueErr, agentName: opts.agentName }, "Sanitized-empty output rescue failed");
      }

      return "Sub-agent produced no final response.";
    };

    const recoverNoResponseAfterSubstantiveWork = (rawResult: string): { result: string; forcedOutcome: SubAgentOutcome | null } => {
      // Structural signal only: the exact "no final response" sentinel. The
      // English planning-phrase sniff was removed — recovery now hinges on the
      // structural interrupted-outcome classifier (successfulToolCount/artifacts/
      // swarmState), not topic/phrase keyword matching of the narrative.
      const noFinalResponse = rawResult === "Sub-agent produced no final response.";
      if (!noFinalResponse) {
        return { result: rawResult, forcedOutcome: null };
      }

      const interruptedOutcome = classifyInterruptedOutcome({
        successfulToolCount,
        artifacts,
        swarmState: opts.swarmState,
      });
      if (interruptedOutcome !== "partial") {
        return { result: rawResult, forcedOutcome: null };
      }

      const recovered = buildInterruptedSubAgentOutput({
        agentName: opts.agentName,
        reason: "produced no final response after substantive work.",
        swarmState: opts.swarmState,
        toolNames,
        toolCount,
        iterations,
        artifacts,
        evidenceSnippets: resolveInterruptedEvidenceSnippets({ recentEvidenceSnippets, history }),
        primaryDelegationBody: extractMostRecentSubstantialDelegationBody(history),
        mutatedFileLines: currentMutatedFileLines(),
      });
      log.warn(
        { agentName: opts.agentName, toolCount, successfulToolCount, iterations },
        "Sub-agent completed substantive work but produced no usable final narrative — returning partial progress summary",
      );
      return { result: recovered, forcedOutcome: "partial" };
    };

    const recoverHallucinatedTruncationAfterSubstantiveWork = (rawResult: string): { result: string; forcedOutcome: SubAgentOutcome | null } => {
      if (!looksLikeHallucinatedTruncationClaim(rawResult)) {
        return { result: rawResult, forcedOutcome: null };
      }

      const usableBufferedSnippets = resolveInterruptedEvidenceSnippets({
        recentEvidenceSnippets,
        history,
        maxSnippets: 6,
      }).filter((snippet) => !looksLikeHallucinatedTruncationClaim(snippet));
      const usableHistorySnippets = usableBufferedSnippets.length > 0
        ? usableBufferedSnippets
        : resolveInterruptedEvidenceSnippets({ history, maxSnippets: 6 })
            .filter((snippet) => !looksLikeHallucinatedTruncationClaim(snippet));

      if (usableHistorySnippets.length === 0) {
        return { result: rawResult, forcedOutcome: null };
      }

      const recovered = buildInterruptedSubAgentOutput({
        agentName: opts.agentName,
        reason: "produced an incomplete synthesis after substantive work.",
        swarmState: toolContext.swarmState,
        toolNames,
        toolCount,
        iterations,
        artifacts,
        evidenceSnippets: usableHistorySnippets,
        primaryDelegationBody: extractMostRecentSubstantialDelegationBody(history),
        mutatedFileLines: currentMutatedFileLines(),
      });
      log.warn(
        { agentName: opts.agentName, resultLength: rawResult.length, recoveredSnippets: usableHistorySnippets.length },
        "Sub-agent claimed collected evidence was truncated — returning recovered tool evidence instead",
      );
      return { result: recovered, forcedOutcome: "partial" };
    };

    // Facts-first synthesis input. The forced-synthesis passes below previously
    // fed the model the FULL raw history (~20K tokens of web_search/web_fetch
    // dumps), which the slow 35B routinely fails to synthesize — it returns "no
    // final response" even with unbounded time (audit 1dc806bf: researchers
    // gathered 13-16 findings, produced nothing, the turn shipped a raw evidence
    // list). The evidence is already in the curated shared facts (extracted,
    // distilled, note-stripped) — a few KB the model CAN digest. Build the
    // synthesis prompt from those when substantial; fall back to history otherwise.
    const SYNTH_FACTS_MIN_CHARS = 400;
    const readCuratedFindingsForSynthesis = async (budgetChars = 12_000): Promise<string> => {
      try {
        const facts = await readAllFacts(deriveRootSessionId(subSessionId));
        const entries = Object.entries(facts)
          .filter(([, v]) => typeof v === "string" && v.trim().length > 0)
          .sort(([a], [b]) => a.localeCompare(b));
        if (entries.length === 0) return "";
        const lines: string[] = [];
        let used = 0;
        for (const [, value] of entries) {
          const line = `- ${String(value).replace(/\s+/g, " ").trim()}`;
          if (used + line.length > budgetChars && lines.length > 0) break;
          lines.push(line);
          used += line.length;
        }
        return lines.join("\n");
      } catch {
        return "";
      }
    };
    const buildFactsFirstSynthMessages = (curated: string): LLMMessage[] =>
      buildFactsFirstSynthesisMessages(opts.task, curated);
    /** Run a forced-synthesis completion, preferring the streaming accumulator so
     *  it gets token-progress + the per-chunk inactivity abort (a hung synthesis
     *  is exactly the failure we're guarding against). */
    const runSynthesisCompletion = (msgs: LLMMessage[], sig?: AbortSignal) =>
      synthProvider.completeViaStream
        ? synthProvider.completeViaStream(msgs, [], sig)
        : synthProvider.complete(msgs, [], sig);

    // "Done is done" (audit 2445da2e): when a BUILD-shaped run has already
    // persisted its deliverable(s), a final-synthesis LLM call adds no
    // information — on a stalled provider it burned the remaining budget and
    // re-branded a finished build as timeout/partial (content_writer wrote the
    // paper + shared the finding at 171s, then died at 270s waiting for the
    // final message). Return a deterministic completion instead. Scoped to
    // artifact-creation tasks: research runs still need the LLM synthesis
    // because their deliverable IS the prose.
    const tryDeterministicArtifactCompletion = (trigger: string): SubAgentRunResult | null => {
      if (artifacts.length === 0) return null;
      if (!looksLikeArtifactCreationRequest(opts.task)) return null;
      const lines = artifacts.map((artifact) => {
        const path = typeof artifact["outputPath"] === "string" && artifact["outputPath"]
          ? String(artifact["outputPath"])
          : (typeof artifact["filename"] === "string" ? String(artifact["filename"]) : "artifact");
        const rawBytes = typeof artifact["bytes"] === "number"
          ? artifact["bytes"]
          : (typeof artifact["size"] === "number" ? artifact["size"] : undefined);
        return `- ${path}${typeof rawBytes === "number" ? ` (${Math.max(1, Math.round(rawBytes / 1024))} KB)` : ""}`;
      });
      // "Done" requires the files to actually be done. A timeout that cut the
      // build mid-chunk leaves a structurally truncated file — report that as
      // PARTIAL with the broken paths named, never as a completed deliverable
      // (audit e5b5850b: half-written quiz app shipped as "Deliverable
      // completed" and the user opened an app with no questions and no JS).
      const truncated = artifacts
        .map((artifact) => ({
          path: typeof artifact["outputPath"] === "string" && artifact["outputPath"]
            ? String(artifact["outputPath"])
            : (typeof artifact["filename"] === "string" ? String(artifact["filename"]) : "artifact"),
          // Workspace root supplied: write_file records the MODEL's relative path, which
          // only resolves against this run's workspace — without it the probe missed every
          // file and a half-written build was branded complete.
          reason: artifactFileLooksTruncated(artifact, opts.workspacePath),
        }))
        .filter((entry): entry is { path: string; reason: string } => Boolean(entry.reason));
      if (truncated.length > 0) {
        const output = [
          "Build INTERRUPTED before completion — file(s) were written but at least one is structurally incomplete:",
          ...lines,
          ...truncated.map((entry) => `INCOMPLETE: ${entry.path} — ${entry.reason}.`),
          "Do NOT present these as finished deliverables. The build must be completed (e.g. append the missing content to the incomplete file) or re-run.",
        ].join("\n");
        const stats = buildStats(trigger === "timeout_synthesis" ? "timeout" : "completed", "partial");
        recordOutcome({
          ts: new Date().toISOString(),
          agent: opts.agentName,
          task: opts.task.slice(0, 200),
          outcome: "partial",
          iterations,
          totalTokens: usage.totalTokens,
          durationMs: Date.now() - runStartedAt,
          timeoutMs: turnTimeoutMs,
        });
        logSubAgentCompletionAudit(stats, output, {
          deterministicArtifactCompletion: true,
          artifactTruncated: truncated.map((entry) => entry.path),
          trigger,
          artifactCount: artifacts.length,
          timeoutMs: turnTimeoutMs,
        }, "warn");
        opts.onProgress?.({
          agentName: opts.agentName,
          kind: "completed",
          iteration: iterations,
          summary: `Interrupted ${opts.agentName} — ${truncated.length} written file(s) look structurally incomplete.`,
        });
        return withArtifacts({ output, stats });
      }
      const output =
        "Deliverable completed. The following file(s) were written this run and are attached as artifacts:\n"
        + lines.join("\n");
      const stats = buildStats("completed", "success");
      recordOutcome({
        ts: new Date().toISOString(),
        agent: opts.agentName,
        task: opts.task.slice(0, 200),
        outcome: "success",
        iterations,
        totalTokens: usage.totalTokens,
        durationMs: Date.now() - runStartedAt,
        timeoutMs: turnTimeoutMs,
      });
      logSubAgentCompletionAudit(stats, output, {
        deterministicArtifactCompletion: true,
        trigger,
        artifactCount: artifacts.length,
        timeoutMs: turnTimeoutMs,
      }, "info");
      opts.onProgress?.({
        agentName: opts.agentName,
        kind: "completed",
        iteration: iterations,
        summary: `Completed ${opts.agentName} — deliverables already written; skipped final synthesis.`,
      });
      return withArtifacts({ output, stats });
    };

    const attemptTimeoutSynthesis = async (): Promise<SubAgentRunResult | null> => {
      if (!turnTimeoutMs || toolCount === 0 || !history.some((message) => message.role === "tool") || opts.signal?.aborted) {
        return null;
      }

      // Built deliverables make the synthesis pass redundant — return them.
      const deterministicAtTimeout = tryDeterministicArtifactCompletion("timeout_synthesis");
      if (deterministicAtTimeout) return deterministicAtTimeout;

      // Single-delegation passthrough first. If the only substantive work was
      // one substantial delegation, the synthesis pass is wasted effort — the
      // delegated specialist's body IS the answer. Returning it directly
      // avoids burning the grace window on a synthesis that often produces a
      // truncated head of the same content anyway.
      const passthrough = tryReturnSingleDelegationPassthrough("timeout_synthesis");
      if (passthrough) return passthrough;

      // The grace window has to fit at least one full LLM inference on the
      // slowest provider the runtime is actually used with. The previous
      // 5s cap was tuned for cloud APIs; on a local 35B model where each
      // completion takes 25–60s, the synthesis was aborted before it
      // could produce a single token and the run died with only the
      // interrupted-output scaffold. Scale to 15% of the turn budget,
      // capped at 25s so an 8-minute coordinator does not get an
      // unboundedly large deadline-grace either.
      const graceTimeoutMs = Math.max(5_000, Math.min(25_000, Math.round(turnTimeoutMs * 0.15)));
      const graceAbort = new AbortController();
      const graceTimer = setTimeout(() => graceAbort.abort(), graceTimeoutMs);
      const graceSignal = opts.signal
        ? AbortSignal.any([opts.signal, graceAbort.signal])
        : graceAbort.signal;

      try {
        const curatedFindings = await readCuratedFindingsForSynthesis();
        const synthMessages: LLMMessage[] = curatedFindings.length >= SYNTH_FACTS_MIN_CHARS
          ? buildFactsFirstSynthMessages(curatedFindings)
          : [
            {
              role: "system",
              content: systemPrompt +
                "\n\nYour execution time budget has expired. DO NOT call any more tools. " +
                "Produce your COMPLETE final answer immediately from the tool results already in the conversation. " +
                "Include the key facts, URLs, and evidence you already retrieved. " +
                "Do NOT mention the timeout unless the prior evidence itself requires it.",
            },
            ...history,
          ];
        const synthResponse = await runSynthesisCompletion(synthMessages, graceSignal);
        usage.promptTokens += synthResponse.usage.promptTokens;
        usage.completionTokens += synthResponse.usage.completionTokens;
        usage.totalTokens += synthResponse.usage.totalTokens;

        if (synthResponse.tool_calls.length > 0) {
          return null;
        }

        let result = normalizeSubAgentOutput(synthResponse.content);
        if (result === "Sub-agent produced no final response.") {
          return null;
        }
        if (looksLikeProviderErrorEcho(result)) {
          log.warn(
            { agentName: opts.agentName, preview: result.slice(0, 200) },
            "Grace-deadline synthesis returned a regurgitated provider error — falling through to interrupted-output recovery",
          );
          return null;
        }
        result = await rescueSanitizedEmptyResult(result);
        const recovered = recoverNoResponseAfterSubstantiveWork(result);
        result = recovered.result;
        result = maybePreferWorkflowOutput(result, workflowPassthroughOutput, toolNames);
        const truncationRecovered = recoverHallucinatedTruncationAfterSubstantiveWork(result);
        result = truncationRecovered.result;
        if (result === "Sub-agent produced no final response.") {
          return null;
        }

        const outputScan = scanOutput(result);
        if (!outputScan.safe && outputScan.redacted) {
          logAudit(
            "output_redacted",
            { agentName: opts.agentName, types: outputScan.detectedTypes },
            { sessionId: subSessionId, severity: "warn" }
          );
          result = outputScan.redacted;
        }

        const semanticOutcome: SubAgentOutcome = recovered.forcedOutcome
          ?? truncationRecovered.forcedOutcome
          ?? (/no results|not found|unable to|failed to|error:/i.test(result.slice(0, 300))
            ? "partial"
            : "success");
        const stats = buildStats("completed", semanticOutcome);
        const suspicious = rejectSuspiciousNoToolOutput(
          opts,
          stats,
          result,
          turnTimeoutMs,
          runStartedAt,
        );
        if (suspicious) {
          return suspicious;
        }

        recordOutcome({
          ts: new Date().toISOString(),
          agent: opts.agentName,
          task: opts.task.slice(0, 200),
          outcome: semanticOutcome,
          iterations,
          totalTokens: usage.totalTokens,
          durationMs: Date.now() - runStartedAt,
          timeoutMs: turnTimeoutMs,
        });
        logSubAgentCompletionAudit(
          stats,
          result,
          { synthesizedAfterTimeout: true, timeoutMs: turnTimeoutMs, timeoutGraceMs: graceTimeoutMs },
          semanticOutcome === "success" ? "info" : "warn",
        );
        opts.onProgress?.({
          agentName: opts.agentName,
          kind: "completed",
          iteration: iterations,
          summary: `Completed delegated work in ${opts.agentName} after timeout-aware synthesis.`,
        });
        return withArtifacts({ output: result, stats });
      } catch (synthErr) {
        log.warn({ synthErr, agentName: opts.agentName }, "Timeout synthesis failed");
        return null;
      } finally {
        clearTimeout(graceTimer);
      }
    };

    // I11: Pre-emptive (soft-deadline) synthesis. Same shape as
    // `attemptTimeoutSynthesis` but runs BEFORE the hard deadline with a
    // real budget so the model has a full inference window to convert its
    // accumulated tool results into a useful answer. Without this, leaf
    // agents on slow local models routinely die with web_search hits and
    // page snapshots in conversation history but no final synthesis,
    // and the coordinator above sees only "Sub-agent timed out" with
    // none of the actually-collected data.
    const attemptPreDeadlineSynthesis = async (budgetMs: number): Promise<SubAgentRunResult | null> => {
      if (toolCount === 0 || !history.some((message) => message.role === "tool") || opts.signal?.aborted) {
        return null;
      }

      // Built deliverables make the reserved synthesis window redundant —
      // return them immediately instead of spending the window on an LLM call.
      const deterministicAtSoftDeadline = tryDeterministicArtifactCompletion("soft_deadline");
      if (deterministicAtSoftDeadline) return deterministicAtSoftDeadline;

      // Single-delegation passthrough — the soft-deadline synthesis would just
      // re-wrap one already-final delegation result. Skip the LLM call when
      // we can return the body directly.
      const passthrough = tryReturnSingleDelegationPassthrough("soft_deadline_synthesis");
      if (passthrough) return passthrough;

      const synthAbort = new AbortController();
      const synthTimer = setTimeout(() => synthAbort.abort(), budgetMs);
      const synthSignal = opts.signal
        ? AbortSignal.any([opts.signal, synthAbort.signal])
        : synthAbort.signal;

      try {
        const curatedFindings = await readCuratedFindingsForSynthesis();
        const synthMessages: LLMMessage[] = curatedFindings.length >= SYNTH_FACTS_MIN_CHARS
          ? buildFactsFirstSynthMessages(curatedFindings)
          : [
            {
              role: "system",
              content: systemPrompt +
                "\n\n[SOFT DEADLINE REACHED — SYNTHESIZE NOW]\n" +
                "You have used most of your execution budget. Stop calling tools. " +
                "Produce your COMPLETE final answer immediately from the tool results already in the conversation history above. " +
                "Include EVERY headline, fact, URL, name, number, source attribution, and snippet you already retrieved — across ALL sources, not just the first one. " +
                "If the evidence covers multiple sources (e.g. several news outlets), your answer MUST visibly cover all of them. " +
                "If your synthesis would exceed roughly 3000 characters, also include the full content verbatim — do not abbreviate, do not collapse list items, do not write '(truncated)'. " +
                "If you genuinely have no usable evidence, say so plainly and list what you tried. " +
                "Do NOT mention the soft deadline. Do NOT call any tools. Write the answer the user actually asked for.",
            },
            ...history,
          ];
        const synthResponse = await runSynthesisCompletion(synthMessages, synthSignal);
        usage.promptTokens += synthResponse.usage.promptTokens;
        usage.completionTokens += synthResponse.usage.completionTokens;
        usage.totalTokens += synthResponse.usage.totalTokens;

        // If the model still tried to call tools despite the explicit "no
        // tools" instruction, fall through and let the iteration loop
        // either succeed normally or hit the hard timeout.
        if (synthResponse.tool_calls.length > 0) {
          return null;
        }

        let result = normalizeSubAgentOutput(synthResponse.content);
        if (result === "Sub-agent produced no final response.") {
          return null;
        }
        if (looksLikeProviderErrorEcho(result)) {
          log.warn(
            { agentName: opts.agentName, preview: result.slice(0, 200) },
            "Soft-deadline synthesis returned a regurgitated provider error — falling through to interrupted-output recovery",
          );
          return null;
        }
        result = await rescueSanitizedEmptyResult(result);
        const recovered = recoverNoResponseAfterSubstantiveWork(result);
        result = recovered.result;
        result = maybePreferWorkflowOutput(result, workflowPassthroughOutput, toolNames);
        if (result === "Sub-agent produced no final response.") {
          return null;
        }

        const outputScan = scanOutput(result);
        if (!outputScan.safe && outputScan.redacted) {
          logAudit(
            "output_redacted",
            { agentName: opts.agentName, types: outputScan.detectedTypes },
            { sessionId: subSessionId, severity: "warn" }
          );
          result = outputScan.redacted;
        }

        const semanticOutcome: SubAgentOutcome = recovered.forcedOutcome
          ?? (/no results|not found|unable to|failed to|error:/i.test(result.slice(0, 300))
            ? "partial"
            : "success");
        const stats = buildStats("completed", semanticOutcome);
        const suspicious = rejectSuspiciousNoToolOutput(
          opts,
          stats,
          result,
          turnTimeoutMs,
          runStartedAt,
        );
        if (suspicious) {
          return suspicious;
        }

        recordOutcome({
          ts: new Date().toISOString(),
          agent: opts.agentName,
          task: opts.task.slice(0, 200),
          outcome: semanticOutcome,
          iterations,
          totalTokens: usage.totalTokens,
          durationMs: Date.now() - runStartedAt,
          timeoutMs: turnTimeoutMs,
        });
        logSubAgentCompletionAudit(
          stats,
          result,
          { synthesizedAtSoftDeadline: true, softDeadlineBudgetMs: budgetMs, timeoutMs: turnTimeoutMs },
          semanticOutcome === "success" ? "info" : "warn",
        );
        opts.onProgress?.({
          agentName: opts.agentName,
          kind: "completed",
          iteration: iterations,
          summary: `Completed delegated work in ${opts.agentName} via pre-deadline synthesis.`,
        });
        return withArtifacts({ output: result, stats });
      } catch (synthErr) {
        log.warn({ synthErr, agentName: opts.agentName }, "Pre-deadline synthesis failed");
        return null;
      } finally {
        clearTimeout(synthTimer);
      }
    };

    const emitSubAgentToolAudit = (params: Parameters<typeof buildSubAgentToolAuditPayload>[0]): void => {
      const payload = buildSubAgentToolAuditPayload(params);
      const isWarn = params.phase === "done" && (payload["success"] === false || typeof payload["skippedReason"] === "string");
      logAudit("sub_agent_tool_call", payload, { sessionId: subSessionId, severity: isWarn ? "warn" : "info" });
    };

    const recordArtifacts = (metadata: unknown, defaults: Record<string, unknown> = {}): void => {
      if (!metadata) {
        return;
      }

      if (Array.isArray(metadata)) {
        for (const entry of metadata) {
          recordArtifacts(entry, defaults);
        }
        return;
      }

      if (typeof metadata !== "object") {
        return;
      }

      const value = metadata as Record<string, unknown>;
      const outputPath = typeof value["outputPath"] === "string" ? value["outputPath"] : "";
      const dataUrl = typeof value["dataUrl"] === "string" ? value["dataUrl"] : "";
      const externalUrl = typeof value["externalUrl"] === "string" ? value["externalUrl"] : "";
      if (outputPath || dataUrl || externalUrl) {
        const artifact = { ...defaults, ...value };
        const key = [
          typeof artifact["outputPath"] === "string" ? artifact["outputPath"] : "",
          typeof artifact["dataUrl"] === "string" ? artifact["dataUrl"] : "",
          typeof artifact["externalUrl"] === "string" ? artifact["externalUrl"] : "",
          typeof artifact["filename"] === "string" ? artifact["filename"] : "",
          typeof artifact["sourceTool"] === "string" ? artifact["sourceTool"] : "",
        ].join("::");
        if (!artifactKeys.has(key)) {
          artifactKeys.add(key);
          artifacts.push(artifact);
        }
      }

      const nestedArtifacts = value["artifacts"];
      if (Array.isArray(nestedArtifacts)) {
        for (const nestedArtifact of nestedArtifacts) {
          recordArtifacts(nestedArtifact, defaults);
        }
      }
    };

    /** Point-in-time shape reading. Pure counter reads — no allocation of note, no LLM. */
    const sampleProgress = (): ProgressSample => {
      let distinctWriteHashes = 0;
      for (const hashes of writeHistory.values()) distinctWriteHashes += new Set(hashes).size;
      return {
        productiveToolCalls: successfulToolCount,
        mutatedPaths: mutatedWorkspacePaths.size,
        distinctWriteHashes,
        outputChars: outputCharsTotal,
        reasoningChars: reasoningCharsTotal,
      };
    };

    /**
     * Wind this run down the way an operator `stop` does: latch the two flags the loop
     * already reacts to, so the next iteration goes to attemptTimeoutSynthesis and the
     * evidence collected so far is synthesised and handed back. Never a hard kill.
     *
     * Deliberately does NOT call longRunningGenerationManager.requestStop(). That sets a
     * latch keyed on the ROOT (turn) session, which is right for an operator decision —
     * the operator means the whole turn — and wrong for the supervisor now that it runs
     * for every sub-agent: one pathological leaf would wind down its healthy siblings
     * too. The supervisor is INSIDE the run it is judging and needs no cross-run channel
     * to reach it.
     */
    const windDownForSupervisor = (): void => {
      lrgOperatorStop = true;
      turnTimeoutReached = true;
      // The consumer below is `turnTimeoutReached && turnTimeoutMs`. An agent that
      // declares no turn timeout — increasingly the point, now that supervision replaces
      // the static budgets — would latch the flag and have nobody read it, which is
      // exactly how a fix ships inert. This flag makes the wind-down independent of
      // whether a deadline happens to exist.
      supervisorStop = true;
    };

    /**
     * THE SUPERVISOR — the thing that replaces the static limits.
     *
     * Cheap and pure: a few counter reads and one comparison, no LLM in the hot path.
     * Runs for EVERY sub-agent at EVERY tier, and especially for a run that was granted
     * unbounded budget — a run nobody is timing is the run that most needs watching.
     *
     * Its predecessor could never reach a verdict. It lived inside the `unbounded`
     * branch, below a markUnbounded() call that flipped the very guard the branch sat
     * under, so it executed at most ONCE per run while its stall rule required two
     * consecutive samples. It is now called unconditionally at the top of each iteration
     * AND on a timer, so a run parked inside one very long streaming completion is still
     * visible — the old placement could only sample BETWEEN iterations.
     */
    const superviseProgress = (trigger: "iteration" | "timer"): void => {
      if (lrgOperatorStop) return;
      if (Date.now() - lrgLastProgressCheckAt < PROGRESS_CHECK_INTERVAL_MS) return;
      lrgLastProgressCheckAt = Date.now();
      const cur = sampleProgress();
      const decision = classifyRunProgress(lrgLastSample, cur, lrgConsecutiveStalls);
      lrgConsecutiveStalls = decision.consecutiveStalls;
      lrgLastSample = cur;
      if (decision.action === "continue") return;
      if (decision.action === "ask") {
        // AMBIGUOUS — a run that has produced something and gone quiet may be
        // mid-verification. Surface it to the operator dock instead of deciding; the
        // notify path is idempotent per run, so this cannot spam.
        longRunningGenerationManager.notifyLongRunning({
          agentName: opts.agentName,
          runSessionId: subSessionId,
          ...(opts.parentSessionId ? { parentSessionId: opts.parentSessionId } : {}),
          reason: `${opts.agentName}: ${decision.reason}`,
          elapsedMs: Date.now() - runStartedAt,
          completionTokens: usage.completionTokens,
          iterations,
        });
        return;
      }
      windDownForSupervisor();
      logAudit("progress_verifier_intervened", {
        agentName: opts.agentName,
        runSessionId: subSessionId,
        trigger,
        verdict: decision.verdict,
        reason: decision.reason,
        elapsedMs: Date.now() - runStartedAt,
        productiveToolCalls: cur.productiveToolCalls,
        mutatedPaths: cur.mutatedPaths,
        reasoningChars: cur.reasoningChars,
        outputChars: cur.outputChars,
        iterations,
      }, { sessionId: opts.parentSessionId, severity: "warn" });
    };
    supervisorTimer = setInterval(() => superviseProgress("timer"), PROGRESS_CHECK_INTERVAL_MS);
    supervisorTimer.unref?.();

    while (iterations < maxIterations) {
      // SUPERVISION RUNS FIRST AND ALWAYS, before any budget/tier branch below can
      // decide this run is somebody else's problem.
      superviseProgress("iteration");

      // SEMANTIC direction judge — opt-in (orchestration.progressVerifierSemantic,
      // default off pending live eval), bounded, fail-open. The structural rules above
      // see a run that has stopped DOING; a busy run can still be doing the wrong thing,
      // which structure alone cannot see. Throttled on its own clock so the (default-on)
      // supervisor sampling above never starves it, and vice versa. It was previously
      // nested in the max-effort `unbounded` branch and was unreachable for the same
      // reason the structural check was.
      if (!lrgOperatorStop && getConfig().orchestration?.progressVerifierSemantic
        && Date.now() - lrgLastJudgeAt >= PROGRESS_CHECK_INTERVAL_MS) {
        lrgLastJudgeAt = Date.now();
        try {
          const lastAssistant = [...history].reverse().find(
            (m) => m.role === "assistant" && typeof m.content === "string" && m.content.trim().length > 0,
          );
          const recentActivity = [
            lastAssistant ? `Latest output:\n${String(lastAssistant.content).slice(0, 1200)}` : "",
            toolNames.length ? `Recent tool calls: ${toolNames.slice(-8).join(", ")}` : "",
          ].filter(Boolean).join("\n\n") || "(no assistant output or tool calls yet)";
          const judgeProvider = getChatProviderForTier("routing") ?? provider;
          const judgeResp = await judgeProvider.complete(
            buildProgressJudgePrompt({ objective: opts.task, recentActivity }),
            [],
            signal,
          );
          const verdict = parseProgressVerdict(judgeResp.content);
          if (verdict.verdict === "drifting") {
            windDownForSupervisor();
            logAudit("progress_verifier_intervened", {
              agentName: opts.agentName,
              runSessionId: subSessionId,
              trigger: "semantic_judge",
              verdict: "drifting",
              reason: verdict.reason,
              elapsedMs: Date.now() - runStartedAt,
              iterations,
            }, { sessionId: opts.parentSessionId, severity: "warn" });
          }
        } catch {
          // fail-open: a judge failure must never stop a healthy run.
        }
      }
      // Long-running-generation handoff — NON-BLOCKING. When this run has
      // burned past the soft thresholds (wall time OR completion tokens),
      // SURFACE it to the operator dock (so the operator can stop it or
      // grant unbounded budget) but never PAUSE the agent waiting for a
      // response.
      //
      // The old code `await`ed the operator inline. A paused agent keeps
      // holding BOTH its per-agent and the shared global concurrency slot
      // (swarm/concurrency.ts) while it sits idle, so it stalls every
      // sibling and parent in the swarm; and on no-response the default
      // `stop` truncated productive work. On a single-GPU local model
      // essentially every substantial run crosses the soft threshold, so
      // the pause fired constantly and a single slow agent repeatedly
      // brought the whole turn to a halt — the opposite of the handoff's
      // intent. The operator's decision is now honoured asynchronously:
      // `isStopRequested` (a turn-level latch that any sibling stop also
      // sets) winds this run down on the next iteration, and `isUnbounded`
      // suppresses further surfacing. The hard `turnTimeoutMs` and the
      // soft-deadline synthesis above remain the real safety bounds.
      // Operator granted "unbounded": the dock promises "let it finish
      // naturally", so the hard turn deadline is suspended for this run
      // (audit 2445da2e: the grant only silenced the dock while the run
      // still died at turnTimeoutMs mid-synthesis). maxIterations and
      // provider failures remain the safety bounds; an operator "stop"
      // still wins.
      if (!lrgOperatorStop && turnTimeoutReached && longRunningGenerationManager.isUnbounded(subSessionId)) {
        turnTimeoutReached = false;
        // Clearing the latch alone is not enough: the deadline also ABORTED the run's
        // model signal, and an aborted controller stays aborted. Without this the run
        // would resume only to have its very next completion reject instantly and be
        // recorded as a timeout — the grant honoured on paper and defeated in fact.
        rearmDeadlineForUnboundedGrant();
        logAudit("long_running_generation_auto_resolved", {
          agentName: opts.agentName,
          runSessionId: subSessionId,
          action: "deadline_suspended_by_unbounded_grant",
          turnTimeoutMs,
          elapsedMs: Date.now() - runStartedAt,
          iterations,
        }, { sessionId: opts.parentSessionId, severity: "info" });
      }
      if (!lrgOperatorStop && !longRunningGenerationManager.isUnbounded(subSessionId)) {
        if (longRunningGenerationManager.isStopRequested(subSessionId)) {
          // Operator stopped this run (or the whole turn). Mark the run for
          // synthesis on the next iteration — reuses the existing
          // timeout-synthesis path so collected evidence is relayed instead
          // of making another LLM call.
          lrgOperatorStop = true;
          turnTimeoutReached = true;
        } else if (
          (Date.now() - runStartedAt) > lrgWallThresholdMs
          || usage.completionTokens > lrgTokenThreshold
        ) {
          // Effort-tier policy answers "this run is taking a while — keep going?"
          // automatically so the operator isn't pinged on every crossing:
          //   low  → stop now (wind down + synthesise from what's collected)
          //   high → continue WITHOUT a dock prompt (bounded by the tier's 20-min cap)
          //   max  → grant unbounded budget silently; the verify-progress guard
          //          (structural stall + opt-in semantic judge) watches for a
          //          runaway run instead of the operator
          //   medium / undefined → surface to the operator dock as before
          const lrgAction = longRunningActionForTier(currentEffortTier());
          if (lrgAction === "stop" && !lrgAutoHandled) {
            lrgAutoHandled = true;
            lrgOperatorStop = true;
            turnTimeoutReached = true;
            logAudit("long_running_generation_auto_resolved", {
              agentName: opts.agentName,
              runSessionId: subSessionId,
              tier: "low",
              action: "stop",
              elapsedMs: Date.now() - runStartedAt,
              completionTokens: usage.completionTokens,
            }, { sessionId: opts.parentSessionId, severity: "info" });
          } else if (lrgAction === "continue") {
            if (!lrgAutoHandled) {
              lrgAutoHandled = true;
              logAudit("long_running_generation_auto_resolved", {
                agentName: opts.agentName,
                runSessionId: subSessionId,
                tier: "high",
                action: "continue",
                elapsedMs: Date.now() - runStartedAt,
                completionTokens: usage.completionTokens,
              }, { sessionId: opts.parentSessionId, severity: "info" });
            }
            // No dock prompt and no stop — the run keeps going, bounded by the tier's
            // own turnTimeoutMs (the real cap stays in force via turnTimeoutReached).
          } else if (lrgAction === "unbounded") {
            // max effort: grant unbounded budget ONCE, silently (no operator dock).
            // The run finishes naturally; the verify-progress guard below replaces
            // the operator as the thing that stops a stalled or drifting run.
            if (!lrgUnboundedGranted) {
              lrgUnboundedGranted = true;
              longRunningGenerationManager.markUnbounded(subSessionId);
              logAudit("long_running_generation_auto_resolved", {
                agentName: opts.agentName,
                runSessionId: subSessionId,
                tier: "max",
                action: "unbounded",
                elapsedMs: Date.now() - runStartedAt,
                completionTokens: usage.completionTokens,
              }, { sessionId: opts.parentSessionId, severity: "info" });
            }
            // The progress check that used to live here has moved to the top of the
            // loop (superviseProgress). It was unreachable from this position: the
            // markUnbounded() call just above flips the `!isUnbounded` guard this whole
            // branch sits under, so the check ran at most ONCE per run while its stall
            // rule needed two consecutive samples. It also only watched `max` effort,
            // which is backwards — an unbounded run is the one that most needs a
            // supervisor, but so does every other run now that the static caps are gone.
          } else if (lrgAction === "ask") {
            // Idempotent per run: only the first crossing surfaces a dock entry.
            longRunningGenerationManager.notifyLongRunning({
              agentName: opts.agentName,
              runSessionId: subSessionId,
              ...(opts.parentSessionId ? { parentSessionId: opts.parentSessionId } : {}),
              reason: `${opts.agentName} has been generating for ${Math.round((Date.now() - runStartedAt) / 1000)}s and burned ${usage.completionTokens} completion tokens across ${iterations} iterations; ${toolCount} tool calls so far`,
              elapsedMs: Date.now() - runStartedAt,
              completionTokens: usage.completionTokens,
              iterations,
            });
          }
        }
      }

      // I11: Pre-emptive soft-deadline synthesis.
      // The hard `turnTimeoutMs` deadline triggers `attemptTimeoutSynthesis`
      // with only ~5s of grace, which is not enough on a 35B local model
      // where each LLM call takes 10-20s. The leaf agent then dies with
      // useful tool results (web_search hits, navigation snapshots, etc.)
      // sitting in conversation history but no final answer for the
      // coordinator to reuse. Reserve a real synthesis budget BEFORE the
      // hard deadline so the model has one full inference window to turn
      // its accumulated evidence into an answer.
      //
      // Reserved budget = max(20s, min(60s, turnTimeoutMs * 0.25)).
      // For a 180s leaf timeout that's a 45s synthesis window starting at
      // 135s elapsed. For a 900s leaf that's a 60s window starting at
      // 840s. Tool calls are blocked during this window — only synthesis
      // is allowed. We only fire the soft deadline once and only when
      // (a) the hard timeout hasn't already triggered, (b) we have real
      // tool output to synthesize from, and (c) the soft deadline has
      // genuinely been crossed.
      if (
        turnTimeoutMs
        && turnTimeoutMs >= 60_000
        && !turnTimeoutReached
        && !softDeadlineSynthesisAttempted
        && toolCount > 0
        && history.some((message) => message.role === "tool")
        // Unbounded grant suspends the soft deadline too — the operator asked
        // for the run to finish naturally.
        && !longRunningGenerationManager.isUnbounded(subSessionId)
      ) {
        const elapsed = Date.now() - runStartedAt;
        // I11.1: Bumped reservation to 33% (min 30s, max 75s). The previous
        // 25% / 20s window was repeatedly eaten by an in-flight tool call
        // that started just before the soft-deadline check, leaving only
        // a couple of seconds before the hard wall. A larger reservation
        // gives the synthesis pass a real chance to fire even when the
        // last tool round took 30-40s.
        const reservedSynthesisMs = Math.max(30_000, Math.min(75_000, Math.round(turnTimeoutMs * 0.33)));
        if (elapsed >= turnTimeoutMs - reservedSynthesisMs) {
          softDeadlineSynthesisAttempted = true;
          logAudit(
            "sub_agent_soft_deadline",
            {
              agentName: opts.agentName,
              elapsedMs: elapsed,
              turnTimeoutMs,
              reservedSynthesisMs,
              iterations,
              toolCount,
            },
            { sessionId: subSessionId, severity: "info" }
          );
          const synthesized = await attemptPreDeadlineSynthesis(reservedSynthesisMs);
          if (synthesized) {
            return synthesized;
          }
          // Synthesis attempt failed — fall through and keep iterating until
          // the hard deadline. The hard-deadline branch below will retry.
        }
      }

      if (turnTimeoutReached && (turnTimeoutMs || supervisorStop)) {
        const synthesized = await attemptTimeoutSynthesis();
        if (synthesized) {
          return synthesized;
        }
        const windDownReason = supervisorStop
          ? "was wound down by the progress supervisor (no forward progress)"
          : `timed out after ${turnTimeoutMs}ms after finishing the current operation`;
        const interruptedOutcome = classifyInterruptedOutcome({
          successfulToolCount,
          artifacts,
          swarmState: toolContext.swarmState,
        });
        recordOutcome({
          ts: new Date().toISOString(),
          agent: opts.agentName,
          task: opts.task.slice(0, 200),
          outcome: interruptedOutcome,
          iterations,
          totalTokens: usage.totalTokens,
          durationMs: Date.now() - runStartedAt,
          timeoutMs: turnTimeoutMs,
          error: supervisorStop
            ? "progress supervisor wound the run down after no forward progress"
            : `timeout (${turnTimeoutMs}ms) reached after current operation finished`,
        });
        const output = buildInterruptedSubAgentOutput({
          agentName: opts.agentName,
          reason: windDownReason,
          swarmState: toolContext.swarmState,
          toolNames,
          toolCount,
          iterations,
          artifacts,
          evidenceSnippets: resolveInterruptedEvidenceSnippets({ recentEvidenceSnippets, history }),
          primaryDelegationBody: currentPrimaryDelegationBody(),
          mutatedFileLines: currentMutatedFileLines(),
        });
        const stats = buildStats("timeout", interruptedOutcome);
        logSubAgentCompletionAudit(stats, output, { timeoutMs: turnTimeoutMs, stopAfterCurrentOperation: true, operatorStopped: lrgOperatorStop }, lrgOperatorStop ? "info" : "warn");
        return withArtifacts({
          output,
          stats,
        });
      }

      if (signal?.aborted) {
        const interruptedOutcome = classifyInterruptedOutcome({
          successfulToolCount,
          artifacts,
          swarmState: toolContext.swarmState,
        });
        recordOutcome({
          ts: new Date().toISOString(),
          agent: opts.agentName,
          task: opts.task.slice(0, 200),
          outcome: interruptedOutcome,
          iterations,
          totalTokens: usage.totalTokens,
          durationMs: Date.now() - runStartedAt,
          timeoutMs: turnTimeoutMs,
          error: "cancelled",
        });
        const output = buildInterruptedSubAgentOutput({
          agentName: opts.agentName,
          reason: "was cancelled",
          swarmState: toolContext.swarmState,
          toolNames,
          toolCount,
          iterations,
          artifacts,
          evidenceSnippets: resolveInterruptedEvidenceSnippets({ recentEvidenceSnippets, history }),
          primaryDelegationBody: currentPrimaryDelegationBody(),
          mutatedFileLines: currentMutatedFileLines(),
        });
        const stats = buildStats("cancelled", interruptedOutcome);
        logSubAgentCompletionAudit(stats, output, { cancelled: true }, "warn");
        return withArtifacts({
          output,
          stats,
        });
      }

      // ── Iteration budget awareness ──────────────────────────────────────
      // When running low on iterations, take increasingly aggressive
      // measures to force the agent to synthesize instead of tool-calling.
      const remaining = maxIterations - iterations;
      const elapsedMs = Date.now() - runStartedAt;
      const synthesisBufferMs = turnTimeoutMs
        ? Math.max(3_000, Math.min(10_000, Math.round(turnTimeoutMs * 0.15)))
        : undefined;
      const timeRemainingMs = turnTimeoutMs ? Math.max(0, turnTimeoutMs - elapsedMs) : undefined;
      const timeBudgetCritical = toolCount > 0
        && synthesisBufferMs !== undefined
        && timeRemainingMs !== undefined
        && timeRemainingMs <= synthesisBufferMs;
      let effectiveSystemPrompt = systemPrompt;
      let effectiveTools = tools;

      if (timeBudgetCritical) {
        effectiveTools = [];
        effectiveSystemPrompt +=
          `\n\n⚠️ TIME BUDGET CRITICAL: Only about ${timeRemainingMs}ms remain before timeout. ` +
          "NO MORE TOOLS AVAILABLE. Produce your COMPLETE final answer NOW from the evidence already gathered. " +
          "Include the key facts, URLs, and extracts you already retrieved.";
        log.info(
          { agentName: opts.agentName, iterations, toolCount, timeRemainingMs, synthesisBufferMs },
          "Time budget nearly exhausted — stripping tools to force synthesis",
        );
      } else if (remaining === 1 && toolCount > 0) {
        // HARD: last iteration — strip ALL tools so the LLM *cannot* make
        // any more tool calls and is forced to produce a text answer.
        effectiveTools = [];
        effectiveSystemPrompt +=
          "\n\n⚠️ FINAL ITERATION — NO MORE TOOLS AVAILABLE. " +
          "You have used all your tool-call iterations. Produce your COMPLETE final answer NOW. " +
          "Synthesize everything you have gathered from previous tool calls — include ALL content, " +
          "URLs, facts, and extracts verbatim. Do NOT summarize away details. " +
          "Your response is the ONLY output the coordinator will receive from you.";
        log.info(
          { agentName: opts.agentName, iterations, maxIterations, toolCount },
          "Last iteration reached — stripping tools to force synthesis",
        );
      } else if (remaining === 2 && toolCount > 0) {
        effectiveSystemPrompt +=
          `\n\n⚠️ BUDGET WARNING: You have only ${remaining} iterations remaining (out of ${maxIterations}). ` +
          "You have already gathered substantial content. Stop calling tools UNLESS critical information is still missing. " +
          "Use your next response to produce your complete final answer with all facts, URLs, and evidence you have collected so far.";
      }

      // E18: Soft deadline — inject a wrap-up nudge once when the caller-supplied
      // deadline expires. Coordinators set this to ~70% of their own budget so
      // specialists begin wrapping up before the hard timeout fires.
      if (
        opts.softDeadlineMs !== undefined
        && !softDeadlineInjected
        && Date.now() >= opts.softDeadlineMs
        && toolCount > 0
      ) {
        softDeadlineInjected = true;
        effectiveSystemPrompt +=
          "\n\n⚠️ SOFT DEADLINE REACHED: Your allocated time budget for this task is expiring. " +
          "Plan to wrap up within the next 1–2 iterations: " +
          "call share_finding with any important evidence you have gathered, " +
          "then produce your complete final answer.";
        log.info(
          { agentName: opts.agentName, iterations, softDeadlineMs: opts.softDeadlineMs },
          "Soft deadline reached — injecting wrap-up nudge",
        );
      }

      // §12: Iteration-budget nudge — fire when many iterations pass without
      // any tool calls, even if the soft-deadline hasn't expired.  Prevents
      // agents that are "thinking aloud" from consuming the entire budget
      // without making progress.
      if (
        !softDeadlineInjected
        && toolCount === 0
        && iterations >= Math.floor(maxIterations * 0.7)
      ) {
        softDeadlineInjected = true; // reuse the flag so this fires only once
        effectiveSystemPrompt +=
          "\n\n⚠️ ITERATION BUDGET WARNING: You have used many iterations without calling any tools. " +
          "If you need to gather information, call the appropriate tools now. " +
          "If you already have enough context, produce your final answer immediately.";
        log.info(
          { agentName: opts.agentName, iterations, maxIterations, toolCount },
          "§12: Iteration-budget nudge injected (no tool calls at 70% of budget)",
        );
      }

      // E19 wave 2 follow-up: mid-turn degradation flip. If the warden
      // marked this session degraded after the turn already started, apply
      // the velocity nudge + tool cap to *this* iteration so the in-flight
      // loop tightens immediately instead of finishing the current turn at
      // full fan-out.
      if (!degradedMidTurnApplied && isSessionDegraded(subSessionId)) {
        degradedMidTurnApplied = true;
        effectiveSystemPrompt +=
          "\n\n⚠️ VELOCITY WARNING (mid-turn): The warden flagged this session "
          + "as approaching a tool-storm / messaging-flood threshold while you were "
          + "running. Narrow scope, batch tool calls, and finish quickly. Do not "
          + "spawn further delegations or parallel tool fan-out unless strictly "
          + "required to complete the task.";
        if (effectiveTools.length > 6) {
          effectiveTools = effectiveTools.slice(0, 6);
        }
        log.info(
          {
            agentName: opts.agentName,
            subSessionId,
            iteration: iterations + 1,
            remainingTools: effectiveTools.length,
          },
          "Sub-agent entered degraded mode mid-turn — nudge injected, tool list capped",
        );
      }

      // INPUT bound. The completion budget is derived from what the prompt leaves
      // free, so an append-only history would starve it before it overflows the
      // window. Trim BEFORE assembling the request, not after.
      const trimmed = trimSubAgentHistory(history, {
        systemPromptChars: effectiveSystemPrompt.length,
        tools: effectiveTools,
        contextWindow: modelConfig.contextWindow,
      });
      if (trimmed.dropped > 0) {
        logAudit(
          "sub_agent_history_trimmed",
          {
            agentName: opts.agentName,
            iteration: iterations + 1,
            droppedMessages: trimmed.dropped,
            remainingMessages: history.length,
            contextWindow: modelConfig.contextWindow,
          },
          { sessionId: subSessionId, severity: "info" },
        );
      }

      const messages: LLMMessage[] = [
        { role: "system", content: effectiveSystemPrompt },
        ...history,
      ];

      opts.onProgress?.({
        agentName: opts.agentName,
        kind: "thinking",
        iteration: iterations + 1,
        summary: `Planning the next delegated step in ${opts.agentName}.`,
      });

      let response;
      try {
        // Prefer the streaming accumulator on the long sub-agent calls: it gives
        // the provider-activity monitor live token progress (producing vs stuck
        // on the prompt vs stalled) and inherits stream()'s per-chunk inactivity
        // abort, which the plain non-streaming complete() lacks. Falls back to
        // complete() for any provider/mock that doesn't implement it.
        response = provider.completeViaStream
          ? await provider.completeViaStream(messages, effectiveTools, llmSignal)
          : await provider.complete(messages, effectiveTools, llmSignal);
      } catch (err) {
        if (opts.signal?.aborted) {
          const interruptedOutcome = classifyInterruptedOutcome({
            successfulToolCount,
            artifacts,
            swarmState: toolContext.swarmState,
          });
          recordOutcome({
            ts: new Date().toISOString(),
            agent: opts.agentName,
            task: opts.task.slice(0, 200),
            outcome: interruptedOutcome,
            iterations,
            totalTokens: usage.totalTokens,
            durationMs: Date.now() - runStartedAt,
            timeoutMs: turnTimeoutMs,
            error: "cancelled",
          });
          const output = buildInterruptedSubAgentOutput({
            agentName: opts.agentName,
            reason: "was cancelled",
            swarmState: toolContext.swarmState,
            toolNames,
            toolCount,
            iterations,
            artifacts,
            evidenceSnippets: recentEvidenceSnippets,
            primaryDelegationBody: currentPrimaryDelegationBody(),
            mutatedFileLines: currentMutatedFileLines(),
          });
          const stats = buildStats("cancelled", interruptedOutcome);
          logSubAgentCompletionAudit(stats, output, { cancelled: true }, "warn");
          return withArtifacts({
            output,
            stats,
          });
        }
        // The TURN DEADLINE aborted the in-flight completion (not the operator).
        // Take the same route the between-iterations latch takes above so the run
        // still gets its synthesis pass and its evidence relay, instead of being
        // reported as a generic "Sub-agent LLM call failed".
        //
        // Reached only when the provider's salvage found NOTHING to keep (the
        // deadline landed during prefill). When the model had already produced
        // content or a tool call, completeViaStream returns normally with
        // finishReason "length" and the existing latch handles the wind-down.
        //
        // Escape hatch 3 (grant landed WHILE this completion was in flight — the
        // operator answered the dock in the moments after the timer fired): the grant
        // outranks the deadline here too. Re-arm and take another pass instead of
        // reporting a timeout the operator just waived. Bounded: `iterations` still
        // advances and the one-shot timer never re-arms, so this cannot spin.
        if (
          deadlineAc.signal.aborted
          && !opts.signal?.aborted
          && longRunningGenerationManager.isUnbounded(subSessionId)
          && !longRunningGenerationManager.isStopRequested(subSessionId)
        ) {
          turnTimeoutReached = false;
          rearmDeadlineForUnboundedGrant();
          logAudit("long_running_generation_auto_resolved", {
            agentName: opts.agentName,
            runSessionId: subSessionId,
            action: "deadline_abort_retried_under_unbounded_grant",
            turnTimeoutMs,
            elapsedMs: Date.now() - runStartedAt,
            iterations,
          }, { sessionId: opts.parentSessionId, severity: "warn" });
          iterations++;
          continue;
        }
        if (deadlineAc.signal.aborted && turnTimeoutMs && !opts.signal?.aborted) {
          const synthesized = await attemptTimeoutSynthesis();
          if (synthesized) return synthesized;
          const interruptedOutcome = classifyInterruptedOutcome({
            successfulToolCount,
            artifacts,
            swarmState: toolContext.swarmState,
          });
          recordOutcome({
            ts: new Date().toISOString(),
            agent: opts.agentName,
            task: opts.task.slice(0, 200),
            outcome: interruptedOutcome,
            iterations,
            totalTokens: usage.totalTokens,
            durationMs: Date.now() - runStartedAt,
            timeoutMs: turnTimeoutMs,
            error: `timeout (${turnTimeoutMs}ms) aborted the in-flight completion`,
          });
          const output = buildInterruptedSubAgentOutput({
            agentName: opts.agentName,
            reason: `timed out after ${turnTimeoutMs}ms while a completion was still generating`,
            swarmState: toolContext.swarmState,
            toolNames,
            toolCount,
            iterations,
            artifacts,
            evidenceSnippets: resolveInterruptedEvidenceSnippets({ recentEvidenceSnippets, history }),
            primaryDelegationBody: currentPrimaryDelegationBody(),
            mutatedFileLines: currentMutatedFileLines(),
          });
          const stats = buildStats("timeout", interruptedOutcome);
          logSubAgentCompletionAudit(
            stats,
            output,
            {
              timeoutMs: turnTimeoutMs,
              abortedInFlightCompletion: true,
              // The branch keys off "the deadline had fired", not off the identity of
              // the caught error — a provider failure that happened to land in the same
              // window is wound down here too. Record what actually threw so the audit
              // is never blind about which of the two it was.
              providerError: err instanceof Error ? err.message : String(err),
            },
            "warn",
          );
          return withArtifacts({ output, stats });
        }
        // A stalled/timed-out FINAL call after the deliverable already exists is
        // not a failed run — return the finished build instead of branding it
        // timeout/partial (audit 2445da2e).
        if (looksLikeTimeoutLikeError(err)) {
          const deterministicAfterStall = tryDeterministicArtifactCompletion("final_call_timeout");
          if (deterministicAfterStall) return deterministicAfterStall;
        }
        const interruptedOutcome = classifyInterruptedOutcome({
          successfulToolCount,
          artifacts,
          swarmState: toolContext.swarmState,
        });
        if (looksLikeTimeoutLikeError(err) && interruptedOutcome === "partial") {
          log.warn({ err, agentName: opts.agentName }, "Sub-agent LLM call timed out after substantive work — returning partial recovered evidence");
          recordOutcome({
            ts: new Date().toISOString(),
            agent: opts.agentName,
            task: opts.task.slice(0, 200),
            outcome: interruptedOutcome,
            iterations,
            totalTokens: usage.totalTokens,
            durationMs: Date.now() - runStartedAt,
            timeoutMs: turnTimeoutMs,
            error: String(err).slice(0, 200),
          });
          const output = buildInterruptedSubAgentOutput({
            agentName: opts.agentName,
            reason: "timed out while finalizing the answer after substantive work",
            swarmState: toolContext.swarmState,
            toolNames,
            toolCount,
            iterations,
            artifacts,
            evidenceSnippets: resolveInterruptedEvidenceSnippets({ recentEvidenceSnippets, history }),
            primaryDelegationBody: currentPrimaryDelegationBody(),
            mutatedFileLines: currentMutatedFileLines(),
          });
          const stats = buildStats("timeout", interruptedOutcome);
          logSubAgentCompletionAudit(stats, output, {
            timeoutDuringFinalSynthesis: true,
            error: String(err).slice(0, 200),
          }, "warn");
          return withArtifacts({ output, stats });
        }
        log.error({ err, agentName: opts.agentName }, "Sub-agent LLM call failed");
        recordOutcome({
          ts: new Date().toISOString(),
          agent: opts.agentName,
          task: opts.task.slice(0, 200),
          outcome: "failure",
          iterations,
          totalTokens: usage.totalTokens,
          durationMs: Date.now() - runStartedAt,
          timeoutMs: turnTimeoutMs,
          error: String(err).slice(0, 200),
        });
        const output = `Sub-agent error: ${String(err)}`;
        const stats = buildStats("error");
        logSubAgentCompletionAudit(stats, output, { error: String(err).slice(0, 200) }, "warn");
        return withArtifacts({ output, stats });
      }

      usage.promptTokens += response.usage.promptTokens;
      usage.completionTokens += response.usage.completionTokens;
      usage.totalTokens += response.usage.totalTokens;

      // Surface the model's chain-of-thought for this iteration to the UI
      // (behind a debug toggle) and the audit log. This is exactly where the
      // qwen "burned 4096-6144 thinking tokens and stalled" pathology shows
      // up — making it visible is the whole point of capturing reasoning.
      // Feed the supervisor's shape counters. Both were already being measured here and
      // at three sibling sites, and consumed nowhere.
      const responseText = typeof response.content === "string" ? response.content : "";
      outputCharsTotal += responseText.length;
      // LOST TRACK: an assistant turn byte-identical to one an earlier iteration already
      // produced means the run is re-emitting, not advancing — the shape a loop takes when
      // it happens above the tool layer, where the per-tool guards cannot see it. The
      // substantive-output floor keeps short acknowledgements ("Done.", "OK") from tripping
      // it; the healthy reference run's 13 iterations were all distinct.
      if (!lrgOperatorStop && responseText.trim().length >= MIN_SUBSTANTIVE_OUTPUT_CHARS) {
        const outputSig = createHash("sha1").update(responseText.trim()).digest("hex").slice(0, 16);
        if (assistantOutputSigs.has(outputSig)) {
          windDownForSupervisor();
          logAudit("progress_verifier_intervened", {
            agentName: opts.agentName,
            runSessionId: subSessionId,
            trigger: "iteration",
            verdict: "looping",
            reason: "assistant output is identical to an earlier iteration — the run is re-emitting, not advancing",
            elapsedMs: Date.now() - runStartedAt,
            iterations,
          }, { sessionId: opts.parentSessionId, severity: "warn" });
        } else {
          assistantOutputSigs.add(outputSig);
        }
      }
      if (response.reasoning && response.reasoning.trim()) {
        const reasoningText = response.reasoning.trim();
        reasoningCharsTotal += reasoningText.length;
        logAudit(
          "sub_agent_reasoning",
          {
            agentName: opts.agentName,
            iteration: iterations + 1,
            reasoningChars: reasoningText.length,
            // Preserve observability without persisting provider reasoning.
            reasoningCaptured: true,
          },
          { sessionId: subSessionId, severity: "info" },
        );
      }

      if (turnTimeoutReached && turnTimeoutMs && response.tool_calls.length > 0) {
        const synthesized = await attemptTimeoutSynthesis();
        if (synthesized) {
          return synthesized;
        }
        const interruptedOutcome = classifyInterruptedOutcome({
          successfulToolCount,
          artifacts,
          swarmState: toolContext.swarmState,
        });
        recordOutcome({
          ts: new Date().toISOString(),
          agent: opts.agentName,
          task: opts.task.slice(0, 200),
          outcome: interruptedOutcome,
          iterations,
          totalTokens: usage.totalTokens,
          durationMs: Date.now() - runStartedAt,
          timeoutMs: turnTimeoutMs,
          error: `timeout (${turnTimeoutMs}ms) reached before starting another tool run`,
        });
        const output = buildInterruptedSubAgentOutput({
          agentName: opts.agentName,
          reason: `timed out after ${turnTimeoutMs}ms before starting another tool run`,
          swarmState: toolContext.swarmState,
          toolNames,
          toolCount,
          iterations,
          artifacts,
          evidenceSnippets: resolveInterruptedEvidenceSnippets({ recentEvidenceSnippets, history }),
          primaryDelegationBody: currentPrimaryDelegationBody(),
          mutatedFileLines: currentMutatedFileLines(),
        });
        const stats = buildStats("timeout", interruptedOutcome);
        logSubAgentCompletionAudit(stats, output, { timeoutMs: turnTimeoutMs, stopAfterCurrentOperation: true, operatorStopped: lrgOperatorStop }, lrgOperatorStop ? "info" : "warn");
        return withArtifacts({ output, stats });
      }

      // No tool calls — final answer
      if (response.tool_calls.length === 0) {
        let result = normalizeSubAgentOutput(response.content);

        // Recovery: if the agent used tools (gathered real content) but returned
        // an empty final response, force one synthesis pass so the fetched data
        // isn't lost.  This catches a common Qwen pattern where the model emits
        // tool calls on every iteration then returns content: "" on the last.
        const emptyAfterWork = result === "Sub-agent produced no final response." && toolCount > 0;
        if (emptyAfterWork && !signal?.aborted) {
          log.warn(
            { agentName: opts.agentName, iterations, toolCalls: toolCount },
            "Sub-agent returned empty response after tool use — forcing synthesis pass",
          );
          try {
            const rescueMessages: LLMMessage[] = [
              {
                role: "system",
                content: systemPrompt +
                  "\n\nYou returned an empty response but you have already gathered content from previous tool calls. " +
                  "DO NOT call any more tools. " +
                  "Produce your COMPLETE final answer now. Include ALL content you retrieved — URLs, facts, and extracts. " +
                  "Your response is the ONLY output the coordinator will receive from you.",
              },
              ...history,
            ];
            const rescueResponse = await provider.complete(rescueMessages, [], signal);
            usage.promptTokens += rescueResponse.usage.promptTokens;
            usage.completionTokens += rescueResponse.usage.completionTokens;
            usage.totalTokens += rescueResponse.usage.totalTokens;
            if (rescueResponse.tool_calls.length === 0) {
              const rescued = normalizeSubAgentOutput(rescueResponse.content);
              if (rescued !== "Sub-agent produced no final response.") {
                result = rescued;
                log.info(
                  { agentName: opts.agentName, rescuedLength: result.length },
                  "Empty-response synthesis rescue succeeded",
                );
              }
            }
          } catch (rescueErr) {
            log.warn({ rescueErr, agentName: opts.agentName }, "Empty-response synthesis rescue failed");
          }
        }

        result = await rescueSanitizedEmptyResult(result);
        const recovered = recoverNoResponseAfterSubstantiveWork(result);
        result = recovered.result;
        result = maybePreferWorkflowOutput(result, workflowPassthroughOutput, toolNames);
        const truncationRecovered = recoverHallucinatedTruncationAfterSubstantiveWork(result);
        result = truncationRecovered.result;

        // Scan for secrets before returning to parent session
        const outputScan = scanOutput(result);
        if (!outputScan.safe && outputScan.redacted) {
          logAudit(
            "output_redacted",
            { agentName: opts.agentName, types: outputScan.detectedTypes },
            { sessionId: subSessionId, severity: "warn" }
          );
          result = outputScan.redacted;
        }

        const semanticOutcome: SubAgentOutcome = recovered.forcedOutcome
          ?? truncationRecovered.forcedOutcome
          ?? (/no results|not found|unable to|failed to|error:/i.test(result.slice(0, 300))
            ? "partial"
            : "success");
        const stats = buildStats("completed", semanticOutcome);
        const suspicious = rejectSuspiciousNoToolOutput(
          opts,
          stats,
          result,
          turnTimeoutMs,
          runStartedAt,
        );
        if (suspicious) {
          return suspicious;
        }

        history.push({ role: "assistant", content: result });

        logSubAgentCompletionAudit(
          stats,
          result,
          adaptiveTimeout ? {
            adaptiveTimeoutMs: adaptiveTimeout.timeoutMs,
            adaptiveTimeoutBaselineMs: adaptiveTimeout.baselineMs,
            adaptiveTimeoutSamples: adaptiveTimeout.sampleSize,
          } : {},
          semanticOutcome === "success" ? "info" : "warn",
        );

        // Detect likely failure patterns from the output text
        recordOutcome({
          ts: new Date().toISOString(),
          agent: opts.agentName,
          task: opts.task.slice(0, 200),
          outcome: semanticOutcome,
          iterations,
          totalTokens: usage.totalTokens,
          durationMs: Date.now() - runStartedAt,
          timeoutMs: turnTimeoutMs,
        });

        log.info({ agentName: opts.agentName, iterations }, "Sub-agent completed");
        opts.onProgress?.({
          agentName: opts.agentName,
          kind: "completed",
          iteration: iterations,
          summary: `Completed delegated work in ${opts.agentName}.`,
        });
        return withArtifacts({ output: result, stats });
      }

      // Process tool calls — repair any mangled tool names first
      for (const tc of response.tool_calls) normalizeToolCall(tc);
      // Force-real-research (orchestration.subAgentPreEvidenceResearchForce, default off): the
      // de-lex hardwired the old sourceSensitiveTask gate off, so an evidence-starved research
      // sub-agent could answer from training memory. Re-arm on the STRUCTURAL evidence-starvation
      // signals already here + a CAPABILITY check (the sub-agent actually holds web/research tools),
      // so a write-only renderer is never forced to research and no keyword classification is used.
      const subAgentHasResearchTools = (effectiveToolNames ?? []).some(
        (n) => n === "web_search" || n === "web_fetch" || n === "url_inspect" || n.startsWith("browser_"),
      );
      if (
        getConfig().orchestration?.subAgentPreEvidenceResearchForce === true
        && subAgentHasResearchTools
        && cumulativeUsefulEvidenceBytes < 120
        && substantiveEvidenceCount === 0
        && !shareFindinCalledThisRun
      ) {
        for (const tc of response.tool_calls) {
          enforceSourceSensitivePreEvidenceDelegation(tc, sanitizedTask, subSessionId, opts.agentName);
        }
      }
      if (requiredResearchFallbackRoute) {
        for (const tc of response.tool_calls) {
          enforceSubAgentRequiredResearchFallbackRouteOnToolCall(tc, requiredResearchFallbackRoute, subSessionId, opts.agentName);
        }
      }

      if (response.tool_calls.length > 0 && response.content?.trim()) {
        logAudit(
          "sub_agent_assistant_text_with_tool_calls_suppressed",
          {
            agentName: opts.agentName,
            contentChars: response.content.length,
            toolNames: response.tool_calls.map((toolCall) => toolCall.name),
            finishReason: response.finishReason,
          },
          { sessionId: subSessionId, severity: "warn" },
        );
        response = { ...response, content: null };
      }

      const assistantToolCalls = response.tool_calls.map(tc => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      }));

      history.push({
        role: "assistant",
        content: response.content,
        tool_calls: assistantToolCalls,
      });

      const toolResults: LLMMessage[] = [];
      let decisiveDirectRemoteToolResult: import("../tools/registry.js").ToolResult | null = null;
      let decisiveDirectRemoteToolName: string | null = null;
      let executedToolThisIteration = false;
      // Structural delegation-dead-end detection: a COORDINATOR sub-agent whose every
      // delegation this iteration FAILED (e.g. coordinator_recursion_blocked — every
      // candidate is itself a coordinator, so no leaf ran) re-fires varying tasks and
      // churns to the iteration cap. The main-orchestrator warden break (a5e3208) does not
      // reach here, and NO_PROGRESS_DELEGATION_FAILURE_RE only matches the per-agent-cap
      // text, not the recursion-block dead-end. Count these via the result METADATA
      // (delegationSucceeded === false), not an error-string regex, and feed the existing
      // consecutiveBlockedToolIterations break.
      let delegationCallsThisIteration = 0;
      let failedDelegationCallsThisIteration = 0;
      // Tool calls whose truncated write_file args were salvaged this iteration —
      // their success result gets the continue-with-append coaching appended.
      const salvagedTruncatedWriteTails = new Map<string, string>();

      // Delegation depth ceiling: a sub-agent at/over the configured nesting
      // depth must not delegate further — it gathers evidence with its own
      // tools and synthesizes. Bounds the tree so a complex task can't cascade
      // into a runaway fan-out. Computed once per iteration (depth is constant
      // for this run). The orchestrator (depth 0) runs in runtime.ts and is
      // unaffected; this only caps nesting below it.
      const currentDelegationDepth = delegationDepthFromSessionId(subSessionId);
      const maxDelegationDepth = effectiveOrchestration().maxDelegationDepth ?? 3;
      const delegationDepthExceeded = currentDelegationDepth >= maxDelegationDepth;

      for (const [toolCallIndex, tc] of response.tool_calls.entries()) {
        if (signal?.aborted) break;
        if (requiredResearchFallbackRoute && enforceSubAgentRequiredResearchFallbackRouteOnToolCall(tc, requiredResearchFallbackRoute, subSessionId, opts.agentName)) {
          const assistantToolCall = assistantToolCalls[toolCallIndex];
          if (assistantToolCall) {
            assistantToolCall.function.name = tc.name;
            assistantToolCall.function.arguments = JSON.stringify(tc.arguments);
          }
        }
        toolCount++;

        if (tc.arguments && "_parse_error" in tc.arguments) {
          const rawArgs = String((tc.arguments as Record<string, unknown>)["_raw"] ?? "");
          // Truncated-giant-write salvage (audit 77944865): the model emitted a whole
          // large file as ONE write_file argument and the output limit cut it off.
          // Prompt-level chunking instructions failed twice on the slow local model,
          // so recover mechanically: write the salvaged first part and coach the model
          // to continue with mode:"append" — the truncation becomes forward progress
          // instead of "path is required" + zero bytes.
          // `_parse_error` means the arguments did not PARSE, not that they were
          // TRUNCATED, so the guard has to answer "was this CUT OFF?":
          //   - finishReason "length" / truncatedBy — the provider says so outright.
          //     (Every path that sets truncatedBy today also sets "length"; it is kept
          //     as the direct, self-describing signal rather than an inference.)
          //   - the size heuristic, restored but no longer BARE. With no output ceiling
          //     multi-KB write_file calls are normal, so "large" on its own would fire
          //     on essentially every big write and coach an append onto a complete file.
          //     Requiring the raw JSON to also be visibly UNTERMINATED (a cut stream
          //     stops mid-string; a complete-but-invalid object still closes its brace)
          //     keeps the case the provider flags miss entirely — a truncation that
          //     arrives with finishReason "stop", i.e. the non-streaming complete()
          //     path and Anthropic, which never sets truncatedBy — without the false
          //     positives that motivated dropping it.
          const rawArgsLookCutOff = rawArgs.length > 4_000 && !/\}$/.test(rawArgs.trimEnd());
          const looksTruncatedByOutputLimit =
            response.finishReason === "length"
            || response.truncatedBy !== undefined
            || rawArgsLookCutOff;
          const salvaged = tc.name === "write_file" && looksTruncatedByOutputLimit
            ? salvageTruncatedWriteFileArgs(rawArgs)
            : null;
          if (salvaged) {
            tc.arguments = { path: salvaged.path, ...(salvaged.mode ? { mode: salvaged.mode } : {}), content: salvaged.content };
            salvagedTruncatedWriteTails.set(tc.id, salvaged.content.slice(-120));
            logAudit("sub_agent_tool_call", {
              agentName: opts.agentName,
              tool: tc.name,
              phase: "recovered",
              reason: "truncated_write_args_salvaged",
              toolCallId: tc.id,
              salvagedChars: salvaged.content.length,
              path: salvaged.path,
            }, { sessionId: subSessionId, severity: "warn" });
            // Fall through to normal execution with the salvaged arguments.
          } else {
            const truncatedWriteCoaching = tc.name === "write_file" && looksTruncatedByOutputLimit
              ? " Your write_file arguments were CUT OFF by the output limit — the call was too large to finish, and nothing was written. Do NOT retry the whole file in one call. Re-issue write_file with a SMALL first chunk — {\"path\": \"...\", \"mode\": \"create\", \"content\": <first small part>} with \"path\" as the FIRST property — then continue with {\"mode\": \"append\"} chunks until the file is complete."
              : " Do not retry this call with a large inline payload; answer from existing evidence or use a smaller valid tool call.";
            emitSubAgentToolAudit({
              agentName: opts.agentName,
              tool: tc.name,
              phase: "done",
              args: { _raw: rawArgs.slice(0, 200) },
              toolCallId: tc.id,
              errorText: `Malformed JSON arguments produced for tool '${tc.name}'.${truncatedWriteCoaching}`,
              skippedReason: "invalid_arguments",
            });
            toolResults.push({
              role: "tool",
              content: `Error: Could not parse arguments for tool '${tc.name}'.${truncatedWriteCoaching}`,
              tool_call_id: tc.id,
            });
            continue;
          }
        }

        const priorApprovalFailure = approvalBlockedTools.get(tc.name);
        if (priorApprovalFailure) {
          const blockedMessage = buildApprovalRetryBlockedMessage(tc.name, priorApprovalFailure);
          emitSubAgentToolAudit({
            agentName: opts.agentName,
            tool: tc.name,
            phase: "done",
            args: tc.arguments,
            toolCallId: tc.id,
            errorText: blockedMessage,
            skippedReason: "approval_gate_unresolved",
          });
          logAudit(
            "sub_agent_tool_blocked",
            { agentName: opts.agentName, tool: tc.name, reason: "approval_gate_unresolved" },
            { sessionId: subSessionId, severity: "warn" },
          );
          toolResults.push({
            role: "tool",
            content: blockedMessage,
            tool_call_id: tc.id,
          });
          continue;
        }

        // Backend-unreachable family breaker (see infraFailureStreaks above).
        const tcFamily = liveToolFamily(tc.name);
        const blockedFamilySig = tcFamily ? infraBlockedFamilies.get(tcFamily) : undefined;
        if (tcFamily && blockedFamilySig) {
          const blockedMessage = buildInfraFamilyBlockedMessage(tcFamily, blockedFamilySig);
          emitSubAgentToolAudit({
            agentName: opts.agentName,
            tool: tc.name,
            phase: "done",
            args: tc.arguments,
            toolCallId: tc.id,
            errorText: blockedMessage,
            skippedReason: "backend_unreachable",
          });
          logAudit(
            "sub_agent_tool_blocked",
            { agentName: opts.agentName, tool: tc.name, reason: "backend_unreachable", signature: blockedFamilySig },
            { sessionId: subSessionId, severity: "warn" },
          );
          toolResults.push({
            role: "tool",
            content: blockedMessage,
            tool_call_id: tc.id,
          });
          continue;
        }

        // Delegation depth ceiling — block further nesting at/over the limit.
        if (delegationDepthExceeded && isDelegationToolName(tc.name)) {
          const nudge = `You are already ${currentDelegationDepth} delegation levels deep (limit ${maxDelegationDepth}). `
            + `Do NOT delegate again with '${tc.name}'. Gather what you need with your own tools `
            + `(e.g. web_search, web_fetch, read_file) and write your answer now. If a step is genuinely `
            + `blocked, report what you have and what's missing instead of delegating.`;
          emitSubAgentToolAudit({
            agentName: opts.agentName,
            tool: tc.name,
            phase: "done",
            args: tc.arguments,
            toolCallId: tc.id,
            errorText: nudge,
            skippedReason: "delegation_depth_ceiling",
          });
          logAudit(
            "delegation_depth_ceiling_enforced",
            { agentName: opts.agentName, tool: tc.name, depth: currentDelegationDepth, maxDepth: maxDelegationDepth },
            { sessionId: subSessionId, severity: "warn" },
          );
          toolResults.push({ role: "tool", content: nudge, tool_call_id: tc.id });
          continue;
        }

        // Enforce tool allow-list
        if (effectiveToolNames && !effectiveToolNames.includes(tc.name)) {
          log.warn({ agentName: opts.agentName, tool: tc.name }, "Sub-agent attempted disallowed tool");
          // Distinguish between tools stripped by the evidence-cap mechanism
          // (normal synthesis enforcement, not a security event) and tools
          // genuinely absent from the agent's configured tool set.
          const blockReason = evidenceCapStrippedTools.has(tc.name)
            ? "evidence_cap_enforced"
            : "not_in_agent_tools";
          logAudit(
            "sub_agent_tool_blocked",
            { agentName: opts.agentName, tool: tc.name, reason: blockReason },
            { sessionId: subSessionId, severity: "warn" }
          );
          toolResults.push({
            role: "tool",
            content: evidenceCapStrippedTools.has(tc.name)
              ? `Tool '${tc.name}' has been disabled — you have gathered enough evidence. Write your final answer now.`
              : `Tool '${tc.name}' is not in this agent's allowed tool set.`,
            tool_call_id: tc.id,
          });
          continue;
        }

        if (!isToolAllowed(tc.name)) {
          toolResults.push({
            role: "tool",
            content: `Tool '${tc.name}' is blocked by security policy.`,
            tool_call_id: tc.id,
          });
          continue;
        }

        emitSubAgentToolAudit({
          agentName: opts.agentName,
          tool: tc.name,
          phase: "start",
          args: tc.arguments,
          toolCallId: tc.id,
        });

        opts.onProgress?.({
          agentName: opts.agentName,
          kind: "tool_start",
          iteration: iterations + 1,
          toolName: tc.name,
          toolCallId: tc.id,
          args: tc.arguments,
          summary: `Running ${tc.name} in ${opts.agentName}.`,
        });

        toolNames.push(tc.name);

        // Per-tool call cap — prevent wasteful loops on a single tool.
        // For path-keyed write tools, the primary cap is per-(tool, path):
        // writing 4 distinct files only counts once against each path. The
        // total per-tool cap is still enforced as a backstop against
        // runaway-with-different-paths.
        const priorCount = perToolCallCount.get(tc.name) ?? 0;
        const toolCap = resolveSubAgentToolCap(tc.name, isCoordinatorAgent);
        const writePath = PATH_KEYED_WRITE_TOOLS.has(tc.name)
          ? (() => {
            const raw = tc.arguments?.["path"] ?? tc.arguments?.["output_file"] ?? tc.arguments?.["filename"];
            return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
          })()
          : null;
        if (writePath !== null) {
          // Appending to one file is HOW a large artifact is built incrementally
          // (write head → append chunks), so repeated write_file(mode:"append") to
          // the same path is expected, not a loop. Give it a much higher per-path
          // ceiling; plain overwrites keep the tight loop-guard cap.
          const isAppendWrite = tc.name === "write_file"
            && typeof tc.arguments?.["mode"] === "string"
            && String(tc.arguments["mode"]).toLowerCase() === "append";
          const pathCap = isAppendWrite ? PER_PATH_APPEND_CAP : PER_PATH_EDIT_CAP;
          const pathKey = `${tc.name}:${writePath}`;
          const pathCount = perWritePathCount.get(pathKey) ?? 0;
          // Content-shape loop detection, ahead of the count cap. Cheap (one sha1 of the
          // payload), language-independent, and it sees the two things a COUNT cannot: a
          // byte-identical rewrite the model keeps re-issuing, and an A→B→A→B flip-flop.
          // A genuine convergence — three edits with three different bodies, which is what
          // the healthy reference run did while fixing its own off-by-one — passes both.
          // Also feeds the supervisor's distinctWriteHashes signal as a side effect.
          const writePayload = String(
            tc.arguments?.["content"] ?? tc.arguments?.["new_string"] ?? tc.arguments?.["text"] ?? "",
          );
          if (writePayload.length > 0) {
            const contentHash = createHash("sha1").update(writePayload).digest("hex").slice(0, 16);
            const hashes = writeHistory.get(pathKey) ?? [];
            const loopKind = classifyWriteLoop(hashes, contentHash);
            if (loopKind) {
              const loopMsg = `Tool '${tc.name}' is looping on '${writePath}': this exact content has already `
                + `been written this run (${loopKind}). The file on disk already has it — move on or finalize.`;
              log.warn(
                { agentName: opts.agentName, tool: tc.name, path: writePath, reason: loopKind },
                "Sub-agent write loop detected (content hash)",
              );
              logAudit("sub_agent_tool_loop_detected", {
                agentName: opts.agentName, tool: tc.name, path: writePath, reason: loopKind,
              }, { sessionId: subSessionId, severity: "warn" });
              emitSubAgentToolAudit({
                agentName: opts.agentName,
                tool: tc.name,
                phase: "done",
                args: tc.arguments,
                toolCallId: tc.id,
                errorText: loopMsg,
                skippedReason: "write_content_loop",
              });
              toolResults.push({ role: "tool", content: loopMsg, tool_call_id: tc.id });
              continue;
            }
            // Bounded: only the tail matters to either rule, and a run must not grow an
            // unbounded history for a file it is appending to 24 times.
            writeHistory.set(pathKey, [...hashes, contentHash].slice(-32));
          }
          if (pathCount >= pathCap) {
            log.warn(
              { agentName: opts.agentName, tool: tc.name, path: writePath, count: pathCount, cap: pathCap, append: isAppendWrite },
              "Sub-agent exceeded per-path write cap (same path written too many times)",
            );
            emitSubAgentToolAudit({
              agentName: opts.agentName,
              tool: tc.name,
              phase: "done",
              args: tc.arguments,
              toolCallId: tc.id,
              errorText: `Tool '${tc.name}' has already written '${writePath}' ${pathCount} times this run (limit: ${pathCap} per path). Move on to a different path or finalize.`,
              skippedReason: "per_path_write_cap",
            });
            toolResults.push({
              role: "tool",
              content: `Tool '${tc.name}' has already written '${writePath}' ${pathCount} times this run (limit: ${pathCap} per path). Move on to a different path or finalize.`,
              tool_call_id: tc.id,
            });
            continue;
          }
          perWritePathCount.set(pathKey, pathCount + 1);
        }
        if (toolCap !== undefined && priorCount >= toolCap) {
          log.warn(
            { agentName: opts.agentName, tool: tc.name, count: priorCount, cap: toolCap },
            "Sub-agent exceeded per-tool call cap",
          );
          emitSubAgentToolAudit({
            agentName: opts.agentName,
            tool: tc.name,
            phase: "done",
            args: tc.arguments,
            toolCallId: tc.id,
            errorText: `Tool '${tc.name}' has been called ${priorCount} times this run (limit: ${toolCap}). You must proceed without calling it again. Work with the results you already have.`,
            skippedReason: "per_tool_cap",
          });
          toolResults.push({
            role: "tool",
            content: `Tool '${tc.name}' has been called ${priorCount} times this run (limit: ${toolCap}). You must proceed without calling it again. Work with the results you already have.`,
            tool_call_id: tc.id,
          });
          continue;
        }
        const priorFailures = perToolFailureCount.get(tc.name) ?? 0;
        if (priorFailures >= PER_TOOL_FAILURE_CAP) {
          log.warn(
            { agentName: opts.agentName, tool: tc.name, failures: priorFailures, cap: PER_TOOL_FAILURE_CAP },
            "Sub-agent exceeded per-tool failure cap (arguments kept being rejected)",
          );
          emitSubAgentToolAudit({
            agentName: opts.agentName,
            tool: tc.name,
            phase: "done",
            args: tc.arguments,
            toolCallId: tc.id,
            errorText: `Tool '${tc.name}' failed ${priorFailures} times this run — its arguments keep being rejected. Stop calling it; work with the results you already have or report the blocker.`,
            skippedReason: "per_tool_failure_cap",
          });
          toolResults.push({
            role: "tool",
            content: `Tool '${tc.name}' failed ${priorFailures} times this run — its arguments keep being rejected. Stop calling it; work with the results you already have or report the blocker.`,
            tool_call_id: tc.id,
          });
          continue;
        }
        if (
          ARTIFACT_PERSIST_TOOLS.has(tc.name)
          && failedArtifactPersistTools.size >= ARTIFACT_PERSIST_DISTINCT_TOOLS_TRIP
          && artifactPersistFailureCount >= ARTIFACT_PERSIST_TOTAL_FAILURES_TRIP
        ) {
          const blockMsg = `Artifact persistence has failed ${artifactPersistFailureCount} times across ${failedArtifactPersistTools.size} different file tools this run (the file was NOT created). Do NOT try to write or generate a file again — deliver the full content directly in your final text answer instead.`;
          log.warn(
            { agentName: opts.agentName, tool: tc.name, artifactFailures: artifactPersistFailureCount, distinctTools: failedArtifactPersistTools.size },
            "Sub-agent thrashed across the artifact-persistence family — blocking further artifact writes",
          );
          emitSubAgentToolAudit({
            agentName: opts.agentName,
            tool: tc.name,
            phase: "done",
            args: tc.arguments,
            toolCallId: tc.id,
            errorText: blockMsg,
            skippedReason: "artifact_persist_failure_cap",
          });
          toolResults.push({ role: "tool", content: blockMsg, tool_call_id: tc.id });
          continue;
        }
        perToolCallCount.set(tc.name, priorCount + 1);

        // ABA-duplicate detection (idempotent tools only): if the same tool
        // was previously called with these exact args at *any* point this run,
        // return the cached result. Catches loops like read_file(a) →
        // read_file(b) → read_file(a) that the consecutive map below misses
        // because slot A was overwritten by B. Restricted to read-only /
        // pure-query tools so we never short-circuit a deliberate re-poll of
        // mutating state (browser session, swarm state, mail send, etc).
        const argsSig = JSON.stringify(tc.arguments);
        const idemKey = `${tc.name}::${argsSig}`;
        // DETECT for every tool; RETURN a cached result only for idempotent ones. The
        // restriction below is right as a CACHING rule — never short-circuit a deliberate
        // re-poll of mutating state — and wrong as a DETECTION rule, which is why a
        // non-idempotent call repeating verbatim was visible to nothing at all. Counting
        // costs one map write.
        const argSigRepeatCount = (argSigRepeats.get(idemKey) ?? 0) + 1;
        argSigRepeats.set(idemKey, argSigRepeatCount);
        if (argSigRepeatCount >= ARG_SIG_REPEAT_LIMIT && !IDEMPOTENT_TOOLS.has(tc.name)) {
          logAudit("sub_agent_tool_loop_detected", {
            agentName: opts.agentName,
            tool: tc.name,
            reason: "identical_args_repeat",
            repeats: argSigRepeatCount,
          }, { sessionId: subSessionId, severity: "warn" });
        }
        if (IDEMPOTENT_TOOLS.has(tc.name)) {
          const cached = idempotentCallCache.get(idemKey);
          if (cached) {
            cached.callCount += 1;
            log.warn(
              { agentName: opts.agentName, tool: tc.name, repeatCount: cached.callCount },
              "Sub-agent re-issued idempotent tool call (ABA dedup) — returning cached result",
            );
            const cachedNote = cached.success
              ? "[Note: This is a cached result — you already called this idempotent tool with identical arguments earlier this run. The output has not changed; move on.]"
              : "[Note: This is a cached failed result from earlier this run — the call did not succeed and re-trying with the same arguments will not help. Work from the partial result you have or report the blocker.]";
            emitSubAgentToolAudit({
              agentName: opts.agentName,
              tool: tc.name,
              phase: "done",
              args: tc.arguments,
              toolCallId: tc.id,
              resultPreview: cached.result,
              successOverride: cached.success,
              cachedResult: true,
            });
            toolResults.push({
              role: "tool",
              content: `${cached.result}\n\n${cachedNote}`,
              tool_call_id: tc.id,
            });
            // A cached *successful* result is a returned result, not a block.
            // Session 39af10b8 (2026-05-29): content_writer re-called
            // read_shared_facts 3× (1 real + 2 cached "no facts"), the cached
            // repeats counted as blocked iterations, the loop detector
            // stripped ALL tools at iteration 2, and the agent was killed
            // before it ever reached write_file. Treat a cached-success
            // return as progress so over-eager context re-checks don't trip
            // the nuclear tool-strip. A cached *failure* stays "blocked" — an
            // agent re-calling a genuinely failing tool IS stuck.
            if (cached.success) executedToolThisIteration = true;
            continue;
          }
        }

        // Consecutive-duplicate detection: if same tool + same args as the
        // immediately prior call, return the cached result with a warning
        // instead of wasting an iteration on a redundant network round-trip.
        const prev = lastToolCallSig.get(tc.name);
        if (prev && prev.args === argsSig && !isLiveStateTool(tc.name)) {
          log.warn(
            { agentName: opts.agentName, tool: tc.name },
            "Sub-agent repeated identical tool call — returning cached result",
          );
          const cachedNote = prev.success
            ? "[Note: This is a cached result — you already called this tool with identical arguments. Move on to the next step.]"
            : "[Note: This is a cached failed result — you already called this tool with identical arguments and it did not succeed. Do NOT call it again. Work from this partial result or report the blocker explicitly.]";
          emitSubAgentToolAudit({
            agentName: opts.agentName,
            tool: tc.name,
            phase: "done",
            args: tc.arguments,
            toolCallId: tc.id,
            resultPreview: prev.result,
            successOverride: prev.success,
            cachedResult: true,
          });
          toolResults.push({
            role: "tool",
            content: `${prev.result}\n\n${cachedNote}`,
            tool_call_id: tc.id,
          });
          // See the ABA-dedup branch above: a cached-success return is
          // progress, not a blocked iteration. Only a cached failure keeps
          // counting toward the all-tools-stripped loop break.
          if (prev.success) executedToolThisIteration = true;
          continue;
        }

        const result = await executeTool(tc.name, tc.arguments, toolContext);
        executedToolThisIteration = true;
        if (isDelegationToolName(tc.name)) {
          delegationCallsThisIteration += 1;
          // Structural failure signal (no error-string match): the delegate tool reports
          // delegationSucceeded:false on a recursion-block / coordinator dead-end / all-
          // candidates-failed outcome; a bare !success covers a hard tool error too.
          if (result.metadata?.["delegationSucceeded"] === false || !result.success) {
            failedDelegationCallsThisIteration += 1;
          }
        }
        if (!result.success) {
          // A failed call did no real work — most often the model can fix it by
          // re-emitting corrected arguments. Refund the per-tool (and per-path)
          // SUCCESS cap and account for it under the bounded failure budget instead,
          // so a couple of arg rejections can't hard-block a build tool mid-task.
          perToolCallCount.set(tc.name, priorCount);
          if (writePath !== null) {
            const refundKey = `${tc.name}:${writePath}`;
            const pc = perWritePathCount.get(refundKey) ?? 0;
            if (pc > 0) perWritePathCount.set(refundKey, pc - 1);
          }
          perToolFailureCount.set(tc.name, (perToolFailureCount.get(tc.name) ?? 0) + 1);
          if (ARTIFACT_PERSIST_TOOLS.has(tc.name)) {
            failedArtifactPersistTools.add(tc.name);
            artifactPersistFailureCount += 1;
          }
        }
        emitSubAgentToolAudit({
          agentName: opts.agentName,
          tool: tc.name,
          phase: "done",
          args: tc.arguments,
          toolCallId: tc.id,
          result,
        });
        let resultContent = result.success
          ? result.output
          : (result.error?.trim()
              ? `Error: ${result.error}`
              : (result.output.trim() || "Error: unknown"));

        const salvagedWriteTail = salvagedTruncatedWriteTails.get(tc.id);
        if (salvagedWriteTail !== undefined && result.success) {
          resultContent += "\n\n[PARTIAL WRITE — OUTPUT LIMIT] Your write_file arguments were cut off by the output limit; only the salvaged first part was written. "
            + "CONTINUE the file NOW: call write_file again with the SAME path and mode:\"append\", adding the next chunk — keep every chunk SMALL (well under your output limit) and repeat until the file is complete. "
            + `The file currently ends with: «${salvagedWriteTail}»`;
        }

        if (!result.success && isApprovalGateFailure(result.error ?? resultContent)) {
          const approvalFailure = result.error?.trim() || resultContent.replace(/^Error:\s*/i, "").trim();
          approvalBlockedTools.set(tc.name, approvalFailure);
          tools = tools.filter((tool) => tool.name !== tc.name);
          resultContent += "\n\n[APPROVAL BLOCKED] Human approval was not granted for this sensitive action. Do not request the same approval-gated tool again in this run; report the blocker and ask the user to retry when they can approve it.";
          logAudit(
            "sub_agent_tool_blocked",
            { agentName: opts.agentName, tool: tc.name, reason: "approval_gate_unresolved" },
            { sessionId: subSessionId, severity: "warn" },
          );
        }

        // Backend-unreachable streak accounting for live-state families. A success
        // clears the family's streak; a same-signature infra failure increments it,
        // and at the threshold the family is blocked for the rest of the run.
        {
          const family = liveToolFamily(tc.name);
          if (family && !infraBlockedFamilies.has(family)) {
            if (result.success) {
              infraFailureStreaks.delete(family);
            } else {
              const signature = extractInfraFailureSignature(result.error ?? resultContent);
              if (signature) {
                const streak = updateInfraFailureStreak(infraFailureStreaks.get(family), signature);
                infraFailureStreaks.set(family, streak);
                if (streak.count >= INFRA_FAILURE_BLOCK_THRESHOLD) {
                  infraBlockedFamilies.set(family, signature);
                  resultContent += `\n\n[BACKEND UNREACHABLE] ${buildInfraFamilyBlockedMessage(family, signature)}`;
                  logAudit(
                    "sub_agent_tool_blocked",
                    { agentName: opts.agentName, tool: tc.name, reason: "backend_unreachable", signature },
                    { sessionId: subSessionId, severity: "warn" },
                  );
                }
              }
            }
          }
        }

        // Redact any secrets leaked into the tool output before the sub-agent sees it.
        const toolOutputScan = scanOutput(resultContent);
        if (!toolOutputScan.safe && toolOutputScan.redacted) {
          resultContent = toolOutputScan.redacted;
          logAudit(
            "output_redacted",
            { surface: "tool_output", agentName: opts.agentName, tool: tc.name, detectedTypes: toolOutputScan.detectedTypes },
            { sessionId: subSessionId, severity: "warn" },
          );
        }

        // Defang framework-mimicking framing markers ([function_results], <tool_result>) in this
        // tool's output before it re-enters the sub-agent's context — the primary indirect prompt-
        // injection vector (researcher/document_intake fetch arbitrary external content). Neutralize
        // (content preserved), NOT block, so legitimate content that merely mentions these tokens is
        // never dropped. The orchestrator's harder checkToolOutput block covers its controlled tools.
        const beforeFraming = resultContent;
        resultContent = neutralizeToolResultFraming(resultContent);
        if (resultContent !== beforeFraming) {
          logAudit(
            "tool_output_framing_neutralized",
            { surface: "tool_output", agentName: opts.agentName, tool: tc.name },
            { sessionId: subSessionId, severity: "warn" },
          );
        }

        // Hard-cap individual tool results to prevent large pages (e.g. Wikipedia) from
        // exhausting the sub-agent's context budget and dropping subsequent tool calls.
        resultContent = truncateToolResult(resultContent, tc.name);

        if (result.success) {
          successfulToolCount += 1;
          // Track substantive evidence for share_finding nudge (Phase A5)
          const SUBSTANTIVE_THRESHOLDS: Record<string, number> = {
            web_search: 1_024,
            web_fetch: 5_120,
            browser_navigate: 5_120,
          };
          const threshold = SUBSTANTIVE_THRESHOLDS[tc.name];
          if (threshold !== undefined && resultContent.length >= threshold) {
            substantiveEvidenceCount += 1;
          }
        }
        if (sourceSensitiveTask && !requiredResearchFallbackRoute && result.success) {
          const discoveryNoMatch = tc.name === "search_agents" && subAgentSearchAgentsReturnedNoMatch(result);
          if (discoveryNoMatch) {
            const trippedAgents = Array.isArray(result.metadata?.["trippedAgents"])
              ? result.metadata?.["trippedAgents"].map(String).filter(Boolean)
              : [];
            requiredResearchFallbackRoute = buildSubAgentRequiredResearchFallbackRoute({
              task: sanitizedTask,
              agentName: opts.agentName,
              allowedAgents: opts.allowedAgents,
              effectiveToolNames,
              excludedAgents: trippedAgents,
            });
          }
        }
        if (tc.name === "share_finding") {
          shareFindinCalledThisRun = true;
          shareFindinCallCount += 1;
        }
        if (tc.name === "run_workflow" && result.success) {
          workflowPassthroughOutput = result.output;
        }
        if (
          response.tool_calls.length === 1
          && tc.name === "ssh_exec"
          && isDirectRemoteCliTask(opts.agentName, sanitizedTask)
        ) {
          decisiveDirectRemoteToolResult = result;
          decisiveDirectRemoteToolName = tc.name;
        }
        lastToolCallSig.set(tc.name, { args: argsSig, result: resultContent, success: result.success });
        if (IDEMPOTENT_TOOLS.has(tc.name)) {
          idempotentCallCache.set(`${tc.name}::${argsSig}`, {
            result: resultContent,
            success: result.success,
            callCount: 1,
          });
        }
        // Track bytes per tool for observability
        bytesByTool.set(tc.name, (bytesByTool.get(tc.name) ?? 0) + resultContent.length);

        // I13: Cascade-timeout detector. Delegation tools wrap one or many
        // child sub-agents; when those children hit their hard timeout, the
        // delegation result content carries one "timed out after Nms" marker
        // per timed-out child. Count them so the post-tool guard below can
        // decide whether the swarm has cascade-failed.
        const isDelegationTool = isDelegationToolName(tc.name);
        if (isDelegationTool) {
          const timeoutMatches = resultContent.match(/timed out after \d+ms/gi);
          if (timeoutMatches) {
            cumulativeTimeoutSignalCount += timeoutMatches.length;
          }
        }

        // I13: Useful-evidence accumulator. Sum non-boilerplate bytes from
        // successful tool results so the post-tool guard can decide whether
        // the agent already has enough material to answer. Strip the
        // timeout-summary boilerplate (the "Sub-agent X timed out" header
        // + "Partial progress before interruption" stanza) so it doesn't
        // count as "evidence" — those bytes are negative signal already
        // counted above.  CRITICAL: stop the strip at "Recovered evidence
        // snippets from completed tools:" so the grandchild's harvested
        // tool outputs (added by sub-agent.ts:buildInterruptedSubAgentOutput)
        // propagate up to the grandparent's recentEvidenceSnippets buffer.
        // Without this, a timed-out delegation cascade discarded all the
        // grandchild's web_search / web_fetch evidence at the parent level.
        if (
          result.success
          && !/^(All candidate agents failed|Tool '[^']+' has been called|Tool '[^']+' is)/i.test(resultContent)
        ) {
          const usefulPortion = resultContent
            // Strip timeout boilerplate. Stop before recovered-snippets header
            // OR before the next parallel_delegate result separator (\n\n---)
            // so that multi-paragraph task descriptions inside partial-progress
            // blocks are fully consumed and not counted as useful evidence.
            .replace(
              /Sub-agent '[^']+' timed out after \d+ms\s+Partial progress before interruption:\s*[\s\S]*?(?=Recovered evidence snippets from completed tools:|\n\n---|$)/g,
              "",
            )
            .replace(
              /Sub-agent '[^']+' produced no final response after substantive work\.\s+Partial progress before interruption:\s*[\s\S]*?(?=Recovered evidence snippets from completed tools:|\n\n---|$)/g,
              "",
            )
            // Same for cancelled-stanza boilerplate.
            .replace(
              /Sub-agent '[^']+' was cancelled\s+Partial progress before interruption:\s*[\s\S]*?(?=Recovered evidence snippets from completed tools:|\n\n---|$)/g,
              "",
            )
            // Single-line timeout markers without a partial-progress block.
            .replace(/Sub-agent '[^']+' timed out after \d+ms\n?/g, "")
            .replace(/Sub-agent '[^']+' produced no final response after substantive work\.\n?/g, "")
            .replace(/Sub-agent '[^']+' was cancelled\n?/g, "");
          const recoveredInterruptedEvidence = extractUsefulInterruptedToolEvidence(resultContent)
            ?? extractUsefulInterruptedToolEvidence(usefulPortion);
          const usefulTrimmed = (recoveredInterruptedEvidence ?? usefulPortion).trim();
          // "Not useful as evidence" must NOT skip the rest of the loop body:
          // the toolResults.push at the bottom is mandatory for EVERY executed
          // call. A `continue` here silently dropped the tool result from
          // history — lenient OpenAI-style templating never noticed, but the
          // Anthropic Messages API rejects the whole next request with a fatal
          // 400 ("tool_use ids were found without tool_result blocks") when any
          // id goes unanswered. Audit f0143008: read_shared_facts returning
          // "No shared facts available yet" (classified boilerplate below)
          // killed two research delegations this way on the claude preset.
          const isUsefulEvidence =
            Boolean(usefulTrimmed)
            && !looksLikeInterruptedEvidenceBoilerplate(usefulTrimmed)
            && !looksLikeProviderErrorEcho(usefulTrimmed);
          // Discovery/meta tool output is ROUTING metadata, not evidence. Auto-sharing
          // it pollutes shared session facts with catalog dumps and "NEXT ACTION:
          // delegate to X" coaching that sibling agents then read as findings
          // (audit 1ac79471: content_writer's context led with a search_agents dump
          // recommending browser_agent for a build). Guard ONLY the snippet+share
          // section — the rest of the per-tool loop body must still run.
          const snippetThreshold = recoveredInterruptedEvidence ? 80 : 180;
          if (isUsefulEvidence && !ROUTING_METADATA_TOOL_NAMES.has(tc.name) && usefulTrimmed.length >= snippetThreshold) {
            const snippet = truncateToolAuditText(usefulTrimmed, 900);
            if (snippet) {
              recentEvidenceSnippets = [...recentEvidenceSnippets, `${tc.name}: ${snippet}`].slice(-6);
            }
            try {
              // autoShareUsefulFinding returns the extracted finding text that was
              // stored, or null if skipped. Count only the extracted length so that
              // cumulativeUsefulEvidenceBytes reflects actual stored knowledge
              // density — not raw dump volume inflated by search headers and URLs.
              const extractedFinding = await autoShareUsefulFinding({
                sessionId: subSessionId,
                agentName: opts.agentName,
                toolName: tc.name,
                evidence: usefulTrimmed,
                sharedKeys: autoSharedFindingKeys,
                objective: opts.task,
                provider,
                signal,
                distill: distillSharedFacts,
              });
              if (extractedFinding !== null) {
                autoSharedFindingCount += 1;
                cumulativeUsefulEvidenceBytes += extractedFinding.length;
                logAudit("sub_agent_tool_call", {
                  agentName: opts.agentName,
                  tool: tc.name,
                  phase: "shared_finding_auto",
                  autoSharedFindingCount,
                  extractedChars: extractedFinding.length,
                }, { sessionId: subSessionId, severity: "info" });
              }
            } catch (err) {
              log.debug({ err, agentName: opts.agentName, tool: tc.name }, "Failed to auto-share useful tool evidence");
            }
          }
        }

        // E21: Track source domain diversity for research plateau detection
        if (result.success && (tc.name === "web_fetch" || tc.name === "browser_navigate")) {
          const rawUrl = (tc.arguments as Record<string, unknown> | undefined)?.["url"];
          const urlStr = typeof rawUrl === "string" ? rawUrl : null;
          if (urlStr) {
            try {
              const domain = new URL(urlStr).hostname.replace(/^www\./i, "");
              if (visitedSourceDomains.has(domain)) {
                consecutiveStaleDomainFetches += 1;
              } else {
                visitedSourceDomains.add(domain);
                consecutiveStaleDomainFetches = 0;
              }
            } catch { /* invalid URL */ }
          }
        }

        // Cost-center 3: track the dead-fetch streak (404 / blocked / non-extractable
        // PDF / error page). Counts failed fetches too (success-only checks miss them);
        // a productive fetch resets the streak.
        if (FETCH_PRODUCTIVITY_TOOL_NAMES.has(tc.name)) {
          if (fetchResultIsNonProductive(result.success, resultContent)) {
            nonProductiveFetchStreak += 1;
          } else {
            nonProductiveFetchStreak = 0;
          }
        }

        // When web_search reports degraded/hard-blocked, remove it from the
        // tools array so the LLM cannot call it on subsequent iterations.
        if (tc.name === "web_search" && result.metadata?.searchDegraded && !result.success) {
          const beforeLen = tools.length;
          tools = tools.filter(t => t.name !== "web_search");
          if (tools.length < beforeLen) {
            log.info(
              { agentName: opts.agentName, iterations },
              "Removed web_search from tools — search backend degraded",
            );
          }
        }

        recordArtifacts(result.metadata, {
          sourceAgent: opts.agentName,
          sourceTool: tc.name,
        });

        // Staged-build salvage bookkeeping. edit_file's metadata carries no
        // outputPath/dataUrl/externalUrl, so recordArtifacts ignores it entirely — a
        // run that FILLED an existing skeleton and was then cut off had nothing in
        // `artifacts` and reported nothing at all. Track the workspace-relative path
        // of every successful file mutation so the interrupted paths below can name
        // what is actually on disk. Cheap (a Set of strings) and independent of the
        // artifact-attachment semantics, which stay untouched.
        if (result.success && (STAGED_BUILD_REQUIRED_TOOLS as readonly string[]).includes(tc.name)) {
          const meta = (result.metadata ?? {}) as Record<string, unknown>;
          const mutatedPath = typeof meta["outputPath"] === "string" && meta["outputPath"]
            ? String(meta["outputPath"])
            : (typeof meta["path"] === "string" ? String(meta["path"]) : "");
          if (mutatedPath) mutatedWorkspacePaths.add(mutatedPath);
        }

        opts.onProgress?.({
          agentName: opts.agentName,
          kind: "tool_done",
          iteration: iterations + 1,
          toolName: tc.name,
          toolCallId: tc.id,
          result: resultContent,
          metadata: result.metadata,
          summary: result.success
            ? `Finished ${tc.name} in ${opts.agentName}.`
            : `Encountered an issue while running ${tc.name} in ${opts.agentName}.`,
        });

        toolResults.push({
          role: "tool",
          content: resultContent,
          tool_call_id: tc.id,
        });
      }

      if (decisiveDirectRemoteToolResult) {
        let directResult = decisiveDirectRemoteToolResult.success
          ? decisiveDirectRemoteToolResult.output
          : `Error: ${decisiveDirectRemoteToolResult.error ?? (decisiveDirectRemoteToolResult.output || "unknown")}`;

        const outputScan = scanOutput(directResult);
        if (!outputScan.safe && outputScan.redacted) {
          logAudit(
            "output_redacted",
            { agentName: opts.agentName, types: outputScan.detectedTypes },
            { sessionId: subSessionId, severity: "warn" }
          );
          directResult = outputScan.redacted;
        }

        iterations += 1;
        const directOutcome: SubAgentOutcome = decisiveDirectRemoteToolResult.success ? "success" : "partial";
        const stats = buildStats("completed", directOutcome);
        recordOutcome({
          ts: new Date().toISOString(),
          agent: opts.agentName,
          task: opts.task.slice(0, 200),
          outcome: directOutcome,
          iterations,
          totalTokens: usage.totalTokens,
          durationMs: Date.now() - runStartedAt,
          timeoutMs: turnTimeoutMs,
          ...(decisiveDirectRemoteToolResult.success ? {} : { error: directResult.slice(0, 200) }),
        });
        logSubAgentCompletionAudit(stats, directResult, {
          deterministicDirectRemoteCli: true,
          tool: decisiveDirectRemoteToolName,
        }, directOutcome === "success" ? "info" : "warn");
        log.info({ agentName: opts.agentName, tool: decisiveDirectRemoteToolName }, "Sub-agent completed via direct remote CLI shortcut");
        return withArtifacts({ output: stripHallucinatedToolTags(directResult), stats });
      }

      // No-progress iteration = every tool call was blocked/skipped, OR every
      // executed result only says the target agent/tool is already exhausted
      // (re-delegating to a capped agent). Both are loops to stop.
      const allResultsNoProgressDelegation = toolResults.length > 0
        && toolResults.every((tr) => NO_PROGRESS_DELEGATION_FAILURE_RE.test(typeof tr.content === "string" ? tr.content : ""));
      // Every executed tool this iteration was a delegation, and all failed (structural,
      // by result metadata) — a coordinator hitting the recursion-block / dead-end wall.
      const allDelegationsFailedThisIteration = delegationCallsThisIteration > 0
        && failedDelegationCallsThisIteration === delegationCallsThisIteration
        && delegationCallsThisIteration === response.tool_calls.length;
      const noProgressIteration = response.tool_calls.length > 0 && toolResults.length > 0
        && (!executedToolThisIteration || allResultsNoProgressDelegation || allDelegationsFailedThisIteration);
      if (noProgressIteration) {
        consecutiveBlockedToolIterations += 1;
        if (consecutiveBlockedToolIterations >= BLOCKED_TOOL_ITERATION_THRESHOLD) {
          const delegationDeadEnd = allDelegationsFailedThisIteration;
          const lastTR = toolResults[toolResults.length - 1]!;
          lastTR.content += delegationDeadEnd
            ? "\n\n[DELEGATION DEAD-END STOP] Every delegation in the last iterations failed (e.g. every candidate is itself a coordinator, so no leaf specialist ran). Re-delegating hits the same wall. " +
              "No tools will be available on the next step. STOP delegating and write your final answer NOW from the shared facts and evidence already gathered this turn; if nothing usable exists, say so honestly."
            : "\n\n[TOOL LOOP STOP] Every tool call in the last iterations was blocked, capped, or malformed. " +
              "No tools will be available on the next step. Produce the final answer from existing evidence now; do not retry the same tool call.";
          tools = [];
          if (effectiveToolNames) effectiveToolNames = [];
          logAudit(
            "sub_agent_tool_loop_detected",
            {
              agentName: opts.agentName,
              reason: delegationDeadEnd ? "all_delegations_failed" : "all_tool_calls_blocked",
              consecutiveBlockedIterations: consecutiveBlockedToolIterations,
              iterations,
              toolNames: response.tool_calls.map((toolCall) => toolCall.name),
            },
            { sessionId: subSessionId, severity: "warn" },
          );
          // Break out of the iteration loop immediately — letting qwen do
          // one more "thinking-mode" pass with tools stripped burns 50–100 s
          // generating ~5 k completion tokens that boil down to a 134-char
          // dead-end (session 8a0c2be3, 2026-05-28: tool_loop_detected fired
          // at 7 s, sub_agent_completed at 103 s — 96 s of pure waste). The
          // post-loop synthesis pass below still gets one shot at producing
          // a final answer from history — so this iteration's tool results
          // (including the loop-stop nudge just appended above and any cached
          // failed-result annotation) MUST land in history before we break,
          // exactly as the normal end-of-iteration push at the bottom of the
          // loop would do. Skipping it discards the last failed tool output
          // (and its annotation) the synthesis pass is supposed to work from.
          history.push(...toolResults);
          break;
        }
      } else {
        consecutiveBlockedToolIterations = 0;
      }

      // Append a budget nudge to the last tool result when on the
      // penultimate iteration, so the agent sees it in the most recent
      // context (not just the system prompt which it may overlook).
      if (remaining === 2 && toolCount > 0 && toolResults.length > 0) {
        const lastTR = toolResults[toolResults.length - 1]!;
        lastTR.content += "\n\n[⚠️ BUDGET: You have 1 iteration left after this one. " +
          "On your next turn you will have NO tools available. " +
          "Produce your COMPLETE final answer NOW or on the very next turn.]";
      }

      // Phase A5: when substantial evidence has been gathered but share_finding hasn't
      // been called yet, inject a nudge so the agent publishes its findings before
      // running out of iterations or dropping evidence.
      if (substantiveEvidenceCount >= 2 && !shareFindinCalledThisRun && toolResults.length > 0) {
        const lastTR = toolResults[toolResults.length - 1]!;
        lastTR.content += "\n\n[EVIDENCE CHECKPOINT] You have collected substantial evidence (" +
          substantiveEvidenceCount + " tool results \u2265 size threshold). " +
          "Call share_finding with the strongest facts you have gathered so far, then continue or finish.";
      }

      // Phase B8: when the agent has called share_finding enough times it has
      // gathered sufficient evidence. Inject a stop nudge to prevent endless loops.
      if (shareFindinCallCount >= 3 && toolResults.length > 0) {
        const lastTR = toolResults[toolResults.length - 1]!;
        lastTR.content += "\n\n[EVIDENCE COMPLETE] You have called share_finding " +
          shareFindinCallCount + " times and gathered sufficient evidence. " +
          "Do NOT call more web_search or web_fetch. Synthesize your findings into a final answer now.";
      }

      // E21: Source-diversity plateau — inject breadth-sufficient nudge when the agent
      // has not visited a new source domain in 2+ consecutive fetches.
      if (consecutiveStaleDomainFetches >= 2 && visitedSourceDomains.size >= 2 && toolResults.length > 0) {
        const lastTR = toolResults[toolResults.length - 1]!;
        lastTR.content += "\n\n[BREADTH SUFFICIENT] You have fetched from " +
          visitedSourceDomains.size + " unique domain(s) with no new source in the last " +
          consecutiveStaleDomainFetches + " fetches. " +
          "Source coverage has plateaued. Stop fetching — call share_finding with your best evidence and synthesize a final answer.";
      }

      // Cost-center 3: dead-fetch streak — many consecutive fetches returned no usable
      // content. Stop guessing alternate URLs for the same document; cite what you have or
      // pivot to one new search. Fires once per run.
      if (nonProductiveFetchStreak >= NON_PRODUCTIVE_FETCH_STREAK_LIMIT && !nonProductiveFetchNudged && toolResults.length > 0) {
        nonProductiveFetchNudged = true;
        const lastTR = toolResults[toolResults.length - 1]!;
        lastTR.content += "\n\n[FETCHES NOT LANDING] " + nonProductiveFetchStreak +
          " consecutive fetches returned no usable content (404 / blocked / non-extractable PDF / error page). " +
          "Do NOT keep guessing alternate URLs for the same document — cite the product or search-result page you already opened and synthesize from the evidence gathered so far, or run ONE different web_search for a new source.";
        logAudit(
          "sub_agent_synthesis_forced",
          { agentName: opts.agentName, reason: "non_productive_fetch_plateau", nonProductiveFetches: nonProductiveFetchStreak, iterations },
          { sessionId: subSessionId, severity: "info" },
        );
      }

      // Track how often the model keeps gathering evidence AFTER the
      // sufficiency nudge told it to answer — feeds the soft→hard escalation
      // in the strip condition below.
      if (sufficiencySynthesisNudged && !sufficiencyToolsStripped && toolNames.some((name) => EVIDENCE_GATHERING_TOOL_NAMES.has(name))) {
        evidenceIterationsSinceNudge += 1;
      }

      // I13: In-loop sufficiency / cascade-failure guard. Runs after tool
      // results have been collected for this iteration but before they are
      // pushed into history and the next LLM call is made. This is the
      // "do I have enough?" / "did the swarm cascade-fail?" gate that was
      // previously missing — without it the coordinator would keep
      // dispatching new delegations even when 6 children had already
      // timed out, eventually hit the per-agent cap, and only then
      // produce a 1097-char shrug ignoring whatever real fragments came
      // back. Both branches fire at most once per run.
      // ── Oversight: goal-aware early finalize ─────────────────────────────
      // The byte-threshold strip below is blunt — it lets a worker grind through
      // far more sources than the goal needs before the 12K brake trips (session
      // d251793b: a "today's news" run hit 9 outlets / 5+ min while the soft
      // nudge was ignored). When the turn recorded acceptance criteria, ask the
      // cheap routing-tier model whether the evidence ALREADY satisfies them; on
      // DONE, fire the SAME authoritative strip+finalize early. Goal-aware, not a
      // per-task source cap. Bounded: only at an evidence boundary, only when
      // criteria exist, ≤ OVERSIGHT_MAX_GOAL_CHECKS calls/run, and a routing-tier
      // miss/error falls through to the byte/time ladder (oversight only ends work
      // early, never prolongs it).
      let oversightGoalMet = false;
      if (
        oversightEnabled
        && oversightCriteria.length > 0
        && !sufficiencyToolsStripped
        && !cascadeSynthesisForced
        && oversightChecksUsed < OVERSIGHT_MAX_GOAL_CHECKS
        && cumulativeUsefulEvidenceBytes >= SUFFICIENT_EVIDENCE_NUDGE_BYTES
        && toolResults.length > 0
        && tools.some((tool) => EVIDENCE_GATHERING_TOOL_NAMES.has(tool.name))
        && !signal?.aborted
      ) {
        oversightChecksUsed += 1;
        const sharedForOversight = await formatSharedFactsContext(subSessionId).catch(() => ({ content: "" }));
        const oversightEvidence = sharedForOversight.content
          || toolResults.map((tr) => tr.content).join("\n");
        oversightGoalMet = await assessOversightGoalMet(oversightCriteria, oversightEvidence, signal);
        if (oversightGoalMet) {
          logAudit(
            "sub_agent_synthesis_forced",
            {
              agentName: opts.agentName,
              reason: "oversight_goal_met",
              usefulEvidenceBytes: cumulativeUsefulEvidenceBytes,
              acceptanceCriteria: oversightCriteria.length,
              iterations,
            },
            { sessionId: subSessionId, severity: "info" },
          );
        }
      }

      if (!cascadeSynthesisForced && cumulativeTimeoutSignalCount >= 2 && toolResults.length > 0) {
        cascadeSynthesisForced = true;
        const beforeLen = tools.length;
        tools = tools.filter((t) =>
          t.name !== "delegate_to_agent"
          && t.name !== "parallel_delegate"
          && t.name !== "swarm_delegate"
          && t.name !== "run_task_graph",
        );
        // I13.2: Direct-fallback tool injection. After delegation has
        // cascade-failed, a delegation-only coordinator agent (e.g.
        // web_task_coordinator) is left with NO working capability and
        // can only apologize. If the runtime exposes web_search /
        // web_fetch and they are not already in the agent's allow-list,
        // inject them so the coordinator can do the gather itself in
        // the same turn instead of returning a refusal. We extend BOTH
        // the loop-local `tools` (visible to the model) and the
        // `effectiveToolNames` allow-list (enforced at the call site).
        const fallbackToolNames: string[] = [];
        if (effectiveToolNames) {
          const candidates = ["web_search", "web_fetch"];
          const fallbackDefs = getToolsAsLLMDefs(candidates).filter(
            (def) => !tools.some((t) => t.name === def.name),
          );
          if (fallbackDefs.length > 0) {
            tools = [...tools, ...fallbackDefs];
            const newAllowList = [...effectiveToolNames];
            for (const def of fallbackDefs) {
              if (!newAllowList.includes(def.name)) {
                newAllowList.push(def.name);
                fallbackToolNames.push(def.name);
              }
            }
            effectiveToolNames = newAllowList;
          }
        }
        const lastTR = toolResults[toolResults.length - 1]!;
        const fallbackHint = fallbackToolNames.length > 0
          ? " You now have direct access to " + fallbackToolNames.join(" and ") +
            " — use them YOURSELF to finish the task in this same turn. Do NOT delegate."
          : "";
        lastTR.content +=
          "\n\n[⚠️ CASCADE TIMEOUT DETECTED] " +
          cumulativeTimeoutSignalCount + " sub-agent invocation(s) have timed out this run. " +
          "Delegation tools are now DISABLED for the rest of this turn — do NOT attempt more delegations." +
          fallbackHint +
          " If you still cannot complete the task, write a HONEST final answer NOW: list which sub-agents you tried, " +
          "state that they timed out, and report what (if anything) was actually retrieved. " +
          "Do NOT invent results. Do NOT pretend the timeouts succeeded.";
        logAudit(
          "sub_agent_synthesis_forced",
          {
            agentName: opts.agentName,
            reason: "cascade_timeout",
            timeoutSignals: cumulativeTimeoutSignalCount,
            usefulEvidenceBytes: cumulativeUsefulEvidenceBytes,
            delegationToolsRemoved: beforeLen - (tools.length - fallbackToolNames.length),
            fallbackToolsInjected: fallbackToolNames,
            iterations,
          },
          { sessionId: subSessionId, severity: "warn" },
        );
        log.warn(
          { agentName: opts.agentName, timeoutSignals: cumulativeTimeoutSignalCount, fallbackToolsInjected: fallbackToolNames, iterations },
          "Cascade timeout detected — stripped delegation tools and injected direct fallbacks",
        );
      } else if (
        !sufficiencyToolsStripped
        && !cascadeSynthesisForced
        && (
          cumulativeUsefulEvidenceBytes >= SUFFICIENT_EVIDENCE_TOOL_STRIP_BYTES
          // Nudge-ignored escalation (audit a438ef4a): the researcher got the
          // soft "answer now" nudge at iteration 5 and kept gathering for 8
          // more iterations (5.5 min) without ever reaching the 12K emergency
          // brake. A nudge ignored this many times IS the convergence failure
          // the brake exists for — escalate soft → hard.
          || (sufficiencySynthesisNudged && evidenceIterationsSinceNudge >= NUDGE_IGNORED_STRIP_ITERATIONS)
          // Oversight judged the recorded acceptance criteria already met —
          // finalize NOW rather than grinding to the byte brake (goal-aware).
          || oversightGoalMet
        )
        && toolResults.length > 0
        && tools.some((tool) => EVIDENCE_GATHERING_TOOL_NAMES.has(tool.name))
      ) {
        // Single-delegation passthrough — short-circuit before stripping. When
        // the only substantive evidence came from one large delegation, the
        // synthesis pass that strip+nudge forces is wasted work: we already
        // have a complete final answer in tool history. Returning it directly
        // saves the rest of the time budget and prevents the "coordinator
        // wraps a complete sub-agent answer for 8 minutes then times out"
        // failure mode from destroying real evidence.
        const passthrough = tryReturnSingleDelegationPassthrough("evidence_strip");
        if (passthrough) return passthrough;

        sufficiencyToolsStripped = true;
        const stripSet = new Set<string>(EVIDENCE_GATHERING_TOOL_NAMES);
        // After enough evidence is gathered, repeated `share_finding`
        // calls are pure noise: they don't add to the useful-evidence
        // total and each one costs another LLM round-trip on a slow
        // local model. When the agent has already published twice,
        // strip share_finding alongside the gather tools so the next
        // iteration has nothing left to call and must synthesize.
        // (Below the 2-call mark we leave it available so the agent
        // can still publish one more strong finding before answering.)
        if (shareFindinCallCount >= 2) {
          stripSet.add("share_finding");
        }
        const strippedToolNames = tools
          .filter((tool) => stripSet.has(tool.name))
          .map((tool) => tool.name);
        for (const name of strippedToolNames) evidenceCapStrippedTools.add(name);
        tools = tools.filter((tool) => !stripSet.has(tool.name));
        if (effectiveToolNames) {
          effectiveToolNames = effectiveToolNames.filter((name) => !stripSet.has(name));
        }
        const lastTR = toolResults[toolResults.length - 1]!;
        lastTR.content +=
          "\n\n[✓ EVIDENCE COMPLETE] You now have approximately " +
          cumulativeUsefulEvidenceBytes + " characters of useful tool output. " +
          "Evidence-gathering tools are disabled for the rest of this run. " +
          "Write the final answer now from the collected evidence. Do not call search, fetch, browser, or delegation tools again.";
        logAudit(
          "sub_agent_synthesis_forced",
          {
            agentName: opts.agentName,
            reason: "sufficient_evidence_tools_stripped",
            usefulEvidenceBytes: cumulativeUsefulEvidenceBytes,
            strippedToolNames,
            shareFindinCallCount,
            iterations,
            nudgeIgnoredEscalation: cumulativeUsefulEvidenceBytes < SUFFICIENT_EVIDENCE_TOOL_STRIP_BYTES,
            evidenceIterationsSinceNudge,
          },
          { sessionId: subSessionId, severity: "info" },
        );
        // Fix 5: bounded synthesis immediately after strip. Without this, the
        // next iteration's LLM call runs unbounded; on slow local models the
        // synthesis pass routinely hangs for 5–10 minutes (hitting the hard
        // turn timeout with no synthesis emitted), which is exactly the
        // failure mode that destroyed the original recording-device turn.
        // Reserve a synthesis window of min(remaining-budget, 90s, 25% of
        // turnTimeoutMs) and attempt the synthesis directly. If it produces
        // a usable result, return it. If not, fall through and let the next
        // iteration try with whatever budget remains.
        if (turnTimeoutMs && !signal?.aborted) {
          history.push(...toolResults);
          toolResults.length = 0;
          const elapsed = Date.now() - runStartedAt;
          const remaining = Math.max(0, turnTimeoutMs - elapsed);
          if (remaining > 5_000) {
            const synthBudget = Math.min(
              remaining - 2_000,
              300_000,                          // cap at 5 min (was 90s, raised for large local models)
              Math.round(turnTimeoutMs * 0.4),
            );
            if (synthBudget > 5_000) {
              const synthesized = await attemptPreDeadlineSynthesis(synthBudget);
              if (synthesized) return synthesized;
            }
          }
        }
      } else if (
        !sufficiencySynthesisNudged
        && !cascadeSynthesisForced
        && cumulativeUsefulEvidenceBytes >= SUFFICIENT_EVIDENCE_NUDGE_BYTES
        && toolResults.length > 0
        && toolNames.some((name) => EVIDENCE_GATHERING_TOOL_NAMES.has(name))
      ) {
        sufficiencySynthesisNudged = true;
        const lastTR = toolResults[toolResults.length - 1]!;
        lastTR.content +=
          "\n\n[✓ EVIDENCE SUFFICIENT] You have gathered approximately " +
          cumulativeUsefulEvidenceBytes + " characters of useful tool output. " +
          "Before calling any more tools, ask yourself: do I really need MORE data, " +
          "or can I answer the user's question NOW from what I already have? " +
          "Default to answering. Only call another tool if a SPECIFIC, NAMED fact is still missing.";
        logAudit(
          "sub_agent_synthesis_forced",
          {
            agentName: opts.agentName,
            reason: "sufficient_evidence",
            usefulEvidenceBytes: cumulativeUsefulEvidenceBytes,
            iterations,
          },
          { sessionId: subSessionId, severity: "info" },
        );
      }

      history.push(...toolResults);
      const refreshedSharedFacts = await formatSharedFactsContext(subSessionId);
      if (refreshedSharedFacts.content && refreshedSharedFacts.signature !== lastSharedFactsSignature) {
        lastSharedFactsSignature = refreshedSharedFacts.signature;
        history.push({
          role: "system",
          content: [
            "[SHARED FINDINGS CHECK BEFORE NEXT ITERATION]",
            "Review these shared findings before calling more tools. Do not repeat work that is already captured here; use them when drafting the final answer.",
            refreshedSharedFacts.content,
          ].join("\n"),
        });
      }
      // Break out of the iteration loop when the model wasted a full
      // round on tools that have already been stripped. After
      // `sufficient_evidence_tools_stripped` fires, a model on a slow
      // local provider routinely keeps emitting the same blocked tool
      // names for several more iterations — each call returns the
      // "Tool '...' has been disabled" stub, the loop continues, and
      // 60–90 seconds of wall time is burned per round before the hard
      // deadline kills the run with no synthesis. Detecting an
      // entirely-blocked iteration (every result content is the
      // disabled-or-capped stub) and falling out of the loop lets the
      // post-loop forced-synthesis pass run while time still remains.
      if (
        sufficiencyToolsStripped
        && response.tool_calls.length > 0
        && toolResults.length > 0
        && toolResults.every((tr) => {
          const c = typeof tr.content === "string" ? tr.content : "";
          return /^Tool '[^']+' (?:has been disabled|has been called|is not in this agent's allowed tool set|is blocked by security policy)/.test(c);
        })
      ) {
        logAudit(
          "sub_agent_synthesis_forced",
          {
            agentName: opts.agentName,
            reason: "all_tool_calls_blocked_after_strip",
            iterations,
            blockedToolNames: response.tool_calls.map((tc) => tc.name),
          },
          { sessionId: subSessionId, severity: "warn" },
        );
        break;
      }
      iterations++;
    }

    logAudit(
      "sub_agent_max_iterations",
      { agentName: opts.agentName, iterations, toolCount, usage, model: modelConfig.primary },
      { sessionId: subSessionId, severity: "warn" }
    );

    // Force a final synthesis pass — send the conversation history back to the
    // LLM with NO tools so it cannot make more tool calls and must produce a
    // plain-text answer from whatever it has gathered so far.
    if (!signal?.aborted) {
      // Single-delegation passthrough — when the only substantive evidence is
      // one large delegation, the post-loop synthesis pass is wasted work.
      // Return the delegation body directly.
      const passthrough = tryReturnSingleDelegationPassthrough("max_iterations_synthesis");
      if (passthrough) return passthrough;
      try {
        const curatedFindings = await readCuratedFindingsForSynthesis();
        const synthMessages: LLMMessage[] = curatedFindings.length >= SYNTH_FACTS_MIN_CHARS
          ? buildFactsFirstSynthMessages(curatedFindings)
          : [
            {
              role: "system",
              content: systemPrompt +
                "\n\nYou have exhausted your tool-call budget. " +
                "DO NOT call any more tools. " +
                "Synthesize everything you have gathered so far and return your COMPLETE final answer now. " +
                "Include ALL content you retrieved from web_fetch, read_file, or any other tool — " +
                "do not summarize away details. Your response is the ONLY output the coordinator will receive from you. " +
                "If you fetched useful content earlier in the conversation, reproduce the key facts, URLs, and extracts verbatim. " +
                "If search failed but you have model knowledge on the topic, provide that and note it was not live-verified.",
            },
            ...history,
          ];
        const synthResponse = await runSynthesisCompletion(synthMessages, signal);
        usage.promptTokens += synthResponse.usage.promptTokens;
        usage.completionTokens += synthResponse.usage.completionTokens;
        usage.totalTokens += synthResponse.usage.totalTokens;

        if (synthResponse.tool_calls.length === 0) {
          let result = normalizeSubAgentOutput(synthResponse.content);

          // ── Empty-response rescue for synthesis path ─────────────────────
          // Qwen models sometimes return empty content even in the synthesis
          // pass. If the agent used tools, retry once with an emphatic prompt.
          if (result === "Sub-agent produced no final response." && toolCount > 0 && !signal?.aborted) {
            try {
              log.warn({ agentName: opts.agentName, toolCount }, "Synthesis returned empty — attempting rescue");
              const rescueMessages: LLMMessage[] = [
                {
                  role: "system",
                  content:
                    "You returned an empty response but you have already gathered content from " +
                    toolCount + " tool calls during this session. " +
                    "Review your conversation history — you MUST have information from web_fetch, " +
                    "read_file, or other tools. Produce your COMPLETE final answer now. " +
                    "Include ALL content you retrieved — URLs, facts, and extracts verbatim. " +
                    "Do NOT call any tools. Do NOT return an empty response.",
                },
                ...history,
              ];
              const rescueResponse = await provider.complete(rescueMessages, [], signal);
              usage.promptTokens += rescueResponse.usage.promptTokens;
              usage.completionTokens += rescueResponse.usage.completionTokens;
              usage.totalTokens += rescueResponse.usage.totalTokens;
              const rescueResult = normalizeSubAgentOutput(rescueResponse.content);
              if (rescueResult !== "Sub-agent produced no final response.") {
                log.info({ agentName: opts.agentName, rescueLength: rescueResult.length }, "Synthesis rescue succeeded");
                result = rescueResult;
              } else {
                log.warn({ agentName: opts.agentName }, "Synthesis rescue also returned empty");
              }
            } catch (rescueErr) {
              log.warn({ rescueErr, agentName: opts.agentName }, "Synthesis rescue failed");
            }
          }

          result = await rescueSanitizedEmptyResult(result);
          result = maybePreferWorkflowOutput(result, workflowPassthroughOutput, toolNames);
          const truncationRecovered = recoverHallucinatedTruncationAfterSubstantiveWork(result);
          result = truncationRecovered.result;

          const outputScan = scanOutput(result);
          if (!outputScan.safe && outputScan.redacted) {
            logAudit(
              "output_redacted",
              { agentName: opts.agentName, types: outputScan.detectedTypes },
              { sessionId: subSessionId, severity: "warn" }
            );
            result = outputScan.redacted;
          }
          // Structural signal only: a real deliverable artifact exists. The
          // English failure-phrase sniff was removed — completion hinges on the
          // structural artifact, not topic/phrase keyword matching of the text.
          const completedFromArtifact = hasDeliverableArtifact(artifacts);
          const stats = completedFromArtifact
            ? buildStats("completed", "success")
            : buildStats("max_iterations", "partial");
          const suspicious = rejectSuspiciousNoToolOutput(
            opts,
            stats,
            result,
            turnTimeoutMs,
            runStartedAt,
          );
          if (suspicious) {
            return suspicious;
          }
          recordOutcome({
            ts: new Date().toISOString(),
            agent: opts.agentName,
            task: opts.task.slice(0, 200),
            outcome: completedFromArtifact ? "success" : "partial",
            iterations,
            totalTokens: usage.totalTokens,
            durationMs: Date.now() - runStartedAt,
            timeoutMs: turnTimeoutMs,
          });
          logSubAgentCompletionAudit(
            stats,
            result,
            {
              synthesizedAfterMaxIterations: true,
              completedFromArtifact,
              artifactCount: artifacts.length,
            },
            completedFromArtifact ? "info" : "warn",
          );
          log.info({ agentName: opts.agentName, iterations, completedFromArtifact }, "Sub-agent synthesized after max iterations");
          opts.onProgress?.({
            agentName: opts.agentName,
            kind: "completed",
            iteration: iterations,
            summary: `Completed delegated work in ${opts.agentName}.`,
          });
          return withArtifacts({ output: result, stats });
        }
      } catch (synthErr) {
        log.warn({ synthErr, agentName: opts.agentName }, "Synthesis pass after max iterations failed");
      }
    }

    recordOutcome({
      ts: new Date().toISOString(),
      agent: opts.agentName,
      task: opts.task.slice(0, 200),
      outcome: hasDeliverableArtifact(artifacts) ? "success" : "partial",
      iterations,
      totalTokens: usage.totalTokens,
      durationMs: Date.now() - runStartedAt,
      timeoutMs: turnTimeoutMs,
      ...(hasDeliverableArtifact(artifacts) ? {} : { error: `max_iterations (${maxIterations}) reached` }),
    });

    const completedFromArtifact = hasDeliverableArtifact(artifacts);
    // When synthesis-after-max-iterations didn't produce a real text answer
    // (model kept emitting tool calls or threw) we used to return a 112-char
    // boilerplate string and discard ~10 KB of useful evidence the agent had
    // already gathered. Route through buildInterruptedSubAgentOutput so the
    // recovered tool-result snippets propagate up to the parent agent under
    // the "Recovered evidence snippets from completed tools:" header that the
    // runtime knows how to extract.
    const recoveredEvidenceSnippets = resolveInterruptedEvidenceSnippets({
      recentEvidenceSnippets,
      history,
      maxSnippets: 6,
    });
    const recoveredUsefulEvidence = recoveredEvidenceSnippets.length > 0;
    const maxIterationsOutput = workflowPassthroughOutput
      ? maybePreferWorkflowOutput(workflowPassthroughOutput, workflowPassthroughOutput, toolNames)
      : completedFromArtifact
      ? buildArtifactCompletionOutput({
          agentName: opts.agentName,
          maxIterations,
          artifacts,
        })
      : recoveredEvidenceSnippets.length > 0
      ? buildInterruptedSubAgentOutput({
          agentName: opts.agentName,
          reason: `reached the maximum number of tool-call iterations (${maxIterations}). Partial result may be incomplete.`,
          swarmState: toolContext.swarmState,
          toolNames,
          toolCount,
          iterations,
          artifacts,
          evidenceSnippets: recoveredEvidenceSnippets,
          primaryDelegationBody: extractMostRecentSubstantialDelegationBody(history),
          mutatedFileLines: currentMutatedFileLines(),
        })
      : `Sub-agent '${opts.agentName}' reached the maximum number of tool-call iterations (${maxIterations}) before producing usable topic-related output.`;
    // A run halted by the iteration guardrail that still GATHERED usable
    // information is partial-with-evidence, NOT a failure — being limited by a
    // guardrail mid-research is not the same as failing. "Gathered usable
    // information" means: recovered evidence snippets, a workflow passthrough, or
    // findings the agent published to shared memory (an explicit share_finding, or
    // a quality-passing auto-share — junk auto-shares no longer increment the
    // count). This deliberately does NOT key on raw successfulToolCount: a
    // successful search_workflows that returned "no workflows matched" succeeded
    // as a call but gathered nothing, and stays a failure.
    const gatheredSharedFindings = shareFindinCallCount > 0 || autoSharedFindingCount > 0;
    const maxIterationsStats = completedFromArtifact
      ? buildStats("completed", "success")
      : buildStats(
          "max_iterations",
          recoveredUsefulEvidence || Boolean(workflowPassthroughOutput) || gatheredSharedFindings
            ? "partial"
            : "failure",
        );
    logSubAgentCompletionAudit(maxIterationsStats, maxIterationsOutput, {
      synthesizedAfterMaxIterations: false,
      completedFromArtifact,
      artifactCount: artifacts.length,
    }, completedFromArtifact ? "info" : "warn");

    return withArtifacts({
      output: maxIterationsOutput,
      stats: maxIterationsStats,
    });
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (supervisorTimer) clearInterval(supervisorTimer);

    // Tear down the live browser preview for this run (also unblocks any
    // still-pending human-assist wait with a "stopped" outcome).
    if (browserSessionId) {
      try { browserSessionManager.stop(browserSessionId, "run_ended"); } catch { /* best effort */ }
    }
    // Resolve any pending long-running-generation prompt for this run so
    // the dashboard's pending list doesn't keep showing it after the run
    // has already finished.
    try { longRunningGenerationManager.stop(subSessionId, "run_ended"); } catch { /* best effort */ }

    // Clean up per-session search circuit-breaker state to avoid memory leaks.
    const clearSearch = await getSearchCleanup();
    clearSearch(subSessionId);

    // Transfer any computer sessions the sub-agent created back to the parent
    // so the orchestrator can reuse them if it falls back to direct tool calls.
    try {
      const subPrefix = `sub:${opts.parentSessionId}`;
      for (const session of computerSessionManager.listActiveSessions()) {
        if (session.leaseOwner.startsWith(subPrefix)) {
          computerSessionManager.attachSession(session.id, opts.parentSessionId, true);
          log.info(
            { sessionId: session.id, from: session.leaseOwner, to: opts.parentSessionId },
            "Transferred computer session lease from sub-agent back to parent",
          );
        }
      }
    } catch (err) {
      log.warn({ err }, "Failed to transfer computer session leases back to parent");
    }
  }
}

export async function runSubAgent(opts: SubAgentRunOptions): Promise<string> {
  const result = await runSubAgentWithStats(opts);
  return result.output;
}
