/**
 * Office artifact emitters — Wave C.
 *
 * generate_docx — emit a Word .docx from a Markdown-like body or a structured
 *                 paragraph/heading/list/table list. Uses the `docx` package.
 * generate_pptx — emit a PowerPoint .pptx from a structured slide list. Uses
 *                 the `pptxgenjs` package.
 */
import { mkdir, stat, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { dirname, extname } from "node:path";
import {
  AlignmentType,
  Document as DocxDocument,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
// pptxgenjs ships UMD-style typings (`export as namespace`) which trip
// TS NodeNext default-import detection. Load it through createRequire so
// we get the runtime constructor without the type-system surprise.
const PptxGenJS = require("pptxgenjs") as new () => {
  title?: string;
  author?: string;
  addSlide(): {
    background?: { color: string };
    addText(text: string | Array<{ text: string; options?: Record<string, unknown> }>, options?: Record<string, unknown>): void;
    addImage(opts: { data: string; x: number; y: number; w: number; h: number }): void;
    addNotes(notes: string): void;
  };
  write(opts: { outputType: string }): Promise<unknown>;
};
import { childLogger } from "../logger.js";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { resolvePathWithinWorkspace } from "./workspace-path.js";
import { PRODUCT } from "../product/index.js";

const log = childLogger("tool:office-output");

function fail(message: string): ToolResult {
  return { success: false, output: "", error: message };
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

async function resolveOutputFile(
  args: Record<string, unknown>,
  ctx: ToolContext,
  expectedExt: string,
  fallbackTitle: string,
): Promise<{ ok: true; resolved: string; relativePath: string } | { ok: false; error: string }> {
  const requestedRaw = typeof args["output_file"] === "string" ? String(args["output_file"]).trim() : "";
  const titleRaw = typeof args["title"] === "string" ? String(args["title"]).trim() : "";
  const requested = requestedRaw || `${slugify(titleRaw || fallbackTitle)}${expectedExt}`;
  if (extname(requested).toLowerCase() !== expectedExt) {
    return { ok: false, error: `output_file must use the ${expectedExt} extension` };
  }
  try {
    const r = resolvePathWithinWorkspace(requested, ctx.workspacePath);
    return { ok: true, resolved: r.resolved, relativePath: r.relativePath };
  } catch {
    return { ok: false, error: "output_file must resolve inside the workspace" };
  }
}

async function refuseIfExists(resolvedPath: string, relativePath: string, overwrite: boolean): Promise<string | null> {
  if (overwrite) return null;
  try {
    await stat(resolvedPath);
    return `Refusing to overwrite existing file: ${relativePath}`;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// generate_docx
// ─────────────────────────────────────────────────────────────────────────────

interface DocxBlock {
  type: "heading" | "paragraph" | "bullets" | "numbered" | "table" | "image" | "page_break";
  level?: 1 | 2 | 3 | 4 | 5 | 6;
  text?: string;
  items?: string[];
  rows?: string[][];
  imagePathBase64?: string;
  imageWidthPt?: number;
  imageHeightPt?: number;
  imageMime?: string;
  alignment?: "left" | "center" | "right";
}

registerTool({
  name: "generate_docx",
  description:
    "Generate and save a Microsoft Word .docx in the workspace. Accepts either Markdown-like text via 'content' (auto-converted) or a structured 'blocks' array of {type: 'heading'|'paragraph'|'bullets'|'numbered'|'table'|'image'|'page_break'} entries for richer layout. Best for business letters, formal reports, contract drafts, and any deliverable where the recipient expects to open in Word.",
  embeddingDescription:
    "docx word document generate write business letter report office microsoft formal deliverable Word-Dokument erstellen",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Optional document title (rendered as Heading 1 at the top when no explicit heading block exists).",
      },
      content: {
        type: "string",
        description: "Markdown-like body. Used when 'blocks' is not provided. Headings (#..######), paragraphs (blank-line-separated), bullets (-/*), and numbered lists (1.) are recognized. For richer layout (tables, images, page breaks) pass 'blocks' instead.",
      },
      blocks: {
        type: "array",
        description: "Structured block list. Each: {type, ...}. Supported types: heading (level, text, alignment), paragraph (text, alignment), bullets (items[]), numbered (items[]), table (rows[][]), image (imagePathBase64, imageMime, imageWidthPt, imageHeightPt), page_break.",
        items: { type: "object" },
      },
      author: {
        type: "string",
        description: "Optional author name embedded in document properties.",
      },
      output_file: {
        type: "string",
        description: "Workspace-relative output path (must end in .docx). Defaults to a slug of the title.",
      },
      overwrite: {
        type: "boolean",
        description: "When false, fail instead of overwriting an existing file. Default true.",
      },
    },
    required: [],
  },
  async execute(args, ctx) {
    const title = typeof args["title"] === "string" ? String(args["title"]).trim() : "";
    const author = typeof args["author"] === "string" ? String(args["author"]).trim() : "";
    const overwrite = args["overwrite"] !== false;
    const blocks = Array.isArray(args["blocks"]) ? args["blocks"] as DocxBlock[] : [];
    const content = typeof args["content"] === "string" ? String(args["content"]) : "";

    if (blocks.length === 0 && !content.trim()) {
      return fail("either content or blocks is required");
    }

    const resolvedRes = await resolveOutputFile(args, ctx, ".docx", title || "document");
    if (!resolvedRes.ok) return fail(resolvedRes.error);

    const refusal = await refuseIfExists(resolvedRes.resolved, resolvedRes.relativePath, overwrite);
    if (refusal) return fail(refusal);

    const renderableBlocks = blocks.length > 0
      ? blocks
      : markdownToBlocks(content);

    const paragraphs: (Paragraph | Table)[] = [];
    if (title && (renderableBlocks.length === 0 || renderableBlocks[0]?.type !== "heading" || renderableBlocks[0]?.level !== 1)) {
      paragraphs.push(buildHeadingParagraph(title, 1, "left"));
    }
    for (const block of renderableBlocks) {
      try {
        const built = buildBlock(block);
        if (Array.isArray(built)) paragraphs.push(...built);
        else if (built) paragraphs.push(built);
      } catch (err) {
        return fail(`block render failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    let buffer: Buffer;
    try {
      const doc = new DocxDocument({
        creator: author || PRODUCT.name,
        title: title || undefined,
        sections: [{ properties: {}, children: paragraphs }],
      });
      buffer = await Packer.toBuffer(doc);
    } catch (err) {
      log.error({ err }, "docx packer failed");
      return fail(`docx packer failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      await mkdir(dirname(resolvedRes.resolved), { recursive: true });
      await writeFile(resolvedRes.resolved, buffer);
    } catch (err) {
      return fail(`Failed to write .docx: ${String(err)}`);
    }

    return {
      success: true,
      output: `DOCX saved to ${resolvedRes.relativePath} (${buffer.byteLength} bytes).`,
      metadata: {
        artifactKind: "document",
        outputPath: resolvedRes.relativePath,
        format: "docx",
        title: title || undefined,
        bytes: buffer.byteLength,
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        previewMode: "download",
      },
    };
  },
});

function markdownToBlocks(md: string): DocxBlock[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: DocxBlock[] = [];
  let i = 0;
  let paraBuf: string[] = [];

  function flushPara() {
    if (paraBuf.length === 0) return;
    blocks.push({ type: "paragraph", text: paraBuf.join(" ") });
    paraBuf = [];
  }

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (/^\s*$/.test(line)) {
      flushPara();
      i++;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushPara();
      const level = Math.min(6, heading[1]!.length) as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ type: "heading", level, text: heading[2]!.trim() });
      i++;
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*[-*+]\s+/, ""));
        i++;
      }
      blocks.push({ type: "bullets", items });
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      blocks.push({ type: "numbered", items });
      continue;
    }
    paraBuf.push(line);
    i++;
  }
  flushPara();
  return blocks;
}

