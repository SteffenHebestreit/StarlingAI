/**
 * A WORKSPACE PATH IS HELD TO ITS ZONE WHEN IT IS OPENED, NOT ONLY WHEN IT IS RESOLVED (review
 * 2026-10-11).
 *
 * containedWorkspaceRealPath judged a path when the file tools resolved it, and they then read or
 * wrote by path again, following whatever was on the way by then. A sandbox runs at the same time as
 * the gateway (every sandbox of an account has its whole root, serve_app's containers run for
 * minutes), so it could swap a directory on the way for a link to agents/ in between.
 * withContainedWorkspaceFile, makeContainedWorkspaceDir and removeContainedWorkspaceFile hold the
 * path to its zone again as they open it: on Linux through /proc/self/fd, elsewhere by checking again
 * right before the open.
 *
 * The race is made deterministic: the swap happens inside the tools' own resolve-time check
 * (containedWorkspaceRealPath as tools/workspace-path.ts exports it), after that check has passed.
 * Real temp directories and real links; a link to a directory is a junction where this machine
 * cannot make symbolic links.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithRequestContext } from "../runtime/request-context.js";
import { getTool, type ToolContext, type ToolResult } from "../tools/registry.js";
import {
  isWorkspaceContainmentError,
  makeContainedWorkspaceDir,
  removeContainedWorkspaceFile,
  withContainedWorkspaceFile,
} from "../tools/workspace-containment.js";

/** Runs once, right after the next resolve-time check the file tools make has passed. */
let afterCheck: (() => void) | null = null;

vi.mock("../tools/workspace-path.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools/workspace-path.js")>();
  return {
    ...actual,
    containedWorkspaceRealPath: (...args: Parameters<typeof actual.containedWorkspaceRealPath>) => {
      const result = actual.containedWorkspaceRealPath(...args);
      const swap = afterCheck;
      afterCheck = null;
      swap?.();
      return result;
    },
  };
});

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
const sub = () => join(ws, "generated", "sub");

/** What a sandbox does between the check and the open: generated/sub becomes a link to `to`. */
const swapSubFor = (to: string) => () => {
  rmSync(sub(), { recursive: true, force: true });
  linkDir(to, sub());
};

beforeAll(async () => {
  await import("../tools/filesystem.js");
});

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "sai-open-ws-"));
  outside = mkdtempSync(join(tmpdir(), "sai-open-outside-"));
  mkdirSync(join(ws, "agents"), { recursive: true });
  writeFileSync(join(ws, "agents", "evil.jsonc"), ORIGINAL);
  mkdirSync(sub(), { recursive: true });
  writeFileSync(join(sub(), "evil.jsonc"), "in the zone\n");
  writeFileSync(join(outside, "secret.txt"), SECRET);
});

