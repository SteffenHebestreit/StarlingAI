/**
 * EVL-401: session workspace override resolution (gateway.sessionWorkspaceRoot).
 */
import { describe, expect, it } from "vitest";
import { join, resolve, sep } from "node:path";
import { resolveSessionWorkspaceOverride, type SessionWorkspaceCaller } from "../gateway/session-workspace.js";

const ALICE = "alice-0123456789abcdef";
const BOB = "bob-fedcba9876543210";
const DEPLOYMENT = resolve("/workspace");
const asAlice: SessionWorkspaceCaller = { ownSegment: ALICE, deploymentRoot: DEPLOYMENT };

describe("resolveSessionWorkspaceOverride", () => {
  it("legacy behavior when no root is configured: relative path passes through raw", () => {
    const r = resolveSessionWorkspaceOverride("eval/fixtures/twin-bug", undefined, asAlice);
    expect(r).toEqual({ ok: true, path: "eval/fixtures/twin-bug" });
  });

  it("resolves relative paths under the configured root", () => {
    const r = resolveSessionWorkspaceOverride("eval/fixtures/twin-bug", "/workspace", asAlice);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.path.endsWith(["eval", "fixtures", "twin-bug"].join(sep))).toBe(true);
      expect(r.path.includes("workspace")).toBe(true);
    }
  });

  it("rejects absolute POSIX, Windows, and UNC-style paths regardless of root", () => {
    for (const p of ["/etc/passwd", "C:/secrets", "c:\\secrets", "\\\\share\\x"]) {
      expect(resolveSessionWorkspaceOverride(p, "/workspace", asAlice).ok).toBe(false);
      expect(resolveSessionWorkspaceOverride(p, undefined, asAlice).ok).toBe(false);
    }
  });

  it("rejects traversal in any segment, including with a root configured", () => {
    for (const p of ["../outside", "a/../../outside", "a/..\\outside"]) {
      expect(resolveSessionWorkspaceOverride(p, "/workspace", asAlice).ok).toBe(false);
      expect(resolveSessionWorkspaceOverride(p, undefined, asAlice).ok).toBe(false);
    }
  });

  it("the root itself is reachable via '.'", () => {
    const r = resolveSessionWorkspaceOverride(".", "/workspace", asAlice);
    expect(r.ok).toBe(true);
  });
});

/**
 * The session roots itself at `<override>/users/<own segment>`, so an override naming another
 * account's root put the caller's session inside it: `users/<bob>` became `users/<bob>/users/<alice>`,
 * where bob's agents read what alice's write and the other way round.
 */
describe("resolveSessionWorkspaceOverride — another account's root", () => {
  it("refuses an override inside another account's root, at any depth and in any case", () => {
    for (const p of [
      `users/${BOB}`,
      `users/${BOB}/users/${ALICE}`,
      `users/${BOB}/generated`,
      `evals/users/${BOB}`,
      `Users/${BOB.toUpperCase()}`,
      "users",
      `users/${ALICE}/users/${BOB}`,
    ]) {
      const configured = resolveSessionWorkspaceOverride(p, "/workspace", asAlice);
      expect(configured.ok, p).toBe(false);
      if (!configured.ok) expect(configured.reason, p).toMatch(/not your own account's workspace/);
      expect(resolveSessionWorkspaceOverride(p, undefined, asAlice).ok, p).toBe(false);
    }
  });

  it("keeps the caller's own root and every path that names no account", () => {
    for (const p of [`users/${ALICE}`, `users/${ALICE}/evals/twin-bug`, `USERS/${ALICE.toUpperCase()}/x`, "eval/fixtures/twin-bug", "."]) {
      expect(resolveSessionWorkspaceOverride(p, "/workspace", asAlice).ok, p).toBe(true);
    }
  });

  it("refuses where the override lands in another account's root, not only what it names", () => {
    // A configured root that IS the users/ directory, or one inside an account's own tree.
    const intoBob = resolveSessionWorkspaceOverride(BOB, join(DEPLOYMENT, "users"), asAlice);
    expect(intoBob.ok).toBe(false);
    expect(resolveSessionWorkspaceOverride(ALICE, join(DEPLOYMENT, "users"), asAlice).ok).toBe(true);
    expect(resolveSessionWorkspaceOverride(".", join(DEPLOYMENT, "users", BOB, "evals"), asAlice).ok).toBe(false);
    expect(resolveSessionWorkspaceOverride(".", join(DEPLOYMENT, "users", ALICE, "evals"), asAlice).ok).toBe(true);
    // The legacy raw path resolves against the working directory, which can hold the deployment.
    const legacyDeployment = resolve("ws");
    expect(resolveSessionWorkspaceOverride("ws/x", undefined, { ownSegment: ALICE, deploymentRoot: legacyDeployment }).ok).toBe(true);
    expect(resolveSessionWorkspaceOverride(".", undefined, { ownSegment: ALICE, deploymentRoot: join(process.cwd(), "..") }).ok).toBe(true);
  });

  it("refuses every users/ path to a caller with no account of its own", () => {
    const nobody: SessionWorkspaceCaller = { ownSegment: undefined, deploymentRoot: DEPLOYMENT };
    expect(resolveSessionWorkspaceOverride(`users/${ALICE}`, "/workspace", nobody).ok).toBe(false);
    expect(resolveSessionWorkspaceOverride("eval/fixtures/twin-bug", "/workspace", nobody).ok).toBe(true);
  });
});
