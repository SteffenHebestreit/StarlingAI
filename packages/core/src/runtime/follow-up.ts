/**
 * What happens when a scheduled task's run ends.
 *
 * A schedule (tools/schedule.ts, runtime/scheduled-task-runner.ts) ran its task as a turn of its
 * own, in a session of its own, and the result stayed on the job run: the person who had asked
 * "tell me when X is out" was never told. Here the run is counted against its schedule and, when
 * it has something to say, its answer is written into the conversation the schedule was made in,
 * as a message of the assistant, and pushed to that person's open pages.
 *
 *  - A schedule that runs once is posted and removed.
 *  - A watch (`until`) is asked, per run, whether its result says the awaited thing has happened
 *    (one small model call). A run that does not is counted and says nothing; the one that does is
 *    posted and ends the watch. A watch that reaches its last run posts that run and ends.
 *  - Any other repeating schedule posts every run.
 *  - A failed run of a one-shot, or the third failed run in a row of a repeating schedule, is
 *    posted as such and ends the schedule: a schedule that fails every day in silence is worse
 *    than none.
 *
 * The message is only ever appended between turns. A turn in progress has tool calls waiting for
 * their results, and a message written between the two orphans the results (agent/session.ts,
 * getCollapsedHistory pairs them by position), so the post waits until the conversation is idle.
 */
import { logAudit } from "../audit/logger.js";
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";
import { applyActiveModelPreset, createChatProvider, getChatProviderForTier, tierModelDefaults } from "../providers/index.js";
import { resolveSession, type SessionTranscriptMessage } from "../agent/session.js";
import { turnSteeringManager } from "../agent/turn-steering.js";
import { userInputBroker } from "../agent/user-input-broker.js";
import type { Identity } from "./accounts.js";
import type { FollowUpEnded, FollowUpMark } from "./follow-up-mark.js";
import { publishNotification } from "./notifications.js";
import { runWithCallAttribution } from "./request-context.js";
import { removeScheduledTask, scheduledRunSettled } from "./scheduled-task-runner.js";
import { getScheduledTask, updateScheduledTask, type ScheduledRunOutcome, type ScheduledTaskRecord } from "./scheduled-tasks.js";
import { multiUserAuthActive, ownsRecord } from "./user-scope.js";

export type { FollowUpEnded, FollowUpMark } from "./follow-up-mark.js";

const log = childLogger("follow-up");

/** Failed runs in a row after which a repeating schedule is stopped and says so. */
export const FAILED_RUNS_BEFORE_STOP = 3;
/** How often, and for how long, a post waits for the conversation's running turn to end. */
const IDLE_POLL_MS = 3_000;
const IDLE_MAX_WAIT_MS = 30 * 60_000;
/** How much of a run's result the condition check reads. */
const CONDITION_RESULT_CHARS = 8_000;

/** How a scheduled run ended, as the worker saw it. */
export type ScheduledRunEnd =
  | { kind: "completed"; response: string; blocked: boolean }
  | { kind: "failed"; error: string }
  | { kind: "cancelled" };

export interface Settlement {
  outcome: ScheduledRunOutcome;
  /** Write the run into the conversation. */
  post: boolean;
  /** The schedule ends with this run, and why. */
  ended?: FollowUpEnded;
  runs: number;
  failedRuns: number;
}

function runsOnce(rec: ScheduledTaskRecord): boolean {
  return rec.at !== undefined && !rec.cron;
}

/**
 * What a run means for its schedule. Pure: `conditionMet` is the condition check's answer for a
 * watch (false when it could not be asked: an unanswered check must not end a watch).
 */
export function decideSettlement(rec: ScheduledTaskRecord, failed: boolean, conditionMet: boolean): Settlement {
  const runs = (rec.runs ?? 0) + 1;
  if (failed) {
    const failedRuns = (rec.failedRuns ?? 0) + 1;
    const stops = runsOnce(rec) || failedRuns >= FAILED_RUNS_BEFORE_STOP;
    return { outcome: "failed", post: stops, ...(stops ? { ended: "failed" as const } : {}), runs, failedRuns };
  }
  if (runsOnce(rec)) return { outcome: "reported", post: true, ended: "once", runs, failedRuns: 0 };
  const lastRun = rec.maxRuns !== undefined && runs >= rec.maxRuns;
  if (rec.until) {
    if (conditionMet) return { outcome: "reported", post: true, ended: "condition_met", runs, failedRuns: 0 };
    if (lastRun) return { outcome: "reported", post: true, ended: "max_runs", runs, failedRuns: 0 };
    return { outcome: "nothing_new", post: false, runs, failedRuns: 0 };
  }
  return { outcome: "reported", post: true, ...(lastRun ? { ended: "max_runs" as const } : {}), runs, failedRuns: 0 };
}

