/**
 * Source-file extractors — Wave E.
 *
 * Each tool takes a workspace-relative file and returns structured /
 * Markdown-friendly content the LLM can consume. Hand-rolled parsers
 * for .ipynb, .eml, .mbox, .ics; transcribe_video reuses the existing
 * STT backend wired by transcribe_audio.
 */
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import JSON5 from "json5";
import { childLogger } from "../logger.js";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { resolvePathWithinWorkspace } from "./workspace-path.js";
import { assertFileSizeWithin, truncateOutput } from "./io-limits.js";

const log = childLogger("tool:extractors");

// Re-use the existing transcribe_audio implementation by importing it lazily.
// We don't want a hard import cycle with multimodal.ts, so we look up the
// registered tool at execute time.
async function callExistingTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { getTool } = await import("./registry.js");
  const tool = getTool(name);
  if (!tool) {
    return { success: false, output: "", error: `dependency tool '${name}' is not registered` };
  }
  return tool.execute(args, ctx);
}

function fail(message: string): ToolResult {
  return { success: false, output: "", error: message };
}

// ─────────────────────────────────────────────────────────────────────────────
// extract_notebook — .ipynb → Markdown with code, output, and image refs
// ─────────────────────────────────────────────────────────────────────────────

interface NotebookCell {
  cell_type: string;
  source?: string | string[];
  outputs?: Array<Record<string, unknown>>;
  execution_count?: number | null;
}

registerTool({
  name: "extract_notebook",
  description:
    "Convert a Jupyter notebook (.ipynb) to a single Markdown document. Markdown cells flow through verbatim; code cells become fenced ```<language> blocks; text and stream outputs become indented quote blocks; image outputs are noted as `[image output: <mime>]`. Read-only.",
  embeddingDescription:
    "jupyter notebook ipynb extract convert markdown code cells outputs python data-science analysis read",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative .ipynb path." },
      includeOutputs: {
        type: "boolean",
        description: "If false, code cells are emitted without their outputs. Defaults to true.",
      },
    },
    required: ["path"],
  },
  async execute(args, ctx) {
    const path = String(args["path"] ?? "").trim();
    if (!path) return fail("path is required");
    if (extname(path).toLowerCase() !== ".ipynb") return fail("path must end in .ipynb");

    let resolved: string;
    try {
      ({ resolved } = resolvePathWithinWorkspace(path, ctx.workspacePath));
    } catch {
      return fail("path must resolve inside the workspace");
    }

    let raw: string;
    try {
      await assertFileSizeWithin(resolved);
      raw = await readFile(resolved, "utf8");
    } catch (err) {
      return fail(`Failed to read notebook: ${String(err)}`);
    }

    let parsed: { cells?: NotebookCell[]; metadata?: { kernelspec?: { language?: string; name?: string } } };
    try {
      parsed = JSON.parse(raw);
    } catch {
      try {
        parsed = JSON5.parse(raw) as typeof parsed;
      } catch (err) {
        return fail(`Notebook is not valid JSON: ${String(err)}`);
      }
    }

    const language = parsed.metadata?.kernelspec?.language?.trim() || "python";
    const cells = Array.isArray(parsed.cells) ? parsed.cells : [];
    const includeOutputs = args["includeOutputs"] !== false;
    const out: string[] = [];
    let codeCellCount = 0;
    let outputCount = 0;

    for (const cell of cells) {
      const source = normalizeSource(cell.source);
      if (cell.cell_type === "markdown") {
        if (source.trim()) out.push(source.trim());
      } else if (cell.cell_type === "raw") {
        if (source.trim()) out.push(source.trim());
      } else if (cell.cell_type === "code") {
        codeCellCount++;
        const exec = typeof cell.execution_count === "number" ? `In[${cell.execution_count}]` : "In[ ]";
        out.push(`<!-- ${exec} -->`);
        out.push("```" + language);
        out.push(source.replace(/\n+$/, ""));
        out.push("```");
        if (includeOutputs && Array.isArray(cell.outputs) && cell.outputs.length > 0) {
          const rendered = renderOutputs(cell.outputs);
          if (rendered) {
            out.push(rendered);
            outputCount += cell.outputs.length;
          }
        }
      }
    }

    const markdown = out.join("\n\n").trim() + "\n";
    return {
      success: true,
      output: truncateOutput(markdown, undefined, "Notebook"),
      metadata: {
        path,
        cellCount: cells.length,
        codeCellCount,
        outputCount,
        language,
      },
    };
  },
});

