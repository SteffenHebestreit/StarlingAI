import { describe, expect, it } from "vitest";
import { computeOpenAICompatibleRequestTimeoutMs } from "../providers/lmstudio.js";

describe("provider request timeout budget", () => {
  it("extends low configured timeouts for large generation budgets", () => {
    const timeoutMs = computeOpenAICompatibleRequestTimeoutMs({ maxTokens: 4096 }, 30_000);
    expect(timeoutMs).toBeGreaterThan(100_000);
  });

  it("respects higher configured timeouts when they already exceed the heuristic", () => {
    const timeoutMs = computeOpenAICompatibleRequestTimeoutMs({ maxTokens: 512 }, 180_000);
    expect(timeoutMs).toBe(180_000);
  });

  it("caps extreme budgets at the provider timeout ceiling", () => {
    const timeoutMs = computeOpenAICompatibleRequestTimeoutMs({ maxTokens: 16_384 }, 30_000);
    expect(timeoutMs).toBe(300_000);
  });

  it("falls back to the configured timeout when maxTokens is omitted", () => {
    const timeoutMs = computeOpenAICompatibleRequestTimeoutMs({}, 45_000);
    expect(timeoutMs).toBe(45_000);
  });
});