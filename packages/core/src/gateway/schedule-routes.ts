/**
 * Scheduled tasks for the dashboard: what the assistant was asked to run later, to repeat or to
 * watch (tools/schedule.ts), and a way to stop one without asking in a chat.
 *
 *   GET    /api/schedules       — the caller's scheduled tasks; an admin's listing has everyone's
 *   DELETE /api/schedules/:id   — remove one: it does not run again
 *
 * Whose they are is decided as for the job runs (scene-job-access.ts) and the schedule tools: by
 * identity under multi-user auth, with an admin seeing all; with one operator every schedule is
 * theirs. A schedule that is not the caller's answers as a missing one.
 */
import type { Hono } from "hono";
import { extractBearerToken, verifyToken } from "./auth.js";
import { sceneJobViewer, type SceneJobViewer } from "./scene-job-access.js";
import { scheduleOwnerIdentity } from "../runtime/follow-up.js";
import { nextScheduledRun, removeScheduledTask } from "../runtime/scheduled-task-runner.js";
import { listScheduledTaskRecords, type ScheduledTaskRecord } from "../runtime/scheduled-tasks.js";
import { ownsRecord } from "../runtime/user-scope.js";

function maySee(viewer: SceneJobViewer, rec: ScheduledTaskRecord): boolean {
  return viewer.all || (viewer.identity !== undefined && ownsRecord(viewer.identity, scheduleOwnerIdentity(rec)));
}

/** A schedule as the dashboard shows it. Only a viewer of every schedule is told whose each is. */
export function presentSchedule(rec: ScheduledTaskRecord, viewer: SceneJobViewer): Record<string, unknown> {
  const nextRunAt = nextScheduledRun(rec);
  return {
    id: rec.id,
    label: rec.label,
    task: rec.task,
    ...(rec.cron ? { cron: rec.cron } : {}),
    ...(rec.at ? { at: rec.at } : {}),
    ...(rec.timeZone ? { timeZone: rec.timeZone } : {}),
    ...(rec.until ? { until: rec.until } : {}),
    ...(rec.maxRuns !== undefined ? { maxRuns: rec.maxRuns } : {}),
    runs: rec.runs ?? 0,
    ...(rec.lastRunAt ? { lastRunAt: rec.lastRunAt } : {}),
    ...(rec.lastOutcome ? { lastOutcome: rec.lastOutcome } : {}),
    ...(nextRunAt ? { nextRunAt } : {}),
    ...(rec.sessionId ? { sessionId: rec.sessionId } : {}),
    createdAt: rec.createdAt,
    ...(rec.disabled ? { disabled: rec.disabled.reason } : {}),
    ...(viewer.all && rec.userId ? { userId: rec.userId } : {}),
  };
}

export function registerScheduleRoutes(app: Hono): void {
  app.get("/api/schedules", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const viewer = await sceneJobViewer(c.req.header("Authorization"));
    const schedules = listScheduledTaskRecords()
      .filter((rec) => maySee(viewer, rec))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((rec) => presentSchedule(rec, viewer));
    return c.json({ schedules });
  });

  app.delete("/api/schedules/:id", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const id = c.req.param("id");
    const viewer = await sceneJobViewer(c.req.header("Authorization"));
    const target = listScheduledTaskRecords().find((rec) => rec.id === id);
    if (!target || !maySee(viewer, target)) return c.json({ error: `No scheduled task with id: ${id}` }, 404);
    removeScheduledTask(id);
    return c.json({ ok: true, removedScheduleId: id });
  });
}
