/// <reference types="node" />
/**
 * Live latency probe of the production model path (never in CI).
 *
 * It measures the prompt-processing facts that decide which restructuring pays off: what one
 * decision call costs (E1), how far cache reuse reaches (E2), whether small calls evict the
 * orchestrator head (E3), whether parallel small calls help (E4), whether an aborted incumbent is
 * free (E5), whether a prefill prewarm helps (E6), what a tool-subset switch costs (E7), which
 * rule decides whether a new conversation finds a sub-agent head cached (E8), and whether warming
 * the orchestrator's forced heads makes a forced turn warm (E9).
 * agent/latency-probe-scenarios.ts defines the calls and the verdicts; this file sends them and
 * writes the report.
 *
 * It talks to the endpoint the gateway uses (SAI_PRIMARY_MODEL_URL: llama-swap and its selector),
 * with raw requests in the shape the provider sends, because the provider drops the llama.cpp
 * `timings` that separate prompt processing, generation and waiting. Every prompt is synthetic;
 * report rows hold step names and numbers only.
 *
 * Usage (from the repo root; the package script changes there first):
 *   pnpm --filter @starlingai/core latency:probe [--base-url <url>] [--model <id>]
 *     [--experiments E1,E2,E3,E4,E5,E6,E7,E8,E9] [--reps 3] [--out <dir>] [--laya-ms 20] [--abort-ms 20]
 *     [--stagger-ms 1500] [--sub-agent image_creator] [--builder content_writer] [--turn-ms <ms>]
 *     [--max-minutes 15] [--timeout-ms 180000] [--no-restore]
 * E8 and E9 are not in the default set: each is a long run of its own (E8 grows five runs to up to
 * 6x a ~7.6k-token head per repetition and puts four other agents' conversations between one of
 * them and its new conversation, about 105 calls; E9 sends six 30k-token prompts in its
 * eviction arm), so they are named explicitly and given the time:
 *   latency:probe --experiments E8 --reps 3 --max-minutes 45
 *   latency:probe --experiments E9 --reps 3 --max-minutes 40
 * E8's answer depends on the server's --no-cache-idle-slots switch, which the report reads off
 * llama-swap's /running: run it once as the server is, and again after the switch changes.
 * --builder names the sub-agent whose staged-build head E8 uses.
 * --base-url defaults to SAI_PRIMARY_MODEL_URL (.env), --model to the configured primary model.
 * E2-E7 compare repetitions and need --reps 2 or more; at --reps 1 they come back inconclusive (E1
 * still answers, from one German and one English warm call per shape), so --reps 1 is a smoke run.
 * Load: calls run one after another except E4's (at most 4 in flight) and E6's prewarm beside its
 * call; about 200 calls and 8-10 minutes at --reps 3. Phases that would start after --max-minutes
 * are skipped and their experiments reported inconclusive. The warm-keeper's own request is sent
 * before the run (was the live head cached?) and after it (put it back), unless --no-restore.
 * Output: <out>/report.json and <out>/report.md, default .starlingai/live-check/latency-probe/<time>/.
 * Exit codes: 0 every experiment answered its question, 2 some could not (too few measurements,
 * mixed servers) or a usage mistake, 3 not a verdict (endpoint unreachable, no call succeeded, no
 * timings in the answers). 1 is not used: the probe measures, it gates nothing. pnpm reports every
 * non-zero code as 1, so the verdict is printed as well.
 */
// MUST be first: loads .env before config/loader.ts freezes its resolution (see that module).
import { REPO_ROOT } from "../agent/eval-env-bootstrap.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { captureEvaluationSourceState } from "../agent/evaluation-provenance.js";
import type * as Scenarios from "../agent/latency-probe-scenarios.js";
import { loadConfig } from "../config/loader.js";

class UsageError extends Error {}

