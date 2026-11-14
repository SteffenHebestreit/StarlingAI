/**
 * A weekday named beside a date, checked against the calendar.
 *
 * A model asked what day a date falls on works it out in its head, and gets it wrong often enough
 * to matter: in session 5b77edf9 a specialist's answer said "Am Donnerstag, den 13. November" on
 * Friday, 13 November 2026, with the date and its weekday in its own prompt, and the sentence was
 * relayed to the user word for word. Which day of the week a date is, is not a matter of opinion,
 * so a specialist's final answer is read for such pairs and the weekday is put right.
 *
 * Only where the date is certain: it names its year, or it is today's date (in the user's time
 * zone) and names none. "Thursday, 13 November" with no year on any other day may be about any
 * year and is left alone. Abbreviated weekdays, and anything inside a code fence, are left alone
 * too.
 *
 * No word lists: the names of the days and months come from the runtime's own calendar data
 * (Intl), for English and for the language the text is written in (agent/text-language.ts).
 */
import { detectTextLanguage } from "./text-language.js";

export interface WeekdayCorrection {
  /** The weekday as the text had it. */
  said: string;
  /** The weekday the date falls on, in the same language. */
  correct: string;
  /** The date, ISO (YYYY-MM-DD). */
  date: string;
}

export interface WeekdayCheck {
  text: string;
  corrections: WeekdayCorrection[];
}

interface CalendarNames {
  /** Sunday first, as Date#getUTCDay counts. */
  weekdays: string[];
  /** Per month, the forms a date is written with: on its own and inside a date ("listopad", "listopada"). */
  months: string[][];
}

const calendarNames = new Map<string, CalendarNames | null>();
const lower = (value: string): string => value.toLocaleLowerCase();
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function namesFor(locale: string): CalendarNames | null {
  if (calendarNames.has(locale)) return calendarNames.get(locale) ?? null;
  let names: CalendarNames | null;
  try {
    const inDate = new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
    const alone = new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" });
    const part = (date: Date, type: string): string => inDate.formatToParts(date).find((entry) => entry.type === type)?.value ?? "";
    // 1 January 2023 was a Sunday.
    const weekdays = Array.from({ length: 7 }, (_, day) => part(new Date(Date.UTC(2023, 0, 1 + day)), "weekday"));
    const months = Array.from({ length: 12 }, (_, month) => {
      const date = new Date(Date.UTC(2023, month, 15));
      return [...new Set([part(date, "month"), alone.format(date)].filter(Boolean))];
    });
    const usable = weekdays.every((name) => /^\p{L}+$/u.test(name))
      && new Set(weekdays.map(lower)).size === 7
      && months.every((forms) => forms.length > 0 && forms.every((name) => /^\p{L}[\p{L}.]*$/u.test(name)));
    names = usable ? { weekdays, months } : null;
  } catch {
    names = null;
  }
  calendarNames.set(locale, names);
  return names;
}

function todayIn(now: Date, timeZone: string | undefined): { year: number; month: number; day: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { ...(timeZone ? { timeZone } : {}), year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
    const value = (type: string): number => Number(parts.find((entry) => entry.type === type)?.value);
    return { year: value("year"), month: value("month"), day: value("day") };
  } catch {
    return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, day: now.getUTCDate() };
  }
}

/** The names as one alternation, longest first, so "Donnerstag" is not read as a shorter name's start. */
function oneOf(names: readonly string[]): string {
  return [...new Set(names.map(lower))].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|");
}

