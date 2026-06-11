import { isAbsolute, relative, resolve } from "node:path";
import { currentWorkspaceScope } from "../runtime/request-context.js";

/**
 * Dedicated subfolder for agent-generated files/projects, kept one layer below
 * the workspace root so generated output never lands next to the hand-/config-
 * authored zone (agents/, jobs/, scenes/, tools/, runtime/).
 */
export const GENERATED_SUBDIR = "generated";

/** User-uploaded files (chat attachments) — readable by every agent. */
export const UPLOADS_SUBDIR = "uploads";

/**
 * Swarm-invented dynamic tools (JSON bundles managed by tools/dynamic-tools.ts).
 * Lives in the workspace next to the other self-authored zones (agents/, jobs/,
 * scenes/) so the swarm's own creations are inspectable and versionable in one
 * place. Written only by the tool-development pipeline (sandbox-tested +
 * approved) — write_file roots everything into generated/, so agents cannot
 * plant tool bundles directly.
 */
export const SWARM_TOOLS_SUBDIR = "tools";

/**
 * Workspace zones that hold working data, not configuration. The config-shard
 * loaders must skip these when sweeping the workspace for .json/.jsonc shards —
 * otherwise an agent-generated data.json (or an uploaded file, or a dynamic-tool
 * bundle) would merge into the live config on the next reload.
 */
export const NON_CONFIG_WORKSPACE_ZONES: ReadonlySet<string> = new Set([
  GENERATED_SUBDIR,
  UPLOADS_SUBDIR,
  SWARM_TOOLS_SUBDIR,
]);

/**
 * Workspace zones a scope-confined ("generated") agent sees verbatim. Everything
 * else — the workspace root and the config zones (agents/, jobs/, scenes/,
 * tools/, runtime/) — is transparently re-rooted under generated/, mirroring the
 * write rooting, so working agents physically cannot wander into the platform's
 * own files (audit 0ac7d3fc: a builder burned 2.5 minutes reading the
 * workspace's README/ARCHITECTURE docs instead of building). Core agents with
 * workspaceAccess:"full" and runtime/gateway code paths are unaffected.
 */
const SCOPED_VISIBLE_ZONES: ReadonlySet<string> = new Set([GENERATED_SUBDIR, UPLOADS_SUBDIR]);

function stripVirtualWorkspacePrefix(inputPath: string): string {
  const normalized = inputPath.replace(/\\/g, "/").trim();
  if (normalized === "/workspace") return ".";
  if (normalized.startsWith("/workspace/")) {
    return normalized.slice("/workspace/".length);
  }
  return inputPath.trim();
}

export function resolvePathWithinWorkspace(inputPath: string, workspacePath: string): { resolved: string; relativePath: string } {
  const candidatePath = stripVirtualWorkspacePrefix(inputPath);
  const resolvedPath = isAbsolute(candidatePath)
    ? resolve(candidatePath)
    : resolve(workspacePath, candidatePath.replace(/^\//, ""));
  const rel = relative(workspacePath, resolvedPath);
  if (rel.startsWith("..") || rel === "..") {
    throw new Error("Path escapes workspace boundary");
  }
  const relativePath = rel === "" ? "." : rel.replace(/\\/g, "/");

  // Zone enforcement for scope-confined executions (set per-agent via
  // ToolContext.workspaceScope → AsyncLocalStorage). Re-rooting (instead of
  // denying) keeps read-after-write consistent: write_file("index.html") lands
  // in generated/index.html, and a later read_file("index.html") under the same
  // scope resolves to that same file.
  if (currentWorkspaceScope() === "generated") {
    const topSegment = relativePath === "." ? "" : (relativePath.split("/")[0] ?? "");
    if (!SCOPED_VISIBLE_ZONES.has(topSegment)) {
      const scopedRel = relativePath === "." ? GENERATED_SUBDIR : `${GENERATED_SUBDIR}/${relativePath}`;
      return { resolved: resolve(workspacePath, scopedRel), relativePath: scopedRel };
    }
  }

  return { resolved: resolvedPath, relativePath };
}

/**
 * Resolve a WRITE target, rooting agent-generated files under the workspace's
 * `generated/` subfolder. Reads stay workspace-wide via
 * resolvePathWithinWorkspace; only mutating file/artifact tools use this.
 *
 * Idempotent: a path already inside `generated/` is left where it is, so an
 * agent can write `index.html` (→ generated/index.html) and later edit either
 * `index.html` or `generated/index.html` and hit the same file. The returned
 * relativePath stays rooted at the workspace (e.g. "generated/index.html") so
 * artifact previews and the file-serving endpoint resolve correctly.
 *
 * Core agents running with workspaceScope:"full" write WITHOUT the generated/
 * rooting — they maintain the workspace itself (config shards, docs), so their
 * write target is taken literally. Everything else (scoped agents AND runtime
 * internals with no scope set) keeps the rooting.
 */
export function resolveWorkspaceWritePath(inputPath: string, workspacePath: string): { resolved: string; relativePath: string } {
  const within = resolvePathWithinWorkspace(inputPath, workspacePath);
  if (currentWorkspaceScope() === "full") {
    return within;
  }
  if (within.relativePath === GENERATED_SUBDIR || within.relativePath.startsWith(`${GENERATED_SUBDIR}/`)) {
    return within;
  }
  const rel = within.relativePath === "." ? GENERATED_SUBDIR : `${GENERATED_SUBDIR}/${within.relativePath}`;
  return { resolved: resolve(workspacePath, rel), relativePath: rel };
}
