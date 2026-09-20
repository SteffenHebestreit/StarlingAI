/**
 * Routing canary CLI — run the canary against the LIVE catalog and embedding backend.
 *
 *   pnpm routing:canary                 # compare against the committed snapshot
 *   pnpm routing:canary -- --update     # re-record the snapshot (after a deliberate change)
 *   pnpm routing:canary -- --json out.json
 *
 * It must run against the GENERATED config and the real embedding backend, because what it
 * guards is the score distribution those two produce together. The previous routing
 * benchmark in this repo ran against a hand-written fixture at `minConfidence: "low"` — it
 * could not have observed a floor regression even if it had not been skipped.
 *
 * Exit codes: 0 pass · 1 a probe or snapshot check failed · 2 INCONCLUSIVE — the backend is
 * unavailable, or no baseline snapshot exists yet. Both cases mean the run could not perform
 * its strongest checks, and a canary that reports green without them is worse than none.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getConfig } from "../config/loader.js";
import { isEmbeddingAvailable, getEmbeddingSearchStatus } from "../providers/embeddings.js";
import { SEMANTIC_AGENT_ROUTING_MIN_SCORE, resolveAgentRouting } from "../tools/agent-routing.js";
import {
  DEFAULT_CANARY_FLOORS,
  buildAgentProbes,
  buildSnapshot,
  diffSnapshot,
  formatCanaryReport,
  runCanary,
  type CanaryProbe,
  type CanaryScorer,
  type CanarySnapshot,
} from "./routing-canary.js";

const DEFAULT_SNAPSHOT_PATH = "eval/routing/canary-snapshot.json";

/**
 * Score a probe exactly the way production routes an un-named delegation: the same
 * resolver, the same floor, the same rerank blend. Anything else measures a path the
 * product does not take.
 */
function createLiveScorer(): CanaryScorer {
  return async (query: string) => {
    const resolution = await resolveAgentRouting(query, { minConfidence: "high" });
    return {
      ranked: resolution.results.map((candidate) => ({ name: candidate.name, score: candidate.score })),
      gated: resolution.gated,
      mode: resolution.mode,
    };
  };
}

function buildProbes(): CanaryProbe[] {
  const config = getConfig();
  const probes: CanaryProbe[] = [];
  for (const [name, cfg] of Object.entries(config.subAgents)) {
    probes.push(...buildAgentProbes(name, cfg));
  }
  return probes;
}

function readSnapshot(path: string): CanarySnapshot | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CanarySnapshot;
  } catch (err) {
    process.stderr.write(`Could not read snapshot at ${path}: ${err instanceof Error ? err.message : String(err)}\n`);
    return null;
  }
}

export async function runRoutingCanaryCli(argv: readonly string[]): Promise<number> {
  const update = argv.includes("--update");
  const jsonIndex = argv.indexOf("--json");
  const jsonPath = jsonIndex >= 0 ? argv[jsonIndex + 1] : undefined;
  const snapshotIndex = argv.indexOf("--snapshot");
  const snapshotPath = resolve(snapshotIndex >= 0 ? argv[snapshotIndex + 1]! : DEFAULT_SNAPSHOT_PATH);

  const config = getConfig();
  const embeddingModel = config.agents.defaults.model.embeddingModel ?? "";
  if (!embeddingModel) {
    process.stderr.write(
      "INCONCLUSIVE: no embedding model is configured (agents.defaults.model.embeddingModel).\n"
      + "Routing runs on keyword fallback in this configuration, which the canary does not guard.\n",
    );
    return 2;
  }

  // Build the index first; the canary is meaningless against an empty or partial one.
  const { buildAgentIndex } = await import("../providers/embeddings.js");
  const { getEmbeddingProvider } = await import("../providers/index.js");
  try {
    await buildAgentIndex(config.subAgents, getEmbeddingProvider(), embeddingModel);
  } catch (err) {
    process.stderr.write(`INCONCLUSIVE: embedding index build failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  if (!isEmbeddingAvailable()) {
    const status = getEmbeddingSearchStatus();
    process.stderr.write(
      `INCONCLUSIVE: embedding search is unavailable (model ${embeddingModel}).\n`
      + `Status: ${JSON.stringify(status)}\n`
      + "Start the embedding backend, or point agents.defaults.model.embeddingModel at a served model.\n",
    );
    return 2;
  }

  const probes = buildProbes();
  if (probes.length === 0) {
    process.stderr.write("INCONCLUSIVE: no probes could be derived — the catalog has no usable descriptions.\n");
    return 2;
  }

  // The floor comes from the ROUTER, not from a copy: the canary exists to guard that
  // constant, so keeping a duplicate of it invites the two drifting apart.
  const report = await runCanary(probes, createLiveScorer(), {
    ...DEFAULT_CANARY_FLOORS,
    agent: SEMANTIC_AGENT_ROUTING_MIN_SCORE,
  });
  const snapshot = readSnapshot(snapshotPath);
  const diff = snapshot ? diffSnapshot(snapshot, report, embeddingModel) : undefined;

  process.stdout.write(`${formatCanaryReport(report, diff)}\n`);

  if (jsonPath) {
    const target = resolve(jsonPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify({ report, diff, embeddingModel }, null, 2), "utf8");
    process.stdout.write(`Wrote ${target}\n`);
  }

  if (update) {
    mkdirSync(dirname(snapshotPath), { recursive: true });
    writeFileSync(snapshotPath, `${JSON.stringify(buildSnapshot(report, embeddingModel), null, 2)}\n`, "utf8");
    process.stdout.write(`Recorded snapshot at ${snapshotPath}\n`);
    // A recorded baseline is a statement about what is NORMAL, so a failing run must not be
    // frozen into one silently.
    if (!report.passed) {
      process.stdout.write("WARNING: the snapshot was recorded from a run with failing probes.\n");
    }
    return 0;
  }

  if (!snapshot) {
    // Exiting 0 here would report a run with its two strongest checks disabled as a pass:
    // the floor-crossing and mean-shift guards are exactly the pair that catches the
    // e1151d8 shape, and both need a baseline. Same contract as an unreachable backend —
    // INCONCLUSIVE, never green.
    process.stderr.write(
      `\nINCONCLUSIVE: no snapshot at ${snapshotPath}, so the floor-crossing and mean-shift `
      + "checks did not run. The per-probe results above are still valid.\n"
      + "Record a baseline with: pnpm routing:canary -- --update\n",
    );
    return report.passed ? 2 : 1;
  }
  return report.passed && (diff?.passed ?? true) ? 0 : 1;
}

const invokedDirectly = process.argv[1]
  && (process.argv[1].endsWith("routing-canary-cli.ts") || process.argv[1].endsWith("routing-canary-cli.js"));
if (invokedDirectly) {
  runRoutingCanaryCli(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      process.stderr.write(`Routing canary failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}
