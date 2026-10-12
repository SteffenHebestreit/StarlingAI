import { describe, expect, it } from "vitest";
import { buildResearchGatheredFallback } from "../agent/evidence-recovery.js";
import { runWithRequestContext } from "../runtime/request-context.js";

/**
 * The text the last-resort terminal guard ships in place of an answer it withheld as a raw tool
 * dump. With no curated findings it used to read "Here are the researched, sourced facts for your
 * request." in German and English, followed by nothing: the E2E turn guards-list-files-on-a-file
 * shipped exactly that, the specialist's listing withheld. It now claims no facts it does not
 * show, and is written in the language the person wrote in.
 */
const inLanguage = <T>(language: string, run: () => T): T => runWithRequestContext({ userMessageLanguage: language }, run);

const FACT_CLAIMS = /sourced facts|mit Quellen belegten|researched and sourced|recherchiert und mit Quellen/i;

describe("the research-gathered fallback", () => {
  it("claims no facts when it has none, in either language, for an answer or an artifact", () => {
    for (const language of ["German", "English"]) {
      for (const artifact of [false, true]) {
        const text = inLanguage(language, () => buildResearchGatheredFallback(null, artifact));
        expect(text).not.toMatch(FACT_CLAIMS);
        expect(text).not.toContain("##");
        expect(buildResearchGatheredFallback("   ", artifact)).not.toMatch(FACT_CLAIMS);
      }
    }
    expect(inLanguage("English", () => buildResearchGatheredFallback(null, false))).toBe(
      "This run returned only raw tool output, not an answer I can show you — ask again and I'll pass it to the right specialist.",
    );
    expect(inLanguage("German", () => buildResearchGatheredFallback(null, false))).toContain("rohe Werkzeugausgaben");
  });

  it("presents curated findings under a heading in one language", () => {
    const facts = "- Founded 1987 in Westmark (https://example.test/about).\n- 146 employees (https://example.test/team).";

    const english = inLanguage("English", () => buildResearchGatheredFallback(facts, false));
    expect(english).toContain("Founded 1987 in Westmark");
    expect(english).toContain("146 employees");
    expect(english).toContain("## Researched facts & sources");
    expect(english).not.toContain("Recherchierte");

    const german = inLanguage("German", () => buildResearchGatheredFallback(facts, true));
    expect(german).toContain("146 employees");
    expect(german).toContain("## Recherchierte Fakten & Quellen");
    expect(german).not.toContain("Researched facts");
  });
});
