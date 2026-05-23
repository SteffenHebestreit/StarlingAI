/**
 * RAG document tools — retrieval-augmented prompting over large inputs.
 *
 * Lets the assistant keep a large first message, pasted document, or set of
 * attachments OUT of the live context window: ingest the bulk text once
 * (chunked + embedded into the unified pgvector store), then pull back only the
 * few most relevant chunks on demand instead of carrying everything inline.
 *
 *   rag_ingest  — chunk + embed text into the RAG store (session-scoped by default)
 *   rag_search  — semantic retrieval of the most relevant chunks for a query
 *   rag_forget  — drop this session's ingested chunks
 *
 * Backed by db/vector-store.ts (pgvector). Degrades gracefully: when pgvector
 * is unavailable the tools report it instead of failing the turn.
 */
import { createHash } from "node:crypto";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import {
  vectorSearch,
  vectorUpsertMany,
  vectorDeleteCollection,
  isVectorStoreReady,
  type VectorUpsert,
} from "../db/vector-store.js";
import { isEmbeddingAvailable } from "../providers/embeddings.js";
import { getEmbeddingProvider } from "../providers/index.js";
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";

const log = childLogger("tool:rag");

const RAG_COLLECTION = "rag_documents";
const DEFAULT_CHUNK_CHARS = 1200;
const DEFAULT_OVERLAP_CHARS = 200;
const MAX_INGEST_CHARS = 500_000; // ~500 KB of text per ingest call

// ── Chunking ────────────────────────────────────────────────────────────────

/**
 * Split text into overlapping chunks, preferring to break on paragraph /
 * sentence boundaries near the target size so chunks stay coherent.
 */
export function chunkText(
  text: string,
  chunkChars = DEFAULT_CHUNK_CHARS,
  overlapChars = DEFAULT_OVERLAP_CHARS,
): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  if (clean.length <= chunkChars) return [clean];

  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(clean.length, start + chunkChars);
    if (end < clean.length) {
      const slice = clean.slice(start, end);
      const boundary = Math.max(
        slice.lastIndexOf("\n\n"),
        slice.lastIndexOf("\n"),
        slice.lastIndexOf(". "),
      );
      if (boundary > chunkChars * 0.5) end = start + boundary + 1;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    start = Math.max(end - overlapChars, start + 1);
  }
  return chunks;
}

async function embedChunks(chunks: string[]): Promise<Float32Array[] | null> {
  if (!isEmbeddingAvailable()) return null;
  const config = getConfig();
  const model = config.agents.defaults.model.embeddingModel ?? config.agents.defaults.model.primary;
  if (!model) return null;
  try {
    return await getEmbeddingProvider().embed(chunks, model);
  } catch (err) {
    log.warn({ err }, "RAG chunk embedding failed");
    return null;
  }
}

function scopeKey(scope: string, ctx: ToolContext): string {
  return scope === "global" ? "global" : `session:${ctx.sessionId}`;
}

// ── rag_ingest ────────────────────────────────────────────────────────────────