function correctIn(text: string, names: CalendarNames, today: { year: number; month: number; day: number }, corrections: WeekdayCorrection[]): string {
  const weekday = oneOf(names.weekdays);
  const month = oneOf(names.months.flat());
  const start = "(?<![\\p{L}\\p{N}])";
  const end = "(?![\\p{L}])";
  // "Donnerstag, den 13. November [2026]", "jeudi 13 novembre", "Thursday, the 13th of November".
  const dayFirst = new RegExp(
    `${start}(?<wd>${weekday})${end},?\\s+(?:\\p{L}{1,3}\\s+)?(?<day>\\d{1,2})(?!\\d)(?:\\.|st|nd|rd|th)?\\s+(?:\\p{L}{1,2}\\s+)?(?<mo>${month})${end}(?:,?\\s+(?<year>\\d{4})(?!\\d))?`,
    "giu",
  );
  // "Thursday, November 13[th][, 2026]".
  const monthFirst = new RegExp(
    `${start}(?<wd>${weekday})${end},?\\s+(?<mo>${month})${end}\\s+(?<day>\\d{1,2})(?:st|nd|rd|th)?(?!\\d)(?:,?\\s+(?<year>\\d{4})(?!\\d))?`,
    "giu",
  );
  // "Donnerstag, 13.11.[2026]": dots mean day before month.
  const numeric = new RegExp(
    `${start}(?<wd>${weekday})${end},?\\s+(?:\\p{L}{1,3}\\s+)?(?<day>\\d{1,2})\\.(?<mon>\\d{1,2})\\.(?<year>\\d{4})?(?!\\d)`,
    "giu",
  );
  const monthNumber = (name: string): number => names.months.findIndex((forms) => forms.some((form) => lower(form) === lower(name))) + 1;
  const fix = (match: string, groups: Record<string, string | undefined>): string => {
    const said = groups["wd"] ?? "";
    const day = Number(groups["day"]);
    const monthOfYear = groups["mon"] !== undefined ? Number(groups["mon"]) : monthNumber(groups["mo"] ?? "");
    if (!(monthOfYear >= 1 && monthOfYear <= 12) || !(day >= 1 && day <= 31)) return match;
    // A date that names no year is today's or nobody's: any other could be about any year.
    const year = groups["year"] !== undefined
      ? Number(groups["year"])
      : (monthOfYear === today.month && day === today.day ? today.year : undefined);
    if (year === undefined || year < 1900 || year > 2200) return match;
    const date = new Date(Date.UTC(year, monthOfYear - 1, day));
    if (date.getUTCMonth() !== monthOfYear - 1 || date.getUTCDate() !== day) return match;
    const saidIndex = names.weekdays.findIndex((name) => lower(name) === lower(said));
    if (saidIndex < 0 || saidIndex === date.getUTCDay()) return match;
    const name = names.weekdays[date.getUTCDay()]!;
    const correct = said[0] === said[0]!.toLocaleUpperCase() ? name[0]!.toLocaleUpperCase() + name.slice(1) : lower(name);
    corrections.push({ said, correct, date: date.toISOString().slice(0, 10) });
    return correct + match.slice(said.length);
  };
  let out = text;
  for (const pattern of [dayFirst, monthFirst, numeric]) {
    out = out.replace(pattern, (...args: unknown[]) => fix(args[0] as string, (args.at(-1) ?? {}) as Record<string, string | undefined>));
  }
  return out;
}

/**
 * `text` with every weekday that contradicts the date beside it put right, and what was changed.
 * `now` and `timeZone` say which date is today's.
 */
export function correctWeekdays(text: string, now: Date = new Date(), timeZone?: string): WeekdayCheck {
  if (!text || text.length > 400_000 || !/\d/.test(text)) return { text, corrections: [] };
  const locales = new Set<string>(["en"]);
  const written = detectTextLanguage(text)?.code;
  if (written) locales.add(written);
  const today = todayIn(now, timeZone);
  const corrections: WeekdayCorrection[] = [];
  // Not inside a code fence: a log or a fixture quotes its dates as they were.
  const parts = text.split(/(```[\s\S]*?```)/);
  for (let index = 0; index < parts.length; index += 2) {
    for (const locale of locales) {
      const names = namesFor(locale);
      if (names) parts[index] = correctIn(parts[index]!, names, today, corrections);
    }
  }
  return corrections.length > 0 ? { text: parts.join(""), corrections } : { text, corrections };
}
