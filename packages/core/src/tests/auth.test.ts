import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PRODUCT } from "../product/index.js";

describe("gateway auth secret resolution", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    delete process.env["SAI_JWT_SECRET"];
    delete process.env["SAI_JWT_SECRET_PATH"];
    vi.resetModules();

    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();

    const auth = await import("../gateway/auth.js");
    auth.resetAuthStateForTests();
  });

  it("uses gateway.jwtSecret from config when env is absent", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-auth-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      gateway: { jwtSecret: "c".repeat(32) },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    delete process.env["SAI_JWT_SECRET"];

    vi.resetModules();
    const auth = await import("../gateway/auth.js");

    try {
      const token = await auth.createToken("alice", { role: "admin" });
      const payload = await auth.verifyToken(token);

      expect(payload?.sub).toBe("alice");
      expect(payload?.role).toBe("admin");
    } finally {
      auth.resetAuthStateForTests();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("persists generated JWT secrets in the workspace-local state directory", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-auth-secret-"));
    const configPath = join(tempDir, "starlingai.json");
    const originalCwd = process.cwd();

    writeFileSync(configPath, JSON.stringify({
      gateway: { port: 8765 },
    }), "utf8");

    process.chdir(tempDir);
    process.env["SAI_CONFIG_PATH"] = configPath;
    process.env["SAI_JWT_SECRET_PATH"] = join(tempDir, PRODUCT.stateDirName, ".jwt_secret");
    delete process.env["SAI_JWT_SECRET"];

    vi.resetModules();
    const auth = await import("../gateway/auth.js");

    try {
      const token = await auth.createToken("workspace-user");
      const payload = await auth.verifyToken(token);
      const secretPath = join(tempDir, PRODUCT.stateDirName, ".jwt_secret");

      expect(payload?.sub).toBe("workspace-user");
      expect(existsSync(secretPath)).toBe(true);
      expect(readFileSync(secretPath, "utf8").trim().length).toBeGreaterThanOrEqual(32);
    } finally {
      process.chdir(originalCwd);
      auth.resetAuthStateForTests();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
describe("authenticatedUser — live-account re-check (JWT revocation)", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    delete process.env["SAI_JWT_SECRET"];
    vi.resetModules();
    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
    const auth = await import("../gateway/auth.js");
    auth.resetAuthStateForTests();
  });

  function writeAuthConfig(configPath: string, users: Array<{ username: string; role: string }>): void {
    writeFileSync(configPath, JSON.stringify({
      gateway: { jwtSecret: "s".repeat(32) },
      auth: {
        enabled: true,
        users: users.map((u) => ({ ...u, passwordHash: "x".repeat(24), createdAt: "2026-01-01T00:00:00Z" })),
      },
    }), "utf8");
  }

  it("rejects a token for a user that was deleted from config", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-revoke-"));
    const configPath = join(tempDir, "starlingai.json");
    writeAuthConfig(configPath, [{ username: "alice", role: "operator" }, { username: "bob", role: "operator" }]);
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();
    const auth = await import("../gateway/auth.js");
    const configLoader = await import("../config/loader.js");
    try {
      const aliceToken = await auth.createToken("alice", { role: "operator" });
      expect((await auth.authenticatedUser(`Bearer ${aliceToken}`))?.username).toBe("alice");

      // Delete alice from config (same jwtSecret so her token still verifies).
      writeAuthConfig(configPath, [{ username: "bob", role: "operator" }]);
      configLoader.resetConfigForTests();

      // Her still-unexpired token must now be rejected — no 24h window.
      expect(await auth.authenticatedUser(`Bearer ${aliceToken}`)).toBeNull();
    } finally {
      auth.resetAuthStateForTests();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns the CURRENT role, so a role change takes effect immediately", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-role-"));
    const configPath = join(tempDir, "starlingai.json");
    writeAuthConfig(configPath, [{ username: "alice", role: "operator" }]);
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();
    const auth = await import("../gateway/auth.js");
    const configLoader = await import("../config/loader.js");
    try {
      const token = await auth.createToken("alice", { role: "operator" }); // token claims operator
      writeAuthConfig(configPath, [{ username: "alice", role: "viewer" }]); // downgraded in config
      configLoader.resetConfigForTests();
      expect((await auth.authenticatedUser(`Bearer ${token}`))?.role).toBe("viewer");
    } finally {
      auth.resetAuthStateForTests();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("trusts token claims when auth is disabled (single-operator / god token)", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-noauth-"));
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      gateway: { jwtSecret: "s".repeat(32) },
      auth: { enabled: false, users: [] },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();
    const auth = await import("../gateway/auth.js");
    try {
      const token = await auth.createToken("admin", { role: "admin" });
      // No user store to check against — the token stands on its own.
      expect((await auth.authenticatedUser(`Bearer ${token}`))?.username).toBe("admin");
    } finally {
      auth.resetAuthStateForTests();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
