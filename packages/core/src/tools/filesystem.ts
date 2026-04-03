import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { basename, resolve, extname } from "node:path";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { childLogger } from "../logger.js";
import { resolvePathWithinWorkspace } from "./workspace-path.js";

const log = childLogger("tool:filesystem");
const MAX_FILE_SIZE = 1024 * 1024; // 1MB read limit
const ALLOWED_EXTENSIONS = new Set([
  ".txt", ".md", ".json", ".jsonc", ".jsonl", ".yaml", ".yml", ".toml", ".env.example",
  ".ts", ".tsx", ".js", ".jsx", ".py", ".sh", ".bash",
  ".html", ".css", ".sql", ".xml", ".csv", ".log",
]);
const MIME_TYPES: Record<string, string> = {
  ".csv": "text/csv; charset=utf-8",
  ".gif": "image/gif",
  ".htm": "text/html; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json; charset=utf-8",
  ".jsonc": "application/json; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".m4a": "audio/mp4",
  ".md": "text/markdown; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
  ".webp": "image/webp",
  ".xml": "application/xml; charset=utf-8",
  ".yaml": "application/yaml; charset=utf-8",
  ".yml": "application/yaml; charset=utf-8",
};

function guardPath(path: string, workspacePath: string): { safe: boolean; resolved: string } {
  try {
    const { resolved } = resolvePathWithinWorkspace(path, workspacePath);
    return { safe: true, resolved };
  } catch {
    return { safe: false, resolved: resolve(workspacePath, path.replace(/^\//, "")) };
  }
}

registerTool({
  name: "read_file",
  description: "Read the contents of a file within the workspace directory.",
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
      const previewMode = isDirectory
        ? "download"
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
  description: "Write content to a file within the workspace. Creates file and parent directories if needed.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative path within workspace" },
      content: { type: "string", description: "File content to write" },
      createDirs: { type: "boolean", description: "Create parent directories if needed", default: true },
    },
    required: ["path", "content"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const path = String(args["path"] ?? "");
    const content = String(args["content"] ?? "");
    const createDirs = Boolean(args["createDirs"] ?? true);
    const { safe, resolved } = guardPath(path, ctx.workspacePath);

    if (!safe) {
      return { success: false, output: "", error: "Path escapes workspace boundary" };
    }

    const ext = extname(resolved).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext) && ext !== "") {
      return { success: false, output: "", error: `File type ${ext} is not allowed for writing` };
    }

    try {
      if (createDirs) {
        mkdirSync(resolve(resolved, ".."), { recursive: true });
      }
      writeFileSync(resolved, content, "utf-8");
      return {
        success: true,
        output: `File written: ${path} (${content.length} chars)`,
        metadata: { path, size: content.length },
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
    const { safe, resolved } = guardPath(path, ctx.workspacePath);

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
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType.startsWith("text/html")) return "html";
  if (contentType.startsWith("application/pdf")) return "pdf";
  if (contentType.startsWith("application/json")) return "json";
  if (contentType.startsWith("text/") || contentType.includes("yaml") || contentType.includes("xml")) return "text";
  return "download";
}

function safeEntryCount(dir: string): number {
  try {
    return readdirSync(dir).length;
  } catch {
    return 0;
  }
}
