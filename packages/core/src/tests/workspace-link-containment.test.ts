/**
 * GATEWAY-SIDE FILE ACCESS FOLLOWS NO LINK OUT OF ITS ZONE (review 2026-10-11).
 *
 * A sandbox can make links wherever it can write: an account's whole root, and generated/ of the
 * shared root for an auth-off session. The gateway's resolvers were lexical, and its writes followed
 * what a sandbox left: write_file to generated/evil.jsonc linked to ../agents/evil.jsonc overwrote a
 * config shard, and generated/up linked to .. reached the parent. containedWorkspaceRealPath holds a
 * path to its zone (its first segment under the root, users/<segment> for an account's directory)
 * through every link on the way, the resolvers apply it, and the write tools refuse a link as the
 * target itself, except delete_file, which removes the link.
 *
 * Real temp directories and real links. A link to a directory is a junction where this machine
 * cannot make symbolic links (Windows without the privilege); a junction always has an absolute
 * target. The cases that need a link to a FILE skip there, and run wherever symbolic links can be
 * made (Linux CI).
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithRequestContext } from "../runtime/request-context.js";
import { getTool, type ToolContext, type ToolResult } from "../tools/registry.js";
import { containedWorkspaceRealPath, resolvePathWithinWorkspace, resolveWorkspaceWritePath } from "../tools/workspace-path.js";

const ORIGINAL = "{ \"original\": true }\n";
const SECRET = "gateway-secret-canary";

/** Whether this machine can make a symbolic link to a file. */
const fileLinks = (() => {
  const dir = mkdtempSync(join(tmpdir(), "sai-link-probe-"));
  try {
    writeFileSync(join(dir, "f"), "");
    symlinkSync(join(dir, "f"), join(dir, "l"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
const FILE_LINK_REASON = "this machine cannot make a symbolic link to a file (Windows without the privilege); runs where it can";

/** Whether the temp directory's filesystem ignores case, as Windows and macOS do. */
const caseInsensitive = existsSync(tmpdir().toUpperCase()) && existsSync(tmpdir().toLowerCase());
const CASE_REASON = "needs a case-insensitive filesystem (Windows, macOS); a case-sensitive one has no other spelling of users/";

/** A link to a directory: a symbolic link, or a junction where the machine cannot make one. */
function linkDir(target: string, at: string): void {
  try {
    symlinkSync(target, at, "dir");
  } catch {
    symlinkSync(target, at, "junction");
  }
}

let ws = "";
let outside = "";

beforeAll(async () => {
  await import("../tools/filesystem.js");
});

beforeEach(() => {
  // The shared root of an auth-off deployment: the config zone, the state directory and generated/.
  ws = mkdtempSync(join(tmpdir(), "sai-link-ws-"));
  outside = mkdtempSync(join(tmpdir(), "sai-link-outside-"));
  mkdirSync(join(ws, "agents"), { recursive: true });
  writeFileSync(join(ws, "agents", "evil.jsonc"), ORIGINAL);
  mkdirSync(join(ws, ".starlingai"), { recursive: true });
  writeFileSync(join(ws, ".starlingai", "accounts.json"), ORIGINAL);
  mkdirSync(join(ws, "generated"), { recursive: true });
  writeFileSync(join(outside, "secret.txt"), SECRET);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(ws, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const unchanged = () => {
  expect(readFileSync(join(ws, "agents", "evil.jsonc"), "utf8")).toBe(ORIGINAL);
  expect(readFileSync(join(ws, ".starlingai", "accounts.json"), "utf8")).toBe(ORIGINAL);
};

function run(tool: string, args: Record<string, unknown>, scope: "generated" | "full" = "generated"): Promise<ToolResult> {
  const ctx: ToolContext = { sessionId: `s-link-${tool}`, workspacePath: ws, workspaceScope: scope };
  return runWithRequestContext({ workspaceScope: scope }, () => getTool(tool)!.execute(args, ctx));
}

describe("containedWorkspaceRealPath", () => {
  it("follows a path with no link to itself", () => {
    expect(containedWorkspaceRealPath(join(ws, "generated", "new", "a.txt"), ws)).not.toBeNull();
    expect(containedWorkspaceRealPath(join(ws, "agents", "evil.jsonc"), ws)).not.toBeNull();
  });

  it("refuses a link out of the workspace, into another zone, or into the state directory", () => {
    linkDir(outside, join(ws, "generated", "out"));
    linkDir(join(ws, "agents"), join(ws, "generated", "cfg"));
    linkDir(join(ws, ".starlingai"), join(ws, "generated", "state"));
    linkDir(ws, join(ws, "generated", "up"));
    for (const path of ["out/secret.txt", "out", "cfg/evil.jsonc", "cfg/new.jsonc", "state/accounts.json", "up/agents/evil.jsonc"]) {
      expect(containedWorkspaceRealPath(join(ws, "generated", path), ws), path).toBeNull();
    }
  });

  it("allows a link that stays in its zone", () => {
    mkdirSync(join(ws, "generated", "site"), { recursive: true });
    linkDir(join(ws, "generated", "site"), join(ws, "generated", "alias"));
    expect(containedWorkspaceRealPath(join(ws, "generated", "alias", "index.html"), ws)).not.toBeNull();
  });

  it("holds one account's directory apart from another's under the shared root", () => {
    const alice = join(ws, "users", "alice-0123456789abcdef");
    const bob = join(ws, "users", "bob-0123456789abcdef");
    mkdirSync(join(alice, "generated"), { recursive: true });
    mkdirSync(bob, { recursive: true });
    linkDir(bob, join(alice, "generated", "peek"));
    expect(containedWorkspaceRealPath(join(alice, "generated", "peek", "x"), ws)).toBeNull();
    expect(containedWorkspaceRealPath(join(alice, "generated", "peek", "x"), alice)).toBeNull();
  });

  it.skipIf(!caseInsensitive)(`holds them apart under any spelling of users/ (${CASE_REASON})`, () => {
    const aliceSegment = "alice-0123456789abcdef";
    mkdirSync(join(ws, "users", aliceSegment, "generated"), { recursive: true });
    mkdirSync(join(ws, "users", "bob-0123456789abcdef"), { recursive: true });
    linkDir(join(ws, "users", "bob-0123456789abcdef"), join(ws, "users", aliceSegment, "generated", "peek"));
    for (const users of ["USERS", "Users"]) {
      expect(containedWorkspaceRealPath(join(ws, users, aliceSegment, "generated", "peek", "x"), ws), users).toBeNull();
    }
    expect(containedWorkspaceRealPath(join(ws, "USERS", aliceSegment, "generated", "x"), ws)).not.toBeNull();
  });

  it("refuses a link that leads nowhere, and with final 'link' judges only where the link itself is", () => {
    linkDir(join(outside, "missing"), join(ws, "generated", "dangling"));
    expect(containedWorkspaceRealPath(join(ws, "generated", "dangling"), ws)).toBeNull();
    expect(containedWorkspaceRealPath(join(ws, "generated", "dangling", "new.txt"), ws)).toBeNull();
    expect(containedWorkspaceRealPath(join(ws, "generated", "dangling"), ws, { final: "link" })).not.toBeNull();
  });

  it("is applied by the resolvers", () => {
    linkDir(join(ws, "agents"), join(ws, "generated", "cfg"));
    expect(() => resolvePathWithinWorkspace("generated/cfg/evil.jsonc", ws)).toThrow(/workspace boundary/);
    expect(() => runWithRequestContext({ workspaceScope: "generated" }, () => resolveWorkspaceWritePath("cfg/evil.jsonc", ws))).toThrow(/workspace boundary/);
    expect(() => resolveWorkspaceWritePath("generated/cfg", ws, { final: "link" })).not.toThrow();
  });
});

describe("the write tools through a link in a directory on the way", () => {
  beforeEach(() => {
    linkDir(join(ws, "agents"), join(ws, "generated", "cfg"));
    linkDir(ws, join(ws, "generated", "up"));
    linkDir(join(ws, ".starlingai"), join(ws, "generated", "state"));
  });

  it("write_file refuses, and the target is unchanged", async () => {
    for (const path of ["cfg/evil.jsonc", "generated/up/agents/evil.jsonc", "state/accounts.json", "cfg/new.jsonc"]) {
      const result = await run("write_file", { path, content: "{ \"planted\": true }", mode: "overwrite" });
      expect(result.success, path).toBe(false);
    }
    unchanged();
    expect(existsSync(join(ws, "agents", "new.jsonc"))).toBe(false);
  });

  it("edit_file refuses, and the target is unchanged", async () => {
    const result = await run("edit_file", { path: "cfg/evil.jsonc", old_string: "true", new_string: "false" });
    expect(result.success).toBe(false);
    unchanged();
  });

  it("create_dir refuses, and nothing is created there", async () => {
    const result = await run("create_dir", { path: "cfg/sub" });
    expect(result.success).toBe(false);
    expect(existsSync(join(ws, "agents", "sub"))).toBe(false);
  });

  it("delete_file refuses, and the target is still there", async () => {
    const result = await run("delete_file", { path: "cfg/evil.jsonc" });
    expect(result.success).toBe(false);
    unchanged();
  });

  it("a full-scope agent's write through a link is refused too", async () => {
    const result = await run("write_file", { path: "generated/cfg/evil.jsonc", content: "{ \"planted\": true }", mode: "overwrite" }, "full");
    expect(result.success).toBe(false);
    unchanged();
  });

  it("list_files names a link and does not list what it leads to", async () => {
    linkDir(outside, join(ws, "generated", "out"));
    const result = await run("list_files", { path: ".", recursive: true });
    expect(result.success).toBe(true);
    expect(result.output).toContain("out");
    expect(result.output).not.toContain("secret.txt");
  });

  it("read_file refuses a link out of the workspace", async () => {
    linkDir(outside, join(ws, "generated", "out"));
    const result = await run("read_file", { path: "out/secret.txt" });
    expect(result.success).toBe(false);
    expect(result.output).not.toContain(SECRET);
  });
});

describe("the write tools on a link that is the target itself", () => {
  it("create_dir refuses a link to a directory, and delete_file removes the link and leaves what it leads to", async () => {
    linkDir(join(ws, "agents"), join(ws, "generated", "dirlink"));
    expect((await run("create_dir", { path: "dirlink" })).success).toBe(false);
    const removed = await run("delete_file", { path: "dirlink" });
    expect(removed.success).toBe(true);
    expect(existsSync(join(ws, "generated", "dirlink"))).toBe(false);
    unchanged();
  });

  it.skipIf(!fileLinks)(`write_file and edit_file refuse a link to a file, and delete_file removes only the link (${FILE_LINK_REASON})`, async () => {
    symlinkSync("../agents/evil.jsonc", join(ws, "generated", "evil.jsonc"));
    expect((await run("write_file", { path: "evil.jsonc", content: "{ \"planted\": true }", mode: "overwrite" })).success).toBe(false);
    expect((await run("edit_file", { path: "evil.jsonc", old_string: "true", new_string: "false" })).success).toBe(false);
    unchanged();
    // A link inside its zone is refused as a target as well: the write tools never write through one.
    writeFileSync(join(ws, "generated", "real.txt"), "real");
    symlinkSync("real.txt", join(ws, "generated", "alias.txt"));
    expect((await run("write_file", { path: "alias.txt", content: "changed", mode: "overwrite" })).success).toBe(false);
    expect(readFileSync(join(ws, "generated", "real.txt"), "utf8")).toBe("real");
    const removed = await run("delete_file", { path: "evil.jsonc" });
    expect(removed.success).toBe(true);
    expect(() => lstatSync(join(ws, "generated", "evil.jsonc"))).toThrow();
    unchanged();
  });

  it.skipIf(!fileLinks)(`write_file refuses a link that leads nowhere, which would create its target (${FILE_LINK_REASON})`, async () => {
    symlinkSync("../agents/new.jsonc", join(ws, "generated", "new.jsonc"));
    expect((await run("write_file", { path: "new.jsonc", content: "{}", mode: "create" })).success).toBe(false);
    expect(existsSync(join(ws, "agents", "new.jsonc"))).toBe(false);
  });

  it("a full-scope agent cannot write the state directory by name either", async () => {
    const result = await run("write_file", { path: ".starlingai/accounts.json", content: "{}", mode: "overwrite" }, "full");
    expect(result.success).toBe(false);
    unchanged();
  });

  it("an ordinary write still works", async () => {
    const result = await run("write_file", { path: "notes/today.md", content: "# Today\n\nAll fine.\n" });
    expect(result.success).toBe(true);
    expect(readFileSync(join(ws, "generated", "notes", "today.md"), "utf8")).toContain("All fine.");
    expect((await run("delete_file", { path: "notes/today.md" })).success).toBe(true);
  });
});
