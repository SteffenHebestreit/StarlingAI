import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { AuditEvent } from "../audit/schema.js";

/**
 * Cost governance aggregator — verifies the per-day / per-session / per-
 * agent / per-model rollups, default rate-card pricing, custom rate cards,
 * budget threshold alerts (soft + hard, daily + monthly), and the
 * monthly-cost projection extrapolation.
 */

function writeCostConfig(extra: Record<string, unknown> = {}): string {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-cost-"));
  const configPath = join(tempDir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({
    cost: { enabled: true, currency: "USD" },
    ...extra,
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configPath;
  process.env["SAI_AUDIT_LOG"] = join(tempDir, "audit.jsonl");
  return tempDir;
}

function makeSubAgentEvent(opts: {
  promptTokens: number;
  completionTokens: number;
  agentName?: string;
  model?: string;
  sessionId?: string;
  timestamp?: string;
}): AuditEvent {
  return {
    id: randomUUID(),
    timestamp: opts.timestamp ?? new Date().toISOString(),
    type: "sub_agent_completed",
    severity: "info",
    sessionId: opts.sessionId,
    data: {
      agentName: opts.agentName ?? "researcher",
      model: opts.model ?? "claude-sonnet-4",
      iterations: 1,
      toolCount: 0,
      usage: {
        promptTokens: opts.promptTokens,
        completionTokens: opts.completionTokens,
        totalTokens: opts.promptTokens + opts.completionTokens,
      },
    },
  };
}

describe("cost aggregator — bucket math", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = writeCostConfig();
    vi.resetModules();
  });

  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    delete process.env["SAI_AUDIT_LOG"];
    rmSync(tempDir, { recursive: true, force: true });
    const cost = await import("../observability/cost.js");
    cost._resetCostStateForTests();
    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
  });

  it("sums token usage from sub_agent_completed events into per-day buckets", async () => {
    const cost = await import("../observability/cost.js");
    cost.startCostAggregator();

    cost._injectEventForTests(makeSubAgentEvent({ promptTokens: 1000, completionTokens: 500, sessionId: "s1" }));
    cost._injectEventForTests(makeSubAgentEvent({ promptTokens: 2000, completionTokens: 1000, sessionId: "s2" }));

    const summary = cost.getCostSummary(30);
    expect(summary.byDay).toHaveLength(1);
    expect(summary.byDay[0]?.totalTokens).toBe(4500); // 1500 + 3000
    expect(summary.totalTokens).toBe(4500);
  });

  it("rolls up by agent + by session + by model independently", async () => {
    const cost = await import("../observability/cost.js");
    cost.startCostAggregator();

    cost._injectEventForTests(makeSubAgentEvent({ promptTokens: 1000, completionTokens: 500, agentName: "researcher", sessionId: "s1", model: "claude-sonnet-4" }));
    cost._injectEventForTests(makeSubAgentEvent({ promptTokens: 2000, completionTokens: 1000, agentName: "coder", sessionId: "s1", model: "gpt-4o" }));
    cost._injectEventForTests(makeSubAgentEvent({ promptTokens: 500, completionTokens: 500, agentName: "researcher", sessionId: "s2", model: "claude-sonnet-4" }));

    const summary = cost.getCostSummary(30);
    expect(summary.byAgent.find((a) => a.source === "researcher")?.totalTokens).toBe(2500);
    expect(summary.byAgent.find((a) => a.source === "coder")?.totalTokens).toBe(3000);
    expect(summary.bySession.find((s) => s.source === "s1")?.totalTokens).toBe(4500);
    expect(summary.bySession.find((s) => s.source === "s2")?.totalTokens).toBe(1000);
    expect(summary.byModel.find((m) => m.source === "claude-sonnet-4")?.totalTokens).toBe(2500);
    expect(summary.byModel.find((m) => m.source === "gpt-4o")?.totalTokens).toBe(3000);
  });

  it("ignores events without a usable usage payload", async () => {
    const cost = await import("../observability/cost.js");
    cost.startCostAggregator();

    cost._injectEventForTests({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      type: "sub_agent_completed",
      severity: "info",
      sessionId: "s1",
      data: { agentName: "x", model: "claude-sonnet-4" }, // missing usage
    });
    cost._injectEventForTests({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      type: "sub_agent_completed",
      severity: "info",
      sessionId: "s2",
      data: { agentName: "x", model: "claude-sonnet-4", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } },
    });

    const summary = cost.getCostSummary(30);
    expect(summary.byDay).toHaveLength(0);
    expect(summary.totalTokens).toBe(0);
  });

  it("orchestrator turns roll up under the synthetic agent name 'orchestrator'", async () => {
    const cost = await import("../observability/cost.js");
    cost.startCostAggregator();

    cost._injectEventForTests({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      type: "turn_performance",
      severity: "info",
      sessionId: "s1",
      data: {
        usage: { promptTokens: 1500, completionTokens: 1500, totalTokens: 3000 },
        model: "claude-opus-4",
      },
    });

    const summary = cost.getCostSummary(30);
    expect(summary.byAgent.find((a) => a.source === "orchestrator")?.totalTokens).toBe(3000);
  });
});