function normalizeSource(source: NotebookCell["source"]): string {
  if (Array.isArray(source)) return source.join("");
  return String(source ?? "");
}

function renderOutputs(outputs: Array<Record<string, unknown>>): string {
  const blocks: string[] = [];
  for (const output of outputs) {
    const type = String(output["output_type"] ?? "");
    if (type === "stream") {
      const text = normalizeSource(output["text"] as string | string[] | undefined).trim();
      if (text) blocks.push(quoteText(text));
    } else if (type === "execute_result" || type === "display_data") {
      const data = output["data"] as Record<string, unknown> | undefined;
      if (!data) continue;
      const textPlain = data["text/plain"];
      if (textPlain) {
        const text = normalizeSource(textPlain as string | string[]).trim();
        if (text) blocks.push(quoteText(text));
      }
      for (const mime of Object.keys(data)) {
        if (mime.startsWith("image/")) {
          blocks.push(`> [image output: ${mime}]`);
          break;
        }
      }
    } else if (type === "error") {
      const ename = String(output["ename"] ?? "Error");
      const evalue = String(output["evalue"] ?? "");
      blocks.push(quoteText(`${ename}: ${evalue}`));
    }
  }
  return blocks.join("\n\n");
}

function quoteText(text: string): string {
  return text.split("\n").map((line) => `> ${line}`).join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// extract_email — .eml or single-message .mbox → headers + body + attachments
// ─────────────────────────────────────────────────────────────────────────────

interface ParsedEmail {
  headers: Record<string, string[]>;
  bodyText: string;
  bodyHtml: string;
  attachments: Array<{ filename: string; contentType: string; sizeBytes: number }>;
}

registerTool({
  name: "extract_email",
  description:
    "Parse an .eml file (single message) or a single message inside an .mbox into structured headers, plain-text body (preferred), HTML body fallback, and a listing of attachments. Read-only. Quoted-printable and base64 transfer encodings are decoded.",
  embeddingDescription:
    "email eml mbox parse extract headers from to subject body attachments inbox archive forensics read",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative .eml or .mbox path." },
      includeAllHeaders: {
        type: "boolean",
        description: "If true, return every header. If false (default), only the common subset (From, To, Cc, Bcc, Subject, Date, Message-ID, Reply-To, In-Reply-To, References).",
      },
    },
    required: ["path"],
  },
  async execute(args, ctx) {
    const path = String(args["path"] ?? "").trim();
    if (!path) return fail("path is required");
    const ext = extname(path).toLowerCase();
    if (ext !== ".eml" && ext !== ".mbox") return fail("path must end in .eml or .mbox");

    let resolved: string;
    try {
      ({ resolved } = resolvePathWithinWorkspace(path, ctx.workspacePath));
    } catch {
      return fail("path must resolve inside the workspace");
    }

    let raw: string;
    try {
      await assertFileSizeWithin(resolved);
      raw = await readFile(resolved, "utf8");
    } catch (err) {
      return fail(`Failed to read email: ${String(err)}`);
    }

    const messageRaw = ext === ".mbox" ? extractFirstMboxMessage(raw) : raw;
    let parsed: ParsedEmail;
    try {
      parsed = parseEmail(messageRaw);
    } catch (err) {
      return fail(`Failed to parse email: ${String(err)}`);
    }

    const interestingHeaders = ["from", "to", "cc", "bcc", "subject", "date", "message-id", "reply-to", "in-reply-to", "references"];
    const headersToShow = args["includeAllHeaders"] === true
      ? Object.keys(parsed.headers).sort()
      : interestingHeaders.filter((h) => parsed.headers[h]);

    const headerLines = headersToShow.flatMap((h) =>
      (parsed.headers[h] ?? []).map((value) => `${formatHeaderName(h)}: ${value.trim()}`),
    );

    const sections: string[] = [headerLines.join("\n")];
    if (parsed.bodyText.trim()) {
      sections.push(`---\n\n${parsed.bodyText.trim()}`);
    } else if (parsed.bodyHtml.trim()) {
      sections.push(`---\n\n${stripHtml(parsed.bodyHtml).trim()}`);
    }
    if (parsed.attachments.length > 0) {
      const list = parsed.attachments
        .map((att) => `- ${att.filename || "(unnamed)"} (${att.contentType}, ${att.sizeBytes} bytes)`)
        .join("\n");
      sections.push(`---\n\nAttachments:\n${list}`);
    }

    return {
      success: true,
      output: truncateOutput(sections.join("\n\n"), undefined, "Email"),
      metadata: {
        path,
        from: parsed.headers["from"]?.[0],
        to: parsed.headers["to"]?.[0],
        subject: parsed.headers["subject"]?.[0],
        date: parsed.headers["date"]?.[0],
        attachmentCount: parsed.attachments.length,
        bodyKind: parsed.bodyText.trim() ? "text" : (parsed.bodyHtml.trim() ? "html-stripped" : "empty"),
      },
    };
  },
});

