import { readFileSync, writeFileSync, appendFileSync, readdirSync, statSync, mkdirSync, existsSync, unlinkSync, realpathSync } from "node:fs";
import { basename, resolve, extname, join, relative, isAbsolute } from "node:path";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { childLogger } from "../logger.js";
import { logAudit } from "../audit/logger.js";
import { getConfig } from "../config/loader.js";
import { generatedZoneDir, resolvePathWithinWorkspace, resolveWorkspaceWritePath } from "./workspace-path.js";
import { UNFINISHED_STUB_MARKER } from "../agent/sub-agent-prompt-guidance.js";

const log = childLogger("tool:filesystem");
const MAX_FILE_SIZE = 1024 * 1024; // 1MB read limit
/**
 * Bound on an UNWINDOWED read — `read_file(path)` with neither offset nor limit.
 *
 * The only cap a read result used to meet was MAX_TOOL_RESULT_CHARS (32_768, applied in
 * agent/sub-agent.ts), so anything under 32 KB entered the conversation whole and — the
 * history being re-sent every iteration — was re-prefilled on every subsequent one. Run
 * 3959f3ac paid that: a single 25_929-char read (≈8_643 tokens at 3.0 chars/token) slid
 * under the cap and then rode along for ~10 more iterations, ≈28% of the final prompt.
 *
 * 16 KB (≈5_400 tokens) returns the overwhelming majority of source, config and doc
 * files whole — this is not a behaviour change for the common read — while capping the
 * pathological one at roughly one third of what it used to cost per iteration. Above it
 * the caller gets head+tail, not head alone: the reason an agent re-reads a file it just
 * built is usually to confirm the END of it still closes.
 */
const MAX_UNWINDOWED_READ_CHARS = 16_000;
const UNWINDOWED_HEAD_CHARS = 12_000;
const UNWINDOWED_TAIL_CHARS = 4_000;
// Text-based formats agents can read and write directly.
const ALLOWED_EXTENSIONS = new Set([
  ".txt", ".md", ".json", ".jsonc", ".jsonl", ".yaml", ".yml", ".toml", ".env.example",
  ".mmd",
  ".ts", ".tsx", ".js", ".mjs", ".jsx", ".py", ".sh", ".bash",
  ".html", ".htm", ".css", ".sql", ".xml", ".csv", ".log",
  ".svg",  // SVG is text-based
]);
// MIME types for content-type inference and preview-mode selection.
// Binary formats (docx, xlsx, pptx, pdf, images, audio…) are download-only
// unless a viewer is built in. Agents can't write binary directly but an
// external tool (pandoc, python-docx, etc.) might produce them in the workspace.
const MIME_TYPES: Record<string, string> = {
  // Web
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  // Text / code
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".mmd": "text/vnd.mermaid; charset=utf-8",
  // Data
  ".json": "application/json; charset=utf-8",
  ".jsonc": "application/json; charset=utf-8",
  ".jsonl": "application/json; charset=utf-8",
  ".yaml": "application/yaml; charset=utf-8",
  ".yml": "application/yaml; charset=utf-8",
  // Documents (download-only)
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".rtf": "application/rtf",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".ppt": "application/vnd.ms-powerpoint",
  ".odp": "application/vnd.oasis.opendocument.presentation",
  // Images
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  // Audio
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".webm": "audio/webm",
  ".flac": "audio/flac",
  // Video
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  // Archives
  ".zip": "application/zip",
};

// Secrets + VCS internals that live INSIDE the workspace (the repo is bind-mounted
// as the workspace so the swarm can self-improve) but must never be read back by a
// file tool — prompt injection could otherwise coax read_file/search into
// exfiltrating them. The gateway process already holds the .env values it needs via
// env_file, and git operations use git COMMANDS, not raw object reads, so nothing
// legitimate is lost. `.env.example` is the shipped public template — allowed.
const SENSITIVE_READ_PATTERNS: RegExp[] = [
  /^\.env(\..+)?$/,             // .env, .env.local, .env.production, …
  /(^|\/)\.starlingai(\/|$)/,   // credential store, jwt secret, audit log, durable memory
  /(^|\/)\.git(\/|$)/,          // VCS internals (objects, refs, hooks, config)
  /(^|\/)credentials\.enc$/,
  /(^|\/)\.jwt_secret$/,
];

/** True when a workspace-relative path points at a secret / VCS-internal file.
 *  Matched case-INSENSITIVELY: the repo is bind-mounted from Windows/macOS hosts whose
 *  Docker Desktop mounts are case-insensitive, so `.ENV` resolves to the real `.env` —
 *  a case-sensitive denylist would wave it straight through. */
