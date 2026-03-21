import { describe, expect, it } from "vitest";
import { buildDynamicTurnGuidance } from "../agent/runtime.js";

describe("runtime turn guidance", () => {
  it("adds web-search guidance for freshness-sensitive requests", () => {
    const guidance = buildDynamicTurnGuidance("What are the latest 2026 MCP updates? Cite official sources.");

    expect(guidance).not.toBeNull();
    expect(guidance?.freshnessSensitive).toBe(true);
    expect(guidance?.sourceSensitive).toBe(true);
    expect(guidance?.prompt).toContain("Use direct web tools before answering");
    expect(guidance?.prompt).toContain("Start with web_search");
  });

  it("does not add extra guidance for timeless questions", () => {
    expect(buildDynamicTurnGuidance("Explain how binary search works.")).toBeNull();
  });
});