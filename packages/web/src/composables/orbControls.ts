/**
 * The chat page's controls in the orb's space: its three round controls, the message input's
 * options, and the start suggestions of an empty chat.
 *
 * The session, its actions and the message input each had a round button floating over the page:
 * glossy balls parked down the right edge, over the messages, in a look the orb has left behind
 * (it is drawn in hairlines of light and has no solid body). On a window wide enough for the orb
 * to have a zone of its own they stand in that zone now, on an orbit round the orb that is tipped
 * towards the viewer: the message input at its front, nearest and below the orb; the session and
 * its actions at its back, above the orb on either side. The canvas draws each one's gimbal and
 * its stretch of the orbit there (components/OrbCanvas.vue), and the page puts the button on it
 * through the same camera (composables/orbActivity.ts projectOrbPoint), as it does the steps.
 *
 * The message input's options (optionStations) fan out on the same orbit while the input bay is
 * open, where the window has the room; the start suggestions (starterLayout) stand on a second,
 * wider orbit in the same plane.
 *
 * Pure: the window in, the orbits and the stations on them out.
 */
import { LABEL_DROP, ORB_REACH, activityRing, orbPixels, projectOrbPoint, ringPosition } from "./orbActivity";

export type ControlId = "session" | "actions" | "message";
/** Which way a control's label and its menu go: away from the orb. */
export type ControlSide = "left" | "right" | "below";

/**
 * How far the orbit is tipped towards the viewer from edge-on. Open enough that its back stands
 * clear above the orb, tipped enough that its front is plainly the nearer side.
 */
export const CONTROL_TILT = (58 * Math.PI) / 180;
/** The orbit's radius in orb units where the window allows it: just past the orb's own orbits. */
export const CONTROL_ORBIT_RADIUS = 2.5;
/** How far the hologram sphere reaches, in orb units (components/shaders/hudRings.ts SPHERE_OUTER). */
export const SPHERE_REACH = 1.28;
/** Air between a control and the sphere, a control and the messages, and two controls, in pixels. */
export const CONTROL_GAP = 10;
/** The widest the two back controls stand apart: this angle either side of the orbit's back. */
export const CONTROL_SPREAD = (38 * Math.PI) / 180;
/** A control's face on the page, in pixels: never smaller than a finger needs. */
export const FACE_MIN = 40;
export const FACE_MAX = 52;
/** The face of a control at the orb's own depth, as a share of one orb unit on the page. */
const FACE_SHARE = 0.62;
/** What a control's name takes beside it, in pixels: its leader line and a word in the label's small capitals. */
export const LABEL_ROOM = 96;
/** Below this window height the message input's control stands too close over the foot of the page for a word under it. */
export const LABEL_MIN_HEIGHT = 640;

export interface ControlOrbit {
  /** Radius in orb units. */
  radius: number;
  /** Tipped towards the viewer from edge-on, radians; its front is below the orb. */
  tilt: number;
}

export interface ControlStation {
  id: ControlId;
  /** Where on the orbit it stands: π/2 is the front. */
  angle: number;
  /** Its centre on the page, in pixels from the viewport's centre, y downwards. */
  x: number;
  y: number;
  /** How much nearer than the orb's centre it is: above 1 in front of it, below 1 behind. */
  scale: number;
  /** Its face's diameter on the page, in pixels. */
  size: number;
  /** That face's radius in orb units at the station's depth: what the canvas sizes the gimbal by. */
  radius: number;
  side: ControlSide;
  /** Whether its name has room beside it: a name that would lie on a message is left to the tooltip. */
  labelled: boolean;
}

