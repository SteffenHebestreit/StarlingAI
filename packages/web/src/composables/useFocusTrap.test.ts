import { describe, expect, it } from "vitest";
import { focusTrapTarget } from "./useFocusTrap";

// Stops stand in for elements: their number is their place in the document.
const stops = [10, 20, 30];

describe("focusTrapTarget", () => {
  it("turns round at the ends", () => {
    expect(focusTrapTarget(stops, 30, false)).toBe(10);
    expect(focusTrapTarget(stops, 10, true)).toBe(30);
  });

  it("leaves the steps in between to the browser", () => {
    expect(focusTrapTarget(stops, 10, false)).toBeNull();
    expect(focusTrapTarget(stops, 20, false)).toBeNull();
    expect(focusTrapTarget(stops, 20, true)).toBeNull();
    expect(focusTrapTarget(stops, 30, true)).toBeNull();
  });

  it("pulls a focus from outside the dialog back to an end", () => {
    expect(focusTrapTarget(stops, null, false)).toBe(10);
    expect(focusTrapTarget(stops, undefined, true)).toBe(30);
    // Something focused that is no stop, and nothing known about where it is.
    expect(focusTrapTarget(stops, 99, false)).toBe(10);
    expect(focusTrapTarget(stops, 99, true)).toBe(30);
  });

  it("keeps a single stop on itself, both ways", () => {
    expect(focusTrapTarget([10], 10, false)).toBe(10);
    expect(focusTrapTarget([10], 10, true)).toBe(10);
    expect(focusTrapTarget([10], null, true)).toBe(10);
  });

  it("has nowhere to go without stops", () => {
    expect(focusTrapTarget([], null, false)).toBeNull();
    expect(focusTrapTarget([], 10, true)).toBeNull();
  });

  describe("from a spot inside the dialog that is no stop", () => {
    const from = (place: number) => (stop: number) => place < stop;

    it("lets the browser step on while a stop lies that way", () => {
      expect(focusTrapTarget(stops, 15, false, from(15))).toBeNull();
      expect(focusTrapTarget(stops, 15, true, from(15))).toBeNull();
    });

    it("turns round where none does", () => {
      // After the last stop, going on; before the first, going back.
      expect(focusTrapTarget(stops, 35, false, from(35))).toBe(10);
      expect(focusTrapTarget(stops, 5, true, from(5))).toBe(30);
    });

    it("from the dialog's own frame: forward into it, backward to its last stop", () => {
      // The frame comes before everything in it.
      expect(focusTrapTarget(stops, 0, false, from(0))).toBeNull();
      expect(focusTrapTarget(stops, 0, true, from(0))).toBe(30);
    });
  });
});
