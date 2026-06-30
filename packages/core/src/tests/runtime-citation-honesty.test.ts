import { describe, expect, it } from "vitest";
import {
  answerPresentsSourceCitations,
  stripFabricatedCitations,
  prependUnverifiedSourceCaveat,
} from "../agent/runtime.js";

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
