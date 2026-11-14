import { beforeAll, describe, expect, it } from "vitest";
import { correctWeekdays } from "../agent/weekday-check.js";
import { warmTextLanguageDetector } from "../agent/text-language.js";

/**
 * A WEEKDAY NAMED BESIDE A DATE IS CHECKED AGAINST THE CALENDAR (agent/weekday-check.ts).
 *
 * Session 5b77edf9: on Friday, 13 November 2026 a specialist's answer said "Am Donnerstag, den
 * 13. November", and the sentence reached the user word for word.
 */
const FRIDAY = new Date("2026-11-13T12:41:00Z");
const BERLIN = "Europe/Berlin";

describe("correctWeekdays", () => {
  beforeAll(async () => { await warmTextLanguageDetector(); });

  it("puts the weekday of today's date right, in the language of the text", () => {
    const text = "### Kurz zusammengefasst\nAm Donnerstag, den 13. November, wird es am Nachmittag teilweise sonnig, aber windig. Die Temperatur liegt bei 8 °C.";
    const checked = correctWeekdays(text, FRIDAY, BERLIN);

    expect(checked.text).toContain("Am Freitag, den 13. November, wird es");
    expect(checked.text).not.toContain("Donnerstag");
    expect(checked.corrections).toEqual([{ said: "Donnerstag", correct: "Freitag", date: "2026-11-13" }]);
  });

  it("leaves a weekday that is right exactly as it was", () => {
    const text = "Am Freitag, den 13. November, wird es am Nachmittag sonnig. Am Samstag, 14.11.2026, regnet es.";
    const checked = correctWeekdays(text, FRIDAY, BERLIN);

    expect(checked.text).toBe(text);
    expect(checked.corrections).toEqual([]);
  });

  it("checks a date that names its year against that year, whatever today is", () => {
    // 13 November 2025 was a Thursday; 24 December 2027 is a Friday.
    expect(correctWeekdays("Die Sitzung war am Donnerstag, den 13. November 2025, im Rathaus.", FRIDAY, BERLIN).corrections).toEqual([]);
    const checked = correctWeekdays("Heiligabend fällt auf Montag, den 24. Dezember 2027, und die Läden schließen früh.", FRIDAY, BERLIN);
    expect(checked.text).toContain("auf Freitag, den 24. Dezember 2027,");
    expect(checked.corrections).toEqual([{ said: "Montag", correct: "Freitag", date: "2027-12-24" }]);
  });

  it("leaves a date with no year alone unless it is today's: it may be about any year", () => {
    const text = "Das Konzert findet am Samstag, den 21. November, in der Stadthalle statt und beginnt am Abend.";
    expect(correctWeekdays(text, FRIDAY, BERLIN)).toEqual({ text, corrections: [] });
  });

  it("reads the English forms: month first, day first, and with the year", () => {
    expect(correctWeekdays("The forecast for Thursday, November 13 is partly sunny with gusts from the west.", FRIDAY, BERLIN).text)
      .toBe("The forecast for Friday, November 13 is partly sunny with gusts from the west.");
    expect(correctWeekdays("We meet on Thursday, the 13th of November, at the usual place in town.", FRIDAY, BERLIN).text)
      .toContain("on Friday, the 13th of November,");
    expect(correctWeekdays("The deadline is Monday, March 3rd, 2027 and it will not move again.", FRIDAY, BERLIN).text)
      .toContain("is Wednesday, March 3rd, 2027 and");
  });

  it("reads a date written in figures, day before month", () => {
    const checked = correctWeekdays("Der Termin ist am Mittwoch, 13.11.2026 um 15 Uhr im Besprechungsraum.", FRIDAY, BERLIN);
    expect(checked.text).toContain("am Freitag, 13.11.2026 um 15 Uhr");
    // No year, today's date.
    expect(correctWeekdays("Heute, Mittwoch, den 13.11., ist die Abgabe der Unterlagen fällig.", FRIDAY, BERLIN).text).toContain("Freitag, den 13.11.,");
    // A date that does not exist is nobody's weekday.
    expect(correctWeekdays("Am Mittwoch, 31.02.2026 ist nichts geplant und es bleibt dabei.", FRIDAY, BERLIN).corrections).toEqual([]);
  });

  it("keeps the case the text wrote the weekday in, in a language that writes it small", () => {
    const checked = correctWeekdays("La réunion aura lieu jeudi 13 novembre 2026 dans la grande salle de la mairie.", FRIDAY, "Europe/Paris");
    expect(checked.text).toContain("lieu vendredi 13 novembre 2026 dans");
    expect(checked.corrections[0]).toMatchObject({ said: "jeudi", correct: "vendredi" });
  });

  it("takes today from the user's time zone", () => {
    // 23:30 UTC on the 13th is already the 14th in Berlin, a Saturday.
    const lateEvening = new Date("2026-11-13T23:30:00Z");
    const text = "Heute, am Freitag, den 14. November, bleibt es trocken und es wird etwas milder als gestern.";
    expect(correctWeekdays(text, lateEvening, BERLIN).text).toContain("am Samstag, den 14. November,");
    // In UTC it is still the 13th: the 14th names no year and is not today's, so it is left alone.
    expect(correctWeekdays(text, lateEvening, "UTC").corrections).toEqual([]);
  });

  it("leaves what is inside a code fence as it was, and corrects around it", () => {
    const text = "Laut Protokoll:\n```\nlog: Donnerstag, den 13. November 2026 — backup ok\n```\nDas war am Donnerstag, den 13. November 2026, kurz nach Mitternacht.";
    const checked = correctWeekdays(text, FRIDAY, BERLIN);

    expect(checked.text).toContain("log: Donnerstag, den 13. November 2026 — backup ok");
    expect(checked.text).toContain("Das war am Freitag, den 13. November 2026,");
    expect(checked.corrections).toHaveLength(1);
  });

  it("does not take a weekday further off for the date's own", () => {
    // "Montag" stands too far from the date to be its weekday; "Freitag" is the date's, and right.
    const text = "Von Montag an gilt der neue Plan, und er endet am Freitag, den 13. November 2026, mit der Abnahme.";
    expect(correctWeekdays(text, FRIDAY, BERLIN).corrections).toEqual([]);
  });

  it("has nothing to do for a text with no date in it", () => {
    for (const text of ["", "Am Donnerstag ist Markt.", "No digits here at all, only words about Thursday."]) {
      expect(correctWeekdays(text, FRIDAY, BERLIN)).toEqual({ text, corrections: [] });
    }
  });
});
