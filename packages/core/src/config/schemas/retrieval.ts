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
  /** Drop retrieved chunks whose engram rerank score is below this (0 = keep all). */
  minRerankScore: z.number().min(0).max(1).default(0),
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
  /** Settings toggle: also search the current user's personal document corpus (`user:<id>`). */
  includeUserDocs: z.boolean().default(false),
  /** Settings toggle: also search the workspace-shared document corpus (`workspace:<name>`). */
  includeWorkspaceDocs: z.boolean().default(false),
  /** Token used for the workspace-shared scope. */
  workspaceName: z.string().min(1).default("workspace"),
});
export type DocumentRagConfig = z.infer<typeof DocumentRagSchema>;

export const RetrievalSchema = z.object({
  reranker: RetrievalRerankerSchema.default({}),
  search: RetrievalSearchSchema.default({}),
  documentRag: DocumentRagSchema.default({}),
});

export type RetrievalSearchConfig = z.infer<typeof RetrievalSearchSchema>;
