import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { flushAuditLog, logAudit } from "../audit/logger.js";
import { buildSessionAuditMarkdown, buildSessionDebugMarkdown } from "../agent/debug-session-export.js";
import { createSession, resetSessionsForTests } from "../agent/session.js";

describe("debug session markdown export", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    await flushAuditLog();
    resetSessionsForTests();
    delete process.env["SAI_AUDIT_LOG"];
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("combines transcript, raw session history, and related audit events", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "starlingai-debug-export-"));
    process.env["SAI_AUDIT_LOG"] = join(tempDir, "audit.jsonl");

    const session = createSession({
      channel: "webchat",
      workspacePath: "/workspace",
      systemPrompt: "You are a debug export test assistant.",
    });

    session.addMessage({ role: "user", content: "Can you show me a chart?" });
    session.addMessage({
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: {
          name: "delegate_to_agent",
          arguments: JSON.stringify({ task: "Find climate data" }),
        },
      }],
    });
    session.addMessage({
      role: "tool",
      content: "Delegated result from ephemeral:climate_data_finder - TASK COMPLETED.\nObserved evidence:\nNo definitive 2025 monthly dataset was found.",
      tool_call_id: "call_1",
      metadata: { agentName: "ephemeral:climate_data_finder" },
    });
    session.incrementTurn();

    logAudit("message_received", { length: 28 }, { sessionId: session.id, channel: "webchat" });
    logAudit("tool_call_completed", { tool: "delegate_to_agent", success: true }, { sessionId: session.id });
    logAudit(
      "sub_agent_started",
      { agentName: "ephemeral:climate_data_finder", parentSessionId: session.id },
      { sessionId: `sub:${session.id}:ephemeral:climate_data_finder:123`, channel: "sub-agent:ephemeral:climate_data_finder" },
    );
    logAudit(
      "sub_agent_tool_call",
      {
        agentName: "ephemeral:climate_data_finder",
        tool: "web_search",
        phase: "done",
        args: { query: "Find climate data" },
        success: true,
        metadata: {
          query: "Find climate data",
          backend: "duckduckgo",
        },
      },
      { sessionId: `sub:${session.id}:ephemeral:climate_data_finder:123` },
    );
    logAudit(
      "sub_agent_tool_call",
      {
        agentName: "ephemeral:climate_data_finder",
        tool: "web_fetch",
        phase: "done",
        args: { url: "https://example.com/climate" },
        success: true,
        metadata: {
          url: "https://example.com/climate",
          fetchMethod: "playwright",
        },
      },
      { sessionId: `sub:${session.id}:ephemeral:climate_data_finder:123` },
    );
    const markdown = await buildSessionDebugMarkdown(session.id);

    expect(markdown).toContain("# StarlingAI Debug Session Export");
    expect(markdown).toContain("## System Prompt");
    expect(markdown).toContain("You are a debug export test assistant.");
    expect(markdown).toContain("## Transcript");
    expect(markdown).toContain("delegate_to_agent");
    expect(markdown).toContain("Tool-only assistant turn.");
    expect(markdown).toContain("Requested tool: delegate_to_agent");
    expect(markdown).toContain("## Raw Session History");
    expect(markdown).toContain("tool_call_id: call_1");
    expect(markdown).toContain("## Audit Events");
    expect(markdown).toContain("message_received");
    expect(markdown).toContain(`sub:${session.id}:ephemeral:climate_data_finder:123`);
    expect(markdown).toContain("Find climate data");
    expect(markdown).toContain("https://example.com/climate");
    expect(markdown).toContain("playwright");
  });

  it("exports a focused audit markdown report without transcript sections", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "starlingai-audit-export-"));
    process.env["SAI_AUDIT_LOG"] = join(tempDir, "audit.jsonl");

    const session = createSession({
      channel: "webchat",
      workspacePath: "/workspace",
      systemPrompt: "You are an audit export test assistant.",
    });

    logAudit("message_received", { length: 18 }, { sessionId: session.id, channel: "webchat" });
    logAudit(
      "sub_agent_tool_call",
      {
        agentName: "audit_specialist",
        tool: "search_workflows",
        phase: "done",
        args: { query: "audit markdown export" },
        success: true,
        metadata: {
          query: "audit markdown export",
          backend: "local-catalog",
        },
      },
      { sessionId: `sub:${session.id}:audit_specialist:123` },
    );

    const markdown = await buildSessionAuditMarkdown(session.id);

    expect(markdown).toContain("# StarlingAI Session Audit Export");
    expect(markdown).toContain("## Audit Events");
    expect(markdown).toContain("message_received");
    expect(markdown).toContain("search_workflows");
    expect(markdown).toContain("audit markdown export");
    expect(markdown).toContain(`sub:${session.id}:audit_specialist:123`);
    expect(markdown).not.toContain("## Transcript");
    expect(markdown).not.toContain("## Raw Session History");
  });
});