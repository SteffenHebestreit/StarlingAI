import { describe, expect, it } from "vitest";
import { ref } from "vue";
import { LIST_PAGE_SIZE, limitToReach, noMatchLine, useListWindow, windowCounts, windowSummary } from "./listWindow";
import { formatDateTime, isoTimestamp } from "./formatDate";

const rows = (count: number): number[] => Array.from({ length: count }, (_, index) => index);

describe("what a list window shows", () => {
  it("shows one page of a longer list and says how much is left", () => {
    expect(windowCounts(312, 50, 50)).toEqual({ shown: 50, total: 312, hasMore: true, nextStep: 50 });
  });

  it("offers only what is left on the last step", () => {
    expect(windowCounts(120, 100, 50)).toEqual({ shown: 100, total: 120, hasMore: true, nextStep: 20 });
  });

  it("shows a short list whole", () => {
    expect(windowCounts(12, 50, 50)).toEqual({ shown: 12, total: 12, hasMore: false, nextStep: 0 });
    expect(windowCounts(50, 50, 50)).toEqual({ shown: 50, total: 50, hasMore: false, nextStep: 0 });
  });

  it("has nothing to show of an empty list", () => {
    expect(windowCounts(0, 50, 50)).toEqual({ shown: 0, total: 0, hasMore: false, nextStep: 0 });
  });

  it("never shows less than one page, whatever limit it is handed", () => {
    expect(windowCounts(200, 0, 50).shown).toBe(50);
    expect(windowCounts(200, -5, 50).shown).toBe(50);
    expect(windowCounts(200, Number.NaN, 50).shown).toBe(50);
    expect(windowCounts(200, 10, 0).shown).toBe(10);
  });

  it("uses a page of 50 unless told otherwise", () => {
    expect(LIST_PAGE_SIZE).toBe(50);
    expect(windowCounts(80, 50).shown).toBe(50);
  });
});

describe("the count line", () => {
  it("counts what is on screen against the whole list", () => {
    expect(windowSummary({ shown: 50, total: 312 })).toBe("Showing 50 of 312");
  });

  it("says so when the whole list is on screen", () => {
    expect(windowSummary({ shown: 120, total: 120 })).toBe("Showing all 120");
  });
});

describe("an empty list under a filter", () => {
  it("names the search text", () => {
    expect(noMatchLine("jobs", "  deploy ")).toBe("No jobs match “deploy”.");
  });

  it("names the filter when only a select is set", () => {
    expect(noMatchLine("jobs", "", true)).toBe("No jobs match the current filter.");
    expect(noMatchLine("jobs", "   ")).toBe("No jobs match the current filter.");
  });

  it("names both when both are set", () => {
    expect(noMatchLine("sessions", "deploy", true)).toBe("No sessions match “deploy” with the current filter.");
  });
});

describe("reaching a row", () => {
  it("takes whole pages", () => {
    expect(limitToReach(0, 50)).toBe(50);
    expect(limitToReach(49, 50)).toBe(50);
    expect(limitToReach(50, 50)).toBe(100);
    expect(limitToReach(137, 50)).toBe(150);
  });
});

