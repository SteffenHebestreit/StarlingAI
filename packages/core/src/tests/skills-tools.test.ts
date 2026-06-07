import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTool, type ToolContext, type ToolHandler } from "../tools/registry.js";
import "../tools/skills.js"; // registers search_skills / list_skills / skill_manage / record_skill

// skillLibrary.enabled defaults to true; searchSkills skips the embedding round-trip
// when no embedding model is configured, so this runs fully offline (keyword scoring).

let ws: string;
let ctx: ToolContext;
beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), "sai-skills-"));
  ctx = { workspacePath: ws, sessionId: "skills-test" } as unknown as ToolContext;
});
afterAll(async () => { await rm(ws, { recursive: true, force: true }); });

const t = (name: string): ToolHandler => {
  const h = getTool(name);
  if (!h) throw new Error(`tool ${name} not registered`);
  return h;
};

const PROC = "1. Connect via shell_agent.\n2. Dump each database.\n3. Rotate the daily/weekly archives and prune old ones.";

describe("skills tools", () => {
  it("record_skill validates required fields and minimum procedure length", async () => {
    expect((await t("record_skill").execute({ name: "x", description: "d" }, ctx)).success).toBe(false); // no procedure
    expect((await t("record_skill").execute({ name: "x", description: "d", procedure: "too short" }, ctx)).success).toBe(false);
  });

  it("record_skill authors a draft skill", async () => {
    const r = await t("record_skill").execute(
      {
        name: "PostgreSQL backup rotation procedure",
        description: "Dump and rotate PostgreSQL database backups on a schedule.",
        whenToUse: "rotating postgresql database backups",
        procedure: PROC,
        tags: ["postgresql", "backup", "rotation"],
        agents: ["shell_agent"],
      },
      ctx,
    );
    expect(r.success).toBe(true);
    expect(r.metadata?.["status"]).toBe("draft");
    expect(typeof r.metadata?.["slug"]).toBe("string");
  });

  it("list_skills enumerates the catalog and honors filters", async () => {
    const all = await t("list_skills").execute({}, ctx);
    expect(all.success).toBe(true);
    expect(all.metadata?.["count"]).toBeGreaterThanOrEqual(1);
    expect(all.output).toContain("PostgreSQL backup rotation");

    // The recorded skill is a draft, so an "active"-only filter returns nothing.
    const activeOnly = await t("list_skills").execute({ status: "active" }, ctx);
    expect(activeOnly.metadata?.["count"]).toBe(0);

    const byAgent = await t("list_skills").execute({ agent: "shell_agent" }, ctx);
    expect(byAgent.metadata?.["count"]).toBeGreaterThanOrEqual(1);
  });

  it("search_skills requires a query and finds a keyword match", async () => {
    expect((await t("search_skills").execute({}, ctx)).success).toBe(false);

    const hit = await t("search_skills").execute({ query: "postgresql backup rotation" }, ctx);
    expect(hit.success).toBe(true);
    const matches = hit.metadata?.["skillMatches"] as Array<{ name: string }>;
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(hit.output).toContain("PostgreSQL backup rotation");
  });

  it("skill_manage creates, pins, and reports missing skills", async () => {
    expect((await t("skill_manage").execute({ action: "create", name: "Incomplete" }, ctx)).success).toBe(false); // no description/procedure

    const created = await t("skill_manage").execute(
      { action: "create", name: "Nightly report build", description: "Assemble the nightly report.", procedure: PROC },
      ctx,
    );
    expect(created.success).toBe(true);
    const slug = String(created.metadata?.["slug"]);

    const pinned = await t("skill_manage").execute({ action: "pin", name: slug }, ctx);
    expect(pinned.success).toBe(true);

    const missing = await t("skill_manage").execute({ action: "patch", name: "does-not-exist", oldString: "a", newString: "b" }, ctx);
    expect(missing.success).toBe(false);
    expect(missing.error).toContain("not found");
  });
});
