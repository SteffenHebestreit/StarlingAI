/**
 * EVL-402: pack framework — manifest validation + vitest→envelope mapping.
 */
import { describe, expect, it } from "vitest";
import { validatePackManifest, vitestJsonToUnifiedReport, type EvalPackDefinition } from "../agent/eval-packs.js";

const PACK: EvalPackDefinition = { name: "race", kind: "deterministic", testFiles: ["src/tests/task-lease.test.ts"] };

describe("validatePackManifest", () => {
  it("accepts a well-formed manifest", () => {
    const m = validatePackManifest({ packs: [PACK, { name: "fable", kind: "live", plan: "agent-eval.jsonc" }] });
    expect(m.packs).toHaveLength(2);
  });

  it("rejects a deterministic pack without test files, a bad kind, and a missing name", () => {
    expect(() => validatePackManifest({ packs: [{ name: "x", kind: "deterministic" }] })).toThrow(/testFiles/);
    expect(() => validatePackManifest({ packs: [{ name: "x", kind: "weekly" }] })).toThrow(/invalid kind/);
    expect(() => validatePackManifest({ packs: [{ kind: "live" }] })).toThrow(/name/);
    expect(() => validatePackManifest({ nope: true })).toThrow(/packs/);
  });
});

describe("vitestJsonToUnifiedReport", () => {
  it("maps green files to passed cases with pass counts and stable relative names", () => {
    const report = vitestJsonToUnifiedReport(PACK, {
      success: true,
      testResults: [{
        name: "F:\\AI\\StarlingAI\\packages\\core\\src\\tests\\task-lease.test.ts",
        status: "passed", startTime: 1000, endTime: 3500,
        assertionResults: [
          { status: "passed", fullName: "lease > acquires" },
          { status: "passed", fullName: "lease > fences" },
        ],
      }],
    }, { workspacePath: "/repo" });
    expect(report.harness).toBe("pack");
    expect(report.suite).toBe("race");
    expect(report.summary).toMatchObject({ total: 1, passed: 1, failed: 0, errored: 0 });
    expect(report.environment.suspect).toBe(false);
    expect(report.cases[0]).toMatchObject({
      name: "src/tests/task-lease.test.ts", subject: "race", status: "passed",
      durationMs: 2500, attempts: 2, passCount: 2,
    });
  });

  it("maps failed assertions into case failures with the first message line", () => {
    const report = vitestJsonToUnifiedReport(PACK, {
      testResults: [{
        name: "/repo/packages/core/src/tests/task-lease.test.ts", status: "failed",
        assertionResults: [
          { status: "passed", fullName: "lease > acquires" },
          { status: "failed", fullName: "lease > fences", failureMessages: ["AssertionError: expected 2 to be 3\n  at …"] },
        ],
      }],
    }, { workspacePath: "/repo" });
    expect(report.summary.failed).toBe(1);
    expect(report.environment.suspect).toBe(false);
    expect(report.cases[0]?.failures[0]).toContain("lease > fences");
    expect(report.cases[0]?.failures[0]).toContain("expected 2 to be 3");
    expect(report.cases[0]?.failures[0]).not.toContain("at …");
  });

  it("a file that crashed before running is an ERROR case and flags the environment", () => {
    const report = vitestJsonToUnifiedReport(PACK, {
      testResults: [{ name: "x.test.ts", status: "failed", assertionResults: [] }],
    }, { workspacePath: "/repo" });
    expect(report.cases[0]?.status).toBe("error");
    expect(report.environment.suspect).toBe(true);
    expect(report.environment.reasons.some((r) => r.includes("crashed before running"))).toBe(true);
  });

  it("an empty result set is environment-suspect, never a green run", () => {
    const report = vitestJsonToUnifiedReport(PACK, { testResults: [] }, { workspacePath: "/repo" });
    expect(report.summary.total).toBe(0);
    expect(report.environment.suspect).toBe(true);
  });
});
