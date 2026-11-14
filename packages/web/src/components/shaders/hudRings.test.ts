import { describe, expect, it } from "vitest";
import {
  HUD_RING_KINDS, SPHERE_FRAMES, SPHERE_INNER, SPHERE_OUTER, SPHERE_RINGS, STEP_RINGS, buildSphereRings,
  type HudRingKind,
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
    for (const ring of [...SPHERE_RINGS, ...STEP_RINGS]) {
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
