/// <reference types="node" />
/**
 * routing:prerouter — could Laya, handed the embedding capsule's candidates at message arrival,
 * pick the specialist well enough to skip the orchestrator's routing round?
 *
 *   pnpm --filter @starlingai/core routing:prerouter [--cases <jsonl>] [--k 8] [--laya-url http://127.0.0.1:18080]
 *     [--out <dir>] [--split all|calibration|test] [--train-out <jsonl>] [--describe description|oneliner]
 *     [--keying language|answer] [--target 0.9] [--min-samples 30] [--round-ms 7900] [--min-coverage 0]
 *     [--limit n] [--no-laya] [--backend laya|readout]
 *
 * Per case: the production capsule for the message (resolveAgentRouting with the discovery
 * prefetch's own options, meta-factory agents dropped, cut to four), the embedding ranking behind
 * it, the question agent/pre-router-bench.ts builds from both, and one POST /v1/decide to the
 * sidecar at concurrency 1. Nothing else is called: no chat model, no gateway.
 *
 * `--backend readout` asks the resident model instead of Laya: the same question, options and
 * letters, read by its logits (decisions/logit-readout.ts — one token, thinking off, the letters'
 * top list) on the routing tier the source judge uses (SAI_PRIMARY_MODEL_URL from .env), at
 * concurrency 1. The report then adds the calibration error before and after a cross-fitted
 * temperature and whether stage 1's two thresholds (top-1 85%, "none" recall lower bound 0.95)
 * are met. Its provider calls are audited to this run's audit.jsonl.
 *
 * Fine-tuning round trip: `--train-out <file>` writes the CALIBRATION half as typed-decisions
 * training items (the format decisions:export writes, options under the letters the sidecar
 * serves). Train on it, serve the new checkpoint, and re-run with `--split test`: the test half is
 * the only one the new checkpoint has not seen. Compare its accuracy rows across the two runs (the
 * test/de and test/en columns before, de and en after): on the 68 cases of the live test half no
 * gate bucket can reach the 35 flawless cases a 0.9 target needs, so its gate says nothing.
 *
 * Reports land in .starlingai/live-check/pre-router-bench/<timestamp>/ (report.json, report.md,
 * questions.jsonl, and this run's own audit log). The embedding vectors are cached beside the
 * timestamped folders, never in the gateway's cache.
 *
 * Exit codes: 0 a pick qualified and held on the other fold, 1 none qualified or it did not hold,
 * 2 usage error, nothing scored (also --no-laya), or too few cases for any bucket to qualify even
 * had every pick been right (the test half alone, or --keying answer, on the 138 live cases),
 * 3 environment-suspect (embeddings or Laya unreachable, or the embedding search or Laya failed on
 * more than a tenth of the cases). pnpm reports every non-zero code as 1;
 * `tsx packages/core/src/scripts/pre-router-bench.ts` from the repo root keeps it.
 */
// MUST be first: loads .env before config/loader.ts freezes its resolution (see that module).
import { REPO_ROOT } from "../agent/eval-env-bootstrap.js";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  answererName,
  BenchUsageError,
  buildPreRouteQuestion,
  buildPreRouteReport,
  buildPreRouteTrainingItem,
  caseLanguage,
  CAPSULE_MAX_AGENTS,
  foldOf,
  formatPreRouteMarkdown,
  inSplit,
  isAnswererOutage,
  mergeCandidates,
  NONE_KEY,
  parseLayaAnswer,
  parsePreRouterArgs,
  pickFromReadout,
  preRouteGold,
  splitOf,
  agentDescriptionText,
  type BuiltPreRouteQuestion,
  type PreRouteGold,
  type PreRouteObservation,
  type PreRouterBenchArgs,
} from "../agent/pre-router-bench.js";
import { lintCases, parseCaseFile, type RoutingEvalCase } from "../agent/routing-eval.js";
import { captureEvaluationSourceState } from "../agent/evaluation-provenance.js";
import { loadConfig } from "../config/loader.js";
import type { TrainingItem } from "./decisions-export.js";

