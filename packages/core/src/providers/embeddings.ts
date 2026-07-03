/**
 * Semantic agent search via local embeddings.
 *
 * Uses LM Studio's /v1/embeddings endpoint (same OpenAI-compatible client).
 * Recommended model: "qwen3-embedding" or "nomic-embed-text"
 *
 * Gracefully falls back to keyword search if no embedding model is available.
 */
import type { LMStudioProvider } from "./lmstudio.js";
import type { SubAgentConfig } from "../config/schema.js";
import { childLogger } from "../logger.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

import { PRODUCT } from "../product/index.js";

const log = childLogger("embeddings");

interface EmbeddingEntry {
  agentName: string;
  description: string;
  vector: Float32Array;
}

interface EmbeddingSearchResult {
  agentName: string;
  description: string;
  score: number;
}

interface CachedEmbeddingQuery {
  storedAt: number;
  results: EmbeddingSearchResult[];
}

/** Extension-contributed routing keywords (see extension SDK `toolKeywords`). */
const EXTENSION_KEYWORD_RULES: Array<{ pattern: RegExp; keywords: string[] }> = [];

/** @internal extension-loader-only. */
export function registerExtensionToolKeywords(rules: Array<{ pattern: RegExp; keywords: string[] }>): void {
  EXTENSION_KEYWORD_RULES.push(...rules);
}

/** Test hook. */
export function _resetExtensionToolKeywordsForTests(): void {
  EXTENSION_KEYWORD_RULES.length = 0;
}

const TOOL_KEYWORD_RULES: Array<{ pattern: RegExp; keywords: string[] }> = [
  // The web_search/web_fetch rule used to inject ["news","updates","latest",
  // "current","release notes"] into every agent that owns a web tool.  That
  // pulled FRESHNESS queries to incidental web-tool holders (channel_operator,
  // prompt_optimizer, etc.) just because they happened to have web_fetch.
  // Keep "release notes" — it's a documentation-shaped artifact specific
  // to researcher's scope — but drop the news/freshness keywords; those
  // routing decisions now flow through the freshnessNewsIntent /
  // looksNewsTask heuristics rather than via tool-rule keyword inflation.
  { pattern: /web_search|web_fetch|searxng/, keywords: ["research", "web", "search", "facts", "documentation", "sources", "release notes"] },
  { pattern: /playwright|browser_/, keywords: ["browser", "automation", "login", "forms", "screenshots", "navigation", "scraping"] },
  { pattern: /code_sandbox|run_js|run_ts/, keywords: ["coding", "scripts", "execution", "analysis", "transform"] },
  { pattern: /shell_exec|run_script/, keywords: ["shell", "terminal", "devops", "ops", "commands"] },
  { pattern: /read_file|list_files|filesystem/, keywords: ["files", "workspace", "code", "analysis"] },
  { pattern: /write_file/, keywords: ["write", "draft", "report", "output"] },
  { pattern: /get_site_credentials/, keywords: ["credentials", "auth", "login", "selectors", "stored"] },
  { pattern: /site_fill_credentials/, keywords: ["credentials", "auth", "login", "forms", "password", "username", "secure fill"] },
  { pattern: /computer_type_credential/, keywords: ["credentials", "auth", "login", "desktop", "rdp", "remote desktop", "password", "username"] },
  { pattern: /delegate_to_agent/, keywords: ["orchestration", "workflow", "delegation"] },
];

// NOTE: the keyword intent/task-shape scoring layer (token-sets, phrase banks,
// hasPhrase/hasToken, all is*Specialist detectors, computeAgentIntentAdjustment,
// computeAgentTaskShapeAdjustment) was deleted. Agent routing is now purely semantic
// embedding-search + structural capability gates; the lexical floor is the
// language-agnostic IDF token-overlap in scoreAgentKeywordMatch / buildAgentTokenIdf.

let _index: EmbeddingEntry[] = [];
let _available = false;
let _embeddingModel = "";
const _queryCache = new Map<string, CachedEmbeddingQuery>();
// Raw query-vector cache (distinct from `_queryCache`, which holds post-search
// `EmbeddingSearchResult[]`). Keyed by `${embeddingModel}::${normalized query}`.
// Hit by tool rerank, trajectory cache, and memory service — all of which
// previously fired an HTTP embedding call per invocation.
type CachedQueryVector = { storedAt: number; vector: Float32Array };
const _queryVectorCache = new Map<string, CachedQueryVector>();
const _queryVectorInflight = new Map<string, Promise<Float32Array | null>>();
let _lastProvider: LMStudioProvider | null = null;
let _lastSubAgents: Record<string, SubAgentConfig> = {};
let _lastEmbeddingError: string | undefined;
let _lastEmbeddingFailedAgent: string | undefined;
let _lastEmbeddingFailureAt: string | undefined;
let _retryTimer: ReturnType<typeof setTimeout> | null = null;
let _retryDelayMs = 0;
// Concurrency guard: only one buildAgentIndex may run at a time.
// If a second call arrives while one is in progress, it is coalesced into a
// single follow-up build so callers never see stale data but the embedding
// endpoint is never flooded with duplicate batches.
let _buildInProgress = false;
let _pendingBuild: { subAgents: Record<string, SubAgentConfig>; provider: LMStudioProvider; embeddingModel: string } | null = null;

