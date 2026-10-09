/**
 * Code navigation — find files by shape, find code by pattern.
 *
 * The gap these close: the workspace had `list_files` (one directory at a time) and
 * `workspace_search` (keyword full-text, ranked snippets). Neither answers the two
 * questions that dominate real work on a source tree — "where are all the X files?"
 * and "show me every call site, with the surrounding lines" — so an agent either
 * walked directories one call at a time or pulled whole files into context to find
 * three lines. Both tools are read-only (Tier 0) and inherit the same workspace
 * confinement and sensitive-path denial as the rest of the filesystem surface.
 */
import { readFileSync, statSync, readdirSync, existsSync } from "node:fs";
import { join, relative, extname, sep } from "node:path";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { childLogger } from "../logger.js";
import { isSensitiveWorkspacePath, guardPath, clipLine, MAX_TEXT_FILE_BYTES } from "./filesystem.js";
import { resolvePathWithinWorkspace } from "./workspace-path.js";

const log = childLogger("tool:code-navigation");

/** Directories never worth walking — huge, generated, or not source. */
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".turbo", "coverage",
  ".venv", "venv", "__pycache__", ".cache", ".pnpm-store", "target",
]);
const MAX_RESULTS = 300;
/** Largest file a search over a directory opens; a larger one is named in the result, not silently passed over. */
const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024;
/** Longest line a match block shows whole; a longer one shows this much around the match. */
const MAX_GREP_LINE_CHARS = 500;
const MAX_WALK_ENTRIES = 20_000;
const BINARY_EXTENSIONS = new Set([
  // images
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tif", ".tiff", ".avif", ".heic", ".psd",
  // documents and archives
  ".pdf", ".zip", ".docx", ".pptx", ".xlsx", ".doc", ".xls", ".ppt", ".odt", ".ods", ".odp",
  ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".tar", ".jar",
  // fonts
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  // audio and video
  ".mp4", ".wav", ".mp3", ".ogg", ".flac", ".m4a", ".aac", ".mov", ".avi", ".mkv", ".webm",
  // databases and compiled artefacts
  ".sqlite", ".sqlite3", ".db", ".exe", ".dll", ".so", ".dylib", ".bin", ".wasm", ".class", ".pyc", ".o", ".a", ".lockb",
]);
/** SKIP_DIRS that hold installed dependencies: counted in an answer, never named as a place to
 *  look — pointing the model at node_modules sends it into a dependency tree. */
const DEPENDENCY_DIRS = new Set(["node_modules", ".pnpm-store", ".venv", "venv"]);

function fail(error: string): ToolResult {
  return { success: false, output: "", error };
}

/**
 * Translate a glob to a RegExp. Supports the subset people actually type:
 * `**` (any depth), `*` (within a segment), `?`, and `{a,b}` alternation.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` consumes any number of segments INCLUDING none, so `**/*.ts`
        // matches a top-level file as well as a deeply nested one.
        if (pattern[i + 2] === "/") { out += "(?:.*/)?"; i += 2; }
        else { out += ".*"; i += 1; }
      } else out += "[^/]*";
      continue;
    }
    if (c === "?") { out += "[^/]"; continue; }
    if (c === "{") {
      const close = pattern.indexOf("}", i);
      if (close > i) {
        const alts = pattern.slice(i + 1, close).split(",").map((a) => a.replace(/[.+^${}()|[\]\\]/g, "\\$&"));
        out += `(?:${alts.join("|")})`;
        i = close;
        continue;
      }
    }
    out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, "i");
}

/**
 * Walk the workspace, yielding root-relative POSIX paths.
 *
 * The denylist is checked on the path relative to the WORKSPACE as well as to the walk root
 * (security finding S1, 2026-10-05): with `path: ".starlingai"` the root-relative entries read
 * "memory/user/x.json" and "auth/…", which no pattern names, so grep_files searched the durable
 * memory and the credential directory's contents. The workspace-relative form keeps the prefix.
 */
function walk(
  root: string,
  workspaceRoot: string,
  onFile: (rel: string, abs: string) => boolean | void,
  report: WalkReport = newWalkReport(),
  descend: ReadonlySet<string> = new Set(),
): WalkReport {
  let seen = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch (err) {
      // Every one of these used to be a silent `continue`: a directory the walk could not open
      // contributed nothing, and the answer read as if it had been searched and held no match.
      report.unreadable.push(`${relative(root, dir).split(sep).join("/") || "."} (${errorCode(err)})`);
      continue;
    }
    for (const entry of entries) {
      if (++seen > MAX_WALK_ENTRIES) { report.stoppedAfter = MAX_WALK_ENTRIES; return report; }
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).split(sep).join("/");
      if (isSensitiveWorkspacePath(rel) || isSensitiveWorkspacePath(relative(workspaceRoot, abs))) continue;
      if (entry.isDirectory()) {
        // A directory the caller's glob names (`dist/**`, `**/node_modules/x/*.ts`) is what they
        // asked for; skipping it anyway answered "No files match" for files that were there.
        if (SKIP_DIRS.has(entry.name) && !descend.has(entry.name.toLowerCase())) { report.skipped.push(rel); continue; }
        stack.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (onFile(rel, abs) === false) return report;
    }
  }
  return report;
}

/** What a walk did not cover, so the answer can say so instead of reading as complete. */
interface WalkReport {
  /** Set when the walk gave up at the entry cap with tree left unvisited. */
  stoppedAfter?: number;
  /** Directories that could not be opened, root-relative, with the reason. */
  unreadable: string[];
  /** SKIP_DIRS directories passed over, root-relative. */
  skipped: string[];
}

