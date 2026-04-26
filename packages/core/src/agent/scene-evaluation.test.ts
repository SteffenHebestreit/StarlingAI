import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("scene evaluation harness", () => {
  const cleanup: string[] = [];

  beforeEach(() => {
    cleanup.length = 0;
  });

  afterEach(() => {
    for (const dir of cleanup.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    delete process.env["SAI_CONFIG_PATH"];
    // resetModules so CONFIG_SOURCE (cached at loader-module load) is recomputed
    // against the next test's SAI_CONFIG_PATH instead of carrying the previous
    // path forward.
    vi.resetModules();
  });

  /**
   * Write a temp starlingai.json with the given scenes catalog, point
   * SAI_CONFIG_PATH at it, and return helpers that import the eval module
   * AFTER the env var is set (so the loader resolves the right config).
   */
  async function setupConfigWithScenes(scenes: Record<string, unknown>) {
    const ws = mkdtempSync(join(tmpdir(), "sai-scene-eval-"));
    cleanup.push(ws);
    const cfgPath = join(ws, "starlingai.json");
    writeFileSync(cfgPath, JSON.stringify({
      workspacePath: ws,
      agents: {
        defaults: { model: { primary: "mock-model" } },
        ephemeralGeneration: {
          enabled: false,
          skillMatchThreshold: 0.7,
          architectAgentName: "agent_architect",
        },
      },
      subAgents: {
        researcher: {
          description: "Test researcher.",
          capabilities: ["research"],
          tags: ["research"],
          tools: ["web_search"],
          maxIterations: 3,
        },
        summarizer: {
          description: "Test summarizer.",
          capabilities: ["summary"],
          tags: ["summary"],
          tools: ["read_file"],
          maxIterations: 3,
        },
      },
      scenes,
    }), "utf-8");
    process.env["SAI_CONFIG_PATH"] = cfgPath;
    vi.resetModules();
    const { loadConfig } = await import("../config/loader.js");
    loadConfig();
    return ws;
  }

  it("flags scene_missing when a referenced scene isn't in the catalog", async () => {
    await setupConfigWithScenes({});
    const { evaluateScenePlan } = await import("./scene-evaluation.js");
    const report = await evaluateScenePlan({
      cases: [{ name: "missing", sceneName: "does_not_exist" }],
    });
    expect(report.totalCases).toBe(1);
    expect(report.passedCases).toBe(0);
    expect(report.results[0]?.status).toBe("scene_missing");
    expect(report.results[0]?.failures[0]).toContain("not found");
  });

  it("passes when assertions match the runner's output", async () => {
    await setupConfigWithScenes({
      sample_scene: {
        description: "Sample scene used by the harness test.",
        task: "Do the thing for {{topic}}.",
        params: { topic: { description: "subject", default: "default-topic" } },
        allowedAgents: ["summarizer"],
      },
    });
    const { evaluateScenePlan } = await import("./scene-evaluation.js");

    const report = await evaluateScenePlan({
      cases: [
        {
          name: "ok",
          sceneName: "sample_scene",
          params: { topic: "alpha" },
          expectIncludes: ["alpha", "completed"],
          expectExcludes: ["I cannot"],
          maxDurationMs: 5000,
          maxToolCalls: 5,
          expectedBootstrapAgent: "summarizer",
          autoApprove: true,
        },
      ],
    }, async (args) => ({
      success: true,
      output: `Workflow ${args.name} [scene] completed via summarizer bootstrap.\n\nDelivered topic=${args.params?.topic ?? "?"}.`,
      metadata: {
        workflowName: args.name,
        workflowType: "scene",
        blocked: false,
        toolCallsExecuted: 3,
        bootstrapAgent: "summarizer",
        stepCount: 1,
      },
    }));

    expect(report.passedCases).toBe(1);
    expect(report.failedCases).toBe(0);
    expect(report.results[0]?.status).toBe("passed");
    expect(report.results[0]?.bootstrapAgent).toBe("summarizer");
    expect(report.results[0]?.toolCallsExecuted).toBe(3);
  });

  it("reports failures for missing-text, forbidden-text, latency, tool-cap, and wrong-bootstrap", async () => {
    await setupConfigWithScenes({
      sample_scene: {
        description: "Sample scene.",
        task: "Do {{topic}}.",
        params: { topic: { description: "x", default: "x" } },
        allowedAgents: ["summarizer"],
      },
    });
    const { evaluateScenePlan } = await import("./scene-evaluation.js");

    let mockDuration = 0;
    const slowRunner = async () => {
      const start = Date.now();
      while (Date.now() - start < mockDuration) { /* spin */ }
      return {
        success: true,
        output: "Workflow ok completed. Final answer: I cannot help with that request.",
        metadata: { blocked: false, toolCallsExecuted: 99, bootstrapAgent: "researcher" },
      };
    };

    mockDuration = 50;
    const report = await evaluateScenePlan({
      cases: [
        {
          name: "fails-many",
          sceneName: "sample_scene",
          expectIncludes: ["this string never appears"],
          expectExcludes: ["I cannot"],
          maxDurationMs: 1,            // will exceed
          maxToolCalls: 5,             // will exceed
          expectedBootstrapAgent: "summarizer",
        },
      ],
    }, slowRunner);

    expect(report.passedCases).toBe(0);
    expect(report.failedCases).toBe(1);
    const failures = report.results[0]?.failures ?? [];
    expect(failures.some((f) => f.includes("missing expected text"))).toBe(true);
    expect(failures.some((f) => f.includes("contained forbidden text"))).toBe(true);
    expect(failures.some((f) => f.includes("duration"))).toBe(true);
    expect(failures.some((f) => f.includes("tool calls"))).toBe(true);
    expect(failures.some((f) => f.includes("bootstrap agent"))).toBe(true);
  });

  it("marks scenes blocked by HITL approval as blocked, not passed", async () => {
    await setupConfigWithScenes({
      gated: {
        description: "Gated.",
        task: "Apply",
        allowedAgents: ["summarizer"],
        humanInLoopSteps: ["sql_query"],
      },
    });
    const { evaluateScenePlan } = await import("./scene-evaluation.js");

    const report = await evaluateScenePlan({
      cases: [{ name: "blocked-case", sceneName: "gated", autoApprove: false }],
    }, async () => ({
      success: false,
      output: "Workflow gated [scene] blocked.",
      error: "blocked by approval gate",
      metadata: { blocked: true, toolCallsExecuted: 0, bootstrapAgent: "summarizer" },
    }));

    expect(report.passedCases).toBe(0);
    expect(report.results[0]?.status).toBe("blocked");
    expect(report.results[0]?.failures.some((f) => f.includes("approval gate"))).toBe(true);
  });

  it("regression compare flags newly-failing cases, latency spikes, tool-call spikes, and bootstrap changes", async () => {
    const { compareSceneEvaluationReports } = await import("./scene-evaluation.js");
    const baseline = {
      runId: "b",
      generatedAt: "2026-04-26T00:00:00Z",
      totalCases: 4,
      passedCases: 4,
      failedCases: 0,
      workspacePath: "/ws",
      results: [
        { name: "fast", sceneName: "s", passed: true, durationMs: 1000, status: "passed" as const, failures: [], outputPreview: "", toolCallsExecuted: 5, bootstrapAgent: "researcher", blocked: false },
        { name: "stable", sceneName: "s", passed: true, durationMs: 2000, status: "passed" as const, failures: [], outputPreview: "", toolCallsExecuted: 6, bootstrapAgent: "summarizer", blocked: false },
        { name: "agent-pin", sceneName: "s", passed: true, durationMs: 1500, status: "passed" as const, failures: [], outputPreview: "", toolCallsExecuted: 4, bootstrapAgent: "researcher", blocked: false },
        { name: "ok-then-broken", sceneName: "s", passed: true, durationMs: 800, status: "passed" as const, failures: [], outputPreview: "", toolCallsExecuted: 3, bootstrapAgent: "summarizer", blocked: false },
      ],
    };
    const current = {
      ...baseline,
      runId: "c",
      generatedAt: "2026-04-26T01:00:00Z",
      results: [
        { ...baseline.results[0]!, durationMs: 4000 },                                                   // latency spike
        { ...baseline.results[1]!, toolCallsExecuted: 20 },                                              // tool spike
        { ...baseline.results[2]!, bootstrapAgent: "summarizer" },                                      // bootstrap changed
        { ...baseline.results[3]!, passed: false, status: "failed" as const, failures: ["missing X"] }, // newly failed
      ],
    };

    const report = compareSceneEvaluationReports(baseline, current);
    expect(report.hasRegressions).toBe(true);
    const kinds = report.findings.map((f) => f.kind).sort();
    expect(kinds).toEqual([
      "bootstrap_agent_changed",
      "case_newly_failed",
      "latency_spike",
      "tool_call_spike",
    ]);
  });

  it("formatSceneEvaluationSummary renders a readable per-case summary", async () => {
    const { formatSceneEvaluationSummary } = await import("./scene-evaluation.js");
    const summary = formatSceneEvaluationSummary({
      runId: "abc",
      generatedAt: "2026-04-26T00:00:00Z",
      totalCases: 2,
      passedCases: 1,
      failedCases: 1,
      workspacePath: "/ws",
      results: [
        { name: "ok", sceneName: "s", passed: true, durationMs: 1234, status: "passed", failures: [], outputPreview: "Final answer", toolCallsExecuted: 4, bootstrapAgent: "summarizer", blocked: false },
        { name: "bad", sceneName: "s", passed: false, durationMs: 999, status: "failed", failures: ["missing expected text: x"], outputPreview: "Did not include x", toolCallsExecuted: 0, blocked: false },
      ],
    });
    expect(summary).toContain("Passed 1/2 cases");
    expect(summary).toContain("ok [s] PASSED in 1234ms 4 tool calls via summarizer");
    expect(summary).toContain("bad [s] FAILED in 999ms");
    expect(summary).toContain("missing expected text: x");
    expect(summary).toContain("Final answer");
  });
});
