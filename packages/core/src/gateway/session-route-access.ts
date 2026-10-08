import { getConfig } from "../config/loader.js";
import { getSessionRecord } from "../agent/session.js";
import { userHasRole, type AuthenticatedUser } from "./auth.js";

/**
 * Whether an HTTP caller may read or drive a session through a /api/sessions/:sessionId route.
 * Callers answer a denial with an opaque 404, so the reply does not confirm the id exists.
 *
 * One rule for every such route, because each route that carried its own copy drifted: /stop
 * exempted operators, the role every account gets by default, and shared-facts and the transcript
 * exports checked nothing at all.
 *
 * - Auth off: a single operator, nothing to enforce.
 * - ADMIN, not operator, is exempt: an operator exemption exempts everyone.
 * - An owner this process cannot see is not an absent owner. getSessionRecord also sees archived
 *   sessions; an id it cannot resolve at all (never existed, or held by another gateway instance)
 *   is refused rather than assumed free.
 * - A session with no owner (auth-off history, channel sessions) stays open to any caller.
 */
export function callerMayUseSession(caller: AuthenticatedUser | null, sessionId: string): boolean {
  if (getConfig().auth?.enabled !== true) return true;
  if (userHasRole(caller, "admin")) return true;
  const session = getSessionRecord(sessionId);
  if (!session) return false;
  return session.userId === undefined || session.userId === caller?.username;
}

/** The ids a client may start a session under: letters, digits, `_` and `-`, at most 128 of them.
 *  A UUID fits, and so does every id the system mints for a chat session (a UUID). */
const CLIENT_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Whether a client may start a new session under an id it chose (the AG-UI stream adopts the id a
 * request names when no session has it).
 *
 * Under multi-user auth, only an id of the CLIENT_SESSION_ID shape, which has no colon. A colon is
 * how a session id names another session, and an id that does was taken apart as one:
 *
 * - The namespaces the system mints ids in (INTERNAL_SESSION_ID_PREFIXES) all end in one. Runs
 *   there have no session record, so the id looked free, and a session created under it shared the
 *   run's facts bucket. A2A ids are predictable from the account's name (`a2a-in:<user segment>:
 *   <id>`), so one account could name another's A2A run and read what it found (found in review,
 *   2026-10-08).
 * - `<alice's session id>:ephemeral` looked like an id of the client's own, but a sub-agent run of
 *   it is `sub:<alice's id>:ephemeral:<agent>:<stamp>`, and parentSessionOf reads `ephemeral` there
 *   as the namespace of an ephemeral agent's name. The run resolved to Alice's session as its root,
 *   and with it her shared facts, turn steering, plan and grants (found in review, 2026-10-09).
 *
 * A fixed character set closes both, where a list of forbidden prefixes closed only the first.
 * Clients that pre-generate a UUID keep working.
 * With auth off there is one operator and nothing to keep apart.
 */
export function clientMayCreateSessionId(sessionId: string): boolean {
  if (getConfig().auth?.enabled !== true) return true;
  return CLIENT_SESSION_ID.test(sessionId);
}
