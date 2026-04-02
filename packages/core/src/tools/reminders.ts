import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { createReminder, listReminders, removeReminder } from "../runtime/reminders.js";

function parsePositiveNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function resolveReminderDueAt(args: Record<string, unknown>): Date | null {
  const dueAtRaw = String(args["dueAt"] ?? "").trim();
  const inSeconds = parsePositiveNumber(args["inSeconds"]);
  const inMinutes = parsePositiveNumber(args["inMinutes"]);

  const modes = [dueAtRaw ? "dueAt" : "", inSeconds ? "inSeconds" : "", inMinutes ? "inMinutes" : ""].filter(Boolean);
  if (modes.length !== 1) {
    return null;
  }

  if (dueAtRaw) {
    const dueAt = new Date(dueAtRaw);
    return Number.isNaN(dueAt.getTime()) ? null : dueAt;
  }

  const delayMs = inSeconds ? inSeconds * 1_000 : (inMinutes ?? 0) * 60_000;
  return new Date(Date.now() + delayMs);
}

registerTool({
  name: "reminder_create",
  description:
    "Create a one-time reminder that will publish a browser notification when it becomes due. " +
    "Reminders are in-memory only and currently tied to the running gateway process.",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Short reminder title shown in the notification.",
      },
      message: {
        type: "string",
        description: "Reminder body shown in the notification.",
      },
      dueAt: {
        type: "string",
        description: "Absolute ISO timestamp for when the reminder should fire.",
      },
      inSeconds: {
        type: "number",
        description: "Relative delay in seconds. Use either dueAt, inSeconds, or inMinutes.",
      },
      inMinutes: {
        type: "number",
        description: "Relative delay in minutes. Use either dueAt, inSeconds, or inMinutes.",
      },
      targetPath: {
        type: "string",
        description: "Optional dashboard path to open from the notification.",
      },
      sticky: {
        type: "boolean",
        description: "When true, the toast stays visible until dismissed.",
      },
    },
    required: ["title", "message"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const title = String(args["title"] ?? "").trim();
    const message = String(args["message"] ?? "").trim();
    const dueAt = resolveReminderDueAt(args);

    if (!title) {
      return { success: false, output: "", error: "title is required" };
    }
    if (!message) {
      return { success: false, output: "", error: "message is required" };
    }
    if (!dueAt) {
      return {
        success: false,
        output: "",
        error: "Provide exactly one of dueAt, inSeconds, or inMinutes with a valid future value",
      };
    }

    try {
      const reminder = createReminder({
        title,
        message,
        dueAt: dueAt.toISOString(),
        sessionId: ctx.sessionId,
        targetPath: String(args["targetPath"] ?? "").trim() || undefined,
        sticky: args["sticky"] === true,
      });

      return {
        success: true,
        output: `Reminder scheduled: **${reminder.title}** at ${reminder.dueAt}`,
        metadata: {
          reminderId: reminder.id,
          dueAt: reminder.dueAt,
          targetPath: reminder.targetPath,
        },
      };
    } catch (err) {
      return {
        success: false,
        output: "",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
});

registerTool({
  name: "reminder_list",
  description: "List reminders scheduled from the current session.",
  parameters: { type: "object", properties: {} },
  async execute(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const reminders = listReminders({ sessionId: ctx.sessionId });
    if (reminders.length === 0) {
      return { success: true, output: "No active reminders.", metadata: { count: 0 } };
    }

    const lines = reminders.map((reminder) =>
      `- **${reminder.id}** ${reminder.title} — due ${reminder.dueAt}${reminder.targetPath ? ` → ${reminder.targetPath}` : ""}`,
    );

    return {
      success: true,
      output: `## Active Reminders (${reminders.length})\n\n${lines.join("\n")}`,
      metadata: { count: reminders.length },
    };
  },
});

registerTool({
  name: "reminder_remove",
  description: "Remove a scheduled reminder created from the current session.",
  parameters: {
    type: "object",
    properties: {
      reminderId: {
        type: "string",
        description: "The ID of the reminder to remove.",
      },
    },
    required: ["reminderId"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const reminderId = String(args["reminderId"] ?? "").trim();
    if (!reminderId) {
      return { success: false, output: "", error: "reminderId is required" };
    }

    const removed = removeReminder(reminderId, { sessionId: ctx.sessionId });
    if (!removed) {
      return { success: false, output: "", error: `No reminder found with ID: ${reminderId}` };
    }

    return {
      success: true,
      output: `Reminder ${reminderId} removed.`,
      metadata: { reminderId },
    };
  },
});