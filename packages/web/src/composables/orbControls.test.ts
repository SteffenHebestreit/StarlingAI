import { describe, expect, it } from "vitest";
import { LABEL_DROP, ORB_REACH, activityRing, freeHalfWidth, orbPixels, orbitPoint, projectOrbPoint, ringPosition } from "./orbActivity";
import {
  CONTROL_GAP, CONTROL_ORBIT_RADIUS, CONTROL_SPREAD, CONTROL_TILT, FACE_MAX, FACE_MIN, LABEL_MIN_HEIGHT, LABEL_ROOM, SPHERE_REACH,
  OPTION_FACE_MAX, OPTION_FAN, OPTION_LABEL_GAP, OPTION_LABEL_LINE, OPTION_STEP, OPTION_TWO_LINES_FROM,
  STARTER_EDGE, STARTER_FAN, STARTER_LABEL_MAX, STARTER_LABEL_MIN, STARTER_LABEL_OFFSET, STARTER_ORBIT_MIN, STARTER_ORBIT_RADIUS, STARTER_STEP,
  controlLayout, optionLabelLines, optionStations, optionsFit, optionsFloor, starterLayout, stationBox, stepLabelFloor,
  type ControlStation,
} from "./orbControls";

/**
 * THE PAGE'S CONTROLS ON THEIR ORBIT ROUND THE ORB. The session, its actions and the message input
 * were round buttons parked over the messages; on a wide window they stand in the orb's own space,
 * where the canvas draws a gimbal round each and the page its glyph, through one camera.
 */
const WINDOWS: ReadonlyArray<readonly [number, number]> = [
  [1100, 800], [1280, 720], [1440, 900], [1600, 900], [1920, 1080], [2000, 1125], [2560, 1440], [1788, 1418], [3440, 1440], [1100, 520], [1400, 420],
];
const layoutFor = (width: number, height: number) => controlLayout(width, height, freeHalfWidth(width, height));
const byId = (stations: ControlStation[], id: string): ControlStation => stations.find((station) => station.id === id)!;
const unitOf = (width: number, height: number): number => orbPixels(width, height) / ORB_REACH;

