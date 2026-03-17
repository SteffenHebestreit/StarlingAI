import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { getConfig } from "../config/loader.js";
import type { SubAgentRunOptions, SubAgentRunResult } from "./sub-agent.js";
import { runSubAgentWithStats } from "./sub-agent.js";

export interface AgentEvaluationCase {
  name: string;
  agentName: string;
  task: string;
  context?: string;
  workspacePath?: string;
  expectIncludes?: string[];
  expectExcludes?: string[];
  maxDurationMs?: number;
}

export interface AgentEvaluationPlan {
  workspacePath?: string;
  outputPath?: string;
  cases: AgentEvaluationCase[];
}

export interface AgentEvaluationCaseResult {
  name: string;
  agentName: string;
  passed: boolean;
  durationMs: number;
  status: "passed" | "failed" | "error";
  failures: string[];
  outputPreview: string;
  stats: SubAgentRunResult["stats"];
}

export interface AgentEvaluationReport {
  runId: string;
  generatedAt: string;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  workspacePath: string;
  results: AgentEvaluationCaseResult[];
}

export type AgentEvaluationRunner = (opts: SubAgentRunOptions) => Promise<SubAgentRunResult>;

function preview(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 240);
}

function collectFailures(resultText: string, durationMs: number, testCase: AgentEvaluationCase): string[] {
  const failures: string[] = [];

  if (resultText.startsWith("Sub-agent error:")) {
    failures.push("agent returned an execution error");
  }
  if (resultText.includes("reached the maximum number of tool-call iterations")) {
    failures.push("agent exhausted its tool-call budget");
  }
  for (const expected of testCase.expectIncludes ?? []) {
    if (!resultText.includes(expected)) {
      failures.push(`missing expected text: ${expected}`);
    }
  }
  for (const forbidden of testCase.expectExcludes ?? []) {
    if (resultText.includes(forbidden)) {
      failures.push(`contained forbidden text: ${forbidden}`);
    }
  }
  if (testCase.maxDurationMs !== undefined && durationMs > testCase.maxDurationMs) {
    failures.push(`duration ${durationMs}ms exceeded limit ${testCase.maxDurationMs}ms`);
  }

  return failures;
}

export async function evaluateAgentPlan(
  plan: AgentEvaluationPlan,
  runner: AgentEvaluationRunner = runSubAgentWithStats,
): Promise<AgentEvaluationReport> {
  const config = getConfig();
  const workspacePath = plan.workspacePath ?? config.workspacePath;
  const results: AgentEvaluationCaseResult[] = [];

  for (const testCase of plan.cases) {
    const startedAt = Date.now();
    const result = await runner({
      agentName: testCase.agentName,
      task: testCase.task,
      context: testCase.context,
      parentSessionId: `eval:${randomUUID()}`,
      workspacePath: testCase.workspacePath ?? workspacePath,
    });
    const durationMs = Date.now() - startedAt;
    const failures = collectFailures(result.output, durationMs, testCase);

    results.push({
      name: testCase.name,
      agentName: testCase.agentName,
      passed: failures.length === 0,
      durationMs,
      status: failures.length === 0 ? "passed" : result.output.startsWith("Sub-agent error:") ? "error" : "failed",
      failures,
      outputPreview: preview(result.output),
      stats: result.stats,
    });
  }

  return {
    runId: randomUUID(),
    generatedAt: new Date().toISOString(),
    totalCases: results.length,
    passedCases: results.filter((result) => result.passed).length,
    failedCases: results.filter((result) => !result.passed).length,
    workspacePath,
    results,
  };
}

export async function writeEvaluationReport(report: AgentEvaluationReport, outputPath: string): Promise<string> {
  const resolvedPath = resolve(outputPath);
  await mkdir(dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, JSON.stringify(report, null, 2), "utf8");
  return resolvedPath;
}

// ── Regression comparison ────────────────────────────────────────────────────

export interface RegressionFinding {
  caseName: string;
  agentName: string;
  kind: "case_newly_failed" | "latency_spike" | "token_spike";
  detail: string;
  baselineValue: number;
  currentValue: number;
}

export interface RegressionReport {
  hasRegressions: boolean;
  findings: RegressionFinding[];
}

const LATENCY_REGRESSION_FACTOR = 1.5; // >50% increase
const TOKEN_REGRESSION_FACTOR = 1.3;   // >30% increase

/**
 * Compare a new evaluation report against a saved baseline.
 * Returns all cases that newly failed, spiked in latency, or ballooned in tokens.
 * New cases (not in baseline) are never flagged as regressions.
 */
export function compareEvaluationReports(
  baseline: AgentEvaluationReport,
  current: AgentEvaluationReport,
): RegressionReport {
  const findings: RegressionFinding[] = [];
  const baselineByName = new Map(baseline.results.map(r => [r.name, r]));

  for (const curr of current.results) {
    const base = baselineByName.get(curr.name);
    if (!base) continue; // new case — not a regression

    if (base.passed && !curr.passed) {
      findings.push({
        caseName: curr.name,
        agentName: curr.agentName,
        kind: "case_newly_failed",
        detail: `Previously passing case now fails: ${curr.failures.join("; ")}`,
        baselineValue: 1,
        currentValue: 0,
      });
    }

    if (curr.passed && base.durationMs > 0 && curr.durationMs > base.durationMs * LATENCY_REGRESSION_FACTOR) {
      findings.push({
        caseName: curr.name,
        agentName: curr.agentName,
        kind: "latency_spike",
        detail: `Latency up ${Math.round(((curr.durationMs / base.durationMs) - 1) * 100)}% (${base.durationMs}ms → ${curr.durationMs}ms)`,
        baselineValue: base.durationMs,
        currentValue: curr.durationMs,
      });
    }

    const baseTokens = base.stats.usage?.totalTokens ?? 0;
    const currTokens = curr.stats.usage?.totalTokens ?? 0;
    if (curr.passed && baseTokens > 0 && currTokens > baseTokens * TOKEN_REGRESSION_FACTOR) {
      findings.push({
        caseName: curr.name,
        agentName: curr.agentName,
        kind: "token_spike",
        detail: `Token usage up ${Math.round(((currTokens / baseTokens) - 1) * 100)}% (${baseTokens} → ${currTokens} tokens)`,
        baselineValue: baseTokens,
        currentValue: currTokens,
      });
    }
  }

  return { hasRegressions: findings.length > 0, findings };
}

export function formatRegressionSummary(report: RegressionReport): string {
  if (!report.hasRegressions) return "No regressions detected.";
  const lines = [`${report.findings.length} regression(s) detected:`, ""];
  for (const f of report.findings) {
    lines.push(`- [${f.kind}] ${f.caseName} (${f.agentName}): ${f.detail}`);
  }
  return lines.join("\n");
}

export function formatEvaluationSummary(report: AgentEvaluationReport): string {
  const lines = [
    `Agent evaluation run ${report.runId}`,
    `Workspace: ${report.workspacePath}`,
    `Passed ${report.passedCases}/${report.totalCases} cases`,
    "",
  ];

  for (const result of report.results) {
    lines.push(`- ${result.name} [${result.agentName}] ${result.status.toUpperCase()} in ${result.durationMs}ms`);
    if (result.failures.length > 0) {
      lines.push(`  Failures: ${result.failures.join("; ")}`);
    }
    lines.push(`  Preview: ${result.outputPreview}`);
  }

  return lines.join("\n");
}