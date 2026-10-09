import { describe, expect, it } from "vitest";
import {
  buildDelegationTranslatePrompt,
  normalizeDelegationTaskLanguage,
  parseDelegationTranslation,
  withOutputLanguageDirective,
} from "../agent/delegation-language.js";

/**
 * Per-delegation language normalization (user 2026-06-19: "work internally in English;
 * deliver in the user's language"). The prompt, the fail-open parser, and the output-
 * language directive are pure, so they are verifiable without a running translation call.
 */
describe("parseDelegationTranslation", () => {
  const original = "Erstelle eine CPSA-F Lernplattform als HTML-Datei.";

  it("returns the English translation + detected language", () => {
    const r = parseDelegationTranslation(
      '{"language":"German","task":"Create a CPSA-F learning platform as an HTML file."}',
      original,
    );
    expect(r.sourceLanguage).toBe("German");
    expect(r.task).toBe("Create a CPSA-F learning platform as an HTML file.");
  });

  it("keeps the ORIGINAL task verbatim when the model reports English (no needless rewrite)", () => {
    const r = parseDelegationTranslation('{"language":"English","task":"slightly reworded"}', original);
    expect(r.sourceLanguage).toBe("English");
    expect(r.task).toBe(original); // original preserved, not the model's reworded English
  });

  it("fails open to the original on empty / unparseable / no-task replies", () => {
    const unchanged = { task: original, sourceLanguage: "English", outputLanguage: "English" };
    expect(parseDelegationTranslation("", original)).toEqual(unchanged);
    expect(parseDelegationTranslation("not json", original)).toEqual(unchanged);
    expect(parseDelegationTranslation('{"language":"German"}', original)).toEqual(unchanged);
  });

  it("tolerates prose around the JSON object", () => {
    const r = parseDelegationTranslation('Here you go: {"language":"French","task":"Build the site."}', original);
    expect(r.sourceLanguage).toBe("French");
    expect(r.task).toBe("Build the site.");
  });

  it("uses the output language the model names — a German task asking for an English letter stays English", () => {
    // The bug: the directive was derived from the TASK's language, so a German task that asked for
    // an English cover letter got "write it in German" appended on top of "in English".
    const r = parseDelegationTranslation(
      '{"language":"German","output_language":"English","task":"Write the cover letter in English."}',
      "Schreib das Anschreiben auf Englisch.",
    );
    expect(r.sourceLanguage).toBe("German");
    expect(r.outputLanguage).toBe("English");
    expect(withOutputLanguageDirective(r.task, r.outputLanguage)).toBe("Write the cover letter in English.");
  });

  it("keeps an English task verbatim but still carries a non-English output language", () => {
    // An English paraphrase of a German request: nothing to translate, but the result is for a
    // German speaker. Before, "English task" meant "no directive", and the page came back in English.
    const task = "Build a landing page for the bakery.";
    const r = parseDelegationTranslation('{"language":"English","output_language":"German","task":"Build a landing page."}', task);
    expect(r.task).toBe(task);
    expect(r.outputLanguage).toBe("German");
    expect(withOutputLanguageDirective(r.task, r.outputLanguage)).toContain("in German");
  });

  it("falls back to the task's language when the model names no output language", () => {
    const r = parseDelegationTranslation('{"language":"German","task":"Build the site."}', original);
    expect(r.outputLanguage).toBe("German");
  });
});

describe("withOutputLanguageDirective", () => {
  it("appends an output-language directive for a non-English source", () => {
    const out = withOutputLanguageDirective("Create a learning platform.", "German");
    expect(out).toContain("Create a learning platform.");
    expect(out).toContain("internally in English");
    expect(out).toContain("German");
    expect(out).toMatch(/\[LANGUAGE\]/);
  });

  it("is a no-op for English / unknown sources", () => {
    expect(withOutputLanguageDirective("Build it.", "English")).toBe("Build it.");
    expect(withOutputLanguageDirective("Build it.", "en")).toBe("Build it.");
    expect(withOutputLanguageDirective("Build it.", "")).toBe("Build it.");
  });
});

describe("buildDelegationTranslatePrompt", () => {
  it("asks for translate-only strict JSON and preserves identifiers", () => {
    const msgs = buildDelegationTranslatePrompt("Baue die Seite für Teil PCM1840.");
    const sys = msgs.find((m) => m.role === "system")!.content as string;
    const user = msgs.find((m) => m.role === "user")!.content as string;
    expect(sys).toContain("STRICT JSON");
    expect(sys.toLowerCase()).toContain("translate");
    expect(sys).toMatch(/preserve/i); // identifiers preserved verbatim
    expect(user).toContain("PCM1840"); // the task is passed through to translate
  });

  it("asks for the output language and hands over the user's own words as context only", () => {
    const msgs = buildDelegationTranslatePrompt("Write the cover letter.", {
      opening: "Schreib mir ein Anschreiben auf Englisch",
      midTurn: [],
    });
    const sys = msgs.find((m) => m.role === "system")!.content as string;
    const user = msgs.find((m) => m.role === "user")!.content as string;
    expect(sys).toContain("output_language");
    expect(sys).toContain("a language the task or the user's own words ask for");
    expect(user).toContain("USER'S OWN WORDS (context only)");
    expect(user).toContain("Schreib mir ein Anschreiben auf Englisch");
  });

  it("sends no user-words section when there are none", () => {
    const user = buildDelegationTranslatePrompt("Build it.").find((m) => m.role === "user")!.content as string;
    expect(user).toBe("TASK:\nBuild it.");
  });
});

describe("normalizeDelegationTaskLanguage", () => {
  const reply = (content: string) => ({ complete: async () => ({ content }) }) as unknown as import("../providers/lmstudio.js").ChatProvider;

  it("reports no change for an English task the user also wants in English", async () => {
    const r = await normalizeDelegationTaskLanguage({
      task: "Build it.",
      provider: reply('{"language":"English","output_language":"English","task":"Build it."}'),
    });
    expect(r).toEqual({ task: "Build it.", sourceLanguage: "English", outputLanguage: "English", changed: false });
  });

  it("translates and appends the output language the model named", async () => {
    const r = await normalizeDelegationTaskLanguage({
      task: "Baue die Seite.",
      provider: reply('{"language":"German","output_language":"German","task":"Build the page."}'),
    });
    expect(r.changed).toBe(true);
    expect(r.task.startsWith("Build the page.")).toBe(true);
    expect(r.task).toContain("in German");
  });

  it("fails open to the original task when the provider throws", async () => {
    const provider = { complete: async () => { throw new Error("down"); } } as unknown as import("../providers/lmstudio.js").ChatProvider;
    const r = await normalizeDelegationTaskLanguage({ task: "Baue die Seite.", provider });
    expect(r).toEqual({ task: "Baue die Seite.", sourceLanguage: "English", outputLanguage: "English", changed: false });
  });
});
