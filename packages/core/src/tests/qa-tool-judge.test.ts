import { describe, expect, it, vi } from "vitest";
import {
  collectJudgeableArtifactRefs,
  buildQaToolJudgeTask,
  runQaToolJudgeCheck,
  QA_TOOL_JUDGE_TOOLS,
} from "../agent/qa-tool-judge.js";

const CRITERIA = ["app loads without errors", "quiz has 10 questions"];

describe("qa-tool-judge — artifact ref collection (pure)", () => {
  it("maps file paths and external URLs, skipping directories and empty attachments", () => {
    const refs = collectJudgeableArtifactRefs([
      { filename: "quiz.html", relativePath: "apps/quiz.html" },
      { filename: "served", externalUrl: "http://localhost:8080/api/app/x1/" },
      { filename: "outdir", relativePath: "apps/", isDirectory: true },
      { filename: "ghost" }, // neither path nor URL
    ]);
    expect(refs).toEqual([
      { kind: "file", location: "apps/quiz.html" },
      { kind: "url", location: "http://localhost:8080/api/app/x1/" },
    ]);
  });

  it("dedupes by location and caps the ref count", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ filename: `f${i}`, relativePath: `out/f${i % 8}.md` }));
    const refs = collectJudgeableArtifactRefs(many);
    expect(refs.length).toBeLessThanOrEqual(6);
    expect(new Set(refs.map((r) => r.location)).size).toBe(refs.length);
  });
});

describe("qa-tool-judge — task builder (pure)", () => {
  it("instructs inspection of every ref with the matching tool and demands the evidence verdict", () => {
    const task = buildQaToolJudgeTask("the answer", CRITERIA, [
      { kind: "file", location: "apps/quiz.html" },
      { kind: "url", location: "http://localhost:8080/x" },
    ]);
    expect(task).toContain("FILE: apps/quiz.html");
    expect(task).toContain("read_file");
    expect(task).toContain("URL: http://localhost:8080/x");
    expect(task).toContain("verify_app");
    expect(task).toContain("PASS — evidence:");
    expect(task).toContain("1. app loads without errors");
    expect(task).toContain("Never PASS on the answer's own claims");
  });
});

describe("qa-tool-judge — check wrapper (DI runner, no module mocks)", () => {
  const REFS = [{ kind: "file" as const, location: "apps/quiz.html" }];

  it("parses an evidence-backed PASS from the judge into a trusted verdict", async () => {
    const runner = vi.fn(async () => "PASS — evidence: read_file shows quiz.html ends with </html> and defines 10 question objects");
    const v = await runQaToolJudgeCheck("answer", CRITERIA, REFS, runner);
    expect(v.pass).toBe(true);
    expect(v.evidence).toContain("10 question objects");
    // The runner gets the read-only tool set
    expect(runner).toHaveBeenCalledWith(expect.stringContaining("FILE: apps/quiz.html"), QA_TOOL_JUDGE_TOOLS);
  });

  it("parses an observed-defect FAIL with flaws", async () => {
    const v = await runQaToolJudgeCheck("answer", CRITERIA, REFS, async () =>
      "FAIL: quiz.html ends mid-<script> with no closing tag — criterion 1 unmet");
    expect(v.pass).toBe(false);
    expect(v.flaws).toContain("mid-<script>");
  });

  it("throws (caller falls back to prose check) on no refs or an empty verdict", async () => {
    await expect(runQaToolJudgeCheck("a", CRITERIA, [], async () => "PASS")).rejects.toThrow(/no inspectable/);
    await expect(runQaToolJudgeCheck("a", CRITERIA, REFS, async () => "   ")).rejects.toThrow(/empty verdict/);
  });

  it("a judge that never inspected anything yields a bare PASS — no evidence (requireEvidence downgrades it)", async () => {
    const v = await runQaToolJudgeCheck("a", CRITERIA, REFS, async () => "PASS");
    expect(v.pass).toBe(true);
    expect(v.evidence).toBeUndefined();
  });

  it("fable 6b: the inspection task carries the SCOPE and DEBRIS fraud rows without new verdict words", () => {
    const task = buildQaToolJudgeTask("answer", CRITERIA, [{ kind: "file", location: "app/index.html" }]);
    expect(task).toMatch(/SCOPE/);
    expect(task).toMatch(/DEBRIS/);
    // The gate's parser only understands PASS/FAIL — the fraud rows must not
    // introduce verdict vocabulary like VERIFIED/REFUTED.
    expect(task).not.toMatch(/VERIFIED|REFUTED/);
  });
});