const CONDITION_SYSTEM =
  "A scheduled check ran for a person who is waiting for something to happen. You are given what they are waiting for and "
  + "what the check found. Decide whether, according to what the check found, it HAS happened. Answer YES only when the result "
  + "states that it has happened. A result that reports no change, an announcement of something still to come, a rumour, an "
  + "expectation, a partial step, or that nothing could be found, is NO. Reply with exactly one word: YES or NO.";

/**
 * Does the run's result say that what the watch waits for has happened? One call on the routing
 * tier, or on the main model where no tier is configured (a model preset has none). Undefined when
 * it could not be asked.
 */
export async function askConditionMet(until: string, result: string): Promise<boolean | undefined> {
  try {
    const config = getConfig();
    const provider = getChatProviderForTier("routing", { reasoningEffort: "none" })
      ?? createChatProvider({ ...applyActiveModelPreset(config.agents.defaults.model), ...tierModelDefaults("routing") });
    const reply = await runWithCallAttribution({ callSite: "routing_tier", agentName: "follow_up_condition" }, () => provider.complete(
      [
        { role: "system", content: CONDITION_SYSTEM },
        { role: "user", content: `Waiting for:\n${until}\n\nWhat the check found:\n${result.slice(0, CONDITION_RESULT_CHARS)}` },
      ],
      [],
    ));
    const word = (reply.content ?? "").trim().toUpperCase();
    if (word.startsWith("YES")) return true;
    if (word.startsWith("NO")) return false;
    log.warn({ reply: word.slice(0, 40) }, "follow-up condition check answered neither yes nor no");
    return undefined;
  } catch (err) {
    log.warn({ err }, "follow-up condition check could not be asked");
    return undefined;
  }
}

/** Who a stored schedule belongs to, whole (as tools/schedule.ts wrote it). */
export function scheduleOwnerIdentity(rec: Pick<ScheduledTaskRecord, "userId" | "account" | "principal">): Identity | undefined {
  if (rec.userId === undefined) return undefined;
  if (rec.account) return { userId: rec.userId, account: rec.account };
  if (rec.principal) return { userId: rec.userId, principal: rec.principal };
  return { userId: rec.userId };
}

async function conversationIdle(sessionId: string, wait: (ms: number) => Promise<void>): Promise<boolean> {
  for (let waited = 0; turnSteeringManager.isTurnActive(sessionId); waited += IDLE_POLL_MS) {
    if (waited >= IDLE_MAX_WAIT_MS) return false;
    await wait(IDLE_POLL_MS);
  }
  return true;
}

export type PostResult = "posted" | "no_conversation";

/**
 * Write a schedule's message into the conversation it was made in and push it to its owner's open
 * pages. "no_conversation" when there is none to write to: the schedule names none, it is gone or
 * was archived by hand, it is another owner's by now, or it stayed busy for half an hour.
 */
export async function postToConversation(
  rec: ScheduledTaskRecord,
  content: string,
  mark: FollowUpMark,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); }),
): Promise<PostResult> {
  if (!rec.sessionId) return "no_conversation";
  const session = await resolveSession(rec.sessionId, { resumeArchived: true });
  if (!session) return "no_conversation";
  // The schedule's owner and the conversation's are one identity when the schedule was made; an
  // account deleted and made again under the name is not that owner.
  if (multiUserAuthActive() && !ownsRecord(scheduleOwnerIdentity(rec), session.identity())) {
    log.warn({ scheduleId: rec.id, sessionId: rec.sessionId }, "follow-up not posted: the conversation is not the schedule owner's");
    return "no_conversation";
  }
  if (!(await conversationIdle(session.id, wait))) {
    log.warn({ scheduleId: rec.id, sessionId: session.id }, "follow-up not posted: the conversation stayed busy");
    return "no_conversation";
  }
  // Its own request id: two posts in a row with none would be merged into one transcript entry
  // (agent/session.ts toTranscript joins neighbouring assistant entries of one turn).
  session.addMessage({ role: "assistant", content, metadata: { followUp: mark }, requestId: followUpRequestId(mark.jobId) });
  const entry = session.toTranscript().at(-1);
  userInputBroker.emitToOwner(session.id, {
    type: "session.follow_up",
    data: { sessionId: session.id, message: entry ?? fallbackEntry(session.id, content, mark) },
  });
  return "posted";
}

