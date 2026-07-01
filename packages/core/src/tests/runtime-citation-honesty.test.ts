import { describe, expect, it } from "vitest";
import {
  answerPresentsSourceCitations,
  stripFabricatedCitations,
  prependUnverifiedSourceCaveat,
} from "../agent/runtime.js";
import {
  userMessageCarriesActionableUrl,
  prependUrlNotFetchedCaveat,
} from "../agent/citation-honesty.js";

// The audited fabricated answer (session 1303e254, condensed): invented 404 links produced with
// ZERO real retrieval. The harmful, language-free signal is the clickable URL, not any phrase.
const FABRICATED = [
  "## Wärmepumpen-Preisvergleich 2026",
  "",
  "| Modell | Preis | Quelle |",
  "| --- | --- | --- |",
  "| Viessmann Vitocal 250-A | 14.500 € | [Heizung.de](https://www.heizung.de/viessmann-vitocal-250a) |",
  "| Daikin Altherma 3 | 13.200 € | [Daikin](https://www.daikin.de/altherma-3-preis) |",
  "",
  "Förderung: siehe https://www.bafa.de/foerderung-2026 für aktuelle Sätze.",
  "",
  "Die Zahlen sind auf Basis von 7 aktuellen Online-Quellen verifiziert.",
].join("\n");

describe("answerPresentsSourceCitations (structural, language-free)", () => {
  it("fires on a markdown link to an http(s) URL", () => {
    expect(answerPresentsSourceCitations("See [Heizung.de](https://www.heizung.de/x) for the price.")).toBe(true);
  });

  it("fires on a bare http(s) URL", () => {
    expect(answerPresentsSourceCitations("Details at https://www.bafa.de/foerderung-2026 today.")).toBe(true);
  });

  it("fires on a URL regardless of language (FR/ES answers with invented links)", () => {
    expect(answerPresentsSourceCitations("Prix vérifiés selon https://www.exemple.fr/pompe-a-chaleur.")).toBe(true);
    expect(answerPresentsSourceCitations("Según [la fuente](https://ejemplo.es/precio), cuesta 14.000 €.")).toBe(true);
  });

  // De-lexicalized (2026-06-30): we no longer phrase-match "verifiziert"/"verified". A verification
  // CLAIM with no URL is not flagged — it has no clickable 404 to strip, and the honest caveat
  // (when the guard fires for other reasons) corrects the framing. This kills the old false-fire
  // on an honest answer that merely names a source in prose.
  it("does NOT fire on a verification claim with no URL (no phrase matching, any language)", () => {
    expect(answerPresentsSourceCitations("Die Zahlen sind auf Basis von 7 Online-Quellen verifiziert.")).toBe(false);
    expect(answerPresentsSourceCitations("These figures were verified against current sources.")).toBe(false);
    expect(answerPresentsSourceCitations("Laut den Datenblättern liegt der Preis bei 14.000 €.")).toBe(false);
  });

  it("does NOT fire on a plain answer with no citations", () => {
    expect(answerPresentsSourceCitations("A heat pump typically costs more upfront than a gas boiler.")).toBe(false);
  });
});

