import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isTimeZone, nextRunAt, parseTimeOfDay, releaseNightLock, takeNightLock } from "../harness-lab/timer.js";

/**
 * The lab's nightly timer inside the stack: when the next night starts, in a time zone and across
 * its DST days, and the lock that keeps two nights from running at once.
 */

const dirs: string[] = [];
const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();

describe("the time of the next night", () => {
  it("reads a time of day and nothing else", () => {
    expect(parseTimeOfDay("02:30")).toEqual({ hour: 2, minute: 30 });
    expect(parseTimeOfDay("2:05")).toEqual({ hour: 2, minute: 5 });
    for (const raw of ["24:00", "02:60", "0230", "2.30", "", "02:30:00"]) expect(parseTimeOfDay(raw), raw).toBeNull();
    expect(isTimeZone("Europe/Berlin")).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
  });

  it("is later today before the time, tomorrow after it", () => {
    const time = { hour: 2, minute: 30 };
    expect(iso(nextRunAt(at("2026-10-27T01:00:00Z"), time, "UTC"))).toBe("2026-10-27T02:30:00.000Z");
    expect(iso(nextRunAt(at("2026-10-27T02:30:00Z"), time, "UTC"))).toBe("2026-10-28T02:30:00.000Z");
    expect(iso(nextRunAt(at("2026-12-31T23:59:00Z"), time, "UTC"))).toBe("2027-01-01T02:30:00.000Z");
  });

  it("follows a clock in the zone, not the process's", () => {
    const time = { hour: 2, minute: 30 };
    // 17:05 in Berlin in winter (CET, UTC+1): the night after starts 01:30 UTC.
    expect(iso(nextRunAt(at("2026-10-27T16:05:00Z"), time, "Europe/Berlin"))).toBe("2026-10-28T01:30:00.000Z");
    // In summer (CEST, UTC+2) the same clock time is 00:30 UTC.
    expect(iso(nextRunAt(at("2026-07-01T12:00:00Z"), time, "Europe/Berlin"))).toBe("2026-07-02T00:30:00.000Z");
    // 00:10 local is still the same night, though UTC is a day behind.
    expect(iso(nextRunAt(at("2026-07-01T22:10:00Z"), time, "Europe/Berlin"))).toBe("2026-07-02T00:30:00.000Z");
  });

  it("starts once on the DST days: a skipped time an hour later, a repeated one once", () => {
    const time = { hour: 2, minute: 30 };
    // 2027-03-28 02:00 CET jumps to 03:00 CEST: 02:30 never shows, the night starts at 03:30 CEST.
    expect(iso(nextRunAt(at("2027-03-27T12:00:00Z"), time, "Europe/Berlin"))).toBe("2027-03-28T01:30:00.000Z");
    // 2026-10-25 03:00 CEST goes back to 02:00 CET: 02:30 shows twice, the night starts at the second (CET).
    const autumn = nextRunAt(at("2026-10-24T12:00:00Z"), time, "Europe/Berlin");
    expect(iso(autumn)).toBe("2026-10-25T01:30:00.000Z");
    // And the next one is the following day's, not the repeat of the same night.
    expect(iso(nextRunAt(autumn, time, "Europe/Berlin"))).toBe("2026-10-26T01:30:00.000Z");
  });
});

describe("the night lock", () => {
  const me = { pid: 4242, host: "lab-container" };
  const take = (file: string, over: Partial<Parameters<typeof takeNightLock>[1]> = {}) =>
    takeNightLock(file, { ...me, now: at("2026-10-27T02:30:00Z"), staleMs: 5 * 3_600_000, alive: () => true, ...over });
  const holdBy = (file: string, pid: number, host: string, startedAt: string) =>
    writeFileSync(file, JSON.stringify({ pid, host, startedAt }), "utf8");

  it("is taken when free, and released only by the one who took it", () => {
    const file = join(tmp("lab-lock-"), "timer.lock");
    expect(take(file)).toEqual({ taken: true });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ pid: 4242, host: "lab-container", startedAt: "2026-10-27T02:30:00.000Z" });
    releaseNightLock(file, { pid: 1, host: "lab-container" });
    expect(existsSync(file)).toBe(true);
    releaseNightLock(file, me);
    expect(existsSync(file)).toBe(false);
  });

  it("is not taken while another night runs, here or in another container", () => {
    const file = join(tmp("lab-lock-"), "timer.lock");
    holdBy(file, 77, "lab-container", "2026-10-27T01:00:00.000Z");
    const here = take(file);
    expect(here).toEqual({ taken: false, holder: { pid: 77, host: "lab-container", startedAt: "2026-10-27T01:00:00.000Z" } });
    holdBy(file, 77, "gateway-container", "2026-10-27T01:00:00.000Z");
    // Another container's process cannot be checked: dead or not, a fresh lock holds.
    expect(take(file, { alive: () => false }).taken).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf8")).pid).toBe(77);
  });

  it("is taken over when stale: too old, its process gone here, or our own pid left by an earlier process", () => {
    const file = join(tmp("lab-lock-"), "timer.lock");
    holdBy(file, 77, "gateway-container", "2026-10-26T20:00:00.000Z");
    expect(take(file)).toEqual({ taken: true });
    holdBy(file, 77, "lab-container", "2026-10-27T02:00:00.000Z");
    expect(take(file, { alive: (pid) => pid !== 77 })).toEqual({ taken: true });
    holdBy(file, 4242, "lab-container", "2026-10-27T02:00:00.000Z");
    expect(take(file)).toEqual({ taken: true });
    expect(JSON.parse(readFileSync(file, "utf8")).startedAt).toBe("2026-10-27T02:30:00.000Z");
  });

  it("goes by the file's age when the lock cannot be read", () => {
    const file = join(tmp("lab-lock-"), "timer.lock");
    writeFileSync(file, "{\"pid\":", "utf8");
    expect(take(file, { now: Date.now() }).taken).toBe(false);
    const old = (Date.now() - 6 * 3_600_000) / 1000;
    utimesSync(file, old, old);
    expect(take(file, { now: Date.now() })).toEqual({ taken: true });
  });
});

describe("harness-lab-timer --once", () => {
  const CORE = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const TSX_CLI = createRequire(import.meta.url).resolve("tsx/cli");

  it("skips the night with exit 5 while another one holds the lock, and starts no lab command", () => {
    const workspace = tmp("lab-timer-ws-");
    const root = join(workspace, ".starlingai", "harness-lab", "nightly");
    mkdirSync(root, { recursive: true });
    // Held by this test process, on this host, just now: alive and fresh.
    writeFileSync(join(root, "timer.lock"), JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }), "utf8");
    const logFile = join(workspace, "nightly.log");
    const run = spawnSync(process.execPath, [TSX_CLI, join(CORE, "src", "scripts", "harness-lab-timer.ts"), "--once", "--workspace", workspace, "--log", logFile], { encoding: "utf8", timeout: 60_000 });
    expect(run.status, run.stderr).toBe(5);
    expect(run.stdout).toMatch(new RegExp(`another night still runs \\(pid ${process.pid} on `));
    expect(run.stdout).not.toMatch(/harness-lab (harvest|nightly)/);
    expect(readFileSync(logFile, "utf8")).toBe(run.stdout);
    expect(existsSync(join(root, "timer.lock"))).toBe(true);
  });

  it("refuses a time zone it does not know with exit 2", () => {
    const run = spawnSync(process.execPath, [TSX_CLI, join(CORE, "src", "scripts", "harness-lab-timer.ts"), "--tz", "Mars/Olympus"], { encoding: "utf8", timeout: 60_000 });
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/--tz takes a time zone/);
  });
});
