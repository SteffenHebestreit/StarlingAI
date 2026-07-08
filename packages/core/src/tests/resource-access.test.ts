import { afterEach, describe, expect, it, vi } from "vitest";
import { canAccessResource, filterAccessibleResources, resourceDeniedMessage } from "../guardrails/resource-access.js";
import * as configLoader from "../config/loader.js";

/**
 * Per-user resource ownership guard. Backwards-compatible: shared resources and
 * single-user (auth-off) mode stay open; only an explicit allowedUsers list
 * scopes access, and only when a requesting user is known.
 */
describe("canAccessResource", () => {
  it("allows shared resources (no allowedUsers) for everyone", () => {
    expect(canAccessResource("alice", {})).toBe(true);
    expect(canAccessResource("alice", { allowedUsers: [] })).toBe(true);
    expect(canAccessResource(undefined, { allowedUsers: [] })).toBe(true);
    expect(canAccessResource("bob", undefined)).toBe(true);
  });

  it("allows when auth is disabled (no requesting user) even on a scoped resource", () => {
    expect(canAccessResource(undefined, { allowedUsers: ["alice"] })).toBe(true);
  });

  it("enforces the allow-list when a user is known", () => {
    expect(canAccessResource("alice", { allowedUsers: ["alice", "carol"] })).toBe(true);
    expect(canAccessResource("bob", { allowedUsers: ["alice", "carol"] })).toBe(false);
  });

  it("compares usernames case-insensitively", () => {
    expect(canAccessResource("Alice", { allowedUsers: ["alice"] })).toBe(true);
    expect(canAccessResource("alice", { allowedUsers: ["ALICE"] })).toBe(true);
  });

  it("filters a resource list to the accessible subset", () => {
    const accounts = [
      { id: "shared", allowedUsers: [] },
      { id: "alice-only", allowedUsers: ["alice"] },
      { id: "bob-only", allowedUsers: ["bob"] },
    ];
    expect(filterAccessibleResources("alice", accounts).map((a) => a.id)).toEqual(["shared", "alice-only"]);
    expect(filterAccessibleResources(undefined, accounts).map((a) => a.id)).toEqual(["shared", "alice-only", "bob-only"]);
  });
});

describe("canAccessResource under multi-user auth", () => {
  afterEach(() => vi.restoreAllMocks());
  function mockAuth(enabled: boolean): void {
    vi.spyOn(configLoader, "getConfig").mockReturnValue(
      { auth: { enabled } } as unknown as ReturnType<typeof configLoader.getConfig>,
    );
  }

  it("fails CLOSED for a bound resource with no requesting user when auth is ON", () => {
    mockAuth(true);
    expect(canAccessResource(undefined, { allowedUsers: ["alice"] })).toBe(false);
  });

  it("still allows a bound resource with no user when auth is OFF (back-compat)", () => {
    mockAuth(false);
    expect(canAccessResource(undefined, { allowedUsers: ["alice"] })).toBe(true);
  });

  it("still shares unbound resources and enforces the allow-list under auth", () => {
    mockAuth(true);
    expect(canAccessResource(undefined, { allowedUsers: [] })).toBe(true);
    expect(canAccessResource("bob", {})).toBe(true);
    expect(canAccessResource("alice", { allowedUsers: ["alice"] })).toBe(true);
    expect(canAccessResource("bob", { allowedUsers: ["alice"] })).toBe(false);
  });
});

describe("resourceDeniedMessage", () => {
  it("names the kind + id without leaking whether the resource exists", () => {
    const msg = resourceDeniedMessage("mail account", "alice-only");
    expect(msg).toContain("mail account");
    expect(msg).toContain("alice-only");
    expect(msg).toContain("restricted to specific users");
    // Must not hint at existence beyond the id the caller already supplied.
    expect(msg.toLowerCase()).not.toContain("does not exist");
    expect(msg.toLowerCase()).not.toContain("not found");
  });
});
