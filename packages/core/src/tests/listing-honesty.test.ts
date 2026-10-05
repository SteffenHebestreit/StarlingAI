import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A listing or a search must say what it did NOT look at. Each case below used to come back as a
 * clean, ordinary answer — an empty directory, a shorter directory, "No matches" — about something
 * the tool had never read. The model believes those answers (run 2026-09-26: ~700 iterations
 * looking for lines grep_files said were not there).
 *
 * Unreadable entries are simulated: a path containing UNREADABLE fails stat/readdir/readFile with
 * EACCES, a path containing NOLIST fails readdir only, one containing NOREAD fails readFile only.
 * Permission bits are not portable to Windows.
 */
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const eacces = (p: unknown): Error =>
    Object.assign(new Error(`EACCES: permission denied, '${String(p)}'`), { code: "EACCES" });
  const unreadable = (p: unknown): boolean => String(p).includes("UNREADABLE");
  const unlistable = (p: unknown): boolean => unreadable(p) || String(p).includes("NOLIST");
  const statSync = ((p: Parameters<typeof actual.statSync>[0], ...rest: unknown[]) => {
    if (unreadable(p)) throw eacces(p);
    return (actual.statSync as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof actual.statSync;
  const readdirSync = ((p: Parameters<typeof actual.readdirSync>[0], ...rest: unknown[]) => {
    if (unlistable(p)) throw eacces(p);
    // A directory with more entries than a walk visits; only its names matter.
    if (String(p).endsWith("HUGE")) {
      return Array.from({ length: 20_001 }, (_, i) => ({ name: `f${i}.txt`, isDirectory: () => false, isFile: () => true }));
    }
    return (actual.readdirSync as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof actual.readdirSync;
  const readFileSync = ((p: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) => {
    if (unreadable(p) || String(p).includes("NOREAD")) throw eacces(p);
    return (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof actual.readFileSync;
  return { ...actual, statSync, readdirSync, readFileSync, default: { ...actual, statSync, readdirSync, readFileSync } };
});

const cleanup: string[] = [];
afterEach(() => { for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function tool(name: string) {
  const [{ getTool }] = await Promise.all([
    import("../tools/registry.js"),
    import("../tools/filesystem.js"),
    import("../tools/code-navigation.js"),
  ]);
  return getTool(name)!;
}

describe("list_files says what it could not list", () => {
  let ws: string;
  const ctx = () => ({ sessionId: "s", workspacePath: ws }) as never;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "sai-listing-"));
    cleanup.push(ws);
    mkdirSync(join(ws, "dir"), { recursive: true });
    writeFileSync(join(ws, "dir", "a.txt"), "a");
    writeFileSync(join(ws, "dir", "b-UNREADABLE.txt"), "b");
    writeFileSync(join(ws, "dir", "c.txt"), "c");
    writeFileSync(join(ws, "notes.md"), "# twelve b\n");
    mkdirSync(join(ws, "NOLIST"), { recursive: true });
    mkdirSync(join(ws, "deep", "l1", "l2", "l3", "l4"), { recursive: true });
    writeFileSync(join(ws, "deep", "l1", "l2", "l3", "l4", "bottom.txt"), "x");
  });

  it("answers a file path with the file, not with an empty directory", async () => {
    const r = await (await tool("list_files")).execute({ path: "notes.md" }, ctx());
    expect(r.success).toBe(true);
    expect(String(r.output)).toBe("notes.md is a file (11 bytes), not a directory — use read_file to read it.");
    expect(String(r.output)).not.toMatch(/empty directory/);
  });

  it("lists every entry after one whose stat fails, and marks that one unreadable", async () => {
    const r = await (await tool("list_files")).execute({ path: "dir" }, ctx());
    expect(r.success).toBe(true);
    const out = String(r.output);
    expect(out).toContain("a.txt");
    expect(out, "the entries after the failing one vanished").toContain("c.txt");
    expect(out).toContain("b-UNREADABLE.txt (unreadable: EACCES)");
    expect(r.metadata?.["unreadable"]).toBe(1);
  });

  it("fails a directory it cannot read instead of calling it empty", async () => {
    const r = await (await tool("list_files")).execute({ path: "NOLIST" }, ctx());
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Could not list NOLIST: EACCES/);
  });

  it("marks a directory the recursive depth limit stopped at, with the path that opens it", async () => {
    const r = await (await tool("list_files")).execute({ path: "deep", recursive: true }, ctx());
    expect(r.success).toBe(true);
    const out = String(r.output);
    expect(out).toContain('l4/ (1 entry below the depth limit — list_files path="deep/l1/l2/l3/l4")');
    expect(out).toMatch(/1 directory was not expanded/);
    expect(r.metadata?.["cutByDepth"]).toBe(1);
  });
});

describe("glob_files / grep_files say what their walk could not cover", () => {
  let ws: string;
  const ctx = () => ({ sessionId: "s", workspacePath: ws }) as never;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "sai-walk-"));
    cleanup.push(ws);
    mkdirSync(join(ws, "src", "NOLIST-dir"), { recursive: true });
    writeFileSync(join(ws, "src", "NOLIST-dir", "hidden.ts"), "needle();\n");
    writeFileSync(join(ws, "src", "UNREADABLE.ts"), "needle();\n");
    writeFileSync(join(ws, "src", "ok.ts"), "needle();\n");
    writeFileSync(join(ws, "NOREAD.ts"), "needle();\n");
    mkdirSync(join(ws, "HUGE"), { recursive: true });
  });

  it("names a directory it could not open", async () => {
    const r = await (await tool("glob_files")).execute({ pattern: "**/*.ts" }, ctx());
    expect(r.success).toBe(true);
    expect(String(r.output)).toMatch(/Not searched, could not be read: src\/NOLIST-dir \(EACCES\)\./);
    const g = await (await tool("grep_files")).execute({ pattern: "needle", path: "src" }, ctx());
    expect(String(g.output)).toMatch(/Not searched, could not be read: NOLIST-dir \(EACCES\)\./);
  });

  it("names a file it could not read, and fails when that file was the one asked for", async () => {
    const dir = await (await tool("grep_files")).execute({ pattern: "needle", path: "src" }, ctx());
    expect(dir.metadata?.["matches"]).toBe(1);
    expect(String(dir.output)).toMatch(/Not searched, unreadable: EACCES: src\/UNREADABLE\.ts\./);

    const unstat = await (await tool("grep_files")).execute({ pattern: "needle", path: "src/UNREADABLE.ts" }, ctx());
    expect(unstat.success).toBe(false);
    expect(unstat.error).toBe("Could not read src/UNREADABLE.ts: EACCES — nothing was searched.");
    const unread = await (await tool("grep_files")).execute({ pattern: "needle", path: "NOREAD.ts" }, ctx());
    expect(unread.success).toBe(false);
    expect(unread.error).toMatch(/^Not searched: NOREAD\.ts — unreadable: EACCES\./);
  });

  it("fails when the directory asked for cannot be read at all", async () => {
    const r = await (await tool("grep_files")).execute({ pattern: "needle", path: "src/NOLIST-dir" }, ctx());
    expect(r.success).toBe(false);
    expect(r.error).toBe("Could not read src/NOLIST-dir: EACCES — nothing was searched.");
  });

  it("says where it stopped when the walk hit its entry cap", async () => {
    const r = await (await tool("glob_files")).execute({ pattern: "**/*.md", path: "HUGE" }, ctx());
    expect(r.success).toBe(true);
    expect(String(r.output)).toMatch(/^No files match \*\*\/\*\.md\.\n\nStopped after 20000 entries — the rest of the tree was not searched/);
    expect(r.metadata?.["walkStoppedAfter"]).toBe(20_000);
  });
});
