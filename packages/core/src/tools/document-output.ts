import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { PDFDocument, StandardFonts, type PDFFont, rgb } from "pdf-lib";
import { childLogger } from "../logger.js";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { overwriteGuard, resolveWorkspaceWritePath } from "./workspace-path.js";
import { inlineLocalImagesInHtml, inlineLocalImagesInMarkdown } from "./inline-images.js";

const log = childLogger("tool:document-output");

const DOCUMENT_FORMATS = ["markdown", "text", "html", "json"] as const;
const CHART_TYPES = ["bar", "line", "pie", "doughnut"] as const;
const MERMAID_THEMES = ["default", "neutral", "dark", "forest"] as const;
const PDF_PAGE_SIZES = {
  A4: { width: 595.28, height: 841.89 },
  Letter: { width: 612, height: 792 },
} as const;

type DocumentFormat = typeof DOCUMENT_FORMATS[number];
type ChartType = typeof CHART_TYPES[number];
type MermaidTheme = typeof MERMAID_THEMES[number];
type PdfPageSize = keyof typeof PDF_PAGE_SIZES;
type ChartSource = { url: string; title?: string };

const FORMAT_EXTENSION: Record<DocumentFormat | "pdf" | "mermaid", string> = {
  markdown: ".md",
  text: ".txt",
  html: ".html",
  json: ".json",
  pdf: ".pdf",
  mermaid: ".mmd",
};

registerTool({
  name: "generate_document",
  description:
    "Generate and save a workspace document as Markdown, text, HTML, or JSON. " +
    "Use this for reports, handoff notes, briefs, and exportable artifacts.",
  embeddingDescription: "Generate, create, produce a document, report, brief, artifact. Dokument erstellen, Bericht generieren, Markdown speichern, Artefakt produzieren. Final deliverable, downloadable report.",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Optional document title. Included in rendered output when present.",
      },
      content: {
        type: "string",
        description: "Main document body. This can be plain text or Markdown-like text.",
      },
      format: {
        type: "string",
        enum: [...DOCUMENT_FORMATS],
        description: "Output format to generate.",
        default: "markdown",
      },
      output_file: {
        type: "string",
        description: "Workspace-relative output path. If omitted, a filename is derived from the title.",
      },
      overwrite: {
        type: "boolean",
        description: "When false, fail instead of overwriting an existing file.",
        default: true,
      },
    },
    required: ["content"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const content = String(args["content"] ?? "");
    const title = optionalString(args["title"]);
    const format = normalizeDocumentFormat(args["format"]);
    const overwrite = Boolean(args["overwrite"] ?? true);

    if (!content.trim()) return fail("content is required");
    if (!format) return fail("format must be one of: markdown, text, html, json");

    const resolvedOutput = resolveOutputPath({
      requestedPath: optionalString(args["output_file"]),
      title,
      format,
      workspacePath: ctx.workspacePath,
    });
    if (!resolvedOutput.success) return fail(resolvedOutput.error);

    const overwriteError = await overwriteGuard(resolvedOutput.resolved, resolvedOutput.relativePath, overwrite);
    if (overwriteError) return fail(overwriteError);

    const rendered = renderDocument({ title, content, format });
    // Inline co-located local images as data URIs so an illustrated paper/report
    // renders self-contained (the workspace preview can't resolve relative
    // `images/x` refs); resolve them against the document's own folder.
    const docDir = dirname(resolvedOutput.resolved);
    const finalContent = format === "markdown"
      ? await inlineLocalImagesInMarkdown(rendered, docDir)
      : format === "html"
        ? await inlineLocalImagesInHtml(rendered, docDir)
        : rendered;

    try {
      await mkdir(docDir, { recursive: true });
      await writeFile(resolvedOutput.resolved, finalContent, "utf8");
    } catch (err) {
      log.error({ err, outputFile: resolvedOutput.relativePath, format }, "generate_document failed");
      return fail(`Failed to write document: ${String(err)}`);
    }

    return {
      success: true,
      output: `Document saved to ${resolvedOutput.relativePath} as ${format}.`,
      metadata: {
        artifactKind: "document",
        outputPath: resolvedOutput.relativePath,
        filename: basenameFromRelativePath(resolvedOutput.relativePath),
        format,
        title: title || undefined,
        size: finalContent.length,
        contentType: contentTypeForDocumentFormat(format),
        previewMode: previewModeForFormat(format),
      },
    };
  },
});