function buildBlock(block: DocxBlock): Paragraph | Table | Paragraph[] | null {
  switch (block.type) {
    case "heading": {
      const level = (block.level ?? 1) as 1 | 2 | 3 | 4 | 5 | 6;
      return buildHeadingParagraph(block.text ?? "", level, block.alignment ?? "left");
    }
    case "paragraph":
      return new Paragraph({
        children: [new TextRun({ text: block.text ?? "" })],
        alignment: alignmentFor(block.alignment),
      });
    case "bullets":
      return (block.items ?? []).map((item) =>
        new Paragraph({
          children: [new TextRun({ text: item })],
          bullet: { level: 0 },
        }),
      );
    case "numbered":
      return (block.items ?? []).map((item) =>
        new Paragraph({
          children: [new TextRun({ text: item })],
          numbering: { reference: "starlingai-numbered", level: 0 },
        }),
      );
    case "table": {
      const rows = block.rows ?? [];
      if (rows.length === 0) return null;
      const cellWidthPercent = Math.floor(100 / Math.max(1, rows[0]?.length ?? 1));
      const tableRows = rows.map((row, rowIdx) =>
        new TableRow({
          children: row.map((cell) =>
            new TableCell({
              width: { size: cellWidthPercent, type: WidthType.PERCENTAGE },
              children: [new Paragraph({
                children: [new TextRun({ text: cell, bold: rowIdx === 0 })],
              })],
            }),
          ),
        }),
      );
      return new Table({
        rows: tableRows,
        width: { size: 100, type: WidthType.PERCENTAGE },
      });
    }
    case "page_break":
      return new Paragraph({ children: [new TextRun({ text: "", break: 1 })], pageBreakBefore: true });
    case "image": {
      const base64 = block.imagePathBase64 ?? "";
      if (!base64) return null;
      const data = Buffer.from(base64, "base64");
      const width = Math.max(8, Math.trunc(block.imageWidthPt ?? 320));
      const height = Math.max(8, Math.trunc(block.imageHeightPt ?? 200));
      const imageType = imageTypeFromMime(block.imageMime);
      return new Paragraph({
        children: [
          new ImageRun({
            data,
            type: imageType,
            transformation: { width, height },
          } as ConstructorParameters<typeof ImageRun>[0]),
        ],
        alignment: alignmentFor(block.alignment),
      });
    }
  }
  return null;
}

