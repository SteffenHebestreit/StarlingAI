/**
 * Knowledge-base management routes — create / list / inspect / re-crawl /
 * cancel / delete named corpora crawled from documentation sites into engram
 * (see retrieval/knowledge-bases.ts + retrieval/kb-crawler.ts).
 *
 * KBs are workspace-shared: every authenticated caller may list and inspect
 * them (their content is retrievable by every agent turn anyway), while
 * mutations are operator-only via a declarative route policy. Crawls run in
 * the background — POST returns immediately and the UI polls GET for the
 * progress persisted in the KB record.
 */
import type { Hono, Context } from "hono";
import { verifyToken, extractBearerToken, authenticatedUser } from "./auth.js";
import { registerRoutePolicies } from "./route-policies.js";
import { callerMayUseSession } from "./session-route-access.js";
import { getConfig } from "../config/loader.js";

export function registerKnowledgeBaseRoutes(app: Hono): void {
  registerRoutePolicies("core", [
    { method: "POST", pattern: "/api/knowledge-bases", roles: ["operator"] },
    { method: "PATCH", pattern: "/api/knowledge-bases/:id", roles: ["operator"] },
    { method: "DELETE", pattern: "/api/knowledge-bases/:id", roles: ["operator"] },
    { method: "POST", pattern: "/api/knowledge-bases/:id/crawl", roles: ["operator"] },
    { method: "POST", pattern: "/api/knowledge-bases/:id/cancel", roles: ["operator"] },
  ]);

  const authorized = async (authorization: string | undefined): Promise<boolean> => {
    const token = extractBearerToken(authorization);
    return Boolean(token && await verifyToken(token));
  };

  // Caller identity for KB scope access control. In multi-user mode the username
  // owns user-scoped KBs; sessionId (query param) owns session-scoped KBs.
  //
  // The sessionId was taken as it came, and a session KB is visible to whoever presents its
  // session's id: a caller who knew another account's session id could list, inspect, re-crawl,
  // edit or delete that session's KBs (found in review, 2026-10-09). Under multi-user auth the id
  // now counts only when its caller may act for that session (callerMayUseSession, the rule of the
  // /api/sessions routes); `foreignSession` says it named one it may not. With auth off every
  // caller may, as before.
  const kbAccess = async (c: Context): Promise<{ who: { userId?: string; sessionId?: string }; foreignSession: boolean }> => {
    const user = await authenticatedUser(c.req.header("Authorization"));
    const named = c.req.query("sessionId");
    const foreignSession = !!named && !callerMayUseSession(user, named);
    const sessionId = foreignSession ? undefined : named;
    return { who: { ...(user?.username ? { userId: user.username } : {}), ...(sessionId ? { sessionId } : {}) }, foreignSession };
  };
  // For a route that names one KB or changes one: null when the request names a session its caller
  // may not act for, which the route answers with the session routes' opaque 404.
  const kbAccessCtx = async (c: Context): Promise<{ userId?: string; sessionId?: string } | null> => {
    const { who, foreignSession } = await kbAccess(c);
    return foreignSession ? null : who;
  };
  const sessionNotFound = (c: Context) => c.json({ error: "Session not found" }, 404);

  app.get("/api/knowledge-bases", async (c) => {
    if (!await authorized(c.req.header("Authorization"))) return c.json({ error: "Unauthorized" }, 401);
    try {
      const [{ listKnowledgeBases, toSummary, filterAccessibleKbs }, { isCrawlActive }, { engramConfigured }] = await Promise.all([
        import("../retrieval/knowledge-bases.js"),
        import("../retrieval/kb-crawler.js"),
        import("../retrieval/engram.js"),
      ]);
      // The list answers a session its caller may not act for as if no session had been named: the
      // KBs the caller may see, and nothing about that session. A 404 here emptied the dashboard's
      // KB page whenever the chat it had open was gone (deleted, or a stale id after a wipe).
      const { who } = await kbAccess(c);
      const kbs = filterAccessibleKbs(await listKnowledgeBases({ isCrawlActive }), who);
      return c.json({
        knowledgeBases: kbs.map(toSummary),
        enabled: getConfig().retrieval.knowledgeBases.enabled,
        ragConfigured: engramConfigured(),
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/api/knowledge-bases/:id", async (c) => {
    if (!await authorized(c.req.header("Authorization"))) return c.json({ error: "Unauthorized" }, 401);
    try {
      const [{ getKnowledgeBase, toSummary, callerCanAccessKb }, { isCrawlActive }] = await Promise.all([
        import("../retrieval/knowledge-bases.js"),
        import("../retrieval/kb-crawler.js"),
      ]);
      const who = await kbAccessCtx(c);
      if (!who) return sessionNotFound(c);
      const kb = await getKnowledgeBase(c.req.param("id"), { isCrawlActive });
      if (!kb || !callerCanAccessKb(kb, who)) return c.json({ error: "Knowledge base not found" }, 404);
      const pages = Object.values(kb.pages)
        .sort((a, b) => (a.url < b.url ? -1 : 1))
        .slice(0, 1000)
        .map((p) => ({ url: p.url, title: p.title ?? null, chunkCount: p.chunkCount ?? 0, lastIngestedAt: p.lastIngestedAt }));
      return c.json({
        knowledgeBase: {
          ...toSummary(kb),
          includePatterns: kb.includePatterns ?? [],
          excludePatterns: kb.excludePatterns ?? [],
          sameOriginOnly: kb.sameOriginOnly,
          respectRobots: kb.respectRobots,
          createdBy: kb.createdBy ?? null,
          worker: kb.worker ?? null,
        },
        pages,
        pagesTruncated: Object.keys(kb.pages).length > 1000,
        crawling: isCrawlActive(kb.id) || kb.status === "crawling",
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/knowledge-bases", async (c) => {
    if (!await authorized(c.req.header("Authorization"))) return c.json({ error: "Unauthorized" }, 401);
    const user = await authenticatedUser(c.req.header("Authorization"));
    try {
      const body = await c.req.json<Record<string, unknown>>();
      const [{ createKnowledgeBase }, { startKbCrawl }] = await Promise.all([
        import("../retrieval/knowledge-bases.js"),
        import("../retrieval/kb-crawler.js"),
      ]);
      const scope = ["session", "user", "workspace"].includes(String(body["scope"] ?? "")) ? String(body["scope"]) as "session" | "user" | "workspace" : undefined;
      const sessionId = typeof body["sessionId"] === "string" ? body["sessionId"] : undefined;
      // A session KB is in the ambient retrieval of its session's turns: one created under another
      // account's session id fed that account's turns. Under multi-user auth only a session the
      // caller may act for, as on the routes above.
      if (sessionId && !callerMayUseSession(user, sessionId)) return sessionNotFound(c);
      const created = await createKnowledgeBase({
        name: String(body["name"] ?? ""),
        seedUrls: Array.isArray(body["seedUrls"]) ? (body["seedUrls"] as string[]) : [],
        ...(body["id"] ? { id: String(body["id"]) } : {}),
        ...(body["description"] ? { description: String(body["description"]) } : {}),
        ...(typeof body["maxPages"] === "number" ? { maxPages: body["maxPages"] } : {}),
        ...(typeof body["maxDepth"] === "number" ? { maxDepth: body["maxDepth"] } : {}),
        ...(Array.isArray(body["includePatterns"]) ? { includePatterns: body["includePatterns"] as string[] } : {}),
        ...(Array.isArray(body["excludePatterns"]) ? { excludePatterns: body["excludePatterns"] as string[] } : {}),
        ...(typeof body["sameOriginOnly"] === "boolean" ? { sameOriginOnly: body["sameOriginOnly"] } : {}),
        ...(typeof body["respectRobots"] === "boolean" ? { respectRobots: body["respectRobots"] } : {}),
        ...(typeof body["ambientRetrieval"] === "boolean" ? { ambientRetrieval: body["ambientRetrieval"] } : {}),
        ...(scope ? { scope } : {}),
        ...(user?.username ? { ownerId: user.username } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(body["worker"] !== undefined ? { worker: body["worker"] as never } : {}),
        ...(user?.username ? { createdBy: user.username } : {}),
      });
      if (!created.ok) return c.json({ error: created.error }, 400);

      let crawlStarted = false;
      let crawlError: string | undefined;
      if (body["crawlNow"] !== false) {
        const started = await startKbCrawl(created.value.id);
        crawlStarted = started.ok;
        if (!started.ok) crawlError = started.error;
      }
      return c.json({ id: created.value.id, crawlStarted, ...(crawlError ? { crawlError } : {}) }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.patch("/api/knowledge-bases/:id", async (c) => {
    if (!await authorized(c.req.header("Authorization"))) return c.json({ error: "Unauthorized" }, 401);
    const user = await authenticatedUser(c.req.header("Authorization"));
    try {
      const body = await c.req.json<Record<string, unknown>>();
      const { updateKnowledgeBase, getKnowledgeBase, callerCanAccessKb, toSummary } = await import("../retrieval/knowledge-bases.js");
      const who = await kbAccessCtx(c);
      if (!who) return sessionNotFound(c);
      // Moving a KB into a session is creating one there: the body's session too.
      const bodySessionId = typeof body["sessionId"] === "string" ? body["sessionId"] : "";
      if (bodySessionId && !callerMayUseSession(user, bodySessionId)) return sessionNotFound(c);
      const existing = await getKnowledgeBase(c.req.param("id"));
      if (!existing || !callerCanAccessKb(existing, who)) return c.json({ error: "Knowledge base not found" }, 404);
      const scope = ["session", "user", "workspace"].includes(String(body["scope"] ?? "")) ? String(body["scope"]) as "session" | "user" | "workspace" : undefined;
      const updated = await updateKnowledgeBase(c.req.param("id"), {
        ...(body["name"] !== undefined ? { name: String(body["name"]) } : {}),
        ...(body["description"] !== undefined ? { description: String(body["description"]) } : {}),
        ...(Array.isArray(body["seedUrls"]) ? { seedUrls: body["seedUrls"] as string[] } : {}),
        ...(typeof body["maxPages"] === "number" ? { maxPages: body["maxPages"] } : {}),
        ...(typeof body["maxDepth"] === "number" ? { maxDepth: body["maxDepth"] } : {}),
        ...(body["includePatterns"] !== undefined ? { includePatterns: (body["includePatterns"] as string[] | null) } : {}),
        ...(body["excludePatterns"] !== undefined ? { excludePatterns: (body["excludePatterns"] as string[] | null) } : {}),
        ...(typeof body["sameOriginOnly"] === "boolean" ? { sameOriginOnly: body["sameOriginOnly"] } : {}),
        ...(typeof body["respectRobots"] === "boolean" ? { respectRobots: body["respectRobots"] } : {}),
        ...(typeof body["ambientRetrieval"] === "boolean" ? { ambientRetrieval: body["ambientRetrieval"] } : {}),
        ...(scope ? { scope } : {}),
        ...(user?.username ? { ownerId: user.username } : {}),
        ...(typeof body["sessionId"] === "string" ? { sessionId: body["sessionId"] } : {}),
        ...(body["worker"] !== undefined ? { worker: (body["worker"] as never) } : {}),
      });
      if (!updated.ok) return c.json({ error: updated.error }, updated.error.includes("not found") ? 404 : 400);
      return c.json({ knowledgeBase: toSummary(updated.value) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // Access-gate a lifecycle action (crawl/cancel/delete) on an owned/visible KB: the reply that
  // refuses it, or null when the caller may.
  const accessRefusal = async (c: Context): Promise<Response | null> => {
    const who = await kbAccessCtx(c);
    if (!who) return sessionNotFound(c);
    const id = c.req.param("id");
    if (!id) return c.json({ error: "Knowledge base not found" }, 404);
    const { getKnowledgeBase, callerCanAccessKb } = await import("../retrieval/knowledge-bases.js");
    const kb = await getKnowledgeBase(id);
    return kb && callerCanAccessKb(kb, who) ? null : c.json({ error: "Knowledge base not found" }, 404);
  };

  app.post("/api/knowledge-bases/:id/crawl", async (c) => {
    if (!await authorized(c.req.header("Authorization"))) return c.json({ error: "Unauthorized" }, 401);
    try {
      const refused = await accessRefusal(c);
      if (refused) return refused;
      const { startKbCrawl } = await import("../retrieval/kb-crawler.js");
      const started = await startKbCrawl(c.req.param("id"));
      return started.ok
        ? c.json({ id: c.req.param("id"), crawlStarted: true })
        : c.json({ error: started.error }, started.error.includes("not found") ? 404 : 409);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/knowledge-bases/:id/cancel", async (c) => {
    if (!await authorized(c.req.header("Authorization"))) return c.json({ error: "Unauthorized" }, 401);
    try {
      const refused = await accessRefusal(c);
      if (refused) return refused;
      const { cancelKbCrawl } = await import("../retrieval/kb-crawler.js");
      const cancelled = await cancelKbCrawl(c.req.param("id"));
      return cancelled
        ? c.json({ id: c.req.param("id"), cancelRequested: true })
        : c.json({ error: "No crawl is running for this knowledge base" }, 409);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.delete("/api/knowledge-bases/:id", async (c) => {
    if (!await authorized(c.req.header("Authorization"))) return c.json({ error: "Unauthorized" }, 401);
    try {
      const refused = await accessRefusal(c);
      if (refused) return refused;
      const { deleteKnowledgeBase } = await import("../retrieval/kb-crawler.js");
      const result = await deleteKnowledgeBase(c.req.param("id"));
      if (!result.ok) return c.json({ error: result.error }, 404);
      return c.json({ id: c.req.param("id"), removed: true, documentsRemoved: result.documentsRemoved, documentsFailed: result.documentsFailed });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });
}
