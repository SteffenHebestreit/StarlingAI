import { describe, expect, it } from "vitest";
import { computeOpenAICompatibleRequestTimeoutMs } from "../providers/lmstudio.js";

// This budget is the per-chunk SILENCE budget — how long the remote may send
// nothing at all — NOT a total generation budget: streamOnce re-arms its
// inactivity timer on every chunk. It used to be derived from maxTokens, which was
// wrong in both directions (it assumed 40 tok/s against a measured ~15.3, and
// raising the output budget silently stretched stall detection from 2 min to 15).
// The completion budget is now derived per request from the context window, so
// there is no constant left to derive from, and TOTAL runtime is bounded by the
// caller's deadline signal instead.
describe("provider request timeout budget", () => {
  it("is INDEPENDENT of maxTokens — the decoupling this exists for", () => {
    const small = computeOpenAICompatibleRequestTimeoutMs({ maxTokens: 512 }, 30_000);
    const large = computeOpenAICompatibleRequestTimeoutMs({ maxTokens: 200_000 }, 30_000);
    expect(small).toBe(large);
  });

  it("floors a low configured timeout at the minimum silence budget", () => {
    // A graded-thinking model legitimately emits nothing for ~5 minutes inside one
    // reasoning block, so anything under 10 minutes of silence is not yet evidence
    // of a hung provider.
    expect(computeOpenAICompatibleRequestTimeoutMs({ maxTokens: 4096 }, 30_000)).toBe(600_000);
    expect(computeOpenAICompatibleRequestTimeoutMs({}, 45_000)).toBe(600_000);
  });

  it("respects a higher configured timeout that already exceeds the floor", () => {
    expect(computeOpenAICompatibleRequestTimeoutMs({ maxTokens: 512 }, 750_000)).toBe(750_000);
  });

  it("still caps a configured timeout at the ceiling", () => {
    expect(computeOpenAICompatibleRequestTimeoutMs({ maxTokens: 16_384 }, 5_000_000)).toBe(900_000);
  });
});
