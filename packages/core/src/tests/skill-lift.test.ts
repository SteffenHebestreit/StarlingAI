/**
 * LRN-403: lift confidence intervals + deterministic holdout assignment.
 */
import { describe, expect, it } from "vitest";
import { proportionDiffCI, skillLiftDecision } from "../skills/lift.js";
import { holdoutAssignment } from "../skills/service.js";
import type { SkillMeta } from "../skills/store.js";

function meta(uses: number, successes: number, holdoutUses: number, holdoutSuccesses: number): SkillMeta {
  return { uses, successes, holdoutUses, holdoutSuccesses } as SkillMeta;
}

describe("proportionDiffCI (Agresti–Caffo)", () => {
  it("centers near the true difference and narrows with n", () => {
    const small = proportionDiffCI(8, 10, 2, 10);
    const large = proportionDiffCI(80, 100, 20, 100);
    expect(small.estimate).toBeCloseTo(0.6, 5);
    expect(large.estimate).toBeCloseTo(0.6, 5);
    expect(large.high - large.low).toBeLessThan(small.high - small.low);
    expect(large.low).toBeGreaterThan(0); // decisively positive at n=100
  });

  it("a tiny sample yields a wide interval spanning zero even with a large point difference", () => {
    const ci = proportionDiffCI(3, 4, 1, 4);
    expect(ci.estimate).toBeCloseTo(0.5, 5);
    expect(ci.low).toBeLessThan(0);
  });
});

describe("skillLiftDecision", () => {
  it("returns null below the per-arm minimum", () => {
    expect(skillLiftDecision(meta(10, 8, 4, 2), { minSamplesPerArm: 5 })).toBeNull();
    expect(skillLiftDecision(meta(4, 4, 10, 2), { minSamplesPerArm: 5 })).toBeNull();
  });

  it("is indecisive when the CI spans zero and decisive when it excludes zero", () => {
    const noisy = skillLiftDecision(meta(6, 4, 5, 5), { minSamplesPerArm: 5 });
    expect(noisy).not.toBeNull();
    expect(noisy!.decisive).toBe(false);

    const harmful = skillLiftDecision(meta(40, 20, 40, 36), { minSamplesPerArm: 5 });
    expect(harmful!.decisive).toBe(true);
    expect(harmful!.ci.high).toBeLessThan(0);

    const helpful = skillLiftDecision(meta(40, 36, 40, 20), { minSamplesPerArm: 5 });
    expect(helpful!.decisive).toBe(true);
    expect(helpful!.ci.low).toBeGreaterThan(0);
  });
});

describe("holdoutAssignment", () => {
  it("is deterministic: the same (session, skill) pair always lands in the same arm", () => {
    for (const slug of ["fable-method", "deploy-runbook", "twin-check"]) {
      const first = holdoutAssignment("session-abc", slug, 0.15);
      for (let i = 0; i < 10; i++) {
        expect(holdoutAssignment("session-abc", slug, 0.15)).toBe(first);
      }
    }
  });

  it("approximates the configured rate across many sessions", () => {
    let held = 0;
    const n = 2000;
    for (let i = 0; i < n; i++) {
      if (holdoutAssignment(`session-${i}`, "fable-method", 0.15)) held++;
    }
    expect(held / n).toBeGreaterThan(0.10);
    expect(held / n).toBeLessThan(0.20);
  });

  it("rate 0 never holds out; different skills get independent assignments", () => {
    expect(holdoutAssignment("s", "any", 0)).toBe(false);
    const assignments = new Set<string>();
    for (let i = 0; i < 50; i++) {
      assignments.add(String(holdoutAssignment("fixed-session", `skill-${i}`, 0.5)));
    }
    expect(assignments.size).toBe(2); // both arms occur across skills for one session
  });
});
