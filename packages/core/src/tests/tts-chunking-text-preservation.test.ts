import { describe, expect, it } from "vitest";
import { splitIntoSentences, splitTextForTts } from "../multimodal/tts-chunking.js";

/**
 * EVERY CHARACTER OF THE TEXT REACHES THE SPEECH SERVER (2026-10-14).
 *
 * The chunker matched sentences with a pattern that needed white space after an end mark, so the
 * text before a "." inside "z.B.", "3.5" or "www.example.com" was dropped: a 991-character German
 * answer lost 344 characters before it was synthesised. Chunks now rebuild the input exactly.
 */

// Compared without white space: a word longer than a chunk has to be cut, which is no loss.
const squash = (text: string) => text.replace(/\s+/g, "");

const SAMPLES = [
  "Version 3.5 is out. Next sentence here.",
  "Das kostet z.B. 4,50 Euro. Danke für den Hinweis!",
  "Besuche www.example.com für mehr. Danach geht es weiter…",
  "Um 10:30, dann Mittag; danach 1,5 Stunden. Ende?",
  "Ein ganz langes Wort: " + "Donaudampfschifffahrtsgesellschaftskapitän".repeat(15) + ". Und weiter.",
];

describe("splitTextForTts", () => {
  it("rebuilds the input exactly from its chunks, abbreviations, URLs, decimals and times included", () => {
    for (const sample of SAMPLES) {
      const text = `${sample} `.repeat(9);
      const chunks = splitTextForTts(text, 120);
      expect(chunks.length).toBeGreaterThan(1);
      expect(squash(chunks.join(" "))).toBe(squash(text));
      for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(120);
    }
  });

  it("keeps paragraphs' text too", () => {
    const text = "Erster Absatz mit z.B. einer Zahl 3.5 drin.\n\nZweiter Absatz: www.example.com, dann 10:30.";
    expect(squash(splitTextForTts(text.repeat(6), 80).join(" "))).toBe(squash(text.repeat(6)));
  });
});

describe("splitIntoSentences", () => {
  it("cuts only at white space after an end mark", () => {
    expect(splitIntoSentences("Version 3.5 is out. Next one! Last?")).toEqual(["Version 3.5 is out.", "Next one!", "Last?"]);
    expect(splitIntoSentences("Besuche www.example.com für mehr.")).toEqual(["Besuche www.example.com für mehr."]);
  });
});
