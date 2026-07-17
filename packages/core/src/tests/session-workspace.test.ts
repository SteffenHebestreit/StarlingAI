/**
 * EVL-401: session workspace override resolution (gateway.sessionWorkspaceRoot).
 */
import { describe, expect, it } from "vitest";
import { sep } from "node:path";
import { resolveSessionWorkspaceOverride } from "../gateway/session-workspace.js";

describe("resolveSessionWorkspaceOverride", () => {
  it("legacy behavior when no root is configured: relative path passes through raw", () => {
    const r = resolveSessionWorkspaceOverride("eval/fixtures/twin-bug", undefined);
    expect(r).toEqual({ ok: true, path: "eval/fixtures/twin-bug" });
  });

  it("resolves relative paths under the configured root", () => {
    const r = resolveSessionWorkspaceOverride("eval/fixtures/twin-bug", "/workspace");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.path.endsWith(["eval", "fixtures", "twin-bug"].join(sep))).toBe(true);
      expect(r.path.includes("workspace")).toBe(true);
    }
  });

  it("rejects absolute POSIX, Windows, and UNC-style paths regardless of root", () => {
    for (const p of ["/etc/passwd", "C:/secrets", "c:\\secrets", "\\\\share\\x"]) {
      expect(resolveSessionWorkspaceOverride(p, "/workspace").ok).toBe(false);
      expect(resolveSessionWorkspaceOverride(p, undefined).ok).toBe(false);
    }
  });

  it("rejects traversal in any segment, including with a root configured", () => {
    for (const p of ["../outside", "a/../../outside", "a/..\\outside"]) {
      expect(resolveSessionWorkspaceOverride(p, "/workspace").ok).toBe(false);
      expect(resolveSessionWorkspaceOverride(p, undefined).ok).toBe(false);
    }
  });

  it("the root itself is reachable via '.'", () => {
    const r = resolveSessionWorkspaceOverride(".", "/workspace");
    expect(r.ok).toBe(true);
  });
});
