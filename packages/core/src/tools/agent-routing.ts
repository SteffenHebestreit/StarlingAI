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
import { buildAgentTokenIdf, isEmbeddingAvailable, routingTokenRarity, scoreAgentKeywordMatch, searchByEmbedding } from "../providers/embeddings.js";
import type { SubAgentConfig } from "../config/schema.js";
import { getEmbeddingProvider } from "../providers/index.js";
import { readPromotedAgents } from "../agent/promoted-agents.js";
import { readRecentOutcomes, computeAgentCostProfile, computeOutcomeRoutingMultiplier, extractTaskKeywords, type AgentCostProfile } from "../agent/outcomes.js";
import { rerankCandidates } from "../retrieval/reranker.js";
import { logAudit } from "../audit/logger.js";
import { resolveRoutingTaxonomy, type TaxonomyBearing } from "../agent/routing-taxonomy.js";

/**
 * Minimum score for a candidate to qualify when semantic embeddings are
 * actually used (rerank mode).  Semantic similarity scores are normalized
 * narrowly around 0.5–0.95, so the cutoff sits high.
 */
export const SEMANTIC_AGENT_ROUTING_MIN_SCORE = 0.72;

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
  if (score >= SEMANTIC_AGENT_ROUTING_MIN_SCORE) return "high";
  if (score >= KEYWORD_AGENT_ROUTING_MIN_SCORE) return "medium";
  return "low";
}

function confidenceThreshold(label: "high" | "medium" | "low"): number {
  if (label === "high") return SEMANTIC_AGENT_ROUTING_MIN_SCORE;
  if (label === "medium") return KEYWORD_AGENT_ROUTING_MIN_SCORE;
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
  /**
   * Best EMBEDDING matches that fell under the 0.72 admission floor, highest first.
   *
   * Telemetry only — nothing branches on it. Sub-floor semantic scores are zeroed before
   * ranking, so without this a query where every agent scored 0.71 logs identically to one
   * where nothing matched at all: resultCount 0, weakCount 0, gated false.
   */
  nearMisses: Array<{ name: string; score: number }>;
  /** Why semantic search could not run even though an embedding model is configured. */
  semanticUnavailableReason?: string;
}

export interface RoutingSelectionReason {
  confidence: "high" | "medium" | "low";
  matchedTerms: string[];
  score: number;
}

/**
 * Which code path asked for this routing decision. `search_agents`/`list_agents` are the
 * model-facing discovery tools; `discovery_prefetch` is the up-front capsule; `delegation`
 * is an un-named delegate_to_agent/swarm_delegate resolving its own target; `bidding` is
 * the swarm bid path.
 */
export type RoutingSurface =
  | "search_agents"
  | "list_agents"
  | "discovery_prefetch"
  | "delegation"
  | "bidding"
  | "shadow";

/**
 * Emit one `agent_routing_evaluated` row for a routing decision.
 *
 * Every routing path funnels through resolveAgentRouting, but only the two model-facing
 * search tools ever logged a row — and in fourteen days of production those tools were
 * called zero times, so the routing scores, the share of decisions that hit the floor and
 * the chosen agents were all unobservable while routing ran on every escalated turn. The
 * shape is the search_agents row plus `surface`, the scored top-5 and the elapsed time, so
 * one query answers "what did routing see, and what did it do" for every surface.
 */
