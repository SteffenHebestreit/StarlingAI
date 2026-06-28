/**
 * Tier 3 (privileged, per-call approval) — schedule a recurring TASK that runs as a
 * real autonomous turn each time it fires (a "standing agent"). Unlike cron_create
 * (which only logs a shared finding), schedule_task runs the task through the full
 * turn pipeline via createJob, and the schedule is PERSISTED so it survives restarts.
 */
import { randomBytes } from "node:crypto";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { addAndActivateScheduledTask, removeScheduledTask } from "../runtime/scheduled-task-runner.js";
import { listScheduledTaskRecords } from "../runtime/scheduled-tasks.js";
import { childLogger } from "../logger.js";

const log = childLogger("tool:schedule");

registerTool({
  name: "schedule_task",
  description:
    "Schedule a recurring TASK that runs as a real autonomous turn each time it fires — a " +
    "standing agent (e.g. 'every weekday 08:00, research today's AI news and brief me'). Unlike " +
    "cron_create (which only logs a note), this runs the task through the full turn pipeline and " +
    "captures the result as a job run. Schedules are persisted and survive restarts.",
  parameters: {
    type: "object",
    properties: {
      cron: { type: "string", description: "5-field cron expression in UTC. E.g. '0 8 * * 1-5' = weekdays at 08:00." },
      label: { type: "string", description: "Short human-readable label for the schedule." },
      task: { type: "string", description: "The instruction to run each time it fires, written as if the user typed it." },
    },
    required: ["cron", "label", "task"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const cron = String(args["cron"] ?? "").trim();
    const label = String(args["label"] ?? "").trim();
    const task = String(args["task"] ?? "").trim();
    if (!cron) return { success: false, output: "", error: "cron is required" };
    if (!label) return { success: false, output: "", error: "label is required" };
    if (!task) return { success: false, output: "", error: "task is required" };
    try {
      const { CronTime } = await import("cron");

      new CronTime(cron);
    } catch {
      return { success: false, output: "", error: `Invalid cron expression: ${cron}` };
    }

    const id = `sched_${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
    addAndActivateScheduledTask({
      id,
      cron,
      label,
      task,
      ...(ctx.userId ? { userId: ctx.userId } : {}),
      createdAt: new Date().toISOString(),
    });
    log.info({ id, cron, label, sessionId: ctx.sessionId }, "schedule_task");

    return {
      success: true,
      output: `Scheduled **${id}** — "${label}"\nRuns: \`${cron}\` (UTC)\nTask: ${task}\n\nEach run executes as a real turn (captured as a job run). Remove it with schedule_remove.`,
      metadata: { scheduleId: id, cron, label },
    };
  },
});

registerTool({
  name: "schedule_list",
  description: "List all persistent scheduled tasks (standing agents).",
  parameters: { type: "object", properties: {} },
  async execute(): Promise<ToolResult> {
    const recs = listScheduledTaskRecords();
    if (recs.length === 0) return { success: true, output: "No scheduled tasks.", metadata: { count: 0 } };
    const lines = recs.map((r) => `- **${r.id}** "${r.label}" — \`${r.cron}\` — ${r.task}`);
    return { success: true, output: `## Scheduled tasks (${recs.length})\n\n${lines.join("\n")}`, metadata: { count: recs.length } };
  },
});

registerTool({
  name: "schedule_remove",
  description: "Remove a persistent scheduled task by its id.",
  parameters: {
    type: "object",
    properties: { scheduleId: { type: "string", description: "The schedule id (e.g. 'sched_...')." } },
    required: ["scheduleId"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const id = String(args["scheduleId"] ?? "").trim();
    if (!id) return { success: false, output: "", error: "scheduleId is required" };
    const removed = removeScheduledTask(id);
    if (!removed) return { success: false, output: "", error: `No scheduled task with id: ${id}` };
    return { success: true, output: `Scheduled task ${id} removed.`, metadata: { scheduleId: id } };
  },
});
