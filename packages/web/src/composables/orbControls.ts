/**
 * The chat page's three controls in the orb's space.
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
 * Pure: the window in, the orbit and the three stations out.
 */
import { ORB_REACH, orbPixels, projectOrbPoint, ringPosition } from "./orbActivity";

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
export function stationBox(station: ControlStation, width: number, height: number): { left: number; top: number; size: number } {
  return {
    left: Math.round(width / 2 + station.x - station.size / 2),
    top: Math.round(height / 2 + station.y - station.size / 2),
    size: station.size,
  };
}
