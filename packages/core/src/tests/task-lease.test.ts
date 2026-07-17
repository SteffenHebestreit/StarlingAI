import { afterEach, describe, expect, it } from "vitest";
import {
  acquireTaskLease,
  isTaskLeaseCurrent,
  publishTaskLeaseResult,
  readTaskLeaseResult,
  releaseTaskLease,
  renewTaskLease,
  resetLocksForTests,
  startTaskLeaseHeartbeat,
  taskLeaseKey,
  tryAcquireTaskLease,
  waitForTaskLeaseResult,
} from "../swarm/locks.js";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const scope = (over: Record<string, string> = {}) => ({
  sessionId: "session-a",
  taskId: "task_1",
  taskSignature: "research API behavior::find official docs",
  workspacePath: "/workspace-a",
  userId: "operator-a",
  ...over,
});

describe("fenced task leases", () => {
  afterEach(async () => {
    delete process.env["REDIS_URL"];
    await resetLocksForTests();
  });

  it("scopes identical short task ids by session and workspace", async () => {
    const first = await acquireTaskLease(scope());
    const same = await acquireTaskLease(scope());
    const otherSession = await acquireTaskLease(scope({ sessionId: "session-b" }));
    const otherWorkspace = await acquireTaskLease(scope({ workspacePath: "/workspace-b" }));

    expect(first).not.toBeNull();
    expect(same).toBeNull();
    expect(otherSession).not.toBeNull();
    expect(otherWorkspace).not.toBeNull();
    expect(taskLeaseKey(scope())).not.toBe(taskLeaseKey(scope({ sessionId: "session-b" })));
  });

  it("contends on structural identity, not the positional task id", async () => {
    // Two workers planning the same work assign different positional ids (task_1
    // vs task_3) but the same structural signature — they MUST contend.
    const first = await acquireTaskLease(scope({ taskId: "task_1" }));
    const samePlanDifferentId = await acquireTaskLease(scope({ taskId: "task_3" }));
    expect(first).not.toBeNull();
    expect(samePlanDifferentId).toBeNull();
    expect(taskLeaseKey(scope({ taskId: "task_1" }))).toBe(taskLeaseKey(scope({ taskId: "task_3" })));
    // Without a signature the taskId is the structural identity fallback.
    expect(taskLeaseKey({ sessionId: "s", taskId: "a" })).not.toBe(taskLeaseKey({ sessionId: "s", taskId: "b" }));
    await releaseTaskLease(first!);
  });

  it("distinguishes contention from acquisition in the discriminated API", async () => {
    const first = await tryAcquireTaskLease(scope());
    expect(first.status).toBe("acquired");
    const second = await tryAcquireTaskLease(scope());
    expect(second.status).toBe("contended");
    if (first.status === "acquired") await releaseTaskLease(first.lease);
    const third = await tryAcquireTaskLease(scope());
    expect(third.status).toBe("acquired");
    if (third.status === "acquired") await releaseTaskLease(third.lease);
  });

  it("renews a healthy owner before expiry", async () => {
    const lease = await acquireTaskLease(scope(), 1_000);
    expect(lease).not.toBeNull();
    await pause(700);
    await expect(renewTaskLease(lease!, 1_000)).resolves.toBe(true);
    await pause(700);
    expect(await acquireTaskLease(scope(), 1_000)).toBeNull();
    await releaseTaskLease(lease!);
  });

  it("increments fencing and rejects a stale owner after takeover", async () => {
    const first = await acquireTaskLease(scope(), 1_000);
    expect(first).not.toBeNull();
    await pause(1_100);
    const second = await acquireTaskLease(scope(), 1_000);
    expect(second).not.toBeNull();
    expect(second!.fencingToken).toBeGreaterThan(first!.fencingToken);
    expect(await isTaskLeaseCurrent(first!)).toBe(false);
    expect(await isTaskLeaseCurrent(second!)).toBe(true);
    await releaseTaskLease(second!);
  });

  it("publishes a fence-guarded result that contenders can read and follow (DST-103)", async () => {
    const first = await tryAcquireTaskLease(scope(), 1_000);
    expect(first.status).toBe("acquired");
    if (first.status !== "acquired") return;
    // A contender waiting sees nothing until the owner publishes.
    expect(await readTaskLeaseResult(scope())).toBeNull();
    const published = await publishTaskLeaseResult(first.lease, {
      status: "completed",
      output: "the winning answer",
      agentName: "researcher",
      finishedAt: new Date().toISOString(),
    });
    expect(published).toBe(true);
    const followed = await waitForTaskLeaseResult(scope(), { timeoutMs: 0 });
    expect(followed?.output).toBe("the winning answer");
    expect(followed?.fencingToken).toBe(first.lease.fencingToken);
    await releaseTaskLease(first.lease);
  });

  it("rejects a stale owner's result publish after takeover", async () => {
    const first = await tryAcquireTaskLease(scope(), 1_000);
    expect(first.status).toBe("acquired");
    if (first.status !== "acquired") return;
    await pause(1_100); // expire without renewal
    const second = await tryAcquireTaskLease(scope(), 1_000);
    expect(second.status).toBe("acquired");
    if (second.status !== "acquired") return;
    // The zombie first owner cannot publish an authoritative result...
    expect(await publishTaskLeaseResult(first.lease, {
      status: "completed", output: "stale", agentName: "zombie", finishedAt: new Date().toISOString(),
    })).toBe(false);
    // ...the takeover owner can.
    expect(await publishTaskLeaseResult(second.lease, {
      status: "partial", output: "fresh", agentName: "successor", finishedAt: new Date().toISOString(),
    })).toBe(true);
    expect((await readTaskLeaseResult(scope()))?.output).toBe("fresh");
    await releaseTaskLease(second.lease);
  });

  it("keeps a long-running owner current through heartbeat renewal", async () => {
    const lease = await acquireTaskLease(scope(), 1_000);
    expect(lease).not.toBeNull();
    const heartbeat = startTaskLeaseHeartbeat(lease!, { ttlMs: 1_000, intervalMs: 250 });
    await pause(1_250);
    expect(heartbeat.lost).toBe(false);
    expect(await isTaskLeaseCurrent(lease!)).toBe(true);
    expect(await acquireTaskLease(scope(), 1_000)).toBeNull();
    await heartbeat.stop();
    await releaseTaskLease(lease!);
  });
});