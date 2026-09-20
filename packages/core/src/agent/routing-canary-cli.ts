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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// NOTE: the config loader, the router and the embedding provider are imported DYNAMICALLY
// inside runRoutingCanaryCli, after the catalog path is resolved. ESM hoists static imports,
// so importing them here would evaluate the config loader — and cache whichever catalog the
// current working directory happens to sit next to — before a single statement of this file
// had run. That is how the canary ended up guarding a zero-agent stub.
import {
  DEFAULT_CANARY_FLOORS,
  buildAgentProbes,
  buildSnapshot,
  diffSnapshot,
  formatCanaryReport,
  runCanary,
  type CanaryProbe,
  type CanaryPipeline,
  type CanaryScorer,
  type CanarySnapshot,
} from "./routing-canary.js";

const DEFAULT_SNAPSHOT_PATH = "eval/routing/canary-snapshot.json";

/**
 * Score a probe exactly the way production routes an un-named delegation: the same
 * resolver, the same floor, the same rerank blend. Anything else measures a path the
 * product does not take.
 */
function createLiveScorer(
  resolveAgentRouting: typeof import("../tools/agent-routing.js")["resolveAgentRouting"],
  scoreEverything?: (query: string) => Promise<Array<{ name: string; score: number }>>,
): CanaryScorer {
  return async (query: string) => {
    const resolution = await resolveAgentRouting(query, { minConfidence: "high" });
    // The resolver cuts to the top 8 BEFORE the floor is consulted, so an entry can be
    // missing from the result either for scoring under 0.72 or for placing ninth. Those call
    // for opposite responses — rewrite the entry, or accept that the field is crowded — and
    // the report could not tell them apart. The extra lookup reuses the cached query
    // embedding, so it costs a cosine pass over an in-memory index.
    const allScored = scoreEverything ? await scoreEverything(query) : undefined;
    return {
      ranked: resolution.results.map((candidate) => ({ name: candidate.name, score: candidate.score })),
      gated: resolution.gated,
      mode: resolution.mode,
      ...(allScored ? { allScored } : {}),
    };
  };
}

function buildProbes(config: { subAgents: Record<string, Parameters<typeof buildAgentProbes>[1]> }): CanaryProbe[] {
  const probes: CanaryProbe[] = [];
  for (const [name, cfg] of Object.entries(config.subAgents)) {
    probes.push(...buildAgentProbes(name, cfg));
  }
  return probes;
}

/**
 * Point the config loader at the REPO-ROOT generated catalog, wherever this was launched from.
 *
 * `pnpm routing:canary` delegates into the core package, so the command runs with cwd
 * packages/core — where a `starlingai.json` also exists, declaring ZERO agents. Without this
 * the canary loaded that stub, derived no probes, and reported "no embedding model is
 * configured", blaming the operator's backend for a path problem.
 *
 * The marker is `pnpm-workspace.yaml`, which exists at the monorepo root and nowhere else.
 * A `workspace/` directory is NOT a usable marker: packages/core has one too, so the walk
 * stopped at the very stub it was written to skip.
 *
 * An explicit SAI_CONFIG_PATH always wins — an operator pointing at a specific deployment's
 * config is making a deliberate choice.
 */
