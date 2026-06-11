import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTool } from "../tools/registry.js";
import "../tools/website.js";
import "../tools/document-output.js";

// generate_presentation + generate_document root agent output under generated/,
// so the deck, its images, the notes, and the paper all co-locate in ONE
// generated/<dir> tree (not a stray workspace/<dir>).
const IMG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

describe("generate_presentation — self-contained deck under generated/", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "deck-"));
    mkdirSync(join(ws, "generated", "presentation", "images"), { recursive: true });
    writeFileSync(join(ws, "generated", "presentation", "images", "x.png"), IMG_BYTES);
  });
  afterEach(() => { rmSync(ws, { recursive: true, force: true }); });

  it("writes under generated/, inlines co-located local images, leaves remote URLs, and emits notes.md", async () => {
    const tool = getTool("generate_presentation");
    expect(tool).toBeDefined();
    const ctx = { sessionId: "t", workspacePath: ws } as unknown as Parameters<NonNullable<typeof tool>["execute"]>[1];

    const res = await tool!.execute({
      outputDir: "presentation",
      title: "Demo Deck",
      slides: [
        { title: "Local", content: "![a](images/x.png)", notes: "speaker note one" },
        { title: "Remote", content: "![b](https://example.com/y.png)", bullets: ["point one", "point two"] },
      ],
    }, ctx);
    expect(res.success).toBe(true);
    expect(res.metadata?.["outputPath"]).toBe("generated/presentation");

    const html = readFileSync(join(ws, "generated", "presentation", "index.html"), "utf8");
    expect(html).toContain("data:image/png;base64,");          // local image inlined → self-contained
    expect(html).not.toContain('src="images/x.png"');           // relative ref replaced
    expect(html).toContain('src="https://example.com/y.png"');  // remote URL untouched

    const arts = res.metadata?.["artifacts"] as Array<Record<string, unknown>> | undefined;
    expect(arts?.some((a) => a["filename"] === "notes.md")).toBe(true);
    const notes = readFileSync(join(ws, "generated", "presentation", "notes.md"), "utf8");
    expect(notes).toContain("## Slide 1: Local");
    expect(notes).toContain("speaker note one");
    expect(notes).toContain("- point one");
  });
});

describe("generate_document — paper images inline under generated/", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "paper-"));
    mkdirSync(join(ws, "generated", "presentation", "images"), { recursive: true });
    writeFileSync(join(ws, "generated", "presentation", "images", "y.png"), IMG_BYTES);
  });
  afterEach(() => { rmSync(ws, { recursive: true, force: true }); });

  it("inlines a co-located image in a markdown paper and leaves remote refs", async () => {
    const tool = getTool("generate_document");
    expect(tool).toBeDefined();
    const ctx = { sessionId: "t", workspacePath: ws } as unknown as Parameters<NonNullable<typeof tool>["execute"]>[1];

    const res = await tool!.execute({
      output_file: "presentation/paper.md",
      format: "markdown",
      title: "Paper",
      content: "# Paper\n\n![local](images/y.png)\n\n![remote](https://example.com/z.png)\n",
    }, ctx);
    expect(res.success).toBe(true);
    expect(res.metadata?.["outputPath"]).toBe("generated/presentation/paper.md");

    const md = readFileSync(join(ws, "generated", "presentation", "paper.md"), "utf8");
    expect(md).toContain("data:image/png;base64,");        // local image inlined
    expect(md).not.toContain("](images/y.png)");            // relative ref replaced
    expect(md).toContain("](https://example.com/z.png)");   // remote ref untouched
  });
});
