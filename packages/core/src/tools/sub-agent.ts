/**
 * Sub-agent tools
 *
 * delegate_to_agent — hand a task off to a named specialist sub-agent
 * list_agents       — enumerate configured sub-agents (so the orchestrator can pick)
 */

import { registerTool, getAllTools, searchToolsByEmbedding, executeTool, type SwarmState, type SwarmTaskAttempt, type SwarmTaskState, type ToolContext, type ToolResult } from "./registry.js";
import { runSubAgent, runSubAgentWithStats } from "../agent/sub-agent.js";
// Importing runArchitectFallback also runs ./ephemeral-agent-factory.ts's top-level
// registerTool side effect, so create_ephemeral_agent stays registered when this
// module loads. The factory imports a few shared helpers back from here
// (isWebReachingToolName, looksLikeFailureResult, looksLikeArtifactDeliverableMiss);
// that ESM cycle is safe because every cross-module binding is only dereferenced at
// call time, never during module evaluation (runArchitectFallback is invoked from
// executeDelegationWithFallback below, never at top level).
import { runArchitectFallback } from "./ephemeral-agent-factory.js";
// Agent-routing cluster (semantic routing + capability gates) extracted to
// ./agent-routing.ts. The dependency is one-directional: this module imports from
// agent-routing.ts (and re-exports its public surface for back-compat); agent-routing.ts
// never imports the delegation-execution singletons from here.
import {
  resolveAgentRouting,
  taskRequiresExternalResearch,
  agentIsResearchCapable,
  agentCfgIsMetaFactory,
  agentIsMetaFactory,
  pickResearchFallbackAgent,
  filterCandidatesByExecutionCapability,
  explicitAgentsCoverTaskExecution,
  countRoutingQueryContentTokens,
  shortenOverspecifiedRoutingQuery,
  uniqueNames,
  type AgentRoutingCandidate,
  type AgentRoutingResolution,
  type RoutingSelectionReason,
} from "./agent-routing.js";
import {
  looksLikePlanningOnlyResult,
  WORKSPACE_MUTATION_TASK_RE,
  ARTIFACT_PRODUCING_TOOLS,
  agentCfgCanFulfillArtifactTask,
  looksLikeInfrastructureFailure,
  looksLikeOnlyFailureStubs,
  partialResultHasSubstantiveEvidence,
  classifyDelegationResult,
  isNarrativeOnlyDeliverableFailure,
  formatArtifactReferencesForSharedContext,
} from "./delegation-artifact-classification.js";
// Re-export the classifiers external modules/tests import via "./sub-agent.js" so the god-file
// extraction stays call-site-transparent (ephemeral-agent-factory, source-sensitive-delegation, tests).
export {
  looksLikeArtifactDeliverableMiss,
  agentCfgCanFulfillArtifactTask,
  looksLikeFailureResult,
  looksLikeInfrastructureFailure,
  looksLikeOnlyFailureStubs,
  partialResultHasSubstantiveEvidence,
  classifyDelegationResult,
  isNarrativeOnlyDeliverableFailure,
  formatArtifactReferencesForSharedContext,
  type DelegationClassification,
} from "./delegation-artifact-classification.js";
import { extractInlineHtmlDocument, looksLikeCompleteHtmlDocument } from "../agent/deliverable-intent.js";
import { getConfig } from "../config/loader.js";
import { getEmbeddingSearchStatus } from "../providers/embeddings.js";
import { getEmbeddingProvider, getChatProviderForTier, getChatProvider } from "../providers/index.js";
import { effectiveOrchestration } from "../runtime/effort-context.js";
import { normalizeDelegationTaskLanguage } from "../agent/delegation-language.js";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";
import { appendOutcome, extractTaskKeywords, type AgentCostProfile } from "../agent/outcomes.js";
import { readPromotedAgents } from "../agent/promoted-agents.js";
import { emitSwarmEvent } from "../swarm/bus.js";
import { announceAgentCapability } from "../swarm/capabilities.js";
import { clearTaskBids, collectTaskBids, DEFAULT_AUTONOMOUS_BID_WINDOW_MS, isAutonomousBiddingStarted } from "../swarm/bidding.js";
import { acquireTaskLock, releaseTaskLock } from "../swarm/locks.js";
import { formatSharedContextForPrompt, appendPartialResult, extractFactsFromOutput, writeSharedFact, searchSharedFacts, searchPartialResults, readAllFacts, currentTurnFactKeys } from "../swarm/memory.js";
import { computeTaskGraphNodeKey, readTaskGraphLedger, recordCompletedTaskGraphNode } from "../swarm/task-graph-ledger.js";
import { deriveSharedSessionId } from "./memory.js";
import { graphPromoteFact } from "../memory/graph-service.js";
import { recordCapabilityGap } from "../agent/self-improve.js";
import { longRunningGenerationManager } from "../agent/long-running-generation.js";

const log = childLogger("tool:sub-agent");
import { isCanonicalResearchSliceTask } from "../agent/source-sensitive-delegation.js";
import { awaitQuorum } from "../agent/delegation-quorum.js";
import { shouldCheckSubAgentDisagreement, checkSubAgentDisagreement } from "../agent/sub-agent-disagreement.js";

// Re-export the agent-routing public surface so existing importers of
// "./sub-agent.js" (gateway, discovery-prefetch, swarm/bidding, tests) keep working
// unchanged after the extraction to ./agent-routing.ts.
export {
  resolveAgentRouting,
  computeHybridRoutingScore,
  isCircuitOpen,
  shortenOverspecifiedRoutingQuery,
  taskRequiresExternalResearch,
  isWebReachingToolName,
  isWebGatheringToolName,
  agentCfgIsResearchCapable,
  agentCfgIsMetaFactory,
  requiredExecutionCapabilities,
  filterCandidatesByExecutionCapability,
  explicitAgentsCoverTaskExecution,
  type AgentRoutingCandidate,
  type AgentRoutingResolution,
} from "./agent-routing.js";

const SERVER_EXECUTION_AGENT_NAMES = new Set(["shell_agent", "ops_triage", "infrastructure_agent"]);

/**
 * Carve a synthesis-headroom reserve out of the parent turn budget before handing it
 * to a delegated sub-agent as that sub-agent's OWN hard timeout. A sub-agent today
 * inherits the FULL parent budget, so one slow node can consume the entire turn and
 * leave the orchestrator zero time to synthesize + deliver (audit b6f8336e). When
 * `reserveMs > 0`, the sub-agent gets at most `parentBudget − reserve` (never below
 * `floorMs`), guaranteeing the parent keeps `reserve` ms to finalize.
 *
 * Pure + identity-by-default: `reserveMs = 0` (the config default) returns the parent
 * budget unchanged, and an absent/unbounded budget is passed through untouched, so the
 * knob is a true no-op until explicitly enabled.
 */
export function reserveSubAgentTimeout(
  parentBudgetMs: number | undefined,
  reserveMs: number,
  floorMs = 60_000,
): number | undefined {
  if (typeof parentBudgetMs !== "number" || !Number.isFinite(parentBudgetMs) || parentBudgetMs <= 0) {
    return parentBudgetMs; // unbounded / absent → leave as-is
  }
  if (reserveMs <= 0) return parentBudgetMs; // identity (default off)
  return Math.max(floorMs, parentBudgetMs - reserveMs);
}

function buildSemanticRoutingMetadata(resolution: AgentRoutingResolution): Record<string, unknown> {
  const status = getEmbeddingSearchStatus();
  const configuredModel = getConfig().agents.defaults.model.embeddingModel;
  const semanticConfigured = Boolean(configuredModel);
  const semanticAvailable = resolution.mode === "hybrid";
  const semanticUnavailableReason = semanticConfigured && !semanticAvailable
    ? status.lastError ?? resolution.semanticUnavailableReason ?? "embedding_index_unavailable"
    : undefined;

  return {
    semanticAvailable,
    semanticConfigured,
    embeddingModel: status.model ?? configuredModel ?? null,
    indexedAgentCount: status.indexedAgentCount,
    totalAgentCount: status.totalAgentCount,
    embeddingRetryScheduled: status.retryScheduled,
    ...(semanticUnavailableReason ? { semanticUnavailableReason } : {}),
    ...(status.lastFailedAgent ? { embeddingLastFailedAgent: status.lastFailedAgent } : {}),
    ...(status.lastFailureAt ? { embeddingLastFailureAt: status.lastFailureAt } : {}),
  };
}

function formatSemanticUnavailableNote(metadata: Record<string, unknown>): string {
  if (metadata["semanticConfigured"] !== true || metadata["semanticAvailable"] === true) return "";
  const reason = typeof metadata["semanticUnavailableReason"] === "string"
    ? metadata["semanticUnavailableReason"]
    : "embedding index unavailable";
  const indexed = typeof metadata["indexedAgentCount"] === "number" ? metadata["indexedAgentCount"] : 0;
  const total = typeof metadata["totalAgentCount"] === "number" ? metadata["totalAgentCount"] : 0;
  return `\n⚠ Semantic agent search is configured but unavailable (${reason}; indexed ${indexed}/${total}). Keyword candidate ranking is disabled for this search.`;
}

function formatCostProfile(profile: AgentCostProfile): string {
  const tokenStr = profile.avgTokens > 0 ? `~${profile.avgTokens.toLocaleString()} tokens/run` : "";
  const iterStr = `~${profile.avgIterations} iter/run`;
  const rateStr = `${Math.round(profile.successRate * 100)}% success`;
  const parts = [rateStr, tokenStr, iterStr].filter(Boolean).join(" | ");
  return `\n  Stats (${profile.runs} runs): ${parts}`;
}

function formatRoutingCandidate(candidate: AgentRoutingCandidate): string {
  const matchLine = candidate.matchedTerms.length > 0
    ? `\n  Matches: ${candidate.matchedTerms.join(", ")}`
    : "";
  const capabilities = candidate.capabilities.length > 0
    ? `\n  Capabilities: ${candidate.capabilities.join(", ")}`
    : "";
  const costNote = candidate.costProfile ? formatCostProfile(candidate.costProfile) : "";
  const scorePct = `${Math.round(candidate.score * 100)}%`;
  return `**${candidate.name}** (${candidate.model})\n  ${candidate.description}\n  Confidence: ${candidate.confidence} (${scorePct} skill match)${capabilities}${matchLine}${costNote}`;
}

// ─── ephemeral-agent / architect factory ──────────────────────────────────────
// The ephemeral-agent cluster (getEphemeralGenerationSettings, requestArchitectSpec,
// normalizeArchitectModel, validateEphemeralToolSelection, maybePromoteEphemeral,
// runArchitectFallback, GRANTABLE_TOOLS, EXECUTION_TOOL_FAMILIES, and the
// create_ephemeral_agent tool) was extracted verbatim to ./ephemeral-agent-factory.ts.
// runArchitectFallback is imported back here for executeDelegationWithFallback. The
// factory module is imported for its side effect so create_ephemeral_agent stays
// registered when this module is loaded (the side-effect import lives with the other
// top-level imports). The shared capability-gate helpers (isWebReachingToolName,
// taskRequiresExternalResearch, …) were extracted verbatim to ./agent-routing.ts and
// are imported back at module top for the delegation-execution path below.

interface DelegationRequest {
  agentName?: string;
  task: string;
  context?: string;
  fallbackAgents?: string[];
  routingQuery?: string;
  skillMatchThreshold?: number;
  taskId?: string;
  taskTitle?: string;
  dependsOn?: string[];
  /**
   * Allow reuse of an EARLIER same-signature task's evidence even though this request carries
   * a taskId. parallel_delegate auto-allocates a fresh `parallel_N` id per slice, so without
   * this its slices never consult cross-call signature reuse and a coordinator re-running the
   * same canonical research in a later round repeats the whole thing (audit d20a9a5e). Graph
   * nodes (caller-pinned ids) leave this off so distinct nodes are never cross-matched.
   */
  allowSignatureReuse?: boolean;
}

interface TaskGraphNodeInput {
  id: string;
  title?: string;
  agentName?: string;
  task: string;
  context?: string;
  dependsOn?: string[];
  fallbackAgents?: string[];
  routingQuery?: string;
  skillMatchThreshold?: number;
}

const DEFAULT_MAX_AGENT_CALLS_PER_TURN = 2;
const DEFAULT_MAX_TOTAL_DELEGATIONS_PER_TURN = 8;

function totalDelegationsThisTurn(ctx: ToolContext): number {
  return [...(ctx._turnAgentCounts?.values() ?? [])].reduce((sum, count) => sum + count, 0);
}

function getPerAgentDelegationLimit(ctx: ToolContext, agentName: string): number {
  const override = ctx._turnAgentRepeatLimitOverrides?.[agentName];
  return Math.max(DEFAULT_MAX_AGENT_CALLS_PER_TURN, override ?? DEFAULT_MAX_AGENT_CALLS_PER_TURN);
}

function getTotalDelegationLimit(ctx: ToolContext): number {
  return Math.max(DEFAULT_MAX_TOTAL_DELEGATIONS_PER_TURN, ctx._turnTotalDelegationLimitOverride ?? DEFAULT_MAX_TOTAL_DELEGATIONS_PER_TURN);
}

function withDelegationFanoutAllowance(ctx: ToolContext, agentNames: Array<string | undefined>, plannedDelegations: number): ToolContext {
  const counts = new Map<string, number>();
  for (const agentName of agentNames) {
    const normalized = agentName?.trim();
    if (!normalized) continue;
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }

  const repeatOverrides: Record<string, number> = {
    ...(ctx._turnAgentRepeatLimitOverrides ?? {}),
  };

  let changed = false;
  for (const [agentName, count] of counts.entries()) {
    if (count <= DEFAULT_MAX_AGENT_CALLS_PER_TURN) continue;
    const nextLimit = Math.max(repeatOverrides[agentName] ?? DEFAULT_MAX_AGENT_CALLS_PER_TURN, count);
    if (repeatOverrides[agentName] !== nextLimit) {
      repeatOverrides[agentName] = nextLimit;
      changed = true;
    }
  }

  const nextTotalLimit = Math.max(
    ctx._turnTotalDelegationLimitOverride ?? DEFAULT_MAX_TOTAL_DELEGATIONS_PER_TURN,
    totalDelegationsThisTurn(ctx) + Math.max(1, plannedDelegations) + 1,
  );

  if (!changed && nextTotalLimit === (ctx._turnTotalDelegationLimitOverride ?? DEFAULT_MAX_TOTAL_DELEGATIONS_PER_TURN)) {
    return ctx;
  }

  return {
    ...ctx,
    _turnAgentRepeatLimitOverrides: repeatOverrides,
    _turnTotalDelegationLimitOverride: nextTotalLimit,
  };
}

function getEphemeralGenerationSettings() {
  const config = getConfig();
  return config.agents.ephemeralGeneration;
}

function resolveSkillMatchThreshold(override?: number): number {
  if (typeof override === "number" && Number.isFinite(override)) {
    return Math.max(0, Math.min(1, override));
  }
  return getEphemeralGenerationSettings().skillMatchThreshold;
}

function shouldGenerateEphemeralAgent(bestScore: number | undefined, threshold: number): boolean {
  return bestScore === undefined || bestScore < threshold;
}

function shouldPreferCatalogAgent(
  bestScore: number | undefined,
  bestConfidence: "high" | "medium" | "low" | undefined,
  threshold: number,
): boolean {
  // The operator's explicit `skillMatchThreshold` is the contract — even a
  // "high"-confidence keyword match must clear it before we skip the
  // ephemeral spawn.  Previously the fast-path returned true for ANY
  // high-confidence candidate, which let TOOL_KEYWORD_RULES-induced score
  // inflation (an agent with `web_search`/`web_fetch` automatically picks
  // up "news"/"current"/"latest"/"updates" into its keyword pool, pushing
  // its score to the 0.72 high-confidence floor) bypass thresholds > 0.72.
  // Concretely: a stub agent with description "Finds web documentation."
  // and one `web_search` tool was beating an explicit `0.75` threshold
  // for queries like "today top headlines current news", which suppressed
  // legitimate ephemeral-agent spawns.
  void bestConfidence; // retained on the signature for callers that pass it
  return !shouldGenerateEphemeralAgent(bestScore, threshold);
}

function publishSwarmState(ctx: ToolContext): void {
  if (!ctx.swarmState || !ctx.onSwarmState) return;
  ctx.onSwarmState(structuredClone(ctx.swarmState));
}

function ensureSwarmState(ctx: ToolContext, objectiveHint: string): SwarmState {
  if (!ctx.swarmState) {
    const now = new Date().toISOString();
    ctx.swarmState = {
      objective: objectiveHint,
      startedAt: now,
      updatedAt: now,
      tasks: {},
    };
  }

  ctx.swarmState.updatedAt = new Date().toISOString();
  return ctx.swarmState;
}

function getOrCreateSwarmTask(ctx: ToolContext, taskId: string, title: string, dependsOn: string[] = [], signature?: string): SwarmTaskState {
  const swarmState = ensureSwarmState(ctx, title);
  swarmState.tasks[taskId] ??= {
    id: taskId,
    title,
    status: "pending",
    dependsOn: [...dependsOn],
    signature,
    attempts: [],
  };

  const task = swarmState.tasks[taskId]!;
  task.dependsOn = [...dependsOn];
  task.signature = signature ?? task.signature;
  publishSwarmState(ctx);
  return task;
}

function summarizeText(text: string, maxLength = 180): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}

function resolveDelegationTaskTitle(args: Record<string, unknown>, task: string): string {
  const explicitTitle = typeof args["taskTitle"] === "string"
    ? String(args["taskTitle"]).replace(/\s+/g, " ").trim()
    : "";
  return explicitTitle ? summarizeText(explicitTitle, 80) : summarizeText(task, 80);
}

/**
 * Read the delegation instruction. Local models sometimes key the brief as `title` or
 * `taskTitle` and dump the full detail into `context`, leaving `task` empty — audit
 * 027c9134: a content_writer delegation hard-failed "task is required" and cost a full
 * round on a max-effort run that was already minutes deep. Fall back to those title
 * fields so the delegation proceeds instead of dead-ending; a genuinely instruction-less
 * call still returns "" and is rejected. Structural coercion, not topic/keyword matching.
 */
export function deriveDelegationTask(args: Record<string, unknown>): string {
  const task = String(args["task"] ?? "").trim();
  if (task) return task;
  const title = typeof args["title"] === "string" ? String(args["title"]).trim() : "";
  if (title) return title;
  return typeof args["taskTitle"] === "string" ? String(args["taskTitle"]).trim() : "";
}

/**
 * Resolve the per-task soft budgets from config.
 * Returns 0 for any disabled limit. Kept inline so config changes are picked up
 * each call without restart.
 */
function getTaskBudgets(): { tokens: number; toolCalls: number; durationMs: number } {
  const budgets = getConfig().agents.budgets;
  return {
    tokens: budgets?.maxTokensPerTask ?? 0,
    toolCalls: budgets?.maxToolCallsPerTask ?? 0,
    durationMs: budgets?.maxDurationMsPerTask ?? 0,
  };
}

/**
 * Finalize a SwarmTaskAttempt with duration, budget breach detection, and
 * task-level totals rollup. Always pair `attempt.startedAt` with this call so
 * `durationMs` is correct. Logs a `task_budget_exceeded` audit when caps trip.
 *
 * Idempotent — safe to call once per attempt at the point where finishedAt is set.
 */
