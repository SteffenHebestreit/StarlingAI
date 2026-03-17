import { describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeAdaptiveSubAgentTimeoutMs, type OutcomeEntry } from "../agent/outcomes.js";

describe("adaptive sub-agent timeout recommendation", () => {
  it("returns null when there is not enough duration history", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-adaptive-timeout-"));
    try {
      expect(computeAdaptiveSubAgentTimeoutMs("researcher", tempDir, 60_000)).toBeNull();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uses recent successful durations with safety headroom", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-adaptive-timeout-"));
    const stateDir = join(tempDir, ".starlingai");
    mkdirSync(stateDir, { recursive: true });
    const outcomesFile = join(stateDir, "agent_outcomes.ndjson");

    const entry = (durationMs: number, outcome: OutcomeEntry["outcome"] = "success"): OutcomeEntry => ({
      ts: new Date().toISOString(),
      agent: "researcher",
      task: "t",
      outcome,
      iterations: 1,
      totalTokens: 100,
      durationMs,
    });

    try {
      for (const durationMs of [40_000, 50_000, 70_000, 80_000]) {
        appendFileSync(outcomesFile, JSON.stringify(entry(durationMs)) + "\n");
      }
      appendFileSync(outcomesFile, JSON.stringify(entry(10_000, "failure")) + "\n");

      const recommendation = computeAdaptiveSubAgentTimeoutMs("researcher", tempDir, 60_000);
      expect(recommendation).toMatchObject({
        sampleSize: 4,
        baselineMs: 80_000,
        timeoutMs: 120_000,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});