describe("controlLayout", () => {
  it("stands the message input at the orbit's front and the session and its actions at its back", () => {
    const { orbit, stations } = layoutFor(1600, 900);
    expect(stations.map((station) => station.id)).toEqual(["session", "actions", "message"]);
    expect(orbit.tilt).toBe(CONTROL_TILT);
    expect(orbit.radius).toBeCloseTo(CONTROL_ORBIT_RADIUS);

    const message = byId(stations, "message");
    const session = byId(stations, "session");
    const actions = byId(stations, "actions");
    // The front: under the orb, on its axis, nearer the viewer than the orb's centre.
    expect(message.angle).toBeCloseTo(Math.PI / 2);
    expect(message.x).toBeCloseTo(0);
    expect(message.y).toBeGreaterThan(0);
    expect(message.scale).toBeGreaterThan(1);
    // The back: above the orb, either side of its axis and mirrored, further away than its centre.
    expect(session.y).toBeLessThan(0);
    expect(session.x).toBeLessThan(0);
    expect(actions.x).toBeCloseTo(-session.x);
    expect(actions.y).toBeCloseTo(session.y);
    expect(session.scale).toBeLessThan(1);
    expect(actions.angle - 1.5 * Math.PI).toBeCloseTo(1.5 * Math.PI - session.angle);
    // Each opens its name and its menu away from the orb.
    expect([session.side, actions.side, message.side]).toEqual(["left", "right", "below"]);
  });

  it("puts each station where the canvas's camera sees its point of the orbit", () => {
    for (const [width, height] of WINDOWS) {
      const { orbit, stations } = layoutFor(width, height);
      for (const station of stations) {
        const seen = projectOrbPoint(ringPosition(station.angle, orbit), width, height);
        expect(station.x).toBeCloseTo(seen.x);
        expect(station.y).toBeCloseTo(seen.y);
        expect(station.scale).toBeCloseTo(seen.scale);
      }
    }
  });

  it("draws the nearer control larger, and none smaller than a finger needs", () => {
    for (const [width, height] of WINDOWS) {
      const { stations } = layoutFor(width, height);
      const message = byId(stations, "message");
      const session = byId(stations, "session");
      expect(message.size).toBeGreaterThan(session.size);
      for (const station of stations) {
        expect(station.size).toBeGreaterThanOrEqual(FACE_MIN);
        expect(station.size).toBeLessThanOrEqual(Math.round(FACE_MAX * station.scale));
      }
    }
    // On a large orb the faces are sized by depth alone: the ratio of the two is the ratio of their scales.
    const { stations } = layoutFor(2560, 1440);
    const message = byId(stations, "message");
    const session = byId(stations, "session");
    expect(message.size / session.size).toBeCloseTo(message.scale / session.scale, 1);
  });

  it("gives the canvas each face's radius in orb units at the station's own depth", () => {
    for (const [width, height] of WINDOWS) {
      const unit = unitOf(width, height);
      for (const station of layoutFor(width, height).stations) {
        // A length of `radius` orb units at that depth is half the face on the page.
        expect(station.radius * unit * station.scale).toBeCloseTo(station.size / 2);
      }
    }
  });

  it("keeps every control clear of the hologram sphere and of the other two", () => {
    for (const [width, height] of WINDOWS) {
      const { stations } = layoutFor(width, height);
      const sphere = SPHERE_REACH * unitOf(width, height);
      for (const station of stations) {
        expect(Math.hypot(station.x, station.y) - station.size / 2, `${width}×${height} ${station.id}`).toBeGreaterThanOrEqual(sphere + CONTROL_GAP - 0.5);
      }
      for (let a = 0; a < stations.length; a += 1) {
        for (let b = a + 1; b < stations.length; b += 1) {
          const first = stations[a]!;
          const second = stations[b]!;
          const apart = Math.hypot(first.x - second.x, first.y - second.y) - (first.size + second.size) / 2;
          expect(apart, `${width}×${height} ${first.id}/${second.id}`).toBeGreaterThanOrEqual(CONTROL_GAP - 0.5);
        }
      }
    }
  });

  it("widens the orbit on an orb too small for its usual one to clear the sphere", () => {
    // 1400 × 420: one orb unit is 31 px, and a 40 px face on the usual orbit would touch the sphere.
    expect(layoutFor(1400, 420).orbit.radius).toBeGreaterThan(CONTROL_ORBIT_RADIUS * 1.05);
    // On an ordinary window the orbit is the usual one.
    expect(layoutFor(1920, 1080).orbit.radius).toBeCloseTo(CONTROL_ORBIT_RADIUS);
  });

  it("closes the back controls up to stay inside the band the messages leave free", () => {
    // Roomy: they stand at the orbit's widest.
    const roomy = layoutFor(1920, 1080);
    const wide = byId(roomy.stations, "actions");
    expect(wide.angle - 1.5 * Math.PI).toBeCloseTo(CONTROL_SPREAD);

    // 1100 × 800: the band is 62 px either side, less than the widest stance needs.
    const free = freeHalfWidth(1100, 800);
    const tight = controlLayout(1100, 800, free);
    const actions = byId(tight.stations, "actions");
    expect(actions.angle - 1.5 * Math.PI).toBeLessThan(CONTROL_SPREAD);
    expect(actions.x + actions.size / 2).toBeLessThanOrEqual(free - CONTROL_GAP + 0.5);
    // Closer together, they stand higher over the orb.
    expect(actions.y).toBeLessThan(byId(controlLayout(1100, 800, 400).stations, "actions").y);

    // No band at all: side by side at the least, never into each other.
    const none = controlLayout(1100, 800, 0);
    const left = byId(none.stations, "session");
    const right = byId(none.stations, "actions");
    expect(right.x - left.x).toBeGreaterThanOrEqual((left.size + right.size) / 2 + CONTROL_GAP - 0.5);
    expect(right.x - left.x).toBeLessThan(2 * actions.x + 1);
  });

  it("gives a control its name beside it only where the name has room", () => {
    // Roomy: all three.
    expect(layoutFor(1920, 1080).stations.map((station) => station.labelled)).toEqual([true, true, true]);
    // A name beside a back control must end inside the free band.
    for (const [width, height] of WINDOWS) {
      const free = freeHalfWidth(width, height);
      for (const station of layoutFor(width, height).stations.filter((candidate) => candidate.side !== "below")) {
        expect(station.labelled, `${width}×${height} ${station.id}`).toBe(Math.abs(station.x) + station.size / 2 + LABEL_ROOM <= free);
      }
    }
    // Its room is measured from the face's outer edge: one pixel less of band, and the name goes.
    const wide = byId(layoutFor(1920, 1080).stations, "actions");
    const edge = wide.x + wide.size / 2 + LABEL_ROOM;
    expect(byId(controlLayout(1920, 1080, edge).stations, "actions").labelled).toBe(true);
    expect(byId(controlLayout(1920, 1080, edge - 1).stations, "actions").labelled).toBe(false);
    // 1280 × 720: the messages come too near for the side names; the one under the front stays.
    expect(layoutFor(1280, 720).stations.map((station) => station.labelled)).toEqual([false, false, true]);
    // A low window: the front control stands close over the foot of the page, and goes without.
    expect(byId(layoutFor(1600, LABEL_MIN_HEIGHT - 1).stations, "message").labelled).toBe(false);
    expect(byId(layoutFor(1600, LABEL_MIN_HEIGHT).stations, "message").labelled).toBe(true);
  });
});

