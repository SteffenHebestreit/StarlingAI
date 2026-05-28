import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  longRunningGenerationManager,
  DEFAULT_SOFT_THRESHOLD_MS,
} from "../agent/long-running-generation.js";

describe("longRunningGenerationManager", () => {
  beforeEach(() => longRunningGenerationManager.resetForTests());
  afterEach(() => longRunningGenerationManager.resetForTests());

  function buildRequest(overrides: Partial<Parameters<typeof longRunningGenerationManager.requestContinuation>[0]> = {}) {
    return {
      agentName: "content_writer",
      runSessionId: "sub:test:content_writer:1",
      parentSessionId: "parent-session",
      reason: "burned a lot of budget but not done yet",
      elapsedMs: DEFAULT_SOFT_THRESHOLD_MS + 1000,
      completionTokens: 9000,
      iterations: 3,
      ...overrides,
    };
  }

  it("resolves to the operator's choice when resolveRequest fires", async () => {
    const wait = longRunningGenerationManager.requestContinuation(buildRequest());
    // Find the request we just raised.
    const pending = longRunningGenerationManager.listPending();
    expect(pending).toHaveLength(1);
    const id = pending[0]!.id;
    longRunningGenerationManager.resolveRequest(id, "continue", "steffen");
    await expect(wait).resolves.toBe("continue");
    expect(longRunningGenerationManager.listPending()).toHaveLength(0);
  });

  it("marks the run as unbounded when the operator picks 'unbounded'", async () => {
    const wait = longRunningGenerationManager.requestContinuation(buildRequest());
    const pending = longRunningGenerationManager.listPending();
    longRunningGenerationManager.resolveRequest(pending[0]!.id, "unbounded");
    await expect(wait).resolves.toBe("unbounded");
    expect(longRunningGenerationManager.isUnbounded(buildRequest().runSessionId)).toBe(true);
  });

  it("short-circuits future requests on the same run after 'unbounded'", async () => {
    const first = longRunningGenerationManager.requestContinuation(buildRequest());
    const pending = longRunningGenerationManager.listPending();
    longRunningGenerationManager.resolveRequest(pending[0]!.id, "unbounded");
    await first;
    // A second request on the same runSessionId should auto-resolve to
    // "unbounded" without creating a new pending entry.
    const second = await longRunningGenerationManager.requestContinuation(buildRequest());
    expect(second).toBe("unbounded");
    expect(longRunningGenerationManager.listPending()).toHaveLength(0);
  });

  it("falls back to defaultOutcome on operator-response timeout", async () => {
    const wait = longRunningGenerationManager.requestContinuation({
      ...buildRequest(),
      waitTimeoutMs: 20,
      defaultOutcome: "stop",
    });
    await expect(wait).resolves.toBe("timeout");
    // The request is no longer pending after the timer fires.
    expect(longRunningGenerationManager.listPending()).toHaveLength(0);
  });

  it("dedupes a second request for the same run while one is still pending", async () => {
    const first = longRunningGenerationManager.requestContinuation(buildRequest());
    const second = longRunningGenerationManager.requestContinuation(buildRequest());
    expect(longRunningGenerationManager.listPending()).toHaveLength(1);
    const id = longRunningGenerationManager.listPending()[0]!.id;
    longRunningGenerationManager.resolveRequest(id, "continue");
    await expect(first).resolves.toBe("continue");
    await expect(second).resolves.toBe("continue");
  });

  it("stop() unblocks a pending request with the configured defaultOutcome", async () => {
    const wait = longRunningGenerationManager.requestContinuation({
      ...buildRequest(),
      defaultOutcome: "stop",
    });
    longRunningGenerationManager.stop(buildRequest().runSessionId, "run_ended");
    await expect(wait).resolves.toBe("stop");
  });

  it("returns the resolved request payload so the caller can audit it", () => {
    void longRunningGenerationManager.requestContinuation(buildRequest());
    const pending = longRunningGenerationManager.listPending();
    const resolved = longRunningGenerationManager.resolveRequest(pending[0]!.id, "stop", "alice");
    expect(resolved).not.toBeNull();
    expect(resolved?.state).toBe("resolved");
    expect(resolved?.resolvedOutcome).toBe("stop");
  });

  it("resolveRequest on an unknown id returns null", () => {
    expect(longRunningGenerationManager.resolveRequest("nope", "continue")).toBeNull();
  });
});
