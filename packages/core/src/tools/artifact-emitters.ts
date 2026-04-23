/**
 * Small focused artifact emitters — Wave B.
 *
 * generate_svg     — write a raw SVG illustration / data-viz to the workspace.
 * generate_qr_code — encode text/URL/contact data as a QR code SVG.
 * generate_ics     — emit an iCalendar (.ics) file from a structured event list.
 *
 * Each writes a single workspace file and returns artifactKind metadata so
 * the chat surface can preview it.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { childLogger } from "../logger.js";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { resolvePathWithinWorkspace } from "./workspace-path.js";

const log = childLogger("tool:artifact-emitters");

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
    .replace(/^-+|-+$/g, "") || "artifact";
}

// ─────────────────────────────────────────────────────────────────────────────
// generate_svg
// ─────────────────────────────────────────────────────────────────────────────

registerTool({
  name: "generate_svg",
  description:
    "Write a raw SVG illustration, data visualization, or icon to the workspace. The caller supplies the full <svg> body (or the bare children, in which case a default viewBox wrapper is added). Use this for static charts, diagrams, badges, illustrations, and anything where Mermaid/chart.js would be overkill or insufficiently expressive.",
  embeddingDescription:
    "svg generate write illustration vector graphic icon badge diagram static chart visualization scalable",
  parameters: {
    type: "object",
    properties: {
      svg: {
        type: "string",
        description: "Either a complete <svg ...>...</svg> document, or just the inner children (in which case a 600x400 viewBox wrapper is generated).",
      },
      title: {
        type: "string",
        description: "Optional title used to derive the filename when output_file is not provided.",
      },
      output_file: {
        type: "string",
        description: "Workspace-relative output path (must end in .svg). Defaults to a slug of the title.",
      },
      width: {
        type: "number",
        description: "Default wrapper width (only used when svg is bare children). Defaults to 600.",
      },
      height: {
        type: "number",
        description: "Default wrapper height (only used when svg is bare children). Defaults to 400.",
      },
      overwrite: {
        type: "boolean",
        description: "When false, fail instead of overwriting an existing file. Default true.",
      },
    },
    required: ["svg"],
  },
  async execute(args, ctx) {
    const svgInput = String(args["svg"] ?? "").trim();
    if (!svgInput) return fail("svg is required");

    const title = typeof args["title"] === "string" ? String(args["title"]).trim() : "";
    const overwrite = args["overwrite"] !== false;
    const outputPath = (typeof args["output_file"] === "string" && String(args["output_file"]).trim())
      ? String(args["output_file"]).trim()
      : `${slugify(title || "illustration")}.svg`;

    if (extname(outputPath).toLowerCase() !== ".svg") {
      return fail("output_file must use the .svg extension");
    }

    const width = typeof args["width"] === "number" && Number.isFinite(args["width"]) ? Math.max(1, Math.trunc(args["width"])) : 600;
    const height = typeof args["height"] === "number" && Number.isFinite(args["height"]) ? Math.max(1, Math.trunc(args["height"])) : 400;

    const document = svgInput.toLowerCase().includes("<svg")
      ? svgInput
      : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">\n${svgInput}\n</svg>`;

    let resolved: { resolved: string; relativePath: string };
    try {
      resolved = resolvePathWithinWorkspace(outputPath, ctx.workspacePath);
    } catch {
      return fail("output_file must resolve inside the workspace");
    }

    if (!overwrite) {
      try {
        const { stat } = await import("node:fs/promises");
        await stat(resolved.resolved);
        return fail(`Refusing to overwrite existing file: ${resolved.relativePath}`);
      } catch {
        // ok
      }
    }

    try {
      await mkdir(dirname(resolved.resolved), { recursive: true });
      await writeFile(resolved.resolved, document, "utf8");
    } catch (err) {
      return fail(`Failed to write SVG: ${String(err)}`);
    }

    log.info({ outputFile: resolved.relativePath, bytes: document.length }, "generate_svg wrote artifact");
    return {
      success: true,
      output: `SVG saved to ${resolved.relativePath}.`,
      metadata: {
        artifactKind: "image",
        outputPath: resolved.relativePath,
        format: "svg",
        title: title || undefined,
        bytes: document.length,
        contentType: "image/svg+xml",
        previewMode: "image",
      },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// generate_qr_code
// ─────────────────────────────────────────────────────────────────────────────

registerTool({
  name: "generate_qr_code",
  description:
    "Encode text (URL, vCard, Wi-Fi credentials, etc.) into a QR code SVG and write it to the workspace. Pure Reed-Solomon implementation, no native dependency. Supports L/M/Q/H error-correction levels and configurable cell size.",
  embeddingDescription:
    "qr code generate svg encode url wifi vcard barcode contact link share",
  parameters: {
    type: "object",
    properties: {
      data: {
        type: "string",
        description: "Text to encode (URL, plain text, vCard, Wi-Fi string, etc.).",
      },
      output_file: {
        type: "string",
        description: "Workspace-relative output path (must end in .svg). Defaults to qr-code.svg.",
      },
      errorCorrection: {
        type: "string",
        enum: ["L", "M", "Q", "H"],
        description: "Reed-Solomon level: L (~7%), M (~15%, default), Q (~25%), H (~30%).",
      },
      cellSizePx: {
        type: "number",
        description: "SVG pixel size per QR module. Defaults to 8.",
      },
      marginCells: {
        type: "number",
        description: "Quiet-zone margin in modules. Defaults to 4.",
      },
      title: {
        type: "string",
        description: "Optional <title> annotation embedded in the SVG (accessibility).",
      },
      overwrite: {
        type: "boolean",
        description: "When false, fail instead of overwriting an existing file. Default true.",
      },
    },
    required: ["data"],
  },
  async execute(args, ctx) {
    const data = String(args["data"] ?? "");
    if (!data) return fail("data is required");
    const ecLevel = (args["errorCorrection"] === "L" || args["errorCorrection"] === "Q" || args["errorCorrection"] === "H")
      ? args["errorCorrection"] as "L" | "Q" | "H"
      : "M";
    const cellSizePx = typeof args["cellSizePx"] === "number" && Number.isFinite(args["cellSizePx"])
      ? Math.max(1, Math.trunc(args["cellSizePx"]))
      : 8;
    const marginCells = typeof args["marginCells"] === "number" && Number.isFinite(args["marginCells"])
      ? Math.max(0, Math.trunc(args["marginCells"]))
      : 4;
    const title = typeof args["title"] === "string" ? String(args["title"]).trim() : "";
    const overwrite = args["overwrite"] !== false;

    const outputPath = (typeof args["output_file"] === "string" && String(args["output_file"]).trim())
      ? String(args["output_file"]).trim()
      : "qr-code.svg";
    if (extname(outputPath).toLowerCase() !== ".svg") {
      return fail("output_file must use the .svg extension");
    }

    let modules: boolean[][];
    try {
      modules = encodeQrCode(data, ecLevel);
    } catch (err) {
      return fail(`QR encoding failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const svg = renderQrSvg(modules, cellSizePx, marginCells, title);

    let resolved: { resolved: string; relativePath: string };
    try {
      resolved = resolvePathWithinWorkspace(outputPath, ctx.workspacePath);
    } catch {
      return fail("output_file must resolve inside the workspace");
    }

    if (!overwrite) {
      try {
        const { stat } = await import("node:fs/promises");
        await stat(resolved.resolved);
        return fail(`Refusing to overwrite existing file: ${resolved.relativePath}`);
      } catch {
        // ok
      }
    }

    try {
      await mkdir(dirname(resolved.resolved), { recursive: true });
      await writeFile(resolved.resolved, svg, "utf8");
    } catch (err) {
      return fail(`Failed to write QR SVG: ${String(err)}`);
    }

    return {
      success: true,
      output: `QR code (${modules.length}x${modules.length} modules) saved to ${resolved.relativePath}.`,
      metadata: {
        artifactKind: "image",
        outputPath: resolved.relativePath,
        format: "svg",
        bytes: svg.length,
        moduleCount: modules.length,
        errorCorrection: ecLevel,
        contentType: "image/svg+xml",
        previewMode: "image",
      },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// generate_ics
// ─────────────────────────────────────────────────────────────────────────────

interface IcsEventInput {
  uid?: string;
  summary: string;
  description?: string;
  location?: string;
  start: string;
  end?: string;
  durationMinutes?: number;
  organizer?: string;
  attendees?: string[];
  status?: "TENTATIVE" | "CONFIRMED" | "CANCELLED";
  rrule?: string;
  url?: string;
}

registerTool({
  name: "generate_ics",
  description:
    "Emit an iCalendar (.ics) file from a structured event list. Each event needs at minimum a summary and start; either end or durationMinutes provides the duration. Times accept ISO 8601 strings (with timezone) or YYYYMMDDTHHMMSSZ. Output is RFC 5545 compliant with proper line folding and escaping.",
  embeddingDescription:
    "ics ical icalendar emit generate write calendar event invite outlook google import schedule appointment",
  parameters: {
    type: "object",
    properties: {
      events: {
        type: "array",
        description: "Array of events. Each: {summary, start, end?|durationMinutes?, location?, description?, organizer?, attendees[]?, status?, rrule?, url?, uid?}",
        items: {
          type: "object",
          properties: {
            uid: { type: "string" },
            summary: { type: "string" },
            description: { type: "string" },
            location: { type: "string" },
            start: { type: "string" },
            end: { type: "string" },
            durationMinutes: { type: "number" },
            organizer: { type: "string" },
            attendees: { type: "array", items: { type: "string" } },
            status: { type: "string", enum: ["TENTATIVE", "CONFIRMED", "CANCELLED"] },
            rrule: { type: "string" },
            url: { type: "string" },
          },
          required: ["summary", "start"],
        },
      },
      calendarName: {
        type: "string",
        description: "Optional X-WR-CALNAME (display name shown by some clients).",
      },
      output_file: {
        type: "string",
        description: "Workspace-relative output path (must end in .ics). Defaults to calendar.ics.",
      },
      overwrite: {
        type: "boolean",
        description: "When false, fail instead of overwriting an existing file. Default true.",
      },
    },
    required: ["events"],
  },
  async execute(args, ctx) {
    const eventsInput = Array.isArray(args["events"]) ? args["events"] as IcsEventInput[] : [];
    if (eventsInput.length === 0) return fail("events must be a non-empty array");

    const calendarName = typeof args["calendarName"] === "string" ? String(args["calendarName"]).trim() : "";
    const overwrite = args["overwrite"] !== false;
    const outputPath = (typeof args["output_file"] === "string" && String(args["output_file"]).trim())
      ? String(args["output_file"]).trim()
      : "calendar.ics";
    if (extname(outputPath).toLowerCase() !== ".ics") {
      return fail("output_file must use the .ics extension");
    }

    let resolved: { resolved: string; relativePath: string };
    try {
      resolved = resolvePathWithinWorkspace(outputPath, ctx.workspacePath);
    } catch {
      return fail("output_file must resolve inside the workspace");
    }

    let body: string;
    try {
      body = renderIcs(eventsInput, calendarName);
    } catch (err) {
      return fail(`Failed to build .ics: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!overwrite) {
      try {
        const { stat } = await import("node:fs/promises");
        await stat(resolved.resolved);
        return fail(`Refusing to overwrite existing file: ${resolved.relativePath}`);
      } catch {
        // ok
      }
    }

    try {
      await mkdir(dirname(resolved.resolved), { recursive: true });
      await writeFile(resolved.resolved, body, "utf8");
    } catch (err) {
      return fail(`Failed to write .ics: ${String(err)}`);
    }

    return {
      success: true,
      output: `iCalendar with ${eventsInput.length} event(s) saved to ${resolved.relativePath}.`,
      metadata: {
        artifactKind: "document",
        outputPath: resolved.relativePath,
        format: "ics",
        eventCount: eventsInput.length,
        bytes: body.length,
        contentType: "text/calendar; charset=utf-8",
        previewMode: "text",
      },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// .ics renderer (RFC 5545)
// ─────────────────────────────────────────────────────────────────────────────

function renderIcs(events: IcsEventInput[], calendarName: string): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//StarlingAI//generate_ics 1.0//EN",
    "CALSCALE:GREGORIAN",
  ];
  if (calendarName) lines.push(`X-WR-CALNAME:${escapeIcsText(calendarName)}`);

  const dtstamp = formatIcsTime(new Date());
  for (const evt of events) {
    if (!evt.summary?.trim()) throw new Error("event.summary is required");
    if (!evt.start?.trim()) throw new Error("event.start is required");
    const startUtc = toIcsTime(evt.start);
    const endUtc = evt.end
      ? toIcsTime(evt.end)
      : (typeof evt.durationMinutes === "number" && Number.isFinite(evt.durationMinutes)
        ? formatIcsTime(new Date(parseDateInput(evt.start).getTime() + evt.durationMinutes * 60_000))
        : undefined);

    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${evt.uid || `evt-${cryptoSafeRandom()}@starlingai`}`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`DTSTART:${startUtc}`);
    if (endUtc) lines.push(`DTEND:${endUtc}`);
    lines.push(`SUMMARY:${escapeIcsText(evt.summary)}`);
    if (evt.description) lines.push(`DESCRIPTION:${escapeIcsText(evt.description)}`);
    if (evt.location) lines.push(`LOCATION:${escapeIcsText(evt.location)}`);
    if (evt.organizer) lines.push(`ORGANIZER:MAILTO:${evt.organizer}`);
    if (Array.isArray(evt.attendees)) {
      for (const a of evt.attendees) {
        if (a) lines.push(`ATTENDEE:MAILTO:${a}`);
      }
    }
    if (evt.status) lines.push(`STATUS:${evt.status}`);
    if (evt.rrule) lines.push(`RRULE:${evt.rrule}`);
    if (evt.url) lines.push(`URL:${evt.url}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldIcsLine).join("\r\n") + "\r\n";
}

function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

function foldIcsLine(line: string): string {
  // RFC 5545: lines longer than 75 octets must be folded with CRLF + space.
  if (line.length <= 75) return line;
  const parts: string[] = [];
  for (let i = 0; i < line.length; i += 73) {
    parts.push((i === 0 ? "" : " ") + line.slice(i, i + 73));
  }
  return parts.join("\r\n");
}

function parseDateInput(value: string): Date {
  // Accept ISO 8601 (preferred) or YYYYMMDDTHHMMSSZ.
  const compact = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (compact) {
    return new Date(`${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}Z`);
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`unparseable timestamp: ${value}`);
  return d;
}

function toIcsTime(value: string): string {
  return formatIcsTime(parseDateInput(value));
}

function formatIcsTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function cryptoSafeRandom(): string {
  // Lightweight unique id; doesn't need to be cryptographic — UID just has to be unique within the cal.
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// QR code encoder — pure-JS Reed-Solomon, supports versions 1-10
// ─────────────────────────────────────────────────────────────────────────────

type EcLevel = "L" | "M" | "Q" | "H";

const EC_LEVELS_BITS: Record<EcLevel, number> = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };

// QR capacity (bytes) for byte-mode, versions 1-10, ec L/M/Q/H.
// Source: ISO/IEC 18004 table 7.
const BYTE_CAPACITY: Record<EcLevel, number[]> = {
  L: [17, 32, 53, 78, 106, 134, 154, 192, 230, 271],
  M: [14, 26, 42, 62, 84, 106, 122, 152, 180, 213],
  Q: [11, 20, 32, 46, 60, 74, 86, 108, 130, 151],
  H: [7, 14, 24, 34, 44, 58, 64, 84, 98, 119],
};

// Total codewords per version (1-10).
const TOTAL_CODEWORDS: number[] = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
// EC codewords per block, by version + level (only versions 1-10).
const EC_CODEWORDS: Record<EcLevel, number[]> = {
  L: [7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  M: [10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
  Q: [13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
  H: [17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
};
// Block grouping per version + level (versions 1-10): [count1, dataPerBlock1, count2, dataPerBlock2]
const BLOCK_GROUPS: Record<EcLevel, number[][]> = {
  L: [
    [1, 19, 0, 0], [1, 34, 0, 0], [1, 55, 0, 0], [1, 80, 0, 0], [1, 108, 0, 0],
    [2, 68, 0, 0], [2, 78, 0, 0], [2, 97, 0, 0], [2, 116, 0, 0], [2, 68, 2, 69],
  ],
  M: [
    [1, 16, 0, 0], [1, 28, 0, 0], [1, 44, 0, 0], [2, 32, 0, 0], [2, 43, 0, 0],
    [4, 27, 0, 0], [4, 31, 0, 0], [2, 38, 2, 39], [3, 36, 2, 37], [4, 43, 1, 44],
  ],
  Q: [
    [1, 13, 0, 0], [1, 22, 0, 0], [2, 17, 0, 0], [2, 24, 0, 0], [2, 15, 2, 16],
    [4, 19, 0, 0], [2, 14, 4, 15], [4, 18, 2, 19], [4, 16, 4, 17], [6, 19, 2, 20],
  ],
  H: [
    [1, 9, 0, 0], [1, 16, 0, 0], [2, 13, 0, 0], [4, 9, 0, 0], [2, 11, 2, 12],
    [4, 15, 0, 0], [4, 13, 1, 14], [4, 14, 2, 15], [4, 12, 4, 13], [6, 15, 2, 16],
  ],
};

const ALIGNMENT_PATTERNS: number[][] = [
  [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

function encodeQrCode(data: string, level: EcLevel): boolean[][] {
  const dataBytes = Buffer.from(data, "utf8");
  if (dataBytes.length === 0) throw new Error("data must be non-empty");

  // Pick smallest version (1-10) that holds the payload at this EC level.
  let version = -1;
  for (let v = 1; v <= 10; v++) {
    if (dataBytes.length <= BYTE_CAPACITY[level][v - 1]!) {
      version = v;
      break;
    }
  }
  if (version === -1) {
    throw new Error(`payload too large (${dataBytes.length} bytes) for QR versions 1-10 at EC ${level}`);
  }

  const totalCodewords = TOTAL_CODEWORDS[version - 1]!;
  const ecPerBlock = EC_CODEWORDS[level][version - 1]!;
  const groups = BLOCK_GROUPS[level][version - 1]!;
  const totalBlocks = groups[0]! + groups[2]!;
  const totalDataCodewords = totalCodewords - ecPerBlock * totalBlocks;

  // ─── Bit stream ────────────────────────────────────────────────────────
  const bits = new BitStream();
  bits.append(0b0100, 4); // mode: byte
  const charCountBits = version <= 9 ? 8 : 16;
  bits.append(dataBytes.length, charCountBits);
  for (const b of dataBytes) bits.append(b, 8);
  // Terminator (up to 4 zero bits)
  const remaining = totalDataCodewords * 8 - bits.length();
  bits.append(0, Math.min(4, Math.max(0, remaining)));
  // Pad to byte boundary
  while (bits.length() % 8 !== 0) bits.append(0, 1);
  // Pad with 0xEC, 0x11 alternating
  const padCodewords = totalDataCodewords - bits.length() / 8;
  for (let i = 0; i < padCodewords; i++) {
    bits.append(i % 2 === 0 ? 0xEC : 0x11, 8);
  }
  const dataCodewords = bits.toBytes();

  // ─── Split into blocks + compute EC ──────────────────────────────────
  const blocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let offset = 0;
  for (let g = 0; g < 2; g++) {
    const count = groups[g * 2]!;
    const blockSize = groups[g * 2 + 1]!;
    for (let i = 0; i < count; i++) {
      const block = dataCodewords.slice(offset, offset + blockSize);
      blocks.push(block);
      ecBlocks.push(reedSolomon(block, ecPerBlock));
      offset += blockSize;
    }
  }

  // ─── Interleave codewords ──────────────────────────────────────────
  const maxDataLen = Math.max(...blocks.map((b) => b.length));
  const interleaved: number[] = [];
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of blocks) {
      if (i < block.length) interleaved.push(block[i]!);
    }
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const ec of ecBlocks) interleaved.push(ec[i]!);
  }

  // ─── Place modules ────────────────────────────────────────────────
  const size = 17 + version * 4;
  const matrix: (boolean | null)[][] = Array.from({ length: size }, () => Array(size).fill(null));
  const reserved: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false));

  placeFinderPatterns(matrix, reserved, size);
  placeAlignmentPatterns(matrix, reserved, version);
  placeTimingPatterns(matrix, reserved, size);
  placeDarkModule(matrix, reserved, version);
  reserveFormatAreas(reserved, size);
  if (version >= 7) reserveVersionAreas(reserved, size);

  placeData(matrix, reserved, size, interleaved);

  // ─── Mask + format ────────────────────────────────────────────────
  const maskResult = chooseMaskAndApply(matrix, reserved, size);
  applyFormatInformation(maskResult.matrix, size, level, maskResult.maskPattern);
  if (version >= 7) applyVersionInformation(maskResult.matrix, size, version);

  // Convert null cells to false (shouldn't happen, but defensive)
  return maskResult.matrix.map((row) => row.map((cell) => cell === true));
}

// ── BitStream ───────────────────────────────────────────────────────────

class BitStream {
  private bits: number[] = [];
  append(value: number, count: number): void {
    for (let i = count - 1; i >= 0; i--) {
      this.bits.push((value >> i) & 1);
    }
  }
  length(): number { return this.bits.length; }
  toBytes(): number[] {
    const bytes: number[] = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) {
        b = (b << 1) | (this.bits[i + j] ?? 0);
      }
      bytes.push(b);
    }
    return bytes;
  }
}

// ── Reed-Solomon over GF(256) with primitive polynomial 0x11D ──────────

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function initGf() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11D;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]!;
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[(GF_LOG[a]! + GF_LOG[b]!) % 255]!;
}

function rsGeneratorPoly(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    poly = polyMul(poly, [1, GF_EXP[i]!]);
  }
  return poly;
}

function polyMul(a: number[], b: number[]): number[] {
  const result = Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      result[i + j] ^= gfMul(a[i]!, b[j]!);
    }
  }
  return result;
}

function reedSolomon(data: number[], ecCount: number): number[] {
  const generator = rsGeneratorPoly(ecCount);
  const buffer = data.slice().concat(Array(ecCount).fill(0));
  for (let i = 0; i < data.length; i++) {
    const lead = buffer[i]!;
    if (lead === 0) continue;
    for (let j = 0; j < generator.length; j++) {
      buffer[i + j] = (buffer[i + j] ?? 0) ^ gfMul(generator[j]!, lead);
    }
  }
  return buffer.slice(data.length);
}

// ── Module placement helpers ───────────────────────────────────────────

function placeFinderPatterns(matrix: (boolean | null)[][], reserved: boolean[][], size: number): void {
  const positions: Array<[number, number]> = [[0, 0], [0, size - 7], [size - 7, 0]];
  for (const [r, c] of positions) {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const inside = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        if (inside) {
          const onBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
          const inCenter = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
          matrix[rr]![cc] = onBorder || inCenter;
        } else {
          matrix[rr]![cc] = false;
        }
        reserved[rr]![cc] = true;
      }
    }
  }
}

function placeAlignmentPatterns(matrix: (boolean | null)[][], reserved: boolean[][], version: number): void {
  const centers = ALIGNMENT_PATTERNS[version] ?? [];
  for (const cy of centers) {
    for (const cx of centers) {
      // Skip centers that overlap finder patterns
      if ((cy === 6 && cx === 6) || (cy === 6 && cx === centers[centers.length - 1]) || (cy === centers[centers.length - 1] && cx === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const r = cy + dr, c = cx + dc;
          const onBorder = Math.abs(dr) === 2 || Math.abs(dc) === 2;
          const isCenter = dr === 0 && dc === 0;
          matrix[r]![c] = onBorder || isCenter;
          reserved[r]![c] = true;
        }
      }
    }
  }
}

function placeTimingPatterns(matrix: (boolean | null)[][], reserved: boolean[][], size: number): void {
  for (let i = 8; i < size - 8; i++) {
    if (!reserved[6]![i]) {
      matrix[6]![i] = i % 2 === 0;
      reserved[6]![i] = true;
    }
    if (!reserved[i]![6]) {
      matrix[i]![6] = i % 2 === 0;
      reserved[i]![6] = true;
    }
  }
}

function placeDarkModule(matrix: (boolean | null)[][], reserved: boolean[][], version: number): void {
  const r = 4 * version + 9;
  const c = 8;
  matrix[r]![c] = true;
  reserved[r]![c] = true;
}

function reserveFormatAreas(reserved: boolean[][], size: number): void {
  // Around top-left finder
  for (let i = 0; i < 9; i++) {
    reserved[8]![i] = true;
    reserved[i]![8] = true;
  }
  // Around top-right finder
  for (let i = 0; i < 8; i++) {
    reserved[8]![size - 1 - i] = true;
  }
  // Around bottom-left finder
  for (let i = 0; i < 7; i++) {
    reserved[size - 1 - i]![8] = true;
  }
}

function reserveVersionAreas(reserved: boolean[][], size: number): void {
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 3; c++) {
      reserved[r]![size - 11 + c] = true;
      reserved[size - 11 + c]![r] = true;
    }
  }
}

function placeData(matrix: (boolean | null)[][], reserved: boolean[][], size: number, codewords: number[]): void {
  const bits: number[] = [];
  for (const cw of codewords) {
    for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);
  }
  let bitIdx = 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // skip vertical timing column
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (let dc = 0; dc < 2; dc++) {
        const c = col - dc;
        if (reserved[row]![c]) continue;
        matrix[row]![c] = bitIdx < bits.length ? bits[bitIdx]! === 1 : false;
        bitIdx++;
      }
    }
    upward = !upward;
  }
}

function chooseMaskAndApply(
  matrix: (boolean | null)[][],
  reserved: boolean[][],
  size: number,
): { matrix: (boolean | null)[][]; maskPattern: number } {
  let bestPattern = 0;
  let bestPenalty = Infinity;
  let bestMatrix: (boolean | null)[][] = matrix;
  for (let pattern = 0; pattern < 8; pattern++) {
    const candidate = matrix.map((row) => row.slice());
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (reserved[r]![c]) continue;
        if (maskFn(pattern, r, c)) candidate[r]![c] = !candidate[r]![c];
      }
    }
    // Apply temporary format bits at standard positions so the penalty calc
    // can see those modules; we'll overwrite with the real format bits later.
    applyFormatInformation(candidate, size, "M", pattern);
    const penalty = scoreMask(candidate, size);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestPattern = pattern;
      bestMatrix = candidate;
    }
  }
  return { matrix: bestMatrix, maskPattern: bestPattern };
}

function maskFn(pattern: number, r: number, c: number): boolean {
  switch (pattern) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return false;
  }
}

function scoreMask(matrix: (boolean | null)[][], size: number): number {
  let penalty = 0;
  // Rule 1: runs of 5+ same-color modules in row/col → 3 + extra per added module.
  for (let r = 0; r < size; r++) {
    let run = 1;
    for (let c = 1; c < size; c++) {
      if (matrix[r]![c] === matrix[r]![c - 1]) {
        run++;
      } else {
        if (run >= 5) penalty += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) penalty += 3 + (run - 5);
  }
  for (let c = 0; c < size; c++) {
    let run = 1;
    for (let r = 1; r < size; r++) {
      if (matrix[r]![c] === matrix[r - 1]![c]) {
        run++;
      } else {
        if (run >= 5) penalty += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) penalty += 3 + (run - 5);
  }
  // Rule 2: 2x2 blocks of same color → 3 each.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = matrix[r]![c];
      if (v === matrix[r]![c + 1] && v === matrix[r + 1]![c] && v === matrix[r + 1]![c + 1]) {
        penalty += 3;
      }
    }
  }
  // Skip rules 3 and 4 (finder-pattern lookalikes + dark/light balance) for compactness.
  return penalty;
}

const FORMAT_MASK = 0b101010000010010;

function applyFormatInformation(
  matrix: (boolean | null)[][],
  size: number,
  level: EcLevel,
  maskPattern: number,
): void {
  const data = (EC_LEVELS_BITS[level] << 3) | maskPattern;
  let bch = data << 10;
  const generator = 0b10100110111;
  for (let i = 14; i >= 10; i--) {
    if ((bch >> i) & 1) {
      bch ^= generator << (i - 10);
    }
  }
  const formatBits = ((data << 10) | bch) ^ FORMAT_MASK;

  for (let i = 0; i < 15; i++) {
    const bit = ((formatBits >> i) & 1) === 1;
    // First 6 bits along the top-left (top column / left row), then jumps.
    let r1: number, c1: number;
    if (i < 6) { r1 = i; c1 = 8; }
    else if (i === 6) { r1 = 7; c1 = 8; }
    else if (i === 7) { r1 = 8; c1 = 8; }
    else if (i === 8) { r1 = 8; c1 = 7; }
    else { r1 = 8; c1 = 14 - i; }
    matrix[r1]![c1] = bit;

    let r2: number, c2: number;
    if (i < 8) { r2 = 8; c2 = size - 1 - i; }
    else { r2 = size - 15 + i; c2 = 8; }
    matrix[r2]![c2] = bit;
  }
}

function applyVersionInformation(matrix: (boolean | null)[][], size: number, version: number): void {
  let bch = version << 12;
  const generator = 0b1111100100101;
  for (let i = 17; i >= 12; i--) {
    if ((bch >> i) & 1) {
      bch ^= generator << (i - 12);
    }
  }
  const versionBits = (version << 12) | bch;
  for (let i = 0; i < 18; i++) {
    const bit = ((versionBits >> i) & 1) === 1;
    const r = Math.floor(i / 3);
    const c = i % 3 + size - 11;
    matrix[r]![c] = bit;
    matrix[c]![r] = bit;
  }
}

function renderQrSvg(modules: boolean[][], cellSizePx: number, marginCells: number, title: string): string {
  const size = modules.length;
  const totalSize = (size + marginCells * 2) * cellSizePx;
  const rects: string[] = [];
  for (let r = 0; r < size; r++) {
    let runStart = -1;
    for (let c = 0; c <= size; c++) {
      const filled = c < size && modules[r]![c];
      if (filled && runStart === -1) runStart = c;
      if (!filled && runStart !== -1) {
        const x = (marginCells + runStart) * cellSizePx;
        const y = (marginCells + r) * cellSizePx;
        const w = (c - runStart) * cellSizePx;
        rects.push(`<rect x="${x}" y="${y}" width="${w}" height="${cellSizePx}"/>`);
        runStart = -1;
      }
    }
  }
  const titleTag = title ? `\n  <title>${title.replace(/[<&>]/g, (c) => c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;")}</title>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalSize} ${totalSize}" width="${totalSize}" height="${totalSize}" shape-rendering="crispEdges">${titleTag}
  <rect width="100%" height="100%" fill="#ffffff"/>
  <g fill="#000000">
    ${rects.join("\n    ")}
  </g>
</svg>
`;
}