function finalizeAttemptBudget(
  ctx: ToolContext,
  task: SwarmTaskState,
  attempt: SwarmTaskAttempt,
): void {
  if (!attempt.finishedAt) attempt.finishedAt = new Date().toISOString();
  const startedMs = Date.parse(attempt.startedAt);
  const finishedMs = Date.parse(attempt.finishedAt);
  if (Number.isFinite(startedMs) && Number.isFinite(finishedMs) && finishedMs >= startedMs) {
    attempt.durationMs = finishedMs - startedMs;
  }

  const budgets = getTaskBudgets();
  const breaches: string[] = [];
  if (budgets.tokens > 0 && (attempt.totalTokens ?? 0) > budgets.tokens) breaches.push("tokens");
  if (budgets.toolCalls > 0 && (attempt.toolCount ?? 0) > budgets.toolCalls) breaches.push("toolCalls");
  if (budgets.durationMs > 0 && (attempt.durationMs ?? 0) > budgets.durationMs) breaches.push("durationMs");
  if (breaches.length > 0) {
    attempt.budgetExceeded = true;
    attempt.budgetBreaches = breaches;
    logAudit(
      "task_budget_exceeded",
      {
        taskId: task.id,
        agentName: attempt.agentName,
        breaches,
        totalTokens: attempt.totalTokens ?? 0,
        toolCount: attempt.toolCount ?? 0,
        durationMs: attempt.durationMs ?? 0,
        limits: budgets,
      },
      { sessionId: ctx.sessionId, severity: "warn" },
    );
  }

  recomputeTaskTotals(task);
}

/** Recompute per-task rollup totals from its attempts. Called by finalizeAttemptBudget. */
function recomputeTaskTotals(task: SwarmTaskState): void {
  let toolCount = 0, iterations = 0, promptTokens = 0, completionTokens = 0, totalTokens = 0, durationMs = 0;
  for (const a of task.attempts) {
    toolCount += a.toolCount ?? 0;
    iterations += a.iterations ?? 0;
    promptTokens += a.promptTokens ?? 0;
    completionTokens += a.completionTokens ?? 0;
    totalTokens += a.totalTokens ?? 0;
    durationMs += a.durationMs ?? 0;
  }
  task.totals = {
    attempts: task.attempts.length,
    toolCount, iterations,
    promptTokens, completionTokens, totalTokens,
    durationMs,
  };
}

// How many times the same already-gathered task may be served back from
// cross-call signature reuse before the pipeline stops replaying the cache and
// returns a hard "already gathered — author/synthesize now" stop. The first
// reuse hands the evidence over; a second identical re-delegation is a loop
// (audit 1fd36e04: a coordinator re-delegated the same research 3× after the
// first, every one served the same cache while burning a slow-model generation,
// and the prompt's own anti-loop rule did not stop it). A non-productive stop
// counts toward the caller's bounded failure budget, so the loop is capped.
const REUSE_SERVE_LIMIT = 1;

function buildExhaustedReuseStop(task: SwarmTaskState, attemptedAgents: string[]): ToolResult {
  // The guidance must live in BOTH fields: parallel_delegate surfaces only a failed
  // slice's `error` to the coordinator, while the single-delegation path surfaces
  // `output` — so put the actionable stop in each.
  const message =
    "[ALREADY GATHERED — do not re-delegate] This exact research was already completed and its findings were returned to you earlier in this run; re-delegating it yields no new evidence. STOP re-researching: call read_shared_facts to use the evidence you already have, then delegate the WRITING to an author (content_writer / paper_author) or synthesize the final answer now.";
  return {
    success: false,
    output: message,
    error: message,
    metadata: {
      agentName: task.selectedAgent,
      taskId: task.id,
      attemptedAgents,
      reused: true,
      reuseExhausted: true,
    },
  };
}

function buildTaskSignature(title: string, task: string, dependsOn: string[] = []): string {
  const normalizedTitle = summarizeText(title, 120).toLowerCase();
  const normalizedTask = summarizeText(task, 240).toLowerCase();
  const normalizedDeps = [...dependsOn].sort().join(",");
  return `${normalizedTitle}::${normalizedTask}::${normalizedDeps}`;
}

function findReusableSwarmTask(ctx: ToolContext, signature: string): SwarmTaskState | undefined {
  if (!ctx.swarmState) return undefined;
  return Object.values(ctx.swarmState.tasks).find((task) => task.signature === signature);
}

function allocateParallelTaskIds(ctx: ToolContext, count: number): string[] {
  if (count <= 0) return [];

  const existingTasks = ctx.swarmState ? Object.keys(ctx.swarmState.tasks) : [];
  const maxParallelIndex = existingTasks.reduce((maxIndex, taskId) => {
    const match = /^parallel_(\d+)$/.exec(taskId);
    if (!match) return maxIndex;
    const parsed = Number.parseInt(match[1] ?? "0", 10);
    return Number.isFinite(parsed) ? Math.max(maxIndex, parsed) : maxIndex;
  }, 0);

  return Array.from({ length: count }, (_value, index) => `parallel_${maxParallelIndex + index + 1}`);
}

function retryIntroducesNewAgent(
  request: Pick<DelegationRequest, "agentName" | "fallbackAgents">,
  attemptedAgents: string[],
): boolean {
  const retryCandidates = uniqueNames([
    request.agentName ?? "",
    ...(request.fallbackAgents ?? []),
  ]);
  if (retryCandidates.length === 0) {
    return false;
  }

  const attempted = new Set(attemptedAgents.filter(Boolean));
  return retryCandidates.some((candidate) => !attempted.has(candidate));
}

function isResearchLikeDelegation(
  candidate: string,
  task: string,
  routingQuery?: string,
  agentCfg?: { tools?: string[]; capabilities?: string[] },
): boolean {
  const text = `${routingQuery ?? ""}\n${task}`.toLowerCase();
  const tools = agentCfg?.tools ?? [];
  const capabilities = agentCfg?.capabilities ?? [];
  // An agent whose job is to fetch+save images (image_sourcer) is NOT a research
  // delegation, even though it uses web_search to FIND image pages: its deliverable is
  // saved local image files, not reusable research facts. Never short-circuit it on
  // cached session evidence — that would skip the actual fetch_image run (audit cdd731d6).
  if (tools.includes("fetch_image")) return false;
  const researchAgentName = /(research|citation|librarian|evidence|source_verifier)/i.test(candidate);
  const researchTools = tools.includes("web_search") || tools.includes("web_fetch");
  const researchCapabilities = capabilities.some((capability) => /research|documentation|source|fact.?check|citation/i.test(capability));
  const sourceHeavyTask = /\b(research|recherche|recherchiere|find|gather|sammle|look for|source|sources|quelle|quellen|citation|citations|zitierfahig|zitierfaehig|reference|references|docs?|documentation|dokumentation|spec|specification|spezifikation|spezifikationen|official|publisher|publication|validate|validiere|protocol|protocols|protokoll|protokolle)\b/i.test(text);
  return sourceHeavyTask && (researchAgentName || researchTools || researchCapabilities);
}

function formatReusableSessionEvidenceOutput(
  title: string,
  factMatches: Array<{ key: string; value: string; score: number }>,
  partialMatches: Array<{ taskId: string; agentName: string; content: string; score: number }>,
): string {
  const factSection = factMatches.length > 0
    ? "## Shared facts already gathered\n" + factMatches
      .slice(0, 4)
      .map((match) => `- **${match.key}** (${Math.round(match.score * 100)}%): ${summarizeText(match.value, 280)}`)
      .join("\n")
    : "";
  const partialSection = partialMatches.length > 0
    ? "## Relevant prior partial results\n" + partialMatches
      .slice(0, 3)
      .map((match) => `### ${match.agentName} (${match.taskId}, ${Math.round(match.score * 100)}%)\n${summarizeText(match.content, 520)}`)
      .join("\n\n")
    : "";

  return [
    `Reused relevant session/task memory for '${title}' instead of launching another duplicate research pass.`,
    factSection,
    partialSection,
  ].filter(Boolean).join("\n\n");
}

// Minimum merged (semantic|keyword) similarity for a cached fact/partial to be
// reuse-eligible. The old 0.18 bar let noise-level embedding similarity through
// (audit 2f4f5fe6: unrelated news facts scored 0.38–0.43 against a "Fable 5"
// query). The structural subject-token gate below is the real guard; this is a
// modest floor that still admits legitimate cross-lingual reuse.
const REUSE_MIN_SCORE = 0.2;

// Generic research/task boilerplate that must NOT count as subject overlap.
// Without this, words like "online", "informationen", or "quellen" shared
// between an unrelated query and a cached fact would falsely qualify as a
// topical match.
const REUSE_SUBJECT_STOPWORDS = new Set<string>([
  // English
  "the", "and", "for", "you", "with", "about", "into", "what", "why", "how", "who", "when",
  "find", "search", "online", "latest", "current", "recent", "information", "informations",
  "source", "sources", "official", "news", "blog", "blogs", "page", "pages", "site", "sites",
  "large", "language", "model", "models", "data", "details", "task", "use", "cases",
  // German
  "und", "der", "die", "das", "den", "dem", "ein", "eine", "einen", "mit", "von", "fur",
  "nach", "auf", "zum", "zur", "ist", "sind", "war", "gibt", "was", "wie", "wer", "wann", "warum",
  "suche", "suchen", "aktuell", "aktuelle", "aktuellen", "neueste", "neuesten", "information",
  "informationen", "quelle", "quellen", "offiziell", "offizielle", "offiziellen", "seiten",
  "technischen", "technische", "zusammenhang", "klare", "namens",
]);

/** Distinctive subject tokens (len ≥ 3, minus boilerplate) of a piece of text. */
function reuseSubjectTokens(text: string): Set<string> {
  const tokens = text.toLowerCase().match(/[a-z0-9äöüß]{3,}/g) ?? [];
  return new Set(tokens.filter((token) => !REUSE_SUBJECT_STOPWORDS.has(token)));
}

/**
 * True when the query and a candidate cached fact/partial share at least one
 * distinctive subject token. This is model-independent and decouples reuse from
 * raw embedding similarity, which can sit at 0.38–0.43 for wholly unrelated text.
 */
function shareReuseSubject(queryTokens: Set<string>, candidateText: string): boolean {
  if (queryTokens.size === 0) return false;
  const candidateTokens = reuseSubjectTokens(candidateText);
  for (const token of queryTokens) {
    if (candidateTokens.has(token)) return true;
  }
  return false;
}

async function findReusableSessionEvidence(
  candidate: string,
  request: DelegationRequest,
  ctx: ToolContext,
  agentCfg?: { tools?: string[]; capabilities?: string[] },
): Promise<{ output: string; factCount: number; partialCount: number } | null> {
  // If the task asks for an artifact (write/create/erstelle/...) and this
  // agent has artifact-producing tools, do NOT short-circuit on cached
  // research evidence — the cached facts won't satisfy the deliverable.
  // Session 2d810e7d (2026-05-28) reused research findings as a "success"
  // for content_writer asked to build a multi-file website, so the website
  // never got written.
  if (
    WORKSPACE_MUTATION_TASK_RE.test(request.task.trim())
    && (agentCfg?.tools ?? []).some((t) => ARTIFACT_PRODUCING_TOOLS.has(t))
  ) {
    return null;
  }
  if (!isResearchLikeDelegation(candidate, request.task, request.routingQuery, agentCfg)) {
    return null;
  }

  const query = (request.routingQuery ?? request.taskTitle ?? summarizeText(request.task, 160)).trim();
  if (!query) {
    return null;
  }

  const config = getConfig();
  const embeddingModel = config.agents.defaults.model.embeddingModel;
  const factMatches = await searchSharedFacts(ctx.sessionId, query, {
    maxResults: 4,
    provider: embeddingModel ? getEmbeddingProvider() : undefined,
    embeddingModel,
  });
  const partialMatches = await searchPartialResults(ctx.sessionId, query, { maxResults: 3 });

  // Two independent guards keep a fresh, unrelated query from being served
  // stale session facts (audit 2f4f5fe6):
  //  1. Mission scope — only facts written THIS turn can short-circuit a
  //     research pass. A brand-new user query has no current-turn facts, so its
  //     researcher actually runs. (enoughEvidence always requires ≥1 fact, so
  //     this also gates the partial path.)
  //  2. Subject-token overlap + a modest score floor — the query must share a
  //     distinctive token with the cached evidence, blocking the noise-level
  //     embedding matches that the old 0.18 score-only bar admitted.
  const currentTurnKeys = currentTurnFactKeys(ctx.sessionId);
  const queryTokens = reuseSubjectTokens(query);
  const relevantFacts = factMatches.filter((match) =>
    match.score >= REUSE_MIN_SCORE
    && currentTurnKeys.has(match.key)
    && shareReuseSubject(queryTokens, `${match.key} ${match.value}`),
  );
  const relevantPartials = partialMatches.filter((match) =>
    match.score >= REUSE_MIN_SCORE
    && shareReuseSubject(queryTokens, match.content),
  );
  const enoughEvidence = relevantFacts.length >= 2 || (relevantFacts.length >= 1 && relevantPartials.length >= 1);

  if (!enoughEvidence) {
    return null;
  }

  return {
    output: formatReusableSessionEvidenceOutput(
      request.taskTitle ?? summarizeText(request.task, 80),
      relevantFacts,
      relevantPartials,
    ),
    factCount: relevantFacts.length,
    partialCount: relevantPartials.length,
  };
}

function agentCanFulfillArtifactTask(
  agentName: string,
  task: string,
  _ctx: ToolContext,
): boolean {
  if (!WORKSPACE_MUTATION_TASK_RE.test(task.trim())) return true;
  const config = getConfig();
  const promotedAgents = readPromotedAgents(config.workspacePath);
  const cfg = config.subAgents[agentName] ?? promotedAgents[agentName];
  return agentCfgCanFulfillArtifactTask(task, cfg);
}

/**
 * True when a delegation is a RENDER/ARTIFACT step: the task asks to produce a
 * concrete deliverable (write the file / create the deck / generate the site) AND the
 * target agent can actually produce it. Such a step consumes already-gathered shared
 * facts; it must NOT be hijacked by the source-sensitive research-incapable redirect,
 * even when the brief carries research wording ("cite the official sources", "use the
 * verified URLs"). Audit 6b382964: a reveal.js write delegation to content_writer was
 * bounced to researcher, which narrated and never wrote the deck.
 */
export function isArtifactRenderTask(task: string, cfg: { tools?: string[] } | undefined): boolean {
  if (!WORKSPACE_MUTATION_TASK_RE.test(task.trim())) return false;
  return agentCfgCanFulfillArtifactTask(task, cfg);
}

function getKnownDelegationAgentNames(workspacePath?: string): Set<string> {
  const config = getConfig();
  const known = new Set(Object.keys(config.subAgents));
  const promotedAgents = readPromotedAgents(workspacePath ?? config.workspacePath);
  for (const name of Object.keys(promotedAgents)) {
    known.add(name);
  }
  return known;
}

function sanitizeDelegationAgentList(agentNames: string[] | undefined, ctx: ToolContext): {
  valid: string[];
  invalid: string[];
  disallowed: string[];
} {
  if (!agentNames?.length) {
    return { valid: [], invalid: [], disallowed: [] };
  }

  const knownAgents = getKnownDelegationAgentNames(ctx.workspacePath);
  const enforceKnownAgents = knownAgents.size > 0;
  const valid: string[] = [];
  const invalid: string[] = [];
  const disallowed: string[] = [];

  for (const agentName of uniqueNames(agentNames)) {
    if (enforceKnownAgents && !knownAgents.has(agentName)) {
      invalid.push(agentName);
      continue;
    }
    if (ctx.allowedAgents && !ctx.allowedAgents.includes(agentName)) {
      disallowed.push(agentName);
      continue;
    }
    valid.push(agentName);
  }

  return { valid, invalid, disallowed };
}

function maybeEnrichServerDelegationContext(agentName: string, task: string, context: string | undefined): string | undefined {
  // Structural gate: only the server-execution specialists get SSH-target enrichment.
  // The agent has already been selected, so we no longer keyword-sniff the task text
  // to decide whether this "looks like" server admin — the configured-node alias match
  // below (against real node names/hosts) is what scopes the addition.
  if (!SERVER_EXECUTION_AGENT_NAMES.has(agentName)) {
    return context;
  }

  const combined = `${task}\n${context ?? ""}`.toLowerCase();
  const nodes = (getConfig().computerUse as { nodes?: Record<string, Record<string, unknown>> } | undefined)?.nodes ?? {};

  for (const [nodeName, node] of Object.entries(nodes)) {
    if (node["adapter"] !== "remote_ssh") continue;

    const label = typeof node["label"] === "string" ? node["label"] : "";
    const host = typeof node["host"] === "string" ? node["host"] : "";
    const username = typeof node["username"] === "string" ? node["username"] : "root";
    const port = typeof node["port"] === "number" ? node["port"] : 22;
    const authMethod = typeof node["authMethod"] === "string" ? node["authMethod"] : "";
    const aliases = [nodeName, label, host]
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);

    const matched = aliases.some((alias) => {
      const variants = new Set([
        alias,
        alias.replace(/[_\s]+/g, "-"),
        alias.replace(/[-_]+/g, " "),
      ]);
      return [...variants].some((variant) => combined.includes(variant));
    });

    if (!matched) continue;

    const addition = [
      "Known configured SSH target for this task:",
      `- nodeName: ${nodeName}`,
      `- host: ${host}`,
      `- port: ${port}`,
      `- username: ${username}`,
      authMethod ? `- authMethod: ${authMethod}` : "",
      `Use ssh_exec with nodeName=\"${nodeName}\" so the runtime can reuse the configured target and credentials instead of rediscovering them.`,
      /\b(docker|container|containers)\b/i.test(task)
        ? "This is a direct remote inventory task. Prefer one SSH command such as docker ps or docker ps --format '{{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Ports}}' and then stop."
        : "Prefer a direct remote command first and only inspect local config files if that remote call fails and you need to verify the configuration.",
      "Do not spend multiple iterations browsing local runtime or workspace files when the target is already identified above.",
    ].filter(Boolean).join("\n");

    if (context?.includes(`nodeName: ${nodeName}`) || context?.includes(`nodeName=\"${nodeName}\"`)) {
      return context;
    }
    return context ? `${context}\n\n${addition}` : addition;
  }

  return context;
}

function buildDelegationFailureMessage(title: string, detail: string, opts?: { prefix?: string }): string {
  const trimmedDetail = detail.trim();
  const prefix = opts?.prefix ?? `All candidate agents failed for task '${title}'.`;
  if (!trimmedDetail) {
    return prefix;
  }
  return `${prefix}\n${trimmedDetail}`;
}

