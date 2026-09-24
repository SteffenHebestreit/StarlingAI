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