export function logRoutingEvaluated(input: {
  surface: RoutingSurface;
  query: string;
  resolution: AgentRoutingResolution;
  elapsedMs?: number;
  sessionId?: string;
  extra?: Record<string, unknown>;
}): void {
  const { resolution } = input;
  const scored = [...resolution.results, ...resolution.weakCandidates]
    .slice(0, 5)
    .map((candidate) => ({
      name: candidate.name,
      score: Number(candidate.score.toFixed(4)),
      confidence: candidate.confidence,
      admitted: resolution.results.some((r) => r.name === candidate.name),
    }));
  logAudit("agent_routing_evaluated", {
    surface: input.surface,
    // The query is the routing input; it is the user's text or a derived task, so it
    // rides through the same audit sanitizer as every other free-form field.
    query: input.query.slice(0, 500),
    minConfidence: resolution.minConfidence,
    mode: resolution.mode,
    ...(resolution.semanticUnavailableReason ? { semanticUnavailableReason: resolution.semanticUnavailableReason } : {}),
    resultCount: resolution.results.length,
    weakCount: resolution.weakCandidates.length,
    // Empty when something was admitted. Non-empty with resultCount 0 is the shape worth
    // alerting on: agents matched, the absolute gate rejected them.
    nearMisses: resolution.nearMisses,
    gated: resolution.gated,
    allLowConfidence: resolution.allLowConfidence,
    trippedAgents: resolution.trippedAgents,
    excludedAgents: resolution.excludedAgents ?? [],
    topResult: resolution.results[0]?.name ?? null,
    topScore: resolution.results[0]?.score ?? null,
    scored,
    ...(input.elapsedMs !== undefined ? { elapsedMs: input.elapsedMs } : {}),
    ...(input.extra ?? {}),
  }, { ...(input.sessionId ? { sessionId: input.sessionId } : {}), channel: "agent-routing" });
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

/**
 * Remove the instruction wrapper a DELEGATED task opens with.
 *
 * "Answer the user's question: …", "Build a WORKING app for: …", "Investigate whether: …" —
 * a delegation states its mode first and its subject after, and the subject is the only half
 * that tells one agent from another. Ranking could not remove it: measured against the real
 * 49-agent catalog the framing words and the domain nouns score the SAME absent-token rarity,
 * so the ranking fell through to document order and kept the wrapper. Cutting it structurally
 * is what makes the ranking behind it mean anything.
 *
 * Deliberately narrow: a colon inside the opening clause only, with substantial text after it.
 * A user-typed query rarely opens that way, and one that does ("error: cannot find module")
 * loses only its label.
 */
export function stripDelegationFraming(query: string): string {
  const colon = query.indexOf(":");
  if (colon < 0) return query;
  const head = query.slice(0, colon);
  if (head.split(/\s+/).filter(Boolean).length > 8) return query;   // not an opening clause
  const rest = query.slice(colon + 1).trim();
  return rest.split(/\s+/).filter(Boolean).length >= 6 ? rest : query;
}

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
export function shortenOverspecifiedRoutingQuery(
  query: string,
  /** Corpus rarity to rank by. Defaults to the live agent catalog; injected in tests. */
  corpusIdf?: Map<string, number>,
): string | null {
  const tokens = stripDelegationFraming(query).split(/\s+/).filter(Boolean);
  if (tokens.length <= 6) return null;

  const candidates: string[] = [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower.length < 3) continue;
    if (ROUTING_QUERY_STOP_WORDS.has(lower)) continue;
    if (ROUTING_QUERY_FILLER.has(lower)) continue;
    candidates.push(token);
  }
  if (candidates.length === 0) return null;

  // KEEP THE INFORMATIVE TOKENS, NOT THE FIRST ONES.
  //
  // This used to take the leading five, on the stated assumption that they "tend to capture
  // the user's primary domain". That holds for a query a user typed. It is false for a
  // DELEGATED task, which always opens with framing — "Answer the user's question: they
  // want to…", "Build a…", "Investigate whether…" — and carries its subject downstream.
  //
  // Session e95eec63 is what the assumption cost: a WireGuard question shortened to
  // "Answer user's question: they want", which routed to prompt_optimizer — a PROMPT-review
  // agent — at 0.793, logged as high confidence. The fragment was not a bad match for that
  // agent; it was an accurate match for boilerplate, because every word of the actual
  // subject had been discarded before routing began.
  //
  // Rarity across the agent corpus answers the question position was standing in for: a word
  // in most agent descriptions tells them apart from nothing. The winners are re-sorted into
  // reading order so the shortened query still parses as a phrase for the embedding search
  // rather than a bag of words.
  //
  // RARITY ONLY RANKS WHERE THE CORPUS HAS AN OPINION, and for the query this exists to fix it
  // has none: measured against the real 49-agent catalog, "want", "know", "wireguard",
  // "raspberry" and "tunnel" ALL score the absent-token maximum, because no agent description
  // happens to contain any of them. The sort then falls through to its tie-break — document
  // order — which is the leading-tokens rule this replaced. That is why the FRAMING is removed
  // before ranking rather than ranked against (see stripDelegationFraming above): with the
  // wrapper gone, document order lands on the subject instead of on "answer the user's
  // question". Ties keep document order so the result still reads as a phrase.
  const idf = corpusIdf ?? buildAgentTokenIdf(routableAgentEntries());
  const ranked = candidates
    .map((token, index) => ({ token, index, rarity: routingTokenRarity(token, idf) }))
    .sort((a, b) => (b.rarity - a.rarity) || (a.index - b.index))
    .slice(0, 5)
    .sort((a, b) => a.index - b.index);

  const seen = new Set<string>();
  const distinctive: string[] = [];
  for (const entry of ranked) {
    const key = entry.token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    distinctive.push(entry.token);
  }

  if (distinctive.length === 0) return null;
  const shortened = distinctive.join(" ");
  // Don't return a "shortened" query that's actually the same as the input.
  if (shortened === query.trim()) return null;
  return shortened;
}