function extractFirstMboxMessage(raw: string): string {
  // mbox separator is "\nFrom " at start of line. The first message starts at the first "From "
  // line. Strip everything before it, then find the next separator and cut there.
  const start = raw.match(/^From .+\n/m);
  const startIdx = start?.index ?? 0;
  const after = raw.slice(startIdx);
  const stripped = after.replace(/^From .+\n/, "");
  const next = stripped.search(/\n\nFrom .+\n/);
  return next === -1 ? stripped : stripped.slice(0, next);
}

function parseEmail(raw: string): ParsedEmail {
  const normalized = raw.replace(/\r\n/g, "\n");
  const headerEnd = normalized.indexOf("\n\n");
  const headerBlock = headerEnd === -1 ? normalized : normalized.slice(0, headerEnd);
  const body = headerEnd === -1 ? "" : normalized.slice(headerEnd + 2);
  const headers = parseHeaderBlock(headerBlock);

  const result: ParsedEmail = {
    headers,
    bodyText: "",
    bodyHtml: "",
    attachments: [],
  };

  const contentType = (headers["content-type"]?.[0] ?? "text/plain").toLowerCase();
  const transferEncoding = (headers["content-transfer-encoding"]?.[0] ?? "7bit").toLowerCase();

  if (contentType.startsWith("multipart/")) {
    const boundary = matchHeaderParam(headers["content-type"]?.[0] ?? "", "boundary");
    if (!boundary) {
      result.bodyText = decodeTransferEncoding(body, transferEncoding);
      return result;
    }
    const parts = splitMultipart(body, boundary);
    for (const part of parts) {
      const partHeaderEnd = part.indexOf("\n\n");
      if (partHeaderEnd === -1) continue;
      const partHeaders = parseHeaderBlock(part.slice(0, partHeaderEnd));
      const partBody = part.slice(partHeaderEnd + 2);
      const partType = (partHeaders["content-type"]?.[0] ?? "text/plain").toLowerCase();
      const partTransfer = (partHeaders["content-transfer-encoding"]?.[0] ?? "7bit").toLowerCase();
      const disposition = (partHeaders["content-disposition"]?.[0] ?? "").toLowerCase();
      const filename = matchHeaderParam(partHeaders["content-disposition"]?.[0] ?? "", "filename")
        || matchHeaderParam(partHeaders["content-type"]?.[0] ?? "", "name")
        || "";

      if (disposition.startsWith("attachment") || filename) {
        const decoded = decodeTransferEncodingToBytes(partBody, partTransfer);
        result.attachments.push({
          filename: filename.replace(/^"|"$/g, ""),
          contentType: partType.split(";")[0]!.trim(),
          sizeBytes: decoded.length,
        });
        continue;
      }

      const decoded = decodeTransferEncoding(partBody, partTransfer);
      if (partType.startsWith("text/plain") && !result.bodyText) {
        result.bodyText = decoded;
      } else if (partType.startsWith("text/html") && !result.bodyHtml) {
        result.bodyHtml = decoded;
      } else if (partType.startsWith("multipart/")) {
        const nested = parseEmail(part);
        if (nested.bodyText && !result.bodyText) result.bodyText = nested.bodyText;
        if (nested.bodyHtml && !result.bodyHtml) result.bodyHtml = nested.bodyHtml;
        result.attachments.push(...nested.attachments);
      }
    }
  } else if (contentType.startsWith("text/html")) {
    result.bodyHtml = decodeTransferEncoding(body, transferEncoding);
  } else {
    result.bodyText = decodeTransferEncoding(body, transferEncoding);
  }
  return result;
}