export function isSensitiveWorkspacePath(relativePath: string): boolean {
  const rel = relativePath.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  if (rel === ".env.example") return false; // public template
  return SENSITIVE_READ_PATTERNS.some((re) => re.test(rel));
}

function guardPath(path: string, workspacePath: string): { safe: boolean; resolved: string } {
  try {
    const { resolved } = resolvePathWithinWorkspace(path, workspacePath);
    // Refuse secrets / VCS internals — on the lexical path AND, when the target exists,
    // its realpath, so a planted symlink (e.g. generated/notes.txt -> ../.env) can't
    // alias a denied file or escape the workspace under an innocent name.
    if (isSensitiveWorkspacePath(relative(workspacePath, resolved))) {
      return { safe: false, resolved };
    }
    let real: string | null = null;
    try { real = realpathSync(resolved); } catch { /* not created yet — the lexical check stands */ }
    if (real !== null) {
      const realRel = relative(workspacePath, real);
      if (realRel.startsWith("..") || isAbsolute(realRel) || isSensitiveWorkspacePath(realRel)) {
        return { safe: false, resolved };
      }
    }
    return { safe: true, resolved };
  } catch {
    return { safe: false, resolved: resolve(workspacePath, path.replace(/^\//, "")) };
  }
}

/**
 * Guard for MUTATING file ops (write/edit/create/delete): roots the target
 * under the workspace's `generated/` subfolder so agent output never clutters
 * the config zone. Reads keep guardPath (workspace-wide). Returns the
 * workspace-rooted relativePath (e.g. "generated/index.html") for artifacts.
 */
function guardWritePath(path: string, workspacePath: string): { safe: boolean; resolved: string; relativePath: string } {
  try {
    const { resolved, relativePath } = resolveWorkspaceWritePath(path, workspacePath);
    return { safe: true, resolved, relativePath };
  } catch {
    return { safe: false, resolved: resolve(workspacePath, path.replace(/^\//, "")), relativePath: path };
  }
}

/** `budget` chars off one end of `content`, snapped to a line boundary when one falls
 *  inside the slice. A minified bundle or a single-line JSON has no boundary to snap to,
 *  so the raw slice stands rather than returning nothing. */
function sliceAtLineBoundary(content: string, budget: number, end: "head" | "tail"): string {
  if (end === "head") {
    const raw = content.slice(0, budget);
    const cut = raw.lastIndexOf("\n");
    return cut > 0 ? raw.slice(0, cut) : raw;
  }
  const raw = content.slice(content.length - budget);
  const cut = raw.indexOf("\n");
  return cut >= 0 && cut < raw.length - 1 ? raw.slice(cut + 1) : raw;
}

function countLines(text: string): number {
  return text.split("\n").length;
}

registerTool({
  name: "read_file",
  description: "Read the contents of a file within the workspace directory. A file over ~16 KB comes back as head+tail — pass offset/limit to read any other window of it.",
  embeddingDescription: "Open, view, inspect, or load a file. Read source code, markdown, JSON, YAML, CSV, text. Datei lesen, öffnen, einsehen, anzeigen, laden. Inhalt einer Datei abrufen.",
  costHint: "low",
  latencyHint: "low",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative path within workspace" },
      offset: { type: "number", description: "1-indexed line to start from. Use with limit to read a WINDOW of a large file instead of all of it." },
      limit: { type: "number", description: "Maximum number of lines to return, counted from offset." },
    },
    required: ["path"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const path = String(args["path"] ?? "");
    const offset = Number.isFinite(Number(args["offset"])) ? Math.max(1, Math.floor(Number(args["offset"]))) : undefined;
    const limit = Number.isFinite(Number(args["limit"])) ? Math.max(1, Math.floor(Number(args["limit"]))) : undefined;
    const { safe, resolved } = guardPath(path, ctx.workspacePath);

    if (!safe) {
      return { success: false, output: "", error: "Path escapes workspace boundary" };
    }
    if (!existsSync(resolved)) {
      return { success: false, output: "", error: `File not found: ${path}` };
    }

    const stat = statSync(resolved);
    if (stat.isDirectory()) {
      return { success: false, output: "", error: "Path is a directory, use list_files instead" };
    }
    if (stat.size > MAX_FILE_SIZE) {
      return { success: false, output: "", error: `File too large (${stat.size} bytes > ${MAX_FILE_SIZE} limit)` };
    }

    const ext = extname(resolved).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext) && ext !== "") {
      return { success: false, output: "", error: `File type ${ext} is not allowed for reading` };
    }

    try {
      const content = readFileSync(resolved, "utf-8");
      // Windowed read. Without it the only way to see part of a large file was to
      // pull the whole thing into context and let the model find its way — the
      // single biggest source of wasted prompt on a big source tree.
      if (offset !== undefined || limit !== undefined) {
        const lines = content.split("\n");
        const start = (offset ?? 1) - 1;
        const end = limit !== undefined ? start + limit : lines.length;
        const window = lines.slice(start, end);
        const shown = window.map((l, i) => `${start + i + 1}\t${l}`).join("\n");
        return {
          success: true,
          output: shown,
          metadata: {
            path, size: stat.size, ext,
            totalLines: lines.length,
            firstLine: start + 1,
            lastLine: Math.min(end, lines.length),
            truncated: end < lines.length || start > 0,
          },
        };
      }
      const totalLines = content.split("\n").length;
      // Unwindowed read of a large file: the caller did not ask for a window, but the
      // whole file would be re-prefilled on every later iteration of that agent's turn.
      // Hand back head+tail and say exactly how to get the middle.
      if (content.length > MAX_UNWINDOWED_READ_CHARS) {
        const head = sliceAtLineBoundary(content, UNWINDOWED_HEAD_CHARS, "head");
        const tail = sliceAtLineBoundary(content, UNWINDOWED_TAIL_CHARS, "tail");
        const firstTailLine = totalLines - countLines(tail) + 1;
        const lastHeadLine = countLines(head);
        return {
          success: true,
          output: `${head}\n\n[read_file returned a window: ${content.length} chars total, `
            + `showing lines 1-${lastHeadLine} and ${firstTailLine}-${totalLines}. `
            + `Call read_file again with offset/limit to see the elided middle.]\n\n${tail}`,
          metadata: {
            path, size: stat.size, ext, totalLines,
            firstLine: 1,
            lastLine: totalLines,
            truncated: true,
            returnedChars: head.length + tail.length,
          },
        };
      }
      return {
        success: true,
        output: content,
        metadata: { path, size: stat.size, ext, totalLines },
      };
    } catch (err) {
      log.error({ err, path }, "read_file failed");
      return { success: false, output: "", error: `Read failed: ${String(err)}` };
    }
  },
});

registerTool({
  name: "list_files",
  description: "List files and directories within a path in the workspace.",
  embeddingDescription: "List, browse, enumerate, or show files and folders in a directory. Dateien und Ordner auflisten, durchsuchen, anzeigen. Verzeichnisinhalt anzeigen. Directory listing.",
  costHint: "low",
  latencyHint: "low",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative path within workspace (default: root)", default: "." },
      recursive: { type: "boolean", description: "List recursively (max 3 levels)", default: false },
    },
    required: [],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const path = String(args["path"] ?? ".");
    const recursive = Boolean(args["recursive"] ?? false);
    const { safe, resolved } = guardPath(path, ctx.workspacePath);

    if (!safe) {
      return { success: false, output: "", error: "Path escapes workspace boundary" };
    }
    if (!existsSync(resolved)) {
      // A scope-confined agent listing its still-empty working zone (generated/
      // only exists after the first write): report an empty zone, not an error.
      if (resolved === generatedZoneDir(ctx.workspacePath)) {
        return { success: true, output: "(empty — no files generated yet; create files with write_file)", metadata: { path, count: 0 } };
      }
      return { success: false, output: "", error: `Path not found: ${path}` };
    }

    const entries = listDir(resolved, recursive ? 3 : 0);
    // An empty-string output reads as "something went wrong" to the model — it
    // retries the same listing over and over (audit a438ef4a: 5 identical
    // list_files calls on an empty working zone). Say "empty" explicitly.
    return {
      success: true,
      output: entries.length > 0 ? entries.join("\n") : "(empty directory — no files yet; create files with write_file)",
      metadata: { path, count: entries.length },
    };
  },
});

registerTool({
  name: "export_workspace_artifact",
  description:
    "Expose an existing workspace file or folder as a downloadable chat artifact. " +
    "Use this when the file already exists and should be previewed or downloaded by the user.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative workspace path to an existing file or folder" },
      title: { type: "string", description: "Optional display title for the artifact card" },
    },
    required: ["path"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const path = String(args["path"] ?? "").trim();
    const title = typeof args["title"] === "string" && args["title"].trim()
      ? args["title"].trim()
      : undefined;

    if (!path) {
      return { success: false, output: "", error: "path is required" };
    }

    let resolvedPath: { resolved: string; relativePath: string };
    try {
      resolvedPath = resolvePathWithinWorkspace(path, ctx.workspacePath);
    } catch {
      return { success: false, output: "", error: "Path escapes workspace boundary" };
    }

    if (!existsSync(resolvedPath.resolved)) {
      return { success: false, output: "", error: `Path not found: ${path}` };
    }

    try {
      const fileStat = statSync(resolvedPath.resolved);
      const isDirectory = fileStat.isDirectory();
      const filename = artifactFilename(resolvedPath.relativePath, ctx.workspacePath);
      const contentType = isDirectory
        ? "application/x-directory"
        : inferArtifactContentType(resolvedPath.relativePath);
      // Directories that contain an index.html are previewable as a website.
      const hasIndexHtml = isDirectory && existsSync(join(resolvedPath.resolved, "index.html"));
      const previewMode = isDirectory
        ? (hasIndexHtml ? "website" : "download")
        : inferArtifactPreviewMode(contentType);

      return {
        success: true,
        output: isDirectory
          ? `Workspace folder ready for download: ${resolvedPath.relativePath}`
          : `Workspace file ready for download: ${resolvedPath.relativePath}`,
        metadata: {
          artifactKind: isDirectory ? "workspace_directory" : "workspace_file",
          outputPath: resolvedPath.relativePath,
          filename,
          title,
          contentType,
          previewMode,
          isDirectory,
          size: fileStat.isFile() ? fileStat.size : undefined,
          entryCount: isDirectory ? safeEntryCount(resolvedPath.resolved) : undefined,
        },
      };
    } catch (err) {
      log.error({ err, path }, "export_workspace_artifact failed");
      return { success: false, output: "", error: `Export failed: ${String(err)}` };
    }
  },
});