/** Catalog the router can actually pick from: configured sub-agents plus promoted ones. */
function routableAgentEntries(): Array<[string, SubAgentConfig]> {
  const config = getConfig();
  const promoted = Object.entries(readPromotedAgents(config.workspacePath))
    .filter((entry): entry is [string, SubAgentConfig] => Boolean(entry[1]));
  return [...Object.entries(config.subAgents), ...promoted];
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
      const results = await searchByEmbedding(raw, provider, 8, opts?.allowedAgents ? { allowedAgents: opts.allowedAgents } : {});
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
      nearMisses: [],
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

  // The rerank blend RE-ORDERS the admitted set. It does not decide admission.
  //
  // It used to do both, and that was a scale error with a provable consequence. The TEI path
  // min-max normalises the model's logits (retrieval/reranker.ts), which throws away their
  // absolute meaning and substitutes the candidate's RANK within the shortlist: the worst
  // candidate always receives exactly 0 and the best always exactly 1. Feeding a rank
  // position into `combinedScore * 0.7 + rerankScore * 0.3` and then comparing the result
  // against the fixed 0.72 floor meant:
  //
  //   - the reranker's LAST choice scored at most 0.7 * 1.0 = 0.70 and was therefore
  //     rejected unconditionally, however well it matched — a perfect 1.0 embedding match
  //     still fell under the gate;
  //   - the reranker's FIRST choice scored at least 0.72 * 0.7 + 0.3 = 0.804 and was
  //     admitted unconditionally, however poorly;
  //   - and because the embedding term only varies across [0.72, 1.0] after its own floor
  //     while the rerank term is stretched across the full [0, 1], the nominal 70/30 blend
  //     behaved closer to 30/70 in the reranker's favour.
  //
  // ONE LIVE CONSEQUENCE, deliberate. `agents.ephemeralGeneration.skillMatchThreshold`
  // compares the REPORTED score, and min-max guaranteed the reranker's top pick at least
  // 0.72 * 0.7 + 0.3 = 0.804 — so any threshold set between 0.72 and 0.804 was bypassed
  // unconditionally, whatever the match was actually worth. That is the same score-inflation
  // failure `shouldPreferCatalogAgent` was written to stop; read its comment. Reporting the
  // pre-blend score restores the threshold's ability to discriminate, so a deployment pinning
  // 0.75 will now spawn an ephemeral agent for matches in 0.72-0.75 that used to be handed to
  // the catalog. That is the configured behaviour finally taking effect, not a new rule.
  //
  // So admission is decided by the embedding score, which is what the 0.72 floor was
  // calibrated for and which computeHybridRoutingScore has already gated once. The blend is
  // kept as the SORT KEY, so the reranker still does the job it is good at — ordering
  // near-equals — without deciding who is in the room. The reported score stays the
  // pre-blend one, so `results` carry the quantity the floor and `confidenceLabel` agree on.
  if (rerankScores && getConfig().retrieval.reranker.blendMode !== "admission") {
    ranked = ranked
      .map((result) => {
        const rerankScore = rerankScores.get(result.name);
        return rerankScore === undefined
          ? { ...result, rankKey: result.combinedScore }
          : { ...result, rankKey: Math.max(0, Math.min(1, result.combinedScore * 0.7 + rerankScore * 0.3)) };
      })
      .sort((a, b) => (b.rankKey - a.rankKey) || compareRoutingResults(a, b));
  } else if (rerankScores) {
    // Legacy: the blend decides admission too. Kept behind `blendMode: "admission"` so a
    // deployment that has tuned around the old numbers can pin them deliberately.
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
  } else {
    ranked = ranked.sort(compareRoutingResults);
  }

  ranked = ranked.slice(0, 5);

  // The best EMBEDDING scores that never reached `ranked`, kept purely as telemetry.
  //
  // computeHybridRoutingScore turns any sub-floor semantic score into a hard 0 and the
  // ranking then filters `> 0`, so a query where every agent scored 0.71 against a 0.72 gate
  // is indistinguishable in the logs from a query where nothing scored at all. Both report
  // resultCount 0, weakCount 0, gated false. That is precisely the shape of the e1151d8
  // incident — 49 agents at 0.7059 against a 0.72 floor — and of a German paraphrase landing
  // a few hundredths under a gate its English twin clears.
  //
  // Nothing downstream reads this: results, weakCandidates and the branch logic are all
  // unchanged. It exists so the near miss is visible before anyone has to guess.
  // Only when the ranking came back EMPTY. The field exists to explain a turn that got
  // nothing, not to annotate healthy ones: almost every successful query also has agents
  // sitting under the gate, and listing them would put three names on every audit row while
  // saying nothing anyone would act on.
  //
  // Restricted to agents this pass was actually ALLOWED to route to. `semanticScores` comes
  // from searchByEmbedding, which honours `allowedAgents` but knows nothing about the
  // `excludeAgents` set or the circuit breaker — both of which `entries` was filtered by
  // above. Without this the field can name a coordinator excluding itself, or an agent whose
  // breaker is open after repeated failures, and `surfaceRoutingNearMisses` would then invite
  // the model to delegate to exactly the agent the router refused to offer.
  const eligible = new Set(entries.map(([name]) => name));
  const nearMisses = ranked.length > 0 ? [] : [...semanticScores.entries()]
    .filter(([name, score]) => eligible.has(name) && score > 0 && score < SEMANTIC_AGENT_ROUTING_MIN_SCORE)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, score]) => ({ name, score: Number(score.toFixed(4)) }));

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
    nearMisses,
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
 * Browser tools that only look at the page the shared browser tab already shows, in both the
 * gateway's own names and the bridged Playwright server's. None of them opens a URL, so they
 * read whatever page the last navigation left there, which may be another session's.
 */
