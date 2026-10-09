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

    const outputPath = join(tempDir, "generated", "weekly-handoff.md");
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
    const outputPath = join(tempDir, "generated", "exports", "release-brief.html");
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
      outputPath: "generated/artifacts/brief.md",
      filename: "brief.md",
      contentType: "text/markdown; charset=utf-8",
      previewMode: "markdown",
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
      sources: [
        { title: "Regional revenue dashboard", url: "https://example.test/revenue-dashboard" },
        { url: "https://example.test/revenue-methodology" },
      ],
      output_file: "reports/quarterly-revenue",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("generated/reports/quarterly-revenue.html");
    expect(result.metadata).toMatchObject({
      artifactKind: "chart_report",
      outputPath: "generated/reports/quarterly-revenue.html",
      contentType: "text/html; charset=utf-8",
      previewMode: "html",
      chartType: "line",
      seriesCount: 2,
      sources: [
        { title: "Regional revenue dashboard", url: "https://example.test/revenue-dashboard" },
        { url: "https://example.test/revenue-methodology" },
      ],
      artifacts: [
        expect.objectContaining({
          externalUrl: "https://example.test/revenue-dashboard",
          previewMode: "html",
          sourceTool: "source_reference",
        }),
        expect.objectContaining({
          externalUrl: "https://example.test/revenue-methodology",
          previewMode: "html",
          sourceTool: "source_reference",
        }),
      ],
    });

    const outputPath = join(tempDir, "generated", "reports", "quarterly-revenue.html");
    expect(existsSync(outputPath)).toBe(true);
    const content = readFileSync(outputPath, "utf8");
    expect(content).toContain("Quarterly Revenue");
    expect(content).not.toMatch(/<script\b/i);
    expect(content).toContain('"labels": [');
    expect(content).toContain("Sources");
    expect(content).toContain("https://example.test/revenue-dashboard");
  });

  // The page used to load Chart.js from a CDN, so offline it drew nothing, and it could not meet a
  // brief asking for a standalone file: in the E2E html-chart run chart_designer hand-wrote an SVG
  // page instead of calling this tool. The chart is now drawn into the file as SVG.
  function chartSvgOf(content: string): string {
    const match = /<svg class="chart-svg"[\s\S]*?<\/svg>/.exec(content);
    expect(match, "no inline chart SVG in the page").not.toBeNull();
    return match![0];
  }

  it("draws the chart into the file itself, with no script or remote resource, plotting every value", async () => {
    const labels = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
    const data = [132, 118, 147, 159, 214, 287];
    const result = await runTool("generate_chart_html", {
      title: "Hofladen Besucher",
      chart_type: "bar",
      labels,
      series: [{ label: "Besucher", data }],
      output_file: "reports/hofladen-besucher.html",
    });
    expect(result.success).toBe(true);

    const content = readFileSync(join(tempDir, "generated", "reports", "hofladen-besucher.html"), "utf8");
    expect(content).not.toMatch(/<script\b/i);
    expect(content).not.toMatch(/\b(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i);
    expect(content).not.toMatch(/url\(|@import/i);

    const svg = chartSvgOf(content);
    const bars = [...svg.matchAll(/<rect class="bar"[^>]*\bheight="([\d.]+)"[^>]*><title>([^<]*)<\/title>/g)];
    expect(bars.map((bar) => bar[2])).toEqual(labels.map((label, index) => `${label} · Besucher: ${data[index]}`));
    for (const value of data) expect(svg).toContain(`>${value}</text>`);
    // Bars are drawn to scale from a zero baseline: heights keep the values' ratios.
    const heights = bars.map((bar) => Number(bar[1]));
    for (let index = 1; index < data.length; index += 1) {
      expect(heights[index]! / heights[0]!).toBeCloseTo(data[index]! / data[0]!, 2);
    }
  });

  it("draws every point of a line chart and every positive slice of a pie or doughnut", async () => {
    const line = await runTool("generate_chart_html", {
      chart_type: "line",
      labels: ["Jan", "Feb", "Mar"],
      series: [{ label: "North", data: [12, 18, 22] }, { label: "South", data: [9, 15, 19] }],
      output_file: "charts/line.html",
    });
    expect(line.success).toBe(true);
    const lineSvg = chartSvgOf(readFileSync(join(tempDir, "generated", "charts", "line.html"), "utf8"));
    expect(lineSvg.match(/<circle class="point"/g)).toHaveLength(6);
    expect(lineSvg.match(/<polyline class="line"/g)).toHaveLength(2);
    expect(lineSvg).toContain("Mar · South: 19");

    for (const chartType of ["pie", "doughnut"] as const) {
      const result = await runTool("generate_chart_html", {
        chart_type: chartType,
        labels: ["A", "B", "C", "D"],
        series: [{ label: "Votes", data: [40, 30, 0, 10] }],
        output_file: `charts/${chartType}.html`,
      });
      expect(result.success).toBe(true);
      const svg = chartSvgOf(readFileSync(join(tempDir, "generated", "charts", `${chartType}.html`), "utf8"));
      const slices = [...svg.matchAll(/<path class="slice" d="([^"]+)"[^>]*><title>([^<]*)<\/title>/g)];
      // A zero share has no slice; the other three do, each named with its value and share.
      expect(slices.map((slice) => slice[2])).toEqual(["A · Votes: 40 (50%)", "B · Votes: 30 (37.5%)", "D · Votes: 10 (12.5%)"]);
      // A doughnut slice is bounded by an outer and an inner arc; a pie wedge only by an outer one.
      for (const slice of slices) expect(slice[1]!.match(/ A /g)).toHaveLength(chartType === "doughnut" ? 2 : 1);
    }
  });

  it("falls back to the palette for a series colour that is not plain colour syntax", async () => {
    const result = await runTool("generate_chart_html", {
      chart_type: "bar",
      labels: ["A", "B"],
      series: [
        { label: "Remote", data: [1, 2], color: "url(https://evil.test/p.svg#x)" },
        { label: "Injected", data: [3, 4], color: "red\" onload=\"alert(1)" },
        { label: "Plain", data: [5, 6], color: "rgb(10, 20, 30)" },
      ],
      output_file: "charts/colours.html",
    });
    expect(result.success).toBe(true);
    const content = readFileSync(join(tempDir, "generated", "charts", "colours.html"), "utf8");
    expect(content).not.toContain("evil.test");
    expect(content).not.toContain("onload");
    const fills = [...chartSvgOf(content).matchAll(/<rect class="bar"[^>]*\bfill="([^"]+)"/g)].map((bar) => bar[1]);
    expect(fills).toEqual(["#7dd3fc", "#7dd3fc", "#fb7185", "#fb7185", "rgb(10, 20, 30)", "rgb(10, 20, 30)"]);
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

describe("generate_mermaid_diagram", () => {
  it("writes a Mermaid source artifact with preview metadata", async () => {
    const result = await runTool("generate_mermaid_diagram", {
      title: "Escalation Flow",
      diagram: "flowchart TD\n  Start --> Review\n  Review --> Ship",
      output_file: "artifacts/escalation-flow",
      theme: "forest",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("generated/artifacts/escalation-flow.mmd");
    expect(result.metadata).toMatchObject({
      artifactKind: "diagram",
      outputPath: "generated/artifacts/escalation-flow.mmd",
      filename: "escalation-flow.mmd",
      contentType: "text/vnd.mermaid; charset=utf-8",
      previewMode: "mermaid",
      theme: "forest",
    });

    const outputPath = join(tempDir, "generated", "artifacts", "escalation-flow.mmd");
    expect(existsSync(outputPath)).toBe(true);
    const content = readFileSync(outputPath, "utf8");
    expect(content).toContain('%%{init: { "theme": "forest" }}%%');
    expect(content).toContain("flowchart TD");
  });

  it("preserves an existing Mermaid init block", async () => {
    const result = await runTool("generate_mermaid_diagram", {
      title: "Existing Theme",
      diagram: "%%{init: { \"theme\": \"dark\" }}%%\nflowchart LR\n  A --> B",
    });

    expect(result.success).toBe(true);
    const outputPath = join(tempDir, "generated", "existing-theme.mmd");
    const content = readFileSync(outputPath, "utf8");
    expect(content.match(/%%\{init:/g)).toHaveLength(1);
    expect(content).toContain('"dark"');
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

    const outputPath = join(tempDir, "generated", "briefs", "board-brief.pdf");
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