/**
 * Memory + knowledge-graph inspector routes for the operator UI under /memory.
 *
 *   GET    /api/memory/entries       — durable memory records (filter + paginate)
 *   PATCH  /api/memory/entries/:key  — edit one durable record (subject/content/tags/kind)
 *   DELETE /api/memory/entries/:key  — permanently delete one durable record
 *   GET    /api/memory/curation      — duplicate/stale report + nudge (read-only)
 *   POST   /api/memory/curate        — compact duplicate memory records (apply)
 *   GET  /api/graph/labels     — MemGraph node-label histogram
 *   GET  /api/graph/overview   — label-scoped node+edge sample for the graph view
 *
 * Extracted verbatim from gateway/index.ts (god-file seam). Every route is
 * auth-gated and degrades gracefully when its backing store (durable memory /
 * MemGraph) is offline. Closure-free — module-level auth/getConfig + lazy imports.
 */
import type { Hono } from "hono";
import { verifyToken, extractBearerToken } from "./auth.js";
import { getConfig } from "../config/loader.js";

export function registerMemoryGraphRoutes(app: Hono): void {
  app.get("/api/memory/entries", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const scope = c.req.query("scope") === "user" ? "user" : "workspace";
    try {
      const { listWorkspaceMemoryRecords, listUserMemoryRecords } = await import("../memory/service.js");
      const cfg = (await import("../config/loader.js")).getConfig();
      const records = scope === "user"
        ? listUserMemoryRecords(cfg.workspacePath)
        : listWorkspaceMemoryRecords(cfg.workspacePath);
      const limitRaw = Number(c.req.query("limit") ?? 200);
      // A non-numeric ?limit=abc → NaN → slice(0, NaN) silently returns ZERO records;
      // fall back to the default instead (mirrors sub-agent-routes.ts / health.ts).
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.trunc(limitRaw))) : 200;
      const query = (c.req.query("query") ?? "").toLowerCase().trim();
      const filtered = query
        ? records.filter((r) => r.content?.toLowerCase().includes(query)
          || r.subject?.toLowerCase().includes(query)
          || r.key?.toLowerCase().includes(query)
          || (r.tags ?? []).some((t) => t.toLowerCase().includes(query)))
        : records;
      const paged = filtered.slice(0, limit);
      return c.json({ scope, total: filtered.length, returned: paged.length, records: paged });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // ── Per-entry mutation (operator UI: edit / delete one durable record) ──────
  // Auth-gated (same bar as POST /api/memory/curate in this file). Scope-aware:
  // ?scope=user targets the user memory store, anything else the workspace store.
  app.patch("/api/memory/entries/:key", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const scope = c.req.query("scope") === "user" ? "user" : "workspace";
    const key = c.req.param("key");
    try {
      const body = await c.req.json<{ content?: unknown; subject?: unknown; tags?: unknown; kind?: unknown }>();
      const patch: { content?: string; subject?: string; tags?: string[]; kind?: string } = {};
      if (typeof body.content === "string") patch.content = body.content;
      if (typeof body.subject === "string") patch.subject = body.subject;
      if (Array.isArray(body.tags)) patch.tags = body.tags.filter((t): t is string => typeof t === "string");
      if (typeof body.kind === "string") patch.kind = body.kind;
      const { updateWorkspaceMemoryRecord, updateUserMemoryRecord } = await import("../memory/service.js");
      const cfg = getConfig();
      const record = scope === "user"
        ? updateUserMemoryRecord(cfg.workspacePath, key, patch)
        : updateWorkspaceMemoryRecord(cfg.workspacePath, key, patch);
      if (!record) return c.json({ error: "Memory entry not found" }, 404);
      return c.json({ scope, record });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.delete("/api/memory/entries/:key", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const scope = c.req.query("scope") === "user" ? "user" : "workspace";
    const key = c.req.param("key");
    try {
      const { deleteWorkspaceMemoryRecord, deleteUserMemoryRecord } = await import("../memory/service.js");
      const cfg = getConfig();
      const deleted = scope === "user"
        ? deleteUserMemoryRecord(cfg.workspacePath, key)
        : deleteWorkspaceMemoryRecord(cfg.workspacePath, key);
      if (!deleted) return c.json({ error: "Memory entry not found" }, 404);
      return c.json({ scope, key, deleted: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // ── Memory curation steward ───────────────────────────────────────────────
  // GET  /api/memory/curation — duplicate/stale report + nudge (read-only)
  // POST /api/memory/curate   — compact duplicates (apply)
  app.get("/api/memory/curation", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    try {
      const { computeMemoryCurationReport } = await import("../memory/steward.js");
      const cfg = getConfig();
      return c.json(computeMemoryCurationReport(cfg.workspacePath));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/memory/curate", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    try {
      const { computeMemoryCurationReport } = await import("../memory/steward.js");
      const { compactWorkspaceMemoryRecords } = await import("../memory/service.js");
      const cfg = getConfig();
      const before = computeMemoryCurationReport(cfg.workspacePath);
      const after = compactWorkspaceMemoryRecords(cfg.workspacePath);
      return c.json({ before, after });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/api/graph/labels", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    try {
      const { isGraphDbAvailable, runCypher, toPlainRecords } = await import("../db/neo4j.js");
      if (!isGraphDbAvailable()) return c.json({ available: false, labels: [] });
      const result = await runCypher(`
        MATCH (n)
        UNWIND labels(n) AS label
        RETURN label, count(*) AS count
        ORDER BY count DESC
      `);
      const labels = result ? toPlainRecords(result).map((r) => ({ label: String(r["label"]), count: Number(r["count"] ?? 0) })) : [];
      return c.json({ available: true, labels });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/api/graph/overview", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    try {
      const { isGraphDbAvailable, runCypher, toPlainRecords } = await import("../db/neo4j.js");
      if (!isGraphDbAvailable()) {
        return c.json({ available: false, nodes: [], edges: [], note: "MemGraph is offline. Set MEMGRAPH_URL and start the memgraph service to enable the knowledge-graph view." });
      }
      const labelFilter = (c.req.query("label") ?? "").trim();
      // The label is string-interpolated into the Cypher template (node labels
      // cannot be a bound parameter), so restrict it to a bare identifier — any
      // injection payload necessarily contains characters outside this set.
      if (labelFilter && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(labelFilter)) {
        return c.json({ error: "Invalid label filter" }, 400);
      }
      const limitRaw = Number(c.req.query("limit") ?? 150);
      const limit = Number.isFinite(limitRaw) ? Math.max(10, Math.min(500, Math.trunc(limitRaw))) : 150;
      // Pull a label-scoped (or global) sample of nodes plus their immediate
      // neighbours. The visualization is a rendered bird's-eye view, not the
      // full graph — operators that need deeper queries should use graph_query.
      const cypher = labelFilter
        ? `MATCH (n:${labelFilter})
           WITH n LIMIT $limit
           OPTIONAL MATCH (n)-[r]-(m)
           RETURN n, r, m`
        : `MATCH (n)
           WITH n LIMIT $limit
           OPTIONAL MATCH (n)-[r]-(m)
           RETURN n, r, m`;
      const result = await runCypher(cypher, { limit });
      const records = result ? toPlainRecords(result) : [];
      const nodesById = new Map<string, Record<string, unknown>>();
      const edgesByKey = new Map<string, Record<string, unknown>>();
      const captureNode = (raw: unknown): string | undefined => {
        if (!raw || typeof raw !== "object") return undefined;
        const node = raw as { identity?: { toString(): string } | string; labels?: string[]; properties?: Record<string, unknown> };
        const id = typeof node.identity === "object" && node.identity !== null && "toString" in node.identity
          ? (node.identity as { toString(): string }).toString()
          : String(node.identity ?? "");
        if (!id) return undefined;
        if (!nodesById.has(id)) {
          const props = node.properties ?? {};
          const name = typeof (props as { name?: unknown }).name === "string" ? String((props as { name: string }).name) : "";
          nodesById.set(id, {
            id,
            labels: Array.isArray(node.labels) ? node.labels : [],
            name,
            properties: props,
          });
        }
        return id;
      };
      const captureEdge = (raw: unknown, sourceId: string | undefined, targetId: string | undefined): void => {
        if (!raw || typeof raw !== "object" || !sourceId || !targetId) return;
        const rel = raw as { identity?: { toString(): string } | string; type?: string; properties?: Record<string, unknown> };
        const rid = typeof rel.identity === "object" && rel.identity !== null && "toString" in rel.identity
          ? (rel.identity as { toString(): string }).toString()
          : String(rel.identity ?? "");
        const key = rid || `${sourceId}-${rel.type ?? "RELATED"}-${targetId}`;
        if (edgesByKey.has(key)) return;
        edgesByKey.set(key, {
          id: key,
          source: sourceId,
          target: targetId,
          type: rel.type ?? "RELATED",
          properties: rel.properties ?? {},
        });
      };
      for (const row of records) {
        const sourceId = captureNode(row["n"]);
        const targetId = captureNode(row["m"]);
        captureEdge(row["r"], sourceId, targetId);
      }
      return c.json({
        available: true,
        labelFilter: labelFilter || null,
        nodes: Array.from(nodesById.values()),
        edges: Array.from(edgesByKey.values()),
        truncated: nodesById.size >= limit,
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });
}