const BROWSER_TAB_VIEW_TOOL_NAMES = new Set<string>([
  "browser_snapshot", "browser_screenshot", "browser_take_screenshot",
  "mcp__playwright__browser_snapshot", "mcp__playwright__browser_screenshot", "mcp__playwright__browser_take_screenshot",
]);

/**
 * True for a tool that can GATHER fresh external evidence (search + fetch page
 * content + drive a browser). This is the narrower cousin of isWebReachingToolName:
 * it excludes url_inspect, which only probes a URL you already have (headers,
 * redirects, content-type) and cannot search or read page content. An agent whose
 * only "web" tool is url_inspect cannot do PRIMARY research — evidence_analyst
 * (url_inspect only, no web_search/web_fetch) was wrongly classed research-capable
 * and dead-looped url_inspect on a 404 after being handed a gather task (audit 687a224b).
 *
 * It excludes the browser tab views (BROWSER_TAB_VIEW_TOOL_NAMES) for the same reason. The
 * browser_ prefix credited them, so vision_browser_analyst, which holds only browser_snapshot
 * and browser_screenshot, counted as a gatherer. Routing gave it "die URL … abrufen" steps
 * ahead of browser_agent and researcher, and it snapshotted a tab an earlier session had left on
 * another page nine times, then answered from that page (E2E 2026-10-08, 79dd29e0, 3c91cb68,
 * c172d755). A browser tool that drives the page (browser_navigate, browser_click, …) still counts.
 */