registerTool({
  name: "generate_pdf",
  description:
    "Generate and save a simple PDF document in the workspace from a title and body text. " +
    "Best for briefs, summaries, handoff notes, and printable reports.",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Optional PDF title.",
      },
      content: {
        type: "string",
        description: "Body text to render into the PDF.",
      },
      output_file: {
        type: "string",
        description: "Workspace-relative output path. If omitted, a filename is derived from the title.",
      },
      page_size: {
        type: "string",
        enum: ["A4", "Letter"],
        description: "Page size to use for the generated PDF.",
        default: "A4",
      },
      overwrite: {
        type: "boolean",
        description: "When false, fail instead of overwriting an existing file.",
        default: true,
      },
    },
    required: ["content"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const content = String(args["content"] ?? "");
    const title = optionalString(args["title"]);
    const pageSize = normalizePdfPageSize(args["page_size"]);
    const overwrite = Boolean(args["overwrite"] ?? true);

    if (!content.trim()) return fail("content is required");
    if (!pageSize) return fail("page_size must be either 'A4' or 'Letter'");

    const resolvedOutput = resolveOutputPath({
      requestedPath: optionalString(args["output_file"]),
      title,
      format: "pdf",
      workspacePath: ctx.workspacePath,
    });
    if (!resolvedOutput.success) return fail(resolvedOutput.error);

    const overwriteError = await overwriteGuard(resolvedOutput.resolved, resolvedOutput.relativePath, overwrite);
    if (overwriteError) return fail(overwriteError);

    let bytes: Uint8Array;
    try {
      bytes = await buildPdfDocument({ title, content, pageSize });
      await mkdir(dirname(resolvedOutput.resolved), { recursive: true });
      await writeFile(resolvedOutput.resolved, bytes);
    } catch (err) {
      log.error({ err, outputFile: resolvedOutput.relativePath, pageSize }, "generate_pdf failed");
      return fail(`Failed to write PDF: ${String(err)}`);
    }

    return {
      success: true,
      output: `PDF saved to ${resolvedOutput.relativePath}.`,
      metadata: {
        artifactKind: "document",
        outputPath: resolvedOutput.relativePath,
        filename: basenameFromRelativePath(resolvedOutput.relativePath),
        format: "pdf",
        pageSize,
        title: title || undefined,
        bytes: bytes.length,
        contentType: "application/pdf",
        previewMode: "pdf",
      },
    };
  },
});

registerTool({
  name: "generate_mermaid_diagram",
  description:
    "Generate and save a Mermaid diagram source artifact in the workspace. " +
    "Use this for workflows, graphs, timelines, architecture maps, and evidence diagrams that the chat UI can preview directly.",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Optional diagram title used for the filename and artifact label.",
      },
      diagram: {
        type: "string",
        description: "Mermaid source text, such as 'flowchart TD' or 'sequenceDiagram'.",
      },
      theme: {
        type: "string",
        enum: [...MERMAID_THEMES],
        description: "Optional Mermaid theme to inject when the source does not already provide an init block.",
        default: "neutral",
      },
      output_file: {
        type: "string",
        description: "Workspace-relative Mermaid output path. Defaults to a filename derived from the title.",
      },
      overwrite: {
        type: "boolean",
        description: "When false, fail instead of overwriting an existing file.",
        default: true,
      },
    },
    required: ["diagram"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const title = optionalString(args["title"]) || "Diagram";
    const diagram = String(args["diagram"] ?? "");
    const theme = normalizeMermaidTheme(args["theme"]);
    const overwrite = Boolean(args["overwrite"] ?? true);

    if (!diagram.trim()) return fail("diagram is required");
    if (!theme) return fail("theme must be one of: default, neutral, dark, forest");

    const resolvedOutput = resolveOutputPath({
      requestedPath: optionalString(args["output_file"]),
      title,
      format: "mermaid",
      workspacePath: ctx.workspacePath,
    });
    if (!resolvedOutput.success) return fail(resolvedOutput.error);

    const overwriteError = await overwriteGuard(resolvedOutput.resolved, resolvedOutput.relativePath, overwrite);
    if (overwriteError) return fail(overwriteError);

    const rendered = renderMermaidSource({ title, diagram, theme });

    try {
      await mkdir(dirname(resolvedOutput.resolved), { recursive: true });
      await writeFile(resolvedOutput.resolved, rendered, "utf8");
    } catch (err) {
      log.error({ err, outputFile: resolvedOutput.relativePath, theme }, "generate_mermaid_diagram failed");
      return fail(`Failed to write Mermaid diagram: ${String(err)}`);
    }

    return {
      success: true,
      output: `Mermaid diagram saved to ${resolvedOutput.relativePath}.`,
      metadata: {
        artifactKind: "diagram",
        outputPath: resolvedOutput.relativePath,
        filename: basenameFromRelativePath(resolvedOutput.relativePath),
        format: "mermaid",
        title,
        theme,
        size: rendered.length,
        contentType: "text/vnd.mermaid; charset=utf-8",
        previewMode: "mermaid",
      },
    };
  },
});