function newWalkReport(): WalkReport {
  return { unreadable: [], skipped: [] };
}

/** The error's code (EACCES, ENOENT, …) when it has one, else its message. */
function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : err instanceof Error ? err.message : String(err);
}

/** The SKIP_DIRS names a glob spells out as a path segment (`dist/**`, `{build,dist}/*.js`). */
function skipDirsNamedBy(glob: string): Set<string> {
  const named = new Set<string>();
  for (const segment of glob.toLowerCase().split("/")) {
    const alternatives = /^\{[^{}]*\}$/.test(segment) ? segment.slice(1, -1).split(",") : [segment];
    for (const alt of alternatives) if (SKIP_DIRS.has(alt)) named.add(alt);
  }
  return named;
}

/** Whether a path inside the workspace-relative directory `dir` could match `glob` — so a
 *  skipped directory is reported only where it can hide a match (`src/*.ts` cannot reach
 *  into `node_modules/`; `**\/*.ts` can). Errs towards reporting. */
function globCouldReachInside(glob: string, dir: string): boolean {
  const globSegments = glob.split("/");
  const dirSegments = dir.split("/");
  const globstarAt = globSegments.findIndex((segment) => segment.includes("**"));
  if (globstarAt < 0 && globSegments.length <= dirSegments.length) return false;
  const fixed = Math.min(dirSegments.length, globstarAt < 0 ? globSegments.length : globstarAt);
  for (let i = 0; i < fixed; i++) {
    try { if (!globToRegExp(globSegments[i]!).test(dirSegments[i]!)) return false; } catch { return true; }
  }
  return true;
}

/**
 * The lines a search appends about what its walk did not cover. The skipped generated/vendored
 * directories are named only when the search found NOTHING — then they are a place the answer
 * could be. Beside real results they were ~350 characters on nearly every call, ending in an
 * invitation to search node_modules. Dependency directories are counted, never named.
 */
function walkReportNotes(report: WalkReport, skippedShown: string[], target: string, resultEmpty: boolean): string[] {
  const notes: string[] = [];
  if (report.stoppedAfter !== undefined) {
    notes.push(`Stopped after ${report.stoppedAfter} entries — the rest of the tree was not searched. Narrow path or the ${target} to cover it.`);
  }
  if (report.unreadable.length > 0) {
    notes.push(`Not searched, could not be read: ${report.unreadable.slice(0, 10).join(", ")}`
      + (report.unreadable.length > 10 ? ` and ${report.unreadable.length - 10} more` : "") + ".");
  }
  if (resultEmpty && skippedShown.length > 0) {
    const isDependency = (dir: string): boolean => DEPENDENCY_DIRS.has(dir.split("/").pop() ?? "");
    const named = skippedShown.filter((dir) => !isDependency(dir));
    const dependencies = skippedShown.length - named.length;
    const parts = [
      ...(named.length > 0 ? [named.slice(0, 6).map((dir) => `${dir}/`).join(", ") + (named.length > 6 ? ` and ${named.length - 6} more` : "")] : []),
      ...(dependencies > 0 ? [`${dependencies} installed-dependency director${dependencies === 1 ? "y" : "ies"}`] : []),
    ];
    notes.push(`Not searched, skipped as generated or vendored: ${parts.join("; ")}. If what you are looking for is generated output, name its directory in path or the ${target}.`);
  }
  return notes;
}