registerTool({
  name: "rag_ingest",
  description:
    "Store a large block of text (a long message, pasted document, or attachment) in the RAG vector store so it can be retrieved on demand instead of kept in context. " +
    "Chunks and embeds the text. Returns the number of chunks stored. Use rag_search later to pull back the relevant parts.",
  parameters: {
    type: "object",
    properties: {
      content: { type: "string", description: "The full text to ingest." },
      source: { type: "string", description: "A short label for this document (e.g. file name or 'user-prompt'). Used to group and cite chunks." },
      scope: { type: "string", enum: ["session", "global"], description: "session (default): retrievable only within this session. global: retrievable across sessions." },
    },
    required: ["content"],
  },
  async execute(args, ctx): Promise<ToolResult> {
    if (!isVectorStoreReady()) {
      return { success: false, output: "", error: "RAG store unavailable (pgvector not ready). The text was not ingested; keep working with it inline or retry later." };
    }
    const content = String(args["content"] ?? "");
    if (!content.trim()) return { success: false, output: "", error: "content is required" };
    if (content.length > MAX_INGEST_CHARS) {
      return { success: false, output: "", error: `content exceeds ${MAX_INGEST_CHARS} chars; split it across multiple rag_ingest calls` };
    }
    const source = String(args["source"] ?? "document").slice(0, 120);
    const scope = args["scope"] === "global" ? "global" : "session";
    const prefix = scopeKey(scope, ctx);

    const chunks = chunkText(content);
    if (chunks.length === 0) return { success: false, output: "", error: "no usable text after chunking" };

    const embeddings = await embedChunks(chunks);
    if (!embeddings || embeddings.length !== chunks.length) {
      return { success: false, output: "", error: "embedding model unavailable; could not ingest" };
    }

    const sourceHash = createHash("sha1").update(`${prefix}:${source}`).digest("hex").slice(0, 12);
    const entries: VectorUpsert[] = chunks.map((chunk, i) => ({
      collection: RAG_COLLECTION,
      id: `${prefix}:${sourceHash}:${i}`,
      content: chunk,
      embedding: embeddings[i],
      metadata: {
        scope,
        source,
        chunk: i,
        chunks: chunks.length,
        ...(scope === "session" ? { sessionId: ctx.sessionId } : {}),
      },
    }));

    const written = await vectorUpsertMany(entries);
    if (written === 0) return { success: false, output: "", error: "failed to write any chunks to the RAG store" };

    return {
      success: true,
      output: `Ingested "${source}" as ${written} chunk(s) into the ${scope} RAG store. Use rag_search to retrieve the relevant parts on demand.`,
      metadata: { source, scope, chunks: written },
    };
  },
});

// ── rag_search ────────────────────────────────────────────────────────────────

registerTool({
  name: "rag_search",
  description:
    "Semantic search over text previously stored with rag_ingest. Returns the most relevant chunks for the query so you can answer from the source without holding it all in context.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to look for." },
      k: { type: "number", description: "Number of chunks to return (default 6, max 20)." },
      source: { type: "string", description: "Optional: restrict to chunks from this source label." },
      scope: { type: "string", enum: ["session", "global"], description: "Which store to search (default session)." },
    },
    required: ["query"],
  },
  async execute(args, ctx): Promise<ToolResult> {
    if (!isVectorStoreReady()) {
      return { success: false, output: "", error: "RAG store unavailable (pgvector not ready)." };
    }
    const query = String(args["query"] ?? "");
    if (!query.trim()) return { success: false, output: "", error: "query is required" };
    const k = Math.max(1, Math.min(20, Number(args["k"]) || 6));
    const scope = args["scope"] === "global" ? "global" : "session";

    const filter: Record<string, unknown> = scope === "session" ? { sessionId: ctx.sessionId } : { scope: "global" };
    if (typeof args["source"] === "string" && args["source"]) filter["source"] = args["source"];

    const hits = await vectorSearch(RAG_COLLECTION, query, { k, filter, minScore: 0.25 });
    if (hits === null) return { success: false, output: "", error: "RAG search failed (store unavailable)." };
    if (hits.length === 0) {
      return { success: true, output: "No relevant chunks found in the RAG store for that query.", metadata: { hits: 0 } };
    }

    const blocks = hits.map((hit, i) => {
      const src = typeof hit.metadata["source"] === "string" ? hit.metadata["source"] : "document";
      const chunkNo = hit.metadata["chunk"];
      return `[${i + 1}] (${src}#${chunkNo}, score ${hit.score.toFixed(3)})\n${hit.content}`;
    });

    return {
      success: true,
      output: `Top ${hits.length} chunk(s):\n\n${blocks.join("\n\n---\n\n")}`,
      metadata: { hits: hits.length },
    };
  },
});

// ── rag_forget ──────────────────────────────────────────────────────────────

registerTool({
  name: "rag_forget",
  description: "Delete this session's ingested RAG documents from the vector store (cleanup).",
  parameters: { type: "object", properties: {}, required: [] },
  async execute(_args, ctx): Promise<ToolResult> {
    if (!isVectorStoreReady()) {
      return { success: false, output: "", error: "RAG store unavailable (pgvector not ready)." };
    }
    const removed = await vectorDeleteCollection(RAG_COLLECTION, `session:${ctx.sessionId}:`);
    return { success: true, output: `Removed ${removed} chunk(s) from this session's RAG store.`, metadata: { removed } };
  },
});