/**
 * Structural sniff for a sensible default file path when a write_file call carries
 * substantial content but no "path" (exported for tests). Language-independent —
 * keyed off the content's own syntax, never off request wording.
 */
export function defaultWritePathForContent(content: string): string {
  const t = content.trimStart();
  if (/^(?:<!DOCTYPE\s+html|<html[\s>])/i.test(t)) return "index.html";
  if (/^<svg[\s>]/i.test(t)) return "image.svg";
  if (/^<\?xml/i.test(t)) return "document.xml";
  if (/^[{[]/.test(t)) {
    try {
      JSON.parse(content);
      return "data.json";
    } catch { /* not valid JSON — fall through */ }
  }
  if (/^#{1,6}\s/.test(t)) return "document.md";
  return "output.txt";
}

/** Length of the shared leading run of two strings, sampled over the first 2 KB — a cheap,
 *  content-agnostic "is this a regeneration of the same document?" signal for the write-churn
 *  nudge. A file rebuilt from the top reproduces its opening identically; a genuinely different
 *  replacement diverges early. */
export function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length, 2048);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

/**
 * Would this overwrite REPLACE FINISHED WORK WITH PLACEHOLDERS?
 *
 * Run 2dc5832c is why this exists. web_coder spent 13 iterations filling six of eight
 * UNFINISHED_STUB subsystems with real code via edit_file; the orchestrator then
 * re-delegated, and the next run answered with ONE write_file carrying a fresh 4,037-byte
 * skeleton holding all eight markers again. Every filled subsystem was destroyed in a
 * single call, and the file that reached the user threw on its first line.
 *
 * The rule is the narrowest one that catches it: an overwrite may not RAISE the number of
 * unfilled markers in a file THAT IS STILL BEING BUILT. Fewer is progress, equal is a harmless
 * re-skeleton of a skeleton, more is work being thrown away. It reads one literal — the same
 * token the staged-build directive tells the model to write and artifactFileLooksTruncated
 * greps back off disk — so the prompt half and the mechanical half still agree on one string.
 *
 * A FINISHED FILE (zero markers) IS A DIFFERENT CASE and is deliberately NOT blocked. The
 * staged-build directive, now default-on, orders a skeleton as the FIRST tool call of any
 * large build — so "rebuild this from scratch, differently" over a completed artifact hit this
 * guard and was refused, with a message telling the model to edit marker lines that do not
 * exist in that file, on a run holding no delete tool. Nothing was being interrupted there:
 * the file was done, and replacing a done file is what a rebuild IS. It is reported instead of
 * refused, so the deliberate rebuild proceeds and an accidental one is still visible.
 *
 * Unlike the churn nudge above this BLOCKS, because here refusing the write is what
 * preserves the work rather than what risks it. edit_file remains available and is the
 * correct tool for the job the model was attempting.
 */
export function evaluateStubRegression(
  existing: string,
  content: string,
): { regressed: boolean; replacesFinished: boolean; existingStubs: number; newStubs: number } {
  const count = (text: string): number => text.split(UNFINISHED_STUB_MARKER).length - 1;
  const existingStubs = count(existing);
  const newStubs = count(content);
  return {
    regressed: existingStubs > 0 && newStubs > existingStubs,
    replacesFinished: existingStubs === 0 && newStubs > 0,
    existingStubs,
    newStubs,
  };
}

/** Pure write-churn decision for the regeneration nudge (orchestration.detectWriteChurnOverwrite).
 *  A file rebuilt from the top after a completion-limit cut-off reproduces its opening identically,
 *  so a substantial (≥500-byte) file whose OVERWRITE shares ≥90% of the first 2 KB is a regeneration,
 *  not a genuine replacement. Mutates tracker.count (the caller persists it per turn+path, only for
 *  regeneration-shaped overwrites) and churns on the 2nd such overwrite. Structural only — file size +
 *  shared-prefix ratio + count; no content/topic inspection. */
export function evaluateWriteChurn(
  existing: string,
  content: string,
  tracker: { count: number },
): { churned: boolean; prefixPct: number } {
  const sampleLen = Math.min(existing.length, content.length, 2048);
  if (existing.length < 500 || sampleLen === 0) return { churned: false, prefixPct: 0 };
  const prefixPct = (100 * commonPrefixLength(existing, content)) / sampleLen;
  if (prefixPct < 90) return { churned: false, prefixPct };
  tracker.count += 1;
  return { churned: tracker.count >= 2, prefixPct };
}

registerTool({
  name: "write_file",
  description: "Write content to a file within the workspace. For a normal-sized deliverable, pass the full content in one call (mode defaults to 'overwrite'). For a VERY LARGE single file (e.g. a 30 KB+ HTML page or reveal.js deck, a long report, a multi-thousand-line script) that the model cannot reliably emit in one completion, build it INCREMENTALLY: write the first chunk, then call write_file again with mode:'append' for each subsequent chunk until the file is complete — each chunk is appended verbatim with no overlap. This keeps every call bounded and avoids the single-giant-completion timeout on slow backends. Creates the file and parent directories if needed. mode:'overwrite' (default) replaces an existing file; mode:'append' adds to it (creating it if missing); mode:'create' fails if the file already exists.",
  embeddingDescription: "Write, save, create, append, or persist a file with given content. Datei schreiben, speichern, erstellen, anhängen, sichern. Write code, documents, reports, generated output. Build large files incrementally by appending chunks. Große Dateien stückweise per Append aufbauen.",
  costHint: "low",
  latencyHint: "low",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative path within workspace" },
      content: { type: "string", description: "File content to write (for mode:'append', the chunk to append verbatim)" },
      mode: {
        type: "string",
        enum: ["overwrite", "append", "create"],
        description: "'overwrite' (default) replaces/creates the file; 'append' adds to the end (creating it if missing) — use this to build a large file in bounded chunks; 'create' fails if the file already exists.",
      },
      createDirs: { type: "boolean", description: "Create parent directories if needed", default: true },
    },
    required: ["path", "content"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    let path = String(args["path"] ?? "");
    const content = String(args["content"] ?? "");
    const createDirs = Boolean(args["createDirs"] ?? true);
    const rawMode = String(args["mode"] ?? "overwrite").toLowerCase();
    const mode: "overwrite" | "append" | "create" =
      rawMode === "append" || rawMode === "create" ? rawMode : "overwrite";

    // Reject malformed calls instead of silently producing junk (audit ca36debc: the slow
    // 35B blew its completion budget emitting a 12 KB doc inline, the tool call was truncated
    // with finishReason:"length", and write_file got an empty path + empty content — it then
    // wrote a 0-byte file named "generated" and surfaced it to the user as a download. An
    // empty write is never a real deliverable; fail with the same clear signal generate_document
    // gives ("content is required") so no 0-byte artifact is created and the model can recover.
    //
    // BUT when the call carries substantial content and only the path is missing (audit
    // 0ac7d3fc: the model spent ~2 minutes generating a complete app, then emitted args with
    // content but no path), failing throws away the expensive part to protect the cheap part.
    // Default the path from the content's structure instead and say so in the output. Append
    // mode is excluded — there is no way to know which existing file the chunk belongs to.
    let defaultedPathNote = "";
    if (!path.trim() && mode !== "append" && content.trim().length >= 200) {
      path = defaultWritePathForContent(content);
      defaultedPathNote = ` (note: your call omitted "path" — it was defaulted to "${path}" from the content. Use this exact path in any follow-up write_file mode:"append" or edit_file calls.)`;
      logAudit("guardrail_flagged", {
        type: "write_file_missing_path_defaulted",
        defaultedPath: path,
        contentChars: content.length,
      }, { sessionId: ctx.sessionId, severity: "warn" });
    }
    if (!path.trim()) {
      return { success: false, output: "", error: "path is required — provide the relative file path to write (e.g. \"report.md\")." };
    }
    if (!content.trim()) {
      return { success: false, output: "", error: "content is required — write_file needs the file content (or, for mode:\"append\", the chunk to append). Refusing to write a 0-byte file. If the content is large, build it in bounded chunks with mode:\"append\"." };
    }

    const { safe, resolved, relativePath } = guardWritePath(path, ctx.workspacePath);

    if (!safe) {
      return { success: false, output: "", error: "Path escapes workspace boundary" };
    }

    const ext = extname(resolved).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext) && ext !== "") {
      return { success: false, output: "", error: `File type ${ext} is not allowed for writing` };
    }

    const fileExists = existsSync(resolved);
    if (mode === "create" && fileExists) {
      return { success: false, output: "", error: `File already exists: ${relativePath} (use mode:"append" to add to it, or mode:"overwrite" to replace it)` };
    }

    // write_file regeneration nudge (orchestration.detectWriteChurnOverwrite, default off): a builder that
    // re-emits a file from the top after a completion-limit cut-off — instead of appending the remainder —
    // shows up as repeated near-identical OVERWRITES of the same path (run 663ac153: a ~21-item block
    // re-emitted 3×). Detect it structurally (per-turn overwrite count + ≥90% shared prefix over the first
    // 2 KB; no content/topic heuristics) and attach a SOFT append nudge. Computed BEFORE the write (the old
    // content is about to be replaced); a full replacement with different content diverges early and is
    // never flagged. Never blocks the write — work is preserved.
    // BLOCK an overwrite that would replace finished work with placeholders (run 2dc5832c:
    // six filled subsystems destroyed by one skeleton write). Checked before the write, and
    // before the churn nudge, because a stub regression is never a nudge-and-continue case —
    // the whole point is that the bytes on disk are worth more than the bytes in the call.
    if (mode === "overwrite" && fileExists) {
      try {
        const previous = readFileSync(resolved, "utf-8");
        const regression = evaluateStubRegression(previous, content);
        if (regression.replacesFinished) {
          // Allowed, but never silent: this is the shape of a deliberate rebuild AND the shape
          // of a clobber that arrives one iteration too late to be distinguished from one.
          logAudit("guardrail_flagged", {
            type: "write_file_skeleton_over_finished_file",
            path: relativePath,
            newStubs: regression.newStubs,
            existingChars: previous.length,
            newChars: content.length,
          }, { sessionId: ctx.sessionId, severity: "info" });
        }
        if (regression.regressed) {
          logAudit("guardrail_flagged", {
            type: "write_file_stub_regression_blocked",
            path: relativePath,
            existingStubs: regression.existingStubs,
            newStubs: regression.newStubs,
            existingChars: previous.length,
            newChars: content.length,
          }, { sessionId: ctx.sessionId, severity: "warn" });
          return {
            success: false,
            output: "",
            error: `Refusing to overwrite '${relativePath}': the file on disk has ${regression.existingStubs} `
              + `unfinished ${UNFINISHED_STUB_MARKER} marker(s) and your replacement has ${regression.newStubs}. `
              + `That would DESTROY work already on disk and hand back a less complete file. Do not re-emit this `
              + `file from the top. Read it, then replace ONE ${UNFINISHED_STUB_MARKER} line at a time with `
              + `edit_file, using that line as old_string.`,
          };
        }
      } catch { /* read failure — fall through; never block a write on an unreadable file */ }
    }

    let churnNudge = "";
    if (mode === "overwrite" && fileExists && getConfig().orchestration?.detectWriteChurnOverwrite === true) {
      try {
        const existing = readFileSync(resolved, "utf-8");
        if (!ctx._turnWriteChurnTracker) ctx._turnWriteChurnTracker = new Map();
        const tracker = ctx._turnWriteChurnTracker.get(relativePath) ?? { count: 0 };
        const churn = evaluateWriteChurn(existing, content, tracker);
        ctx._turnWriteChurnTracker.set(relativePath, tracker);
        if (churn.churned) {
          churnNudge = `\n\nNOTE: '${relativePath}' has now been overwritten ${tracker.count}× this turn with near-identical`
            + ` content (~${Math.round(churn.prefixPct)}% shared prefix). If you are rebuilding a file that was cut off`
            + ` mid-write, append only the missing remainder with mode:"append" (or use edit_file for a targeted change)`
            + ` instead of re-emitting the whole file from the top — regenerating risks the same cut-off and wastes tokens.`;
          logAudit("guardrail_flagged", {
            type: "write_file_churn_detected",
            path: relativePath,
            overwriteCount: tracker.count,
            prefixMatchPct: Math.round(churn.prefixPct),
          }, { sessionId: ctx.sessionId, severity: "warn" });
        }
      } catch { /* read failure — skip the nudge, never block the write */ }
    }

    try {
      if (createDirs) {
        mkdirSync(resolve(resolved, ".."), { recursive: true });
      }
      const appended = mode === "append" && fileExists;
      if (appended) {
        appendFileSync(resolved, content, "utf-8");
      } else {
        writeFileSync(resolved, content, "utf-8");
      }
      // On append, preview/size reflect the full resulting file so the artifact
      // shows the whole deliverable as it is assembled — not just the last chunk.
      const fullContent = appended ? readFileSync(resolved, "utf-8") : content;
      const contentType = inferArtifactContentType(relativePath);
      const textPreview = buildArtifactTextPreview(fullContent);
      const verb = appended ? "appended to" : "written";
      return {
        success: true,
        output: (appended
          ? `Appended ${content.length} chars to ${relativePath} (now ${fullContent.length} chars total)`
          : `File ${verb}: ${relativePath} (${content.length} chars)`) + defaultedPathNote + churnNudge,
        metadata: {
          artifactKind: "workspace_file",
          path,
          outputPath: relativePath,
          filename: artifactFilename(relativePath, ctx.workspacePath),
          contentType,
          previewMode: inferArtifactPreviewMode(contentType),
          isDirectory: false,
          size: fullContent.length,
          writeMode: mode,
          ...(textPreview ? { textPreview } : {}),
        },
      };
    } catch (err) {
      log.error({ err, path }, "write_file failed");
      return { success: false, output: "", error: `Write failed: ${String(err)}` };
    }
  },
});

