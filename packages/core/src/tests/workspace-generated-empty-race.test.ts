/**
 * DELETE /api/workspace/generated REMOVES A DIRECTORY IN THE DIRECTORY IT REALLY IS IN (review
 * 2026-10-12).
 *
 * The walk checked that a directory was under generated/ and then removed it by name. An account's
 * own sandbox has its root read-write, so it can swap a directory on the way for a link in between,
 * and the removal then took an empty directory wherever the link led: another account's, a config
 * zone's. removeContainedWorkspaceDir holds the removal to generated/: on Linux it removes the
 * directory in the open parent it was found in (/proc/self/fd), elsewhere it checks again right
 * before, which narrows the window without closing it.
 *
 * Both races are made deterministic:
 *   - the route's: a sandbox that swaps generated/site for a link after every check the route makes
 *     of generated/site/empty (containedWorkspaceRealPath as tools/workspace-path.ts exports it), and
 *     puts it back before the next one. Real links; junctions where symbolic links cannot be made.
 *   - the helper's own: the swap lands inside rmdirSync, after every check by path. Only the removal
 *     in the open parent holds there, so that case runs on Linux only.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as configLoader from "../config/loader.js";
import { registerWorkspaceRoutes } from "../gateway/workspace-routes.js";
import { createToken } from "../gateway/auth.js";
import { safeUserSegment } from "../runtime/user-scope.js";
import { removeContainedWorkspaceDir } from "../tools/workspace-containment.js";

/** The path whose every check by the route is followed by the sandbox's swap, and undone before. */
let watched: string | null = null;
let swapIn: () => void = () => undefined;
let swapOut: () => void = () => undefined;

vi.mock("../tools/workspace-path.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools/workspace-path.js")>();
  return {
    ...actual,
    containedWorkspaceRealPath: (...args: Parameters<typeof actual.containedWorkspaceRealPath>) => {
      const hit = watched !== null && resolve(String(args[0])) === watched;
      if (hit) swapOut();
      const result = actual.containedWorkspaceRealPath(...args);
      if (hit) swapIn();
      return result;
    },
  };
});

/** Runs once, inside the next rmdirSync, before the directory is removed. */
let beforeRmdir: (() => void) | null = null;

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const rmdirSync = ((...args: Parameters<typeof real.rmdirSync>) => {
    const swap = beforeRmdir;
    beforeRmdir = null;
    swap?.();
    return real.rmdirSync(...args);
  }) as typeof real.rmdirSync;
  return { ...real, rmdirSync, default: { ...real, rmdirSync } };
});

/** A link to a directory: a symbolic link, or a junction where the machine cannot make one. */
function linkDir(target: string, at: string): void {
  try {
    symlinkSync(target, at, "dir");
  } catch {
    symlinkSync(target, at, "junction");
  }
}

describe("emptying generated/ while a sandbox swaps a directory on the way for a link", () => {
  const ws = mkdtempSync(join(tmpdir(), "sai-route-empty-race-"));
  const root = (user: string) => join(ws, "users", safeUserSegment(user));
  const zone = (user: string) => join(root(user), "generated");
  const site = () => join(zone("alice"), "site");

  process.env["SAI_JWT_SECRET"] = "workspace-generated-empty-race-test-secret-key";
  const config = {
    auth: { enabled: true, provider: "builtin", users: [] },
    workspacePath: ws,
    gateway: { jwtSecret: "workspace-generated-empty-race-test-secret-key" },
  };
  vi.spyOn(configLoader, "getConfig").mockImplementation(() => config as unknown as ReturnType<typeof configLoader.getConfig>);

  const app = new Hono();
  registerWorkspaceRoutes(app);

  beforeEach(() => {
    rmSync(join(ws, "users"), { recursive: true, force: true });
    // alice's turn left an empty directory; bob's generated/ and alice's config zone hold empty ones too.
    mkdirSync(join(site(), "empty"), { recursive: true });
    mkdirSync(join(zone("bob"), "empty"), { recursive: true });
    writeFileSync(join(zone("bob"), "brief.md"), "bob's", "utf8");
    mkdirSync(join(root("alice"), "agents", "empty"), { recursive: true });
  });

  afterEach(() => {
    watched = null;
    beforeRmdir = null;
    vi.clearAllMocks();
  });
  afterAll(() => { rmSync(ws, { recursive: true, force: true }); });

  it("removes no empty directory of another account's when generated/site turns into a link after every check", async () => {
    // generated/site becomes a link to bob's generated/ right after each check of site/empty passes,
    // and a directory again before the next: the route's own checks all pass.
    watched = resolve(join(site(), "empty"));
    swapIn = () => {
      if (lstatSync(site()).isSymbolicLink()) return;
      rmSync(site(), { recursive: true, force: true });
      linkDir(zone("bob"), site());
    };
    swapOut = () => {
      if (!lstatSync(site()).isSymbolicLink()) return;
      unlinkSync(site());
      mkdirSync(join(site(), "empty"), { recursive: true });
    };
    const token = await createToken("alice");
    const res = await app.request("/api/workspace/generated", { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    // The sandbox did swap.
    expect(lstatSync(site()).isSymbolicLink()).toBe(true);
    expect(existsSync(join(zone("bob"), "empty"))).toBe(true);
    expect(existsSync(join(zone("bob"), "brief.md"))).toBe(true);
    expect(res.status).toBe(500);
  });

  it.skipIf(process.platform !== "linux")("removes the directory in the open parent, whatever a swap inside the removal did (Linux: /proc/self/fd; elsewhere only narrowed)", () => {
    // The swap lands after every check by path: generated/site becomes a link to alice's config zone,
    // whose empty directory has the same name.
    beforeRmdir = () => {
      rmSync(site(), { recursive: true, force: true });
      linkDir(join(root("alice"), "agents"), site());
    };
    // The open parent is the directory site was; the empty directory in it went with it.
    expect(() => removeContainedWorkspaceDir(join(site(), "empty"), root("alice"))).toThrow(/ENOENT/);
    expect(beforeRmdir).toBeNull();
    expect(lstatSync(site()).isSymbolicLink()).toBe(true);
    expect(existsSync(join(root("alice"), "agents", "empty"))).toBe(true);
  });

  it("removes an empty directory under generated/, and refuses a full one, a link at the name, and one a link takes out of it", () => {
    removeContainedWorkspaceDir(join(site(), "empty"), root("alice"));
    expect(existsSync(join(site(), "empty"))).toBe(false);

    writeFileSync(join(site(), "page.html"), "<h1>x</h1>", "utf8");
    expect(() => removeContainedWorkspaceDir(site(), root("alice"))).toThrow(/ENOTEMPTY|EEXIST|EPERM/);
    expect(existsSync(join(site(), "page.html"))).toBe(true);

    linkDir(zone("bob"), join(zone("alice"), "bob-link"));
    expect(() => removeContainedWorkspaceDir(join(zone("alice"), "bob-link"), root("alice"))).toThrow(/ENOTDIR/);
    expect(() => removeContainedWorkspaceDir(join(zone("alice"), "bob-link", "empty"), root("alice"))).toThrow(/escapes workspace boundary/);
    expect(existsSync(join(zone("bob"), "empty"))).toBe(true);

    expect(() => removeContainedWorkspaceDir(root("alice"), root("alice"))).toThrow(/escapes workspace boundary/);
  });
});