registerTool({
  name: "generate_chart_html",
  description:
    "Generate and save an HTML chart report in the workspace. " +
    "Use this for dashboards, KPI snapshots, and visual summaries that can be previewed in chat.",
  embeddingDescription: "Generate, create a chart, graph, bar chart, line chart, pie chart, visual data report. Diagramm erstellen, Chart generieren, Datenvisualisierung, Balken-, Linien-, Tortendiagramm.",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Optional chart report title.",
      },
      summary: {
        type: "string",
        description: "Optional short summary shown above the chart.",
      },
      chart_type: {
        type: "string",
        enum: [...CHART_TYPES],
        description: "Chart type to render.",
        default: "bar",
      },
      labels: {
        type: "array",
        items: { type: "string" },
        description: "Ordered labels for the x-axis or chart segments.",
      },
      series: {
        type: "array",
        description: "One or more data series aligned to labels.",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            data: { type: "array", items: { type: "number" } },
            color: { type: "string" },
          },
          required: ["data"],
        },
      },
      sources: {
        type: "array",
        description: "Optional source links to surface alongside the chart artifact for direct preview.",
        items: {
          type: "object",
          properties: {
            url: { type: "string" },
            title: { type: "string" },
          },
          required: ["url"],
        },
      },
      output_file: {
        type: "string",
        description: "Workspace-relative HTML output path. Defaults to a filename derived from the title.",
      },
      overwrite: {
        type: "boolean",
        description: "When false, fail instead of overwriting an existing file.",
        default: true,
      },
    },
    required: ["labels", "series"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const title = optionalString(args["title"]) || "Chart Report";
    const summary = optionalString(args["summary"]);
    const chartType = normalizeChartType(args["chart_type"]);
    const overwrite = Boolean(args["overwrite"] ?? true);
    const labels = normalizeStringArray(args["labels"]);
    const series = normalizeChartSeries(args["series"]);
    const sources = normalizeChartSources(args["sources"]);

    if (!chartType) return fail("chart_type must be one of: bar, line, pie, doughnut");
    if (labels.length === 0) return fail("labels must contain at least one entry");
    if (series.length === 0) return fail("series must contain at least one data series");
    if (series.some((entry) => entry.data.length !== labels.length)) {
      return fail("each series.data array must have the same length as labels");
    }

    const resolvedOutput = resolveOutputPath({
      requestedPath: optionalString(args["output_file"]),
      title,
      format: "html",
      workspacePath: ctx.workspacePath,
    });
    if (!resolvedOutput.success) return fail(resolvedOutput.error);

    const overwriteError = await overwriteGuard(resolvedOutput.resolved, resolvedOutput.relativePath, overwrite);
    if (overwriteError) return fail(overwriteError);

    const rendered = renderChartHtml({ title, summary, chartType, labels, series, sources });

    try {
      await mkdir(dirname(resolvedOutput.resolved), { recursive: true });
      await writeFile(resolvedOutput.resolved, rendered, "utf8");
    } catch (err) {
      log.error({ err, outputFile: resolvedOutput.relativePath, chartType }, "generate_chart_html failed");
      return fail(`Failed to write chart report: ${String(err)}`);
    }

    return {
      success: true,
      output: `Chart HTML saved to ${resolvedOutput.relativePath}.`,
      metadata: {
        artifactKind: "chart_report",
        outputPath: resolvedOutput.relativePath,
        filename: basenameFromRelativePath(resolvedOutput.relativePath),
        format: "html",
        title,
        summary: summary || undefined,
        chartType,
        seriesCount: series.length,
        points: labels.length,
        sources,
        artifacts: sources.map((source, index) => ({
          artifactKind: "external_source",
          externalUrl: source.url,
          filename: sourceFilenameFromUrl(source.url, index),
          title: source.title || sourceTitleFromUrl(source.url),
          contentType: "text/html; charset=utf-8",
          previewMode: "html",
          sourceTool: "source_reference",
        })),
        size: rendered.length,
        contentType: "text/html; charset=utf-8",
        previewMode: "html",
      },
    };
  },
});

