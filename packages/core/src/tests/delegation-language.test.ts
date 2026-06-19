import { describe, expect, it } from "vitest";
import {
  buildDelegationTranslatePrompt,
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
    expect(parseDelegationTranslation("", original)).toEqual({ task: original, sourceLanguage: "English" });
    expect(parseDelegationTranslation("not json", original)).toEqual({ task: original, sourceLanguage: "English" });
    expect(parseDelegationTranslation('{"language":"German"}', original)).toEqual({ task: original, sourceLanguage: "English" });
  });

  it("tolerates prose around the JSON object", () => {
    const r = parseDelegationTranslation('Here you go: {"language":"French","task":"Build the site."}', original);
    expect(r.sourceLanguage).toBe("French");
    expect(r.task).toBe("Build the site.");
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
});