const QUERY_CACHE_TTL_MS = 5 * 60_000;
const QUERY_CACHE_MAX_ENTRIES = 64;
const QUERY_VECTOR_CACHE_TTL_MS = 5 * 60_000;
const QUERY_VECTOR_CACHE_MAX_ENTRIES = 256;
const EMBEDDING_RETRY_INITIAL_DELAY_MS = 15_000;
const EMBEDDING_RETRY_MAX_DELAY_MS = 120_000;
const SEARCH_STOP_WORDS = new Set<string>([
  // English functional / auxiliary words
  "a", "an", "and", "any", "are", "as", "at", "be", "been", "but", "by",
  "can", "check", "could", "do", "does", "for", "from",
  "get", "give", "has", "have", "how", "i", "if", "in", "is", "it",
  "its", "me", "most", "my", "no", "not", "of", "on", "ones", "or", "our",
  "please", "set", "show", "so", "such", "that", "top", "up",
  "each", "every", "last", "used", "via", "was", "what", "when", "where",
  "tell", "the", "their", "them", "these", "this", "those", "to", "us", "we", "with", "you",
  // German functional words
  "de", "der", "die", "das", "dem", "den", "des", "ein", "eine", "einer", "eines", "und",
  "für", "fuer", "im", "in", "ist", "kann", "kannst", "meine", "meinen", "meiner", "meines",
  "mir", "uns", "zeige", "alle", "auch", "auf", "aus", "bei", "bis", "du", "er", "es",
  "hat", "hier", "ich", "ihm", "ihn", "ihr", "kein", "keine", "noch", "nur", "oder",
  "sei", "seit", "sie", "so", "von", "vor", "war", "wie", "wo", "zu", "zum", "zur",
]);

export interface EmbeddingSearchStatus {
  configured: boolean;
  available: boolean;
  model: string | null;
  indexedAgentCount: number;
  totalAgentCount: number;
  retryScheduled: boolean;
  retryDelayMs: number;
  lastError?: string;
  lastFailedAgent?: string;
  lastFailureAt?: string;
}

function summarizeEmbeddingError(err: unknown): string {
  const value = err instanceof Error
    ? err.message || err.toString()
    : String(err);
  return value.replace(/\s+/g, " ").trim().slice(0, 500) || "unknown embedding error";
}

function recordEmbeddingFailure(err: unknown, failedAgent?: string): void {
  _lastEmbeddingError = summarizeEmbeddingError(err);
  _lastEmbeddingFailedAgent = failedAgent;
  _lastEmbeddingFailureAt = new Date().toISOString();
}

function clearEmbeddingFailure(): void {
  _lastEmbeddingError = undefined;
  _lastEmbeddingFailedAgent = undefined;
  _lastEmbeddingFailureAt = undefined;
}

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_:/.-]+/g, " ")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeSearchText(value: string): string[] {
  return [...new Set(
    normalizeSearchText(value)
      .split(" ")
      .filter((token) => token.length >= 2 && !SEARCH_STOP_WORDS.has(token))
  )];
}

function expandTokenVariants(token: string): string[] {
  const variants = new Set<string>([token]);

  if (token.length > 4 && token.endsWith("es")) {
    variants.add(token.slice(0, -2));
  }
  if (token.length > 3 && token.endsWith("s")) {
    variants.add(token.slice(0, -1));
  }

  return [...variants].filter((value) => value.length >= 2);
}

export function inferAgentSearchKeywords(agentName: string, cfg: SubAgentConfig): string[] {
  const keywords = new Set<string>();

  for (const token of tokenizeSearchText(`${agentName} ${cfg.description}`)) {
    keywords.add(token);
  }

  for (const value of [...(cfg.capabilities ?? []), ...(cfg.tags ?? [])]) {
    for (const token of tokenizeSearchText(value)) {
      keywords.add(token);
    }
    keywords.add(value.toLowerCase());
  }

  for (const toolName of cfg.tools ?? []) {
    for (const token of tokenizeSearchText(toolName)) {
      keywords.add(token);
    }

    for (const rule of [...TOOL_KEYWORD_RULES, ...EXTENSION_KEYWORD_RULES]) {
      if (rule.pattern.test(toolName)) {
        for (const keyword of rule.keywords) {
          keywords.add(keyword);
        }
      }
    }
  }

  return [...keywords].sort();
}

