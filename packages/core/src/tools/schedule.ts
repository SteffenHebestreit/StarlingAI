/**
 * Tier 3 (privileged, per-call approval) — schedule a TASK that runs later as a real autonomous
 * turn: once at a time (`at`), or on a schedule (`cron`), a "standing agent". Unlike cron_create
 * (which only logs a shared finding), schedule_task runs the task through the full turn pipeline
 * via createJob, and the schedule is PERSISTED so it survives restarts.
 *
 * A schedule knows the conversation it was made in, and what its runs find is posted there
 * (runtime/follow-up.ts): this is the one way the assistant acts when nobody has written. With
 * `until` it is a watch, which stays silent until a run finds that the awaited thing has happened.
 */
import { randomBytes } from "node:crypto";
import { registerTool, toolCallIdentity, type ToolContext, type ToolResult } from "./registry.js";
import type { ScheduledTaskRecord } from "../runtime/scheduled-tasks.js";
import type { Identity } from "../runtime/accounts.js";
import { addAndActivateScheduledTask, removeScheduledTask } from "../runtime/scheduled-task-runner.js";
import { DEFAULT_WATCH_RUNS, listScheduledTaskRecords } from "../runtime/scheduled-tasks.js";
import { multiUserAuthActive, ownsRecord } from "../runtime/user-scope.js";
import { currentRequestContext } from "../runtime/request-context.js";
import { formatInZone, parseUserTime } from "../runtime/user-time.js";
import { childLogger } from "../logger.js";

const log = childLogger("tool:schedule");

/** How far a one-shot may lie in the past when the call is checked, and when it is stored after
 *  the person took their time to approve it: such a run is simply due now. */
const AT_PAST_TOLERANCE_MS = 60_000;
const AT_PAST_TOLERANCE_AFTER_APPROVAL_MS = 30 * 60_000;
const MAX_RUNS_LIMIT = 365;
const MAX_IN_MINUTES = 366 * 24 * 60;

export interface ScheduleRequest {
  cron?: string;
  /** The instant of a single run (ISO 8601, UTC). */
  at?: string;
  /** The zone the times were given in, when one is known. */
  timeZone?: string;
  /** A time without an offset was taken as UTC, since no zone is known for the conversation. */
  assumedUtc?: true;
  label: string;
  task: string;
  until?: string;
  maxRuns?: number;
}

/** What a schedule is: one run, a run that repeats and posts every time, or a watch. */
export const SCHEDULE_KINDS = ["once", "repeat", "watch"] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

/**
 * Read a schedule_task call. `kind` says what it is and with it which of the other arguments it
 * needs: once takes `at` or `inMinutes`, repeat takes `cron`, watch takes `cron` and `until`.
 * Times are the user's wall clock in `timeZone` (runtime/user-time.ts); a watch gets a last run.
 * Returns the reason the call cannot work instead, worded for the model that made it.
 *
 * The kind is asked for, never inferred. With `until` as one optional argument among others the
 * model left it out of 7 of 10 watches (2026-11-12, live) and wrote "report only when something is
 * new" into the task, where nothing reads it: every run would have been posted. Having to name the
 * kind is what makes it say what ends a watch.
 */
