import { describe, expect, it } from "vitest";
import { describeChain, findArithmeticMismatches } from "../agent/arithmetic-check.js";

/**
 * The arithmetic-chain detector behind orchestration.subAgentArithmeticCheck. Its target is the
 * line browser_agent wrote on 2026-10-09 (session d1ba2275): 18 terms that come to 604, stated as
 * 609. Everything that is not plainly a sum must fail open, each anchor rule by its own case.
 */
const REAL_LINE = "**Rechnung:** 17 + 9 + 1 + 38 + 22 + 0 + 19 + 30 + 5 + 0 + 4 + 2 + 95 + 180 + 36 + 44 + 29 + 73 = **609**";

describe("findArithmeticMismatches", () => {
  it("finds the real 609 line, its total wrapped in double emphasis: 18 terms that come to 604", () => {
    const found = findArithmeticMismatches(`Lagerbestand Südtal:\n\n${REAL_LINE}\n\nGesamt: 609 Stück.`);
    expect(found).toHaveLength(1);
    expect(found[0]!.terms).toHaveLength(18);
    expect(found[0]!).toMatchObject({ computed: "604", stated: "609" });
    expect(found[0]!.excerpt).toBe("17 + 9 + 1 + 38 + 22 + 0 + 19 + 30 + 5 + 0 + 4 + 2 + 95 + 180 + 36 + 44 + 29 + 73 = **609");
    expect(describeChain(found[0]!)).toBe("17 + 9 + … + 73");
  });

  it.each([
    ["a product before the chain", "3 × 19,90 € + 4,90 € = 64,60 €"],
    ["a product written with *", "3 * 19,90 + 4,90 = 64,60"],
    ["a percentage term", "200 € + 19 % = 238 €"],
    ["a division before the chain", "100 / 4 + 5 = 30"],
    ["a power before the chain", "2^3 + 1 = 9"],
    ["space-grouped thousands", "1 234 + 1 = 1 235"],
    ["an elided chain (…)", "17 + 9 + … + 73 = 609"],
    ["an elided chain (...)", "17 + 9 + ... + 73 = 609"],
    ["percent shares", "33 % + 33 % + 33 % = 100 %"],
    ["more decimals than any term", "0.1 + 0.2 = 0.30000000000000004"],
    ["a quotation", "„100 + 50 = 160“"],
    ["a bracketed chain", "(17 + 9 = 27)"],
    ["an assignment before the chain", "a = 17 + 9 = 27"],
    ["an operator after the total", "17 + 9 = 27 + 1"],
    ["a chain broken over two lines", "17 + 9\n= 27"],
    ["single emphasis before the chain", "*Summe:* 17 + 9 = 27"],
    ["a date", "Stand 2026-10-09 = 2026-10-10"],
    ["identifiers", "NW-1101 + NW-1102 = NW-2203"],
    ["a range", "1–9 + 2 = 12"],
    ["a fenced chain", "```\n17 + 9 = 27\n```"],
    ["an inline code chain", "Die Zeile `17 + 9 = 27` ist ein Beispiel."],
    ["an approximation", "17 + 9 ≈ 27"],
  ])("ignores %s", (_label, text) => {
    expect(findArithmeticMismatches(text)).toEqual([]);
  });

  it("checks a chain after a label, under both decimal conventions, and a spaced minus", () => {
    expect(findArithmeticMismatches("Summe: 17 + 9 = 27")).toEqual([expect.objectContaining({ terms: ["17", "9"], stated: "27", computed: "26" })]);
    expect(findArithmeticMismatches("Gesamt: 129,00 € + 249,00 € = 378,00 €")).toEqual([]);
    expect(findArithmeticMismatches("Bestand 1.234 + 1 = 1.235")).toEqual([]);
    expect(findArithmeticMismatches("Menge 1,5 + 1 = 2,5")).toEqual([]);
    expect(findArithmeticMismatches("Rest 17 - 9 = 8")).toEqual([]);
    expect(findArithmeticMismatches("Rest 17 - 9 = 9")).toEqual([expect.objectContaining({ computed: "8", stated: "9", operators: ["-"] })]);
    expect(findArithmeticMismatches("- 34,90 € + 27,50 € = 62,50 €")).toEqual([expect.objectContaining({ computed: "62,40" })]);
  });

  it("lets a chain follow a list or quote marker alone at the line's start, and nothing else that is not a letter, \":\" or \"|\"", () => {
    for (const lead of ["- ", "• ", "> ", "12. ", "  - ", "\t3. ", "  ", ""]) {
      expect(findArithmeticMismatches(`${lead}1 + 1 = 3`), JSON.stringify(lead)).toHaveLength(1);
    }
    for (const lead of ["x, ", "12.5 ", "1.2. ", "-- ", "a - ", "(", "2 ", ". "]) {
      expect(findArithmeticMismatches(`${lead}1 + 1 = 3`), JSON.stringify(lead)).toEqual([]);
    }
  });

  it("reads a line of 200,000 characters in linear time, whatever stands before its chains", () => {
    // The space before a chain was trimmed by a regex over the whole line before it, once per
    // chain: 150,000 spaces before one chain took seconds, and a 70 kB line of chains after a
    // comma took longer, while every sub-agent answer in shadow mode passes through here.
    const lines = [
      `${" ".repeat(150_000)}x 1 + 1 = 3`,
      `${" ".repeat(2_000)}${", 1 + 1 = 3".repeat(6_000)}`,
      `${"1".repeat(2_000)}${", 1 + 1 = 3".repeat(6_000)}`,
      "x 1 + 1 = 3 ".repeat(15_000),
    ];
    const found: number[] = [];
    for (const line of lines) {
      const started = Date.now();
      found.push(findArithmeticMismatches(line).length);
      expect(Date.now() - started, line.slice(0, 20)).toBeLessThan(300);
    }
    expect(found).toEqual([1, 0, 0, 15_000]);
  });

  it("skips texts over 200,000 characters and chains of 200 terms or more", () => {
    expect(findArithmeticMismatches(`${"x".repeat(200_001)}\nSumme: 17 + 9 = 27`)).toEqual([]);
    expect(findArithmeticMismatches(`Summe: ${Array.from({ length: 200 }, () => "1").join(" + ")} = 7`)).toEqual([]);
    expect(findArithmeticMismatches(`Summe: ${Array.from({ length: 199 }, () => "1").join(" + ")} = 7`)).toHaveLength(1);
  });
});
