/**
 * What the chat does when its content grows: keep the newest line in view, point at it, or
 * leave the reader where they are.
 *
 * Growth used to be noticed only through two proxies — a new message, or more streamed text. A
 * turn that only runs tools grows through neither: its step rows, status line and reasoning
 * expand inside the one live bubble, and its answer replaces that bubble in place. So the view
 * sat still and the answer landed below the fold with nothing saying so. The chat now measures
 * the content itself, and this decides what a measured growth means.
 *
 * Only a turn's own growth moves the view. Content that grows because the reader opened
 * something — "show more", a thinking panel — must not scroll away from what they just opened.
 *
 * Deliberately free of Vue and of the store, so it can be exercised on its own.
 */

export type FollowAction = "stick" | "mark" | "none";

export function followGrowth(input: {
  /** Content height now minus at the last measurement. */
  grewBy: number;
  /** The reader is parked at the bottom. */
  atBottom: boolean;
  /** A turn is running, or has just landed. */
  turnLive: boolean;
}): FollowAction {
  if (input.grewBy <= 0 || !input.turnLive) return "none";
  return input.atBottom ? "stick" : "mark";
}

/** How long after a turn lands its growth still counts as the turn's: the answer is laid out after the flag flips. */
export const LANDING_FOLLOW_MS = 1_500;
