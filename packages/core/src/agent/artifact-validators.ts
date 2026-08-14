/**
 * Per-format artifact validators — "is this file actually usable?", deterministically.
 *
 * Every generated artifact passes through here. The question answered is narrow and
 * honest: is the file WELL-FORMED for what its extension claims to be. That is not
 * the same as "correct" — nothing here knows whether the PDF says the right thing —
 * and the receipts say so. What it does catch is the failure class that actually
 * ships: truncated writes, zero-byte files, a renderer that died mid-stream, and a
 * deliverable whose bytes are not the format the user was promised.
 *
 * THREE-VALUED, and this is the load-bearing design decision:
 *
 *   pass          — checked, well-formed.
 *   fail          — checked, definitively broken. Costs a rebuild, so it must be certain.
 *   unverifiable  — could not check (unknown format, over size cap, ambiguous parse,
 *                   missing library). Costs an honest caveat.
 *
 * A validator that cannot reach a confident verdict returns `unverifiable`, NEVER
 * `fail`. A false `fail` throws away a good deliverable and burns a rebuild; a false
 * `unverifiable` only adds a caveat. The asymmetry is deliberate and every validator
 * below is written to respect it.
 *
 * Severity separates "this file is broken" from "this looks suspicious":
 *   hard — structural proof of breakage (bad magic bytes, unterminated construct).
 *   soft — heuristic worth reporting but never worth failing a turn over.
 *
 * Dependency policy: pdf-lib is already a core dep and is used for PDFs. Everything
 * else is hand-rolled against the format spec so this module adds no dependency and
 * cannot fail because a package is missing.
 */
import { childLogger } from "../logger.js";

const log = childLogger("agent:artifact-validators");

export type ValidationStatus = "pass" | "fail" | "unverifiable";
export type ValidationSeverity = "hard" | "soft";

export interface ValidationResult {
  status: ValidationStatus;
  /** Short probe name for the receipt, e.g. "pdf_structure", "zip_parts". */
  probe: string;
  detail: string;
  /** Only meaningful when status === "fail". Soft failures must not block delivery. */
  severity: ValidationSeverity;
}

const pass = (probe: string, detail: string): ValidationResult => ({ status: "pass", probe, detail, severity: "hard" });
const fail = (probe: string, detail: string, severity: ValidationSeverity = "hard"): ValidationResult => ({ status: "fail", probe, detail, severity });
const unknown = (probe: string, detail: string): ValidationResult => ({ status: "unverifiable", probe, detail, severity: "soft" });

