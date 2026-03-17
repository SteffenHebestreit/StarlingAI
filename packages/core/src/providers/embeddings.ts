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

const TOOL_KEYWORD_RULES: Array<{ pattern: RegExp; keywords: string[] }> = [
  { pattern: /web_search|web_fetch|searxng/, keywords: ["research", "web", "search", "facts", "documentation", "sources"] },
  { pattern: /playwright|browser_/, keywords: ["browser", "automation", "login", "forms", "screenshots", "navigation", "scraping"] },
  { pattern: /code_sandbox|run_js|run_ts/, keywords: ["coding", "scripts", "execution", "analysis", "transform"] },
  { pattern: /shell_exec|run_script/, keywords: ["shell", "terminal", "devops", "ops", "commands"] },
  { pattern: /read_file|list_files|filesystem/, keywords: ["files", "workspace", "code", "analysis"] },
  { pattern: /write_file/, keywords: ["write", "draft", "report", "output"] },
  { pattern: /get_site_credentials/, keywords: ["credentials", "auth", "login", "secrets"] },
  { pattern: /delegate_to_agent/, keywords: ["orchestration", "workflow", "delegation"] },
];

const RESEARCH_INTENT_TOKENS = new Set([
  "research", "spec", "specs", "specification", "specifications", "documentation", "docs",
  "official", "principles", "design", "protocol", "api", "mcp", "a2a", "reference",
  "references", "architecture", "concepts",
]);

const WRITING_INTENT_TOKENS = new Set([
  "draft", "email", "reply", "message", "proposal", "proposals", "pitch", "cover",
  "letter", "outreach", "subject", "application",
]);