async function routeAgentCandidates(query: string, ctx: ToolContext, exclude: string[]): Promise<AgentRoutingCandidate[]> {
  const excluded = new Set(exclude);
  if (ctx.currentAgentName) {
    excluded.add(ctx.currentAgentName);
  }
  // Meta/factory agents (agent_factory et al.) are never autonomously routable —
  // they are a deliberate, explicit choice, not something the swarm should elect
  // for ordinary work (audit c33e65dd). Explicit agentName/fallbacks bypass this
  // function entirely, so they stay reachable.
  {
    const routingConfig = getConfig();
    const routingPromoted = readPromotedAgents(routingConfig.workspacePath);
    for (const [name, cfg] of [...Object.entries(routingConfig.subAgents), ...Object.entries(routingPromoted)]) {
      if (agentCfgIsMetaFactory(cfg)) excluded.add(name);
    }
  }
  const medium = await resolveAgentRouting(query, {
    minConfidence: "medium",
    allowedAgents: ctx.allowedAgents,
    excludeAgents: [...excluded],
  });

  let candidates: AgentRoutingCandidate[] = medium.results;
  if (candidates.length === 0) {
    const low = await resolveAgentRouting(query, {
      minConfidence: "low",
      allowedAgents: ctx.allowedAgents,
      excludeAgents: [...excluded],
    });
    candidates = [...low.results, ...low.weakCandidates];

    // Total routing failure — no agent at any confidence. Auto-record for self-improvement.
    if (candidates.length === 0) {
      recordCapabilityGap({
        description: `Delegation failed — no agent found for task: "${query.slice(0, 300)}"`,
        exampleInput: query.slice(0, 500),
        sessionId: ctx.sessionId,
      }).catch(() => { /* self-improvement may be disabled */ });
    }
  }

  // Deduplicate by name, exclude already-attempted agents. Order is the pure
  // semantic + structural ranking from resolveAgentRouting — no keyword-driven
  // coordinator preference re-sort.
  const seen = new Set<string>();
  return candidates.filter(c => {
    if (excluded.has(c.name) || seen.has(c.name)) return false;
    seen.add(c.name);
    return true;
  });
}

// ─── Architect fallback ───────────────────────────────────────────────────────
// runArchitectFallback (+ its private helpers maybePromoteEphemeral,
// requestArchitectSpec, normalizeArchitectModel, validateEphemeralToolSelection)
// moved to ./ephemeral-agent-factory.ts. It is imported at module top and called
// below from executeDelegationWithFallback (call-time only).

/**
 * True for agents whose job is to decompose-and-re-delegate (mission_coordinator,
 * web_task_coordinator, …). Mirrors the inline check used during attempt dispatch:
 * the `_coordinator` name suffix or a `coordination` tag in the agent config.
 */
function agentNameIsCoordinator(name: string): boolean {
  if (!name) return false;
  if (name.endsWith("_coordinator")) return true;
  const cfg = getConfig().subAgents[name];
  return Boolean(cfg && (cfg.tags ?? []).includes("coordination"));
}