export function isWebGatheringToolName(toolName: string): boolean {
  if (toolName === "url_inspect" || BROWSER_TAB_VIEW_TOOL_NAMES.has(toolName)) return false;
  return isWebReachingToolName(toolName);
}

/**
 * Pure capability check against an agent's tool list. Research-capable means it can
 * GATHER from the web directly (web_search/web_fetch/browser_*) or is a coordinator
 * that can delegate to one that does. url_inspect alone does NOT qualify (it only
 * probes a known URL, cannot search/fetch), and neither do browser tab views alone
 * (browser_snapshot/browser_screenshot read the open page, cannot open one). An undefined tool list means "inherit all
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
 * Whether an agent gathers external evidence ITSELF, rather than merely being able
 * to hand the task to something that does. The same distinction `isWebGatheringToolName`
 * already draws one clause up — it excludes url_inspect because probing a known URL is
 * not primary research — applied to the coordination clause, which never got it.
 *
 * The coordination clause is right for a coordinator and wrong for a WRITER that happens
 * to hold `delegate_to_agent`. Of the 48 agents this repo configures, 14 pass
 * `agentCfgIsResearchCapable` but only 8 gather directly; of the six credited on
 * coordination alone, four are coordinators and two are WRITERS — meeting_briefing_agent,
 * and paper_author, whose own description says it drafts "from an already-collected
 * evidence ledger" and is "distinct from researcher". Session 00b3675d handed it four consecutive
 * source-sensitive delegations at high confidence (topResultScore 0.845-0.866) and its
 * sub-sessions made 0 web_search, 0 web_fetch and, on three of the four, 0
 * delegate_to_agent calls: three pricing reports written from model memory, each
 * reporting delegationOutcome "success". One told the user Anthropic has no
 * subscription plans minutes after the user said they hold one.
 *
 * Used ONLY as the RANKING key (see preferResearchCapableCandidates). The veto that
 * decides whether a delegation is redirected stays `agentCfgIsResearchCapable`, so a
 * coordinator asked to run a multi-area mission is still allowed to fan it out.
 */
export function agentCfgGathersDirectly(cfg: { tools?: string[] } | undefined): boolean {
  if (!cfg) return true;
  if (!cfg.tools) return true; // inherits the full tool set
  return cfg.tools.some(isWebGatheringToolName);
}

