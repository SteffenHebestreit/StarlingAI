import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { globToRegExp } from "../tools/code-navigation.js";

/**
 * glob_files / grep_files close the two questions the workspace could not answer:
 * "where are all the X files" and "show me every call site with its context".
 * list_files walks one directory per call; workspace_search ranks by relevance for a
 * concept rather than reporting every literal match.
 */
describe("globToRegExp", () => {
  const m = (pattern: string, path: string): boolean => globToRegExp(pattern).test(path);

  it("matches ** across any depth, including none", () => {
    expect(m("**/*.ts", "a.ts")).toBe(true);              // top level
    expect(m("**/*.ts", "src/a.ts")).toBe(true);
    expect(m("**/*.ts", "src/deep/nested/a.ts")).toBe(true);
    expect(m("**/*.ts", "src/a.js")).toBe(false);
  });

  it("keeps * inside a single segment", () => {
    expect(m("src/*.ts", "src/a.ts")).toBe(true);
    expect(m("src/*.ts", "src/deep/a.ts")).toBe(false);   // * must not cross /
  });

  it("supports brace alternation and ?", () => {
    expect(m("src/*.{ts,json}", "src/a.json")).toBe(true);
    expect(m("src/*.{ts,json}", "src/a.md")).toBe(false);
    expect(m("a?.ts", "ab.ts")).toBe(true);
    expect(m("a?.ts", "abc.ts")).toBe(false);
  });

  it("treats dots literally rather than as regex wildcards", () => {
    expect(m("*.ts", "axts")).toBe(false);
  });
});

describe("glob_files / grep_files", () => {
  const cleanup: string[] = [];
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "sai-nav-"));
    cleanup.push(ws);
    mkdirSync(join(ws, "src", "deep"), { recursive: true });
    mkdirSync(join(ws, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(ws, "src", "alpha.ts"), "export const alpha = 1;\ncallSite();\n");
    writeFileSync(join(ws, "src", "deep", "beta.ts"), "// beta\ncallSite();\nconst x = 2;\n");
    writeFileSync(join(ws, "src", "notes.md"), "callSite mentioned in prose\n");
    writeFileSync(join(ws, "node_modules", "pkg", "index.ts"), "callSite();\n");
  });

  afterEach(() => { for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true }); });

  async function tool(name: string) {
    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/code-navigation.js"),
    ]);
    return getTool(name)!;
  }
  const ctx = () => ({ sessionId: "s", workspacePath: ws }) as never;

  it("finds files by pattern across depths and skips node_modules", async () => {
    const r = await (await tool("glob_files")).execute({ pattern: "**/*.ts" }, ctx());
    expect(r.success).toBe(true);
    const paths = String(r.output).split("\n").sort();
    expect(paths).toEqual(["src/alpha.ts", "src/deep/beta.ts"]);   // node_modules excluded
  });

  it("reports every literal match with line numbers and context", async () => {
    const r = await (await tool("grep_files")).execute(
      { pattern: "callSite\\(\\)", glob: "**/*.ts", context: 1 }, ctx(),
    );
    expect(r.success).toBe(true);
    expect(r.metadata?.["matches"]).toBe(2);      // the .md prose mention is filtered out by the glob
    expect(r.metadata?.["files"]).toBe(2);
    expect(String(r.output)).toMatch(/src\/alpha\.ts:2/);
    expect(String(r.output)).toMatch(/> 2\t/);    // the matching line is marked
  });

  it("honours the glob filter", async () => {
    const r = await (await tool("grep_files")).execute({ pattern: "callSite", glob: "**/*.md" }, ctx());
    expect(r.metadata?.["matches"]).toBe(1);
  });

  it("rejects an invalid regular expression instead of matching nothing silently", async () => {
    const r = await (await tool("grep_files")).execute({ pattern: "[unclosed" }, ctx());
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Invalid regular expression/);
  });

  it("refuses a path that escapes the workspace", async () => {
    const r = await (await tool("glob_files")).execute({ pattern: "**/*", path: "../.." }, ctx());
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/within the workspace/);
  });

  it("reports truncation rather than silently capping", async () => {
    const r = await (await tool("glob_files")).execute({ pattern: "**/*.ts", limit: 1 }, ctx());
    expect(r.metadata?.["returned"]).toBe(1);
    expect(r.metadata?.["matched"]).toBe(2);
    expect(r.metadata?.["truncated"]).toBe(true);
  });
});