function normalizeDocumentFormat(value: unknown): DocumentFormat | null {
  const normalized = String(value ?? "markdown").trim().toLowerCase();
  return (DOCUMENT_FORMATS as readonly string[]).includes(normalized)
    ? (normalized as DocumentFormat)
    : null;
}

function normalizePdfPageSize(value: unknown): PdfPageSize | null {
  const normalized = String(value ?? "A4").trim();
  return normalized === "A4" || normalized === "Letter" ? normalized : null;
}

function normalizeChartType(value: unknown): ChartType | null {
  const normalized = String(value ?? "bar").trim().toLowerCase();
  return (CHART_TYPES as readonly string[]).includes(normalized)
    ? (normalized as ChartType)
    : null;
}

function normalizeChartSources(value: unknown): ChartSource[] {
  if (!Array.isArray(value)) return [];

  const normalized: ChartSource[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      const url = entry.trim();
      if (isHttpUrl(url)) normalized.push({ url });
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const url = String(record["url"] ?? "").trim();
    const title = optionalString(record["title"]);
    if (!isHttpUrl(url)) continue;
    normalized.push(title ? { url, title } : { url });
  }

  const seen = new Set<string>();
  return normalized.filter((source) => {
    if (seen.has(source.url)) return false;
    seen.add(source.url);
    return true;
  });
}

function normalizeMermaidTheme(value: unknown): MermaidTheme | null {
  const normalized = String(value ?? "neutral").trim().toLowerCase();
  return (MERMAID_THEMES as readonly string[]).includes(normalized)
    ? (normalized as MermaidTheme)
    : null;
}

function resolveOutputPath(input: {
  requestedPath: string;
  title: string;
  format: DocumentFormat | "pdf" | "mermaid";
  workspacePath: string;
}): { success: true; resolved: string; relativePath: string } | { success: false; error: string } {
  const extension = FORMAT_EXTENSION[input.format];
  const fallbackName = `${slugifyTitle(input.title || "document")}${extension}`;
  const requestedPath = input.requestedPath.trim() || fallbackName;
  const currentExtension = extname(requestedPath).toLowerCase();
  const normalizedPath = currentExtension
    ? requestedPath
    : `${requestedPath}${extension}`;

  if (extname(normalizedPath).toLowerCase() !== extension) {
    return { success: false, error: `output_file must use the ${extension} extension for ${input.format} output` };
  }

  try {
    const { resolved, relativePath } = resolveWorkspaceWritePath(normalizedPath, input.workspacePath);
    return { success: true, resolved, relativePath };
  } catch {
    return { success: false, error: "output_file must be a relative path within the workspace" };
  }
}