export async function readScheduleRequest(
  args: Record<string, unknown>,
  now: Date,
  timeZone: string | undefined,
  pastToleranceMs = AT_PAST_TOLERANCE_MS,
): Promise<ScheduleRequest | { error: string }> {
  const text = (key: string): string => (typeof args[key] === "string" ? (args[key] as string).trim() : "");
  const given = (key: string): boolean => args[key] !== undefined && args[key] !== null && args[key] !== "";
  const cron = text("cron");
  const atRaw = text("at");
  const label = text("label");
  const task = text("task");
  const until = text("until");
  if (!label) return { error: "label is required" };
  if (!task) return { error: "task is required" };
  const kind = SCHEDULE_KINDS.find((value) => value === text("kind"));
  if (!kind) {
    return { error: "kind is required: \"once\" (one run, with `at` or `inMinutes`), \"repeat\" (`cron`; every run is posted) or \"watch\" (`cron` and `until`; silent until what the user waits for has happened)." };
  }
  if (kind === "once") {
    if (cron) return { error: "kind \"once\" runs one time: give `at` or `inMinutes`, not `cron`. A schedule with `cron` is \"repeat\" or \"watch\"." };
    if (atRaw && given("inMinutes")) return { error: "Give `at` or `inMinutes`, not both." };
    if (!atRaw && !given("inMinutes")) return { error: "kind \"once\" needs `at` (the time on the user's clock) or `inMinutes`." };
    if (until) return { error: "`until` belongs to kind \"watch\": a single run is posted whatever it finds." };
    if (given("maxRuns")) return { error: "maxRuns belongs to a repeating schedule: kind \"once\" runs one time." };
  } else {
    if (atRaw || given("inMinutes")) return { error: `kind "${kind}" repeats: give \`cron\`, not \`at\` or \`inMinutes\`. One run is kind "once".` };
    if (!cron) return { error: `kind "${kind}" needs \`cron\`: when it repeats, on the user's clock.` };
    if (kind === "watch" && !until) return { error: "kind \"watch\" needs `until`: what the user is waiting for, as a statement a result can be checked against ('the full release is out')." };
    if (kind === "repeat" && until) return { error: "A schedule with `until` is kind \"watch\". Kind \"repeat\" posts every run and has no `until`." };
  }

  let at: Date | undefined;
  let assumedUtc = false;
  if (atRaw) {
    const parsed = parseUserTime(atRaw, timeZone);
    if (!parsed) return { error: `at is not a time: "${atRaw}". Write it as YYYY-MM-DDTHH:mm, e.g. 2026-11-13T09:00.` };
    if (parsed.at.getTime() < now.getTime() - pastToleranceMs) {
      const zone = timeZone ?? "UTC";
      return { error: `at is in the past: ${formatInZone(parsed.at, zone)} (${zone}). It is ${formatInZone(now, zone)} there now.` };
    }
    at = parsed.at;
    assumedUtc = parsed.assumedUtc;
  } else if (given("inMinutes")) {
    const minutes = Number(args["inMinutes"]);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > MAX_IN_MINUTES) return { error: `inMinutes must be a number from 1 to ${MAX_IN_MINUTES}.` };
    at = new Date(now.getTime() + Math.round(minutes) * 60_000);
  } else {
    try {
      const { CronTime } = await import("cron");

      new CronTime(cron, timeZone ?? "UTC");
    } catch {
      return { error: `Invalid cron expression: ${cron}` };
    }
  }
  let maxRuns: number | undefined;
  if (given("maxRuns")) {
    const value = Number(args["maxRuns"]);
    if (!Number.isInteger(value) || value < 1 || value > MAX_RUNS_LIMIT) return { error: `maxRuns must be a whole number from 1 to ${MAX_RUNS_LIMIT}.` };
    maxRuns = value;
  }
  // A watch always has a last run: a condition that never comes true must not run for ever.
  if (until && maxRuns === undefined) maxRuns = DEFAULT_WATCH_RUNS;

  return {
    ...(at ? { at: at.toISOString() } : { cron }),
    ...(timeZone ? { timeZone } : {}),
    ...(assumedUtc ? { assumedUtc: true as const } : {}),
    label,
    task,
    ...(until ? { until } : {}),
    ...(maxRuns !== undefined ? { maxRuns } : {}),
  };
}

/** When a cron expression fires next, as its zone's clock shows it, for the tool's answer. */
async function nextCronRun(cron: string, timeZone: string): Promise<string | undefined> {
  try {
    const { CronTime } = await import("cron");
    const next = new CronTime(cron, timeZone).sendAt().toJSDate();
    return formatInZone(next, timeZone);
  } catch {
    return undefined;
  }
}

/** A schedule's time as its maker's clock shows it. */
export function scheduleWhen(rec: Pick<ScheduledTaskRecord, "at" | "cron" | "timeZone">): string {
  const zone = rec.timeZone ?? "UTC";
  if (rec.at !== undefined && !rec.cron) return `once at ${formatInZone(new Date(rec.at), zone)} (${zone})`;
  return `\`${rec.cron}\` (${zone})`;
}

