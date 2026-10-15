import { describe, expect, it } from "vitest";
import { readBodyWithin, sendChunkedTtsRequests, splitIntoSentences, splitTextForTts } from "../multimodal/tts-chunking.js";

/** A minimal 16-bit mono PCM WAV with `samples` zero samples. */
function wav(samples: number): Uint8Array {
  const data = samples * 2;
  const buffer = new ArrayBuffer(44 + data);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => { for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i)); };
  ascii(0, "RIFF"); view.setUint32(4, 36 + data, true); ascii(8, "WAVE");
  ascii(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, "data"); view.setUint32(40, data, true);
  return new Uint8Array(buffer);
}

describe("sendChunkedTtsRequests", () => {
  it("merges WAV chunks the service labels audio/x-wav", async () => {
    const response = await sendChunkedTtsRequests({ text: "Erster Satz hier. ".repeat(40) }, {
      maxChunkChars: 100,
      requestChunk: async () => new Response(wav(10).slice(0), { headers: { "content-type": "audio/x-wav" } }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/wav");
  });

  it("gives up on a chunk whose audio stops arriving", async () => {
    const stalled = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([82, 73])); } }), {
      headers: { "content-type": "audio/wav" },
    });
    await expect(readBodyWithin(stalled, 50)).rejects.toThrow(/timed out/);
  });
});

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
