import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Audit 3ccd8015 (turn 2): content_writer is told to "author compact Markdown
 * while the tool assembles the HTML", so it named pages `index.md` / `mic-overview.md`.
 * generate_website hard-rejected any non-.html page path → the whole tutorial-site
 * build failed three times across ~16 minutes before a lucky `.html` retry.
 * The tool now normalizes `.md`/.markdown/extensionless page paths to `.html`.
 */
const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function getGenerateWebsite() {
  const [{ getTool }] = await Promise.all([
    import("../tools/registry.js"),
    import("../tools/website.js"),
  ]);
  const tool = getTool("generate_website");
  expect(tool).toBeDefined();
  return tool!;
}

describe("generate_website — markdown page-path normalization", () => {
  it("accepts .md page paths and writes them as .html (the build no longer fails on index.md)", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "sai-website-md-"));
    tempDirs.push(workspace);
    const tool = await getGenerateWebsite();

    const result = await tool.execute(
      {
        outputDir: "site",
        title: "Tutorial",
        pages: [
          { path: "index.md", title: "Übersicht", content: "# Übersicht\n\nSee [details](mic-overview.html)." },
          { path: "mic-overview.md", title: "Mikrofon", content: "# Mikrofon\n\nPDM digital MEMS." },
        ],
      },
      { sessionId: "s1", workspacePath: workspace },
    );

    expect(result.success).toBe(true);
    // .md page paths were assembled into .html files (and the index requirement is met).
    expect(existsSync(join(workspace, "site", "index.html"))).toBe(true);
    expect(existsSync(join(workspace, "site", "mic-overview.html"))).toBe(true);
    // The literal .md names must NOT be written.
    expect(existsSync(join(workspace, "site", "index.md"))).toBe(false);
  });

  it("still rejects a genuinely foreign page extension", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "sai-website-bad-"));
    tempDirs.push(workspace);
    const tool = await getGenerateWebsite();

    const result = await tool.execute(
      {
        outputDir: "site",
        title: "Tutorial",
        pages: [{ path: "index.exe", title: "x", content: "# x" }],
      },
      { sessionId: "s2", workspacePath: workspace },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain(".html or .md");
  });
});