function hasPhrase(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function hasToken(tokens: string[], dictionary: Set<string>): boolean {
  return tokens.some((token) => dictionary.has(token));
}

function isWritingSpecialist(cfg: SubAgentConfig, keywords: string[]): boolean {
  const combined = `${cfg.description} ${(cfg.capabilities ?? []).join(" ")} ${(cfg.tags ?? []).join(" ")}`.toLowerCase();
  return keywords.some((keyword) =>
    keyword.includes("email")
    || keyword.includes("proposal")
    || keyword.includes("communication")
    || keyword.includes("outreach")
    || keyword.includes("draft")
    || keyword.includes("message")
    || keyword.includes("cover")
  ) || /(email|proposal|communication|outreach|draft|cover letter|business communicator)/.test(combined);
}

function isResearchSpecialist(cfg: SubAgentConfig, keywords: string[]): boolean {
  return (cfg.tools ?? []).some((tool) => tool === "web_search" || tool === "web_fetch" || tool === "workspace_search")
    || keywords.some((keyword) =>
      keyword.includes("research")
      || keyword.includes("retrieval")
      || keyword.includes("documentation")
      || keyword.includes("docs")
      || keyword.includes("search")
      || keyword.includes("sources")
      || keyword.includes("workspace")
    );
}

export function computeAgentIntentAdjustment(query: string, cfg: SubAgentConfig, keywords: string[]): number {
  const normalizedQuery = normalizeSearchText(query);
  const queryTokens = tokenizeSearchText(query);

  const researchIntent = hasToken(queryTokens, RESEARCH_INTENT_TOKENS)
    || hasPhrase(normalizedQuery, [
      /official specification/,
      /design principles/,
      /technical documentation/,
      /protocol reference/,
      /api reference/,
    ]);

  const writingIntent = hasToken(queryTokens, WRITING_INTENT_TOKENS)
    || hasPhrase(normalizedQuery, [
      /cover letter/,
      /cold outreach/,
      /draft email/,
      /write (a )?proposal/,
      /write (a )?message/,
    ]);

  const writingSpecialist = isWritingSpecialist(cfg, keywords);
  const researchSpecialist = isResearchSpecialist(cfg, keywords);

  let adjustment = 0;

  if (researchIntent && !writingIntent) {
    if (researchSpecialist) adjustment += 0.12;
    if (writingSpecialist && !researchSpecialist) adjustment -= 0.25;
  }

  if (writingIntent) {
    if (writingSpecialist) adjustment += 0.1;
    if (researchSpecialist && !writingSpecialist) adjustment -= 0.04;
  }

  return adjustment;
}

let _index: EmbeddingEntry[] = [];
let _available = false;
let _embeddingModel = "";
let _queryCache = new Map<string, CachedEmbeddingQuery>();

const QUERY_CACHE_TTL_MS = 5 * 60_000;
const QUERY_CACHE_MAX_ENTRIES = 64;

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_:/.-]+/g, " ")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeSearchText(value: string): string[] {
  return [...new Set(normalizeSearchText(value).split(" ").filter(token => token.length >= 2))];
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

    for (const rule of TOOL_KEYWORD_RULES) {
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

export function scoreAgentKeywordMatch(
  query: string,
  agentName: string,
  cfg: SubAgentConfig
): { score: number; matchedTerms: string[] } {
  const normalizedQuery = normalizeSearchText(query);
  const queryTokens = tokenizeSearchText(query);

  if (!normalizedQuery || queryTokens.length === 0) {
    return { score: 0, matchedTerms: [] };
  }

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

    if (nameText.split(" ").includes(token) || nameText.includes(token)) tokenScore = Math.max(tokenScore, 0.95);
    if (descriptionText.includes(token)) tokenScore = Math.max(tokenScore, 0.75);
    if (keywordTokens.some(keyword => keyword === token || keyword.includes(token))) tokenScore = Math.max(tokenScore, 0.85);
    if (toolsText.includes(token)) tokenScore = Math.max(tokenScore, 0.65);
    if (promptText.includes(token)) tokenScore = Math.max(tokenScore, 0.4);

    if (tokenScore > 0) {
      score += tokenScore;
      matchedTerms.add(token);
    }
  }

  const coverageBonus = (matchedTerms.size / queryTokens.length) * 0.4;
  const normalizedScore = Math.min(1, ((score / queryTokens.length) + coverageBonus) / 1.4);
  const adjustedScore = Math.max(0, Math.min(1, normalizedScore + computeAgentIntentAdjustment(query, cfg, keywordTokens)));

  return { score: adjustedScore, matchedTerms: [...matchedTerms] };
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  return normA === 0 || normB === 0 ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function buildAgentIndex(
  subAgents: Record<string, SubAgentConfig>,
  provider: LMStudioProvider,
  embeddingModel: string
): Promise<void> {
  _embeddingModel = embeddingModel;
  clearEmbeddingQueryCache();
  const entries = Object.entries(subAgents);
  if (entries.length === 0) {
    _index = [];
    _available = false;
    return;
  }

  const texts = entries.map(([name, cfg]) => buildAgentSearchDocument(name, cfg));

  try {
    const vectors = await provider.embed(texts, embeddingModel);
    _index = entries.map(([name, cfg], i) => ({
      agentName: name,
      description: cfg.description,
      vector: vectors[i]!,
    }));
    _available = true;
    log.info({ model: embeddingModel, agentCount: _index.length }, "Agent embedding index built");
  } catch (err) {
    _available = false;
    log.warn({ err, model: embeddingModel }, "Failed to build embedding index — semantic search disabled, using keyword fallback");
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
    const [queryVector] = await provider.embed([query], _embeddingModel);
    if (!queryVector) return [];
    const results = _index
      .map(entry => ({ agentName: entry.agentName, description: entry.description, score: cosineSimilarity(queryVector, entry.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topN);
    storeCachedEmbeddingQuery(cacheKey, results);
    return results;
  } catch (err) {
    log.warn({ err }, "Embedding search failed — falling back to keyword");
    return [];
  }
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

export function resetEmbeddingSearchStateForTests(): void {
  _index = [];
  _available = false;
  _embeddingModel = "";
  clearEmbeddingQueryCache();
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
}
