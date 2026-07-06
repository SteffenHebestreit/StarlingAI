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
  engramSearchDetailed,
  engramListDocuments,
  engramDeleteDocument,
  engramInvalidateDocument,
  type EngramDocumentInfo,
  type EngramSearchMeta,
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

/**
 * Source tokens a caller may MANAGE (list / download / delete) through the
 * documents API. Distinct from {@link activeScopeSources}, which governs
 * retrieval *injection* and is gated by the includeUserDocs/includeWorkspaceDocs
 * toggles: management visibility is about ownership, not those retrieval knobs.
 * A caller may always manage the shared workspace corpus, plus — when known —
 * their own user corpus and the named session's corpus. Used by the gateway to
 * stop one authenticated user from listing, downloading, or deleting another
 * user's (or another session's) documents. Pure + exported for testing.
 */
export function callerManageableSources(opts: { userId?: string; sessionId?: string }): Set<string> {
  const cfg = getConfig().retrieval.documentRag;
  const sources = new Set<string>([workspaceSource(cfg.workspaceName)]);
  if (opts.userId) sources.add(userSource(opts.userId));
  if (opts.sessionId) sources.add(sessionSource(opts.sessionId));
  return sources;
}

export interface IngestDocumentResult {
  documentId: string;
  chunkCount: number;
  keywords: string[];
  scope: DocumentScope;
  source: string;
  title: string;
  /** The full extracted text that was ingested. Surfaced so the runtime can inline a
   *  small just-attached document in full instead of re-fetching top-k chunks. */
  text: string;
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
    result: { ...res, scope: input.scope, source, title: input.title, text: input.text },
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
export interface DocumentRetrievalOutcome {
  chunks: RetrievedChunk[];
  /**
   * True when engram was reached-for but FAILED (unreachable / timed out) — as distinct from a
   * genuinely empty store or no in-scope match. The caller MUST NOT treat this as "the user has
   * no documents on file" (engramListDocuments / engramSearchDetailed return null on failure, [] on empty).
   */
  retrievalFailed: boolean;
  /**
   * True when the confidenceDemotion flag is ON and engram's response-level confidence
   * signals (top_rerank_score / score_gap, v0.6.0+) fell below the configured thresholds —
   * the retrieved excerpts should be framed as possibly-relevant, not authoritative.
   * Always false when the flag is off, on older servers, or when engram reports null.
   */
  lowConfidence: boolean;
}

/**
 * CRAG-style confidence gate (docs/engram-reevaluation-2026-07.md Phase 1). Pure —
 * exported for tests. Demotes ONLY on a positive signal: a null field (older engram,
 * <3 results, engram down) never demotes, and the flag must be on.
 */
export function isLowRetrievalConfidence(
  meta: EngramSearchMeta | null | undefined,
  cfg: { confidenceDemotion: boolean; confidenceMinScoreGap: number; confidenceMinTopRerank: number | null },
): boolean {
  if (!cfg.confidenceDemotion || !meta) return false;
  if (meta.scoreGap !== null && meta.scoreGap < cfg.confidenceMinScoreGap) return true;
  // top_rerank threshold is reranker-range-specific (logit vs sigmoid); null disables it.
  // A reported score BELOW the threshold = the best hit is weak/irrelevant → demote.
  if (cfg.confidenceMinTopRerank !== null && meta.topRerankScore !== null && meta.topRerankScore < cfg.confidenceMinTopRerank) return true;
  return false;
}

export async function retrieveDocumentContextWithStatus(
  query: string,
  ctx: RagScopeContext,
): Promise<DocumentRetrievalOutcome> {
  if (!engramConfigured() || !query.trim()) return { chunks: [], retrievalFailed: false, lowConfidence: false };
  const cfg = getConfig().retrieval.documentRag;
  const scopeSources = new Set(activeScopeSources(ctx));
  if (scopeSources.size === 0) return { chunks: [], retrievalFailed: false, lowConfidence: false };

  const docs = await engramListDocuments();
  if (docs === null) return { chunks: [], retrievalFailed: true, lowConfidence: false };      // engram unreachable / timed out
  if (docs.length === 0) return { chunks: [], retrievalFailed: false, lowConfidence: false }; // genuinely no documents

  const inScope = new Map<string, EngramDocumentInfo>();
  for (const d of docs) {
    if (d.sources.some((s) => scopeSources.has(s))) inScope.set(d.id, d);
  }
  if (inScope.size === 0) return { chunks: [], retrievalFailed: false, lowConfidence: false };

  // Server-side scope filter (flag-gated): send the active sources so a spec-implementing
  // engram filters in the store. The client post-filter below ALWAYS stays on — it is the
  // defense-in-depth layer and carries the per-document metadata the injection needs.
  const outcome = await engramSearchDetailed({
    query,
    finalTopK: cfg.candidateTopK,
    ...(cfg.serverSideScopeFilter ? { sources: [...scopeSources] } : {}),
  });
  if (outcome === null) return { chunks: [], retrievalFailed: true, lowConfidence: false };   // search failed / timed out
  const results = outcome.results;
  // CAVEAT: engram computes the confidence meta over its GLOBAL result set, while the
  // chunks injected below are the scope post-filtered subset — off-scope hits can skew
  // the signal either way. Framing-only impact (demote-never-suppress), resolved when
  // tenant_id scope-sets retire the post-filter (re-eval doc Phase 2); factor into the eval.
  const lowConfidence = isLowRetrievalConfidence(outcome.meta, cfg);

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
  return { chunks: filtered, retrievalFailed: false, lowConfidence };
}

export async function retrieveDocumentContext(
  query: string,
  ctx: RagScopeContext,
): Promise<RetrievedChunk[]> {
  return (await retrieveDocumentContextWithStatus(query, ctx)).chunks;
}

/**
 * In-scope document inventory (metadata only), INDEPENDENT of query relevance. Cheap:
 * one (cached) `/documents` list + a scope-membership filter — no embedding, no rerank.
 *
 * Why this exists: content-relevance retrieval can't surface that a document EXISTS when
 * the question doesn't semantically match its chunks. An existence/access question ("do
 * you have my CV?") reranks every CV chunk negative, so `retrieveDocumentContext` returns
 * [] and the model wrongly concludes "no documents on file". This returns the in-scope
 * titles so a userOwnFacts turn can honestly acknowledge the documents it holds even when
 * no excerpt matched the specific query.
 */
export async function listInScopeDocuments(ctx: RagScopeContext): Promise<EngramDocumentInfo[]> {
  if (!engramConfigured()) return [];
  const scopeSources = new Set(activeScopeSources(ctx));
  if (scopeSources.size === 0) return [];
  const docs = await engramListDocuments();
  if (!docs || docs.length === 0) return [];
  return docs.filter((d) => d.sources.some((s) => scopeSources.has(s)));
}

/**
 * Format retrieved chunks as an injectable context block, capped at
 * maxContextChars. Returns "" when there is nothing to inject.
 *
 * `lowConfidence` (CRAG Phase 1) only DEMOTES the framing sentence — the
 * excerpts themselves are always included. Suppressing the block on low
 * confidence would regress the "you have no CV/documents" false-negative the
 * retrieval-failure + attached-documents notes exist to prevent.
 */
export function formatDocumentContext(
  chunks: RetrievedChunk[],
  opts?: { lowConfidence?: boolean },
): string {
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
  const framing = opts?.lowConfidence
    ? "Excerpts retrieved from documents attached to this conversation — retrieval confidence for this query was LOW, so treat them as possibly-relevant material rather than authoritative answers: verify against the cited document (search_documents) before relying on specifics, cite the document name for anything you do use, and say so plainly if they do not actually answer the question. Do NOT conclude from weak matches that the information is absent:\n\n"
    : "Relevant excerpts retrieved from documents attached to this conversation. " +
      "Treat them as authoritative source context when answering, and cite the document name:\n\n";
  return framing + parts.join("\n\n---\n\n");
}

/**
 * Build a FULL-text inline context block for documents attached THIS turn, or null when
 * inlining is disabled, there are no fresh docs, or their combined text exceeds the
 * threshold (→ fall back to lean semantic retrieval). Inlining the whole small doc is what
 * the user wants when they attach a short file and ask about it — the semantic top-k path
 * silently drops sections and the model then reports present content as "missing" (audit
 * ef9bd480). Pure + exported for testing.
 */
export function buildInlineDocumentContext(
  docs: Array<{ title: string; text: string }>,
  cfg: { inlineSmallDocuments: boolean; inlineThresholdChars: number },
): string | null {
  if (!cfg.inlineSmallDocuments || docs.length === 0) return null;
  const totalChars = docs.reduce((n, d) => n + d.text.length, 0);
  if (totalChars > cfg.inlineThresholdChars) return null;
  const names = docs.map((d) => d.title.trim() || "document").join(", ");
  const header =
    `The user attached ${docs.length} document(s) this turn (${names}). ` +
    `Their COMPLETE text is included below — treat it as the full, authoritative document(s) and answer directly from it. ` +
    `Do NOT claim a section, line item, or figure is absent unless it is genuinely not in the text below.`;
  const body = docs
    .map((d) => `[Doc: ${d.title.trim() || "document"} — full text]\n${d.text.trim()}`)
    .join("\n\n---\n\n");
  return `${header}\n\n${body}`;
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
  // Full extracted text of docs attached THIS turn — used to inline small docs whole.
  const ingestedDocs: Array<{ title: string; text: string }> = [];

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
          ingestedDocs.push({ title: outcome.result.title, text: outcome.result.text });
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

  // Reuse-the-whole-doc (audit ef9bd480): when the user just attached small document(s),
  // inline their FULL text instead of a handful of semantic top-k excerpts that silently
  // drop sections (the page-2 budget rows the model then wrongly called "missing"). Only
  // THIS turn's freshly-attached docs under the threshold; large + prior-turn docs stay on
  // the lean retrieval path below. Costs no extra engram/LLM call — the text is in hand.
  const inlineBlock = buildInlineDocumentContext(ingestedDocs, cfg);
  if (inlineBlock) return { ingested, failed, contextBlock: inlineBlock };

  const { chunks, retrievalFailed, lowConfidence } = await retrieveDocumentContextWithStatus(input.query, input.ctx);
  let contextBlock = formatDocumentContext(chunks, { lowConfidence });

  // Engram did not respond this turn (unreachable / timed out) and produced no context. Surface it
  // so the model does NOT conflate a retrieval FAILURE with "the user has no documents on file"
  // (fresh-instance eval session 9b0414e3: a hung engram made a CV question answer "I have no stored
  // information about your background" — a false claim, since retrieval simply failed).
  if (retrievalFailed && !contextBlock) {
    return {
      ingested,
      failed,
      contextBlock:
        "[DOCUMENT RETRIEVAL UNAVAILABLE THIS TURN — the document store did not respond, so this is NOT evidence that the user has no documents, CV, or profile on file. Do NOT tell the user that nothing is stored about them; say their stored documents could not be retrieved right now and offer to retry or let them paste the content.]",
    };
  }

  // When documents were just attached, always note them (even if same-turn
  // retrieval surfaced little) so the assistant knows the content is indexed and
  // can pull more with search_documents — the prompt stays lean (a hint + the
  // few most relevant excerpts) instead of carrying the whole document. The excerpts
  // are a PARTIAL sample, so the model must not treat them as exhaustive: declaring a
  // section "missing" from a sample is exactly the false-negative seen in audit ef9bd480.
  if (ingestedNames.length > 0) {
    const hint =
      `The user attached ${ingestedNames.length} document(s) this turn (${ingestedNames.join(", ")}), now indexed in the document library. ` +
      `The excerpts below are a PARTIAL semantic sample, NOT the full document — before stating that any section, line item, or figure is absent or missing, call search_documents to retrieve the relevant part (e.g. tables, totals, hours). ` +
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
/**
 * Mark a document OUTDATED (engram invalidation) — the non-destructive sibling of
 * forgetDocument. Reconciliation of the two delete models (docs/engram-reevaluation-2026-07.md
 * Phase 3): they are different verbs, not competitors. forgetDocument = "remove this
 * document from MY scope" (per-source ref-drop; the document survives in other scopes;
 * last ref removes chunks + persisted file). invalidateDocument = "this CONTENT is
 * superseded" — doc-level, hits every scope at once, chunks stay stored for audit,
 * default-valid searches stop surfacing them, and re-ingesting the same content
 * reinstates it. Files and source refs are deliberately NOT touched (reinstate needs
 * the original, and scope membership is unchanged). Ownership policy lives at the
 * gateway route (doc-global action → caller must own every source, or auth off).
 */
export async function invalidateDocument(documentId: string): Promise<boolean> {
  if (!engramConfigured()) return false;
  const ok = await engramInvalidateDocument(documentId);
  if (!ok) return false;
  try {
    const { markDocumentInvalidated } = await import("./document-registry.js");
    await markDocumentInvalidated(documentId);
  } catch (err) {
    log.warn({ err, documentId }, "registry invalidation mark failed");
  }
  return true;
}

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
