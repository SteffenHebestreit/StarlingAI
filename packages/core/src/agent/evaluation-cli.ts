import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
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
import { createGatewayEvalRunner } from "./gateway-eval-runner.js";

async function main(): Promise<void> {
  const defaultPlanPath = resolve(process.cwd(), "agent-eval.jsonc");
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
  const resolvedPlanPath = planPath ?? (existsSync(defaultPlanPath) ? defaultPlanPath : undefined);

  if (!resolvedPlanPath) {
    console.error("Usage: pnpm agents:evaluate [plan.jsonc] [output.json] [--baseline baseline.json] [--repeat k]");
    console.error("                            [--via-gateway [--gateway-url ws://host:8765/ws] [--token <jwt>]]");
    console.error("If omitted, the CLI looks for ./agent-eval.jsonc in the current workspace.");
    console.error("--repeat k runs each case k times and reports pass^k (reliability), not just pass@1.");
    console.error("--concurrency n runs a case's k attempts n-at-a-time (artifact-free cases only) — cuts");
    console.error("  pass^k wall-clock up to ~k×; latency regressions are not flagged under concurrency.");
    console.error("--via-gateway runs each case through a live gateway so agents get the full runtime env");
    console.error("  (docker/searxng/browser); needed to evaluate web/computer/docker/coordinator agents.");
    process.exit(1);
  }

  const raw = await readFile(resolvedPlanPath, "utf8");
  const plan = JSON5.parse(raw) as AgentEvaluationPlan;
  if (repeatOverride !== undefined) plan.repeat = repeatOverride;
  if (concurrencyOverride !== undefined) plan.concurrency = concurrencyOverride;

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
    report = await evaluateAgentPlan(plan, gateway?.runner);
  } finally {
    gateway?.close();
  }

  console.log(formatEvaluationSummary(report));

  const outputPath = explicitOutputPath ?? plan.outputPath;
  if (outputPath) {
    const writtenPath = await writeEvaluationReport(report, outputPath);
    console.log(`\nReport written to ${writtenPath}`);
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

    const regressions = compareEvaluationReports(baseline, report);
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
