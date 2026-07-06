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
import type { Hono } from "hono";
import { verifyToken, extractBearerToken, authenticatedUser } from "./auth.js";
import { registerRoutePolicies } from "./route-policies.js";
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

  app.get("/api/knowledge-bases", async (c) => {
    if (!await authorized(c.req.header("Authorization"))) return c.json({ error: "Unauthorized" }, 401);
    try {
      const [{ listKnowledgeBases, toSummary }, { isCrawlActive }, { engramConfigured }] = await Promise.all([
        import("../retrieval/knowledge-bases.js"),
        import("../retrieval/kb-crawler.js"),
        import("../retrieval/engram.js"),
      ]);
      const kbs = await listKnowledgeBases({ isCrawlActive });
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
      const [{ getKnowledgeBase, toSummary }, { isCrawlActive }] = await Promise.all([
        import("../retrieval/knowledge-bases.js"),
        import("../retrieval/kb-crawler.js"),
      ]);
      const kb = await getKnowledgeBase(c.req.param("id"), { isCrawlActive });
      if (!kb) return c.json({ error: "Knowledge base not found" }, 404);
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
    try {
      const body = await c.req.json<Record<string, unknown>>();
      const { updateKnowledgeBase } = await import("../retrieval/knowledge-bases.js");
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
      });
      if (!updated.ok) return c.json({ error: updated.error }, updated.error.includes("not found") ? 404 : 400);
      const { toSummary } = await import("../retrieval/knowledge-bases.js");
      return c.json({ knowledgeBase: toSummary(updated.value) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/knowledge-bases/:id/crawl", async (c) => {
    if (!await authorized(c.req.header("Authorization"))) return c.json({ error: "Unauthorized" }, 401);
    try {
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
      const { deleteKnowledgeBase } = await import("../retrieval/kb-crawler.js");
      const result = await deleteKnowledgeBase(c.req.param("id"));
      if (!result.ok) return c.json({ error: result.error }, 404);
      return c.json({ id: c.req.param("id"), removed: true, documentsRemoved: result.documentsRemoved, documentsFailed: result.documentsFailed });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });
}
