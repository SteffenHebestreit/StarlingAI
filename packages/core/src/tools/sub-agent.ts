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
import { extractInlineHtmlDocument, looksLikeCompleteHtmlDocument } from "../agent/deliverable-intent.js";
import { looksLikeContainerLevelFailure, looksLikeModelTemplateArtifact } from "../agent/container-failure.js";
import { getConfig } from "../config/loader.js";
import { buildAgentTokenIdf, getEmbeddingSearchStatus, isEmbeddingAvailable, scoreAgentKeywordMatch, searchByEmbedding } from "../providers/embeddings.js";
import { getEmbeddingProvider, getChatProviderForTier, getChatProvider } from "../providers/index.js";
import { effectiveOrchestration } from "../runtime/effort-context.js";
import { normalizeDelegationTaskLanguage } from "../agent/delegation-language.js";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";
import { appendOutcome, readRecentOutcomes, computeAgentCostProfile, computeOutcomeRoutingMultiplier, extractTaskKeywords, type AgentCostProfile } from "../agent/outcomes.js";
import { readPromotedAgents } from "../agent/promoted-agents.js";
import { emitSwarmEvent } from "../swarm/bus.js";
import { announceAgentCapability } from "../swarm/capabilities.js";
import { clearTaskBids, collectTaskBids, DEFAULT_AUTONOMOUS_BID_WINDOW_MS, isAutonomousBiddingStarted } from "../swarm/bidding.js";
import { acquireTaskLock, releaseTaskLock } from "../swarm/locks.js";
import { formatSharedContextForPrompt, appendPartialResult, extractFactsFromOutput, writeSharedFact, searchSharedFacts, searchPartialResults, readAllFacts, currentTurnFactKeys } from "../swarm/memory.js";
import { deriveSharedSessionId } from "./memory.js";
import { graphPromoteFact } from "../memory/graph-service.js";
import { rerankCandidates } from "../retrieval/reranker.js";
import { recordCapabilityGap } from "../agent/self-improve.js";
import { longRunningGenerationManager } from "../agent/long-running-generation.js";

const log = childLogger("tool:sub-agent");
import { isCanonicalResearchSliceTask } from "../agent/source-sensitive-delegation.js";
import { awaitQuorum } from "../agent/delegation-quorum.js";
import { shouldCheckSubAgentDisagreement, checkSubAgentDisagreement } from "../agent/sub-agent-disagreement.js";

const SERVER_EXECUTION_AGENT_NAMES = new Set(["shell_agent", "ops_triage", "infrastructure_agent"]);
/**
 * Minimum score for a candidate to qualify when semantic embeddings are
 * actually used (rerank mode).  Semantic similarity scores are normalized
 * narrowly around 0.5–0.95, so the cutoff sits high.
 */
const SEMANTIC_AGENT_ROUTING_MIN_SCORE = 0.72;

/**
 * Minimum score for a candidate to qualify when only keyword scoring is
 * available (no embedding endpoint reachable — typical in unit tests and
 * when LM Studio is unavailable).  Keyword scores are aggressively
 * normalized down by the per-token-then-average-and-clamp pipeline in
 * scoreAgentKeywordMatch; they rarely cross 0.72 even for unambiguous
 * specialist matches like "git commit" → git_developer.  A higher floor
 * here causes the routing layer to silently drop legitimate candidates
 * and return "none" for common queries.
 */
const KEYWORD_AGENT_ROUTING_MIN_SCORE = 0.45;

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
  /** GPU/compute resource requirements declared by the agent (Stage 9). */
  computeProfile?: { gpuPreferred: boolean; gpuTier: string; minVramMb: number };
}

export interface AgentRoutingResolution {
  query: string;
  minConfidence: "high" | "medium" | "low";
  mode: "keyword" | "hybrid" | "semantic_unavailable";
  results: AgentRoutingCandidate[];
  weakCandidates: AgentRoutingCandidate[];
  gated: boolean;
  /** Agents excluded because their circuit breaker is open (too many recent failures). */
  trippedAgents: string[];
  /** True when every result is only "low" confidence — consider ephemeral agent or user clarification. */
  allLowConfidence: boolean;
  /** Agents explicitly excluded from this routing pass, such as the invoking coordinator. */
  excludedAgents?: string[];
  /** Why semantic search could not run even though an embedding model is configured. */
  semanticUnavailableReason?: string;
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
  if (semanticSearchAvailable) {
    return semanticScore >= SEMANTIC_AGENT_ROUTING_MIN_SCORE ? semanticScore : 0;
  }
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
    computeProfile: cfg.compute ? {
      gpuPreferred: cfg.compute.gpuPreferred ?? false,
      gpuTier: cfg.compute.gpuTier ?? "none",
      minVramMb: cfg.compute.minVramMb ?? 0,
    } : undefined,
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

/** Shared stop-word set for query shortening — covers the most common
 *  English + German fillers that don't carry routing signal. Kept small so
 *  legitimate domain words (research, build, audio) survive. */
const ROUTING_QUERY_STOP_WORDS = new Set<string>([
  "a", "an", "and", "or", "the", "of", "for", "with", "to", "in", "on", "at",
  "by", "from", "as", "is", "are", "be", "this", "that", "these", "those",
  "der", "die", "das", "den", "dem", "ein", "eine", "einen", "einer", "eines",
  "und", "oder", "für", "fuer", "mit", "von", "in", "auf", "zu", "im", "am",
]);

/** Generic verbs/nouns that don't narrow the embedding — drop when shortening. */
const ROUTING_QUERY_FILLER = new Set<string>([
  "task", "tasks", "help", "do", "make", "get", "show", "find", "use", "using",
  "via", "etc",
]);

/** Count meaningful content words in a routing query.  Used to detect
 *  over-specified queries that fragment the embedding similarity. */
function countRoutingQueryContentTokens(query: string): number {
  return query
    .toLowerCase()
    .split(/[\s,;:]+/)
    .filter((token) => token.length >= 3 && !ROUTING_QUERY_STOP_WORDS.has(token) && !ROUTING_QUERY_FILLER.has(token))
    .length;
}

/**
 * Shorten an over-specified routing query by keeping only the leading
 * distinctive content tokens.  Triggered after a long query returns 0
 * results — the embedding fragments across too many concepts and matches
 * nothing, but the same terms in a tighter slice often hit a real agent.
 *
 * Example (audit session 0a93078b, May 2026):
 *   Original: "hardware engineering circuit design PCB layout component
 *              selection MEMS microphone ESP32 audio recording" (12 content
 *              tokens, 0 results)
 *   Shortened: "hardware engineering circuit design PCB" (5 tokens) —
 *              still 0 here, but "hardware research" or "audio research"
 *              would hit `researcher`.  In practice we keep the leading
 *              5 distinctive tokens since they tend to capture the user's
 *              primary domain.
 *
 * Returns null when the query is already short enough that shortening
 * wouldn't change behavior.
 */
export function shortenOverspecifiedRoutingQuery(query: string): string | null {
  const tokens = query.split(/\s+/).filter(Boolean);
  if (tokens.length <= 6) return null;

  const distinctive: string[] = [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower.length < 3) continue;
    if (ROUTING_QUERY_STOP_WORDS.has(lower)) continue;
    if (ROUTING_QUERY_FILLER.has(lower)) continue;
    distinctive.push(token);
    if (distinctive.length >= 5) break;
  }

