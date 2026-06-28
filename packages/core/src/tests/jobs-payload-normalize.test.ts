import { describe, it, expect } from "vitest";
import { _normalizePayloadForTests as normalizePayload } from "../agent/jobs.js";

// Regression for B31 issue #1: the Postgres store reads jobs through
// rowToStoredJob → normalizePayload, which rebuilds the payload field-by-field. If it
// drops `completedStepResults`, the resumable-workflow checkpoint is silently lost on
// every Postgres read and resume never happens (the in-memory store skips this path).
describe("normalizePayload — workflow checkpoint round-trip (B31)", () => {
  const stepOutput = {
    response: "did:alpha",
    toolCallsExecuted: 2,
    guardrailEvents: [],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    blocked: false,
  };

  it("preserves completedStepResults through a jsonb (JSON) round-trip", () => {
    const payload = {
      definitionType: "scene",
      turnTimeoutMs: 30_000,
      steps: [{ sceneName: "wf", label: "A", task: "alpha" }],
      completedStepResults: [stepOutput],
    };
    // Simulate the DB round-trip: serialize to jsonb, read back, normalize.
    const normalized = normalizePayload(JSON.parse(JSON.stringify(payload)));
    expect(normalized.completedStepResults).toHaveLength(1);
    expect(normalized.completedStepResults?.[0]?.response).toBe("did:alpha");
    expect(normalized.completedStepResults?.[0]?.toolCallsExecuted).toBe(2);
  });

  it("drops malformed checkpoint entries that would crash the resumed merge", () => {
    const normalized = normalizePayload({
      turnTimeoutMs: 30_000,
      completedStepResults: [stepOutput, { response: "x" } /* missing blocked/usage/etc */, 42, null],
    });
    expect(normalized.completedStepResults).toHaveLength(1);
    expect(normalized.completedStepResults?.[0]?.response).toBe("did:alpha");
  });

  it("leaves completedStepResults undefined when absent", () => {
    const normalized = normalizePayload({ turnTimeoutMs: 30_000 });
    expect(normalized.completedStepResults).toBeUndefined();
  });
});