export function followUpRequestId(jobId: string): string {
  return `follow-up:${jobId}`;
}

function fallbackEntry(sessionId: string, content: string, mark: FollowUpMark): SessionTranscriptMessage {
  return { id: `${sessionId}:${followUpRequestId(mark.jobId)}`, role: "assistant", content, timestamp: new Date().toISOString(), followUp: mark };
}

function failureText(rec: ScheduledTaskRecord, error: string, settlement: Settlement): string {
  const stopped = !runsOnce(rec) && settlement.ended === "failed"
    ? ` It failed ${settlement.failedRuns} times in a row and has been stopped.`
    : "";
  return `The scheduled follow-up "${rec.label}" could not run: ${error}${stopped}`;
}

function firstLine(text: string, max = 160): string {
  const line = text.replace(/[#*_`>|]/g, "").split("\n").map((part) => part.trim()).find(Boolean) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export interface SettleDeps {
  conditionMet: (until: string, result: string) => Promise<boolean | undefined>;
  post: (rec: ScheduledTaskRecord, content: string, mark: FollowUpMark) => Promise<PostResult>;
  now: () => Date;
}

const defaultDeps: SettleDeps = {
  conditionMet: askConditionMet,
  post: postToConversation,
  now: () => new Date(),
};

/**
 * A scheduled task's run ended: count it, end the schedule when this was its last run, and post
 * what it found. Never throws: the job is finished either way.
 */
export async function settleScheduledRun(
  job: { id: string; scheduleId?: string },
  end: ScheduledRunEnd,
  deps: Partial<SettleDeps> = {},
): Promise<Settlement | undefined> {
  const scheduleId = job.scheduleId;
  if (!scheduleId) return undefined;
  const { conditionMet, post, now } = { ...defaultDeps, ...deps };
  try {
    scheduledRunSettled(scheduleId);
    const rec = getScheduledTask(scheduleId);
    // Removed while its run was out: nothing to count, and nobody waiting for the result.
    if (!rec) return undefined;
    if (end.kind === "cancelled") {
      // A person stopped the run. A one-shot does not get another; a repeating one runs again.
      if (runsOnce(rec)) removeScheduledTask(rec.id);
      return undefined;
    }

    const answer = end.kind === "completed" ? end.response.trim() : "";
    const error = end.kind === "failed"
      ? end.error
      : end.blocked ? "its answer was blocked by the guardrails" : answer ? "" : "it returned no answer";
    const failed = error !== "";
    const met = !failed && rec.until ? (await conditionMet(rec.until, answer)) === true : false;
    const settlement = decideSettlement(rec, failed, met);

    if (settlement.ended) {
      removeScheduledTask(rec.id);
    } else {
      updateScheduledTask(rec.id, {
        runs: settlement.runs,
        failedRuns: settlement.failedRuns,
        lastRunAt: now().toISOString(),
        lastOutcome: settlement.outcome,
      });
    }

    let posted: PostResult | "not_posted" = "not_posted";
    if (settlement.post) {
      const mark: FollowUpMark = {
        scheduleId: rec.id,
        label: rec.label,
        jobId: job.id,
        run: settlement.runs,
        ...(settlement.ended ? { ended: settlement.ended } : {}),
        ...(failed ? { failed: true as const } : {}),
      };
      const content = failed ? failureText(rec, error, settlement) : answer;
      posted = await post(rec, content, mark);
      const owner = scheduleOwnerIdentity(rec);
      publishNotification({
        title: failed ? `Follow-up failed: ${rec.label}` : `Follow-up: ${rec.label}`,
        message: posted === "posted"
          ? firstLine(content)
          : "Its conversation is gone or was busy: the result is on the Jobs page.",
        level: failed ? "error" : "info",
        category: "follow_up",
        ...(posted === "posted" && rec.sessionId ? { sessionId: rec.sessionId, targetPath: "/" } : { targetPath: "/jobs" }),
        jobId: job.id,
        sticky: true,
        ...(owner ? { owner } : {}),
      });
    }

    logAudit("scheduled_run_settled", {
      scheduleId: rec.id,
      jobId: job.id,
      outcome: settlement.outcome,
      run: settlement.runs,
      posted,
      ...(settlement.ended ? { ended: settlement.ended } : {}),
      ...(rec.until ? { watch: true, conditionMet: met } : {}),
    }, { ...(rec.sessionId ? { sessionId: rec.sessionId } : {}), severity: failed ? "warn" : "info" });
    return settlement;
  } catch (err) {
    log.error({ err, scheduleId, jobId: job.id }, "settling a scheduled run failed");
    return undefined;
  }
}
