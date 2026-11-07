import { describe, expect, it } from "vitest";
import { FRESHNESS_HONESTY_PROMPT } from "../agent/turn-system-prompt.js";
import { normalizeMessagesForModel } from "../providers/lmstudio.js";

/**
 * A RULE BEHIND THE HISTORY READS AS THE USER'S WORDS.
 * After "geh zurück auf das lokale Modell" the tool had little to report, and the model answered
 * this line instead: "Verstanden, ich halte mich strikt daran", 7 times in 8, storing it as a memory
 * on the way. Labelled, 0 times in 18 on the same messages (2026-11-06).
 */
describe("the honesty rule in the turn's tail", () => {
  it("reaches the model as a user message", () => {
    const delivered = normalizeMessagesForModel([
      { role: "system", content: "head" },
      { role: "user", content: "Geh zurück auf das lokale Modell." },
      { role: "system", content: FRESHNESS_HONESTY_PROMPT },
    ], "qwen");
    expect(delivered.at(-1)).toMatchObject({ role: "user", content: FRESHNESS_HONESTY_PROMPT });
  });

  it("so it says it is not the user's, and is not to be answered or kept", () => {
    expect(FRESHNESS_HONESTY_PROMPT).toContain("not the user's words");
    expect(FRESHNESS_HONESTY_PROMPT).toContain("never acknowledge or store it");
  });
});