export function buildAgentSearchDocument(agentName: string, cfg: SubAgentConfig): string {
  const tools = cfg.tools?.join(", ") ?? "general";
  const keywords = inferAgentSearchKeywords(agentName, cfg).join(", ");
  const promptExcerpt = cfg.systemPrompt?.slice(0, 800) ?? "";
  const capabilities = (cfg.capabilities ?? []).join(", ");
  const tags = (cfg.tags ?? []).join(", ");

  return [
    `Agent: ${agentName}`,
    `Description: ${cfg.description}`,
    capabilities ? `Capabilities: ${capabilities}` : "",
    tags ? `Tags: ${tags}` : "",
    `Tools: ${tools}`,
    `Search Keywords: ${keywords}`,
    promptExcerpt ? `Prompt: ${promptExcerpt}` : "",
  ].filter(Boolean).join("\n");
}

/**
 * BM25-style inverse document frequency over the agent corpus, for the LEXICAL
 * routing fallback. Without IDF, common tokens ("web", "search", "research")
 * match nearly every agent and a degraded-embeddings ranking goes flat — the
 * 0.25-everywhere collapse that pushed routing into architect-fallback ephemerals
 * (audit 9b5196ad). Rare tokens are what actually discriminate specialists.
 * ~59 small docs → trivial to compute per search; no caching needed.
 */
