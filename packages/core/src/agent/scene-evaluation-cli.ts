/**
 * `pnpm scenes:evaluate [plan.jsonc] [output.json] [--baseline baseline.json]`
 *
 * Live-mode scene evaluation runner. Mirrors the agent eval CLI:
 *   - looks for ./scene-eval.jsonc when no plan path is given
 *   - prints a summary, optionally writes a JSON report, optionally
 *     compares to a baseline and exits non-zero on regression
 *
 * Each case in the plan executes the named scene end-to-end through
 * the real `run_workflow` tool against the configured providers, so
 * this is meant for periodic / pre-release runs rather than CI.
 */
import "dotenv/config";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import JSON5 from "json5";
import { loadConfig } from "../config/loader.js";
import { initEphemeralStore } from "../runtime/ephemeral-store/index.js";
import { initProviders } from "../providers/index.js";
import { syncWebhookTools } from "../tools/webhooks.js";

// Side-effect imports so the tool registry has every tool registered before
// the first scene call. Mirrors the bootstrap in src/index.ts but stops at
// what the eval needs (no HTTP listener, no workers).
import "../tools/filesystem.js";
import "../tools/shell.js";
import "../tools/ssh.js";
import "../tools/ssh-upload.js";
import "../tools/ssh-download.js";
import "../tools/service-check.js";
import "../tools/ansible.js";
import "../tools/ansible-task.js";
import "../tools/proxmox.js";
import "../tools/terraform.js";
import "../tools/kubernetes.js";
import "../tools/prometheus.js";
import "../tools/grafana.js";
import "../tools/github.js";
import "../tools/accessibility.js";
import "../tools/credentials.js";
import "../tools/sub-agent.js";
import "../tools/workflow-catalog.js";
import "../tools/memory.js";
import "../tools/workspace-search.js";
import "../tools/web.js";
import "../tools/navigation.js";
import "../tools/multimodal.js";
import "../tools/document-output.js";
import "../tools/website.js";
import "../tools/extractors.js";
import "../tools/artifact-emitters.js";
import "../tools/office-output.js";
import "../tools/bundle-zip.js";
import "../tools/computer-use.js";
import "../tools/telegram.js";
import "../tools/cron.js";
import "../tools/reminders.js";
import "../tools/timers.js";
import "../tools/http-request.js";
import "../tools/git.js";
import "../tools/messaging.js";
import "../tools/ask-user.js";
import "../tools/browser-assist.js";
import "../tools/run-test-suite.js";
import "../tools/log-stream.js";
import "../tools/translate-text.js";
import "../tools/mail.js";
import "../tools/calendar.js";
import "../tools/contacts.js";
import "../tools/agent-datastore.js";
import "../tools/graph.js";
import "../tools/timeseries.js";
import "../tools/research-scratch.js";
import "../tools/sql.js";
import "../tools/spreadsheet.js";
import "../tools/pdf-forms.js";
import "../tools/data-feeds/index.js";

import {
  evaluateScenePlan,
  compareSceneEvaluationReports,
  formatSceneEvaluationSummary,
  formatSceneRegressionSummary,
  writeSceneEvaluationReport,
  type SceneEvaluationPlan,
  type SceneEvaluationReport,
} from "./scene-evaluation.js";

interface ParsedArgs {
  planPath?: string;
  outputPath?: string;
  baselinePath?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {};
  let i = 0;
  const positional: string[] = [];
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg === "--baseline") {
      args.baselinePath = argv[i + 1];
      i += 2;
      continue;
    }
    positional.push(arg);
    i++;
  }
  if (positional[0]) args.planPath = positional[0];
  if (positional[1]) args.outputPath = positional[1];
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const defaultPlanPath = resolve(process.cwd(), "scene-eval.jsonc");
  const resolvedPlanPath = args.planPath
    ? resolve(args.planPath)
    : (existsSync(defaultPlanPath) ? defaultPlanPath : undefined);

  if (!resolvedPlanPath) {
    console.error("Usage: pnpm scenes:evaluate [plan.jsonc] [output.json] [--baseline baseline.json]");
    console.error("If omitted, the CLI looks for ./scene-eval.jsonc in the current workspace.");
    process.exit(1);
  }

  // Load config + ephemeral store + providers so scenes have what they need.
  loadConfig();
  await initEphemeralStore();
  await initProviders();
  syncWebhookTools();

  const raw = await readFile(resolvedPlanPath, "utf8");
  const plan = JSON5.parse(raw) as SceneEvaluationPlan;
  const report = await evaluateScenePlan(plan);

  console.log(formatSceneEvaluationSummary(report));

  const outputPath = args.outputPath ?? plan.outputPath;
  if (outputPath) {
    const writtenPath = await writeSceneEvaluationReport(report, outputPath);
    console.log(`\nReport written to ${writtenPath}`);
  }

  let hasRegressions = false;
  if (args.baselinePath) {
    let baseline: SceneEvaluationReport;
    try {
      const baselineRaw = await readFile(args.baselinePath, "utf8");
      baseline = JSON.parse(baselineRaw) as SceneEvaluationReport;
    } catch (err) {
      console.error(`\nWarning: could not load baseline from ${args.baselinePath}: ${String(err)}`);
      console.error("Skipping regression check.");
      if (report.failedCases > 0) process.exit(1);
      return;
    }

    const regressions = compareSceneEvaluationReports(baseline, report);
    console.log(`\n${formatSceneRegressionSummary(regressions)}`);
    if (regressions.hasRegressions) hasRegressions = true;
  }

  if (report.failedCases > 0 || hasRegressions) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
