import { afterEach, describe, expect, it } from "vitest";
import {
  getMissionStore,
  reduceMissionStatus,
  resetMissionStoreForTests,
  startMissionEventBridge,
} from "../swarm/mission-store.js";
import { emitSwarmEvent } from "../swarm/bus.js";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("mission store (MIS-201, local adapter)", () => {
  afterEach(async () => {
    await resetMissionStoreForTests();
  });

  it("creates one mission per root session with a mission_created event", async () => {
    const store = await getMissionStore();
    const first = await store.getOrCreateMissionForSession({ rootSessionId: "sess-1", objective: "build a report" });
    const again = await store.getOrCreateMissionForSession({ rootSessionId: "sess-1" });
    expect(again.id).toBe(first.id);
    expect(first.status).toBe("active");
    const events = await store.listMissionEvents(first.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("mission_created");
    expect(events[0]?.sequence).toBe(1);
  });

  it("appends with per-mission monotonic sequences and bumps the projection version", async () => {
    const store = await getMissionStore();
    const mission = await store.getOrCreateMissionForSession({ rootSessionId: "sess-2" });
    const a = await store.appendMissionEvent(mission.id, { type: "task_claimed", actor: "researcher" });
    const b = await store.appendMissionEvent(mission.id, { type: "task_completed", actor: "researcher" });
    expect(a).toMatchObject({ accepted: true, sequence: 2 });
    expect(b).toMatchObject({ accepted: true, sequence: 3 });
    const current = await store.getMission(mission.id);
    expect(current?.eventCount).toBe(3);
    expect(current?.version).toBe(3);
  });

  it("rejects an append with a stale expected version (optimistic concurrency)", async () => {
    const store = await getMissionStore();
    const mission = await store.getOrCreateMissionForSession({ rootSessionId: "sess-3" });
    const fresh = await store.getMission(mission.id);
    const ok = await store.appendMissionEvent(mission.id, { type: "task_claimed" }, { expectedVersion: fresh!.version });
    expect(ok.accepted).toBe(true);
    const stale = await store.appendMissionEvent(mission.id, { type: "task_claimed" }, { expectedVersion: fresh!.version });
    expect(stale).toMatchObject({ accepted: false, reason: "version_conflict" });
  });

  it("is idempotent on the event idempotency key (crash-retry cannot double-append)", async () => {
    const store = await getMissionStore();
    const mission = await store.getOrCreateMissionForSession({ rootSessionId: "sess-4" });
    const first = await store.appendMissionEvent(mission.id, { type: "task_completed", idempotencyKey: "evt-1" });
    const retry = await store.appendMissionEvent(mission.id, { type: "task_completed", idempotencyKey: "evt-1" });
    expect(first.accepted).toBe(true);
    expect(first.accepted && first.duplicate).toBeFalsy();
    expect(retry).toMatchObject({ accepted: true, duplicate: true });
    if (first.accepted && retry.accepted) expect(retry.sequence).toBe(first.sequence);
    expect((await store.listMissionEvents(mission.id)).filter((e) => e.type === "task_completed")).toHaveLength(1);
  });

  it("derives mission status only from events, and the projection is rebuildable", async () => {
    expect(reduceMissionStatus("active", "task_failed")).toBe("active");
    expect(reduceMissionStatus("active", "mission_completed")).toBe("completed");
    const store = await getMissionStore();
    const mission = await store.getOrCreateMissionForSession({ rootSessionId: "sess-5" });
    await store.appendMissionEvent(mission.id, { type: "task_completed" });
    await store.appendMissionEvent(mission.id, { type: "mission_completed" });
    expect((await store.getMission(mission.id))?.status).toBe("completed");
    const rebuilt = await store.rebuildMissionProjection(mission.id);
    expect(rebuilt?.status).toBe("completed");
    expect(rebuilt?.eventCount).toBe(3);
  });

  it("bridge (shadow mode): task-lifecycle swarm events append mission events idempotently", async () => {
    const stop = startMissionEventBridge();
    try {
      emitSwarmEvent("task_claimed", { sessionId: "bridge-sess", taskId: "t1", agentName: "coder", task: "Do the thing" });
      emitSwarmEvent("task_completed", { sessionId: "bridge-sess", taskId: "t1", agentName: "coder" });
      emitSwarmEvent("task_bid", { sessionId: "bridge-sess", taskId: "t1", agentName: "coder" }); // not a mission event
      await pause(150); // bridge appends asynchronously
      const store = await getMissionStore();
      const mission = await store.getMissionBySession("bridge-sess");
      expect(mission).not.toBeNull();
      const events = await store.listMissionEvents(mission!.id);
      const types = events.map((e) => e.type);
      expect(types).toContain("task_claimed");
      expect(types).toContain("task_completed");
      expect(types).not.toContain("task_bid");
      expect(mission!.status).toBe("active"); // task completion does not complete the mission
    } finally {
      stop();
    }
  });
});

describe.skipIf(!process.env["DATABASE_URL"])("mission store (PostgreSQL, integration)", () => {
  afterEach(async () => {
    await resetMissionStoreForTests();
  });

  it("appends transactionally with idempotency and version conflict on real Postgres", async () => {
    const store = await getMissionStore();
    const rootSessionId = `pg-int-${Date.now()}`;
    const mission = await store.getOrCreateMissionForSession({ rootSessionId, objective: "pg check" });
    const first = await store.appendMissionEvent(mission.id, { type: "task_completed", idempotencyKey: "pg-evt" });
    const retry = await store.appendMissionEvent(mission.id, { type: "task_completed", idempotencyKey: "pg-evt" });
    expect(first.accepted).toBe(true);
    expect(retry).toMatchObject({ accepted: true, duplicate: true });
    const fresh = await store.getMission(mission.id);
    const stale = await store.appendMissionEvent(mission.id, { type: "task_claimed" }, { expectedVersion: fresh!.version - 1 });
    expect(stale).toMatchObject({ accepted: false, reason: "version_conflict" });
    const rebuilt = await store.rebuildMissionProjection(mission.id);
    expect(rebuilt?.eventCount).toBe(fresh?.eventCount);
  }, 30_000);
});
