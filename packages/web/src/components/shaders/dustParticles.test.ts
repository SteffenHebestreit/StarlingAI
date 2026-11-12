import { describe, expect, it } from "vitest";
import { DUST_BREATH, DUST_INNER, DUST_OUTER, DUST_STIR, buildDust } from "./dustParticles";
import { GLOBE_RADIUS, SPHERE_FRAMES } from "./hudRings";

/** The core's own shell of points (OrbCanvas.vue NS_RADIUS), in orb units. */
const CORE_SHELL = 0.4;

const dust = buildDust();
const pointCount = dust.clouds.reduce((sum, cloud) => sum + cloud.count, 0);
/** A point strays DUST_STIR along each of the three axes at most. */
const stir = DUST_STIR * Math.sqrt(3);

describe("the orb's breathing body", () => {
  it("is the same body on every load, and another one for another seed", () => {
    expect(buildDust()).toEqual(dust);
    expect(buildDust(1).clouds[0]!.phase).not.toEqual(dust.clouds[0]!.phase);
  });

  it("lies between the core's shell and the cage at rest", () => {
    for (const cloud of dust.clouds) {
      for (let i = 0; i < cloud.count; i++) {
        const reach = Math.hypot(cloud.radius[i]!, cloud.height[i]!);
        expect(reach).toBeGreaterThanOrEqual(DUST_INNER - 1e-6);
        expect(reach).toBeLessThanOrEqual(DUST_OUTER + 1e-6);
      }
    }
  });

  it("is held by the cage: breathing in it does not reach the globe, breathing out it does not sink into the core", () => {
    expect(DUST_OUTER * (1 + DUST_BREATH) + stir).toBeLessThan(GLOBE_RADIUS);
    expect(DUST_INNER * (1 - DUST_BREATH) - stir).toBeGreaterThan(CORE_SHELL);
  });

  it("hangs every cloud in a frame of the sphere, one cloud per frame", () => {
    const frames = dust.clouds.map((cloud) => cloud.frame);
    expect(new Set(frames).size).toBe(frames.length);
    for (const cloud of dust.clouds) {
      expect(SPHERE_FRAMES[cloud.frame]).toBeDefined();
      for (const list of [cloud.radius, cloud.angle, cloud.height, cloud.speed, cloud.phase, cloud.isNode]) {
        expect(list.length).toBe(cloud.count);
      }
    }
  });

  it("is a body, not a handful of points and not a fog", () => {
    expect(pointCount).toBeGreaterThan(500);
    expect(pointCount).toBeLessThan(1200);
  });

  it("marks exactly the points a pulse can start from, and knows where each of them is", () => {
    const marked = dust.clouds.reduce((sum, cloud) => sum + cloud.isNode.reduce((a, b) => a + b, 0), 0);
    expect(dust.nodes.length).toBe(10);
    expect(marked).toBe(dust.nodes.length);
    for (const node of dust.nodes) {
      const cloud = dust.clouds.find((c) => c.frame === node.frame)!;
      const at = cloud.radius.findIndex((radius, i) => radius === node.radius && cloud.angle[i] === node.angle && cloud.height[i] === node.height);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(cloud.isNode[at]).toBe(1);
      expect(cloud.speed[at]).toBe(node.speed);
    }
  });
});
