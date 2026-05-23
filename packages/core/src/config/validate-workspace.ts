/**
 * Workspace config validator — the "did my self-edit break the swarm?" check.
 *
 * Self-improvement agents (swarm_maintainer) author scenes, jobs, and sub-agent
 * definitions by editing the JSONC shards under config/ + workspace/. Those edits
 * are invisible to the running gateway (which loads the compiled starlingai.json)
 * until a human runs `config build` and reloads — so a malformed edit silently
 * sits broken until boot. This module re-reads the shards straight from disk,
 * merges them exactly like scripts/config-layout.mjs, validates the result against
 * the same Zod schema the loader uses, and then runs cross-reference integrity
 * checks the schema cannot express (scene→agent, job→scene, agent→tool).
 *
 * It is the config-side parallel to tool_dev_test: a gate the agent runs against
 * its own work before declaring success. It never writes anything.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import JSON5 from "json5";
import { ConfigSchema } from "./schema.js";

export interface WorkspaceValidationResult {
  ok: boolean;
  /** Per-file JSON5 parse failures (shard path → message). */
  parseErrors: string[];
  /** Zod schema violations against ConfigSchema. */
  schemaErrors: string[];
  /** Reference integrity failures (unknown agent/scene/tool wiring). */
  referenceErrors: string[];
  /** Non-fatal advisories (e.g. a tool name that may be dynamic/profile-gated). */
  warnings: string[];
  /** Inventory counts for the success summary. */
  summary: { subAgents: number; scenes: number; jobs: number };
}

/**
 * Resolve the repo root that holds the `config/` and `workspace/` zones from a
 * sub-agent's workspacePath. Agents run with workspacePath pointing at the
 * `workspace/` directory, so the repo root is its parent; fall back to the path
 * itself when it already contains the zones (single-dir / test layouts).
 */
export function resolveConfigRoot(workspacePath: string): string {
  const candidates = [
    basename(workspacePath) === "workspace" ? dirname(workspacePath) : null,
    workspacePath,
    dirname(workspacePath),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (existsSync(join(candidate, "config")) || existsSync(join(candidate, "workspace"))) {
      return candidate;
    }
  }
  return candidates[0] ?? workspacePath;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Sorted .json/.jsonc shard paths under a directory (recursive), like config-layout. */
function collectShardPaths(directory: string): string[] {
  const paths: string[] = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const next = resolve(current, entry.name);
      if (entry.isDirectory()) {
        visit(next);
        continue;
      }
      const ext = extname(entry.name).toLowerCase();
      if (ext !== ".json" && ext !== ".jsonc") continue;
      paths.push(next);
    }
  };
  visit(directory);
  return paths.sort((a, b) => relative(directory, a).localeCompare(relative(directory, b)));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const baseValue = merged[key];
    merged[key] = isPlainObject(baseValue) && isPlainObject(value) ? deepMerge(baseValue, value) : value;
  }
  return merged;
}

/**
 * Read + merge the config/ and workspace/ shards under `repoRoot`, collecting
 * per-file parse errors instead of throwing. Returns the merged raw object.
 */
function mergeShards(repoRoot: string, parseErrors: string[]): Record<string, unknown> {
  let merged: Record<string, unknown> = {};
  for (const zone of ["config", "workspace"]) {
    const dir = join(repoRoot, zone);
    if (!existsSync(dir) || !isDir(dir)) continue;
    for (const shardPath of collectShardPaths(dir)) {
      let parsed: unknown;
      try {
        parsed = JSON5.parse(readFileSync(shardPath, "utf8"));
      } catch (err) {
        parseErrors.push(`${relative(repoRoot, shardPath).replace(/\\/g, "/")}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (isPlainObject(parsed)) merged = deepMerge(merged, parsed);
    }
  }
  return merged;
}

/**
 * Validate the on-disk workspace config: JSON5 parse → Zod schema → cross-refs.
 * `knownToolNames` is the set of currently registered tool names; unknown tool
 * grants become warnings (they may be dynamic, self-developed, or profile-gated)
 * rather than hard errors so validation never blocks on a deferred capability.
 */
export function validateWorkspaceConfig(workspacePath: string, knownToolNames: Set<string>): WorkspaceValidationResult {
  const repoRoot = resolveConfigRoot(workspacePath);
  const parseErrors: string[] = [];
  const schemaErrors: string[] = [];
  const referenceErrors: string[] = [];
  const warnings: string[] = [];

  const merged = mergeShards(repoRoot, parseErrors);

  // Schema pass — same gate the loader applies, but collected rather than thrown.
  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      schemaErrors.push(`${path}: ${issue.message}`);
    }
  }

  // Cross-reference integrity — runs on the raw merge so it still reports useful
  // wiring problems even when an unrelated section fails the schema.
  const subAgents = isPlainObject(merged["subAgents"]) ? merged["subAgents"] : {};
  const scenes = isPlainObject(merged["scenes"]) ? merged["scenes"] : {};
  const jobs = isPlainObject(merged["jobs"]) ? merged["jobs"] : {};

  const knownAgents = new Set(Object.keys(subAgents));
  const knownScenes = new Set(Object.keys(scenes));

  for (const [sceneName, rawScene] of Object.entries(scenes)) {
    if (!isPlainObject(rawScene)) continue;
    const allowed = Array.isArray(rawScene["allowedAgents"]) ? rawScene["allowedAgents"] : [];
    for (const agent of allowed) {
      const agentName = String(agent);
      if (!knownAgents.has(agentName)) {
        referenceErrors.push(`scene "${sceneName}".allowedAgents references unknown agent "${agentName}"`);
      }
    }
  }

  for (const [jobName, rawJob] of Object.entries(jobs)) {
    if (!isPlainObject(rawJob)) continue;
    const steps = Array.isArray(rawJob["steps"]) ? rawJob["steps"] : [];
    steps.forEach((step, index) => {
      if (!isPlainObject(step)) return;
      const sceneRef = step["scene"] != null ? String(step["scene"]) : "";
      if (sceneRef && !knownScenes.has(sceneRef)) {
        referenceErrors.push(`job "${jobName}".steps[${index}] references unknown scene "${sceneRef}"`);
      }
    });
  }

  for (const [agentName, rawAgent] of Object.entries(subAgents)) {
    if (!isPlainObject(rawAgent)) continue;
    const tools = Array.isArray(rawAgent["tools"]) ? rawAgent["tools"] : [];
    for (const tool of tools) {
      const toolName = String(tool);
      if (!knownToolNames.has(toolName)) {
        warnings.push(`agent "${agentName}" grants tool "${toolName}" that is not currently registered (dynamic, self-developed, or profile-gated?)`);
      }
    }
  }

  const ok = parseErrors.length === 0 && schemaErrors.length === 0 && referenceErrors.length === 0;
  return {
    ok,
    parseErrors,
    schemaErrors,
    referenceErrors,
    warnings,
    summary: { subAgents: knownAgents.size, scenes: knownScenes.size, jobs: Object.keys(jobs).length },
  };
}
