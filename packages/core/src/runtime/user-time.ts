/**
 * The user's clock.
 *
 * The gateway runs in UTC and knows no time zone of its own, and the prompt's temporal context
 * carries the date only (it is part of the cached head, so it cannot carry the minute). A time the
 * user names ("tomorrow at nine", "every weekday at eight") is therefore taken as they say it, as
 * wall-clock time, and placed in the zone their browser reports with each message
 * (RequestContext.userTimeZone): the model never does UTC arithmetic, which it gets wrong, and is
 * never told a time of day it would have to be told every turn.
 */

/** An IANA time zone name the runtime knows, or undefined. */
export function validTimeZone(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  if (!name || name.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(name)) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return name;
  } catch {
    return undefined;
  }
}

function wallParts(timeZone: string, at: Date): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const read = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return { year: read("year"), month: read("month"), day: read("day"), hour: read("hour"), minute: read("minute"), second: read("second") };
}

/** How far the zone's clock is ahead of UTC at that instant, in minutes (Berlin in winter: 60). */
export function zoneOffsetMinutes(timeZone: string, at: Date): number {
  const wall = wallParts(timeZone, at);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return Math.round((asUtc - at.getTime()) / 60_000);
}

const WALL_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * The instant a wall-clock time ("2026-11-13T09:00") is in a zone. Undefined when the text is no
 * such time or names a date that does not exist. Across a clock change the offset is read at the
 * result, so an hour that occurs twice resolves to one of the two and one that is skipped to the
 * hour after it.
 */
export function wallTimeInZone(text: string, timeZone: string): Date | undefined {
  const match = WALL_TIME.exec(text.trim());
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1).map((part) => Number(part ?? "0")) as [number, number, number, number, number, number];
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(naive);
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return undefined;
  let instant = naive - zoneOffsetMinutes(timeZone, new Date(naive)) * 60_000;
  instant = naive - zoneOffsetMinutes(timeZone, new Date(instant)) * 60_000;
  return new Date(instant);
}

/**
 * A time as a schedule takes it: with an offset or a Z it is that instant; without, it is the
 * user's wall-clock time in their zone, or UTC where no zone is known (`assumedUtc`).
 */
export function parseUserTime(text: string, timeZone: string | undefined): { at: Date; assumedUtc: boolean } | undefined {
  const value = text.trim();
  if (!value) return undefined;
  if (HAS_OFFSET.test(value)) {
    const instant = Date.parse(value);
    return Number.isFinite(instant) ? { at: new Date(instant), assumedUtc: false } : undefined;
  }
  const at = wallTimeInZone(value, timeZone ?? "UTC");
  return at ? { at, assumedUtc: timeZone === undefined } : undefined;
}

/** "2026-11-13 09:00" as the zone's clock shows that instant. */
export function formatInZone(at: Date, timeZone: string): string {
  const wall = wallParts(timeZone, at);
  const two = (value: number): string => String(value).padStart(2, "0");
  return `${wall.year}-${two(wall.month)}-${two(wall.day)} ${two(wall.hour)}:${two(wall.minute)}`;
}