describe("stationBox", () => {
  it("is the face's box on the page, centred on the station", () => {
    const { stations } = layoutFor(1600, 900);
    const session = byId(stations, "session");
    const box = stationBox(session, 1600, 900);
    expect(box.size).toBe(session.size);
    expect(box.left + box.size / 2).toBeCloseTo(800 + session.x, 0);
    expect(box.top + box.size / 2).toBeCloseTo(450 + session.y, 0);
  });
});

/**
 * THE MESSAGE INPUT'S OPTIONS ON THE ORBIT'S FRONT. They were a row of chips in the input bay;
 * while the bay is open they stand on the controls' orbit, fanned out where the message input's
 * own control stands while the bay is folded away — where the window leaves them the room.
 */
/** Windows on which the options go onto the orbit: the orb is large enough for all of it to stand apart. */
const ROOMY: ReadonlyArray<readonly [number, number]> = [
  [1280, 800], [1440, 820], [1536, 864], [1440, 900], [1600, 900], [1920, 1080], [2560, 1440], [1788, 1418], [3440, 1440],
];
const optionsFor = (count: number, width: number, height: number) => optionStations(count, width, height, layoutFor(width, height).orbit);
const degrees = (radians: number): number => (radians * 180) / Math.PI;

describe("optionStations", () => {
  it("fans the options out either side of the orbit's front, left to right, in front of the orb", () => {
    const stations = optionsFor(4, 1600, 900);
    expect(stations.map((station) => station.index)).toEqual([0, 1, 2, 3]);
    // Left to right on the page.
    expect(stations.map((station) => station.x)).toEqual([...stations.map((station) => station.x)].sort((a, b) => a - b));
    // Mirrored about the orb's axis.
    expect(stations[0]!.x).toBeCloseTo(-stations[3]!.x);
    expect(stations[1]!.x).toBeCloseTo(-stations[2]!.x);
    expect(stations[0]!.y).toBeCloseTo(stations[3]!.y);
    for (const station of stations) {
      // Under the orb, and nearer the viewer than its centre.
      expect(station.y).toBeGreaterThan(0);
      expect(station.scale).toBeGreaterThan(1);
      expect(Math.abs(station.angle - Math.PI / 2)).toBeLessThanOrEqual(OPTION_FAN + 1e-9);
    }
    // The ones nearer the front stand lower on the page.
    expect(stations[1]!.y).toBeGreaterThan(stations[0]!.y);
    // A menu opens away from the middle.
    expect(stations.map((station) => station.side)).toEqual(["left", "left", "right", "right"]);
  });

  it("steps no wider than a step, and never past the fan", () => {
    const offsets = (count: number) => optionsFor(count, 1600, 900).map((station) => Math.round(degrees(station.angle - Math.PI / 2) * 100) / 100);
    expect(offsets(1)).toEqual([0]);
    expect(offsets(2)).toEqual([13.5, -13.5]);
    expect(offsets(3)).toEqual([27, 0, -27]);
    // Four and five would pass the fan at a full step each: they close up.
    expect(offsets(4)).toEqual([40, 13.33, -13.33, -40]);
    expect(offsets(5)).toEqual([40, 20, 0, -20, -40]);
    expect(degrees(OPTION_STEP)).toBeCloseTo(27);
    expect(degrees(OPTION_FAN)).toBeCloseTo(40);
    expect(optionsFor(0, 1600, 900)).toEqual([]);
  });

  it("stands the middle one of an odd number at the front, where the message control stood, its menu to the left", () => {
    const { stations: controls } = layoutFor(1600, 900);
    const middle = optionsFor(5, 1600, 900)[2]!;
    const message = byId(controls, "message");
    expect(middle.x).toBeCloseTo(message.x);
    expect(middle.y).toBeCloseTo(message.y);
    expect(middle.side).toBe("left");
  });

  it("puts each where the canvas's camera sees its point of the controls' orbit", () => {
    for (const [width, height] of WINDOWS) {
      const { orbit } = layoutFor(width, height);
      for (const station of optionStations(5, width, height, orbit)) {
        const seen = projectOrbPoint(ringPosition(station.angle, orbit), width, height);
        expect(station.x).toBeCloseTo(seen.x);
        expect(station.y).toBeCloseTo(seen.y);
        expect(station.scale).toBeCloseTo(seen.scale);
      }
    }
  });

  it("gives an option a face a size under a control's, never under a finger's, and its radius for the canvas", () => {
    for (const [width, height] of WINDOWS) {
      const unit = unitOf(width, height);
      const message = byId(layoutFor(width, height).stations, "message");
      for (const station of optionsFor(4, width, height)) {
        expect(station.size).toBeGreaterThanOrEqual(FACE_MIN);
        expect(station.size).toBeLessThanOrEqual(Math.round(OPTION_FACE_MAX * station.scale));
        expect(station.size).toBeLessThanOrEqual(message.size);
        expect(station.radius * unit * station.scale).toBeCloseTo(station.size / 2);
      }
    }
    // On a large orb an option is plainly the smaller of the two.
    expect(optionsFor(4, 2560, 1440)[1]!.size).toBeLessThan(byId(layoutFor(2560, 1440).stations, "message").size - 6);
  });

  it("keeps them clear of each other, of the sphere and of the session's and the actions' controls", () => {
    for (const [width, height] of ROOMY) {
      const sphere = SPHERE_REACH * unitOf(width, height);
      const back = layoutFor(width, height).stations.filter((station) => station.id !== "message");
      for (const count of [1, 2, 3, 4, 5]) {
        const stations = optionsFor(count, width, height);
        for (const station of stations) {
          expect(Math.hypot(station.x, station.y) - station.size / 2, `${width}×${height} ${count}`).toBeGreaterThanOrEqual(sphere + CONTROL_GAP - 0.5);
          for (const control of back) {
            expect(Math.hypot(station.x - control.x, station.y - control.y) - (station.size + control.size) / 2).toBeGreaterThan(CONTROL_GAP);
          }
        }
        for (let a = 0; a + 1 < stations.length; a += 1) {
          const first = stations[a]!;
          const second = stations[a + 1]!;
          const apart = Math.hypot(first.x - second.x, first.y - second.y) - (first.size + second.size) / 2;
          expect(apart, `${width}×${height} ${count}: ${a}`).toBeGreaterThanOrEqual(CONTROL_GAP);
        }
      }
    }
  });

  it("keeps them inside the band the messages leave free", () => {
    for (const [width, height] of ROOMY) {
      const free = freeHalfWidth(width, height);
      for (const station of optionsFor(5, width, height)) {
        expect(Math.abs(station.x) + station.size / 2, `${width}×${height}`).toBeLessThanOrEqual(free - CONTROL_GAP);
      }
    }
  });
});

