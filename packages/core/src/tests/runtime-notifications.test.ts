import { afterEach, describe, expect, it } from "vitest";
import { createJob, completeJob, failJob, resetJobsForTests } from "../agent/jobs.js";
import {
  listRecentNotifications,
  publishNotification,
  resetNotificationsForTests,
  subscribeToNotifications,
  type RuntimeNotification,
} from "../runtime/notifications.js";

describe("runtime notifications", () => {
  afterEach(async () => {
    resetNotificationsForTests();
    await resetJobsForTests();
  });

  it("publishes notifications to subscribers and keeps recent history", () => {
    const received: RuntimeNotification[] = [];
    const unsubscribe = subscribeToNotifications((notification) => {
      received.push(notification);
    });

    const notification = publishNotification({
      title: "Reminder due",
      message: "Standup starts in five minutes.",
      level: "info",
      category: "reminder",
      targetPath: "/jobs",
    });

    unsubscribe();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      id: notification.id,
      title: "Reminder due",
      message: "Standup starts in five minutes.",
      level: "info",
      category: "reminder",
      targetPath: "/jobs",
    });
    expect(listRecentNotifications(1)[0]?.id).toBe(notification.id);
  });

  it("emits a success notification when a job completes", async () => {
    const received: RuntimeNotification[] = [];
    const unsubscribe = subscribeToNotifications((notification) => {
      received.push(notification);
    });

    const job = await createJob({
      sceneName: "daily_digest",
      task: "Summarize the day",
    });

    await completeJob(job.id, {
      response: "Done",
      toolCallsExecuted: 1,
      blocked: false,
    });

    unsubscribe();

    expect(received.at(-1)).toMatchObject({
      title: "Job completed",
      message: "daily_digest finished successfully.",
      level: "success",
      category: "job",
      jobId: job.id,
      sessionId: job.sessionId,
      targetPath: "/jobs",
    });
  });

  it("emits an error notification when a job fails", async () => {
    const received: RuntimeNotification[] = [];
    const unsubscribe = subscribeToNotifications((notification) => {
      received.push(notification);
    });

    const job = await createJob({
      sceneName: "broken_job",
      task: "Fail intentionally",
    });

    await failJob(job.id, "Upstream service unavailable");

    unsubscribe();

    expect(received.at(-1)).toMatchObject({
      title: "Job failed",
      message: "broken_job failed. Upstream service unavailable",
      level: "error",
      category: "job",
      jobId: job.id,
      sessionId: job.sessionId,
      targetPath: "/jobs",
      sticky: true,
    });
  });
});