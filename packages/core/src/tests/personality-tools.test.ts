import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("assistant personality tools", () => {
  const dirs: string[] = [];

  beforeAll(async () => {
    await import("../tools/memory.js");
  });

  afterEach(() => {
    delete process.env["SAI_USER_MEMORY_PATH"];
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads the default personality through assistant_personality_view", async () => {
    const userStatePath = mkdtempSync(join(tmpdir(), "starlingai-personality-"));
    const workspacePath = mkdtempSync(join(tmpdir(), "starlingai-personality-workspace-"));
    dirs.push(userStatePath, workspacePath);
    process.env["SAI_USER_MEMORY_PATH"] = userStatePath;

    const { executeTool } = await import("../tools/registry.js");
    const result = await executeTool("assistant_personality_view", {}, {
      sessionId: "session:test",
      workspacePath,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Identity:");
    expect(result.output).toContain("Revision:");
  });

  it("updates and persists the personality through assistant_personality_update", async () => {
    const userStatePath = mkdtempSync(join(tmpdir(), "starlingai-personality-"));
    const workspacePath = mkdtempSync(join(tmpdir(), "starlingai-personality-workspace-"));
    dirs.push(userStatePath, workspacePath);
    process.env["SAI_USER_MEMORY_PATH"] = userStatePath;

    const { executeTool } = await import("../tools/registry.js");
    const updateResult = await executeTool("assistant_personality_update", {
      identity: "A blunt but useful systems partner.",
      tone: ["Frank without being hostile."],
      defaults: ["Lead with the constraint before the implementation details."],
      avoidances: ["Do not over-explain obvious mechanics."],
      append: true,
      reason: "User wants a slightly sharper voice.",
    }, {
      sessionId: "session:test",
      workspacePath,
    });

    expect(updateResult.success).toBe(true);
    expect(updateResult.output).toContain("updated to revision");

    const readResult = await executeTool("assistant_personality_view", {}, {
      sessionId: "session:test",
      workspacePath,
    });

    expect(readResult.success).toBe(true);
    expect(readResult.output).toContain("A blunt but useful systems partner.");
    expect(readResult.output).toContain("Frank without being hostile.");
    expect(readResult.output).toContain("Lead with the constraint before the implementation details.");
    expect(readResult.output).toContain("Do not over-explain obvious mechanics.");
  });
});