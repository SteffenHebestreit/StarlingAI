import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateAgentPlan,
  compareEvaluationReports,
  formatEvaluationSummary,
  formatRegressionSummary,
  writeEvaluationReport,
  type AgentEvaluationReport,
} from "../agent/evaluation.js";

describe("agent evaluation harness", () => {
  it("records pass and fail outcomes with execution stats", async () => {
    const report = await evaluateAgentPlan({
      workspacePath: "/workspace",
      cases: [
        {
          name: "passing-case",
          agentName: "researcher",
          task: "Summarize the docs.",
          expectIncludes: ["LM Studio"],
          maxDurationMs: 1000,
        },
        {
          name: "failing-case",
          agentName: "coder",
          task: "Write code.",
          expectIncludes: ["success"],
          expectExcludes: ["forbidden"],
          maxDurationMs: 1,
        },
      ],
    }, async (opts) => ({
      output: opts.agentName === "researcher" ? "LM Studio tool use summary" : "forbidden output",
      stats: {
        agentName: opts.agentName,
        sessionId: `eval:${opts.agentName}`,
        promptChars: 120,
        userContentChars: opts.task.length,
        toolCount: 1,
        toolNames: ["web_search"],
        iterations: 1,
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        maxIterations: 4,
        model: "lmstudio/qwen3.5-9b",
        capabilities: ["analysis"],
      },
    }));

    expect(report.totalCases).toBe(2);
    expect(report.passedCases).toBe(1);
    expect(report.failedCases).toBe(1);
    expect(report.results[0]?.passed).toBe(true);
    expect(report.results[1]?.passed).toBe(false);
    expect(report.results[1]?.failures.some((failure) => failure.includes("missing expected text"))).toBe(true);
    expect(report.results[1]?.failures.some((failure) => failure.includes("contained forbidden text"))).toBe(true);

    const summary = formatEvaluationSummary(report);
    expect(summary).toContain("Passed 1/2 cases");
    expect(summary).toContain("passing-case");
    expect(summary).toContain("failing-case");
  });

  it("detects regressions between baseline and current reports", () => {
    const makeStats = (tokens: number) => ({
      agentName: "researcher",
      sessionId: "s1",
      promptChars: 100,
      userContentChars: 20,
      toolCount: 1,
      toolNames: ["web_search"],
      iterations: 1,
      usage: { promptTokens: tokens, completionTokens: tokens, totalTokens: tokens * 2 },
      maxIterations: 5,
      model: "test",
      capabilities: [],
    });

    const baseline: AgentEvaluationReport = {
      runId: "base-run",
      generatedAt: new Date().toISOString(),
      totalCases: 2,
      passedCases: 2,
      failedCases: 0,
      workspacePath: "/workspace",
      results: [
        { name: "case-a", agentName: "researcher", passed: true, durationMs: 1000, status: "passed", failures: [], outputPreview: "ok", stats: makeStats(50) },
        { name: "case-b", agentName: "coder", passed: true, durationMs: 2000, status: "passed", failures: [], outputPreview: "ok", stats: makeStats(100) },
      ],
    };

    const current: AgentEvaluationReport = {
      runId: "curr-run",
      generatedAt: new Date().toISOString(),
      totalCases: 3,
      passedCases: 1,
      failedCases: 2,
      workspacePath: "/workspace",
      results: [
        // case-a: newly failed
        { name: "case-a", agentName: "researcher", passed: false, durationMs: 900, status: "failed", failures: ["missing expected text: foo"], outputPreview: "bad", stats: makeStats(50) },
        // case-b: latency spike (3000 vs 2000 = +50%, exactly at threshold — should trigger >50%)
        { name: "case-b", agentName: "coder", passed: true, durationMs: 3100, status: "passed", failures: [], outputPreview: "ok", stats: makeStats(100) },
        // case-c: new case — not a regression
        { name: "case-c", agentName: "shell_agent", passed: true, durationMs: 500, status: "passed", failures: [], outputPreview: "ok", stats: makeStats(20) },
      ],
    };

    const regressions = compareEvaluationReports(baseline, current);
    expect(regressions.hasRegressions).toBe(true);

    const newlyFailed = regressions.findings.filter(f => f.kind === "case_newly_failed");
    expect(newlyFailed).toHaveLength(1);
    expect(newlyFailed[0]?.caseName).toBe("case-a");

    const latencySpike = regressions.findings.filter(f => f.kind === "latency_spike");
    expect(latencySpike).toHaveLength(1);
    expect(latencySpike[0]?.caseName).toBe("case-b");

    // case-c is new, should not be flagged
    expect(regressions.findings.some(f => f.caseName === "case-c")).toBe(false);

    const summary = formatRegressionSummary(regressions);
    expect(summary).toContain("2 regression(s) detected");
    expect(summary).toContain("case-a");
    expect(summary).toContain("case-b");
  });

  it("reports no regressions when current matches baseline", () => {
    const stats = {
      agentName: "researcher",
      sessionId: "s1",
      promptChars: 100,
      userContentChars: 20,
      toolCount: 1,
      toolNames: ["web_search"],
      iterations: 1,
      usage: { promptTokens: 50, completionTokens: 50, totalTokens: 100 },
      maxIterations: 5,
      model: "test",
      capabilities: [] as string[],
    };

    const report: AgentEvaluationReport = {
      runId: "run",
      generatedAt: new Date().toISOString(),
      totalCases: 1,
      passedCases: 1,
      failedCases: 0,
      workspacePath: "/workspace",
      results: [
        { name: "case-a", agentName: "researcher", passed: true, durationMs: 1000, status: "passed", failures: [], outputPreview: "ok", stats },
      ],
    };

    const regressions = compareEvaluationReports(report, report);
    expect(regressions.hasRegressions).toBe(false);
    expect(formatRegressionSummary(regressions)).toBe("No regressions detected.");
  });

  it("writes the evaluation report to disk", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-agent-eval-"));
    const outputPath = join(tempDir, "report.json");

    try {
      const report = await evaluateAgentPlan({
        workspacePath: "/workspace",
        cases: [],
      }, async () => ({
        output: "",
        stats: {
          agentName: "noop",
          sessionId: "noop",
          promptChars: 0,
          userContentChars: 0,
          toolCount: 0,
          toolNames: [],
          iterations: 0,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          maxIterations: 0,
          model: "",
          capabilities: [],
        },
      }));

      const writtenPath = await writeEvaluationReport(report, outputPath);
      expect(writtenPath).toBe(outputPath);

      const persisted = JSON.parse(readFileSync(outputPath, "utf8")) as { runId: string; totalCases: number };
      expect(persisted.runId).toBe(report.runId);
      expect(persisted.totalCases).toBe(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});