  if (distinctive.length === 0) return null;
  const shortened = distinctive.join(" ");
  // Don't return a "shortened" query that's actually the same as the input.
  if (shortened === query.trim()) return null;
  return shortened;
}

export async function resolveAgentRouting(
  query: string,
  opts?: {
    minConfidence?: "high" | "medium" | "low";
    allowedAgents?: string[];
    excludeAgents?: string[];
    allowKeywordFallback?: boolean;
  },
): Promise<AgentRoutingResolution> {
  const raw = query.trim();
  const minConfidence = opts?.minConfidence ?? "medium";
  // The qualification floor is computed AFTER we know whether semantic
  // search produced results (see further down), since the floor depends
  // on which scoring mode is in use.  Keep it as `let` here so the
  // post-rerank gate can read the resolved value.
  let minScore = Math.max(confidenceThreshold(minConfidence), SEMANTIC_AGENT_ROUTING_MIN_SCORE);
  const config = getConfig();
  const embeddingConfigured = Boolean(config.agents.defaults.model.embeddingModel);
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
  if (opts?.excludeAgents?.length) {
    const excludedAgents = new Set(opts.excludeAgents);
    entries = entries.filter(([name]) => !excludedAgents.has(name));
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
  let semanticSearchAttempted = false;

  if (isEmbeddingAvailable()) {
    try {
      semanticSearchAttempted = true;
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

  if (opts?.allowKeywordFallback === false && embeddingConfigured && !usedSemanticSearch) {
    return {
      query: raw,
      minConfidence,
      mode: "semantic_unavailable",
      results: [],
      weakCandidates: [],
      gated: true,
      trippedAgents,
      allLowConfidence: false,
      excludedAgents: opts?.excludeAgents,
      semanticUnavailableReason: semanticSearchAttempted
        ? "embedding_query_failed_or_empty"
        : "embedding_index_unavailable",
    };
  }

  // Resolve the qualification floor now that we know which scoring mode
  // is active.  Keyword-only scores are aggressively normalized down by
  // scoreAgentKeywordMatch (per-token-then-coverage-then-clamp) and rarely
  // cross 0.72 even for unambiguous specialist matches; using the
  // semantic floor in that mode silently drops legitimate candidates.
  // At keyword mode we honor the requested confidence label verbatim:
  //   high   → 0.72  (only confident keyword matches qualify)
  //   medium → 0.45  (specialist matches with one or two keyword hits)
  //   low    → 0     (anything with score > 0 surfaces — useful when the
  //                   caller is doing its own re-rank or mining the long
  //                   tail for capability-gap detection)
  if (!usedSemanticSearch) {
    minScore = confidenceThreshold(minConfidence);
  }

  // G32: Task-class keywords for outcome-weighted routing multiplier
  const queryKeywords = extractTaskKeywords(raw);

  // Lexical-fallback discrimination: IDF over the agent corpus so rare query tokens
  // dominate when embeddings are degraded (without it, common tokens flatten the
  // ranking and routing collapses to ~equal scores — audit 9b5196ad). Semantic mode
  // never reads keyword scores, so this only shapes the degraded path.
  const lexicalIdf = usedSemanticSearch ? undefined : buildAgentTokenIdf(entries);
  let ranked = entries
    .map(([name, cfg]) => {
      const keywordMatch = usedSemanticSearch ? { score: 0, matchedTerms: [] } : scoreAgentKeywordMatch(raw, name, cfg, lexicalIdf);
      const semanticScore = semanticScores.get(name) ?? 0;
      const combinedScore = computeHybridRoutingScore(keywordMatch.score, semanticScore, usedSemanticSearch);

      const outcomeBoost = usedSemanticSearch ? 0 : computeOutcomeBoost(name, config.workspacePath);
      // G32: Multiply by historical outcome weight (±20% max, requires ≥25 samples)
      const outcomeMultiplier = usedSemanticSearch ? 1 : computeOutcomeRoutingMultiplier(name, queryKeywords, config.workspacePath);
      const boostedScore = Math.max(0, Math.min(1, (combinedScore + outcomeBoost) * outcomeMultiplier));
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

  ranked = ranked.sort(compareRoutingResults).slice(0, 5);

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
    excludedAgents: opts?.excludeAgents ? [...opts.excludeAgents] : undefined,
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

// ─── ephemeral-agent / architect factory ──────────────────────────────────────
// The ephemeral-agent cluster (getEphemeralGenerationSettings, requestArchitectSpec,
// normalizeArchitectModel, validateEphemeralToolSelection, maybePromoteEphemeral,
// runArchitectFallback, GRANTABLE_TOOLS, EXECUTION_TOOL_FAMILIES, and the
// create_ephemeral_agent tool) was extracted verbatim to ./ephemeral-agent-factory.ts.
// runArchitectFallback is imported back here for executeDelegationWithFallback. The
// factory module is imported for its side effect so create_ephemeral_agent stays
// registered when this module is loaded (the side-effect import lives with the other
// top-level imports). The shared helpers below (isWebReachingToolName,
// RESEARCH_CAPABLE_TOOL_NAMES, …) are used by both clusters and stay here.

/** Tool names that satisfy "external research" intent — i.e. the agent can
 *  reach the open internet for datasheets, prices, supplier inventory, news,
 *  documentation, or product specs.  Used by the tool-fit validator below. */
const RESEARCH_CAPABLE_TOOL_NAMES = new Set<string>([
  "web_search",
  "web_fetch",
  "mcp__playwright__browser_navigate",
  "mcp__playwright__browser_click",
  "mcp__playwright__browser_type",
  "mcp__playwright__browser_snapshot",
  "mcp__playwright__browser_screenshot",
]);

/** Coordination tools — an agent holding any of these can fan a research task
 *  out to a web-capable specialist, so it counts as research-capable. */
const COORDINATION_TOOL_NAMES = new Set<string>([
  "delegate_to_agent", "swarm_delegate", "parallel_delegate", "run_task_graph", "run_workflow",
]);

/** True for a tool name that can reach the open web (real config tool names,
 *  not just the ephemeral mcp__playwright__ grants in RESEARCH_CAPABLE_TOOL_NAMES). */
export function isWebReachingToolName(toolName: string): boolean {
  if (RESEARCH_CAPABLE_TOOL_NAMES.has(toolName)) return true;
  return toolName === "web_search"
    || toolName === "web_fetch"
    || toolName === "fetch_image"
    || toolName === "url_inspect"
    || toolName.startsWith("browser_");
}

/**
 * True for a tool that can GATHER fresh external evidence (search + fetch page
 * content + drive a browser). This is the narrower cousin of isWebReachingToolName:
 * it excludes url_inspect, which only probes a URL you already have (headers,
 * redirects, content-type) and cannot search or read page content. An agent whose
 * only "web" tool is url_inspect cannot do PRIMARY research — evidence_analyst
 * (url_inspect only, no web_search/web_fetch) was wrongly classed research-capable
 * and dead-looped url_inspect on a 404 after being handed a gather task (audit 687a224b).
 */
export function isWebGatheringToolName(toolName: string): boolean {
  if (toolName === "url_inspect") return false;
  return isWebReachingToolName(toolName);
}

/**
 * Pure capability check against an agent's tool list. Research-capable means it can
 * GATHER from the web directly (web_search/web_fetch/browser_*) or is a coordinator
 * that can delegate to one that does. url_inspect alone does NOT qualify (it only
 * probes a known URL, cannot search/fetch). An undefined tool list means "inherit all
 * tools" → qualifies. Undefined cfg (unknown/ephemeral) → not blocked.
 */
export function agentCfgIsResearchCapable(cfg: { tools?: string[] } | undefined): boolean {
  if (!cfg) return true;
  if (!cfg.tools) return true; // inherits the full tool set
  return cfg.tools.some(isWebGatheringToolName) || cfg.tools.some((t) => COORDINATION_TOOL_NAMES.has(t));
}

/**
 * Whether an agent can actually carry out an external-research task. Agents with
 * an explicit tool list of only generators (image_creator, chart_designer) are
 * NOT research-capable.
 */
function agentIsResearchCapable(agentName: string): boolean {
  const config = getConfig();
  return agentCfgIsResearchCapable(config.subAgents[agentName] ?? readPromotedAgents(config.workspacePath)[agentName]);
}

/**
 * Whether an agent is a meta/factory agent — one whose job is to MINT other
 * agents (it holds create_ephemeral_agent). Such an agent must never be picked
 * by UNDIRECTED routing/bidding for an ordinary task: electing "the thing that
 * builds new agents" for routine work wastes a whole cycle synthesising a
 * bespoke agent before any real work happens (audit c33e65dd: a plain Fable
 * research question auto-routed to agent_factory, which attempted
 * create_ephemeral_agent, crashed, then fell back to researcher). It stays fully
 * reachable via an EXPLICIT agentName / fallbackAgents — only autonomous
 * selection is blocked.
 */
export function agentCfgIsMetaFactory(cfg: { tools?: string[] } | undefined): boolean {
  return Boolean(cfg?.tools?.includes("create_ephemeral_agent"));
}

function agentIsMetaFactory(agentName: string): boolean {
  const config = getConfig();
  return agentCfgIsMetaFactory(config.subAgents[agentName] ?? readPromotedAgents(config.workspacePath)[agentName]);
}

/** Phrases that explicitly ask the swarm to go online and validate/look up. */
const SEARCH_ONLINE_TASK_RE = /\b(search online|search the web|web search|look (it|this) up online|validate (your |the |this )?answer|fact[- ]?check|im internet (such|recherchier)|recherchier[a-z]* online)\b/i;

// A web-research task in the GENERAL (incl. German) shape the patterns above miss:
// a search/research VERB together with an unambiguously EXTERNAL web noun (URL,
// price, platform, provider, course, …). Audit 3ef67aef: a German "Recherchiere
// die besten Lernquellen … Suche nach … URL, Preis, Quellen" task matched none of
// the English patterns and the turn was not classified source-sensitive, so the
// research-capability redirect never fired — swarm_delegate bidding then handed it
// to web-INCAPABLE agents (quality_supervisor → … → productivity_agent) that
// FABRICATED a sourced-looking resource list with zero web_search calls. Stays
// high-precision: BOTH a verb AND an external noun must be present, and a workspace/
// code marker (function, file, symbol, codebase) vetoes it so internal "find/search"
// tasks (code_analyst's territory) are never misrouted to the web researcher.
const WEB_RESEARCH_VERB_RE = /\b(?:research|recherch\w+|investigat\w+|ermittl\w+|such\w*|searche?s?|find|finde|look\s*up|gather|sammel\w+|zusammenstell\w+)\b/i;
const EXTERNAL_WEB_NOUN_RE = /\b(?:url|urls|link|links|website|websites|webseite\w*|online|plattform\w*|platforms?|anbieter|providers?|vendors?|preis|preise|prices?|pricing|kurs|kurse|courses?|datasheets?|reviews?|bewertung\w*|lernquelle\w*|lernmaterial\w*)\b/i;
const WORKSPACE_CODE_MARKER_RE = /\b(?:codebase|workspace|repository|repo|source\s*code|quellcode|funktion\w*|functions?|methods?|datei\w*|files?|symbols?|klasse\w*|class(?:es)?|modul\w*|modules?)\b/i;

/**
 * Whether a delegation task requires fresh external evidence. The authoritative
 * signal is the runtime-injected "SOURCE-SENSITIVE DELEGATION" wrapper (the
 * orchestrator adds it when the turn was classified source-sensitive); we also
 * catch explicit "search online / validate" phrasing and the vetted research
 * patterns. When true, the chosen agent MUST be research-capable — this is a
 * correctness invariant, not a routing preference.
 */
export function taskRequiresExternalResearch(task: string): boolean {
  const t = task ?? "";
  if (t.includes("SOURCE-SENSITIVE DELEGATION")) return true;
  if (SEARCH_ONLINE_TASK_RE.test(t)) return true;
  // (Deleted the EPHEMERAL_EXTERNAL_RESEARCH_PATTERNS hardware-sourcing keyword bag with the
  //  ephemeral tool-fit de-lexicalization; the structural SOURCE-SENSITIVE marker + the
  //  verb/noun shape below still gate research-capability. This whole gate is a deferred
  //  capability invariant, to be replaced fully by the structural marker path later.)
  // General (incl. German) web-research shape: a research/search verb + an external
  // web noun, with no workspace/code marker that would make it an internal lookup.
  if (!WORKSPACE_CODE_MARKER_RE.test(t) && WEB_RESEARCH_VERB_RE.test(t) && EXTERNAL_WEB_NOUN_RE.test(t)) return true;
  return false;
}

/** First configured, research-capable, not-yet-attempted coordinator/specialist
 *  to fall back to when routing produced only research-incapable candidates. */
function pickResearchFallbackAgent(attempted: string[]): string | undefined {
  const config = getConfig();
  const promoted = readPromotedAgents(config.workspacePath);
  // Prefer the direct web specialist over a coordinator: a single research task
  // does not need a coordinator-of-coordinator hop (the ~20-min web_task_coordinator
  // → researcher loop, session 44ea5c21). Coordinators are the last resort.
  return ["researcher", "browser_agent", "web_task_coordinator", "mission_coordinator"].find(
    (name) => (config.subAgents[name] || promoted[name]) && agentIsResearchCapable(name) && !attempted.includes(name),
  );
}

// ── General capability-aware routing/bidding gate ───────────────────────────
// Beyond the dedicated web-research and artifact gates, some tasks UNAMBIGUOUSLY
// require a concrete EXECUTION tool class that an agent either holds or doesn't.
// Routing/bidding rank on semantic + outcome fit and can elect an agent that
// literally lacks the tool the task needs (audit 14661623: a no-web generator
// out-bid the web specialist). This gate keeps the capable candidates WHEN BOTH
// capable and incapable candidates are present for the same task. It is a
// preventive routing filter, not an output backstop: it NEVER dead-ends (if no
// candidate is capable it leaves the set untouched and the run proceeds), always
// passes coordinators (they can delegate to a capable specialist) and tool-
// inheritors, and only ever swaps an incapable auto-pick for a capable peer that
// was already a candidate — it cannot invent agents. Detectors are deliberately
// high-precision (concrete command/host/language/transaction signals, never
// ambiguous verbs like "build" or "run a script") so a false positive cannot
// drop a correct non-execution specialist.
type ExecutionCapability = "shell" | "code_exec" | "browser_interaction";

const EXECUTION_CAPABILITY_DETECTORS: Record<ExecutionCapability, RegExp> = {
  // Host/server command execution — concrete shell/system signals only.
  shell: /\b(?:ssh|sudo|systemctl|journalctl|crontab|kubectl|docker(?:\s|-compose|$)|chmod|chown|apt(?:-get)?|yum|dnf|pacman|ps aux|df -h|free -m|uptime|on the (?:server|host|remote machine|box)|shell command|bash command|run the command|restart the (?:service|daemon|container))\b|\.sh\b/i,
  // Run/execute code in a sandbox — require an explicit language or "sandbox",
  // never bare "run a script" (ambiguous with a shell script).
  code_exec: /\b(?:run|execute|laufen lassen|führe?\s+aus)\b[^.\n]{0,30}\b(?:javascript|typescript|js|ts|python|node(?:\.js)?)\b|\bin a sandbox\b|\bsandbox:/i,
  // Interactive actions on a live website — strong transaction/login/form signals.
  browser_interaction: /\b(?:log ?in|sign ?in|anmelden|einloggen|fill (?:in |out )?the form|formular ausf(?:ü|ue)llen|submit the form|formular absenden|add to cart|in den warenkorb|check ?out|book (?:a|the)\b|apply (?:for|to)\b|place (?:an|the) order|bestellung aufgeben)\b/i,
};

function agentSatisfiesExecutionCapability(cfg: { tools?: string[] } | undefined, cap: ExecutionCapability): boolean {
  if (!cfg) return true;       // unknown / ephemeral — don't filter
  if (!cfg.tools) return true; // inherits the full tool set
  const tools = cfg.tools;
  if (tools.some((t) => COORDINATION_TOOL_NAMES.has(t))) return true; // can delegate to a capable specialist
  switch (cap) {
    case "shell":
      return tools.includes("shell_exec") || tools.includes("ssh_exec");
    case "code_exec":
      return tools.some((t) => t.startsWith("mcp__code_sandbox__") || /(?:^|_)(?:run_js|run_ts|run_code|execute_code)$/.test(t));
    case "browser_interaction":
      return tools.some((t) => t.startsWith("browser_") || t === "site_fill_credentials" || t.startsWith("computer_"));
  }
}

/** Execution tool classes the task UNAMBIGUOUSLY requires (high-precision detectors). */
export function requiredExecutionCapabilities(task: string): ExecutionCapability[] {
  const t = task ?? "";
  return (Object.keys(EXECUTION_CAPABILITY_DETECTORS) as ExecutionCapability[])
    .filter((cap) => EXECUTION_CAPABILITY_DETECTORS[cap].test(t));
}

/**
 * Capability-aware filter for AUTO-selected candidates (semantic routing + bidding).
 * For each execution capability the task requires, drop candidates that lack it — but
 * only while at least one capable candidate remains (never dead-end). Pure; the caller
 * decides what to do with the result. Coordinators and tool-inheritors always pass.
 */
export function filterCandidatesByExecutionCapability(
  names: string[],
  task: string,
  lookup: (name: string) => { tools?: string[] } | undefined,
): { kept: string[]; dropped: string[]; capabilities: ExecutionCapability[] } {
  const capabilities = requiredExecutionCapabilities(task);
  if (capabilities.length === 0 || names.length <= 1) return { kept: names, dropped: [], capabilities };
  let kept = names;
  const dropped: string[] = [];
  for (const cap of capabilities) {
    const capable = kept.filter((name) => agentSatisfiesExecutionCapability(lookup(name), cap));
    if (capable.length > 0 && capable.length < kept.length) {
      for (const name of kept) if (!capable.includes(name)) dropped.push(name);
      kept = capable;
    }
    // capable.length === 0 → no candidate holds this class; leave `kept` as-is (no dead-end).
  }
  return { kept, dropped: uniqueNames(dropped), capabilities };
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

function looksLikePlanningOnlyResult(result: string): boolean {
  const preview = result.slice(0, 600).trim();
  if (!preview) return false;

  // Openers that signal "the model started narrating intent". Both English
  // and German because qwen mirrors the user's language; session 6b3f2123
  // showed an entire 3 KB planning loop in German ("Ich werde…", "Lass mich
  // einen anderen Ansatz wählen", "Stattdessen…", "Letztendlich…") that the
  // English-only regex missed entirely.
  const startsLikePlanning = /^\s*(let me|now let me|first let me|now i can|now i (?:have|understand)\b[\s\S]{0,160}\blet me|i (?:now )?(?:have|understand)\b[\s\S]{0,160}\blet me|i(?:'m| am) going to|i(?:'ll| will)|i(?:'m| am) trying to|i need to|next,? i(?:'m| am) going to|ich werde|ich erstelle|ich nutze|ich verwende|ich entscheide|ich w(?:ä|ae)hle|ich versuche|ich muss|lass mich|stattdessen|letztendlich|allerdings|aufgrund|der (?:beste|pragmatischste|einfachste) ansatz|da (?:es sich|ich|write_file|das))\b/i.test(preview);
  if (!startsLikePlanning) return false;

  // English keywords stay strictly bounded so we don't false-match across
  // unrelated words. German verb stems are matched as a stem-prefix (no
  // trailing \b) because conjugated forms like "erstellen" / "erstelle" /
  // "verwende" all need to match the same `erstell` / `verwend` stem.
  const planningAction = /\b(try|attempt|start|check|verify|fetch|get|gather|collect|retrieve|research|search|look for|look up|read|download|continue|proceed|focus|click|type|open|inspect|retry|use|switch|launch|list|attach|create|update|modify|edit|write|patch|save)\b|\b(erstell|schreib|verwend|nutz|aufteil|zusammenf(?:ü|ue)hr|umgeh|brauch|w(?:ä|ae)hl|entscheid)\w*/i.test(preview);
  if (!planningAction) return false;

  const terminalMarker = /\b(completed|done|finished|succeeded|successfully|typed|opened|clicked|verified|updated|modified|edited|wrote|written|saved|patched|failed|error|could not|did not)\b|\b(abgeschlossen|fertig|erfolgreich|geschrieben|gespeichert|fehlgeschlagen|nicht m(?:ö|oe)glich)/i.test(preview);
  // No length gate. The earlier `preview.length <= 220 || unresolvedMarker`
  // condition was meant to avoid flagging short legitimate narration, but
  // by accepting only short results it missed long planning loops — the
  // exact failure mode we want to catch. If the final assistant message
  // opens with planning narrative AND no terminal marker is present, the
  // agent narrated instead of executing regardless of how verbose it got.
  return !terminalMarker;
}

const WORKSPACE_MUTATION_TASK_RE = /\b(?:update|modify|edit|write|patch|save|create|add|change|set|switch|configure|implement|apply|fix|adjust|build|generate|produce|draft|compose|anpass(?:en|ung|ungen)?|angepasst|pass(?:e|en|t)\b[\s\S]{0,80}\ban|aendere|ändere|ändern|aktualisier(?:e|en|ung)?|bearbeit(?:e|en)|schreib(?:e|en)?|erstell(?:e|en)?|erzeug(?:e|en|ung)?|generier(?:e|en)?|bau(?:e|en)?|hinzuf(?:ue|ü)gen|setz(?:e|en)?|konfigurier(?:e|en)|umstell(?:e|en))\b/i;
const WORKSPACE_MUTATION_CONTEXT_RE = /\b(?:starlingai|workspace|repo|repository|agent|agents|scene|scenes|job|jobs|workflow|workflows|config|configuration|prompt|prompts|tool|tools|model|routing|self[- ]?improvement|selbstverbesserung|konfiguration|modell|agenten|szene|szenen|wartung)\b/i;
const WORKSPACE_MUTATION_TOOL_NAMES = new Set(["write_file", "edit_file", "create_dir", "delete_file", "shell_exec"]);
const READ_ONLY_CONTEXT_TOOL_NAMES = new Set([
  "read_file", "list_files", "workspace_search", "read_shared_facts", "search_agents", "agent_catalog", "git_status", "git_diff",
]);

function looksLikeWorkspaceMutationTask(
  task: string,
  agentCfg: import("../config/schema.js").SubAgentConfig | undefined,
  agentName: string,
): boolean {
  const text = task.trim();
  if (!text || !WORKSPACE_MUTATION_TASK_RE.test(text)) return false;
  const tags = new Set((agentCfg?.tags ?? []).map((tag) => tag.toLowerCase()));
  const maintenanceAgent = agentName === "swarm_maintainer"
    || tags.has("swarm")
    || tags.has("maintenance")
    || tags.has("selfimprovement")
    || tags.has("agents")
    || tags.has("prompts")
    || tags.has("workflow");
  return maintenanceAgent || WORKSPACE_MUTATION_CONTEXT_RE.test(text);
}

function hasWorkspaceMutationTool(stats: { toolNames: string[] } | undefined): boolean {
  return (stats?.toolNames ?? []).some((toolName) => WORKSPACE_MUTATION_TOOL_NAMES.has(toolName));
}

function usedOnlyReadOnlyContextTools(stats: { toolCount: number; toolNames: string[] } | undefined): boolean {
  const toolNames = stats?.toolNames ?? [];
  return (stats?.toolCount ?? 0) > 0
    && toolNames.length > 0
    && toolNames.every((toolName) => READ_ONLY_CONTEXT_TOOL_NAMES.has(toolName));
}

function looksLikeRawWorkspaceConfigDump(result: string): boolean {
  const text = result.trim();
  if (!text) return false;
  const compact = text.replace(/\s+/g, " ").slice(0, 12_000);
  if (/\.starlingai\/\s+agent_outcomes\.ndjson\s+README\.md\s+agents\/\s+10-core-agents\.jsonc\s+2\d-[a-z-]+\.jsonc/i.test(compact)) {
    return true;
  }
  if (/[{]\s*"(?:agents|subAgents)"\s*:\s*[{]/i.test(compact)
    && /"systemPrompt"\s*:/i.test(compact)
    && /"primary"\s*:\s*"lmstudio\//i.test(compact)) {
    return true;
  }
  return /####\s+Tool Calls/i.test(text)
    && /\b(?:read_file|list_files|search_agents|agent_catalog)\b/i.test(text)
    && /\b(?:agents\/|10-core-agents\.jsonc|2\d-[a-z-]+\.jsonc|"subAgents"|"agents")\b/i.test(text);
}

function looksLikeReadOnlyMutationMiss(
  output: string,
  task: string,
  stats: { toolCount: number; toolNames: string[] } | undefined,
  agentCfg: import("../config/schema.js").SubAgentConfig | undefined,
  agentName: string,
): boolean {
  if (!looksLikeWorkspaceMutationTask(task, agentCfg, agentName)) return false;
  if (hasWorkspaceMutationTool(stats)) return false;
  return usedOnlyReadOnlyContextTools(stats) || looksLikeRawWorkspaceConfigDump(output);
}

// Tools that directly produce a user-visible deliverable. If the agent had
// any of these AND the task asked for one AND the agent called none of them,
// the agent narrated intent instead of executing — regardless of how the
// output is phrased. This catches the failure mode where the model says
// "Let me build this as a complete single-file HTML application" or "Die
// Website wurde erstellt" but never actually called write_file.
const ARTIFACT_PRODUCING_TOOLS = new Set([
  "write_file", "edit_file", "create_dir",
  "generate_document", "generate_website", "generate_presentation", "generate_docx", "generate_pptx", "generate_pdf",
  "bundle_artifact_zip", "export_workspace_artifact",
  // fetch_image downloads + SAVES a real local image file — that saved asset is the
  // deliverable, which cached research facts can never satisfy. Without this, an
  // image-sourcing delegation gets short-circuited by findReusableSessionEvidence and
  // never actually runs (audit cdd731d6: image_sourcer "reusedFromSessionMemory", 0 images).
  "fetch_image",
  "shell_exec",
]);

// Coordinators can also "produce" by delegating the work. If they called
// none of these AND none of ARTIFACT_PRODUCING_TOOLS, they truly did
// nothing useful.
const PRODUCTIVE_COORDINATOR_TOOLS = new Set([
  "delegate_to_agent", "parallel_delegate", "run_task_graph",
  "run_workflow", "create_ephemeral_agent", "swarm_delegate",
]);

export function looksLikeArtifactDeliverableMiss(
  task: string,
  stats: { toolCount: number; toolNames: string[] } | undefined,
  agentCfg: import("../config/schema.js").SubAgentConfig | undefined,
): boolean {
  if (!agentCfg) return false;
  // We can only fire this check when stats are present — without them we
  // don't know which tools the agent actually called, and treating absent
  // stats as "called nothing" would false-positive on every legacy test
  // path that mocks runSubAgent without runSubAgentWithStats.
  if (!stats) return false;
  // A runtime-authored research slice embeds the user's ORIGINAL request
  // (which may say "bauen"/"build a device"), but the slice's own deliverable
  // is prose evidence by construction. Judging the researcher against the
  // embedded build verb branded a successful 8.8KB sourced report a failure
  // because it never called write_file (audit b5107ae4) — which then cascaded
  // into an architect-built ephemeral that re-researched ONE component and
  // shipped that as the whole answer.
  if (isCanonicalResearchSliceTask(task)) return false;
  // NOTE: do NOT skip on `toolCount === 0 && toolNames.length === 0`. The
  // earlier "treat empty stats as a mock signal" shortcut let real
  // production failures through: session 25f55376 (2026-05-28) had
  // mission_coordinator generate 4096 tokens of "I'll write it in one go"
  // narrative with literally zero tool calls and get marked as success.
  // That is the strongest narrative-only signal we have; we must catch it.
  if (!WORKSPACE_MUTATION_TASK_RE.test(task.trim())) return false;

  const availableArtifactTools = (agentCfg.tools ?? []).filter((t) => ARTIFACT_PRODUCING_TOOLS.has(t));
  if (availableArtifactTools.length === 0) return false;

  const calledTools = new Set(stats.toolNames ?? []);
  const calledArtifact = [...calledTools].some((t) => ARTIFACT_PRODUCING_TOOLS.has(t));
  if (calledArtifact) return false;

  // If the agent could delegate (coordinator-shaped) and actually did,
  // that's a legitimate alternative path — the work might still happen
  // downstream. Don't flag it here.
  const couldDelegate = (agentCfg.tools ?? []).some((t) => PRODUCTIVE_COORDINATOR_TOOLS.has(t));
  if (couldDelegate) {
    const delegated = [...calledTools].some((t) => PRODUCTIVE_COORDINATOR_TOOLS.has(t));
    if (delegated) return false;
  }

  return true;
}

// Routing-time gate. If the task asks for a deliverable (write/create/edit/
// erstelle/...) the candidate agent must be able to either produce one
// directly (artifact tool) or fan out via a productive coordinator tool.
// Without this gate, swarm routing was sending CPSA-F "erzeuge mir eine
// Lernwebsite" to `quality_supervisor` (session 2d810e7d, 2026-05-28) — a
// read/audit-only agent that has no write_file/edit_file/shell_exec — and
// the agent narrated a review of nothing while burning the delegation
// budget.
export function agentCfgCanFulfillArtifactTask(
  task: string,
  cfg: { tools?: string[] } | undefined,
): boolean {
  if (!WORKSPACE_MUTATION_TASK_RE.test(task.trim())) return true;
  if (!cfg) return true; // unknown agent — let the downstream attempt fail loudly rather than silently filtering
  const tools = cfg.tools ?? [];
  return tools.some((t) => ARTIFACT_PRODUCING_TOOLS.has(t))
    || tools.some((t) => PRODUCTIVE_COORDINATOR_TOOLS.has(t));
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

export function looksLikeFailureResult(result: string): boolean {
  if (!result.trim()) return true;
  const preview = result.slice(0, 600);
  if (/^sub-agent produced no final response\.?$/i.test(preview.trim())) {
    return true;
  }
  if (looksLikeContainerLevelFailure(preview)) {
    return true;
  }
  // Detect when the sub-agent emitted only LLM template special tokens
  // (e.g. `<|mask_end|>`, `<|im_end|>`).  Apply to the FULL result, not
  // the preview, so that a 12-char template-only output is caught even
  // when the preview happens to be padded.
  if (looksLikeModelTemplateArtifact(result)) {
    return true;
  }
  if (/\b(no results|not found|unable to|failed to|error:|timed out|cancelled|incomplete|max.{0,20}iterations|sub_agent_max_iterations|could not complete|did not complete|exited with code|exit code)\b/i.test(preview)) {
    return true;
  }

  if (/\bis already running via\s+(?:[a-z0-9_:-]*(?:_agent|_coordinator)|researcher|another agent)\b/i.test(preview)) {
    return true;
  }

  if (/\bNo (?:agents|workflows) matched\b/i.test(preview)) {
    return true;
  }

  if (/\b(i can(?:not|'t) access|i do not have access|i can(?:not|'t) retrieve|cannot retrieve the latest|cannot access real[- ]time|knowledge cutoff|my knowledge is based on the data i was trained on)\b/i.test(preview)) {
    return true;
  }

  if (/\b(need to start a session|no computer_session_start|not available in my tool list|available tools are only|missing tool|cannot complete because .*tool)\b/i.test(preview)) {
    return true;
  }

  return looksLikePlanningOnlyResult(preview);
}

function looksLikeRunningTaskStatusResult(result: string): boolean {
  const normalized = result
    .replace(/^\[[^\]]+\]:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized || normalized.length > 1000) return false;
  return /\bis already running via\s+(?:[a-z0-9_:-]*(?:_agent|_coordinator)|researcher|another agent)\b/i.test(normalized)
    && !/(?:^|\s)(?:FACT:|https?:\/\/|datasheet|specification|voltage|current|capacity|snr|frequency|dimension|pinout)\b/i.test(normalized);
}

/**
 * Detect infrastructure-level failures where retrying via a different agent
 * or ephemeral agent cannot succeed (host unreachable, service down, etc.).
 */
export function looksLikeInfrastructureFailure(result: string): boolean {
  if (!result.trim()) return false;
  const preview = result.slice(0, 800);
  // Sub-agent execution timeouts ("Sub-agent 'X' timed out after Yms") are
  // retryable with a different agent — they are NOT infrastructure failures.
  if (/\bSub-agent\b.{0,60}\btimed out\b/i.test(preview)) return false;
  return /\b(timed out|ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|connection refused|not reachable|host is down|failed recently and is still in cooldown|Do NOT retry)\b/i.test(preview);
}

function shouldAcceptPartialDelegation(
  agentName: string,
  task: string,
  stats: { toolCount: number; toolNames: string[]; terminalState?: string; outcome?: string } | undefined,
  artifacts: Record<string, unknown>[] = [],
): boolean {
  if (stats?.outcome !== "partial") {
    return false;
  }

  const hasArtifactOutput = artifacts.some((artifact) => {
    if (!artifact || typeof artifact !== "object") return false;
    const value = artifact as Record<string, unknown>;
    return typeof value["outputPath"] === "string"
      || typeof value["dataUrl"] === "string"
      || typeof value["externalUrl"] === "string";
  });
  if (hasArtifactOutput) {
    return true;
  }

  // Accept research-type agents that made meaningful tool progress
  // (used web_search, web_fetch, or similar) — research agents that fetch
  // content but hit max_iterations should be treated as partial successes.
  const hasResearchTools = stats.toolNames.some((name) =>
    name === "web_search" || name === "web_fetch" || name === "read_shared_facts"
  );
  if (hasResearchTools && stats.toolCount >= 2) {
    return true;
  }

  // Structural gate only: a computer-use partial counts when the agent that ran
  // is the computer-use specialist (or it actually invoked a computer_* tool).
  // The task-text keyword sniff was removed — routing/acceptance must not read topic words.
  if (agentName !== "computer_use_agent") {
    return false;
  }

  return stats.toolCount > 0 || stats.toolNames.some((toolName) => toolName.startsWith("computer_"));
}

/**
 * Detect when a "partial" timeout/cancel output contains nothing but failed
 * tool stubs in its recovered-evidence section.  The classic failure mode
 * (audit session 0a93078b, May 2026) is a coordinator that times out after
 * its only tool calls were search_agents → 0 results, list_agents → 0
 * results, create_ephemeral_agent → spawn that itself errored.  The
 * `buildInterruptedSubAgentOutput` formatter produces a "Partial progress
 * before interruption" block whose Recovered evidence snippets list reads:
 *
 *   - search_agents: No agents matched ...
 *   - list_agents: No agents matched ...
 *   - create_ephemeral_agent: Sub-agent error: ...
 *
 * The classifier was treating that as `partial` (because outcome=partial and
 * the output is non-empty), letting the runtime persist it as evidence and
 * skip the failure-handling cascade.  Demote those to `failure` so the
 * failed-delegation diagnostic and warden escalation can fire.
 */
/**
 * True when a failed/timed-out attempt's output carries real gathered evidence
 * (findings, figures, sources) rather than just an interrupted/max-iteration NOTICE.
 * Used to decide whether a captured partial is substantial enough to HALT escalation:
 * a bare "reached the maximum number of tool-call iterations … partial may be
 * incomplete" notice (even when it echoes the task) is not evidence worth stopping
 * for, so we still escalate past it. Distinguishes the 687a224b keystone (a 3789-char
 * verified-spec body → halt) from a researcher's max-iteration notice (→ keep escalating).
 */
export function partialResultHasSubstantiveEvidence(output: string): boolean {
  if (!output) return false;
  const stripped = output
    .replace(/Sub-agent\s+'[^']*'\s+reached the maximum number of tool-call iterations[^.]*\.?/gi, " ")
    .replace(/reached the maximum number of tool-call iterations\s*\(\d+\)/gi, " ")
    .replace(/Partial result may be incomplete\.?/gi, " ")
    .replace(/before producing usable topic-related output\.?/gi, " ")
    .replace(/Partial progress before interruption:?/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length >= 200;
}

export function looksLikeOnlyFailureStubs(output: string): boolean {
  if (!output) return false;
  const text = output.trim();
  // Must be the shape `buildInterruptedSubAgentOutput` produces — header
  // line + "Partial progress before interruption" block.
  if (!/Partial progress before interruption:/i.test(text)) return false;
  // Extract the recovered-evidence section if present.
  const evidenceMatch = /Recovered evidence snippets from completed tools:\s*\n([\s\S]+)$/.exec(text);
  if (!evidenceMatch) {
    // No recovered snippets at all — the only content is the timeout/cancel
    // header plus the swarm-progress lines.  That's effectively no evidence.
    return true;
  }
  const snippets = evidenceMatch[1]!
    .split(/\n(?=- )/)
    .map((line) => line.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean);
  if (snippets.length === 0) return true;
  // Patterns that mark a snippet as "failure stub only — no usable evidence".
  const FAILURE_STUB_PATTERNS: RegExp[] = [
    /^[\w_]+:\s*No agents matched\b/i,
    /^[\w_]+:\s*No workspace files contain\b/i,
    /^[\w_]+:\s*No (?:results|matches|files|content|entries) found\b/i,
    /^[\w_]+:\s*Sub-agent error:/i,
    /^[\w_]+:\s*Tool '[^']+' has been called \d+ times this run/i,
    /^[\w_]+:\s*\[ephemeral:[^\]]+\]:\s*Sub-agent error:/i,
    /Request timed out\.?$/i,
    /container error:/i,
    /failed to spawn/i,
  ];
  // Every recovered snippet must match a failure-stub pattern for the output
  // to qualify as "only failure stubs". Even one substantive snippet (e.g. a
  // real web_search hit, a read_file payload, a workspace_search snippet
  // with content) is enough to keep this as a real partial result.
  return snippets.every((snippet) => FAILURE_STUB_PATTERNS.some((pattern) => pattern.test(snippet)));
}

/** Consolidated classification of a completed sub-agent delegation. */
export type DelegationClassification =
  | "success"               // usable, complete answer
  | "partial"               // usable but incomplete evidence (accepted partial)
  | "coordinator_noop"      // coordinator returned a planning stub without delegating or sharing evidence
  | "failure"               // no usable output
  | "infrastructure_failure"; // failure caused by an unreachable service — do not retry with a different agent

/**
 * D14: Single classification function that replaces the scattered combination of
 * looksLikeFailureResult, looksLikePlanningOnlyResult, shouldAcceptPartialDelegation,
 * terminalState checks, stats.outcome, and the coordinator no-op heuristic.
 *
 * Call AFTER <final_answer> tag parsing has already mutated `output` and
 * `delegationOutcome`.
 */
export function classifyDelegationResult(
  output: string,
  delegationOutcome: string | undefined,
  stats: { toolCount: number; toolNames: string[]; terminalState?: string; outcome?: string } | undefined,
  agentCfg: import("../config/schema.js").SubAgentConfig | undefined,
  agentName: string,
  task: string,
  artifacts: Record<string, unknown>[] = [],
): DelegationClassification {
  const planningOnly = looksLikePlanningOnlyResult(output);

  // ── Coordinator no-op ──────────────────────────────────────────────────
  // A coordinator that completed without calling any delegation/evidence tools
  // and returned a short or planning-only stub is treated as a no-op.
  // Guard on terminalState === "completed" to avoid false positives from
  // test mocks that leave terminalState undefined.
  const isCoordinator =
    (agentCfg?.tags ?? []).includes("coordination") || agentName.endsWith("_coordinator");
  if (isCoordinator && stats?.terminalState === "completed" && delegationOutcome !== "failure") {
    const COORDINATOR_WORK_TOOLS = new Set([
      "delegate_to_agent", "parallel_delegate", "run_task_graph",
      "swarm_delegate", "share_finding", "run_workflow",
    ]);
    const actuallyWorked = (stats.toolNames ?? []).some((n) => COORDINATOR_WORK_TOOLS.has(n));
    // A coordinator's only job is orchestration via tools. If it called ZERO
    // tools at all and just emitted prose, it did nothing real — no matter how
    // long or plausible that prose reads. The previous (<80 chars || planningOnly)
    // guard let a 767-char capability refusal ("I have no tools for live news…
    // but here are some news sites") slip through as a "successful" completion,
    // so the explicit researcher fallback never ran and the orchestrator relayed
    // the refusal (audit 3a0fd176: "aktuelle news von heute" dead-ended while
    // searxng was reachable). Zero tool calls is the structural, language-
    // independent tell of a no-op. Keep the length/planning guard for the case
    // where the coordinator DID call some non-work tool (e.g. discovery) but
    // never delegated or shared evidence.
    // Restrict the zero-tool extension to PURE orchestration coordinators
    // (delegation/read tools only). A coordinator that also owns artifact tools
    // (write_file, generate_*, shell_exec, browser_*) narrating "I'll build this"
    // without calling them must stay an artifact-deliverable-miss failure below,
    // which carries the "expected write_file" hint — so don't pre-empt it here.
    const hasArtifactTools = (agentCfg?.tools ?? []).some((name) =>
      /^(?:write_file|edit_file|generate_|bundle_artifact|shell_exec|send_|post_|browser_)/.test(name)
    );
    const calledNoTools =
      !hasArtifactTools && (stats.toolCount ?? 0) === 0 && (stats.toolNames ?? []).length === 0;
    if (!actuallyWorked && (calledNoTools || output.trim().length < 80 || planningOnly)) {
      return "coordinator_noop";
    }
  }

  if (planningOnly) {
    return "failure";
  }

  if (looksLikeReadOnlyMutationMiss(output, task, stats, agentCfg, agentName)) {
    return "failure";
  }

  // Language-agnostic fallback: the agent had artifact-producing tools
  // (write_file, generate_website, …) AND the task asks for a deliverable
  // AND the agent called none of them AND, for coordinators, didn't
  // delegate either. Catches "Let me build this as a complete single-file
  // HTML application" / "Die Website wurde erstellt" / "This is a
  // substantial deliverable…" — phrasings the planning-only regex misses.
  if (looksLikeArtifactDeliverableMiss(task, stats, agentCfg)) {
    return "failure";
  }

  // ── Partial acceptance ─────────────────────────────────────────────────
  const acceptPartial = shouldAcceptPartialDelegation(agentName, task, stats, artifacts);

  // ── Failure detection ──────────────────────────────────────────────────
  const isExplicitFailure = delegationOutcome === "failure";
  const isNeedsInfoUnaccepted = delegationOutcome === "needs_info" && !acceptPartial;
  const isIncompleteUnaccepted =
    !acceptPartial
    && (
      (stats?.terminalState !== undefined && stats.terminalState !== "completed")
      || looksLikeFailureResult(output)
    );

  if (isExplicitFailure || isNeedsInfoUnaccepted || isIncompleteUnaccepted) {
    // Even in a failing result, partial content may still be usable
    const hasPartialContent =
      delegationOutcome === "partial"
      || (stats?.outcome === "partial" && delegationOutcome !== "success");
    // Demote partial-with-only-failure-stubs to failure: the recovered-
    // evidence section contains nothing but "No X matched" / "Sub-agent
    // error:" / per-tool-cap stubs, so there's nothing to synthesize from.
    // Letting this through as `partial` skips the failure-handling cascade
    // (failed-delegation diagnostic, warden escalation) and surfaces stubs
    // to the model as if they were real evidence.
    if (hasPartialContent && output.trim() && !looksLikePlanningOnlyResult(output) && !looksLikeOnlyFailureStubs(output) && !looksLikeRunningTaskStatusResult(output)) {
      return "partial";
    }
    return looksLikeInfrastructureFailure(output) ? "infrastructure_failure" : "failure";
  }

  // ── Success / partial-accepted ─────────────────────────────────────────
  if (acceptPartial || delegationOutcome === "partial") {
    return "partial";
  }
  return "success";
}

/**
 * Decide whether a FAILED delegation should be reported to the orchestrator as
 * "narrative-only" (the agent narrated intent but never called a work tool).
 *
 * A container/host-level crash — the agent-worker could not reach the model
 * endpoint or a gateway-bound MCP, failed to spawn, exited non-zero, or timed
 * out — is NOT a narrative-only miss even though it produced zero tool calls
 * (it never got to run). Labeling it "never called write_file — restate the
 * task as a single direct instruction, or pick a different specialist" is
 * misleading on two counts: the agent wasn't lazy, and re-wording the task to
 * the SAME broken containerized agent cannot succeed. Surface the raw container
 * error instead so the orchestrator can see it and route elsewhere.
 *
 * (audit: `coder` ran containerized for the CPSA-F learning-platform build, hit
 * "container error: unknown" with 0 tokens / 0 tools, and was reported as
 * "narrative-only — restate the task", which sent the orchestrator in circles
 * and cascaded the dependent nodes to blocked.)
 */
export function isNarrativeOnlyDeliverableFailure(
  classification: DelegationClassification,
  output: string,
  task: string,
  stats: { toolCount: number; toolNames: string[] } | undefined,
  agentCfg: import("../config/schema.js").SubAgentConfig | undefined,
): boolean {
  if (classification !== "failure") return false;
  if (looksLikeContainerLevelFailure(output)) return false;
  return looksLikePlanningOnlyResult(output) || looksLikeArtifactDeliverableMiss(task, stats, agentCfg);
}

function formatArtifactReferencesForSharedContext(artifacts: Record<string, unknown>[]): string {
  const lines = artifacts
    .map((artifact) => {
      if (!artifact || typeof artifact !== "object") return "";
      const value = artifact as Record<string, unknown>;
      const outputPath = typeof value["outputPath"] === "string" ? value["outputPath"] : "";
      const filename = typeof value["filename"] === "string" ? value["filename"] : "";
      const previewMode = typeof value["previewMode"] === "string" ? value["previewMode"] : "";
      const sourceTool = typeof value["sourceTool"] === "string" ? value["sourceTool"] : "";
      const artifactRef = outputPath || filename;
      if (!artifactRef) return "";

      const qualifiers = [previewMode, sourceTool].filter(Boolean);
      return qualifiers.length > 0
        ? `- ${artifactRef} (${qualifiers.join(", ")})`
        : `- ${artifactRef}`;
    })
    .filter(Boolean)
    .slice(0, 6);

  return lines.length > 0
    ? `\n\nArtifacts generated by this result:\n${lines.join("\n")}`
    : "";
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
  if (!isArtifactRenderDelegation && taskRequiresExternalResearch(request.task) && candidateQueue.length > 0) {
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
          return Date.now() + Math.floor(effective * 0.70);
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
        content: `${summarizeText(output, 1200)}${formatArtifactReferencesForSharedContext(artifacts)}`.trim(),
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
        if (Array.isArray(arts)) {
          for (const artifact of arts) {
            if (artifact && typeof artifact === "object") {
              graphArtifacts.push(artifact as Record<string, unknown>);
            }
          }
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
      return `- ${node.id} [${task?.status ?? "unknown"}] ${task?.selectedAgent ?? node.agentName ?? "unassigned"}`;
    }).join("\n");

    return {
      success: failed.size === 0,
      output: `Swarm task graph complete.\n${summary}\n\n${formatSwarmState(swarmState)}`,
      metadata: {
        completed: [...completed],
        failed: [...failed],
        blocked: [...blocked],
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