async function executeDelegationWithFallback(request: DelegationRequest, ctx: ToolContext): Promise<ToolResult> {
  const title = request.taskTitle ?? summarizeText(request.task, 80);
  const signature = buildTaskSignature(title, request.task, request.dependsOn ?? []);
  const skillMatchThreshold = resolveSkillMatchThreshold(request.skillMatchThreshold);
  const explicitAgentRequested = typeof request.agentName === "string" && request.agentName.trim().length > 0;
  const hasExplicitFallbacks = (request.fallbackAgents?.length ?? 0) > 0;
  const reusableTaskById = request.taskId
    ? ctx.swarmState?.tasks[request.taskId]
    : undefined;
  // Cross-call signature reuse is normally skipped when a taskId is present (graph nodes are
  // caller-pinned — never cross-match a distinct node to another's signature). parallel_delegate
  // sets allowSignatureReuse because its `parallel_N` ids are auto-allocated, so a later round
  // that re-issues the same canonical research reuses the earlier slice's evidence instead of
  // re-running it (audit d20a9a5e: the coordinator researched the same request twice = ~2x turn).
  const reusableTask = reusableTaskById?.signature === signature
    ? reusableTaskById
    : ((request.taskId && !request.allowSignatureReuse) ? undefined : findReusableSwarmTask(ctx, signature));
  const reusableTaskAttemptedAgents = reusableTask?.attempts.map((attempt) => attempt.agentName) ?? [];

  if (reusableTask?.status === "completed" && reusableTask.output) {
    reusableTask.reuseServedCount = (reusableTask.reuseServedCount ?? 0) + 1;
    if (reusableTask.reuseServedCount > REUSE_SERVE_LIMIT) {
      return buildExhaustedReuseStop(reusableTask, reusableTaskAttemptedAgents);
    }
    return {
      success: true,
      output: reusableTask.output,
      metadata: {
        agentName: reusableTask.selectedAgent,
        taskId: reusableTask.id,
        attemptedAgents: reusableTaskAttemptedAgents,
        delegationSucceeded: true,
        reused: true,
      },
    };
  }

  if (reusableTask?.status === "partial" && reusableTask.output) {
    reusableTask.reuseServedCount = (reusableTask.reuseServedCount ?? 0) + 1;
    if (reusableTask.reuseServedCount > REUSE_SERVE_LIMIT) {
      return buildExhaustedReuseStop(reusableTask, reusableTaskAttemptedAgents);
    }
    return {
      success: true,
      output: reusableTask.output,
      metadata: {
        agentName: reusableTask.selectedAgent,
        taskId: reusableTask.id,
        attemptedAgents: reusableTaskAttemptedAgents,
        delegationSucceeded: true,
        delegationOutcome: "partial",
        reused: true,
      },
    };
  }

  if (reusableTask?.status === "running") {
    return {
      success: true,
      output: `Task '${title}' is already running via ${reusableTask.selectedAgent ?? reusableTask.attempts[reusableTask.attempts.length - 1]?.agentName ?? "another agent"}.`,
      metadata: {
        agentName: reusableTask.selectedAgent,
        taskId: reusableTask.id,
        attemptedAgents: reusableTaskAttemptedAgents,
        reused: true,
        inFlight: true,
      },
    };
  }

  if (!request.taskId && reusableTask?.status === "failed" && !retryIntroducesNewAgent(request, reusableTaskAttemptedAgents)) {
    return {
      success: false,
      output: "",
      error: `Delegation for task '${title}' already failed earlier in this turn${reusableTaskAttemptedAgents.length > 0 ? ` after trying ${reusableTaskAttemptedAgents.join(", ")}` : ""}. Do not retry the same task verbatim. ${reusableTask.error ?? "Use a different agent or provide a more specific task."}`,
      metadata: {
        agentName: reusableTask.selectedAgent,
        taskId: reusableTask.id,
        attemptedAgents: reusableTaskAttemptedAgents,
        delegationSucceeded: false,
        reused: true,
        priorFailure: true,
      },
    };
  }

  const taskId = request.taskId ?? reusableTask?.id ?? `task_${Object.keys(ensureSwarmState(ctx, request.task).tasks).length + 1}`;
  const taskState = getOrCreateSwarmTask(ctx, taskId, title, request.dependsOn ?? [], signature);
  const attemptedAgents: string[] = [];

  // Operator stopped this turn — do NOT start a fresh delegation. The orchestrator
  // must synthesize from evidence already gathered (shared findings + prior
  // delegated results) instead of spawning a new sub-agent. Audit 5a6db38d: after
  // the operator stopped the researchers, the orchestrator re-delegated to a
  // coordinator that burned another 14 minutes and then shipped a training-data
  // answer. Re-evaluated per call; the latch is cleared at runTurn start, so this
  // only fires within the stopped turn. (A reusable completed/partial task above
  // has already returned its evidence before reaching here.)
  // EXCEPTION: the terminal auto-build-after-research delegation
  // (ctx.allowDelegationAfterOperatorStop) is exempt — an operator Stop means "stop
  // gathering more, build NOW from what we have," so the single bounded build from
  // already-gathered facts must still run (audit 453a263e: Stop blocked the build and the
  // turn shipped a fabricated inline deck instead of building from the verified findings).
  if (!ctx.allowDelegationAfterOperatorStop && longRunningGenerationManager.isStopRequested(ctx.sessionId)) {
    logAudit("delegation_halted_operator_stop", {
      taskTitle: title,
      phase: "new_delegation",
      agentName: request.agentName ?? "auto",
    }, { sessionId: ctx.sessionId, severity: "info" });
    taskState.status = "failed";
    taskState.error = "Operator stopped this turn.";
    publishSwarmState(ctx);
    return {
      success: false,
      output: "",
      error: "Operator stopped this turn — do NOT delegate again. Synthesize a final response now from the evidence already gathered (shared findings and the prior delegated results in this conversation), and clearly mark anything that remains open.",
      metadata: { taskId, attemptedAgents, delegationSucceeded: false, operatorStopped: true },
    };
  }
  // Terminal auto-build is exempt AND the operator had stopped: clear the turn's stop latch
  // so the build sub-agent's own long-running-generation checks don't auto-stop it mid-build.
  // Safe — the auto-build is the turn's final action (nothing else delegates after it), and
  // content_writer has no delegate tools, so this cannot re-open a runaway re-delegation loop.
  if (ctx.allowDelegationAfterOperatorStop && longRunningGenerationManager.isStopRequested(ctx.sessionId)) {
    longRunningGenerationManager.clearStopRequested(ctx.sessionId);
    logAudit("delegation_halted_operator_stop", {
      taskTitle: title,
      phase: "auto_build_stop_latch_cleared",
      agentName: request.agentName ?? "content_writer",
    }, { sessionId: ctx.sessionId, severity: "info" });
  }
  // I12: Track candidates skipped because they had already exhausted their
  // per-agent delegation cap this turn. Without this, when every routed
  // candidate is already maxed out (e.g. researcher already called 2/2
  // times by an earlier parallel_delegate) we silently fall through to
  // "No suitable agent completed the task" which makes the coordinator
  // think it's a routing problem and re-delegate the same work.
  const cappedCandidates: string[] = [];
  // A coordinator must not delegate to another coordinator — that is pure
  // re-decomposition recursion (audit 687a224b: a depth-1 mission_coordinator
  // spawned a depth-2 mission_coordinator and burned ~24 min before the turn cap).
  // Coordinators delegate to leaf specialists; track skips for the failure diagnostic.
  const callerIsCoordinator = Boolean(ctx.currentAgentName && agentNameIsCoordinator(ctx.currentAgentName));
  const skippedCoordinatorCandidates: string[] = [];
  const usesAutonomousBidding = !request.agentName;

  if (usesAutonomousBidding) {
    clearTaskBids(taskId);
  }

  emitSwarmEvent("task_announced", {
    sessionId: ctx.sessionId,
    taskId,
    task: request.task,
    agentName: request.agentName,
    ...(usesAutonomousBidding
      ? {
        data: {
          dispatchMode: "autonomous_bidding",
          routingQuery: request.routingQuery ?? request.task,
          allowedAgents: ctx.allowedAgents ?? [],
          excludeAgents: attemptedAgents,
          bidWindowMs: DEFAULT_AUTONOMOUS_BID_WINDOW_MS,
        },
      }
      : {}),
  });

  let candidateQueue = uniqueNames([
    request.agentName ?? "",
    ...(request.fallbackAgents ?? []),
  ]);
  let biddingTried = false;
  let bestAutoMatchScore: number | undefined;
  let bestAutoMatchConfidence: "high" | "medium" | "low" | undefined;
  let lastFailureWasInfrastructure = false;
  let bestPartialResult:
    | {
      agentName: string;
      output: string;
      terminalState?: string;
      routingInfo?: RoutingSelectionReason;
      artifacts?: Record<string, unknown>[];
    }
    | undefined;
  /** Routing metadata for agents that were auto-selected by resolveAgentRouting. */
  const routingCandidateMap = new Map<string, RoutingSelectionReason>();

  if (!ctx._turnAgentCounts) ctx._turnAgentCounts = new Map();

  // Research-capability gate for EXPLICIT delegations (the routing/bidding gates
  // only cover undirected picks). If a source-sensitive / "search online" task
  // was explicitly aimed at web-incapable agents (e.g. an orchestrator that saw
  // a generator ranked high in search_agents), redirect to a research-capable
  // agent so a generator never runs a research task. Closes the loop the
  // routing/bidding gates opened. Only redirects when a capable fallback exists.
  //
  // EXCEPTION — RENDER/ARTIFACT delegations: writing the deck / creating the file /
  // generating the site from already-gathered shared facts is NOT a gather task, even
  // when the brief is full of source-sensitive wording ("use the verified URLs", "cite
  // official sources"). Bouncing the writer to a researcher that cannot produce the
  // artifact is the failure mode in audit 6b382964 (content_writer → researcher, which
  // narrated and never wrote the reveal.js deck). When the task asks to produce an
  // artifact AND every requested agent is artifact-capable for it, let the writer run.
  //
  // PRECONDITION: a render exemption only holds once research has ACTUALLY produced
  // shared facts. On a source-sensitive task with ZERO shared facts the "render" agent
  // would build the deliverable from nothing — straight from training data, no
  // verification (audit 42339f53: content_writer built a Dresden deck with fabricated
  // facts and fake "sources" because the exemption skipped the redirect on a fresh
  // session). When the task needs research and no facts exist yet, it is a GATHER, not a
  // render — withhold the exemption so the research redirect fires (then the terminal
  // auto-build runs once facts exist).
  const renderCfgConfig = getConfig();
  const renderCfgPromoted = readPromotedAgents(renderCfgConfig.workspacePath);
  let renderHasGatheredFacts = true;
  if (taskRequiresExternalResearch(request.task)) {
    try {
      const facts = await readAllFacts(deriveSharedSessionId(ctx.sessionId));
      renderHasGatheredFacts = Object.keys(facts).length > 0;
    } catch {
      renderHasGatheredFacts = false;
    }
  }
  const isArtifactRenderDelegation = renderHasGatheredFacts
    && candidateQueue.length > 0
    && candidateQueue.every((name) =>
      isArtifactRenderTask(request.task, renderCfgConfig.subAgents[name] ?? renderCfgPromoted[name]));
  if (isArtifactRenderDelegation && taskRequiresExternalResearch(request.task)) {
    logAudit("delegation_render_research_redirect_skipped", {
      taskTitle: title,
      requestedAgents: candidateQueue,
    }, { sessionId: ctx.sessionId });
  }
  // An EXPLICIT delegation to an agent that genuinely covers the task's execution/interaction
  // capability (browser login, shell, sandboxed code) is real execution work — never hijack it to a
  // research agent, even when the task text trips the web-research word shape. Session 8815a45e: an
  // explicit computer_use_agent login ("...auf der Website freelancermap.de anmelden... sicheren
  // Credential-Lookup...") was redirected to `researcher` because "Website" + "Credential-Lookup"
  // matched taskRequiresExternalResearch; the tool-less researcher then returned a first-person
  // refusal that was relayed verbatim to the user. This narrows the redirect (never widens it):
  // the render-agent anti-fabrication case still fires (writers hold no execution capability).
  const explicitCoversExecution = explicitAgentRequested
    && explicitAgentsCoverTaskExecution(
      candidateQueue,
      request.task,
      (name) => renderCfgConfig.subAgents[name] ?? renderCfgPromoted[name],
    );
  if (!isArtifactRenderDelegation && !explicitCoversExecution && taskRequiresExternalResearch(request.task) && candidateQueue.length > 0) {
    const capable = candidateQueue.filter((name) => agentIsResearchCapable(name));
    if (capable.length === 0) {
      const fallback = pickResearchFallbackAgent(attemptedAgents);
      logAudit("delegation_explicit_redirected_research_incapable", {
        taskTitle: title,
        requestedAgents: candidateQueue,
        redirectedTo: fallback ?? null,
      }, { sessionId: ctx.sessionId });
      if (fallback) {
        routingCandidateMap.set(fallback, {
          confidence: "medium",
          matchedTerms: ["research", "search-online", "redirected"],
          score: 0.7,
        });
        candidateQueue = [fallback];
      }
    } else if (capable.length < candidateQueue.length) {
      candidateQueue = capable;
    }
  }

  while (true) {
    // Abort early if the parent turn was cancelled
    if (ctx.signal?.aborted) {
      taskState.status = "failed";
      taskState.error = "Turn cancelled.";
      publishSwarmState(ctx);
      return {
        success: false,
        output: "",
        error: buildDelegationFailureMessage(
          title,
          taskState.error,
          { prefix: "Turn cancelled — delegation aborted." },
        ),
        metadata: { taskId, attemptedAgents, delegationSucceeded: false },
      };
    }

    // Hard ceiling: if we've already spawned too many agents this turn, stop and tell the LLM to synthesize
    const totalDelegations = totalDelegationsThisTurn(ctx);
    const maxTotalDelegationsPerTurn = getTotalDelegationLimit(ctx);
    if (totalDelegations >= maxTotalDelegationsPerTurn) {
      taskState.status = "failed";
      taskState.error = "Turn delegation budget exceeded.";
      publishSwarmState(ctx);
      return {
        success: false,
        output: "",
        error: `Turn delegation limit (${maxTotalDelegationsPerTurn}) reached. Stop delegating and synthesize your findings into a final response for the user now.`,
        metadata: { taskId, attemptedAgents, delegationSucceeded: false },
      };
    }

    // Operator stopped this turn — do NOT ESCALATE to a fallback / next candidate.
    // The first attempt (started before the stop) is allowed to finish and have
    // its evidence captured below; we just stop spawning additional agents. This
    // is what ends the researcher→mission_coordinator→nested-researcher escalation
    // in audit 5a6db38d, where a stopped researcher's partial was discarded and a
    // coordinator re-decomposed the same slice. Breaking here falls through to the
    // bestPartialResult return so the captured evidence is surfaced.
    if (taskState.attempts.length > 0 && longRunningGenerationManager.isStopRequested(ctx.sessionId)) {
      logAudit("delegation_halted_operator_stop", {
        taskTitle: title,
        phase: "escalation",
        attempts: taskState.attempts.length,
      }, { sessionId: ctx.sessionId, severity: "info" });
      break;
    }

    if (candidateQueue.length === 0) {
      // Explicit delegate_to_agent calls stay explicit unless the caller opted
      // into retries with fallbackAgents. Hidden auto-routing after an explicit
      // pick led to wasted coordinator hops and surprising tool churn.
      const allowImplicitFallbackRouting = !explicitAgentRequested || hasExplicitFallbacks;

      if (!allowImplicitFallbackRouting) {
        break;
      }

      // ── Step 1: embedding + keyword routing (fast, outcome-boosted) ──────
      // Run first for all undirected delegations — deterministic, uses
      // accumulated outcome data, and incurs no extra latency.
      if (candidateQueue.length === 0) {
        const allRoutingCandidates = await routeAgentCandidates(request.routingQuery ?? request.task, ctx, attemptedAgents);
        // Drop candidates that cannot produce the deliverable the task asks
        // for. See agentCanFulfillArtifactTask for the regression context.
        let routingCandidates = allRoutingCandidates.filter((cand) =>
          agentCanFulfillArtifactTask(cand.name, request.task, ctx)
        );
        if (routingCandidates.length === 0 && allRoutingCandidates.length > 0) {
          logAudit("delegation_routing_filtered_artifact_incapable", {
            taskTitle: title,
            droppedAgents: allRoutingCandidates.map((c) => c.name),
          }, { sessionId: ctx.sessionId });
        }
        // Research-capability gate: a source-sensitive / "search online and
        // validate" task must go to an agent that can actually reach the web (or
        // a coordinator that can). This stops generation specialists like
        // image_creator / chart_designer from being routed a research task and
        // returning narrative-only "Let me search online…" non-answers.
        // (Regression: session 64b90fcc, 2026-05-29.)
        if (taskRequiresExternalResearch(request.task) && routingCandidates.length > 0) {
          const researchCapable = routingCandidates.filter((cand) => agentIsResearchCapable(cand.name));
          if (researchCapable.length === 0) {
            logAudit("delegation_routing_filtered_research_incapable", {
              taskTitle: title,
              droppedAgents: routingCandidates.map((c) => c.name),
            }, { sessionId: ctx.sessionId });
            const fallback = pickResearchFallbackAgent(attemptedAgents);
            if (fallback) {
              routingCandidateMap.set(fallback, {
                confidence: "medium",
                matchedTerms: ["research", "search-online", "source-sensitive"],
                score: 0.7,
              });
              candidateQueue.push(fallback);
            }
            routingCandidates = [];
          } else {
            routingCandidates = researchCapable;
          }
        }
        // Capability-aware gate: when the task needs a concrete execution tool class
        // (shell/code-exec/browser interaction) and both capable and incapable agents
        // were routed, keep the capable ones so bidding/routing can't elect an agent
        // that lacks the tool the task needs.
        if (routingCandidates.length > 1) {
          const capCfg = getConfig();
          const capPromoted = readPromotedAgents(capCfg.workspacePath);
          const { kept, dropped, capabilities } = filterCandidatesByExecutionCapability(
            routingCandidates.map((c) => c.name),
            request.task,
            (name) => capCfg.subAgents[name] ?? capPromoted[name],
          );
          if (dropped.length > 0) {
            logAudit("delegation_routing_filtered_capability_incapable", {
              taskTitle: title,
              droppedAgents: dropped,
              capabilities,
            }, { sessionId: ctx.sessionId });
            routingCandidates = routingCandidates.filter((c) => kept.includes(c.name));
          }
        }
        if (routingCandidates.length > 0) {
          const topCandidate = routingCandidates[0]!;
          bestAutoMatchScore = topCandidate.score;
          bestAutoMatchConfidence = topCandidate.confidence;
          // Diagnostic: a weak top score that coincides with a DEGRADED embedding endpoint is
          // the signature of "configured embedding model not serving" (audit 9b5196ad: the
          // configured model wasn't loaded → /v1/embeddings errored → every catalog agent
          // scored ~0.25 → architect ephemeral). Surface it in the audit the operator reads so
          // the cause (embeddings) is obvious from the symptom (low score / ephemeral fallback),
          // instead of silently degrading to keyword scoring.
          if (bestAutoMatchScore < skillMatchThreshold) {
            const embStatus = getEmbeddingSearchStatus();
            if (embStatus.configured && (!embStatus.available || embStatus.lastError)) {
              logAudit("delegation_routing_embedding_degraded", {
                taskTitle: title,
                topScore: Number(bestAutoMatchScore.toFixed(3)),
                embeddingModel: embStatus.model,
                embeddingAvailable: embStatus.available,
                indexedAgentCount: embStatus.indexedAgentCount,
                lastError: embStatus.lastError ?? null,
              }, { sessionId: ctx.sessionId, severity: "warn" });
            }
          }
          // A research task whose candidates were already filtered to research-capable agents
          // (above) must route to the REAL researcher even when the match score is weak — e.g.
          // a domain-specific routing query ("iSAQB CPSA-F curriculum exam format topics") or a
          // DOWN/unloaded embedding model scores every catalog agent ~0.25, which would
          // otherwise fall through to an architect-designed ephemeral that lacks share_finding
          // and loses its facts to the parent (audit 9b5196ad: embeddings unavailable →
          // bestAutoMatchScore 0.25 → ephemeral → starved build). A real research agent is
          // strictly better here than a fabricated one.
          const researchTaskHasCapableCandidate =
            taskRequiresExternalResearch(request.task) && agentIsResearchCapable(topCandidate.name);
          const shouldQueueRoutedCandidate = explicitAgentRequested
            || attemptedAgents.length > 0
            || researchTaskHasCapableCandidate
            || shouldPreferCatalogAgent(bestAutoMatchScore, bestAutoMatchConfidence, skillMatchThreshold);
          if (shouldQueueRoutedCandidate) {
            routingCandidateMap.set(topCandidate.name, {
              confidence: topCandidate.confidence,
              matchedTerms: topCandidate.matchedTerms,
              score: topCandidate.score,
            });
            candidateQueue.push(topCandidate.name);
          }
        }
      }

      // ── Step 2: autonomous bidding (last resort — 125ms window) ─────────
      // Only when semantic + structural routing came up empty. Bidding is the
      // correct fallback for tasks that require a dynamic peer-elected agent
      // not represented in the static catalog. (The keyword-driven coordinator
      // re-injection that used to sit here was removed — routing is purely
      // semantic + structural now.)
      if (candidateQueue.length === 0 && usesAutonomousBidding && isAutonomousBiddingStarted() && !biddingTried) {
        biddingTried = true;
        const rawBids = await collectTaskBids(taskId, DEFAULT_AUTONOMOUS_BID_WINDOW_MS);
        let bids = rawBids.filter((bid) => agentCanFulfillArtifactTask(bid.agentName, request.task, ctx));
        if (bids.length === 0 && rawBids.length > 0) {
          logAudit("delegation_bidding_filtered_artifact_incapable", {
            taskTitle: title,
            droppedAgents: rawBids.map((b) => b.agentName),
          }, { sessionId: ctx.sessionId });
        }
        // Same exclusion as semantic routing: a meta/factory agent must not win
        // an autonomous bid for ordinary work (audit c33e65dd).
        {
          const nonMetaBids = bids.filter((bid) => !agentIsMetaFactory(bid.agentName));
          if (nonMetaBids.length !== bids.length) {
            logAudit("delegation_bidding_filtered_meta_factory", {
              taskTitle: title,
              droppedAgents: bids.filter((bid) => agentIsMetaFactory(bid.agentName)).map((b) => b.agentName),
            }, { sessionId: ctx.sessionId });
          }
          bids = nonMetaBids;
        }
        // Same research-capability gate as semantic routing (Step 1): never let
        // bidding hand a source-sensitive task to a web-incapable generator.
        if (taskRequiresExternalResearch(request.task) && bids.length > 0) {
          const researchCapableBids = bids.filter((bid) => agentIsResearchCapable(bid.agentName));
          if (researchCapableBids.length === 0) {
            logAudit("delegation_bidding_filtered_research_incapable", {
              taskTitle: title,
              droppedAgents: bids.map((b) => b.agentName),
            }, { sessionId: ctx.sessionId });
          }
          bids = researchCapableBids;
        }
        // Same capability-aware gate as semantic routing: don't let a winning bid come
        // from an agent that lacks the execution tool class the task needs.
        if (bids.length > 1) {
          const capCfg = getConfig();
          const capPromoted = readPromotedAgents(capCfg.workspacePath);
          const { kept, dropped, capabilities } = filterCandidatesByExecutionCapability(
            bids.map((b) => b.agentName),
            request.task,
            (name) => capCfg.subAgents[name] ?? capPromoted[name],
          );
          if (dropped.length > 0) {
            logAudit("delegation_bidding_filtered_capability_incapable", {
              taskTitle: title,
              droppedAgents: dropped,
              capabilities,
            }, { sessionId: ctx.sessionId });
            bids = bids.filter((b) => kept.includes(b.agentName));
          }
        }
        bestAutoMatchScore = bids[0]?.score ?? bestAutoMatchScore;
        bestAutoMatchConfidence = bids[0]?.confidence as ("high" | "medium" | "low" | undefined) ?? bestAutoMatchConfidence;
        if (shouldPreferCatalogAgent(bestAutoMatchScore, bestAutoMatchConfidence, skillMatchThreshold)) {
          for (const bid of bids) {
            routingCandidateMap.set(bid.agentName, {
              confidence: bid.confidence,
              matchedTerms: bid.matchedTerms,
              score: bid.score,
            });
          }
          candidateQueue = uniqueNames(bids.map(bid => bid.agentName));
        }
      }

      if (candidateQueue.length === 0) break;
    }

    const candidate = candidateQueue.shift()!;
    if (attemptedAgents.includes(candidate)) continue;

    // Coordinator→coordinator block: a coordinator caller skips any coordinator
    // candidate so the hierarchy stays flat (coordinator → leaf specialist), instead
    // of nesting mission_coordinator under mission_coordinator. Skipped before the
    // attempt counter so it isn't recorded as a real attempt.
    if (callerIsCoordinator && agentNameIsCoordinator(candidate)) {
      if (!skippedCoordinatorCandidates.includes(candidate)) {
        skippedCoordinatorCandidates.push(candidate);
        logAudit("delegation_coordinator_recursion_blocked", {
          taskTitle: title,
          callerAgent: ctx.currentAgentName,
          blockedCandidate: candidate,
        }, { sessionId: ctx.sessionId, severity: "info" });
      }
      continue;
    }

    // Per-agent repeat cap: skip if this agent has already been called its allowed number of times this turn
    const prevCalls = ctx._turnAgentCounts.get(candidate) ?? 0;
    if (prevCalls >= getPerAgentDelegationLimit(ctx, candidate)) {
      // I12: Remember WHO got skipped so the failure path can produce an
      // honest "these agents are already maxed out for this turn"
      // diagnostic instead of pretending nothing matched.
      if (!cappedCandidates.includes(candidate)) {
        cappedCandidates.push(candidate);
      }
      continue;
    }
    ctx._turnAgentCounts.set(candidate, prevCalls + 1);

    attemptedAgents.push(candidate);

    if (ctx.allowedAgents && !ctx.allowedAgents.includes(candidate)) {
      continue;
    }

    const startedAt = new Date().toISOString();
    taskState.status = "running";
    taskState.selectedAgent = candidate;
    taskState.output = undefined;
    taskState.error = undefined;
    taskState.attempts.push({
      agentName: candidate,
      status: "running",
      startedAt,
    });
    ensureSwarmState(ctx, request.task).updatedAt = startedAt;
    publishSwarmState(ctx);

    emitSwarmEvent("task_claimed", { sessionId: ctx.sessionId, taskId, agentName: candidate, task: request.task });

    // Acquire a distributed lock so a re-queued broadcast of the same task can't
    // be double-claimed in a multi-instance deployment. Lock TTL = 30 s; released
    // on completion or failure.
    const lockOwner = await acquireTaskLock(taskId);

    const attempt = taskState.attempts[taskState.attempts.length - 1]!;
    const config = getConfig();
    const promotedAgents = readPromotedAgents(config.workspacePath);
    const agentCfg = config.subAgents[candidate] ?? promotedAgents[candidate];
    announceAgentCapability({
      sessionId: ctx.sessionId,
      agentName: candidate,
      domain: agentCfg?.domain,
      capabilities: agentCfg?.capabilities ?? [],
      tags: agentCfg?.tags ?? [],
      availability: "busy",
      activeTaskId: taskId,
      source: "runtime",
    });

    try {
      // Inject shared facts from other agents into this sub-agent's context
      const sharedCtx = await formatSharedContextForPrompt(ctx.sessionId, { agentName: candidate });
      const enrichedContext = sharedCtx
        ? `${sharedCtx}\n\n---\n\n${request.context ?? ""}`.trim()
        : request.context;

      const reusableSessionEvidence = await findReusableSessionEvidence(candidate, request, ctx, agentCfg);
      if (reusableSessionEvidence) {
        attempt.finishedAt = new Date().toISOString();
        attempt.status = "completed";
        attempt.summary = summarizeText(reusableSessionEvidence.output);
        attempt.toolCount = 0;
        attempt.iterations = 0;
        attempt.toolNames = [];
        finalizeAttemptBudget(ctx, taskState, attempt);
        taskState.status = "completed";
        taskState.output = reusableSessionEvidence.output;
        taskState.error = undefined;
        ensureSwarmState(ctx, request.task).updatedAt = attempt.finishedAt;
        publishSwarmState(ctx);
        emitSwarmEvent("task_completed", {
          sessionId: ctx.sessionId,
          taskId,
          agentName: candidate,
          data: {
            reusedSessionEvidence: true,
            factCount: reusableSessionEvidence.factCount,
            partialCount: reusableSessionEvidence.partialCount,
          },
        });
        announceAgentCapability({
          sessionId: ctx.sessionId,
          agentName: candidate,
          domain: agentCfg?.domain,
          capabilities: agentCfg?.capabilities ?? [],
          tags: agentCfg?.tags ?? [],
          availability: "idle",
          source: "runtime",
        });
        if (lockOwner) await releaseTaskLock(taskId, lockOwner);
        return {
          success: true,
          output: reusableSessionEvidence.output,
          metadata: {
            agentName: candidate,
            taskId,
            attemptedAgents,
            delegationSucceeded: true,
            reused: true,
            reusedFromSessionMemory: true,
            factCount: reusableSessionEvidence.factCount,
            partialCount: reusableSessionEvidence.partialCount,
          },
        };
      }

      // B7: Cross-agent context handoff — when this is a fallback agent (prior attempts
      // already exist), prepend a brief summary of what was tried so the new agent does
      // not repeat the same failing approaches. Pass as context (not task) so it goes
      // into the system prompt area and won't contaminate the agent's output text.
      let handoffContext = enrichedContext;
      const priorAttempts = taskState.attempts.slice(0, -1); // all but the one just pushed
      if (priorAttempts.length > 0) {
        const priorLines = priorAttempts.map((a) => {
          const status = a.status === "partial" ? "partial evidence" : "failed";
          // Omit the raw error summary to avoid accidentally leaking failure-detection
          // patterns into the new agent's context in a confusing way.
          return `  - ${a.agentName} (${status})`;
        });
        const handoffPrefix =
          `[PRIOR AGENT ACTIVITY]\n` +
          priorLines.join("\n") +
          "\nDo NOT repeat these exact approaches. Use a different strategy or source.\n";
        handoffContext = handoffPrefix + (enrichedContext ? `\n${enrichedContext}` : "");
      }

      const subAgentArgs = {
        agentName: candidate,
        task: request.task,
        taskTitle: request.taskTitle,
        context: handoffContext,
        parentSessionId: ctx.sessionId,
        workspacePath: ctx.workspacePath,
        userId: ctx.userId,
        allowedAgents: ctx.allowedAgents,
        signal: ctx.signal,
        approvalCallback: ctx.approvalCallback,
        onProgress: ctx.onSubAgentProgress,
        humanInLoopSteps: ctx.humanInLoopSteps,
        onComputerAction: ctx.onComputerAction,
        onComputerScreenshot: ctx.onComputerScreenshot,
        onComputerSessionState: ctx.onComputerSessionState,
        maxIterationsOverride: ctx.maxIterationsOverride,
        // Reserve synthesis headroom for the parent so a single slow sub-agent can't
        // consume the entire turn budget and leave nothing for finalize+deliver
        // (audit b6f8336e). Identity (= ctx.turnTimeoutOverrideMs) until the reserve
        // knob is set; soft deadline below derives from this same effective value.
        turnTimeoutOverrideMs: reserveSubAgentTimeout(
          ctx.turnTimeoutOverrideMs,
          getConfig().orchestration?.subAgentSynthesisReserveMs ?? 0,
        ),
        swarmState: ctx.swarmState,
        onSwarmState: ctx.onSwarmState,
        _turnAgentCounts: ctx._turnAgentCounts,
        _turnAgentRepeatLimitOverrides: ctx._turnAgentRepeatLimitOverrides,
        _turnTotalDelegationLimitOverride: ctx._turnTotalDelegationLimitOverride,
        _workflowExecutionStack: ctx._workflowExecutionStack,
        // D3: propagate the parent turn's absolute deadline so the specialist clamps its hard timeout
        // to the remaining budget (orchestration.clampSubAgentTimeoutToParent).
        _turnDeadlineMs: ctx._turnDeadlineMs,
        // E18: Soft deadline — give the specialist 70% of its effective timeout so
        // it starts wrapping up before the hard timeout fires.
        softDeadlineMs: (() => {
          // Derive from the SAME reserved budget as the hard timeout above so the soft
          // deadline (70%) stays proportional when a synthesis reserve is in effect.
          const reserved = reserveSubAgentTimeout(
            ctx.turnTimeoutOverrideMs,
            getConfig().orchestration?.subAgentSynthesisReserveMs ?? 0,
          );
          const raw = reserved ?? agentCfg?.turnTimeoutMs ?? 60_000;
          // "unbound" (no numeric budget) → push the soft deadline effectively
          // out of reach so it never fires for long-running agents.
          const effective = typeof raw === "number" ? raw : Number.MAX_SAFE_INTEGER;
          const softMs = Date.now() + Math.floor(effective * 0.70);
          // D3: don't let the wrap-up nudge land AFTER the parent turn's hard deadline (else it never
          // fires and the specialist is guillotined mid-flight). Clamp when the clamp flag is on.
          return (getConfig().orchestration?.clampSubAgentTimeoutToParent === true && typeof ctx._turnDeadlineMs === "number")
            ? Math.min(softMs, ctx._turnDeadlineMs)
            : softMs;
        })(),
      };

      let output: string;
      let stats: {
        toolCount: number;
        iterations: number;
        toolNames: string[];
        terminalState?: string;
        outcome?: string;
        usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
      } | undefined;
      let artifacts: Record<string, unknown>[] = [];

      if (typeof runSubAgentWithStats === "function") {
        const maybeResult = await runSubAgentWithStats(subAgentArgs);
        if (
          maybeResult
          && typeof maybeResult.output === "string"
          && maybeResult.stats
          && Array.isArray(maybeResult.stats.toolNames)
        ) {
          output = maybeResult.output;
          stats = maybeResult.stats;
          artifacts = Array.isArray(maybeResult.artifacts)
            ? maybeResult.artifacts.map((artifact) => ({ ...artifact }))
            : [];
        } else {
          output = await runSubAgent(subAgentArgs);
        }
      } else {
        output = await runSubAgent(subAgentArgs);
      }

      if (stats) {
        attempt.toolCount = stats.toolCount;
        attempt.iterations = stats.iterations;
        attempt.toolNames = [...stats.toolNames];
        if (stats.usage) {
          attempt.promptTokens = stats.usage.promptTokens;
          attempt.completionTokens = stats.usage.completionTokens;
          attempt.totalTokens = stats.usage.totalTokens;
        }
        if (stats.terminalState) {
          attempt.terminalState = stats.terminalState;
        }
      }

      let delegationOutcome = stats?.outcome;
      let parsedOutcome: any = null;
      const tagMatch = output.match(/<final_answer\s+status="([^"]+)">([\s\S]*?)<\/final_answer>/i);
      if (tagMatch) {
        parsedOutcome = { status: tagMatch[1]!.toLowerCase(), data: tagMatch[2]!.trim() };
      }

      if (parsedOutcome && parsedOutcome.status) {
        delegationOutcome = parsedOutcome.status;
        output = parsedOutcome.data || output;
      }

      // Delegation-boundary inline-app harvest (audit 1ac79471): a build delegation
      // "succeeds" with ZERO artifacts but pastes the complete app document into its
      // RESULT text (browser_agent dumped a 14KB <!DOCTYPE html> app inline because
      // its completion cap cut the write_file call). The expensive content exists —
      // write it NOW so the deliverable survives, instead of classifying around the
      // loss. Mirrors the runtime's corrective-build harvest one level down, covering
      // EVERY delegated builder.
      if (artifacts.length === 0 && WORKSPACE_MUTATION_TASK_RE.test(request.task.trim())) {
        const inlineDoc = extractInlineHtmlDocument(output);
        if (inlineDoc) {
          try {
            const harvestWrite = await executeTool("write_file", { path: "app/index.html", content: inlineDoc }, ctx);
            if (harvestWrite.success && harvestWrite.metadata) {
              const harvestComplete = looksLikeCompleteHtmlDocument(inlineDoc);
              artifacts.push({ sourceAgent: candidate, sourceTool: "write_file", ...harvestWrite.metadata });
              const writtenPath = typeof harvestWrite.metadata["outputPath"] === "string" ? harvestWrite.metadata["outputPath"] : "app/index.html";
              output = `${output.trim()}\n\n[INLINE DOCUMENT HARVESTED] The HTML document above was written to ${writtenPath} and attached as a real artifact${harvestComplete ? "" : " — NOTE: the document was cut off before its end, so the file is INCOMPLETE"}. Do not paste its code again; reference the file.`;
              logAudit("guardrail_flagged", {
                type: "delegation_inline_artifact_harvested",
                agentName: candidate,
                chars: inlineDoc.length,
                complete: harvestComplete,
              }, { sessionId: ctx.sessionId, severity: "warn" });
            }
          } catch (err) {
            log.warn({ err, agentName: candidate }, "Delegation-boundary inline-document harvest failed");
          }
        }
      }

      // D14: Consolidated classification — replaces the scattered acceptPartial /
      // coordinatorMicroCompletion / weak variables that used to live here.
      const classification = classifyDelegationResult(
        output, delegationOutcome, stats, agentCfg, candidate, request.task, artifacts,
      );
      const routingInfo = routingCandidateMap.get(candidate);

      attempt.finishedAt = new Date().toISOString();
      attempt.summary = summarizeText(output);
      finalizeAttemptBudget(ctx, taskState, attempt);

      if (classification !== "success" && classification !== "partial") {
        // "coordinator_noop", "failure", and "infrastructure_failure"
        // all continue to the next candidate.
        attempt.status = "failed";
        // When the sub-agent just narrated intent ("I'll create…", "Let me
        // start…") without calling any write/generate/exec tool, pasting that
        // narrative back to the orchestrator as the error message is actively
        // misleading — it reads like a partial answer and pushes the
        // orchestrator into retrying with the same wording. Replace it with a
        // structured reason that names what was missing so the orchestrator
        // can adjust its next move.
        const narrativeOnly = isNarrativeOnlyDeliverableFailure(
          classification, output, request.task, stats, agentCfg,
        );
        if (narrativeOnly) {
          const expectedTools = (agentCfg?.tools ?? []).filter((name) =>
            /^(?:write_file|edit_file|generate_|bundle_artifact|shell_exec|send_|post_|browser_)/.test(name)
          );
          const expectedHint = expectedTools.length > 0
            ? ` Expected the agent to call one of: ${expectedTools.slice(0, 4).join(", ")}.`
            : "";
          taskState.error = `Sub-agent '${candidate}' returned a narrative-only result (started planning, never executed any work tool).${expectedHint} Restate the task as a single direct instruction naming the concrete deliverable, or pick a different specialist.`;
        } else {
          taskState.error = output.trim().slice(0, 4000) || summarizeText(output);
        }
        taskState.status = "failed";
        lastFailureWasInfrastructure = classification === "infrastructure_failure";
        // Preserve substantive evidence from a failed/interrupted attempt so the
        // tail return surfaces it instead of "No suitable agent completed the
        // task." A research/timeout attempt that gathered real content (web
        // results, fetched pages) but got classified as failure — e.g. an operator
        // stop cut off its synthesis and left an interrupted-output stub — must NOT
        // be discarded. That discard is why audit 5a6db38d shipped a training-data
        // answer despite 31 min of real research. Skip pure failure stubs,
        // planning-only narration, and infrastructure failures.
        if (
          !lastFailureWasInfrastructure
          && output.trim().length > 200
          && (!bestPartialResult || output.length > bestPartialResult.output.length)
          && !looksLikeOnlyFailureStubs(output)
          && !looksLikePlanningOnlyResult(output)
          && !looksLikeInfrastructureFailure(output)
        ) {
          bestPartialResult = {
            agentName: candidate,
            output,
            ...(stats?.terminalState ? { terminalState: stats.terminalState } : {}),
            ...(routingInfo ? { routingInfo } : {}),
            ...(artifacts.length > 0 ? { artifacts } : {}),
          };
        }
        publishSwarmState(ctx);
        emitSwarmEvent("task_failed", {
          sessionId: ctx.sessionId,
          taskId,
          agentName: candidate,
          data: { reason: narrativeOnly ? "narrative_only" : "weak_result" },
        });
        announceAgentCapability({
          sessionId: ctx.sessionId,
          agentName: candidate,
          domain: agentCfg?.domain,
          capabilities: agentCfg?.capabilities ?? [],
          tags: agentCfg?.tags ?? [],
          availability: "degraded",
          activeTaskId: taskId,
          source: "runtime",
        });
        if (lockOwner) await releaseTaskLock(taskId, lockOwner);
        // Infrastructure failures cannot be solved by a different agent — stop immediately
        if (lastFailureWasInfrastructure) break;
        // Keystone (audit 687a224b): once a failed/timed-out attempt has STILL left
        // substantive, usable evidence (captured into bestPartialResult above), stop
        // escalating. Walking the rest of the candidate queue — especially into a
        // coordinator that re-decomposes and re-fans-out — cost that session 77 min and
        // a depth-2 coordinator recursion for a marginal gain over evidence we can
        // already synthesize from. Surface the partial via the tail return instead.
        // Only halt for a partial that carries real evidence — a bare max-iteration
        // notice (no findings) must still escalate (e.g. researcher → web_task_coordinator).
        if (bestPartialResult && partialResultHasSubstantiveEvidence(bestPartialResult.output)) {
          logAudit("delegation_halted_partial_evidence", {
            taskTitle: title,
            agentName: bestPartialResult.agentName,
            partialChars: bestPartialResult.output.length,
            remainingCandidates: candidateQueue.length,
          }, { sessionId: ctx.sessionId, severity: "info" });
          break;
        }
        continue;
      }

      // Store successful output as a partial result and extract any FACT: lines
      await appendPartialResult({
        sessionId: ctx.sessionId,
        taskId,
        agentName: candidate,
        content: `${summarizeText(output, 1200)}${formatArtifactReferencesForSharedContext(artifacts, getConfig().orchestration?.crossAgentArtifactReuse === true)}`.trim(),
        ts: attempt.finishedAt!,
      });
      const extractedFacts = extractFactsFromOutput(output);
      for (const [k, v] of Object.entries(extractedFacts)) {
        await writeSharedFact(ctx.sessionId, k, v);
        // Promote to durable graph node so facts outlive the 4h Redis TTL
        graphPromoteFact(k, v, candidate, ctx.sessionId).catch(() => {});
      }

      const partial = classification === "partial";
      attempt.status = partial ? "partial" : "completed";
      taskState.status = partial ? "partial" : "completed";
      taskState.output = output;
      taskState.error = undefined;
      ensureSwarmState(ctx, request.task).updatedAt = attempt.finishedAt;
      publishSwarmState(ctx);
      emitSwarmEvent(partial ? "task_partial" : "task_completed", { sessionId: ctx.sessionId, taskId, agentName: candidate });
      announceAgentCapability({
        sessionId: ctx.sessionId,
        agentName: candidate,
        domain: agentCfg?.domain,
        capabilities: agentCfg?.capabilities ?? [],
        tags: agentCfg?.tags ?? [],
        availability: "idle",
        source: "runtime",
      });
      if (lockOwner) await releaseTaskLock(taskId, lockOwner);

      const routingNote = routingInfo
        ? `\n↳ Auto-routed to ${candidate} (${routingInfo.confidence} confidence${routingInfo.matchedTerms.length > 0 ? `, matched: ${routingInfo.matchedTerms.join(", ")}` : ""})`
        : "";
      return {
        success: true,
        output: `[${candidate}]: ${output}${routingNote}`,
        metadata: {
          agentName: candidate,
          taskId,
          attemptedAgents,
          delegationSucceeded: true,
          delegationOutcome: delegationOutcome ?? "success",
          // Mark runtime-authored research slices: their output is synthesis
          // INPUT (evidence), never a verbatim-relayable final deliverable.
          ...(isCanonicalResearchSliceTask(request.task) ? { researchSlice: true } : {}),
          ...(artifacts.length > 0 ? { artifacts } : {}),
          ...(stats?.terminalState ? { terminalState: stats.terminalState } : {}),
          ...(routingInfo && { routingReason: { confidence: routingInfo.confidence, matchedTerms: routingInfo.matchedTerms, score: routingInfo.score } }),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      attempt.finishedAt = new Date().toISOString();
      attempt.status = "failed";
      attempt.summary = summarizeText(message);
      finalizeAttemptBudget(ctx, taskState, attempt);
      taskState.status = "failed";
      taskState.error = summarizeText(message);
      ensureSwarmState(ctx, request.task).updatedAt = attempt.finishedAt;
      publishSwarmState(ctx);
      emitSwarmEvent("task_failed", { sessionId: ctx.sessionId, taskId, agentName: candidate, data: { error: message } });
      announceAgentCapability({
        sessionId: ctx.sessionId,
        agentName: candidate,
        domain: agentCfg?.domain,
        capabilities: agentCfg?.capabilities ?? [],
        tags: agentCfg?.tags ?? [],
        availability: "degraded",
        activeTaskId: taskId,
        source: "runtime",
      });
      if (lockOwner) await releaseTaskLock(taskId, lockOwner);
    }
  }

  // ── Architect fallback ────────────────────────────────────────────────────
  // When routing found zero candidates (no agent was even tried), ask the LLM
  // architect to design a purpose-built ephemeral agent for this task.
  // Skip architect if the failure was infrastructure-level (host unreachable, etc.) —
  // an ephemeral agent would face the exact same connectivity problem.
  if (
    !explicitAgentRequested
    && !lastFailureWasInfrastructure
    && !longRunningGenerationManager.isStopRequested(ctx.sessionId)
    // Honor the substantive-partial-evidence keystone above: once an attempt
    // left real usable evidence, do NOT escalate to an architect-built
    // ephemeral either. The ephemeral starts cold, scopes itself from whatever
    // shared facts are most recent (audit b5107ae4: it re-researched ONLY the
    // TP4056 charger out of a whole device design), and its result then
    // REPLACES the broader partial evidence at the return below. Surface the
    // partial via the tail return instead — the orchestrator synthesizes from it.
    && !(bestPartialResult && partialResultHasSubstantiveEvidence(bestPartialResult.output))
    && (attemptedAgents.length === 0 || shouldGenerateEphemeralAgent(bestAutoMatchScore, skillMatchThreshold))
  ) {
    const architectResult = await runArchitectFallback(request.task, ctx);
    if (architectResult) {
      clearTaskBids(taskId);
      if (architectResult.success || !bestPartialResult) {
        taskState.status = architectResult.success ? "completed" : "failed";
        taskState.output = architectResult.success ? architectResult.output : undefined;
        taskState.error = architectResult.success ? undefined : architectResult.error;
        ensureSwarmState(ctx, request.task).updatedAt = new Date().toISOString();
        publishSwarmState(ctx);
        return {
          ...architectResult,
          metadata: { ...architectResult.metadata, taskId, attemptedAgents, skillMatchThreshold, bestAutoMatchScore, delegationSucceeded: architectResult.success },
        };
      }
    }
  }

  if (bestPartialResult) {
    clearTaskBids(taskId);
    taskState.status = "partial";
    taskState.selectedAgent = bestPartialResult.agentName;
    taskState.output = bestPartialResult.output;
    taskState.error = undefined;
    ensureSwarmState(ctx, request.task).updatedAt = new Date().toISOString();
    publishSwarmState(ctx);

    const routingNote = bestPartialResult.routingInfo
      ? `\n↳ Auto-routed to ${bestPartialResult.agentName} (${bestPartialResult.routingInfo.confidence} confidence${bestPartialResult.routingInfo.matchedTerms.length > 0 ? `, matched: ${bestPartialResult.routingInfo.matchedTerms.join(", ")}` : ""})`
      : "";
    return {
      success: true,
      output: `[${bestPartialResult.agentName}]: ${bestPartialResult.output}${routingNote}`,
      metadata: {
        agentName: bestPartialResult.agentName,
        taskId,
        attemptedAgents,
        delegationSucceeded: true,
        delegationOutcome: "partial",
        partialFallback: true,
        ...(isCanonicalResearchSliceTask(request.task) ? { researchSlice: true } : {}),
        ...(bestPartialResult.artifacts?.length ? { artifacts: bestPartialResult.artifacts } : {}),
        ...(bestPartialResult.terminalState ? { terminalState: bestPartialResult.terminalState } : {}),
        ...(bestPartialResult.routingInfo
          ? {
            routingReason: {
              confidence: bestPartialResult.routingInfo.confidence,
              matchedTerms: bestPartialResult.routingInfo.matchedTerms,
              score: bestPartialResult.routingInfo.score,
            },
          }
          : {}),
      },
    };
  }

  taskState.status = "failed";
  taskState.error = taskState.error ?? "No suitable agent completed the task.";
  clearTaskBids(taskId);
  ensureSwarmState(ctx, request.task).updatedAt = new Date().toISOString();
  publishSwarmState(ctx);

  // I9: Surface timeout cascades explicitly. When every attempt in this
  // delegation hit `terminalState === "timeout"`, the operator's per-agent
  // `turnTimeoutMs` is too tight for the chosen model to finish the work,
  // not a routing failure. Append (don't replace) so the rich per-attempt
  // diagnostic text from the sub-agent (e.g. "Partial progress before
  // interruption: ...") is preserved for the coordinator and audit log.
  const timeoutAttempts = taskState.attempts.filter((a) => a.terminalState === "timeout");
  const allAttemptsTimedOut = taskState.attempts.length > 0
    && timeoutAttempts.length === taskState.attempts.length;
  // I12: When every routed candidate was skipped due to the per-agent
  // delegation cap, that's the actual cause of failure — not routing.
  // Tell the coordinator plainly so it stops re-delegating the same work.
  const allCandidatesCapped = taskState.attempts.length === 0
    && cappedCandidates.length > 0;
  // A coordinator whose every routed candidate was ANOTHER coordinator (and so
  // got coordinator→coordinator-blocked) with no leaf specialist ever attempted.
  // Without an explicit diagnostic this falls to the generic "No suitable agent"
  // message, which reads as a routing miss and makes the coordinator re-decompose
  // and try again — the recursion-blocked re-delegation loop in audit 4db1f294
  // (mission_coordinator kept re-firing parallel_delegate for ~5 min, every
  // candidate blocked, the turn never synthesized). Tell it plainly to stop.
  const allCandidatesCoordinatorBlocked = taskState.attempts.length === 0
    && cappedCandidates.length === 0
    && skippedCoordinatorCandidates.length > 0;
  const baseError = taskState.error ?? "No suitable agent completed the task.";
  let errorBody = baseError;
  if (allAttemptsTimedOut) {
    errorBody = `${baseError}\n\nTimeout cascade: every delegated attempt hit its per-agent turnTimeoutMs (${timeoutAttempts.length} attempt(s) on ${[...new Set(timeoutAttempts.map((a) => a.agentName))].join(", ")}). The model did not finish within the configured budget — this is a timeout, not a routing failure. Either raise turnTimeoutMs for these agents in starlingai.json, switch them to a faster model, or split the task into smaller pieces. Do NOT re-delegate the same work in this turn.`;
  } else if (allCandidatesCapped) {
    errorBody = `Per-agent delegation cap exhausted: every routed candidate (${cappedCandidates.join(", ")}) has already been delegated to its per-turn maximum (${DEFAULT_MAX_AGENT_CALLS_PER_TURN} call(s)) earlier in this turn. This is NOT a routing failure — the same agents already ran for this work. Stop re-delegating to them. Either accept what those earlier delegations returned (look back at the prior parallel_delegate / delegate_to_agent results in this conversation), or escalate the task back to the user with what you have.`;
  } else if (allCandidatesCoordinatorBlocked) {
    errorBody = `Coordinator hierarchy dead-end: you are a coordinator (${ctx.currentAgentName ?? "coordinator"}) and every routed candidate for this task is itself a coordinator (${skippedCoordinatorCandidates.join(", ")}), which is blocked so the hierarchy stays flat — no leaf specialist ran. This is NOT a routing failure and re-delegating will hit the same wall. Either delegate to a LEAF specialist by explicit agentName (e.g. researcher, content_writer, coder), or — preferred when findings already exist — STOP delegating and write your final answer from the shared facts gathered this turn (call read_shared_facts first). Do NOT re-delegate this task to another coordinator.`;
  }

  return {
    success: false,
    output: "",
    error: buildDelegationFailureMessage(title, errorBody),
    metadata: {
      taskId,
      attemptedAgents,
      delegationSucceeded: false,
      ...(allAttemptsTimedOut
        ? {
          delegationOutcome: "timeout_cascade",
          timeoutCascade: true,
          timedOutAgents: [...new Set(timeoutAttempts.map((a) => a.agentName))],
        }
        : {}),
      ...(allCandidatesCapped
        ? {
          delegationOutcome: "per_agent_cap_exhausted",
          perAgentCapExhausted: true,
          cappedCandidates: [...cappedCandidates],
        }
        : {}),
      ...(allCandidatesCoordinatorBlocked
        ? {
          delegationOutcome: "coordinator_hierarchy_dead_end",
          coordinatorHierarchyDeadEnd: true,
          blockedCoordinators: [...skippedCoordinatorCandidates],
        }
        : {}),
    },
  };
}

function formatSwarmState(state: SwarmState): string {
  const tasks = Object.values(state.tasks);
  if (tasks.length === 0) {
    return `Objective: ${state.objective}\nNo swarm tasks recorded yet.`;
  }

  const lines = tasks.map((task) => {
    const attempts = task.attempts
      .map((attempt) => {
        const flag = attempt.budgetExceeded ? `!budget(${(attempt.budgetBreaches ?? []).join("/")})` : "";
        return `${attempt.agentName}:${attempt.status}${flag ? ` ${flag}` : ""}`;
      })
      .join(", ");
    const totals = task.totals
      ? ` | totals: ${task.totals.totalTokens}tok, ${task.totals.toolCount}tools, ${task.totals.durationMs}ms`
      : "";
    return `- ${task.id} [${task.status}] ${task.title}${task.selectedAgent ? ` via ${task.selectedAgent}` : ""}${attempts ? ` | attempts: ${attempts}` : ""}${totals}`;
  });

  return `Objective: ${state.objective}\nUpdated: ${state.updatedAt}\nTasks:\n${lines.join("\n")}`;
}

function formatSwarmBudget(state: SwarmState): { output: string; metadata: Record<string, unknown> } {
  const tasks = Object.values(state.tasks);
  const budgets = getTaskBudgets();

  const overall = {
    attempts: 0,
    toolCount: 0,
    iterations: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    durationMs: 0,
  };
  const perAgent = new Map<string, typeof overall>();
  const breachedAttempts: Array<{ taskId: string; agentName: string; breaches: string[]; totalTokens: number; toolCount: number; durationMs: number }> = [];

  for (const task of tasks) {
    if (task.totals) {
      overall.attempts += task.totals.attempts;
      overall.toolCount += task.totals.toolCount;
      overall.iterations += task.totals.iterations;
      overall.promptTokens += task.totals.promptTokens;
      overall.completionTokens += task.totals.completionTokens;
      overall.totalTokens += task.totals.totalTokens;
      overall.durationMs += task.totals.durationMs;
    }
    for (const a of task.attempts) {
      const slot = perAgent.get(a.agentName) ?? {
        attempts: 0, toolCount: 0, iterations: 0,
        promptTokens: 0, completionTokens: 0, totalTokens: 0, durationMs: 0,
      };
      slot.attempts += 1;
      slot.toolCount += a.toolCount ?? 0;
      slot.iterations += a.iterations ?? 0;
      slot.promptTokens += a.promptTokens ?? 0;
      slot.completionTokens += a.completionTokens ?? 0;
      slot.totalTokens += a.totalTokens ?? 0;
      slot.durationMs += a.durationMs ?? 0;
      perAgent.set(a.agentName, slot);

      if (a.budgetExceeded) {
        breachedAttempts.push({
          taskId: task.id,
          agentName: a.agentName,
          breaches: a.budgetBreaches ?? [],
          totalTokens: a.totalTokens ?? 0,
          toolCount: a.toolCount ?? 0,
          durationMs: a.durationMs ?? 0,
        });
      }
    }
  }

  const lines: string[] = [];
  lines.push(`Objective: ${state.objective}`);
  lines.push(`Tasks tracked: ${tasks.length}`);
  lines.push("");
  lines.push("## Configured per-task budgets");
  lines.push(`- maxTokensPerTask: ${budgets.tokens > 0 ? budgets.tokens : "(unset)"}`);
  lines.push(`- maxToolCallsPerTask: ${budgets.toolCalls > 0 ? budgets.toolCalls : "(unset)"}`);
  lines.push(`- maxDurationMsPerTask: ${budgets.durationMs > 0 ? budgets.durationMs : "(unset)"}`);
  lines.push("");
  lines.push("## Overall totals");
  lines.push(`- attempts: ${overall.attempts}`);
  lines.push(`- iterations: ${overall.iterations}`);
  lines.push(`- toolCount: ${overall.toolCount}`);
  lines.push(`- promptTokens: ${overall.promptTokens}`);
  lines.push(`- completionTokens: ${overall.completionTokens}`);
  lines.push(`- totalTokens: ${overall.totalTokens}`);
  lines.push(`- durationMs: ${overall.durationMs}`);
  lines.push("");
  lines.push("## Per-agent breakdown");
  if (perAgent.size === 0) {
    lines.push("- (no attempts recorded yet)");
  } else {
    const sorted = [...perAgent.entries()].sort((a, b) => b[1].totalTokens - a[1].totalTokens);
    for (const [agent, totals] of sorted) {
      lines.push(`- ${agent}: ${totals.attempts} attempts, ${totals.totalTokens}tok, ${totals.toolCount}tools, ${totals.durationMs}ms`);
    }
  }
  lines.push("");
  lines.push("## Budget breaches");
  if (breachedAttempts.length === 0) {
    lines.push("- (none)");
  } else {
    for (const b of breachedAttempts) {
      lines.push(`- task ${b.taskId} via ${b.agentName}: ${b.breaches.join(", ")} | ${b.totalTokens}tok, ${b.toolCount}tools, ${b.durationMs}ms`);
    }
  }

  return {
    output: lines.join("\n"),
    metadata: {
      budgets,
      overall,
      perAgent: Object.fromEntries(perAgent),
      breaches: breachedAttempts,
    },
  };
}

function validateTaskGraphNodes(nodes: TaskGraphNodeInput[]): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();

  for (const node of nodes) {
    if (!node.id?.trim()) issues.push("Each task-graph node needs a non-empty id.");
    if (ids.has(node.id)) issues.push(`Duplicate task-graph node id: ${node.id}`);
    ids.add(node.id);
    if (!node.task?.trim()) issues.push(`Task-graph node '${node.id}' is missing its task.`);
  }

  for (const node of nodes) {
    for (const dep of node.dependsOn ?? []) {
      if (!ids.has(dep)) issues.push(`Task-graph node '${node.id}' depends on unknown node '${dep}'.`);
      if (dep === node.id) issues.push(`Task-graph node '${node.id}' cannot depend on itself.`);
    }
  }

  return issues;
}

