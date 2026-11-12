/**
 * One way to write a point in time on the management pages.
 *
 * Each page called `toLocaleString()` with its own options, or none: the same moment read
 * "11/12/2026, 2:05:33 PM" on one page and "Nov 12, 02:05 PM" — no year — on the next.
 *
 *   <time :datetime="isoTimestamp(job.startedAt)" :title="isoTimestamp(job.startedAt)">
 *     {{ formatDateTime(job.startedAt) }}
 *   </time>
 *
 * `formatDateTime` is short and in the browser's locale ("12 Nov 2026, 14:05" in en-GB);
 * `isoTimestamp` is the whole of it, seconds and zone included, for a title.
 */

export type TimeInput = string | number | Date | null | undefined;

export interface FormatDateOptions {
  /** Defaults to the browser's. */
  locale?: string;
  /** Defaults to the browser's. */
  timeZone?: string;
  /** What stands in for no value at all. */
  fallback?: string;
}

function toDate(value: TimeInput): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// A list page formats a date per row; building a formatter each time is the slow part.
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(locale: string | undefined, timeZone: string | undefined): Intl.DateTimeFormat {
  const key = `${locale ?? ""}|${timeZone ?? ""}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      ...(timeZone ? { timeZone } : {}),
    });
    formatters.set(key, formatter);
  }
  return formatter;
}

/**
 * "12 Nov 2026, 14:05". Text that is not a date is given back as it came, so an odd value from
 * the gateway stays readable; no value at all is a dash.
 */
export function formatDateTime(value: TimeInput, options: FormatDateOptions = {}): string {
  const date = toDate(value);
  if (date) return formatterFor(options.locale, options.timeZone).format(date);
  if (typeof value === "string" && value.trim()) return value;
  return options.fallback ?? "—";
}

/** The full ISO timestamp for a title or a `datetime`; undefined (no attribute) when not a date. */
export function isoTimestamp(value: TimeInput): string | undefined {
  return toDate(value)?.toISOString();
}
