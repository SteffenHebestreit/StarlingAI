/**
 * render_pdf — Markdown/HTML → a typeset PDF, via headless Chromium over CDP.
 *
 * This is the tool to reach for when the user will SEND the result to someone: a
 * CV, an offer, an invoice, a report. It differs from `generate_pdf` (pdf-lib) in
 * kind, not degree — that one draws unstyled 11pt lines and throws outright on any
 * character outside cp1252 (`→`, `✓`, emoji, CJK), which is exactly the set an LLM
 * reaches for in a bullet list. Here the document is real HTML rendered by Chrome:
 * headings, bold, bullets, tables, page breaks, web-safe unicode, and a print
 * stylesheet with `@page` margins and widow/orphan control.
 *
 * The HTML is assembled and fully inlined HERE (local images → data: URIs) and then
 * pushed into the page over the debugger socket, so the renderer never fetches
 * anything. See ../render/cdp-pdf.ts for why that shape was chosen.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { childLogger } from "../logger.js";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { overwriteGuard, resolveWorkspaceWritePath } from "./workspace-path.js";
import { inlineLocalImagesInHtml } from "./inline-images.js";
import { markdownToHtml } from "./website.js";
import { renderHtmlToPdf, type PdfRenderOptions } from "../render/cdp-pdf.js";

const log = childLogger("tool:render-pdf");

const THEMES = ["document", "cv", "report", "plain"] as const;
const PAGE_SIZES = ["A4", "Letter", "Legal"] as const;

type Theme = typeof THEMES[number];
type PageSize = typeof PAGE_SIZES[number];

function fail(error: string): ToolResult {
  return { success: false, output: "", error };
}

registerTool({
  name: "render_pdf",
  description:
    "Render a Markdown (or HTML) document into a properly typeset, send-ready PDF using a real browser engine — headings, bold, bullet lists, tables, page breaks, and full unicode. " +
    "Use this for any PDF a human will receive or print: CVs and résumés, cover letters, offers, invoices, reports, and handouts. " +
    "Prefer this over generate_pdf, which produces unstyled text and fails on characters like → or ✓. " +
    "You MUST supply the complete document text in `content` — this tool typesets exactly what you pass, it does not author content itself.",
  embeddingDescription:
    "render create generate a real formatted PDF document with proper layout typography headings tables — CV resume curriculum vitae, cover letter, invoice, offer, report, printable handout, send-ready file. " +
    "PDF erstellen, Lebenslauf als PDF, Bewerbung, Rechnung, Bericht drucken, formatiertes Dokument.",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Document title. Used for the PDF metadata and the derived filename.",
      },
      content: {
        type: "string",
        description:
          "REQUIRED. The complete document body as Markdown (default) or a full HTML document when format is 'html'. " +
          "Markdown supports headings (#..######), **bold**, *italic*, bullet and numbered lists, GFM tables, blockquotes, fenced code, links and images. " +
          "This tool typesets exactly what you pass and does NOT generate content on its own.",
      },
      format: {
        type: "string",
        enum: ["markdown", "html"],
        description: "How to interpret `content`. 'html' expects a complete document and skips the built-in stylesheet unless theme is set.",
        default: "markdown",
      },
      theme: {
        type: "string",
        enum: [...THEMES],
        description:
          "Print style. 'document' = clean general-purpose report (default). " +
          "'cv' = compact single-column résumé: tight spacing, ruled section headings, dates aligned right. " +
          "'report' = titled business report with serif body copy. 'plain' = minimal, near-unstyled.",
        default: "document",
      },
      page_size: {
        type: "string",
        enum: [...PAGE_SIZES],
        description: "Paper size.",
        default: "A4",
      },
      landscape: {
        type: "boolean",
        description: "Render in landscape orientation.",
        default: false,
      },
      page_numbers: {
        type: "boolean",
        description: "Print 'page N of M' in the footer. Off by default — a one-page CV should not carry one.",
        default: false,
      },
      output_file: {
        type: "string",
        description: "Workspace-relative output path ending in .pdf. If omitted, a filename is derived from the title.",
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
    const content = typeof args["content"] === "string" ? args["content"] : "";
    const title = typeof args["title"] === "string" ? args["title"].trim() : "";
    const format = String(args["format"] ?? "markdown").trim().toLowerCase();
    const theme = String(args["theme"] ?? "document").trim().toLowerCase() as Theme;
    const pageSize = String(args["page_size"] ?? "A4").trim() as PageSize;
    const landscape = args["landscape"] === true;
    const pageNumbers = args["page_numbers"] === true;
    const overwrite = args["overwrite"] !== false;

    if (!content.trim()) {
      return fail("content is required: pass the FULL document text in the `content` field. This tool typesets what you provide; it does not author the document. Retry with content populated.");
    }
    if (format !== "markdown" && format !== "html") return fail("format must be either 'markdown' or 'html'");
    if (!(THEMES as readonly string[]).includes(theme)) return fail(`theme must be one of: ${THEMES.join(", ")}`);
    if (!(PAGE_SIZES as readonly string[]).includes(pageSize)) return fail(`page_size must be one of: ${PAGE_SIZES.join(", ")}`);

    const resolved = resolveOutputPath(args["output_file"], title, ctx.workspacePath);
    if (!resolved.ok) return fail(resolved.error);

    const refusal = await overwriteGuard(resolved.resolved, resolved.relativePath, overwrite);
    if (refusal) return fail(refusal);

    // Inline co-located images relative to the OUTPUT folder, matching generate_document:
    // the renderer cannot resolve `images/x`, and it is blocked from fetching anyway.
    const outDir = dirname(resolved.resolved);
    const body = format === "html" ? content : markdownToHtml(content);
    const html = await inlineLocalImagesInHtml(buildDocument({ title, body, theme, pageSize, landscape }), outDir);

    const render = await renderHtmlToPdf(html, {
      format: pageSize,
      landscape,
      preferCssPageSize: true,
      printBackground: true,
      ...(pageNumbers ? { footerHtml: FOOTER_TEMPLATE, headerHtml: EMPTY_TEMPLATE } : {}),
    } satisfies PdfRenderOptions);

    if (!render.ok) return fail(render.error);

    try {
      await mkdir(outDir, { recursive: true });
      await writeFile(resolved.resolved, render.bytes);
    } catch (err) {
      log.error({ err, outputFile: resolved.relativePath }, "render_pdf write failed");
      return fail(`Failed to write PDF: ${String(err)}`);
    }

    return {
      success: true,
      output: `PDF saved to ${resolved.relativePath} (${render.bytes.length} bytes, ${theme} theme, ${pageSize}).`,
      metadata: {
        artifactKind: "document",
        outputPath: resolved.relativePath,
        filename: basenameOf(resolved.relativePath),
        format: "pdf",
        theme,
        pageSize,
        title: title || undefined,
        bytes: render.bytes.length,
        contentType: "application/pdf",
        previewMode: "pdf",
      },
    };
  },
});

function resolveOutputPath(
  requested: unknown,
  title: string,
  workspacePath: string,
): { ok: true; resolved: string; relativePath: string } | { ok: false; error: string } {
  const raw = typeof requested === "string" ? requested.trim() : "";
  const candidate = raw || `${slugify(title || "document")}.pdf`;
  const withExt = extname(candidate) ? candidate : `${candidate}.pdf`;
  if (extname(withExt).toLowerCase() !== ".pdf") {
    return { ok: false, error: "output_file must use the .pdf extension" };
  }
  try {
    const { resolved, relativePath } = resolveWorkspaceWritePath(withExt, workspacePath);
    return { ok: true, resolved, relativePath };
  } catch {
    return { ok: false, error: "output_file must be a relative path within the workspace" };
  }
}

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "document";
}

function basenameOf(relativePath: string): string {
  const parts = relativePath.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || relativePath;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const EMPTY_TEMPLATE = "<span></span>";
// Chrome only honours its own classes here, and the template inherits NO page CSS.
const FOOTER_TEMPLATE =
  '<div style="width:100%;font-size:8pt;color:#777;padding:0 14mm;text-align:right;font-family:sans-serif;">'
  + '<span class="pageNumber"></span> / <span class="totalPages"></span></div>';

/**
 * Shared print rules. `@page` owns the paper and margins (printToPDF is called with
 * preferCSSPageSize), and the break rules are the ones that separate a document that
 * merely fits on pages from one that reads correctly across them: never strand a
 * heading at the foot of a page, never split a table row or a list item.
 */
