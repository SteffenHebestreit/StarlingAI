import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

/**
 * The memory inspector reads the caller's own workspace memory (found 2026-10-07). Under multi-user
 * auth workspace memory is written to the user's own root, <workspace>/users/<segment>/, and
 * GET /api/memory/entries?scope=workspace read the shared root: a user's own entries never showed.
 */
const tempDir = mkdtempSync(join(tmpdir(), "starlingai-memory-inspector-"));
const workspacePath = join(tempDir, "workspace");
const configPath = join(tempDir, "starlingai.json");
writeFileSync(configPath, JSON.stringify({
  workspacePath,
  gateway: { jwtSecret: "t".repeat(32) },
  auth: { enabled: true, users: [{ username: "alice", passwordHash: "scrypt$placeholder-hash-not-used-here", role: "operator", createdAt: "2026-10-07T00:00:00Z" }] },
}), "utf8");
process.env["SAI_CONFIG_PATH"] = configPath;

describe("memory inspector scope", () => {
  afterAll(async () => {
    (await import("../config/loader.js")).resetConfigForTests();
    delete process.env["SAI_CONFIG_PATH"];
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("lists the caller's own workspace entries, not the shared root's", async () => {
    // Sequential imports: these modules import each other.
    const loader = await import("../config/loader.js");
    loader.resetConfigForTests();
    loader.loadConfig();
    const { runWithRequestContext } = await import("../runtime/request-context.js");
    const { userWorkspaceRoot } = await import("../tools/workspace-path.js");
    const memory = await import("../memory/service.js");
    const { createToken } = await import("../gateway/auth.js");
    const { registerMemoryGraphRoutes } = await import("../gateway/memory-graph-routes.js");

    memory.storeWorkspaceMemoryRecord(userWorkspaceRoot(workspacePath, "alice"), {
      key: "alice_note", subject: "Lager", content: "Alices eigene Notiz zum Lager Nordhafen.",
    });
    memory.storeWorkspaceMemoryRecord(workspacePath, {
      key: "shared_note", subject: "Gemeinsam", content: "Eine Notiz an der geteilten Wurzel.",
    });

    const app = new Hono();
    // What the gateway does for every /api request under auth (gateway/index.ts).
    app.use("/api/*", (_c, next) => runWithRequestContext({ userId: "alice" }, () => next()));
    registerMemoryGraphRoutes(app);

    const token = await createToken("alice", { role: "operator" });
    const response = await app.request("/api/memory/entries?scope=workspace", { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    const body = await response.json() as { records: Array<{ key?: string }> };
    const keys = body.records.map((record) => record.key);
    expect(keys).toContain("alice_note");
    expect(keys).not.toContain("shared_note");
  });
});
