/**
 * Computer-use sessions as the dashboard lists them, and which one the live preview follows.
 *
 * The gateway lists a caller's own sessions whole. To an operator it also lists everyone else's,
 * as `restricted` entries: id, adapter, node, state and start time, enough to emergency-stop a
 * runaway session, but no frames, window text or lease owner. It sends no frame of such a session,
 * so the preview must not follow one: it would ask for a screenshot every second and get none.
 */

export interface ComputerSession {
  id: string;
  adapter: string;
  state: string;
  createdAt: number;
  updatedAt?: number;
  lastHeartbeat: number;
  attachedScene?: string;
  /** Another user's session (or nobody's): it can be stopped, not watched. */
  restricted?: boolean;
}

const LIVE_STATES = new Set(["active", "initializing", "paused"]);

/** A session entry as the gateway sent it (`computer.list_sessions`), in the dashboard's shape. */
export function normalizeComputerSession(session: Record<string, unknown>): ComputerSession {
  return {
    id: String(session.id ?? ""),
    adapter: String(session.adapter ?? "unknown"),
    state: String(session.state ?? "active"),
    createdAt: Number(session.createdAt ?? Date.now()),
    updatedAt: Number(session.updatedAt ?? Date.now()),
    lastHeartbeat: Number(session.lastHeartbeatAt ?? session.lastHeartbeat ?? session.updatedAt ?? Date.now()),
    attachedScene: typeof session.attachedScene === "string" ? session.attachedScene : undefined,
    ...(session.restricted === true ? { restricted: true } : {}),
  };
}

/** Whether the live preview may follow a session: the gateway sends frames of the caller's own. */
export function canObserveComputerSession(session: Pick<ComputerSession, "restricted">): boolean {
  return session.restricted !== true;
}

/**
 * The session the live preview should follow when none is chosen: the preferred one, else the
 * first live one, else the first at all, of those it may watch. Null when it may watch none.
 */
export function computerSessionToObserve(sessions: readonly ComputerSession[], preferredId?: string | null): string | null {
  const watchable = sessions.filter(canObserveComputerSession);
  const preferred = preferredId ? watchable.find((session) => session.id === preferredId) : undefined;
  return (preferred ?? watchable.find((session) => LIVE_STATES.has(session.state)) ?? watchable[0])?.id ?? null;
}
