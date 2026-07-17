import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Multi-user authentication (Wave A) — verifies the username/password
 * login path, the user-management CRUD endpoints, and the legacy
 * single-operator fallback when `auth.enabled` is false.
 *
 * Each test boots a focused Hono app that mounts only the auth-related
 * routes from the gateway (we don't want to spin up the full gateway
 * machinery; this keeps the test cheap and isolated).
 */

const SHARED_JWT_SECRET = "j".repeat(40);

function writeAuthConfig(extra: Record<string, unknown> = {}): string {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-multiuser-"));
  const configPath = join(tempDir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({
    gateway: { jwtSecret: SHARED_JWT_SECRET },
    auth: { enabled: false, users: [] },
    ...extra,
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configPath;
  process.env["SAI_MUTABLE_CONFIG_PATH"] = configPath;
  return tempDir;
}

// A config user record for tokens minted directly in tests. authenticatedUser now
// re-checks the live user store on every request, so a token's subject must exist
// there — an absent/deleted user is (correctly) rejected. The password hash is a
// dummy (login isn't exercised for these directly-minted tokens).
const DUMMY_HASH = "$2b$10$0123456789abcdefghijklmno";
function userRec(username: string, role: string, displayName?: string): Record<string, unknown> {
  return { username, role, passwordHash: DUMMY_HASH, ...(displayName ? { displayName } : {}), createdAt: "2026-01-01T00:00:00Z" };
}

async function buildAuthApp(): Promise<Hono> {
  const auth = await import("../gateway/auth.js");
  const { getConfig, updateConfig } = await import("../config/loader.js");
  const { logAudit } = await import("../audit/logger.js");

  const app = new Hono();

  app.post("/api/auth/login", async (c) => {
    const ip = c.req.header("X-Forwarded-For") ?? "test";
    const rate = auth.checkAuthRateLimit(ip);
    if (!rate.allowed) return c.json({ error: "Too many failed attempts" }, 429);

    let body: { username?: unknown; password?: unknown };
    try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!username || !password) return c.json({ error: "Username and password are required" }, 400);

    const cfg = getConfig().auth;
    if (!cfg.enabled) return c.json({ error: "disabled" }, 503);

    const user = cfg.users.find((u) => u.username.toLowerCase() === username);
    if (!user) {
      auth.recordAuthFailure(ip);
      return c.json({ error: "Invalid username or password" }, 401);
    }
    const ok = await auth.verifyPassword(password, user.passwordHash);
    if (!ok) {
      auth.recordAuthFailure(ip);
      return c.json({ error: "Invalid username or password" }, 401);
    }
    auth.clearAuthFailures(ip);
    const role: "operator" | "viewer" = user.role === "viewer" ? "viewer" : "operator";
    const token = await auth.createToken(user.username, {
      role,
      ...(user.displayName ? { displayName: user.displayName } : {}),
    });
    logAudit("auth_success", { username: user.username, role }, { userId: user.username });
    return c.json({ token, username: user.username, displayName: user.displayName, role });
  });

  app.get("/api/auth/me", async (c) => {
    const me = await auth.authenticatedUser(c.req.header("Authorization"));
    if (!me) return c.json({ error: "Unauthorized" }, 401);
    return c.json(me);
  });

  app.post("/api/auth/users", async (c) => {
    const actor = await auth.authenticatedUser(c.req.header("Authorization"));
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    if (!auth.userHasRole(actor, "operator")) {
      return c.json({ error: "Operator role required" }, 403);
    }
    let body: { username?: unknown; password?: unknown; displayName?: unknown; role?: unknown };
    try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const displayName = typeof body.displayName === "string" ? body.displayName : undefined;
    const role = body.role === "viewer" ? "viewer" : "operator";
    if (!username || !/^[a-z0-9_.-]+$/.test(username)) return c.json({ error: "username invalid" }, 400);
    if (password.length < 8) return c.json({ error: "password too short" }, 400);
    if (getConfig().auth.users.find((u) => u.username.toLowerCase() === username)) {
      return c.json({ error: "exists" }, 409);
    }
    const passwordHash = await auth.hashPassword(password);
    const createdAt = new Date().toISOString();
    updateConfig((raw) => {
      const a = (raw["auth"] = (raw["auth"] as Record<string, unknown>) ?? {});
      const users = (a["users"] = (a["users"] as unknown[] | undefined) ?? []);
      (users as unknown[]).push({ username, passwordHash, displayName, role, createdAt });
      if (a["enabled"] !== true) a["enabled"] = true;
    });
    return c.json({ username, displayName, role, createdAt });
  });

  return app;
}

describe("multi-user auth — login flow", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    delete process.env["SAI_MUTABLE_CONFIG_PATH"];
    delete process.env["SAI_JWT_SECRET"];
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
    vi.resetModules();
    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
    const auth = await import("../gateway/auth.js");
    auth.resetAuthStateForTests();
  });

  it("returns 503 when auth.enabled is false", async () => {
    tempDir = writeAuthConfig({ auth: { enabled: false, users: [] } });
    vi.resetModules();
    const app = await buildAuthApp();
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "anything" }),
    });
    expect(res.status).toBe(503);
  });

  it("rejects unknown usernames with 401", async () => {
    const auth = await import("../gateway/auth.js");
    const hash = await auth.hashPassword("correct-horse");
    tempDir = writeAuthConfig({
      auth: { enabled: true, users: [{ username: "alice", passwordHash: hash, createdAt: "2026-04-28T00:00:00Z" }] },
    });
    vi.resetModules();
    const app = await buildAuthApp();
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "bob", password: "correct-horse" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects wrong passwords with 401", async () => {
    const auth = await import("../gateway/auth.js");
    const hash = await auth.hashPassword("correct-horse");
    tempDir = writeAuthConfig({
      auth: { enabled: true, users: [{ username: "alice", passwordHash: hash, createdAt: "2026-04-28T00:00:00Z" }] },
    });
    vi.resetModules();
    const app = await buildAuthApp();
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "wrong" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns a JWT scoped to the username on success", async () => {
    const auth = await import("../gateway/auth.js");
    const hash = await auth.hashPassword("correct-horse");
    tempDir = writeAuthConfig({
      auth: {
        enabled: true,
        users: [{ username: "alice", passwordHash: hash, displayName: "Alice Smith", createdAt: "2026-04-28T00:00:00Z" }],
      },
    });
    vi.resetModules();
    // Re-import after resetModules so we use the SAME auth module instance
    // that the app's login endpoint will use.  Otherwise the JWT minted by
    // the new instance can't be verified by a stale reference (separate
    // _jwtSecret caches per module instance).
    const auth2 = await import("../gateway/auth.js");
    const app = await buildAuthApp();
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "correct-horse" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { token: string; username: string; displayName?: string; role: string };
    expect(body.username).toBe("alice");
    expect(body.displayName).toBe("Alice Smith");
    expect(body.role).toBe("operator");
    expect(body.token).toMatch(/^eyJ/);

    // The token should round-trip via authenticatedUser:
    const me = await auth2.authenticatedUser(`Bearer ${body.token}`);
    expect(me?.username).toBe("alice");
    expect(me?.displayName).toBe("Alice Smith");
  });

  it("usernames are matched case-insensitively", async () => {
    const auth = await import("../gateway/auth.js");
    const hash = await auth.hashPassword("correct-horse");
    tempDir = writeAuthConfig({
      auth: { enabled: true, users: [{ username: "alice", passwordHash: hash, createdAt: "2026-04-28T00:00:00Z" }] },
    });
    vi.resetModules();
    const app = await buildAuthApp();
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "ALICE", password: "correct-horse" }),
    });
    expect(res.status).toBe(200);
  });
});

