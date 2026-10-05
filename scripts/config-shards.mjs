// Shard discovery and merge for the two-zone config (config/ + workspace/).
//
// Shared by `config build` (config-layout.mjs) and the routing taxonomy check
// (routing-taxonomy-check.mjs), so the check merges exactly what the build merges: the
// same files, in the same order, with the same deep-merge rule.
import { existsSync, readdirSync } from "node:fs";
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
 * Every .json/.jsonc shard under `sourceDir`, in merge order.
 *
 * `excludeZones` skips depth-0 directories that hold working data, not config; hidden
 * directories are skipped at every depth.
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
      if (entry.isDirectory()) {
        // SECURITY: skip depth-0 working zones (generated/, uploads/, tools/) so
        // an agent-written or uploaded data.json with a top-level "agents" key
        // cannot merge into the compiled config. Mirrors the runtime loader's
        // NON_CONFIG_WORKSPACE_ZONES guard, closing the build-vs-loader gap.
        // Hidden directories at any depth hold state (checkpoints, per-user memory), never shards.
        if (entry.name.startsWith(".") || (depth === 0 && skipZones.has(entry.name))) continue;
        visit(nextPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = extname(entry.name).toLowerCase();
      if (extension !== ".json" && extension !== ".jsonc") continue;
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
