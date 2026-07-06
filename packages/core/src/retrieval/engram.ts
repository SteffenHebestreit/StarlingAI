/**
 * engram client — graph-RAG over attached/uploaded documents.
 *
 * Thin HTTP wrapper over the engram service (https://github.com/SteffenHebestreit/engram).
 * engram chunks each document, extracts summary/keywords via an LLM, builds
 * multi-channel embeddings, and links chunks in a Neo4j graph; `/search` runs a
 * HyDE → multi-channel retrieval → fusion → graph-expansion → cross-encoder
 * rerank pipeline.
 *
 * IMPORTANT — scoping: engram `/search` is GLOBAL within an instance (no source
 * filter). We scope by ingesting each document under a `source` token
 * (`session:<id>` / `user:<id>` / `workspace:<name>`) and post-filtering search
 * results to the documents whose sources intersect the active scope (see
 * document-rag.ts). Documents are reference-counted by source, so the same file
 * ingested in two sessions shares chunks and is only removed when its last
 * source reference is dropped.
 *
 * Every call degrades gracefully: failures return null/false and are logged, so
 * RAG being down never fails a turn.
 */
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";

const log = childLogger("retrieval:engram");

export interface EngramIngestResult {
  documentId: string;
  chunkCount: number;
  keywords: string[];
}

export interface EngramSearchResult {
  chunkId: string;
  documentId: string;
  text: string;
  summary: string;
  keywords: string[];
  origin: string;
  graphDistance: number;
  graphProximity: number;
  retrievalScore: number;
  medianScore: number;
  fusedScore: number;
  rerankScore: number;
}

export interface EngramDocumentInfo {
  id: string;
  title?: string;
  sources: string[];
  createdAt?: string;
  chunkCount: number;
}

/** True when document RAG is enabled and an engram base URL is configured. */
export function engramConfigured(): boolean {
  const cfg = getConfig().retrieval.documentRag;
  return cfg.enabled && typeof cfg.engramBaseUrl === "string" && cfg.engramBaseUrl.trim().length > 0;
}

function engramHeaders(): Record<string, string> {
  const cfg = getConfig().retrieval.documentRag;
  return {
    "Content-Type": "application/json",
    ...(cfg.engramApiKey ? { Authorization: `Bearer ${cfg.engramApiKey}` } : {}),
  };
}

