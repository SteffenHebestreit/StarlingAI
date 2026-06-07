/**
 * bundle_artifact_zip — Wave D.
 *
 * Bundle one or more workspace files (or inline content) into a single .zip
 * deliverable inside the workspace. Useful for packaging the output of
 * generate_website / generate_svg / generate_pdf / generate_docx /
 * generate_pptx into a single download for the user.
 */
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { dirname, extname, join, posix, relative, sep } from "node:path";
import { createWriteStream } from "node:fs";
import { ZipFile } from "yazl";
import { childLogger } from "../logger.js";
import { registerTool, type ToolResult } from "./registry.js";
import { resolvePathWithinWorkspace, resolveWorkspaceWritePath } from "./workspace-path.js";

const log = childLogger("tool:bundle-zip");

interface InlineEntry {
  archivePath: string;
  content: string;
  encoding?: "utf8" | "base64";
}

interface FileEntry {
  workspacePath: string;
  archivePath?: string;
}

interface DirEntry {
  workspaceDir: string;
  archiveDir?: string;
  includeGlobs?: string[];
  excludeGlobs?: string[];
}

function fail(message: string): ToolResult {
  return { success: false, output: "", error: message };
}

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\w\s.-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "bundle";
}

function normalizeArchivePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

function matchAny(path: string, patterns: string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((pattern) => globMatch(pattern, path));
}

function globMatch(pattern: string, path: string): boolean {
  // Minimal glob translator. Handles:
  //   *      → match zero or more chars within a path segment ([^/]*)
  //   **     → match zero or more path chars including slashes (.*)
  //   **/    → optionally match an ancestor path prefix ((?:.*\/)?)
  //              so `**/*.html` matches both `index.html` and `docs/intro.html`.
  // Other regex metacharacters are escaped. Case-sensitive.
  let regexStr = "^";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") {
        regexStr += "(?:.*\\/)?";
        i += 3;
      } else {
        regexStr += ".*";
        i += 2;
      }
    } else if (c === "*") {
      regexStr += "[^/]*";
      i++;
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      regexStr += "\\" + c;
      i++;
    } else {
      regexStr += c;
      i++;
    }
  }
  regexStr += "$";
  return new RegExp(regexStr).test(path);
}

async function walkDir(absoluteRoot: string): Promise<string[]> {
  const out: string[] = [];
  async function visit(dir: string) {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) await visit(full);
      else if (e.isFile()) out.push(full);
    }
  }
  await visit(absoluteRoot);
  return out;
}

