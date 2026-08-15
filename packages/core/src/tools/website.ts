/**
 * generate_website — produce a complete static site in the workspace in one call.
 *
 * Scope: multi-page static HTML + shared CSS + optional assets. Themes are
 * inlined, no external CDN dependencies (unless explicitly enabled via
 * includeMermaid / includeHighlightJs). Pages can be authored in Markdown
 * or raw HTML; Markdown is rendered server-side with a small CommonMark
 * subset covering headings, paragraphs, lists, code blocks, blockquotes,
 * horizontal rules, links, images, emphasis, inline code, and GFM tables.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { dirname, extname, join, posix } from "node:path";
import { childLogger } from "../logger.js";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { pathExists, resolvePathWithinWorkspace, resolveWorkspaceWritePath } from "./workspace-path.js";
import { inlineLocalImagesInHtml } from "./inline-images.js";

const log = childLogger("tool:website");

type Theme = "default" | "minimal" | "dark" | "clean-docs" | "corporate";

const THEMES: Theme[] = ["default", "minimal", "dark", "clean-docs", "corporate"];

interface PageSpec {
  path: string;
  title: string;
  content: string;
  format: "markdown" | "html";
  navLabel?: string;
  includeInNav: boolean;
}

interface AssetSpec {
  path: string;
  content: string;
  encoding: "utf8" | "base64";
}

registerTool({
  name: "generate_website",
  description:
    "Generate a complete multi-page static website in the workspace in one call. Accepts pages authored in Markdown or HTML, shared theme, optional assets (css, js, images as base64), and auto-generated navigation. Produces a runnable site with an index.html, theme.css, and a preview-ready artifactKind='website' response. No external CDN dependencies by default.",
  embeddingDescription:
    "generate website static site html multi-page on-the-fly microsite landing page docs site build publish mini-site Webseite erstellen Microsite generieren statische Seite",
  parameters: {
    type: "object",
    properties: {
      outputDir: {
        type: "string",
        description: "Workspace-relative directory to write the site into. Will be created if missing.",
      },
      title: {
        type: "string",
        description: "Site title (appears in <title>, header, and meta description fallback).",
      },
      description: {
        type: "string",
        description: "Optional meta description for the site (used on every page when no page override is given).",
      },
      pages: {
        type: "array",
        description:
          "Pages to render. Each page needs path (workspace-relative within outputDir, e.g. 'index.html' or 'docs/intro.html'), title, and content. format defaults to 'markdown'. Set includeInNav=false to hide a page from the auto-generated nav. Set navLabel to override the label.",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            title: { type: "string" },
            content: { type: "string" },
            format: { type: "string", enum: ["markdown", "html"] },
            navLabel: { type: "string" },
            includeInNav: { type: "boolean" },
          },
          required: ["path", "title", "content"],
        },
      },
      theme: {
        type: "string",
        enum: [...THEMES],
        description:
          "Visual theme. default=clean general-purpose, minimal=tight monospace docs, dark=dark marketing/landing, clean-docs=doc-site sidebar, corporate=muted business report. Defaults to 'default'.",
      },
      footer: {
        type: "string",
        description: "Optional footer text or inline HTML shown below content on every page.",
      },
      assets: {
        type: "array",
        description:
          "Extra files to drop into the site (css, js, images, fonts, etc.). path is relative to outputDir. encoding='utf8' (default) for text, 'base64' for binary.",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
            encoding: { type: "string", enum: ["utf8", "base64"] },
          },
          required: ["path", "content"],
        },
      },
      includeMermaid: {
        type: "boolean",
        description: "If true, inject the Mermaid.js CDN + auto-init so ```mermaid code blocks render as diagrams.",
      },
      includeHighlightJs: {
        type: "boolean",
        description:
          "If true, include highlight.js (inlined common-lang bundle) so ``` language code blocks get syntax highlighting. Default true for clean-docs theme, false otherwise.",
      },
      overwrite: {
        type: "boolean",
        description: "When false, fail if the output directory is not empty. Default true.",
      },
    },
    required: ["outputDir", "title", "pages"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const outputDir = String(args["outputDir"] ?? "").trim();
    const title = String(args["title"] ?? "").trim();
    const description = typeof args["description"] === "string" ? String(args["description"]).trim() : "";
    const footer = typeof args["footer"] === "string" ? String(args["footer"]) : "";
    const overwrite = args["overwrite"] !== false;

    if (!outputDir) return fail("outputDir is required");
    if (!title) return fail("title is required");

    const theme = normalizeTheme(args["theme"]);
    if (!theme) return fail(`theme must be one of: ${THEMES.join(", ")}`);

    const pages = normalizePages(args["pages"]);
    if (!pages.ok) return fail(pages.error);
    if (pages.pages.length === 0) return fail("at least one page is required");

    const assets = normalizeAssets(args["assets"]);
    if (!assets.ok) return fail(assets.error);

    const includeMermaid = args["includeMermaid"] === true;
    const includeHighlightJs = args["includeHighlightJs"] === true
      || (args["includeHighlightJs"] !== false && theme === "clean-docs");

    let resolvedDir: { resolved: string; relativePath: string };
    try {
      resolvedDir = resolvePathWithinWorkspace(outputDir, ctx.workspacePath);
    } catch {
      return fail("outputDir must resolve inside the workspace");
    }

    try {
      await mkdir(resolvedDir.resolved, { recursive: true });
    } catch (err) {
      return fail(`Failed to create outputDir: ${String(err)}`);
    }

    const existingIndex = join(resolvedDir.resolved, "index.html");
    if (!overwrite && await pathExists(existingIndex)) {
      return fail(`Refusing to overwrite existing site at ${resolvedDir.relativePath}/index.html`);
    }

    const navItems = pages.pages
      .filter((p) => p.includeInNav)
      .map((p) => ({ href: p.path, label: p.navLabel || p.title }));

    const hasIndex = pages.pages.some((p) => p.path === "index.html");
    if (!hasIndex) {
      return fail("pages must include exactly one page at path 'index.html' (the site landing page)");
    }

    // Write theme.css once (shared across pages)
    const css = buildThemeCss(theme);
    try {
      await writeFile(join(resolvedDir.resolved, "theme.css"), css, "utf8");
    } catch (err) {
      return fail(`Failed to write theme.css: ${String(err)}`);
    }

    // Render every page
    const writtenPages: Array<{ path: string; bytes: number }> = [];
    for (const page of pages.pages) {
      const bodyHtml = renderPageBody(page);
      const depth = depthOfPath(page.path);
      const prefix = "../".repeat(depth);
      const pageHtml = renderPageShell({
        title: `${page.title} · ${title}`.trim(),
        siteTitle: title,
        description: description || undefined,
        bodyHtml,
        navItems,
        currentHref: page.path,
        prefix,
        footer,
        includeMermaid,
        includeHighlightJs,
      });
      const fullPath = join(resolvedDir.resolved, page.path);
      try {
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, pageHtml, "utf8");
        writtenPages.push({ path: page.path, bytes: Buffer.byteLength(pageHtml, "utf8") });
      } catch (err) {
        return fail(`Failed to write ${page.path}: ${String(err)}`);
      }
    }

    // Write assets
    const writtenAssets: Array<{ path: string; bytes: number }> = [];
    for (const asset of assets.assets) {
      const fullPath = join(resolvedDir.resolved, asset.path);
      try {
        resolvePathWithinWorkspace(fullPath, ctx.workspacePath);
      } catch {
        return fail(`asset path escapes workspace: ${asset.path}`);
      }
      try {
        await mkdir(dirname(fullPath), { recursive: true });
        const bytes = asset.encoding === "base64"
          ? Buffer.from(asset.content, "base64")
          : Buffer.from(asset.content, "utf8");
        await writeFile(fullPath, bytes);
        writtenAssets.push({ path: asset.path, bytes: bytes.byteLength });
      } catch (err) {
        return fail(`Failed to write asset ${asset.path}: ${String(err)}`);
      }
    }

    const indexRelative = posix.join(resolvedDir.relativePath.replace(/\\/g, "/"), "index.html");
    const totalBytes = Buffer.byteLength(css, "utf8")
      + writtenPages.reduce((acc, p) => acc + p.bytes, 0)
      + writtenAssets.reduce((acc, a) => acc + a.bytes, 0);

    log.info(
      {
        outputDir: resolvedDir.relativePath,
        pages: writtenPages.length,
        assets: writtenAssets.length,
        theme,
        bytes: totalBytes,
      },
      "generate_website produced site",
    );

    return {
      success: true,
      output: `Site with ${writtenPages.length} page(s) and ${writtenAssets.length} asset(s) written to ${resolvedDir.relativePath}. Open ${indexRelative}.`,
      metadata: {
        artifactKind: "website",
        outputPath: resolvedDir.relativePath,
        indexPath: indexRelative,
        pageCount: writtenPages.length,
        assetCount: writtenAssets.length,
        theme,
        totalBytes,
        previewMode: "website",
        contentType: "text/html; charset=utf-8",
      },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// generate_presentation — self-contained reveal.js HTML slide deck
// ─────────────────────────────────────────────────────────────────────────────

const REVEAL_THEMES = [
  "black", "white", "league", "beige", "sky", "night", "serif",
  "simple", "solarized", "blood", "moon", "dracula",
] as const;
type RevealTheme = (typeof REVEAL_THEMES)[number];
const DEFAULT_REVEAL_VERSION = "4.6.1";

interface SlideSpec {
  title?: string;
  content?: string;
  bullets?: string[];
  format: "markdown" | "html";
  notes?: string;
}

registerTool({
  name: "generate_presentation",
  description:
    "Generate a self-contained reveal.js HTML slide deck in the workspace from a STRUCTURED slide list — author each slide's content as compact Markdown (or bullet points), and the tool assembles the full reveal.js HTML, theme, and navigation. Use this for any 'create an HTML presentation / slide deck / reveal.js deck' deliverable instead of emitting a whole HTML document via write_file (which the model cannot reliably produce in one call). Each slide: {title?, content? (markdown), bullets?[], notes?}. Markdown in `content` is fully supported (headings, lists, links, emphasis, tables, and `![alt](url)` images). Co-located LOCAL images (e.g. `![](images/x.jpg)`) are inlined into the HTML as data URIs so the deck is self-contained and its pictures render in the preview and in a downloaded copy. Also writes a per-slide `notes.md` (the on-slide points plus each slide's speaker notes) next to index.html and surfaces it as a second artifact. Produces index.html with a preview-ready artifactKind='website' response.",
  embeddingDescription:
    "generate presentation slide deck reveal.js reveal html slides talk keynote pitch deck Präsentation Foliensatz erstellen HTML-Präsentation create slideshow",
  parameters: {
    type: "object",
    properties: {
      outputDir: {
        type: "string",
        description: "Workspace-relative directory to write the deck into (index.html). Created if missing.",
      },
      title: {
        type: "string",
        description: "Deck title (appears in <title> and as the default first slide when no title slide is provided).",
      },
      slides: {
        type: "array",
        description:
          "Ordered slide list. Each slide: title (optional heading), content (optional Markdown body — supports `![alt](url)` images), bullets (optional string array rendered as a list), format ('markdown' default or 'html' for raw content), notes (optional speaker notes). At least one of title/content/bullets is required per slide.",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            content: { type: "string" },
            bullets: { type: "array", items: { type: "string" } },
            format: { type: "string", enum: ["markdown", "html"] },
            notes: { type: "string" },
          },
        },
      },
      theme: {
        type: "string",
        enum: [...REVEAL_THEMES],
        description: "reveal.js theme. Defaults to 'white'. Common: black, white, league, sky, night, serif, moon.",
      },
      revealVersion: {
        type: "string",
        description: `reveal.js version to load from the jsDelivr CDN. Defaults to '${DEFAULT_REVEAL_VERSION}'.`,
      },
      transition: {
        type: "string",
        enum: ["none", "fade", "slide", "convex", "concave", "zoom"],
        description: "Slide transition. Defaults to 'slide'.",
      },
      overwrite: {
        type: "boolean",
        description: "When false, fail if index.html already exists. Default true.",
      },
    },
    required: ["outputDir", "title", "slides"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const outputDir = String(args["outputDir"] ?? "").trim();
    const title = String(args["title"] ?? "").trim();
    const overwrite = args["overwrite"] !== false;

    if (!outputDir) return fail("outputDir is required");
    if (!title) return fail("title is required");

    const theme = normalizeRevealTheme(args["theme"]);

    const slides = normalizeSlides(args["slides"]);
    if (!slides.ok) return fail(slides.error);
    if (slides.slides.length === 0) return fail("at least one slide is required");

    const revealVersion = normalizeRevealVersion(args["revealVersion"]);
    const transition = normalizeTransition(args["transition"]);

    let resolvedDir: { resolved: string; relativePath: string };
    try {
      // Root the deck under generated/ (same place generate_document puts the
      // paper) so the deck, its images, the notes, and the paper all co-locate
      // in ONE folder instead of a stray workspace/<dir> beside generated/.
      resolvedDir = resolveWorkspaceWritePath(outputDir, ctx.workspacePath);
    } catch {
      return fail("outputDir must resolve inside the workspace");
    }

    try {
      await mkdir(resolvedDir.resolved, { recursive: true });
    } catch (err) {
      return fail(`Failed to create outputDir: ${String(err)}`);
    }

    const indexPath = join(resolvedDir.resolved, "index.html");
    if (!overwrite && await pathExists(indexPath)) {
      return fail(`Refusing to overwrite existing deck at ${resolvedDir.relativePath}/index.html`);
    }

    const rawHtml = renderRevealDeck({ title, slides: slides.slides, theme, revealVersion, transition });
    // Inline co-located local images so the deck is self-contained and renders
    // under the query-param workspace preview (which can't resolve relative srcs).
    const html = await inlineLocalImagesInHtml(rawHtml, resolvedDir.resolved);
    try {
      await writeFile(indexPath, html, "utf8");
    } catch (err) {
      return fail(`Failed to write index.html: ${String(err)}`);
    }

    // Emit the per-slide details + speaker notes as a standalone Markdown
    // deliverable (the "Speaker-Notes" the user expects), surfaced as a nested
    // artifact so it appears alongside the deck with no extra model call.
    const extraArtifacts: Array<Record<string, unknown>> = [];
    const notesMd = buildDeckNotesMarkdown(title, slides.slides);
    const notesRelative = posix.join(resolvedDir.relativePath.replace(/\\/g, "/"), "notes.md");
    try {
      await writeFile(join(resolvedDir.resolved, "notes.md"), notesMd, "utf8");
      extraArtifacts.push({
        artifactKind: "document",
        outputPath: notesRelative,
        filename: "notes.md",
        format: "markdown",
        title: `${title} — Speaker Notes`,
        size: Buffer.byteLength(notesMd, "utf8"),
        contentType: "text/markdown; charset=utf-8",
        previewMode: "markdown",
        sourceTool: "generate_presentation",
      });
    } catch (err) {
      log.warn({ err }, "generate_presentation could not write notes.md sidecar");
    }

    const indexRelative = posix.join(resolvedDir.relativePath.replace(/\\/g, "/"), "index.html");
    const totalBytes = Buffer.byteLength(html, "utf8");
    log.info(
      { outputDir: resolvedDir.relativePath, slides: slides.slides.length, theme, revealVersion, bytes: totalBytes, notes: extraArtifacts.length > 0 },
      "generate_presentation produced reveal.js deck",
    );

    return {
      success: true,
      output: `reveal.js deck with ${slides.slides.length} slide(s) written to ${resolvedDir.relativePath}. Open ${indexRelative}.${extraArtifacts.length > 0 ? ` Per-slide speaker notes written to ${notesRelative}.` : ""}`,
      metadata: {
        artifactKind: "website",
        outputPath: resolvedDir.relativePath,
        indexPath: indexRelative,
        slideCount: slides.slides.length,
        theme,
        revealVersion,
        totalBytes,
        previewMode: "website",
        contentType: "text/html; charset=utf-8",
        ...(extraArtifacts.length > 0 ? { artifacts: extraArtifacts } : {}),
      },
    };
  },
});

// Map a few common guesses the slow model emits onto real reveal.js themes.
const REVEAL_THEME_SYNONYMS: Record<string, RevealTheme> = {
  dark: "black",
  light: "white",
  default: "black",
  bright: "white",
  modern: "simple",
  minimal: "simple",
  professional: "simple",
  corporate: "simple",
};

// Never fail the whole deck build over a theme name. The slow model frequently guesses a
// non-reveal theme ("dark", "modern", …); rejecting it cost a full build attempt + a long
// provider stall (audit 3c46a4d4: `theme:"dark"` hard-failed before the deck ever rendered).
// Map known synonyms, otherwise fall back to a sensible default.
function normalizeRevealTheme(value: unknown): RevealTheme {
  const v = String(value ?? "white").trim().toLowerCase();
  if ((REVEAL_THEMES as readonly string[]).includes(v)) return v as RevealTheme;
  return REVEAL_THEME_SYNONYMS[v] ?? "black";
}

function normalizeRevealVersion(value: unknown): string {
  const v = String(value ?? "").trim();
  // Only allow a simple semver-ish token from the CDN path — never arbitrary text in a URL.
  return /^\d+(?:\.\d+){0,2}$/.test(v) ? v : DEFAULT_REVEAL_VERSION;
}

function normalizeTransition(value: unknown): string {
  const allowed = new Set(["none", "fade", "slide", "convex", "concave", "zoom"]);
  const v = String(value ?? "slide").trim().toLowerCase();
  return allowed.has(v) ? v : "slide";
}

// Escape stray, unescaped double-quotes that appear INSIDE a JSON string value — the
// dominant way the slow local model corrupts a serialized slides/bullets string (audit
// 39953ed9: a notes value `… „Elbflorenz" rührt …` left the closing typographic quote as a
// raw " that terminated the string early and broke JSON.parse, so coercion failed and the
// build fell back to hand-written HTML). Single left-to-right pass that tracks both string
// state AND structural position (object key vs value), because the delimiter rule differs:
//   - a KEY string closes only before ':'   (e.g. `"content":`)
//   - a VALUE string closes only before ',' '}' ']' or EOF — a value is NEVER followed by
//     a colon, so a `"` inside a value that precedes ':' is a stray inner quote and must be
//     escaped. The earlier version treated ':' as a delimiter regardless of position, so a
//     German quotation like `**Begriff „Zwinger":**` inside a notes value was read as a key
//     terminator → the repaired JSON was still broken → JSON.parse failed again → every deck
//     retry bounced on "slides must be an array" (audit 3c46a4d4: presentation + speaker
//     notes never built, the step burned its whole budget on identical rejections).
// Used ONLY as a fallback after a normal JSON.parse fails, so valid JSON is never touched.
function repairUnescapedInnerQuotes(s: string): string {
  let out = "";
  let inStr = false;
  let curStringIsKey = false;
  const stack: Array<"obj" | "arr"> = [];
  let expectKey = false; // meaningful when top of stack is "obj": next opened string is a key
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (!inStr) {
      out += c;
      if (c === '"') {
        inStr = true;
        curStringIsKey = stack[stack.length - 1] === "obj" && expectKey;
      } else if (c === "{") {
        stack.push("obj");
        expectKey = true;
      } else if (c === "[") {
        stack.push("arr");
        expectKey = false;
      } else if (c === "}" || c === "]") {
        stack.pop();
      } else if (c === ":") {
        expectKey = false; // the value of the current key follows
      } else if (c === ",") {
        expectKey = stack[stack.length - 1] === "obj"; // next object entry starts with a key
      }
      continue;
    }
    if (c === "\\") { // copy an escape sequence verbatim (e.g. \" \\ \n)
      out += c + (s[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && (s[j] === " " || s[j] === "\t" || s[j] === "\n" || s[j] === "\r")) j++;
      const next = j < s.length ? s[j]! : "";
      const isDelimiter = curStringIsKey
        ? next === ":"
        : next === "" || next === "," || next === "}" || next === "]";
      if (isDelimiter) {
        out += '"'; // genuine closing delimiter
        inStr = false;
      } else {
        out += '\\"'; // stray inner quote → escape it so JSON.parse survives
      }
      continue;
    }
    out += c;
  }
  return out;
}

// The slow local model frequently serializes an ARRAY argument as a JSON STRING
// (`"slides": "[{…}]"`, `"bullets": "[\"…\"]"`) instead of a real array — a tool-calling
// quirk of small models, not a user error. Parsing it leniently lets the deck build on the
// FIRST call instead of bouncing on "slides must be an array" and burning the per-tool cap,
// which collapsed every build into hand-written-HTML timeouts (audit 2daf5f54: 5 turns /
// ~100 min before one call happened to pass a real array).
function coerceJsonArrayArg(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return value;
  try { return JSON.parse(trimmed); } catch {
    // Fallback: repair the dominant defect (unescaped inner quotes) and retry once.
    try { return JSON.parse(repairUnescapedInnerQuotes(trimmed)); } catch { return value; }
  }
}

function normalizeSlides(value: unknown): { ok: true; slides: SlideSpec[] } | { ok: false; error: string } {
  let coerced = coerceJsonArrayArg(value);
  // A single slide object (not wrapped in an array) becomes a one-slide deck.
  if (coerced && typeof coerced === "object" && !Array.isArray(coerced)) coerced = [coerced];
  if (!Array.isArray(coerced)) {
    return { ok: false, error: 'slides must be an array of slide objects (e.g. [{"title":"…","bullets":["…"]}]) — pass a JSON array, not a quoted string' };
  }
  const normalized: SlideSpec[] = [];
  for (const [i, raw] of coerced.entries()) {
    if (!raw || typeof raw !== "object") return { ok: false, error: `slides[${i}] must be an object` };
    const r = raw as Record<string, unknown>;
    const title = typeof r["title"] === "string" ? String(r["title"]).trim() : undefined;
    const content = typeof r["content"] === "string" ? String(r["content"]) : undefined;
    const bulletsValue = coerceJsonArrayArg(r["bullets"]);
    const bullets = Array.isArray(bulletsValue)
      ? bulletsValue.filter((b): b is string => typeof b === "string")
      : undefined;
    const notes = typeof r["notes"] === "string" ? String(r["notes"]) : undefined;
    const format = r["format"] === "html" ? "html" : "markdown";
    if (!title && !content && (!bullets || bullets.length === 0)) {
      return { ok: false, error: `slides[${i}] needs at least one of title, content, or bullets` };
    }
    normalized.push({ title, content, bullets, notes, format });
  }
  return { ok: true, slides: normalized };
}

/** Per-slide details + speaker notes as a standalone Markdown deliverable, built
 * from the same slide data that renders the deck (so it never drifts and costs
 * the model no extra time). */