function engramUrl(path: string): string {
  const base = getConfig().retrieval.documentRag.engramBaseUrl.replace(/\/$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

async function engramFetch(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(engramUrl(path), { ...init, headers: { ...engramHeaders(), ...(init.headers ?? {}) }, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Liveness check (GET /health). */
export async function engramHealth(): Promise<boolean> {
  if (!engramConfigured()) return false;
  try {
    const res = await engramFetch("/health", { method: "GET" }, 5000);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Ingest a document (POST /documents). `source` is the scope token; re-ingesting
 * with the same `documentId` replaces the prior version. Returns null on failure.
 */
export async function engramIngest(input: {
  text: string;
  source: string;
  title?: string;
  documentId?: string;
}): Promise<EngramIngestResult | null> {
  if (!engramConfigured()) return null;
  const text = input.text.trim();
  if (!text || !input.source.trim()) return null;
  const cfg = getConfig().retrieval.documentRag;
  try {
    const res = await engramFetch(
      "/documents",
      {
        method: "POST",
        body: JSON.stringify({
          text,
          source: input.source,
          ...(input.title ? { title: input.title } : {}),
          ...(input.documentId ? { document_id: input.documentId } : {}),
        }),
      },
      cfg.ingestTimeoutMs,
    );
    if (!res.ok) {
      log.warn({ status: res.status, source: input.source }, "engram ingest failed");
      return null;
    }
    const body = await res.json() as { document_id?: string; chunk_count?: number; keywords?: string[] };
    if (!body.document_id) return null;
    invalidateEngramDocListCache(); // a new document changed scope membership
    return {
      documentId: body.document_id,
      chunkCount: typeof body.chunk_count === "number" ? body.chunk_count : 0,
      keywords: Array.isArray(body.keywords) ? body.keywords : [],
    };
  } catch (err) {
    log.warn({ err, source: input.source }, "engram ingest error");
    return null;
  }
}

/** Response-level retrieval-confidence signals (engram ≥ v0.6.0; null on older servers
 *  or when engram itself reports null — e.g. score_gap needs ≥ 3 results). */
export interface EngramSearchMeta {
  topRerankScore: number | null;
  scoreGap: number | null;
}

export interface EngramSearchOutcome {
  results: EngramSearchResult[];
  meta: EngramSearchMeta;
}

/**
 * Search (POST /search). Returns the pipeline-ranked results plus the
 * response-level confidence meta, or null on failure. `finalTopK` maps to
 * engram's per-request `final_top_k` tuning; pass a generous value when a
 * scope post-filter will trim the results afterwards.
 */
export async function engramSearchDetailed(input: {
  query: string;
  finalTopK?: number;
  tuning?: Record<string, unknown>;
  /** Server-side source scope-set filter (docs/engram-sources-filter-spec.md). Engram
   *  releases without the feature ignore the unknown field — safe to send speculatively. */
  sources?: string[];
}): Promise<EngramSearchOutcome | null> {
  if (!engramConfigured()) return null;
  const query = input.query.trim();
  if (!query) return null;
  const cfg = getConfig().retrieval.documentRag;
  const tuning: Record<string, unknown> = { ...(input.tuning ?? {}) };
  if (typeof input.finalTopK === "number") tuning["final_top_k"] = input.finalTopK;
  try {
    const res = await engramFetch(
      "/search",
      {
        method: "POST",
        body: JSON.stringify({
          query,
          ...(input.sources && input.sources.length > 0 ? { sources: input.sources } : {}),
          ...(Object.keys(tuning).length > 0 ? { tuning } : {}),
        }),
      },
      cfg.searchTimeoutMs,
    );
    if (!res.ok) {
      log.warn({ status: res.status }, "engram search failed");
      return null;
    }
    const body = await res.json() as {
      results?: Array<Record<string, unknown>>;
      top_rerank_score?: unknown;
      score_gap?: unknown;
    };
    const results = Array.isArray(body.results) ? body.results : [];
    const mapped = results.map((r): EngramSearchResult => ({
      chunkId: String(r["chunk_id"] ?? ""),
      documentId: String(r["document_id"] ?? ""),
      text: String(r["text"] ?? ""),
      summary: String(r["summary"] ?? ""),
      keywords: Array.isArray(r["keywords"]) ? (r["keywords"] as string[]) : [],
      origin: String(r["origin"] ?? ""),
      graphDistance: Number(r["graph_distance"] ?? 0),
      graphProximity: Number(r["graph_proximity"] ?? 0),
      retrievalScore: Number(r["retrieval_score"] ?? 0),
      medianScore: Number(r["median_score"] ?? 0),
      fusedScore: Number(r["fused_score"] ?? 0),
      rerankScore: Number(r["rerank_score"] ?? 0),
    }));
    return {
      results: mapped,
      meta: {
        topRerankScore: typeof body.top_rerank_score === "number" ? body.top_rerank_score : null,
        scoreGap: typeof body.score_gap === "number" ? body.score_gap : null,
      },
    };
  } catch (err) {
    log.warn({ err }, "engram search error");
    return null;
  }
}

/** List all ingested documents with their source references (GET /documents). */
// retrieveDocumentContext fetches the full /documents list every RAG-augmented turn
// just to build the in-scope id set. Cache it for a SHORT TTL: long enough to drop
// the repeated serial round-trip within a turn/burst, short enough that cross-process
// ingest/forget (via federation) can't leave a stale scope-membership view for long.
// The TTL is the correctness floor; local mutations also bust it explicitly.
const ENGRAM_DOC_LIST_TTL_MS = 3_000;
let _docListCache: { storedAt: number; docs: EngramDocumentInfo[] } | null = null;

/** Drop the cached document list (call after a local ingest/forget). */
export function invalidateEngramDocListCache(): void { _docListCache = null; }

export async function engramListDocuments(): Promise<EngramDocumentInfo[] | null> {
  if (!engramConfigured()) return null;
  if (_docListCache && Date.now() - _docListCache.storedAt <= ENGRAM_DOC_LIST_TTL_MS) {
    return _docListCache.docs;
  }
  try {
    const res = await engramFetch("/documents", { method: "GET" }, 10000);
    if (!res.ok) return null;
    const body = await res.json() as Array<Record<string, unknown>>;
    if (!Array.isArray(body)) return null;
    const docs = body.map((d): EngramDocumentInfo => ({
      id: String(d["id"] ?? ""),
      title: typeof d["title"] === "string" ? d["title"] : undefined,
      sources: Array.isArray(d["sources"]) ? (d["sources"] as string[]) : [],
      createdAt: typeof d["created_at"] === "string" ? d["created_at"] : undefined,
      chunkCount: Number(d["chunk_count"] ?? 0),
    }));
    _docListCache = { storedAt: Date.now(), docs };
    return docs;
  } catch (err) {
    log.warn({ err }, "engram list documents error");
    return null;
  }
}

/**
 * Delete a document (DELETE /documents/{id}). With `source`, only drops that
 * source reference (the document survives if other sources still hold it);
 * without it, hard-removes the document and all chunks.
 */
export async function engramDeleteDocument(documentId: string, source?: string): Promise<boolean> {
  if (!engramConfigured() || !documentId) return false;
  const path = source ? `/documents/${encodeURIComponent(documentId)}?source=${encodeURIComponent(source)}` : `/documents/${encodeURIComponent(documentId)}`;
  try {
    const res = await engramFetch(path, { method: "DELETE" }, 15000);
    if (res.ok) invalidateEngramDocListCache(); // scope membership changed
    return res.ok;
  } catch (err) {
    log.warn({ err, documentId }, "engram delete error");
    return false;
  }
}