registerTool({
  name: "schedule_task",
  description:
    "Run a task later, by itself, and post what it finds into this conversation. Use it for anything to be checked, watched, "
    + "repeated or reminded of after this reply: nothing else happens until the user writes again. Three kinds: \"once\" (a "
    + "reminder, a check at a time), \"repeat\" (a briefing: every run is posted) and \"watch\" (\"tell me when…\": runs stay "
    + "silent until what the user waits for has happened; that run is posted and ends it). The user approves each call.",
  embeddingDescription:
    "schedule later remind reminder follow up keep watching monitor check again notify when timer recurring daily weekly; "
    + "erinnere mich, sag Bescheid sobald, beobachte weiter, prüfe täglich, später nachsehen",
  parameters: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: [...SCHEDULE_KINDS],
        description: "once: one run, needs `at` or `inMinutes`. repeat: needs `cron`; every run is posted, also one that found nothing new. watch: needs `cron` and `until`; nothing is posted until `until` has happened.",
      },
      at: { type: "string", description: "Kind once: the time on the user's clock, written YYYY-MM-DDTHH:mm, e.g. '2026-11-13T09:00'." },
      inMinutes: { type: "number", description: "Kind once: this many minutes from now, for 'in two hours'." },
      cron: { type: "string", description: "Kinds repeat and watch: 5-field cron expression on the user's clock, e.g. '0 8 * * 1-5' = weekdays at 08:00." },
      label: { type: "string", description: "Short label, shown with every post." },
      task: {
        type: "string",
        description:
          "The instruction a run executes, in the user's language. A run knows nothing of this conversation: name the subject in "
          + "full, say what is already known so that only what is new is reported, and what to report.",
      },
      until: {
        type: "string",
        description: "Kind watch: what the user is waiting for, as a statement a result can be checked against ('the full release is out').",
      },
      maxRuns: { type: "number", description: `Kinds repeat and watch: the most runs before it ends by itself. A watch gets ${DEFAULT_WATCH_RUNS} when none is given.` },
    },
    required: ["kind", "label", "task"],
  },
  async refuse(args: Record<string, unknown>): Promise<string | undefined> {
    const request = await readScheduleRequest(args, new Date(), currentRequestContext()?.userTimeZone);
    return "error" in request ? request.error : undefined;
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    // Read again: the approval may have taken a while, and a time that was a minute off is due now.
    const request = await readScheduleRequest(args, new Date(), currentRequestContext()?.userTimeZone, AT_PAST_TOLERANCE_AFTER_APPROVAL_MS);
    if ("error" in request) return { success: false, output: "", error: request.error };
    const { assumedUtc, ...stored } = request;

    const id = `sched_${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
    addAndActivateScheduledTask({
      id,
      ...stored,
      // The owner whole: its account id (or principal kind) with its name, so each run is theirs.
      ...scheduleOwner(ctx),
      // Where its runs report to. A sub-agent's or workflow's session is not a conversation.
      ...(ctx.sessionId && !ctx.sessionId.includes(":") ? { sessionId: ctx.sessionId } : {}),
      createdAt: new Date().toISOString(),
    });
    log.info({ id, cron: request.cron, at: request.at, timeZone: request.timeZone, label: request.label, watch: request.until !== undefined, sessionId: ctx.sessionId }, "schedule_task");

    const zone = request.timeZone ?? "UTC";
    const next = request.cron ? await nextCronRun(request.cron, zone) : undefined;
    const when = request.at
      ? `Runs ${scheduleWhen(request)}.`
      : `Runs on ${scheduleWhen(request)}${next ? `, next at ${next}` : ""}.`;
    const zoneNote = assumedUtc || (!request.timeZone && request.cron)
      ? " No time zone is known for this conversation, so the time was taken as UTC: say so."
      : "";
    const reports = request.until
      ? `A watch: runs stay silent until one finds that this has happened: "${request.until}". That run is posted into this conversation and ends the watch; so does run ${request.maxRuns}, whatever it finds.`
      : request.at
        ? "Its result is posted into this conversation."
        : `Every run's result is posted into this conversation${request.maxRuns !== undefined ? `, ${request.maxRuns} runs at most` : ""}.`;
    return {
      success: true,
      output: `Scheduled **${id}** — "${request.label}"\n${when}${zoneNote}\n${reports}\nTask: ${request.task}\n\nTell the user what was set up and when it first runs. It is removed with schedule_remove.`,
      metadata: { scheduleId: id, label: request.label, ...(request.cron ? { cron: request.cron } : {}), ...(request.at ? { at: request.at } : {}), ...(request.timeZone ? { timeZone: request.timeZone } : {}), watch: request.until !== undefined },
    };
  },
});