describe("stripFabricatedCitations (structural, language-free)", () => {
  it("converts a markdown link to its plain label and removes bare URLs", () => {
    const out = stripFabricatedCitations("See [Heizung.de](https://www.heizung.de/x) and https://www.bafa.de/y.");
    expect(out).not.toMatch(/https?:\/\//); // no clickable 404 survives
    expect(out).toMatch(/Heizung\.de/); // the readable label is preserved
  });

  it("strips every fabricated URL from the audited answer but keeps its substance", () => {
    const out = stripFabricatedCitations(FABRICATED);
    expect(out).not.toMatch(/https?:\/\//); // zero surviving links — no 404 ever ships
    expect(out).toMatch(/Viessmann Vitocal 250-A/); // the data table survives
    expect(out).toMatch(/14\.500 €/);
    expect(out.trim().length).toBeGreaterThan(40); // never empties the answer
  });

  it("strips fabricated links in any language (no phrase neutralization)", () => {
    const fr = "Prix vérifiés d'après 7 sources : [source](https://exemple.fr/x) et https://exemple.fr/y.";
    const out = stripFabricatedCitations(fr);
    expect(out).not.toMatch(/https?:\/\//);
    expect(out).toMatch(/Prix vérifiés/); // body (incl. the claim) is untouched; the caveat corrects framing
  });

  it("is a no-op on an answer that has no fabricated URLs", () => {
    const clean = "A heat pump typically costs more upfront than a gas boiler.";
    expect(stripFabricatedCitations(clean)).toBe(clean);
  });
});

describe("strip + caveat pipeline (what the guard ships)", () => {
  it("produces a URL-free, caveated answer", () => {
    const shipped = prependUnverifiedSourceCaveat(stripFabricatedCitations(FABRICATED), "Wärmepumpen-Preise 2026?");
    expect(shipped).not.toMatch(/https?:\/\//); // no fabricated link
    expect(shipped).toMatch(/Ungeprüft|NICHT mit aktuellen Online-Quellen/); // honest caveat on top corrects the framing
    expect(shipped).toMatch(/Viessmann/); // substance retained
  });
});

// URL-not-fetched fabrication guard (session 29796f86): the user handed over a freelancermap URL,
// the model wrote a full "Ich habe die Ausschreibung geladen" job posting, and made ZERO web
// fetch / delegation calls — pure fabrication that the citation guard missed (the answer carried
// no URL citation to strip). Structural, language-free: user-URL + no fetch + substantial answer.
describe("userMessageCarriesActionableUrl (structural, language-free)", () => {
  it("fires when the user's message contains an http(s) URL", () => {
    expect(userMessageCarriesActionableUrl("hier ist das projekt https://www.freelancermap.de/projekt/x")).toBe(true);
    expect(userMessageCarriesActionableUrl("check http://example.com please")).toBe(true);
  });
  it("does NOT fire on a message with no URL", () => {
    expect(userMessageCarriesActionableUrl("hab ich die passenden Fähigkeiten?")).toBe(false);
    expect(userMessageCarriesActionableUrl("")).toBe(false);
  });
});

describe("prependUrlNotFetchedCaveat", () => {
  it("prepends a prominent NOT-fetched warning on top and never empties the answer", () => {
    const fabricated = "## Projektübersicht\nRolle: AI/Data Science Engineer\nAnforderungen: 3+ Jahre Erfahrung mit LLMs, Fine-Tuning, vLLM.";
    const out = prependUrlNotFetchedCaveat(fabricated);
    expect(out).toMatch(/NICHT abgerufen/);       // German warning
    expect(out).toMatch(/NOT fetched/i);          // English warning
    expect(out).toMatch(/Projektübersicht/);      // body retained
    expect(out.indexOf("NICHT abgerufen")).toBeLessThan(out.indexOf("Projektübersicht")); // caveat is on top
  });

  it("leads with the user's language (English message → English-primary banner)", () => {
    const body = "The role is an AI/Data Science Engineer position requiring several years of LLM experience. " + "x".repeat(400);
    const out = prependUrlNotFetchedCaveat(body, "Read this page for me: https://example.com/job and summarize it");
    // English message → English line is primary (before the parenthesized German translation).
    expect(out.indexOf("NOT fetched this turn")).toBeLessThan(out.indexOf("NICHT abgerufen"));
    expect(out).toMatch(/The role is an AI\/Data Science Engineer/); // body retained
  });

  it("does not stack a second banner when one is already present (dedupe)", () => {
    const already = prependUrlNotFetchedCaveat("Some substantial page summary. " + "y".repeat(400), "en message");
    const out = prependUrlNotFetchedCaveat(already, "en message");
    expect(out).toBe(already); // idempotent — no double caveat
    // Also dedupes against the sibling unverified banner.
    const withSibling = "> ⚠️ **Unverified:** This answer is based on general knowledge and was NOT verified against live web sources.\n\nBody.";
    expect(prependUrlNotFetchedCaveat(withSibling, "en")).toBe(withSibling);
  });
});
