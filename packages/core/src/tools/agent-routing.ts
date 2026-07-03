/**
 * Agent routing — semantic + structural routing and capability-gate logic.
 *
 * Extracted verbatim from ./sub-agent.ts (pure move, no logic changes). This is
 * the candidate-resolution + capability-gate cluster that the delegation-execution
 * path (executeDelegationWithFallback, which stays in sub-agent.ts) calls. The
 * dependency is one-directional: sub-agent.ts imports from here; this module never
 * imports the delegation-execution singletons from sub-agent.ts.
 */

import { getConfig } from "../config/loader.js";
import { buildAgentTokenIdf, isEmbeddingAvailable, scoreAgentKeywordMatch, searchByEmbedding } from "../providers/embeddings.js";
import { getEmbeddingProvider } from "../providers/index.js";
import { readPromotedAgents } from "../agent/promoted-agents.js";
import { readRecentOutcomes, computeAgentCostProfile, computeOutcomeRoutingMultiplier, extractTaskKeywords, type AgentCostProfile } from "../agent/outcomes.js";
import { rerankCandidates } from "../retrieval/reranker.js";

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

export interface RoutingSelectionReason {
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

// Read a wide GLOBAL window before filtering per-agent: readRecentOutcomes returns the last-N
// across ALL agents, so a low-traffic agent's own recent calls get drowned out of a small window
// by a busy pool — its circuit could then never open (or its boost never compute) despite a real
// failure streak. 200 gives ~4x headroom so an agent's last CIRCUIT_LOOKBACK calls survive churn.
const OUTCOME_READ_WINDOW = 200;

export function isCircuitOpen(agentName: string, workspacePath: string): boolean {
  const outcomes = readRecentOutcomes(workspacePath, OUTCOME_READ_WINDOW);
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
  const outcomes = readRecentOutcomes(workspacePath, OUTCOME_READ_WINDOW);
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
export function countRoutingQueryContentTokens(query: string): number {
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

// ─── capability gates (research + meta-factory + execution) ────────────────────
// Shared by both the routing path above and the delegation-execution path in
// sub-agent.ts.  All pure; no execution-loop state.

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
export function agentIsResearchCapable(agentName: string): boolean {
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

export function agentIsMetaFactory(agentName: string): boolean {
  const config = getConfig();
  return agentCfgIsMetaFactory(config.subAgents[agentName] ?? readPromotedAgents(config.workspacePath)[agentName]);
}

/** Phrases that explicitly ask the swarm to go online and validate/look up. */
const SEARCH_ONLINE_TASK_RE = /\b(search online|search the web|web search|look (it|this) up online|validate (your |the |this )?answer|fact[- ]?check)\b/i;

// A web-research task in the general shape the phrase list above misses: a search/
// research VERB together with an unambiguously EXTERNAL web noun (URL, price,
// platform, provider, course, …). Audit 3ef67aef: a research task that matched none
// of the explicit phrases and was not classified source-sensitive slipped through, so
// the research-capability redirect never fired — swarm_delegate bidding then handed it
// to web-INCAPABLE agents that FABRICATED a sourced-looking resource list with zero
// web_search calls. Stays high-precision: BOTH a verb AND an external noun must be
// present, and a workspace/code marker (function, file, symbol, codebase) vetoes it so
// internal "find/search" tasks (code_analyst's territory) are never misrouted.
//
// English-internal (de-lexicalized): these carry no per-language entries. The structural
// "SOURCE-SENSITIVE DELEGATION" marker (checked first in the function below) stays the PRIMARY
// signal and is language-independent, so it still fires for any language; this verb+noun shape
// is the English-only fallback. NOTE: the boundary-translation layer that would render a
// non-English task to English before this fallback is NOT YET IMPLEMENTED — until it lands, a
// non-English task relies on the structural marker alone (the verb+noun fallback won't fire).
const WEB_RESEARCH_VERB_RE = /\b(?:research|investigat\w+|searche?s?|find|look\s*up|gather)\b/i;
const EXTERNAL_WEB_NOUN_RE = /\b(?:url|urls|link|links|website|websites|online|platforms?|providers?|vendors?|prices?|pricing|courses?|datasheets?|reviews?)\b/i;
const WORKSPACE_CODE_MARKER_RE = /\b(?:codebase|workspace|repository|repo|source\s*code|functions?|methods?|files?|symbols?|class(?:es)?|modules?)\b/i;

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
export function pickResearchFallbackAgent(attempted: string[]): string | undefined {
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
  // never bare "run a script" (ambiguous with a shell script). English-internal (de-lex);
  // boundary-translation of non-English tasks is planned but NOT YET IMPLEMENTED.
  code_exec: /\b(?:run|execute)\b[^.\n]{0,30}\b(?:javascript|typescript|js|ts|python|node(?:\.js)?)\b|\bin a sandbox\b|\bsandbox:/i,
  // Interactive actions on a live website — strong transaction/login/form signals.
  browser_interaction: /\b(?:log ?in|sign ?in|fill (?:in |out )?the form|submit the form|add to cart|check ?out|book (?:a|the)\b|apply (?:for|to)\b|place (?:an|the) order)\b/i,
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

/**
 * Whether an EXPLICIT delegation's named agents genuinely cover the execution/interaction
 * capability the task requires (browser login, shell command, sandboxed code). Protects an
 * explicit, capable pick from the research-capability redirect: an interactive login sent to a
 * browser/computer specialist is real execution work, NOT a research-fabrication risk — even when
 * the task text happens to trip the web-research word shape (session 8815a45e: an explicit
 * computer_use_agent login was hijacked to `researcher` because "Website" + "Credential-Lookup"
 * matched taskRequiresExternalResearch, and the tool-less researcher returned a first-person
 * refusal that was relayed verbatim to the user). Returns false when the task needs no execution
 * capability, so it never widens the redirect — it only withholds it for genuine execution picks.
 */
export function explicitAgentsCoverTaskExecution(
  names: string[],
  task: string,
  lookup: (name: string) => { tools?: string[] } | undefined,
): boolean {
  const caps = requiredExecutionCapabilities(task);
  if (caps.length === 0 || names.length === 0) return false;
  return caps.every((cap) => names.some((name) => agentSatisfiesExecutionCapability(lookup(name), cap)));
}

/** De-duplicate a list of agent names, trimming and dropping blanks, order-preserving. */
export function uniqueNames(values: string[]): string[] {
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