/** Extensions we can say something meaningful about. Anything else → unverifiable. */
const TEXTUAL = new Set([".json", ".html", ".htm", ".svg", ".ics", ".md", ".markdown", ".txt", ".csv", ".mmd", ".xml", ".css", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"]);

export function extensionOf(path: string): string {
  const name = path.replace(/\\/g, "/").split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

/**
 * Validate an artifact's bytes against what its extension claims.
 * Pure and synchronous apart from the PDF path, which needs pdf-lib's async load.
 */
export async function validateArtifactBytes(path: string, bytes: Uint8Array): Promise<ValidationResult> {
  if (bytes.length === 0) return fail("empty", "zero-byte file — nothing was written");

  const ext = extensionOf(path);
  try {
    switch (ext) {
      case ".pdf": return await validatePdf(bytes);
      case ".docx": return validateOoxml(bytes, "word/document.xml", "DOCX");
      case ".pptx": return validateOoxml(bytes, "ppt/presentation.xml", "PPTX");
      case ".xlsx": return validateOoxml(bytes, "xl/workbook.xml", "XLSX");
      case ".zip": return validateZip(bytes);
      case ".png": return validatePng(bytes);
      case ".jpg":
      case ".jpeg": return validateJpeg(bytes);
      case ".gif": return validateGif(bytes);
      case ".webp": return validateWebp(bytes);
      case ".wav": return validateWav(bytes);
      case ".json": return validateJson(bytes);
      case ".html":
      case ".htm": return validateHtml(bytes);
      case ".svg": return validateSvg(bytes);
      case ".ics": return validateIcs(bytes);
      case ".mmd": return validateMermaid(bytes);
      case ".css":
      case ".js":
      case ".mjs":
      case ".cjs":
      case ".ts":
      case ".tsx":
      case ".jsx": return validateCodeIntegrity(bytes, ext);
      case ".md":
      case ".markdown":
      case ".txt":
      case ".csv":
      case ".xml": return validateText(bytes, ext);
      default:
        return unknown("format", `no validator for '${ext || "extensionless file"}' — existence and size checked only`);
    }
  } catch (err) {
    // A validator that throws is a bug in the validator, not proof the file is bad.
    log.warn({ err, path, ext }, "artifact validator threw — reporting unverifiable");
    return unknown("validator_error", `validator error: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
  }
}

// ── Binary formats ───────────────────────────────────────────────────────────

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  if (bytes.length < magic.length) return false;
  return magic.every((b, i) => bytes[i] === b);
}

async function validatePdf(bytes: Uint8Array): Promise<ValidationResult> {
  if (!startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) { // "%PDF-"
    return fail("pdf_structure", `not a PDF — expected a %PDF- header, found ${describeLeadingBytes(bytes)}`);
  }
  // Look for the trailer ANYWHERE in the tail, never `endsWith`: valid PDFs carry
  // trailing whitespace, and incrementally-updated files hold several %%EOF markers.
  const tail = Buffer.from(bytes.subarray(Math.max(0, bytes.length - 2048))).toString("latin1");
  if (!tail.includes("%%EOF")) {
    return fail("pdf_structure", `PDF trailer missing (no %%EOF in the last 2 KB of ${bytes.length} bytes) — the file was cut off before the render finished`);
  }
  try {
    const { PDFDocument } = await import("pdf-lib");
    // ignoreEncryption: an encrypted-but-valid PDF must not be reported as broken.
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const pages = doc.getPageCount();
    if (pages < 1) return fail("pdf_structure", "PDF parsed but contains no pages");
    return pass("pdf_structure", `valid PDF, ${pages} page(s)`);
  } catch (err) {
    // Header and trailer are both present, so the file is plausibly fine and pdf-lib
    // is simply strict (it rejects some legal constructs). Do not burn a rebuild on it.
    return unknown("pdf_structure", `header and trailer present but the parser rejected it: ${err instanceof Error ? err.message.slice(0, 100) : String(err)}`);
  }
}

/**
 * List the entry names in a ZIP central directory. Hand-rolled so OOXML validation
 * needs no zip library: find the End Of Central Directory record, then walk the
 * central-directory file headers it points at. Returns null when the structure
 * cannot be read (→ caller reports unverifiable, not fail).
 */
function listZipEntries(bytes: Uint8Array): string[] | null {
  const view = Buffer.from(bytes);
  // EOCD signature 0x06054b50, within the last 64 KB + 22 byte record.
  const searchFrom = Math.max(0, view.length - (0xffff + 22));
  let eocd = -1;
  for (let i = view.length - 22; i >= searchFrom; i--) {
    if (view.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;

  const entryCount = view.readUInt16LE(eocd + 10);
  const cdOffset = view.readUInt32LE(eocd + 16);
  // ZIP64 or a truncated archive: the offset points outside the file.
  if (cdOffset >= view.length || entryCount === 0) return null;

  const names: string[] = [];
  let p = cdOffset;
  for (let n = 0; n < entryCount; n++) {
    if (p + 46 > view.length || view.readUInt32LE(p) !== 0x02014b50) return null;
    const nameLen = view.readUInt16LE(p + 28);
    const extraLen = view.readUInt16LE(p + 30);
    const commentLen = view.readUInt16LE(p + 32);
    const nameEnd = p + 46 + nameLen;
    if (nameEnd > view.length) return null;
    names.push(view.subarray(p + 46, nameEnd).toString("utf8"));
    p = nameEnd + extraLen + commentLen;
  }
  return names;
}

function validateZipContainer(bytes: Uint8Array, label: string): { entries: string[] } | ValidationResult {
  // "PK\x03\x04" (normal) or "PK\x05\x06" (empty archive).
  if (!startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) && !startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) {
    return fail("zip_structure", `not a ${label} — expected a ZIP container, found ${describeLeadingBytes(bytes)}`);
  }
  const entries = listZipEntries(bytes);
  if (entries === null) {
    return fail("zip_structure", `${label} container is unreadable — the ZIP central directory is missing or truncated`);
  }
  return { entries };
}

function validateOoxml(bytes: Uint8Array, requiredPart: string, label: string): ValidationResult {
  const container = validateZipContainer(bytes, label);
  if ("status" in container) return container;
  const { entries } = container;
  if (!entries.includes("[Content_Types].xml")) {
    return fail("ooxml_parts", `${label} is missing [Content_Types].xml — not a valid Office document`);
  }
  if (!entries.includes(requiredPart)) {
    return fail("ooxml_parts", `${label} is missing its main part ${requiredPart} (found ${entries.length} entries) — the document body was never written`);
  }
  return pass("ooxml_parts", `valid ${label}, ${entries.length} package part(s)`);
}

function validateZip(bytes: Uint8Array): ValidationResult {
  const container = validateZipContainer(bytes, "ZIP");
  if ("status" in container) return container;
  if (container.entries.length === 0) return fail("zip_structure", "ZIP archive contains no entries");
  return pass("zip_structure", `valid ZIP, ${container.entries.length} entr(ies)`);
}

function validatePng(bytes: Uint8Array): ValidationResult {
  if (!startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return fail("image_structure", `not a PNG — bad signature, found ${describeLeadingBytes(bytes)}`);
  }
  const tail = Buffer.from(bytes.subarray(Math.max(0, bytes.length - 16)));
  if (!tail.includes("IEND")) return fail("image_structure", "PNG is missing its IEND chunk — the file is truncated");
  return pass("image_structure", `valid PNG, ${bytes.length} bytes`);
}

function validateJpeg(bytes: Uint8Array): ValidationResult {
  if (!startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return fail("image_structure", `not a JPEG — bad SOI marker, found ${describeLeadingBytes(bytes)}`);
  }
  // EOI marker FF D9. Some encoders append padding, so scan a small tail window.
  const tail = bytes.subarray(Math.max(0, bytes.length - 32));
  let hasEoi = false;
  for (let i = 0; i + 1 < tail.length; i++) {
    if (tail[i] === 0xff && tail[i + 1] === 0xd9) { hasEoi = true; break; }
  }
  if (!hasEoi) return fail("image_structure", "JPEG is missing its end-of-image marker — the file is truncated");
  return pass("image_structure", `valid JPEG, ${bytes.length} bytes`);
}

function validateGif(bytes: Uint8Array): ValidationResult {
  const head = Buffer.from(bytes.subarray(0, 6)).toString("latin1");
  if (head !== "GIF87a" && head !== "GIF89a") {
    return fail("image_structure", `not a GIF — bad signature, found ${describeLeadingBytes(bytes)}`);
  }
  return pass("image_structure", `valid GIF, ${bytes.length} bytes`);
}

function validateWebp(bytes: Uint8Array): ValidationResult {
  const riff = Buffer.from(bytes.subarray(0, 4)).toString("latin1");
  const webp = Buffer.from(bytes.subarray(8, 12)).toString("latin1");
  if (riff !== "RIFF" || webp !== "WEBP") {
    return fail("image_structure", `not a WEBP — bad RIFF/WEBP signature, found ${describeLeadingBytes(bytes)}`);
  }
  return pass("image_structure", `valid WEBP, ${bytes.length} bytes`);
}

function validateWav(bytes: Uint8Array): ValidationResult {
  const riff = Buffer.from(bytes.subarray(0, 4)).toString("latin1");
  const wave = Buffer.from(bytes.subarray(8, 12)).toString("latin1");
  if (riff !== "RIFF" || wave !== "WAVE") {
    return fail("audio_structure", `not a WAV — bad RIFF/WAVE signature, found ${describeLeadingBytes(bytes)}`);
  }
  return pass("audio_structure", `valid WAV, ${bytes.length} bytes`);
}

// ── Textual formats ──────────────────────────────────────────────────────────

function decode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8");
}

function validateJson(bytes: Uint8Array): ValidationResult {
  const text = decode(bytes);
  if (!text.trim()) return fail("json_parse", "empty file");
  try {
    JSON.parse(text);
    return pass("json_parse", "valid JSON");
  } catch (err) {
    return fail("json_parse", `invalid JSON: ${err instanceof Error ? err.message.slice(0, 120) : "parse error"}`);
  }
}

/**
 * HTML structural check. Tag counting is done on a version of the source with
 * comments and the BODIES of <script>/<style> removed first — counting raw
 * `<script` occurrences over the whole file reports "unclosed <script>" on any page
 * that prints markup inside a JS string or a <pre> tutorial block, which is a
 * perfectly valid document. That false positive is worse than the miss it prevents.
 */
export function validateHtmlText(text: string): ValidationResult {
  const trimmed = text.trim();
  if (!trimmed) return fail("html_structure", "empty file");

  // Unterminated final tag is unambiguous truncation.
  if (trimmed.lastIndexOf("<") > trimmed.lastIndexOf(">")) {
    return fail("html_structure", "ends mid-tag — the file was cut off during the write");
  }

  const stripped = trimmed
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "<script></script>")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "<style></style>");

  // A fragment (no <html>) has no required terminator — only judge full documents.
  if (/<html[\s>]/i.test(stripped)) {
    for (const tag of ["html", "body"] as const) {
      const opens = (stripped.match(new RegExp(`<${tag}[\\s>]`, "gi")) ?? []).length;
      const closes = (stripped.match(new RegExp(`</${tag}\\s*>`, "gi")) ?? []).length;
      if (opens > closes) {
        return fail("html_structure", `unclosed <${tag}> (${opens} opened, ${closes} closed) — the document ends before it is complete`);
      }
    }
  }
  return pass("html_structure", "structure balanced");
}

function validateHtml(bytes: Uint8Array): ValidationResult {
  return validateHtmlText(decode(bytes));
}

function validateSvg(bytes: Uint8Array): ValidationResult {
  const text = decode(bytes).trim();
  if (!text) return fail("svg_structure", "empty file");
  if (!/<svg[\s>]/i.test(text)) return fail("svg_structure", "no <svg> root element — this is not an SVG");
  if (!/<\/svg\s*>/i.test(text.slice(-2000))) return fail("svg_structure", "missing closing </svg> — the file is truncated");
  return pass("svg_structure", "valid SVG root");
}

function validateIcs(bytes: Uint8Array): ValidationResult {
  const text = decode(bytes);
  if (!/BEGIN:VCALENDAR/i.test(text)) return fail("ics_structure", "missing BEGIN:VCALENDAR — not an iCalendar file");
  if (!/END:VCALENDAR/i.test(text)) return fail("ics_structure", "missing END:VCALENDAR — the file is truncated");
  return pass("ics_structure", "valid iCalendar envelope");
}

/**
 * Mermaid: soft only, permanently. A fixed list of diagram keywords would reject
 * valid new diagram types the moment upstream adds one, which is exactly the
 * keyword-overfitting this codebase avoids. Emptiness is the only hard signal.
 */
function validateMermaid(bytes: Uint8Array): ValidationResult {
  const text = decode(bytes).replace(/^\s*%%\{[\s\S]*?\}%%\s*/m, "").replace(/^\s*%%.*$/gm, "").trim();
  if (!text) return fail("mermaid_structure", "no diagram source — the file holds only comments or is empty");
  return pass("mermaid_structure", "non-empty diagram source");
}

function validateText(bytes: Uint8Array, ext: string): ValidationResult {
  const text = decode(bytes);
  if (!text.trim()) return fail("text_content", "empty file");
  if (ext === ".xml") {
    if (text.trimStart().startsWith("<") && text.trimEnd().endsWith(">")) return pass("text_content", "non-empty XML");
    return unknown("text_content", "non-empty, but XML well-formedness was not checked");
  }
  return pass("text_content", `non-empty (${bytes.length} bytes)`);
}

// ── Code integrity ───────────────────────────────────────────────────────────

/**
 * Structural integrity for code, WITHOUT executing or fully parsing it.
 *
 * This deliberately verifies integrity, not correctness. It answers "did the whole
 * file get written?", which is the failure that actually happens: a model hits its
 * completion budget mid-function and the file ends inside a string or a block. Real
 * syntax validation would need a per-language parser; this is language-independent
 * and catches the dominant defect.
 *
 * It reports `fail` ONLY on unambiguous truncation — an unterminated block comment
 * or string literal at EOF, or brackets left open at EOF. Anything the scanner
 * cannot read confidently (notably JS regex-literal-vs-division ambiguity) returns
 * `unverifiable` rather than risking a false failure on good code.
 */
export function validateCodeIntegrityText(source: string, ext: string): ValidationResult {
  if (!source.trim()) return fail("code_integrity", "empty file");

  const jsLike = ext !== ".css";
  const stack: string[] = [];
  let i = 0;
  let ambiguous = false;

  // Tracks whether a `/` at this position can start a regex literal. After a value
  // (identifier, literal, closing bracket) it is division; otherwise it may be a
  // regex. When we cannot tell, bail to unverifiable instead of guessing.
  let prevSignificant = "";

  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];

    // Line comment
    if (c === "/" && next === "/") {
      const nl = source.indexOf("\n", i);
      if (nl < 0) break;
      i = nl + 1;
      continue;
    }
    // Block comment
    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end < 0) return fail("code_integrity", "unterminated block comment — the file ends inside /* ... */, so the write was cut off");
      i = end + 2;
      continue;
    }
    // String / template literal
    if (c === '"' || c === "'" || (jsLike && c === "`")) {
      const end = scanStringEnd(source, i, c);
      if (end < 0) {
        return fail("code_integrity", `unterminated ${c === "`" ? "template literal" : "string literal"} starting at offset ${i} — the file ends mid-string, so the write was cut off`);
      }
      i = end + 1;
      prevSignificant = "value";
      continue;
    }
    // Regex literal (JS-family only) — the one genuinely ambiguous construct.
    if (jsLike && c === "/" && prevSignificant !== "value") {
      const end = scanRegexEnd(source, i);
      if (end < 0) { ambiguous = true; break; }
      i = end + 1;
      prevSignificant = "value";
      continue;
    }

    if (c === "(" || c === "[" || c === "{") { stack.push(c); prevSignificant = ""; i++; continue; }
    if (c === ")" || c === "]" || c === "}") {
      const open = stack.pop();
      const expected = c === ")" ? "(" : c === "]" ? "[" : "{";
      if (open !== expected) {
        // Mismatched closer. In a language this scanner only approximates, treat a
        // mismatch as ambiguity rather than proof of breakage.
        ambiguous = true;
        break;
      }
      prevSignificant = "value";
      i++;
      continue;
    }

    if (/[A-Za-z0-9_$)\]]/.test(c)) prevSignificant = "value";
    else if (!/\s/.test(c)) prevSignificant = "";
    i++;
  }

  if (ambiguous) {
    return unknown("code_integrity", "structure could not be scanned confidently (ambiguous regex or bracket nesting) — not treated as a defect");
  }
  if (stack.length > 0) {
    const kind = stack[stack.length - 1] === "{" ? "brace" : stack[stack.length - 1] === "(" ? "parenthesis" : "bracket";
    return fail("code_integrity", `${stack.length} unclosed ${kind}(s) at end of file — the file ends mid-block, so the write was cut off`);
  }
  return pass("code_integrity", "brackets, strings and comments all terminated");
}

function validateCodeIntegrity(bytes: Uint8Array, ext: string): ValidationResult {
  return validateCodeIntegrityText(decode(bytes), ext);
}

/** Index of the closing quote, or -1 when the literal never terminates. */
function scanStringEnd(source: string, start: number, quote: string): number {
  for (let i = start + 1; i < source.length; i++) {
    const c = source[i]!;
    if (c === "\\") { i++; continue; }
    if (c === quote) return i;
    // A plain quote never spans a newline; a template literal may.
    if (c === "\n" && quote !== "`") return -1;
  }
  return -1;
}

/** Index of the closing slash of a regex literal, or -1 when it does not terminate. */
function scanRegexEnd(source: string, start: number): number {
  let inClass = false;
  for (let i = start + 1; i < source.length; i++) {
    const c = source[i]!;
    if (c === "\\") { i++; continue; }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) return i;
    else if (c === "\n") return -1;
  }
  return -1;
}

// ── Format-vs-extension agreement ────────────────────────────────────────────

/** Magic-byte signatures used to detect "you promised a PDF and delivered a DOCX". */
const SIGNATURES: ReadonlyArray<{ ext: readonly string[]; magic: readonly number[]; label: string }> = [
  { ext: [".pdf"], magic: [0x25, 0x50, 0x44, 0x46, 0x2d], label: "PDF" },
  { ext: [".png"], magic: [0x89, 0x50, 0x4e, 0x47], label: "PNG" },
  { ext: [".jpg", ".jpeg"], magic: [0xff, 0xd8, 0xff], label: "JPEG" },
  { ext: [".gif"], magic: [0x47, 0x49, 0x46, 0x38], label: "GIF" },
  { ext: [".docx", ".pptx", ".xlsx", ".zip"], magic: [0x50, 0x4b], label: "ZIP-based" },
];

/**
 * Does the file's actual content match what the extension promises?
 *
 * This is what catches "here is your PDF" over a .docx. Only runs for formats with
 * an unambiguous signature, and only reports a mismatch when the bytes positively
 * match a DIFFERENT known format — an unrecognised header is `unverifiable`, since
 * plenty of legitimate formats have no magic number.
 */
export function checkFormatMatchesExtension(path: string, bytes: Uint8Array): ValidationResult | null {
  const ext = extensionOf(path);
  const expected = SIGNATURES.find((s) => s.ext.includes(ext));
  if (!expected) return null; // no signature to check against — the per-format validator covers it
  if (startsWith(bytes, expected.magic)) return null; // matches, nothing to report

  const actual = SIGNATURES.find((s) => startsWith(bytes, s.magic));
  if (actual) {
    return fail("format_match", `file is named ${ext} but its bytes are ${actual.label}, not ${expected.label} — the wrong format was delivered`);
  }
  return fail("format_match", `file is named ${ext} but does not start with a ${expected.label} signature (found ${describeLeadingBytes(bytes)})`);
}

function describeLeadingBytes(bytes: Uint8Array): string {
  const head = bytes.subarray(0, 8);
  const printable = Buffer.from(head).toString("latin1").replace(/[^\x20-\x7e]/g, ".");
  const hex = Array.from(head).map((b) => b.toString(16).padStart(2, "0")).join(" ");
  return `"${printable}" (${hex})`;
}

/** True when this extension is one the validators understand at all. */
export function isValidatableExtension(ext: string): boolean {
  return TEXTUAL.has(ext)
    || [".pdf", ".docx", ".pptx", ".xlsx", ".zip", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".wav"].includes(ext);
}