registerTool({
  name: "get_swarm_state",
  description: "Read the current turn-local swarm state, including tracked sub-tasks, statuses, attempts, and selected agents.",
  parameters: {
    type: "object",
    properties: {},
  },
  async execute(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const state = ensureSwarmState(ctx, "Current turn");
    publishSwarmState(ctx);
    return {
      success: true,
      output: formatSwarmState(state),
      metadata: { swarmState: state },
    };
  },
});

registerTool({
  name: "get_swarm_budget",
  description: "Aggregate token, tool-call, and wall-clock spending across all swarm tasks this turn. Shows configured per-task budgets, overall totals, per-agent breakdown, and any attempts that breached a budget.",
  parameters: {
    type: "object",
    properties: {},
  },
  async execute(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const state = ensureSwarmState(ctx, "Current turn");
    const { output, metadata } = formatSwarmBudget(state);
    return {
      success: true,
      output,
      metadata,
    };
  },
});

registerTool({
  name: "run_task_graph",
  description: "Execute a dependency-aware swarm task graph. Ready nodes run in parallel, dependent nodes wait for prerequisites, and failed nodes can fall back to alternative agents.",
  parameters: {
    type: "object",
    properties: {
      objective: {
        type: "string",
        description: "Optional swarm objective label for the graph run.",
      },
      nodes: {
        type: "array",
        description: "Task graph nodes with ids, dependencies, agent selection, and optional fallback agents.",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            agentName: { type: "string" },
            task: { type: "string" },
            context: { type: "string" },
            dependsOn: { type: "array", items: { type: "string" } },
            fallbackAgents: { type: "array", items: { type: "string" } },
            routingQuery: { type: "string" },
            skillMatchThreshold: { type: "number" },
          },
          required: ["id", "task"],
        },
      },
    },
    required: ["nodes"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const rawNodes = Array.isArray(args["nodes"]) ? args["nodes"] as TaskGraphNodeInput[] : [];
    if (rawNodes.length === 0) {
      return { success: false, output: "", error: "nodes array must not be empty" };
    }
    if (rawNodes.length > 8) {
      return { success: false, output: "", error: "Task graphs are limited to 8 nodes per turn" };
    }

    const issues = validateTaskGraphNodes(rawNodes);
    if (issues.length > 0) {
      return { success: false, output: "", error: issues.join(" ") };
    }

    const swarmState = ensureSwarmState(ctx, String(args["objective"] ?? "Swarm task graph"));
    swarmState.objective = String(args["objective"] ?? swarmState.objective);
    publishSwarmState(ctx);

    const delegatedCtx = withDelegationFanoutAllowance(ctx, rawNodes.map((node) => node.agentName), rawNodes.length);

    const remaining = new Map(rawNodes.map((node) => [node.id, node]));
    const completed = new Set<string>();
    const failed = new Set<string>();
    const blocked = new Set<string>();
    // Accumulate artifacts each node's sub-agent produced so the graph surfaces
    // them as downloads on the parent turn (same propagation gap as
    // parallel_delegate — see that handler). Without this a graph whose final
    // node BUILT a file ships no download and the honesty guards see 0 produced.
    const graphArtifacts: Record<string, unknown>[] = [];
    const graphId = `graph_${Date.now()}_${Object.keys(swarmState.tasks).length}`;

    for (const node of rawNodes) {
      getOrCreateSwarmTask(ctx, node.id, node.title ?? summarizeText(node.task, 80), node.dependsOn ?? []);
    }

    // Emit graph-level lifecycle event
    emitSwarmEvent("graph_started", {
      sessionId: ctx.sessionId,
      taskId: graphId,
      task: String(args["objective"] ?? "Swarm task graph"),
      data: {
        nodeCount: rawNodes.length,
        nodeIds: rawNodes.map(n => n.id),
      },
    });

    // Durable node reuse (orchestration.durableTaskGraph): satisfy nodes a prior run of
    // this session already completed (structural hash match) from the ledger instead of
    // re-executing them. Conservative by construction — only ever SKIPS work that already
    // succeeded; downstream context still flows from the original run's shared facts.
    const durableLedgerEnabled = effectiveOrchestration().durableTaskGraph;
    const durableLedger = durableLedgerEnabled ? await readTaskGraphLedger(ctx.sessionId) : {};
    const nodeLedgerKeys = new Map(rawNodes.map((node) => [node.id, computeTaskGraphNodeKey(node)]));
    const reused = new Set<string>();
    if (durableLedgerEnabled) {
      for (const node of rawNodes) {
        const hit = durableLedger[nodeLedgerKeys.get(node.id)!];
        if (!hit) continue;
        remaining.delete(node.id);
        completed.add(node.id);
        reused.add(node.id);
        const task = getOrCreateSwarmTask(ctx, node.id, node.title ?? summarizeText(node.task, 80), node.dependsOn ?? []);
        task.status = "completed";
        task.output = hit.output;
        for (const artifact of hit.artifacts ?? []) {
          graphArtifacts.push(artifact);
        }
        // Re-hydrate the shared channel for the reused node, exactly as a fresh execution would
        // (appendPartialResult + FACT extraction). Without this, a downstream dependent that is
        // NOT reused (its task text changed) re-executes with the reused node's output missing from
        // its context — the injected partial-results window is only the last few and the original
        // partial can have scrolled out — producing an ungrounded answer while the graph reports
        // success. This makes reuse indistinguishable from re-execution for downstream context.
        await appendPartialResult({
          sessionId: ctx.sessionId,
          taskId: node.id,
          agentName: node.agentName ?? hit.nodeId,
          content: summarizeText(hit.output, 1200),
          ts: hit.completedAt,
        });
        for (const [k, v] of Object.entries(extractFactsFromOutput(hit.output))) {
          await writeSharedFact(ctx.sessionId, k, v);
          graphPromoteFact(k, v, node.agentName ?? hit.nodeId, ctx.sessionId).catch(() => {});
        }
        emitSwarmEvent("graph_node_reused", {
          sessionId: ctx.sessionId,
          taskId: node.id,
          data: { graphId, completedAt: hit.completedAt },
        });
        logAudit("delegation_result_reused", {
          graphId,
          nodeId: node.id,
          source: "task_graph_ledger",
          completedAt: hit.completedAt,
        }, { sessionId: ctx.sessionId, severity: "info" });
      }
      if (reused.size > 0) publishSwarmState(ctx);
    }

    const active = new Map<string, Promise<{ node: TaskGraphNodeInput; result: ToolResult }>>();

    const blockFailedDependents = () => {
      for (const [nodeId, node] of [...remaining.entries()]) {
        if ((node.dependsOn ?? []).some((dep) => failed.has(dep) || blocked.has(dep))) {
          const task = getOrCreateSwarmTask(ctx, nodeId, node.title ?? summarizeText(node.task, 80), node.dependsOn ?? []);
          task.status = "blocked";
          task.error = "Blocked by failed dependency.";
          publishSwarmState(ctx);
          blocked.add(nodeId);
          remaining.delete(nodeId);

          emitSwarmEvent("graph_node_blocked", {
            sessionId: ctx.sessionId,
            taskId: nodeId,
            data: { graphId, reason: "dependency_failed" },
          });
        }
      }
    };

    const startReadyNodes = () => {
      const ready = [...remaining.values()].filter((node) => (node.dependsOn ?? []).every((dep) => completed.has(dep)));

      for (const node of ready) {
        remaining.delete(node.id);

        emitSwarmEvent("graph_node_ready", {
          sessionId: ctx.sessionId,
          taskId: node.id,
          agentName: node.agentName,
          task: node.task,
          data: {
            graphId,
            dependsOn: node.dependsOn ?? [],
            completedDeps: [...completed],
          },
        });

        active.set(node.id, executeDelegationWithFallback({
          agentName: node.agentName,
          task: node.task,
          context: node.context,
          fallbackAgents: node.fallbackAgents,
          routingQuery: node.routingQuery,
          skillMatchThreshold: node.skillMatchThreshold,
          taskId: node.id,
          taskTitle: node.title,
          dependsOn: node.dependsOn,
        }, delegatedCtx).then((result) => ({ node, result })));
      }
    };

    while (remaining.size > 0 || active.size > 0) {
      blockFailedDependents();

      if (active.size === 0) {
        startReadyNodes();
      }

      if (active.size === 0) {
        if (remaining.size === 0) {
          break;
        }

        for (const [nodeId, node] of remaining.entries()) {
          const task = getOrCreateSwarmTask(ctx, nodeId, node.title ?? summarizeText(node.task, 80), node.dependsOn ?? []);
          task.status = "blocked";
          task.error = task.error ?? "Task graph could not make progress; check dependencies for cycles.";
          publishSwarmState(ctx);
          blocked.add(nodeId);

          emitSwarmEvent("graph_node_blocked", {
            sessionId: ctx.sessionId,
            taskId: nodeId,
            data: { graphId, reason: "cycle_detected" },
          });
        }
        remaining.clear();
        break;
      }

      const { node, result } = await Promise.race(active.values());
      active.delete(node.id);

      if (result.success) {
        completed.add(node.id);
        const arts = result.metadata?.["artifacts"];
        const nodeArtifacts: Record<string, unknown>[] = [];
        if (Array.isArray(arts)) {
          for (const artifact of arts) {
            if (artifact && typeof artifact === "object") {
              graphArtifacts.push(artifact as Record<string, unknown>);
              nodeArtifacts.push(artifact as Record<string, unknown>);
            }
          }
        }
        if (durableLedgerEnabled) {
          await recordCompletedTaskGraphNode(ctx.sessionId, nodeLedgerKeys.get(node.id)!, {
            nodeId: node.id,
            output: result.output,
            completedAt: new Date().toISOString(),
            ...(nodeArtifacts.length > 0 ? { artifacts: nodeArtifacts } : {}),
          });
        }
      } else {
        failed.add(node.id);
      }

      blockFailedDependents();
      startReadyNodes();
    }

    // Emit graph completion event
    emitSwarmEvent("graph_completed", {
      sessionId: ctx.sessionId,
      taskId: graphId,
      data: {
        completedNodes: [...completed],
        failedNodes: [...failed],
        blockedNodes: [...blocked],
        success: failed.size === 0,
      },
    });

    const summary = rawNodes.map((node) => {
      const task = swarmState.tasks[node.id];
      const reusedMark = reused.has(node.id) ? " (reused prior completed result)" : "";
      return `- ${node.id} [${task?.status ?? "unknown"}] ${task?.selectedAgent ?? node.agentName ?? "unassigned"}${reusedMark}`;
    }).join("\n");

    return {
      success: failed.size === 0,
      output: `Swarm task graph complete.\n${summary}\n\n${formatSwarmState(swarmState)}`,
      metadata: {
        completed: [...completed],
        failed: [...failed],
        blocked: [...blocked],
        ...(reused.size > 0 ? { reused: [...reused] } : {}),
        swarmState,
        ...(graphArtifacts.length > 0 ? { artifacts: graphArtifacts } : {}),
      },
    };
  },
});