function parseHeaderBlock(block: string): Record<string, string[]> {
  const headers: Record<string, string[]> = {};
  // Unfold continuation lines (RFC 5322): line starts with whitespace → join with previous.
  const unfolded: string[] = [];
  for (const line of block.split("\n")) {
    if (/^[ \t]/.test(line) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += " " + line.trim();
    } else {
      unfolded.push(line);
    }
  }
  for (const line of unfolded) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = decodeRfc2047(line.slice(idx + 1).trim());
    if (!name) continue;
    if (!headers[name]) headers[name] = [];
    headers[name]!.push(value);
  }
  return headers;
}

function matchHeaderParam(headerValue: string, param: string): string {
  // Match name="value" or name=value (unquoted, up to ; or end)
  const re = new RegExp(`${param.replace(/[-/\\^$*+?.()|[\\]{}]/g, "\\$&")}=("([^"]*)"|([^;\\s]+))`, "i");
  const match = headerValue.match(re);
  return match ? (match[2] ?? match[3] ?? "") : "";
}

function splitMultipart(body: string, boundary: string): string[] {
  const sep = `--${boundary}`;
  const end = `--${boundary}--`;
  const parts: string[] = [];
  let i = body.indexOf(sep);
  if (i === -1) return parts;
  while (i !== -1) {
    const after = i + sep.length;
    // Skip the trailing CRLF/LF after boundary marker
    let start = after;
    if (body[start] === "\r") start++;
    if (body[start] === "\n") start++;
    const nextSep = body.indexOf(`\n${sep}`, start);
    const partEnd = nextSep === -1 ? body.length : nextSep + 1;
    const slice = body.slice(start, partEnd).replace(/\r?\n$/, "");
    if (slice && !slice.startsWith(end)) parts.push(slice);
    if (nextSep === -1) break;
    i = nextSep + 1;
    if (body.startsWith(end, i)) break;
  }
  return parts;
}

function decodeTransferEncoding(body: string, encoding: string): string {
  return decodeTransferEncodingToBytes(body, encoding).toString("utf8");
}

function decodeTransferEncodingToBytes(body: string, encoding: string): Buffer {
  if (encoding === "base64") {
    const cleaned = body.replace(/[\r\n]/g, "");
    try {
      return Buffer.from(cleaned, "base64");
    } catch {
      return Buffer.from(body, "utf8");
    }
  }
  if (encoding === "quoted-printable") {
    return decodeQuotedPrintable(body);
  }
  return Buffer.from(body, "utf8");
}

function decodeQuotedPrintable(input: string): Buffer {
  const collapsed = input.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < collapsed.length; i++) {
    const c = collapsed[i];
    if (c === "=" && i + 2 < collapsed.length) {
      const hex = collapsed.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push((c ?? "").charCodeAt(0));
  }
  return Buffer.from(bytes);
}

function decodeRfc2047(value: string): string {
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]+)\?=/g, (_m, charset, enc, encoded) => {
    try {
      if (enc.toUpperCase() === "B") {
        return Buffer.from(encoded, "base64").toString("utf8");
      }
      const qpDecoded = decodeQuotedPrintable(encoded.replace(/_/g, " ")).toString("utf8");
      return qpDecoded;
    } catch {
      return _m;
    }
  });
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n");
}

function formatHeaderName(name: string): string {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("-");
}

// ─────────────────────────────────────────────────────────────────────────────
// extract_calendar — .ics → structured events
// ─────────────────────────────────────────────────────────────────────────────

interface CalendarEvent {
  uid: string;
  summary: string;
  description: string;
  location: string;
  start: string;
  end: string;
  organizer: string;
  attendees: string[];
  status: string;
  rrule: string;
}

registerTool({
  name: "extract_calendar",
  description:
    "Parse an iCalendar file (.ics) into a structured event list. Returns each VEVENT with summary, start/end timestamps, location, organizer, attendees, RRULE, status, and description. Read-only.",
  embeddingDescription:
    "ics ical icalendar calendar parse events extract meetings appointments schedule import outlook google",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative .ics path." },
      includePast: {
        type: "boolean",
        description: "Include events whose end-time is before now. Defaults to true.",
      },
    },
    required: ["path"],
  },
  async execute(args, ctx) {
    const path = String(args["path"] ?? "").trim();
    if (!path) return fail("path is required");
    if (extname(path).toLowerCase() !== ".ics") return fail("path must end in .ics");

    let resolved: string;
    try {
      ({ resolved } = resolvePathWithinWorkspace(path, ctx.workspacePath));
    } catch {
      return fail("path must resolve inside the workspace");
    }

    let raw: string;
    try {
      await assertFileSizeWithin(resolved);
      raw = await readFile(resolved, "utf8");
    } catch (err) {
      return fail(`Failed to read .ics file: ${String(err)}`);
    }

    const events = parseIcs(raw);
    const includePast = args["includePast"] !== false;
    const now = Date.now();
    const filtered = includePast
      ? events
      : events.filter((evt) => {
          const endTs = parseIcsTime(evt.end || evt.start);
          return endTs === null || endTs >= now;
        });

    return {
      success: true,
      output: truncateOutput(JSON.stringify(filtered, null, 2), undefined, "Calendar"),
      metadata: {
        path,
        eventCount: filtered.length,
        totalEventCount: events.length,
        skippedPastCount: events.length - filtered.length,
      },
    };
  },
});

