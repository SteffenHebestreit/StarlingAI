import { getConfig } from "../config/loader.js";
import { getAllSessions, getSessionRecord, type AgentSession } from "../agent/session.js";
import { owningChatSessionId } from "../agent/session-ids.js";
import type { ComputerSession } from "../agent/computer-session.js";
import type { BrowserSession } from "../agent/browser-session.js";
import type { Identity } from "../runtime/accounts.js";
import { ownsRecord, recordHasOwner } from "../runtime/user-scope.js";
import { callerIdentity, roleRank, userHasRole, type AuthenticatedUser } from "./auth.js";

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
 * - A session with no owner (auth-off history) stays open to any caller.
 * - Otherwise the caller must be its owner by identity (ownsRecord), not by name: an account
 *   created again under a deleted one's name, or a bootstrap token whose `sub` is an account's
 *   username, owned every session the name did. A channel sender's session is that principal's,
 *   so no dashboard caller owns it, and a session from before account ids is an admin's alone.
 */
export function callerMayUseSession(caller: AuthenticatedUser | null, sessionId: string): boolean {
  if (getConfig().auth?.enabled !== true) return true;
  if (userHasRole(caller, "admin")) return true;
  const session = getSessionRecord(sessionId);
  if (!session) return false;
  const owner = session.identity();
  return !recordHasOwner(owner) || ownsRecord(callerIdentity(caller), owner);
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
 * Clients that pre-generate a UUID keep working. The id must be a string too: RegExp.test reads any
 * value as its string, so `["<alice's id>"]` from a JSON body passed as Alice's id while every
 * lookup keyed by the value itself missed her session (found in review, 2026-10-09).
 * With auth off there is one operator and nothing to keep apart.
 */
export function clientMayCreateSessionId(sessionId: unknown): boolean {
  if (getConfig().auth?.enabled !== true) return true;
  return typeof sessionId === "string" && CLIENT_SESSION_ID.test(sessionId);
}

/** Whether the caller holds at least `role`. With auth off there is one operator, who holds every
 *  role, as the gateway's role gate already treats it. */
export function callerHasRank(caller: AuthenticatedUser | null, role: string): boolean {
  if (getConfig().auth?.enabled !== true) return true;
  return userHasRole(caller, role);
}

/**
 * Whether the caller may see a computer-use session in full (its screenshots, accessibility text and
 * lease owner) and drive it: read it, request a frame of it, keep it alive. A session belongs to the
 * chat its lease is held for (`leaseOwner` is the session id of the run that started or attached
 * it, often a `sub:` run of that chat), so the rule is callerMayUseSession on that chat: its owner,
 * or an admin. An emergency stop revokes the lease and keeps the last frame, so a stopped session
 * stays with the chat that held it then (`revokedLeaseOwner`). A session no run holds (detached)
 * belongs to nobody, and only an admin sees it whole. Callers answer a denial as they answer a
 * missing session.
 *
 * Every authenticated socket and token could list every session with its last frame and the text
 * of its windows, push itself a fresh frame of any of them, and revive a paused one: one account
 * read another's desktop (found in a role audit, 2026-11).
 */
export function callerMayUseComputerSession(
  caller: AuthenticatedUser | null,
  session: Pick<ComputerSession, "leaseOwner" | "revokedLeaseOwner">,
): boolean {
  if (getConfig().auth?.enabled !== true) return true;
  const holder = session.leaseOwner || session.revokedLeaseOwner;
  if (!holder) return userHasRole(caller, "admin");
  return callerMayUseSession(caller, owningChatSessionId(holder));
}

/**
 * Whether the caller may emergency-stop a computer-use session. Any operator may stop any session,
 * owned or not: it is a safety control, and the person who sees a runaway agent on a shared desktop
 * need not be the one whose chat started it. Below operator rank no caller gets here by default: the
 * REST role gate refuses every POST, and the socket's computer.emergency_stop needs operator rank
 * (gateway/rpc-policy.ts). A role that an extension's rpcPolicies opens the method to may stop a
 * session of its own, as it may then keep that session alive.
 */
export function callerMayStopComputerSession(
  caller: AuthenticatedUser | null,
  session: Pick<ComputerSession, "leaseOwner" | "revokedLeaseOwner"> | undefined,
): boolean {
  if (callerHasRank(caller, "operator")) return true;
  return session !== undefined && callerMayUseComputerSession(caller, session);
}

/** What a caller who may not use a computer session sees of it in a listing: enough to know it
 *  runs, and to stop it. */
export interface RestrictedComputerSessionView {
  id: string;
  adapter: ComputerSession["adapter"];
  nodeId?: string;
  state: ComputerSession["state"];
  createdAt: number;
  emergencyStopAt?: number;
  /** Its frames, window text and lease owner are withheld: another user's session, or nobody's. */
  restricted: true;
}

function restrictedComputerSessionView(session: ComputerSession): RestrictedComputerSessionView {
  return {
    id: session.id,
    adapter: session.adapter,
    ...(session.nodeId ? { nodeId: session.nodeId } : {}),
    state: session.state,
    createdAt: session.createdAt,
    ...(session.emergencyStopAt !== undefined ? { emergencyStopAt: session.emergencyStopAt } : {}),
    restricted: true,
  };
}

/**
 * A listing of computer sessions as the caller may see it: the sessions it may use in full; the
 * others, to an operator (who may stop them), as RestrictedComputerSessionView (no snapshot, no
 * lease owner); to anyone else, not at all.
 */
export function computerSessionsVisibleTo(
  caller: AuthenticatedUser | null,
  sessions: readonly ComputerSession[],
): Array<ComputerSession | RestrictedComputerSessionView> {
  const seesOthers = callerHasRank(caller, "operator");
  return sessions.flatMap((session): Array<ComputerSession | RestrictedComputerSessionView> => {
    if (callerMayUseComputerSession(caller, session)) return [session];
    return seesOthers ? [restrictedComputerSessionView(session)] : [];
  });
}

/**
 * Whether the caller may see a browser session (its page, why it waits on a person) and answer its
 * handoff: the owner of the chat that delegated the browser run (`parentSessionId`), or an admin. A
 * session with no parent is an admin's alone.
 */
export function callerMayUseBrowserSession(caller: AuthenticatedUser | null, session: Pick<BrowserSession, "parentSessionId">): boolean {
  if (getConfig().auth?.enabled !== true) return true;
  if (!session.parentSessionId) return userHasRole(caller, "admin");
  return callerMayUseSession(caller, owningChatSessionId(session.parentSessionId));
}

/** The chat a nested session id belongs to (agent/session-ids.ts, the one copy, which the computer-use
 *  tools share), re-exported for the route modules that check access through this file. */
export { owningChatSessionId };

/**
 * The sessions a caller may see listed: every one for an admin, otherwise the caller's own and those
 * with no owner. One rule for the socket's session list and GET /api/status, which listed every
 * session's id, channel and turn count to any caller that signed in.
 *
 * `caller` is undefined where there is no one to enforce anything for (auth off, or a socket whose
 * token names no subject): every session, as before. ADMIN, not operator, is exempt, as for
 * callerMayUseSession. A caller with no identity owns nothing, so it sees the unowned sessions only.
 */
export function visibleSessionsFor(
  caller: { identity: Identity | undefined; role: string | undefined } | undefined,
  opts?: { includeArchived?: boolean },
): AgentSession[] {
  const sessions = getAllSessions(opts);
  if (!caller || (caller.role !== undefined && roleRank(caller.role) >= roleRank("admin"))) return sessions;
  return sessions.filter((session) => {
    const owner = session.identity();
    return !recordHasOwner(owner) || ownsRecord(caller.identity, owner);
  });
}