const DEFAULT_CASES = ["eval/routing/live-cases.jsonl", "eval/routing/live-cases.example.jsonl"];
const LAYA_TIMEOUT_MS = 10_000;
/** The first question may wait for the checkpoint to load; it is asked once, untimed, before the rest. */
const WARM_UP_TIMEOUT_MS = 180_000;
const HEALTH_TIMEOUT_MS = 5_000;
/** A sidecar that failed this many questions in a row is down: the rest are not asked, 10 s each. */
const MAX_CONSECUTIVE_FAILURES = 5;

class EnvironmentError extends Error {}

function inputPath(path: string): string {
  if (isAbsolute(path)) return path;
  const fromCwd = resolve(process.cwd(), path);
  return existsSync(fromCwd) ? fromCwd : resolve(REPO_ROOT, path);
}

function outputPath(path: string): string {
  return isAbsolute(path) ? path : resolve(REPO_ROOT, path);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function layaHealth(baseUrl: string): Promise<Record<string, unknown>> {
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (!response.ok) throw new EnvironmentError(`Laya /health answered HTTP ${response.status} at ${baseUrl}`);
    const body = await readJson(response);
    return body && typeof body === "object" ? body as Record<string, unknown> : {};
  } catch (err) {
    if (err instanceof EnvironmentError) throw err;
    throw new EnvironmentError(`Laya is not reachable at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** One question, one request, as production asks it: the round trip is the latency a turn would pay. */
async function askLaya(
  baseUrl: string,
  built: BuiltPreRouteQuestion,
  timeoutMs = LAYA_TIMEOUT_MS,
): Promise<NonNullable<PreRouteObservation["laya"]> | { error: string }> {
  const started = performance.now();
  try {
    const response = await fetch(`${baseUrl}/v1/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questions: [built.request] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await readJson(response) as { answers?: Record<string, unknown>; ms?: unknown; model?: unknown } | null;
    // Until the answer is read, as a turn would wait for it.
    const elapsed = performance.now() - started;
    if (!response.ok) {
      const detail = body && typeof body === "object" ? JSON.stringify(body).slice(0, 300) : "";
      return { error: `HTTP ${response.status} ${detail}`.trim() };
    }
    const pick = parseLayaAnswer(body?.answers?.[built.request.id], built.keys);
    if (!pick) return { error: "the answer does not fit the options" };
    return {
      choice: pick.choice,
      top: pick.top,
      ms: Math.round(elapsed * 10) / 10,
      ...(typeof body?.ms === "number" ? { serverMs: body.ms } : {}),
      model: typeof body?.model === "string" ? body.model.slice(0, 300) : "",
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function writeJsonl(path: string, rows: readonly unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : ""), "utf8");
}

async function run(args: PreRouterBenchArgs): Promise<number> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const benchRoot = resolve(REPO_ROOT, ".starlingai", "live-check", "pre-router-bench");
  const outDir = args.out ? outputPath(args.out) : join(benchRoot, stamp);
  await mkdir(outDir, { recursive: true });
  // This run's audit rows (every resolveAgentRouting logs one) and agent vectors stay out of the
  // gateway's files: its audit log is the repo-root .starlingai/audit.jsonl through the mount.
  process.env["SAI_AUDIT_LOG"] = join(outDir, "audit.jsonl");
  process.env["SAI_EMBEDDING_CACHE"] ??= join(benchRoot, "embedding-cache.json");

  const casesFile = args.cases
    ? inputPath(args.cases)
    : DEFAULT_CASES.map((path) => resolve(REPO_ROOT, path)).find((path) => existsSync(path));
  if (!casesFile || !existsSync(casesFile)) {
    throw new BenchUsageError(`no case file at ${casesFile ?? DEFAULT_CASES.join(" or ")}`);
  }
  const text = await readFile(casesFile, "utf8");
  let cases: RoutingEvalCase[];
  try {
    cases = parseCaseFile(text);
  } catch (err) {
    throw new BenchUsageError(`${casesFile}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const problems = lintCases(cases);
  if (problems.length > 0) throw new BenchUsageError(`the case file is not usable:\n  - ${problems.join("\n  - ")}`);
  if (args.limit !== undefined) cases = cases.slice(0, args.limit);

  const warnings: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const selected: Array<{ evalCase: RoutingEvalCase; gold: PreRouteGold; ask: boolean; train: boolean }> = [];
  for (const evalCase of cases) {
    const classified = preRouteGold(evalCase);
    if ("skip" in classified) {
      skipped.push({ id: evalCase.id, reason: classified.skip });
      continue;
    }
    const ask = inSplit(evalCase.id, args.split);
    const train = args.trainOut !== undefined && splitOf(evalCase.id) === "calibration";
    if (ask || train) selected.push({ evalCase, gold: classified.gold, ask, train });
  }
  if (args.split === "all") {
    warnings.push("Split all: valid for a checkpoint that was not trained on these cases. After fine-tuning on --train-out, re-run with --split test.");
  }

  // Loaded without its compiled copy: from the repo root that copy is ./starlingai.json, which the
  // live gateway reads through its mount. Everything that reads config at import comes after.
  const config = loadConfig({ skipCompiledWrite: true });
  // No promoted agents and no tripped circuit breakers from the live workspace: the bench routes
  // over the catalog the labels were written against.
  config.workspacePath = outDir;
  const { resolveAgentRouting, agentIsMetaFactory } = await import("../tools/agent-routing.js");
  const { buildAgentIndex, isEmbeddingAvailable, getEmbeddingSearchStatus, searchByEmbedding } = await import("../providers/embeddings.js");
  const { getEmbeddingProvider } = await import("../providers/index.js");
  const { getRerankerRunStatus } = await import("../retrieval/reranker.js");

  const agentCount = Object.keys(config.subAgents).length;
  process.stdout.write(`Catalog: ${agentCount} agents. Cases: ${casesFile} (${cases.length}, ${selected.length} selected, ${skipped.length} skipped).\n`);
  if (agentCount === 0) throw new EnvironmentError("the loaded config declares no sub-agents: run from the repo root, or `pnpm config:build`");
  const embeddingModel = config.agents.defaults.model.embeddingModel ?? "";
  if (!embeddingModel) throw new EnvironmentError("no embedding model is configured (agents.defaults.model.embeddingModel)");
  const provider = getEmbeddingProvider();
  try {
    await buildAgentIndex(config.subAgents, provider, embeddingModel);
  } catch (err) {
    throw new EnvironmentError(`the embedding index could not be built: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isEmbeddingAvailable()) {
    throw new EnvironmentError(`embedding search is unavailable: ${JSON.stringify(getEmbeddingSearchStatus())}`);
  }
  const readoutBackend = args.backend === "readout";
  const who = answererName(args.backend);
  // The readout: the routing tier the up-front source judge runs on, read by its logits.
  let askAnswerer: (built: BuiltPreRouteQuestion, timeoutMs?: number) => Promise<NonNullable<PreRouteObservation["laya"]> | { error: string }>
    = (built, timeoutMs) => askLaya(args.layaUrl, built, timeoutMs);
  let readoutModel: string | undefined;
  let health: Record<string, unknown> | null = null;
  if (!args.noLaya && readoutBackend) {
    const { resolveRoutingTierProvider } = await import("../agent/routing-tier-provider.js");
    const { askReadout } = await import("../decisions/logit-readout.js");
    const { runWithCallAttribution } = await import("../runtime/request-context.js");
    const readoutProvider = resolveRoutingTierProvider();
    readoutModel = config.agents.defaults.model.tiers?.["routing"] ?? config.agents.defaults.model.primary;
    const reachable = await readoutProvider.checkHealth().catch((err: unknown) => ({ healthy: false, error: err instanceof Error ? err.message : String(err) }));
    if (!reachable.healthy) throw new EnvironmentError(`the routing tier (${readoutModel}) is not reachable${reachable.error ? `: ${reachable.error}` : ""}`);
    health = { backend: "readout", model: readoutModel, ...reachable };
    askAnswerer = async (built, timeoutMs = LAYA_TIMEOUT_MS) => pickFromReadout(
      await runWithCallAttribution({ callSite: "routing_tier", agentName: "pre_router_readout" }, () =>
        askReadout(readoutProvider, built.request, built.request.state, { signal: AbortSignal.timeout(timeoutMs) })),
      built.keys,
      `readout:${readoutModel}`,
    );
  } else if (!args.noLaya) {
    health = await layaHealth(args.layaUrl);
  }
  let warmUp: { ms: number; model: string } | { error: string } | null = null;

  const describe = (name: string) => agentDescriptionText(config.subAgents[name], args.describe);
  const observations: PreRouteObservation[] = [];
  const questions: unknown[] = [];
  const trainingItems: TrainingItem[] = [];
  const noCandidates: string[] = [];
  let overWindow = 0;
  const reportPath = join(outDir, "report.json");
  const markdownPath = join(outDir, "report.md");
  const settings = {
    k: args.k,
    split: args.split,
    describe: args.describe,
    keying: args.keying,
    target: args.target,
    minSamples: args.minSamples,
    roundMs: args.roundMs,
    minCoverage: args.minCoverage,
    layaUrl: args.noLaya || readoutBackend ? null : args.layaUrl,
    casesFile,
    casesSha256: createHash("sha256").update(text).digest("hex"),
    ...(args.backend ? { backend: args.backend } : {}),
    ...(readoutModel ? { readoutModel } : {}),
  };
  const source = captureEvaluationSourceState(REPO_ROOT);
  const buildReport = () => buildPreRouteReport({
    settings,
    observations,
    loaded: cases.length,
    skipped,
    noCandidates,
    overWindow,
    layaSkipped: args.noLaya,
    warnings,
    environment: {
      gitRevision: source.revision ?? null,
      gitDirty: Boolean(source.status?.trim()),
      modelUrl: process.env["SAI_PRIMARY_MODEL_URL"] ?? null,
      embeddingModel,
      agentCount,
      reranker: getRerankerRunStatus(),
      laya: health,
      layaWarmUp: warmUp,
    },
  });

  let index = 0;
  let consecutiveFailures = 0;
  for (const { evalCase, gold, ask, train } of selected) {
    index += 1;
    const query = evalCase.query.trim();
    // The capsule exactly as the discovery prefetch resolves it (discovery-prefetch.ts).
    const started = performance.now();
    const resolution = await resolveAgentRouting(query, { minConfidence: "medium", allowKeywordFallback: false });
    const capsuleMs = Math.round(performance.now() - started);
    // An empty capsule because the embedding search failed is an outage, not a routing miss:
    // the case is left out and counted, and the verdict turns environment-suspect past a tenth.
    if (resolution.mode === "semantic_unavailable") {
      noCandidates.push(evalCase.id);
      continue;
    }
    const capsule = resolution.results.map((candidate) => candidate.name).filter((name) => !agentIsMetaFactory(name)).slice(0, CAPSULE_MAX_AGENTS);
    // The ranking the capsule was cut from, all of it: options past the floor, and recall at any K.
    const ranking = await searchByEmbedding(query, provider, agentCount);
    const scores = new Map(ranking.map((result) => [result.agentName, Math.max(0, (result.score + 1) / 2)]));
    const order = mergeCandidates(capsule, ranking.map((result) => result.agentName), agentCount, agentIsMetaFactory);
    const built = buildPreRouteQuestion({ id: evalCase.id, message: query, candidates: order, describe, k: args.k });
    if (!built) {
      noCandidates.push(evalCase.id);
      continue;
    }
    if (built.overWindow) overWindow += 1;
    const language = caseLanguage(evalCase);
    if (train) trainingItems.push(buildPreRouteTrainingItem(built, gold, language));
    if (!ask) continue;
    questions.push(built.request);
    const observation: PreRouteObservation = {
      id: evalCase.id,
      language,
      split: splitOf(evalCase.id),
      fold: foldOf(evalCase.id),
      gold,
      capsule,
      order,
      options: built.keys.filter((key) => key !== NONE_KEY),
      optionScores: built.keys.filter((key) => key !== NONE_KEY).map((key) => scores.get(key) ?? null),
      capsuleMs,
    };
    if (!args.noLaya) {
      if (warmUp === null) {
        // Untimed: the checkpoint may still be loading, and a cold first call is not what a turn pays.
        const first = await askAnswerer(built, WARM_UP_TIMEOUT_MS);
        warmUp = "error" in first ? { error: first.error } : { ms: first.ms, model: first.model };
        // A readout that read no answer off a list is a miss, not an outage; no list, or no call, is one.
        if ("error" in first && isAnswererOutage(first.error)) {
          throw new EnvironmentError(`${who}'s first answer failed: ${first.error}`);
        }
      }
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        observation.layaError = `not asked: the previous ${MAX_CONSECUTIVE_FAILURES} questions failed`;
      } else {
        const answer = await askAnswerer(built);
        if ("error" in answer) {
          observation.layaError = answer.error;
          // Only an outage trips the breaker. A readout's miss came with a top list, so the model is
          // up: five of them in a row must not leave every later case unasked.
          consecutiveFailures = isAnswererOutage(answer.error) ? consecutiveFailures + 1 : 0;
        } else {
          observation.laya = answer;
          consecutiveFailures = 0;
        }
      }
    }
    observations.push(observation);
    const pick = observation.laya ? `${observation.laya.choice} ${observation.laya.top.toFixed(2)}` : observation.layaError ?? "not asked";
    process.stdout.write(`[${index}/${selected.length}] ${evalCase.id} (${language}) capsule [${capsule.join(", ")}] -> ${pick}\n`);
  }

  // Production orders the capsule by the rerank blend; off the internal network the reranker never
  // answers, so the order (not the membership, in the default blend mode) is the embedding's alone.
  const rerank = getRerankerRunStatus();
  if (rerank.enabled && rerank.applied === 0 && rerank.attempted + rerank.skippedCircuitOpen > 0) {
    warnings.push(`The reranker answered none of ${rerank.attempted + rerank.skippedCircuitOpen} capsule queries (${rerank.lastError ?? "no error recorded"}): the capsule order is the embedding's, not production's blend.`);
  }
  const report = buildReport();
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  await writeFile(markdownPath, formatPreRouteMarkdown(report), "utf8");
  await writeJsonl(join(outDir, "questions.jsonl"), questions);
  if (args.trainOut !== undefined) {
    const target = outputPath(args.trainOut);
    await writeJsonl(target, trainingItems);
    process.stdout.write(`Wrote ${trainingItems.length} training items (calibration half) to ${target}\n`);
  }
  process.stdout.write(`\n${report.verdict.status}: ${report.verdict.reasons.join("; ")}\nReport: ${markdownPath}\n`);
  return report.verdict.code;
}

async function main(): Promise<number> {
  let args: PreRouterBenchArgs;
  try {
    args = parsePreRouterArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`Usage error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  try {
    return await run(args);
  } catch (err) {
    if (err instanceof BenchUsageError) {
      process.stderr.write(`Usage error: ${err.message}\n`);
      return 2;
    }
    if (err instanceof EnvironmentError) {
      process.stderr.write(`ENVIRONMENT-SUSPECT: ${err.message}\n`);
      return 3;
    }
    throw err;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((err: unknown) => {
      process.stderr.write(`Pre-router bench failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exitCode = 3;
    });
}
