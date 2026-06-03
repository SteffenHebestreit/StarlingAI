import { afterEach, describe, expect, it, vi } from "vitest";

// Mock the chat provider so we can script the orchestrator's tool-call sequence.
const streamMock = vi.hoisted(() => vi.fn());
const completeMock = vi.hoisted(() => vi.fn(async () => ({
  content: "done",
  tool_calls: [],
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  finishReason: "stop",
})));

vi.mock("../providers/index.js", () => {
  const provider = {
    checkHealth: async () => ({ healthy: true }),
    verifyToolCallSupport: async () => true,
    complete: (...args: Parameters<typeof completeMock>) => completeMock(...args),
    stream: (...args: Parameters<typeof streamMock>) => streamMock(...args),
    embed: async () => [],
    isHealthy: () => true,
  };
  return {
    getChatProvider: () => provider,
    getChatProviderWithOverride: () => provider,
    getChatProviderForTier: () => null,
  };
});

vi.mock("../guardrails/rate-limiter.js", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));

vi.mock("../guardrails/input.js", () => ({
  checkInput: vi.fn(() => ({ allowed: true, detectedPatterns: [] })),
  checkToolOutput: vi.fn(() => ({ allowed: true })),
}));

vi.mock("../guardrails/moderation.js", () => ({
  moderateInputText: vi.fn(async () => null),
  moderateToolResultText: vi.fn(async () => null),
}));

vi.mock("../guardrails/output.js", () => ({
  scanOutput: vi.fn((text: string) => ({ safe: true, redacted: text })),
}));

vi.mock("../audit/logger.js", () => ({
  logAudit: vi.fn(),
}));

import { AgentSession, resetSessionsForTests } from "../agent/session.js";
import { logAudit } from "../audit/logger.js";
import { runTurn } from "../agent/runtime.js";
import { resetConfigForTests } from "../config/loader.js";
import { registerTool, unregisterTool } from "../tools/registry.js";

