import { afterEach, describe, expect, it, vi } from "vitest";
import { resetNotificationsForTests, subscribeToNotifications, type RuntimeNotification } from "../runtime/notifications.js";
import { cancelTimer, listTimers, resetTimersForTests, startTimer } from "../runtime/timers.js";

describe("runtime timers", () => {
  afterEach(() => {
    resetTimersForTests();
    resetNotificationsForTests();
    vi.useRealTimers();
  });

  it("publishes a timer notification when the timer elapses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T14:00:00.000Z"));

    const received: RuntimeNotification[] = [];
    const unsubscribe = subscribeToNotifications((notification) => {
      received.push(notification);
    });

    startTimer({
      label: "Tea break",
      durationMs: 30_000,
      message: "Tea break is over.",
      sessionId: "session-timer",
      targetPath: "/",
    });

    await vi.advanceTimersByTimeAsync(30_000);
    unsubscribe();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      title: "Timer elapsed",
      message: "Tea break is over.",
      category: "timer",
      sessionId: "session-timer",
      targetPath: "/",
    });
    expect(listTimers({ sessionId: "session-timer" })).toHaveLength(0);
  });

  it("cancels timers before they elapse", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T15:00:00.000Z"));

    const received: RuntimeNotification[] = [];
    const unsubscribe = subscribeToNotifications((notification) => {
      received.push(notification);
    });

    const timer = startTimer({
      label: "Stretch",
      durationMs: 45_000,
      sessionId: "session-timer",
    });

    expect(cancelTimer(timer.id, { sessionId: "session-timer" })).toBe(true);
    await vi.advanceTimersByTimeAsync(45_000);
    unsubscribe();

    expect(received).toHaveLength(0);
    expect(listTimers({ sessionId: "session-timer" })).toHaveLength(0);
  });
});