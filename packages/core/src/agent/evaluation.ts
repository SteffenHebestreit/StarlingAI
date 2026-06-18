import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { getConfig } from "../config/loader.js";
import type { SubAgentRunOptions, SubAgentRunResult } from "./sub-agent.js";
import { runSubAgentWithStats } from "./sub-agent.js";
// Register the full built-in tool surface so evaluated agents can actually call
// their tools (write_file, generate_document, …). Without this the offline eval
// runs agents against an incomplete registry and silently mis-scores them.
import "../tools/register-builtins.js";

export interface AgentEvaluationCase {
  name: string;
  agentName: string;
  task: string;
  context?: string;
  workspacePath?: string;
  expectIncludes?: string[];
  expectExcludes?: string[];
  maxDurationMs?: number;
  /** Per-case override for how many times to run this case (reliability sampling). */
  repeat?: number;
  /** Inspect the file(s) the agent actually PRODUCED, not just its returned text —
   *  the only way to gate file-writing builders on deliverable completeness (a
   *  builder's reply is a summary+path, so expectIncludes can't see a dropped or
   *  truncated section). In-process eval only: the artifact must be in the case's
   *  workspace (a gateway-routed run writes inside the gateway container). */
  expectArtifact?: ExpectArtifact | ExpectArtifact[];
}

export interface ExpectArtifact {
  /** Workspace-relative file OR directory the agent must have produced. */
  path: string;
  /** Substrings that must ALL appear in the artifact's text. For a directory the
   *  contained text files are concatenated, so this catches dropped/stubbed
   *  sections across a multi-page deliverable. */
  includes?: string[];
  /** Minimum total artifact text size (bytes) — catches truncated/stub output. */
  minBytes?: number;
}

export interface AgentEvaluationPlan {
  workspacePath?: string;
  outputPath?: string;
  /** Default number of runs per case (reliability sampling). 1 = legacy pass@1.
   *  With k>1 the report adds pass^k (all k runs pass) and pass@k (any run passes). */
  repeat?: number;
  cases: AgentEvaluationCase[];
}

export interface AgentEvaluationCaseResult {
  name: string;
  agentName: string;
  /** Reliability verdict: true only when ALL attempts passed (pass^k). At repeat=1
   *  this is identical to the legacy single-run pass/fail. */
  passed: boolean;
  /** Mean wall-clock across attempts (equals the single run at repeat=1). */
  durationMs: number;
  status: "passed" | "flaky" | "failed" | "error";
  failures: string[];
  outputPreview: string;
  stats: SubAgentRunResult["stats"];
  /** Reliability sampling (added by evaluateAgentPlan; optional so legacy report
   *  literals stay valid). attempts=k; passCount=how many of k passed. */
  attempts?: number;
  passCount?: number;
  /** pass^k — every attempt passed (the reliability metric the 2026 literature favors). */
  passCaretK?: boolean;
  /** pass@k — at least one attempt passed. */
  passAtK?: boolean;
  runDurationsMs?: number[];
}

export interface AgentEvaluationReport {
  runId: string;
  generatedAt: string;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  /** Effective default repeat for the run (per-case overrides may differ). Optional
   *  so legacy report literals stay valid; evaluateAgentPlan always sets it. */
  repeat?: number;
  /** Cases where every attempt passed (pass^k). Equals passedCases. */
  reliableCases?: number;
  /** Cases that passed at least once but not every time (0 < passCount < attempts). */
  flakyCases?: number;
  workspacePath: string;
  results: AgentEvaluationCaseResult[];
}

export type AgentEvaluationRunner = (opts: SubAgentRunOptions) => Promise<SubAgentRunResult>;

function preview(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 240);
}

/** Read an artifact's text: a file → its content; a directory → the concatenated
 *  text of its files (recursive), so multi-page/multi-file deliverables are checked
 *  as one body. Returns "" if missing/unreadable. */
function readArtifactText(absPath: string): string {
  try {
    const st = statSync(absPath);
    if (st.isFile()) return readFileSync(absPath, "utf8");
    if (st.isDirectory()) {
      let combined = "";
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, entry.name);
          if (entry.isDirectory()) walk(p);
          else { try { combined += readFileSync(p, "utf8") + "\n"; } catch { /* skip binary/unreadable */ } }
        }
      };
      walk(absPath);
      return combined;
    }
  } catch { /* missing path */ }
  return "";
}

/** Remove the case's expected artifact paths so each pass^k attempt starts clean —
 *  otherwise a later attempt would "pass" on an earlier attempt's leftover files,
 *  masking a regression. Only deletes inside the eval workspace. */
function clearArtifacts(workspacePath: string, testCase: AgentEvaluationCase): void {
  const spec = testCase.expectArtifact;
  if (spec === undefined) return;
  const specs = Array.isArray(spec) ? spec : [spec];
  for (const s of specs) {
    try { rmSync(resolve(workspacePath, s.path), { recursive: true, force: true }); } catch { /* nothing to clear */ }
  }
}

/** Inspect produced artifact files against the case's expectArtifact spec(s). */
function checkArtifacts(workspacePath: string, testCase: AgentEvaluationCase): string[] {
  const spec = testCase.expectArtifact;
  const specs = spec === undefined ? [] : Array.isArray(spec) ? spec : [spec];
  const failures: string[] = [];
  for (const s of specs) {
    const abs = resolve(workspacePath, s.path);
    if (!existsSync(abs)) { failures.push(`expected artifact not produced: ${s.path}`); continue; }
    const text = readArtifactText(abs);
    const bytes = Buffer.byteLength(text, "utf8");
    if (s.minBytes !== undefined && bytes < s.minBytes) {
      failures.push(`artifact ${s.path} is ${bytes}B (< ${s.minBytes}B — likely truncated/stub)`);
    }
    for (const inc of s.includes ?? []) {
      if (!text.includes(inc)) failures.push(`artifact ${s.path} missing expected content: ${inc}`);
    }
  }
  return failures;
}

