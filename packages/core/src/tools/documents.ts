/**
 * Document RAG tools — graph-RAG over attached/uploaded files via engram.
 *
 * These are distinct from the lightweight pgvector `rag_*` tools (which stash
 * large inline text out of context). Here, files attached to a conversation are
 * extracted to Markdown (file-MCP) and ingested into engram's knowledge graph;
 * `search_documents` retrieves the most relevant excerpts, scope-aware
 * (session by default; user/workspace when enabled in settings).
 *
 * The runtime also auto-ingests session attachments and auto-injects retrieved
 * context, so an agent usually does not need to call these — they are for
 * explicit control (ingest a workspace file, list, search a specific query,
 * forget a document).
 */
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { basename, extname, relative } from "node:path";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { resolvePathWithinWorkspace } from "./workspace-path.js";
import { isSensitiveWorkspacePath } from "./filesystem.js";
import { engramConfigured } from "../retrieval/engram.js";
import {
  ingestDocumentBytes,
  retrieveDocumentContext,
  listScopedDocuments,
  forgetDocument,
  type DocumentScope,
  type RagScopeContext,
} from "../retrieval/document-rag.js";

const SCOPE_VALUES: DocumentScope[] = ["session", "user", "workspace"];

function fail(error: string): ToolResult {
  return { success: false, output: "", error };
}

function scopeOf(args: Record<string, unknown>, fallback: DocumentScope = "session"): DocumentScope {
  const raw = String(args["scope"] ?? "").trim() as DocumentScope;
  return SCOPE_VALUES.includes(raw) ? raw : fallback;
}

function ragCtx(ctx: ToolContext): RagScopeContext {
  return { sessionId: ctx.sessionId, ...(ctx.userId ? { userId: ctx.userId } : {}) };
}

// Best-effort MIME from extension — the file-conversion service keys off the
// filename anyway; content type only steers the image-vision fallback.
const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".html": "text/html",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

function guessContentType(filename: string): string {
  return MIME[extname(filename).toLowerCase()] ?? "application/octet-stream";
}

// ── ingest_document ───────────────────────────────────────────────────────────