/** Config-backed {@link agentCfgGathersDirectly}. */
export function agentGathersDirectly(agentName: string): boolean {
  const config = getConfig();
  return agentCfgGathersDirectly(config.subAgents[agentName] ?? readPromotedAgents(config.workspacePath)[agentName]);
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
// English-internal (de-lexicalized): these carry no per-language entries, so this shape fires for
// English task text only. The structural "SOURCE-SENSITIVE DELEGATION" marker checked first in the
// function below is language-independent, but nothing puts it on the orchestrator's own
// delegations any more: its injector needs the sourceSensitive guidance flag the de-lex hard-wired
// off, and the boundary translation that would hand this shape English is off by default
// (orchestration.normalizeDelegationToEnglish). A plan step written in German therefore never
// matched here, and web_coder ran a "die Website … abrufen" step it cannot do (E2E 2026-10-07,
// 2f31f387). A non-English research step now reaches the research gate through its TURN TRIGGER
// (executeDelegationWithFallback in tools/sub-agent.ts): the up-front judge's verdict and the named
// agent's routing taxonomy, no words at all.
const WEB_RESEARCH_VERB_RE = /\b(?:research|investigat\w+|searche?s?|find|look\s*up|gather|compare|recommend)\b/i;
// External web nouns now also cover PRODUCT/MODEL/TOOL SELECTION research — "find the
// best image MODEL", "compare GPUs", "research the top framework". The field of real
// options, their specs/benchmarks/versions/availability are external facts that must be
// gathered, not recalled; without these nouns "research the best X model" matched the
// verb but no noun and slipped through (live session d4eca79c: a generator, image_creator,
// topped the ranking for a research query and the answer was fabricated with zero
// web_search calls). WORKSPACE_CODE_MARKER_RE still vetoes internal code/file lookups.
const EXTERNAL_WEB_NOUN_RE = /\b(?:url|urls|link|links|website|websites|online|platforms?|providers?|vendors?|prices?|pricing|courses?|datasheets?|reviews?|models?|tools?|toolkits?|software|hardware|frameworks?|librar(?:y|ies)|apps?|applications?|services?|products?|benchmarks?|alternatives?|gpus?|cpus?)\b/i;
const WORKSPACE_CODE_MARKER_RE = /\b(?:codebase|workspace|repository|repo|source\s*code|functions?|methods?|files?|symbols?|class(?:es)?|modules?)\b/i;

/**
 * Whether a delegation task requires fresh external evidence, read from the task's text: the
 * "SOURCE-SENSITIVE DELEGATION" wrapper (rarely injected since the de-lex — see the note above),
 * explicit "search online / validate" phrasing and the vetted research patterns. When true, the
 * chosen agent MUST be research-capable — this is a correctness invariant, not a routing
 * preference. The research gate has a second, language-independent trigger that does not read
 * the text (the turn trigger in executeDelegationWithFallback).
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
export function pickResearchFallbackAgent(attempted: string[], canDispatch?: (name: string) => boolean): string | undefined {
  const config = getConfig();
  const promoted = readPromotedAgents(config.workspacePath);
  // Prefer the direct web specialist over a coordinator: a single research task
  // does not need a coordinator-of-coordinator hop (the ~20-min web_task_coordinator
  // → researcher loop, session 44ea5c21). Coordinators are the last resort.
  return ["researcher", "browser_agent", "web_task_coordinator", "mission_coordinator"].find(
    (name) => (config.subAgents[name] || promoted[name]) && agentIsResearchCapable(name) && !attempted.includes(name)
      && (!canDispatch || canDispatch(name)),
  );
}

type CapabilityBearing = (TaxonomyBearing & { tools?: string[] }) | undefined;

/** Surfaces of the routing taxonomy that stay inside the deployment. Every other surface — the
 *  open network, a browser, a desktop host, remote infrastructure, the user's own channels — reaches
 *  a source outside the workspace. */
const WORKSPACE_SURFACES: ReadonlySet<string> = new Set(["workspace", "local_sandbox", "swarm_internal"]);

/**
 * Whether an agent's one way outside the workspace is the page the shared browser tab already
 * shows: it holds nothing that gathers or delegates (agentCfgIsResearchCapable, which does not
 * count a snapshot or screenshot of the open tab), and the browser is the only outside surface its
 * routing taxonomy names. It can read a page but not open one, so it reads whatever the last
 * navigation left there. On a turn nothing has gathered for yet, that is another turn's page: on
 * the E2E run of 2026-10-08 (c172d755) a plan named vision_browser_analyst for both of its site
 * steps, and it read dokumentation.html, which another session had opened, and reported a
 * headcount and two page visits it never made.
 */
function agentCfgOnlyReadsOpenBrowserTab(cfg: CapabilityBearing): boolean {
  if (!cfg || agentCfgIsResearchCapable(cfg)) return false;
  const outside = (resolveRoutingTaxonomy(cfg)?.surface ?? []).filter((surface) => !WORKSPACE_SURFACES.has(surface));
  return outside.length > 0 && outside.every((surface) => surface === "browser");
}

/**
 * Whether an agent can reach anything outside the workspace: it can gather or delegate (the
 * research gate's own veto, agentCfgIsResearchCapable), or its routing taxonomy names a surface
 * outside the workspace — a mailbox, a calendar, a desktop, remote infrastructure. Read from the
 * taxonomy rather than from tool names, because that is where the catalog already records it
 * (`surface` is derived from the tool list and linted for staleness). An agent with no taxonomy,
 * or an empty surface list, is treated as reaching out: the turn trigger never touches what it
 * cannot classify. An agent that only reads the open browser tab (agentCfgOnlyReadsOpenBrowserTab)
 * does not reach out: the page it reads is one another agent opened.
 */
export function agentCfgReachesOutsideWorkspace(cfg: CapabilityBearing): boolean {
  if (!cfg || agentCfgIsResearchCapable(cfg)) return true;
  // A promoted agent is read from its JSON file without the schema's defaults, so a hand-written
  // routing block can lack `surface` altogether: unclassifiable, not a crash on the delegation path.
  const surfaces = resolveRoutingTaxonomy(cfg)?.surface ?? [];
  if (surfaces.length === 0) return true;
  if (agentCfgOnlyReadsOpenBrowserTab(cfg)) return false;
  return surfaces.some((surface) => !WORKSPACE_SURFACES.has(surface));
}

/**
 * Whether an agent works only from the text it is handed: confined to the workspace, and its
 * taxonomy's input is text alone. A builder, writer or generator (web_coder, content_writer,
 * image_creator). An agent that reads a codebase, an uploaded file or a data table has a source of
 * its own and is not this — its step may well be about that source. An agent that only reads the
 * open browser tab is this too, whatever its input: the page is handed to it the way text is, by
 * whichever agent opened it, and with nothing gathered yet it has nothing to read.
 */
export function agentCfgWorksOnlyFromHandedText(cfg: CapabilityBearing): boolean {
  if (agentCfgReachesOutsideWorkspace(cfg)) return false;
  if (agentCfgOnlyReadsOpenBrowserTab(cfg)) return true;
  const inputs = resolveRoutingTaxonomy(cfg)?.inputModality ?? [];
  return inputs.length > 0 && inputs.every((input) => input === "text" || input === "none");
}

/**
 * The member of a batch of delegations — a plan's delegate steps, parallel slices, task-graph
 * nodes — that may become the turn's evidence gather point when the turn needs outside facts: the
 * first one, in the order given, naming an agent that works only from handed text. -1 when any member
 * could reach outside the workspace itself (it names such an agent, names none, or names an
 * unknown one): the batch has then already decided where its evidence comes from, and every member
 * keeps the agent it names. The order given has to be the order the members run in: a plan and a
 * task graph run by their dependsOn edges, so they ask once for the whole batch (is there a gather
 * point at all) and then again for each round they dispatch, which picks the first one that runs.
 */
export function evidenceGatherPoint(
  agentNames: ReadonlyArray<string | undefined>,
  lookup: (name: string) => CapabilityBearing,
): number {
  if (agentNames.some((name) => !name || agentCfgReachesOutsideWorkspace(lookup(name)))) return -1;
  return agentNames.findIndex((name) => agentCfgWorksOnlyFromHandedText(lookup(name!)));
}

/** Config-backed lookup for the two predicates above (configured or promoted agent). */
export function lookupAgentCapabilities(name: string): CapabilityBearing {
  const config = getConfig();
  return config.subAgents[name] ?? readPromotedAgents(config.workspacePath)[name];
}

/**
 * Pure reorder for the topic-over-intent bias in semantic routing. A research
 * query embeds near its SUBJECT, so a pure generator that owns that subject
 * (image_creator for "research the best image MODEL") can top the ranking despite
 * being unable to research anything. For a research query, put research-capable
 * candidates first; report `needsFallback` when NONE of the surfaced candidates
 * can research (the caller then surfaces the canonical research specialist).
 * Never dead-ends: a non-research query, an empty set, or an all-capable set is
 * returned unchanged. Extracted from the config-backed wrapper below so the
 * ordering rule is unit-testable without a config fixture.
 */
export function reorderByResearchCapability(
  results: AgentRoutingCandidate[],
  isResearchQuery: boolean,
  isCapable: (name: string) => boolean,
): { results: AgentRoutingCandidate[]; needsFallback: boolean } {
  if (results.length === 0 || !isResearchQuery) return { results, needsFallback: false };
  const capable = results.filter((candidate) => isCapable(candidate.name));
  if (capable.length === 0) return { results, needsFallback: true };
  if (capable.length === results.length) return { results, needsFallback: false };
  const incapable = results.filter((candidate) => !isCapable(candidate.name));
  return { results: [...capable, ...incapable], needsFallback: false };
}

function buildConfiguredAgentCandidate(name: string, score: number): AgentRoutingCandidate | null {
  const config = getConfig();
  const cfg = config.subAgents[name] ?? readPromotedAgents(config.workspacePath)[name];
  if (!cfg) return null;
  return toCandidate(name, cfg, score, [], config.agents.defaults.model.primary, config.workspacePath);
}

/**
 * Apply {@link reorderByResearchCapability} against the live config, and when the
 * entire ranking is research-incapable for a research query, surface the canonical
 * research specialist ({@link pickResearchFallbackAgent}, i.e. researcher) as the
 * top pick — for a research task we are confident the web specialist is the right
 * CAPABILITY match even though the topical embedding did not surface it. Pure of
 * side effects; returns the (possibly reordered / fallback-prepended) list.
 */
export function preferResearchCapableCandidates(
  results: AgentRoutingCandidate[],
  query: string,
): AgentRoutingCandidate[] {
  const { results: reordered, needsFallback } = reorderByResearchCapability(
    results,
    taskRequiresExternalResearch(query),
    // Rank on who gathers DIRECTLY, not on who could delegate. A coordinator that can
    // reach a researcher is still a legitimate pick — it just does not outrank the
    // researcher for a research query, which is the same preference
    // pickResearchFallbackAgent already documents ("a single research task does not
    // need a coordinator-of-coordinator hop"). This is the layer that decides: the
    // model named no agent on any of session 00b3675d's four delegations; the runtime
    // injects search_agents' topResult (four tool_call_recovered rows,
    // reason "reuse_search_agents_top_result"), so the ranking IS the router.
    // Ordering only — reorderByResearchCapability returns the list untouched when the
    // set is empty, all-capable, or the query is not research, and needsFallback below
    // PREPENDS the specialist rather than removing anyone.
    agentGathersDirectly,
  );
  if (!needsFallback) return reordered;
  const fallbackName = pickResearchFallbackAgent([]);
  if (!fallbackName) return reordered;
  // Score just above the strong-match threshold (0.72): confident capability match.
  const fallbackCandidate = buildConfiguredAgentCandidate(fallbackName, 0.75);
  return fallbackCandidate ? [fallbackCandidate, ...reordered] : reordered;
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
