import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { cancelTimer, listTimers, startTimer } from "../runtime/timers.js";

function parsePositiveNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function resolveTimerDurationMs(args: Record<string, unknown>): number | null {
  const inSeconds = parsePositiveNumber(args["inSeconds"]);
  const inMinutes = parsePositiveNumber(args["inMinutes"]);
  const inMilliseconds = parsePositiveNumber(args["inMilliseconds"]);
  const modes = [inMilliseconds ? "inMilliseconds" : "", inSeconds ? "inSeconds" : "", inMinutes ? "inMinutes" : ""].filter(Boolean);
  if (modes.length !== 1) {
    return null;
  }
  if (inMilliseconds) return Math.trunc(inMilliseconds);
  if (inSeconds) return Math.trunc(inSeconds * 1_000);
  return Math.trunc((inMinutes ?? 0) * 60_000);
}

registerTool({
  name: "timer_start",
  description:
    "Start a one-time timer that will publish a browser notification when it elapses. " +
    "Timers are in-memory only and tied to the running gateway process.",
  embeddingDescription: "Start a timer, countdown, stopwatch, set a duration alarm. Timer starten, Wecker stellen, Countdown beginnen, Minuten abzählen. Pomodoro, cooking timer, short alarm.",
  parameters: {
    type: "object",
    properties: {
      label: {
        type: "string",
        description: "Short timer label shown in the list and default elapsed message.",
      },
      message: {
        type: "string",
        description: "Optional custom elapsed message for the browser notification.",
      },
      inMilliseconds: {
        type: "number",
        description: "Relative timer duration in milliseconds. Use exactly one duration field.",
      },
      inSeconds: {
        type: "number",
        description: "Relative timer duration in seconds. Use exactly one duration field.",
      },
      inMinutes: {
        type: "number",
        description: "Relative timer duration in minutes. Use exactly one duration field.",
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
    required: ["label"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const label = String(args["label"] ?? "").trim();
    const durationMs = resolveTimerDurationMs(args);

    if (!label) {
      return { success: false, output: "", error: "label is required" };
    }
    if (!durationMs) {
      return {
        success: false,
        output: "",
        error: "Provide exactly one of inMilliseconds, inSeconds, or inMinutes with a valid positive value",
      };
    }

    try {
      const timer = startTimer({
        label,
        durationMs,
        message: String(args["message"] ?? "").trim() || undefined,
        sessionId: ctx.sessionId,
        targetPath: String(args["targetPath"] ?? "").trim() || undefined,
        sticky: args["sticky"] === true,
      });

      return {
        success: true,
        output: `Timer started: **${timer.label}** until ${timer.dueAt}`,
        metadata: {
          timerId: timer.id,
          durationMs: timer.durationMs,
          dueAt: timer.dueAt,
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
  name: "timer_list",
  description: "List timers started from the current session.",
  parameters: { type: "object", properties: {} },
  async execute(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const timers = listTimers({ sessionId: ctx.sessionId });
    if (timers.length === 0) {
      return { success: true, output: "No active timers.", metadata: { count: 0 } };
    }

    const lines = timers.map((timer) =>
      `- **${timer.id}** ${timer.label} — due ${timer.dueAt} (${timer.durationMs}ms)`,
    );

    return {
      success: true,
      output: `## Active Timers (${timers.length})\n\n${lines.join("\n")}`,
      metadata: { count: timers.length },
    };
  },
});

registerTool({
  name: "timer_cancel",
  description: "Cancel an active timer created from the current session.",
  parameters: {
    type: "object",
    properties: {
      timerId: {
        type: "string",
        description: "The ID of the timer to cancel.",
      },
    },
    required: ["timerId"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const timerId = String(args["timerId"] ?? "").trim();
    if (!timerId) {
      return { success: false, output: "", error: "timerId is required" };
    }

    const cancelled = cancelTimer(timerId, { sessionId: ctx.sessionId });
    if (!cancelled) {
      return { success: false, output: "", error: `No timer found with ID: ${timerId}` };
    }

    return {
      success: true,
      output: `Timer ${timerId} cancelled.`,
      metadata: { timerId },
    };
  },
});