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