registerTool({
  name: "ingest_document",
  description:
    "Extract a workspace file (PDF, DOCX, PPTX, XLSX, images, etc.) to text and add it to the document library (engram graph-RAG) so it can be retrieved later with search_documents. Choose a scope: 'session' (this conversation, default), 'user' (your personal library), or 'workspace' (shared).",
  embeddingDescription:
    "ingest index add document file to RAG knowledge base library for retrieval; pdf docx attachment; Dokument indexieren hinzufügen",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative path to the file to ingest." },
      scope: { type: "string", enum: SCOPE_VALUES, description: "Where the document lives: session (default), user, or workspace." },
    },
    required: ["path"],
  },
  async execute(args, ctx): Promise<ToolResult> {
    if (!engramConfigured()) return fail("Document RAG is not enabled (retrieval.documentRag.enabled).");
    const path = String(args["path"] ?? "").trim();
    if (!path) return fail("path is required");

    let bytes: Buffer;
    try {
      const { resolved } = resolvePathWithinWorkspace(path, ctx.workspacePath);
      // Same secret-exfil guard read_file enforces: ingest_document must not pull
      // .env / .starlingai / .git / credential files into the searchable document
      // library (where search_documents would return their contents). Checked on the
      // lexical path and, when it exists, the realpath (symlink defense).
      let realRel: string | null = null;
      try { realRel = relative(ctx.workspacePath, realpathSync(resolved)); } catch { /* not-yet-existing handled by readFile below */ }
      if (isSensitiveWorkspacePath(relative(ctx.workspacePath, resolved)) || (realRel !== null && isSensitiveWorkspacePath(realRel))) {
        return fail(`Refusing to ingest a protected path: ${path}`);
      }
      bytes = await readFile(resolved);
    } catch (err) {
      return fail(`Failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }

    const filename = basename(path);
    const outcome = await ingestDocumentBytes({
      bytes: new Uint8Array(bytes),
      filename,
      contentType: guessContentType(filename),
      scope: scopeOf(args),
      ctx: ragCtx(ctx),
    });
    if (!outcome.ok) return fail(outcome.error);

    const r = outcome.result;
    return {
      success: true,
      output: `Ingested "${r.title}" into the ${r.scope} document library as ${r.chunkCount} chunk(s).` +
        (r.keywords.length ? ` Keywords: ${r.keywords.slice(0, 8).join(", ")}.` : "") +
        ` Use search_documents to retrieve relevant parts.`,
      metadata: { documentId: r.documentId, scope: r.scope, chunks: r.chunkCount },
    };
  },
});

// ── search_documents ──────────────────────────────────────────────────────────

registerTool({
  name: "search_documents",
  description:
    "Search the documents attached to this conversation (and, when enabled in settings, your personal or the workspace-shared library) using graph-RAG. Returns the most relevant excerpts with their source document, so you can answer from the source.",
  embeddingDescription:
    "search query documents attachments knowledge base RAG retrieve excerpts from uploaded files; Dokumente durchsuchen finden",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to look for in the attached documents." },
    },
    required: ["query"],
  },
  async execute(args, ctx): Promise<ToolResult> {
    if (!engramConfigured()) return fail("Document RAG is not enabled (retrieval.documentRag.enabled).");
    const query = String(args["query"] ?? "").trim();
    if (!query) return fail("query is required");

    const chunks = await retrieveDocumentContext(query, ragCtx(ctx));
    if (chunks.length === 0) {
      return { success: true, output: "No relevant excerpts found in the attached documents.", metadata: { hits: 0 } };
    }

    const blocks = chunks.map((c, i) => {
      const label = c.title?.trim() || c.documentId.slice(0, 8);
      return `[${i + 1}] (${label}, score ${c.score.toFixed(3)})\n${c.text.trim()}`;
    });
    return {
      success: true,
      output: `Top ${chunks.length} excerpt(s):\n\n${blocks.join("\n\n---\n\n")}`,
      metadata: { hits: chunks.length },
    };
  },
});

// ── list_documents ────────────────────────────────────────────────────────────

registerTool({
  name: "list_documents",
  description:
    "List the documents currently available to this conversation's document library (engram), with their scope and chunk counts.",
  embeddingDescription: "list show ingested documents attachments knowledge base library inventory",
  parameters: { type: "object", properties: {}, required: [] },
  async execute(_args, ctx): Promise<ToolResult> {
    if (!engramConfigured()) return fail("Document RAG is not enabled (retrieval.documentRag.enabled).");
    const docs = await listScopedDocuments(ragCtx(ctx));
    if (docs.length === 0) {
      return { success: true, output: "No documents have been ingested into this conversation's library yet.", metadata: { count: 0 } };
    }
    // An invalidated ("marked outdated") document is still LISTED but its content is
    // excluded from all retrieval — flag it so the model never asserts it can read a doc
    // that search_documents will always return empty for.
    const lines = docs.map((d) => {
      const base = `- ${d.title?.trim() || d.id.slice(0, 12)} (${d.chunkCount} chunks) [${d.sources.join(", ")}]`;
      return d.invalidated ? `${base} — MARKED OUTDATED: content not retrievable (re-upload to reinstate)` : base;
    });
    const outdated = docs.filter((d) => d.invalidated).length;
    return { success: true, output: `${docs.length} document(s)${outdated ? ` (${outdated} marked outdated — not retrievable)` : ""}:\n${lines.join("\n")}`, metadata: { count: docs.length, outdated } };
  },
});

// ── forget_document ───────────────────────────────────────────────────────────

registerTool({
  name: "forget_document",
  description:
    "Remove a document from the library. With a scope, only drops that scope's reference (the document survives if other scopes still use it); without a scope, hard-deletes it everywhere. Use list_documents to get the document id.",
  embeddingDescription: "delete remove forget document attachment from RAG knowledge base library cleanup",
  parameters: {
    type: "object",
    properties: {
      document_id: { type: "string", description: "The document id (from list_documents)." },
      scope: { type: "string", enum: SCOPE_VALUES, description: "Optional: only drop this scope's reference. Omit to hard-delete." },
    },
    required: ["document_id"],
  },
  async execute(args, ctx): Promise<ToolResult> {
    if (!engramConfigured()) return fail("Document RAG is not enabled (retrieval.documentRag.enabled).");
    const documentId = String(args["document_id"] ?? "").trim();
    if (!documentId) return fail("document_id is required");
    const scope = SCOPE_VALUES.includes(String(args["scope"] ?? "") as DocumentScope)
      ? (String(args["scope"]) as DocumentScope)
      : undefined;
    const ok = await forgetDocument(documentId, scope, ragCtx(ctx));
    return ok
      ? { success: true, output: `Removed document ${documentId}${scope ? ` from ${scope} scope` : ""}.` }
      : fail(`Could not remove document ${documentId} (not found or service unavailable).`);
  },
});
