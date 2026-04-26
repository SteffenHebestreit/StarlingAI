/**
 * Live-mode scene evaluation harness.
 *
 * Mirrors the agent evaluation harness (evaluation.ts) but for scenes:
 * each case names a scene from the workspace catalog, supplies parameter
 * overrides + optional context, and asserts on the resulting output and
 * orchestration metadata. Each case runs end-to-end through the real
 * `run_workflow` tool against the configured providers — slow, real,
 * non-deterministic, but the right signal for "does my edited scene
 * still actually deliver the goods?"
 *
 * For unit-test-style deterministic scene tests, see
 * `tests/scenario-harness.test.ts` which uses vitest's vi.mock() to stub
 * sub-agents.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { getConfig } from "../config/loader.js";
import { getTool, type ToolContext, type ToolResult } from "../tools/registry.js";

export interface SceneEvaluationCase {
  /** Human-readable name for the case (used in reports). */
  name: string;
  /** Scene name from workspace/scenes/*.jsonc. */
  sceneName: string;
  /** Optional parameter overrides for the scene's template substitution. */
  params?: Record<string, string>;
  /** Optional extra context appended to the first step's task. */
  context?: string;
  /** Optional override for workspace root (defaults to plan.workspacePath / config). */
  workspacePath?: string;
  /** Strings the final output must contain (case-insensitive). */
  expectIncludes?: string[];
  /** Strings the final output must NOT contain (case-insensitive). */
  expectExcludes?: string[];
  /** Optional max wall-clock duration in ms. */
  maxDurationMs?: number;
  /** Optional cap on tool calls executed during the scene. */
  maxToolCalls?: number;
  /** Expected boostrap agent (when set, the scene must dispatch via this agent). */
  expectedBootstrapAgent?: string;
  /** When true, the scene must complete without being blocked by HITL gates. */
  expectSuccess?: boolean;
  /** When true (default), HITL approval prompts are auto-approved during the eval. */
  autoApprove?: boolean;
}

export interface SceneEvaluationPlan {
  workspacePath?: string;
  outputPath?: string;
  cases: SceneEvaluationCase[];
}

export interface SceneEvaluationCaseResult {
  name: string;
  sceneName: string;
  passed: boolean;
  durationMs: number;
  status: "passed" | "failed" | "error" | "blocked" | "scene_missing";
  failures: string[];
  outputPreview: string;
  toolCallsExecuted: number;
  bootstrapAgent?: string;
  blocked: boolean;
}

export interface SceneEvaluationReport {
  runId: string;
  generatedAt: string;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  workspacePath: string;
  results: SceneEvaluationCaseResult[];
}

export type SceneRunner = (args: { name: string; params?: Record<string, string>; context?: string }, ctx: ToolContext) => Promise<ToolResult>;

const PREVIEW_MAX_CHARS = 240;

function preview(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, PREVIEW_MAX_CHARS);
}

function collectFailures(
  result: ToolResult,
  durationMs: number,
  testCase: SceneEvaluationCase,
): string[] {
  const failures: string[] = [];
  const output = String(result.output ?? "").toLowerCase();
  const metadata = result.metadata ?? {};
  const blocked = metadata["blocked"] === true;
  const toolCalls = typeof metadata["toolCallsExecuted"] === "number" ? metadata["toolCallsExecuted"] as number : 0;
  const bootstrapAgent = typeof metadata["bootstrapAgent"] === "string" ? metadata["bootstrapAgent"] as string : undefined;

  if (!result.success && testCase.expectSuccess !== false) {
    failures.push(`scene returned error: ${result.error ?? "(no error message)"}`);
  }
  if (blocked && testCase.expectSuccess !== false) {
    failures.push("scene was blocked by an approval gate");
  }
  for (const expected of testCase.expectIncludes ?? []) {
    if (!output.includes(expected.toLowerCase())) {
      failures.push(`missing expected text: "${expected}"`);
    }
  }
  for (const forbidden of testCase.expectExcludes ?? []) {
    if (output.includes(forbidden.toLowerCase())) {
      failures.push(`contained forbidden text: "${forbidden}"`);
    }
  }
  if (testCase.maxDurationMs !== undefined && durationMs > testCase.maxDurationMs) {
    failures.push(`duration ${durationMs}ms exceeded limit ${testCase.maxDurationMs}ms`);
  }
  if (testCase.maxToolCalls !== undefined && toolCalls > testCase.maxToolCalls) {
    failures.push(`tool calls ${toolCalls} exceeded limit ${testCase.maxToolCalls}`);
  }
  if (testCase.expectedBootstrapAgent && bootstrapAgent !== testCase.expectedBootstrapAgent) {
    failures.push(`bootstrap agent was '${bootstrapAgent ?? "(none)"}', expected '${testCase.expectedBootstrapAgent}'`);
  }
  return failures;
}

