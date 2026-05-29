import { isAbsolute, relative, resolve } from "node:path";

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
  return {
    resolved: resolvedPath,
    relativePath: rel === "" ? "." : rel.replace(/\\/g, "/"),
  };
}

/**
 * Dedicated subfolder for agent-generated files/projects, kept one layer below
 * the workspace root so generated output never lands next to the hand-/config-
 * authored zone (agents/, jobs/, scenes/, runtime/).
 */
export const GENERATED_SUBDIR = "generated";

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
 */
export function resolveWorkspaceWritePath(inputPath: string, workspacePath: string): { resolved: string; relativePath: string } {
  const within = resolvePathWithinWorkspace(inputPath, workspacePath);
  if (within.relativePath === GENERATED_SUBDIR || within.relativePath.startsWith(`${GENERATED_SUBDIR}/`)) {
    return within;
  }
  const rel = within.relativePath === "." ? GENERATED_SUBDIR : `${GENERATED_SUBDIR}/${within.relativePath}`;
  return { resolved: resolve(workspacePath, rel), relativePath: rel };
}