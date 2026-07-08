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

/** Coerce a JSON body value to a trimmed non-empty string list, or undefined when absent. */
function toStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean);
}

/** Only human-selectable statuses are accepted from the manual create/edit UI. */
function normalizeSkillStatus(v: unknown): "draft" | "active" | undefined {
  return v === "draft" || v === "active" ? v : undefined;
}

export function registerSkillLibraryRoutes(app: Hono): void {
  // ── Skill Library inspector ───────────────────────────────────────────────
  // GET  /api/skills                 — list skills (filter by status/query)
  // POST /api/skills                 — create a skill by hand (origin "manual")
  // PUT  /api/skills/:slug           — edit an existing skill's full content
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

  // POST /api/skills — create a new skill by hand from the Skill Library UI.
  // Reuses the same validated writeSkill path as the record_skill tool (incl. the
  // credential-shaped-content guard); origin "manual". Rejects a slug collision so
  // "create" can never silently overwrite an existing skill (use PUT to edit).
  app.post("/api/skills", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    if (!getConfig().skillLibrary.enabled) return c.json({ error: "Skill Library is disabled" }, 409);
    let body: Record<string, unknown>;
    try { body = await c.req.json() as Record<string, unknown>; } catch { return c.json({ error: "Invalid JSON body" }, 400); }
    try {
      const { getSkill, writeSkill, slugifySkillName } = await import("../skills/store.js");
      const cfg = getConfig();
      const name = typeof body["name"] === "string" ? body["name"].trim() : "";
      const description = typeof body["description"] === "string" ? body["description"].trim() : "";
      const procedure = typeof body["procedure"] === "string" ? body["procedure"].trim() : "";
      if (!name || !description || !procedure) return c.json({ error: "name, description, and procedure are required" }, 400);
      const slug = slugifySkillName(name);
      if (!slug) return c.json({ error: "name must contain at least one alphanumeric character" }, 400);
      if (getSkill(cfg.workspacePath, slug)) return c.json({ error: `A skill "${slug}" already exists — edit it instead` }, 409);
      const skill = writeSkill(cfg.workspacePath, {
        name,
        description,
        procedure,
        whenToUse: typeof body["whenToUse"] === "string" ? body["whenToUse"].trim() : undefined,
        tags: toStringArray(body["tags"]),
        agents: toStringArray(body["agents"]),
        tools: toStringArray(body["tools"]),
        status: normalizeSkillStatus(body["status"]) ?? "active",
        origin: "manual",
      });
      return c.json({ slug: skill.frontmatter.slug, name: skill.frontmatter.name, version: skill.frontmatter.version, status: skill.frontmatter.status });
    } catch (err) {
      if (err instanceof Error && err.name === "SkillCredentialError") return c.json({ error: err.message }, 400);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // PUT /api/skills/:slug — edit an existing skill's full content (name/description/
  // whenToUse/body/tags/agents/tools/status). Content changes bump the version and
  // preserve outcome stats + creation time (writeSkill upserts by slug).
  app.put("/api/skills/:slug", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    if (!getConfig().skillLibrary.enabled) return c.json({ error: "Skill Library is disabled" }, 409);
    let body: Record<string, unknown>;
    try { body = await c.req.json() as Record<string, unknown>; } catch { return c.json({ error: "Invalid JSON body" }, 400); }
    try {
      const { getSkill, writeSkill } = await import("../skills/store.js");
      const cfg = getConfig();
      const slug = c.req.param("slug");
      if (!getSkill(cfg.workspacePath, slug)) return c.json({ error: "Skill not found" }, 404);
      const name = typeof body["name"] === "string" ? body["name"].trim() : "";
      const description = typeof body["description"] === "string" ? body["description"].trim() : "";
      const procedure = typeof body["procedure"] === "string" ? body["procedure"].trim() : "";
      if (!name || !description || !procedure) return c.json({ error: "name, description, and procedure are required" }, 400);
      const skill = writeSkill(cfg.workspacePath, {
        slug,
        name,
        description,
        procedure,
        whenToUse: typeof body["whenToUse"] === "string" ? body["whenToUse"].trim() : undefined,
        tags: toStringArray(body["tags"]),
        agents: toStringArray(body["agents"]),
        tools: toStringArray(body["tools"]),
        status: normalizeSkillStatus(body["status"]),
      });
      return c.json({ slug: skill.frontmatter.slug, name: skill.frontmatter.name, version: skill.frontmatter.version, status: skill.frontmatter.status });
    } catch (err) {
      if (err instanceof Error && err.name === "SkillCredentialError") return c.json({ error: err.message }, 400);
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