// ─── list_agents ──────────────────────────────────────────────────────────────
// IMPORTANT: list_agents now requires a query and routes through the same
// semantic + keyword engine as search_agents. It never dumps the full catalog.
// This prevents context bloat when the agent registry is large (56+ agents
// → 70 KB of text → LLM prefill timeout). Use search_agents when you only
// want the top match; use list_agents when you want up to 10 candidates for
// manual selection. Both tools require a query.

registerTool({
  name: "list_agents",
  description: "Search available sub-agents by semantic capability match and return up to 10 candidates — use this when you need to browse several candidates before choosing. Requires a natural-language query describing the task. NEVER dumps the full catalog. Prefer search_agents when you only need the single best match.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Natural-language description of the task or capability you need. Required — the tool does semantic search, not a flat dump.",
      },
    },
    required: ["query"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const raw = String(args["query"] ?? "").trim();
    if (!raw) {
      return {
        success: false,
        output: "",
        error: "query is required. Describe the task or capability you need — list_agents searches semantically, it does not dump the full catalog. Use search_agents for a single best-match lookup.",
      };
    }

    // Route through the same semantic+keyword engine as search_agents but
    // return up to 10 candidates and use "low" as minimum confidence so
    // browse-mode callers see the full competitive set.
    const resolution = await resolveAgentRouting(raw, {
      minConfidence: "low",
      excludeAgents: ctx.currentAgentName ? [ctx.currentAgentName] : undefined,
      allowedAgents: ctx.allowedAgents,
      allowKeywordFallback: false,
    });
    const semanticMetadata = buildSemanticRoutingMetadata(resolution);
    const semanticUnavailableNote = formatSemanticUnavailableNote(semanticMetadata);

    const allCandidates = [
      ...resolution.results,
      ...resolution.weakCandidates,
    ].slice(0, 10);

    if (allCandidates.length === 0) {
      const scopeNote = ctx.allowedAgents
        ? ` (this scene restricts delegation to: ${ctx.allowedAgents.join(", ")})`
        : "";
      return {
        success: true,
        output: `No agents matched "${raw}"${scopeNote}.${semanticUnavailableNote} Use create_ephemeral_agent to build a purpose-built specialist for this task.`,
        metadata: {
          query: raw,
          resultCount: 0,
          routingMode: resolution.mode,
          ...semanticMetadata,
        },
      };
    }

    const circuitNote = resolution.trippedAgents.length > 0
      ? `\n\n⚠ Circuit-open agents excluded from results: ${resolution.trippedAgents.join(", ")}`
      : "";

    const topCandidate = allCandidates[0];
    const topIsStrong = topCandidate &&
      (topCandidate.confidence === "high" ||
        (topCandidate.confidence === "medium" && topCandidate.score >= 0.5));
    const nextActionLine = topIsStrong
      ? `➡ NEXT ACTION: Call delegate_to_agent(agentName="${topCandidate.name}", task="<your task>") NOW.`
      : `ℹ Review the candidates below and pick the most relevant, or use create_ephemeral_agent if none fit.`;

    return {
      success: true,
      output: `${nextActionLine}\n\nAgents matching "${raw}" [${resolution.mode} search, ${allCandidates.length} result(s)]:${semanticUnavailableNote}\n\n${allCandidates.map(formatRoutingCandidate).join("\n\n")}${circuitNote}`,
      metadata: {
        query: raw,
        resultCount: allCandidates.length,
        routingMode: resolution.mode,
        topResult: allCandidates[0]?.name ?? null,
        ...semanticMetadata,
      },
    };
  },
});

// ─── agent_catalog ────────────────────────────────────────────────────────────
// Flat capability directory — answers "what agents exist and what can they do".
// Unlike search_agents/list_agents (semantic, query-required, never dump), this
// enumerates the whole catalog. For discovery/answering, NOT for routing.

