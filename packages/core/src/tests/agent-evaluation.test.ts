import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
        model: "lmstudio/qwen/qwen3.5-9b",
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

  const statsFor = (agentName: string, task: string) => ({
    agentName, sessionId: `eval:${agentName}`, promptChars: 100, userContentChars: task.length,
    toolCount: 1, toolNames: ["web_search"], iterations: 1,
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    maxIterations: 4, model: "test", capabilities: [] as string[],
  });

  it("reports pass^k: a case that passes every run is reliable, not just pass@1", async () => {
    const report = await evaluateAgentPlan({
      workspacePath: "/workspace",
      repeat: 3,
      cases: [{ name: "stable", agentName: "researcher", task: "summarize", expectIncludes: ["OK"] }],
    }, async (opts) => ({ output: "OK result", stats: statsFor(opts.agentName, opts.task) }));

    const r = report.results[0]!;
    expect(r.attempts).toBe(3);
    expect(r.passCount).toBe(3);
    expect(r.passCaretK).toBe(true);
    expect(r.passAtK).toBe(true);
    expect(r.passed).toBe(true);
    expect(report.repeat).toBe(3);
    expect(report.reliableCases).toBe(1);
    expect(report.flakyCases).toBe(0);
    expect(formatEvaluationSummary(report)).toContain("Reliable (pass^3) 1/1");
  });

  it("classifies a case that passes only sometimes as FLAKY (fails pass^k)", async () => {
    let call = 0;
    const report = await evaluateAgentPlan({
      workspacePath: "/workspace",
      repeat: 4,
      cases: [{ name: "intermittent", agentName: "coder", task: "do it", expectIncludes: ["DONE"] }],
    }, async (opts) => {
      call += 1;
      // Pass on calls 1 and 3, fail on 2 and 4 → 2/4.
      const output = call % 2 === 1 ? "DONE" : "still working";
      return { output, stats: statsFor(opts.agentName, opts.task) };
    });

    const r = report.results[0]!;
    expect(r.attempts).toBe(4);
    expect(r.passCount).toBe(2);
    expect(r.passCaretK).toBe(false); // not reliable
    expect(r.passAtK).toBe(true);     // but passed at least once
    expect(r.passed).toBe(false);     // pass^k governs `passed`
    expect(r.status).toBe("flaky");
    expect(report.flakyCases).toBe(1);
    expect(report.reliableCases).toBe(0);
    expect(formatEvaluationSummary(report)).toContain("pass^k=2/4");
  });

  function concurrencyProbe() {
    let inFlight = 0, maxInFlight = 0;
    const runner = async (opts: { agentName: string; task: string }) => {
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10)); // hold so concurrent attempts overlap
      inFlight -= 1;
      return { output: "OK", stats: statsFor(opts.agentName, opts.task) };
    };
    return { runner, getMax: () => maxInFlight };
  }

  it("A18: runs a case's k attempts CONCURRENTLY when concurrency>1, keeping pass^k intact", async () => {
    const probe = concurrencyProbe();
    const report = await evaluateAgentPlan({
      workspacePath: "/workspace", repeat: 4, concurrency: 4,
      cases: [{ name: "stable", agentName: "researcher", task: "t", expectIncludes: ["OK"] }],
    }, probe.runner);
    expect(probe.getMax()).toBeGreaterThan(1); // attempts overlapped
    expect(report.concurrency).toBe(4);
    expect(report.results[0]?.passCount).toBe(4); // aggregation across concurrent attempts is correct
    expect(report.results[0]?.passCaretK).toBe(true);
  });

  it("A18: runs attempts SEQUENTIALLY by default (concurrency unset = 1)", async () => {
    const probe = concurrencyProbe();
    await evaluateAgentPlan({
      workspacePath: "/workspace", repeat: 4,
      cases: [{ name: "s", agentName: "researcher", task: "t", expectIncludes: ["OK"] }],
    }, probe.runner);
    expect(probe.getMax()).toBe(1);
  });

  it("a per-case repeat overrides the plan default; repeat=1 stays legacy pass@1", async () => {
    const report = await evaluateAgentPlan({
      workspacePath: "/workspace",
      repeat: 1,
      cases: [{ name: "override", agentName: "researcher", task: "t", repeat: 2, expectIncludes: ["X"] }],
    }, async (opts) => ({ output: "X", stats: statsFor(opts.agentName, opts.task) }));
    expect(report.results[0]?.attempts).toBe(2);
    expect(report.repeat).toBe(1);
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

  it("A18: suppresses latency-spike findings when either run used concurrency>1", () => {
    const stats = {
      agentName: "researcher", sessionId: "s1", promptChars: 100, userContentChars: 20,
      toolCount: 1, toolNames: ["web_search"], iterations: 1,
      usage: { promptTokens: 50, completionTokens: 50, totalTokens: 100 },
      maxIterations: 5, model: "test", capabilities: [] as string[],
    };
    const base: AgentEvaluationReport = {
      runId: "b", generatedAt: new Date().toISOString(), totalCases: 1, passedCases: 1, failedCases: 0,
      concurrency: 1, workspacePath: "/workspace",
      results: [{ name: "a", agentName: "researcher", passed: true, durationMs: 1000, status: "passed", failures: [], outputPreview: "ok", stats, runDurationsMs: [1000] }],
    };
    const current: AgentEvaluationReport = {
      runId: "c", generatedAt: new Date().toISOString(), totalCases: 1, passedCases: 1, failedCases: 0,
      concurrency: 4, workspacePath: "/workspace",
      results: [{ name: "a", agentName: "researcher", passed: true, durationMs: 5000, status: "passed", failures: [], outputPreview: "ok", stats, runDurationsMs: [5000] }],
    };
    // 5× slower, but the concurrent run's per-attempt wall-clock is contended → not a regression.
    const reg = compareEvaluationReports(base, current);
    expect(reg.findings.some((f) => f.kind === "latency_spike")).toBe(false);
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

describe("agent evaluation harness — artifact inspection (expectArtifact)", () => {
  // The mock runner doesn't write files; the test pre-creates the artifacts the
  // agent would have produced, so we exercise the inspection logic deterministically.
  const benignRunner = async (opts: { agentName: string; task: string }) => ({
    output: "Wrote the document.",
    stats: {
      agentName: opts.agentName, sessionId: "s", promptChars: 0, userContentChars: opts.task.length,
      toolCount: 1, toolNames: ["write_file"], iterations: 1,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      maxIterations: 5, model: "test", capabilities: [] as string[],
    },
  });

  // The runner writes the artifact DURING the run (as a real agent would, after the
  // per-attempt clear), via the writeFn each test supplies.
  async function runWithWorkspace(ws: string, expectArtifact: unknown, writeFn?: () => void) {
    const runner = async (opts: { agentName: string; task: string }) => { writeFn?.(); return benignRunner(opts); };
    return evaluateAgentPlan({
      workspacePath: ws,
      cases: [{ name: "build", agentName: "content_writer", task: "write it", expectArtifact: expectArtifact as never }],
    }, runner);
  }

  it("passes when a single artifact file exists with the expected content + size", async () => {
    const ws = mkdtempSync(join(tmpdir(), "sai-artifact-"));
    try {
      const r = await runWithWorkspace(ws, { path: "generated/doc.md", includes: ["Introduction", "Conclusion"], minBytes: 20 }, () => {
        mkdirSync(join(ws, "generated"), { recursive: true });
        writeFileSync(join(ws, "generated/doc.md"), "# Guide\n## Introduction\n...\n## Conclusion\nThe end.", "utf8");
      });
      expect(r.results[0]?.passed).toBe(true);
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  it("FAILS when the artifact was not produced", async () => {
    const ws = mkdtempSync(join(tmpdir(), "sai-artifact-"));
    try {
      const r = await runWithWorkspace(ws, { path: "generated/missing.md", includes: ["x"] }); // runner writes nothing
      expect(r.results[0]?.passed).toBe(false);
      expect(r.results[0]?.failures.join(" ")).toMatch(/not produced/);
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  it("FAILS when a required section is missing (the content_writer over-trim case)", async () => {
    const ws = mkdtempSync(join(tmpdir(), "sai-artifact-"));
    try {
      const r = await runWithWorkspace(ws, { path: "generated/doc.md", includes: ["Introduction", "Conclusion"] }, () => {
        mkdirSync(join(ws, "generated"), { recursive: true });
        // Dropped the Introduction section — exactly what the trimmed prompt did.
        writeFileSync(join(ws, "generated/doc.md"), "## Algorithms\n...\n## Conclusion\nend", "utf8");
      });
      expect(r.results[0]?.passed).toBe(false);
      expect(r.results[0]?.failures.join(" ")).toMatch(/missing expected content: Introduction/);
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  it("FAILS a truncated/stub artifact via minBytes", async () => {
    const ws = mkdtempSync(join(tmpdir(), "sai-artifact-"));
    try {
      const r = await runWithWorkspace(ws, { path: "generated/doc.md", minBytes: 1000 }, () => {
        mkdirSync(join(ws, "generated"), { recursive: true });
        writeFileSync(join(ws, "generated/doc.md"), "stub", "utf8");
      });
      expect(r.results[0]?.passed).toBe(false);
      expect(r.results[0]?.failures.join(" ")).toMatch(/likely truncated\/stub/);
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  it("keeps artifact cases SEQUENTIAL even under concurrency (no workspace race) (A18)", async () => {
    const ws = mkdtempSync(join(tmpdir(), "sai-artifact-"));
    try {
      let inFlight = 0, maxInFlight = 0;
      const runner = async (opts: { agentName: string; task: string }) => {
        inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
        mkdirSync(join(ws, "generated"), { recursive: true });
        writeFileSync(join(ws, "generated/doc.md"), "## Introduction\nbody", "utf8");
        await new Promise((r) => setTimeout(r, 10));
        inFlight -= 1;
        return { output: "done", stats: (await benignRunner(opts)).stats };
      };
      const r = await evaluateAgentPlan({
        workspacePath: ws, repeat: 3, concurrency: 4,
        cases: [{ name: "build", agentName: "content_writer", task: "t", expectArtifact: { path: "generated/doc.md", includes: ["Introduction"] } }],
      }, runner);
      expect(maxInFlight).toBe(1); // artifact case forced sequential despite concurrency:4
      expect(r.results[0]?.passCaretK).toBe(true);
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  it("checks a DIRECTORY artifact as the concatenated content of its files (multi-page sites)", async () => {
    const ws = mkdtempSync(join(tmpdir(), "sai-artifact-"));
    try {
      const r = await runWithWorkspace(ws, { path: "generated/site", includes: ["Introduction", "Conclusion"] }, () => {
        const dir = join(ws, "generated/site");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "index.html"), "<h1>Introduction</h1>", "utf8");
        writeFileSync(join(dir, "section7.html"), "<h2>Conclusion</h2>", "utf8");
      });
      expect(r.results[0]?.passed).toBe(true);
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  it("clears artifacts between pass^k attempts so a stale file can't mask a later regression", async () => {
    const ws = mkdtempSync(join(tmpdir(), "sai-artifact-"));
    try {
      mkdirSync(join(ws, "generated"), { recursive: true });
      let call = 0;
      const writeOnceRunner = async (opts: { agentName: string; task: string }) => {
        call += 1;
        if (call === 1) writeFileSync(join(ws, "generated/doc.md"), "## Introduction\nfull content", "utf8");
        return { output: "done", stats: (await benignRunner(opts)).stats };
      };
      const r = await evaluateAgentPlan({
        workspacePath: ws,
        repeat: 2,
        cases: [{ name: "b", agentName: "content_writer", task: "t", expectArtifact: { path: "generated/doc.md", includes: ["Introduction"] } }],
      }, writeOnceRunner);
      // Attempt 1 writes + passes; attempt 2 starts cleared and writes nothing → fails.
      // Without clearing, attempt 2 would falsely pass on attempt 1's leftover file.
      expect(r.results[0]?.passCount).toBe(1);
      expect(r.results[0]?.passCaretK).toBe(false);
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });
});