import { describe, expect, it } from "vitest";
import { ORB_REACH, freeHalfWidth, orbPixels, projectOrbPoint, ringPosition } from "./orbActivity";
import {
  CONTROL_GAP, CONTROL_ORBIT_RADIUS, CONTROL_SPREAD, CONTROL_TILT, FACE_MAX, FACE_MIN, LABEL_MIN_HEIGHT, LABEL_ROOM, SPHERE_REACH,
  controlLayout, stationBox, type ControlStation,
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
