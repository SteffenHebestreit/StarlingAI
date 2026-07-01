import { describe, expect, it } from "vitest";
import {
  answerPresentsSourceCitations,
  stripFabricatedCitations,
  prependUnverifiedSourceCaveat,
} from "../agent/runtime.js";
import {
  userMessageCarriesActionableUrl,
  prependUrlNotFetchedCaveat,
  looksLikeUnsourcedSpecificClaims,
  answerAssertsSpecifics,
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

// looksLikeUnsourcedSpecificClaims is the STRUCTURAL trigger for the general (no-URL) force-research
// guard (ungroundedFactualAnswerGuard). It must fire on a specifics-dense fabricated bulletin in any
// language but stay OFF ordinary prose — WITHOUT any topic/language keyword table.
describe("looksLikeUnsourcedSpecificClaims — dense specifics without a keyword table", () => {
  it("fires on a fabricated current-events bulletin (audit fe496ec5 shape, German)", () => {
    const bulletin = "Aktuelle Nachrichten von heute, Stand 14:00 Uhr:\n"
      + "- Der DAX schloss bei 24.000 Punkten, ein Plus von 1,2 % gegenüber dem Vortag.\n"
      + "- Die EZB hält den Leitzins unverändert bei 3,75 % und signalisiert eine Pause.\n"
      + "- Die NASA plant den Artemis-Start für 2026, das Budget liegt bei 4,1 Mrd USD.\n"
      + "- Der Ölpreis der Sorte Brent liegt bei 82 USD pro Barrel, ein Rückgang von 0,8 %.\n"
      + "- Der Goldpreis erreichte 2.150 USD je Feinunze, ein neues Jahreshoch für 2026.\n"
      + "Diese Meldungen fassen die wichtigsten wirtschaftlichen Ereignisse des Tages zusammen und geben einen kompakten Überblick über die aktuelle Marktlage.";
    expect(bulletin.trim().length).toBeGreaterThanOrEqual(400);
    expect(looksLikeUnsourcedSpecificClaims(bulletin)).toBe(true);
  });

  it("fires on fabricated hardware specs (audit bdbace34 shape, English)", () => {
    const specs = "The recommended microphone is the IM73A135V01 analog MEMS mic from the reference design. "
      + "It draws 0.95 mA at 3.3 V, offers a 73 dB SNR, a frequency range up to 20 kHz, and a sensitivity around -38 dBV. "
      + "Pair it with the BMI270 IMU, released in 2020, over I2C at 400 kHz on a compact 12 mm x 8 mm board. "
      + "The BMI270 draws about 685 mA peak and supports output data rates up to 1.6 kHz in performance mode. "
      + "This combination has been widely adopted since 2021 across many wearable and hearable reference kits.";
    expect(specs.trim().length).toBeGreaterThanOrEqual(400);
    expect(looksLikeUnsourcedSpecificClaims(specs)).toBe(true);
  });

  it("does NOT fire on ordinary prose explanation (few fact-shaped tokens)", () => {
    const prose = "A transmission control protocol connection is established with a three-way handshake: "
      + "the client sends a synchronize request, the server acknowledges it, and the client confirms. "
      + "Once open, data flows reliably in order, with retransmission of anything lost, until either side "
      + "closes the connection. It is the backbone of most reliable communication on the internet, and it "
      + "trades a little latency for guaranteed delivery, which is why it underpins the web and email.";
    expect(prose.trim().length).toBeGreaterThanOrEqual(400);
    expect(looksLikeUnsourcedSpecificClaims(prose)).toBe(false);
  });

  it("does NOT fire on a short answer even if specifics-dense (400-char floor)", () => {
    expect(looksLikeUnsourcedSpecificClaims("DAX 24.000, EZB 3,75 %, 2026, 82 USD.")).toBe(false);
  });

  // Regression (final-diff verify w5w8p7dqm): the old part-code regex matched prose "word number"
  // pairs ("in 1998") and double-counted years, so a general-knowledge answer mentioning only a few
  // years over-fired the ENABLED ⑤ guard. The category-diversity gate (≥2 distinct categories) fixes it.
  it("does NOT fire on a general-knowledge answer carrying ONLY years (single category)", () => {
    const history = "The company was founded in 1998 by a small team of engineers who wanted to build "
      + "reliable tools. In 2004 it moved to a larger headquarters, and by 2008 it had opened offices "
      + "abroad and hired across several countries. It went public in 2015 after years of steady, "
      + "unglamorous growth, and in 2020 it restructured around three divisions to stay focused. "
      + "Throughout its history it kept a reputation for careful, methodical engineering rather than "
      + "chasing every passing trend, and that patience is often cited as the main reason it endured.";
    expect(history.trim().length).toBeGreaterThanOrEqual(400);
    expect(looksLikeUnsourcedSpecificClaims(history)).toBe(false); // years only → 1 category → no fire
  });

  it("does NOT fire on a general-knowledge answer carrying ONLY percentages (single category)", () => {
    const stats = "Macronutrients each contribute differently to daily energy. In a balanced diet, carbohydrates "
      + "typically make up about 50 % of intake, fats around 30 %, and protein close to 20 %. Fibre is counted "
      + "within carbohydrates but is not fully digested, so its usable energy is lower. These proportions shift "
      + "with activity level and goals, but the rough split is a common starting point for general guidance and "
      + "everyday meal planning without any special medical considerations involved.";
    expect(stats.trim().length).toBeGreaterThanOrEqual(400);
    expect(looksLikeUnsourcedSpecificClaims(stats)).toBe(false); // percentages only → 1 category → no fire
  });

  it("does NOT match a prose 'word number' pair as a code token (regex tightening)", () => {
    // "in 1998" / "by 2015" must NOT count as part-codes; a real contiguous alnum code still does.
    const prose = "The standard was ratified in 1998 and revised by 2015 after long review. " + "x".repeat(400);
    // Only the two years (one category) → below the 2-category bar.
    expect(looksLikeUnsourcedSpecificClaims(prose)).toBe(false);
  });
});

// answerAssertsSpecifics (#5): the SHORT-answer branch of the URL-not-fetched guard. A ~300-char
// fabricated page summary that asserts specifics must be catchable below the 400-char floor, but an
// honest short "couldn't fetch it" must not.
describe("answerAssertsSpecifics — short answer asserts page content", () => {
  it("fires on a short fabricated page summary (≥2 fact-shape tokens)", () => {
    expect(answerAssertsSpecifics(
      "Die Ausschreibung sucht einen AI Engineer, 100 % Remote, Vergütung 90 EUR pro Stunde, Start 2026.",
    )).toBe(true);
  });

  it("does NOT fire on an honest short 'could not fetch' reply (no specifics)", () => {
    expect(answerAssertsSpecifics(
      "Ich konnte die verlinkte Seite nicht abrufen. Soll ich es noch einmal versuchen?",
    )).toBe(false);
  });

  it("respects a higher minTokens threshold", () => {
    expect(answerAssertsSpecifics("Only one year here: 2026.", 2)).toBe(false); // 1 token < 2
  });
});
