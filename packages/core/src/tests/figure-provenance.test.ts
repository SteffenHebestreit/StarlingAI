import { describe, expect, it } from "vitest";
import {
  UNOBSERVED_FIGURE_MARKER,
  addFigureKeys,
  countUnobservedFigures,
  figureKey,
  maskUnobservedFigures,
} from "../agent/figure-provenance.js";
import { INCIDENT, INVENTED_FIGURES } from "./support/figure-provenance-incident.js";

/**
 * WHICH FIGURES IN A RUN'S ANSWER SOME INPUT OF THE RUN CONTAINED (E2E 2026-10-07).
 *
 * The coder's seven sandbox runs failed or printed nothing, and its answer gave "8.393" primes
 * summing to "7.597.648.268". A figure is compared by its digits alone, so the grouping a locale
 * writes and the plain form a program prints are one key; an identifier's digits are not a figure.
 */
describe("figure keys", () => {
  it("are the digits alone, whatever grouping the locale writes", () => {
    const key = figureKey("8393");
    expect(key).toBe("8393");
    for (const written of ["8.393", "8,393", "8\u202f393", "8\u00a0393", "8'393", "8\u2019393"]) {
      expect(figureKey(written)).toBe(key);
    }
    // Leading zeros go, and a digit of another script counts by its value.
    expect(figureKey("007")).toBe("7");
    expect(figureKey("\u0668\u0663\u0669\u0663")).toBe(key);
    expect(figureKey("\uff18\uff13\uff19\uff13")).toBe(key);
  });

  it("an identifier's digits and one-digit numbers are not figures", () => {
    const keys = new Set<string>();
    addFigureKeys(keys, "node v18 on x86_64, target ES2020, user eval-1bbd174404efbce9");
    expect([...keys]).toEqual([]);
    addFigureKeys(keys, "step 1 of 3, then 7");
    expect([...keys]).toEqual([]);
    expect(maskUnobservedFigures("v18 x86_64 ES2020 eval-1bbd174404efbce9, step 3", new Set())).toEqual({
      text: "v18 x86_64 ES2020 eval-1bbd174404efbce9, step 3",
      masked: 0,
    });
  });
});

describe("masking the figures no input of the run contained", () => {
  // What the coder's run received or executed: the task, every tool result as the model read it,
  // and the commands it sent to the sandbox. Not the script it wrote: write_file content is its
  // own claim, and "200001" in it proves nothing.
  const corpus = new Set<string>();
  addFigureKeys(corpus, INCIDENT.task);
  for (const call of INCIDENT.calls) {
    addFigureKeys(corpus, call.result.success ? call.result.output : `Error: ${call.result.error}`);
    if (call.tool === "shell_exec" || call.tool === "run_script") addFigureKeys(corpus, JSON.stringify(call.args));
  }

  it("masks exactly the two invented figures of the recorded reply and keeps the task's", () => {
    expect(INCIDENT.reply).toHaveLength(1016);
    const { text, masked } = maskUnobservedFigures(INCIDENT.reply, corpus);
    expect(masked).toBe(2);
    expect(countUnobservedFigures(INCIDENT.reply, corpus)).toBe(2);
    for (const figure of INVENTED_FIGURES) expect(text).not.toContain(figure);
    expect(text.split(UNOBSERVED_FIGURE_MARKER)).toHaveLength(3);
    // 100000 ≤ p ≤ 200000 is in the delegated task, however the reply groups it.
    expect(text).toContain("100.000");
    expect(text).toContain("200.000");
    expect(text).toContain("[100000, 200000]");
  });

  it("masking twice changes nothing: the marker holds no digit", () => {
    const once = maskUnobservedFigures(INCIDENT.reply, corpus).text;
    expect(maskUnobservedFigures(once, corpus)).toEqual({ text: once, masked: 0 });
    expect(countUnobservedFigures(once, corpus)).toBe(0);
  });

  it("leaves a figure some input contained, in any grouping", () => {
    const seen = new Set<string>();
    addFigureKeys(seen, "Anzahl der Primzahlen: 8392\nSumme der Primzahlen:   1255204276");
    const answer = "Es sind 8.392 Primzahlen, ihre Summe ist 1.255.204.276.";
    expect(maskUnobservedFigures(answer, seen)).toEqual({ text: answer, masked: 0 });
  });
});
