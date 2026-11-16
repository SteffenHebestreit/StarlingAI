import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The OIDC sign-in routes on a gateway that does not sign in through OIDC.
 *
 * The callback resolved its public base URL, which reads auth.oidc, before it asked whether OIDC
 * sign-in was on at all. On a gateway with the default builtin provider (or auth off) and no
 * auth.oidc, every GET /api/auth/oidc/callback threw "auth.provider is 'oidc' but auth.oidc is not
 * configured": a 500 and a stack trace in the log for anyone who asked, where the login route
 * answers 404 "OIDC login is not enabled". These tests drive the REAL routes
 * (gateway/auth-routes.ts) and record anything a route throws instead of answering.
 */

const tempDirs: string[] = [];

function writeConfig(auth: Record<string, unknown>): void {
  const dir = mkdtempSync(join(tmpdir(), "starlingai-oidc-off-"));
  tempDirs.push(dir);
  const configPath = join(dir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({ gateway: { jwtSecret: "k".repeat(40) }, workspacePath: dir, auth }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configPath;
  process.env["SAI_MUTABLE_CONFIG_PATH"] = configPath;
}

async function boot(auth: Record<string, unknown>) {
  writeConfig(auth);
  vi.resetModules();
  const { registerAuthRoutes } = await import("../gateway/auth-routes.js");
  const { createToken } = await import("../gateway/auth.js");
  const thrown: unknown[] = [];
  const app = new Hono();
  // Hono's default handler answers an uncaught throw with a bare 500; recording it here lets each
  // test say that no route threw, not only which status came back.
  app.onError((err, c) => {
    thrown.push(err);
    return c.text("Internal Server Error", 500);
  });
  registerAuthRoutes(app);
  return { app, thrown, createToken };
}

afterEach(async () => {
  delete process.env["SAI_CONFIG_PATH"];
  delete process.env["SAI_MUTABLE_CONFIG_PATH"];
  const loader = await import("../config/loader.js");
  loader.resetConfigForTests();
  const auth = await import("../gateway/auth.js");
  auth.resetAuthStateForTests();
  vi.resetModules();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("OIDC sign-in routes when OIDC sign-in is not enabled", () => {
  const notEnabled = { error: "OIDC login is not enabled" };

  it("answers the callback 404 under the builtin provider without auth.oidc, with or without a credential", async () => {
    const { app, thrown, createToken } = await boot({ enabled: true, users: [] });
    const token = await createToken("admin", { role: "admin", bst: true });

    for (const [path, init] of [
      ["/api/auth/oidc/callback", undefined],
      ["/api/auth/oidc/callback?state=forged&code=abc", undefined],
      ["/api/auth/oidc/callback?state=forged&code=abc", { headers: { Authorization: `Bearer ${token}` } }],
    ] as const) {
      const res = await app.request(path, init);
      expect(res.status, path).toBe(404);
      expect(await res.json()).toEqual(notEnabled);
    }
    expect(thrown).toEqual([]);
  });

  it("answers the login route and the callback the same 404 when auth is off", async () => {
    const { app, thrown } = await boot({ enabled: false, users: [] });

    for (const path of ["/api/auth/oidc/login", "/api/auth/oidc/callback?state=forged&code=abc"]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(404);
      expect(await res.json()).toEqual(notEnabled);
    }
    expect(thrown).toEqual([]);
  });

  it("answers the login route 404 under the builtin provider", async () => {
    const { app, thrown } = await boot({ enabled: true, users: [] });

    const res = await app.request("/api/auth/oidc/login");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(notEnabled);
    expect(thrown).toEqual([]);
  });
});

describe("OIDC sign-in routes when the oidc provider is chosen but auth.oidc is missing", () => {
  it("refuses a callback with no login state 400 instead of throwing on the missing configuration", async () => {
    const { app, thrown } = await boot({ enabled: true, provider: "oidc", users: [] });

    for (const path of ["/api/auth/oidc/callback", "/api/auth/oidc/callback?state=forged&code=abc"]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid or expired login state" });
    }
    expect(thrown).toEqual([]);
  });

  it("keeps answering the login route 503 (it already caught the missing configuration)", async () => {
    const { app, thrown } = await boot({ enabled: true, provider: "oidc", users: [] });

    const res = await app.request("/api/auth/oidc/login");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "OIDC login unavailable — check the issuer configuration" });
    expect(thrown).toEqual([]);
  });
});
