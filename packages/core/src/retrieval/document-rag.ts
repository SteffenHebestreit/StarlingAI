/**
 * Document RAG service — scope-aware retrieval over attached/uploaded files via
 * engram, plus the extract→ingest pipeline (file-MCP → engram).
 *
 * Scoping: engram `/search` is global within an instance, so we tag each
 * document at ingest time with a `source` token and post-filter search results
 * to the documents whose sources intersect the active scope:
 *   - session:<id>     — documents attached in this conversation (always active)
 *   - user:<id>        — the user's personal corpus (active when includeUserDocs)
 *   - workspace:<name> — the workspace-shared corpus (active when includeWorkspaceDocs)
 *
 * Everything degrades gracefully: when engram is disabled/unreachable, ingest
 * returns an error object and retrieval returns [].
 */
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";
import {
  engramConfigured,
  engramIngest,
  engramSearch,
  engramListDocuments,
  engramDeleteDocument,
  type EngramDocumentInfo,
} from "./engram.js";

const log = childLogger("retrieval:document-rag");

export type DocumentScope = "session" | "user" | "workspace";

export interface RagScopeContext {
  sessionId: string;
  userId?: string;
}

export function sessionSource(sessionId: string): string {
  return `session:${sessionId}`;
}
export function userSource(userId: string): string {
  return `user:${userId}`;
}
export function workspaceSource(name: string): string {
  return `workspace:${name}`;
}

/** Resolve a scope choice to its engram source token, or null when unavailable. */
export function resolveScopeSource(scope: DocumentScope, ctx: RagScopeContext): string | null {
  const cfg = getConfig().retrieval.documentRag;
  switch (scope) {
    case "session":
      return ctx.sessionId ? sessionSource(ctx.sessionId) : null;
    case "user":
      return ctx.userId ? userSource(ctx.userId) : null;
    case "workspace":
      return workspaceSource(cfg.workspaceName);
    default:
      return null;
  }
}

/**
 * Source tokens visible to this turn: always the current session, plus the
 * user's and/or workspace's corpus when the corresponding settings toggle is on.
 */
export function activeScopeSources(ctx: RagScopeContext): string[] {
  const cfg = getConfig().retrieval.documentRag;
  const sources: string[] = [];
  if (ctx.sessionId) sources.push(sessionSource(ctx.sessionId));
  if (cfg.includeUserDocs && ctx.userId) sources.push(userSource(ctx.userId));
  if (cfg.includeWorkspaceDocs) sources.push(workspaceSource(cfg.workspaceName));
  return sources;
}

export interface IngestDocumentResult {
  documentId: string;
  chunkCount: number;
  keywords: string[];
  scope: DocumentScope;
  source: string;
  title: string;
}

export type IngestOutcome =
  | { ok: true; result: IngestDocumentResult }
  | { ok: false; error: string };

/**
 * Extract document bytes to Markdown (via the file-conversion service) and
 * ingest into engram under the scope's source token.
 */
export async function ingestDocumentBytes(input: {
  bytes: Uint8Array;
  filename: string;
  contentType: string;
  scope: DocumentScope;
  ctx: RagScopeContext;
  /** Workspace-relative path of the persisted original file, recorded in the registry for the UI. */
  relativePath?: string;
}): Promise<IngestOutcome> {
  if (!engramConfigured()) return { ok: false, error: "document RAG (engram) is not enabled" };
  const source = resolveScopeSource(input.scope, input.ctx);
  if (!source) return { ok: false, error: `cannot resolve ${input.scope} scope for this context` };

  // Lazy import to avoid a static tools↔retrieval import cycle.
  const { extractDocumentBytesToMarkdown } = await import("../tools/multimodal.js");
  const markdown = (await extractDocumentBytesToMarkdown(input.bytes, input.filename, input.contentType)).trim();
  if (!markdown) return { ok: false, error: `no extractable text content in ${input.filename}` };

  return ingestDocumentText({
    text: markdown,
    title: input.filename,
    scope: input.scope,
    ctx: input.ctx,
    file: { relativePath: input.relativePath, contentType: input.contentType, size: input.bytes.byteLength },
  });
}

