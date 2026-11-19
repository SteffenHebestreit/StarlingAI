import { describe, expect, it } from "vitest";
import { turnModelTotals } from "./turnPerf";

describe("turnModelTotals", () => {
  it("keeps the all-agents totals the gateway sent", () => {
    expect(turnModelTotals({ llmCalls: 2, allModelCalls: 24, allModelTimeMs: 368_000, allPromptTokens: 88_000, allCompletionTokens: 3_000 }))
      .toEqual({ allModelCalls: 24, allModelTimeMs: 368_000, allPromptTokens: 88_000, allCompletionTokens: 3_000 });
  });

  it("leaves out what an older gateway does not send, and what is not a usable number", () => {
    expect(turnModelTotals({ llmCalls: 2, llmTimeMs: 20_463 })).toEqual({});
    expect(turnModelTotals({ allModelCalls: "24", allModelTimeMs: Number.NaN, allPromptTokens: -1, allCompletionTokens: null })).toEqual({});
  });
});
