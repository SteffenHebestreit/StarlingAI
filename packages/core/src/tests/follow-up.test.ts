import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configLoader from "../config/loader.js";
import { createSession, getSessionTranscript, resetSessionsForTests } from "../agent/session.js";
import { turnSteeringManager } from "../agent/turn-steering.js";
import { userInputBroker } from "../agent/user-input-broker.js";
import {
  FAILED_RUNS_BEFORE_STOP,
  decideSettlement,
  postToConversation,
  settleScheduledRun,
  type FollowUpMark,
  type PostResult,
} from "../runtime/follow-up.js";
import { followUpMarkOf } from "../runtime/follow-up-mark.js";
import { listRecentNotifications, notificationForCaller, resetNotificationsForTests } from "../runtime/notifications.js";
import { _resetScheduledTaskRuntimeForTests } from "../runtime/scheduled-task-runner.js";
import {
  _setScheduledTasksPathForTests,
  getScheduledTask,
  saveScheduledTask,
  type ScheduledTaskRecord,
} from "../runtime/scheduled-tasks.js";

const baseConfig = configLoader.getConfig();
let multiUser = false;
let dir = "";

beforeEach(() => {
  multiUser = false;
  vi.spyOn(configLoader, "getConfig").mockImplementation(() => ({ ...baseConfig, auth: { ...baseConfig.auth, enabled: multiUser } }) as ReturnType<typeof configLoader.getConfig>);
  dir = mkdtempSync(join(tmpdir(), "follow-up-"));
  _setScheduledTasksPathForTests(join(dir, "scheduled-tasks.json"));
});

afterEach(() => {
  vi.restoreAllMocks();
  _resetScheduledTaskRuntimeForTests();
  _setScheduledTasksPathForTests(null);
  resetSessionsForTests();
  resetNotificationsForTests();
  if (dir) { rmSync(dir, { recursive: true, force: true }); dir = ""; }
});

const watch = (extra: Partial<ScheduledTaskRecord> = {}): ScheduledTaskRecord => ({
  id: "w1", cron: "0 7 * * *", label: "Release watch", task: "check the release", until: "the release is out", maxRuns: 30,
  sessionId: "chat-1", createdAt: "2026-11-12T00:00:00Z", ...extra,
});
const once = (extra: Partial<ScheduledTaskRecord> = {}): ScheduledTaskRecord => ({
  id: "o1", at: "2026-11-13T08:00:00.000Z", label: "Reminder", task: "remind about the call", sessionId: "chat-1",
  createdAt: "2026-11-12T00:00:00Z", ...extra,
});
const briefing = (extra: Partial<ScheduledTaskRecord> = {}): ScheduledTaskRecord => ({
  id: "b1", cron: "0 7 * * 1-5", label: "Morning brief", task: "brief me", sessionId: "chat-1", createdAt: "2026-11-12T00:00:00Z", ...extra,
});

describe("what a run means for its schedule", () => {
  it("a watch says nothing until what it waits for has happened, then posts and ends", () => {
    expect(decideSettlement(watch(), false, false)).toEqual({ outcome: "nothing_new", post: false, runs: 1, failedRuns: 0 });
    expect(decideSettlement(watch({ runs: 4 }), false, true)).toEqual({ outcome: "reported", post: true, ended: "condition_met", runs: 5, failedRuns: 0 });
  });

  it("a watch that reaches its last run posts that run and ends, whatever it found", () => {
    expect(decideSettlement(watch({ runs: 29 }), false, false)).toEqual({ outcome: "reported", post: true, ended: "max_runs", runs: 30, failedRuns: 0 });
    expect(decideSettlement(watch({ runs: 28 }), false, false).post).toBe(false);
  });

  it("a schedule that runs once is posted and ends", () => {
    expect(decideSettlement(once(), false, false)).toEqual({ outcome: "reported", post: true, ended: "once", runs: 1, failedRuns: 0 });
  });

  it("a repeating schedule with no condition posts every run and goes on", () => {
    expect(decideSettlement(briefing({ runs: 9 }), false, false)).toEqual({ outcome: "reported", post: true, runs: 10, failedRuns: 0 });
    expect(decideSettlement(briefing({ runs: 4, maxRuns: 5 }), false, false).ended).toBe("max_runs");
  });

  it("a failed one-shot says so and ends; a repeating schedule is stopped at the third failure in a row", () => {
    expect(decideSettlement(once(), true, false)).toEqual({ outcome: "failed", post: true, ended: "failed", runs: 1, failedRuns: 1 });
    expect(decideSettlement(watch(), true, false)).toEqual({ outcome: "failed", post: false, runs: 1, failedRuns: 1 });
    expect(decideSettlement(watch({ runs: 2, failedRuns: FAILED_RUNS_BEFORE_STOP - 1 }), true, false)).toEqual({
      outcome: "failed", post: true, ended: "failed", runs: 3, failedRuns: FAILED_RUNS_BEFORE_STOP,
    });
  });

  it("a run that worked clears the count of failures", () => {
    expect(decideSettlement(watch({ failedRuns: 2 }), false, false).failedRuns).toBe(0);
  });
});

