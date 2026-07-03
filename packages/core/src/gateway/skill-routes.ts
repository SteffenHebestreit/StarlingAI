/**
 * Skill Library inspector routes, extracted verbatim from the gateway god-file
 * (gateway/index.ts createGateway()). Self-contained: bearer-token auth via
 * ./auth.js, config via getConfig, and the skills store accessed through dynamic
 * imports exactly as before (the store loads lazily on first route hit).
 * Registered by createGateway() via registerSkillLibraryRoutes(app).
 */
import type { Hono } from "hono";
import { getConfig } from "../config/loader.js";
import { verifyToken, extractBearerToken } from "./auth.js";

export function registerSkillLibraryRoutes(app: Hono): void {
  // ── Skill Library inspector ───────────────────────────────────────────────
  // GET  /api/skills                 — list skills (filter by status/query)
  // GET  /api/skills/:slug/history   — inspect mutation history
  // POST /api/skills/:slug/patch     — exact-string patch SKILL.md/support file
  // POST /api/skills/:slug/rollback  — restore a history entry
  // POST /api/skills/:slug/support-file — write support file
  // GET/DELETE /api/skills/:slug/support-file?filePath=... — read/remove support file
  // POST /api/skills/:slug/archive   — archive a skill
  // DELETE /api/skills/:slug         — delete a skill
  app.get("/api/skills", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    try {
      const { listSkillSupportFiles, listSkills, skillSuccessRate } = await import("../skills/store.js");
      const cfg = getConfig();
      const includeArchived = c.req.query("includeArchived") === "true";
      const statusFilter = c.req.query("status");
      const query = (c.req.query("query") ?? "").toLowerCase().trim();
      let skills = listSkills(cfg.workspacePath, { includeArchived });
      if (statusFilter) skills = skills.filter((s) => s.frontmatter.status === statusFilter);
      if (query) {
        skills = skills.filter((s) =>
          s.frontmatter.name.toLowerCase().includes(query)
          || s.frontmatter.description.toLowerCase().includes(query)
          || s.frontmatter.whenToUse.toLowerCase().includes(query)
          || s.frontmatter.tags.some((t) => t.toLowerCase().includes(query)));
      }
      const records = skills.map((s) => ({
        slug: s.frontmatter.slug,
        name: s.frontmatter.name,
        description: s.frontmatter.description,
        whenToUse: s.frontmatter.whenToUse,
        version: s.frontmatter.version,
        status: s.frontmatter.status,
        tags: s.frontmatter.tags,
        agents: s.frontmatter.agents,
        tools: s.frontmatter.tools,
        origin: s.meta.origin,
        curatorManaged: s.meta.curatorManaged,
        pinned: s.meta.pinned,
        views: s.meta.views,
        uses: s.meta.uses,
        successes: s.meta.successes,
        failures: s.meta.failures,
        patches: s.meta.patches,
        successRate: skillSuccessRate(s.meta),
        updatedAt: s.meta.updatedAt,
        lastViewedAt: s.meta.lastViewedAt,
        lastUsedAt: s.meta.lastUsedAt,
        lastPatchedAt: s.meta.lastPatchedAt,
        archivedAt: s.meta.archivedAt,
        supportFiles: listSkillSupportFiles(cfg.workspacePath, s.frontmatter.slug),
        body: s.body,
      }));
      return c.json({ total: records.length, records });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/api/skills/:slug/history", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    try {
      const { getSkill, listSkillHistory } = await import("../skills/store.js");
      const cfg = getConfig();
      const slug = c.req.param("slug");
      if (!getSkill(cfg.workspacePath, slug)) return c.json({ error: "Skill not found" }, 404);
      return c.json({ slug, history: listSkillHistory(cfg.workspacePath, slug) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/skills/:slug/patch", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    let body: Record<string, unknown>;
    try { body = await c.req.json() as Record<string, unknown>; } catch { return c.json({ error: "Invalid JSON body" }, 400); }
    try {
      const { getSkill, patchSkill } = await import("../skills/store.js");
      const cfg = getConfig();
      const slug = c.req.param("slug");
      if (!getSkill(cfg.workspacePath, slug)) return c.json({ error: "Skill not found" }, 404);
      const oldString = typeof body["oldString"] === "string" ? body["oldString"] : "";
      const newString = typeof body["newString"] === "string" ? body["newString"] : undefined;
      if (!oldString || newString === undefined) return c.json({ error: "oldString and newString are required" }, 400);
      const skill = patchSkill(cfg.workspacePath, slug, {
        oldString,
        newString,
        replaceAll: body["replaceAll"] === true,
        filePath: typeof body["filePath"] === "string" ? body["filePath"] : undefined,
      });
      return c.json({ slug: skill.frontmatter.slug, version: skill.frontmatter.version, patches: skill.meta.patches });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/skills/:slug/rollback", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    try {
      const { getSkill, rollbackSkillHistory } = await import("../skills/store.js");
      const cfg = getConfig();
      const slug = c.req.param("slug");
      if (!getSkill(cfg.workspacePath, slug)) return c.json({ error: "Skill not found" }, 404);
      const historyId = typeof body["historyId"] === "string" ? body["historyId"] : undefined;
      const skill = rollbackSkillHistory(cfg.workspacePath, slug, historyId);
      return c.json({ slug: skill.frontmatter.slug, version: skill.frontmatter.version, patches: skill.meta.patches });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/skills/:slug/support-file", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    let body: Record<string, unknown>;
    try { body = await c.req.json() as Record<string, unknown>; } catch { return c.json({ error: "Invalid JSON body" }, 400); }
    try {
      const { getSkill, listSkillSupportFiles, writeSkillSupportFile } = await import("../skills/store.js");
      const cfg = getConfig();
      const slug = c.req.param("slug");
      if (!getSkill(cfg.workspacePath, slug)) return c.json({ error: "Skill not found" }, 404);
      const filePath = typeof body["filePath"] === "string" ? body["filePath"].trim() : "";
      const fileContent = typeof body["fileContent"] === "string" ? body["fileContent"] : undefined;
      if (!filePath || fileContent === undefined) return c.json({ error: "filePath and fileContent are required" }, 400);
      const skill = writeSkillSupportFile(cfg.workspacePath, slug, filePath, fileContent);
      return c.json({ slug: skill.frontmatter.slug, filePath, supportFiles: listSkillSupportFiles(cfg.workspacePath, skill.frontmatter.slug) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/api/skills/:slug/support-file", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    try {
      const { getSkill, readSkillSupportFile } = await import("../skills/store.js");
      const cfg = getConfig();
      const slug = c.req.param("slug");
      if (!getSkill(cfg.workspacePath, slug)) return c.json({ error: "Skill not found" }, 404);
      const filePath = c.req.query("filePath")?.trim() ?? "";
      if (!filePath) return c.json({ error: "filePath is required" }, 400);
      return c.json({ slug, filePath, content: readSkillSupportFile(cfg.workspacePath, slug, filePath) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.delete("/api/skills/:slug/support-file", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    try {
      const { getSkill, listSkillSupportFiles, removeSkillSupportFile } = await import("../skills/store.js");
      const cfg = getConfig();
      const slug = c.req.param("slug");
      if (!getSkill(cfg.workspacePath, slug)) return c.json({ error: "Skill not found" }, 404);
      const filePath = c.req.query("filePath")?.trim() ?? "";
      if (!filePath) return c.json({ error: "filePath is required" }, 400);
      const skill = removeSkillSupportFile(cfg.workspacePath, slug, filePath);
      return c.json({ slug: skill.frontmatter.slug, filePath, supportFiles: listSkillSupportFiles(cfg.workspacePath, skill.frontmatter.slug) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/skills/:slug/pin", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    try {
      const { getSkill, setSkillPinned } = await import("../skills/store.js");
      const cfg = getConfig();
      const slug = c.req.param("slug");
      if (!getSkill(cfg.workspacePath, slug)) return c.json({ error: "Skill not found" }, 404);
      setSkillPinned(cfg.workspacePath, slug, true);
      return c.json({ slug, pinned: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/skills/:slug/unpin", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    try {
      const { getSkill, setSkillPinned } = await import("../skills/store.js");
      const cfg = getConfig();
      const slug = c.req.param("slug");
      if (!getSkill(cfg.workspacePath, slug)) return c.json({ error: "Skill not found" }, 404);
      setSkillPinned(cfg.workspacePath, slug, false);
      return c.json({ slug, pinned: false });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/skills/:slug/archive", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    try {
      const { getSkill, setSkillStatus } = await import("../skills/store.js");
      const cfg = getConfig();
      const slug = c.req.param("slug");
      if (!getSkill(cfg.workspacePath, slug)) return c.json({ error: "Skill not found" }, 404);
      if (!setSkillStatus(cfg.workspacePath, slug, "archived")) return c.json({ error: "Skill is pinned and cannot be archived" }, 409);
      return c.json({ slug, status: "archived" });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.delete("/api/skills/:slug", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    try {
      const { getSkill, deleteSkill } = await import("../skills/store.js");
      const cfg = getConfig();
      const slug = c.req.param("slug");
      if (!getSkill(cfg.workspacePath, slug)) return c.json({ error: "Skill not found" }, 404);
      if (!deleteSkill(cfg.workspacePath, slug)) return c.json({ error: "Skill is pinned and cannot be deleted" }, 409);
      return c.json({ slug, deleted: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });
}