describe("the options' room on the orbit", () => {
  it("gives a label two lines on a tall window and one below that", () => {
    expect(optionLabelLines(OPTION_TWO_LINES_FROM)).toBe(2);
    expect(optionLabelLines(OPTION_TWO_LINES_FROM - 1)).toBe(1);
    expect(optionLabelLines(1440)).toBe(2);
  });

  it("measures how far under the orb they reach, labels and all", () => {
    const stations = optionsFor(4, 1600, 900);
    const faces = Math.max(...stations.map((station) => station.y + station.size / 2));
    // The lowest face is one of the two nearest the front.
    expect(faces).toBeCloseTo(stations[1]!.y + stations[1]!.size / 2);
    expect(optionsFloor(stations, 0)).toBeCloseTo(faces);
    expect(optionsFloor(stations, 1)).toBeCloseTo(faces + OPTION_LABEL_GAP + OPTION_LABEL_LINE);
    expect(optionsFloor(stations, 2)).toBeCloseTo(faces + OPTION_LABEL_GAP + 2 * OPTION_LABEL_LINE);
    expect(optionsFloor([], 2)).toBe(0);
  });

  it("finds the front step's label where the page hangs it: under the front of the step ring", () => {
    for (const [width, height] of WINDOWS) {
      const free = freeHalfWidth(width, height);
      const front = orbitPoint(0, 1, { ring: activityRing(width, height, free), width, height, coreRadius: 0 });
      expect(stepLabelFloor(width, height, free)).toBeCloseTo(front.y + LABEL_DROP + 24);
    }
    // A wider free band lets the ring grow, and its front come down.
    expect(stepLabelFloor(1600, 900, 400)).toBeGreaterThan(stepLabelFloor(1600, 900, 150));
  });

  it("puts them on the orbit where they end above the bay and begin under the front step's label", () => {
    for (const [width, height] of ROOMY) {
      const stations = optionsFor(5, width, height);
      const over = stepLabelFloor(width, height, freeHalfWidth(width, height));
      expect(optionsFit(stations, optionLabelLines(height), height, { bayHeight: 150, over }), `${width}×${height}`).toBe(true);
    }
    expect(optionsFit([], 2, 900, { bayHeight: 600, over: 400 })).toBe(true);
  });

  it("leaves them in the bay on a low window, where the orb is small and they would stand in the step's label", () => {
    for (const [width, height] of [[1280, 720], [1366, 650], [1100, 740], [1920, 700]] as const) {
      const stations = optionsFor(4, width, height);
      const over = stepLabelFloor(width, height, freeHalfWidth(width, height));
      expect(optionsFit(stations, optionLabelLines(height), height, { bayHeight: 150, over }), `${width}×${height}`).toBe(false);
    }
    // At 1280 × 720 the bay alone would leave them the room: it is the label they would stand in.
    const stations = optionsFor(4, 1280, 720);
    expect(optionsFit(stations, 1, 720, { bayHeight: 150 })).toBe(true);
  });

  it("leaves them in the bay when the bay has grown too tall for them", () => {
    const stations = optionsFor(4, 1600, 900);
    const over = stepLabelFloor(1600, 900, freeHalfWidth(1600, 900));
    // The bay may come up to a gap under their labels, and no further.
    const limit = 900 / 2 - 20 - optionsFloor(stations, 2) - CONTROL_GAP;
    expect(optionsFit(stations, 2, 900, { bayHeight: limit, over })).toBe(true);
    expect(optionsFit(stations, 2, 900, { bayHeight: limit + 1, over })).toBe(false);
    // One line of label less is 13 px more of bay.
    expect(optionsFit(stations, 1, 900, { bayHeight: limit + OPTION_LABEL_LINE, over })).toBe(true);
    // A bay that stands higher over the window's foot has that much less.
    expect(optionsFit(stations, 2, 900, { bayHeight: limit, bayBottom: 40, over })).toBe(false);
    expect(optionsFit(stations, 2, 900, { bayHeight: limit - 20, bayBottom: 40, over })).toBe(true);
  });

  it("keeps their highest face a few pixels under the step's label, and not less", () => {
    const stations = optionsFor(4, 1600, 900);
    const top = Math.min(...stations.map((station) => station.y - station.size / 2));
    // The outer options are the highest.
    expect(top).toBeCloseTo(stations[0]!.y - stations[0]!.size / 2);
    expect(optionsFit(stations, 2, 900, { bayHeight: 150, over: top - 4 })).toBe(true);
    expect(optionsFit(stations, 2, 900, { bayHeight: 150, over: top - 3 })).toBe(false);
  });
});

