// Shard discovery and merge for the two-zone config (config/ + workspace/).
//
// Shared by `config build` (config-layout.mjs) and the routing taxonomy check
// (routing-taxonomy-check.mjs), so the check merges exactly what the build merges: the
// same files, in the same order, with the same deep-merge rule.
import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

/**
 * Shard order: the code-point order of each shard's path relative to its zone, with "/"
 * as the separator on every OS.
 *
 * Order decides which shard wins a key, so it must not depend on the machine. It did:
 * `localeCompare` follows the runtime's ICU collation, which ignores punctuation at the
 * first level and folds case, so "a_b" and "a-b" (or "B" and "a") can swap between
 * environments. The separator is normalised because Windows' "\" sorts after digits
 * while "/" sorts before them.
 */
export function compareShardPaths(sourceDir) {
  const sortKey = (path) => relative(sourceDir, path).split(sep).join("/");
  return (left, right) => {
    const a = sortKey(left);
    const b = sortKey(right);
    return a < b ? -1 : a > b ? 1 : 0;
  };
}

/**
 * What a sweep finds at `path`, by lstat: "link" for a symlink or, on Windows, a junction, which
 * no sweep follows. Mirrors sweepEntryKind in packages/core/src/tools/workspace-zones.ts: the
 * full-scope maintenance sandbox writes agents/, jobs/, scenes/ and tools/, and a link it leaves
 * there would hand the build any file the build can read.
 */
export function sweepEntryKind(path) {
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

/** The warning for a link a sweep skipped. */
export function warnSkippedLink(path) {
  console.warn(`[config] WARNING: skipped ${path}: a link in the config tree. Shards are read only from regular files, and no link is followed.`);
}

/**
 * A link at the TOP of a config tree (depth 0, a name the sweep reads: not hidden, not a working
 * zone) that stands for config: a directory, a shard by its name, or a link that leads nowhere,
 * which could have been either. Mirrors topLevelLinkHoldsConfig in
 * packages/core/src/tools/workspace-zones.ts.
 *
 * Skipped like a link further down, it dropped everything behind it, config/gateway/ linked to a
 * directory kept elsewhere took the gateway's settings out, and the build still said "Built
 * starlingai.json" after a warning. No sandbox writes that depth: a link there is the operator's
 * layout, so the build stops and says how to fix it. A whole config/ or workspace/ that is a link
 * is the swept directory itself, which readdir reads through, and still works.
 */
export function topLevelLinkHoldsConfig(path, name) {
  if (isShardName(name)) return true;
  try {
    return statSync(path).isDirectory();
  } catch {
    return true;
  }
}

/** The sweep found a link at the top of a config tree that stands for config (topLevelLinkHoldsConfig). */
export class LinkedConfigEntryError extends Error {
  constructor(path) {
    super(
      `${path} is a link at the top of the config tree, and the build reads no link: everything behind it would be left out. `
      + "Replace the link with what it points to (move or copy that directory or file into its place), "
      + "or make the whole config/ or workspace/ directory the link instead, which is read through.",
    );
    this.name = "LinkedConfigEntryError";
    this.path = path;
  }
}

function isShardName(name) {
  const extension = extname(name).toLowerCase();
  return extension === ".json" || extension === ".jsonc";
}

/**
 * Every .json/.jsonc shard under `sourceDir`, in merge order.
 *
 * `excludeZones` skips depth-0 directories that hold working data, not config; hidden
 * directories are skipped at every depth. A link is never followed (sweepEntryKind), and each
 * one is warned about; one at the top of the tree that stands for config throws
 * LinkedConfigEntryError instead (topLevelLinkHoldsConfig).
 * `include` filters individual files by absolute path (the taxonomy check passes the
 * git-tracked set); the default takes every shard, as the build does.
 */
export function collectShardPaths(sourceDir, { excludeZones = [], include = () => true } = {}) {
  if (!existsSync(sourceDir)) return [];
  const shardPaths = [];
  const skipZones = new Set(excludeZones);

  const visit = (currentDir, depth) => {
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const nextPath = join(currentDir, entry.name);
      const kind = sweepEntryKind(nextPath);
      const skippedZone = entry.name.startsWith(".") || (depth === 0 && skipZones.has(entry.name));
      if (kind === "link") {
        if (skippedZone) continue;
        if (depth === 0 && topLevelLinkHoldsConfig(nextPath, entry.name)) throw new LinkedConfigEntryError(nextPath);
        warnSkippedLink(nextPath);
        continue;
      }
      if (kind === "directory") {
        // SECURITY: skip depth-0 working zones (generated/, uploads/, tools/) so
        // an agent-written or uploaded data.json with a top-level "agents" key
        // cannot merge into the compiled config. Mirrors the runtime loader's
        // NON_CONFIG_WORKSPACE_ZONES guard, closing the build-vs-loader gap.
        // Hidden directories at any depth hold state (checkpoints, per-user memory), never shards.
        if (skippedZone) continue;
        visit(nextPath, depth + 1);
        continue;
      }
      if (kind !== "file") continue;
      if (!isShardName(entry.name)) continue;
      if (entry.name === "runtime.overrides.json") continue;
      if (!include(nextPath)) continue;
      shardPaths.push(nextPath);
    }
  };

  visit(sourceDir, 0);
  return shardPaths.sort(compareShardPaths(sourceDir));
}

export function deepMerge(base, overlay) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const baseValue = merged[key];
    if (isPlainObject(baseValue) && isPlainObject(value)) {
      merged[key] = deepMerge(baseValue, value);
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