describe("a list window on a page", () => {
  it("renders the list in steps", () => {
    const items = ref(rows(120));
    const win = useListWindow(() => items.value, { pageSize: 50 });

    expect(win.visible).toEqual(rows(50));
    expect(win.summary).toBe("Showing 50 of 120");
    expect(win.hasMore).toBe(true);
    expect(win.nextStep).toBe(50);
    expect(win.paged).toBe(true);

    win.showMore();
    expect(win.visible).toHaveLength(100);
    expect(win.nextStep).toBe(20);

    win.showMore();
    expect(win.visible).toEqual(rows(120));
    expect(win.hasMore).toBe(false);
    expect(win.summary).toBe("Showing all 120");

    // Nothing left to add: a further step changes nothing.
    win.showMore();
    expect(win.visible).toHaveLength(120);
  });

  it("goes back to one page when the filter changes", () => {
    const items = ref(rows(300));
    const search = ref("");
    const status = ref("all");
    const win = useListWindow(() => items.value, { pageSize: 50, resetKey: () => `${status.value}|${search.value}` });

    win.showMore();
    win.showMore();
    expect(win.shown).toBe(150);

    search.value = "a";
    expect(win.shown).toBe(50);

    win.showMore();
    expect(win.shown).toBe(100);
    status.value = "failed";
    expect(win.shown).toBe(50);
  });

  it("keeps its place when the same list is loaded again", () => {
    const items = ref(rows(300));
    const search = ref("");
    const win = useListWindow(() => items.value, { pageSize: 50, resetKey: () => search.value });

    win.showMore();
    items.value = rows(320);
    expect(win.shown).toBe(100);
    expect(win.total).toBe(320);

    // Writing the same filter again is not a change.
    search.value = "";
    expect(win.shown).toBe(100);
  });

  it("follows a list that shrinks, and keeps its width for when it grows back", () => {
    const items = ref(rows(300));
    const win = useListWindow(() => items.value, { pageSize: 50 });
    win.showMore();
    win.showMore();
    win.showMore();
    expect(win.shown).toBe(200);

    items.value = rows(30);
    expect(win.visible).toEqual(rows(30));
    expect(win.hasMore).toBe(false);
    expect(win.paged).toBe(false);
    // A step with nothing held back adds nothing — not now, and not to the longer list later.
    win.showMore();

    items.value = rows(120);
    expect(win.shown).toBe(120);
    items.value = rows(400);
    expect(win.shown).toBe(200);
    win.showMore();
    expect(win.shown).toBe(250);
  });

  it("grows to a row picked somewhere else, and never shrinks for one", () => {
    const items = ref(rows(300));
    const win = useListWindow(() => items.value, { pageSize: 50 });

    win.reveal(137);
    expect(win.shown).toBe(150);
    expect(win.visible).toContain(137);

    win.reveal(3);
    expect(win.shown).toBe(150);

    // Not in the list: nothing to reach.
    win.reveal(-1);
    win.reveal(300);
    expect(win.shown).toBe(150);
  });

  it("can be put back by hand", () => {
    const items = ref(rows(300));
    const win = useListWindow(() => items.value, { pageSize: 50 });
    win.showMore();
    win.reset();
    expect(win.shown).toBe(50);
  });
});

describe("a timestamp on a page", () => {
  const AT = "2026-11-12T14:05:33.000Z";
  const UK = { locale: "en-GB", timeZone: "UTC" };

  it("is short: day, month, year, hour and minute", () => {
    expect(formatDateTime(AT, UK)).toBe("12 Nov 2026, 14:05");
  });

  it("reads the same from a string, a Date and epoch milliseconds", () => {
    expect(formatDateTime(new Date(AT), UK)).toBe("12 Nov 2026, 14:05");
    expect(formatDateTime(Date.parse(AT), UK)).toBe("12 Nov 2026, 14:05");
  });

  it("follows the locale and the time zone", () => {
    expect(formatDateTime(AT, { locale: "en-US", timeZone: "UTC" })).toMatch(/^Nov 12, 2026, 02:05\sPM$/);
    expect(formatDateTime(AT, { locale: "en-GB", timeZone: "Europe/Berlin" })).toBe("12 Nov 2026, 15:05");
  });

  it("always carries the year", () => {
    expect(formatDateTime("2024-01-03T08:00:00Z", UK)).toBe("3 Jan 2024, 08:00");
  });

  it("gives text that is not a date back as it came, and a dash for no value", () => {
    expect(formatDateTime("yesterday-ish", UK)).toBe("yesterday-ish");
    expect(formatDateTime("", UK)).toBe("—");
    expect(formatDateTime(null, UK)).toBe("—");
    expect(formatDateTime(undefined, { ...UK, fallback: "never" })).toBe("never");
    expect(formatDateTime(Number.NaN, UK)).toBe("—");
  });

  it("has the whole timestamp for a title", () => {
    expect(isoTimestamp(AT)).toBe(AT);
    expect(isoTimestamp("2026-11-12T15:05:33+01:00")).toBe(AT);
    expect(isoTimestamp(Date.parse(AT))).toBe(AT);
  });

  it("has no title for what is not a date", () => {
    expect(isoTimestamp("not a date")).toBeUndefined();
    expect(isoTimestamp(null)).toBeUndefined();
    expect(isoTimestamp("")).toBeUndefined();
  });
});