/**
 * THE START SUGGESTIONS ON THEIR ARC. An empty chat's suggestions were a row of pills at the foot
 * of the page; on a wide window they stand round the lower half of the orb, on a second orbit.
 */
describe("starterLayout", () => {
  const message = (width: number, height: number) => byId(layoutFor(width, height).stations, "message");
  const startersFor = (count: number, width: number, height: number) => starterLayout(count, width, height, message(width, height));

  it("stands five suggestions round the lower half of the orb, the middle one in front", () => {
    const { orbit, stations } = startersFor(5, 1600, 900);
    expect(orbit).toEqual({ radius: STARTER_ORBIT_RADIUS, tilt: CONTROL_TILT });
    expect(stations.map((station) => station.index)).toEqual([0, 1, 2, 3, 4]);
    expect(stations.map((station) => station.x)).toEqual([...stations.map((station) => station.x)].sort((a, b) => a - b));
    const [farLeft, left, front, right, farRight] = stations as [typeof stations[0], typeof stations[0], typeof stations[0], typeof stations[0], typeof stations[0]];
    // Mirrored about the orb's axis.
    expect(front.x).toBeCloseTo(0);
    expect(left.x).toBeCloseTo(-right.x);
    expect(farLeft.x).toBeCloseTo(-farRight.x);
    expect(farLeft.y).toBeCloseTo(farRight.y);
    // All under the orb's centre; the front one lowest and nearest, the outer ones highest and furthest.
    for (const station of stations) expect(station.y).toBeGreaterThan(0);
    expect(front.y).toBeGreaterThan(left.y);
    expect(left.y).toBeGreaterThan(farLeft.y);
    expect(front.scale).toBeGreaterThan(left.scale);
    expect(left.scale).toBeGreaterThan(farLeft.scale);
    // Its words hang under the front one, and stand on the outer side of the others.
    expect(stations.map((station) => station.side)).toEqual(["left", "left", "below", "right", "right"]);
  });

  it("spaces them by a step, and closes them up to stay inside the fan", () => {
    const offsets = (count: number) => startersFor(count, 1920, 1080).stations.map((station) => Math.round(degrees(station.angle - Math.PI / 2) * 10) / 10);
    expect(offsets(1)).toEqual([0]);
    expect(offsets(2)).toEqual([19, -19]);
    expect(offsets(3)).toEqual([38, 0, -38]);
    expect(offsets(4)).toEqual([57, 19, -19, -57]);
    // Five at a full step would reach 76°: they close up to the fan's 75°.
    expect(offsets(5)).toEqual([75, 37.5, 0, -37.5, -75]);
    expect(offsets(7)).toEqual([75, 50, 25, 0, -25, -50, -75]);
    expect(degrees(STARTER_STEP)).toBeCloseTo(38);
    expect(degrees(STARTER_FAN)).toBeCloseTo(75);
    // With an even number none stands at the front, and none has its words under it.
    expect(startersFor(4, 1920, 1080).stations.map((station) => station.side)).toEqual(["left", "left", "right", "right"]);
  });

  it("puts each where the canvas's camera sees its point of the suggestions' orbit", () => {
    for (const [width, height] of WINDOWS) {
      const { orbit, stations } = startersFor(5, width, height);
      expect(orbit.tilt).toBe(CONTROL_TILT);
      for (const station of stations) {
        const seen = projectOrbPoint(ringPosition(station.angle, orbit), width, height);
        expect(station.x).toBeCloseTo(seen.x);
        expect(station.y).toBeCloseTo(seen.y);
        expect(station.scale).toBeCloseTo(seen.scale);
      }
    }
  });

  it("keeps the suggestions' orbit outside the controls' own", () => {
    for (const [width, height] of WINDOWS) {
      const controls = layoutFor(width, height);
      const starters = startersFor(5, width, height);
      expect(starters.orbit.radius).toBeGreaterThanOrEqual(STARTER_ORBIT_MIN);
      expect(starters.orbit.radius).toBeLessThanOrEqual(STARTER_ORBIT_RADIUS);
      expect(starters.orbit.radius, `${width}×${height}`).toBeGreaterThan(controls.orbit.radius + 0.5);
      // No suggestion's point lies on a control.
      for (const station of starters.stations) {
        for (const control of controls.stations) {
          expect(Math.hypot(station.x - control.x, station.y - control.y)).toBeGreaterThan(control.size / 2 + 5 + CONTROL_GAP);
        }
      }
    }
  });

  it("shrinks the orbit where the window is too narrow for the outer suggestions' words, down to its least", () => {
    // 1600 × 900 has the room: the full orbit, and the full width for every suggestion's words.
    const roomy = startersFor(5, 1600, 900);
    expect(roomy.orbit.radius).toBe(STARTER_ORBIT_RADIUS);
    expect(roomy.stations.map((station) => station.maxWidth)).toEqual([260, 260, 260, 260, 260]);
    // 1100 × 1100: a large orb in a narrow window — the orbit comes in so the outer words still have their least.
    const tight = startersFor(5, 1100, 1100);
    expect(tight.orbit.radius).toBeLessThan(STARTER_ORBIT_RADIUS);
    expect(tight.orbit.radius).toBeGreaterThan(STARTER_ORBIT_MIN);
    expect(tight.stations[0]!.maxWidth).toBeGreaterThanOrEqual(STARTER_LABEL_MIN - 1);
    // 1100 × 1400: at its least it stops, and the outer words get what is left.
    const least = startersFor(5, 1100, 1400);
    expect(least.orbit.radius).toBe(STARTER_ORBIT_MIN);
    expect(least.stations[0]!.maxWidth).toBeLessThan(STARTER_LABEL_MIN);
    expect(least.stations[0]!.maxWidth).toBeGreaterThan(100);
  });

  it("shrinks it where the window is too low for the front suggestion and the line under it", () => {
    const low = startersFor(5, 1600, 440);
    expect(low.orbit.radius).toBeLessThan(STARTER_ORBIT_RADIUS);
    expect(low.orbit.radius).toBeGreaterThanOrEqual(STARTER_ORBIT_MIN);
    for (const [width, height] of WINDOWS) {
      if (height < 500) continue;
      // The line under the suggestions ends inside the window.
      expect(startersFor(5, width, height).hintY + 16, `${width}×${height}`).toBeLessThanOrEqual(height / 2);
    }
  });

  it("keeps every suggestion's words inside the window, and the front one's off its neighbours", () => {
    for (const [width, height] of WINDOWS) {
      for (const count of [3, 4, 5]) {
        const { stations } = startersFor(count, width, height);
        for (const station of stations) {
          expect(station.maxWidth).toBeLessThanOrEqual(STARTER_LABEL_MAX);
          if (station.side === "below") {
            const neighbour = Math.min(...stations.filter((other) => other !== station).map((other) => Math.abs(other.x - station.x)));
            // Centred under its point: half of it to each side, ending short of the neighbour's point.
            expect(station.maxWidth / 2).toBeLessThanOrEqual(neighbour - STARTER_LABEL_OFFSET + 0.5);
          } else {
            expect(Math.abs(station.x) + STARTER_LABEL_OFFSET + station.maxWidth, `${width}×${height} ${count}`).toBeLessThanOrEqual(width / 2 - STARTER_EDGE + 0.5);
          }
        }
      }
    }
  });

  it("stands the line over them between the message control and the front suggestion, where there is room", () => {
    const control = message(1600, 900);
    const { leadY, stations, hintY } = startersFor(5, 1600, 900);
    const front = stations[2]!;
    // Under the control and its name, over the front suggestion: in the middle of the two.
    const top = control.y + control.size / 2 + 28;
    const bottom = front.y - 12;
    expect(leadY).toBeCloseTo((top + bottom) / 2);
    // The line under them stands under the front suggestion's words.
    expect(hintY).toBeCloseTo(front.y + 48 + 14);
    // Without the control it is not placed at all.
    expect(starterLayout(5, 1600, 900).leadY).toBeNull();
    // The suggestions beside the front do not count: they are out of a centred line's way.
    expect(startersFor(3, 1600, 900).leadY).toBeCloseTo(leadY!);
    // With an even number the two nearest the front stand in its way, and it stands over them.
    const four = startersFor(4, 1920, 1080);
    expect(four.leadY).not.toBeNull();
    expect(four.leadY!).toBeLessThan(four.stations[1]!.y - 12);
    // It needs 30 px between the two: 1600 × 480 leaves 35, 1600 × 460 leaves 28 — no line there.
    expect(startersFor(5, 1600, 480).leadY).not.toBeNull();
    expect(startersFor(5, 1600, 460).leadY).toBeNull();
  });

  it("says how much of the circle the arc takes: past the outermost suggestion on each side", () => {
    const five = startersFor(5, 1600, 900);
    expect(five.span * 360).toBeGreaterThan(150);
    expect(five.span * 360).toBeLessThan(150 + 30);
    const one = startersFor(1, 1600, 900);
    expect(one.span * 360).toBeCloseTo(degrees(0.42));
    expect(startersFor(3, 1600, 900).span).toBeLessThan(five.span);
  });

  it("has nothing to place for no suggestions", () => {
    const none = startersFor(0, 1600, 900);
    expect(none.stations).toEqual([]);
    expect(none.hintY).toBe(0);
    expect(none.leadY).toBeNull();
    expect(none.orbit.radius).toBe(STARTER_ORBIT_RADIUS);
  });
});
