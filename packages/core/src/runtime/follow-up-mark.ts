/**
 * The mark a scheduled task's post carries: on the history message as `metadata.followUp`, on its
 * transcript entry as `followUp`. Kept apart from runtime/follow-up.ts, which writes the message,
 * so that agent/session.ts can read the mark without importing its own writer.
 */

/** Why a schedule ended with a run: it ran its one time, what it waited for happened, it used up
 *  its runs, or it kept failing. */
export type FollowUpEnded = "once" | "condition_met" | "max_runs" | "failed";

const ENDED: readonly FollowUpEnded[] = ["once", "condition_met", "max_runs", "failed"];

export interface FollowUpMark {
  scheduleId: string;
  label: string;
  jobId: string;
  /** Which run of the schedule this was, counted from 1. */
  run: number;
  /** Set when the schedule ended with this run. */
  ended?: FollowUpEnded;
  /** The run failed; the message says why. */
  failed?: true;
}

/** The mark on a history message's metadata, when the message is a schedule's post. */
export function followUpMarkOf(metadata: Record<string, unknown> | undefined): FollowUpMark | undefined {
  const raw = metadata?.["followUp"];
  if (typeof raw !== "object" || raw === null) return undefined;
  const mark = raw as Record<string, unknown>;
  if (typeof mark["scheduleId"] !== "string" || typeof mark["label"] !== "string" || typeof mark["jobId"] !== "string") return undefined;
  const ended = ENDED.find((value) => value === mark["ended"]);
  return {
    scheduleId: mark["scheduleId"],
    label: mark["label"],
    jobId: mark["jobId"],
    run: typeof mark["run"] === "number" && Number.isFinite(mark["run"]) ? mark["run"] : 1,
    ...(ended ? { ended } : {}),
    ...(mark["failed"] === true ? { failed: true as const } : {}),
  };
}