describe("settling a scheduled run", () => {
  const posts: Array<{ content: string; mark: FollowUpMark }> = [];
  const post = vi.fn(async (_rec: ScheduledTaskRecord, content: string, mark: FollowUpMark): Promise<PostResult> => {
    posts.push({ content, mark });
    return "posted";
  });
  const now = () => new Date("2026-11-13T07:00:30Z");
  beforeEach(() => { posts.length = 0; post.mockClear(); });

  it("a run that is no schedule's is nothing here", async () => {
    expect(await settleScheduledRun({ id: "job-1" }, { kind: "completed", response: "x", blocked: false }, { post })).toBeUndefined();
    expect(post).not.toHaveBeenCalled();
  });

  it("counts a watch's run that found nothing new, and posts nothing", async () => {
    saveScheduledTask(watch());
    const conditionMet = vi.fn(async () => false);
    await settleScheduledRun({ id: "job-1", scheduleId: "w1" }, { kind: "completed", response: "Still in preview.", blocked: false }, { post, conditionMet, now });
    expect(conditionMet).toHaveBeenCalledWith("the release is out", "Still in preview.");
    expect(post).not.toHaveBeenCalled();
    expect(getScheduledTask("w1")).toMatchObject({ runs: 1, lastOutcome: "nothing_new", lastRunAt: "2026-11-13T07:00:30.000Z", failedRuns: 0 });
    expect(listRecentNotifications()).toHaveLength(0);
  });

  it("posts the run that meets the condition, removes the watch and tells its owner", async () => {
    saveScheduledTask(watch({ runs: 3, userId: "alice", account: "alice-0123456789abcdef" }));
    await settleScheduledRun({ id: "job-4", scheduleId: "w1" }, { kind: "completed", response: "## It is out\nWeights are on the hub.", blocked: false }, {
      post, conditionMet: async () => true, now,
    });
    expect(posts).toEqual([{
      content: "## It is out\nWeights are on the hub.",
      mark: { scheduleId: "w1", label: "Release watch", jobId: "job-4", run: 4, ended: "condition_met" },
    }]);
    expect(getScheduledTask("w1")).toBeUndefined();
    expect(listRecentNotifications()[0]).toMatchObject({
      title: "Follow-up: Release watch", message: "It is out", category: "follow_up", sessionId: "chat-1", targetPath: "/",
      owner: { userId: "alice", account: "alice-0123456789abcdef" },
    });
  });

  it("an unanswered condition check does not end a watch", async () => {
    saveScheduledTask(watch());
    await settleScheduledRun({ id: "job-1", scheduleId: "w1" }, { kind: "completed", response: "It is out.", blocked: false }, { post, conditionMet: async () => undefined, now });
    expect(post).not.toHaveBeenCalled();
    expect(getScheduledTask("w1")?.runs).toBe(1);
  });

  it("posts a one-shot's result without asking anything, and removes it", async () => {
    saveScheduledTask(once({ firedAt: "2026-11-13T08:00:00.000Z" }));
    const conditionMet = vi.fn(async () => true);
    await settleScheduledRun({ id: "job-9", scheduleId: "o1" }, { kind: "completed", response: "Reminder: the call is at ten.", blocked: false }, { post, conditionMet, now });
    expect(conditionMet).not.toHaveBeenCalled();
    expect(posts[0]?.mark).toEqual({ scheduleId: "o1", label: "Reminder", jobId: "job-9", run: 1, ended: "once" });
    expect(getScheduledTask("o1")).toBeUndefined();
  });

  it("says why a one-shot could not run, and that is its end", async () => {
    saveScheduledTask(once());
    await settleScheduledRun({ id: "job-9", scheduleId: "o1" }, { kind: "failed", error: "Scene timed out after 15 minutes" }, { post, now });
    expect(posts[0]).toEqual({
      content: 'The scheduled follow-up "Reminder" could not run: Scene timed out after 15 minutes',
      mark: { scheduleId: "o1", label: "Reminder", jobId: "job-9", run: 1, ended: "failed", failed: true },
    });
    expect(getScheduledTask("o1")).toBeUndefined();
    expect(listRecentNotifications()[0]).toMatchObject({ title: "Follow-up failed: Reminder", level: "error" });
  });

  it("keeps a repeating schedule through two failures in silence, and stops it at the third with a message", async () => {
    saveScheduledTask(watch());
    const fail = { kind: "failed", error: "model endpoint unreachable" } as const;
    await settleScheduledRun({ id: "job-1", scheduleId: "w1" }, fail, { post, now });
    await settleScheduledRun({ id: "job-2", scheduleId: "w1" }, fail, { post, now });
    expect(post).not.toHaveBeenCalled();
    expect(getScheduledTask("w1")).toMatchObject({ runs: 2, failedRuns: 2, lastOutcome: "failed" });
    await settleScheduledRun({ id: "job-3", scheduleId: "w1" }, fail, { post, now });
    expect(posts[0]?.content).toBe('The scheduled follow-up "Release watch" could not run: model endpoint unreachable It failed 3 times in a row and has been stopped.');
    expect(posts[0]?.mark).toMatchObject({ ended: "failed", failed: true, run: 3 });
    expect(getScheduledTask("w1")).toBeUndefined();
  });

  it("treats a blocked answer and an empty one as failed runs", async () => {
    saveScheduledTask(once());
    await settleScheduledRun({ id: "job-9", scheduleId: "o1" }, { kind: "completed", response: "[BLOCKED]", blocked: true }, { post, now });
    expect(posts[0]?.content).toContain("its answer was blocked by the guardrails");
    saveScheduledTask(once({ id: "o2" }));
    await settleScheduledRun({ id: "job-10", scheduleId: "o2" }, { kind: "completed", response: "  ", blocked: false }, { post, now });
    expect(posts[1]?.content).toContain("it returned no answer");
  });

  it("a cancelled run is not counted; a one-shot does not get another", async () => {
    saveScheduledTask(watch({ runs: 2 }));
    saveScheduledTask(once());
    await settleScheduledRun({ id: "job-1", scheduleId: "w1" }, { kind: "cancelled" }, { post, now });
    await settleScheduledRun({ id: "job-2", scheduleId: "o1" }, { kind: "cancelled" }, { post, now });
    expect(post).not.toHaveBeenCalled();
    expect(getScheduledTask("w1")?.runs).toBe(2);
    expect(getScheduledTask("o1")).toBeUndefined();
  });

  it("a run whose schedule was removed while it was out posts nothing and brings nothing back", async () => {
    await settleScheduledRun({ id: "job-1", scheduleId: "gone" }, { kind: "completed", response: "news", blocked: false }, { post, now });
    expect(post).not.toHaveBeenCalled();
    expect(getScheduledTask("gone")).toBeUndefined();
  });

  it("points at the Jobs page when the conversation is gone", async () => {
    saveScheduledTask(once());
    await settleScheduledRun({ id: "job-9", scheduleId: "o1" }, { kind: "completed", response: "Reminder", blocked: false }, { post: async () => "no_conversation", now });
    expect(listRecentNotifications()[0]).toMatchObject({ targetPath: "/jobs", jobId: "job-9" });
    expect(listRecentNotifications()[0]?.sessionId).toBeUndefined();
  });
});