describe("cost aggregator — pricing", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = writeCostConfig();
    vi.resetModules();
  });

  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    delete process.env["SAI_AUDIT_LOG"];
    rmSync(tempDir, { recursive: true, force: true });
    const cost = await import("../observability/cost.js");
    cost._resetCostStateForTests();
    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
  });

  it("uses the default rate card when no custom models are configured", async () => {
    const cost = await import("../observability/cost.js");
    cost.startCostAggregator();

    // 1M prompt + 1M completion tokens at claude-sonnet-4 default ($3 / $15)
    cost._injectEventForTests(makeSubAgentEvent({ promptTokens: 1_000_000, completionTokens: 1_000_000, model: "claude-sonnet-4" }));

    const summary = cost.getCostSummary(30);
    // 1M * $3 + 1M * $15 = $18
    expect(summary.totalCost).toBeCloseTo(18, 5);
  });

  it("prices Claude Opus 4.x at the Opus rate, not the Sonnet rate (regression)", async () => {
    const cost = await import("../observability/cost.js");
    cost.startCostAggregator();
    // 1M prompt + 1M completion at claude-opus-4-8 default ($5 / $25) = $30
    cost._injectEventForTests(makeSubAgentEvent({ promptTokens: 1_000_000, completionTokens: 1_000_000, model: "claude-opus-4-8" }));
    const summary = cost.getCostSummary(30);
    expect(summary.totalCost).toBeCloseTo(30, 5);
  });

  it("prices a locally-served model at $0", async () => {
    const cost = await import("../observability/cost.js");
    cost.startCostAggregator();
    cost._injectEventForTests(makeSubAgentEvent({ promptTokens: 1_000_000, completionTokens: 1_000_000, model: "qwen/qwen3.6-35b-a3b" }));
    const summary = cost.getCostSummary(30);
    expect(summary.totalCost).toBeCloseTo(0, 5);
  });

  it("custom rate card overrides default rates entirely (first match wins)", async () => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = writeCostConfig({
      cost: {
        enabled: true,
        currency: "USD",
        models: [
          { matches: "^my-cheap-model$", promptPer1m: 0.1, completionPer1m: 0.2 },
        ],
      },
    });
    vi.resetModules();
    const cost = await import("../observability/cost.js");
    cost.startCostAggregator();

    cost._injectEventForTests(makeSubAgentEvent({ promptTokens: 1_000_000, completionTokens: 1_000_000, model: "my-cheap-model" }));
    // Models that don't match yield $0 because the custom card replaces
    // (not extends) the default card.
    cost._injectEventForTests(makeSubAgentEvent({ promptTokens: 1_000_000, completionTokens: 0, model: "claude-sonnet-4" }));

    const summary = cost.getCostSummary(30);
    // 0.1 + 0.2 = 0.3 from cheap-model; claude-sonnet-4 misses → 0
    expect(summary.totalCost).toBeCloseTo(0.3, 5);
  });

  it("emits $0 for unknown models without breaking token tracking", async () => {
    const cost = await import("../observability/cost.js");
    cost.startCostAggregator();

    cost._injectEventForTests(makeSubAgentEvent({ promptTokens: 5000, completionTokens: 5000, model: "totally-unknown-model" }));

    const summary = cost.getCostSummary(30);
    expect(summary.totalTokens).toBe(10_000);
    expect(summary.totalCost).toBe(0);
  });
});

