import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The renderer talks to a real browser over CDP. These are unit tests: stub the
// transport so they assert what THIS module controls — the assembled HTML, the
// argument validation, the output path rules, and the artifact metadata contract —
// without needing the browser-vnc container. The live render is covered separately.
const renderMock = vi.hoisted(() => vi.fn());
vi.mock("../render/cdp-pdf.js", () => ({ renderHtmlToPdf: renderMock }));

const FAKE_PDF = new Uint8Array(Buffer.from("%PDF-1.4\n% stub\n%%EOF\n", "latin1"));

describe("render_pdf", () => {
  const cleanup: string[] = [];
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "starlingai-renderpdf-"));
    cleanup.push(workspace);
    renderMock.mockReset();
    renderMock.mockResolvedValue({ ok: true, bytes: FAKE_PDF });
  });

  afterEach(() => {
    for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function tool() {
    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./render-pdf.js"),
    ]);
    return getTool("render_pdf")!;
  }

  const ctx = () => ({ sessionId: "s1", workspacePath: workspace });
  /** HTML handed to the renderer by the most recent call. */
  const renderedHtml = (): string => String(renderMock.mock.calls.at(-1)?.[0] ?? "");
  const renderOpts = () => (renderMock.mock.calls.at(-1)?.[1] ?? {}) as Record<string, unknown>;

  // ── happy path ────────────────────────────────────────────────────────────

  it("writes a PDF and reports the artifact metadata the chat UI needs", async () => {
    const result = await (await tool()).execute({
      title: "Curriculum Vitae",
      content: "# Jane Doe\n\nBerlin\n\n## Experience\n\n- Led the platform team",
      theme: "cv",
    }, ctx());

    expect(result.success).toBe(true);
    // Bare filenames are rooted under generated/ by resolveWorkspaceWritePath, the same
    // place generate_document puts its output — the filename stays the bare basename.
    expect(result.metadata?.["outputPath"]).toBe("generated/curriculum-vitae.pdf");
    expect(result.metadata?.["filename"]).toBe("curriculum-vitae.pdf");
    expect(result.metadata?.["artifactKind"]).toBe("document");
    expect(result.metadata?.["contentType"]).toBe("application/pdf");
    // previewMode "pdf" is what turns the artifact card into a preview rather than
    // a bare download link (MessageBubble.vue gates on this exact value).
    expect(result.metadata?.["previewMode"]).toBe("pdf");

    const written = readFileSync(join(workspace, "generated", "curriculum-vitae.pdf"));
    expect(written.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("converts Markdown to real HTML structure rather than passing text through", async () => {
    await (await tool()).execute({
      title: "Report",
      content: "# Title\n\nIntro **bold**.\n\n- one\n- two\n\n| a | b |\n| --- | --- |\n| 1 | 2 |",
    }, ctx());

    const html = renderedHtml();
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<table>");
    expect(html).toContain("<td>1</td>");
  });

  it("emits print rules that keep a document readable across pages", async () => {
    await (await tool()).execute({ content: "# H", page_size: "Letter" }, ctx());

    const html = renderedHtml();
    expect(html).toContain("@page { size: Letter; margin: 18mm 16mm; }");
    // The break rules are the point of a print stylesheet, not decoration.
    expect(html).toContain("break-after: avoid");   // headings not stranded at page foot
    expect(html).toContain("break-inside: avoid");  // rows/list items not split
    expect(html).toContain("orphans: 3");
    expect(renderOpts()["preferCssPageSize"]).toBe(true);
  });

  it("carries unicode that generate_pdf cannot encode", async () => {
    // → and ✓ THROW in pdf-lib's WinAnsi encoder; the whole point of this path is
    // that they survive. Guard the regression at the assembly boundary.
    await (await tool()).execute({ content: "- Java → Kotlin\n- ✓ Certified\n- Größe: 42 €" }, ctx());

    const html = renderedHtml();
    expect(html).toContain("→");
    expect(html).toContain("✓");
    expect(html).toContain("Größe");
  });

  it("applies the requested theme and defaults to 'document'", async () => {
    await (await tool()).execute({ content: "# A", theme: "report" }, ctx());
    expect(renderedHtml()).toContain("Georgia");           // report = serif body

    await (await tool()).execute({ content: "# A", output_file: "b.pdf" }, ctx());
    expect(renderedHtml()).toContain("Helvetica Neue");    // document = sans default
  });

  it("adds a page-number footer only when asked", async () => {
    await (await tool()).execute({ content: "# A", output_file: "no.pdf" }, ctx());
    expect(renderOpts()["footerHtml"]).toBeUndefined();

    await (await tool()).execute({ content: "# A", output_file: "yes.pdf", page_numbers: true }, ctx());
    expect(String(renderOpts()["footerHtml"])).toContain("pageNumber");
  });

  it("inlines a co-located local image so the render needs no network", async () => {
    // Co-located with the DOCUMENT (generated/), which is what a relative `images/x`
    // in the body resolves against — and the inliner refuses to escape that folder.
    mkdirSync(join(workspace, "generated", "images"), { recursive: true });
    // 1x1 transparent PNG
    writeFileSync(join(workspace, "generated", "images", "photo.png"), Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64"));

    await (await tool()).execute({ content: "![me](images/photo.png)", output_file: "cv.pdf" }, ctx());

    const html = renderedHtml();
    expect(html).toContain("data:image/png;base64,");
    expect(html).not.toContain('src="images/photo.png"');
  });

  it("keeps a full HTML document's own markup and only injects print CSS", async () => {
    await (await tool()).execute({
      format: "html",
      content: "<html><head><title>X</title></head><body><p id='keep'>hi</p></body></html>",
      output_file: "h.pdf",
    }, ctx());

    const html = renderedHtml();
    expect(html).toContain("id='keep'");
    expect(html).toContain("@page");
    // No second <html> wrapper around the caller's document.
    expect(html.match(/<html/gi)?.length).toBe(1);
  });

  // ── negative cases ────────────────────────────────────────────────────────

  it("rejects missing content instead of writing an empty PDF", async () => {
    const result = await (await tool()).execute({ title: "Empty" }, ctx());
    expect(result.success).toBe(false);
    expect(result.error).toContain("content is required");
    expect(renderMock).not.toHaveBeenCalled();
  });

  it("rejects a non-.pdf output_file", async () => {
    const result = await (await tool()).execute({ content: "x", output_file: "notes.txt" }, ctx());
    expect(result.success).toBe(false);
    expect(result.error).toContain(".pdf extension");
  });

  it("rejects an output path that escapes the workspace", async () => {
    const result = await (await tool()).execute({ content: "x", output_file: "../outside.pdf" }, ctx());
    expect(result.success).toBe(false);
    expect(result.error).toContain("within the workspace");
    expect(renderMock).not.toHaveBeenCalled();
  });

  it("refuses to clobber an existing file when overwrite is false", async () => {
    await (await tool()).execute({ content: "first", output_file: "cv.pdf" }, ctx());
    const result = await (await tool()).execute({ content: "second", output_file: "cv.pdf", overwrite: false }, ctx());

    expect(result.success).toBe(false);
    expect(result.error).toContain("Refusing");
  });

  it("rejects an unknown theme and page size", async () => {
    const badTheme = await (await tool()).execute({ content: "x", theme: "fancy" }, ctx());
    expect(badTheme.success).toBe(false);
    expect(badTheme.error).toContain("theme must be one of");

    const badSize = await (await tool()).execute({ content: "x", page_size: "A3" }, ctx());
    expect(badSize.success).toBe(false);
    expect(badSize.error).toContain("page_size must be one of");
  });

  it("surfaces a renderer failure instead of writing a truncated file", async () => {
    renderMock.mockResolvedValue({ ok: false, error: "The PDF renderer is unreachable at http://browser-vnc:9222" });

    const result = await (await tool()).execute({ content: "x", output_file: "gone.pdf" }, ctx());

    expect(result.success).toBe(false);
    expect(result.error).toContain("unreachable");
    expect(() => readFileSync(join(workspace, "generated", "gone.pdf"))).toThrow();
  });
});
