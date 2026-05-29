import { describe, expect, it } from "vitest";
import { prependUnverifiedSourceCaveat } from "../agent/runtime.js";

/**
 * Anti-hallucination caveat (regression: session f59f85f5, 2026-05-29). A
 * source-sensitive product/spec question where the model refused to delegate
 * shipped a wall of invented part numbers as if confirmed. When such an answer
 * is released without research evidence, it must carry an explicit unverified
 * banner so pre-assumptions are not read as facts.
 */
describe("prependUnverifiedSourceCaveat", () => {
  it("prepends a German banner for a German question", () => {
    const out = prependUnverifiedSourceCaveat("Nimm den BQ25895 als Lade-IC.", "ich brauche ein lade-ic für mein gerät");
    expect(out).toMatch(/^>\s*⚠️\s*\*\*Ungeprüft/);
    expect(out).toContain("NICHT mit aktuellen Online-Quellen");
    expect(out).toContain("BQ25895");
  });

  it("prepends an English banner for an English question", () => {
    const out = prependUnverifiedSourceCaveat("Use the BQ25895 charging IC.", "which charging ic should i use");
    expect(out).toMatch(/^>\s*⚠️\s*\*\*Unverified/);
    expect(out).toContain("NOT verified against live web sources");
  });

  it("is idempotent — does not stack the banner", () => {
    const once = prependUnverifiedSourceCaveat("Use the BQ25895.", "which ic");
    const twice = prependUnverifiedSourceCaveat(once, "which ic");
    expect(twice).toBe(once);
  });
});