describe("cost aggregator — budget thresholds", () => {
  let tempDir: string;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    delete process.env["SAI_AUDIT_LOG"];
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    const cost = await import("../observability/cost.js");
    cost._resetCostStateForTests();
    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
  });

  it("fires a soft warn when daily spend crosses 75% of the cap", async () => {
    tempDir = writeCostConfig({
      cost: {
        enabled: true,
        currency: "USD",
        budgets: { dailyUsd: 10, monthlyUsd: 0 },
        models: [{ matches: "^x$", promptPer1m: 1_000_000, completionPer1m: 0 }], // $1 per token (prompt) for trivial math
      },
    });
    vi.resetModules();
    const cost = await import("../observability/cost.js");
    const audit = await import("../audit/logger.js");
    const captured: { type: string; severity: string }[] = [];
    audit.subscribeToAudit((e) => captured.push({ type: e.type, severity: e.severity }));
    cost.startCostAggregator();

    // 8 tokens at $1/token = $8 ≥ $7.5 (soft of $10) but < $10 (hard)
    cost._injectEventForTests(makeSubAgentEvent({ promptTokens: 8, completionTokens: 0, model: "x" }));

    const thresholds = captured.filter((c) => c.type === "cost_budget_threshold");
    expect(thresholds).toHaveLength(1);
    expect(thresholds[0]?.severity).toBe("warn");
  });

  it("fires a hard error when daily spend crosses 100% of the cap", async () => {
    tempDir = writeCostConfig({
      cost: {
        enabled: true,
        currency: "USD",
        budgets: { dailyUsd: 5, monthlyUsd: 0 },
        models: [{ matches: "^x$", promptPer1m: 1_000_000, completionPer1m: 0 }],
      },
    });
    vi.resetModules();
    const cost = await import("../observability/cost.js");
    const audit = await import("../audit/logger.js");
    const captured: { type: string; severity: string; data: Record<string, unknown> }[] = [];
    audit.subscribeToAudit((e) => captured.push({ type: e.type, severity: e.severity, data: e.data }));
    cost.startCostAggregator();

    // 6 tokens × $1 = $6 ≥ $5 hard cap
    cost._injectEventForTests(makeSubAgentEvent({ promptTokens: 6, completionTokens: 0, model: "x" }));

    const hard = captured.filter((c) => c.type === "cost_budget_threshold" && c.data["bucket"] === "hard");
    expect(hard).toHaveLength(1);
    expect(hard[0]?.severity).toBe("error");
  });

  it("does not re-fire the same hard alert on subsequent same-day events", async () => {
    tempDir = writeCostConfig({
      cost: {
        enabled: true,
        currency: "USD",
        budgets: { dailyUsd: 5, monthlyUsd: 0 },
        models: [{ matches: "^x$", promptPer1m: 1_000_000, completionPer1m: 0 }],
      },
    });
    vi.resetModules();
    const cost = await import("../observability/cost.js");
    const audit = await import("../audit/logger.js");
    const captured: { type: string }[] = [];
    audit.subscribeToAudit((e) => captured.push({ type: e.type }));
    cost.startCostAggregator();

    // First event already crosses hard; subsequent ones add to spend but
    // shouldn't re-emit the hard alert.
    cost._injectEventForTests(makeSubAgentEvent({ promptTokens: 6, completionTokens: 0, model: "x" }));
    cost._injectEventForTests(makeSubAgentEvent({ promptTokens: 4, completionTokens: 0, model: "x" }));
    cost._injectEventForTests(makeSubAgentEvent({ promptTokens: 4, completionTokens: 0, model: "x" }));

    const thresholds = captured.filter((c) => c.type === "cost_budget_threshold");
    expect(thresholds).toHaveLength(1);
  });
});

describe("cost aggregator — projection", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = writeCostConfig();
    vi.resetModules();
  });

  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    delete process.env["SAI_AUDIT_LOG"];
    rmSync(tempDir, { recursive: true, force: true });
    const cost = await import("../observability/cost.js");
    cost._resetCostStateForTests();
    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
  });

  it("extrapolates monthly cost from completed days only (skips today)", async () => {
    const cost = await import("../observability/cost.js");
    cost.startCostAggregator();

    // Inject events for the previous 3 days + today using fake timestamps.
    const dayMs = 24 * 60 * 60 * 1000;
    const now = Date.now();
    for (let daysAgo = 1; daysAgo <= 3; daysAgo++) {
      cost._injectEventForTests(makeSubAgentEvent({
        promptTokens: 1_000_000,
        completionTokens: 0,
        model: "claude-sonnet-4", // $3/M prompt
        timestamp: new Date(now - daysAgo * dayMs).toISOString(),
      }));
    }
    // Today's activity should be ignored by the projection.
    cost._injectEventForTests(makeSubAgentEvent({
      promptTokens: 999_999_999,
      completionTokens: 999_999_999,
      model: "claude-sonnet-4",
    }));

    const proj = cost.getCostProjection(7);
    // 3 days × $3 each = $9 total → avg $3 → projected $90/month
    expect(proj.windowDays).toBe(3);
    expect(proj.averageDailyCost).toBeCloseTo(3, 5);
    expect(proj.projectedMonthlyCost).toBeCloseTo(90, 5);
  });
});
