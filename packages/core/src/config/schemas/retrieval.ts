import { z } from "zod";

export const RetrievalRerankerSchema = z.object({
  enabled: z.boolean().default(false),
  /**
   * How candidates are scored:
   *  - "tei": a real cross-encoder rerank endpoint (HuggingFace TEI / Infinity)
   *    via `POST {baseUrl}/rerank` with `{query, texts}` → `[{index, score}]`.
   *    This is the correct way to use bge-reranker-v2-m3 (LM Studio cannot serve
   *    a cross-encoder over REST — it only exposes it via /embeddings).
   *  - "llm": ask an OpenAI-compatible chat model to score candidates as JSON
   *    via `POST {baseUrl}/chat/completions`. Works with any loaded chat model
   *    but is slower and less precise than a dedicated cross-encoder.
   */
  mode: z.enum(["tei", "llm"]).default("tei"),
  /** Rerank service base URL. For "tei" the server root (NO /v1 suffix); for "llm" an OpenAI-compatible base (…/v1). */
  baseUrl: z.string().url().default("http://reranker:80"),
  apiKey: z.string().default("lm-studio"),
  model: z.string().min(1).default("BAAI/bge-reranker-v2-m3"),
  timeoutMs: z.number().int().min(1000).max(120000).default(15000),
  topK: z.number().int().min(2).max(12).default(6),
});

export const RetrievalSearchSchema = z.object({
  backend: z.enum(["auto", "searxng", "playwright", "duckduckgo"]).default("auto"),
  searxngBaseUrl: z.string().url().optional(),
  timeoutMs: z.number().int().min(1000).max(60000).default(15000),
});

/**
 * Document RAG over attached/uploaded files, backed by the engram graph-RAG
 * service (separate from the lightweight pgvector `rag_*` tools). Files are
 * extracted to Markdown via the file-conversion service (`multimodal.files`),
 * then ingested into engram; relevant chunks are retrieved on demand and can be
 * auto-injected as turn context. Scoping is done with engram's `source` token:
 * `session:<id>` (default), `user:<id>`, or `workspace:<name>`.
 */
export const DocumentRagSchema = z.object({
  enabled: z.boolean().default(false),
  /** engram API base URL (the graph-RAG service). */
  engramBaseUrl: z.string().url().default("http://engram:8088"),
  /** Optional bearer token for the engram API (engram itself is usually unauthenticated on the internal network). */
  engramApiKey: z.string().optional(),
  /** Ingest can be slow (chunk → LLM metadata → embeddings → graph), so allow a generous timeout. */
  ingestTimeoutMs: z.number().int().min(1000).max(600000).default(120000),
  searchTimeoutMs: z.number().int().min(1000).max(120000).default(20000),
  /** When a file is attached to a session, auto-extract + ingest it into the session-scoped corpus. */
  autoIngestAttachments: z.boolean().default(true),
  /** Before answering, retrieve relevant chunks for the user's message and inject them as additional context. */
  injectContext: z.boolean().default(true),
  /** How many chunks to inject / return after scope filtering. */
  retrievalTopK: z.number().int().min(1).max(20).default(6),
  /** engram final_top_k requested before the scope post-filter (kept generous so in-scope chunks survive). */
  candidateTopK: z.number().int().min(4).max(100).default(30),
  /** Drop retrieved chunks whose engram rerank score is below this. RANGE IS
   *  RERANKER-SPECIFIC (unclamped): for a sigmoid/[0,1] reranker 0 keeps all; the shipped
   *  Qwen3-Reranker emits raw LOGITS (relevant ≫ 0, irrelevant ≪ 0; measured live), so 0
   *  acts as a relevance cut (drops negatives) and a NEGATIVE floor (e.g. −8) keeps weak
   *  but non-garbage chunks — see docs/engram-reevaluation-2026-07.md "CRAG tuning", where
   *  this interacts with confidenceMinTopRerank. Default 0. */
  minRerankScore: z.number().default(0),
  /** Cap on the total characters of injected document context per turn. */
  maxContextChars: z.number().int().min(500).max(50000).default(6000),
  /** Reuse-the-whole-doc fix (audit ef9bd480): when a file attached THIS turn is small
   *  enough to fit a prompt, inline its FULL extracted text instead of a handful of
   *  semantic top-k excerpts. The default RAG path reduced an ~11KB / 3-page offer PDF to
   *  6 chunks (6000-char cap), dropped the page-2 budget rows, and the model then declared
   *  present line-items "missing". Inlining the whole small doc is what the user actually
   *  wants when they attach something and say "evaluate this". Default OFF until live eval
   *  confirms it; only the just-attached doc is inlined (large docs + prior-turn docs stay
   *  on the lean retrieval path). */
  inlineSmallDocuments: z.boolean().default(false),
  /** Max total extracted chars across THIS turn's freshly-attached docs to inline in full.
   *  Above this the lean semantic-retrieval path is used instead. */
  inlineThresholdChars: z.number().int().min(1000).max(50000).default(12000),
  /** CRAG-style confidence demotion (docs/engram-reevaluation-2026-07.md Phase 1). When ON
   *  and the engram /search response reports LOW retrieval confidence, the injected
   *  [DOCUMENT CONTEXT] block is framed as "possibly relevant — verify before relying on it"
   *  instead of authoritative. It NEVER suppresses the block or the retrieval-failure /
   *  attached-documents honesty notes; on older engram servers (no confidence fields) or
   *  when engram reports null, framing is unchanged. Default OFF pending eval. */
  confidenceDemotion: z.boolean().default(false),
  /** Demote when the response-level `score_gap` (normalized top-two margin, 0..1; null under
   *  3 results) is BELOW this. A small gap = the top hits are near-indistinguishable, a weak
   *  relevance signal. Only consulted when engram reports a non-null gap; 0 disables this
   *  check (the gap is never < 0). NOTE: engram computes the signal over its GLOBAL result
   *  set, pre scope-filter — see the caveat at the isLowRetrievalConfidence call site. */
  confidenceMinScoreGap: z.number().min(0).max(1).default(0.05),
  /** Demote when the response-level `top_rerank_score` is BELOW this. null = disabled
   *  (the default). The range is RERANKER-SPECIFIC and this is unclamped: the shipped
   *  Qwen3-Reranker emits raw LOGITS (clearly-relevant hits ≈ +2..+3, clearly-irrelevant
   *  ≈ −10), so a threshold near 0 demotes anything the reranker scores below its decision
   *  boundary; a sigmoid/normalized reranker would use a value in [0,1]. This is the signal
   *  that actually catches "confidently irrelevant" results (a low top score), whereas
   *  score_gap only catches near-ties — set it per your reranker. */
  confidenceMinTopRerank: z.number().nullable().default(null),
  /** Send the active scope sources as a server-side `sources` filter on engram /search
   *  (docs/engram-sources-filter-spec.md — requires an engram release that implements it;
   *  older servers ignore the unknown field, so this is a safe no-op against them). The
   *  client-side scope post-filter stays on regardless as defense-in-depth; the server
   *  filter adds 0-leak enforcement in the store + stops candidateTopK being wasted on
   *  off-scope hits. Default OFF pending the engram release + the combined eval. */
  serverSideScopeFilter: z.boolean().default(false),
  /** Settings toggle: also search the current user's personal document corpus (`user:<id>`). */
  includeUserDocs: z.boolean().default(false),
  /** Settings toggle: also search the workspace-shared document corpus (`workspace:<name>`). */
  includeWorkspaceDocs: z.boolean().default(false),
  /** Token used for the workspace-shared scope. */
  workspaceName: z.string().min(1).default("workspace"),
});
export type DocumentRagConfig = z.infer<typeof DocumentRagSchema>;

