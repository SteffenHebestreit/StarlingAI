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