function toolCallStream(callId: string, toolName: string, args: Record<string, unknown>) {
  return (async function* () {
    yield { type: "tool_call_start", toolCallId: callId, toolName };
    yield { type: "tool_call_delta", toolCallId: callId, argumentsDelta: JSON.stringify(args) };
    yield { type: "done", finishReason: "tool_calls", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  })();
}

function textStream(text: string) {
  return (async function* () {
    yield { type: "text_delta", content: text };
    yield { type: "done", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  })();
}

function auditCalls(type: string) {
  return vi.mocked(logAudit).mock.calls.filter(
    (call) => (call[1] as { type?: string } | undefined)?.type === type,
  );
}

afterEach(() => {
  unregisterTool("search_workflows");
  unregisterTool("run_workflow");
  unregisterTool("parallel_delegate");
  streamMock.mockReset();
  completeMock.mockClear();
  vi.mocked(logAudit).mockClear();
  resetConfigForTests();
  resetSessionsForTests();
});

describe("workflow-run force-after-search", () => {
  it("deterministically rewrites a 2nd non-workflow orchestration into run_workflow on a strong match", async () => {
    const STRONG_MATCH = {
      name: "sourced_presentation",
      workflowType: "scene" as const,
      score: 0.74,
      matchedTerms: ["presentation", "bilder", "quellen"],
    };
    const userMessage = "Erstelle eine Präsentation über Dresden mit Bildern und verifizierten Quellen.";

    const runWorkflowExecute = vi.fn(async (args: Record<string, unknown>) => ({
      success: true,
      output: `Workflow ${String(args["name"])} [scene] completed.\n\nThe sourced deck was built with verified local images.`,
      metadata: {
        workflowName: String(args["name"]),
        workflowType: "scene",
        blocked: false,
        // The scene's artifacts must ride up so the parent turn surfaces them
        // (and the auto-build does not re-fire with guessed hotlinks).
        artifacts: [
          { outputPath: "presentation/index.html", filename: "index.html", sourceTool: "delegate_to_agent" },
        ],
      },
    }));
    const parallelDelegateExecute = vi.fn(async () => ({
      success: true,
      output: "delegated (should never run — the force rewrites this away)",
      metadata: { delegationOutcome: "success" },
    }));

    registerTool({
      name: "search_workflows",
      description: "search",
      parameters: { type: "object", properties: {} },
      execute: async () => ({
        success: true,
        output: "Found sourced_presentation [scene].",
        metadata: { workflowMatches: [STRONG_MATCH] },
      }),
    });
    registerTool({
      name: "run_workflow",
      description: "run",
      parameters: { type: "object", properties: {} },
      execute: runWorkflowExecute,
    });
    registerTool({
      name: "parallel_delegate",
      description: "parallel delegate",
      parameters: { type: "object", properties: {} },
      execute: parallelDelegateExecute,
    });

    let call = 0;
    streamMock.mockImplementation(() => {
      call += 1;
      if (call === 1) return toolCallStream("s1", "search_workflows", { query: "presentation" });
      if (call === 2) return toolCallStream("p1", "parallel_delegate", { tasks: [{ agentName: "researcher", task: "research dresden" }] });
      if (call === 3) return toolCallStream("p2", "parallel_delegate", { tasks: [{ agentName: "researcher", task: "research dresden again" }] });
      return textStream("Die belegte Präsentation wurde erstellt.");
    });

    const session = new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "test" });
    const result = await runTurn({ session, userMessage });

    expect(result.blocked).toBe(false);

    // The forced run_workflow ran exactly once, targeting the strong match,
    // with the ORIGINAL user request threaded through as context.
    expect(runWorkflowExecute).toHaveBeenCalledTimes(1);
    const forcedArgs = runWorkflowExecute.mock.calls[0]![0];
    expect(forcedArgs["name"]).toBe("sourced_presentation");
    expect(forcedArgs["workflowType"]).toBe("scene");
    expect(String(forcedArgs["context"])).toContain("Dresden");

    // The model's parallel_delegate never actually executed — the first one was
    // nudged (continue) and the second was rewritten into run_workflow.
    expect(parallelDelegateExecute).not.toHaveBeenCalled();

    // The force was audited, and the soft release path was NOT taken.
    expect(auditCalls("workflow_run_required_after_search")).toHaveLength(1);
    const forced = vi.mocked(logAudit).mock.calls.filter(
      (c) => (c[1] as { reason?: string } | undefined)?.reason === "workflow_run_forced_after_search",
    );
    expect(forced).toHaveLength(1);
    expect(auditCalls("workflow_run_released_after_search")).toHaveLength(0);
  });

  it("releases (does not force again) if the model keeps avoiding the workflow after one forced run", async () => {
    const STRONG_MATCH = {
      name: "sourced_presentation",
      workflowType: "scene" as const,
      score: 0.74,
      matchedTerms: ["presentation", "bilder", "quellen"],
    };

    // run_workflow fails here, so workflowRunCompletedThisTurn stays false and the
    // model is free to pivot back to delegation on the next miss.
    const runWorkflowExecute = vi.fn(async () => ({
      success: false,
      output: "",
      error: "Workflow sourced_presentation [scene] blocked.",
      metadata: { workflowName: "sourced_presentation", workflowType: "scene", blocked: true },
    }));
    const parallelDelegateExecute = vi.fn(async () => ({
      success: true,
      output: "Researched Dresden directly after the workflow failed.",
      metadata: { delegationOutcome: "success" },
    }));

    registerTool({
      name: "search_workflows",
      description: "search",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ success: true, output: "found", metadata: { workflowMatches: [STRONG_MATCH] } }),
    });
    registerTool({
      name: "run_workflow",
      description: "run",
      parameters: { type: "object", properties: {} },
      execute: runWorkflowExecute,
    });
    registerTool({
      name: "parallel_delegate",
      description: "parallel delegate",
      parameters: { type: "object", properties: {} },
      execute: parallelDelegateExecute,
    });

    let call = 0;
    streamMock.mockImplementation(() => {
      call += 1;
      if (call === 1) return toolCallStream("s1", "search_workflows", { query: "presentation" });
      if (call === 2) return toolCallStream("p1", "parallel_delegate", { tasks: [{ agentName: "researcher", task: "a" }] });
      // call 3 → forced into run_workflow (which fails).
      if (call === 3) return toolCallStream("p2", "parallel_delegate", { tasks: [{ agentName: "researcher", task: "b" }] });
      // call 4 → model tries delegation again; already forced once → released → executes.
      if (call === 4) return toolCallStream("p3", "parallel_delegate", { tasks: [{ agentName: "researcher", task: "c" }] });
      return textStream("Ich habe direkt recherchiert, nachdem der Workflow blockiert war.");
    });

    const session = new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "test" });
    const result = await runTurn({ session, userMessage: "Erstelle eine Präsentation über Dresden mit Bildern und Quellen." });

    expect(result.blocked).toBe(false);
    // Forced exactly once.
    expect(runWorkflowExecute).toHaveBeenCalledTimes(1);
    // After the forced run failed and the model pivoted, the release let the
    // delegation run rather than dead-ending or force-looping.
    expect(parallelDelegateExecute).toHaveBeenCalledTimes(1);
    expect(auditCalls("workflow_run_released_after_search")).toHaveLength(1);
  });
});