afterEach(() => {
  afterCheck = null;
  rmSync(ws, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const unchanged = () => {
  expect(readdirSync(join(ws, "agents"))).toEqual(["evil.jsonc"]);
  expect(readFileSync(join(ws, "agents", "evil.jsonc"), "utf8")).toBe(ORIGINAL);
};

function run(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
  const ctx: ToolContext = { sessionId: `s-open-${tool}`, workspacePath: ws, workspaceScope: "generated" };
  return runWithRequestContext({ workspaceScope: "generated" }, () => getTool(tool)!.execute(args, ctx));
}

describe("the file tools, with a directory on the way swapped for a link after their check", () => {
  it("write_file writes nothing through it", async () => {
    afterCheck = swapSubFor(join(ws, "agents"));
    const result = await run("write_file", { path: "sub/evil.jsonc", content: "{ \"planted\": true }", mode: "overwrite" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/escapes workspace boundary/);
    unchanged();
  });

  it("write_file creates nothing through it", async () => {
    afterCheck = swapSubFor(join(ws, "agents"));
    const result = await run("write_file", { path: "sub/new.jsonc", content: "{ \"planted\": true }", mode: "create" });
    expect(result.success).toBe(false);
    unchanged();
  });

  it("edit_file changes nothing through it", async () => {
    afterCheck = swapSubFor(join(ws, "agents"));
    const result = await run("edit_file", { path: "sub/evil.jsonc", old_string: "true", new_string: "false" });
    expect(result.success).toBe(false);
    unchanged();
  });

  it("create_dir makes nothing through it", async () => {
    afterCheck = swapSubFor(join(ws, "agents"));
    const result = await run("create_dir", { path: "sub/planted" });
    expect(result.success).toBe(false);
    unchanged();
  });

  it("delete_file removes nothing through it", async () => {
    afterCheck = swapSubFor(join(ws, "agents"));
    const result = await run("delete_file", { path: "sub/evil.jsonc" });
    expect(result.success).toBe(false);
    unchanged();
  });

  it("read_file reads nothing through it", async () => {
    afterCheck = swapSubFor(outside);
    const result = await run("read_file", { path: "sub/secret.txt" });
    expect(result.success).toBe(false);
    expect(result.output).not.toContain(SECRET);
  });

  it("and without a swap each of them works", async () => {
    expect((await run("write_file", { path: "sub/deep/new.md", content: "# New\n" })).success).toBe(true);
    expect((await run("write_file", { path: "sub/deep/new.md", content: "more\n", mode: "append" })).output).toContain("now 11 chars total");
    expect((await run("edit_file", { path: "sub/deep/new.md", old_string: "more", new_string: "less" })).success).toBe(true);
    expect((await run("read_file", { path: "sub/deep/new.md" })).output).toBe("# New\nless\n");
    expect((await run("create_dir", { path: "sub/a/b/c" })).success).toBe(true);
    expect(existsSync(join(sub(), "a", "b", "c"))).toBe(true);
    expect((await run("delete_file", { path: "sub/deep/new.md" })).success).toBe(true);
    expect(existsSync(join(sub(), "deep", "new.md"))).toBe(false);
  });
});

describe("withContainedWorkspaceFile and its siblings, called after a swap", () => {
  const target = () => join(sub(), "evil.jsonc");

  it("refuse every open, make and remove through the link", () => {
    swapSubFor(join(ws, "agents"))();
    for (const mode of ["read", "edit", "write", "create"] as const) {
      expect(() => withContainedWorkspaceFile(target(), ws, { mode, createDirs: true }, (file) => file.replace("planted")), mode)
        .toThrow(/escapes workspace boundary/);
    }
    expect(() => makeContainedWorkspaceDir(join(sub(), "planted", "deeper"), ws)).toThrow(/escapes workspace boundary/);
    expect(() => removeContainedWorkspaceFile(target(), ws)).toThrow(/escapes workspace boundary/);
    unchanged();
  });

  it("throw a WorkspaceContainmentError for a path outside the root", () => {
    let thrown: unknown;
    try {
      withContainedWorkspaceFile(join(outside, "secret.txt"), ws, { mode: "read" }, (file) => file.read());
    } catch (err) {
      thrown = err;
    }
    expect(isWorkspaceContainmentError(thrown)).toBe(true);
  });
});

describe("withContainedWorkspaceFile on an ordinary path", () => {
  it("opens without truncating, then replaces, appends and reads through the descriptor", () => {
    const path = join(ws, "generated", "notes", "today.md");
    const created = withContainedWorkspaceFile(path, ws, { mode: "write", createDirs: true }, (file) => {
      file.replace("first\n");
      return file.created;
    });
    expect(created).toBe(true);
    const seen = withContainedWorkspaceFile(path, ws, { mode: "write" }, (file) => {
      const before = file.read().toString("utf8");
      file.append("second\n");
      return { before, created: file.created, after: file.read().toString("utf8") };
    });
    expect(seen).toEqual({ before: "first\n", created: false, after: "first\nsecond\n" });
    withContainedWorkspaceFile(path, ws, { mode: "edit" }, (file) => file.replace("x"));
    expect(readFileSync(path, "utf8")).toBe("x");
  });

  it("says ENOENT, EEXIST and EISDIR as the plain calls did", () => {
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (err) {
        return (err as NodeJS.ErrnoException).code;
      }
      return "none";
    };
    expect(code(() => withContainedWorkspaceFile(join(sub(), "missing.txt"), ws, { mode: "read" }, () => 0))).toBe("ENOENT");
    expect(code(() => withContainedWorkspaceFile(join(sub(), "missing.txt"), ws, { mode: "edit" }, () => 0))).toBe("ENOENT");
    expect(code(() => withContainedWorkspaceFile(join(sub(), "evil.jsonc"), ws, { mode: "create" }, () => 0))).toBe("EEXIST");
    expect(code(() => removeContainedWorkspaceFile(sub(), ws))).toBe("EISDIR");
    expect(code(() => removeContainedWorkspaceFile(join(sub(), "missing.txt"), ws))).toBe("ENOENT");
  });

  it("reads through a link that keeps the file in its zone, as the resolver allows", () => {
    linkDir(sub(), join(ws, "generated", "alias"));
    const content = withContainedWorkspaceFile(join(ws, "generated", "alias", "evil.jsonc"), ws, { mode: "read" }, (file) => file.read().toString("utf8"));
    expect(content).toBe("in the zone\n");
  });

  it("applies the caller's own refusal to where the file really is", () => {
    expect(() => withContainedWorkspaceFile(join(sub(), "evil.jsonc"), ws, { mode: "read", refuse: (real) => real.endsWith("evil.jsonc") }, () => 0))
      .toThrow(/escapes workspace boundary/);
  });

  it.skipIf(!fileLinks)(`opens no link at the file's own name for a write (${FILE_LINK_REASON})`, () => {
    symlinkSync(join(sub(), "evil.jsonc"), join(sub(), "alias.jsonc"));
    for (const mode of ["edit", "write", "create"] as const) {
      expect(() => withContainedWorkspaceFile(join(sub(), "alias.jsonc"), ws, { mode }, (file) => file.replace("planted")), mode).toThrow();
    }
    expect(readFileSync(join(sub(), "evil.jsonc"), "utf8")).toBe("in the zone\n");
  });

  it.skipIf(process.platform === "win32")("refuses a fifo planted under a file's name, without hanging on it (no fifos on Windows)", () => {
    execFileSync("mkfifo", [join(sub(), "pipe.txt")]);
    expect(() => withContainedWorkspaceFile(join(sub(), "pipe.txt"), ws, { mode: "read" }, (file) => file.read())).toThrow(/Not a regular file/);
  });
});