function imageTypeFromMime(mime?: string): "png" | "jpg" | "gif" | "bmp" {
  switch ((mime ?? "").toLowerCase()) {
    case "image/png": return "png";
    case "image/jpeg":
    case "image/jpg": return "jpg";
    case "image/gif": return "gif";
    case "image/bmp": return "bmp";
    default: return "png";
  }
}

function buildHeadingParagraph(text: string, level: 1 | 2 | 3 | 4 | 5 | 6, alignment: "left" | "center" | "right"): Paragraph {
  const headingMap: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
    1: HeadingLevel.HEADING_1,
    2: HeadingLevel.HEADING_2,
    3: HeadingLevel.HEADING_3,
    4: HeadingLevel.HEADING_4,
    5: HeadingLevel.HEADING_5,
    6: HeadingLevel.HEADING_6,
  };
  return new Paragraph({
    heading: headingMap[level],
    children: [new TextRun({ text, bold: true })],
    alignment: alignmentFor(alignment),
  });
}

function alignmentFor(value?: string): (typeof AlignmentType)[keyof typeof AlignmentType] | undefined {
  switch (value) {
    case "center": return AlignmentType.CENTER;
    case "right": return AlignmentType.RIGHT;
    case "left": return AlignmentType.LEFT;
    default: return undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// generate_pptx
// ─────────────────────────────────────────────────────────────────────────────

interface SlideSpec {
  layout?: "title" | "title-content" | "two-column" | "section-divider" | "blank";
  title?: string;
  subtitle?: string;
  bullets?: string[];
  body?: string;
  leftBullets?: string[];
  rightBullets?: string[];
  imageBase64?: string;
  imageMime?: string;
  notes?: string;
}

registerTool({
  name: "generate_pptx",
  description:
    "Generate a PowerPoint .pptx in the workspace from a structured slide list. Each slide picks a layout (title, title-content, two-column, section-divider, blank) and provides title/subtitle/bullets/body/imageBase64 fields appropriate for that layout. Best for kickoffs, status decks, training material, and any deliverable that needs to open in PowerPoint.",
  embeddingDescription:
    "pptx powerpoint slides generate write deck presentation kickoff training office Folie erstellen",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Deck title (used in document properties and the default first-slide header when slides is omitted).",
      },
      author: {
        type: "string",
        description: "Optional author name embedded in document properties.",
      },
      slides: {
        type: "array",
        description: "Slide list. Each: {layout, title?, subtitle?, bullets[]?, body?, leftBullets[]?, rightBullets[]?, imageBase64?, imageMime?, notes?}.",
        items: { type: "object" },
      },
      output_file: {
        type: "string",
        description: "Workspace-relative output path (must end in .pptx).",
      },
      overwrite: {
        type: "boolean",
        description: "When false, fail instead of overwriting an existing file. Default true.",
      },
    },
    required: ["slides"],
  },
  async execute(args, ctx) {
    const slides = Array.isArray(args["slides"]) ? args["slides"] as SlideSpec[] : [];
    if (slides.length === 0) return fail("slides must be a non-empty array");

    const title = typeof args["title"] === "string" ? String(args["title"]).trim() : "";
    const author = typeof args["author"] === "string" ? String(args["author"]).trim() : "";
    const overwrite = args["overwrite"] !== false;

    const resolvedRes = await resolveOutputFile(args, ctx, ".pptx", title || "deck");
    if (!resolvedRes.ok) return fail(resolvedRes.error);

    const refusal = await refuseIfExists(resolvedRes.resolved, resolvedRes.relativePath, overwrite);
    if (refusal) return fail(refusal);

    const pptx = new PptxGenJS();
    if (title) pptx.title = title;
    if (author) pptx.author = author;

    for (const slide of slides) {
      const s = pptx.addSlide();
      const layout = slide.layout ?? "title-content";
      switch (layout) {
        case "title":
          if (slide.title) s.addText(slide.title, { x: 0.5, y: 2.5, w: 9, h: 1.2, fontSize: 36, bold: true, align: "center" });
          if (slide.subtitle) s.addText(slide.subtitle, { x: 0.5, y: 3.8, w: 9, h: 0.8, fontSize: 18, color: "595959", align: "center" });
          break;
        case "section-divider":
          s.background = { color: "1F2937" };
          if (slide.title) s.addText(slide.title, { x: 0.5, y: 2.8, w: 9, h: 1.4, fontSize: 32, bold: true, color: "FFFFFF", align: "center" });
          if (slide.subtitle) s.addText(slide.subtitle, { x: 0.5, y: 4.0, w: 9, h: 0.6, fontSize: 16, color: "D1D5DB", align: "center" });
          break;
        case "two-column": {
          if (slide.title) s.addText(slide.title, { x: 0.5, y: 0.4, w: 9, h: 0.8, fontSize: 24, bold: true });
          const leftItems = (slide.leftBullets ?? []).map((b) => ({ text: b, options: { bullet: true } as Record<string, unknown> }));
          const rightItems = (slide.rightBullets ?? []).map((b) => ({ text: b, options: { bullet: true } as Record<string, unknown> }));
          if (leftItems.length > 0) s.addText(leftItems, { x: 0.5, y: 1.4, w: 4.4, h: 5.5, fontSize: 14 });
          if (rightItems.length > 0) s.addText(rightItems, { x: 5.1, y: 1.4, w: 4.4, h: 5.5, fontSize: 14 });
          break;
        }
        case "blank":
          if (slide.body) s.addText(slide.body, { x: 0.5, y: 0.5, w: 9, h: 6.5, fontSize: 14 });
          break;
        case "title-content":
        default: {
          if (slide.title) s.addText(slide.title, { x: 0.5, y: 0.4, w: 9, h: 0.8, fontSize: 24, bold: true });
          if (slide.bullets && slide.bullets.length > 0) {
            const items = slide.bullets.map((b) => ({ text: b, options: { bullet: true } as Record<string, unknown> }));
            s.addText(items, { x: 0.5, y: 1.4, w: 9, h: 5.5, fontSize: 14 });
          } else if (slide.body) {
            s.addText(slide.body, { x: 0.5, y: 1.4, w: 9, h: 5.5, fontSize: 14 });
          }
          if (slide.imageBase64) {
            const mime = slide.imageMime ?? "image/png";
            s.addImage({ data: `data:${mime};base64,${slide.imageBase64}`, x: 6, y: 1.4, w: 3.5, h: 3.5 });
          }
          break;
        }
      }
      if (slide.notes) {
        s.addNotes(slide.notes);
      }
    }

    let buffer: Buffer;
    try {
      const data = await pptx.write({ outputType: "nodebuffer" }) as Buffer;
      buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    } catch (err) {
      return fail(`pptx writer failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      await mkdir(dirname(resolvedRes.resolved), { recursive: true });
      await writeFile(resolvedRes.resolved, buffer);
    } catch (err) {
      return fail(`Failed to write .pptx: ${String(err)}`);
    }

    return {
      success: true,
      output: `PPTX with ${slides.length} slide(s) saved to ${resolvedRes.relativePath} (${buffer.byteLength} bytes).`,
      metadata: {
        artifactKind: "document",
        outputPath: resolvedRes.relativePath,
        format: "pptx",
        slideCount: slides.length,
        bytes: buffer.byteLength,
        contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        previewMode: "download",
      },
    };
  },
});
