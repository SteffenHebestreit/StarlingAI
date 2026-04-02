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
  { pattern: /get_site_credentials/, keywords: ["credentials", "auth", "login", "selectors", "stored"] },
  { pattern: /site_fill_credentials/, keywords: ["credentials", "auth", "login", "forms", "password", "username", "secure fill"] },
  { pattern: /computer_type_credential/, keywords: ["credentials", "auth", "login", "desktop", "rdp", "remote desktop", "password", "username"] },
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

const MAIL_INTENT_TOKENS = new Set([
  "mail", "email", "emails", "inbox", "mailbox", "mailboxes", "posteingang", "postfach",
  "unread", "ungelesen", "draft", "drafts", "entwurf", "entwurfe", "reply", "replies",
]);

const GIT_VCS_TOKENS = new Set([
  "git", "commit", "branch", "merge", "rebase", "stash", "diff",
  "checkout", "pull", "push", "clone",
]);

const CODE_ANALYSIS_TOKENS = new Set([
  "explain", "review", "analyze", "analyse", "structure",
  "vulnerabilities", "security", "audit", "inspect",
]);

const CODE_CONTEXT_TOKENS = new Set([
  "code", "source", "file", "function", "class", "module",
  "codebase", "implementation",
]);

const WORKFLOW_AUTOMATION_TOKENS = new Set([
  "automation", "pipeline", "workflow", "n8n", "integrate", "integration",
  "orchestrate", "orchestration",
]);

const TTS_PHRASES: RegExp[] = [
  /\bread\s+(out|aloud)\b/,
  /\btext\s+to\s+speech\b/,
  /\bsynthesize\s+speech\b/,
  /\bnarrate\b/,
  /\bspeak\s+(this|the|it)\b/,
  /\bvoice\s+over\b/,
  /\baudio\s+narrat/,
];

const STT_PHRASES: RegExp[] = [
  /\btranscrib/,
  /\bspeech\s+to\s+text\b/,
  /\bvoice\s+memo\b/,
  /\b(audio|voice|recording)\s+to\s+text\b/,
  /\bmeeting\s+(notes|transcript|recording)/,
];

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

function isMailSpecialist(cfg: SubAgentConfig, keywords: string[]): boolean {
  const combined = `${cfg.description} ${(cfg.capabilities ?? []).join(" ")} ${(cfg.tags ?? []).join(" ")}`.toLowerCase();
  return (cfg.tools ?? []).some((tool) => tool.startsWith("mail_"))
    || keywords.some((keyword) =>
      keyword.includes("mail")
      || keyword.includes("email")
      || keyword.includes("inbox")
      || keyword.includes("mailbox")
      || keyword.includes("posteingang")
    )
    || /(mail|email|inbox|mailbox|posteingang)/.test(combined);
}

function isTtsSpecialist(cfg: SubAgentConfig): boolean {
  const tools = cfg.tools ?? [];
  const caps = (cfg.capabilities ?? []).join(" ").toLowerCase();
  return tools.some(t => t === "synthesize_speech" || t === "list_tts_voices")
    || caps.includes("text to speech") || caps.includes("voice synthesis") || caps.includes("audio narration");
}

function isSttSpecialist(cfg: SubAgentConfig): boolean {
  const tools = cfg.tools ?? [];
  const caps = (cfg.capabilities ?? []).join(" ").toLowerCase();
  return tools.some(t => t === "transcribe_audio")
    || caps.includes("audio transcription") || caps.includes("speech to text");
}

function isCodeAnalysisSpecialist(cfg: SubAgentConfig): boolean {
  const caps = (cfg.capabilities ?? []).join(" ").toLowerCase();
  return caps.includes("code review") || caps.includes("code analysis")
    || caps.includes("code explanation") || caps.includes("architecture review");
}

function isCodeWriterSpecialist(cfg: SubAgentConfig): boolean {
  const caps = (cfg.capabilities ?? []).join(" ").toLowerCase();
  return caps.includes("code writing") || caps.includes("code generation") || caps.includes("programming");
}

function isPromptSpecialist(cfg: SubAgentConfig): boolean {
  const caps = (cfg.capabilities ?? []).join(" ").toLowerCase();
  return caps.includes("prompt analysis") || caps.includes("prompt rewriting") || caps.includes("convergence tuning");
}

