import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeTurnOutput, type TurnOutput } from "../agent/runtime.js";

/**
 * Turn invariant — a chat turn must never hand the user a blank response.
 * finalizeTurnOutput is the single chokepoint on the runTurn boundary that
 * converts an empty/whitespace response into a graceful recoverable message
 * while passing real answers through untouched.
 */

function makeOutput(response: string): TurnOutput {
  return {
    response,
    toolCallsExecuted: 2,
    guardrailEvents: [{ type: "workflow_required", details: "x" }],
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    blocked: false,
    performance: {
      turnDurationMs: 100,
      llmCalls: 1,
      llmTimeMs: 50,
      toolCallsRequested: 2,
      toolExecutionTimeMs: 10,
      systemPromptChars: 1000,
      collapsedHistoryMessages: 0,
      collapsedHistoryChars: 0,
      promptChars: 1100,
      completionChars: response.length,
      toolIterations: 1,
      finishReason: "completed",
      blocked: false,
    },
  };
}

describe("finalizeTurnOutput — never-empty invariant", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "starlingai-finalize-"));
    process.env["SAI_AUDIT_LOG"] = join(dir, "audit.jsonl");
  });
  afterEach(() => {
    delete process.env["SAI_AUDIT_LOG"];
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes a real answer through unchanged", () => {
    const out = makeOutput("The capital of France is Paris.");
    const result = finalizeTurnOutput(out, "sess-1");
    expect(result).toBe(out);
    expect(result.response).toBe("The capital of France is Paris.");
  });

  it("replaces an empty response with a graceful, non-empty fallback", () => {
    const result = finalizeTurnOutput(makeOutput(""), "sess-2");
    expect(result.response.trim().length).toBeGreaterThan(0);
    expect(result.response.toLowerCase()).toContain("retry");
  });

  it("replaces a whitespace-only response too", () => {
    const result = finalizeTurnOutput(makeOutput("   \n\t  "), "sess-3");
    expect(result.response.trim().length).toBeGreaterThan(0);
  });

  it("preserves the other fields when recovering", () => {
    const out = makeOutput("");
    const result = finalizeTurnOutput(out, "sess-4");
    expect(result.blocked).toBe(out.blocked);
    expect(result.usage).toEqual(out.usage);
    expect(result.toolCallsExecuted).toBe(out.toolCallsExecuted);
    expect(result.performance?.finishReason).toBe("completed");
  });
});
