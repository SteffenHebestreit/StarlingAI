import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emitSwarmEvent,
  onSwarmEvent,
  isSwarmBusConnected,
  resetSwarmBusForTests,
  type SwarmEvent,
} from "../swarm/bus.js";
import { acquireTaskLock, releaseTaskLock, resetLocksForTests } from "../swarm/locks.js";

describe("Swarm Bus — in-process event delivery", () => {
  afterEach(async () => {
    resetSwarmBusForTests();
    await resetLocksForTests();
  });

  it("delivers events to subscribers", () => {
    const received: SwarmEvent[] = [];
    const unsub = onSwarmEvent(e => received.push(e));

    emitSwarmEvent("task_announced", { sessionId: "s1", taskId: "t1", task: "do something" });
    emitSwarmEvent("task_claimed", { sessionId: "s1", taskId: "t1", agentName: "code_writer" });
    emitSwarmEvent("task_completed", { sessionId: "s1", taskId: "t1", agentName: "code_writer" });

    unsub();

    expect(received).toHaveLength(3);
    expect(received[0]!.type).toBe("task_announced");
    expect(received[1]!.type).toBe("task_claimed");
    expect(received[2]!.type).toBe("task_completed");
  });

  it("each event gets a unique id and ISO timestamp", () => {
    const received: SwarmEvent[] = [];
    const unsub = onSwarmEvent(e => received.push(e));

    emitSwarmEvent("task_announced", { taskId: "t2" });
    emitSwarmEvent("task_announced", { taskId: "t3" });

    unsub();

    expect(received[0]!.id).not.toBe(received[1]!.id);
    expect(() => new Date(received[0]!.ts)).not.toThrow();
  });

  it("truncates task description to 120 chars", () => {
    const longTask = "a".repeat(200);
    const received: SwarmEvent[] = [];
    const unsub = onSwarmEvent(e => received.push(e));

    emitSwarmEvent("task_announced", { task: longTask });

    unsub();

    expect(received[0]!.task!.length).toBe(120);
  });

  it("stops delivering events after unsubscribe", () => {
    const received: SwarmEvent[] = [];
    const unsub = onSwarmEvent(e => received.push(e));

    emitSwarmEvent("task_announced", { taskId: "t1" });
    unsub();
    emitSwarmEvent("task_announced", { taskId: "t2" });

    expect(received).toHaveLength(1);
  });

  it("reports not connected without Redis", () => {
    expect(isSwarmBusConnected()).toBe(false);
  });
});

describe("Swarm Bus — event types", () => {
  afterEach(() => { resetSwarmBusForTests(); });

  it("emits all event types", () => {
    const types: string[] = [];
    const unsub = onSwarmEvent(e => types.push(e.type));

    emitSwarmEvent("task_announced", {});
    emitSwarmEvent("task_bid", {});
    emitSwarmEvent("task_claimed", {});
    emitSwarmEvent("task_completed", {});
    emitSwarmEvent("task_failed", {});
    emitSwarmEvent("task_requeued", {});
    emitSwarmEvent("agent_promoted", {});
    emitSwarmEvent("agent_message", {});
    emitSwarmEvent("agent_broadcast", {});
    emitSwarmEvent("agent_capability_announce", {});

    unsub();

    expect(types).toEqual([
      "task_announced", "task_bid", "task_claimed", "task_completed",
      "task_failed", "task_requeued", "agent_promoted", "agent_message", "agent_broadcast", "agent_capability_announce",
    ]);
  });
});

describe("Distributed Task Locks — in-process fallback", () => {
  afterEach(async () => { await resetLocksForTests(); });

  it("grants lock to first requester", async () => {
    const owner = await acquireTaskLock("task-A");
    expect(owner).toBeTruthy();
  });

  it("denies lock to second requester while first holds it", async () => {
    const owner1 = await acquireTaskLock("task-B");
    const owner2 = await acquireTaskLock("task-B");

    expect(owner1).toBeTruthy();
    expect(owner2).toBeNull();
  });

  it("allows re-acquisition after release", async () => {
    const owner1 = await acquireTaskLock("task-C");
    expect(owner1).toBeTruthy();

    await releaseTaskLock("task-C", owner1!);

    const owner2 = await acquireTaskLock("task-C");
    expect(owner2).toBeTruthy();
    expect(owner2).not.toBe(owner1);
  });

  it("does not release a lock owned by someone else", async () => {
    await acquireTaskLock("task-D"); // owner1 holds it
    const owner2 = "fake-owner";
    await releaseTaskLock("task-D", owner2); // should not release

    const owner3 = await acquireTaskLock("task-D"); // should still be locked
    expect(owner3).toBeNull();
  });

  it("allows independent locks on different tasks", async () => {
    const o1 = await acquireTaskLock("task-E");
    const o2 = await acquireTaskLock("task-F");

    expect(o1).toBeTruthy();
    expect(o2).toBeTruthy();
  });
});
