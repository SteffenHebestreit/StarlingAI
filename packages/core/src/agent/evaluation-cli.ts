// MUST be first: loads .env before config/loader.ts freezes its resolution. See the
// module's own comment for why doing this inside main() is too late.
import { REPO_ROOT } from "./eval-env-bootstrap.js";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import JSON5 from "json5";
import {
  evaluateAgentPlan,
  compareEvaluationReports,
  formatEvaluationSummary,
  formatRegressionSummary,
  writeEvaluationReport,
  type AgentEvaluationPlan,
  type AgentEvaluationReport,
} from "./evaluation.js";
import { buildVersionedEvaluationReportPath } from "./evaluation-provenance.js";
import { createGatewayEvalRunner } from "./gateway-eval-runner.js";
import { agentReportEnvironment } from "./eval-report.js";

/** Resolve a user-supplied path: absolute wins, then cwd, then the repo root. */
function resolveInputPath(p: string, repoRoot: string): string {
  if (isAbsolute(p)) return p;
  const fromCwd = resolve(process.cwd(), p);
  if (existsSync(fromCwd)) return fromCwd;
  return resolve(repoRoot, p);
}

async function main(): Promise<void> {
  const repoRoot = REPO_ROOT;
  const defaultPlanPath = resolve(repoRoot, "agent-eval.jsonc");
  // Parse args: <plan.jsonc> [output.json] [--baseline baseline.json] [--repeat k]
  const args = process.argv.slice(2);
  const baselineIndex = args.indexOf("--baseline");
  const baselinePath = baselineIndex !== -1 ? args[baselineIndex + 1] : undefined;
  const repeatIndex = args.indexOf("--repeat");
  const repeatOverride = repeatIndex !== -1 ? Math.max(1, parseInt(args[repeatIndex + 1] ?? "", 10) || 1) : undefined;
  // A18: run a case's k attempts concurrently (artifact-free cases only). --concurrency
  // wins over SAI_EVAL_CONCURRENCY; both default to sequential.
  const concurrencyIndex = args.indexOf("--concurrency");
  const concurrencyOverride = concurrencyIndex !== -1
    ? Math.max(1, parseInt(args[concurrencyIndex + 1] ?? "", 10) || 1)
    : (process.env["SAI_EVAL_CONCURRENCY"] ? Math.max(1, parseInt(process.env["SAI_EVAL_CONCURRENCY"], 10) || 1) : undefined);
  // Gateway-routed eval: run each case through a live gateway (full runtime env)
  // instead of in-process. Needed for agents that touch docker/web/browser.
  // Opt-in cost-per-pass regression check (mean tokens ÷ passing attempts). Off by
  // default: existing baselines were recorded before stats were mean-aggregated, so
  // enabling it silently would compare against numbers that meant something else.
  // Re-baseline first, then pass this.
  const costCompare = args.includes("--cost-compare");
  const viaGateway = args.includes("--via-gateway");
  const gatewayUrlIndex = args.indexOf("--gateway-url");
  const gatewayUrl = (gatewayUrlIndex !== -1 ? args[gatewayUrlIndex + 1] : undefined) ?? "ws://localhost:8765/ws";
  const tokenIndex = args.indexOf("--token");
  const token = (tokenIndex !== -1 ? args[tokenIndex + 1] : undefined) ?? process.env["SAI_EVAL_GATEWAY_TOKEN"];
  // Positionals are non-flag args that aren't the VALUE of a flag.
  const flagValueIndices = new Set<number>();
  if (baselineIndex !== -1) flagValueIndices.add(baselineIndex + 1);
  if (repeatIndex !== -1) flagValueIndices.add(repeatIndex + 1);
  if (concurrencyIndex !== -1) flagValueIndices.add(concurrencyIndex + 1);
  if (gatewayUrlIndex !== -1) flagValueIndices.add(gatewayUrlIndex + 1);
  if (tokenIndex !== -1) flagValueIndices.add(tokenIndex + 1);
  const positionals = args.filter((a, i) => !a.startsWith("--") && !flagValueIndices.has(i));
  const planPath = positionals[0];
  const explicitOutputPath = positionals[1];
  const resolvedPlanPath = planPath
    ? resolveInputPath(planPath, repoRoot)
    : (existsSync(defaultPlanPath) ? defaultPlanPath : undefined);

  if (!resolvedPlanPath) {
    console.error("Usage: pnpm agents:evaluate [plan.jsonc] [output.json] [--baseline baseline.json] [--repeat k] [--cost-compare] [--record]");
    console.error("                            [--via-gateway [--gateway-url ws://host:8765/ws] [--token <jwt>]]");
    console.error("If omitted, the CLI looks for ./agent-eval.jsonc in the current workspace.");
    console.error("--repeat k runs each case k times and reports pass^k (reliability), not just pass@1.");
    console.error("--concurrency n runs a case's k attempts n-at-a-time (artifact-free cases only) — cuts");
    console.error("  pass^k wall-clock up to ~k×; latency regressions are not flagged under concurrency.");
    console.error("--via-gateway runs each case through a live gateway so agents get the full runtime env");
    console.error("  (docker/searxng/browser); needed to evaluate web/computer/docker/coordinator agents.");
    console.error("--record writes a versioned raw report under artifacts/evaluations/ when no output path is supplied.");
    process.exit(1);
  }

  const raw = await readFile(resolvedPlanPath, "utf8");
  const plan = JSON5.parse(raw) as AgentEvaluationPlan;
  if (repeatOverride !== undefined) plan.repeat = repeatOverride;
  if (concurrencyOverride !== undefined) plan.concurrency = concurrencyOverride;

  // Fail loudly on an empty agent catalog (in-process runs). runSubAgent returns
  // "Sub-agent 'X' is not defined in config.subAgents" as its OUTPUT rather than
  // throwing, so every case fails its expectIncludes and the run reads like the
  // AGENTS regressed. The usual cause is the wrong config being loaded — running
  // under `pnpm --filter` used to resolve packages/core/starlingai.json, an 8KB
  // stub with zero subAgents, instead of the real root config.
  if (!viaGateway) {
    const { getConfig } = await import("../config/loader.js");
    const catalogSize = Object.keys(getConfig().subAgents ?? {}).length;
    if (catalogSize === 0) {
      console.error("Aborting: the loaded config declares ZERO subAgents, so every case would fail with");
      console.error("\"Sub-agent '<name>' is not defined in config.subAgents\" — a config problem misreported");
      console.error("as an agent regression.");
      console.error(`Set SAI_CONFIG_PATH to the real config (repo root: ${resolve(repoRoot, "starlingai.json")}),`);
      console.error("or run `pnpm config:build` if it has not been generated yet.");
      process.exit(1);
    }
  }

  // Pre-flight (in-process runs only): one quick model-backend health check so a run
  // against an unreachable backend fails FAST with a clear reason, instead of every case
  // crashing with a cryptic "Sub-agent error:" and a misleading clean-baseline verdict.
  // --via-gateway routes through the gateway, which the connection check below covers.
  if (!viaGateway) {
    try {
      const { getChatProvider } = await import("../providers/index.js");
      const health = await getChatProvider().checkHealth();
      if (!health.healthy) {
        console.error(`\nPre-flight FAILED — the default chat model backend is unreachable${health.error ? ` (${health.error})` : ""}.`);
        console.error("Start your model backend (e.g. LM Studio with the configured model loaded) and check");
        console.error("SAI_CONFIG_PATH + the API key, or run with --via-gateway. Aborting before running the plan.");
        process.exit(1);
      }
    } catch (err) {
      // A failed health PROBE (vs an unhealthy verdict) shouldn't block a legit run.
      console.error(`\nPre-flight model check could not run (${err instanceof Error ? err.message : String(err)}); continuing.`);
    }
  }

  let gateway: ReturnType<typeof createGatewayEvalRunner> | undefined;
  if (viaGateway) {
    if (!token) {
      console.error("--via-gateway requires --token <jwt> or SAI_EVAL_GATEWAY_TOKEN (the dashboard JWT).");
      process.exit(1);
    }
    gateway = createGatewayEvalRunner({ url: gatewayUrl, token });
    console.log(`Running via gateway ${gatewayUrl} (agents execute in the full runtime environment).`);
  }

  let report: AgentEvaluationReport;
  try {
    report = await evaluateAgentPlan(plan, gateway?.runner, { transport: viaGateway ? "gateway" : "in_process" });
  } finally {
    gateway?.close();
  }

  console.log(formatEvaluationSummary(report));

  const outputPath = explicitOutputPath
    ?? plan.outputPath
    ?? (args.includes("--record") ? buildVersionedEvaluationReportPath("agent", report.generatedAt, report.provenance) : undefined);
  if (outputPath) {
    const writtenPath = await writeEvaluationReport(report, outputPath);
    console.log(`\nReport written to ${writtenPath}`);
  }

  // EVL-401: an environment-suspect run is NOT a pass/fail gate. Exit with a
  // distinct code (3) and refuse the baseline comparison — a "clean" comparison
  // against crashed cases would read as regressions fixed or introduced when the
  // truth is "the environment broke". The report is still written above so the
  // run's evidence is preserved.
  const environment = agentReportEnvironment(report);
  if (environment.suspect) {
    console.error("\nENVIRONMENT-SUSPECT RUN — refusing to gate on these results:");
    for (const reason of environment.reasons) console.error(`  - ${reason}`);
    console.error("Fix the environment (model backend, --via-gateway, run from the repo root) and re-run.");
    process.exit(3);
  }

  // Regression check against baseline if provided
  let hasRegressions = false;
  if (baselinePath) {
    let baseline: AgentEvaluationReport;
    try {
      const baselineRaw = await readFile(baselinePath, "utf8");
      baseline = JSON.parse(baselineRaw) as AgentEvaluationReport;
    } catch (err) {
      console.error(`\nWarning: could not load baseline from ${baselinePath}: ${String(err)}`);
      console.error("Skipping regression check.");
      if (report.failedCases > 0) process.exit(1);
      return;
    }

    const regressions = compareEvaluationReports(baseline, report, { costCompare });
    console.log(`\n${formatRegressionSummary(regressions)}`);
    if (regressions.hasRegressions) {
      hasRegressions = true;
    }
  }

  if (report.failedCases > 0 || hasRegressions) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