function renderDocument(input: { title: string; content: string; format: DocumentFormat }): string {
  switch (input.format) {
    case "markdown":
      return renderMarkdown(input.title, input.content);
    case "text":
      return renderText(input.title, input.content);
    case "html":
      return renderHtml(input.title, input.content);
    case "json":
      return JSON.stringify(
        {
          title: input.title || null,
          content: input.content,
          generatedAt: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n";
  }
}

function renderMarkdown(title: string, content: string): string {
  if (!title) return ensureTrailingNewline(content);
  const trimmed = content.trimStart();
  if (trimmed.startsWith("# ")) return ensureTrailingNewline(content);
  return `# ${title}\n\n${ensureTrailingNewline(content).trimEnd()}\n`;
}

function renderText(title: string, content: string): string {
  if (!title) return ensureTrailingNewline(content);
  return `${title}\n${"=".repeat(title.length)}\n\n${ensureTrailingNewline(content).trimEnd()}\n`;
}

function renderHtml(title: string, content: string): string {
  const safeTitle = escapeHtml(title || "Document");
  const safeContent = escapeHtml(content);
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    `  <title>${safeTitle}</title>`,
    "  <style>",
    "    :root { color-scheme: light; font-family: Georgia, 'Times New Roman', serif; }",
    "    body { margin: 0; background: #f3efe6; color: #1f1b16; }",
    "    main { max-width: 860px; margin: 0 auto; padding: 48px 24px 64px; }",
    "    h1 { font-size: 2.2rem; margin-bottom: 1.5rem; }",
    "    pre { white-space: pre-wrap; word-break: break-word; line-height: 1.6; font: 1rem/1.6 Georgia, 'Times New Roman', serif; margin: 0; }",
    "  </style>",
    "</head>",
    "<body>",
    "  <main>",
    `    <h1>${safeTitle}</h1>`,
    `    <pre>${safeContent}</pre>`,
    "  </main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function renderChartHtml(input: {
  title: string;
  summary: string;
  chartType: ChartType;
  labels: string[];
  series: Array<{ label: string; data: number[]; color: string }>;
  sources: ChartSource[];
}): string {
  const safeTitle = escapeHtml(input.title || "Chart Report");
  const safeSummary = escapeHtml(input.summary);
  const chartConfig = JSON.stringify({
    type: input.chartType,
    data: {
      labels: input.labels,
      datasets: input.series.map((entry) => ({
        label: entry.label,
        data: entry.data,
        borderColor: entry.color,
        backgroundColor: `${entry.color}33`,
        pointBackgroundColor: entry.color,
        borderWidth: 2,
        tension: input.chartType === "line" ? 0.32 : undefined,
        fill: input.chartType === "line",
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: "#f4efe6" } },
      },
      scales: ["bar", "line"].includes(input.chartType)
        ? {
            x: { ticks: { color: "#d6c8b5" }, grid: { color: "rgba(214, 200, 181, 0.12)" } },
            y: { ticks: { color: "#d6c8b5" }, grid: { color: "rgba(214, 200, 181, 0.12)" } },
          }
        : undefined,
    },
  }, null, 2);

  const tableRows = input.labels.map((label, index) => {
    const values = input.series.map((entry) => `<td>${escapeHtml(String(entry.data[index] ?? ""))}</td>`).join("");
    return `        <tr><th scope="row">${escapeHtml(label)}</th>${values}</tr>`;
  }).join("\n");
  const tableHeaders = input.series.map((entry) => `<th scope="col">${escapeHtml(entry.label)}</th>`).join("");
  const sourceRows = input.sources.map((source) => {
    const label = escapeHtml(source.title || sourceTitleFromUrl(source.url));
    const safeUrl = escapeHtml(source.url);
    return `          <li><a href="${safeUrl}" target="_blank" rel="noreferrer">${label}</a><span>${safeUrl}</span></li>`;
  }).join("\n");
  const sourcePanel = input.sources.length > 0
    ? [
        '      <section class="panel panel--sources">',
        '        <div class="panel__title">Sources</div>',
        '        <ul class="sources">',
        sourceRows,
        '        </ul>',
        '      </section>',
      ].join("\n")
    : "";

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    `  <title>${safeTitle}</title>`,
    '  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>',
    "  <style>",
    "    :root { color-scheme: dark; --bg: #11141f; --panel: #1b2131; --ink: #f4efe6; --muted: #d6c8b5; --accent: #7dd3fc; font-family: 'Aptos', 'Segoe UI', sans-serif; }",
    "    body { margin: 0; background: radial-gradient(circle at top, #1f2840 0%, var(--bg) 58%); color: var(--ink); }",
    "    main { max-width: 1080px; margin: 0 auto; padding: 40px 24px 64px; }",
    "    .hero { display: grid; gap: 18px; margin-bottom: 28px; }",
    "    .eyebrow { letter-spacing: 0.16em; text-transform: uppercase; font-size: 0.72rem; color: var(--accent); }",
    "    h1 { margin: 0; font-size: clamp(2rem, 4vw, 3.2rem); line-height: 1.05; }",
    "    p { margin: 0; color: var(--muted); line-height: 1.65; max-width: 72ch; }",
    "    .grid { display: grid; gap: 24px; grid-template-columns: minmax(0, 1.8fr) minmax(300px, 1fr); }",
    "    .panel { background: linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02)); border: 1px solid rgba(255,255,255,0.08); border-radius: 24px; padding: 22px; box-shadow: 0 18px 48px rgba(0, 0, 0, 0.24); }",
    "    .chart-wrap { position: relative; min-height: 420px; }",
    "    table { width: 100%; border-collapse: collapse; font-size: 0.95rem; }",
    "    th, td { padding: 0.7rem 0.8rem; border-bottom: 1px solid rgba(255,255,255,0.08); text-align: left; }",
    "    th { color: var(--muted); font-weight: 600; }",
    "    tbody th { color: var(--ink); font-weight: 500; }",
    "    .panel__title { margin: 0 0 12px; font-size: 0.88rem; letter-spacing: 0.12em; text-transform: uppercase; color: var(--accent); }",
    "    .panel--sources { margin-top: 24px; }",
    "    .sources { list-style: none; padding: 0; margin: 0; display: grid; gap: 12px; }",
    "    .sources li { display: grid; gap: 4px; padding: 12px 14px; border-radius: 14px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); }",
    "    .sources a { color: #d9f2ff; text-decoration: none; font-weight: 600; }",
    "    .sources a:hover { text-decoration: underline; }",
    "    .sources span { color: var(--muted); font-size: 0.82rem; word-break: break-all; }",
    "    .config { margin-top: 20px; background: rgba(0,0,0,0.22); border-radius: 16px; padding: 14px; overflow: auto; font-size: 0.82rem; color: #c9e8ff; }",
    "    @media (max-width: 860px) { .grid { grid-template-columns: 1fr; } .chart-wrap { min-height: 320px; } }",
    "  </style>",
    "</head>",
    "<body>",
    "  <main>",
    '    <section class="hero">',
    '      <div class="eyebrow">StarlingAI Chart Report</div>',
    `      <h1>${safeTitle}</h1>`,
    `      <p>${safeSummary || "Generated chart artifact with an inline data table for quick verification and export."}</p>`,
    "    </section>",
    '    <section class="grid">',
    '      <article class="panel">',
    '        <div class="chart-wrap"><canvas id="chart"></canvas></div>',
    "      </article>",
    '      <aside class="panel">',
    "        <table>",
    "          <thead>",
    `            <tr><th scope="col">Label</th>${tableHeaders}</tr>`,
    "          </thead>",
    "          <tbody>",
    tableRows,
    "          </tbody>",
    "        </table>",
    '        <pre class="config" aria-label="Chart configuration"></pre>',
    sourcePanel,
    "      </aside>",
    "    </section>",
    "  </main>",
    "  <script>",
    `    const config = ${chartConfig};`,
    "    document.querySelector('.config').textContent = JSON.stringify(config, null, 2);",
    "    if (window.Chart) {",
    "      const ctx = document.getElementById('chart');",
    "      new window.Chart(ctx, config);",
    "    }",
    "  </script>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function renderMermaidSource(input: { title: string; diagram: string; theme: MermaidTheme }): string {
  const trimmed = input.diagram.trim();
  const hasInitBlock = /^%%\{\s*init:/i.test(trimmed);
  const titleComment = input.title ? `%% ${input.title}\n` : "";
  const themeBlock = hasInitBlock ? "" : `%%{init: { \"theme\": \"${input.theme}\" }}%%\n`;
  return `${titleComment}${themeBlock}${ensureTrailingNewline(trimmed)}`;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function sourceTitleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const lastSegment = parsed.pathname.split("/").filter(Boolean).pop();
    return lastSegment ? `${parsed.hostname} / ${decodeURIComponent(lastSegment)}` : parsed.hostname;
  } catch {
    return url;
  }
}

function sourceFilenameFromUrl(url: string, index: number): string {
  try {
    const parsed = new URL(url);
    const lastSegment = parsed.pathname.split("/").filter(Boolean).pop();
    if (lastSegment) {
      return decodeURIComponent(lastSegment);
    }
    const hostname = parsed.hostname.replace(/[^a-z0-9.-]+/gi, "-");
    return `${hostname || `source-${index + 1}`}.html`;
  } catch {
    return `source-${index + 1}.html`;
  }
}

async function buildPdfDocument(input: { title: string; content: string; pageSize: PdfPageSize }): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const bodyFont = await pdf.embedFont(StandardFonts.Helvetica);
  const titleFont = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pageDimensions = PDF_PAGE_SIZES[input.pageSize];
  const margin = 48;
  const maxWidth = pageDimensions.width - margin * 2;
  const lines = buildPdfLines(input.title, input.content, titleFont, bodyFont, maxWidth);

  let page = pdf.addPage([pageDimensions.width, pageDimensions.height]);
  let y = pageDimensions.height - margin;

  for (const line of lines) {
    const lineHeight = line.size * 1.45;
    if (y - lineHeight < margin) {
      page = pdf.addPage([pageDimensions.width, pageDimensions.height]);
      y = pageDimensions.height - margin;
    }

    if (line.text.length > 0) {
      page.drawText(line.text, {
        x: margin,
        y: y - line.size,
        size: line.size,
        font: line.font,
        color: rgb(0.12, 0.11, 0.1),
      });
    }

    y -= lineHeight;
  }

  return pdf.save();
}

