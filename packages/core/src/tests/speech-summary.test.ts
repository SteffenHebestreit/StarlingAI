import { beforeAll, describe, it, expect } from "vitest";
import { warmTextLanguageDetector } from "../agent/text-language.js";
import { stripMarkdownForSpeech, detectSpeechSummaryLanguage } from "../gateway/speech-summary.js";

// The detector loads lazily (text-language.ts); the gateway warms it at boot, a test does it here.
beforeAll(async () => { await warmTextLanguageDetector(); });

describe("stripMarkdownForSpeech", () => {
  it("removes fenced code blocks and replaces with placeholder", () => {
    const input = "Here is the code:\n```typescript\nconst x = 1;\n```\nDone.";
    const result = stripMarkdownForSpeech(input);
    expect(result).not.toContain("```");
    expect(result).toContain("(code omitted)");
    expect(result).toContain("Here is the code");
    expect(result).toContain("Done.");
  });

  it("removes inline code backticks, keeping the text", () => {
    const input = "Call the `search_agents` tool first.";
    expect(stripMarkdownForSpeech(input)).toBe("Call the search_agents tool first.");
  });

  it("removes ATX headings, keeping heading text", () => {
    const input = "## Summary\nSome text here.\n### Details\nMore text.";
    const result = stripMarkdownForSpeech(input);
    expect(result).toContain("Summary");
    expect(result).toContain("Details");
    expect(result).not.toContain("##");
    expect(result).not.toContain("###");
  });

  it("removes bold and italic markers", () => {
    const input = "This is **bold** and *italic* and ***both***.";
    const result = stripMarkdownForSpeech(input);
    expect(result).toBe("This is bold and italic and both.");
  });

  it("removes bullet list markers", () => {
    const input = "Steps:\n- First step\n- Second step\n* Third step\n+ Fourth step";
    const result = stripMarkdownForSpeech(input);
    expect(result).toContain("First step");
    expect(result).toContain("Second step");
    expect(result).not.toMatch(/^\s*[-*+]\s/m);
  });

  it("removes numbered list markers", () => {
    const input = "1. Do this\n2. Then this\n3) Finally this";
    const result = stripMarkdownForSpeech(input);
    expect(result).toContain("Do this");
    expect(result).toContain("Then this");
    expect(result).not.toMatch(/^\s*\d+[.)]/m);
  });

  it("removes blockquote markers", () => {
    const input = "> This is a quote\n> continued here";
    const result = stripMarkdownForSpeech(input);
    expect(result).toContain("This is a quote");
    expect(result).not.toContain("> ");
  });

  it("removes horizontal rules", () => {
    const input = "Before\n---\nAfter";
    const result = stripMarkdownForSpeech(input);
    expect(result).toContain("Before");
    expect(result).toContain("After");
    expect(result).not.toMatch(/^---/m);
  });

  it("converts table rows to pipe-free readable format", () => {
    const input = "| A | B |\n|---|---|\n| 1 | 2 |";
    const result = stripMarkdownForSpeech(input);
    // Separator row removed
    expect(result).not.toMatch(/\|[-| :]+\|/);
    // Data rows: pipes stripped, cells joined with " — "
    expect(result).toContain("A — B");
    expect(result).toContain("1 — 2");
    // No raw pipe characters remain
    expect(result).not.toContain("|");
  });

  it("handles empty string", () => {
    expect(stripMarkdownForSpeech("")).toBe("");
  });

  it("passes through plain text unchanged", () => {
    const input = "Just some plain text here. Nothing special.";
    expect(stripMarkdownForSpeech(input)).toBe(input);
  });

  it("handles a realistic assistant reply", () => {
    const input = `## Ergebnis

Der Workflow wurde erstellt. Folgende Schritte:

- Browser öffnet http://app.example.com
- Credentials werden eingefügt
- Login wird durchgeführt

**Hinweis:** Stelle sicher, dass die Credentials im Store hinterlegt sind.`;
    const result = stripMarkdownForSpeech(input);
    expect(result).not.toContain("##");
    expect(result).not.toMatch(/^\s*-\s/m);
    expect(result).not.toContain("**");
    expect(result).toContain("Ergebnis");
    expect(result).toContain("Browser öffnet http://app.example.com");
    expect(result).toContain("Hinweis");
  });
});

describe("detectSpeechSummaryLanguage", () => {
  it("detects German", () => {
    expect(detectSpeechSummaryLanguage("Das ist nicht gut für uns")).toBe("German");
  });

  it("detects English", () => {
    expect(detectSpeechSummaryLanguage("This is how you can use the tool")).toBe("English");
  });

  it("returns null for empty string", () => {
    expect(detectSpeechSummaryLanguage("")).toBeNull();
  });
});

describe("detectSpeechSummaryLanguage — any language, not just German or English", () => {
  it("names a French reply so the summary stays French", () => {
    expect(detectSpeechSummaryLanguage("Voici le résumé : le serveur répond à nouveau et la latence est revenue à la normale.")).toBe("French");
  });

  it("does not read English containing 'was' and 'die' as German", () => {
    expect(detectSpeechSummaryLanguage("The die was cast, and the rollout was finished before noon.")).toBe("English");
  });

  it("returns null when there is too little prose to call", () => {
    expect(detectSpeechSummaryLanguage("ok")).toBeNull();
    expect(detectSpeechSummaryLanguage("```js\nconst x = 1;\n```")).toBeNull();
  });
});
