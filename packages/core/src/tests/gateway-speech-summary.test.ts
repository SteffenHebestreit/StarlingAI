import { describe, expect, it } from "vitest";
import { buildSpeechSummarySystemPrompt, buildSpeechSummaryUserPrompt, detectSpeechSummaryLanguage } from "../gateway/speech-summary.js";

describe("speech summary prompt", () => {
  it("keeps the assistant perspective for spoken summaries", () => {
    const prompt = buildSpeechSummarySystemPrompt(2, "Hallo. Ich bin Luna. Wie kann ich Ihnen heute behilflich sein?");

    expect(prompt).toContain("assistant-to-user perspective");
    expect(prompt).toContain("MUST remain in German");
    expect(prompt).toContain("Never switch into the user's voice");
    expect(prompt).toContain("I need help");
    expect(prompt).toContain("Respond with only the spoken summary");
  });

  it("detects common German assistant replies", () => {
    expect(detectSpeechSummaryLanguage("Hallo. Ich bin Luna. Wie kann ich Ihnen heute behilflich sein?")).toBe("German");
    expect(detectSpeechSummaryLanguage("Hello. I am Luna. How can I help you today?")).toBe("English");
  });

  it("wraps the source reply explicitly for the model", () => {
    const userPrompt = buildSpeechSummaryUserPrompt("Hallo. Wie kann ich helfen?");

    expect(userPrompt).toContain("Source assistant reply:");
    expect(userPrompt).toContain("<<<SOURCE");
    expect(userPrompt).toContain("Preserve its language and perspective");
  });
});