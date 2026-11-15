import { describe, expect, it } from "vitest";
import {
  CONTROL_ORBIT_RING, HUD_RING_KINDS, NODE_ORBIT_ARC, NODE_RINGS, SPHERE_FRAMES, SPHERE_INNER, SPHERE_OUTER, SPHERE_RINGS, STEP_RINGS,
  SUGGESTION_ARC, buildSphereRings, type HudRingKind,
} from "./hudRings";

/** The orb's own parts the sphere has to keep clear of (OrbCanvas.vue, orbitalSystem.ts), in orb units. */
const CORE_SPHERE = 0.4;
const FIRST_ORBIT = 1.45;

/** How far a ring draws outside and inside its own circle: a scale's marks point inwards, teeth outwards. */
const OUTWARD: Record<HudRingKind, number> = { hair: 0, rail: 1, scale: 0, dash: 0.5, teeth: 1, tracks: 1 };
const INWARD: Record<HudRingKind, number> = { hair: 0, rail: 1, scale: 1, dash: 0.5, teeth: 0, tracks: 1 };

describe("the hologram sphere", () => {
  it("is the same sphere on every load, and another one for another seed", () => {
    expect(buildSphereRings()).toEqual(SPHERE_RINGS);
    expect(buildSphereRings(1)).not.toEqual(SPHERE_RINGS);
  });

  it("stays between the core's sphere of points and the first orbit", () => {
    for (const ring of SPHERE_RINGS) {
      const onSphere = Math.hypot(ring.radius, ring.offset);
      expect(onSphere).toBeGreaterThanOrEqual(SPHERE_INNER);
      expect(onSphere).toBeLessThanOrEqual(SPHERE_OUTER);
      expect(Math.hypot(ring.radius + OUTWARD[ring.kind] * ring.width, ring.offset)).toBeLessThan(FIRST_ORBIT);
      expect(Math.hypot(ring.radius - INWARD[ring.kind] * ring.width, ring.offset)).toBeGreaterThan(CORE_SPHERE);
    }
  });

  it("hangs every ring in a frame that exists, on a plane with a real normal", () => {
    for (const ring of SPHERE_RINGS) {
      expect(SPHERE_FRAMES[ring.frame]).toBeDefined();
      expect(Math.hypot(...ring.normal)).toBeCloseTo(1, 6);
      expect(ring.arc).toBeGreaterThan(0);
      expect(ring.arc).toBeLessThanOrEqual(1);
      expect(ring.strength).toBeGreaterThan(0);
    }
  });

  it("draws every kind of ring, and keeps some of each size of orb", () => {
    expect(new Set(SPHERE_RINGS.map((ring) => ring.kind))).toEqual(new Set(HUD_RING_KINDS));
    const minor = SPHERE_RINGS.filter((ring) => ring.minor).length;
    // A small orb still has a sphere, and a large one has more to show.
    expect(SPHERE_RINGS.length - minor).toBeGreaterThanOrEqual(10);
    expect(minor).toBeGreaterThanOrEqual(5);
  });

  it("stays sparse, and sparsest near the core, so the rings do not steal the show from it", () => {
    expect(SPHERE_RINGS.length).toBeLessThanOrEqual(24);
    const nearCore = SPHERE_RINGS.filter((ring) => Math.hypot(ring.radius, ring.offset) < 0.8);
    expect(nearCore.length).toBeLessThanOrEqual(2);
  });

  it("gives some of its rings a share of the dust's colours, and leaves the rest the core's", () => {
    const shares = SPHERE_RINGS.map((ring) => ring.tint ?? 0);
    const tinted = shares.filter((share) => share > 0).length;
    // Not all of them, or the sphere is one colour again; not a few, or the dust stays a stranger in it.
    expect(tinted).toBeGreaterThanOrEqual(Math.ceil(SPHERE_RINGS.length * 0.35));
    expect(tinted).toBeLessThanOrEqual(Math.floor(SPHERE_RINGS.length * 0.7));
    expect(new Set(shares)).toEqual(new Set([0, 0.55, 1]));
    // Among the bold lines and the quiet ones alike.
    expect(SPHERE_RINGS.filter((ring) => !ring.minor).some((ring) => (ring.tint ?? 0) > 0)).toBe(true);
    expect(SPHERE_RINGS.filter((ring) => !ring.minor).some((ring) => (ring.tint ?? 0) === 0)).toBe(true);
  });

  it("lays the sphere out as it was: the shares do not move a ring", () => {
    // The first ring is the globe's equator, a whole graduated scale — whatever its share.
    const { tint: _tint, ...equator } = SPHERE_RINGS[0]!;
    expect(equator).toMatchObject({ kind: "scale", arc: 1, offset: 0, tiles: 65 });
    expect(SPHERE_RINGS).toHaveLength(21);
  });

  it("gives a scale a whole number of fives, so every fifth mark is a long one all the way round", () => {
    for (const ring of [...SPHERE_RINGS, ...STEP_RINGS, ...NODE_RINGS]) {
      if (ring.kind === "scale") expect(ring.tiles % 5).toBe(0);
    }
  });
});

