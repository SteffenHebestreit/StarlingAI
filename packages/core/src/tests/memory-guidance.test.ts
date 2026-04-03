import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendOutcome } from "../agent/outcomes.js";
import { appendFlowMemoryEntry } from "../agent/flow-memory.js";
import { formatScopedMemoryGuidance, storeUserMemoryRecord, storeWorkspaceMemoryRecord } from "../memory/service.js";
import { resetSharedMemoryForTests, writeSharedFact } from "../swarm/memory.js";

describe("memory guidance", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    delete process.env["SAI_USER_MEMORY_PATH"];
    await resetSharedMemoryForTests();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("formats scoped memory guidance across session, workspace, and agent memory", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "starlingai-memory-guidance-"));
    const userMemoryPath = mkdtempSync(join(tmpdir(), "starlingai-user-memory-guidance-"));
    dirs.push(workspacePath, userMemoryPath);
    process.env["SAI_USER_MEMORY_PATH"] = userMemoryPath;

    storeWorkspaceMemoryRecord(workspacePath, {
      key: "quality_goal",
      content: "Prefer retrieval precision over raw memory volume.",
      kind: "decision",
      tags: ["memory", "quality"],
    });
    await writeSharedFact("parent-session", "current_focus", "Improve memory quality during this session.");
    appendOutcome(workspacePath, {
      ts: "2026-04-01T10:00:00.000Z",
      agent: "productivity_agent",
      task: "Design memory recall",
      outcome: "success",
      iterations: 2,
      totalTokens: 900,
      lesson: "Use scope filters before semantic recall.",
    });
    appendFlowMemoryEntry(workspacePath, {
      ts: "2026-04-01T11:00:00.000Z",
      scope: "workflow",
      request: "Improve prompt recall quality",
      summary: "Budgeting memory snippets kept prompt quality high.",
      assistantAgent: "planner",
      targetAgent: "productivity_agent",
      actions: ["inject short scoped memory guidance"],
      outcome: "success",
      lesson: "Keep memory snippets compact.",
      tags: ["memory", "prompt"],
    });
    storeUserMemoryRecord(workspacePath, {
      key: "response_style",
      content: "Prefer concise answers when discussing memory quality unless the user explicitly asks for more detail.",
      kind: "preference",
      tags: ["style", "user"],
    });

    const guidance = await formatScopedMemoryGuidance(workspacePath, "memory quality", {
      sessionId: "parent-session",
      targetAgent: "productivity_agent",
      scopes: ["session", "workspace", "user", "agent"],
      limit: 5,
      maxChars: 900,
    });

    expect(guidance).toContain("Relevant Memory");
    expect(guidance).toContain("[workspace/decision]");
    expect(guidance).toContain("[user/preference]");
    expect(guidance).toContain("[session/fact]");
    expect(guidance).toContain("[agent/lesson]");
  });

  it("respects the maxChars budget", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "starlingai-memory-guidance-"));
    dirs.push(workspacePath);

    storeWorkspaceMemoryRecord(workspacePath, {
      key: "very_long_note",
      content: "A".repeat(2_000),
      kind: "note",
      tags: ["memory"],
    });

    const guidance = await formatScopedMemoryGuidance(workspacePath, "memory", {
      scopes: ["workspace"],
      limit: 4,
      maxChars: 240,
    });

    expect(guidance.length).toBeLessThanOrEqual(240);
  });
});