/** Ingest already-extracted text into engram under the scope's source token. */
export async function ingestDocumentText(input: {
  text: string;
  title: string;
  scope: DocumentScope;
  ctx: RagScopeContext;
  documentId?: string;
  /** Original-file metadata recorded in the registry (for the management UI). */
  file?: { relativePath?: string; contentType?: string; size?: number };
}): Promise<IngestOutcome> {
  if (!engramConfigured()) return { ok: false, error: "document RAG (engram) is not enabled" };
  const source = resolveScopeSource(input.scope, input.ctx);
  if (!source) return { ok: false, error: `cannot resolve ${input.scope} scope for this context` };

  const res = await engramIngest({
    text: input.text,
    source,
    title: input.title,
    ...(input.documentId ? { documentId: input.documentId } : {}),
  });
  if (!res) return { ok: false, error: "engram ingest failed (service unavailable or rejected the document)" };

  log.info({ source, title: input.title, chunks: res.chunkCount }, "ingested document into engram");

  // Record in the registry so the management UI can list/view/remove it.
  const { registerDocument } = await import("./document-registry.js");
  await registerDocument({
    documentId: res.documentId,
    scope: input.scope,
    source,
    filename: input.title,
    ...(input.file?.relativePath ? { relativePath: input.file.relativePath } : {}),
    ...(input.file?.contentType ? { contentType: input.file.contentType } : {}),
    ...(typeof input.file?.size === "number" ? { size: input.file.size } : {}),
    chunkCount: res.chunkCount,
    ingestedAt: new Date().toISOString(),
  });

  return {
    ok: true,
    result: { ...res, scope: input.scope, source, title: input.title },
  };
}

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  title?: string;
  source?: string;
  text: string;
  score: number;
}

/**
 * Scope-aware retrieval. engram search is global, so: list documents → keep only
 * those whose sources intersect the active scope → search with a generous
 * candidate top-k → post-filter to in-scope docs and the min score → trim to
 * retrievalTopK. Returns [] when nothing in scope (never leaks other scopes).
 */
export async function retrieveDocumentContext(
  query: string,
  ctx: RagScopeContext,
): Promise<RetrievedChunk[]> {
  if (!engramConfigured() || !query.trim()) return [];
  const cfg = getConfig().retrieval.documentRag;
  const scopeSources = new Set(activeScopeSources(ctx));
  if (scopeSources.size === 0) return [];

  const docs = await engramListDocuments();
  if (!docs || docs.length === 0) return [];

  const inScope = new Map<string, EngramDocumentInfo>();
  for (const d of docs) {
    if (d.sources.some((s) => scopeSources.has(s))) inScope.set(d.id, d);
  }
  if (inScope.size === 0) return [];

  const results = await engramSearch({ query, finalTopK: cfg.candidateTopK });
  if (!results) return [];

  const filtered: RetrievedChunk[] = [];
  for (const r of results) {
    const doc = inScope.get(r.documentId);
    if (!doc) continue;
    if (r.rerankScore < cfg.minRerankScore) continue;
    filtered.push({
      chunkId: r.chunkId,
      documentId: r.documentId,
      title: doc.title,
      source: doc.sources.find((s) => scopeSources.has(s)),
      text: r.text,
      score: r.rerankScore || r.fusedScore,
    });
    if (filtered.length >= cfg.retrievalTopK) break;
  }
  return filtered;
}

/**
 * Format retrieved chunks as an injectable context block, capped at
 * maxContextChars. Returns "" when there is nothing to inject.
 */
export function formatDocumentContext(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return "";
  const cfg = getConfig().retrieval.documentRag;
  const parts: string[] = [];
  let total = 0;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    const label = c.title?.trim() || c.documentId.slice(0, 8);
    const block = `[Doc ${i + 1}: ${label}]\n${c.text.trim()}`;
    if (total + block.length > cfg.maxContextChars && parts.length > 0) break;
    parts.push(block);
    total += block.length;
  }
  return (
    "Relevant excerpts retrieved from documents attached to this conversation. " +
    "Treat them as authoritative source context when answering, and cite the document name:\n\n" +
    parts.join("\n\n---\n\n")
  );
}

/** List the documents visible to this turn's scope. */
export async function listScopedDocuments(ctx: RagScopeContext): Promise<EngramDocumentInfo[]> {
  if (!engramConfigured()) return [];
  const scopeSources = new Set(activeScopeSources(ctx));
  const docs = await engramListDocuments();
  if (!docs) return [];
  return docs.filter((d) => d.sources.some((s) => scopeSources.has(s)));
}

/** Minimal attachment shape needed for auto-ingest (subset of SessionTranscriptAttachment). */
export interface TurnAttachment {
  filename: string;
  relativePath?: string;
  contentType?: string;
  isDirectory?: boolean;
}

/**
 * Per-turn document-RAG augmentation, called by the runtime at the start of a
 * turn: (1) auto-ingest any files attached THIS turn into the session corpus
 * (so they're searchable immediately — engram dedupes by content hash, so
 * re-attaching is idempotent), then (2) retrieve + format relevant excerpts for
 * the user's message. Returns the ingest counts and the injectable context
 * block ("" when nothing to inject). Never throws.
 */