function buildPdfLines(
  title: string,
  content: string,
  titleFont: PDFFont,
  bodyFont: PDFFont,
  maxWidth: number,
): Array<{ text: string; font: PDFFont; size: number }> {
  const lines: Array<{ text: string; font: PDFFont; size: number }> = [];

  if (title) {
    for (const line of wrapText(title, titleFont, 16, maxWidth)) {
      lines.push({ text: line, font: titleFont, size: 16 });
    }
    lines.push({ text: "", font: bodyFont, size: 11 });
  }

  for (const paragraph of content.replace(/\r\n/g, "\n").split("\n")) {
    if (!paragraph.trim()) {
      lines.push({ text: "", font: bodyFont, size: 11 });
      continue;
    }
    for (const line of wrapText(paragraph, bodyFont, 11, maxWidth)) {
      lines.push({ text: line, font: bodyFont, size: 11 });
    }
  }

  if (lines.length === 0) {
    lines.push({ text: "", font: bodyFont, size: 11 });
  }

  return lines;
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.replace(/\t/g, "    ").split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];

  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    if (!currentLine) {
      if (font.widthOfTextAtSize(word, size) <= maxWidth) {
        currentLine = word;
        continue;
      }

      const chunks = breakLongWord(word, font, size, maxWidth);
      lines.push(...chunks.slice(0, -1));
      currentLine = chunks[chunks.length - 1] ?? "";
      continue;
    }

    const candidate = `${currentLine} ${word}`;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      currentLine = candidate;
      continue;
    }

    lines.push(currentLine);
    if (font.widthOfTextAtSize(word, size) <= maxWidth) {
      currentLine = word;
      continue;
    }

    const chunks = breakLongWord(word, font, size, maxWidth);
    lines.push(...chunks.slice(0, -1));
    currentLine = chunks[chunks.length - 1] ?? "";
  }

  if (currentLine) lines.push(currentLine);
  return lines;
}

