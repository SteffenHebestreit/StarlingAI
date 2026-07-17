/**
 * UX-501/502: mission flight-recorder reads + operator cancel control.
 * Routes on a bare Hono app; auth + the distributed-cancel plumbing mocked at
 * the module seam; local mission-store/budget adapters underneath.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { getMissionStore, resetMissionStoreForTests } from "../swarm/mission-store.js";
import { resetMissionBudgetForTests, reserveMissionBudget, reconcileMissionBudget } from "../swarm/mission-budget.js";

const authState = vi.hoisted(() => ({
  user: { username: "op", role: "operator", displayName: "Op" } as { username: string; role: string; displayName?: string } | null,
}));
const cancelState = vi.hoisted(() => ({ abortedLocally: true, commandId: "cmd-test" }));

// authenticatedUser is mocked; userHasRole is the REAL rank-based helper (spread
// from the original), so the in-handler operator gate is genuinely exercised.
vi.mock("../gateway/auth.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../gateway/auth.js")>();
  return { ...original, authenticatedUser: async () => authState.user };
});

// The distributed-cancel plumbing has its own tests (distributed-control.test.ts);
// here we drive abortedLocally to exercise the route's confirmed/unconfirmed split.
vi.mock("../swarm/control.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../swarm/control.js")>();
  return { ...original, requestDistributedSessionCancel: async () => ({ commandId: cancelState.commandId, abortedLocally: cancelState.abortedLocally }) };
});

async function buildApp(): Promise<Hono> {
  const { registerMissionRoutes } = await import("../gateway/mission-routes.js");
  const app = new Hono();
  registerMissionRoutes(app);
  return app;
}

const AUTH = { Authorization: "Bearer test-token" };

describe("mission flight recorder routes (UX-501/502)", () => {
  beforeEach(() => {
    // Keep tests hermetic against the local adapters even if the dev shell has a
    // Postgres/Redis URL set (the sibling suites do the same).
    delete process.env["DATABASE_URL"];
    delete process.env["REDIS_URL"];
    authState.user = { username: "op", role: "operator", displayName: "Op" };
    cancelState.abortedLocally = true;
    cancelState.commandId = "cmd-test";
  });
  afterEach(async () => {
    await resetMissionStoreForTests();
    await resetMissionBudgetForTests();
  });

  it("lists missions newest-first with a cost rollup", async () => {
    const store = await getMissionStore();
    const m1 = await store.getOrCreateMissionForSession({ rootSessionId: "fr-1", objective: "first" });
    await store.getOrCreateMissionForSession({ rootSessionId: "fr-2", objective: "second" });
    const reserve = await reserveMissionBudget(m1.id, { tokens: 100, toolCalls: 2, activeTimeMs: 1000 });
    if (reserve.granted) await reconcileMissionBudget(reserve.reservation, { tokens: 80, toolCalls: 2, activeTimeMs: 900 });

    const app = await buildApp();
    const res = await app.request("/api/missions", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json() as { missions: Array<{ id: string; budgetTokensSpent: number }> };
    expect(body.missions.length).toBe(2);
    expect(body.missions.find((m) => m.id === m1.id)?.budgetTokensSpent).toBe(80);
  });

  it("returns the full flight record: mission + ordered events + budget + truncation flag", async () => {
    const store = await getMissionStore();
    const mission = await store.getOrCreateMissionForSession({ rootSessionId: "fr-3", objective: "record me" });
    await store.appendMissionEvent(mission.id, { type: "task_claimed", actor: "coder", payload: { taskId: "t1" } });
    await store.appendMissionEvent(mission.id, { type: "task_completed", actor: "coder", payload: { taskId: "t1" } });

    const app = await buildApp();
    const res = await app.request(`/api/missions/${mission.id}`, { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json() as { mission: { id: string }; events: Array<{ type: string; sequence: number }>; truncated: boolean; summary: { eventCount: number; status: string } };
    expect(body.mission.id).toBe(mission.id);
    expect(body.events.map((e) => e.type)).toEqual(["mission_created", "task_claimed", "task_completed"]);
    expect(body.events.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(body.truncated).toBe(false);
    expect(body.summary.eventCount).toBe(3);
    expect(body.summary.status).toBe("active");
  });

  it("the timeline pages from the TAIL when a mission exceeds the event limit", async () => {
    const store = await getMissionStore();
    const mission = await store.getOrCreateMissionForSession({ rootSessionId: "fr-tail", objective: "long" });
    for (let i = 0; i < 12; i++) await store.appendMissionEvent(mission.id, { type: "task_claimed", actor: "a", payload: { i } });
    const { getMissionFlightRecord } = await import("../swarm/mission-flight-recorder.js");
    const record = (await getMissionFlightRecord(mission.id, 5))!;
    expect(record.truncated).toBe(true);
    expect(record.events).toHaveLength(5);
    // Newest 5 (sequences 9..13 of the 13 total: 1 created + 12 claimed), not the oldest.
    expect(record.events.map((e) => e.sequence)).toEqual([9, 10, 11, 12, 13]);
  });

  it("reads reject unauthenticated (401), non-operator (403), unknown (404), and malformed ids (404)", async () => {
    const app = await buildApp();
    authState.user = null;
    expect((await app.request("/api/missions")).status).toBe(401);
    authState.user = { username: "v", role: "viewer" };
    expect((await app.request("/api/missions", { headers: AUTH })).status).toBe(403);
    authState.user = { username: "op", role: "operator" };
    expect((await app.request("/api/missions/123e4567-e89b-12d3-a456-426614174000", { headers: AUTH })).status).toBe(404);
    // Malformed (non-UUID) id → 404, not a 500 from a Postgres uuid cast.
    expect((await app.request("/api/missions/not-a-uuid", { headers: AUTH })).status).toBe(404);
  });

  it("operator cancel (CONFIRMED): records mission_cancelled, flips terminal, idempotent", async () => {
    const store = await getMissionStore();
    const mission = await store.getOrCreateMissionForSession({ rootSessionId: "fr-4", objective: "cancel me" });
    cancelState.abortedLocally = true; // the owning turn was aborted → confirmed

    const app = await buildApp();
    const res = await app.request(`/api/missions/${mission.id}/cancel`, {
      method: "POST", headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "operator changed course" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; status: string; commandId: string };
    expect(body).toMatchObject({ ok: true, status: "cancelled" });
    expect((await store.getMission(mission.id))?.status).toBe("cancelled");

    const again = await app.request(`/api/missions/${mission.id}/cancel`, { method: "POST", headers: AUTH });
    expect(again.status).toBe(200);
    expect((await again.json() as { alreadyTerminal?: boolean }).alreadyTerminal).toBe(true);
    expect((await store.listMissionEvents(mission.id)).filter((e) => e.type === "mission_cancelled")).toHaveLength(1);
  });

  it("operator cancel (UNCONFIRMED): 409, mission stays ACTIVE, no terminal event", async () => {
    const store = await getMissionStore();
    const mission = await store.getOrCreateMissionForSession({ rootSessionId: "fr-6", objective: "remote" });
    cancelState.abortedLocally = false; // not owned here, distributedCancel default off → cannot confirm

    const app = await buildApp();
    const res = await app.request(`/api/missions/${mission.id}/cancel`, { method: "POST", headers: AUTH });
    expect(res.status).toBe(409);
    const body = await res.json() as { ok: boolean; unconfirmed: boolean; status: string };
    expect(body).toMatchObject({ ok: false, unconfirmed: true, status: "active" });
    // The mission must remain active and re-cancellable — no false terminal.
    expect((await store.getMission(mission.id))?.status).toBe("active");
    expect((await store.listMissionEvents(mission.id)).some((e) => e.type === "mission_cancelled")).toBe(false);
  });

  it("cancel is operator-gated: a viewer is 403'd and no authed user is 401'd", async () => {
    const store = await getMissionStore();
    const mission = await store.getOrCreateMissionForSession({ rootSessionId: "fr-5", objective: "protected" });
    const app = await buildApp();

    authState.user = { username: "v", role: "viewer" };
    expect((await app.request(`/api/missions/${mission.id}/cancel`, { method: "POST", headers: AUTH })).status).toBe(403);
    authState.user = null;
    expect((await app.request(`/api/missions/${mission.id}/cancel`, { method: "POST", headers: AUTH })).status).toBe(401);
    // And the mission was never touched.
    expect((await store.getMission(mission.id))?.status).toBe("active");
  });

  it("an admin (rank ≥ operator) is allowed to cancel — no exact-match lockout", async () => {
    const store = await getMissionStore();
    const mission = await store.getOrCreateMissionForSession({ rootSessionId: "fr-admin", objective: "admin cancels" });
    authState.user = { username: "root", role: "admin" };
    cancelState.abortedLocally = true;
    const app = await buildApp();
    const res = await app.request(`/api/missions/${mission.id}/cancel`, { method: "POST", headers: AUTH });
    expect(res.status).toBe(200);
    expect((await store.getMission(mission.id))?.status).toBe("cancelled");
  });
});
