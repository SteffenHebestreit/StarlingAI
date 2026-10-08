import { getConfig } from "../config/loader.js";
import { getSessionRecord } from "../agent/session.js";
import { isInternalSessionId } from "../agent/session-ids.js";
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

/**
 * Whether a client may start a new session under an id it chose (the AG-UI stream adopts the id a
 * request names when no session has it).
 *
 * Under multi-user auth, not an id in a namespace the system mints ids in (isInternalSessionId).
 * Runs there have no session record, so the id looked free, and a session created under it shared
 * the run's facts bucket: a turn's shared facts live under its session id, a sub-agent's under its
 * root's. A2A ids are predictable from the account's name (`a2a-in:<user segment>:<id>`), so one
 * account could name another's A2A run and read what it found (found in review, 2026-10-08). Any
 * other id stays the client's to choose, so clients that pre-generate a UUID keep working.
 * With auth off there is one operator and nothing to keep apart.
 */
export function clientMayCreateSessionId(sessionId: string): boolean {
  if (getConfig().auth?.enabled !== true) return true;
  return !isInternalSessionId(sessionId);
}