const FLAGS_WITH_VALUE = new Set([
  "base-url", "model", "experiments", "reps", "out", "laya-ms", "abort-ms", "stagger-ms", "sub-agent", "builder", "turn-ms", "max-minutes", "timeout-ms",
]);
/** Long runs of their own: planned only when named (see the usage above). */
const OPT_IN_EXPERIMENTS = new Set(["E8", "E9"]);
const SWITCHES = new Set(["no-restore"]);

function parseArgs(argv: readonly string[]): { values: Map<string, string>; switches: Set<string> } {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) throw new UsageError(`unexpected argument "${arg}"`);
    const name = arg.slice(2);
    if (SWITCHES.has(name)) {
      switches.add(name);
      continue;
    }
    if (!FLAGS_WITH_VALUE.has(name)) throw new UsageError(`unknown flag --${name}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`--${name} needs a value`);
    values.set(name, value);
    i += 1;
  }
  return { values, switches };
}

function numberFlag(values: Map<string, string>, name: string, fallback: number, check: (n: number) => boolean, rule: string): number {
  const raw = values.get(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !check(n)) throw new UsageError(`--${name} takes ${rule} (got "${raw}")`);
  return n;
}

async function getJson(url: string, headers: Record<string, string>, timeoutMs: number, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers: { ...headers, ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatCall(r: Scenarios.CallResult): string {
  const head = `  ${r.experiment} r${r.rep} ${`${r.step} ${r.shape}`.padEnd(46)}`;
  if (r.status !== "ok") return `${head} ${r.status.toUpperCase()} after ${Math.round(r.wallMs)} ms${r.error ? `: ${r.error}` : ""}`;
  const t = r.timings;
  return `${head} ${String(Math.round(r.wallMs)).padStart(6)} ms`
    + (t ? `  prompt_n ${t.promptN}  cache_n ${t.cacheN ?? "?"}  prompt ${Math.round(t.promptMs)} ms  gen ${Math.round(t.predictedMs)} ms  queue ${Math.round(r.queueMs ?? 0)} ms` : "  (no timings)");
}

async function main(): Promise<void> {
  const { values, switches } = parseArgs(process.argv.slice(2));
  const baseUrl = (values.get("base-url") ?? process.env["SAI_PRIMARY_MODEL_URL"] ?? "").replace(/\/+$/, "");
  if (!baseUrl) throw new UsageError("no endpoint: pass --base-url or set SAI_PRIMARY_MODEL_URL (the probe never falls back to the container-only host.docker.internal)");
  const reps = numberFlag(values, "reps", 3, (n) => Number.isInteger(n) && n >= 1 && n <= 10, "a whole number from 1 to 10");
  const layaMs = numberFlag(values, "laya-ms", 20, (n) => n >= 0, "a number of milliseconds, 0 or more");
  const abortAfterMs = numberFlag(values, "abort-ms", 20, (n) => n >= 0, "a number of milliseconds, 0 or more");
  const prewarmStaggerMs = numberFlag(values, "stagger-ms", 1500, (n) => n >= 0, "a number of milliseconds, 0 or more");
  const maxMinutes = numberFlag(values, "max-minutes", 15, (n) => n > 0, "a number of minutes above 0");
  const callTimeoutMs = numberFlag(values, "timeout-ms", 180_000, (n) => n >= 1000, "a number of milliseconds, at least 1000");
  const turnMsRaw = values.get("turn-ms");
  const turnMs = turnMsRaw === undefined ? undefined : numberFlag(values, "turn-ms", 0, (n) => n > 0, "a number of milliseconds above 0");
  const subAgent = values.get("sub-agent") ?? "image_creator";
  const builder = values.get("builder") ?? "content_writer";
  const restore = !switches.has("no-restore");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outArg = values.get("out");
  const outDir = outArg ? (isAbsolute(outArg) ? outArg : resolve(REPO_ROOT, outArg)) : resolve(REPO_ROOT, ".starlingai", "live-check", "latency-probe", stamp);
  await mkdir(outDir, { recursive: true });
  // Whatever an imported module audits lands beside the report, never in the gateway's log.
  process.env["SAI_AUDIT_LOG"] = join(outDir, "audit.jsonl");

  const sourceState = captureEvaluationSourceState(REPO_ROOT);
  // Revision and a digest of the diff only: the diff itself can carry local secrets.
  const source = {
    revision: sourceState.revision?.trim() || null,
    dirty: Boolean(sourceState.status?.trim()),
    diffSha256: sourceState.diff ? createHash("sha256").update(sourceState.diff).digest("hex") : null,
  };

  // Loaded without its compiled copy before anything that loads it with one (image-agent-live-eval.ts).
  const config = loadConfig({ skipCompiledWrite: true });
  const S: typeof Scenarios = await import("../agent/latency-probe-scenarios.js");
  const { resolveProviderEndpoint } = await import("../providers/index.js");
  // The whole built-in tool surface: the orchestrator head carries the real tool schemas.
  await import("../tools/register-builtins.js");

  const experimentsArg = values.get("experiments");
  const experiments = experimentsArg
    ? [...new Set(experimentsArg.split(",").map((e) => e.trim().toUpperCase()).filter(Boolean))]
    : S.EXPERIMENT_IDS.filter((id) => !OPT_IN_EXPERIMENTS.has(id));
  for (const e of experiments) {
    if (!(S.EXPERIMENT_IDS as readonly string[]).includes(e)) throw new UsageError(`--experiments: unknown experiment "${e}" (known: ${S.EXPERIMENT_IDS.join(", ")})`);
  }
  const selected = experiments as Scenarios.ExperimentId[];
  if (selected.length === 0) throw new UsageError("--experiments names no experiment");

  const modelConfig = config.agents.defaults.model;
  const model = values.get("model") ?? (modelConfig.primary.split("/").slice(1).join("/") || modelConfig.primary);
  const apiKey = resolveProviderEndpoint(modelConfig).apiKey;
  const authHeaders: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const wire: Scenarios.WireOptions = {
    model,
    contextWindow: modelConfig.contextWindow,
    ...(modelConfig.maxTokens !== undefined ? { declaredMaxTokens: modelConfig.maxTokens } : {}),
  };

  const orchestratorHead = S.collectOrchestratorHead();
  let subAgentHead: Scenarios.HeadShape = { label: "sub_agent:(not used)", system: "", tools: [] };
  if (selected.includes("E6")) {
    try {
      subAgentHead = S.collectSubAgentShapedHead(subAgent);
    } catch (err) {
      throw new UsageError(`--sub-agent: ${describeError(err)}`);
    }
  }
  const { filterForcedOrchestrationTools } = await import("../agent/forced-orchestration-tools.js");
  let forcedSubsetTools: Scenarios.HeadShape["tools"] = [];
  if (selected.includes("E7")) {
    // The first forced iteration of a turn without a plan: record_plan offered, execute_plan withheld.
    forcedSubsetTools = filterForcedOrchestrationTools(orchestratorHead.tools, { planRecorded: false });
  }
  let stagedBuilderHead: Scenarios.HeadShape | undefined;
  if (selected.includes("E8")) {
    try {
      stagedBuilderHead = S.collectStagedBuilderHead(builder);
    } catch (err) {
      throw new UsageError(`--builder: ${describeError(err)}`);
    }
  }
  let forcedHeads: Scenarios.ForcedHeadSet | undefined;
  if (selected.includes("E9")) {
    // The warm-keeper's own heads, with the forced ones whatever the flag says: E9 is what decides
    // whether the flag should be turned on. The date line is the turn's own builder's.
    const { collectWarmHeads } = await import("../agent/cache-warmer.js");
    const { buildTemporalContextPrompt } = await import("../agent/runtime.js");
    const warm = collectWarmHeads({ forcedHeads: true });
    const pick = (label: string): Scenarios.MultiSystemHead => {
      const head = warm.find((h) => h.label === label);
      if (!head) throw new Error(`the warm-keeper built no "${label}" head (is the tool registry empty?)`);
      return { label, system: head.system.map((m) => String(m.content ?? "")), tools: head.tools };
    };
    const full = pick("full");
    forcedHeads = {
      full,
      plan: pick("forced_plan"),
      dispatch: pick("forced_dispatch"),
      literalSubsetTools: filterForcedOrchestrationTools(full.tools),
      temporal: buildTemporalContextPrompt(),
    };
  }
  const flat = (head: Scenarios.MultiSystemHead, label: string): Scenarios.HeadShape => ({ label, system: head.system.join("\n\n"), tools: head.tools });
  const heads: Scenarios.HeadShape[] = [
    orchestratorHead,
    ...(selected.includes("E6") ? [subAgentHead] : []),
    ...(selected.includes("E7") ? [{ label: "forced_subset", system: orchestratorHead.system, tools: forcedSubsetTools }] : []),
    ...(stagedBuilderHead ? [stagedBuilderHead] : []),
    ...(forcedHeads ? [flat(forcedHeads.plan, "forced_plan"), flat(forcedHeads.dispatch, "forced_dispatch")] : []),
  ];

  const runId = randomUUID().slice(0, 8);
  const ctx: Scenarios.PlanContext = {
    runId,
    reps,
    settings: S.collectDecisionSettings(),
    orchestratorHead,
    subAgentHead,
    forcedSubsetTools,
    abortAfterMs,
    prewarmStaggerMs,
    ...(stagedBuilderHead ? { stagedBuilderHead } : {}),
    ...(forcedHeads ? { forcedHeads } : {}),
  };
  const plans = selected.map((id) => S.buildExperimentPlan(id, ctx));
  const plannedCalls = plans.reduce((sum, plan) => sum + plan.phases.reduce((n, phase) => n + phase.calls.length, 0), 0);

  const server: Scenarios.ServerFacts = { errors: [] };
  const environmentReasons: string[] = [];
  const results: Scenarios.CallResult[] = [];
  const settings: Scenarios.ProbeReport["settings"] = {
    experiments: selected,
    reps,
    layaMs,
    abortAfterMs,
    prewarmStaggerMs,
    subAgent: selected.includes("E6") ? subAgent : null,
    builder: selected.includes("E8") ? builder : null,
    turnMs: turnMs ?? null,
    maxMinutes,
    callTimeoutMs,
    restore,
    thinking: "off (routing-tier controls)",
  };
  const reportPath = join(outDir, "report.json");
  const markdownPath = join(outDir, "report.md");
  const write = async (): Promise<Scenarios.ProbeReport> => {
    const report = S.buildProbeReport({
      generatedAt: new Date().toISOString(),
      runId,
      endpoint: { baseUrl, model },
      source,
      settings,
      server,
      heads,
      experiments: selected,
      results,
      verdictContext: { layaMs, ...(turnMs !== undefined ? { turnMs } : {}) },
      environmentReasons,
    });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(markdownPath, S.formatProbeMarkdown(report), "utf8");
    return report;
  };

  console.log(`latency probe ${runId}: ${baseUrl} model "${model}", ${selected.join(", ")} x reps ${reps}: ${plannedCalls} calls planned`);

  // Pre-flight: an unreachable endpoint is said once, plainly, and nothing is sent.
  try {
    const models = await getJson(`${baseUrl}/models`, authHeaders, 10_000);
    const ids = ((models as { data?: Array<{ id?: unknown }> })?.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
    server.models = ids;
    if (ids.length > 0 && !ids.includes(model)) console.warn(`  note: "${model}" is not among the endpoint's listed models (${ids.slice(0, 8).join(", ")}${ids.length > 8 ? ", ..." : ""})`);
  } catch (err) {
    environmentReasons.push(`the endpoint ${baseUrl} is unreachable: ${describeError(err)}`);
    await write();
    console.error(`\nENVIRONMENT: ${environmentReasons.join("; ")}\nNo call was sent. Report: ${markdownPath}`);
    process.exit(3);
  }

  // What the server says about itself, through llama-swap. Each is optional; a failure is noted.
  const origin = S.endpointOrigin(baseUrl);
  const upstream = `${origin}/upstream/${encodeURIComponent(model)}`;
  try {
    server.running = S.summarizeRunning(await getJson(`${origin}/running`, authHeaders, 5_000));
    if (server.running.length > 0) server.modelLoaded = server.running.some((r) => r.model === model);
  } catch (err) {
    server.errors.push(`/running: ${describeError(err)}`);
  }
  try {
    server.props = S.summarizeProps(await getJson(`${upstream}/props`, authHeaders, 10_000));
  } catch (err) {
    server.errors.push(`/props: ${describeError(err)}`);
  }
  try {
    const slots = S.summarizeSlots(await getJson(`${upstream}/slots`, authHeaders, 5_000));
    if (slots) server.slots = slots;
  } catch (err) {
    server.errors.push(`/slots: ${describeError(err)}`);
  }
  try {
    const rendered = await getJson(`${upstream}/apply-template`, authHeaders, 10_000, { method: "POST", body: S.renderOrderProbeBody() });
    server.renderOrder = S.detectRenderOrder((rendered as { prompt?: unknown })?.prompt);
  } catch (err) {
    server.errors.push(`/apply-template: ${describeError(err)}`);
  }
  console.log(`  server: slots ${server.props?.totalSlots ?? server.slots?.count ?? "?"}, ctx ${server.props?.nCtx ?? "?"}, tools render ${server.renderOrder ?? "?"}${server.modelLoaded === false ? `, "${model}" not loaded yet (the first call loads it)` : ""}`);

  const transport: Scenarios.ProbeTransport = {
    chatUrl: `${baseUrl}/chat/completions`,
    headers: authHeaders,
    fetchImpl: fetch,
    now: () => performance.now(),
    callTimeoutMs,
  };
  const execute = (request: Scenarios.ProbeRequest) => S.runProbeCall(S.buildWireBody(request, wire), request, transport);
  const runStartedAt = performance.now();
  const setupCall = async (step: typeof S.PRODUCTION_HEAD_BEFORE | typeof S.PRODUCTION_HEAD_AFTER): Promise<void> => {
    const request = S.productionHeadRequest(orchestratorHead, step);
    const startedAtMs = performance.now() - runStartedAt;
    const outcome = await execute(request);
    const queueMs = S.queueMsOf(outcome);
    const result: Scenarios.CallResult = {
      ...outcome, experiment: S.SETUP_EXPERIMENT, rep: 0, phase: 0, step, shape: request.shape, inFlight: 1, startedAtMs,
      ...(queueMs !== undefined ? { queueMs } : {}),
    };
    results.push(result);
    console.log(formatCall(result));
  };

  if (restore) await setupCall(S.PRODUCTION_HEAD_BEFORE);
  await S.runPlans(plans, execute, {
    now: () => performance.now(),
    runStartedAt,
    deadlineAt: runStartedAt + maxMinutes * 60_000,
    onPhase: async (phaseResults) => {
      results.push(...phaseResults);
      for (const r of phaseResults) if (r.status !== "skipped") console.log(formatCall(r));
      await write();
    },
  });
  if (restore) await setupCall(S.PRODUCTION_HEAD_AFTER);

  const report = await write();
  console.log("");
  for (const e of report.experiments) console.log(`${e.experiment} ${e.code}${e.conclusive ? "" : " (inconclusive)"}: ${e.answer}`);
  console.log(`\nVerdict: ${report.verdict}${report.environment.reasons.length ? ` (${report.environment.reasons.join("; ")})` : ""}`);
  console.log(`Report: ${markdownPath}\nJSON:   ${reportPath}`);
  process.exit(S.probeExitCode(report));
}

main().catch((err) => {
  if (err instanceof UsageError) {
    console.error(`usage: ${err.message}`);
    process.exit(2);
  }
  // Anything else stopped the run before it could be scored: not a verdict.
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(3);
});
