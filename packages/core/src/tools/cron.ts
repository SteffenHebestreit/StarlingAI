/**
 * Tier 3 (privileged, per-call approval) — Create, list, and remove
 * in-memory cron jobs.  Jobs are NOT persisted across restarts.
 */
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import {
  createCronJob,
  listCronJobs,
  removeCronJob,
} from "../runtime/scheduler.js";
import { childLogger } from "../logger.js";

const log = childLogger("tool:cron");

// ── cron_create ───────────────────────────────────────────────────────────────

registerTool({
  name: "cron_create",
  description:
    "Create a recurring scheduled job using a cron expression. " +
    "The job runs an action description that is logged and published as a shared finding each time it fires. " +
    "Jobs are in-memory only — they do not survive process restarts.",
  parameters: {
    type: "object",
    properties: {
      expression: {
        type: "string",
        description:
          "Standard cron expression (5 fields: minute hour day-of-month month day-of-week). " +
          "Examples: '*/5 * * * *' (every 5 min), '0 9 * * 1-5' (weekdays at 09:00 UTC).",
      },
      label: {
        type: "string",
        description: "Short human-readable label for this job.",
      },
      action: {
        type: "string",
        description:
          "Description of what this job should do when it fires. " +
          "This is stored as a reference note — the cron tick logs it and publishes a shared finding.",
      },
    },
    required: ["expression", "label", "action"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const expression = String(args["expression"] ?? "").trim();
    const label = String(args["label"] ?? "").trim();
    const action = String(args["action"] ?? "").trim();

    if (!expression) {
      return { success: false, output: "", error: "expression is required" };
    }
    if (!label) {
      return { success: false, output: "", error: "label is required" };
    }
    if (!action) {
      return { success: false, output: "", error: "action is required" };
    }

    // Validate cron expression by attempting to parse it
    try {
      const { CronTime } = await import("cron");
       
      new CronTime(expression);
    } catch {
      return { success: false, output: "", error: `Invalid cron expression: ${expression}` };
    }

    log.info({ expression, label, sessionId: ctx.sessionId }, "cron_create");

    // Import share_finding dynamically to avoid circular dependency
    const { shareFinding } = await import("./memory.js");

    const job = createCronJob(expression, label, action, async () => {
      try {
        await shareFinding(ctx.sessionId, label, action);
      } catch (err) {
        log.warn({ err, jobId: job.id }, "share_finding from cron job failed");
      }
    });

    return {
      success: true,
      output: `Cron job created: **${job.id}** — "${label}"\nSchedule: \`${expression}\` (UTC)\nAction: ${action}`,
      metadata: { jobId: job.id, expression, label },
    };
  },
});

// ── cron_list ─────────────────────────────────────────────────────────────────

registerTool({
  name: "cron_list",
  description: "List all active cron jobs.",
  parameters: { type: "object", properties: {} },
  async execute(): Promise<ToolResult> {
    const jobs = listCronJobs();
    if (jobs.length === 0) {
      return { success: true, output: "No active cron jobs.", metadata: { count: 0 } };
    }

    const lines = jobs.map(
      (j) =>
        `- **${j.id}** "${j.label}" — \`${j.expression}\` — fired ${j.fireCount}x` +
        (j.lastFiredAt ? ` (last: ${j.lastFiredAt.toISOString()})` : ""),
    );

    return {
      success: true,
      output: `## Active Cron Jobs (${jobs.length})\n\n${lines.join("\n")}`,
      metadata: { count: jobs.length },
    };
  },
});

// ── cron_remove ───────────────────────────────────────────────────────────────

registerTool({
  name: "cron_remove",
  description: "Stop and remove an active cron job by its ID.",
  parameters: {
    type: "object",
    properties: {
      jobId: {
        type: "string",
        description: "The ID of the cron job to remove (e.g. 'cron_1').",
      },
    },
    required: ["jobId"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const jobId = String(args["jobId"] ?? "").trim();
    if (!jobId) {
      return { success: false, output: "", error: "jobId is required" };
    }

    const removed = removeCronJob(jobId);
    if (!removed) {
      return { success: false, output: "", error: `No cron job found with ID: ${jobId}` };
    }

    return {
      success: true,
      output: `Cron job ${jobId} stopped and removed.`,
      metadata: { jobId },
    };
  },
});
