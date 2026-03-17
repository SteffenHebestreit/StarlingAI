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

async function main(): Promise<void> {
  const defaultPlanPath = resolve(process.cwd(), "agent-eval.jsonc");
  // Parse args: <plan.jsonc> [output.json] [--baseline baseline.json]
  const args = process.argv.slice(2);
  const planPath = args.find(a => !a.startsWith("--") && !args[args.indexOf(a) - 1]?.startsWith("--baseline"));
  const baselineIndex = args.indexOf("--baseline");
  const baselinePath = baselineIndex !== -1 ? args[baselineIndex + 1] : undefined;
  const explicitOutputPath = args.find((a, i) => !a.startsWith("--") && i !== baselineIndex + 1 && a !== planPath);
  const resolvedPlanPath = planPath ?? (existsSync(defaultPlanPath) ? defaultPlanPath : undefined);

  if (!resolvedPlanPath) {
    console.error("Usage: pnpm agents:evaluate [plan.jsonc] [output.json] [--baseline baseline.json]");
    console.error("If omitted, the CLI looks for ./agent-eval.jsonc in the current workspace.");
    process.exit(1);
  }

  const raw = await readFile(resolvedPlanPath, "utf8");
  const plan = JSON5.parse(raw) as AgentEvaluationPlan;
  const report = await evaluateAgentPlan(plan);

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
