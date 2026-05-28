import { describe, expect, it } from "vitest";
import { shouldRequireWorkflowExecutionAfterSearch } from "../agent/runtime.js";

type Match = { name: string; workflowType: "scene" | "job"; score: number; matchedTerms: string[] };
const m = (score: number, matchedTerms: string[]): Match => ({ name: "x", workflowType: "job", score, matchedTerms });

describe("shouldRequireWorkflowExecutionAfterSearch", () => {
  it("does NOT force workflow execution on a weak/incidental match", () => {
    // Regression: an unrelated database_analysis job scored 0.245 on two generic
    // terms ("inspection","analysis") and used to hard-force run_workflow,
    // deadlocking a 'research this repo' turn into an empty answer.
    expect(shouldRequireWorkflowExecutionAfterSearch([m(0.245, ["inspection", "analysis"])])).toBe(false);
    // Three generic terms but still a weak score must also not force it.
    expect(shouldRequireWorkflowExecutionAfterSearch([m(0.245, ["inspection", "analysis", "data"])])).toBe(false);
  });

  it("forces workflow execution on a genuinely strong match", () => {
    expect(shouldRequireWorkflowExecutionAfterSearch([m(0.5, ["a"])])).toBe(true);
    expect(shouldRequireWorkflowExecutionAfterSearch([m(0.72, ["audit"])])).toBe(true);
  });

  it("forces execution on 3+ matched terms backed by a non-trivial score", () => {
    // Preserves existing behavior: a 0.33 score with 3 matched terms still fires.
    expect(shouldRequireWorkflowExecutionAfterSearch([m(0.33, ["paper", "protocol", "mcp"])])).toBe(true);
    expect(shouldRequireWorkflowExecutionAfterSearch([m(0.34, ["paper", "mcp", "a2a"])])).toBe(true);
  });

  it("returns false for no matches", () => {
    expect(shouldRequireWorkflowExecutionAfterSearch([])).toBe(false);
  });

  it("does NOT force on pure-semantic match below the strong-semantic threshold", () => {
    // Regression: session b15e2099 (2026-05-28) had apply_jobs (a freelance
    // application scene) score 0.65 against an unrelated "create a CPSA-F
    // learning website" request — pure semantic, zero keyword overlap. The
    // old 0.5 floor forced run_workflow and burned 12 min of browser
    // automation on the wrong workflow. With no keyword overlap, require
    // a much higher semantic score (0.78+) before forcing.
    expect(shouldRequireWorkflowExecutionAfterSearch([m(0.65, [])])).toBe(false);
    expect(shouldRequireWorkflowExecutionAfterSearch([m(0.74, [])])).toBe(false);
  });

  it("still forces on a strong pure-semantic match", () => {
    expect(shouldRequireWorkflowExecutionAfterSearch([m(0.82, [])])).toBe(true);
  });
});
