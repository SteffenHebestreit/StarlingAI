/**
 * Which user-role message opens a turn.
 *
 * Mid-turn steering and the oversight redirect are injected into the history as `role: "user"`
 * so the model treats them as the user's words — but they arrive INSIDE a turn. Every reader that
 * keyed "the current turn" on the last user-role message (the collapsed-history plan snippet, the
 * delegated-evidence backstops, this turn's artifacts, the timeout delivery, the prior-turn
 * window) therefore cut the turn at the steering message and lost everything before it: a plan
 * report clipped to 2,000 characters on the very turn answering from it, a turn's own artifacts
 * missed by the verification gate, pre-steering evidence dropped by the recovery backstops. Those
 * messages carry the marker below; a turn starts at a user message without it.
 */
export const MID_TURN_USER_MESSAGE_METADATA = "midTurn";

export interface TurnBoundaryMessage {
  role: string;
  metadata?: Record<string, unknown> | undefined;
}

/** True for the user message that opens a turn — not for one injected while the turn ran. */
export function startsTurn(message: TurnBoundaryMessage): boolean {
  return message.role === "user" && message.metadata?.[MID_TURN_USER_MESSAGE_METADATA] !== true;
}

/** Index of the user message that opened the current turn, or -1 when there is none. */
export function currentTurnStartIndex(history: readonly TurnBoundaryMessage[]): number {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (startsTurn(history[i]!)) return i;
  }
  return -1;
}
