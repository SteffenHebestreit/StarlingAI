/**
 * Lanes for the chat page's round controls.
 *
 * The session, actions and composer buttons float over the page where the user parks them, by
 * default down the right edge — which is where the messages stand (pages/Chat.vue lays each side
 * out at its outer edge). A long question ran under the button beside it, its words covered. The
 * messages now keep a lane free at a side for the buttons parked there: this says how wide.
 *
 * Pure: the buttons' places and the messages' column in, the two lanes out.
 */

export interface Pod {
  /** The button's left edge, in viewport pixels. */
  x: number;
  /** Its width. */
  size: number;
}

export interface PodLanes {
  /** Extra room the messages leave at the column's left edge, beyond its own inset, in pixels. */
  left: number;
  right: number;
}

export interface PodLaneOptions {
  /** The room the column already leaves at each edge (its padding). */
  inset?: number;
  /** The air between a button and the nearest message. */
  gap?: number;
  /**
   * How far from an edge a button still counts as parked there. One dragged out over the middle
   * of a column is the user's choice and reserves nothing: a lane that wide would take the column.
   */
  reach?: number;
}

/** A button counts as parked at an edge within this share of the column's width, or 8rem if that is more. */
const REACH_SHARE = 0.07;
const REACH_MIN = 128;

export function podLanes(pods: readonly Pod[], column: { left: number; right: number }, options: PodLaneOptions = {}): PodLanes {
  const width = column.right - column.left;
  if (!(width > 0)) return { left: 0, right: 0 };
  const inset = options.inset ?? 20;
  const gap = options.gap ?? 10;
  const reach = options.reach ?? Math.max(REACH_MIN, REACH_SHARE * width);
  let left = 0;
  let right = 0;
  for (const pod of pods) {
    // Beside the column (in the page's own margin), not over the messages.
    if (pod.x >= column.right || pod.x + pod.size <= column.left) continue;
    const fromRight = column.right - pod.x;
    const fromLeft = pod.x + pod.size - column.left;
    if (fromRight <= fromLeft) {
      if (fromRight <= reach) right = Math.max(right, fromRight + gap);
    } else if (fromLeft <= reach) {
      left = Math.max(left, fromLeft + gap);
    }
  }
  return { left: Math.max(0, Math.round(left - inset)), right: Math.max(0, Math.round(right - inset)) };
}
