import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { executeTool } from "../tools/registry.js";
import { resetRemindersForTests } from "../runtime/reminders.js";
import { resetNotificationsForTests } from "../runtime/notifications.js";

describe("reminder tools", () => {
  beforeAll(async () => {
    await import("../tools/reminders.js");
  });

  afterEach(() => {
    resetRemindersForTests();
    resetNotificationsForTests();
    vi.useRealTimers();
  });

  it("creates and lists reminders for the current session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T12:00:00.000Z"));

    const createResult = await executeTool("reminder_create", {
      title: "Reply to Alex",
      message: "Send the follow-up note.",
      inMinutes: 15,
      targetPath: "/",
    }, {
      sessionId: "session-reminder-tools",
      workspacePath: "/workspace",
    });

    expect(createResult.success).toBe(true);
    expect(createResult.metadata?.["reminderId"]).toBeTruthy();

    const listResult = await executeTool("reminder_list", {}, {
      sessionId: "session-reminder-tools",
      workspacePath: "/workspace",
    });

    expect(listResult.success).toBe(true);
    expect(listResult.output).toContain("Reply to Alex");
  });

  it("removes reminders from the current session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T13:00:00.000Z"));

    const createResult = await executeTool("reminder_create", {
      title: "Pay invoice",
      message: "Send the payment before close of business.",
      inSeconds: 90,
    }, {
      sessionId: "session-reminder-tools",
      workspacePath: "/workspace",
    });

    const reminderId = String(createResult.metadata?.["reminderId"] ?? "");
    const removeResult = await executeTool("reminder_remove", { reminderId }, {
      sessionId: "session-reminder-tools",
      workspacePath: "/workspace",
    });

    expect(removeResult.success).toBe(true);

    const listResult = await executeTool("reminder_list", {}, {
      sessionId: "session-reminder-tools",
      workspacePath: "/workspace",
    });

    expect(listResult.success).toBe(true);
    expect(listResult.output).toContain("No active reminders");
  });
});