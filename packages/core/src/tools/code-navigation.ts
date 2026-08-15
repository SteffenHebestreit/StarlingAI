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
import { isSensitiveWorkspacePath } from "./filesystem.js";
import { resolvePathWithinWorkspace } from "./workspace-path.js";

const log = childLogger("tool:code-navigation");

/** Directories never worth walking — huge, generated, or not source. */
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".turbo", "coverage",
  ".venv", "venv", "__pycache__", ".cache", ".pnpm-store", "target",
]);
const MAX_RESULTS = 300;
const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024;
const MAX_WALK_ENTRIES = 20_000;

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

/** Walk the workspace, yielding workspace-relative POSIX paths. */
function walk(root: string, onFile: (rel: string, abs: string) => boolean | void): void {
  let seen = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (++seen > MAX_WALK_ENTRIES) return;
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).split(sep).join("/");
      if (isSensitiveWorkspacePath(rel)) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (onFile(rel, abs) === false) return;
    }
  }
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

    let root = ctx.workspacePath;
    const sub = typeof args["path"] === "string" ? args["path"].trim() : "";
    if (sub) {
      try { root = resolvePathWithinWorkspace(sub, ctx.workspacePath).resolved; }
      catch { return fail("path must be a relative path within the workspace"); }
      if (!existsSync(root)) return fail(`Directory not found: ${sub}`);
    }

    let re: RegExp;
    try { re = globToRegExp(pattern); }
    catch { return fail(`Invalid pattern: ${pattern}`); }

    const hits: Array<{ rel: string; mtime: number }> = [];
    // Match against the path relative to the WORKSPACE (not the subdirectory), so a
    // pattern reads the same whether or not `path` was narrowed.
    const prefix = sub ? relative(ctx.workspacePath, root).split(sep).join("/") : "";
    walk(root, (rel, abs) => {
      const full = prefix ? `${prefix}/${rel}` : rel;
      if (!re.test(full)) return;
      try { hits.push({ rel: full, mtime: statSync(abs).mtimeMs }); } catch { /* vanished mid-walk */ }
    });

    hits.sort((a, b) => b.mtime - a.mtime);
    const shown = hits.slice(0, limit);
    return {
      success: true,
      output: shown.length === 0
        ? `No files match ${pattern}.`
        : shown.map((h) => h.rel).join("\n"),
      metadata: { pattern, matched: hits.length, returned: shown.length, truncated: hits.length > shown.length },
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
      path: { type: "string", description: "Optional subdirectory to search within, workspace-relative." },
      context: { type: "number", description: "Lines of context to show around each match (default 2, max 10)." },
      ignore_case: { type: "boolean", description: "Case-insensitive match. Default false." },
      limit: { type: "number", description: "Maximum matches to return (default 100)." },
    },
    required: ["pattern"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const pattern = String(args["pattern"] ?? "");
    if (!pattern.trim()) return fail("pattern is required");
    const contextLines = Math.min(10, Math.max(0, Number(args["context"]) ?? 2));
    const limit = Math.min(500, Math.max(1, Number(args["limit"]) || 100));

    let re: RegExp;
    try { re = new RegExp(pattern, args["ignore_case"] === true ? "i" : ""); }
    catch (err) { return fail(`Invalid regular expression: ${err instanceof Error ? err.message : String(err)}`); }

    let root = ctx.workspacePath;
    const sub = typeof args["path"] === "string" ? args["path"].trim() : "";
    if (sub) {
      try { root = resolvePathWithinWorkspace(sub, ctx.workspacePath).resolved; }
      catch { return fail("path must be a relative path within the workspace"); }
      if (!existsSync(root)) return fail(`Directory not found: ${sub}`);
    }

    const globStr = typeof args["glob"] === "string" ? args["glob"].trim() : "";
    let globRe: RegExp | null = null;
    if (globStr) {
      try { globRe = globToRegExp(globStr); } catch { return fail(`Invalid glob: ${globStr}`); }
    }

    const blocks: string[] = [];
    let matchCount = 0;
    let filesWithMatches = 0;
    const prefix = sub ? relative(ctx.workspacePath, root).split(sep).join("/") : "";

    walk(root, (rel, abs) => {
      if (matchCount >= limit) return false;
      const full = prefix ? `${prefix}/${rel}` : rel;
      if (globRe && !globRe.test(full)) return;
      // Skip obvious binaries cheaply — extension first, size second.
      const ext = extname(rel).toLowerCase();
      if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".zip", ".docx", ".pptx", ".xlsx", ".woff", ".woff2", ".ico", ".mp4", ".wav"].includes(ext)) return;
      let stat;
      try { stat = statSync(abs); } catch { return; }
      if (stat.size > MAX_GREP_FILE_BYTES) return;

      let text: string;
      try { text = readFileSync(abs, "utf-8"); } catch { return; }
      if (text.includes(" ")) return;   // binary that slipped the extension check
      if (!re.test(text)) { re.lastIndex = 0; return; }
      re.lastIndex = 0;

      const lines = text.split("\n");
      let fileHits = 0;
      for (let i = 0; i < lines.length && matchCount < limit; i++) {
        if (!re.test(lines[i]!)) { re.lastIndex = 0; continue; }
        re.lastIndex = 0;
        const from = Math.max(0, i - contextLines);
        const to = Math.min(lines.length - 1, i + contextLines);
        const body = [];
        for (let j = from; j <= to; j++) {
          body.push(`${j === i ? ">" : " "} ${j + 1}\t${lines[j]}`);
        }
        blocks.push(`${full}:${i + 1}\n${body.join("\n")}`);
        matchCount++;
        fileHits++;
      }
      if (fileHits > 0) filesWithMatches++;
    });

    return {
      success: true,
      output: blocks.length === 0
        ? `No matches for /${pattern}/${globStr ? ` in ${globStr}` : ""}.`
        : blocks.join("\n\n"),
      metadata: {
        pattern,
        matches: matchCount,
        files: filesWithMatches,
        truncated: matchCount >= limit,
        ...(globStr ? { glob: globStr } : {}),
      },
    };
  },
});

log.debug("code navigation tools registered");
