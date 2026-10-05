import { describe, expect, it } from "vitest";
import {
  sanitizeUserFacingAssistantResponse,
  shouldResynthesizeUserFacingResponse,
} from "../agent/response-finalization.js";
import { sanitizeAssistantContent } from "../agent/sanitize-response.js";

/**
 * Execution-chatter stripping belongs to text that ACCOMPANIED tool calls or narrated tool markup,
 * never to a final answer's own paragraphs. Verified 2026-10-05: in a tool-using turn the answer
 * paragraph "I'll be direct: option B is cheaper and faster." was deleted, because the filter
 * keyed off "this turn ran tools" and the paragraph happens to open with "I'll".
 */
describe("final-answer chatter filter (2026-10-05)", () => {
  const ANSWER = [
    "Both options meet the 5 V requirement.",
    "I'll be direct: option B is cheaper and faster.",
    "Let me know if you want the full cost table.",
  ].join("\n\n");

  it("keeps every paragraph of a tool-using turn's final answer", () => {
    expect(sanitizeUserFacingAssistantResponse(ANSWER, 3)).toBe(ANSWER);
  });

  it("still strips the narration around narrated tool markup", () => {
    const narrated = [
      "Let me search for the datasheet.",
      "[Tool: web_search(query: \"option B datasheet\") -> results]",
      "Option B draws 12 mA at 3.3 V.",
    ].join("\n\n");
    expect(sanitizeUserFacingAssistantResponse(narrated, 2)).toBe("Option B draws 12 mA at 3.3 V.");
  });

  it("never lets the filter empty an answer", () => {
    const onlyNarration = "Let me search for the datasheet.\n\n[Tool: web_search(query: \"x\") -> results]";
    expect(sanitizeUserFacingAssistantResponse(onlyNarration, 2)).toBe("Let me search for the datasheet.");
  });

  it("resynthesizes a tool-using turn that ended on narration alone — the decision moved out of the sanitizer", () => {
    const narration = "Let me check the datasheet for the exact figures.";
    const cleaned = sanitizeUserFacingAssistantResponse(narration, 2);
    expect(cleaned).toBe(narration);
    expect(shouldResynthesizeUserFacingResponse(narration, cleaned, 2)).toBe(true);
    // A real answer is not resynthesized just because one paragraph opens with "I'll".
    expect(shouldResynthesizeUserFacingResponse(ANSWER, sanitizeUserFacingAssistantResponse(ANSWER, 3), 3)).toBe(false);
  });

  it("transcript text that accompanied tool calls is still treated as narration", () => {
    expect(sanitizeAssistantContent("I'll search for current methodologies.", true)).toBe("");
  });

  // Adversarial review 2026-10-05: with the filter gone, a tool turn's leftover step narration
  // leaked IN FRONT of the answer. A leading run of one-sentence narration is dropped when real
  // content follows; closings ("Let me know …") and colon content ("I'll be direct: …") stay.
  it("drops a leading run of step narration in a tool turn, never the answer after it", () => {
    expect(sanitizeUserFacingAssistantResponse("Let me check the pricing page.\n\nThe price is $5/month.", 2)).toBe("The price is $5/month.");
    expect(sanitizeUserFacingAssistantResponse("I'll call web_search next.\n\nThe ESP32-S3 draws 240 mA.", 2)).toBe("The ESP32-S3 draws 240 mA.");
    const direct = "I'll be direct: option B is cheaper and faster.\n\nIt also ships a week earlier.";
    expect(sanitizeUserFacingAssistantResponse(direct, 2)).toBe(direct);
    // A turn without tools keeps its text as written.
    expect(sanitizeUserFacingAssistantResponse("Let me explain.\n\nThe price is $5/month.", 0)).toBe("Let me explain.\n\nThe price is $5/month.");
  });

  it("content after a colon on the narration line is an answer; a tool call printed after it is not", () => {
    const direct = "I'll be direct: option B is cheaper and faster.";
    expect(shouldResynthesizeUserFacingResponse(direct, sanitizeUserFacingAssistantResponse(direct, 2), 2)).toBe(false);
    const question = "I'm going to need more details: which region?";
    expect(shouldResynthesizeUserFacingResponse(question, sanitizeUserFacingAssistantResponse(question, 2), 2)).toBe(false);
    const printedCall = "Let me search for that:\n{\"name\": \"web_search\", \"arguments\": {\"query\": \"esp32 price\"}}";
    expect(shouldResynthesizeUserFacingResponse(printedCall, sanitizeUserFacingAssistantResponse(printedCall, 2), 2)).toBe(true);
  });
});
