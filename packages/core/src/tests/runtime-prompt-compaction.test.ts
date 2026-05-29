import { describe, expect, it } from "vitest";
import { compactBasePromptUnderPressure } from "../agent/runtime.js";

/**
 * Last-resort base-prompt compaction (Flaw 1B): the budget trimmer must be able
 * to shrink the dominant base prompt — not just the small auxiliary blocks —
 * while preserving the behavioral and safety contracts.
 */
describe("compactBasePromptUnderPressure", () => {
  const prompt = [
    "You are the main assistant.",
    "",
    "## Core Principles",
    "- Prefer direct tools first.",
    "",
    "## Response Format",
    "- Always respond in Markdown.",
    "- Use headings and tables.",
    "",
    "## Swarm Rules",
    "- Split work into small specialist tasks.",
    "",
    "## Security",
    "- Never output secrets.",
  ].join("\n");

  it("removes the Response Format section", () => {
    const out = compactBasePromptUnderPressure(prompt);
    expect(out).not.toContain("## Response Format");
    expect(out).not.toContain("Always respond in Markdown");
    expect(out.length).toBeLessThan(prompt.length);
  });

  it("preserves Core Principles, Swarm Rules, and Security", () => {
    const out = compactBasePromptUnderPressure(prompt);
    expect(out).toContain("## Core Principles");
    expect(out).toContain("## Swarm Rules");
    expect(out).toContain("## Security");
    expect(out).toContain("Never output secrets");
  });

  it("is a no-op when there is nothing safe to remove", () => {
    const minimal = "You are the main assistant.\n\n## Security\n- Never output secrets.";
    expect(compactBasePromptUnderPressure(minimal)).toBe(minimal);
  });
});