function baseCss(pageSize: PageSize, landscape: boolean): string {
  return `
@page { size: ${pageSize}${landscape ? " landscape" : ""}; margin: 18mm 16mm; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { -webkit-print-color-adjust: exact; print-color-adjust: exact; orphans: 3; widows: 3; }
h1, h2, h3, h4, h5, h6 { break-after: avoid; page-break-after: avoid; margin: 0 0 .4em; }
h1 + *, h2 + *, h3 + * { break-before: avoid; page-break-before: avoid; }
p, li { orphans: 3; widows: 3; }
li { break-inside: avoid; page-break-inside: avoid; }
img { max-width: 100%; height: auto; break-inside: avoid; }
table { width: 100%; border-collapse: collapse; break-inside: auto; margin: .9em 0; }
tr { break-inside: avoid; page-break-inside: avoid; }
thead { display: table-header-group; }
blockquote { break-inside: avoid; }
pre { white-space: pre-wrap; word-wrap: break-word; break-inside: avoid; }
a { color: inherit; text-decoration: none; }
hr { border: 0; border-top: 1px solid #d8d8d8; margin: 1.4em 0; }
.page-break { break-after: page; page-break-after: always; }
`.trim();
}

const THEME_CSS: Record<Theme, string> = {
  document: `
body { font: 10.5pt/1.55 "Helvetica Neue", Helvetica, Arial, "DejaVu Sans", sans-serif; color: #1c1c1e; }
h1 { font-size: 20pt; letter-spacing: -.35pt; margin-bottom: .25em; }
h2 { font-size: 13pt; margin-top: 1.5em; padding-bottom: .18em; border-bottom: 1px solid #dcdcdc; }
h3 { font-size: 11.5pt; margin-top: 1.15em; }
p { margin: 0 0 .7em; }
ul, ol { margin: .3em 0 .9em; padding-left: 1.15em; }
li { margin: .2em 0; }
th, td { border: 1px solid #d8d8d8; padding: .42em .6em; text-align: left; font-size: 9.8pt; }
th { background: #f4f4f6; font-weight: 600; }
blockquote { margin: 1em 0; padding: .4em .9em; border-left: 3px solid #c9c9cf; color: #494950; }
code { font: .92em/1.4 "DejaVu Sans Mono", Consolas, monospace; background: #f4f4f6; padding: .1em .3em; border-radius: 3px; }
pre { background: #f4f4f6; padding: .7em .9em; border-radius: 5px; font-size: 9pt; }
a { text-decoration: underline; text-decoration-color: #b9b9c2; }
`.trim(),

  // Résumé: tight vertical rhythm (a CV lives or dies on fitting cleanly), ruled
  // section headings, and a right-aligned date column driven purely by markdown —
  // "**Role — Company** `2020 – 2024`" puts the trailing code span on the right.
  cv: `
body { font: 10pt/1.42 "Helvetica Neue", Helvetica, Arial, "DejaVu Sans", sans-serif; color: #16181d; }
h1 { font-size: 21pt; font-weight: 650; letter-spacing: -.5pt; margin: 0 0 .1em; }
h1 + p { margin: 0 0 1.1em; color: #55585f; font-size: 9.6pt; }
h2 { font-size: 9.2pt; font-weight: 700; text-transform: uppercase; letter-spacing: 1.1pt;
     color: #16181d; margin: 1.35em 0 .5em; padding-bottom: .22em; border-bottom: 1.3px solid #16181d; }
h3 { font-size: 10.2pt; font-weight: 650; margin: .75em 0 .1em; display: flex;
     justify-content: space-between; align-items: baseline; gap: 1em; }
h3 code { font: 400 9.2pt/1.4 inherit; background: none; color: #6a6d75; white-space: nowrap; }
p { margin: 0 0 .45em; }
ul { margin: .25em 0 .6em; padding-left: 1.05em; }
li { margin: .13em 0; }
th, td { border: 0; border-bottom: 1px solid #e6e6ea; padding: .3em .5em .3em 0; font-size: 9.6pt; }
th { font-weight: 650; }
code { font-family: inherit; background: none; }
/* Without this a quote falls back to the browser's 40px indent, which reads as a
   stray block in an otherwise flush-left résumé. */
blockquote { margin: .3em 0 .6em; padding-left: .7em; border-left: 2px solid #d8d9de; color: #4a4d55; }
blockquote p { margin: 0; }
a { color: #2c4b8f; }
hr { margin: 1em 0; }
`.trim(),

  report: `
body { font: 11pt/1.6 Georgia, "Times New Roman", "DejaVu Serif", serif; color: #1d2230; }
h1 { font: 700 23pt/1.2 "Helvetica Neue", Helvetica, Arial, sans-serif; margin: 0 0 .5em;
     padding-bottom: .3em; border-bottom: 2.5px solid #1d2230; }
h2 { font: 650 14pt/1.3 "Helvetica Neue", Helvetica, Arial, sans-serif; margin: 1.6em 0 .45em; color: #1d2230; }
h3 { font: 650 11.5pt/1.35 "Helvetica Neue", Helvetica, Arial, sans-serif; margin: 1.15em 0 .3em; }
p { margin: 0 0 .8em; text-align: justify; hyphens: auto; }
ul, ol { margin: .4em 0 1em; padding-left: 1.3em; }
th, td { border: 1px solid #cfd0d6; padding: .45em .65em; font: 9.8pt/1.45 "Helvetica Neue", Helvetica, Arial, sans-serif; }
th { background: #eceef3; font-weight: 650; }
blockquote { margin: 1.1em 0; padding: .5em 1em; border-left: 3px solid #8a5c3b; color: #3a3f4d; font-style: italic; }
code, pre { font-family: "DejaVu Sans Mono", Consolas, monospace; font-size: 9pt; }
pre { background: #f3f3f6; padding: .8em 1em; }
`.trim(),

  plain: `
body { font: 11pt/1.5 "DejaVu Sans", Arial, sans-serif; color: #000; }
h1 { font-size: 17pt; } h2 { font-size: 13.5pt; } h3 { font-size: 11.5pt; }
p { margin: 0 0 .6em; }
th, td { border: 1px solid #999; padding: .35em .5em; }
`.trim(),
};

function buildDocument(input: { title: string; body: string; theme: Theme; pageSize: PageSize; landscape: boolean }): string {
  // An `html` payload that is already a full document keeps its own <head>; we only
  // add the print rules, which a hand-authored page almost never carries.
  const isFullDocument = /<html[\s>]/i.test(input.body);
  const css = `${baseCss(input.pageSize, input.landscape)}\n${THEME_CSS[input.theme]}`;

  if (isFullDocument) {
    const styleTag = `<style>${css}</style>`;
    return /<\/head>/i.test(input.body)
      ? input.body.replace(/<\/head>/i, `${styleTag}</head>`)
      : `${styleTag}\n${input.body}`;
  }

  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>${escapeHtml(input.title || "Document")}</title>`,
    `<style>${css}</style>`,
    "</head><body>",
    input.body,
    "</body></html>",
    "",
  ].join("\n");
}