function defaultRunWorkflowRunner(): SceneRunner {
  return async (args, ctx) => {
    const tool = getTool("run_workflow");
    if (!tool) throw new Error("run_workflow tool is not registered");
    return tool.execute(
      {
        name: args.name,
        workflowType: "scene",
        params: args.params ?? {},
        context: args.context,
      },
      ctx,
    );
  };
}

/**
 * Build a ToolContext suitable for eval — auto-approves HITL prompts (or
 * denies them when autoApprove=false) and provides a stable session id.
 */
function buildEvalContext(
  workspacePath: string,
  testCase: SceneEvaluationCase,
): ToolContext {
  const autoApprove = testCase.autoApprove !== false;
  return {
    sessionId: `scene-eval:${randomUUID()}`,
    workspacePath,
    approvalCallback: async () => autoApprove,
    inputCallback: async () => "(eval auto-skip)",
  };
}

export async function evaluateScenePlan(
  plan: SceneEvaluationPlan,
  runner: SceneRunner = defaultRunWorkflowRunner(),
): Promise<SceneEvaluationReport> {
  const config = getConfig();
  const workspacePath = plan.workspacePath ?? config.workspacePath;
  const sceneCatalog = config.scenes ?? {};
  const results: SceneEvaluationCaseResult[] = [];

  for (const testCase of plan.cases) {
    if (!sceneCatalog[testCase.sceneName]) {
      results.push({
        name: testCase.name,
        sceneName: testCase.sceneName,
        passed: false,
        durationMs: 0,
        status: "scene_missing",
        failures: [`scene '${testCase.sceneName}' not found in workspace catalog`],
        outputPreview: "",
        toolCallsExecuted: 0,
        blocked: false,
      });
      continue;
    }

    const caseWorkspacePath = testCase.workspacePath ?? workspacePath;
    const ctx = buildEvalContext(caseWorkspacePath, testCase);
    const startedAt = Date.now();
    let result: ToolResult;
    try {
      result = await runner({
        name: testCase.sceneName,
        params: testCase.params,
        context: testCase.context,
      }, ctx);
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      results.push({
        name: testCase.name,
        sceneName: testCase.sceneName,
        passed: false,
        durationMs,
        status: "error",
        failures: [error instanceof Error ? error.message : String(error)],
        outputPreview: "",
        toolCallsExecuted: 0,
        blocked: false,
      });
      continue;
    }

    const durationMs = Date.now() - startedAt;
    const failures = collectFailures(result, durationMs, testCase);
    const metadata = result.metadata ?? {};
    const blocked = metadata["blocked"] === true;
    const toolCalls = typeof metadata["toolCallsExecuted"] === "number" ? metadata["toolCallsExecuted"] as number : 0;
    const bootstrapAgent = typeof metadata["bootstrapAgent"] === "string" ? metadata["bootstrapAgent"] as string : undefined;

    results.push({
      name: testCase.name,
      sceneName: testCase.sceneName,
      passed: failures.length === 0,
      durationMs,
      status: failures.length === 0 ? "passed" : (blocked ? "blocked" : "failed"),
      failures,
      outputPreview: preview(String(result.output ?? "")),
      toolCallsExecuted: toolCalls,
      bootstrapAgent,
      blocked,
    });
  }

  return {
    runId: randomUUID(),
    generatedAt: new Date().toISOString(),
    totalCases: results.length,
    passedCases: results.filter((r) => r.passed).length,
    failedCases: results.filter((r) => !r.passed).length,
    workspacePath,
    results,
  };
}

