/**
 * G32 — Outcome-weighted routing tests.
 *
 * Verify that:
 * 1. extractTaskKeywords strips stop-words and returns ≤3 sorted tokens.
 * 2. computeOutcomeRoutingMultiplier returns 1.0 when fewer than MIN_SAMPLES exist.
 * 3. computeOutcomeRoutingMultiplier boosts an agent with a strong success history
 *    and penalises one with mostly failures.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractTaskKeywords, computeOutcomeRoutingMultiplier, type OutcomeEntry } from "../agent/outcomes.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeWorkspace(): string {
  const dir = join(tmpdir(), `sai-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, ".starlingai"), { recursive: true });
  return dir;
}

function seedOutcomes(ws: string, entries: OutcomeEntry[]): void {
  const ndjson = entries.map(e => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(join(ws, ".starlingai", "agent_outcomes.ndjson"), ndjson, "utf-8");
}

function makeEntry(
  agent: string,
  outcome: OutcomeEntry["outcome"],
  task: string,
  keywords?: string[],
): OutcomeEntry {
  return {
    ts: new Date().toISOString(),
    agent,
    task,
    outcome,
    iterations: 3,
    totalTokens: 500,
    taskKeywords: keywords ?? extractTaskKeywords(task),
  };
}

// ── extractTaskKeywords ────────────────────────────────────────────────────

describe("extractTaskKeywords", () => {
  it("strips stop-words and returns ≤3 tokens sorted", () => {
    const kws = extractTaskKeywords("What are the latest headlines from Germany today?");
    expect(kws.length).toBeLessThanOrEqual(3);
    expect(kws).not.toContain("the");
    expect(kws).not.toContain("from");
    expect(kws).not.toContain("what");
    expect(kws).not.toContain("are");
  });

  it("returns empty array for all-stopword input", () => {
    const kws = extractTaskKeywords("is the a an");
    expect(kws).toEqual([]);
  });

  it("normalises to lowercase and sorts", () => {
    const kws = extractTaskKeywords("Search Python Libraries Documentation");
    expect(kws).toEqual([...kws].sort());
    for (const w of kws) {
      expect(w).toEqual(w.toLowerCase());
    }
  });
});

// ── computeOutcomeRoutingMultiplier ────────────────────────────────────────

describe("computeOutcomeRoutingMultiplier", () => {
  let ws: string;

  beforeEach(() => { ws = makeWorkspace(); });
  afterEach(() => { rmSync(ws, { recursive: true, force: true }); });

  it("returns 1.0 when no outcomes exist", () => {
    const mult = computeOutcomeRoutingMultiplier("researcher", ["news", "headlines"], ws);
    expect(mult).toBe(1.0);
  });

  it("returns 1.0 when fewer than 25 matching outcomes exist", () => {
    const entries: OutcomeEntry[] = Array.from({ length: 20 }, () =>
      makeEntry("researcher", "success", "latest news headlines today"),
    );
    seedOutcomes(ws, entries);
    const mult = computeOutcomeRoutingMultiplier("researcher", ["news", "headlines"], ws);
    expect(mult).toBe(1.0);
  });

  it("boosts an agent with high success rate (≥25 samples)", () => {
    const entries: OutcomeEntry[] = [
      ...Array.from({ length: 28 }, () => makeEntry("researcher", "success", "latest news headlines today")),
      ...Array.from({ length: 2 }, () => makeEntry("researcher", "failure", "latest news headlines today")),
    ];
    seedOutcomes(ws, entries);
    const mult = computeOutcomeRoutingMultiplier("researcher", ["news", "headlines"], ws);
    expect(mult).toBeGreaterThan(1.0);
    expect(mult).toBeLessThanOrEqual(1.20);
  });

  it("penalises an agent with high failure rate (≥25 samples)", () => {
    const entries: OutcomeEntry[] = [
      ...Array.from({ length: 2 }, () => makeEntry("researcher", "success", "latest news headlines today")),
      ...Array.from({ length: 28 }, () => makeEntry("researcher", "failure", "latest news headlines today")),
    ];
    seedOutcomes(ws, entries);
    const mult = computeOutcomeRoutingMultiplier("researcher", ["news", "headlines"], ws);
    expect(mult).toBeLessThan(1.0);
    expect(mult).toBeGreaterThanOrEqual(0.80);
  });

  it("ignores outcomes for a different agent", () => {
    const entries: OutcomeEntry[] = Array.from({ length: 30 }, () =>
      makeEntry("coder", "success", "latest news headlines today"),
    );
    seedOutcomes(ws, entries);
    // 'researcher' has no samples → should return 1.0
    const mult = computeOutcomeRoutingMultiplier("researcher", ["news", "headlines"], ws);
    expect(mult).toBe(1.0);
  });

  it("routing flips toward the historically successful agent", () => {
    // researcher: 29 success / 1 failure on news tasks
    // coder: 1 success / 29 failure on news tasks
    const entries: OutcomeEntry[] = [
      ...Array.from({ length: 29 }, () => makeEntry("researcher", "success", "latest news headlines today")),
      makeEntry("researcher", "failure", "latest news headlines today"),
      makeEntry("coder", "success", "latest news headlines today"),
      ...Array.from({ length: 29 }, () => makeEntry("coder", "failure", "latest news headlines today")),
    ];
    seedOutcomes(ws, entries);
    const qKws = extractTaskKeywords("latest news headlines today");
    const researcherMult = computeOutcomeRoutingMultiplier("researcher", qKws, ws);
    const coderMult = computeOutcomeRoutingMultiplier("coder", qKws, ws);
    expect(researcherMult).toBeGreaterThan(coderMult);
  });
});