function isWorkflowSpecialist(cfg: SubAgentConfig): boolean {
  const caps = (cfg.capabilities ?? []).join(" ").toLowerCase();
  const tags = (cfg.tags ?? []).join(" ").toLowerCase();
  return caps.includes("automation") || caps.includes("workflow") || caps.includes("integration architecture")
    || tags.includes("workflow") || tags.includes("automation") || tags.includes("n8n");
}

function isChannelOpsSpecialist(cfg: SubAgentConfig): boolean {
  const caps = (cfg.capabilities ?? []).join(" ").toLowerCase();
  const tags = (cfg.tags ?? []).join(" ").toLowerCase();
  return caps.includes("channel troubleshooting") || caps.includes("delivery diagnosis")
    || tags.includes("channels");
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

  // Suppress writing intent from "message" when the query is about git (e.g. "commit message")
  const gitContext = hasToken(queryTokens, GIT_VCS_TOKENS);
  const writingIntentRaw = hasToken(queryTokens, WRITING_INTENT_TOKENS)
    || hasPhrase(normalizedQuery, [
      /cover letter/,
      /cold outreach/,
      /draft email/,
      /write (a )?proposal/,
      /write (a )?message/,
    ]);
  const writingIntent = writingIntentRaw
    && !(gitContext && queryTokens.filter(t => WRITING_INTENT_TOKENS.has(t)).every(t => t === "message"));
  const mailIntent = hasToken(queryTokens, MAIL_INTENT_TOKENS)
    || hasPhrase(normalizedQuery, [
      /last\s+\d+\s+emails?/,
      /recent\s+emails?/,
      /letzten?\s+\d+\s+emails?/,
      /zeige.*emails?/,
    ]);

  // Audio direction intent
  const ttsIntent = hasPhrase(normalizedQuery, TTS_PHRASES);
  const sttIntent = hasPhrase(normalizedQuery, STT_PHRASES);

  // Code analysis intent (requires both an analysis verb AND code-related context)
  const codeAnalysisIntent = hasToken(queryTokens, CODE_ANALYSIS_TOKENS)
    && hasToken(queryTokens, CODE_CONTEXT_TOKENS);

  // Workflow / automation intent
  const workflowIntent = hasToken(queryTokens, WORKFLOW_AUTOMATION_TOKENS);

  const writingSpecialist = isWritingSpecialist(cfg, keywords);
  const researchSpecialist = isResearchSpecialist(cfg, keywords);
  const mailSpecialist = isMailSpecialist(cfg, keywords);

  let adjustment = 0;

  // ── Research vs writing ──
  if (researchIntent && !writingIntent) {
    if (researchSpecialist) adjustment += 0.12;
    if (writingSpecialist && !researchSpecialist) adjustment -= 0.25;
  }

  if (writingIntent) {
    if (writingSpecialist) adjustment += 0.1;
    if (researchSpecialist && !writingSpecialist) adjustment -= 0.04;
  }

  // ── Mailbox triage / reading / drafting ──
  if (mailIntent) {
    if (mailSpecialist) adjustment += 0.38;
    if (researchSpecialist && !mailSpecialist) adjustment -= 0.12;
  }

  // ── TTS vs STT ──
  if (ttsIntent && !sttIntent) {
    if (isTtsSpecialist(cfg)) adjustment += 0.12;
    if (isSttSpecialist(cfg) && !isTtsSpecialist(cfg)) adjustment -= 0.15;
  }
  if (sttIntent && !ttsIntent) {
    if (isSttSpecialist(cfg)) adjustment += 0.12;
    if (isTtsSpecialist(cfg) && !isSttSpecialist(cfg)) adjustment -= 0.15;
  }

  // ── Code analysis vs code writing / prompt optimization ──
  if (codeAnalysisIntent) {
    if (isCodeAnalysisSpecialist(cfg)) adjustment += 0.12;
    if (isCodeWriterSpecialist(cfg) && !isCodeAnalysisSpecialist(cfg)) adjustment -= 0.08;
    if (isPromptSpecialist(cfg)) adjustment -= 0.12;
  }

  // ── Workflow automation vs channel ops ──
  if (workflowIntent) {
    if (isWorkflowSpecialist(cfg)) adjustment += 0.1;
    if (isChannelOpsSpecialist(cfg) && !isWorkflowSpecialist(cfg)) adjustment -= 0.08;
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