export interface ControlLayout {
  orbit: ControlOrbit;
  /** The session, its actions, the message input. */
  stations: ControlStation[];
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/**
 * The orbit and the three stations for a window. `freeHalf` is half the width the messages leave
 * free round the centre (orbActivity.ts freeHalfWidth): the back controls close up to stay inside
 * it, down to standing side by side.
 */
export function controlLayout(width: number, height: number, freeHalf = Infinity): ControlLayout {
  // One orb unit on the page at the orb's own depth: the faces are sized by it, so a control is
  // to the orb what it is on any window, between what a finger needs and what would outgrow it.
  const unit = orbPixels(width, height) / ORB_REACH;
  const face = clamp(FACE_SHARE * unit, FACE_MIN, FACE_MAX);

  const place = (radius: number, spread: number): ControlStation[] => {
    const orbit = { radius, tilt: CONTROL_TILT };
    const station = (id: ControlId, angle: number, side: ControlSide): ControlStation => {
      const seen = projectOrbPoint(ringPosition(angle, orbit), width, height);
      const size = Math.max(FACE_MIN, Math.round(face * seen.scale));
      const labelled = side === "below" ? height >= LABEL_MIN_HEIGHT : Math.abs(seen.x) + size / 2 + LABEL_ROOM <= freeHalf;
      return { id, angle, side, labelled, x: seen.x, y: seen.y, scale: seen.scale, size, radius: size / 2 / (unit * seen.scale) };
    };
    return [
      station("session", 1.5 * Math.PI - spread, "left"),
      station("actions", 1.5 * Math.PI + spread, "right"),
      station("message", 0.5 * Math.PI, "below"),
    ];
  };

  let radius = CONTROL_ORBIT_RADIUS;
  let spread = CONTROL_SPREAD;
  let stations = place(radius, spread);
  // The spread and the radius depend on each other through the camera (a station further back is
  // drawn smaller and nearer the centre), so they settle over a few passes.
  for (let pass = 0; pass < 8; pass += 1) {
    const back = stations[0]!;
    // Page pixels of x per unit of the spread's sine, at the depth the back stations have now.
    const perSine = Math.abs(back.x) / Math.sin(spread);
    // Side by side at the least; inside the band the messages leave free where it holds them; and
    // no wider apart than the orbit's back looks composed.
    const apart = (back.size + CONTROL_GAP) / 2 / perSine;
    const inBand = (freeHalf - back.size / 2 - CONTROL_GAP) / perSine;
    const sine = Math.max(apart, Math.min(Math.sin(CONTROL_SPREAD), inBand));
    // On an orb so small that two faces side by side are wider than its orbit's back, and where a
    // face would touch the sphere, the orbit widens.
    const short = Math.max(...stations.map((station) => (SPHERE_REACH * unit + CONTROL_GAP + station.size / 2) / Math.hypot(station.x, station.y)));
    const grow = Math.max(1, short, sine / Math.sin(CONTROL_SPREAD));
    const nextSpread = Math.asin(Math.min(Math.sin(CONTROL_SPREAD), sine / grow));
    if (grow < 1.0005 && Math.abs(nextSpread - spread) < 0.0005) break;
    radius *= grow > 1 ? grow * 1.002 : 1;
    spread = nextSpread;
    stations = place(radius, spread);
  }
  return { orbit: { radius, tilt: CONTROL_TILT }, stations };
}

/** A station's face as a box on the page: its top left corner and its size, in viewport pixels. */
export function stationBox(station: { x: number; y: number; size: number }, width: number, height: number): { left: number; top: number; size: number } {
  return {
    left: Math.round(width / 2 + station.x - station.size / 2),
    top: Math.round(height / 2 + station.y - station.size / 2),
    size: station.size,
  };
}

// ── The message input's options, on the orbit's front ───────────────────────────────────────
// What the input bay offers beside its field — its options menu, the effort, whether a render
// asks first, whether the model thinks — stood in the bay as a row of chips. While the bay is
// open they stand on the controls' orbit now, fanned out either side of its front, where the
// message input's own control stands while the bay is folded away: that control opens into them.

/** An option's face at the orb's own depth, as a share of one orb unit: a size under a control's. */
const OPTION_FACE_SHARE = 0.5;
export const OPTION_FACE_MAX = 44;
/** The furthest an option stands from the orbit's front: beyond it, it would climb into the steps' labels. */
export const OPTION_FAN = (40 * Math.PI) / 180;
/** The widest step between two options next to each other. */
export const OPTION_STEP = (27 * Math.PI) / 180;
/** Under an option: the air above its label, and the height of one line of it, in pixels. */
export const OPTION_LABEL_GAP = 7;
export const OPTION_LABEL_LINE = 13;
/** From this window height an option's label has room for two lines: its name, and what it is set to. */
export const OPTION_TWO_LINES_FROM = 840;

export interface OptionStation {
  /** Left to right. */
  index: number;
  /** Where on the orbit it stands: π/2 is the front. */
  angle: number;
  x: number;
  y: number;
  scale: number;
  size: number;
  /** Its face's radius in orb units at its depth, for the canvas. */
  radius: number;
  /** Which way its menu opens: away from the middle. The middle one's opens to the left. */
  side: "left" | "right";
}

/** Where `count` options stand on the orbit's front, left to right, for a window. */
export function optionStations(count: number, width: number, height: number, orbit: ControlOrbit): OptionStation[] {
  const unit = orbPixels(width, height) / ORB_REACH;
  const face = clamp(OPTION_FACE_SHARE * unit, FACE_MIN * 0.9, OPTION_FACE_MAX);
  const step = count > 1 ? Math.min(OPTION_STEP, (2 * OPTION_FAN) / (count - 1)) : 0;
  return Array.from({ length: Math.max(0, count) }, (_, index): OptionStation => {
    // Angles grow towards the left of the front, so the first option takes the largest.
    const offset = ((count - 1) / 2 - index) * step;
    const angle = Math.PI / 2 + offset;
    const seen = projectOrbPoint(ringPosition(angle, orbit), width, height);
    const size = Math.max(FACE_MIN, Math.round(face * seen.scale));
    return {
      index, angle, x: seen.x, y: seen.y, scale: seen.scale, size,
      radius: size / 2 / (unit * seen.scale),
      side: offset > -1e-9 ? "left" : "right",
    };
  });
}

/** How many lines an option's label has room for under it: two on a tall window, one below that. */
export function optionLabelLines(height: number): 1 | 2 {
  return height >= OPTION_TWO_LINES_FROM ? 2 : 1;
}

/** How far below the viewport's centre the options reach, labels and all, in pixels. */
export function optionsFloor(stations: readonly OptionStation[], labelLines: number): number {
  if (stations.length === 0) return 0;
  const faces = Math.max(...stations.map((station) => station.y + station.size / 2));
  return faces + (labelLines > 0 ? OPTION_LABEL_GAP + labelLines * OPTION_LABEL_LINE : 0);
}

/** A step's label under its point on the step ring, in pixels: its height, and the air an option keeps to it. */
const STEP_LABEL_HEIGHT = 24;
const STEP_LABEL_CLEAR = 4;

/**
 * How far below the viewport's centre the front step's label reaches while a turn runs: it hangs
 * under the front of the step ring (components/OrbActivity.vue), which is where the options'
 * fan begins.
 */
export function stepLabelFloor(width: number, height: number, freeHalf = Infinity): number {
  const ring = activityRing(width, height, freeHalf);
  return projectOrbPoint(ringPosition(Math.PI / 2, ring), width, height).y + LABEL_DROP + STEP_LABEL_HEIGHT;
}

export interface OptionRoom {
  /** How tall the input bay is, and how far its foot stands over the window's. */
  bayHeight: number;
  bayBottom?: number;
  /** How far below the viewport's centre what stands over the options reaches: the front step's label. */
  over?: number;
}

/**
 * Whether the options have room on the orbit: the lowest of them must end above the input bay,
 * and the highest begin under the front step's label. Where they have not — a low window, where
 * the orb is small and all of this is close together, or a bay grown tall with attachments or the
 * voice bar — they stay in the bay.
 */
export function optionsFit(stations: readonly OptionStation[], labelLines: number, height: number, room: OptionRoom): boolean {
  if (stations.length === 0) return true;
  const bayTop = height / 2 - (room.bayBottom ?? 20) - room.bayHeight;
  const top = Math.min(...stations.map((station) => station.y - station.size / 2));
  return optionsFloor(stations, labelLines) + CONTROL_GAP <= bayTop
    && (room.over === undefined || top >= room.over + STEP_LABEL_CLEAR);
}

// ── The start suggestions, on an arc of their own ───────────────────────────────────────────
// An empty chat offers a few beginnings. They were a row of pills at the foot of the page; they
// stand round the lower half of the orb now, on the front of a second, wider orbit in the
// controls' plane: the middle one in front, the others further round and further away.

/** The suggestions' orbit, in orb units, where the window has the room; and the least it shrinks to. */
export const STARTER_ORBIT_RADIUS = 4.4;
export const STARTER_ORBIT_MIN = 3.4;
/** The furthest a suggestion stands from the orbit's front, and the widest step between two. */
export const STARTER_FAN = (75 * Math.PI) / 180;
export const STARTER_STEP = (38 * Math.PI) / 180;
/** A suggestion's words: what they need at the least and take at the most, in pixels. */
export const STARTER_LABEL_MIN = 150;
export const STARTER_LABEL_MAX = 260;
/** From a suggestion's point to its words. */
export const STARTER_LABEL_OFFSET = 14;
/** The air a suggestion's words keep to the window's edge: the side panel's handle stands at the right one. */
export const STARTER_EDGE = 44;
/** Under the front suggestion: its words and the line that says typing works too. */
const STARTER_FOOT = 76;
/** The least the line over the suggestions needs between the message control and the front suggestion. */
const STARTER_LEAD_ROOM = 30;
/** Within this angle of the front a suggestion's words hang under its point; further round, beside it. */
const STARTER_BELOW_WITHIN = 0.2;

export interface StarterStation {
  /** Left to right. */
  index: number;
  angle: number;
  x: number;
  y: number;
  scale: number;
  /** Where its words stand: under its point at the front, on the outer side of it elsewhere. */
  side: ControlSide;
  /** The widest its words may be, in pixels. */
  maxWidth: number;
}

export interface StarterLayout {
  orbit: ControlOrbit;
  /** The share of the circle the suggestions' arc takes, centred on the orbit's front. */
  span: number;
  stations: StarterStation[];
  /** Where the line under them stands ("or just start typing"), in pixels below the centre. */
  hintY: number;
  /**
   * Where the line over them stands ("What shall I start with?"): between the message input's
   * control and the front suggestion, or null where the two leave it no room.
   */
  leadY: number | null;
}

/**
 * The suggestions' orbit and where `count` of them stand, for a window. `message` is the message
 * input's control, which the line over the suggestions keeps clear of.
 */
export function starterLayout(count: number, width: number, height: number, message?: ControlStation): StarterLayout {
  const step = count > 1 ? Math.min(STARTER_STEP, (2 * STARTER_FAN) / (count - 1)) : 0;
  const offsets = Array.from({ length: Math.max(0, count) }, (_, index) => ((count - 1) / 2 - index) * step);
  const place = (radius: number) => offsets.map((offset) => {
    const angle = Math.PI / 2 + offset;
    return { offset, angle, ...projectOrbPoint(ringPosition(angle, { radius, tilt: CONTROL_TILT }), width, height) };
  });

  // The orbit shrinks where the window is too narrow for the outer suggestions' words, or too low
  // for the front one and the line under it — but not into the controls' own orbit.
  let radius = STARTER_ORBIT_RADIUS;
  let points = place(radius);
  for (let pass = 0; pass < 6 && points.length > 0; pass += 1) {
    const widest = Math.max(...points.map((point) => Math.abs(point.x)));
    const lowest = Math.max(...points.map((point) => point.y));
    const sideRoom = width / 2 - STARTER_EDGE - STARTER_LABEL_OFFSET - STARTER_LABEL_MIN;
    const footRoom = height / 2 - STARTER_FOOT;
    const shrink = Math.min(1, widest > 0 ? sideRoom / widest : 1, lowest > 0 ? footRoom / lowest : 1);
    if (shrink > 0.999 || radius <= STARTER_ORBIT_MIN) break;
    radius = Math.max(STARTER_ORBIT_MIN, radius * shrink);
    points = place(radius);
  }

  const stations = points.map((point, index): StarterStation => {
    const below = Math.abs(point.offset) < STARTER_BELOW_WITHIN;
    const side: ControlSide = below ? "below" : point.offset > 0 ? "left" : "right";
    // Under its point a suggestion's words are centred, and end short of its neighbours' points;
    // beside it they run outwards, as far as the window's edge lets them.
    const neighbour = Math.min(...points.filter((other) => other !== point).map((other) => Math.abs(other.x - point.x)), Infinity);
    const room = below
      ? 2 * (neighbour - STARTER_LABEL_OFFSET)
      : width / 2 - Math.abs(point.x) - STARTER_LABEL_OFFSET - STARTER_EDGE;
    return {
      index, angle: point.angle, x: point.x, y: point.y, scale: point.scale, side,
      maxWidth: Math.round(clamp(room, 0, STARTER_LABEL_MAX)),
    };
  });

  const hintY = stations.length > 0
    ? Math.max(...stations.map((station) => station.y + (station.side === "below" ? 48 : 16))) + 14
    : 0;
  let leadY: number | null = null;
  if (message && stations.length > 0) {
    const top = message.y + message.size / 2 + (message.labelled ? 28 : 6);
    // The line is centred under the orb: it stands over the suggestion at the orbit's front, or
    // over the two either side of it. The ones further round are out of its way.
    const nearest = Math.min(...offsets.map(Math.abs));
    const frontmost = stations.filter((_, index) => Math.abs(offsets[index]!) < nearest + 1e-9);
    const bottom = Math.min(...frontmost.map((station) => station.y)) - 12;
    if (bottom - top >= STARTER_LEAD_ROOM) leadY = (top + bottom) / 2;
  }
  const reach = offsets.length > 0 ? Math.max(...offsets.map(Math.abs)) : 0;
  return {
    orbit: { radius, tilt: CONTROL_TILT },
    span: Math.min(1, (2 * reach + 0.42) / (2 * Math.PI)),
    stations, hintY, leadY,
  };
}