/**
 * Text of a file for searching, or why it cannot be searched. UTF-16 with a byte-order mark is
 * decoded: Windows tools write it (PowerShell's `>`, Notepad's "Unicode"), every second byte is
 * NUL, and the NUL check below used to drop such a file silently — "No matches" for a file that
 * held the text. Without a BOM, a NUL byte still means binary.
 */
const BINARY_CONTENT = "binary content (NUL bytes, no UTF-16 byte-order mark)";

function decodeSearchText(bytes: Buffer): { text: string } | { reason: string } {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return { text: bytes.subarray(2).toString("utf16le") };
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const body = Buffer.from(bytes.subarray(2, 2 + ((bytes.length - 2) & ~1)));
    return { text: body.swap16().toString("utf16le") };
  }
  const start = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  if (bytes.indexOf(0, start) >= 0) return { reason: BINARY_CONTENT };
  return { text: bytes.subarray(start).toString("utf-8") };
}

// ── glob_files ───────────────────────────────────────────────────────────────

registerTool({
  name: "glob_files",
  description:
    "Find files anywhere in the workspace by path pattern, e.g. '**/*.test.ts', 'src/**/{a,b}.json', 'docs/*.md'. "
    + "Returns matching workspace-relative paths sorted by most recently modified. "
    + "Use this instead of walking directories with list_files when you know the SHAPE of the filename but not where it lives.",
  embeddingDescription:
    "find files by name pattern glob wildcard extension across the project; locate all tests, all markdown, all config files; "
    + "Dateien nach Muster finden, alle Dateien mit Endung suchen, Projektstruktur durchsuchen.",
  costHint: "low",
  latencyHint: "low",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern, e.g. '**/*.ts' or 'src/**/*.{json,yaml}'. Matched against the workspace-relative path." },
      path: { type: "string", description: "Optional subdirectory to search within, workspace-relative. Defaults to the whole workspace." },
      limit: { type: "number", description: `Maximum paths to return (default ${MAX_RESULTS}).` },
    },
    required: ["pattern"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const pattern = String(args["pattern"] ?? "").trim();
    if (!pattern) return fail("pattern is required");
    const limit = Math.min(MAX_RESULTS, Math.max(1, Number(args["limit"]) || MAX_RESULTS));

    // The DEFAULT root goes through the resolver too. Taking ctx.workspacePath raw skipped the
    // zoning that the explicit-path branch below applies: a scope-confined agent calling this
    // with no `path` listed and read the platform's own config zones, which is exactly what the
    // scoping exists to prevent — and, now that the artifact zone is per-user, one account's
    // files from another's. workspace-search.ts resolves "." for the same reason.
    let root = resolvePathWithinWorkspace(".", ctx.workspacePath).resolved;
    const sub = typeof args["path"] === "string" ? args["path"].trim() : "";
    if (sub) {
      try { root = resolvePathWithinWorkspace(sub, ctx.workspacePath).resolved; }
      catch { return fail("path must be a relative path within the workspace"); }
      if (!existsSync(root)) return fail(`Directory not found: ${sub}`);
      // The walk refuses secrets entry by entry, but relative to this root: a root that is itself a
      // link into .starlingai/ or .git/ reads as innocent paths. read_file's guard checks the realpath.
      if (!guardPath(sub, ctx.workspacePath).safe) return fail(`Access denied: ${sub}`);
    }
    if (!existsSync(root)) return fail("No files to search yet — nothing has been written to your working zone.");

    let re: RegExp;
    try { re = globToRegExp(pattern); }
    catch { return fail(`Invalid pattern: ${pattern}`); }

    const hits: Array<{ rel: string; mtime: number }> = [];
    // Match against the path relative to the WORKSPACE (not the subdirectory), so a
    // pattern reads the same whether or not `path` was narrowed.
    const prefix = sub ? relative(ctx.workspacePath, root).split(sep).join("/") : "";
    const report = walk(root, ctx.workspacePath, (rel, abs) => {
      const full = prefix ? `${prefix}/${rel}` : rel;
      if (!re.test(full)) return;
      try { hits.push({ rel: full, mtime: statSync(abs).mtimeMs }); } catch { /* vanished mid-walk */ }
    }, newWalkReport(), skipDirsNamedBy(pattern));
    if (report.unreadable.some((dir) => dir.startsWith(". ("))) {
      return fail(`Could not read ${sub || "the workspace"}: ${report.unreadable[0]!.slice(3, -1)} — nothing was searched.`);
    }

    hits.sort((a, b) => b.mtime - a.mtime);
    const shown = hits.slice(0, limit);
    const atLeast = report.stoppedAfter !== undefined ? "≥" : "";
    const skippedShown = report.skipped
      .map((rel) => (prefix ? `${prefix}/${rel}` : rel))
      .filter((dir) => globCouldReachInside(pattern, dir));
    const notes = [
      ...(hits.length > shown.length
        ? [`Showing ${shown.length} of ${atLeast}${hits.length} matching paths, most recently modified first — `
          + (limit < MAX_RESULTS ? `raise limit (max ${MAX_RESULTS}) or narrow pattern/path.` : "narrow pattern or path to see the rest.")]
        : []),
      ...walkReportNotes(report, skippedShown, "pattern", shown.length === 0),
    ];
    return {
      success: true,
      output: (shown.length === 0
        ? `No files match ${pattern}.`
        : shown.map((h) => h.rel).join("\n")) + (notes.length > 0 ? `\n\n${notes.join("\n")}` : ""),
      metadata: {
        pattern,
        matched: hits.length,
        returned: shown.length,
        truncated: hits.length > shown.length,
        ...(report.stoppedAfter !== undefined ? { walkStoppedAfter: report.stoppedAfter } : {}),
        ...(report.unreadable.length > 0 ? { unreadableDirs: report.unreadable.length } : {}),
        ...(skippedShown.length > 0 ? { notDescended: skippedShown } : {}),
      },
    };
  },
});

