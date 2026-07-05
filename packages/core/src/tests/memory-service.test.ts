import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendOutcome } from "../agent/outcomes.js";
import { appendFlowMemoryEntry } from "../agent/flow-memory.js";
import {
  compactUserMemoryRecords,
  compactWorkspaceMemoryRecords,
  deleteUserMemoryRecord,
  deleteWorkspaceMemoryRecord,
  listUserMemoryRecords,
  listWorkspaceMemoryRecords,
  promoteMemoryRecords,
  searchMemoryRecords,
  storeUserMemoryRecord,
  storeWorkspaceMemoryRecord,
  updateUserMemoryRecord,
  updateWorkspaceMemoryRecord,
} from "../memory/service.js";
import { resetSharedMemoryForTests, writeSharedFact } from "../swarm/memory.js";

describe("memory service", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    delete process.env["SAI_USER_MEMORY_PATH"];
    await resetSharedMemoryForTests();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stores workspace memory records with typed metadata", () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "starlingai-memory-service-"));
    dirs.push(workspacePath);

    const record = storeWorkspaceMemoryRecord(workspacePath, {
      key: "project_goals",
      subject: "Project goals",
      content: "Keep latency low and retrieval precision high.",
      tags: ["architecture", "quality"],
      kind: "decision",
    });

    expect(record.scope).toBe("workspace");
    expect(record.kind).toBe("decision");
    expect(record.subject).toBe("Project goals");
  });

  it("stores and retrieves user-global durable memory records", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "starlingai-memory-service-"));
    const userMemoryPath = mkdtempSync(join(tmpdir(), "starlingai-user-memory-"));
    dirs.push(workspacePath, userMemoryPath);
    process.env["SAI_USER_MEMORY_PATH"] = userMemoryPath;

    const record = storeUserMemoryRecord(workspacePath, {
      key: "response_style",
      subject: "Response style",
      content: "Prefer terse answers unless the user explicitly asks for depth.",
      kind: "preference",
      tags: ["style", "user"],
    });

    expect(record.scope).toBe("user");

    const results = await searchMemoryRecords(workspacePath, "terse answers", {
      scopes: ["user"],
      limit: 5,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.scope).toBe("user");
    expect(results[0]?.kind).toBe("preference");
  });

  it("searches across workspace, session, and agent memory scopes", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "starlingai-memory-service-"));
    dirs.push(workspacePath);

    storeWorkspaceMemoryRecord(workspacePath, {
      key: "prompt_strategy",
      content: "Prefer short prompts with explicit retrieval filters.",
      tags: ["prompt", "quality"],
      kind: "decision",
    });
    await writeSharedFact("sub:parent-session", "active_focus", "Need the best retrieval quality for memory search.");
    appendOutcome(workspacePath, {
      ts: "2026-04-01T10:00:00.000Z",
      agent: "browser_agent",
      task: "Reduce repetitive loops",
      outcome: "success",
      iterations: 3,
      totalTokens: 1200,
      lesson: "Stable page state is a stop signal once the needed evidence is visible.",
    });
    appendFlowMemoryEntry(workspacePath, {
      ts: "2026-04-01T11:00:00.000Z",
      scope: "workflow",
      request: "Improve memory retrieval quality",
      summary: "Summarizing session findings before promotion improved retrieval precision.",
      assistantAgent: "planner",
      targetAgent: "productivity_agent",
      actions: ["promote only distilled facts"],
      outcome: "success",
      lesson: "Promote by usefulness, not by existence.",
      tags: ["memory", "retrieval"],
    });

    const results = await searchMemoryRecords(workspacePath, "retrieval quality", {
      sessionId: "sub:parent-session",
      limit: 6,
    });

    expect(results.map((entry) => entry.scope)).toContain("workspace");
    expect(results.map((entry) => entry.scope)).toContain("session");
    expect(results.map((entry) => entry.scope)).toContain("agent");
  });

  it("promotes session and agent memory into durable workspace memory with deduplication", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "starlingai-memory-service-"));
    dirs.push(workspacePath);

    storeWorkspaceMemoryRecord(workspacePath, {
      key: "quality_goal",
      subject: "Quality goal",
      content: "Prefer retrieval precision over raw memory volume.",
      kind: "decision",
      tags: ["quality"],
    });
    await writeSharedFact("sub:parent-session", "quality_goal", "Prefer retrieval precision over raw memory volume.");
    appendOutcome(workspacePath, {
      ts: "2026-04-01T12:00:00.000Z",
      agent: "productivity_agent",
      task: "Memory quality",
      outcome: "success",
      iterations: 1,
      totalTokens: 600,
      lesson: "Promote only distilled facts.",
    });

    const result = await promoteMemoryRecords(workspacePath, "quality", {
      sessionId: "sub:parent-session",
      scopes: ["session", "agent"],
      maxPromotions: 5,
    });

    expect(result.merged.length + result.promoted.length).toBeGreaterThan(0);

    const workspaceResults = await searchMemoryRecords(workspacePath, "quality", {
      scopes: ["workspace"],
      limit: 10,
    });
    expect(workspaceResults.length).toBeGreaterThan(0);
    expect(
      workspaceResults.some((record) =>
        record.content.includes("retrieval precision")
        && record.content.includes("raw memory volume"),
      ),
    ).toBe(true);
    expect(
      workspaceResults.some((record) => record.content.includes("Promote only distilled facts")),
    ).toBe(true);
  });

  it("compacts near-duplicate workspace memory records and folds summaries into the canonical record", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "starlingai-memory-service-"));
    dirs.push(workspacePath);

    storeWorkspaceMemoryRecord(workspacePath, {
      key: "quality_summary",
      subject: "Quality goal",
      content: "Prefer retrieval precision over raw memory volume.",
      kind: "summary",
      tags: ["quality"],
    });
    storeWorkspaceMemoryRecord(workspacePath, {
      key: "quality_detail",
      subject: "Quality goal",
      content: "Keep durable memory focused on retrieval precision instead of accumulating every temporary note.",
      kind: "decision",
      tags: ["memory", "performance"],
    });
    storeWorkspaceMemoryRecord(workspacePath, {
      key: "shutdown_cleanup",
      subject: "Shutdown cleanup",
      content: "Stop reminders and timers during shutdown.",
      kind: "fact",
      tags: ["runtime"],
    });

    const result = compactWorkspaceMemoryRecords(workspacePath);
    expect(result.removed).toBe(1);
    expect(result.merged).toBe(1);

    const workspaceResults = await searchMemoryRecords(workspacePath, "temporary note", {
      scopes: ["workspace"],
      limit: 10,
    });
    expect(workspaceResults.length).toBeGreaterThan(0);
    expect(
      workspaceResults.some((record) =>
        record.content.includes("Prefer retrieval precision over raw memory volume")
        && record.content.includes("temporary note"),
      ),
    ).toBe(true);
  });

  it("promotes workspace memory into user-global durable memory", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "starlingai-memory-service-"));
    const userMemoryPath = mkdtempSync(join(tmpdir(), "starlingai-user-memory-"));
    dirs.push(workspacePath, userMemoryPath);
    process.env["SAI_USER_MEMORY_PATH"] = userMemoryPath;

    storeWorkspaceMemoryRecord(workspacePath, {
      key: "writing_style",
      subject: "Writing style",
      content: "The user prefers concise answers with direct next steps.",
      kind: "preference",
      tags: ["style", "workspace"],
    });

    const result = await promoteMemoryRecords(workspacePath, "concise answers", {
      scopes: ["workspace"],
      destinationScope: "user",
      maxPromotions: 3,
    });

    expect(result.destinationScope).toBe("user");
    expect(result.promoted.length + result.merged.length).toBeGreaterThan(0);

    const userResults = await searchMemoryRecords(workspacePath, "concise answers", {
      scopes: ["user"],
      limit: 5,
    });

    expect(userResults.length).toBeGreaterThan(0);
    expect(userResults[0]?.scope).toBe("user");
  });

  it("compacts duplicate user-global durable memory records", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "starlingai-memory-service-"));
    const userMemoryPath = mkdtempSync(join(tmpdir(), "starlingai-user-memory-"));
    dirs.push(workspacePath, userMemoryPath);
    process.env["SAI_USER_MEMORY_PATH"] = userMemoryPath;

    storeUserMemoryRecord(workspacePath, {
      key: "pref_one",
      subject: "Response style",
      content: "Prefer terse answers unless more detail is requested.",
      kind: "preference",
      tags: ["user"],
    });
    storeUserMemoryRecord(workspacePath, {
      key: "pref_two",
      subject: "Response style",
      content: "Prefer terse answers unless the user asks for more detail.",
      kind: "preference",
      tags: ["style"],
    });

    const result = compactUserMemoryRecords(workspacePath);
    expect(result.scope).toBe("user");
    expect(result.removed).toBe(1);
  });

  it("edits a workspace memory record in place and reflects it in the listing", () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "starlingai-memory-service-"));
    dirs.push(workspacePath);

    storeWorkspaceMemoryRecord(workspacePath, {
      key: "deploy_target",
      subject: "Deploy target",
      content: "Ship to the homelab box.",
      kind: "note",
      tags: ["ops"],
    });

    const updated = updateWorkspaceMemoryRecord(workspacePath, "deploy_target", {
      content: "Ship to the managed cloud cluster instead.",
      tags: ["ops", "cloud"],
      subject: "Deploy target (revised)",
    });

    expect(updated).not.toBeNull();
    expect(updated?.content).toBe("Ship to the managed cloud cluster instead.");
    expect(updated?.subject).toBe("Deploy target (revised)");
    expect(updated?.tags).toEqual(["ops", "cloud"]);

    // The read path (what the memory page consumes) must show the edited value.
    const listed = listWorkspaceMemoryRecords(workspacePath);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.content).toBe("Ship to the managed cloud cluster instead.");
    expect(listed[0]?.key).toBe("deploy_target");
  });

  it("returns null when editing a memory key that does not exist", () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "starlingai-memory-service-"));
    dirs.push(workspacePath);

    const missing = updateWorkspaceMemoryRecord(workspacePath, "nope", { content: "x" });
    expect(missing).toBeNull();
  });

  it("deletes a workspace memory record and removes it from the listing", () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "starlingai-memory-service-"));
    dirs.push(workspacePath);

    storeWorkspaceMemoryRecord(workspacePath, {
      key: "throwaway",
      subject: "Throwaway",
      content: "This should be deletable.",
      kind: "note",
    });
    expect(listWorkspaceMemoryRecords(workspacePath)).toHaveLength(1);

    const deleted = deleteWorkspaceMemoryRecord(workspacePath, "throwaway");
    expect(deleted).toBe(true);
    expect(listWorkspaceMemoryRecords(workspacePath)).toHaveLength(0);

    // Deleting again is a no-op that reports nothing was removed.
    expect(deleteWorkspaceMemoryRecord(workspacePath, "throwaway")).toBe(false);
  });

  it("deletes a user-scoped memory record via the user store path", () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "starlingai-memory-service-"));
    const userMemoryPath = mkdtempSync(join(tmpdir(), "starlingai-user-memory-"));
    dirs.push(workspacePath, userMemoryPath);
    process.env["SAI_USER_MEMORY_PATH"] = userMemoryPath;

    storeUserMemoryRecord(workspacePath, {
      key: "temp_pref",
      subject: "Temp preference",
      content: "Delete me from the user store.",
      kind: "preference",
    });
    expect(listUserMemoryRecords(workspacePath)).toHaveLength(1);

    // Edit through the user-scoped path before deleting.
    const edited = updateUserMemoryRecord(workspacePath, "temp_pref", {
      content: "Actually keep me a moment longer.",
    });
    expect(edited?.content).toBe("Actually keep me a moment longer.");
    expect(listUserMemoryRecords(workspacePath)[0]?.content).toBe("Actually keep me a moment longer.");

    expect(deleteUserMemoryRecord(workspacePath, "temp_pref")).toBe(true);
    expect(listUserMemoryRecords(workspacePath)).toHaveLength(0);
  });
});