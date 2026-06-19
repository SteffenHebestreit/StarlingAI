import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  longRunningGenerationManager,
  longRunningActionForTier,
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

  it("falls back to defaultOutcome 'stop' on operator-response timeout", async () => {
    const wait = longRunningGenerationManager.requestContinuation({
      ...buildRequest(),
      waitTimeoutMs: 20,
      defaultOutcome: "stop",
    });
    await expect(wait).resolves.toBe("stop");
    expect(longRunningGenerationManager.listPending()).toHaveLength(0);
  });

  it("falls back to defaultOutcome 'continue' on operator-response timeout for pre-authorized runs", async () => {
    // When the operator pre-authorized the turn via --timeout N, the
    // handoff still fires (operator sees it in the dock and can stop the
    // run) but the default outcome on no-response is "continue" so the run
    // grants itself another round of budget and keeps going.
    const wait = longRunningGenerationManager.requestContinuation({
      ...buildRequest(),
      waitTimeoutMs: 20,
      defaultOutcome: "continue",
    });
    await expect(wait).resolves.toBe("continue");
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

describe("longRunningGenerationManager — operator stop latches the turn", () => {
  beforeEach(() => longRunningGenerationManager.resetForTests());
  afterEach(() => longRunningGenerationManager.resetForTests());

  // Same turn (root "turnA"): a coordinator and its researcher child.
  const coord = "sub:turnA:mission_coordinator:1";
  const child = "sub:sub:turnA:mission_coordinator:1:researcher:2";
  const otherTurn = "sub:turnB:mission_coordinator:9";
  const req = (runSessionId: string) => ({
    agentName: "researcher", runSessionId, parentSessionId: "turnA",
    reason: "still going", elapsedMs: DEFAULT_SOFT_THRESHOLD_MS + 1, completionTokens: 9000, iterations: 3,
  });

  it("auto-stops later runs in the same turn after one operator stop (no re-prompt)", async () => {
    const first = longRunningGenerationManager.requestContinuation(req(coord));
    longRunningGenerationManager.resolveRequest(longRunningGenerationManager.listPending()[0]!.id, "stop", "admin");
    await expect(first).resolves.toBe("stop");
    // A fresh sub-agent in the same turn must NOT raise a new operator prompt.
    const second = await longRunningGenerationManager.requestContinuation(req(child));
    expect(second).toBe("stop");
    expect(longRunningGenerationManager.listPending()).toHaveLength(0);
    expect(longRunningGenerationManager.isStopRequested(child)).toBe(true);
  });

  it("resolves sibling pending prompts in the same turn when the operator stops one", async () => {
    const a = longRunningGenerationManager.requestContinuation(req(coord));
    const b = longRunningGenerationManager.requestContinuation(req(child));
    expect(longRunningGenerationManager.listPending()).toHaveLength(2);
    longRunningGenerationManager.resolveRequest(
      longRunningGenerationManager.listPending().find((r) => r.runSessionId === coord)!.id, "stop", "admin");
    await expect(a).resolves.toBe("stop");
    await expect(b).resolves.toBe("stop"); // sibling auto-resolved
    expect(longRunningGenerationManager.listPending()).toHaveLength(0);
  });

  it("does not auto-stop a different turn", async () => {
    const first = longRunningGenerationManager.requestContinuation(req(coord));
    longRunningGenerationManager.resolveRequest(longRunningGenerationManager.listPending()[0]!.id, "stop", "admin");
    await first;
    // A run in a different root (turn) is unaffected and still prompts.
    void longRunningGenerationManager.requestContinuation({ ...req(otherTurn), parentSessionId: "turnB" });
    expect(longRunningGenerationManager.listPending()).toHaveLength(1);
    expect(longRunningGenerationManager.isStopRequested(otherTurn)).toBe(false);
  });

  it("clearStopRequested re-enables prompting for the next turn", async () => {
    const first = longRunningGenerationManager.requestContinuation(req(coord));
    longRunningGenerationManager.resolveRequest(longRunningGenerationManager.listPending()[0]!.id, "stop", "admin");
    await first;
    longRunningGenerationManager.clearStopRequested("turnA");
    void longRunningGenerationManager.requestContinuation(req(child));
    expect(longRunningGenerationManager.listPending()).toHaveLength(1);
  });
});

describe("longRunningGenerationManager.notifyLongRunning — non-blocking surfacing", () => {
  beforeEach(() => longRunningGenerationManager.resetForTests());
  afterEach(() => longRunningGenerationManager.resetForTests());

  const run = "sub:turnX:researcher:1";
  const notify = (runSessionId = run) => longRunningGenerationManager.notifyLongRunning({
    agentName: "researcher",
    runSessionId,
    parentSessionId: "turnX",
    reason: "still going",
    elapsedMs: DEFAULT_SOFT_THRESHOLD_MS + 1,
    completionTokens: 9000,
    iterations: 3,
  });

  it("surfaces a dock entry synchronously without an awaiter", () => {
    expect(notify()).toEqual({ surfaced: true });
    const pending = longRunningGenerationManager.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.runSessionId).toBe(run);
  });

  it("is idempotent per run while a request is already pending", () => {
    expect(notify().surfaced).toBe(true);
    expect(notify().surfaced).toBe(false);
    expect(longRunningGenerationManager.listPending()).toHaveLength(1);
  });

  it("is a no-op once the run has been granted unbounded", () => {
    expect(notify().surfaced).toBe(true);
    longRunningGenerationManager.resolveRequest(longRunningGenerationManager.listPending()[0]!.id, "unbounded");
    expect(longRunningGenerationManager.isUnbounded(run)).toBe(true);
    expect(notify().surfaced).toBe(false);
  });

  it("is a no-op once the turn has been stopped", () => {
    expect(notify().surfaced).toBe(true);
    longRunningGenerationManager.resolveRequest(longRunningGenerationManager.listPending()[0]!.id, "stop", "admin");
    expect(longRunningGenerationManager.isStopRequested(run)).toBe(true);
    expect(notify().surfaced).toBe(false);
  });

  it("lets the operator stop an advisory (non-pending-awaiter) entry; latch fires for the run", () => {
    notify();
    const id = longRunningGenerationManager.listPending()[0]!.id;
    const resolved = longRunningGenerationManager.resolveRequest(id, "stop", "admin");
    expect(resolved?.resolvedOutcome).toBe("stop");
    expect(longRunningGenerationManager.isStopRequested(run)).toBe(true);
    expect(longRunningGenerationManager.listPending()).toHaveLength(0);
  });

  it("run-end stop() clears the advisory dock entry", () => {
    notify();
    expect(longRunningGenerationManager.listPending()).toHaveLength(1);
    longRunningGenerationManager.stop(run, "run_ended");
    expect(longRunningGenerationManager.listPending()).toHaveLength(0);
  });
});

describe("longRunningActionForTier (effort-driven auto-resolution)", () => {
  it("low → stop (finish now)", () => {
    expect(longRunningActionForTier("low")).toBe("stop");
  });
  it("high → continue (keep going, no dock prompt)", () => {
    expect(longRunningActionForTier("high")).toBe("continue");
  });
  it("medium → ask (surface to the operator dock, current behaviour)", () => {
    expect(longRunningActionForTier("medium")).toBe("ask");
  });
  it("max → ask for now (interim until the verify-progress agent ships)", () => {
    expect(longRunningActionForTier("max")).toBe("ask");
  });
  it("undefined tier → ask (safe default = unchanged behaviour)", () => {
    expect(longRunningActionForTier(undefined)).toBe("ask");
  });
});
