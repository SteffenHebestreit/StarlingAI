/**
 * EVL-401: unified eval report envelope + environment-health gating.
 */
import { describe, expect, it } from "vitest";
import {
  agentReportEnvironment,
  sceneReportEnvironment,
  unifyAgentReport,
  unifySceneReport,
} from "../agent/eval-report.js";
import type { AgentEvaluationReport, AgentEvaluationCaseResult } from "../agent/evaluation.js";
import type { SceneEvaluationReport } from "../agent/scene-evaluation.js";

const stats = {
  agentName: "a", sessionId: "s", promptChars: 0, userContentChars: 0, toolCount: 0,
  toolNames: [], iterations: 1, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  maxIterations: 10, model: "m", capabilities: [], terminalState: "completed",
} as AgentEvaluationCaseResult["stats"];

function agentCase(over: Partial<AgentEvaluationCaseResult>): AgentEvaluationCaseResult {
  return {
    name: "case", agentName: "code_analyst", passed: true, durationMs: 1200,
    status: "passed", failures: [], outputPreview: "", stats, ...over,
  };
}

function agentReport(results: AgentEvaluationCaseResult[]): AgentEvaluationReport {
  return {
    runId: "r1", generatedAt: "2026-07-17T00:00:00.000Z",
    totalCases: results.length,
    passedCases: results.filter((r) => r.passed).length,
    failedCases: results.filter((r) => !r.passed).length,
    erroredCases: results.filter((r) => r.status === "error").length,
    workspacePath: "/w", results,
  };
}

describe("agentReportEnvironment", () => {
  it("healthy run: no reasons, not suspect", () => {
    const env = agentReportEnvironment(agentReport([agentCase({}), agentCase({ passed: false, status: "failed", failures: ["missing expected text: x"] })]));
    expect(env.suspect).toBe(false);
    expect(env.reasons).toEqual([]);
  });

  it("crash ratio at/above 25% is environment-suspect", () => {
    const results = [
      agentCase({ passed: false, status: "error", failures: ["agent returned an execution error"] }),
      agentCase({}), agentCase({}), agentCase({}),
    ];
    const env = agentReportEnvironment(agentReport(results));
    expect(env.suspect).toBe(true);
    expect(env.reasons[0]).toContain("1/4 cases crashed");
  });

  it("all failures in 0ms flags a harness failure even with zero crashes", () => {
    const results = [
      agentCase({ passed: false, status: "failed", durationMs: 0 }),
      agentCase({ passed: false, status: "failed", durationMs: 0 }),
    ];
    const env = agentReportEnvironment(agentReport(results));
    expect(env.suspect).toBe(true);
    expect(env.reasons.some((r) => r.includes("0ms"))).toBe(true);
  });

  it("a fast run that PASSES is not flagged by the 0ms rule", () => {
    const env = agentReportEnvironment(agentReport([agentCase({ durationMs: 0 })]));
    expect(env.suspect).toBe(false);
  });
});

describe("sceneReportEnvironment", () => {
  function sceneReport(statuses: SceneEvaluationReport["results"][number]["status"][]): SceneEvaluationReport {
    const results = statuses.map((status, i) => ({
      name: `c${i}`, sceneName: "scene", passed: status === "passed", durationMs: 100,
      status, failures: [], outputPreview: "", toolCallsExecuted: 0, blocked: false,
    }));
    return {
      runId: "r2", generatedAt: "2026-07-17T00:00:00.000Z",
      totalCases: results.length,
      passedCases: results.filter((r) => r.passed).length,
      failedCases: results.filter((r) => !r.passed).length,
      workspacePath: "/w", results,
    };
  }

  it("missing scenes are an environment problem, not scene quality", () => {
    const env = sceneReportEnvironment(sceneReport(["scene_missing", "passed", "passed"]));
    expect(env.suspect).toBe(true);
    expect(env.reasons[0]).toContain("missing from the workspace");
  });

  it("ordinary failures do not trip the gate", () => {
    const env = sceneReportEnvironment(sceneReport(["failed", "passed", "passed", "passed"]));
    expect(env.suspect).toBe(false);
  });
});

describe("unify adapters", () => {
  it("agent report maps to the envelope with pass^k and receipts intact", () => {
    const report = agentReport([agentCase({
      attempts: 3, passCount: 2, passed: false, status: "flaky",
      workspaceChanges: { added: [], modified: ["receipts.py"], deleted: [] },
    })]);
    report.repeat = 3;
    const unified = unifyAgentReport(report);
    expect(unified.schemaVersion).toBe(1);
    expect(unified.harness).toBe("agent");
    expect(unified.summary).toMatchObject({ total: 1, passed: 0, failed: 1, repeat: 3 });
    expect(unified.cases[0]).toMatchObject({
      subject: "code_analyst", status: "flaky", attempts: 3, passCount: 2,
      workspaceChanges: { modified: ["receipts.py"] },
    });
  });

  it("scene report maps to the same envelope shape", () => {
    const unified = unifySceneReport({
      runId: "r3", generatedAt: "2026-07-17T00:00:00.000Z", totalCases: 1, passedCases: 1,
      failedCases: 0, workspacePath: "/w",
      results: [{
        name: "c", sceneName: "reviewed_deliverable", passed: true, durationMs: 5,
        status: "passed", failures: [], outputPreview: "", toolCallsExecuted: 2, blocked: false,
      }],
    });
    expect(unified.harness).toBe("scene");
    expect(unified.cases[0]).toMatchObject({ subject: "reviewed_deliverable", status: "passed", passed: true });
    expect(unified.environment.suspect).toBe(false);
  });
});
