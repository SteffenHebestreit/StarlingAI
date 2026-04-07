import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { flushAuditLog, logAudit } from "../audit/logger.js";
import { buildSessionDebugMarkdown } from "../agent/debug-session-export.js";
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
  });
});