export function buildAgentTokenIdf(agents: Array<[string, SubAgentConfig]>): Map<string, number> {
  const docCount = agents.length;
  const df = new Map<string, number>();
  for (const [name, cfg] of agents) {
    const tokens = new Set<string>(tokenizeSearchText([
      name,
      cfg.description,
      ...(cfg.capabilities ?? []),
      ...(cfg.tags ?? []),
      ...(cfg.tools ?? []),
    ].join(" ")));
    for (const t of tokens) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const idf = new Map<string, number>();
  for (const [t, n] of df) idf.set(t, Math.log(1 + (docCount - n + 0.5) / (n + 0.5)));
  return idf;
}

export function scoreAgentKeywordMatch(
  query: string,
  agentName: string,
  cfg: SubAgentConfig,
  idf?: Map<string, number>,
): { score: number; matchedTerms: string[] } {
  const normalizedQuery = normalizeSearchText(query);
  const queryTokens = tokenizeSearchText(query);

  if (!normalizedQuery || queryTokens.length === 0) {
    return { score: 0, matchedTerms: [] };
  }

  // Per-query-normalized IDF weight in [0.35, 1]: rare tokens dominate, but common
  // tokens still contribute (an all-common query must not zero out). A token absent
  // from the corpus is treated as maximally rare — it discriminates by definition.
  const maxIdf = idf && idf.size > 0 ? Math.max(...queryTokens.map((t) => idf.get(t) ?? Number.NEGATIVE_INFINITY)) : 0;
  const corpusMaxIdf = idf && idf.size > 0 ? Math.max(...idf.values()) : 0;
  const idfWeight = (token: string): number => {
    if (!idf || idf.size === 0) return 1;
    const tokenIdf = idf.get(token) ?? corpusMaxIdf;
    const reference = Math.max(maxIdf, tokenIdf, 1e-9);
    return 0.35 + 0.65 * (tokenIdf / reference);
  };

  const nameText = normalizeSearchText(agentName);
  const descriptionText = normalizeSearchText(cfg.description);
  const promptText = normalizeSearchText(cfg.systemPrompt ?? "");
  const toolsText = normalizeSearchText((cfg.tools ?? []).join(" "));
  const keywordTokens = inferAgentSearchKeywords(agentName, cfg);
  const matchedTerms = new Set<string>();

  let score = 0;

  if (nameText.includes(normalizedQuery)) score += 1.2;
  else if (descriptionText.includes(normalizedQuery)) score += 0.9;

  for (const token of queryTokens) {
    let tokenScore = 0;
    const variants = expandTokenVariants(token);

    if (variants.some((variant) => nameText.split(" ").includes(variant) || nameText.includes(variant))) {
      tokenScore = Math.max(tokenScore, 0.95);
    }
    if (variants.some((variant) => descriptionText.includes(variant))) {
      tokenScore = Math.max(tokenScore, 0.75);
    }
    if (variants.some((variant) => keywordTokens.some(keyword => keyword === variant || keyword.includes(variant)))) {
      tokenScore = Math.max(tokenScore, 0.85);
    }
    if (variants.some((variant) => toolsText.includes(variant))) {
      tokenScore = Math.max(tokenScore, 0.65);
    }
    if (variants.some((variant) => promptText.includes(variant))) {
      tokenScore = Math.max(tokenScore, 0.4);
    }

    if (tokenScore > 0) {
      score += tokenScore * idfWeight(token);
      matchedTerms.add(token);
    }
  }

  const coverageBonus = (matchedTerms.size / queryTokens.length) * 0.4;
  // Pure IDF-weighted token-overlap (the language-agnostic degraded-mode floor).
  // The keyword intent/shape adjustment layer that used to be folded in here was
  // removed — routing must not add topic/keyword scoring on top of token overlap.
  const adjustedScore = Math.max(0, Math.min(1, ((score / queryTokens.length) + coverageBonus) / 1.4));

  return { score: adjustedScore, matchedTerms: [...matchedTerms] };
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  return normA === 0 || normB === 0 ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ── Persistent embedding cache ────────────────────────────────────────────────

interface PersistedEmbeddingEntry {
  /** SHA-256 of the agent's search document — used to detect changes. */
  hash: string;
  /** Base64-encoded Float32Array (little-endian). */
  vector: string;
}

interface PersistedEmbeddingCache {
  /** Embedding model name the vectors were produced with. */
  model: string;
  agents: Record<string, PersistedEmbeddingEntry>;
}

function resolveEmbeddingCachePath(): string {
  const explicit = process.env["SAI_EMBEDDING_CACHE"]?.trim();
  if (explicit) return resolve(explicit);
  const workspacePath = resolve(process.cwd(), PRODUCT.stateDirName, "embedding-cache.json");
  const homePath = resolve(homedir(), PRODUCT.stateDirName, "embedding-cache.json");
  if (existsSync(workspacePath)) return workspacePath;
  return workspacePath; // default to workspace even if it doesn't exist yet
}

function hashAgentDocument(doc: string): string {
  return createHash("sha256").update(doc).digest("hex");
}

/**
 * A cached embedding is degenerate if it is empty or all-zero — a sign the
 * embedding pipeline was broken when it was written (e.g. base64 mis-decode).
 * Such entries must be re-embedded rather than restored, so a stale cache can
 * never silently degrade semantic search after a fix.
 */
function isDegenerateCachedVector(b64: string): boolean {
  try {
    const v = base64ToFloat32(b64);
    return isDegenerateVector(v);
  } catch {
    return true;
  }
}

/**
 * A live embedding is degenerate if it is empty or all-zero — a transient broken
 * embedding response. Such a vector must never be cached or returned: cosine
 * similarity against it is ~0/NaN, which would silently flatten ALL semantic
 * retrieval (tool rerank, memory recall, trajectory cache, RAG) for the full
 * cache TTL. Treat it as a miss so the next call re-embeds.
 */
function isDegenerateVector(v: Float32Array | null | undefined): boolean {
  if (!v || v.length === 0) return true;
  for (const x of v) { if (x !== 0) return false; }
  return true;
}

function float32ToBase64(v: Float32Array): string {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");
}

function base64ToFloat32(s: string): Float32Array {
  const buf = Buffer.from(s, "base64");
  // A corrupt/truncated cache entry can decode to a non-multiple-of-4 length. The
  // zero-copy view constructor would silently TRUNCATE that into a shorter vector
  // (cosineSimilarity then reads past its end → NaN scores → flattened routing).
  // Reject it so the degeneracy guard routes it to re-embed. Also copy into an
  // owned, 4-aligned ArrayBuffer so the view never aliases a pooled Buffer whose
  // byteOffset is not 4-aligned (which would throw a RangeError).
  if (buf.byteLength === 0 || buf.byteLength % 4 !== 0) {
    throw new Error(`corrupt embedding vector: ${buf.byteLength} bytes is not a multiple of 4`);
  }
  const copy = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(copy);
}

function loadEmbeddingCache(model: string): Record<string, PersistedEmbeddingEntry> {
  try {
    const path = resolveEmbeddingCachePath();
    if (!existsSync(path)) return {};
    const raw = JSON.parse(readFileSync(path, "utf-8")) as PersistedEmbeddingCache;
    if (raw.model !== model) {
      log.info({ cached: raw.model, current: model }, "Embedding model changed — discarding cache");
      return {};
    }
    return raw.agents ?? {};
  } catch {
    return {};
  }
}

function saveEmbeddingCache(model: string, agents: Record<string, PersistedEmbeddingEntry>): void {
  try {
    const path = resolveEmbeddingCachePath();
    mkdirSync(resolve(path, ".."), { recursive: true });
    const data: PersistedEmbeddingCache = { model, agents };
    writeFileSync(path, JSON.stringify(data), "utf-8");
  } catch (err) {
    log.warn({ err }, "Failed to save embedding cache");
  }
}

async function _buildAgentIndexInner(
  subAgents: Record<string, SubAgentConfig>,
  provider: LMStudioProvider,
  embeddingModel: string
): Promise<void> {
  _lastProvider = provider;
  _lastSubAgents = { ...subAgents };
  _embeddingModel = embeddingModel;
  // Only invalidate the search-result cache; preserve the query-vector cache
  // and its inflight-dedup map so concurrent rerankToolsForTask / memory
  // lookups keep their dedup guard and do NOT fire duplicate HTTP requests.
  _queryCache.clear();
  const entries = Object.entries(subAgents);
  if (entries.length === 0) {
    _index = [];
    _available = false;
    clearEmbeddingFailure();
    clearEmbeddingRetryTimer();
    return;
  }

  // ── Load persisted cache ──────────────────────────────────────────────────
  const cachedAgents = loadEmbeddingCache(embeddingModel);

  // Compute current hash for every agent
  const currentDocs = new Map<string, { doc: string; hash: string; cfg: SubAgentConfig }>();
  for (const [name, cfg] of entries) {
    const doc = buildAgentSearchDocument(name, cfg);
    currentDocs.set(name, { doc, hash: hashAgentDocument(doc), cfg });
  }

  // Identify which agents actually need a new embedding. Re-embed when the
  // document changed OR the cached vector is degenerate (empty / all-zero) — the
  // latter self-heals a cache persisted across an embedding-pipeline change
  // (e.g. the LM Studio base64→float fix) that would otherwise silently serve
  // zero vectors and break semantic routing.
  const toEmbed: Array<{ name: string; doc: string }> = [];
  for (const [name, { doc, hash }] of currentDocs) {
    const cached = cachedAgents[name];
    if (!cached || cached.hash !== hash || isDegenerateCachedVector(cached.vector)) {
      toEmbed.push({ name, doc });
    }
  }

  const unchanged = entries.length - toEmbed.length;
  if (toEmbed.length === 0) {
    // Everything is cached — restore index directly without any HTTP calls
    _index = entries.flatMap(([name, cfg]) => {
      // Skip (rather than abort the whole build on) a stray corrupt cache entry;
      // the degeneracy guard above already re-embeds these, so this is defensive.
      try {
        return [{ agentName: name, description: cfg.description, vector: base64ToFloat32(cachedAgents[name]!.vector) }];
      } catch (err) {
        log.warn({ err, agent: name }, "skipping corrupt cached embedding entry");
        return [];
      }
    });
    // Live endpoint probe: the index loaded ENTIRELY from the on-disk cache, so NO live embed
    // happened this load. If the configured model has since been unloaded/removed from the
    // endpoint, blindly setting `_available = true` would be a lie — every query embed would
    // then fail at runtime and semantic routing/recall silently degrades to keyword scoring
    // (audit 9b5196ad: stale cache + a model that returns "No models loaded" → every catalog
    // agent scored ~0.25 → architect-fallback ephemeral with no obvious cause). Verify the
    // endpoint actually serves the configured model before trusting the cache.
    try {
      const [probe] = await provider.embed(["embedding endpoint health probe"], embeddingModel);
      if (!probe || probe.length === 0) throw new Error("embedding endpoint returned an empty vector");
      _available = true;
      _retryDelayMs = 0;
      clearEmbeddingFailure();
      clearEmbeddingRetryTimer();
      log.info({ model: embeddingModel, agentCount: _index.length }, "Agent embedding index loaded from cache (no changes); endpoint probe OK");
    } catch (err) {
      _available = false;
      recordEmbeddingFailure(err);
      log.warn(
        { err, model: embeddingModel, agentCount: _index.length },
        "Agent embedding index loaded from cache BUT the configured embedding model is NOT serving — semantic agent routing, skill/memory recall, and RAG will degrade to keyword matching until it returns. Load the model on the endpoint or repoint agents.defaults.model.embeddingModel.",
      );
      scheduleEmbeddingRetry();
    }
    return;
  }

  // ── Carry over unchanged entries from the disk cache ─────────────────────
  const updatedCache: Record<string, PersistedEmbeddingEntry> = {};
  for (const [name, { hash }] of currentDocs) {
    const cached = cachedAgents[name];
    if (cached && cached.hash === hash) {
      updatedCache[name] = cached;
    }
  }

  // ── Embed changed agents one at a time and save incremental progress ──────
  // Sending all texts in a single HTTP call causes LM Studio to queue hundreds
  // of embedding computations at once. When the request eventually times out,
  // the retry sends another full batch while LM Studio is still working on the
  // first — queue grows unboundedly. Processing one-at-a-time ensures LM
  // Studio's queue never exceeds 1 entry from this code path, and partial
  // progress is saved after every agent so retries only redo what's missing.
  let failed = false;
  for (const { name, doc } of toEmbed) {
    try {
      const [vec] = await provider.embed([doc], embeddingModel);
      if (vec) {
        updatedCache[name] = { hash: currentDocs.get(name)!.hash, vector: float32ToBase64(vec) };
        // Persist incremental progress so a retry starts from where we left off
        saveEmbeddingCache(embeddingModel, updatedCache);
      }
    } catch (err) {
      recordEmbeddingFailure(err, name);
      log.warn({ err, agent: name, model: embeddingModel }, "Failed to embed agent — will retry remaining agents");
      failed = true;
      break;
    }
  }

  // Build in-memory index from whatever we have so far (partial is better than nothing)
  _index = entries.flatMap(([name, cfg]) => {
    const entry = updatedCache[name];
    if (!entry) return [];
    try {
      return [{ agentName: name, description: cfg.description, vector: base64ToFloat32(entry.vector) }];
    } catch (err) {
      log.warn({ err, agent: name }, "skipping corrupt cached embedding entry");
      return [];
    }
  });

  const embeddedCount = Object.keys(updatedCache).length - unchanged;

  if (failed) {
    // Keep whatever is indexed so far available; schedule retry for the rest
    _available = _index.length > 0;
    log.warn(
      { model: embeddingModel, indexed: _index.length, embedded: embeddedCount, cached: unchanged, remaining: toEmbed.length - embeddedCount },
      "Embedding index partially built — scheduling retry for remaining agents"
    );
    scheduleEmbeddingRetry();
  } else {
    _available = true;
    _retryDelayMs = 0;
    clearEmbeddingFailure();
    clearEmbeddingRetryTimer();
    log.info(
      { model: embeddingModel, agentCount: _index.length, embedded: embeddedCount, cached: unchanged },
      "Agent embedding index built"
    );
  }
}

export async function buildAgentIndex(
  subAgents: Record<string, SubAgentConfig>,
  provider: LMStudioProvider,
  embeddingModel: string
): Promise<void> {
  if (_buildInProgress) {
    // Coalesce: remember the latest request; it will be picked up after the
    // current build finishes. Overwriting a previous pending entry is correct
    // — the most recent config is always what matters.
    _pendingBuild = { subAgents: { ...subAgents }, provider, embeddingModel };
    return;
  }
  _buildInProgress = true;
  try {
    await _buildAgentIndexInner(subAgents, provider, embeddingModel);
  } finally {
    _buildInProgress = false;
    const pending = _pendingBuild;
    if (pending) {
      _pendingBuild = null;
      buildAgentIndex(pending.subAgents, pending.provider, pending.embeddingModel).catch(() => undefined);
    }
  }
}

export async function searchByEmbedding(
  query: string,
  provider: LMStudioProvider,
  topN = 5
): Promise<EmbeddingSearchResult[]> {
  if (!_available || _index.length === 0) return [];

  const cacheKey = buildEmbeddingQueryCacheKey(query, topN);
  const cached = readCachedEmbeddingQuery(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const queryVector = await getOrComputeQueryEmbedding(query, provider, _embeddingModel);
    if (!queryVector) return [];
    const results = _index
      .map(entry => ({ agentName: entry.agentName, description: entry.description, score: cosineSimilarity(queryVector, entry.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topN);
    storeCachedEmbeddingQuery(cacheKey, results);
    return results;
  } catch (err) {
    recordEmbeddingFailure(err);
    log.warn({ err }, "Embedding search failed — falling back to keyword");
    scheduleEmbeddingRetry();
    return [];
  }
}

/**
 * Symmetric counterpart to `searchToolsByEmbedding` in the tool registry.
 * One scored helper that callers (search_agents tool, dashboard surfaces,
 * capability-gap matchers) can share instead of re-implementing cosine
 * walks against the agent index.
 *
 * Auto-resolves the embedding provider via the most-recent `buildAgentIndex`
 * call so callers don't have to thread it. Falls back to keyword token
 * overlap on description + capabilities + tags when embeddings are
 * unavailable, so unit tests + offline operators still get useful output.
 *
 * Note: this returns the *raw* embedding-similarity ranking. The
 * `search_agents` tool layers richer routing heuristics
 * (looksFresh / looksWebTask / preferred-name bumps) on top via
 * `resolveAgentRouting` — that path stays the user-facing one. This helper
 * is for surfaces that want the bare scored list.
 */
export async function searchAgentsByEmbedding(
  query: string,
  topN = 8,
  opts?: { excludeAgents?: Iterable<string> },
): Promise<{ agentName: string; description: string; score: number; mode: "embedding" | "keyword" | "empty" }[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const exclude = opts?.excludeAgents ? new Set(opts.excludeAgents) : null;

  if (_available && _index.length > 0 && _lastProvider && _embeddingModel) {
    try {
      const queryVector = await getOrComputeQueryEmbedding(trimmed, _lastProvider, _embeddingModel);
      if (queryVector) {
        const ranked = _index
          .filter((entry) => !exclude || !exclude.has(entry.agentName))
          .map((entry) => ({
            agentName: entry.agentName,
            description: entry.description,
            score: cosineSimilarity(queryVector, entry.vector),
            mode: "embedding" as const,
          }))
          .sort((a, b) => b.score - a.score)
          .slice(0, topN);
        if (ranked.length > 0) return ranked;
      }
    } catch (err) {
      recordEmbeddingFailure(err);
      log.warn({ err }, "Agent embedding search failed — falling back to keyword");
      scheduleEmbeddingRetry();
    }
  }

  // Keyword fallback — token overlap on description + capabilities + tags.
  const subAgents = _lastSubAgents ?? {};
  const entries = Object.entries(subAgents).filter(
    ([name]) => !exclude || !exclude.has(name),
  );
  if (entries.length === 0) return [];

  const q = trimmed.toLowerCase();
  const queryTokens = q.split(/\s+/).filter((t) => t.length > 2);

  const ranked = entries
    .map(([name, cfg]) => {
      const text = [
        name,
        cfg.description ?? "",
        ...(cfg.capabilities ?? []),
        ...(cfg.tags ?? []),
        cfg.domain ?? "",
        cfg.role ?? "",
      ]
        .join(" ")
        .toLowerCase();
      let score = 0;
      if (text.includes(q)) score = 1;
      else if (queryTokens.length > 0) {
        const hits = queryTokens.filter((token) => text.includes(token)).length;
        score = hits / queryTokens.length;
      }
      return {
        agentName: name,
        description: cfg.description ?? "",
        score,
        mode: "keyword" as const,
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);

  return ranked;
}

export function rebuildAgentIndex(
  subAgents: Record<string, SubAgentConfig>,
  provider: LMStudioProvider
): void {
  if (!_embeddingModel) return;
  clearEmbeddingQueryCache();
  buildAgentIndex(subAgents, provider, _embeddingModel).catch(() => undefined);
}

export function isEmbeddingAvailable(): boolean {
  return _available;
}

export function getEmbeddingSearchStatus(): EmbeddingSearchStatus {
  return {
    configured: Boolean(_embeddingModel),
    available: _available,
    model: _embeddingModel || null,
    indexedAgentCount: _index.length,
    totalAgentCount: Object.keys(_lastSubAgents).length,
    retryScheduled: Boolean(_retryTimer),
    retryDelayMs: _retryDelayMs,
    lastError: _lastEmbeddingError,
    lastFailedAgent: _lastEmbeddingFailedAgent,
    lastFailureAt: _lastEmbeddingFailureAt,
  };
}

/**
 * G33: Compute an embedding for an arbitrary query string using the currently
 * configured embedding provider.  Returns `null` if unavailable.
 */
export async function computeQueryEmbedding(text: string): Promise<Float32Array | null> {
  if (!_available || !_lastProvider || !_embeddingModel) return null;
  return getOrComputeQueryEmbedding(text, _lastProvider, _embeddingModel);
}

/**
 * Batched, cache-aware embedding for a set of texts (e.g. retrieval candidates
 * that have no stored vector, such as session shared-facts or agent lessons).
 * Cached vectors are returned from the same query-vector cache; every uncached
 * text is embedded in a SINGLE provider.embed() call, so semantic retrieval for
 * those scopes costs one batched request, not one call per record. Returns a
 * parallel array (null where unavailable/failed). Empty/blank texts map to null.
 */
export async function computeTextEmbeddings(texts: string[]): Promise<Array<Float32Array | null>> {
  const results: Array<Float32Array | null> = new Array(texts.length).fill(null);
  if (!_available || !_lastProvider || !_embeddingModel || texts.length === 0) return results;
  const model = _embeddingModel;

  const toEmbed: Array<{ idx: number; text: string; cacheKey: string }> = [];
  for (let i = 0; i < texts.length; i++) {
    const normalized = normalizeSearchText(texts[i] ?? "");
    if (!normalized) continue;
    const cacheKey = `${model}::${normalized}`;
    const cached = _queryVectorCache.get(cacheKey);
    if (cached && Date.now() - cached.storedAt <= QUERY_VECTOR_CACHE_TTL_MS) {
      results[i] = cached.vector;
      continue;
    }
    if (cached) _queryVectorCache.delete(cacheKey);
    toEmbed.push({ idx: i, text: texts[i] ?? "", cacheKey });
  }

  if (toEmbed.length > 0) {
    try {
      const vectors = await _lastProvider.embed(toEmbed.map((t) => t.text), model);
      for (let k = 0; k < toEmbed.length; k++) {
        const vec = vectors[k];
        if (isDegenerateVector(vec)) continue; // never cache/return a zero vector
        const { idx, cacheKey } = toEmbed[k]!;
        results[idx] = vec!;
        _queryVectorCache.set(cacheKey, { storedAt: Date.now(), vector: vec! });
      }
      while (_queryVectorCache.size > QUERY_VECTOR_CACHE_MAX_ENTRIES) {
        const oldestKey = _queryVectorCache.keys().next().value;
        if (!oldestKey) break;
        _queryVectorCache.delete(oldestKey);
      }
    } catch (err) {
      recordEmbeddingFailure(err);
    }
  }
  return results;
}

async function getOrComputeQueryEmbedding(
  text: string,
  provider: LMStudioProvider,
  model: string,
): Promise<Float32Array | null> {
  const normalized = normalizeSearchText(text);
  if (!normalized) {
    try {
      const [vec] = await provider.embed([text], model);
      return isDegenerateVector(vec) ? null : vec!;
    } catch (err) {
      recordEmbeddingFailure(err);
      return null;
    }
  }
  const cacheKey = `${model}::${normalized}`;
  const cached = _queryVectorCache.get(cacheKey);
  if (cached && Date.now() - cached.storedAt <= QUERY_VECTOR_CACHE_TTL_MS) {
    return cached.vector;
  }
  if (cached) _queryVectorCache.delete(cacheKey);
  const inflight = _queryVectorInflight.get(cacheKey);
  if (inflight) return inflight;
  const promise = (async () => {
    try {
      const [vec] = await provider.embed([text], model);
      if (isDegenerateVector(vec)) return null; // miss, not a poisoned cache entry
      _queryVectorCache.set(cacheKey, { storedAt: Date.now(), vector: vec! });
      if (_queryVectorCache.size > QUERY_VECTOR_CACHE_MAX_ENTRIES) {
        const oldestKey = _queryVectorCache.keys().next().value;
        if (oldestKey) _queryVectorCache.delete(oldestKey);
      }
      return vec!;
    } catch (err) {
      recordEmbeddingFailure(err);
      return null;
    } finally {
      _queryVectorInflight.delete(cacheKey);
    }
  })();
  _queryVectorInflight.set(cacheKey, promise);
  return promise;
}

export function resetEmbeddingSearchStateForTests(): void {
  _index = [];
  _available = false;
  _embeddingModel = "";
  _lastProvider = null;
  _lastSubAgents = {};
  clearEmbeddingFailure();
  _retryDelayMs = 0;
  _buildInProgress = false;
  _pendingBuild = null;
  clearEmbeddingRetryTimer();
  clearEmbeddingQueryCache();
}

function clearEmbeddingRetryTimer(): void {
  if (_retryTimer) {
    clearTimeout(_retryTimer);
    _retryTimer = null;
  }
}

function scheduleEmbeddingRetry(): void {
  if (_retryTimer || !_lastProvider || !_embeddingModel || Object.keys(_lastSubAgents).length === 0) {
    return;
  }

  const delay = _retryDelayMs > 0 ? _retryDelayMs : EMBEDDING_RETRY_INITIAL_DELAY_MS;
  _retryDelayMs = Math.min(EMBEDDING_RETRY_MAX_DELAY_MS, delay * 2);
  _retryTimer = setTimeout(() => {
    _retryTimer = null;
    buildAgentIndex(_lastSubAgents, _lastProvider!, _embeddingModel).catch(() => undefined);
  }, delay);
  _retryTimer.unref?.();
  log.info({ model: _embeddingModel, retryInMs: delay }, "Scheduled embedding index rebuild retry");
}

function buildEmbeddingQueryCacheKey(query: string, topN: number): string {
  return `${_embeddingModel}::${topN}::${normalizeSearchText(query)}`;
}

function readCachedEmbeddingQuery(cacheKey: string): EmbeddingSearchResult[] | null {
  const cached = _queryCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.storedAt > QUERY_CACHE_TTL_MS) {
    _queryCache.delete(cacheKey);
    return null;
  }
  return cached.results.map((result) => ({ ...result }));
}

function storeCachedEmbeddingQuery(cacheKey: string, results: EmbeddingSearchResult[]): void {
  _queryCache.set(cacheKey, {
    storedAt: Date.now(),
    results: results.map((result) => ({ ...result })),
  });

  if (_queryCache.size <= QUERY_CACHE_MAX_ENTRIES) return;
  const oldestKey = _queryCache.keys().next().value;
  if (oldestKey) {
    _queryCache.delete(oldestKey);
  }
}

function clearEmbeddingQueryCache(): void {
  _queryCache.clear();
  _queryVectorCache.clear();
  _queryVectorInflight.clear();
}