registerTool({
  name: "edit_file",
  description: "Apply an exact string replacement to a file within the workspace. Fails if old_string is not found, or if it appears more than once and replace_all is not set — include surrounding lines to make it unique.",
  embeddingDescription: "Edit, modify, update, patch, or change a specific section of a file. Datei bearbeiten, anpassen, ändern, patchen. Surgical string replacement for targeted edits.",
  costHint: "low",
  latencyHint: "low",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative path within workspace" },
      old_string: { type: "string", description: "Exact string to find and replace. Must match EXACTLY ONE place in the file unless replace_all is true — add surrounding context lines to disambiguate." },
      new_string: { type: "string", description: "Replacement string" },
      replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match. Default false.", default: false },
    },
    required: ["path", "old_string", "new_string"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const path = String(args["path"] ?? "");
    const oldStr = String(args["old_string"] ?? "");
    const newStr = String(args["new_string"] ?? "");
    const replaceAll = args["replace_all"] === true;
    const { safe, resolved } = guardWritePath(path, ctx.workspacePath);

    if (!safe) return { success: false, output: "", error: "Path escapes workspace boundary" };
    if (!oldStr) return { success: false, output: "", error: "old_string cannot be empty" };
    if (!existsSync(resolved)) return { success: false, output: "", error: `File not found: ${path}` };

    const stat = statSync(resolved);
    if (stat.size > MAX_FILE_SIZE) {
      return { success: false, output: "", error: `File too large (${stat.size} bytes > ${MAX_FILE_SIZE} limit)` };
    }

    const ext = extname(resolved).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext) && ext !== "") {
      return { success: false, output: "", error: `File type ${ext} is not allowed for editing` };
    }

    try {
      const content = readFileSync(resolved, "utf-8");
      if (!content.includes(oldStr)) {
        // "old_string not found in file" is true and useless: it tells the caller the edit
        // missed but not what to aim at instead. During a staged build the overwhelmingly
        // common cause is targeting a marker that an earlier iteration already filled — the
        // model lost track of its own progress — and recovering from the bare message costs
        // a grep_files round trip, which on a 14-iteration budget is real headroom spent on
        // rediscovering something the file already knows.
        //
        // So when the miss was aimed at a stub marker, answer the question the caller is
        // actually asking: which markers are still there. Naming them lets the next call
        // land instead of hunting.
        const missedAStub = oldStr.includes(UNFINISHED_STUB_MARKER);
        const remaining = missedAStub
          ? content.split("\n")
              .filter(line => line.includes(UNFINISHED_STUB_MARKER))
              .map(line => line.trim())
              .slice(0, 20)
          : [];
        const hint = !missedAStub ? ""
          : remaining.length > 0
            ? ` This file still holds ${remaining.length} unfilled marker(s) — target one of these exactly: ${remaining.join(" | ")}`
            : ` No ${UNFINISHED_STUB_MARKER} markers remain in this file; every subsystem is already filled.`;
        return { success: false, output: "", error: `old_string not found in file.${hint}` };
      }
      // Count first. `String.replace` with a string pattern rewrites only the FIRST
      // match, and this reported `replacements: 1` unconditionally — so an ambiguous
      // old_string silently edited whichever occurrence came first, which is very
      // often not the intended one, and the caller was told it succeeded.
      const occurrences = content.split(oldStr).length - 1;
      if (occurrences > 1 && !replaceAll) {
        return {
          success: false,
          output: "",
          error: `old_string matches ${occurrences} places in ${path}. Add surrounding lines so it identifies exactly one, or pass replace_all: true to change all ${occurrences}.`,
        };
      }
      const updated = replaceAll ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr);
      writeFileSync(resolved, updated, "utf-8");
      const replacements = replaceAll ? occurrences : 1;
      return {
        success: true,
        output: `File edited: ${path} (${replacements} replacement${replacements === 1 ? "" : "s"}).`,
        metadata: { path, replacements },
      };
    } catch (err) {
      log.error({ err, path }, "edit_file failed");
      return { success: false, output: "", error: `Edit failed: ${String(err)}` };
    }
  },
});