registerTool({
  name: "agent_catalog",
  description:
    "List ALL configured specialist sub-agents with their capabilities — a flat directory that answers "
    + "\"what agents are available and what can each do\". Read-only and query-free (unlike search_agents / "
    + "list_agents, which require a query and never dump the catalog). Use this to tell the user what the swarm "
    + "can do; do NOT use it to route work (use delegate_to_agent / search_agents for routing). Optional `filter` "
    + "narrows by a case-insensitive substring over name, description, capability, or tag.",
  embeddingDescription:
    "list all available agents and what they can do; full agent catalog or directory; which specialists exist; "
    + "agent capabilities overview; alle Agenten auflisten, welche Agenten gibt es und was koennen sie",
  parameters: {
    type: "object",
    properties: {
      filter: { type: "string", description: "Optional case-insensitive substring to filter agents by name, description, capability, or tag." },
    },
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const config = getConfig();
    const promoted = readPromotedAgents(config.workspacePath);
    const all: Record<string, import("../config/schema.js").SubAgentConfig> = { ...config.subAgents, ...promoted };
    const filter = typeof args["filter"] === "string" ? args["filter"].trim().toLowerCase() : "";

    const entries = Object.keys(all)
      .filter((name) => name !== ctx.currentAgentName)
      .sort()
      .map((name) => ({ name, cfg: all[name]! }))
      .filter(({ name, cfg }) => {
        if (!filter) return true;
        const hay = `${name} ${cfg.description ?? ""} ${(cfg.capabilities ?? []).join(" ")} ${(cfg.tags ?? []).join(" ")}`.toLowerCase();
        return hay.includes(filter);
      });

    if (entries.length === 0) {
      return {
        success: true,
        output: filter ? `No agents match "${String(args["filter"])}".` : "No specialist agents are configured.",
        metadata: { count: 0 },
      };
    }

    // Keep the full-catalog dump compact enough to survive the tool-result relay
    // cap (56 agents × a fat block overflows). Show capabilities only for small/
    // filtered result sets; otherwise one tight line per agent (the first
    // sentence of the description) and a hint to filter for detail.
    const detailed = entries.length <= 15;
    const firstSentence = (text: string): string => {
      const clean = (text ?? "").replace(/\s+/g, " ").trim();
      const dot = clean.indexOf(". ");
      return (dot > 0 ? clean.slice(0, dot + 1) : clean).slice(0, detailed ? 220 : 120);
    };
    const lines = entries.map(({ name, cfg }) => {
      const desc = firstSentence(cfg.description ?? "");
      const promotedTag = promoted[name] ? " (promoted)" : "";
      const caps = detailed ? (cfg.capabilities ?? []).slice(0, 8).join(", ") : "";
      return `- **${name}**${promotedTag} — ${desc}${caps ? `\n  capabilities: ${caps}` : ""}`;
    });

    const hint = detailed ? "" : "\n\n(Showing one line each — call agent_catalog with a `filter` to see full capabilities for a subset.)";
    return {
      success: true,
      output: `${entries.length} specialist agent(s)${filter ? ` matching "${String(args["filter"])}"` : ""}:\n\n${lines.join("\n")}${hint}`,
      metadata: { count: entries.length, agents: entries.map((e) => e.name) },
    };
  },
});

// ─── search_agents ────────────────────────────────────────────────────────────
// Semantic discovery over agent capabilities — keeps orchestrator context small
// when the agent registry grows large.

registerTool({
  name: "search_agents",
  description: "Search available sub-agents by semantic capability match. Returns only suitable agents above the confidence threshold — much lighter than list_agents when the registry is large. If no suitable match is returned, stop discovery and delegate autonomously or use create_ephemeral_agent.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Natural-language capability or task description to match semantically against specialist agents",
      },
      minConfidence: {
        type: "string",
        enum: ["high", "medium", "low"],
        description: "Minimum confidence required for results. Default is medium. Use low only when explicitly inspecting weak candidates, not as an automatic no-match retry.",
      },
    },
    required: ["query"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const raw = String(args["query"] ?? "").trim();
    if (!raw) return { success: false, output: "", error: "query is required" };
    const minConfidence = args["minConfidence"] === "low" ? "low" : "medium";
    const currentAgentName = typeof ctx.currentAgentName === "string" && ctx.currentAgentName.trim().length > 0
      ? ctx.currentAgentName.trim()
      : undefined;
    // Route WITHOUT excludeAgents so the invoking agent can still appear in
    // rawResolution — we need that to detect self-exclusion.  The manual
    // filter below removes it before the result is returned to the caller.
    const rawResolution = await resolveAgentRouting(raw, {
      minConfidence,
      allowedAgents: ctx.allowedAgents,
      allowKeywordFallback: false,
    });
    const selfExcluded = currentAgentName
      ? rawResolution.results.some((candidate) => candidate.name === currentAgentName)
        || rawResolution.weakCandidates.some((candidate) => candidate.name === currentAgentName)
      : false;
    const resolution = currentAgentName
      ? {
          ...rawResolution,
          results: rawResolution.results.filter((candidate) => candidate.name !== currentAgentName),
          weakCandidates: rawResolution.weakCandidates.filter((candidate) => candidate.name !== currentAgentName),
        }
      : rawResolution;
    const semanticMetadata = buildSemanticRoutingMetadata(resolution);
    const semanticUnavailableNote = formatSemanticUnavailableNote(semanticMetadata);

    logAudit("agent_routing_evaluated", {
      query: raw,
      minConfidence,
      mode: resolution.mode,
      ...semanticMetadata,
      resultCount: resolution.results.length,
      weakCount: resolution.weakCandidates.length,
      gated: resolution.gated,
      trippedAgents: resolution.trippedAgents,
      excludedAgents: resolution.excludedAgents ?? [],
      allLowConfidence: resolution.allLowConfidence,
      topResult: resolution.results[0]?.name ?? null,
    }, { sessionId: ctx.sessionId, channel: "agent-routing" });

    const circuitNote = resolution.trippedAgents.length > 0
      ? `\n⚠ Circuit breakers open (excluded from routing): ${resolution.trippedAgents.join(", ")}`
      : "";
    const selfExclusionNote = ctx.currentAgentName
      ? `\nℹ Self excluded from routing suggestions: ${ctx.currentAgentName}`
      : "";

    if (resolution.results.length === 0 && resolution.weakCandidates.length === 0) {
      // Auto-retry with a shortened query when the original was over-specified.
      // Common failure shape (audit session 0a93078b, May 2026): a coordinator
      // emits a 9-12 noun query like "hardware engineering circuit design PCB
      // layout component selection MEMS microphone ESP32 audio recording".
      // The embedding fragments across too many concepts and matches nothing,
      // even though `researcher` or `mission_coordinator` would hit on the
      // first 4-5 distinctive terms.  When this happens, retry once with a
      // shortened query before declaring the routing a complete failure.
      const shortened = countRoutingQueryContentTokens(raw) > 7
        ? shortenOverspecifiedRoutingQuery(raw)
        : null;
      if (shortened) {
        const retryResolutionRaw = await resolveAgentRouting(shortened, {
          minConfidence,
          allowedAgents: ctx.allowedAgents,
          allowKeywordFallback: false,
        });
        const retryResolution = currentAgentName
          ? {
              ...retryResolutionRaw,
              results: retryResolutionRaw.results.filter((candidate) => candidate.name !== currentAgentName),
              weakCandidates: retryResolutionRaw.weakCandidates.filter((candidate) => candidate.name !== currentAgentName),
            }
          : retryResolutionRaw;
        if (retryResolution.results.length > 0) {
          const retrySemanticMetadata = buildSemanticRoutingMetadata(retryResolution);
          logAudit("agent_routing_evaluated", {
            query: shortened,
            originalQuery: raw,
            retryAfterEmpty: true,
            minConfidence,
            mode: retryResolution.mode,
            ...retrySemanticMetadata,
            resultCount: retryResolution.results.length,
            weakCount: retryResolution.weakCandidates.length,
            gated: retryResolution.gated,
            topResult: retryResolution.results[0]?.name ?? null,
          }, { sessionId: ctx.sessionId, channel: "agent-routing" });
          const topAgent = retryResolution.results[0]!;
          const topResultIsStrong = topAgent.confidence === "high"
            || (topAgent.confidence === "medium" && topAgent.score >= 0.5);
          const nextActionLine = topResultIsStrong
            ? `➡ NEXT ACTION: Call delegate_to_agent(agentName="${topAgent.name}", task="<your task>") NOW. Do NOT call search_agents again.`
            : `ℹ Best available match is ${topAgent.name} (${topAgent.confidence} confidence, score ${topAgent.score.toFixed(2)}) — review the candidate list below.`;
          return {
            success: true,
            output: `${nextActionLine}\n\n⚠ Original query "${raw}" matched no agents (over-specified). Auto-retried with shortened query "${shortened}" and found ${retryResolution.results.length} match(es):\n\n${retryResolution.results.map(formatRoutingCandidate).join("\n\n")}${circuitNote}${selfExclusionNote}`,
            metadata: {
              query: raw,
              shortenedQuery: shortened,
              retryAfterEmpty: true,
              minConfidence,
              routingMode: retryResolution.mode,
              ...retrySemanticMetadata,
              resultCount: retryResolution.results.length,
              weakCount: retryResolution.weakCandidates.length,
              topResult: topAgent.name,
              topResultConfidence: topAgent.confidence,
              topResultScore: topAgent.score,
              suggestedFallbackAgents: retryResolution.results.slice(1, 4).map((candidate) => candidate.name),
            },
          };
        }
      }

      // Complete routing failure — auto-record a capability gap for self-improvement pipeline
      recordCapabilityGap({
        description: `No agent found for routing query: "${raw}"`,
        exampleInput: raw,
        sessionId: ctx.sessionId,
      }).catch(() => { /* self-improvement may be disabled */ });
      const shortenedNote = shortened
        ? ` (also tried shortened query "${shortened}" — also 0 matches)`
        : "";
      return {
        success: true,
        output: `No agents matched "${raw}"${shortenedNote}.${semanticUnavailableNote} Do not call search_agents again for this turn. Delegate without an agentName so autonomous routing can bid on the original task, or use create_ephemeral_agent only if this is a brand-new capability not covered by ANY existing specialist.${circuitNote}${selfExclusionNote}`,
        metadata: {
          query: raw,
          minConfidence,
          routingMode: resolution.mode,
          ...semanticMetadata,
          resultCount: 0,
          weakCount: 0,
          topResult: null,
          trippedAgents: resolution.trippedAgents,
          excludedAgents: resolution.excludedAgents ?? [],
          ...(shortened ? { shortenedQueryAttempted: shortened } : {}),
        },
      };
    }

    if (resolution.results.length === 0) {
      const topCandidates = resolution.weakCandidates.map((candidate) => `- ${candidate.name} (${candidate.confidence})`).join("\n");
      // Only weak candidates — record gap so the pipeline can design a better specialist
      recordCapabilityGap({
        description: `No agent met minimum confidence for routing query: "${raw}" (only low-confidence candidates)`,
        exampleInput: raw,
        sessionId: ctx.sessionId,
      }).catch(() => { /* self-improvement may be disabled */ });
      return {
        success: true,
        output: `No agents matched "${raw}" with ${minConfidence} confidence or better.${semanticUnavailableNote} Do not call search_agents again for this turn. Delegate without an agentName so autonomous routing can bid on the original task, delegate to a known coordinator, or use create_ephemeral_agent if this is a new capability.${circuitNote}${selfExclusionNote}\n\nTop weak candidates:\n${topCandidates}`,
        metadata: {
          query: raw,
          minConfidence,
          routingMode: resolution.mode,
          ...semanticMetadata,
          resultCount: 0,
          weakCount: resolution.weakCandidates.length,
          topResult: null,
          trippedAgents: resolution.trippedAgents,
          excludedAgents: resolution.excludedAgents ?? [],
        },
      };
    }

    const topAgent = resolution.results[0]!;
    const lowConfidenceWarning = resolution.allLowConfidence
      ? `\n⚠ LOW CONFIDENCE: No specialist found with medium+ confidence for this query. Consider using create_ephemeral_agent for a purpose-built agent, or ask the user to clarify the task before delegating.`
      : "";
    const resultSelfExclusionNote = selfExcluded && currentAgentName
      ? `\nℹ Self excluded from routing suggestions: ${currentAgentName}`
      : "";
    // I10: Only emit the assertive "NEXT ACTION: Call delegate_to_agent(<topAgent>)"
    // pointer when the top match is genuinely strong. Low-confidence top results
    // (or scores < 0.5) routinely surface bad agents — e.g. accessibility_tester
    // for "research news headlines" — and the imperative wording pushed weaker
    // models to delegate to the wrong specialist. For weak top results, present
    // the candidate list neutrally and let the LLM choose, including the option
    // to call list_agents or create_ephemeral_agent.
    const topResultIsStrong = topAgent.confidence === "high"
      || (topAgent.confidence === "medium" && topAgent.score >= 0.5);
    const nextActionLine = topResultIsStrong
      ? `➡ NEXT ACTION: Call delegate_to_agent(agentName="${topAgent.name}", task="<your task>") NOW. Do NOT call search_agents again.`
      : `ℹ Best available match is ${topAgent.name} (${topAgent.confidence} confidence, score ${topAgent.score.toFixed(2)}) — review the candidate list below and pick the most relevant agent, or use create_ephemeral_agent if none fit. Do NOT call search_agents again.`;
    return {
      success: true,
      output: `${nextActionLine}\n\nAgents matching "${raw}" [${resolution.mode} search, ${resolution.results.length} result(s)]:${semanticUnavailableNote}\n\n${resolution.results.map(formatRoutingCandidate).join("\n\n")}${lowConfidenceWarning}${circuitNote}${resultSelfExclusionNote}`,
      metadata: {
        query: raw,
        minConfidence,
        routingMode: resolution.mode,
        ...semanticMetadata,
        resultCount: resolution.results.length,
        weakCount: resolution.weakCandidates.length,
        topResult: topAgent.name,
        topResultConfidence: topAgent.confidence,
        topResultScore: topAgent.score,
        suggestedFallbackAgents: resolution.results.slice(1, 4).map((candidate) => candidate.name),
        trippedAgents: resolution.trippedAgents,
        excludedAgents: resolution.excludedAgents ?? [],
      },
    };
  },
});

// ─── search_tools ────────────────────────────────────────────────────────────
// Semantic search over the registered tool catalog. Keeps sub-agent context
// small: instead of printing the full tool list (which can exceed 50 KB when
// MCP surfaces are loaded), an agent can discover which tools are available
// for a specific sub-task without blowing up its context window.

registerTool({
  name: "search_tools",
  description: "Search available tools by semantic similarity to a task description. Returns the top-matching tool names and descriptions. Use this to discover which tools are available for a sub-task instead of relying on the static tool list in the system prompt.",
  embeddingDescription: "find tools, discover capabilities, what tools can do X, which tool handles Y, tool catalog search, tool discovery",
  costHint: "low" as const,
  latencyHint: "low" as const,
  parameters: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description: "Natural-language description of what you want to do. The tool returns the most semantically similar registered tools.",
      },
      topN: {
        type: "number",
        description: "Maximum number of results to return. Defaults to 8.",
      },
    },
    required: ["query"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const query = String(args["query"] ?? "").trim();
    if (!query) {
      return { success: false, output: "", error: "query is required" };
    }
    const topN = Math.min(20, Math.max(1, Number(args["topN"] ?? 8)));

    const handlers = getAllTools();
    if (handlers.length === 0) {
      return { success: true, output: "No tools are available in this context." };
    }

    // Single shared semantic-search path — uses the long-lived per-tool
    // embedding cache that warmToolEmbeddings populates, with a keyword
    // fallback when the embedding provider is unavailable.  Avoids the
    // earlier double-walk pattern (rerankToolsForTask + per-tool
    // computeQueryEmbedding) which re-embedded each tool's text via the
    // short-TTL query cache instead of the proper tool cache.
    const ranked = await searchToolsByEmbedding(query, topN, handlers);

    if (ranked.length === 0) {
      return {
        success: true,
        output: `No tools matched "${query}". Check that the required tools are in your tool list for this run.`,
        metadata: { query, resultCount: 0 },
      };
    }

    const mode = ranked[0]?.mode ?? "empty";
    const lines = ranked.map((r) => `- **${r.name}**: ${r.description}`);
    return {
      success: true,
      output: `Tools matching "${query}" (${ranked.length} result${ranked.length === 1 ? "" : "s"}, ${mode} mode):\n\n${lines.join("\n")}`,
      metadata: { query, resultCount: ranked.length, mode, topResult: ranked[0]?.name ?? null },
    };
  },
});

// ─── delegate_to_agent ────────────────────────────────────────────────────────

