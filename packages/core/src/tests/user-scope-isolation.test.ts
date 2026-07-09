import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as configLoader from "../config/loader.js";
import { runWithRequestContext } from "../runtime/request-context.js";
import { userScopedDir, safeUserSegment } from "../runtime/user-scope.js";
import { userHasRole, roleRank } from "../gateway/auth.js";
import type { AuthenticatedUser } from "../gateway/auth.js";
import {
  loadMainAssistantPersonality,
  saveMainAssistantPersonality,
  clearMainAssistantPersonalityOverride,
} from "../personality/service.js";

function mockAuth(enabled: boolean): void {
  vi.spyOn(configLoader, "getConfig").mockReturnValue(
    { auth: { enabled } } as unknown as ReturnType<typeof configLoader.getConfig>,
  );
}

const editable = (name: string) => ({
  schemaVersion: 2 as const,
  identity: { core: "A rigorous implementation partner.", name },
  voice: { tone: ["Calm and exact."], style: ["State the tradeoff, then commit."], quirks: [] },
  collaboration: { defaults: [], avoidances: [] },
  growth: { notes: [] },
});

describe("user-scope partitioning", () => {
  afterEach(() => vi.restoreAllMocks());

  it("safeUserSegment is filesystem-safe, injective, and readable-prefixed", () => {
    // Segment = a sanitized readable prefix + a hash of the RAW id.
    expect(safeUserSegment("alice")).toMatch(/^alice-[0-9a-f]{16}$/);
    expect(safeUserSegment("a/b@c..d")).toMatch(/^a_b_c__d-[0-9a-f]{16}$/);
    expect(safeUserSegment("   ")).toMatch(/^u-[0-9a-f]{16}$/); // empty prefix → "u"
    // Deterministic.
    expect(safeUserSegment("alice")).toBe(safeUserSegment("alice"));
    // INJECTIVE: distinct-but-similar valid ids that the old lossy replace collapsed to one
    // bucket now map to DISTINCT buckets (the fix — no more cross-user memory/persona leak).
    expect(safeUserSegment("alice.smith")).not.toBe(safeUserSegment("alice_smith"));
    expect(safeUserSegment("first.last")).not.toBe(safeUserSegment("first@last"));
    // Never a Windows reserved device name.
    expect(safeUserSegment("CON")).not.toMatch(/^CON$/i);
  });

  const base = resolve("/tmp/sai-scope-base"); // normalized once (cross-platform)

  it("auth OFF keeps the single shared path even with a userId (back-compat)", () => {
    mockAuth(false);
    runWithRequestContext({ userId: "alice" }, () => {
      expect(userScopedDir(base)).toBe(base);
    });
  });

  it("auth ON + userId partitions into <base>/users/<segment>", () => {
    mockAuth(true);
    runWithRequestContext({ userId: "alice" }, () => {
      expect(userScopedDir(base)).toBe(resolve(base, "users", safeUserSegment("alice")));
    });
    // Distinct users get distinct buckets.
    const a = runWithRequestContext({ userId: "alice" }, () => userScopedDir(base));
    const b = runWithRequestContext({ userId: "bob" }, () => userScopedDir(base));
    expect(a).not.toBe(b);
  });

  it("auth ON without an authenticated user falls back to the shared path", () => {
    mockAuth(true);
    expect(userScopedDir(base)).toBe(base);
  });

  it("accepts an explicit userId for background sweeps", () => {
    mockAuth(true);
    expect(userScopedDir(base, "carol")).toBe(resolve(base, "users", safeUserSegment("carol")));
  });

  it("uses a pre-resolved segment VERBATIM (sweep round-trip must not double-hash)", () => {
    mockAuth(true);
    const segment = safeUserSegment("dave"); // an existing on-disk bucket name
    runWithRequestContext({ userScopeSegment: segment }, () => {
      // Resolves to that exact bucket — NOT safeUserSegment(segment) (a double hash).
      expect(userScopedDir(base)).toBe(resolve(base, "users", segment));
    });
  });
});

describe("role hierarchy (admin > operator > viewer)", () => {
  const asUser = (role: string): AuthenticatedUser => ({ username: "u", role });

  it("ranks admin above operator above viewer", () => {
    expect(roleRank("admin")).toBeGreaterThan(roleRank("operator"));
    expect(roleRank("operator")).toBeGreaterThan(roleRank("viewer"));
  });

  it("admin satisfies operator and admin; operator does not satisfy admin", () => {
    expect(userHasRole(asUser("admin"), "operator")).toBe(true);
    expect(userHasRole(asUser("admin"), "admin")).toBe(true);
    expect(userHasRole(asUser("operator"), "operator")).toBe(true);
    expect(userHasRole(asUser("operator"), "admin")).toBe(false);
    expect(userHasRole(asUser("viewer"), "operator")).toBe(false);
  });
});

describe("personality: global default + per-user override", () => {
  let dir = "";
  afterEach(() => {
    delete process.env["SAI_USER_MEMORY_PATH"];
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
    vi.restoreAllMocks();
  });

  it("keeps a global default, layers per-user overrides in isolation, and reverts on reset", () => {
    dir = mkdtempSync(join(tmpdir(), "sai-userscope-"));
    process.env["SAI_USER_MEMORY_PATH"] = dir;
    mockAuth(true);

    // 1. Seed the GLOBAL persona (no authenticated user → shared file).
    saveMainAssistantPersonality(editable("Global"), { updatedBy: "user", global: true });
    expect(existsSync(join(dir, "main-assistant-personality.json"))).toBe(true);

    // 2. Alice, with no override yet, sees the global persona.
    runWithRequestContext({ userId: "alice" }, () => {
      expect(loadMainAssistantPersonality().identity.name).toBe("Global");
      // 3. Alice saves her own override.
      saveMainAssistantPersonality(editable("Alice"), { updatedBy: "user" });
      expect(loadMainAssistantPersonality().identity.name).toBe("Alice");
      expect(existsSync(join(dir, "users", safeUserSegment("alice"), "main-assistant-personality.json"))).toBe(true);
    });

    // 4. Bob still sees the global persona — Alice's override is isolated.
    runWithRequestContext({ userId: "bob" }, () => {
      expect(loadMainAssistantPersonality().identity.name).toBe("Global");
    });

    // 5. Alice resets → override cleared → back to the global persona.
    runWithRequestContext({ userId: "alice" }, () => {
      expect(clearMainAssistantPersonalityOverride()).toBe(true);
      expect(loadMainAssistantPersonality().identity.name).toBe("Global");
    });
  });
});
