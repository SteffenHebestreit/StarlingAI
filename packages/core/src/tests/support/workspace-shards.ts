/**
 * Read the workspace catalog the way the CONFIG BUILDER reads it.
 *
 * The shards under workspace/{agents,scenes,jobs}/ are OVERLAYS: the builder deep-merges them
 * in filename order, so a shard may carry only one key of an entry and leave the rest intact.
 * Several tests merged them with a single `Object.assign(merged, shard.subAgents)`, which
 * REPLACES each entry wholesale — so the first overlay shard to ship (the generated routing
 * taxonomy, which carries one key per agent) silently emptied every agent those tests then
 * asserted on. They failed loudly, which is the good case; a shard that merely dropped a
 * field would not have.
 *
 * This helper merges per entry, matching the builder for the shapes shards actually use, so a
 * future overlay cannot reintroduce the same defect in five places at once.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";

export const WORKSPACE_AGENTS_DIR = fileURLToPath(new URL("../../../../../workspace/agents/", import.meta.url));
export const WORKSPACE_SCENES_DIR = fileURLToPath(new URL("../../../../../workspace/scenes/", import.meta.url));
export const WORKSPACE_JOBS_DIR = fileURLToPath(new URL("../../../../../workspace/jobs/", import.meta.url));

/**
 * Merge every `*.jsonc` shard in `dir`, reading `container` from each, entry by entry.
 *
 * Filename order is the precedence order, exactly as the builder applies it.
 */
export function mergeWorkspaceShards<T extends Record<string, unknown>>(
  dir: string,
  container: string,
): Record<string, T> {
  const merged: Record<string, T> = {};
  if (!existsSync(dir)) return merged;
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".jsonc")) continue;
    const raw = JSON5.parse<Record<string, Record<string, T> | undefined>>(readFileSync(join(dir, file), "utf8"));
    for (const [name, entry] of Object.entries(raw[container] ?? {})) {
      merged[name] = { ...(merged[name] ?? ({} as T)), ...entry };
    }
  }
  return merged;
}

export function loadWorkspaceAgents<T extends Record<string, unknown>>(): Record<string, T> {
  return mergeWorkspaceShards<T>(WORKSPACE_AGENTS_DIR, "subAgents");
}

export function loadWorkspaceScenes<T extends Record<string, unknown>>(): Record<string, T> {
  return mergeWorkspaceShards<T>(WORKSPACE_SCENES_DIR, "scenes");
}

export function loadWorkspaceJobs<T extends Record<string, unknown>>(): Record<string, T> {
  return mergeWorkspaceShards<T>(WORKSPACE_JOBS_DIR, "jobs");
}