registerTool({
  name: "delegate_to_agent",
  description: "Delegate a task to a specialized sub-agent. When agentName is omitted the swarm's autonomous bidding system selects the best specialist — prefer this for tasks where the right specialist is not obvious. Provide agentName only when you already know from prior context exactly which specialist to use.",
  parameters: {
    type: "object",
    properties: {
      agentName: {
        type: "string",
        description: "Name of the sub-agent to invoke. OPTIONAL — omit to let the swarm bidding system pick the best specialist automatically.",
      },
      task: {
        type: "string",
        description: "The task or question for the sub-agent to complete",
      },
      context: {
        type: "string",
        description: "Optional background context to provide to the sub-agent (e.g. data gathered so far)",
      },
      fallbackAgents: {
        type: "array",
        items: { type: "string" },
        description: "Optional ordered fallback agents to try automatically if the primary agent fails or returns a weak result.",
      },
      routingQuery: {
        type: "string",
        description: "Optional routing query used to auto-select fallback agents when the primary path fails.",
      },
      skillMatchThreshold: {
        type: "number",
        description: "Optional 0-1 threshold. If the best auto-selected specialist scores below this value, generate an ephemeral agent instead.",
      },
    },
    required: ["task"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    // agentName is now optional — omitting it triggers undirected swarm bidding
    const requestedAgentName = args["agentName"] ? String(args["agentName"]).trim() : "";
    let task = deriveDelegationTask(args);
    const context = args["context"] ? String(args["context"]) : undefined;
    // Work internally in English: translate a non-English task to English for routing +
    // the sub-agent's work, carrying an output-language directive so the deliverable still
    // comes back in the user's language. Context evidence is left verbatim. Gated, fail-open.
    if (task && effectiveOrchestration().normalizeDelegationToEnglish) {
      const normalized = await normalizeDelegationTaskLanguage({ task, provider: getChatProviderForTier("routing") ?? getChatProvider(), signal: ctx.signal });
      if (normalized.sourceLanguage !== "English") {
        logAudit("delegation_task_normalized_to_english", { sourceLanguage: normalized.sourceLanguage }, { sessionId: ctx.sessionId, severity: "info" });
        task = normalized.task;
      }
    }
    const explicitFallbackAgents = Array.isArray(args["fallbackAgents"]) ? args["fallbackAgents"].map(String) : undefined;
    const routingQuery = args["routingQuery"] ? String(args["routingQuery"]) : undefined;
    const skillMatchThreshold = typeof args["skillMatchThreshold"] === "number" ? args["skillMatchThreshold"] : undefined;
    const taskTitle = resolveDelegationTaskTitle(args, task);

    if (!task) {
      return { success: false, output: "", error: "task is required" };
    }

    const rawAgentName = requestedAgentName || "";
    const primaryValidation = sanitizeDelegationAgentList(rawAgentName ? [rawAgentName] : undefined, ctx);
    const agentName = primaryValidation.valid[0] ?? "";

    // Enforce per-scene agent scope only when an explicit agent was requested
    if (primaryValidation.disallowed.length > 0) {
      return {
        success: false,
        output: "",
        error: `Agent '${primaryValidation.disallowed[0]}' is not permitted in this scene. Allowed agents: ${ctx.allowedAgents?.join(", ") ?? ""}`,
      };
    }

    if (primaryValidation.invalid.length > 0) {
      // Ignore unknown explicit agent names so the task can still recover via
      // fallback agents or normal routing.
    }

    const rawFallbackAgents = explicitFallbackAgents?.length
      ? explicitFallbackAgents
      : agentName === "swarm_maintainer"
        ? ["coder", "prompt_optimizer"].filter((candidate) => !ctx.allowedAgents || ctx.allowedAgents.includes(candidate))
        : undefined;
    const fallbackValidation = sanitizeDelegationAgentList(rawFallbackAgents, ctx);
    const fallbackAgents = fallbackValidation.valid.length > 0
      ? fallbackValidation.valid
      : undefined;

    const enrichedContext = agentName
      ? maybeEnrichServerDelegationContext(agentName, task, context)
      : context;

    return executeDelegationWithFallback({
      agentName,
      task,
      context: enrichedContext,
      fallbackAgents,
      routingQuery,
      skillMatchThreshold,
      taskTitle,
    }, ctx);
  },
});

// ─── swarm_delegate ────────────────────────────────────────────────────────────
//
// Undirected delegation only — no agentName parameter. The swarm routing system
// (keyword + embedding + outcome-weighted bidding) always picks the specialist.
// Use this when you do not yet know which agent is best for the task, or when
// you want the swarm to self-select based on current availability and skill scores.
// Prefer delegate_to_agent only when you already know from context which exact
// specialist to invoke.

registerTool({
  name: "swarm_delegate",
  description: "Delegate a task to the swarm without naming a specific agent. The autonomous routing system (embedding match + outcome-weighted bidding) selects the best available specialist. Use this when the ideal specialist is not obvious — the swarm almost always picks better than an LLM guess at this point in the conversation. For tasks where you already know the exact right specialist from prior context, use delegate_to_agent instead.",
  parameters: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: "The task or question for a specialist to complete. Write this as a clear, self-contained assignment — the routing system uses its full text to pick the agent.",
      },
      context: {
        type: "string",
        description: "Optional background context — prior findings, data already gathered, or constraints the specialist should know.",
      },
      routingQuery: {
        type: "string",
        description: "Optional override query used for routing. Defaults to the task text. Provide this when the task text contains a lot of detail that might obscure the core capability needed.",
      },
      skillMatchThreshold: {
        type: "number",
        description: "Optional 0–1 threshold. If the best-matched specialist scores below this value an ephemeral agent is synthesised instead. Defaults to the swarm's global threshold.",
      },
    },
    required: ["task"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    let task = deriveDelegationTask(args);
    const context = args["context"] ? String(args["context"]) : undefined;
    // Work internally in English (same as the directed path): translate a non-English task
    // for routing + the sub-agent's work, with an output-language directive. Gated, fail-open.
    if (task && effectiveOrchestration().normalizeDelegationToEnglish) {
      const normalized = await normalizeDelegationTaskLanguage({ task, provider: getChatProviderForTier("routing") ?? getChatProvider(), signal: ctx.signal });
      if (normalized.sourceLanguage !== "English") {
        logAudit("delegation_task_normalized_to_english", { sourceLanguage: normalized.sourceLanguage }, { sessionId: ctx.sessionId, severity: "info" });
        task = normalized.task;
      }
    }
    const routingQuery = args["routingQuery"] ? String(args["routingQuery"]) : undefined;
    const skillMatchThreshold = typeof args["skillMatchThreshold"] === "number" ? args["skillMatchThreshold"] : undefined;
    const taskTitle = resolveDelegationTaskTitle(args, task);

    if (!task) {
      return { success: false, output: "", error: "task is required" };
    }

    // Undirected — no agentName — the routing system owns the choice.
    return executeDelegationWithFallback({
      task,
      context,
      routingQuery,
      skillMatchThreshold,
      taskTitle,
    }, ctx);
  },
});

// ─── parallel_delegate ────────────────────────────────────────────────────────

/**
 * Normalize a delegation task body so two "slices" carrying the SAME underlying request
 * compare equal. Drops the source-sensitive SLICE markers, the generic per-slice focus
 * line, and the leading WEB-RESEARCH framing the source-sensitive rewrite prepends, then
 * collapses whitespace/case. Used only for redundancy detection — the original task text
 * is what actually runs.
 */
export function normalizeDelegationBodyForDedup(task: string): string {
  return String(task ?? "")
    .replace(/SOURCE-SENSITIVE DELEGATION[^\n:]*:/gi, "")
    .replace(/\bSLICE\s+\d+\s*\/\s*\d+\b/gi, "")
    .replace(/Focus for this slice[^\n]*/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Collapse redundant parallel-delegate tasks: when the orchestrator fans out several tasks
 * that share the SAME normalized body+context, running them concurrently is pure waste — on
 * a single GPU it multiplies turn latency N× for one piece of work (audit 49372c7a: a turn
 * fanned out 4 "slices" each carrying the full original request + an identical generic focus,
 * differing only by a "SLICE n/4" marker and the routingQuery; all four redundantly
 * researched everything and the turn took ~17 min). Keeps the FIRST occurrence of each
 * distinct body+context and drops the rest. Only substantial bodies (>=120 normalized chars)
 * are eligible so trivially-short micro-tasks are never merged. Genuine decomposition
 * (distinct bodies) and intentional same-agent partitions with distinct text are untouched —
 * parallel_delegate is for DISTINCT work, so identical bodies are a mis-expression, not a plan.
 */
/** Word-token set of a normalized body, for near-duplicate comparison. */
function delegationBodyTokenSet(normalized: string): Set<string> {
  return new Set(normalized.split(" ").filter((token) => token.length > 0));
}

/**
 * Two normalized bodies are NEAR-duplicates when their containment overlap
 * (|A ∩ B| / |smaller set|) is >= 0.9. Containment (not Jaccard) so a copy that merely
 * dropped/added a word or two — the slow 35B paraphrases its own "identical" slices, e.g.
 * "and we can make a sync button" vs "and and make a sync button" (audit d20a9a5e) — still
 * collapses, while genuinely distinct sub-tasks (low overlap) are kept.
 */
function delegationBodiesAreNearDuplicate(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const token of small) if (large.has(token)) intersection += 1;
  return intersection / small.size >= 0.9;
}

export function deduplicateRunnableDelegations<T extends { task: string; context?: string; agentName?: string; routingQuery?: string }>(
  tasks: T[],
): { kept: T[]; removed: number } {
  // Pass 1 — per-lane near-duplicate collapse. Lane = the explicit agent (routingQuery is
  // ignored once agentName is set), else the routingQuery that picks the specialist. Near-
  // identical bodies in the SAME lane are the same agent doing the same work -> collapse.
  // Identical bodies across DIFFERENT agents are preserved here: the source-sensitive cap
  // deliberately fans the canonical task to a RESEARCHER POOL for cross-check coverage.
  const keptTokensByLane = new Map<string, Set<string>[]>();
  const laneKept: Array<{ spec: T; tokens: Set<string> | null }> = [];
  for (const taskSpec of tasks) {
    const body = normalizeDelegationBodyForDedup(taskSpec.task);
    if (body.length < 120) {
      laneKept.push({ spec: taskSpec, tokens: null }); // too short to confidently call redundant — keep
      continue;
    }
    const lane = taskSpec.agentName && taskSpec.agentName.trim()
      ? `@${taskSpec.agentName.trim().toLowerCase()}`
      : `~${normalizeDelegationBodyForDedup(taskSpec.routingQuery ?? "")}`;
    const tokens = delegationBodyTokenSet(`${body} ${normalizeDelegationBodyForDedup(taskSpec.context ?? "")}`);
    const laneTokens = keptTokensByLane.get(lane) ?? [];
    if (laneTokens.some((keptTokens) => delegationBodiesAreNearDuplicate(tokens, keptTokens))) {
      continue; // near-duplicate of an already-kept task in this lane
    }
    laneTokens.push(tokens);
    keptTokensByLane.set(lane, laneTokens);
    laneKept.push({ spec: taskSpec, tokens });
  }
  // Pass 2 — drop COORDINATOR slices whose body near-duplicates a NON-coordinator slice. A
  // coordinator handed the identical canonical research task just re-spawns its own
  // researchers, compounding the tree on a single GPU (audit e2071dce: a researcher + coder +
  // mission_coordinator fan-out of one identical request → coordinators nested more
  // researchers → ~10 min). The researcher pool already covers the work; the coordinator copy
  // is pure redundant nesting. A group that is ALL coordinators is left untouched.
  const nonCoordinatorTokens = laneKept
    .filter((k) => k.tokens && !agentNameIsCoordinator(String(k.spec.agentName ?? "")))
    .map((k) => k.tokens as Set<string>);
  const kept = laneKept
    .filter((k) => {
      if (!k.tokens || !agentNameIsCoordinator(String(k.spec.agentName ?? ""))) return true;
      return !nonCoordinatorTokens.some((nt) => delegationBodiesAreNearDuplicate(k.tokens as Set<string>, nt));
    })
    .map((k) => k.spec);
  return { kept, removed: tasks.length - kept.length };
}

registerTool({
  name: "parallel_delegate",
  description: "Run multiple independent sub-agent tasks in parallel and collect all results. Use when the orchestrator needs outputs from 2–5 independent partitions. Repeating the same agent is allowed when each task is a distinct partition of the work. Returns all results concatenated with separators.",
  parameters: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            agentName: { type: "string", description: "Name of the sub-agent to invoke" },
            task: { type: "string", description: "Task description for this agent" },
            context: { type: "string", description: "Optional context to pass to this agent" },
            fallbackAgents: { type: "array", items: { type: "string" }, description: "Optional fallback agents for this task" },
            routingQuery: { type: "string", description: "Optional routing query for self-healing fallback selection" },
            skillMatchThreshold: { type: "number", description: "Optional 0-1 threshold for generating an ephemeral agent when no specialist matches strongly enough" },
          },
          required: ["task"],
        },
        description: "Array of independent tasks to run in parallel (max 5)",
      },
    },
    required: ["tasks"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const tasks = Array.isArray(args["tasks"])
      ? (args["tasks"] as Array<{ agentName?: string; task: string; context?: string; fallbackAgents?: string[]; routingQuery?: string; skillMatchThreshold?: number }>)
      : [];

    if (tasks.length === 0) return { success: false, output: "", error: "tasks array must not be empty" };
    if (tasks.length > 5) return { success: false, output: "", error: "Maximum 5 parallel tasks allowed" };

    const normalizedTasks = tasks.map((taskSpec) => {
      const rawAgentName = taskSpec.agentName ? String(taskSpec.agentName).trim() : "";
      const primaryValidation = sanitizeDelegationAgentList(rawAgentName ? [rawAgentName] : undefined, ctx);
      if (primaryValidation.disallowed.length > 0) {
        return {
          error: `Agent '${primaryValidation.disallowed[0]}' is not permitted in this scene. Allowed: ${ctx.allowedAgents?.join(", ") ?? ""}`,
        };
      }
      if (primaryValidation.invalid.length > 0) {
        // Ignore unknown explicit agent names so the task can still recover via
        // fallback agents or normal routing.
      }

      const fallbackValidation = sanitizeDelegationAgentList(taskSpec.fallbackAgents, ctx);
      if (fallbackValidation.disallowed.length > 0) {
        return {
          error: `Agent '${fallbackValidation.disallowed[0]}' is not permitted in this scene. Allowed: ${ctx.allowedAgents?.join(", ") ?? ""}`,
        };
      }

      return {
        ...taskSpec,
        agentName: primaryValidation.valid[0],
        fallbackAgents: fallbackValidation.valid.length > 0 ? fallbackValidation.valid : undefined,
      };
    });

    const normalizationError = normalizedTasks.find((taskSpec): taskSpec is { error: string } => "error" in taskSpec);
    if (normalizationError && normalizationError.error) {
      return { success: false, output: "", error: normalizationError.error };
    }

    const runnableTasks: Array<{
      agentName: string | undefined;
      task: string;
      context?: string;
      fallbackAgents: string[] | undefined;
      routingQuery?: string;
      skillMatchThreshold?: number;
    }> = [];
    for (const taskSpec of normalizedTasks) {
      if ("error" in taskSpec) {
        continue;
      }
      runnableTasks.push(taskSpec);
    }

    // Collapse redundant duplicate-body slices before dispatch (audit 49372c7a). Running
    // the SAME research task N× in parallel is pure waste and N×'s the turn on a single GPU.
    const { kept: dispatchTasks, removed: duplicatesRemoved } = deduplicateRunnableDelegations(runnableTasks);
    if (duplicatesRemoved > 0) {
      logAudit(
        "parallel_delegate_deduplicated",
        { requested: runnableTasks.length, dispatched: dispatchTasks.length, removed: duplicatesRemoved },
        { sessionId: ctx.sessionId, severity: "warn" },
      );
      // Smallest-sufficient-swarm feedback: a coordinator whose ENTIRE fan-out collapsed
      // to one task added no decomposition value this run — the request was a single
      // specialist's job reached through an expensive extra coordinator hop (audit
      // ce8e2128: mission_coordinator's only contribution was two IDENTICAL researcher
      // slices, 708s of overhead). Record a "partial" outcome for the coordinator so
      // outcome-weighted routing (computeOutcomeRoutingMultiplier, ±20% over ≥25 samples)
      // gradually prefers the direct specialist for this task class. Learning signal
      // only — no hard rule, and a partial dedup (3→2) still counts as real partitioning.
      if (dispatchTasks.length === 1 && runnableTasks.length > 1 && ctx.currentAgentName) {
        appendOutcome(ctx.workspacePath, {
          ts: new Date().toISOString(),
          agent: ctx.currentAgentName,
          task: (dispatchTasks[0]?.task ?? "").slice(0, 300),
          outcome: "partial",
          iterations: 0,
          totalTokens: 0,
          lesson: "parallel_delegate fan-out collapsed to ONE task (identical slices) — no decomposition value added; this request shape fits a single specialist directly",
          taskKeywords: extractTaskKeywords(dispatchTasks[0]?.task ?? ""),
        });
      }
    }

    logAudit(
      "parallel_delegate_started",
      { taskCount: dispatchTasks.length, agents: dispatchTasks.map((taskSpec) => taskSpec.agentName ?? "auto") },
      { sessionId: ctx.sessionId }
    );

    const delegatedCtx = withDelegationFanoutAllowance(
      ctx,
      dispatchTasks.map((taskSpec) => taskSpec.agentName),
      dispatchTasks.length,
    );
    const taskIds = allocateParallelTaskIds(delegatedCtx, dispatchTasks.length);

    const runSlice = (taskSpec: typeof dispatchTasks[number], index: number, ctxOverride: ToolContext) =>
      executeDelegationWithFallback({
        ...taskSpec,
        taskId: taskIds[index],
        taskTitle: summarizeText(taskSpec.task, 80),
        // Auto-allocated parallel id — let a later round reuse an earlier same-signature
        // slice's evidence instead of re-researching it.
        allowSignatureReuse: true,
      }, ctxOverride);

    // QUORUM EARLY-SYNTHESIS (orchestration.quorumEarlySynthesis, default-off): return as
    // soon as ceil(quorumFraction * N) slices SUCCEED (+ a straggler grace window), aborting
    // the rest, instead of blocking on the slowest. Default-off path is the original
    // Promise.all (wait-for-all), byte-for-byte.
    const orch = effectiveOrchestration();
    let results: ToolResult[];
    if (orch.quorumEarlySynthesis === true && dispatchTasks.length > 1) {
      const k = Math.max(1, Math.ceil((orch.quorumFraction ?? 0.6) * dispatchTasks.length));
      results = await awaitQuorum<ToolResult>(
        dispatchTasks.map((taskSpec, index) => (signal: AbortSignal) =>
          runSlice(taskSpec, index, { ...delegatedCtx, signal })),
        {
          k,
          graceMs: orch.quorumStragglerGraceMs ?? 8000,
          isSuccess: (r) => r.success === true,
          onError: (err) => ({ success: false, output: "", error: String((err as { message?: string })?.message ?? err) }),
          onAbandon: () => ({ success: false, output: "", error: "abandoned: quorum of successful slices reached before this slice completed (partial evidence persisted to shared facts)" }),
          ...(delegatedCtx.signal ? { parentSignal: delegatedCtx.signal } : {}),
        },
      );
    } else {
      results = await Promise.all(
        dispatchTasks.map((taskSpec, index) => runSlice(taskSpec, index, delegatedCtx)),
      );
    }

    const formatted = results.map((result, index) => {
      const label = dispatchTasks[index]?.agentName ?? `task_${index + 1}`;
      if (result.success) return `**[${label}]**:\n${result.output}`;
      return `**[${label}]** (failed): ${result.error ?? "unknown error"}`;
    });

    const succeeded = results.filter(result => result.success).length;

    // Propagate each sub-task's produced artifacts to the parent turn. Single
    // delegate_to_agent and run_workflow already surface their delegate's
    // artifacts via metadata.artifacts (collectTurnArtifactAttachments recurses
    // into it); parallel_delegate previously dropped them. The cost: a fan-out
    // that actually BUILT a deliverable (e.g. backend_coder writing a full
    // multi-file WebApp) surfaced ZERO downloads on the final message AND every
    // artifact-aware honesty guard (auto-build "already built?", false-completion
    // banner) saw "0 produced" — so the turn shipped a research-only stub with no
    // sign of the built app (audit 411ed14f: iSAQB learn-platform built by
    // backend_coder, never surfaced). Aggregate them here.
    const aggregatedArtifacts: Record<string, unknown>[] = [];
    for (const result of results) {
      const arts = result.metadata?.["artifacts"];
      if (Array.isArray(arts)) {
        for (const artifact of arts) {
          if (artifact && typeof artifact === "object") {
            aggregatedArtifacts.push(artifact as Record<string, unknown>);
          }
        }
      }
    }

    // DISAGREEMENT-AS-SIGNAL (orchestration.subAgentDisagreementVerify, default-off): when
    // ≥2 slices succeeded, a cheap routing-tier check flags contradictory outputs so the
    // orchestrator reconciles them in synthesis instead of silently merging. Fails open.
    let disagreementMarker: string | null = null;
    if (shouldCheckSubAgentDisagreement({ enabled: orch.subAgentDisagreementVerify === true, succeeded })) {
      const successfulOutputs = results
        .map((result, index) => ({ label: dispatchTasks[index]?.agentName ?? `task_${index + 1}`, text: result.output ?? "", success: result.success }))
        .filter((entry) => entry.success && entry.text.trim().length > 0)
        .map(({ label, text }) => ({ label, text }));
      disagreementMarker = await checkSubAgentDisagreement(successfulOutputs, delegatedCtx.signal);
    }

    const baseOutput = formatted.join("\n\n---\n\n");
    return {
      success: succeeded > 0,
      output: disagreementMarker ? `${disagreementMarker}\n\n${baseOutput}` : baseOutput,
      metadata: {
        taskCount: dispatchTasks.length,
        succeeded,
        failed: results.length - succeeded,
        ...(disagreementMarker ? { subAgentDisagreement: true } : {}),
        ...(aggregatedArtifacts.length > 0 ? { artifacts: aggregatedArtifacts } : {}),
        ...(duplicatesRemoved > 0 ? { requestedTaskCount: runnableTasks.length, duplicatesRemoved } : {}),
      },
    };
  },
});
