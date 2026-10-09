#!/usr/bin/env node
// Routing taxonomy check against the git-TRACKED config shards only.
//
// Why not the compiled starlingai.json: that file is gitignored and built from whatever
// sits in config/ + workspace/, including gitignored *.local.jsonc shards and other
// untracked files. A label that only resolves because of a local shard passes on the
// machine that has it and fails in every clean checkout (process_memory_keeper,
// 2026-09-29). The generated label files (workspace/*/59-routing.generated.jsonc) have no
// generator in the repo, so nothing else keeps them in step with the catalog.
//
// This merges the tracked shards exactly as `config build` does (same walk, order and
// merge, from config-shards.mjs) and fails on:
//   - orphan:  a label for an entry no tracked shard defines,
//   - stale:   a routingGenerated.sourceHash that no longer matches the entry's text,
//   - missing: an agent, scene or job with no label,
// plus the internal contradictions lintTaxonomy reports. The hashing and the lint are the
// runtime's own (packages/core/src/agent/routing-taxonomy.ts), loaded through tsx, so the
// check cannot drift from what the router reads.
//
// Usage: node scripts/routing-taxonomy-check.mjs   (pnpm routing:taxonomy-check)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import JSON5 from "json5";
import { collectShardPaths, deepMerge } from "./config-shards.mjs";
import { NON_CONFIG_BASE_ZONES, NON_CONFIG_WORKSPACE_ZONES } from "./config-zones.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COLLECTIONS = [["subAgents", "agent"], ["scenes", "scene"], ["jobs", "job"]];
const GENERATED_SHARD = /\.generated\.jsonc$/;
const LOCAL_SHARD = /\.local\.jsonc$/;

const display = (path) => relative(repoRoot, path).split(sep).join("/");

function fail(message) {
  console.error(`[routing-taxonomy-check] ${message}`);
  process.exit(1);
}

function trackedShardSet() {
  let output;
  try {
    output = execFileSync("git", ["ls-files", "-z", "--", "config", "workspace"], { cwd: repoRoot, encoding: "utf8" });
  } catch (error) {
    fail(`git ls-files failed (${error instanceof Error ? error.message : String(error)}); this check needs a git checkout.`);
  }
  return new Set(
    output.split("\0")
      .filter((path) => path && !LOCAL_SHARD.test(path))
      .map((path) => resolve(repoRoot, path)),
  );
}

async function loadTaxonomyModule() {
  // tsx is a dependency of @starlingai/core, not of the repo root, so resolve it from there.
  let tsImport;
  try {
    ({ tsImport } = createRequire(join(repoRoot, "packages", "core", "package.json"))("tsx/esm/api"));
  } catch {
    fail("tsx is not installed for @starlingai/core; run `pnpm install` first.");
  }
  const modulePath = join(repoRoot, "packages", "core", "src", "agent", "routing-taxonomy.ts");
  return tsImport(pathToFileURL(modulePath).href, import.meta.url);
}

const configDir = join(repoRoot, "config");
const workspaceDir = join(repoRoot, "workspace");
if (!existsSync(configDir)) fail("no config/ directory at the repo root.");

const tracked = trackedShardSet();
const isTracked = (path) => tracked.has(path);
const shardPaths = [
  ...collectShardPaths(configDir, { excludeZones: NON_CONFIG_BASE_ZONES, include: isTracked }),
  ...collectShardPaths(workspaceDir, { excludeZones: NON_CONFIG_WORKSPACE_ZONES, include: isTracked }),
];
const ignored = [
  ...collectShardPaths(configDir, { excludeZones: NON_CONFIG_BASE_ZONES }),
  ...collectShardPaths(workspaceDir, { excludeZones: NON_CONFIG_WORKSPACE_ZONES }),
].filter((path) => !isTracked(path));

let catalog = {};
const generatedShards = [];
/** collection -> names defined by a tracked shard that is not a label file */
const defined = new Map(COLLECTIONS.map(([collection]) => [collection, new Set()]));
for (const shardPath of shardPaths) {
  let shard;
  try {
    shard = JSON5.parse(readFileSync(shardPath, "utf8"));
  } catch (error) {
    fail(`${display(shardPath)} does not parse: ${error instanceof Error ? error.message : String(error)}`);
  }
  catalog = deepMerge(catalog, shard);
  if (GENERATED_SHARD.test(basename(shardPath))) {
    generatedShards.push({ path: shardPath, shard });
    continue;
  }
  for (const [collection] of COLLECTIONS) {
    for (const name of Object.keys(shard?.[collection] ?? {})) defined.get(collection).add(name);
  }
}

const counts = Object.fromEntries(COLLECTIONS.map(([collection]) => [collection, Object.keys(catalog[collection] ?? {}).length]));
console.log(
  `[routing-taxonomy-check] ${counts.subAgents} agents, ${counts.scenes} scenes, ${counts.jobs} jobs`
  + ` from ${shardPaths.length} tracked shards (${generatedShards.length} label files)`,
);
if (ignored.length > 0) {
  console.log(`[routing-taxonomy-check] not checked (untracked or *.local.jsonc): ${ignored.map(display).join(", ")}`);
}
// A gate over an empty catalog passes by having nothing to check.
if (counts.subAgents === 0 || generatedShards.length === 0) {
  fail("the tracked catalog has no agents or no label files, so there is nothing to check; is this the repo root?");
}

const findings = [];
const reported = new Set();
for (const { path, shard } of generatedShards) {
  for (const [collection, kind] of COLLECTIONS) {
    for (const name of Object.keys(shard?.[collection] ?? {})) {
      if (defined.get(collection).has(name)) continue;
      const entry = `${kind} ${name}`;
      reported.add(entry);
      findings.push({ kind: "orphan", entry, detail: `labelled in ${display(path)}, but no tracked shard defines it` });
    }
  }
}

const { lintTaxonomy } = await loadTaxonomyModule();
for (const finding of lintTaxonomy(catalog)) {
  // A file-level orphan above already names the label file; the lint's copy adds nothing.
  if (finding.kind === "orphan" && reported.has(finding.entry)) continue;
  findings.push(finding);
}

if (findings.length > 0) {
  console.error(`[routing-taxonomy-check] FAILED: ${findings.length} finding(s)`);
  for (const finding of findings) console.error(`  [${finding.kind}] ${finding.entry}: ${finding.detail}`);
  console.error(
    "[routing-taxonomy-check] Re-label the entry (or remove a label whose entry is gone), or set an authored"
    + " `routing` block in the entry's own shard, which always wins over the generated one.",
  );
  process.exit(1);
}
console.log("[routing-taxonomy-check] OK");
