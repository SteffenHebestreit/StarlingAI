import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createReminder,
  listReminders,
  removeReminder,
  resetRemindersForTests,
} from "../runtime/reminders.js";
import {
  resetNotificationsForTests,
  subscribeToNotifications,
  type RuntimeNotification,
} from "../runtime/notifications.js";

describe("runtime reminders", () => {
  afterEach(() => {
    resetRemindersForTests();
    resetNotificationsForTests();
    vi.useRealTimers();
  });

  it("publishes a reminder notification when the reminder becomes due", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T09:00:00.000Z"));

    const received: RuntimeNotification[] = [];
    const unsubscribe = subscribeToNotifications((notification) => {
      received.push(notification);
    });

    createReminder({
      title: "Standup",
      message: "Daily standup starts now.",
      dueAt: "2026-04-01T09:05:00.000Z",
      sessionId: "session-reminder",
      targetPath: "/",
    });

    await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);
    unsubscribe();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      title: "Standup",
      message: "Daily standup starts now.",
      category: "reminder",
      sessionId: "session-reminder",
      targetPath: "/",
    });
    expect(listReminders({ sessionId: "session-reminder" })).toHaveLength(0);
  });

  it("removes reminders before they fire", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T10:00:00.000Z"));

    const received: RuntimeNotification[] = [];
    const unsubscribe = subscribeToNotifications((notification) => {
      received.push(notification);
    });

    const reminder = createReminder({
      title: "Stretch",
      message: "Time to take a short break.",
      dueAt: "2026-04-01T10:01:00.000Z",
      sessionId: "session-reminder",
    });

    expect(removeReminder(reminder.id, { sessionId: "session-reminder" })).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    unsubscribe();

    expect(received).toHaveLength(0);
    expect(listReminders({ sessionId: "session-reminder" })).toHaveLength(0);
  });
});