/**
 * Document RAG management routes — list / upload / view / remove / mark-outdated
 * files ingested into the engram document library across the three scopes
 * (session / user / workspace). Removing a document updates the RAG (engram
 * delete) AND deletes the persisted original file; marking it outdated (engram
 * invalidation) is non-destructive and reversible by re-ingest.
 *
 * Extracted verbatim from gateway/index.ts (god-file seam). Every route is
 * auth-gated and, in multi-user mode (`auth.enabled`), scope-filtered to the
 * caller's own documents via callerManageableSources — the round-5 cross-user
 * document-leak fix. Legacy single-operator mode keeps the flat instance-wide view.
 */
import type { Hono } from "hono";
import { verifyToken, extractBearerToken, authenticatedUser } from "./auth.js";
import { getConfig } from "../config/loader.js";

export function registerDocumentRoutes(app: Hono): void {
  app.get("/api/documents", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const user = await authenticatedUser(c.req.header("Authorization"));
    const sessionId = c.req.query("sessionId") ?? "";
    try {
      const [{ engramListDocuments }, { listRegistry }, { parseScopeFromSource, callerManageableSources }] = await Promise.all([
        import("../retrieval/engram.js"),
        import("../retrieval/document-registry.js"),
        import("../retrieval/document-rag.js"),
      ]);
      const docs = await engramListDocuments();
      const registry = await listRegistry();
      // Multi-user mode: never list another user's / another session's documents.
      // Legacy single-operator mode (auth disabled) keeps the flat instance-wide view.
      const inScope = getConfig().auth.enabled
        ? (() => {
            const manageable = callerManageableSources({ userId: user?.username, sessionId });
            return (docs ?? []).filter((d) => d.sources.some((s) => manageable.has(s)));
          })()
        : (docs ?? []);
      const documents = inScope.map((d) => ({
        id: d.id,
        title: d.title ?? null,
        chunkCount: d.chunkCount,
        createdAt: d.createdAt ?? null,
        hasFile: registry.some((e) => e.documentId === d.id && e.relativePath),
        // engram's list endpoint does not expose the invalidation marker — the
        // registry stamp (set by POST /:id/invalidate below) is the UI's view of it.
        invalidated: registry.some((e) => e.documentId === d.id && e.invalidatedAt),
        scopes: d.sources.map((src) => {
          const reg = registry.find((e) => e.documentId === d.id && e.source === src);
          return {
            scope: parseScopeFromSource(src) ?? "unknown",
            source: src,
            ...(reg?.relativePath ? { relativePath: reg.relativePath } : {}),
            ...(reg?.contentType ? { contentType: reg.contentType } : {}),
            ...(typeof reg?.size === "number" ? { size: reg.size } : {}),
          };
        }),
      }));
      return c.json({ documents, engramAvailable: docs !== null, currentUser: user?.username ?? null });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/documents", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const user = await authenticatedUser(c.req.header("Authorization"));

    const formData = await c.req.raw.formData();
    const uploadedFile = formData.get("file");
    if (!(uploadedFile instanceof File)) return c.json({ error: "file is required" }, 400);
    const scopeRaw = String(formData.get("scope") ?? "user");
    if (!["session", "user", "workspace"].includes(scopeRaw)) return c.json({ error: "scope must be session|user|workspace" }, 400);
    const scope = scopeRaw as "session" | "user" | "workspace";
    const sessionId = (() => { const s = formData.get("sessionId"); return typeof s === "string" && /^[\w-]{1,64}$/.test(s) ? s : ""; })();
    if (scope === "session" && !sessionId) return c.json({ error: "sessionId is required for session scope" }, 400);
    if (scope === "user" && !user?.username) return c.json({ error: "user scope requires authentication" }, 400);

    try {
      const { writeFile, mkdir } = await import("node:fs/promises");
      const { join, basename } = await import("node:path");
      const safe = basename(uploadedFile.name).replace(/[^\w.\-]+/g, "_").slice(-180) || "upload";
      // Scope-specific upload folder so files are grouped + cleaned with their scope.
      const dirKey = scope === "session" ? sessionId : scope === "user" ? `user-${user!.username}` : "workspace";
      const finalName = `${Date.now()}-${safe}`;
      const relativePath = `uploads/${dirKey}/${finalName}`;
      const absDir = join(getConfig().workspacePath, "uploads", dirKey);
      await mkdir(absDir, { recursive: true });
      const bytes = Buffer.from(await uploadedFile.arrayBuffer());
      await writeFile(join(absDir, finalName), bytes);

      const { ingestDocumentBytes } = await import("../retrieval/document-rag.js");
      const outcome = await ingestDocumentBytes({
        bytes: new Uint8Array(bytes),
        filename: uploadedFile.name,
        contentType: uploadedFile.type || "application/octet-stream",
        scope,
        ctx: { sessionId, ...(user?.username ? { userId: user.username } : {}) },
        relativePath,
      });
      if (!outcome.ok) return c.json({ error: outcome.error }, 502);
      return c.json({
        documentId: outcome.result.documentId,
        title: outcome.result.title,
        scope: outcome.result.scope,
        chunkCount: outcome.result.chunkCount,
        keywords: outcome.result.keywords,
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // Mark a document OUTDATED (engram invalidation) — non-destructive: chunks stay
  // stored, default-valid searches stop surfacing them, re-ingest reinstates. This is
  // deliberately a SEPARATE verb from DELETE (per-scope ref-drop): invalidation is
  // doc-GLOBAL and hits every scope holding the document, so in multi-user mode the
  // caller must own EVERY source of the document (sole owner) — a partial owner may
  // only ref-drop their own scope via DELETE.
  app.post("/api/documents/:id/invalidate", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const user = await authenticatedUser(c.req.header("Authorization"));
    const id = c.req.param("id");
    const sessionId = c.req.query("sessionId") ?? "";
    try {
      const { invalidateDocument, callerManageableSources } = await import("../retrieval/document-rag.js");
      if (getConfig().auth.enabled) {
        const { engramListDocuments } = await import("../retrieval/engram.js");
        const docs = await engramListDocuments();
        const doc = docs?.find((d) => d.id === id);
        const manageable = callerManageableSources({ userId: user?.username, sessionId });
        const owned = doc ? doc.sources.filter((s) => manageable.has(s)) : [];
        // No visible stake → same not-found shape as DELETE (no existence disclosure).
        if (!doc || owned.length === 0) return c.json({ error: "Document not found" }, 404);
        if (owned.length < doc.sources.length) {
          return c.json({ error: "Document is shared with scopes you do not own — remove it from your own scope instead" }, 403);
        }
      }
      const ok = await invalidateDocument(id);
      return ok
        ? c.json({ id, invalidated: true })
        : c.json({ error: "Document not found or RAG unavailable" }, 502);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.delete("/api/documents/:id", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const user = await authenticatedUser(c.req.header("Authorization"));
    const id = c.req.param("id");
    const scopeRaw = c.req.query("scope");
    const scope = scopeRaw && ["session", "user", "workspace"].includes(scopeRaw) ? scopeRaw as "session" | "user" | "workspace" : undefined;
    const sessionId = c.req.query("sessionId") ?? "";
    const ctx = { sessionId, ...(user?.username ? { userId: user.username } : {}) };
    try {
      const { forgetDocument, callerManageableSources, resolveScopeSource, parseScopeFromSource } =
        await import("../retrieval/document-rag.js");
      // Multi-user mode: a caller may only delete document references in scopes it
      // owns — never wipe another user's copy, and never blanket-delete every scope
      // of a shared document. Legacy single-operator mode keeps the flat behavior.
      if (getConfig().auth.enabled) {
        const { engramListDocuments } = await import("../retrieval/engram.js");
        const docs = await engramListDocuments();
        const doc = docs?.find((d) => d.id === id);
        const manageable = callerManageableSources({ userId: user?.username, sessionId });
        const owned = doc ? doc.sources.filter((s) => manageable.has(s)) : [];
        if (!doc || owned.length === 0) return c.json({ error: "Document not found" }, 404);
        const targets = scope
          ? (() => { const t = resolveScopeSource(scope, ctx); return t && owned.includes(t) ? [scope] : []; })()
          : owned.map((s) => parseScopeFromSource(s)).filter((s): s is "session" | "user" | "workspace" => !!s);
        if (targets.length === 0) return c.json({ error: "Document not found" }, 404);
        let removed = false;
        for (const sc of targets) removed = (await forgetDocument(id, sc, ctx)) || removed;
        return removed ? c.json({ id, removed: true, scope: scope ?? "owned" }) : c.json({ error: "Document not found or RAG unavailable" }, 502);
      }
      const ok = await forgetDocument(id, scope, ctx);
      return ok ? c.json({ id, removed: true, scope: scope ?? "all" }) : c.json({ error: "Document not found or RAG unavailable" }, 502);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/api/documents/:id/file", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const user = await authenticatedUser(c.req.header("Authorization"));
    const sessionId = c.req.query("sessionId") ?? "";
    const id = c.req.param("id");
    try {
      // Multi-user mode: don't stream another user's / another session's file bytes.
      if (getConfig().auth.enabled) {
        const [{ engramListDocuments }, { callerManageableSources }] = await Promise.all([
          import("../retrieval/engram.js"),
          import("../retrieval/document-rag.js"),
        ]);
        const docs = await engramListDocuments();
        const doc = docs?.find((d) => d.id === id);
        const manageable = callerManageableSources({ userId: user?.username, sessionId });
        if (!doc || !doc.sources.some((s) => manageable.has(s))) {
          return c.json({ error: "No original file is stored for this document" }, 404);
        }
      }
      const { getRegistryFileEntry } = await import("../retrieval/document-registry.js");
      const entry = await getRegistryFileEntry(id);
      if (!entry?.relativePath) return c.json({ error: "No original file is stored for this document" }, 404);
      const { resolvePathWithinWorkspace } = await import("../tools/workspace-path.js");
      const { readFile } = await import("node:fs/promises");
      const { resolved } = resolvePathWithinWorkspace(entry.relativePath, getConfig().workspacePath);
      const bytes = await readFile(resolved);
      return new Response(new Uint8Array(bytes), {
        headers: {
          "Content-Type": entry.contentType || "application/octet-stream",
          "Content-Disposition": `inline; filename="${encodeURIComponent(entry.filename)}"`,
        },
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
    }
  });
}
