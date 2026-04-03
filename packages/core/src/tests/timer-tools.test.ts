import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resetNotificationsForTests } from "../runtime/notifications.js";
import { resetTimersForTests } from "../runtime/timers.js";
import { executeTool } from "../tools/registry.js";

describe("timer tools", () => {
  beforeAll(async () => {
    await import("../tools/timers.js");
  });

  afterEach(() => {
    resetTimersForTests();
    resetNotificationsForTests();
    vi.useRealTimers();
  });

  it("starts and lists timers for the current session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T16:00:00.000Z"));

    const startResult = await executeTool("timer_start", {
      label: "Check oven",
      inMinutes: 12,
      message: "Check whether the dish is ready.",
    }, {
      sessionId: "session-timer-tools",
      workspacePath: "/workspace",
    });

    expect(startResult.success).toBe(true);
    expect(startResult.metadata?.["timerId"]).toBeTruthy();

    const listResult = await executeTool("timer_list", {}, {
      sessionId: "session-timer-tools",
      workspacePath: "/workspace",
    });

    expect(listResult.success).toBe(true);
    expect(listResult.output).toContain("Check oven");
  });

  it("cancels timers from the current session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T17:00:00.000Z"));

    const startResult = await executeTool("timer_start", {
      label: "Short break",
      inSeconds: 75,
    }, {
      sessionId: "session-timer-tools",
      workspacePath: "/workspace",
    });

    const timerId = String(startResult.metadata?.["timerId"] ?? "");
    const cancelResult = await executeTool("timer_cancel", { timerId }, {
      sessionId: "session-timer-tools",
      workspacePath: "/workspace",
    });

    expect(cancelResult.success).toBe(true);

    const listResult = await executeTool("timer_list", {}, {
      sessionId: "session-timer-tools",
      workspacePath: "/workspace",
    });

    expect(listResult.success).toBe(true);
    expect(listResult.output).toContain("No active timers");
  });
});