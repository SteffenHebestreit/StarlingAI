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

  it("excludes runs that hit their own timeout so the budget can't ratchet upward", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-adaptive-timeout-"));
    const stateDir = join(tempDir, ".starlingai");
    mkdirSync(stateDir, { recursive: true });
    const outcomesFile = join(stateDir, "agent_outcomes.ndjson");

    const entry = (durationMs: number, timeoutMs: number, outcome: OutcomeEntry["outcome"] = "partial"): OutcomeEntry => ({
      ts: new Date().toISOString(), agent: "source_verifier", task: "t", outcome,
      iterations: 3, totalTokens: 100, durationMs, timeoutMs,
    });

    try {
      // Clean finishes well under budget — these should inform the baseline.
      for (const d of [40_000, 50_000, 60_000]) {
        appendFileSync(outcomesFile, JSON.stringify(entry(d, 600_000, "success")) + "\n");
      }
      // Timed-out runs (durationMs ≈ timeoutMs) — these must be ignored; otherwise
      // the baseline jumps to ~240s and the next budget ratchets up.
      for (const _ of [0, 1, 2, 3]) {
        appendFileSync(outcomesFile, JSON.stringify(entry(245_000, 240_000, "partial")) + "\n");
      }

      const rec = computeAdaptiveSubAgentTimeoutMs("source_verifier", tempDir, 60_000);
      // Baseline reflects only the clean ≤60s runs, not the 240s timeouts.
      expect(rec?.sampleSize).toBe(3);
      expect(rec?.baselineMs).toBe(60_000);
      expect(rec?.timeoutMs).toBe(90_000);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("clamps the adaptive budget to the 6-minute ceiling", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-adaptive-timeout-"));
    const stateDir = join(tempDir, ".starlingai");
    mkdirSync(stateDir, { recursive: true });
    const outcomesFile = join(stateDir, "agent_outcomes.ndjson");

    const entry = (durationMs: number): OutcomeEntry => ({
      ts: new Date().toISOString(), agent: "researcher", task: "t", outcome: "success",
      iterations: 5, totalTokens: 100, durationMs, timeoutMs: 900_000,
    });

    try {
      // Clean but slow finishes (500s) → baseline 500s × 1.5 = 750s, clamped to 360s.
      for (const _ of [0, 1, 2, 3]) appendFileSync(outcomesFile, JSON.stringify(entry(500_000)) + "\n");
      const rec = computeAdaptiveSubAgentTimeoutMs("researcher", tempDir, 60_000);
      expect(rec?.timeoutMs).toBe(360_000);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});