/**
 * The harness lab's own process: set up before anything that loads the config or a store.
 *
 * The lab runs real turns on candidate prompts, laid over the loaded config in memory
 * (config/loader.ts applyLabPromptOverlay). That is only safe in a process of its own, cut off from
 * every store the live gateway reads and writes:
 * - its audit log and session store live under --out (SAI_AUDIT_LOG, SAI_SESSION_STORE), never the
 *   gateway's (the session store rewrites its whole file and mirrors it to Redis);
 * - the shared stores are unset (Redis, Postgres, Memgraph, QuestDB): a lab turn's memory
 *   retrievals would otherwise leave RETRIEVED edges in the shared graph, which the decay job reads
 *   as live memories retrieved and never useful, and its missions and jobs would land in the
 *   gateway's tables. The lab's synthetic principal has no memories of its own to miss;
 * - nothing that listens is started: no channel sync (it would consume live Telegram and mail), no
 *   job worker, swarm bus or Postgres audit sink.
 *
 * The CLI imports this module statically and everything else dynamically, after startLabProcess:
 * config/loader.ts resolves its sources when it is first imported.
 */
import { REPO_ROOT } from "../agent/eval-env-bootstrap.js";
import { mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export { REPO_ROOT };

/** The shared stores the lab process is cut off from. */
export const LAB_SHARED_STORE_ENV = ["REDIS_URL", "DATABASE_URL", "MEMGRAPH_URL", "NEO4J_URL", "QUESTDB_URL"] as const;

export interface LabProcess {
  outDir: string;
  /** The deployment's workspace, as loaded before any arm switched it: proposals are filed there. */
  liveWorkspacePath: string;
  /** The shared stores that were configured and are unset in this process. */
  isolatedStores: string[];
}

let _started: LabProcess | null = null;

/** The out directory, absolute: relative paths are taken from the repo root. */
export function resolveOutDir(out: string): string {
  return isAbsolute(out) ? out : resolve(REPO_ROOT, out);
}

/** Cut this process off from the live stores, load the config and the built-in tools. Once per process. */
export async function startLabProcess(outDir: string): Promise<LabProcess> {
  if (_started) return _started;
  mkdirSync(outDir, { recursive: true });
  process.env["SAI_HARNESS_LAB_PROCESS"] = "1";
  process.env["SAI_AUDIT_LOG"] = join(outDir, "audit.jsonl");
  process.env["SAI_SESSION_STORE"] = join(outDir, "sessions.json");
  const isolatedStores: string[] = [];
  for (const name of LAB_SHARED_STORE_ENV) {
    if (process.env[name]) isolatedStores.push(name);
    delete process.env[name];
  }

  const { loadConfig } = await import("../config/loader.js");
  const config = loadConfig({ skipCompiledWrite: true });
  const liveWorkspacePath = config.workspacePath;
  await import("../tools/register-builtins.js");
  const { initProviders } = await import("../providers/index.js");
  await initProviders();

  _started = { outDir, liveWorkspacePath, isolatedStores };
  return _started;
}
