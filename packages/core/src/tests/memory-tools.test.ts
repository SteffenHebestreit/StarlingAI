import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendOutcome } from "../agent/outcomes.js";
import { resetSharedMemoryForTests, writeSharedFact } from "../swarm/memory.js";

describe("memory tools", () => {
  const dirs: string[] = [];

  beforeAll(async () => {
    await import("../tools/memory.js");
  });

  afterEach(async () => {
    delete process.env["SAI_USER_MEMORY_PATH"];
    await resetSharedMemoryForTests();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("searches across workspace and session memory through memory_search", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "starlingai-memory-tools-"));
    dirs.push(workspacePath);

    const { executeTool } = await import("../tools/registry.js");
    await executeTool("memory_store", {
      key: "project_focus",
      content: "Optimize retrieval precision before adding more memory volume.",
      kind: "decision",
      tags: ["memory", "quality"],
    }, {
      sessionId: "sub:parent-session:productivity_agent:1",
      workspacePath,
    });
    await writeSharedFact("sub:parent-session", "active_focus", "Optimize retrieval precision in this session.");

    const result = await executeTool("memory_search", {
      query: "retrieval precision",
      scopes: ["workspace", "session"],
    }, {
      sessionId: "sub:parent-session:productivity_agent:1",
      workspacePath,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("[workspace/decision]");
    expect(result.output).toContain("[session/fact]");
  });

  it("surfaces agent lessons through memory_search when filtering agent scope", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "starlingai-memory-tools-"));
    dirs.push(workspacePath);

    appendOutcome(workspacePath, {
      ts: "2026-04-01T12:00:00.000Z",
      agent: "browser_agent",
      task: "Avoid browser loops",
      outcome: "success",
      iterations: 2,
      totalTokens: 800,
      lesson: "Stop retrying when the page state is stable and the needed evidence is already visible.",
    });

    const { executeTool } = await import("../tools/registry.js");
    const result = await executeTool("memory_search", {
      query: "browser loops",
      scopes: ["agent"],
      targetAgent: "browser_agent",
      kinds: ["lesson"],
    }, {
      sessionId: "sub:parent-session:planner:1",
      workspacePath,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("[agent/lesson]");
    expect(result.output).toContain("browser loops");
  });

  it("promotes session memory into durable workspace memory through memory_promote", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "starlingai-memory-tools-"));
    dirs.push(workspacePath);

    await writeSharedFact("sub:parent-session", "meeting_notes", "Summarize and keep only the action items.");

    const { executeTool } = await import("../tools/registry.js");
    const promoteResult = await executeTool("memory_promote", {
      query: "action items",
      scopes: ["session"],
    }, {
      sessionId: "sub:parent-session:productivity_agent:1",
      workspacePath,
    });

    expect(promoteResult.success).toBe(true);
    expect(promoteResult.output).toContain("Workspace memory promotion completed");

    const searchResult = await executeTool("memory_search", {
      query: "action items",
      scopes: ["workspace"],
    }, {
      sessionId: "sub:parent-session:productivity_agent:1",
      workspacePath,
    });

    expect(searchResult.success).toBe(true);
    expect(searchResult.output).toContain("[workspace/fact]");
  });

  it("compacts paraphrased durable memory through memory_compact", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "starlingai-memory-tools-"));
    dirs.push(workspacePath);

    const { executeTool } = await import("../tools/registry.js");
    await executeTool("memory_store", {
      key: "quality_summary",
      subject: "Quality goal",
      content: "Prefer retrieval precision over raw memory volume.",
      kind: "summary",
    }, {
      sessionId: "sub:parent-session:productivity_agent:1",
      workspacePath,
    });
    await executeTool("memory_store", {
      key: "quality_detail",
      subject: "Quality goal",
      content: "Keep durable memory focused on retrieval precision instead of accumulating every temporary note.",
      kind: "decision",
    }, {
      sessionId: "sub:parent-session:productivity_agent:1",
      workspacePath,
    });

    const result = await executeTool("memory_compact", {}, {
      sessionId: "sub:parent-session:productivity_agent:1",
      workspacePath,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Removed: 1");

    const searchResult = await executeTool("memory_search", {
      query: "temporary note",
      scopes: ["workspace"],
    }, {
      sessionId: "sub:parent-session:productivity_agent:1",
      workspacePath,
    });

    expect(searchResult.success).toBe(true);
    expect(searchResult.output).toContain("[workspace/decision]");
    expect(searchResult.output).toContain("retrieval precision");
  });

  it("stores and searches user-global memory through memory_store and memory_search", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "starlingai-memory-tools-"));
    const userMemoryPath = mkdtempSync(join(tmpdir(), "starlingai-user-memory-tools-"));
    dirs.push(workspacePath, userMemoryPath);
    process.env["SAI_USER_MEMORY_PATH"] = userMemoryPath;

    const { executeTool } = await import("../tools/registry.js");
    const storeResult = await executeTool("memory_store", {
      key: "response_style",
      subject: "Response style",
      content: "Prefer terse answers unless the user explicitly asks for depth.",
      kind: "preference",
      scope: "user",
    }, {
      sessionId: "sub:parent-session:productivity_agent:1",
      workspacePath,
    });

    expect(storeResult.success).toBe(true);
    expect(storeResult.output).toContain("User memory stored");

    const searchResult = await executeTool("memory_search", {
      query: "terse answers",
      scopes: ["user"],
    }, {
      sessionId: "sub:parent-session:productivity_agent:1",
      workspacePath,
    });

    expect(searchResult.success).toBe(true);
    expect(searchResult.output).toContain("[user/preference]");
  });

  it("promotes workspace memory into user-global memory through memory_promote", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "starlingai-memory-tools-"));
    const userMemoryPath = mkdtempSync(join(tmpdir(), "starlingai-user-memory-tools-"));
    dirs.push(workspacePath, userMemoryPath);
    process.env["SAI_USER_MEMORY_PATH"] = userMemoryPath;

    const { executeTool } = await import("../tools/registry.js");
    await executeTool("memory_store", {
      key: "writing_style",
      subject: "Writing style",
      content: "The user prefers concise answers with direct next steps.",
      kind: "preference",
    }, {
      sessionId: "sub:parent-session:productivity_agent:1",
      workspacePath,
    });

    const promoteResult = await executeTool("memory_promote", {
      query: "concise answers",
      scopes: ["workspace"],
      destinationScope: "user",
    }, {
      sessionId: "sub:parent-session:productivity_agent:1",
      workspacePath,
    });

    expect(promoteResult.success).toBe(true);
    expect(promoteResult.output).toContain("User memory promotion completed");

    const searchResult = await executeTool("memory_search", {
      query: "concise answers",
      scopes: ["user"],
    }, {
      sessionId: "sub:parent-session:productivity_agent:1",
      workspacePath,
    });

    expect(searchResult.success).toBe(true);
    expect(searchResult.output).toContain("[user/preference]");
  });
});