function buildDeckNotesMarkdown(title: string, slides: SlideSpec[]): string {
  const lines: string[] = [`# ${title} — Speaker Notes`, ""];
  slides.forEach((slide, i) => {
    lines.push(`## Slide ${i + 1}${slide.title ? `: ${slide.title}` : ""}`, "");
    if (slide.bullets && slide.bullets.length > 0) {
      for (const b of slide.bullets) lines.push(`- ${b}`);
      lines.push("");
    } else if (slide.content) {
      lines.push(slide.content.trim(), "");
    }
    if (slide.notes) lines.push(`**Speaker notes:** ${slide.notes.trim()}`, "");
  });
  return lines.join("\n").trimEnd() + "\n";
}

function renderSlideSection(slide: SlideSpec): string {
  const parts: string[] = [];
  if (slide.title) parts.push(`<h2>${renderInline(slide.title)}</h2>`);
  if (slide.content) parts.push(slide.format === "html" ? slide.content : markdownToHtml(slide.content));
  if (slide.bullets && slide.bullets.length > 0) {
    parts.push(`<ul>\n${slide.bullets.map((b) => `<li>${renderInline(b)}</li>`).join("\n")}\n</ul>`);
  }
  const notes = slide.notes ? `\n<aside class="notes">\n${markdownToHtml(slide.notes)}\n</aside>` : "";
  return `<section>\n${parts.join("\n")}${notes}\n</section>`;
}