describe("the step ring", () => {
  it("has its rail where the page puts the steps, and is built whole", () => {
    const rail = STEP_RINGS.find((ring) => ring.kind === "rail");
    expect(rail?.radius).toBe(1);
    for (const ring of STEP_RINGS) {
      expect(ring.arc).toBe(1);
      expect(ring.offset).toBe(0);
      expect(ring.normal).toEqual([0, 0, 1]);
      expect(ring.minor).toBeUndefined();
    }
  });

  it("keeps the rail the steps ride on in the core's colour, and grades its scale like the dust", () => {
    expect(STEP_RINGS.find((ring) => ring.kind === "rail")?.tint).toBeUndefined();
    expect(STEP_RINGS.find((ring) => ring.kind === "scale")?.tint).toBe(1);
  });
});

describe("the page's controls on their orbit", () => {
  it("draws a control's gimbal round the bezel the page draws, never across its glyph", () => {
    for (const ring of NODE_RINGS) {
      // 1 is the bezel round the glyph: everything a ring draws stays outside it.
      expect(ring.radius - INWARD[ring.kind] * ring.width).toBeGreaterThan(1);
      // A great circle about the node's own centre, which it turns round.
      expect(ring.offset).toBe(0);
      // Leaning: neither flat to the viewer, where it would be a second bezel, nor edge-on, where it dims to a line.
      const lean = Math.abs(ring.normal[2]) / Math.hypot(...ring.normal);
      expect(lean).toBeGreaterThan(0.5);
      expect(lean).toBeLessThan(0.9);
      expect(ring.arc).toBeLessThan(1);
      // A control keeps its whole gimbal on a small orb too.
      expect(ring.minor).toBeUndefined();
    }
    // The two rings turn against each other, and lean different ways.
    expect(Math.sign(NODE_RINGS[0]!.spin)).toBe(-Math.sign(NODE_RINGS[1]!.spin));
    expect(Math.sign(NODE_RINGS[0]!.normal[0])).toBe(-Math.sign(NODE_RINGS[1]!.normal[0]));
  });

  it("draws the whole orbit faintly and lights each control's own stretch of it", () => {
    for (const ring of [NODE_ORBIT_ARC, CONTROL_ORBIT_RING, SUGGESTION_ARC]) {
      // In the orbit's own plane and units: the canvas scales it to the orbit's radius.
      expect(ring.radius).toBe(1);
      expect(ring.offset).toBe(0);
      expect(ring.normal).toEqual([0, 0, 1]);
    }
    expect(CONTROL_ORBIT_RING.arc).toBe(1);
    // A stretch short enough that the two back controls' stretches stay apart at their widest stance (38° either side).
    expect(NODE_ORBIT_ARC.arc * 360).toBeLessThan(2 * 38);
    // The orbit is a guide for the eye, not a fourth thing to look at.
    expect(CONTROL_ORBIT_RING.strength).toBeLessThan(NODE_ORBIT_ARC.strength / 2);
  });

  it("draws the start suggestions' arc as a plain line with light running along it, quieter than a control's stretch", () => {
    expect(SUGGESTION_ARC.kind).toBe("hair");
    // A partial arc: the page says how much of the circle (the fan of the suggestions).
    expect(SUGGESTION_ARC.arc).toBeLessThan(1);
    expect(SUGGESTION_ARC.tiles).toBeGreaterThanOrEqual(1);
    expect(SUGGESTION_ARC.flow).toBeGreaterThan(0);
    expect(SUGGESTION_ARC.spin).toBe(0);
    expect(SUGGESTION_ARC.strength).toBeLessThan(NODE_ORBIT_ARC.strength);
    expect(SUGGESTION_ARC.strength).toBeGreaterThan(CONTROL_ORBIT_RING.strength);
  });
});
