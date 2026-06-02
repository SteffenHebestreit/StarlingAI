import { afterEach, describe, expect, it } from "vitest";
import { turnSteeringManager } from "../agent/turn-steering.js";

/**
 * Mid-turn user steering inbox. The runtime drains this between tool-loop
 * iterations and folds queued messages into the running turn. Scoped to the
 * root (turn) session id so steering reaches the orchestrator turn regardless
 * of which sub-agent is mid-flight, and only queues while a turn is live so a
 * stray message never leaks into a later turn.
 */
describe("turnSteeringManager", () => {
  afterEach(() => turnSteeringManager.resetForTests());

  it("does NOT queue when no turn is active", () => {
    expect(turnSteeringManager.enqueueIfActive("s1", "hello")).toBe(false);
    expect(turnSteeringManager.hasPending("s1")).toBe(false);
    expect(turnSteeringManager.drain("s1")).toEqual([]);
  });

  it("queues while active and drains in arrival order, once", () => {
    turnSteeringManager.markTurnActive("s1");
    expect(turnSteeringManager.enqueueIfActive("s1", "first")).toBe(true);
    expect(turnSteeringManager.enqueueIfActive("s1", "  second  ")).toBe(true);
    expect(turnSteeringManager.enqueueIfActive("s1", "   ")).toBe(false); // blank ignored
    expect(turnSteeringManager.hasPending("s1")).toBe(true);
    expect(turnSteeringManager.drain("s1")).toEqual(["first", "second"]);
    expect(turnSteeringManager.drain("s1")).toEqual([]); // drained once
    expect(turnSteeringManager.hasPending("s1")).toBe(false);
  });

  it("markTurnActive clears a stale queue; markTurnDone clears active + queue", () => {
    turnSteeringManager.markTurnActive("s1");
    turnSteeringManager.enqueueIfActive("s1", "stale");
    turnSteeringManager.markTurnActive("s1"); // new turn — old queue dropped
    expect(turnSteeringManager.drain("s1")).toEqual([]);

    turnSteeringManager.enqueueIfActive("s1", "live");
    turnSteeringManager.markTurnDone("s1");
    expect(turnSteeringManager.isTurnActive("s1")).toBe(false);
    expect(turnSteeringManager.drain("s1")).toEqual([]);
    expect(turnSteeringManager.enqueueIfActive("s1", "after-done")).toBe(false);
  });

  it("is root-scoped: a sub-agent session steers the parent turn", () => {
    turnSteeringManager.markTurnActive("root1");
    // A message addressed to the running sub-agent still reaches the root turn queue.
    expect(turnSteeringManager.enqueueIfActive("sub:root1:researcher:1780000000000", "focus on the Zwinger")).toBe(true);
    expect(turnSteeringManager.isTurnActive("sub:root1:researcher:1780000000000")).toBe(true);
    // Drained via the root id.
    expect(turnSteeringManager.drain("root1")).toEqual(["focus on the Zwinger"]);
  });
});