function renderRevealDeck(input: {
  title: string;
  slides: SlideSpec[];
  theme: RevealTheme;
  revealVersion: string;
  transition: string;
}): string {
  const base = `https://cdn.jsdelivr.net/npm/reveal.js@${input.revealVersion}`;
  const sections = input.slides.map(renderSlideSection).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(input.title)}</title>
  <link rel="stylesheet" href="${base}/dist/reset.css">
  <link rel="stylesheet" href="${base}/dist/reveal.css">
  <link rel="stylesheet" href="${base}/dist/theme/${input.theme}.css" id="theme">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11/styles/github.min.css">
</head>
<body>
  <div class="reveal">
    <div class="slides">
${sections}
    </div>
  </div>
  <script src="${base}/dist/reveal.js"></script>
  <script src="${base}/plugin/notes/notes.js"></script>
  <script src="${base}/plugin/markdown/markdown.js"></script>
  <script src="${base}/plugin/highlight/highlight.js"></script>
  <script>
    Reveal.initialize({
      hash: true,
      transition: ${JSON.stringify(input.transition)},
      plugins: [ RevealMarkdown, RevealHighlight, RevealNotes ]
    });
  </script>
</body>
</html>
`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Arg normalization
// ─────────────────────────────────────────────────────────────────────────────

function normalizeTheme(value: unknown): Theme | null {
  const v = String(value ?? "default").trim().toLowerCase();
  return (THEMES as string[]).includes(v) ? (v as Theme) : null;
}

function normalizePages(value: unknown): { ok: true; pages: PageSpec[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: "pages must be an array" };
  const seen = new Set<string>();
  const normalized: PageSpec[] = [];
  for (const [i, raw] of value.entries()) {
    if (!raw || typeof raw !== "object") {
      return { ok: false, error: `pages[${i}] must be an object` };
    }
    const r = raw as Record<string, unknown>;
    const rawPath = String(r["path"] ?? "").trim();
    const title = String(r["title"] ?? "").trim();
    const content = String(r["content"] ?? "");
    if (!rawPath) return { ok: false, error: `pages[${i}].path is required` };
    if (!title) return { ok: false, error: `pages[${i}].title is required` };
    if (!content) return { ok: false, error: `pages[${i}].content is required` };
    if (rawPath.includes("..") || rawPath.startsWith("/") || rawPath.startsWith("\\")) {
      return { ok: false, error: `pages[${i}].path must be a relative path without '..'` };
    }
    // Each page's markdown `content` is assembled into an HTML file, so `path` names the
    // OUTPUT html. Agents (instructed to author Markdown) routinely pass a `.md` or
    // extensionless path — audit 3ccd8015: a whole tutorial-site build failed 3× / 16 min
    // because content_writer named pages "index.md". Normalize .md/.markdown/no-extension
    // → .html instead of rejecting the build; only a foreign extension is an error.
    const ext = extname(rawPath).toLowerCase();
    let path: string;
    if (ext === ".html") {
      path = rawPath;
    } else if (ext === ".md" || ext === ".markdown" || ext === "") {
      path = rawPath.replace(/\.(md|markdown)$/i, "") + ".html";
    } else {
      return { ok: false, error: `pages[${i}].path must end in .html or .md (got ${rawPath})` };
    }
    if (seen.has(path)) return { ok: false, error: `pages[${i}].path is duplicated: ${path}` };
    seen.add(path);

    const format = r["format"] === "html" ? "html" : "markdown";
    const navLabel = typeof r["navLabel"] === "string" && String(r["navLabel"]).trim()
      ? String(r["navLabel"]).trim()
      : undefined;
    const includeInNav = r["includeInNav"] === false ? false : true;

    normalized.push({ path, title, content, format, navLabel, includeInNav });
  }
  return { ok: true, pages: normalized };
}

function normalizeAssets(value: unknown): { ok: true; assets: AssetSpec[] } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, assets: [] };
  if (!Array.isArray(value)) return { ok: false, error: "assets must be an array" };
  const seen = new Set<string>();
  const normalized: AssetSpec[] = [];
  for (const [i, raw] of value.entries()) {
    if (!raw || typeof raw !== "object") return { ok: false, error: `assets[${i}] must be an object` };
    const r = raw as Record<string, unknown>;
    const path = String(r["path"] ?? "").trim();
    const content = typeof r["content"] === "string" ? String(r["content"]) : "";
    if (!path) return { ok: false, error: `assets[${i}].path is required` };
    if (path.includes("..") || path.startsWith("/") || path.startsWith("\\")) {
      return { ok: false, error: `assets[${i}].path must be a relative path without '..'` };
    }
    if (seen.has(path)) return { ok: false, error: `assets[${i}].path is duplicated: ${path}` };
    seen.add(path);
    const encoding = r["encoding"] === "base64" ? "base64" : "utf8";
    normalized.push({ path, content, encoding });
  }
  return { ok: true, assets: normalized };
}

function depthOfPath(path: string): number {
  const parts = path.split(/[\\/]+/).filter((s) => s && s !== ".");
  return Math.max(0, parts.length - 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Themes — inlined, no CDN
// ─────────────────────────────────────────────────────────────────────────────

const BASE_CSS = `
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;line-height:1.6;-webkit-font-smoothing:antialiased}
img,svg,video{max-width:100%;height:auto;display:block}
a{color:var(--link)}a:hover{text-decoration:underline}
code{font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:.9em;padding:.15em .35em;border-radius:3px;background:var(--code-bg);color:var(--code-fg)}
pre{font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:.9em;line-height:1.55;background:var(--code-bg);color:var(--code-fg);padding:1rem;border-radius:6px;overflow:auto}
pre code{padding:0;background:transparent;border-radius:0}
blockquote{margin:1.25rem 0;padding:.5rem 1rem;border-left:4px solid var(--quote-border);background:var(--quote-bg);color:var(--quote-fg)}
hr{border:0;border-top:1px solid var(--border);margin:2rem 0}
table{border-collapse:collapse;width:100%;margin:1rem 0}
th,td{border:1px solid var(--border);padding:.5rem .75rem;text-align:left}
th{background:var(--th-bg);font-weight:600}
h1,h2,h3,h4,h5,h6{line-height:1.25;margin:2rem 0 .8rem;font-weight:600}
h1{font-size:2rem}h2{font-size:1.55rem}h3{font-size:1.25rem}h4{font-size:1.05rem}
ul,ol{padding-left:1.5rem}
li{margin:.3rem 0}
`.trim();

const THEME_VARS: Record<Theme, string> = {
  default: `
