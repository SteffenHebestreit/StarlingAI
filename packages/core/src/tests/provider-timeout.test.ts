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

  // The ceiling bounds SILENCE, not total generation: streamOnce re-arms its
  // inactivity timer on every chunk. It was 300_000, which killed a graded-thinking
  // model mid-reasoning-block (qwen3.8-27b, 28k-token prompt, ~5 min quiet) after it
  // had already done useful work. 900_000 still catches a genuinely hung provider.
  it("lets a large-but-plausible budget through now that the ceiling is 15 min", () => {
    // 20_000 + 16_384 * 25 = 429_600 — under the ceiling, so it is NOT capped. At the
    // old 300_000 ceiling this was clamped, which is what cut long generations short.
    const timeoutMs = computeOpenAICompatibleRequestTimeoutMs({ maxTokens: 16_384 }, 30_000);
    expect(timeoutMs).toBe(429_600);
  });

  it("still caps a budget that would exceed even the raised ceiling", () => {
    const timeoutMs = computeOpenAICompatibleRequestTimeoutMs({ maxTokens: 200_000 }, 30_000);
    expect(timeoutMs).toBe(900_000);
  });

  it("falls back to the configured timeout when maxTokens is omitted", () => {
    const timeoutMs = computeOpenAICompatibleRequestTimeoutMs({}, 45_000);
    expect(timeoutMs).toBe(45_000);
  });
});