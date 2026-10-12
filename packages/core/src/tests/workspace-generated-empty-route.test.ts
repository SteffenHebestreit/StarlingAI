import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as configLoader from "../config/loader.js";
import { registerWorkspaceRoutes } from "../gateway/workspace-routes.js";
import { createToken } from "../gateway/auth.js";
import { safeUserSegment } from "../runtime/user-scope.js";

/**
 * DELETE /api/workspace/generated empties generated/ in the caller's own workspace root and touches
 * nothing else: not another account's generated/, not the caller's other zones, not what a link in
 * generated/ leads to.
 *
 * The app below mounts the workspace routes alone, without the /api/* role gate of
 * gateway/index.ts, so a viewer is refused here only if the route checks the role itself. Real temp
 * directories and real links; a link to a directory is a junction where this machine cannot make
 * symbolic links, and the case that needs a link to a FILE skips there.
 */

/** Whether this machine can make a symbolic link to a file. */
const fileLinks = (() => {
  const dir = mkdtempSync(join(tmpdir(), "sai-link-probe-"));
  try {
    writeFileSync(join(dir, "f"), "");
    symlinkSync(join(dir, "f"), join(dir, "l"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
const FILE_LINK_REASON = "this machine cannot make a symbolic link to a file (Windows without the privilege); runs where it can";

/** A link to a directory: a symbolic link, or a junction where the machine cannot make one. */
function linkDir(target: string, at: string): void {
  try {
    symlinkSync(target, at, "dir");
  } catch {
    symlinkSync(target, at, "junction");
  }
}

function put(path: string, content = "x"): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

describe("DELETE /api/workspace/generated", () => {
  const ws = mkdtempSync(join(tmpdir(), "sai-route-empty-generated-"));
  const root = (user: string) => join(ws, "users", safeUserSegment(user));
  const zone = (user: string) => join(root(user), "generated");

  process.env["SAI_JWT_SECRET"] = "workspace-generated-empty-route-test-secret-key";
  const config = {
    // No `users` entries: authenticatedUser then takes the role from the token's own claims.
    auth: { enabled: true, provider: "builtin", users: [] },
    workspacePath: ws,
    gateway: { jwtSecret: "workspace-generated-empty-route-test-secret-key" },
  };
  vi.spyOn(configLoader, "getConfig").mockImplementation(() => config as unknown as ReturnType<typeof configLoader.getConfig>);

  const app = new Hono();
  registerWorkspaceRoutes(app);

  const empty = async (user: string, role?: string) => {
    const token = await createToken(user, role ? { role } : undefined);
    return app.request("/api/workspace/generated", { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  };

  /** What a turn leaves in generated/: files, a nested tree. */
  const turnOutput = ["brief.md", "charts/Hofladen_Besucherzahlen.html", "site/a/b/index.html"];
  /** The rest of an account's root, which is not a turn's output. */
  const otherZones = ["uploads/notes.txt", ".starlingai/memory/memory.db", ".gitignore", ".git/HEAD"];

  beforeEach(() => {
    config.auth.enabled = true;
    for (const dir of ["users", "generated", "agents", ".starlingai"]) {
      rmSync(join(ws, dir), { recursive: true, force: true });
    }
    for (const user of ["alice", "bob"]) {
      for (const file of turnOutput) put(join(zone(user), file), `${user}: ${file}`);
      for (const file of otherZones) put(join(root(user), file), `${user}: ${file}`);
    }
  });

  afterEach(() => { vi.clearAllMocks(); });
  afterAll(() => { rmSync(ws, { recursive: true, force: true }); });

  it("empties the caller's own generated/ and keeps the directory; another account's and the caller's other zones stay", async () => {
    const res = await empty("alice");
    expect(res.status).toBe(200);
    // brief.md, charts/ and its file, site/, a/, b/ and index.html.
    expect(await res.json()).toEqual({ removed: 7 });
    expect(existsSync(zone("alice"))).toBe(true);
    expect(readdirSync(zone("alice"))).toEqual([]);
    for (const file of otherZones) expect(existsSync(join(root("alice"), file)), file).toBe(true);
    for (const file of turnOutput) expect(existsSync(join(zone("bob"), file)), file).toBe(true);
  });

  it("answers 0 when the caller has no generated/ yet", async () => {
    rmSync(zone("alice"), { recursive: true, force: true });
    const res = await empty("alice");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: 0 });
    expect(existsSync(join(root("alice"), ".starlingai", "memory", "memory.db"))).toBe(true);
  });

  it("removes a link in generated/ that leads out of it, and leaves what it leads to", async () => {
    // One into another account's generated/, one into the caller's own state directory, nested.
    linkDir(zone("bob"), join(zone("alice"), "bob-link"));
    linkDir(join(root("alice"), ".starlingai"), join(zone("alice"), "site", "state-link"));
    const res = await empty("alice");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: 9 });
    expect(readdirSync(zone("alice"))).toEqual([]);
    for (const file of turnOutput) expect(existsSync(join(zone("bob"), file)), file).toBe(true);
    expect(existsSync(join(root("alice"), ".starlingai", "memory", "memory.db"))).toBe(true);
  });

  it.skipIf(!fileLinks)(`removes a link to a file outside generated/, and leaves the file (${FILE_LINK_REASON})`, async () => {
    symlinkSync(join(root("alice"), ".starlingai", "memory", "memory.db"), join(zone("alice"), "memory.db"));
    const res = await empty("alice");
    expect(res.status).toBe(200);
    expect(readdirSync(zone("alice"))).toEqual([]);
    expect(existsSync(join(root("alice"), ".starlingai", "memory", "memory.db"))).toBe(true);
  });

  it("refuses a generated/ that is itself a link, and removes nothing it leads to", async () => {
    rmSync(zone("alice"), { recursive: true, force: true });
    linkDir(join(root("alice"), ".starlingai"), zone("alice"));
    const res = await empty("alice");
    expect(res.status).toBe(400);
    expect(lstatSync(zone("alice")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(root("alice"), ".starlingai", "memory", "memory.db"))).toBe(true);
  });

  it("refuses an account root that is itself a link into another account's", async () => {
    // The path strings all stay in alice's root; the directory they name is bob's.
    rmSync(root("alice"), { recursive: true, force: true });
    linkDir(root("bob"), root("alice"));
    const res = await empty("alice");
    expect(res.status).toBe(400);
    for (const file of turnOutput) expect(existsSync(join(zone("bob"), file)), file).toBe(true);
  });

  it("refuses a request without a token, or with one that does not verify", async () => {
    const none = await app.request("/api/workspace/generated", { method: "DELETE" });
    expect(none.status).toBe(401);
    const forged = await app.request("/api/workspace/generated", { method: "DELETE", headers: { Authorization: "Bearer not-a-token" } });
    expect(forged.status).toBe(401);
    for (const file of turnOutput) expect(existsSync(join(zone("alice"), file)), file).toBe(true);
  });

  it("refuses a viewer, its own files included; an operator's or an admin's own are emptied", async () => {
    const viewer = await empty("alice", "viewer");
    expect(viewer.status).toBe(403);
    for (const file of turnOutput) expect(existsSync(join(zone("alice"), file)), file).toBe(true);

    expect((await empty("alice", "operator")).status).toBe(200);
    expect(readdirSync(zone("alice"))).toEqual([]);
    expect((await empty("bob", "admin")).status).toBe(200);
    expect(readdirSync(zone("bob"))).toEqual([]);
  });

  it("with auth off, empties the shared root's generated/ as the single operator, and nothing beside it", async () => {
    config.auth.enabled = false;
    put(join(ws, "generated", "brief.md"));
    put(join(ws, "generated", "charts", "chart.html"));
    put(join(ws, "agents", "20-primary-agents.jsonc"), "[]");
    const res = await empty("admin", "admin");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: 3 });
    expect(readdirSync(join(ws, "generated"))).toEqual([]);
    expect(existsSync(join(ws, "agents", "20-primary-agents.jsonc"))).toBe(true);
    // No account partition with auth off: the per-user roots are just folders beside generated/.
    for (const file of turnOutput) expect(existsSync(join(zone("alice"), file)), file).toBe(true);
  });
});