:root{
  --bg:#ffffff;--fg:#1a1f2e;--muted:#556072;--border:#e4e7ee;
  --link:#0366d6;--code-bg:#f5f7fa;--code-fg:#1a1f2e;
  --quote-bg:#f6f8fb;--quote-border:#c9d4e2;--quote-fg:#3c4555;--th-bg:#f6f8fb;
  --header-bg:#ffffff;--header-border:#e4e7ee;--nav-fg:#1a1f2e;--nav-active:#0366d6;
}
header{background:var(--header-bg);border-bottom:1px solid var(--header-border);padding:1rem 1.5rem}
header .site-title{font-weight:700;font-size:1.1rem;text-decoration:none;color:var(--fg)}
nav{display:flex;gap:1rem;margin-top:.5rem;flex-wrap:wrap}
nav a{color:var(--nav-fg);text-decoration:none;font-size:.95rem}
nav a.active{color:var(--nav-active);font-weight:600}
nav a:hover{color:var(--nav-active);text-decoration:none}
main{max-width:820px;margin:0 auto;padding:2.5rem 1.5rem 4rem}
footer{max-width:820px;margin:3rem auto 2rem;padding:1.5rem;color:var(--muted);font-size:.9rem;border-top:1px solid var(--border)}
body{background:var(--bg);color:var(--fg)}
`.trim(),
  minimal: `