export async function writeSceneEvaluationReport(report: SceneEvaluationReport, outputPath: string): Promise<string> {
  const resolved = resolve(outputPath);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, JSON.stringify(report, null, 2), "utf8");
  return resolved;
}

// ── Regression comparison ────────────────────────────────────────────────────

export interface SceneRegressionFinding {
  caseName: string;
  sceneName: string;
  kind: "case_newly_failed" | "latency_spike" | "tool_call_spike" | "bootstrap_agent_changed";
  detail: string;
}

export interface SceneRegressionReport {
  hasRegressions: boolean;
  findings: SceneRegressionFinding[];
}

const LATENCY_REGRESSION_FACTOR = 1.5;
const TOOL_CALL_REGRESSION_FACTOR = 1.5;

export function compareSceneEvaluationReports(
  baseline: SceneEvaluationReport,
  current: SceneEvaluationReport,
): SceneRegressionReport {
  const findings: SceneRegressionFinding[] = [];
  const baselineByName = new Map(baseline.results.map((r) => [r.name, r]));

  for (const curr of current.results) {
    const base = baselineByName.get(curr.name);
    if (!base) continue;

    if (base.passed && !curr.passed) {
      findings.push({
        caseName: curr.name,
        sceneName: curr.sceneName,
        kind: "case_newly_failed",
        detail: `Previously passing case now fails: ${curr.failures.join("; ")}`,
      });
    }
    if (curr.passed && base.durationMs > 0 && curr.durationMs > base.durationMs * LATENCY_REGRESSION_FACTOR) {
      findings.push({
        caseName: curr.name,
        sceneName: curr.sceneName,
        kind: "latency_spike",
        detail: `Duration up ${Math.round(((curr.durationMs / base.durationMs) - 1) * 100)}% (${base.durationMs}ms → ${curr.durationMs}ms)`,
      });
    }
    if (curr.passed && base.toolCallsExecuted > 0 && curr.toolCallsExecuted > base.toolCallsExecuted * TOOL_CALL_REGRESSION_FACTOR) {
      findings.push({
        caseName: curr.name,
        sceneName: curr.sceneName,
        kind: "tool_call_spike",
        detail: `Tool calls up ${Math.round(((curr.toolCallsExecuted / base.toolCallsExecuted) - 1) * 100)}% (${base.toolCallsExecuted} → ${curr.toolCallsExecuted})`,
      });
    }
    if (curr.passed && base.bootstrapAgent && curr.bootstrapAgent && base.bootstrapAgent !== curr.bootstrapAgent) {
      findings.push({
        caseName: curr.name,
        sceneName: curr.sceneName,
        kind: "bootstrap_agent_changed",
        detail: `Bootstrap agent changed: ${base.bootstrapAgent} → ${curr.bootstrapAgent}`,
      });
    }
  }
  return { hasRegressions: findings.length > 0, findings };
}

export function formatSceneRegressionSummary(report: SceneRegressionReport): string {
  if (!report.hasRegressions) return "No scene regressions detected.";
  const lines = [`${report.findings.length} scene regression(s) detected:`, ""];
  for (const f of report.findings) {
    lines.push(`- [${f.kind}] ${f.caseName} [${f.sceneName}]: ${f.detail}`);
  }
  return lines.join("\n");
}

export function formatSceneEvaluationSummary(report: SceneEvaluationReport): string {
  const lines = [
    `Scene evaluation run ${report.runId}`,
    `Workspace: ${report.workspacePath}`,
    `Passed ${report.passedCases}/${report.totalCases} cases`,
    "",
  ];
  for (const result of report.results) {
    const callPart = result.toolCallsExecuted > 0 ? ` ${result.toolCallsExecuted} tool calls` : "";
    const agentPart = result.bootstrapAgent ? ` via ${result.bootstrapAgent}` : "";
    lines.push(`- ${result.name} [${result.sceneName}] ${result.status.toUpperCase()} in ${result.durationMs}ms${callPart}${agentPart}`);
    if (result.failures.length > 0) {
      lines.push(`  Failures: ${result.failures.join("; ")}`);
    }
    if (result.outputPreview) {
      lines.push(`  Preview: ${result.outputPreview}`);
    }
  }
  return lines.join("\n");
}
