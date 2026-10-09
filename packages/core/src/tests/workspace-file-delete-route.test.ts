import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configLoader from "../config/loader.js";
import { registerWorkspaceRoutes } from "../gateway/workspace-routes.js";
import { createToken } from "../gateway/auth.js";
import { safeUserSegment } from "../runtime/user-scope.js";

/**
 * DELETE /api/workspace/file removes one file under generated/ in the caller's own root and
 * nothing else.
 *
 * The app below mounts the workspace routes alone, without the /api/* role gate of
 * gateway/index.ts, so a viewer is refused here only if the route checks the role itself.
 */
describe("DELETE /api/workspace/file", () => {
  const ws = mkdtempSync(join(tmpdir(), "sai-route-delete-"));
  const root = (user: string) => join(ws, "users", safeUserSegment(user));
  const zone = (user: string) => join(root(user), "generated");

  process.env["SAI_JWT_SECRET"] = "workspace-file-delete-route-test-secret-key";
  const config = {
    // No `users` entries: authenticatedUser then takes the role from the token's own claims.
    auth: { enabled: true, provider: "builtin", users: [] },
    workspacePath: ws,
    gateway: { jwtSecret: "workspace-file-delete-route-test-secret-key" },
  };
  vi.spyOn(configLoader, "getConfig").mockImplementation(() => config as unknown as ReturnType<typeof configLoader.getConfig>);

  const app = new Hono();
  registerWorkspaceRoutes(app);

  const remove = async (user: string, path: string, role?: string) => {
    const token = await createToken(user, role ? { role } : undefined);
    return app.request(`/api/workspace/file?path=${encodeURIComponent(path)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
  };

  beforeEach(() => {
    config.auth.enabled = true;
    for (const dir of ["users", "generated", "agents", ".starlingai"]) {
      rmSync(join(ws, dir), { recursive: true, force: true });
    }
    for (const user of ["alice", "bob"]) {
      mkdirSync(join(zone(user), "e2e"), { recursive: true });
      writeFileSync(join(zone(user), "e2e", "page.html"), `<h1>${user}</h1>`, "utf8");
      // The state dir sits in the same root as generated/, next to it.
      mkdirSync(join(root(user), ".starlingai", "memory"), { recursive: true });
      writeFileSync(join(root(user), ".starlingai", "memory", "memory.db"), "memory", "utf8");
    }
  });

  afterEach(() => { vi.clearAllMocks(); });
  afterAll(() => { rmSync(ws, { recursive: true, force: true }); });

  it("removes the file from the caller's own root and leaves the same path of another account alone", async () => {
    const res = await remove("alice", "generated/e2e/page.html");
    expect(res.status).toBe(204);
    expect(existsSync(join(zone("alice"), "e2e", "page.html"))).toBe(false);
    expect(existsSync(join(zone("bob"), "e2e", "page.html"))).toBe(true);
  });

  it("answers 404 for a file that is not there", async () => {
    const res = await remove("alice", "generated/e2e/missing.html");
    expect(res.status).toBe(404);
  });

  it("refuses a path that leaves the caller's root", async () => {
    const res = await remove("alice", `../${safeUserSegment("bob")}/generated/e2e/page.html`);
    expect(res.status).toBe(400);
    expect(existsSync(join(zone("bob"), "e2e", "page.html"))).toBe(true);
  });

  it("refuses a directory and keeps what is in it", async () => {
    const res = await remove("alice", "generated/e2e");
    expect(res.status).toBe(400);
    expect(existsSync(join(zone("alice"), "e2e", "page.html"))).toBe(true);
  });

  it("refuses a path through a directory link that points into another account's root", async () => {
    // The path string stays inside alice's root; the directory it names is bob's.
    symlinkSync(join(zone("bob"), "e2e"), join(zone("alice"), "bob-link"), "junction");
    const res = await remove("alice", "generated/bob-link/page.html");
    expect(res.status).toBe(400);
    expect(existsSync(join(zone("bob"), "e2e", "page.html"))).toBe(true);
  });

  it("refuses the memory store in the caller's own root: only generated/ is a turn's output", async () => {
    const res = await remove("alice", ".starlingai/memory/memory.db");
    expect(res.status).toBe(400);
    expect(existsSync(join(root("alice"), ".starlingai", "memory", "memory.db"))).toBe(true);
  });

  it("refuses a path outside generated/ as such, not as a file that is not there", async () => {
    const res = await remove("alice", "agents/missing.jsonc");
    expect(res.status).toBe(400);
  });

  it("refuses a path through a directory link in generated/ that points out of it", async () => {
    // The path string is under alice's generated/; the directory it names is her state dir.
    symlinkSync(join(root("alice"), ".starlingai"), join(zone("alice"), "state-link"), "junction");
    const res = await remove("alice", "generated/state-link/memory/memory.db");
    expect(res.status).toBe(400);
    expect(existsSync(join(root("alice"), ".starlingai", "memory", "memory.db"))).toBe(true);
  });

  it("refuses a viewer", async () => {
    const res = await remove("alice", "generated/e2e/page.html", "viewer");
    expect(res.status).toBe(403);
    expect(existsSync(join(zone("alice"), "e2e", "page.html"))).toBe(true);
  });

  it("refuses a request without a token", async () => {
    const res = await app.request("/api/workspace/file?path=generated/e2e/page.html", { method: "DELETE" });
    expect(res.status).toBe(401);
    expect(existsSync(join(zone("alice"), "e2e", "page.html"))).toBe(true);
  });

  it("with auth off, removes the file from the shared root as the single operator", async () => {
    config.auth.enabled = false;
    mkdirSync(join(ws, "generated", "e2e"), { recursive: true });
    writeFileSync(join(ws, "generated", "e2e", "page.html"), "<h1>shared</h1>", "utf8");
    const res = await remove("admin", "generated/e2e/page.html", "admin");
    expect(res.status).toBe(204);
    expect(existsSync(join(ws, "generated", "e2e", "page.html"))).toBe(false);
    // No account partition with auth off: the per-user roots are just folders under the shared one.
    expect(existsSync(join(zone("alice"), "e2e", "page.html"))).toBe(true);
  });

  it("with auth off, refuses a config shard and a deployment ledger in the shared root", async () => {
    config.auth.enabled = false;
    mkdirSync(join(ws, "agents"), { recursive: true });
    writeFileSync(join(ws, "agents", "20-primary-agents.jsonc"), "[]", "utf8");
    mkdirSync(join(ws, ".starlingai"), { recursive: true });
    writeFileSync(join(ws, ".starlingai", "agent_outcomes.ndjson"), "{}\n", "utf8");
    for (const path of ["agents/20-primary-agents.jsonc", ".starlingai/agent_outcomes.ndjson"]) {
      const res = await remove("admin", path, "admin");
      expect(res.status, path).toBe(400);
    }
    expect(existsSync(join(ws, "agents", "20-primary-agents.jsonc"))).toBe(true);
    expect(existsSync(join(ws, ".starlingai", "agent_outcomes.ndjson"))).toBe(true);
  });
});
