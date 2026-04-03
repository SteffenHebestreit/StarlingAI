/**
 * Sub-agent tools
 *
 * delegate_to_agent — hand a task off to a named specialist sub-agent
 * list_agents       — enumerate configured sub-agents (so the orchestrator can pick)
 */

import { registerTool, type SwarmState, type SwarmTaskState, type ToolContext, type ToolResult } from "./registry.js";
import { runSubAgent, runSubAgentWithStats } from "../agent/sub-agent.js";
import { getConfig } from "../config/loader.js";
import { computeAgentIntentAdjustment, isEmbeddingAvailable, scoreAgentKeywordMatch, searchByEmbedding } from "../providers/embeddings.js";
import { getEmbeddingProvider } from "../providers/index.js";
import { logAudit } from "../audit/logger.js";
import { readRecentOutcomes, computeAgentCostProfile, type AgentCostProfile } from "../agent/outcomes.js";
import { getToolTier, ToolTier } from "../guardrails/tool-tiers.js";
import { readPromotedAgents, promoteEphemeralAgent, PROMOTION_MIN_SUCCESSES, PROMOTION_MIN_SUCCESS_RATE } from "../agent/promoted-agents.js";
import { emitSwarmEvent } from "../swarm/bus.js";
import { announceAgentCapability } from "../swarm/capabilities.js";
import { clearTaskBids, collectTaskBids, DEFAULT_AUTONOMOUS_BID_WINDOW_MS, isAutonomousBiddingStarted } from "../swarm/bidding.js";
import { acquireTaskLock, releaseTaskLock } from "../swarm/locks.js";
import { formatSharedContextForPrompt, appendPartialResult, extractFactsFromOutput, writeSharedFact } from "../swarm/memory.js";
import { rerankCandidates } from "../retrieval/reranker.js";

function confidenceLabel(score: number): "high" | "medium" | "low" {
  if (score >= 0.72) return "high";
  if (score >= 0.45) return "medium";
  return "low";
}

function confidenceThreshold(label: "high" | "medium" | "low"): number {
  if (label === "high") return 0.72;
  if (label === "medium") return 0.45;
  return 0;
}

interface HeuristicRoutingSignals {
  looksBroad: boolean;
  looksFresh: boolean;
  looksSourceHeavy: boolean;
  looksWebTask: boolean;
}

function analyzeHeuristicRoutingQuery(query: string): HeuristicRoutingSignals {
  const normalized = query.trim().toLowerCase();
  return {
    looksBroad: /\b(comprehensive|guide|tutorial|walkthrough|step by step|step-by-step|deep dive|covering|compare|comparison|overview|audit)\b/i.test(normalized),
    looksFresh: /\b(2025|2026|current|currently|latest|recent|recently|updated|today|now)\b/i.test(normalized),
    looksSourceHeavy: /\b(official|source|sources|citation|citations|reference|references|documentation|docs|release notes|spec|specification|standard)\b/i.test(normalized),
    looksWebTask: /\b(web|website|browser|online|wcag|a11y|accessibility|testing|audit)\b/i.test(normalized),
  };
}

function buildCoordinatorMatchedTerms(signals: HeuristicRoutingSignals): string[] {
  return [
    "web",
    "research",
    ...(signals.looksBroad ? ["guide"] : []),
    ...(signals.looksFresh ? ["current"] : []),
    ...(signals.looksSourceHeavy ? ["sources"] : []),
  ];
}

function shouldPreferWebTaskCoordinator(query: string, ctx: ToolContext, exclude: string[]): boolean {
  const signals = analyzeHeuristicRoutingQuery(query);
  if (!signals.looksWebTask || !(signals.looksBroad || signals.looksFresh || signals.looksSourceHeavy)) {
    return false;
  }

  if (exclude.includes("web_task_coordinator")) {
    return false;
  }

  if (ctx.allowedAgents && !ctx.allowedAgents.includes("web_task_coordinator")) {
    return false;
  }

  return Boolean(getConfig().subAgents["web_task_coordinator"]);
}

export interface AgentRoutingCandidate {
  name: string;
  description: string;
  model: string;
  confidence: "high" | "medium" | "low";
  score: number;
  matchedTerms: string[];
  capabilities: string[];
  tags: string[];
  /** Performance and cost profile derived from recent outcome log entries. */
  costProfile?: AgentCostProfile;
}

export interface AgentRoutingResolution {
  query: string;
  minConfidence: "high" | "medium" | "low";
  mode: "keyword" | "hybrid";
  results: AgentRoutingCandidate[];
  weakCandidates: AgentRoutingCandidate[];
  gated: boolean;
  /** Agents excluded because their circuit breaker is open (too many recent failures). */
  trippedAgents: string[];
  /** True when every result is only "low" confidence — consider ephemeral agent or user clarification. */
  allLowConfidence: boolean;
}

interface RoutingSelectionReason {
  confidence: "high" | "medium" | "low";
  matchedTerms: string[];
  score: number;
}

export function computeHybridRoutingScore(
  keywordScore: number,
  semanticScore: number,
  semanticSearchAvailable: boolean,
): number {
  if (keywordScore > 0 && semanticScore > 0) {
    return keywordScore * 0.25 + semanticScore * 0.75;
  }
  if (semanticScore > 0) {
    return semanticScore;
  }
  if (semanticSearchAvailable && keywordScore > 0) {
    return keywordScore * 0.65;
  }
  return keywordScore;
}

function toCandidate(
  name: string,
  cfg: NonNullable<ReturnType<typeof getConfig>["subAgents"][string]>,
  score: number,
  matchedTerms: string[],
  defaultModel: string,
  workspacePath: string,
): AgentRoutingCandidate {
  return {
    name,
    description: cfg.description,
    model: cfg.model?.primary ?? defaultModel,
    confidence: confidenceLabel(score),
    score,
    matchedTerms,
    capabilities: cfg.capabilities ?? [],
    tags: cfg.tags ?? [],
    costProfile: computeAgentCostProfile(name, workspacePath) ?? undefined,
  };
}

function compareRoutingResults(
  left: { combinedScore: number; matchedTerms: string[]; name: string },
  right: { combinedScore: number; matchedTerms: string[]; name: string },
): number {
  if (right.combinedScore !== left.combinedScore) {
    return right.combinedScore - left.combinedScore;
  }
  if (right.matchedTerms.length !== left.matchedTerms.length) {
    return right.matchedTerms.length - left.matchedTerms.length;
  }
  return left.name.localeCompare(right.name);
}

// Circuit breaker: if an agent fails ≥60% of its last 10 calls (min 3 samples),
// its circuit is "open" and it is excluded from routing until outcomes improve.
const CIRCUIT_LOOKBACK = 10;
const CIRCUIT_MIN_SAMPLES = 3;
const CIRCUIT_FAILURE_THRESHOLD = 0.60;