registerTool({
  name: "create_dir",
  description: "Create a directory (and any missing parent directories) within the workspace.",
  embeddingDescription: "Create, make, or add a folder or directory. Ordner anlegen, Verzeichnis erstellen, neues Verzeichnis. mkdir, new folder.",
  costHint: "low",
  latencyHint: "low",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative path within workspace" },
    },
    required: ["path"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const path = String(args["path"] ?? "");
    const { safe, resolved } = guardWritePath(path, ctx.workspacePath);

    if (!safe) return { success: false, output: "", error: "Path escapes workspace boundary" };
    if (!path.trim()) return { success: false, output: "", error: "path is required" };

    try {
      mkdirSync(resolved, { recursive: true });
      return {
        success: true,
        output: `Directory created: ${path}`,
        metadata: { path },
      };
    } catch (err) {
      log.error({ err, path }, "create_dir failed");
      return { success: false, output: "", error: `Create directory failed: ${String(err)}` };
    }
  },
});

registerTool({
  name: "delete_file",
  description: "Delete a file within the workspace. Requires per-call approval (Tier 1 — destructive).",
  embeddingDescription: "Delete, remove, or destroy a file permanently. Datei löschen, entfernen, vernichten. Remove file from workspace. Destructive operation with approval.",
  costHint: "low",
  latencyHint: "low",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative path within workspace" },
    },
    required: ["path"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const path = String(args["path"] ?? "");
    const { safe, resolved } = guardWritePath(path, ctx.workspacePath);

    if (!safe) return { success: false, output: "", error: "Path escapes workspace boundary" };
    if (!existsSync(resolved)) return { success: false, output: "", error: `File not found: ${path}` };

    const stat = statSync(resolved);
    if (stat.isDirectory()) {
      return { success: false, output: "", error: "Cannot delete directories with this tool — use shell_exec for recursive removal" };
    }

    try {
      unlinkSync(resolved);
      log.info({ path, sessionId: ctx.sessionId }, "delete_file: file deleted");
      return {
        success: true,
        output: `File deleted: ${path}`,
        metadata: { path },
      };
    } catch (err) {
      log.error({ err, path }, "delete_file failed");
      return { success: false, output: "", error: `Delete failed: ${String(err)}` };
    }
  },
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function listDir(dir: string, depth: number): string[] {
  const entries: string[] = [];
  try {
    for (const name of readdirSync(dir)) {
      const full = resolve(dir, name);
      const stat = statSync(full);
      const prefix = stat.isDirectory() ? "/" : "";
      entries.push(`${name}${prefix}`);
      if (depth > 0 && stat.isDirectory()) {
        const children = listDir(full, depth - 1).map(c => `  ${c}`);
        entries.push(...children);
      }
    }
  } catch { /* ignore permission errors */ }
  return entries;
}

function artifactFilename(relativePath: string, workspacePath: string): string {
  return relativePath === "." ? basename(workspacePath) : basename(relativePath);
}

function inferArtifactContentType(relativePath: string): string {
  return MIME_TYPES[extname(relativePath).toLowerCase()] ?? "application/octet-stream";
}

function inferArtifactPreviewMode(contentType: string): "image" | "html" | "pdf" | "text" | "json" | "audio" | "download" {
  if (contentType.startsWith("image/svg")) return "html"; // SVGs render in an iframe
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType.startsWith("video/")) return "download"; // no inline video viewer yet
  if (contentType.startsWith("text/html")) return "html";
  if (contentType.startsWith("application/pdf")) return "pdf";
  if (contentType.startsWith("application/json")) return "json";
  if (contentType.startsWith("text/") || contentType.includes("yaml") || contentType.includes("xml") || contentType.includes("mermaid")) return "text";
  // Office docs, archives and other binary formats → trigger browser download
  return "download";
}

function buildArtifactTextPreview(content: string): string | undefined {
  const compact = content.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return compact.length > 1_200 ? `${compact.slice(0, 1_197)}...` : compact;
}

function safeEntryCount(dir: string): number {
  try {
    return readdirSync(dir).length;
  } catch {
    return 0;
  }
}