describe("posting into the conversation", () => {
  const mark = (jobId: string, extra: Partial<FollowUpMark> = {}): FollowUpMark => ({ scheduleId: "w1", label: "Release watch", jobId, run: 1, ...extra });
  const noWait = async () => undefined;

  function conversation() {
    const session = createSession({ sessionId: "chat-1", channel: "webchat", workspacePath: "/workspace" });
    session.addMessage({ role: "user", content: "Tell me when it is out.", requestId: "r1" });
    session.addMessage({ role: "assistant", content: "I check every morning.", requestId: "r1" });
    return session;
  }

  it("appends the result as the assistant's message, marked, and pushes it to the open page", async () => {
    const session = conversation();
    const events: Array<{ type: string; data: unknown }> = [];
    userInputBroker.attachSink("chat-1", "conn-1", (event) => events.push(event), { isAdmin: false });

    expect(await postToConversation(watch(), "It is out.", mark("job-4", { ended: "condition_met" }), noWait)).toBe("posted");

    const last = session.getHistory().at(-1)!;
    expect(last).toMatchObject({ role: "assistant", content: "It is out.", requestId: "follow-up:job-4" });
    expect(followUpMarkOf(last.metadata)).toEqual(mark("job-4", { ended: "condition_met" }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "session.follow_up",
      data: { sessionId: "chat-1", message: { role: "assistant", content: "It is out.", followUp: { label: "Release watch", ended: "condition_met" } } },
    });
    userInputBroker.detachSink("conn-1");
  });

  it("keeps two posts in a row, and the answer before them, as separate transcript entries", async () => {
    conversation();
    await postToConversation(briefing(), "Monday's brief.", mark("job-1"), noWait);
    await postToConversation(briefing(), "Tuesday's brief.", mark("job-2", { run: 2 }), noWait);
    const transcript = getSessionTranscript("chat-1")!.transcript;
    expect(transcript.map((entry) => entry.content)).toEqual(["Tell me when it is out.", "I check every morning.", "Monday's brief.", "Tuesday's brief."]);
    expect(transcript.map((entry) => entry.followUp?.jobId)).toEqual([undefined, undefined, "job-1", "job-2"]);
  });

  it("waits for a running turn to end before it writes", async () => {
    const session = conversation();
    turnSteeringManager.armTurn("chat-1", "token-1", "r2");
    let waits = 0;
    const wait = async () => {
      waits += 1;
      // Nothing was written while the turn ran.
      expect(session.getHistory()).toHaveLength(2);
      if (waits === 2) turnSteeringManager.closeTurn("chat-1", "token-1");
    };
    expect(await postToConversation(watch(), "It is out.", mark("job-4"), wait)).toBe("posted");
    expect(waits).toBe(2);
    expect(session.getHistory()).toHaveLength(3);
  });

  it("gives up on a conversation that stays busy, and writes nothing", async () => {
    const session = conversation();
    turnSteeringManager.armTurn("chat-1", "token-1", "r2");
    expect(await postToConversation(watch(), "It is out.", mark("job-4"), noWait)).toBe("no_conversation");
    expect(session.getHistory()).toHaveLength(2);
    turnSteeringManager.closeTurn("chat-1", "token-1");
  });

  it("has nowhere to post when the schedule names no conversation, or it is gone", async () => {
    expect(await postToConversation(watch({ sessionId: undefined }), "x", mark("job-1"), noWait)).toBe("no_conversation");
    expect(await postToConversation(watch({ sessionId: "never-existed" }), "x", mark("job-1"), noWait)).toBe("no_conversation");
  });

  it("under multi-user auth, posts only into a conversation of the schedule's own account", async () => {
    multiUser = true;
    const session = createSession({ sessionId: "chat-2", channel: "webchat", workspacePath: "/workspace", userId: "alice", account: "alice-0123456789abcdef" });
    const hers = watch({ sessionId: "chat-2", userId: "alice", account: "alice-0123456789abcdef" });
    // The same name, another account: an account deleted and made again.
    const lookalike = watch({ sessionId: "chat-2", userId: "alice", account: "alice-fedcba9876543210" });
    expect(await postToConversation(lookalike, "x", mark("job-1"), noWait)).toBe("no_conversation");
    expect(session.getHistory()).toHaveLength(0);
    expect(await postToConversation(hers, "It is out.", mark("job-2"), noWait)).toBe("posted");
    expect(session.getHistory()).toHaveLength(1);
  });
});

describe("a notification with an owner", () => {
  const owned = { id: "n1", title: "Follow-up: x", message: "m", level: "info" as const, createdAt: "t", owner: { userId: "alice", account: "alice-0123456789abcdef" } };

  it("goes to its owner alone under multi-user auth, without saying whose it is", () => {
    multiUser = true;
    expect(notificationForCaller(owned, { userId: "alice", account: "alice-0123456789abcdef" })).toEqual({ id: "n1", title: "Follow-up: x", message: "m", level: "info", createdAt: "t" });
    expect(notificationForCaller(owned, { userId: "bob", account: "bob-0123456789abcdef" })).toBeUndefined();
    expect(notificationForCaller(owned, undefined)).toBeUndefined();
  });

  it("goes to the one operator when there is nobody else", () => {
    expect(notificationForCaller(owned, undefined)).not.toHaveProperty("owner");
    expect(notificationForCaller(owned, undefined)?.id).toBe("n1");
  });

  it("without an owner goes to everybody, as before", () => {
    multiUser = true;
    const { owner: _owner, ...open } = owned;
    expect(notificationForCaller(open, { userId: "bob", account: "bob-0123456789abcdef" })).toEqual(open);
  });
});