registerTool({
  name: "bundle_artifact_zip",
  description:
    "Bundle one or more workspace files, directories, or inline-content entries into a single .zip artifact in the workspace. Use this to ship a generate_website output, a research dossier with attachments, or any multi-file deliverable as a single download. Each entry may be a workspace file (with optional rename), a workspace directory (recursively walked, with include/exclude glob filters), or inline content (utf8 or base64).",
  embeddingDescription:
    "zip bundle archive package compress assemble multi-file deliverable download website artifact dossier sharable",
  parameters: {
    type: "object",
    properties: {
      output_file: {
        type: "string",
        description: "Workspace-relative output path (must end in .zip). Defaults to bundle.zip.",
      },
      files: {
        type: "array",
        description: "Single-file entries: {workspacePath, archivePath?}. workspacePath is workspace-relative; archivePath defaults to the same path.",
        items: { type: "object" },
      },
      directories: {
        type: "array",
        description: "Directory entries: {workspaceDir, archiveDir?, includeGlobs?, excludeGlobs?}. Walked recursively. includeGlobs filters to matching entries; excludeGlobs removes matching entries. Glob supports * (single segment) and ** (any depth).",
        items: { type: "object" },
      },
      inline: {
        type: "array",
        description: "Inline entries: {archivePath, content, encoding?}. encoding='utf8' (default) or 'base64'. Useful for adding a README or generated metadata to the bundle.",
        items: { type: "object" },
      },
      compressionLevel: {
        type: "number",
        description: "0 (store) to 9 (best). Defaults to 6.",
      },
      overwrite: {
        type: "boolean",
        description: "When false, fail instead of overwriting an existing .zip. Default true.",
      },
    },
    required: [],
  },
  async execute(args, ctx) {
    const overwrite = args["overwrite"] !== false;
    const compressionLevel = typeof args["compressionLevel"] === "number" && Number.isFinite(args["compressionLevel"])
      ? Math.max(0, Math.min(9, Math.trunc(args["compressionLevel"])))
      : 6;
    const compress = compressionLevel > 0;

    const files = Array.isArray(args["files"]) ? args["files"] as FileEntry[] : [];
    const directories = Array.isArray(args["directories"]) ? args["directories"] as DirEntry[] : [];
    const inline = Array.isArray(args["inline"]) ? args["inline"] as InlineEntry[] : [];

    if (files.length === 0 && directories.length === 0 && inline.length === 0) {
      return fail("at least one of files, directories, or inline must be non-empty");
    }

    const requestedOutput = (typeof args["output_file"] === "string" && String(args["output_file"]).trim())
      ? String(args["output_file"]).trim()
      : "bundle.zip";
    if (extname(requestedOutput).toLowerCase() !== ".zip") {
      return fail("output_file must use the .zip extension");
    }

    let resolvedOutput: { resolved: string; relativePath: string };
    try {
      // The output archive is generated content → root it under generated/.
      // The files/dirs being bundled (below) stay workspace-wide reads.
      resolvedOutput = resolveWorkspaceWritePath(requestedOutput, ctx.workspacePath);
    } catch {
      return fail("output_file must resolve inside the workspace");
    }

    if (!overwrite) {
      try {
        await stat(resolvedOutput.resolved);
        return fail(`Refusing to overwrite existing file: ${resolvedOutput.relativePath}`);
      } catch {
        // ok
      }
    }

    type Plan = { kind: "file"; absolutePath: string; archivePath: string }
              | { kind: "buffer"; bytes: Buffer; archivePath: string };
    const plan: Plan[] = [];
    const archivePathsSeen = new Set<string>();

    function recordArchivePath(path: string): string | null {
      const normalized = normalizeArchivePath(path);
      if (!normalized) return "archive entry path is empty";
      if (normalized.includes("..")) return `archive entry path may not contain '..': ${path}`;
      if (archivePathsSeen.has(normalized)) return `duplicate archive entry: ${normalized}`;
      archivePathsSeen.add(normalized);
      return null;
    }

    // ── Inline entries ──
    for (const entry of inline) {
      if (!entry || typeof entry !== "object") return fail("inline entry must be an object");
      const archivePath = String(entry.archivePath ?? "").trim();
      const err = recordArchivePath(archivePath);
      if (err) return fail(err);
      const enc = entry.encoding === "base64" ? "base64" : "utf8";
      const bytes = Buffer.from(String(entry.content ?? ""), enc);
      plan.push({ kind: "buffer", bytes, archivePath: normalizeArchivePath(archivePath) });
    }

    // ── Single-file entries ──
    for (const entry of files) {
      if (!entry || typeof entry !== "object") return fail("file entry must be an object");
      const wsPath = String(entry.workspacePath ?? "").trim();
      if (!wsPath) return fail("file entry requires workspacePath");
      let resolved: { resolved: string; relativePath: string };
      try {
        resolved = resolvePathWithinWorkspace(wsPath, ctx.workspacePath);
      } catch {
        return fail(`workspacePath escapes the workspace: ${wsPath}`);
      }
      try {
        const s = await stat(resolved.resolved);
        if (!s.isFile()) return fail(`workspacePath is not a regular file: ${wsPath}`);
      } catch {
        return fail(`workspacePath does not exist: ${wsPath}`);
      }
      const archivePath = String(entry.archivePath ?? resolved.relativePath).trim();
      const err = recordArchivePath(archivePath);
      if (err) return fail(err);
      plan.push({ kind: "file", absolutePath: resolved.resolved, archivePath: normalizeArchivePath(archivePath) });
    }

    // ── Directory entries ──
    for (const entry of directories) {
      if (!entry || typeof entry !== "object") return fail("directory entry must be an object");
      const wsDir = String(entry.workspaceDir ?? "").trim();
      if (!wsDir) return fail("directory entry requires workspaceDir");
      let resolved: { resolved: string; relativePath: string };
      try {
        resolved = resolvePathWithinWorkspace(wsDir, ctx.workspacePath);
      } catch {
        return fail(`workspaceDir escapes the workspace: ${wsDir}`);
      }
      try {
        const s = await stat(resolved.resolved);
        if (!s.isDirectory()) return fail(`workspaceDir is not a directory: ${wsDir}`);
      } catch {
        return fail(`workspaceDir does not exist: ${wsDir}`);
      }
      const archiveDirRaw = String(entry.archiveDir ?? resolved.relativePath).trim();
      const archiveDir = normalizeArchivePath(archiveDirRaw);
      const includeGlobs = Array.isArray(entry.includeGlobs) ? entry.includeGlobs.map(String) : undefined;
      const excludeGlobs = Array.isArray(entry.excludeGlobs) ? entry.excludeGlobs.map(String) : undefined;

      const allFiles = await walkDir(resolved.resolved);
      for (const absolutePath of allFiles) {
        const rel = relative(resolved.resolved, absolutePath).split(sep).join("/");
        if (includeGlobs && !matchAny(rel, includeGlobs)) continue;
        if (matchAny(rel, excludeGlobs)) continue;
        const archivePath = archiveDir ? posix.join(archiveDir, rel) : rel;
        const err = recordArchivePath(archivePath);
        if (err) return fail(err);
        plan.push({ kind: "file", absolutePath, archivePath: normalizeArchivePath(archivePath) });
      }
    }

    if (plan.length === 0) {
      return fail("nothing matched — all globs / inputs were empty after filtering");
    }

    try {
      await mkdir(dirname(resolvedOutput.resolved), { recursive: true });
    } catch (err) {
      return fail(`Failed to create output dir: ${String(err)}`);
    }

    let bytesWritten = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        const zip = new ZipFile();
        const stream = createWriteStream(resolvedOutput.resolved);
        stream.on("error", reject);
        stream.on("close", () => resolve());

        zip.outputStream.on("error", reject);
        zip.outputStream.on("data", (chunk: Buffer) => {
          bytesWritten += chunk.byteLength;
        });
        zip.outputStream.pipe(stream);

        for (const entry of plan) {
          if (entry.kind === "file") {
            zip.addFile(entry.absolutePath, entry.archivePath, { compress });
          } else {
            zip.addBuffer(entry.bytes, entry.archivePath, { compress });
          }
        }
        zip.end();
      });
    } catch (err) {
      log.error({ err }, "bundle_artifact_zip stream failed");
      try { await unlink(resolvedOutput.resolved); } catch { /* ignore */ }
      return fail(`Failed to build .zip: ${String(err)}`);
    }

    log.info(
      { outputFile: resolvedOutput.relativePath, entryCount: plan.length, bytes: bytesWritten },
      "bundle_artifact_zip wrote archive",
    );

    return {
      success: true,
      output: `Bundle (${plan.length} entries, ${bytesWritten} bytes) saved to ${resolvedOutput.relativePath}.`,
      metadata: {
        artifactKind: "document",
        outputPath: resolvedOutput.relativePath,
        format: "zip",
        entryCount: plan.length,
        bytes: bytesWritten,
        contentType: "application/zip",
        previewMode: "download",
      },
    };
  },
});

void slugify; // reserved for future title-derived defaults
