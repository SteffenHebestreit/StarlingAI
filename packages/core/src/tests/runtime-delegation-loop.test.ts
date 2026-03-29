import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const streamMock = vi.hoisted(() => vi.fn());
const completeMock = vi.hoisted(() => vi.fn(async () => ({
  content: "synthesized",
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
import { runTurn } from "../agent/runtime.js";
import { registerTool, unregisterTool } from "../tools/registry.js";

interface DelegationLoopFixtures {
  identicalLoop: {
    agentName: string;
    task: string;
    delegatedOutput: string;
  };
  delegateLimit: {
    agentName: string;
    tasks: string[];
    delegatedOutputs: string[];
  };
}

const fixtures = JSON.parse(
  readFileSync(new URL("./fixtures/runtime-delegation-loop.json", import.meta.url), "utf8"),
) as DelegationLoopFixtures;

function createDelegateToolCallStream(callId: string, args: Record<string, unknown>) {
  return (async function* () {
    yield { type: "tool_call_start", toolCallId: callId, toolName: "delegate_to_agent" };
    yield { type: "tool_call_delta", toolCallId: callId, argumentsDelta: JSON.stringify(args) };
    yield {
      type: "done",
      finishReason: "tool_calls",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  })();
}

function createToolCallStream(callId: string, toolName: string, args: Record<string, unknown>) {
  return (async function* () {
    yield { type: "tool_call_start", toolCallId: callId, toolName };
    yield { type: "tool_call_delta", toolCallId: callId, argumentsDelta: JSON.stringify(args) };
    yield {
      type: "done",
      finishReason: "tool_calls",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  })();
}

function createTextStream(text: string) {
  return (async function* () {
    yield { type: "text_delta", content: text };
    yield {
      type: "done",
      finishReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  })();
}

afterEach(() => {
  unregisterTool("delegate_to_agent");
  streamMock.mockReset();
  completeMock.mockClear();
  resetSessionsForTests();
});

describe("runtime delegated-loop regressions", () => {
  it("terminates repeated delegated clarification loops and keeps raw delegated chatter out of parent history", async () => {
    const { agentName, task, delegatedOutput } = fixtures.identicalLoop;

    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      return createDelegateToolCallStream(`call_${llmCallCount}`, {
        agentName,
        task,
      });
    });

    const delegateExecuteMock = vi.fn(async () => ({
      success: true,
      output: delegatedOutput,
      metadata: {
        agentName,
        attemptedAgents: [agentName],
        routingReason: { confidence: "high" },
      },
    }));

    registerTool({
      name: "delegate_to_agent",
      description: "Delegate to a specialist.",
      parameters: { type: "object", properties: {} },
      execute: delegateExecuteMock,
    });

    const session = new AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });
    const observedToolResults: string[] = [];

    const result = await runTurn({
      session,
      userMessage: "Start the authorized pentest.",
      onToolResult: (_name, toolResult) => observedToolResults.push(toolResult),
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toContain("Delegation loop detected");
    expect(result.response).toContain("Latest delegated response");
    expect(result.response).toContain("Please confirm the authorization reference again before I proceed.");
    expect(streamMock).toHaveBeenCalledTimes(3);
    expect(delegateExecuteMock).toHaveBeenCalledTimes(3);
    expect(observedToolResults).toHaveLength(2);
    expect(observedToolResults[0]).toContain("## Authorization Confirmed");

    const toolMessages = session.getHistory().filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[0]?.content).toContain(`Delegated result from ${agentName}`);
    expect(toolMessages[0]?.content).not.toContain("## Authorization Confirmed");
  });

  it("surfaces the latest delegated clarification when the per-turn delegate limit is exceeded", async () => {
    const { agentName, tasks, delegatedOutputs } = fixtures.delegateLimit;
    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      return createDelegateToolCallStream(`limit_${llmCallCount}`, {
        agentName,
        task: tasks[llmCallCount - 1] ?? tasks[tasks.length - 1],
      });
    });
    let delegatedOutputIndex = 0;

    const delegateExecuteMock = vi.fn(async () => ({
      success: true,
      output: delegatedOutputs[delegatedOutputIndex++] ?? delegatedOutputs[delegatedOutputs.length - 1],
      metadata: {
        agentName,
        attemptedAgents: [agentName],
      },
    }));

    registerTool({
      name: "delegate_to_agent",
      description: "Delegate to a specialist.",
      parameters: { type: "object", properties: {} },
      execute: delegateExecuteMock,
    });

    const session = new AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    const result = await runTurn({
      session,
      userMessage: "Continue the pentest.",
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toContain("Delegation limit reached for this turn");
    expect(result.response).toContain(delegatedOutputs[2]);
    expect(streamMock).toHaveBeenCalledTimes(4);
    expect(delegateExecuteMock).toHaveBeenCalledTimes(3);

    const toolMessages = session.getHistory().filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(3);
    expect(toolMessages[2]?.content).toContain("Result summary: Please confirm the authorization reference again before I continue.");
  });

  it("blocks hallucinated direct computer tools on owned-computer-access turns", async () => {
    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createToolCallStream("desktop_1", "computer_snapshot", {});
      }
      return createTextStream("I should delegate to the desktop specialist instead.");
    });

    const directComputerTool = vi.fn(async () => ({
      success: true,
      output: "should not run",
    }));

    registerTool({
      name: "computer_snapshot",
      description: "Take a desktop snapshot.",
      parameters: { type: "object", properties: {} },
      execute: directComputerTool,
    });

    const session = new AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    const result = await runTurn({
      session,
      userMessage: "Use my computer to type into VS Code on my local desktop.",
    });

    expect(directComputerTool).not.toHaveBeenCalled();
    expect(result.response).toContain("desktop specialist");

    const toolMessages = session.getHistory().filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]?.content).toContain("Tool 'computer_snapshot' is not available in this turn");
  });
});