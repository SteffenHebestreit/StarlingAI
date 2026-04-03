import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "starlingai-document-tools-"));
  await import("../tools/document-output.js");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

async function runTool(name: string, args: Record<string, unknown>) {
  const { executeTool } = await import("../tools/registry.js");
  return executeTool(name, args, {
    sessionId: "document-tools-test",
    workspacePath: tempDir,
  });
}

describe("generate_document", () => {
  it("writes a Markdown document with a derived filename", async () => {
    const result = await runTool("generate_document", {
      title: "Weekly Handoff",
      content: "Completed items\n\n- Task A\n- Task B",
      format: "markdown",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("weekly-handoff.md");

    const outputPath = join(tempDir, "weekly-handoff.md");
    expect(existsSync(outputPath)).toBe(true);
    const content = readFileSync(outputPath, "utf8");
    expect(content).toContain("# Weekly Handoff");
    expect(content).toContain("- Task A");
  });

  it("renders HTML output and appends the extension when omitted", async () => {
    const result = await runTool("generate_document", {
      title: "Release Brief",
      content: "Ship date: 2026-03-30",
      format: "html",
      output_file: "exports/release-brief",
    });

    expect(result.success).toBe(true);
    const outputPath = join(tempDir, "exports", "release-brief.html");
    expect(existsSync(outputPath)).toBe(true);
    const content = readFileSync(outputPath, "utf8");
    expect(content).toContain("<!doctype html>");
    expect(content).toContain("Release Brief");
    expect(content).toContain("Ship date: 2026-03-30");
  });

  it("rejects mismatched output extensions", async () => {
    const result = await runTool("generate_document", {
      title: "Bad Extension",
      content: "text",
      format: "json",
      output_file: "brief.md",
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/\.json extension/i);
  });

  it("respects overwrite=false", async () => {
    await runTool("generate_document", {
      title: "No Overwrite",
      content: "first version",
      format: "text",
      output_file: "no-overwrite.txt",
    });

    const result = await runTool("generate_document", {
      title: "No Overwrite",
      content: "second version",
      format: "text",
      output_file: "no-overwrite.txt",
      overwrite: false,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/refusing to overwrite/i);
  });

  it("returns artifact metadata that can be surfaced in chat", async () => {
    const result = await runTool("generate_document", {
      title: "Brief",
      content: "Artifact body",
      format: "markdown",
      output_file: "artifacts/brief.md",
    });

    expect(result.success).toBe(true);
    expect(result.metadata).toMatchObject({
      artifactKind: "document",
      outputPath: "artifacts/brief.md",
      filename: "brief.md",
      contentType: "text/markdown; charset=utf-8",
      previewMode: "text",
    });
  });
});

describe("generate_chart_html", () => {
  it("writes an HTML chart report with inline config data", async () => {
    const result = await runTool("generate_chart_html", {
      title: "Quarterly Revenue",
      summary: "Shows the regional trend for the quarter.",
      chart_type: "line",
      labels: ["Jan", "Feb", "Mar"],
      series: [
        { label: "North", data: [12, 18, 22] },
        { label: "South", data: [9, 15, 19], color: "#f97316" },
      ],
      output_file: "reports/quarterly-revenue",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("reports/quarterly-revenue.html");
    expect(result.metadata).toMatchObject({
      artifactKind: "chart_report",
      outputPath: "reports/quarterly-revenue.html",
      contentType: "text/html; charset=utf-8",
      previewMode: "html",
      chartType: "line",
      seriesCount: 2,
    });

    const outputPath = join(tempDir, "reports", "quarterly-revenue.html");
    expect(existsSync(outputPath)).toBe(true);
    const content = readFileSync(outputPath, "utf8");
    expect(content).toContain("Quarterly Revenue");
    expect(content).toContain("cdn.jsdelivr.net/npm/chart.js");
    expect(content).toContain('"labels": [');
  });

  it("rejects mismatched series lengths", async () => {
    const result = await runTool("generate_chart_html", {
      labels: ["A", "B"],
      series: [{ data: [1] }],
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/same length as labels/i);
  });
});

describe("generate_pdf", () => {
  it("writes a PDF file to the workspace without network access", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await runTool("generate_pdf", {
      title: "Board Brief",
      content: "Priority items:\n1. Launch status\n2. Risks\n3. Budget",
      output_file: "briefs/board-brief.pdf",
      page_size: "Letter",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("board-brief.pdf");
    expect(fetchMock).not.toHaveBeenCalled();

    const outputPath = join(tempDir, "briefs", "board-brief.pdf");
    expect(existsSync(outputPath)).toBe(true);
    const bytes = readFileSync(outputPath);
    expect(bytes.subarray(0, 4).toString("utf8")).toBe("%PDF");
  });

  it("rejects paths outside the workspace", async () => {
    const result = await runTool("generate_pdf", {
      title: "Escape Test",
      content: "body",
      output_file: "../../escape.pdf",
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/workspace/i);
  });
});