/**
 * Knowledge Bases — named, workspace-shared corpora built by recursively
 * crawling a documentation site (wiki, tutorial, standard) into the engram
 * document store under a per-KB `kb:<id>` source token. The crawler is
 * deterministic (no LLM in the loop): bounded BFS over in-scope links with
 * robots.txt respect, per-host politeness delay, and the same SSRF guard as
 * web_fetch. Requires documentRag (engram) — every KB operation no-ops
 * gracefully when that is disabled. This block holds the crawler's global
 * safety rails; per-KB bounds (maxPages/maxDepth/patterns) live on each KB
 * record and are clamped to the caps here.
 */
export const KnowledgeBasesSchema = z.object({
  /** Master switch for the KB surface (tools + routes). The hard dependency is
   *  retrieval.documentRag.enabled — with that off, KBs are inert regardless. */
  enabled: z.boolean().default(true),
  /** User-Agent for crawl requests (sites use it for rate/robots policy). */
  userAgent: z.string().min(1).default("StarlingAI-KBCrawler/1.0"),
  /** Default page budget for a KB when none is specified at creation. */
  defaultMaxPages: z.number().int().min(1).max(5000).default(150),
  /** Hard cap on any KB's page budget (create/update requests are clamped). */
  maxPagesCap: z.number().int().min(1).max(20000).default(1000),
  /** Default link depth from the seed URLs (0 = seeds only). */
  defaultMaxDepth: z.number().int().min(0).max(20).default(4),
  /** Hard cap on any KB's link depth. */
  maxDepthCap: z.number().int().min(0).max(20).default(8),
  /** Concurrent page fetches within one crawl (keep small — politeness). */
  concurrency: z.number().int().min(1).max(8).default(2),
  /** Minimum interval between two requests to the SAME host. */
  requestDelayMs: z.number().int().min(0).max(60000).default(300),
  /** Per-page fetch timeout. */
  pageTimeoutMs: z.number().int().min(1000).max(120000).default(15000),
  /** Pages larger than this are skipped (pre-checked via Content-Length when present). */
  maxPageBytes: z.number().int().min(10000).max(50_000_000).default(2_000_000),
  /** Wall-clock budget for one crawl run; the crawl stops gracefully (partial corpus is kept). */
  maxCrawlMs: z.number().int().min(10000).max(24 * 3600_000).default(1_800_000),
  /** How many KBs may crawl at the same time in this process. */
  maxConcurrentCrawls: z.number().int().min(1).max(8).default(2),
  /** Allow crawling private/internal hosts (RFC1918, *.internal …). OFF = the
   *  web_fetch SSRF guard applies per redirect hop. Turn on ONLY for instances
   *  that need to index an internal wiki and trust their operators. */
  allowPrivateHosts: z.boolean().default(false),
});
export type KnowledgeBasesConfig = z.infer<typeof KnowledgeBasesSchema>;

export const RetrievalSchema = z.object({
  reranker: RetrievalRerankerSchema.default({}),
  search: RetrievalSearchSchema.default({}),
  documentRag: DocumentRagSchema.default({}),
  knowledgeBases: KnowledgeBasesSchema.default({}),
});

export type RetrievalSearchConfig = z.infer<typeof RetrievalSearchSchema>;
