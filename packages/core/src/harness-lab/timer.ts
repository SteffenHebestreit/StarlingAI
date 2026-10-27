/**
 * The harness lab's nightly timer inside the stack (harness lab P4): it needs no timer on the host
 * and nobody logged on. The `harness-lab` compose service runs scripts/harness-lab-timer.ts, a
 * process in a container of its own, which sleeps until the set time of day and then runs one night.
 * A lock in the nightly root keeps two nights from running at once, whoever started them: the
 * service, `--once` by hand, or the host wrapper (scripts/harness-lab-nightly.mjs).
 */
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";

export interface TimeOfDay {
  hour: number;
  minute: number;
}

/** "02:30" -> { hour: 2, minute: 30 }; null for anything that is not a time of day. */
export function parseTimeOfDay(raw: string): TimeOfDay | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour < 24 && minute < 60 ? { hour, minute } : null;
}

/** Whether `timeZone` is an IANA zone this runtime knows. */
export function isTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** What a clock in `timeZone` shows at `at`, written as if that were UTC (ms). */
function wallClock(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const field = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(field("year"), field("month") - 1, field("day"), field("hour"), field("minute"), field("second"));
}

/**
 * The instant a clock in `timeZone` shows `wall`. The second pass settles the offset on DST days: a
 * time the spring change skips comes an hour later, and one the autumn change repeats comes once.
 */
function instantOf(wall: number, timeZone: string): number {
  let at = wall - (wallClock(wall, timeZone) - wall);
  at = wall - (wallClock(at, timeZone) - at);
  return at;
}

/** The first instant after `now` at which a clock in `timeZone` shows `time`. */
export function nextRunAt(now: number, time: TimeOfDay, timeZone: string): number {
  const today = new Date(wallClock(now, timeZone));
  for (let day = 0; ; day += 1) {
    const wall = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + day, time.hour, time.minute);
    const at = instantOf(wall, timeZone);
    if (at > now) return at;
  }
}

/** Who runs a night: written into the lock file. */
export interface NightLock {
  pid: number;
  host: string;
  startedAt: string;
}

export interface LockOwner {
  pid: number;
  host: string;
}

export interface TakeLockOptions extends LockOwner {
  now: number;
  /** A lock older than this is left over from a night that never released it. */
  staleMs: number;
  /** Whether a process of this host still runs. */
  alive: (pid: number) => boolean;
}

function readLock(file: string): NightLock | null {
  try {
    const lock = JSON.parse(readFileSync(file, "utf8")) as Partial<NightLock>;
    return typeof lock.pid === "number" && typeof lock.host === "string" && typeof lock.startedAt === "string" ? (lock as NightLock) : null;
  } catch {
    return null;
  }
}

/**
 * Takes the lock file for one night. A lock someone else holds is taken over only when it is stale:
 * older than `staleMs`, or held by a process of this host that no longer runs. A process of another
 * host (another container) cannot be checked, so only its age counts there.
 */
export function takeNightLock(file: string, opts: TakeLockOptions): { taken: true } | { taken: false; holder: NightLock | null } {
  let holder: NightLock | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(file, "wx");
      try {
        writeSync(fd, JSON.stringify({ pid: opts.pid, host: opts.host, startedAt: new Date(opts.now).toISOString() } satisfies NightLock));
      } finally {
        closeSync(fd);
      }
      return { taken: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    holder = readLock(file);
    let startedAt: number;
    try {
      // A lock that cannot be read was cut off while being written: its file's age stands in.
      startedAt = holder ? Date.parse(holder.startedAt) : statSync(file).mtimeMs;
    } catch {
      continue; // released in the meantime
    }
    // On this host a lock under our own pid is one an earlier process left (a restarted container's
    // PID 1 is the timer again): it is not held, whatever `alive` says.
    const leftOnThisHost = holder !== null && holder.host === opts.host && (holder.pid === opts.pid || !opts.alive(holder.pid));
    const stale = !(opts.now - startedAt <= opts.staleMs) || leftOnThisHost;
    if (!stale) return { taken: false, holder };
    try {
      unlinkSync(file);
    } catch {
      // Another process took it over first; the next attempt finds out who.
    }
  }
  return { taken: false, holder };
}

/** Removes the lock file, when it is still the one `owner` took. */
export function releaseNightLock(file: string, owner: LockOwner): void {
  const lock = readLock(file);
  if (!lock || lock.pid !== owner.pid || lock.host !== owner.host) return;
  try {
    unlinkSync(file);
  } catch {
    // Already gone.
  }
}

/** process.kill(pid, 0) as a question: EPERM still means the process runs. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
