import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { globToRegExp } from "../tools/code-navigation.js";
import { runWithRequestContext } from "../runtime/request-context.js";

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
    // Beside real results the skipped directory is metadata only, not a nudge into dependencies.
    expect(r.metadata?.["notDescended"]).toEqual(["node_modules"]);
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

/**
 * A DEFAULT ROOT IS STILL A ROOT.
 *
 * Both tools resolved an EXPLICIT `path` through the zone-aware resolver and then took
 * ctx.workspacePath RAW when none was given — so the confinement applied only to the callers
 * who named a directory. A scope-confined agent calling glob_files with just a pattern listed
 * the platform's own config zones and docs, which is the thing scoping exists to prevent.
 * workspace-search.ts resolves "." for exactly this reason, with a comment saying so.
 */
describe("glob_files / grep_files respect the working zone by default", () => {
  const cleanup: string[] = [];
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "sai-nav-zone-"));
    cleanup.push(ws);
    mkdirSync(join(ws, "agents"), { recursive: true });
    mkdirSync(join(ws, "generated", "app"), { recursive: true });
    writeFileSync(join(ws, "agents", "10-core-agents.jsonc"), "{ \"secret\": \"platform config\" }\n");
    writeFileSync(join(ws, "generated", "app", "index.ts"), "const mine = 1;\n");
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
  const scoped = <T,>(fn: () => T): T => runWithRequestContext({ workspaceScope: "generated" }, fn);

  it("globs only the working zone for a scope-confined agent", async () => {
    const t = await tool("glob_files");
    const r = await scoped(() => t.execute({ pattern: "**/*" }, ctx()));
    const out = String(r.output);
    expect(out).toContain("index.ts");
    expect(out).not.toContain("10-core-agents.jsonc");
  });

  it("greps only the working zone for a scope-confined agent", async () => {
    const t = await tool("grep_files");
    const r = await scoped(() => t.execute({ pattern: "platform config" }, ctx()));
    expect(String(r.output)).not.toContain("10-core-agents.jsonc");
  });

  it("still sees the whole workspace when the agent is not scope-confined — the discriminator", async () => {
    // Core/maintenance agents and runtime internals run unscoped and maintain those very
    // files; confining them would be a different bug.
    const t = await tool("glob_files");
    const r = await t.execute({ pattern: "**/*.jsonc" }, ctx());
    expect(String(r.output)).toContain("10-core-agents.jsonc");
  });
});

/**
 * "NO MATCHES" MUST MEAN THE FILE WAS SEARCHED.
 *
 * Run c297c5ea: generate_presentation inlined ten photos into the deck, index.html came to 3.9 MB, and
 * the content_writer grepped it nearly 300 times for a script tag that was there. A path naming a file
 * searched nothing (the walk only descends directories), a file over the size limit was skipped without
 * a word, and both answered "No matches" — which the model believed.
 */
describe("grep_files answers for what it searched", () => {
  const cleanup: string[] = [];
  let ws: string;
  const photo = `<img src="data:image/jpeg;base64,${"QUJD".repeat(750_000)}">`;   // one 3 MB line

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "sai-nav-big-"));
    cleanup.push(ws);
    mkdirSync(join(ws, "generated", "presentation"), { recursive: true });
    writeFileSync(join(ws, "generated", "presentation", "index.html"), [
      "<!DOCTYPE html>",
      "<section>",
      `  ${photo}`,
      "</section>",
      "<script src=\"reveal.js\"></script>",
      "<script>Reveal.initialize({ hash: true });</script>",
    ].join("\n"));
    writeFileSync(join(ws, "generated", "presentation", "notes.md"), "# Notes\nexport this deck\n");
    writeFileSync(join(ws, ".env"), "SECRET=1\n");
  });

  afterEach(() => { for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true }); });

  async function grep(args: Record<string, unknown>) {
    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/code-navigation.js"),
    ]);
    return getTool("grep_files")!.execute(args, { sessionId: "s", workspacePath: ws } as never);
  }

  it("searches the file a path names, however it was generated", async () => {
    const r = await grep({ pattern: "Reveal\.initialize", path: "generated/presentation/index.html" });
    expect(r.success).toBe(true);
    expect(r.metadata?.["matches"]).toBe(1);
    expect(String(r.output)).toContain("generated/presentation/index.html:6");
  });

  it("shows a window of a megabyte line around the match, not the line", async () => {
    const r = await grep({ pattern: "data:image", path: "generated/presentation/index.html", context: 1 });
    expect(r.metadata?.["matches"]).toBe(1);
    const out = String(r.output);
    expect(out).toContain("data:image/jpeg;base64,");
    expect(out).toMatch(/chars not shown/);
    expect(out.length).toBeLessThan(2_000);
  });

  it("names a file a directory search passed over for its size, instead of answering no matches", async () => {
    const r = await grep({ pattern: "Reveal", path: "generated/presentation" });
    expect(r.metadata?.["matches"]).toBe(0);
    expect(r.metadata?.["notSearchedTooLarge"]).toBe(1);
    expect(String(r.output)).toMatch(/Not searched, larger than \d+ bytes: generated\/presentation\/index\.html/);
  });

  it("reads ^ at the start of every line, not only the file's first", async () => {
    const r = await grep({ pattern: "^export", path: "generated/presentation" });
    expect(r.metadata?.["matches"]).toBe(1);
    expect(String(r.output)).toContain("generated/presentation/notes.md:2");
  });

  it("refuses a named secret as read_file does", async () => {
    const r = await grep({ pattern: "SECRET", path: ".env" });
    expect(r.success).toBe(false);
    expect(String(r.output)).not.toContain("SECRET=1");
  });
});