registerTool({
  name: "schedule_list",
  description: "List the scheduled tasks: what runs later or repeats, when, and what each watch waits for.",
  parameters: { type: "object", properties: {} },
  async execute(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const mayManage = await scheduleManager(ctx);
    const recs = listScheduledTaskRecords().filter(mayManage);
    if (recs.length === 0) return { success: true, output: "No scheduled tasks.", metadata: { count: 0 } };
    // A schedule of a deleted or retired account stays listed (an admin removes it) and says that it
    // no longer runs.
    const lines = recs.map((r) => {
      const when = scheduleWhen(r);
      const watch = r.until ? ` — watch until: "${r.until}"` : "";
      const runs = r.runs ? ` — ${r.runs}${r.maxRuns !== undefined ? ` of ${r.maxRuns}` : ""} run${r.runs === 1 ? "" : "s"}, last ${r.lastOutcome === "failed" ? "failed" : r.lastOutcome === "nothing_new" ? "found nothing new" : "posted"}${r.lastRunAt ? ` at ${r.lastRunAt}` : ""}` : "";
      return `- **${r.id}** "${r.label}" — ${when}${watch}${runs} — ${r.task}${r.disabled ? ` — disabled (${r.disabled.reason})` : ""}`;
    });
    return { success: true, output: `## Scheduled tasks (${recs.length})\n\n${lines.join("\n")}`, metadata: { count: recs.length } };
  },
});

registerTool({
  name: "schedule_remove",
  description: "Remove a scheduled task by its id: it does not run again.",
  parameters: {
    type: "object",
    properties: { scheduleId: { type: "string", description: "The schedule id (e.g. 'sched_...')." } },
    required: ["scheduleId"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const id = String(args["scheduleId"] ?? "").trim();
    if (!id) return { success: false, output: "", error: "scheduleId is required" };
    // Another owner's schedule answers as a missing one: the reply says nothing about it.
    const mayManage = await scheduleManager(ctx);
    const target = listScheduledTaskRecords().find((record) => record.id === id);
    if (target && !mayManage(target)) return { success: false, output: "", error: `No scheduled task with id: ${id}` };
    const removed = removeScheduledTask(id);
    if (!removed) return { success: false, output: "", error: `No scheduled task with id: ${id}` };
    return { success: true, output: `Scheduled task ${id} removed.`, metadata: { scheduleId: id } };
  },
});

/**
 * Which schedules a caller of schedule_list or schedule_remove may see and remove.
 *
 * Both tools listed and removed every schedule in the deployment, whoever made it: under
 * multi-user auth any account read the tasks other accounts had scheduled and could delete them.
 * There a schedule is now its owner's by identity (ownsRecord), so an account created again under a
 * deleted one's name does not inherit the old one's standing agents either; an admin manages all.
 * A schedule from before account ids, or with no owner, is an admin's alone. With one operator
 * every schedule is theirs, as before.
 */
async function scheduleManager(ctx: ToolContext): Promise<(record: ScheduledTaskRecord) => boolean> {
  if (!multiUserAuthActive()) return () => true;
  if (ctx.userRole) {
    // Lazily, to keep this leaf tool module off the gateway import graph at load time.
    const { roleRank } = await import("../gateway/auth.js");
    if (roleRank(ctx.userRole) >= roleRank("admin")) return () => true;
  }
  const caller = toolCallIdentity(ctx);
  return (record) => ownsRecord(caller, scheduleOwnerIdentity(record));
}

/** Who a stored schedule belongs to, whole, as scheduleOwner wrote it. */
function scheduleOwnerIdentity(record: ScheduledTaskRecord): Identity | undefined {
  if (record.userId === undefined) return undefined;
  if (record.account) return { userId: record.userId, account: record.account };
  if (record.principal) return { userId: record.userId, principal: record.principal };
  return { userId: record.userId };
}

/** Who a new schedule belongs to: the caller of schedule_task, whole, when it names one. */
function scheduleOwner(ctx: ToolContext): Pick<ScheduledTaskRecord, "userId" | "account" | "principal"> {
  if (!ctx.userId) return {};
  const owner = toolCallIdentity(ctx);
  if (!owner?.userId) return { userId: ctx.userId };
  return {
    userId: owner.userId,
    ...(owner.account ? { account: owner.account } : owner.principal ? { principal: owner.principal } : {}),
  };
}