export async function augmentTurnWithDocuments(input: {
  ctx: RagScopeContext;
  workspacePath: string;
  query: string;
  attachments?: TurnAttachment[];
}): Promise<{ ingested: number; failed: number; contextBlock: string }> {
  if (!engramConfigured()) return { ingested: 0, failed: 0, contextBlock: "" };
  const cfg = getConfig().retrieval.documentRag;
  let ingested = 0;
  let failed = 0;
  const ingestedNames: string[] = [];

  if (cfg.autoIngestAttachments && input.attachments?.length) {
    const [{ readFile }, { resolvePathWithinWorkspace }, { basename }] = await Promise.all([
      import("node:fs/promises"),
      import("../tools/workspace-path.js"),
      import("node:path"),
    ]);
    for (const att of input.attachments) {
      if (att.isDirectory || !att.relativePath) continue;
      try {
        const { resolved } = resolvePathWithinWorkspace(att.relativePath, input.workspacePath);
        const bytes = await readFile(resolved);
        const filename = att.filename || basename(att.relativePath);
        const outcome = await ingestDocumentBytes({
          bytes: new Uint8Array(bytes),
          filename,
          contentType: att.contentType || "application/octet-stream",
          scope: "session",
          ctx: input.ctx,
          relativePath: att.relativePath,
        });
        if (outcome.ok) {
          ingested += 1;
          ingestedNames.push(outcome.result.title);
        } else {
          failed += 1;
        }
      } catch (err) {
        log.warn({ err, path: att.relativePath }, "auto-ingest of attachment failed");
        failed += 1;
      }
    }
  }

  if (!cfg.injectContext) return { ingested, failed, contextBlock: "" };

  const chunks = await retrieveDocumentContext(input.query, input.ctx);
  let contextBlock = formatDocumentContext(chunks);

  // When documents were just attached, always note them (even if same-turn
  // retrieval surfaced little) so the assistant knows the content is indexed and
  // can pull more with search_documents — the prompt stays lean (a hint + the
  // few most relevant excerpts) instead of carrying the whole document.
  if (ingestedNames.length > 0) {
    const hint =
      `The user attached ${ingestedNames.length} document(s) this turn (${ingestedNames.join(", ")}), now indexed in the document library. ` +
      `Their full text is NOT inlined here — call search_documents to retrieve specific passages on demand. ` +
      `Any directly relevant excerpts found for the current message are included below.`;
    contextBlock = contextBlock ? `${hint}\n\n${contextBlock}` : hint;
  }

  return { ingested, failed, contextBlock };
}

/** Parse a scope from an engram source token (`session:x` → "session", etc.). */
export function parseScopeFromSource(source: string): DocumentScope | undefined {
  if (source.startsWith("session:")) return "session";
  if (source.startsWith("user:")) return "user";
  if (source.startsWith("workspace:")) return "workspace";
  return undefined;
}

/**
 * Drop a document's reference from a scope (or hard-delete when scope omitted),
 * keeping the registry and the persisted original files in sync with engram.
 * Returns true when engram accepted the delete.
 */
export async function forgetDocument(
  documentId: string,
  scope: DocumentScope | undefined,
  ctx: RagScopeContext,
): Promise<boolean> {
  if (!engramConfigured()) return false;
  const source = scope ? resolveScopeSource(scope, ctx) ?? undefined : undefined;
  const ok = await engramDeleteDocument(documentId, source);
  if (!ok) return false;

  // Sync the registry + delete the persisted original file(s) for the removed
  // reference(s). Best-effort — engram is the source of truth for the index.
  try {
    const { unregisterDocument } = await import("./document-registry.js");
    const removed = await unregisterDocument(documentId, source);
    if (removed.length > 0) {
      const [{ rm }, { resolvePathWithinWorkspace }] = await Promise.all([
        import("node:fs/promises"),
        import("../tools/workspace-path.js"),
      ]);
      const workspacePath = getConfig().workspacePath;
      for (const entry of removed) {
        if (!entry.relativePath) continue;
        try {
          const { resolved } = resolvePathWithinWorkspace(entry.relativePath, workspacePath);
          await rm(resolved, { force: true });
        } catch (err) {
          log.warn({ err, path: entry.relativePath }, "could not delete persisted file for removed document");
        }
      }
    }
  } catch (err) {
    log.warn({ err, documentId }, "registry/file cleanup after forget failed");
  }
  return true;
}
