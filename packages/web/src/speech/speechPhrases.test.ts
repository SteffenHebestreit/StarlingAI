import { describe, expect, it } from "vitest";
import { PhraseBook, phrasesFor, spokenPhraseLanguage } from "./speechPhrases";

describe("phrases", () => {
  it("are German for German and English for every other language", () => {
    expect(phrasesFor("ack", "de")[0]).toBe("Alles klar, ich bin dran.");
    expect(phrasesFor("ack", "pl")).toEqual(phrasesFor("ack", "en"));
    expect(phrasesFor("ack", undefined)).toEqual(phrasesFor("ack", "en"));
    expect(spokenPhraseLanguage("pl")).toBe("en");
  });

  it("take their wordings in turn, per kind and language", () => {
    const book = new PhraseBook();
    const acks = [book.pick("ack", "de"), book.pick("ack", "de"), book.pick("ack", "de"), book.pick("ack", "de")].map((phrase) => phrase.text);
    expect(acks).toEqual([...phrasesFor("ack", "de"), phrasesFor("ack", "de")[0]]);
    expect(book.pick("ack", "en")).toEqual({ text: phrasesFor("ack", "en")[0], language: "en" });
    expect(book.pick("stillWorking", "de").text).toBe(phrasesFor("stillWorking", "de")[0]);
  });
});
