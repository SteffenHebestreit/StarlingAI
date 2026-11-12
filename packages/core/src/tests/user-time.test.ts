import { describe, expect, it } from "vitest";
import { formatInZone, parseUserTime, validTimeZone, wallTimeInZone, zoneOffsetMinutes } from "../runtime/user-time.js";

describe("the user's time zone", () => {
  it("takes a zone the runtime knows and nothing else", () => {
    expect(validTimeZone("Europe/Berlin")).toBe("Europe/Berlin");
    expect(validTimeZone(" America/Argentina/Buenos_Aires ")).toBe("America/Argentina/Buenos_Aires");
    expect(validTimeZone("UTC")).toBe("UTC");
    expect(validTimeZone("Mars/Olympus_Mons")).toBeUndefined();
    expect(validTimeZone("Europe/Berlin; rm -rf")).toBeUndefined();
    expect(validTimeZone("")).toBeUndefined();
    expect(validTimeZone(60)).toBeUndefined();
    expect(validTimeZone("x".repeat(80))).toBeUndefined();
  });

  it("knows how far a zone is ahead of UTC, summer and winter", () => {
    expect(zoneOffsetMinutes("Europe/Berlin", new Date("2026-11-12T12:00:00Z"))).toBe(60);
    expect(zoneOffsetMinutes("Europe/Berlin", new Date("2026-07-12T12:00:00Z"))).toBe(120);
    expect(zoneOffsetMinutes("America/New_York", new Date("2026-11-12T12:00:00Z"))).toBe(-300);
    expect(zoneOffsetMinutes("Asia/Kolkata", new Date("2026-11-12T12:00:00Z"))).toBe(330);
    expect(zoneOffsetMinutes("UTC", new Date("2026-11-12T12:00:00Z"))).toBe(0);
  });
});

describe("a wall-clock time in a zone", () => {
  it("is the instant that clock shows it", () => {
    expect(wallTimeInZone("2026-11-13T09:00", "Europe/Berlin")?.toISOString()).toBe("2026-11-13T08:00:00.000Z");
    expect(wallTimeInZone("2026-07-13T09:00", "Europe/Berlin")?.toISOString()).toBe("2026-07-13T07:00:00.000Z");
    expect(wallTimeInZone("2026-11-13 09:00:30", "America/New_York")?.toISOString()).toBe("2026-11-13T14:00:30.000Z");
    expect(wallTimeInZone("2026-11-13T00:15", "Asia/Kolkata")?.toISOString()).toBe("2026-11-12T18:45:00.000Z");
  });

  it("resolves the days the clocks change", () => {
    // Berlin 2026: forward on 29 March (02:00 → 03:00), back on 25 October (03:00 → 02:00).
    expect(wallTimeInZone("2026-03-29T09:00", "Europe/Berlin")?.toISOString()).toBe("2026-03-29T07:00:00.000Z");
    expect(wallTimeInZone("2026-03-29T01:30", "Europe/Berlin")?.toISOString()).toBe("2026-03-29T00:30:00.000Z");
    expect(wallTimeInZone("2026-10-25T09:00", "Europe/Berlin")?.toISOString()).toBe("2026-10-25T08:00:00.000Z");
    // The skipped hour lands in the hour after it, never a day off.
    const skipped = wallTimeInZone("2026-03-29T02:30", "Europe/Berlin")!;
    expect(["2026-03-29T00:30:00.000Z", "2026-03-29T01:30:00.000Z"]).toContain(skipped.toISOString());
  });

  it("is nothing for what is not a time, or a date that does not exist", () => {
    expect(wallTimeInZone("tomorrow at nine", "Europe/Berlin")).toBeUndefined();
    expect(wallTimeInZone("2026-02-30T09:00", "Europe/Berlin")).toBeUndefined();
    expect(wallTimeInZone("2026-11-13T25:00", "Europe/Berlin")).toBeUndefined();
    expect(wallTimeInZone("2026-11-13", "Europe/Berlin")).toBeUndefined();
  });

  it("reads back as the zone's clock shows it", () => {
    expect(formatInZone(new Date("2026-11-13T08:00:00Z"), "Europe/Berlin")).toBe("2026-11-13 09:00");
    expect(formatInZone(new Date("2026-11-12T23:30:00Z"), "Europe/Berlin")).toBe("2026-11-13 00:30");
  });
});

describe("a time as a schedule takes it", () => {
  it("is the user's wall clock when it names no offset", () => {
    expect(parseUserTime("2026-11-13T09:00", "Europe/Berlin")).toEqual({ at: new Date("2026-11-13T08:00:00Z"), assumedUtc: false });
  });

  it("is the instant it names when it carries an offset or a Z, whatever the user's zone", () => {
    expect(parseUserTime("2026-11-13T09:00:00+05:30", "Europe/Berlin")).toEqual({ at: new Date("2026-11-13T03:30:00Z"), assumedUtc: false });
    expect(parseUserTime("2026-11-13T09:00:00Z", "Europe/Berlin")).toEqual({ at: new Date("2026-11-13T09:00:00Z"), assumedUtc: false });
  });

  it("is UTC, and says so, where no zone is known", () => {
    expect(parseUserTime("2026-11-13T09:00", undefined)).toEqual({ at: new Date("2026-11-13T09:00:00Z"), assumedUtc: true });
  });

  it("is nothing for what is not a time", () => {
    expect(parseUserTime("morgen um 9", "Europe/Berlin")).toBeUndefined();
    expect(parseUserTime("", "Europe/Berlin")).toBeUndefined();
  });
});
