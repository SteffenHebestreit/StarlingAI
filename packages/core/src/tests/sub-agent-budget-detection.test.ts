import { describe, expect, it } from "vitest";
import { looksLikeExhaustedBudgetNoTool } from "../agent/sub-agent.js";
import type { SubAgentExecutionStats } from "../agent/sub-agent.js";

function makeStats(overrides: Partial<SubAgentExecutionStats> = {}): SubAgentExecutionStats {
  return {
    agentName: "content_writer",
    sessionId: "sub:test",
    promptChars: 1000,
    userContentChars: 200,
    toolCount: 0,
    toolNames: [],
    iterations: 0,
    usage: { promptTokens: 1000, completionTokens: 0, totalTokens: 1000 },
    maxIterations: 10,
    model: "lmstudio/qwen/qwen3.6-35b-a3b",
    capabilities: [],
    ...overrides,
  };
}

describe("looksLikeExhaustedBudgetNoTool", () => {
  it("flags the canonical empty-response marker once completion tokens crossed the threshold", () => {
    const stats = makeStats({ usage: { promptTokens: 4000, completionTokens: 8192, totalTokens: 12192 } });
    expect(looksLikeExhaustedBudgetNoTool("Sub-agent produced no final response.", stats)).toBe(true);
  });

  it("flags trivially short output (< 60 chars) after a substantial completion", () => {
    const stats = makeStats({ usage: { promptTokens: 4000, completionTokens: 7500, totalTokens: 11500 } });
    expect(looksLikeExhaustedBudgetNoTool("Here is the file:", stats)).toBe(true);
  });

  it("does NOT flag a legitimate short refusal that cost very few tokens", () => {
    // The model decided early that the question had no answer — < 1500 tokens
    // means it didn't try to inline anything huge. This is a real "no" answer,
    // not a runaway artifact-inlining failure.
    const stats = makeStats({ usage: { promptTokens: 800, completionTokens: 80, totalTokens: 880 } });
    expect(looksLikeExhaustedBudgetNoTool("No matching records found.", stats)).toBe(false);
  });

  it("does NOT flag a normal substantive response, even at the token threshold", () => {
    const longRealAnswer = "Here is the analysis: ".repeat(20); // > 60 chars, real content
    const stats = makeStats({ usage: { promptTokens: 4000, completionTokens: 8000, totalTokens: 12000 } });
    expect(looksLikeExhaustedBudgetNoTool(longRealAnswer, stats)).toBe(false);
  });

  it("treats whitespace-only output the same as empty", () => {
    const stats = makeStats({ usage: { promptTokens: 4000, completionTokens: 5000, totalTokens: 9000 } });
    expect(looksLikeExhaustedBudgetNoTool("    \n  \t  ", stats)).toBe(true);
  });

  it("matches the threshold exactly (>= 1500 tokens)", () => {
    const below = makeStats({ usage: { promptTokens: 100, completionTokens: 1499, totalTokens: 1599 } });
    expect(looksLikeExhaustedBudgetNoTool("Sub-agent produced no final response.", below)).toBe(false);
    const at = makeStats({ usage: { promptTokens: 100, completionTokens: 1500, totalTokens: 1600 } });
    expect(looksLikeExhaustedBudgetNoTool("Sub-agent produced no final response.", at)).toBe(true);
  });
});