describe("multi-user auth — /api/auth/me", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    delete process.env["SAI_MUTABLE_CONFIG_PATH"];
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
    vi.resetModules();
    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
    const auth = await import("../gateway/auth.js");
    auth.resetAuthStateForTests();
  });

  it("returns 401 without a bearer token", async () => {
    tempDir = writeAuthConfig({ auth: { enabled: true, users: [] } });
    vi.resetModules();
    const app = await buildAuthApp();
    const res = await app.request("/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("returns the current user when called with a valid token", async () => {
    const auth = await import("../gateway/auth.js");
    tempDir = writeAuthConfig({ auth: { enabled: true, users: [userRec("alice", "operator", "Alice")] } });
    vi.resetModules();
    const auth2 = await import("../gateway/auth.js");
    const token = await auth2.createToken("alice", { role: "operator", displayName: "Alice" });
    const app = await buildAuthApp();
    const res = await app.request("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as { username: string; role: string; displayName?: string };
    expect(body.username).toBe("alice");
    expect(body.role).toBe("operator");
    expect(body.displayName).toBe("Alice");
    // Suppress unused warning for the import-style read
    expect(typeof auth.hashPassword).toBe("function");
  });
});

describe("multi-user auth — user creation", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    delete process.env["SAI_MUTABLE_CONFIG_PATH"];
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
    vi.resetModules();
    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
    const auth = await import("../gateway/auth.js");
    auth.resetAuthStateForTests();
  });

  it("creates a user and persists the bcrypt hash to config", async () => {
    tempDir = writeAuthConfig({ auth: { enabled: true, users: [userRec("admin", "operator")] } });
    vi.resetModules();
    const auth = await import("../gateway/auth.js");
    const actorToken = await auth.createToken("admin", { role: "operator" });
    const app = await buildAuthApp();

    const res = await app.request("/api/auth/users", {
      method: "POST",
      headers: { Authorization: `Bearer ${actorToken}`, "content-type": "application/json" },
      body: JSON.stringify({ username: "bob", password: "12345678", displayName: "Bob Builder" }),
    });
    expect(res.status).toBe(200);

    const persisted = JSON.parse(readFileSync(join(tempDir!, "starlingai.json"), "utf8")) as {
      auth: { users: Array<{ username: string; passwordHash: string; displayName?: string }> };
    };
    const bob = persisted.auth.users.find((u) => u.username === "bob");
    expect(bob).toBeDefined();
    expect(bob?.passwordHash).toMatch(/^\$2[aby]\$/); // bcrypt prefix
    expect(bob?.displayName).toBe("Bob Builder");

    // Sanity: the new credentials actually log in.
    const loginRes = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "bob", password: "12345678" }),
    });
    expect(loginRes.status).toBe(200);
  });

  it("rejects passwords shorter than 8 chars", async () => {
    tempDir = writeAuthConfig({ auth: { enabled: true, users: [userRec("admin", "operator")] } });
    vi.resetModules();
    const auth = await import("../gateway/auth.js");
    const actorToken = await auth.createToken("admin", { role: "operator" });
    const app = await buildAuthApp();

    const res = await app.request("/api/auth/users", {
      method: "POST",
      headers: { Authorization: `Bearer ${actorToken}`, "content-type": "application/json" },
      body: JSON.stringify({ username: "bob", password: "short" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects duplicate usernames with 409", async () => {
    const auth = await import("../gateway/auth.js");
    const hash = await auth.hashPassword("12345678");
    tempDir = writeAuthConfig({
      auth: { enabled: true, users: [{ username: "alice", passwordHash: hash, createdAt: "2026-04-28T00:00:00Z" }] },
    });
    vi.resetModules();
    const auth2 = await import("../gateway/auth.js");
    const actorToken = await auth2.createToken("alice", { role: "operator" });
    const app = await buildAuthApp();

    const res = await app.request("/api/auth/users", {
      method: "POST",
      headers: { Authorization: `Bearer ${actorToken}`, "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "anotherpass" }),
    });
    expect(res.status).toBe(409);
  });
});

describe("multi-user auth Wave B — role gating", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    delete process.env["SAI_MUTABLE_CONFIG_PATH"];
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
    vi.resetModules();
    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
    const auth = await import("../gateway/auth.js");
    auth.resetAuthStateForTests();
  });

  it("login carries the user's stored role into the JWT", async () => {
    const auth = await import("../gateway/auth.js");
    const opHash = await auth.hashPassword("op-password");
    const viewerHash = await auth.hashPassword("viewer-password");
    tempDir = writeAuthConfig({
      auth: {
        enabled: true,
        users: [
          { username: "alice", passwordHash: opHash, role: "operator", createdAt: "2026-04-28T00:00:00Z" },
          { username: "bob", passwordHash: viewerHash, role: "viewer", createdAt: "2026-04-28T00:00:00Z" },
        ],
      },
    });
    vi.resetModules();
    const auth2 = await import("../gateway/auth.js");
    const app = await buildAuthApp();

    const opRes = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "op-password" }),
    });
    const opBody = await opRes.json() as { token: string; role: string };
    expect(opBody.role).toBe("operator");
    expect((await auth2.authenticatedUser(`Bearer ${opBody.token}`))?.role).toBe("operator");

    const viewerRes = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "bob", password: "viewer-password" }),
    });
    const viewerBody = await viewerRes.json() as { token: string; role: string };
    expect(viewerBody.role).toBe("viewer");
    expect((await auth2.authenticatedUser(`Bearer ${viewerBody.token}`))?.role).toBe("viewer");
  });

  it("viewers cannot create users (403)", async () => {
    tempDir = writeAuthConfig({ auth: { enabled: true, users: [userRec("eve", "viewer")] } });
    vi.resetModules();
    const auth = await import("../gateway/auth.js");
    const viewerToken = await auth.createToken("eve", { role: "viewer" });
    const app = await buildAuthApp();

    const res = await app.request("/api/auth/users", {
      method: "POST",
      headers: { Authorization: `Bearer ${viewerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ username: "newuser", password: "pass1234" }),
    });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/operator role/i);
  });

  it("operators can create viewer accounts via role parameter", async () => {
    tempDir = writeAuthConfig({ auth: { enabled: true, users: [userRec("alice", "operator")] } });
    vi.resetModules();
    const auth = await import("../gateway/auth.js");
    const operatorToken = await auth.createToken("alice", { role: "operator" });
    const app = await buildAuthApp();

    const res = await app.request("/api/auth/users", {
      method: "POST",
      headers: { Authorization: `Bearer ${operatorToken}`, "content-type": "application/json" },
      body: JSON.stringify({ username: "newviewer", password: "pass1234", role: "viewer" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { username: string; role: string };
    expect(body.role).toBe("viewer");
  });

  it("userHasRole helper enforces the operator > viewer hierarchy", async () => {
    const auth = await import("../gateway/auth.js");
    const op = { username: "alice", role: "operator" as const };
    const viewer = { username: "bob", role: "viewer" as const };

    expect(auth.userHasRole(op, "operator")).toBe(true);
    expect(auth.userHasRole(op, "viewer")).toBe(true); // operators include viewer access
    expect(auth.userHasRole(viewer, "viewer")).toBe(true);
    expect(auth.userHasRole(viewer, "operator")).toBe(false);
    expect(auth.userHasRole(null, "viewer")).toBe(false);
  });

  it("resolves a user's role from the live store, defaulting to operator", async () => {
    // A stored user whose record omits an explicit role defaults to operator.
    tempDir = writeAuthConfig({ auth: { enabled: true, users: [{ username: "legacy_admin", passwordHash: DUMMY_HASH, createdAt: "2026-01-01T00:00:00Z" }] } });
    vi.resetModules();
    const auth = await import("../gateway/auth.js");
    // Token carries no role claim; the role now comes from the live user record.
    const token = await auth.createToken("legacy_admin", {});
    const me = await auth.authenticatedUser(`Bearer ${token}`);
    expect(me?.role).toBe("operator");
  });
});

describe("multi-user auth — zero-users bootstrap window", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    delete process.env["SAI_MUTABLE_CONFIG_PATH"];
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
    vi.resetModules();
    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
    const auth = await import("../gateway/auth.js");
    auth.resetAuthStateForTests();
  });

  it("resolves the bootstrap admin token via its claims while auth.users[] is empty", async () => {
    // The lockout this prevents: auth.enabled=true ships in config BEFORE any
    // account exists (config/gateway/30-auth.jsonc documents this state), so the
    // sai-token JWT must keep working or no first account can ever be created.
    tempDir = writeAuthConfig({ auth: { enabled: true, users: [] } });
    vi.resetModules();
    const auth = await import("../gateway/auth.js");
    const token = await auth.createToken("admin", { role: "admin" });
    const me = await auth.authenticatedUser(`Bearer ${token}`);
    expect(me).not.toBeNull();
    expect(me?.username).toBe("admin");
    expect(me?.role).toBe("admin");
  });

  it("lets the bootstrap token create the first account", async () => {
    tempDir = writeAuthConfig({ auth: { enabled: true, users: [] } });
    vi.resetModules();
    const auth = await import("../gateway/auth.js");
    const token = await auth.createToken("admin", { role: "admin" });
    const app = await buildAuthApp();
    const res = await app.request("/api/auth/users", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ username: "steffen", password: "longenough", role: "operator" }),
    });
    expect(res.status).toBe(200);
    const { getConfig } = await import("../config/loader.js");
    expect(getConfig().auth.users.map((u) => u.username)).toEqual(["steffen"]);
  });

  it("closes the window once the first account exists", async () => {
    // With one real account in the store, the live-store re-check is authoritative
    // again: the claims-only bootstrap token no longer resolves.
    tempDir = writeAuthConfig({ auth: { enabled: true, users: [userRec("alice", "operator")] } });
    vi.resetModules();
    const auth = await import("../gateway/auth.js");
    const token = await auth.createToken("admin", { role: "admin" });
    expect(await auth.authenticatedUser(`Bearer ${token}`)).toBeNull();
  });
});
