/**
 * The dashboard's view of scheduled tasks: a caller lists and removes its own, an admin everyone's.
 * Routes on a bare Hono app; auth mocked at the module seam; the real store and runner underneath,
 * with the scheduler mocked so no cron job runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import * as configLoader from "../config/loader.js";

const state = vi.hoisted(() => ({
  user: null as { username: string; role: string; account?: string } | null,
  cron: new Map<string, string>(),
  n: 0,
}));

vi.mock("../gateway/auth.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../gateway/auth.js")>();
  return { ...original, verifyToken: async () => true, authenticatedUser: async () => state.user };
});
vi.mock("../runtime/scheduler.js", () => ({
  createCronJob: vi.fn((expression: string) => {
    const id = `cron_${++state.n}`;
    state.cron.set(id, expression);
    return { id };
  }),
  removeCronJob: vi.fn((id: string) => state.cron.delete(id)),
  listCronJobs: vi.fn(() => [...state.cron.keys()].map((id) => ({ id, nextFireAt: "2026-11-13T07:00:00.000Z" }))),
}));
vi.mock("../agent/jobs.js", () => ({ createJob: vi.fn(async () => ({ id: "job" })) }));

import { addAndActivateScheduledTask, _resetScheduledTaskRuntimeForTests } from "../runtime/scheduled-task-runner.js";
import { _setScheduledTasksPathForTests, listScheduledTaskRecords } from "../runtime/scheduled-tasks.js";

const baseConfig = configLoader.getConfig();
let multiUser = true;
let dir = "";
const ALICE = "alice-0123456789abcdef";
const BOB = "bob-0123456789abcdef";
const AUTH = { Authorization: "Bearer test-token" };

async function buildApp(): Promise<Hono> {
  const { registerScheduleRoutes } = await import("../gateway/schedule-routes.js");
  const app = new Hono();
  registerScheduleRoutes(app);
  return app;
}

beforeEach(() => {
  multiUser = true;
  state.cron.clear();
  vi.spyOn(configLoader, "getConfig").mockImplementation(() => ({ ...baseConfig, auth: { ...baseConfig.auth, enabled: multiUser } }) as ReturnType<typeof configLoader.getConfig>);
  dir = mkdtempSync(join(tmpdir(), "schedule-routes-"));
  _setScheduledTasksPathForTests(join(dir, "scheduled-tasks.json"));
  addAndActivateScheduledTask({
    id: "hers", cron: "0 7 * * *", label: "Release watch", task: "check the release", until: "it is out", maxRuns: 30, runs: 2,
    lastRunAt: "2026-11-12T07:00:20.000Z", lastOutcome: "nothing_new", sessionId: "chat-1", userId: "alice", account: ALICE, createdAt: "2026-11-11T10:00:00Z",
  });
  addAndActivateScheduledTask({ id: "his", at: "2099-01-01T09:00:00.000Z", label: "Reminder", task: "remind", userId: "bob", account: BOB, createdAt: "2026-11-12T10:00:00Z" });
});

afterEach(() => {
  vi.restoreAllMocks();
  _resetScheduledTaskRuntimeForTests();
  _setScheduledTasksPathForTests(null);
  if (dir) { rmSync(dir, { recursive: true, force: true }); dir = ""; }
});

describe("GET /api/schedules", () => {
  it("lists the caller's own schedules, with what the page shows and not whose they are", async () => {
    state.user = { username: "alice", role: "operator", account: ALICE };
    const res = await (await buildApp()).request("/api/schedules", { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      schedules: [{
        id: "hers", label: "Release watch", task: "check the release", cron: "0 7 * * *", until: "it is out", maxRuns: 30, runs: 2,
        lastRunAt: "2026-11-12T07:00:20.000Z", lastOutcome: "nothing_new", nextRunAt: "2026-11-13T07:00:00.000Z", sessionId: "chat-1",
        createdAt: "2026-11-11T10:00:00Z",
      }],
    });
  });

  it("lists everyone's for an admin, newest first, each with its owner", async () => {
    state.user = { username: "root", role: "admin", account: "root-0123456789abcdef" };
    const body = await (await (await buildApp()).request("/api/schedules", { headers: AUTH })).json() as { schedules: Array<Record<string, unknown>> };
    expect(body.schedules.map((entry) => [entry["id"], entry["userId"]])).toEqual([["his", "bob"], ["hers", "alice"]]);
    expect(body.schedules[0]).toMatchObject({ at: "2099-01-01T09:00:00.000Z", nextRunAt: "2099-01-01T09:00:00.000Z", runs: 0 });
  });

  it("lists every schedule for the one operator", async () => {
    multiUser = false;
    state.user = null;
    const body = await (await (await buildApp()).request("/api/schedules", { headers: AUTH })).json() as { schedules: unknown[] };
    expect(body.schedules).toHaveLength(2);
  });

  it("is not answered without a token", async () => {
    expect((await (await buildApp()).request("/api/schedules")).status).toBe(401);
  });
});

describe("DELETE /api/schedules/:id", () => {
  it("removes the caller's own schedule, and its cron job with it", async () => {
    state.user = { username: "alice", role: "operator", account: ALICE };
    expect(state.cron.size).toBe(1);
    const res = await (await buildApp()).request("/api/schedules/hers", { method: "DELETE", headers: AUTH });
    expect(res.status).toBe(200);
    expect(listScheduledTaskRecords().map((rec) => rec.id)).toEqual(["his"]);
    expect(state.cron.size).toBe(0);
  });

  it("answers another account's schedule as a missing one, and leaves it", async () => {
    state.user = { username: "alice", role: "operator", account: ALICE };
    const res = await (await buildApp()).request("/api/schedules/his", { method: "DELETE", headers: AUTH });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "No scheduled task with id: his" });
    expect(listScheduledTaskRecords()).toHaveLength(2);
  });

  it("lets an admin remove anyone's", async () => {
    state.user = { username: "root", role: "admin", account: "root-0123456789abcdef" };
    expect((await (await buildApp()).request("/api/schedules/his", { method: "DELETE", headers: AUTH })).status).toBe(200);
    expect(listScheduledTaskRecords().map((rec) => rec.id)).toEqual(["hers"]);
  });
});
