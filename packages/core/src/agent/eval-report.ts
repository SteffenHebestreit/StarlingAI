/**
 * EVL-401: unified mission eval report envelope.
 *
 * The platform grew three eval harnesses with three report shapes (agent pass^k
 * plans, scene substring plans, runtime-guidance live evals). Cross-harness
 * tooling — dashboards, nightly suite aggregation (EVL-402), shadow/holdout lift
 * measurement (LRN-403) — needs ONE schema, and it needs runs that crashed on
 * environment (backend down, config unresolvable, scenes missing) to be REJECTED
 * as gates rather than read as quality signal.
 *
 * Slice 1: a normalized envelope + adapters from the agent and scene reports,
 * with environment-health reasons computed uniformly. Harness CLIs keep writing
 * their native reports (existing baselines stay valid) and additionally consume
 * these adapters for gating; EVL-402's suite aggregator consumes the envelope.
 */
import type { AgentEvaluationReport, RubricScores, WorkspaceChanges } from "./evaluation.js";
import type { SceneEvaluationReport } from "./scene-evaluation.js";
import type { EvaluationProvenance } from "./evaluation-provenance.js";

export type UnifiedEvalHarness = "agent" | "scene" | "pack";

export type UnifiedEvalCaseStatus =
  | "passed" | "flaky" | "failed" | "error" | "blocked" | "scene_missing";

export interface UnifiedEvalCase {
  name: string;
  /** What was evaluated: the agent name or scene name. */
  subject: string;
  status: UnifiedEvalCaseStatus;
  /** pass^k verdict (single-run pass at k=1). */
  passed: boolean;
  durationMs: number;
  failures: string[];
  attempts?: number;
  passCount?: number;
  workspaceChanges?: WorkspaceChanges;
  judgeScores?: RubricScores;
}

export interface UnifiedEvalEnvironment {
  /** True when the run cannot be trusted as a pass/fail gate. */
  suspect: boolean;
  /** Human-readable reasons; empty when healthy. */
  reasons: string[];
}

export interface UnifiedEvalReport {
  schemaVersion: 1;
  harness: UnifiedEvalHarness;
  /** EVL-402: the suite/pack this report belongs to (e.g. "race", "budget"),
   *  so PR/nightly/weekly runs of the same pack are directly comparable. */
  suite?: string;
  runId: string;
  generatedAt: string;
  summary: {
    total: number;
    passed: number;
    failed: number;
    flaky?: number;
    errored?: number;
    repeat?: number;
  };
  environment: UnifiedEvalEnvironment;
  provenance?: EvaluationProvenance;
  workspacePath: string;
  cases: UnifiedEvalCase[];
}

/** Fraction of cases that crashed at/above which a run is environment-suspect. */
const ENV_SUSPECT_ERROR_RATIO = 0.25;

/** Environment health for an agent-harness report. Beyond the crash-ratio rule,
 *  an all-failures-in-0ms run is flagged: it means the harness itself failed
 *  (config unresolvable, registry empty) before any agent did real work. */
export function agentReportEnvironment(report: AgentEvaluationReport): UnifiedEvalEnvironment {
  const reasons: string[] = [];
  const errored = report.erroredCases ?? report.results.filter((r) => r.status === "error").length;
  if (report.totalCases > 0 && errored / report.totalCases >= ENV_SUSPECT_ERROR_RATIO) {
    reasons.push(`${errored}/${report.totalCases} cases crashed (status "error") — model backend or runtime environment failure, not agent quality`);
  }
  const failures = report.results.filter((r) => !r.passed);
  if (report.totalCases > 0 && failures.length === report.totalCases && failures.every((r) => r.durationMs === 0)) {
    reasons.push("every case failed in 0ms — the harness failed before agents ran (config/registry resolution), not agent quality");
  }
  return { suspect: reasons.length > 0, reasons };
}

/** Environment health for a scene-harness report: crashed scenes and scenes the
 *  workspace doesn't define are environment/config problems, not scene quality. */
export function sceneReportEnvironment(report: SceneEvaluationReport): UnifiedEvalEnvironment {
  const reasons: string[] = [];
  const errored = report.results.filter((r) => r.status === "error").length;
  const missing = report.results.filter((r) => r.status === "scene_missing").length;
  if (report.totalCases > 0 && errored / report.totalCases >= ENV_SUSPECT_ERROR_RATIO) {
    reasons.push(`${errored}/${report.totalCases} scenes crashed (status "error") — runtime environment failure, not scene quality`);
  }
  if (report.totalCases > 0 && missing / report.totalCases >= ENV_SUSPECT_ERROR_RATIO) {
    reasons.push(`${missing}/${report.totalCases} scenes missing from the workspace — plan/workspace mismatch, not scene quality`);
  }
  return { suspect: reasons.length > 0, reasons };
}

export function unifyAgentReport(report: AgentEvaluationReport): UnifiedEvalReport {
  return {
    schemaVersion: 1,
    harness: "agent",
    runId: report.runId,
    generatedAt: report.generatedAt,
    summary: {
      total: report.totalCases,
      passed: report.passedCases,
      failed: report.failedCases,
      ...(report.flakyCases !== undefined ? { flaky: report.flakyCases } : {}),
      ...(report.erroredCases !== undefined ? { errored: report.erroredCases } : {}),
      ...(report.repeat !== undefined ? { repeat: report.repeat } : {}),
    },
    environment: agentReportEnvironment(report),
    ...(report.provenance ? { provenance: report.provenance } : {}),
    workspacePath: report.workspacePath,
    cases: report.results.map((r) => ({
      name: r.name,
      subject: r.agentName,
      status: r.status,
      passed: r.passed,
      durationMs: r.durationMs,
      failures: r.failures,
      ...(r.attempts !== undefined ? { attempts: r.attempts } : {}),
      ...(r.passCount !== undefined ? { passCount: r.passCount } : {}),
      ...(r.workspaceChanges ? { workspaceChanges: r.workspaceChanges } : {}),
      ...(r.judgeScores ? { judgeScores: r.judgeScores } : {}),
    })),
  };
}

export function unifySceneReport(report: SceneEvaluationReport): UnifiedEvalReport {
  return {
    schemaVersion: 1,
    harness: "scene",
    runId: report.runId,
    generatedAt: report.generatedAt,
    summary: {
      total: report.totalCases,
      passed: report.passedCases,
      failed: report.failedCases,
      errored: report.results.filter((r) => r.status === "error").length,
    },
    environment: sceneReportEnvironment(report),
    workspacePath: report.workspacePath,
    cases: report.results.map((r) => ({
      name: r.name,
      subject: r.sceneName,
      status: r.status,
      passed: r.passed,
      durationMs: r.durationMs,
      failures: r.failures,
    })),
  };
}