export function isCircuitOpen(agentName: string, workspacePath: string): boolean {
  const outcomes = readRecentOutcomes(workspacePath, 50);
  const recent = outcomes.filter(o => o.agent === agentName).slice(-CIRCUIT_LOOKBACK);
  if (recent.length < CIRCUIT_MIN_SAMPLES) return false;
  const failures = recent.filter(o => o.outcome === "failure").length;
  return failures / recent.length > CIRCUIT_FAILURE_THRESHOLD;
}

/**
 * Returns a small reputation boost/penalty based on recent agent outcomes.
 * Range: approximately [-0.125, +0.125]. Returns 0 when no history exists.
 */
function computeOutcomeBoost(agentName: string, workspacePath: string): number {
  const outcomes = readRecentOutcomes(workspacePath, 50);
  const relevant = outcomes.filter(o => o.agent === agentName);
  if (relevant.length === 0) return 0;
  const successRate =
    (relevant.filter(o => o.outcome === "success").length +
     relevant.filter(o => o.outcome === "partial").length * 0.5) /
    relevant.length;
  // Neutral (0.5 win rate) → 0, perfect → +0.125, all failures → -0.125
  return (successRate - 0.5) * 0.25;
}

export async function resolveAgentRouting(
  query: string,
  opts?: {
    minConfidence?: "high" | "medium" | "low";
    allowedAgents?: string[];
  },
): Promise<AgentRoutingResolution> {
  const raw = query.trim();
  const minConfidence = opts?.minConfidence ?? "medium";
  const minScore = confidenceThreshold(minConfidence);
  const config = getConfig();
  // Merge promoted agents — they are visible to routing but don't override
  // permanent config entries.
  const promotedAgents = readPromotedAgents(config.workspacePath);
  const promotedEntries = Object.entries(promotedAgents).filter(
    ([name]) => !config.subAgents[name],
  );
  let entries = [...Object.entries(config.subAgents), ...promotedEntries];
  if (opts?.allowedAgents) {
    entries = entries.filter(([name]) => opts.allowedAgents!.includes(name));
  }

  // Filter out agents whose circuit breaker is open
  const trippedAgents: string[] = entries
    .filter(([name]) => isCircuitOpen(name, config.workspacePath))
    .map(([name]) => name);
  if (trippedAgents.length > 0) {
    entries = entries.filter(([name]) => !trippedAgents.includes(name));
  }

  const semanticScores = new Map<string, number>();
  let usedSemanticSearch = false;

  if (isEmbeddingAvailable()) {
    try {
      const provider = getEmbeddingProvider();
      const results = await searchByEmbedding(raw, provider, 8);
      for (const result of results) {
        if (opts?.allowedAgents && !opts.allowedAgents.includes(result.agentName)) continue;
        semanticScores.set(result.agentName, Math.max(0, (result.score + 1) / 2));
      }
      usedSemanticSearch = semanticScores.size > 0;
    } catch {
      // fallback to keyword-only ranking
    }
  }

  let ranked = entries
    .map(([name, cfg]) => {
      const keywordMatch = scoreAgentKeywordMatch(raw, name, cfg);
      const semanticScore = semanticScores.get(name) ?? 0;
      const combinedScore = computeHybridRoutingScore(keywordMatch.score, semanticScore, usedSemanticSearch);

      const outcomeBoost = computeOutcomeBoost(name, config.workspacePath);
      const intentAdjustment = computeAgentIntentAdjustment(raw, cfg, [
        ...keywordMatch.matchedTerms,
        ...(cfg.capabilities ?? []),
        ...(cfg.tags ?? []),
      ]);
      const boostedScore = Math.max(0, Math.min(1, combinedScore + outcomeBoost + intentAdjustment));
      return {
        name,
        cfg,
        matchedTerms: keywordMatch.matchedTerms,
        combinedScore: boostedScore,
      };
    })
    .filter((result) => result.combinedScore > 0)
    .sort(compareRoutingResults)
    .slice(0, 5);

  const rerankScores = await rerankCandidates(
    raw,
    ranked.map((result) => ({
      id: result.name,
      title: result.name,
      content: [
        result.cfg.description,
        `Capabilities: ${(result.cfg.capabilities ?? []).join(", ")}`,
        `Tags: ${(result.cfg.tags ?? []).join(", ")}`,
        `Tools: ${(result.cfg.tools ?? []).join(", ")}`,
      ].filter(Boolean).join("\n"),
    })),
  );

  if (rerankScores) {
    ranked = ranked
      .map((result) => {
        const rerankScore = rerankScores.get(result.name);
        if (rerankScore === undefined) return result;
        return {
          ...result,
          combinedScore: Math.max(0, Math.min(1, result.combinedScore * 0.7 + rerankScore * 0.3)),
        };
      })
      .sort(compareRoutingResults);
  }

  const gated = ranked.filter((result) => result.combinedScore >= minScore);
  const weakCandidates = ranked
    .filter((result) => result.combinedScore < minScore)
    .slice(0, 3)
    .map((result) => toCandidate(result.name, result.cfg, result.combinedScore, result.matchedTerms, config.agents.defaults.model.primary, config.workspacePath));

  const resolvedResults = gated.map((result) =>
    toCandidate(result.name, result.cfg, result.combinedScore, result.matchedTerms, config.agents.defaults.model.primary, config.workspacePath)
  );
  const allLowConfidence = resolvedResults.length > 0 && resolvedResults.every(r => r.confidence === "low");

  return {
    query: raw,
    minConfidence,
    mode: usedSemanticSearch ? "hybrid" : "keyword",
    results: resolvedResults,
    weakCandidates,
    gated: ranked.length > 0 && gated.length === 0,
    trippedAgents,
    allLowConfidence,
  };
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

// ─── create_ephemeral_agent ───────────────────────────────────────────────────

// Tools the factory is allowed to grant to ephemeral agents (must exist in registry)
const GRANTABLE_TOOLS = new Set([
  "read_file", "list_files", "write_file", "edit_file", "create_dir", "delete_file",
  "memory_search", "memory_store", "record_lesson",
  "parallel_delegate",
  "workspace_search",
  "web_search", "web_fetch",
  "shell_exec", "run_script",
  "mcp__playwright__browser_navigate", "mcp__playwright__browser_click",
  "mcp__playwright__browser_type", "mcp__playwright__browser_snapshot",
  "mcp__playwright__browser_screenshot",
  "mcp__code_sandbox__run_js", "mcp__code_sandbox__run_ts",
  "mcp__filesystem__read_file", "mcp__filesystem__list_directory",
  "computer_session_start", "computer_session_attach", "computer_session_stop",
  "computer_list_nodes", "computer_snapshot", "computer_click", "computer_type", "computer_hotkey",
  "computer_scroll", "computer_list_windows", "computer_focus_window",
  "computer_capture_region",
  "get_site_credentials", "site_fill_credentials", "computer_type_credential",
]);

const EXECUTION_TOOL_FAMILIES = {
  shell: new Set(["shell_exec", "run_script"]),
  browser: new Set([
    "mcp__playwright__browser_navigate",
    "mcp__playwright__browser_click",
    "mcp__playwright__browser_type",
    "mcp__playwright__browser_snapshot",
    "mcp__playwright__browser_screenshot",
  ]),
  code: new Set(["mcp__code_sandbox__run_js", "mcp__code_sandbox__run_ts"]),
  computer: new Set([
    "computer_session_start", "computer_click", "computer_type", "computer_type_credential",
    "computer_hotkey", "computer_scroll", "computer_focus_window",
  ]),
};

function validateEphemeralToolSelection(tools: string[]): string[] {
  const issues: string[] = [];

  if (tools.length === 0) {
    issues.push("Ephemeral agents must have at least one valid tool.");
  }

  const usesComputerTools = tools.some(t => EXECUTION_TOOL_FAMILIES.computer.has(t));
  const toolCap = usesComputerTools ? 10 : 6;

  if (tools.length > toolCap) {
    issues.push(`Ephemeral agents may grant at most ${toolCap} tools. Keep them narrowly specialized.`);
  }

  const privilegedTools = tools.filter((toolName) => getToolTier(toolName).tier >= ToolTier.TWO_EXECUTE);
  if (privilegedTools.length > 5) {
    issues.push(`Ephemeral agents may grant at most 5 execution-capable tools, got ${privilegedTools.length}.`);
  }

  const selectedFamilies = Object.entries(EXECUTION_TOOL_FAMILIES)
    .filter(([, familyTools]) => tools.some((toolName) => familyTools.has(toolName)))
    .map(([family]) => family);

  if (selectedFamilies.length > 1) {
    issues.push(`Ephemeral agents cannot mix multiple execution families (${selectedFamilies.join(", ")}). Split the mission into focused agents instead.`);
  }

  if (tools.includes("parallel_delegate") && privilegedTools.length > 1) {
    issues.push("Ephemeral coordinator agents using parallel_delegate cannot also hold additional execution-heavy tools.");
  }

  return issues;
}

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

interface ArchitectEphemeralSpec {
  agentName?: unknown;
  description?: unknown;
  systemPrompt?: unknown;
  tools?: unknown;
  maxIterations?: unknown;
  model?: unknown;
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

function parseArchitectSpec(content: string): ArchitectEphemeralSpec {
  const trimmed = content.trim();
  const jsonStr = trimmed.startsWith("{")
    ? trimmed
    : trimmed.slice(trimmed.indexOf("{"));
  return JSON.parse(jsonStr) as ArchitectEphemeralSpec;
}

function buildArchitectPrompt(task: string): string {
  const toolList = [...GRANTABLE_TOOLS].join(", ");
  const defaultModel = getConfig().agents.defaults.model.primary;
  return [
    "You are an agent architect. Design a minimal, focused ephemeral agent to complete the given task.",
    "Return valid JSON only. Do not include markdown fences or commentary.",
    "",
    `Available tools: ${toolList}`,
    `Default model: ${defaultModel}`,
    "",
    "Rules:",
    "- Choose at most 4 tools (up to 6 for computer-use tasks).",
    "- Do NOT mix execution families: shell (shell_exec, run_script), browser (mcp__playwright__*), and code (mcp__code_sandbox__*) are separate families — pick at most one.",
    "- Keep systemPrompt concise (under 200 words). State the role, key rules, and a tool budget.",
    "- maxIterations must be between 3 and 8 for non-computer tasks. For computer-use tasks (tools starting with computer_), use 10-15 iterations because each screen interaction needs snapshot+action+verify cycles.",
    "- For computer-use agents: include 'Do NOT call the same tool with identical arguments twice in a row' in the systemPrompt. The session is already started — begin with computer_list_windows, not computer_session_start.",
    "- Choose a model appropriate for the task. Use a single string model id in model.primary when you want to override the default.",
    "",
    "Schema:",
    "{",
    '  "agentName": "<snake_case_name>",',
    '  "description": "<one line>",',
    '  "systemPrompt": "<instructions>",',
    '  "tools": ["<tool1>", "<tool2>"],',
    '  "maxIterations": 5,',
    '  "model": { "primary": "<optional model id>", "temperature": 0.1, "maxTokens": 4000 }',
    "}",
    "",
    `Task: ${task.slice(0, 1200)}`,
  ].join("\n");
}

async function requestArchitectSpec(task: string, ctx: ToolContext): Promise<ArchitectEphemeralSpec | null> {
  const settings = getEphemeralGenerationSettings();
  const architectAgentName = settings.architectAgentName;
  const architectPrompt = buildArchitectPrompt(task);

  try {
    const response = await runSubAgent({
      agentName: architectAgentName,
      task: architectPrompt,
      parentSessionId: ctx.sessionId,
      workspacePath: ctx.workspacePath,
      signal: ctx.signal,
      approvalCallback: ctx.approvalCallback,
      humanInLoopSteps: ctx.humanInLoopSteps,
      maxIterationsOverride: ctx.maxIterationsOverride,
    });
    return parseArchitectSpec(response);
  } catch (error) {
    logAudit(
      "architect_fallback_failed",
      { reason: "architect_agent_error", architectAgentName, err: String(error) },
      { sessionId: ctx.sessionId, severity: "warn" },
    );
    return null;
  }
}

function normalizeArchitectModel(model: unknown): import("../config/schema.js").SubAgentConfig["model"] {
  if (!model) return undefined;
  if (typeof model === "string" && model.trim()) {
    return { primary: model.trim() };
  }
  if (typeof model !== "object") return undefined;
  const raw = model as Record<string, unknown>;
  const primary = typeof raw.primary === "string" && raw.primary.trim() ? raw.primary.trim() : undefined;
  const temperature = typeof raw.temperature === "number" ? raw.temperature : undefined;
  const maxTokens = typeof raw.maxTokens === "number" ? raw.maxTokens : undefined;
  if (!primary && temperature === undefined && maxTokens === undefined) return undefined;
  return {
    ...(primary ? { primary } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };
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

function looksLikePlanningOnlyResult(result: string): boolean {
  const preview = result.slice(0, 600).trim();
  if (!preview) return false;

  const startsLikePlanning = /^\s*(let me|now let me|first let me|i(?:'m| am) going to|i(?:'ll| will)|i(?:'m| am) trying to|i need to|next,? i(?:'m| am) going to)\b/i.test(preview);
  if (!startsLikePlanning) return false;

  const planningAction = /\b(try|attempt|start|check|verify|focus|click|type|open|inspect|retry|look for|use|switch|launch|list|attach|create)\b/i.test(preview);
  if (!planningAction) return false;

  const unresolvedMarker = /\b(sessionid|session id|empty string|null|again|different approach|tool list|available tools)\b/i.test(preview);
  const terminalMarker = /\b(completed|done|finished|succeeded|successfully|typed|opened|clicked|verified|failed|error|could not|did not)\b/i.test(preview);
  return !terminalMarker && (unresolvedMarker || preview.length <= 220);
}

export function looksLikeFailureResult(result: string): boolean {
  if (!result.trim()) return true;
  const preview = result.slice(0, 600);
  if (/\b(no results|not found|unable to|failed to|error:|timed out|cancelled|incomplete|max.{0,20}iterations|sub_agent_max_iterations|could not complete|did not complete)\b/i.test(preview)) {
    return true;
  }

  if (/\b(need to start a session|no computer_session_start|not available in my tool list|available tools are only|missing tool|cannot complete because .*tool)\b/i.test(preview)) {
    return true;
  }

  return looksLikePlanningOnlyResult(preview);
}

/**
 * Detect infrastructure-level failures where retrying via a different agent
 * or ephemeral agent cannot succeed (host unreachable, service down, etc.).
 */
export function looksLikeInfrastructureFailure(result: string): boolean {
  if (!result.trim()) return false;
  const preview = result.slice(0, 800);
  return /\b(timed out|ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|connection refused|not reachable|host is down|failed recently and is still in cooldown|Do NOT retry)\b/i.test(preview);
}

function uniqueNames(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

async function routeAgentCandidates(query: string, ctx: ToolContext, exclude: string[]): Promise<AgentRoutingCandidate[]> {
  const excluded = new Set(exclude);
  const medium = await resolveAgentRouting(query, {
    minConfidence: "medium",
    allowedAgents: ctx.allowedAgents,
  });

  let candidates: AgentRoutingCandidate[] = medium.results;
  if (candidates.length === 0) {
    const low = await resolveAgentRouting(query, {
      minConfidence: "low",
      allowedAgents: ctx.allowedAgents,
    });
    candidates = [...low.results, ...low.weakCandidates];
  }

  // Deduplicate by name, exclude already-attempted agents
  const seen = new Set<string>();
  const routed = candidates.filter(c => {
    if (excluded.has(c.name) || seen.has(c.name)) return false;
    seen.add(c.name);
    return true;
  });

  const heuristicCandidates = buildHeuristicRoutingCandidates(query, ctx, excluded, seen);
  const mergedCandidates = [...routed, ...heuristicCandidates]
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (right.matchedTerms.length !== left.matchedTerms.length) {
        return right.matchedTerms.length - left.matchedTerms.length;
      }
      return left.name.localeCompare(right.name);
    });

  const coordinatorCandidate = heuristicCandidates.find((candidate) => candidate.name === "web_task_coordinator");
  if (coordinatorCandidate) {
    return [coordinatorCandidate, ...mergedCandidates.filter((candidate) => candidate.name !== coordinatorCandidate.name)];
  }

  return mergedCandidates;
}

function buildHeuristicRoutingCandidates(
  query: string,
  ctx: ToolContext,
  excluded: Set<string>,
  seen: Set<string>,
): AgentRoutingCandidate[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];

  const config = getConfig();
  const defaultModel = config.agents.defaults.model.primary;
  const heuristicCandidates: AgentRoutingCandidate[] = [];
  const signals = analyzeHeuristicRoutingQuery(normalized);

  const maybeAdd = (name: string, score: number, matchedTerms: string[]) => {
    if (excluded.has(name) || seen.has(name)) return;
    if (ctx.allowedAgents && !ctx.allowedAgents.includes(name)) return;
    const cfg = config.subAgents[name];
    if (!cfg) return;
    seen.add(name);
    heuristicCandidates.push(toCandidate(name, cfg, score, matchedTerms, defaultModel, config.workspacePath));
  };

  if (signals.looksWebTask && (signals.looksBroad || signals.looksFresh || signals.looksSourceHeavy)) {
    maybeAdd("web_task_coordinator", 0.62, buildCoordinatorMatchedTerms(signals));
  }

  if (signals.looksSourceHeavy || /\b(wcag|spec|specification|standard|guideline|guidelines)\b/i.test(normalized)) {
    maybeAdd("citation_researcher", 0.56, ["official", "sources"]);
  }

  return heuristicCandidates;
}

// ─── Architect fallback ───────────────────────────────────────────────────────

/**
 * After a successful ephemeral run, check whether this agent type has proven
 * reliable enough to be promoted to the permanent catalog.
 */
function maybePromoteEphemeral(
  agentName: string,
  workspacePath: string,
  cfg: import("../config/schema.js").SubAgentConfig,
): void {
  const outcomes = readRecentOutcomes(workspacePath, 100);
  const relevant = outcomes.filter(o => o.agent === agentName);
  const successes = relevant.filter(o => o.outcome === "success").length;
  if (successes < PROMOTION_MIN_SUCCESSES) return;
  const successRate = successes / relevant.length;
  if (successRate < PROMOTION_MIN_SUCCESS_RATE) return;
  // Strip "ephemeral:" prefix for the promoted catalog name
  const promotedName = agentName.replace(/^ephemeral:/, "");
  // Don't overwrite an existing permanent agent
  const config = getConfig();
  if (config.subAgents[promotedName]) return;
  promoteEphemeralAgent(workspacePath, promotedName, cfg);
}

/**
 * Last-resort routing path: ask the LLM to design a minimal ephemeral agent
 * tailored to the task, run it, and conditionally auto-promote it.
 *
 * Returns null if the LLM call or spec validation fails so the caller can
 * handle the hard-failure case gracefully.
 */
async function runArchitectFallback(task: string, ctx: ToolContext): Promise<ToolResult | null> {
  const config = getConfig();
  const settings = getEphemeralGenerationSettings();
  if (!settings.enabled) {
    return null;
  }

  const spec = await requestArchitectSpec(task, ctx);
  if (!spec) {
    return null;
  }

  const agentName = String(spec.agentName ?? "architect_agent")
    .trim()
    .replace(/\W+/g, "_")
    .slice(0, 64);
  const systemPrompt = String(spec.systemPrompt ?? "").trim();
  const description = String(spec.description ?? agentName);
  const rawTools = Array.isArray(spec.tools) ? spec.tools.map(String) : [];
  const tools = rawTools.filter(t => GRANTABLE_TOOLS.has(t));
  const usesComputerTools = tools.some(t => EXECUTION_TOOL_FAMILIES.computer.has(t));
  const iterCap = usesComputerTools ? 20 : 8;
  const iterFloor = usesComputerTools ? 8 : 1;
  const maxIterations = Math.min(iterCap, Math.max(iterFloor, Number(spec.maxIterations ?? (usesComputerTools ? 12 : 5)) || 5));
  const model = normalizeArchitectModel(spec.model);

  const policyIssues = validateEphemeralToolSelection(tools);
  if (policyIssues.length > 0 || !systemPrompt) {
    logAudit(
      "architect_fallback_rejected",
      { agentName, policyIssues, missingSystemPrompt: !systemPrompt },
      { sessionId: ctx.sessionId, severity: "warn" },
    );
    return null;
  }

  const inlineConfig: import("../config/schema.js").SubAgentConfig = {
    description,
    capabilities: [],
    tags: [],
    systemPrompt,
    tools,
    maxIterations,
    model,
  };

  const ephemeralName = `ephemeral:${agentName}`;

  logAudit(
    "architect_fallback_started",
    { agentName: ephemeralName, tools, maxIterations, model: model?.primary ?? null, architectAgentName: settings.architectAgentName },
    { sessionId: ctx.sessionId },
  );

  let result: string;
  let terminalState: string | undefined;
  try {
    const runResult = await runSubAgentWithStats({
      agentName: ephemeralName,
      task,
      parentSessionId: ctx.sessionId,
      workspacePath: ctx.workspacePath,
      signal: ctx.signal,
      approvalCallback: ctx.approvalCallback,
      humanInLoopSteps: ctx.humanInLoopSteps,
      inlineConfig,
    });
    result = runResult.output;
    terminalState = runResult.stats.terminalState;
  } catch (err) {
    logAudit(
      "architect_fallback_failed",
      { agentName: ephemeralName, reason: "run_error", err: String(err) },
      { sessionId: ctx.sessionId, severity: "warn" },
    );
    return null;
  }

  const success = terminalState === undefined || terminalState === "completed"
    ? !looksLikeFailureResult(result)
    : false;

  logAudit(
    "architect_fallback_completed",
    { agentName: ephemeralName, success, resultLength: result.length, terminalState: terminalState ?? null },
    { sessionId: ctx.sessionId },
  );

  if (success) {
    maybePromoteEphemeral(ephemeralName, ctx.workspacePath, inlineConfig);
  }

  return {
    success,
    output: success ? `[${ephemeralName}]: ${result}` : result,
    error: success ? undefined : `Architect-designed agent '${agentName}' could not complete the task.`,
    metadata: {
      agentName: ephemeralName,
      architect: true,
      tools,
      promoted: success && config.subAgents[agentName] === undefined,
    },
  };
}

async function executeDelegationWithFallback(request: DelegationRequest, ctx: ToolContext): Promise<ToolResult> {
  const title = request.taskTitle ?? summarizeText(request.task, 80);
  const signature = buildTaskSignature(title, request.task, request.dependsOn ?? []);
  const skillMatchThreshold = resolveSkillMatchThreshold(request.skillMatchThreshold);
  const explicitAgentRequested = typeof request.agentName === "string" && request.agentName.trim().length > 0;
  const reusableTask = request.taskId ? undefined : findReusableSwarmTask(ctx, signature);

  if (reusableTask?.status === "completed" && reusableTask.output) {
    return {
      success: true,
      output: reusableTask.output,
      metadata: {
        agentName: reusableTask.selectedAgent,
        taskId: reusableTask.id,
        attemptedAgents: reusableTask.attempts.map((attempt) => attempt.agentName),
        delegationSucceeded: true,
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
        attemptedAgents: reusableTask.attempts.map((attempt) => attempt.agentName),
        reused: true,
        inFlight: true,
      },
    };
  }

  if (!request.taskId && reusableTask?.status === "failed") {
    const attemptedAgents = reusableTask.attempts.map((attempt) => attempt.agentName);
    return {
      success: false,
      output: "",
      error: `Delegation for task '${title}' already failed earlier in this turn${attemptedAgents.length > 0 ? ` after trying ${attemptedAgents.join(", ")}` : ""}. Do not retry the same task verbatim. ${reusableTask.error ?? "Use a different agent or provide a more specific task."}`,
      metadata: {
        agentName: reusableTask.selectedAgent,
        taskId: reusableTask.id,
        attemptedAgents,
        delegationSucceeded: false,
        reused: true,
        priorFailure: true,
      },
    };
  }

  const taskId = request.taskId ?? reusableTask?.id ?? `task_${Object.keys(ensureSwarmState(ctx, request.task).tasks).length + 1}`;
  const taskState = getOrCreateSwarmTask(ctx, taskId, title, request.dependsOn ?? [], signature);
  const attemptedAgents: string[] = [];
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
  let lastFailureWasInfrastructure = false;
  /** Routing metadata for agents that were auto-selected by resolveAgentRouting. */
  const routingCandidateMap = new Map<string, RoutingSelectionReason>();

  // Per-turn limits — prevent runaway delegation loops from smaller local LLMs.
  const MAX_AGENT_CALLS_PER_TURN = 2;      // same agent may not be re-spawned more than this many times
  const MAX_TOTAL_DELEGATIONS_PER_TURN = 8; // hard ceiling across all agents in a single turn
  if (!ctx._turnAgentCounts) ctx._turnAgentCounts = new Map();

  while (true) {
    // Abort early if the parent turn was cancelled
    if (ctx.signal?.aborted) {
      taskState.status = "failed";
      taskState.error = "Turn cancelled.";
      publishSwarmState(ctx);
      return {
        success: false,
        output: "",
        error: "Turn cancelled — delegation aborted.",
        metadata: { taskId, attemptedAgents, delegationSucceeded: false },
      };
    }

    // Hard ceiling: if we've already spawned too many agents this turn, stop and tell the LLM to synthesize
    const totalDelegations = [...ctx._turnAgentCounts.values()].reduce((sum, n) => sum + n, 0);
    if (totalDelegations >= MAX_TOTAL_DELEGATIONS_PER_TURN) {
      taskState.status = "failed";
      taskState.error = "Turn delegation budget exceeded.";
      publishSwarmState(ctx);
      return {
        success: false,
        output: "",
        error: `Turn delegation limit (${MAX_TOTAL_DELEGATIONS_PER_TURN}) reached. Stop delegating and synthesize your findings into a final response for the user now.`,
        metadata: { taskId, attemptedAgents, delegationSucceeded: false },
      };
    }

    if (candidateQueue.length === 0) {
      if (usesAutonomousBidding && isAutonomousBiddingStarted() && !biddingTried) {
        biddingTried = true;
        const bids = await collectTaskBids(taskId, DEFAULT_AUTONOMOUS_BID_WINDOW_MS);
        bestAutoMatchScore = bids[0]?.score ?? bestAutoMatchScore;
        if (shouldGenerateEphemeralAgent(bestAutoMatchScore, skillMatchThreshold)) {
          candidateQueue = [];
        } else {
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

      if (candidateQueue.length === 0) {
        if (attemptedAgents.length > 0 && shouldPreferWebTaskCoordinator(request.routingQuery ?? request.task, ctx, attemptedAgents)) {
          routingCandidateMap.set("web_task_coordinator", {
            confidence: "medium",
            matchedTerms: buildCoordinatorMatchedTerms(analyzeHeuristicRoutingQuery(request.routingQuery ?? request.task)),
            score: 0.62,
          });
          candidateQueue.push("web_task_coordinator");
        }
      }

      if (candidateQueue.length === 0) {
        const routingCandidates = await routeAgentCandidates(request.routingQuery ?? request.task, ctx, attemptedAgents);
        if (routingCandidates.length > 0) {
          const topCandidate = routingCandidates[0]!;
          bestAutoMatchScore = topCandidate.score;
          const shouldQueueRoutedCandidate = explicitAgentRequested
            || attemptedAgents.length > 0
            || !shouldGenerateEphemeralAgent(bestAutoMatchScore, skillMatchThreshold);
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

      if (candidateQueue.length === 0) break;
    }

    const candidate = candidateQueue.shift()!;
    if (attemptedAgents.includes(candidate)) continue;

    // Per-agent repeat cap: skip if this agent has already been called MAX_AGENT_CALLS_PER_TURN times this turn
    const prevCalls = ctx._turnAgentCounts.get(candidate) ?? 0;
    if (prevCalls >= MAX_AGENT_CALLS_PER_TURN) {
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

      const subAgentArgs = {
        agentName: candidate,
        task: request.task,
        context: enrichedContext,
        parentSessionId: ctx.sessionId,
        workspacePath: ctx.workspacePath,
        signal: ctx.signal,
        approvalCallback: ctx.approvalCallback,
        humanInLoopSteps: ctx.humanInLoopSteps,
        onComputerAction: ctx.onComputerAction,
        onComputerScreenshot: ctx.onComputerScreenshot,
        onComputerSessionState: ctx.onComputerSessionState,
        maxIterationsOverride: ctx.maxIterationsOverride,
      };

      let output: string;
      let stats: { toolCount: number; iterations: number; toolNames: string[]; terminalState?: string } | undefined;

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
      }

      const weak = (stats?.terminalState !== undefined && stats.terminalState !== "completed") || looksLikeFailureResult(output);
      attempt.finishedAt = new Date().toISOString();
      attempt.summary = summarizeText(output);

      if (weak) {
        attempt.status = "failed";
        taskState.error = summarizeText(output);
        taskState.status = "failed";
        lastFailureWasInfrastructure = looksLikeInfrastructureFailure(output);
        publishSwarmState(ctx);
        emitSwarmEvent("task_failed", { sessionId: ctx.sessionId, taskId, agentName: candidate, data: { reason: "weak_result" } });
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
        continue;
      }

      // Store successful output as a partial result and extract any FACT: lines
      await appendPartialResult({ sessionId: ctx.sessionId, taskId, agentName: candidate, content: summarizeText(output, 1200), ts: attempt.finishedAt! });
      const extractedFacts = extractFactsFromOutput(output);
      for (const [k, v] of Object.entries(extractedFacts)) {
        await writeSharedFact(ctx.sessionId, k, v);
      }

      attempt.status = "completed";
      taskState.status = "completed";
      taskState.output = output;
      taskState.error = undefined;
      ensureSwarmState(ctx, request.task).updatedAt = attempt.finishedAt;
      publishSwarmState(ctx);
      emitSwarmEvent("task_completed", { sessionId: ctx.sessionId, taskId, agentName: candidate });
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

      const routingInfo = routingCandidateMap.get(candidate);
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
          ...(routingInfo && { routingReason: { confidence: routingInfo.confidence, matchedTerms: routingInfo.matchedTerms, score: routingInfo.score } }),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      attempt.finishedAt = new Date().toISOString();
      attempt.status = "failed";
      attempt.summary = summarizeText(message);
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
  if (!explicitAgentRequested && !lastFailureWasInfrastructure && (attemptedAgents.length === 0 || shouldGenerateEphemeralAgent(bestAutoMatchScore, skillMatchThreshold))) {
    const architectResult = await runArchitectFallback(request.task, ctx);
    if (architectResult) {
      clearTaskBids(taskId);
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

  taskState.status = "failed";
  taskState.error = taskState.error ?? "No suitable agent completed the task.";
  clearTaskBids(taskId);
  ensureSwarmState(ctx, request.task).updatedAt = new Date().toISOString();
  publishSwarmState(ctx);
  return {
    success: false,
    output: "",
    error: `All candidate agents failed for task '${title}'. ${taskState.error}`,
    metadata: { taskId, attemptedAgents, delegationSucceeded: false },
  };
}

function formatSwarmState(state: SwarmState): string {
  const tasks = Object.values(state.tasks);
  if (tasks.length === 0) {
    return `Objective: ${state.objective}\nNo swarm tasks recorded yet.`;
  }

  const lines = tasks.map((task) => {
    const attempts = task.attempts.map((attempt) => `${attempt.agentName}:${attempt.status}`).join(", ");
    return `- ${task.id} [${task.status}] ${task.title}${task.selectedAgent ? ` via ${task.selectedAgent}` : ""}${attempts ? ` | attempts: ${attempts}` : ""}`;
  });

  return `Objective: ${state.objective}\nUpdated: ${state.updatedAt}\nTasks:\n${lines.join("\n")}`;
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

    const remaining = new Map(rawNodes.map((node) => [node.id, node]));
    const completed = new Set<string>();
    const failed = new Set<string>();
    const blocked = new Set<string>();
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

    while (remaining.size > 0) {
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

      const ready = [...remaining.values()].filter((node) => (node.dependsOn ?? []).every((dep) => completed.has(dep)));
      if (ready.length === 0) {
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

      // Emit ready events for all nodes about to execute
      for (const node of ready) {
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
      }

      const results = await Promise.all(ready.map(async (node) => ({
        node,
        result: await executeDelegationWithFallback({
          agentName: node.agentName,
          task: node.task,
          context: node.context,
          fallbackAgents: node.fallbackAgents,
          routingQuery: node.routingQuery,
          skillMatchThreshold: node.skillMatchThreshold,
          taskId: node.id,
          taskTitle: node.title,
          dependsOn: node.dependsOn,
        }, ctx),
      })));

      for (const { node, result } of results) {
        remaining.delete(node.id);
        if (result.success) completed.add(node.id);
        else failed.add(node.id);
      }
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
      return `- ${node.id} [${task?.status ?? "unknown"}] ${task?.selectedAgent ?? node.agentName ?? "unassigned"}`;
    }).join("\n");

    return {
      success: failed.size === 0,
      output: `Swarm task graph complete.\n${summary}\n\n${formatSwarmState(swarmState)}`,
      metadata: { completed: [...completed], failed: [...failed], blocked: [...blocked], swarmState },
    };
  },
});

registerTool({
  name: "create_ephemeral_agent",
  description: [
    "Design and immediately run a purpose-built single-use agent for a task that no configured agent covers.",
    "Provide the agent's full spec inline: system prompt, tool list, model, and the task to run.",
    "The agent is ephemeral — it runs once and is discarded.",
    "Use this when list_agents shows no suitable agent for the required task.",
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      agentName: {
        type: "string",
        description: "Descriptive name for logging (e.g. 'judicative_researcher', 'tax_law_analyst')",
      },
      description: {
        type: "string",
        description: "One-line description of what this agent does",
      },
      systemPrompt: {
        type: "string",
        description: "Full system prompt for the agent — include role, domain expertise, and RULES for tool use limits",
      },
      tools: {
        type: "array",
        items: { type: "string" },
        description: `Tools to grant. Allowed values: ${[...GRANTABLE_TOOLS].join(", ")}`,
      },
      model: {
        type: "object",
        description: "Optional model override. Example: { \"primary\": \"lmstudio/qwen3.5-9b\", \"temperature\": 0.1 }",
        properties: {
          primary: { type: "string" },
          temperature: { type: "number" },
          maxTokens: { type: "number" },
        },
      },
      maxIterations: {
        type: "number",
        description: "Max tool-call iterations before the agent is forced to stop (default: 5, max: 10)",
      },
      task: {
        type: "string",
        description: "The task or question for the ephemeral agent to complete",
      },
      context: {
        type: "string",
        description: "Optional background context to pass to the agent",
      },
    },
    required: ["agentName", "systemPrompt", "tools", "task"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const agentName = String(args["agentName"] ?? "").trim().replace(/\W+/g, "_").slice(0, 64);
    const task = String(args["task"] ?? "").trim();
    const context = args["context"] ? String(args["context"]) : undefined;
    const systemPrompt = String(args["systemPrompt"] ?? "").trim();

    if (!agentName || !task || !systemPrompt) {
      return { success: false, output: "", error: "agentName, systemPrompt, and task are required" };
    }

    // Validate and filter tool list
    const requestedTools = Array.isArray(args["tools"]) ? args["tools"].map(String) : [];
    const tools = requestedTools.filter(t => GRANTABLE_TOOLS.has(t));
    const rejected = requestedTools.filter(t => !GRANTABLE_TOOLS.has(t));
    if (rejected.length > 0) {
      // Non-fatal: log and proceed with the valid subset
      ctx; // used for sessionId below
    }

    const policyIssues = validateEphemeralToolSelection(tools);
    if (policyIssues.length > 0) {
      logAudit("ephemeral_agent_rejected", {
        agentName,
        requestedTools,
        grantedTools: tools,
        rejectedTools: rejected,
        reasons: policyIssues,
      }, { sessionId: ctx.sessionId, severity: "warn", channel: "agent-factory" });

      return {
        success: false,
        output: "",
        error: policyIssues.join(" "),
        metadata: { agentName, rejectedTools: rejected, grantedTools: tools },
      };
    }

    // Build model config
    const modelOverride = args["model"] && typeof args["model"] === "object"
      ? args["model"] as Record<string, unknown>
      : {};

    const maxIter = Math.min(10, Math.max(1, Number(args["maxIterations"] ?? 5) || 5));

    const inlineConfig = {
      description: String(args["description"] ?? agentName),
      capabilities: [],
      tags: [],
      systemPrompt,
      tools,
      maxIterations: maxIter,
      model: Object.keys(modelOverride).length > 0 ? {
        primary: modelOverride["primary"] ? String(modelOverride["primary"]) : undefined,
        temperature: typeof modelOverride["temperature"] === "number" ? modelOverride["temperature"] : undefined,
        maxTokens: typeof modelOverride["maxTokens"] === "number" ? modelOverride["maxTokens"] : undefined,
      } : undefined,
    };

    const ephemeralName = `ephemeral:${agentName}`;

    const result = await runSubAgent({
      agentName: ephemeralName,
      task,
      context,
      parentSessionId: ctx.sessionId,
      workspacePath: ctx.workspacePath,
      signal: ctx.signal,
      approvalCallback: ctx.approvalCallback,
      humanInLoopSteps: ctx.humanInLoopSteps,
      inlineConfig,
      // Note: ephemeral agents have their own maxIter baked into inlineConfig; ctx.maxIterationsOverride is intentionally not forwarded here.
    });

    const note = rejected.length > 0 ? ` [Note: tools ${rejected.join(", ")} were rejected as not grantable]` : "";
    return {
      success: true,
      output: `[ephemeral:${agentName}]: ${result}${note}`,
      metadata: { agentName: ephemeralName, grantedTools: tools, rejectedTools: rejected },
    };
  },
});

// ─── list_agents ──────────────────────────────────────────────────────────────

registerTool({
  name: "list_agents",
  description: "List all available specialized sub-agents with their descriptions and allowed tools. Call this first to discover which agents are available before delegating.",
  parameters: {
    type: "object",
    properties: {},
  },
  async execute(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const config = getConfig();
    const promotedAgents = readPromotedAgents(config.workspacePath);
    const promotedEntries = Object.entries(promotedAgents).filter(
      ([name]) => !config.subAgents[name],
    );
    let entries = [...Object.entries(config.subAgents), ...promotedEntries];

    // Filter to scene's allowed agents if a scope is set
    if (ctx.allowedAgents) {
      entries = entries.filter(([name]) => ctx.allowedAgents!.includes(name));
    }

    if (entries.length === 0) {
      const scopeNote = ctx.allowedAgents
        ? ` (this scene restricts delegation to: ${ctx.allowedAgents.join(", ")})`
        : "";
      return {
        success: true,
        output: `No sub-agents are configured${scopeNote}. Add them under \`subAgents\` in starlingai.json.`,
      };
    }

    const promotedNames = new Set(Object.keys(promotedAgents).filter(name => !config.subAgents[name]));
    const lines = entries.map(([name, cfg]) => {
      const model = cfg.model?.primary ?? config.agents.defaults.model.primary;
      const toolList = cfg.tools ? cfg.tools.join(", ") : "all tools";
      const capabilities = cfg.capabilities && cfg.capabilities.length > 0
        ? `\n  Capabilities: ${cfg.capabilities.join(", ")}`
        : "";
      const tags = cfg.tags && cfg.tags.length > 0
        ? `\n  Tags: ${cfg.tags.join(", ")}`
        : "";
      const domainNote = cfg.domain ? `\n  Domain: ${cfg.domain}` : "";
      const promotedNote = promotedNames.has(name) ? " (auto-promoted)" : "";
      const circuitStatus = isCircuitOpen(name, config.workspacePath)
        ? `\n  ⚠ CIRCUIT OPEN — too many recent failures, excluded from auto-routing`
        : "";
      const costProfile = computeAgentCostProfile(name, config.workspacePath);
      const costNote = costProfile ? formatCostProfile(costProfile) : "";
      return `**${name}**${promotedNote} (${model})\n  ${cfg.description}${capabilities}${tags}${domainNote}${circuitStatus}${costNote}\n  Tools: ${toolList}`;
    });

    const ephemeralNote = `\n\n---\nIf no agent above fits the task, use **create_ephemeral_agent** to design a purpose-built single-use agent on the fly.`;

    return {
      success: true,
      output: `Available sub-agents (${entries.length}):\n\n${lines.join("\n\n")}${ephemeralNote}`,
    };
  },
});

// ─── search_agents ────────────────────────────────────────────────────────────
// Keyword search over agent names and descriptions — keeps orchestrator context
// small when the agent registry grows large.

registerTool({
  name: "search_agents",
  description: "Search available sub-agents by keyword(s). Returns only agents whose name or description matches the query — much lighter than list_agents when the registry is large. Use this when you need a specific capability but don't know the exact agent name.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Space-separated keywords to search for in agent names and descriptions (case-insensitive)",
      },
      minConfidence: {
        type: "string",
        enum: ["high", "medium", "low"],
        description: "Minimum confidence required for results. Default is medium. Use low to inspect weak matches.",
      },
    },
    required: ["query"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const raw = String(args["query"] ?? "").trim();
    if (!raw) return { success: false, output: "", error: "query is required" };
    const minConfidence = args["minConfidence"] === "high" || args["minConfidence"] === "low"
      ? args["minConfidence"]
      : "medium";
    const resolution = await resolveAgentRouting(raw, {
      minConfidence,
      allowedAgents: ctx.allowedAgents,
    });

    logAudit("agent_routing_evaluated", {
      query: raw,
      minConfidence,
      mode: resolution.mode,
      resultCount: resolution.results.length,
      weakCount: resolution.weakCandidates.length,
      gated: resolution.gated,
      trippedAgents: resolution.trippedAgents,
      allLowConfidence: resolution.allLowConfidence,
      topResult: resolution.results[0]?.name ?? null,
    }, { sessionId: ctx.sessionId, channel: "agent-routing" });

    const circuitNote = resolution.trippedAgents.length > 0
      ? `\n⚠ Circuit breakers open (excluded from routing): ${resolution.trippedAgents.join(", ")}`
      : "";

    if (resolution.results.length === 0 && resolution.weakCandidates.length === 0) {
      return {
        success: true,
        output: `No agents matched "${raw}". Try broader keywords or call list_agents to see all available agents.${circuitNote}`,
      };
    }

    if (resolution.results.length === 0) {
      const topCandidates = resolution.weakCandidates.map((candidate) => `- ${candidate.name} (${candidate.confidence})`).join("\n");
      return {
        success: true,
        output: `No agents matched "${raw}" with ${minConfidence} confidence or better. Call list_agents for the full catalog, use search_agents with minConfidence=low to inspect weak matches, or use create_ephemeral_agent if this is a new capability.${circuitNote}\n\nTop weak candidates:\n${topCandidates}`,
      };
    }

    const topAgent = resolution.results[0]!;
    const lowConfidenceWarning = resolution.allLowConfidence
      ? `\n⚠ LOW CONFIDENCE: No specialist found with medium+ confidence for this query. Consider using create_ephemeral_agent for a purpose-built agent, or ask the user to clarify the task before delegating.`
      : "";
    return {
      success: true,
      output: `➡ NEXT ACTION: Call delegate_to_agent(agentName="${topAgent.name}", task="<your task>") NOW. Do NOT call search_agents again.\n\nAgents matching "${raw}" [${resolution.mode} search, ${resolution.results.length} result(s)]:\n\n${resolution.results.map(formatRoutingCandidate).join("\n\n")}${lowConfidenceWarning}${circuitNote}`,
    };
  },
});

// ─── delegate_to_agent ────────────────────────────────────────────────────────

registerTool({
  name: "delegate_to_agent",
  description: "Delegate a task to a named specialized sub-agent. The sub-agent runs autonomously with its own model and tool set, then returns its result. Use list_agents first to see what agents are available.",
  parameters: {
    type: "object",
    properties: {
      agentName: {
        type: "string",
        description: "Name of the sub-agent to invoke (must match a key in subAgents config)",
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
    required: ["agentName", "task"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const agentName = String(args["agentName"] ?? "").trim();
    const task = String(args["task"] ?? "").trim();
    const context = args["context"] ? String(args["context"]) : undefined;
    const fallbackAgents = Array.isArray(args["fallbackAgents"]) ? args["fallbackAgents"].map(String) : undefined;
    const routingQuery = args["routingQuery"] ? String(args["routingQuery"]) : undefined;
    const skillMatchThreshold = typeof args["skillMatchThreshold"] === "number" ? args["skillMatchThreshold"] : undefined;

    if (!agentName) {
      return { success: false, output: "", error: "agentName is required" };
    }
    if (!task) {
      return { success: false, output: "", error: "task is required" };
    }

    // Enforce per-scene agent scope
    if (ctx.allowedAgents && !ctx.allowedAgents.includes(agentName)) {
      return {
        success: false,
        output: "",
        error: `Agent '${agentName}' is not permitted in this scene. Allowed agents: ${ctx.allowedAgents.join(", ")}`,
      };
    }

    return executeDelegationWithFallback({
      agentName,
      task,
      context,
      fallbackAgents,
      routingQuery,
      skillMatchThreshold,
      taskTitle: summarizeText(task, 80),
    }, ctx);
  },
});

// ─── parallel_delegate ────────────────────────────────────────────────────────

registerTool({
  name: "parallel_delegate",
  description: "Run multiple independent sub-agent tasks in parallel and collect all results. Use when the orchestrator needs outputs from 2–5 agents that don't depend on each other. Returns all results concatenated with separators.",
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

    // Enforce per-scene agent scope for all explicit primary/fallback tasks upfront
    for (const t of tasks) {
      for (const candidate of [t.agentName, ...(t.fallbackAgents ?? [])].filter(Boolean) as string[]) {
        if (ctx.allowedAgents && !ctx.allowedAgents.includes(candidate)) {
          return {
            success: false, output: "",
            error: `Agent '${candidate}' is not permitted in this scene. Allowed: ${ctx.allowedAgents.join(", ")}`,
          };
        }
      }
    }

    logAudit(
      "parallel_delegate_started",
      { taskCount: tasks.length, agents: tasks.map(t => t.agentName ?? "auto") },
      { sessionId: ctx.sessionId }
    );

    const results = await Promise.all(
      tasks.map((taskSpec, index) => executeDelegationWithFallback({
        ...taskSpec,
        taskId: `parallel_${index + 1}`,
        taskTitle: summarizeText(taskSpec.task, 80),
      }, ctx))
    );

    const formatted = results.map((result, index) => {
      const label = tasks[index]?.agentName ?? `task_${index + 1}`;
      if (result.success) return `**[${label}]**:\n${result.output}`;
      return `**[${label}]** (failed): ${result.error ?? "unknown error"}`;
    });

    const succeeded = results.filter(result => result.success).length;

    return {
      success: succeeded > 0,
      output: formatted.join("\n\n---\n\n"),
      metadata: { taskCount: tasks.length, succeeded, failed: tasks.length - succeeded },
    };
  },
});
