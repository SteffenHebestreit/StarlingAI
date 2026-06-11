/**
 * workspace_search — full-text keyword search across all workspace text files.
 *
 * Returns matching file paths with surrounding context snippets.
 * Skips node_modules, .git, dist, and files larger than 200 KB.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { resolvePathWithinWorkspace } from "./workspace-path.js";
import { childLogger } from "../logger.js";

const log = childLogger("tool:workspace-search");

const MAX_FILE_BYTES = 200_000;
const MAX_DEPTH = 8;
const SKIP_DIRS = new Set([
  ".git", "node_modules", ".starlingai", "dist", "build",
  ".next", ".nuxt", "coverage", ".cache", ".turbo",
]);
const TEXT_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".jsonc", ".json5",
  ".md", ".txt", ".yaml", ".yml", ".toml",
  ".env", ".sh", ".bash",
  ".py", ".go", ".rs", ".rb", ".java", ".cs",
  ".html", ".css", ".scss", ".sql", ".graphql",
]);

function* walkDir(dir: string, depth = 0): Generator<string> {
  if (depth > MAX_DEPTH) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walkDir(join(dir, entry.name), depth + 1);
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf(".");
      if (dot >= 0 && TEXT_EXTS.has(entry.name.slice(dot))) yield join(dir, entry.name);
    }
  }
}

export interface WorkspaceSearchMatch {
  file: string;
  snippets: string[];
}

/**
 * Run a case-insensitive keyword search over the workspace and return
 * matching files with context snippets.  Shared between the local
 * workspace_search tool and the federated_workspace_search broadcaster so
 * peers return results in the same shape.
 */
export function searchWorkspace(workspacePath: string, query: string, maxResults: number): WorkspaceSearchMatch[] {
  const matches: WorkspaceSearchMatch[] = [];
  try {
    for (const filePath of walkDir(workspacePath)) {
      if (matches.length >= maxResults) break;
      const snippets = extractSnippets(filePath, query);
      if (snippets.length > 0) matches.push({ file: relative(workspacePath, filePath), snippets });
    }
  } catch (err) {
    log.warn({ err, query }, "workspace_search walk error");
  }
  return matches;
}

function extractSnippets(filePath: string, query: string, maxSnippets = 3, snippetWindow = 200): string[] {
  try {
    if (statSync(filePath).size > MAX_FILE_BYTES) return [];
    const content = readFileSync(filePath, "utf-8");
    const lower = content.toLowerCase();
    const qLower = query.toLowerCase();
    const snippets: string[] = [];
    let pos = 0;
    while ((pos = lower.indexOf(qLower, pos)) !== -1 && snippets.length < maxSnippets) {
      const lineStart = content.lastIndexOf("\n", Math.max(0, pos - 80)) + 1;
      const end = Math.min(content.length, pos + snippetWindow);
      snippets.push(content.slice(lineStart, end).replace(/\n{3,}/g, "\n\n").trim());
      pos += qLower.length;
    }
    return snippets;
  } catch { return []; }
}

registerTool({
  name: "workspace_search",
  description:
    "Full-text keyword search across all text files in the workspace. " +
    "Returns matching file paths with surrounding context snippets. " +
    "Use for retrieval, code lookup, or finding mentions of a concept across the project.",
  embeddingDescription: "Search, find, locate, grep, or look up text, code, symbols, mentions across the workspace. Dateien durchsuchen, Code finden, Begriff suchen, Vorkommen lokalisieren. Full-text search in the project. Retrieval.",
  costHint: "low",
  latencyHint: "low",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search term — matched case-insensitively across all workspace text files",
      },
      maxResults: {
        type: "number",
        description: "Maximum number of matching files to return (default 10, max 30)",
      },
    },
    required: ["query"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const query = String(args["query"] ?? "").trim();
    if (!query) return { success: false, output: "", error: "query is required" };
    const maxResults = Math.min(30, Math.max(1, Number(args["maxResults"] ?? 10) || 10));

    // Workspace zoning: resolve the search root through the scope-aware resolver
    // so a scope-confined agent searches its working zone (generated/), not the
    // platform's config zones and docs.
    const searchRoot = resolvePathWithinWorkspace(".", ctx.workspacePath).resolved;
    if (!existsSync(searchRoot)) {
      return { success: true, output: `No workspace files contain "${query}".`, metadata: { count: 0 } };
    }

    const matches = searchWorkspace(searchRoot, query, maxResults);

    if (matches.length === 0) {
      return { success: true, output: `No workspace files contain "${query}".`, metadata: { count: 0 } };
    }

    const output = matches
      .map(m => `**${m.file}**\n${m.snippets.map(s => "```\n" + s + "\n```").join("\n")}`)
      .join("\n\n---\n\n");

    return {
      success: true,
      output: `Found "${query}" in ${matches.length} file(s):\n\n${output}`,
      metadata: { count: matches.length },
    };
  },
});