function parseIcs(raw: string): CalendarEvent[] {
  // Unfold continuation lines (RFC 5545): a line starting with space or tab is appended to the previous line.
  const normalized = raw.replace(/\r\n/g, "\n");
  const unfolded: string[] = [];
  for (const line of normalized.split("\n")) {
    if (/^[ \t]/.test(line) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += line.slice(1);
    } else {
      unfolded.push(line);
    }
  }

  const events: CalendarEvent[] = [];
  let current: Partial<CalendarEvent> & { attendees: string[] } | null = null;

  for (const line of unfolded) {
    if (line === "BEGIN:VEVENT") {
      current = { attendees: [] };
      continue;
    }
    if (line === "END:VEVENT") {
      if (current) {
        events.push({
          uid: current.uid ?? "",
          summary: current.summary ?? "",
          description: current.description ?? "",
          location: current.location ?? "",
          start: current.start ?? "",
          end: current.end ?? "",
          organizer: current.organizer ?? "",
          attendees: current.attendees,
          status: current.status ?? "",
          rrule: current.rrule ?? "",
        });
      }
      current = null;
      continue;
    }
    if (!current) continue;

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const left = line.slice(0, colonIdx);
    const value = unescapeIcsText(line.slice(colonIdx + 1));
    const name = (left.split(";")[0] ?? "").toUpperCase();
    switch (name) {
      case "UID": current.uid = value; break;
      case "SUMMARY": current.summary = value; break;
      case "DESCRIPTION": current.description = value; break;
      case "LOCATION": current.location = value; break;
      case "DTSTART": current.start = value; break;
      case "DTEND": current.end = value; break;
      case "ORGANIZER": current.organizer = value.replace(/^MAILTO:/i, ""); break;
      case "ATTENDEE": current.attendees.push(value.replace(/^MAILTO:/i, "")); break;
      case "STATUS": current.status = value; break;
      case "RRULE": current.rrule = value; break;
    }
  }
  return events;
}

function unescapeIcsText(value: string): string {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function parseIcsTime(value: string): number | null {
  if (!value) return null;
  // Forms: 20260423T080000Z, 20260423T080000, 20260423
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/);
  if (!m) return null;
  const [, y, mo, d, h = "0", mn = "0", s = "0", z = ""] = m;
  const iso = `${y}-${mo}-${d}T${h.padStart(2, "0")}:${mn.padStart(2, "0")}:${s.padStart(2, "0")}${z ? "Z" : ""}`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// transcribe_video — route a video file's audio track through STT
// ─────────────────────────────────────────────────────────────────────────────

registerTool({
  name: "transcribe_video",
  description:
    "Transcribe the audio track of a video file from the workspace using the configured STT backend. Most STT services (whisper, qwen-audio, etc.) accept video input directly and demux the audio internally. Read-only.",
  embeddingDescription:
    "video transcribe audio track speech-to-text mp4 mov webm meeting recording screencast Sprache zu Text Video",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative video file path." },
      language: { type: "string", description: "Optional language hint (e.g. en, de)." },
      prompt: { type: "string", description: "Optional transcription prompt or context." },
      model: { type: "string", description: "Optional STT model override." },
    },
    required: ["path"],
  },
  async execute(args, ctx) {
    const path = String(args["path"] ?? "").trim();
    if (!path) return fail("path is required");
    const ext = extname(path).toLowerCase();
    const supported = [".mp4", ".mov", ".webm", ".mkv", ".m4v", ".avi"];
    if (!supported.includes(ext)) {
      return fail(`path must be a video file (${supported.join(", ")}); got ${ext || "no extension"}`);
    }
    log.debug({ path }, "transcribe_video → routing to transcribe_audio");
    return callExistingTool("transcribe_audio", args, ctx);
  },
});
