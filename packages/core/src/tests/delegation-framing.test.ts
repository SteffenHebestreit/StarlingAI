/**
 * The instruction wrapper a delegated task opens with is cut before routing; a colon that is no
 * label is not. Taking the first colon of all cut a web address's scheme off with everything
 * before it, and the routing query lost the step's subject (E2E 2026-10-12).
 */
import { describe, expect, it } from "vitest";
import { stripDelegationFraming } from "../tools/agent-routing.js";

describe("stripDelegationFraming", () => {
  it("cuts a wrapper whose colon is a label", () => {
    expect(stripDelegationFraming("Answer the user's question: which battery tools does the shop sell this month"))
      .toBe("which battery tools does the shop sell this month");
  });

  it("keeps a task whose first colon is a web address's scheme", () => {
    const task = "Rufe die Website http://www.nordlicht-werkzeuge.test/ auf und suche nach Gründungsjahr und Mitarbeiterzahl";
    expect(stripDelegationFraming(task)).toBe(task);
  });

  it("cuts the label and keeps the address when both are there", () => {
    expect(stripDelegationFraming("Investigate whether: the page https://example.test/docs lists the reset procedure and error codes"))
      .toBe("the page https://example.test/docs lists the reset procedure and error codes");
  });

  it("keeps a time or a drive letter", () => {
    const time = "Plan the meeting at 12:30 with the supplier and send the agenda to everyone involved";
    expect(stripDelegationFraming(time)).toBe(time);
    const drive = "Read C:\data\report.xlsx and chart the monthly totals per region as bars please";
    expect(stripDelegationFraming(drive)).toBe(drive);
  });
});
