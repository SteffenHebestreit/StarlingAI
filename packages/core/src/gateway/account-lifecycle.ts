/**
 * What ends with an account: a builtin account deleted (DELETE /api/auth/users/:username) or an
 * identity-provider account retired (POST /api/admin/accounts/:id/retire).
 *
 * Either one stopped the account's tokens and closed its open sockets, and nothing else. Its chats
 * stayed open, a turn it had started ran to the end, its queued and running jobs ran, its schedules
 * kept firing and queued a turn as the account every time, and its MCP sessions and A2A tasks stayed
 * in memory. None of that could reach another account (everything is keyed by the account id), but
 * all of it went on working for an account nobody can sign in as any more, in storage nobody can
 * reach. Now each of them ends here.
 *
 * Nothing is deleted: the account's storage stays under its id, its sessions are archived, its
 * schedules are kept, disabled. Only an explicit purge removes them.
 */
import { archiveSession, getAllSessions } from "../agent/session.js";
import { cancelAccountJobs } from "../agent/jobs.js";
import { userInputBroker } from "../agent/user-input-broker.js";
import { isSessionTurnActive } from "../agent/warden.js";
import { sameAccountId } from "../runtime/accounts.js";
import { disableAccountScheduledTasks } from "../runtime/scheduled-task-runner.js";
import { childLogger } from "../logger.js";
import { closeAccountConnections, endAccountBindings } from "./account-connections.js";

const log = childLogger("gateway:account-lifecycle");

/** Why an account ended. */
export type AccountEndReason = "account deleted" | "account retired";

/** What ended with the account, for the route's reply and its audit record. */
export interface AccountEndSummary {
  socketsClosed: number;
  sessionsArchived: number;
  turnsStopped: number;
  jobsCancelled: number;
  schedulesDisabled: number;
  /** MCP HTTP sessions and A2A tasks, by kind. */
  bindingsEnded: Record<string, number>;
  /** The steps that failed; the others still ran. */
  failed: string[];
}

/**
 * Ends everything `account` has running or bound, in this order: its open sockets; its live
 * sessions (a running turn stopped, a question it waits on closed, the session archived as an
 * explicit end); its queued and running jobs; its schedules; its MCP sessions and A2A tasks. Each
 * step runs whether or not an earlier one failed, and a failure is named in the summary.
 */
export async function endAccountActivity(account: string, reason: AccountEndReason, actor: string): Promise<AccountEndSummary> {
  const summary: AccountEndSummary = {
    socketsClosed: 0,
    sessionsArchived: 0,
    turnsStopped: 0,
    jobsCancelled: 0,
    schedulesDisabled: 0,
    bindingsEnded: {},
    failed: [],
  };
  const code = reason.replace(" ", "_");

  summary.socketsClosed = closeAccountConnections(account, reason);

  for (const session of getAllSessions()) {
    if (!session.account || !sameAccountId(session.account, account)) continue;
    try {
      if (isSessionTurnActive(session.id)) {
        // The force stop of the session route: the turn aborts here, or wherever it runs.
        const { requestDistributedSessionCancel } = await import("../swarm/control.js");
        await requestDistributedSessionCancel(session.id, { reason: code, actor });
        summary.turnsStopped += 1;
      }
      userInputBroker.stopRoot(session.id);
      if (archiveSession(session.id, "manual")) summary.sessionsArchived += 1;
    } catch (err) {
      log.error({ err, account, sessionId: session.id }, "Could not end a session of an ended account");
      if (!summary.failed.includes("sessions")) summary.failed.push("sessions");
    }
  }

  try {
    summary.jobsCancelled = (await cancelAccountJobs(account)).length;
  } catch (err) {
    log.error({ err, account }, "Could not cancel the jobs of an ended account");
    summary.failed.push("jobs");
  }

  try {
    summary.schedulesDisabled = disableAccountScheduledTasks(account, reason).length;
  } catch (err) {
    log.error({ err, account }, "Could not disable the schedules of an ended account");
    summary.failed.push("schedules");
  }

  const bindings = await endAccountBindings(account, reason);
  summary.bindingsEnded = bindings.ended;
  summary.failed.push(...bindings.failed);

  log.info({ account, reason, ...summary }, "Ended an account's sessions, jobs, schedules and bindings");
  return summary;
}