/**
 * EVERY GAP IN THE SEARCH IS PART OF THE ANSWER.
 *
 * Each case below used to come back as a plain "No matches" / "No files match" / a list that read as
 * complete: a UTF-16 file (every second byte NUL) dropped as binary, a named file that was never read,
 * a dist/ directory the glob asked for and the walk skipped anyway, a result list cut at the limit.
 */
describe("glob_files / grep_files report what they did not search", () => {
  const cleanup: string[] = [];
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "sai-nav-gaps-"));
    cleanup.push(ws);
    mkdirSync(join(ws, "src"), { recursive: true });
    mkdirSync(join(ws, "dist", "lib"), { recursive: true });
    mkdirSync(join(ws, "logs"), { recursive: true });
    const text = "first line\nneedle in a UTF-16 file\n";
    writeFileSync(join(ws, "logs", "le.txt"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]));
    writeFileSync(join(ws, "logs", "be.txt"), Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, "utf16le").swap16()]));
    writeFileSync(join(ws, "logs", "blob.dat"), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00, 0x01, 0x02]));
    writeFileSync(join(ws, "src", "a.ts"), "needle();\nneedle();\n");
    writeFileSync(join(ws, "dist", "lib", "bundle.js"), "needle();\n");
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

  it("decodes a UTF-16 file with a byte-order mark, little- and big-endian", async () => {
    for (const file of ["logs/le.txt", "logs/be.txt"]) {
      const r = await (await tool("grep_files")).execute({ pattern: "needle", path: file }, ctx());
      expect(r.success, file).toBe(true);
      expect(r.metadata?.["matches"], file).toBe(1);
      expect(String(r.output)).toContain(`${file}:2`);
    }
  });

  it("fails a named file it could not search instead of answering no matches", async () => {
    const r = await (await tool("grep_files")).execute({ pattern: "needle", path: "logs/blob.dat" }, ctx());
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/^Not searched: logs\/blob\.dat — binary content/);
  });

  it("counts binary files a directory search passed over, and skips known binary types silently", async () => {
    writeFileSync(join(ws, "logs", "font.ttf"), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00]));
    writeFileSync(join(ws, "logs", "cache.sqlite"), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00]));
    const r = await (await tool("grep_files")).execute({ pattern: "needle", path: "logs" }, ctx());
    expect(r.success).toBe(true);
    expect(r.metadata?.["matches"]).toBe(2);
    expect(String(r.output)).toContain("1 file(s) with binary content (NUL bytes) were not searched.");
    expect(String(r.output)).not.toMatch(/blob\.dat|font\.ttf|cache\.sqlite/);
  });

  it("descends a skipped directory the glob names, and says when it skipped one", async () => {
    const named = await (await tool("glob_files")).execute({ pattern: "dist/**/*.js" }, ctx());
    expect(String(named.output).split("\n\n")[0]).toBe("dist/lib/bundle.js");
    const grepNamed = await (await tool("grep_files")).execute({ pattern: "needle", glob: "dist/**" }, ctx());
    expect(grepNamed.metadata?.["matches"]).toBe(1);

    const unnamed = await (await tool("grep_files")).execute({ pattern: "needle", glob: "**/*.js" }, ctx());
    expect(unnamed.metadata?.["matches"]).toBe(0);
    expect(String(unnamed.output)).toContain("Not searched, skipped as generated or vendored: dist/. If what you are looking for is generated output, name its directory in path or the glob.");
  });

  it("names skipped directories only for an empty result, and never names a dependency directory", async () => {
    mkdirSync(join(ws, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(ws, "node_modules", "pkg", "index.js"), "needle();\n");
    const found = await (await tool("grep_files")).execute({ pattern: "needle" }, ctx());
    expect(found.metadata?.["matches"]).toBeGreaterThan(0);
    expect(String(found.output)).not.toMatch(/skipped as generated|node_modules/);

    const none = await (await tool("grep_files")).execute({ pattern: "absent-token" }, ctx());
    expect(String(none.output)).toContain("Not searched, skipped as generated or vendored: dist/; 1 installed-dependency directory.");
    expect(String(none.output)).not.toContain("node_modules");
  });

  it("does not report a skipped directory the pattern could not reach into", async () => {
    const r = await (await tool("glob_files")).execute({ pattern: "src/*.md" }, ctx());
    expect(String(r.output)).toBe("No files match src/*.md.");
  });

  it("says how many results the limit cut, and how to get them", async () => {
    const grep = await (await tool("grep_files")).execute({ pattern: "needle", path: "src", limit: 1 }, ctx());
    expect(String(grep.output)).toMatch(/Showing 1 of ≥1 matches — the search stopped at the limit.*Raise limit \(max 500\)/);
    const glob = await (await tool("glob_files")).execute({ pattern: "logs/*.txt", limit: 1 }, ctx());
    expect(String(glob.output)).toMatch(/Showing 1 of 2 matching paths, most recently modified first — raise limit \(max 300\)/);
  });
});