function collectFailures(resultText: string, durationMs: number, testCase: AgentEvaluationCase, workspacePath: string): string[] {
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
  failures.push(...checkArtifacts(workspacePath, testCase));

  return failures;
}

export async function evaluateAgentPlan(
  plan: AgentEvaluationPlan,
  runner: AgentEvaluationRunner = runSubAgentWithStats,
): Promise<AgentEvaluationReport> {
  const config = getConfig();
  const workspacePath = plan.workspacePath ?? config.workspacePath;
  const planRepeat = Math.max(1, Math.floor(plan.repeat ?? 1));
  const results: AgentEvaluationCaseResult[] = [];

  for (const testCase of plan.cases) {
    const attempts = Math.max(1, Math.floor(testCase.repeat ?? planRepeat));
    const runDurationsMs: number[] = [];
    let passCount = 0;
    let firstFailures: string[] = [];
    let sawError = false;
    let lastResult: SubAgentRunResult | undefined;

    // Run the case k times so we can report pass^k (reliability), not just pass@1.
    // Each attempt gets a fresh session so runs are independent.
    for (let attempt = 0; attempt < attempts; attempt++) {
      // Start each attempt from a clean slate so artifact checks reflect THIS run.
      clearArtifacts(testCase.workspacePath ?? workspacePath, testCase);
      const startedAt = Date.now();
      const result = await runner({
        agentName: testCase.agentName,
        task: testCase.task,
        context: testCase.context,
        parentSessionId: `eval:${randomUUID()}`,
        workspacePath: testCase.workspacePath ?? workspacePath,
      });
      const durationMs = Date.now() - startedAt;
      runDurationsMs.push(durationMs);
      lastResult = result;
      const failures = collectFailures(result.output, durationMs, testCase, testCase.workspacePath ?? workspacePath);
      if (result.output.startsWith("Sub-agent error:")) sawError = true;
      if (failures.length === 0) passCount++;
      else if (firstFailures.length === 0) firstFailures = failures;
    }

    const passCaretK = passCount === attempts;
    const passAtK = passCount > 0;
    const meanDurationMs = Math.round(runDurationsMs.reduce((a, b) => a + b, 0) / runDurationsMs.length);
    const status: AgentEvaluationCaseResult["status"] = passCaretK
      ? "passed"
      : passAtK
        ? "flaky"
        : sawError ? "error" : "failed";

    results.push({
      name: testCase.name,
      agentName: testCase.agentName,
      passed: passCaretK,
      durationMs: meanDurationMs,
      status,
      failures: passCaretK ? [] : firstFailures,
      outputPreview: preview(lastResult?.output ?? ""),
      stats: lastResult!.stats,
      attempts,
      passCount,
      passCaretK,
      passAtK,
      runDurationsMs,
    });
  }

  return {
    runId: randomUUID(),
    generatedAt: new Date().toISOString(),
    totalCases: results.length,
    passedCases: results.filter((result) => result.passed).length,
    failedCases: results.filter((result) => !result.passed).length,
    repeat: planRepeat,
    reliableCases: results.filter((result) => result.passCaretK).length,
    flakyCases: results.filter((result) => result.passAtK && !result.passCaretK).length,
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

/** Median run duration — robust to the cold-start outlier that skews the mean on
 *  small pass^k samples (a single process-warmup run shouldn't read as a latency
 *  regression when the typical run is unchanged). Falls back to the stored mean. */
function medianDurationMs(result: AgentEvaluationCaseResult): number {
  const runs = result.runDurationsMs;
  if (!runs || runs.length === 0) return result.durationMs;
  const sorted = [...runs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

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

    const baseLatency = medianDurationMs(base);
    const currLatency = medianDurationMs(curr);
    if (curr.passed && baseLatency > 0 && currLatency > baseLatency * LATENCY_REGRESSION_FACTOR) {
      findings.push({
        caseName: curr.name,
        agentName: curr.agentName,
        kind: "latency_spike",
        detail: `Median latency up ${Math.round(((currLatency / baseLatency) - 1) * 100)}% (${baseLatency}ms → ${currLatency}ms)`,
        baselineValue: baseLatency,
        currentValue: currLatency,
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
    (report.repeat ?? 1) > 1
      ? `Reliable (pass^${report.repeat}) ${report.reliableCases ?? report.passedCases}/${report.totalCases} · flaky ${report.flakyCases ?? 0} · repeat=${report.repeat}`
      : `Passed ${report.passedCases}/${report.totalCases} cases`,
    "",
  ];

  for (const result of report.results) {
    const kSuffix = (result.attempts ?? 1) > 1 ? ` pass^k=${result.passCount}/${result.attempts}` : "";
    lines.push(`- ${result.name} [${result.agentName}] ${result.status.toUpperCase()}${kSuffix} in ${result.durationMs}ms`);
    if (result.failures.length > 0) {
      lines.push(`  Failures: ${result.failures.join("; ")}`);
    }
    lines.push(`  Preview: ${result.outputPreview}`);
  }

  return lines.join("\n");
}