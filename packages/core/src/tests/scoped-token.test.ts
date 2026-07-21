/**
 * Scope-claim enforcement in the auth layer (capability-token enforcement).
 *
 * A token minted with a `scope` claim is a narrow capability token (e.g. a fork's
 * single-resource media token), NOT a session credential. Before this
 * enforcement, such a token was accepted by every verifyToken/authenticatedUser
 * gate — a leaked media URL acted as a full bearer session token for its TTL.
 * These tests run against the REAL auth module (real signing + verification).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("scoped capability tokens vs session tokens", () => {
  let tempDir: string | null = null;

  async function freshAuth() {
    tempDir = mkdtempSync(join(tmpdir(), "scoped-token-"));
    const configPath = join(tempDir, "starlingai.json");
    // auth omitted → auth.enabled false: the single-operator path where token
    // claims are authoritative — exactly where a scoped token previously
    // resolved to a full operator session.
    writeFileSync(configPath, JSON.stringify({ gateway: { jwtSecret: "s".repeat(32) } }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();
    return import("../gateway/auth.js");
  }

  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    vi.resetModules();
    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
    const auth = await import("../gateway/auth.js");
    auth.resetAuthStateForTests();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("verifyToken rejects a scope-bearing token; verifyScopedToken accepts it for its scope only", async () => {
    const auth = await freshAuth();
    const media = await auth.createToken("alice", { scope: "luna-media", sid: "rec_1" }, "1h");

    // Not a session credential…
    expect(await auth.verifyToken(media)).toBeNull();
    // …but valid for exactly its own scope, claims intact.
    const payload = await auth.verifyScopedToken(media, "luna-media");
    expect(payload?.sub).toBe("alice");
    expect(payload?.sid).toBe("rec_1");
    // A different scope never matches.
    expect(await auth.verifyScopedToken(media, "other-scope")).toBeNull();
  });

  it("verifyScopedToken rejects a plain session token (no scope claim)", async () => {
    const auth = await freshAuth();
    const session = await auth.createToken("alice", { role: "operator" });
    expect(await auth.verifyScopedToken(session, "luna-media")).toBeNull();
    // Sanity: the session token itself still verifies as a session.
    expect((await auth.verifyToken(session))?.sub).toBe("alice");
  });

  it("authenticatedUser refuses a scoped token as an Authorization bearer credential", async () => {
    const auth = await freshAuth();
    const media = await auth.createToken("alice", { scope: "luna-media", sid: "rec_1" }, "1h");
    // Pre-fix this returned { username: "alice", role: "operator" } — the leak.
    expect(await auth.authenticatedUser(`Bearer ${media}`)).toBeNull();
    // A real session token still authenticates.
    const session = await auth.createToken("alice", { role: "operator" });
    expect((await auth.authenticatedUser(`Bearer ${session}`))?.username).toBe("alice");
  });

  it("a garbage or tampered token is rejected by both verifiers", async () => {
    const auth = await freshAuth();
    expect(await auth.verifyScopedToken("not-a-jwt", "luna-media")).toBeNull();
    const media = await auth.createToken("alice", { scope: "luna-media", sid: "rec_1" }, "1h");
    const tampered = media.slice(0, -2) + "xx";
    expect(await auth.verifyScopedToken(tampered, "luna-media")).toBeNull();
    expect(await auth.verifyToken(tampered)).toBeNull();
  });
});