:root{
  --bg:#ffffff;--fg:#111;--muted:#666;--border:#ddd;
  --link:#0066cc;--code-bg:#f4f4f4;--code-fg:#111;
  --quote-bg:transparent;--quote-border:#999;--quote-fg:#555;--th-bg:#f4f4f4;
}
body{background:var(--bg);color:var(--fg);font-family:'SFMono-Regular',Consolas,monospace;font-size:15px}
header{padding:1rem 1.5rem;border-bottom:1px solid var(--border)}
header .site-title{font-weight:700;text-decoration:none;color:var(--fg)}
nav{display:flex;gap:1.25rem;margin-top:.5rem;flex-wrap:wrap}
nav a{color:var(--fg);text-decoration:underline;font-size:.95rem}
nav a.active{color:var(--link);font-weight:600}
main{max-width:720px;margin:0 auto;padding:2rem 1.5rem 4rem}
footer{max-width:720px;margin:3rem auto 2rem;padding:1rem 1.5rem;color:var(--muted);font-size:.85rem;border-top:1px solid var(--border)}
h1,h2,h3,h4{font-family:'SFMono-Regular',Consolas,monospace}
`.trim(),
  dark: `
:root{
  --bg:#0f1419;--fg:#e6edf3;--muted:#8b949e;--border:#30363d;
  --link:#58a6ff;--code-bg:#161b22;--code-fg:#e6edf3;
  --quote-bg:#161b22;--quote-border:#30363d;--quote-fg:#8b949e;--th-bg:#161b22;
  --header-bg:#0b0f14;--header-border:#30363d;--nav-fg:#c9d1d9;--nav-active:#58a6ff;
}
body{background:var(--bg);color:var(--fg)}
header{background:var(--header-bg);border-bottom:1px solid var(--header-border);padding:1.25rem 1.5rem}
header .site-title{font-weight:700;font-size:1.15rem;text-decoration:none;color:var(--fg);letter-spacing:-.01em}
nav{display:flex;gap:1rem;margin-top:.6rem;flex-wrap:wrap}
nav a{color:var(--nav-fg);text-decoration:none;font-size:.95rem}
nav a.active{color:var(--nav-active);font-weight:600}
nav a:hover{color:var(--nav-active)}
main{max-width:880px;margin:0 auto;padding:3rem 1.5rem 5rem}
footer{max-width:880px;margin:3rem auto 2rem;padding:1.5rem;color:var(--muted);font-size:.9rem;border-top:1px solid var(--border)}
h1{font-size:2.4rem;letter-spacing:-.02em}
h2{color:#e6edf3;border-bottom:1px solid var(--border);padding-bottom:.4rem}
`.trim(),
  "clean-docs": `
:root{
  --bg:#fff;--fg:#1f2328;--muted:#59636e;--border:#d1d9e0;
  --link:#0969da;--code-bg:#f6f8fa;--code-fg:#1f2328;
  --quote-bg:transparent;--quote-border:#d0d7de;--quote-fg:#59636e;--th-bg:#f6f8fb;
  --header-bg:#24292f;--header-border:#24292f;--nav-fg:#fff;--nav-active:#58a6ff;
  --sidebar-bg:#f6f8fa;--sidebar-border:#d0d7de;
}
body{background:var(--bg);color:var(--fg);font-size:16px}
header{background:var(--header-bg);padding:.9rem 1.5rem;color:#fff}
header .site-title{color:#fff;text-decoration:none;font-weight:700}
.layout{display:grid;grid-template-columns:240px 1fr;gap:0;min-height:calc(100vh - 4rem)}
.sidebar{background:var(--sidebar-bg);border-right:1px solid var(--sidebar-border);padding:2rem 1.25rem}
.sidebar nav{display:flex;flex-direction:column;gap:.25rem;margin:0}
.sidebar nav a{color:var(--fg);text-decoration:none;padding:.4rem .6rem;border-radius:6px;font-size:.95rem}
.sidebar nav a:hover{background:#eaeef2}
.sidebar nav a.active{background:#ddf4ff;color:var(--link);font-weight:600}
main{max-width:780px;padding:2.5rem 2rem 4rem}
footer{border-top:1px solid var(--border);padding:1.5rem;color:var(--muted);font-size:.9rem}
@media (max-width:780px){.layout{grid-template-columns:1fr}.sidebar{border-right:0;border-bottom:1px solid var(--sidebar-border)}}
`.trim(),
  corporate: `
:root{
  --bg:#f7f6f2;--fg:#1d2230;--muted:#5a6276;--border:#d7d3ca;
  --link:#a35b32;--code-bg:#ece9e2;--code-fg:#1d2230;
  --quote-bg:#ece9e2;--quote-border:#a35b32;--quote-fg:#1d2230;--th-bg:#ece9e2;
  --header-bg:#1d2230;--header-border:#1d2230;--nav-fg:#f7f6f2;--nav-active:#e8c28a;
}
body{background:var(--bg);color:var(--fg);font-family:Georgia,'Times New Roman',serif}
header{background:var(--header-bg);padding:1.2rem 1.8rem;color:#f7f6f2}
header .site-title{color:#f7f6f2;text-decoration:none;font-weight:700;font-size:1.2rem;letter-spacing:.04em;text-transform:uppercase}
nav{display:flex;gap:1.3rem;margin-top:.5rem;flex-wrap:wrap}
nav a{color:var(--nav-fg);text-decoration:none;font-size:.95rem;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
nav a.active{color:var(--nav-active);font-weight:600}
main{max-width:760px;margin:0 auto;padding:3rem 1.8rem 5rem}
footer{max-width:760px;margin:3rem auto 2rem;padding:1.5rem 1.8rem;color:var(--muted);font-size:.9rem;border-top:1px solid var(--border)}
h1{font-size:2.2rem;border-bottom:2px solid var(--link);padding-bottom:.4rem}
`.trim(),
};

function buildThemeCss(theme: Theme): string {
  return `/* generate_website theme: ${theme} */\n${THEME_VARS[theme]}\n\n${BASE_CSS}\n`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Markdown → HTML (small CommonMark subset + GFM tables + fenced code)
// ─────────────────────────────────────────────────────────────────────────────

function renderPageBody(page: PageSpec): string {
  if (page.format === "html") return page.content;
  return markdownToHtml(page.content);
}

/** Markdown → HTML (CommonMark subset + GFM tables + fenced code). Shared with the PDF renderer. */
export function markdownToHtml(md: string): string {
  // Normalize line endings
  const src = md.replace(/\r\n?/g, "\n");
  const lines = src.split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Blank line
    if (/^\s*$/.test(line)) { i++; continue; }

    // Fenced code block
    const fence = line.match(/^(```+)\s*([^\s`]*)\s*$/);
    if (fence) {
      const closer = fence[1]!;
      const lang = fence[2] ?? "";
      const buf: string[] = [];
      i++;
      while (i < lines.length) {
        const l = lines[i]!;
        if (l.startsWith(closer) && /^\s*$/.test(l.slice(closer.length))) { i++; break; }
        buf.push(l);
        i++;
      }
      const code = escapeHtml(buf.join("\n"));
      const cls = lang ? ` class="language-${escapeAttr(lang)}"` : "";
      const preCls = lang === "mermaid" ? ' class="mermaid"' : "";
      if (lang === "mermaid") {
        out.push(`<pre${preCls}>${escapeHtml(buf.join("\n"))}</pre>`);
      } else {
        out.push(`<pre><code${cls}>${code}</code></pre>`);
      }
      continue;
    }

    // ATX heading
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      const level = h[1]!.length;
      const inner = renderInline(h[2]!);
      out.push(`<h${level}>${inner}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(\s*)(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) {
        buf.push(lines[i]!.replace(/^>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>\n${markdownToHtml(buf.join("\n"))}\n</blockquote>`);
      continue;
    }

    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = collectListItems(lines, i, /^\s*[-*+]\s+/);
      i = items.end;
      out.push(`<ul>\n${items.items.map((it) => `<li>${renderListItemBody(it)}</li>`).join("\n")}\n</ul>`);
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = collectListItems(lines, i, /^\s*\d+\.\s+/);
      i = items.end;
      out.push(`<ol>\n${items.items.map((it) => `<li>${renderListItemBody(it)}</li>`).join("\n")}\n</ol>`);
      continue;
    }

    // GFM table: header row | divider row | body rows (contains at least one |)
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[i + 1]!)) {
      const { html, next } = renderTable(lines, i);
      out.push(html);
      i = next;
      continue;
    }

    // Paragraph
    const pBuf: string[] = [line];
    i++;
    while (i < lines.length
      && !/^\s*$/.test(lines[i]!)
      && !/^(#{1,6})\s+/.test(lines[i]!)
      && !/^(```+)/.test(lines[i]!)
      && !/^>\s?/.test(lines[i]!)
      && !/^\s*[-*+]\s+/.test(lines[i]!)
      && !/^\s*\d+\.\s+/.test(lines[i]!)
      && !/^(\s*)(?:---+|___+|\*\*\*+)\s*$/.test(lines[i]!)
    ) {
      pBuf.push(lines[i]!);
      i++;
    }
    out.push(`<p>${renderInline(pBuf.join(" "))}</p>`);
  }

  return out.join("\n\n");
}

function collectListItems(lines: string[], start: number, bulletRe: RegExp): { items: string[]; end: number } {
  const items: string[] = [];
  let current: string[] = [];
  let i = start;
  let inItem = false;

  while (i < lines.length) {
    const line = lines[i]!;
    if (bulletRe.test(line)) {
      if (inItem) {
        items.push(current.join("\n"));
        current = [];
      }
      inItem = true;
      current.push(line.replace(bulletRe, ""));
      i++;
      continue;
    }
    if (inItem && /^\s+\S/.test(line)) {
      // continuation
      current.push(line.replace(/^\s+/, ""));
      i++;
      continue;
    }
    if (/^\s*$/.test(line)) {
      // blank line might continue a lazy list; peek ahead
      if (i + 1 < lines.length && bulletRe.test(lines[i + 1]!)) {
        i++;
        continue;
      }
      break;
    }
    break;
  }
  if (inItem) items.push(current.join("\n"));
  return { items, end: i };
}

function renderListItemBody(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes("\n")) {
    // render any nested block structure
    return markdownToHtml(trimmed);
  }
  return renderInline(trimmed);
}

function renderTable(lines: string[], start: number): { html: string; next: number } {
  const header = splitTableRow(lines[start]!);
  const divider = splitTableRow(lines[start + 1]!);
  const aligns = divider.map((cell) => {
    const c = cell.trim();
    if (c.startsWith(":") && c.endsWith(":")) return "center";
    if (c.endsWith(":")) return "right";
    if (c.startsWith(":")) return "left";
    return undefined;
  });
  const rows: string[][] = [];
  let i = start + 2;
  while (i < lines.length && lines[i]!.trim() && lines[i]!.includes("|")) {
    rows.push(splitTableRow(lines[i]!));
    i++;
  }
  const headHtml = `<thead><tr>${header.map((cell, idx) =>
    `<th${aligns[idx] ? ` style="text-align:${aligns[idx]}"` : ""}>${renderInline(cell.trim())}</th>`).join("")}</tr></thead>`;
  const bodyHtml = `<tbody>${rows.map((row) =>
    `<tr>${row.map((cell, idx) =>
      `<td${aligns[idx] ? ` style="text-align:${aligns[idx]}"` : ""}>${renderInline(cell.trim())}</td>`).join("")}</tr>`).join("")}</tbody>`;
  return { html: `<table>${headHtml}${bodyHtml}</table>`, next: i };
}

function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|");
}

function renderInline(text: string): string {
  // Order matters: code first so content inside backticks is not mangled.
  const pieces: string[] = [];
  let rest = text;

  while (rest.length > 0) {
    const code = rest.match(/`([^`]+)`/);
    if (code && code.index !== undefined) {
      pieces.push(renderInlineNoCode(rest.slice(0, code.index)));
      pieces.push(`<code>${escapeHtml(code[1]!)}</code>`);
      rest = rest.slice(code.index + code[0].length);
      continue;
    }
    pieces.push(renderInlineNoCode(rest));
    rest = "";
  }
  return pieces.join("");
}

function renderInlineNoCode(text: string): string {
  let t = escapeHtml(text);
  // Images ![alt](src "title")
  t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (_m, alt, src, title) =>
    `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}"${title ? ` title="${escapeAttr(title)}"` : ""}>`);
  // Links [text](href "title")
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (_m, inner, href, title) =>
    `<a href="${escapeAttr(href)}"${title ? ` title="${escapeAttr(title)}"` : ""}>${inner}</a>`);
  // Bold
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  // Italic
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  t = t.replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
  // Manual line breaks (two trailing spaces)
  t = t.replace(/ {2}\n/g, "<br>\n");
  return t;
}

// ─────────────────────────────────────────────────────────────────────────────
// Page shell
// ─────────────────────────────────────────────────────────────────────────────

function renderPageShell(input: {
  title: string;
  siteTitle: string;
  description?: string;
  bodyHtml: string;
  navItems: Array<{ href: string; label: string }>;
  currentHref: string;
  prefix: string;
  footer: string;
  includeMermaid: boolean;
  includeHighlightJs: boolean;
}): string {
  const sidebar = input.navItems.length > 0;
  const navHtml = input.navItems.map((item) => {
    const href = `${input.prefix}${item.href}`;
    const cls = item.href === input.currentHref ? ' class="active"' : "";
    return `<a href="${escapeAttr(href)}"${cls}>${escapeHtml(item.label)}</a>`;
  }).join("\n        ");

  const metaDescription = input.description
    ? `\n  <meta name="description" content="${escapeAttr(input.description)}">`
    : "";

  const extraScripts: string[] = [];
  if (input.includeMermaid) {
    extraScripts.push(`
  <script type="module">
    import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
    mermaid.initialize({ startOnLoad: true, theme: "default" });
  </script>`);
  }
  if (input.includeHighlightJs) {
    extraScripts.push(`
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11/styles/github.min.css">
  <script src="https://cdn.jsdelivr.net/npm/highlight.js@11/lib/index.min.js"></script>
  <script>document.addEventListener("DOMContentLoaded", () => { if (window.hljs) window.hljs.highlightAll(); });</script>`);
  }

  // Hacky theme detector: clean-docs uses a sidebar layout; other themes use header/nav.
  const useCleanDocsLayout = input.navItems.length > 0 && /clean-docs/.test(String((globalThis as any).__starlingCurrentTheme ?? ""));
  // We don't have theme here directly; build an alternate shell using attribute detection via class.
  const footerHtml = input.footer ? `<footer>${input.footer}</footer>` : "";

  const chromeHeader = sidebar
    ? `<header><a class="site-title" href="${escapeAttr(input.prefix)}index.html">${escapeHtml(input.siteTitle)}</a></header>`
    : `<header>
      <a class="site-title" href="${escapeAttr(input.prefix)}index.html">${escapeHtml(input.siteTitle)}</a>
      <nav>
        ${navHtml}
      </nav>
    </header>`;

  const mainContent = `<main>${input.bodyHtml}</main>${footerHtml}`;

  // Always emit both nav styles; the themes style them differently (corporate/dark/default use
  // header nav; clean-docs re-uses .layout + .sidebar).
  const body = sidebar
    ? `${chromeHeader}
    <div class="layout">
      <aside class="sidebar">
        <nav>
          ${navHtml}
        </nav>
      </aside>
      ${mainContent}
    </div>`
    : `${chromeHeader}
    ${mainContent}`;

  // Suppress unused-var warning for useCleanDocsLayout (kept for future theme-specific toggles).
  void useCleanDocsLayout;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(input.title)}</title>${metaDescription}
  <link rel="stylesheet" href="${escapeAttr(input.prefix)}theme.css">${extraScripts.join("")}
</head>
<body>
    ${body}
</body>
</html>
`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fail(error: string): ToolResult {
  return { success: false, output: "", error };
}
