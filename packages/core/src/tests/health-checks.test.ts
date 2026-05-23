import { describe, expect, it } from "vitest";
import { classifyEmbeddingProbe } from "../observability/health-checks.js";

/**
 * The embedding self-check is the one that would have caught this stack's
 * biggest latent bug (LM Studio base64 → all-zero vectors silently degrading
 * every semantic feature). Lock the classifier behaviour.
 */
describe("classifyEmbeddingProbe", () => {
  it("reports ok for a real (non-zero) vector", () => {
    const c = classifyEmbeddingProbe(new Float32Array([0.1, -0.2, 0, 0.3]));
    expect(c.status).toBe("ok");
    expect(c.detail).toContain("dim 4");
  });

  it("reports degraded for an all-zero vector (broken embedding pipeline)", () => {
    const c = classifyEmbeddingProbe(new Float32Array([0, 0, 0, 0]));
    expect(c.status).toBe("degraded");
    expect(c.detail?.toLowerCase()).toContain("all-zero");
  });

  it("reports unavailable for an empty or missing vector", () => {
    expect(classifyEmbeddingProbe(new Float32Array([])).status).toBe("unavailable");
    expect(classifyEmbeddingProbe(null).status).toBe("unavailable");
    expect(classifyEmbeddingProbe(undefined).status).toBe("unavailable");
  });

  it("accepts a plain number[] too", () => {
    expect(classifyEmbeddingProbe([0.5, 0.5]).status).toBe("ok");
    expect(classifyEmbeddingProbe([0, 0]).status).toBe("degraded");
  });
});
