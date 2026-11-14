import { describe, expect, it } from "vitest";
import { podLanes } from "./podLanes";

const column = { left: 0, right: 1788 };
const pod = (x: number, size = 40) => ({ x, size });

describe("podLanes", () => {
  it("keeps the messages out from under a button parked at the right edge", () => {
    // The live case: the session button dragged to x = 1736 of 1788, over the question's last words.
    const lanes = podLanes([pod(1736)], column);
    // 52 px from the edge to the button's inner side, 10 px of air, less the column's own 20 px.
    expect(lanes).toEqual({ left: 0, right: 42 });
    // The message then ends left of the button.
    expect(column.right - 20 - lanes.right).toBeLessThan(1736);
  });

  it("does the same at the left edge", () => {
    expect(podLanes([pod(29)], column)).toEqual({ left: 59, right: 0 });
  });

  it("makes one lane as wide as the innermost button parked there", () => {
    // The defaults: actions and session at 95.5 % of the width, the composer button at 95 %.
    const lanes = podLanes([pod(0.955 * 1788), pod(0.955 * 1788), pod(0.95 * 1788, 54)], column);
    expect(lanes.left).toBe(0);
    expect(lanes.right).toBe(Math.round(1788 - 0.95 * 1788 + 10 - 20));
  });

  it("reserves a lane on each side when buttons are parked on both", () => {
    const lanes = podLanes([pod(29), pod(1736)], column);
    expect(lanes.left).toBeGreaterThan(0);
    expect(lanes.right).toBeGreaterThan(0);
  });

  it("reserves nothing for a button dragged out over the middle of a column", () => {
    expect(podLanes([pod(1400)], column)).toEqual({ left: 0, right: 0 });
    expect(podLanes([pod(300)], column)).toEqual({ left: 0, right: 0 });
    expect(podLanes([pod(874)], column)).toEqual({ left: 0, right: 0 });
  });

  it("reserves nothing for a button that needs no more than the column's own inset", () => {
    // Narrower than the inset and hard at the edge: nothing lies under it anyway.
    expect(podLanes([pod(1788 - 8, 8)], column, { gap: 4 })).toEqual({ left: 0, right: 0 });
  });

  it("ignores a button that stands beside the column, not over the messages", () => {
    const beside = { left: 0, right: 1200 };
    expect(podLanes([pod(1736)], beside)).toEqual({ left: 0, right: 0 });
    // One that straddles the column's edge still covers its last pixels.
    expect(podLanes([pod(1180)], beside).right).toBe(Math.round(20 + 10 - 20));
  });

  it("scales what counts as parked with the column: the default place on a very wide screen", () => {
    const wide = { left: 0, right: 3840 };
    // 4.5 % of 3840 is 173 px from the edge: further than 8rem, still the button's default place.
    expect(podLanes([pod(0.955 * 3840)], wide).right).toBe(Math.round(3840 - 0.955 * 3840 + 10 - 20));
  });

  it("returns no lanes for a column it cannot measure", () => {
    expect(podLanes([pod(100)], { left: 0, right: 0 })).toEqual({ left: 0, right: 0 });
  });
});