function breakLongWord(word: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const chunks: string[] = [];
  let currentChunk = "";

  for (const character of word) {
    const candidate = `${currentChunk}${character}`;
    if (!currentChunk || font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      currentChunk = candidate;
      continue;
    }

    chunks.push(currentChunk);
    currentChunk = character;
  }

  if (currentChunk) chunks.push(currentChunk);
  return chunks;
}

function basenameFromRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || normalized;
}

function contentTypeForDocumentFormat(format: DocumentFormat): string {
  switch (format) {
    case "markdown":
      return "text/markdown; charset=utf-8";
    case "text":
      return "text/plain; charset=utf-8";
    case "html":
      return "text/html; charset=utf-8";
    case "json":
      return "application/json; charset=utf-8";
  }
}

function previewModeForFormat(format: DocumentFormat): "html" | "text" | "json" | "markdown" {
  switch (format) {
    case "markdown":
      return "markdown";
    case "html":
      return "html";
    case "json":
      return "json";
    default:
      return "text";
  }
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => String(entry ?? "").trim()).filter(Boolean)
    : [];
}

function normalizeChartSeries(value: unknown): Array<{ label: string; data: number[]; color: string }> {
  if (!Array.isArray(value)) return [];

  const palette = ["#7dd3fc", "#fb7185", "#facc15", "#34d399", "#c084fc", "#f97316"];

  return value.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    if (!Array.isArray(record["data"])) return [];
    const numericData = (record["data"] as unknown[]).map((point) => Number(point));
    if (numericData.some((point) => !Number.isFinite(point))) return [];
    return [{
      label: optionalString(record["label"]) || `Series ${index + 1}`,
      data: numericData,
      color: optionalString(record["color"]) || palette[index % palette.length]!,
    }];
  });
}

function slugifyTitle(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "document";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function fail(error: string): ToolResult {
  return { success: false, output: "", error };
}
