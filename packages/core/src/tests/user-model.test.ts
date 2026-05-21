import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatUserModelGuidance,
  loadUserModel,
  resetUserModelForTests,
  updateUserModel,
} from "../user-model/service.js";

describe("dialectic user model", () => {
  let prevPath: string | undefined;

  beforeEach(() => {
    prevPath = process.env["SAI_USER_MEMORY_PATH"];
    process.env["SAI_USER_MEMORY_PATH"] = mkdtempSync(join(tmpdir(), "starlingai-usermodel-"));
    resetUserModelForTests();
  });

  afterEach(() => {
    const dir = process.env["SAI_USER_MEMORY_PATH"];
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (prevPath === undefined) delete process.env["SAI_USER_MEMORY_PATH"];
    else process.env["SAI_USER_MEMORY_PATH"] = prevPath;
  });

  it("starts empty and produces no guidance", () => {
    const profile = loadUserModel();
    expect(profile.goals).toEqual([]);
    expect(formatUserModelGuidance()).toBe("");
  });

  it("records and replaces inferences, bumping revision", () => {
    const first = updateUserModel({ goals: ["Ship the swarm upgrade"], expertise: ["TypeScript", "agent systems"] });
    expect(first.revision).toBe(2);
    expect(first.goals).toEqual(["Ship the swarm upgrade"]);

    const second = updateUserModel({ goals: ["Ship v1.0"] });
    expect(second.revision).toBe(3);
    expect(second.goals).toEqual(["Ship v1.0"]); // replaced, not appended
    expect(second.expertise).toEqual(["TypeScript", "agent systems"]); // untouched
  });

  it("appends when append=true", () => {
    updateUserModel({ communication: ["Prefers terse answers"] });
    const result = updateUserModel({ communication: ["Wants tradeoffs first"], append: true });
    expect(result.communication).toEqual(["Prefers terse answers", "Wants tradeoffs first"]);
  });

  it("formats guidance with dialectic open questions when populated", () => {
    updateUserModel({
      goals: ["Improve swarm architecture"],
      workingStyle: ["Biggest-win first"],
      openQuestions: ["Does the user prefer German or English summaries?"],
    });
    const guidance = formatUserModelGuidance();
    expect(guidance).toContain("## User Model");
    expect(guidance).toContain("Goals:");
    expect(guidance).toContain("Open questions:");
    expect(guidance).toContain("German or English");
  });

  it("rejects empty updates", () => {
    expect(() => updateUserModel({})).toThrow();
  });
});
