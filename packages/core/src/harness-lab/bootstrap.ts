/**
 * The harness lab's own process: set up before anything that loads the config or a store.
 *
 * The lab runs real turns on candidate prompts, laid over the loaded config in memory
 * (config/loader.ts applyLabPromptOverlay). That is only safe in a process of its own, cut off from
 * every store the live gateway reads and writes:
 * - its audit log, session store, decisions ledger, embedding cache (a warm copy) and recovery
 *   stats live under --out, never the gateway's (the session store rewrites its whole file and
 *   mirrors it to Redis; the decisions ledger trains the Laya model);
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
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
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
  /** The copy of the live skill library every attempt starts from, or null when there is none. */
  skillSnapshot: string | null;
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
  process.env["SAI_RECOVERY_NET_STATS"] = join(outDir, "recovery-net-stats.json");
  // The embedding cache is a file the gateway rewrites too: the lab works on a copy (still warm),
  // never on the file itself, which two writers could tear.
  const liveCache = process.env["SAI_EMBEDDING_CACHE"]?.trim() || resolve(process.cwd(), ".starlingai", "embedding-cache.json");
  const labCache = join(outDir, "embedding-cache.json");
  if (existsSync(liveCache)) copyFileSync(liveCache, labCache);
  process.env["SAI_EMBEDDING_CACHE"] = labCache;
  const isolatedStores: string[] = [];
  for (const name of LAB_SHARED_STORE_ENV) {
    if (process.env[name]) isolatedStores.push(name);
    delete process.env[name];
  }

  const { loadConfig } = await import("../config/loader.js");
  const config = loadConfig({ skipCompiledWrite: true });
  const liveWorkspacePath = config.workspacePath;
  // The decisions ledger trains the Laya model: lab turns write their own, under --out (it follows
  // the audit log unless a path is configured, and a configured one is the deployment's).
  if (config.decisions?.ledger?.path) config.decisions.ledger.path = join(outDir, "decisions", "ledger.jsonl");
  // Every attempt starts from a copy of the live skill library, taken once: the base arm runs with
  // the skills a live turn finds, and nothing an attempt does to skills reaches the live library.
  const { setSkillSnapshot, snapshotSkills } = await import("./arm.js");
  const skillSnapshot = snapshotSkills(liveWorkspacePath, join(outDir, "skills-snapshot"));
  setSkillSnapshot(skillSnapshot);
  await import("../tools/register-builtins.js");
  const { initProviders } = await import("../providers/index.js");
  await initProviders();
  // initProviders starts the agent index and does not wait for it: the first attempt would route
  // cold and get no capsule (harness-lab/warmup.ts).
  if (config.agents.defaults.model.embeddingModel) {
    const { warmLabRouting, ROUTING_WARMUP_QUERY } = await import("./warmup.js");
    const { isEmbeddingAvailable } = await import("../providers/embeddings.js");
    const { prefetchCapabilityCandidates } = await import("../agent/discovery-prefetch.js");
    await warmLabRouting({ ready: isEmbeddingAvailable, route: () => prefetchCapabilityCandidates(ROUTING_WARMUP_QUERY) });
  }

  _started = { outDir, liveWorkspacePath, isolatedStores, skillSnapshot };
  return _started;
}
