/**
 * The role a turn answers to, read when the turn starts (agent/runtime.ts runTurn) and when the
 * gateway checks a `--agent` directive before one (gateway/rpc.ts).
 *
 * A session records the role its creator held when it was opened (AgentSession.userRole), and keeps
 * it. Read alone, that judged every later turn in it by a role that may have changed since: an admin
 * demoted to operator kept running full-scope agents from the chats they had opened as admin, and an
 * operator promoted to admin was refused them there. The turn's role is what the full-scope agent
 * floor, ToolContext.userRole and the extension hooks (authorizeToolCall, authorizeAgentRun) read.
 *
 * With auth off every answer here is the session's recorded role, as before.
 */
import { getConfig } from "../config/loader.js";
import type { Identity } from "../runtime/accounts.js";
import type { TurnSender } from "../runtime/request-context.js";
import { ownsRecord } from "../runtime/user-scope.js";

/** What these checks read of a session (agent/session.ts AgentSession). */
export interface RoleHoldingSession {
  readonly userRole: string | undefined;
  identity(): Identity | undefined;
}

/**
 * The role a session's owner holds now. Under multi-user auth, the role the store holds for the
 * account (gateway/auth.ts storedAccountRole): a builtin account's record, an extension auth
 * provider's user, the role an identity provider granted at the account's latest sign-in. The
 * session's recorded role where the store holds none (an identity-provider account whose registry
 * entry predates that record) and where the account no longer signs in: only an admin can drive such
 * a session then, and work queued for it is refused before it runs (agent/scene-worker.ts).
 */
export async function liveSessionOwnerRole(session: RoleHoldingSession): Promise<string | undefined> {
  const owner = session.identity();
  if (getConfig().auth?.enabled !== true || !owner?.account) return session.userRole;
  // Imported here, as the other role checks outside the gateway do: agents stay out of the
  // gateway's module graph until a check needs it.
  const { storedAccountRole } = await import("../gateway/auth.js");
  const stored = storedAccountRole(owner);
  return typeof stored === "string" ? stored : session.userRole;
}

/**
 * The role a turn on `session` answers to. The person who sent its message, when the session is
 * theirs: their role as their connection holds it now (RequestContext.sender; the chat socket checks
 * the account again before every message). Any other turn answers to the session's owner as they
 * stand now (liveSessionOwnerRole): an admin driving another account's chat, whose own role the
 * gateway checks beside it (`--agent`, approvals), and a turn nobody sent (a scene's or a job's step).
 * Undefined when no role is known, as for a session no sign-in created: the turn then takes the one
 * its enclosing work carries.
 */
export async function turnRole(session: RoleHoldingSession, sender: TurnSender | undefined): Promise<string | undefined> {
  if (getConfig().auth?.enabled === true && sender?.role !== undefined && ownsRecord(sender.identity, session.identity())) {
    return sender.role;
  }
  return liveSessionOwnerRole(session);
}
