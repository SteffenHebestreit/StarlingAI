import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configLoader from "../config/loader.js";
import { registerWorkspaceRoutes } from "../gateway/workspace-routes.js";
import { createToken } from "../gateway/auth.js";
import { safeUserSegment } from "../runtime/user-scope.js";

/**
 * A PARTITION NOBODY ENFORCES IS DECORATION.
 *
 * The artifact zone now resolves per user, but every serve route gates on "is this token
 * valid" and then resolves a caller-supplied path — so without an ownership rule, moving a
 * file into generated/users/<alice> changes nothing about Bob's ability to fetch it. These
 * drive the real routes over real HTTP-shaped requests rather than asserting on the resolver
 * a second time.
 */
describe("workspace routes answer to the caller's own artifact zone", () => {
  const ws = mkdtempSync(join(tmpdir(), "sai-route-scope-"));
  const zone = (user: string) => join(ws, "generated", "users", safeUserSegment(user));

  mkdirSync(zone("alice"), { recursive: true });
  mkdirSync(zone("bob"), { recursive: true });
  writeFileSync(join(zone("alice"), "index.html"), "<h1>alice</h1>", "utf8");
  writeFileSync(join(zone("bob"), "secret.html"), "<h1>bob's</h1>", "utf8");

  // A fixed secret so createToken and verifyToken agree without touching the real one.
  process.env["SAI_JWT_SECRET"] = "workspace-route-user-scope-test-secret-key";

  const app = new Hono();
  vi.spyOn(configLoader, "getConfig").mockReturnValue({
    // No `users` entries: authenticatedUser then resolves the caller from the token's own
    // claims, which is the same path a bootstrap/CLI-minted operator token takes.
    auth: { enabled: true, provider: "builtin", users: [] },
    workspacePath: ws,
    gateway: { jwtSecret: "workspace-route-user-scope-test-secret-key" },
  } as unknown as ReturnType<typeof configLoader.getConfig>);
  registerWorkspaceRoutes(app);

  const asUser = async (user: string, path: string) => {
    const token = await createToken(user);
    return app.request(`/api/workspace/file?path=${encodeURIComponent(path)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  };

  afterEach(() => { vi.clearAllMocks(); });

  it("serves a caller their own artifact addressed the way tools report it", async () => {
    const res = await asUser("alice", "generated/index.html");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("alice");
  });

  it("refuses another account's artifact, opaquely", async () => {
    const bobs = `generated/users/${safeUserSegment("bob")}/secret.html`;
    const res = await asUser("alice", bobs);
    // 404, not 403: a distinct status confirms the file is there, which is most of what an
    // enumeration wants to learn.
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("bob's");
  });

  it("gives two callers the same path and two different files", async () => {
    writeFileSync(join(zone("bob"), "index.html"), "<h1>bob</h1>", "utf8");
    expect(await (await asUser("alice", "generated/index.html")).text()).toContain("alice");
    expect(await (await asUser("bob", "generated/index.html")).text()).toContain("bob");
  });
});