// ── grep_files ───────────────────────────────────────────────────────────────

registerTool({
  name: "grep_files",
  description:
    "Search file CONTENTS with a regular expression and return each match with surrounding context lines. "
    + "Filter which files are searched with a glob. This is the tool for 'where is X called', 'which files still reference Y' — "
    + "workspace_search ranks by relevance for a concept; this reports every literal match with line numbers.",
  embeddingDescription:
    "grep regex search inside files for a symbol, function, string, call site, with context lines and line numbers; "
    + "find all usages, all references, all occurrences; Code durchsuchen, Vorkommen finden, Aufrufstellen suchen.",
  costHint: "low",
  latencyHint: "low",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression to search for." },
      glob: { type: "string", description: "Optional file filter, e.g. '**/*.ts'. Defaults to all text files." },
      path: { type: "string", description: "Optional subdirectory or single file to search within, workspace-relative." },
      context: { type: "number", description: "Lines of context to show around each match (default 2, max 10)." },
      ignore_case: { type: "boolean", description: "Case-insensitive match. Default false." },
      limit: { type: "number", description: "Maximum matches to return (default 100)." },
    },
    required: ["pattern"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const pattern = String(args["pattern"] ?? "");
    if (!pattern.trim()) return fail("pattern is required");
    // `??` cannot help here: Number(undefined) is NaN, not nullish, so the default
    // never applied and an omitted `context` produced NaN context lines.
    const rawContext = Number(args["context"]);
    const contextLines = Math.min(10, Math.max(0, Number.isFinite(rawContext) ? Math.floor(rawContext) : 2));
    const limit = Math.min(500, Math.max(1, Number(args["limit"]) || 100));

    let re: RegExp;
    // The whole-file pre-test must read ^ and $ at line boundaries, as the per-line test does: without the
    // m flag a /^export/ skipped every file whose FIRST line was not an export and answered "No matches".
    let fileRe: RegExp;
    try {
      re = new RegExp(pattern, args["ignore_case"] === true ? "i" : "");
      fileRe = new RegExp(pattern, args["ignore_case"] === true ? "im" : "m");
    }
    catch (err) { return fail(`Invalid regular expression: ${err instanceof Error ? err.message : String(err)}`); }

    // The DEFAULT root goes through the resolver too. Taking ctx.workspacePath raw skipped the
    // zoning that the explicit-path branch below applies: a scope-confined agent calling this
    // with no `path` listed and read the platform's own config zones, which is exactly what the
    // scoping exists to prevent — and, now that the artifact zone is per-user, one account's
    // files from another's. workspace-search.ts resolves "." for the same reason.
    let root = resolvePathWithinWorkspace(".", ctx.workspacePath).resolved;
    const sub = typeof args["path"] === "string" ? args["path"].trim() : "";
    // A path naming one FILE searches that file. The walk below only descends directories, so a file
    // path searched nothing and answered "No matches" — which the caller believes: run c297c5ea's
    // content_writer grepped its own deck nearly 300 times for lines that were there.
    let namedFile = false;
    if (sub) {
      try { root = resolvePathWithinWorkspace(sub, ctx.workspacePath).resolved; }
      catch { return fail("path must be a relative path within the workspace"); }
      if (!existsSync(root)) return fail(`Path not found: ${sub}`);
      try { namedFile = statSync(root).isFile(); } catch (err) { return fail(`Could not read ${sub}: ${errorCode(err)} — nothing was searched.`); }
      // The walk refuses secrets entry by entry, but relative to its root: a root that is itself a link
      // into .starlingai/ or .git/ reads as innocent paths. So the root — file or directory — gets
      // read_file's guard, which checks the realpath.
      if (!guardPath(sub, ctx.workspacePath).safe) return fail(`Access denied: ${sub}`);
      if (namedFile && BINARY_EXTENSIONS.has(extname(root).toLowerCase())) return fail(`${sub} is a binary file; grep_files searches text.`);
    }
    if (!existsSync(root)) return fail("No files to search yet — nothing has been written to your working zone.");

    const globStr = typeof args["glob"] === "string" && !namedFile ? args["glob"].trim() : "";
    let globRe: RegExp | null = null;
    if (globStr) {
      try { globRe = globToRegExp(globStr); } catch { return fail(`Invalid glob: ${globStr}`); }
    }

    const blocks: string[] = [];
    let matchCount = 0;
    let filesWithMatches = 0;
    /** Files passed over for their size: named in the answer, so "No matches" never means "not looked at". */
    const tooLarge: Array<{ path: string; bytes: number }> = [];
    /** Files passed over for any other reason (unreadable, binary content), named likewise. */
    const skippedFiles: Array<{ path: string; reason: string }> = [];
    const prefix = sub ? relative(ctx.workspacePath, root).split(sep).join("/") : "";
    // One file asked for by name is opened up to read_file's limit; a directory search keeps its lower one.
    const maxBytes = namedFile ? MAX_TEXT_FILE_BYTES : MAX_GREP_FILE_BYTES;

    const searchFile = (full: string, abs: string): void => {
      // Skip obvious binaries cheaply — extension first, size second.
      if (BINARY_EXTENSIONS.has(extname(abs).toLowerCase())) return;
      let stat;
      try { stat = statSync(abs); } catch (err) { skippedFiles.push({ path: full, reason: `unreadable: ${errorCode(err)}` }); return; }
      if (stat.size > maxBytes) { tooLarge.push({ path: full, bytes: stat.size }); return; }

      let bytes: Buffer;
      try { bytes = readFileSync(abs); } catch (err) { skippedFiles.push({ path: full, reason: `unreadable: ${errorCode(err)}` }); return; }
      const decoded = decodeSearchText(bytes);
      if ("reason" in decoded) { skippedFiles.push({ path: full, reason: decoded.reason }); return; }
      const text = decoded.text;
      if (!fileRe.test(text)) return;

      const lines = text.split("\n");
      let fileHits = 0;
      for (let i = 0; i < lines.length && matchCount < limit; i++) {
        const at = lines[i]!.search(re);
        if (at < 0) continue;
        const from = Math.max(0, i - contextLines);
        const to = Math.min(lines.length - 1, i + contextLines);
        const body = [];
        for (let j = from; j <= to; j++) {
          body.push(`${j === i ? ">" : " "} ${j + 1}\t${clipLine(lines[j]!, j === i ? at : 0, MAX_GREP_LINE_CHARS)}`);
        }
        blocks.push(`${full}:${i + 1}\n${body.join("\n")}`);
        matchCount++;
        fileHits++;
      }
      if (fileHits > 0) filesWithMatches++;
    };

    let report = newWalkReport();
    if (namedFile) {
      searchFile(prefix, root);
      // The one file asked for was not read: that is a failure to search, not an absence of matches.
      const notRead = skippedFiles[0]?.reason
        ?? (tooLarge[0] ? `larger than ${maxBytes} bytes (${tooLarge[0].bytes} bytes)` : undefined);
      if (notRead) return fail(`Not searched: ${sub} — ${notRead}. Nothing in this answer says whether it contains /${pattern}/.`);
    } else {
      report = walk(root, ctx.workspacePath, (rel, abs) => {
        if (matchCount >= limit) return false;
        const full = prefix ? `${prefix}/${rel}` : rel;
        if (globRe && !globRe.test(full)) return;
        searchFile(full, abs);
      }, report, globStr ? skipDirsNamedBy(globStr) : new Set());
      if (report.unreadable.some((dir) => dir.startsWith(". ("))) {
        return fail(`Could not read ${sub || "the workspace"}: ${report.unreadable[0]!.slice(3, -1)} — nothing was searched.`);
      }
    }

    const notes: string[] = [];
    if (matchCount >= limit) {
      notes.push(`Showing ${matchCount} of ≥${matchCount} matches — the search stopped at the limit, so nothing after the last match shown was searched. `
        + (limit < 500 ? "Raise limit (max 500) or narrow path/glob to see the rest." : "Narrow path or glob to see the rest."));
    }
    if (tooLarge.length > 0) {
      notes.push(`Not searched, larger than ${maxBytes} bytes: `
        + tooLarge.slice(0, 10).map((file) => `${file.path} (${file.bytes} bytes)`).join(", ")
        + (tooLarge.length > 10 ? ` and ${tooLarge.length - 10} more` : "")
        + ". Pass one of them as path to search it on its own.");
    }
    // Binary content found by its NUL bytes is counted, not listed: a font or a database in a
    // directory search is expected, and naming each one on every grep is noise. A file that
    // could not be READ is a real gap and stays named.
    const binaryCount = skippedFiles.filter((file) => file.reason === BINARY_CONTENT).length;
    const byReason = new Map<string, string[]>();
    for (const file of skippedFiles) {
      if (file.reason !== BINARY_CONTENT) byReason.set(file.reason, [...(byReason.get(file.reason) ?? []), file.path]);
    }
    for (const [reason, paths] of byReason) {
      notes.push(`Not searched, ${reason}: ${paths.slice(0, 10).join(", ")}${paths.length > 10 ? ` and ${paths.length - 10} more` : ""}.`);
    }
    if (binaryCount > 0) notes.push(`${binaryCount} file(s) with binary content (NUL bytes) were not searched.`);
    const skippedShown = report.skipped
      .map((rel) => (prefix ? `${prefix}/${rel}` : rel))
      .filter((dir) => !globStr || globCouldReachInside(globStr, dir));
    notes.push(...walkReportNotes(report, skippedShown, "glob", blocks.length === 0));
    return {
      success: true,
      output: (blocks.length === 0
        ? `No matches for /${pattern}/${globStr ? ` in ${globStr}` : ""}.`
        : blocks.join("\n\n")) + (notes.length > 0 ? `\n\n${notes.join("\n")}` : ""),
      metadata: {
        pattern,
        matches: matchCount,
        files: filesWithMatches,
        truncated: matchCount >= limit,
        ...(tooLarge.length > 0 ? { notSearchedTooLarge: tooLarge.length } : {}),
        ...(skippedFiles.length > 0 ? { notSearchedOther: skippedFiles.length } : {}),
        ...(report.stoppedAfter !== undefined ? { walkStoppedAfter: report.stoppedAfter } : {}),
        ...(report.unreadable.length > 0 ? { unreadableDirs: report.unreadable.length } : {}),
        ...(skippedShown.length > 0 ? { notDescended: skippedShown } : {}),
        ...(globStr ? { glob: globStr } : {}),
      },
    };
  },
});

log.debug("code navigation tools registered");
