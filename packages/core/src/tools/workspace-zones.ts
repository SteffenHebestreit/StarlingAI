/**
 * The workspace's top-level zones and the rules the config-shard sweep applies to them.
 *
 * A leaf module (it imports nothing of this package): the config loader reads these while it
 * loads, and every module that resolves a workspace path reads the config. They lived in
 * tools/workspace-path.ts, which derives per-user roots and so imports the per-user scope, which
 * imports the config: a cycle, and two imports entering it at different modules at once (as
 * concurrent dynamic imports do) waited on each other for good. tools/workspace-path.ts re-exports
 * every one of them.
 */
import { lstatSync, statSync } from "node:fs";
import { relative, sep } from "node:path";

/**
 * Dedicated subfolder for agent-generated files/projects, kept one layer below
 * the workspace root so generated output never lands next to the hand-/config-
 * authored zone (agents/, jobs/, scenes/, tools/, runtime/).
 */
export const GENERATED_SUBDIR = "generated";

/** User-uploaded files (chat attachments) — readable by every agent. */
export const UPLOADS_SUBDIR = "uploads";

/** The directory under a shared root that holds one directory per user (runtime/user-scope.ts). */
export const USERS_SUBDIR = "users";

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
  // Each signed-in user's working root (userWorkspaceRoot) holds that user's own generated/,
  // uploads/ and state dir — one level down, where the depth-0 zone check above never looked,
  // so an agent-written users/<id>/generated/data.json merged into the live config.
  USERS_SUBDIR,
]);

/**
 * Top-level directories of the CONFIG tree (config/) that hold another service's own files, not
 * gateway config. config/mail/ is the mail-service's accounts file, which it reads itself: swept as
 * a shard it put the real mail account list into the compiled starlingai.json as a top-level
 * `accounts` key (2026-10-07), where nothing reads it, and a malformed edit refused the config load.
 */
export const NON_CONFIG_BASE_ZONES: ReadonlySet<string> = new Set(["mail"]);

/**
 * Whether a config-shard sweep skips this directory: one of `zones` at the top (the workspace's
 * working zones by default; NON_CONFIG_BASE_ZONES for the config tree), or a hidden directory at
 * any depth. Hidden directories hold state, never shards — the state dir under the workspace keeps
 * a JSON file per long-running task (checkpoints/), and one half-written file there was read as a
 * base shard, which refuses to boot on a parse error.
 */
export function isNonConfigShardDirectory(
  name: string,
  depth: number,
  zones: ReadonlySet<string> = NON_CONFIG_WORKSPACE_ZONES,
): boolean {
  return name.startsWith(".") || (depth === 0 && zones.has(name));
}

/**
 * What a sweep of the workspace or config tree finds at `path`, by lstat: "link" for a symlink or,
 * on Windows, a junction, which a sweep never follows, whatever it leads to; null where nothing is
 * there any more.
 *
 * A LINK IN THE ZONES IS THE SANDBOX'S, NOT THE OPERATOR'S. The full-scope maintenance sandbox writes
 * agents/, jobs/, scenes/, tools/ and generated/, and can leave `agents/x.jsonc` linked to any file
 * the gateway can read, or a directory linked anywhere: the gateway would read through it what the
 * sandbox itself cannot, the state directory included, and merge it into the live configuration
 * (review 2026-10-12). Node's Dirent already reported such an entry as neither file nor directory,
 * but a sweep that took anything not a directory as a file (validate-workspace), or listed names
 * and read them by path (the dynamic tools, config-layout), followed it; each caller warns, naming
 * the link it skips.
 */
export function sweepEntryKind(path: string): "file" | "directory" | "link" | "other" | null {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    return null;
  }
  if (stats.isSymbolicLink()) return "link";
  if (stats.isDirectory()) return "directory";
  return stats.isFile() ? "file" : "other";
}

/**
 * Whether a link a sweep found at the TOP of a config tree (depth 0, a name the sweep reads: not
 * hidden, not a working zone) stands for config: a directory, a shard by its name (`isShard`), or a
 * link that leads nowhere, which could have been either. Mirrors topLevelLinkHoldsConfig in
 * scripts/config-shards.mjs, where the build stops on one.
 *
 * Skipped like a link further down, with a warning, it dropped everything behind it from the
 * configuration: config/gateway/ linked to a directory kept elsewhere took the gateway's settings
 * out. No sandbox writes that depth, so such a link is the operator's layout; the loader says so as
 * an error. A config or workspace directory that is itself a link is the swept directory, which is
 * read through.
 */
export function topLevelLinkHoldsConfig(path: string, isShard: boolean): boolean {
  if (isShard) return true;
  try {
    return statSync(path).isDirectory();
  } catch {
    return true;
  }
}

/**
 * Shard merge order: code-point order on the "/"-joined path relative to the swept directory —
 * the order `sai config build` (scripts/config-shards.mjs) uses, so the compiled config and the
 * loaded one merge alike on every OS. localeCompare would weigh case and punctuation by locale,
 * and Windows separators sort apart from "/".
 */
export function compareShardPaths(directory: string): (left: string, right: string) => number {
  const sortKey = (path: string) => relative(directory, path).split(sep).join("/");
  return (left, right) => {
    const a = sortKey(left);
    const b = sortKey(right);
    return a < b ? -1 : a > b ? 1 : 0;
  };
}
