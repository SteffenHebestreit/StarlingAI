import { readFileSync, writeFileSync, appendFileSync, readdirSync, statSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { basename, resolve, extname, join } from "node:path";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { childLogger } from "../logger.js";
import { resolvePathWithinWorkspace, resolveWorkspaceWritePath } from "./workspace-path.js";

const log = childLogger("tool:filesystem");
const MAX_FILE_SIZE = 1024 * 1024; // 1MB read limit
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

function guardPath(path: string, workspacePath: string): { safe: boolean; resolved: string } {
  try {
    const { resolved } = resolvePathWithinWorkspace(path, workspacePath);
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

registerTool({
  name: "read_file",
  description: "Read the contents of a file within the workspace directory.",
  embeddingDescription: "Open, view, inspect, or load a file. Read source code, markdown, JSON, YAML, CSV, text. Datei lesen, öffnen, einsehen, anzeigen, laden. Inhalt einer Datei abrufen.",
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
      return {
        success: true,
        output: content,
        metadata: { path, size: stat.size, ext },
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
      return { success: false, output: "", error: `Path not found: ${path}` };
    }

    const entries = listDir(resolved, recursive ? 3 : 0);
    return {
      success: true,
      output: entries.join("\n"),
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
    const path = String(args["path"] ?? "");
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
        output: appended
          ? `Appended ${content.length} chars to ${relativePath} (now ${fullContent.length} chars total)`
          : `File ${verb}: ${relativePath} (${content.length} chars)`,
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
  description: "Apply an exact string replacement to a file within the workspace. Fails if old_string is not found.",
  embeddingDescription: "Edit, modify, update, patch, or change a specific section of a file. Datei bearbeiten, anpassen, ändern, patchen. Surgical string replacement for targeted edits.",
  costHint: "low",
  latencyHint: "low",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative path within workspace" },
      old_string: { type: "string", description: "Exact string to find and replace" },
      new_string: { type: "string", description: "Replacement string" },
    },
    required: ["path", "old_string", "new_string"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const path = String(args["path"] ?? "");
    const oldStr = String(args["old_string"] ?? "");
    const newStr = String(args["new_string"] ?? "");
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
        return { success: false, output: "", error: "old_string not found in file" };
      }
      const updated = content.replace(oldStr, newStr);
      writeFileSync(resolved, updated, "utf-8");
      return {
        success: true,
        output: `File edited: ${path}`,
        metadata: { path, replacements: 1 },
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