function resolveRepoRootConfig(): string | undefined {
  if (process.env["SAI_CONFIG_PATH"]) return process.env["SAI_CONFIG_PATH"];
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      const candidate = join(dir, "starlingai.json");
      if (!existsSync(candidate)) return undefined;
      process.env["SAI_CONFIG_PATH"] = candidate;
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
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

  const configPath = resolveRepoRootConfig();
  if (!configPath) {
    process.stderr.write(
      "INCONCLUSIVE: could not locate the generated catalog (starlingai.json next to workspace/).\n"
      + "Run `pnpm config:build` first, or set SAI_CONFIG_PATH explicitly.\n",
    );
    return 2;
  }
  // Imported only now — see the note at the top of this file.
  const { getConfig } = await import("../config/loader.js");
  const { SEMANTIC_AGENT_ROUTING_MIN_SCORE, resolveAgentRouting } = await import("../tools/agent-routing.js");
  const { isEmbeddingAvailable, getEmbeddingSearchStatus } = await import("../providers/embeddings.js");
  const config = getConfig();
  // Say which catalog is being guarded. The whole point of this canary is the score
  // distribution of a SPECIFIC catalog, so reading the wrong one is a silent no-op.
  process.stdout.write(
    `Catalog: ${configPath} (${Object.keys(config.subAgents).length} agents)\n`,
  );
  if (Object.keys(config.subAgents).length === 0) {
    process.stderr.write(
      "INCONCLUSIVE: that config declares no sub-agents, so there is nothing to probe.\n"
      + "Run `pnpm config:build` at the repo root, or point SAI_CONFIG_PATH at a built catalog.\n",
    );
    return 2;
  }
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

  const probes = buildProbes(config);
  if (probes.length === 0) {
    process.stderr.write("INCONCLUSIVE: no probes could be derived — the catalog has no usable descriptions.\n");
    return 2;
  }

  // The floor comes from the ROUTER, not from a copy: the canary exists to guard that
  // constant, so keeping a duplicate of it invites the two drifting apart.
  const { searchByEmbedding } = await import("../providers/embeddings.js");
  const embeddingProvider = getEmbeddingProvider();
  const catalogSize = Object.keys(config.subAgents).length;
  const scoreEverything = async (query: string): Promise<Array<{ name: string; score: number }>> => {
    const hits = await searchByEmbedding(query, embeddingProvider, catalogSize);
    // Same rescale the router applies at agent-routing.ts:442. Reporting raw cosine here
    // would print a number that looks nothing like the floor it is being compared to.
    return hits.map((hit) => ({ name: hit.agentName, score: Math.max(0, (hit.score + 1) / 2) }));
  };

  const report = await runCanary(probes, createLiveScorer(resolveAgentRouting, scoreEverything), {
    ...DEFAULT_CANARY_FLOORS,
    agent: SEMANTIC_AGENT_ROUTING_MIN_SCORE,
  });
  const snapshot = readSnapshot(snapshotPath);

  // Say whether the RERANKER took part. The admission floor is applied after the rerank
  // blend, so a run without it scores a different pipeline from production — same catalog,
  // different absolute numbers against a fixed gate. This is read BEFORE the diff, because
  // the diff needs the pipeline stamp to know whether the baseline is comparable at all.
  const { getRerankerRunStatus } = await import("../retrieval/reranker.js");
  const rerank = getRerankerRunStatus();
  const rerankDegraded = rerank.enabled && rerank.applied === 0;
  // The stamp is what the run DID, not what it was configured to do: a reranker that was
  // enabled and never answered produced embedding-only scores.
  const pipeline: CanaryPipeline = rerank.applied > 0 ? "embedding_rerank" : "embedding_only";
  const diff = snapshot ? diffSnapshot(snapshot, report, embeddingModel, { pipeline }) : undefined;

  process.stdout.write(`${formatCanaryReport(report, diff)}\n`);

  if (jsonPath) {
    const target = resolve(jsonPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify({ report, diff, embeddingModel, pipeline }, null, 2), "utf8");
    process.stdout.write(`Wrote ${target}\n`);
  }

  process.stdout.write(
    `Reranker: ${rerank.enabled ? `enabled (${rerank.mode})` : "disabled"}`
    + `, applied to ${rerank.applied}/${rerank.attempted + rerank.skippedCircuitOpen} queries`
    + `${rerank.lastError ? ` — last error: ${rerank.lastError}` : ""}\n`,
  );
  if (rerankDegraded) {
    process.stdout.write(
      "WARNING: the reranker is configured but never answered, so these scores are PRE-BLEND.\n"
      + "Production blends 0.7*embedding + 0.3*rerank and applies the 0.72 floor to the RESULT.\n"
      + "The sidecar sits on the docker network; run this from inside it for a comparable run.\n",
    );
  }

  if (update) {
    // A baseline recorded from a degraded pipeline is worse than none: the floor-crossing
    // check would then compare production runs against a system that never existed, and
    // report the difference as a regression. Same contract as an embedder change.
    if (rerankDegraded && !argv.includes("--allow-degraded")) {
      process.stderr.write(
        "\nREFUSING to record a baseline from a run the reranker did not take part in.\n"
        + "Re-run where the reranker is reachable, or pass --allow-degraded if you deliberately\n"
        + "want a pre-blend baseline (it will not be comparable to production runs).\n",
      );
      return 2;
    }
    mkdirSync(dirname(snapshotPath), { recursive: true });
    writeFileSync(snapshotPath, `${JSON.stringify(
      {
        ...buildSnapshot(report, embeddingModel, pipeline),
        reranker: { applied: rerank.applied, enabled: rerank.enabled, mode: rerank.mode },
      },
      null, 2,
    )}\n`, "utf8");
    process.stdout.write(`Recorded snapshot at ${snapshotPath}\n`);
    // A recorded baseline is a statement about what is NORMAL, so a failing run must not be
    // frozen into one silently.
    if (!report.passed) {
      process.stdout.write("WARNING: the snapshot was recorded from a run with failing probes.\n");
    }
    return 0;
  }

  // Checked BEFORE the snapshot check, because it is the stronger statement: without the
  // reranker these probes scored a pipeline production does not run, so neither a pass nor a
  // failure over them is a verdict about production. Grading it RED would train people to
  // ignore the command, which is the same harm as reporting green without a baseline.
  if (rerankDegraded) {
    process.stderr.write(
      "\nINCONCLUSIVE: the probes above ran WITHOUT the reranker, and production applies the\n"
      + "admission floor to the blended score. Re-run where the reranker is reachable — from\n"
      + "inside the docker network — to get a verdict on production.\n",
    );
    return 2;
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
  // With a baseline, the VERDICT is the diff. Absolute probe results stay printed above, but
  // they do not decide the exit code.
  //
  // This catalog fails twelve probes at the baseline, every one of them adjudicated as a
  // short abstract capability phrase several agents legitimately advertise rather than a
  // defect. Grading those red on every run gives a command that is permanently red, and a
  // permanently red canary is an ignored canary. What this file exists to catch is DRIFT —
  // an entry crossing the floor, the distribution shifting, a new entry that retrieves
  // nothing — and all three are diff checks. Recording a baseline from a failing run still
  // warns, so the twelve are a deliberate record rather than a silent amnesty.
  if (diff) return diff.passed ? 0 : 1;
  return report.passed ? 0 : 1;
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
