import { describe, expect, it } from "vitest";
import {
  detectLanguage,
  isShortForSpeech,
  languageCode,
  leadSentences,
  localeFor,
  sentencesOf,
  speechChunks,
  toSpeakableText,
} from "./speechText";

describe("toSpeakableText", () => {
  it("reads markdown as sentences: no marks, code, URLs or emoji, and a pause after each heading and item", () => {
    const markdown = [
      "## Ergebnis",
      "",
      "Das **Wetter** in [Berlin](https://example.com/berlin) ist _heute_ gut ✅ — siehe https://wetter.example.com/x?y=1.",
      "",
      "- Temperatur `22 °C`",
      "- Wind schwach",
      "",
      "```js",
      "console.log('nicht vorlesen');",
      "```",
      "",
      "| Tag | Wert |",
      "| --- | ---: |",
      "| Mo | 20 |",
      "",
      "---",
      "> Ein Zitat",
    ].join("\n");
    expect(toSpeakableText(markdown)).toBe(
      "Ergebnis. Das Wetter in Berlin ist heute gut — siehe. Temperatur 22 °C. Wind schwach. Tag, Wert. Mo, 20. Ein Zitat.",
    );
  });

  it("keeps snake_case names and arithmetic, and drops long inline code", () => {
    expect(toSpeakableText("Set max_tokens to 5 * 3 now")).toBe("Set max_tokens to 5 * 3 now.");
    expect(toSpeakableText(`Run \`${"x".repeat(60)}\` first`)).toBe("Run first.");
  });

  it("is empty for a reply that is only code or a link", () => {
    expect(toSpeakableText("```\ncode\n```")).toBe("");
    expect(toSpeakableText("https://example.com")).toBe("");
  });
});

describe("detectLanguage", () => {
  it("tells German, English and Polish apart", () => {
    expect(detectLanguage("Ich habe das Wetter für dich nachgeschlagen, es ist sonnig.")).toBe("de");
    expect(detectLanguage("I looked up the weather for you and it is sunny.")).toBe("en");
    expect(detectLanguage("Sprawdziłem pogodę, jest słonecznie i nie pada.")).toBe("pl");
  });

  // The previous detector counted " i " as Polish: English with "I" in it came out Polish.
  it("does not read the English 'I' as Polish", () => {
    expect(detectLanguage("I think I know what I want.")).toBe("en");
  });

  it("does not guess when the text says nothing", () => {
    expect(detectLanguage("OK")).toBeUndefined();
    expect(detectLanguage("42")).toBeUndefined();
  });
});

describe("languageCode / localeFor", () => {
  it("reduces names and locales to a two-letter code", () => {
    expect(["German", "de-DE", "de_de", "en", "English", "auto", "", undefined, "Klingonisch"].map(languageCode))
      .toEqual(["de", "de", "de", "en", "en", undefined, undefined, undefined, undefined]);
    expect(localeFor("de")).toBe("de-DE");
    expect(localeFor("fr")).toBe("fr");
  });
});

describe("speechChunks", () => {
  const strip = (text: string) => text.replace(/\s+/g, "");

  it("starts with a short piece and groups the rest, keeping every character", () => {
    const text = "Hallo! Hier ist die Antwort. " + "Dieser Satz ist ein ganz normaler Satz mit etwas Inhalt. ".repeat(12);
    const chunks = speechChunks(text, { firstMax: 160, max: 300 });
    expect(chunks[0]).toBe("Hallo! Hier ist die Antwort.");
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks.slice(1)) expect(chunk.length).toBeLessThanOrEqual(300);
    expect(strip(chunks.join(""))).toBe(strip(text));
  });

  it("cuts a sentence longer than the limit at a clause or a word", () => {
    const long = `${"eins, zwei drei vier fünf sechs ".repeat(20)}Ende.`;
    const chunks = speechChunks(long, { firstMax: 80, max: 120 });
    expect(chunks[0]!.length).toBeLessThanOrEqual(80);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(120);
    expect(strip(chunks.join(""))).toBe(strip(long));
  });

  it("keeps the first piece short even when the first sentence would fit a later piece", () => {
    const first = `${"Ein recht langer erster Satz mit vielen Wörtern ".repeat(3).trim()}.`;
    const chunks = speechChunks(`${first} Danach kommt mehr.`, { firstMax: 80, max: 300 });
    expect(first.length).toBeGreaterThan(80);
    expect(chunks[0]!.length).toBeLessThanOrEqual(80);
  });

  it("does not merge a real first sentence with the next", () => {
    expect(speechChunks("Das ist der erste richtige Satz. Und hier kommt der zweite.")).toEqual([
      "Das ist der erste richtige Satz.",
      "Und hier kommt der zweite.",
    ]);
  });
});

describe("short or summarised", () => {
  it("reads a few sentences in full and summarises a long answer", () => {
    expect(isShortForSpeech("Es ist sonnig. Morgen regnet es.")).toBe(true);
    expect(isShortForSpeech("Satz eins. Satz zwei. Satz drei. Satz vier. Satz fünf.")).toBe(false);
    expect(isShortForSpeech("x".repeat(500))).toBe(false);
  });

  it("takes the opening sentences when no summary could be made", () => {
    expect(leadSentences("Eins ist hier. Zwei ist da. Drei auch.", 2)).toBe("Eins ist hier. Zwei ist da.");
    expect(leadSentences(`${"a".repeat(318)}. Kurz.`, 2, 320)).toBe(`${"a".repeat(318)}.`);
    expect(sentencesOf("A. B? C!")).toEqual(["A.", "B?", "C!"]);
  });
});
