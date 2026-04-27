/**
 * H1 — Swarm retry-continuity tests.
 *
 * 1. Completed swarm tasks from the previous turn are seeded into the new
 *    turn's swarmState.tasks so a "try again" user message does not re-run
 *    research that already succeeded.
 *
 * 2. Architect-spawned ephemeral agents (runArchitectFallback) and
 *    create_ephemeral_agent always get container: { disabled: true } so
 *    they run in-process and can reach gateway-bound tools (web_search,
 *    Playwright, MCP). Without this they hit "container error: unknown".
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SubAgentRunOptions, SubAgentRunResult } from "../agent/sub-agent.js";
import type { SwarmState } from "../tools/registry.js";

// ── Shared mocks ──────────────────────────────────────────────────────────

const streamMock = vi.hoisted(() => vi.fn());
const completeMock = vi.hoisted(() => vi.fn(async () => ({
  content: "synthesized answer",
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

const runSubAgentWithStatsMock = vi.fn(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => ({
  output: "research results from sub-agent",
  stats: {
    agentName: args.agentName,
    sessionId: `sub:test:${args.agentName}:1`,
    promptChars: 0,
    userContentChars: String(args.task ?? "").length,
    toolCount: 2,
    toolNames: ["web_search"],
    iterations: 2,
    usage: { promptTokens: 50, completionTokens: 80, totalTokens: 130 },
    maxIterations: 5,
    model: "mock",
    capabilities: [],
    terminalState: "completed" as const,
    outcome: "success" as const,
  },
}));

vi.mock("../agent/sub-agent.js", () => ({
  runSubAgent: vi.fn(async ({ agentName, task }: SubAgentRunOptions) => `${agentName}:${task}`),
  runSubAgentWithStats: runSubAgentWithStatsMock,
}));

// ── Helpers ───────────────────────────────────────────────────────────────

function makeTextStream(text: string) {
  return (async function* () {
    yield { type: "text_delta", content: text };
    yield { type: "done", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  })();
}

function makeToolStream(callId: string, toolName: string, args: Record<string, unknown>) {
  return (async function* () {
    yield { type: "tool_call_start", toolCallId: callId, toolName };
    yield { type: "tool_call_delta", toolCallId: callId, argumentsDelta: JSON.stringify(args) };
    yield { type: "done", finishReason: "tool_calls", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  })();
}

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env["SAI_CONFIG_PATH"];
  vi.resetModules();
  streamMock.mockReset();
  completeMock.mockReset();
  runSubAgentWithStatsMock.mockClear();

  const { resetConfigForTests } = await import("../config/loader.js");
  resetConfigForTests();
  const { resetSessionsForTests } = await import("../agent/session.js");
  resetSessionsForTests();
  const memory = await import("../swarm/memory.js");
  await memory.resetSharedMemoryForTests();
});

// ── 1. Swarm state continuity across turns ────────────────────────────────

describe("H1.1: swarm state seeding on retry turns", () => {
  it("loadPreviousTurnSwarmTasks carries completed tasks into new turn swarmState", async () => {
    const ws = mkdtempSync(join(tmpdir(), "sai-h1-swarm-"));
    mkdirSync(join(ws, ".starlingai"), { recursive: true });
    tempDirs.push(ws);

    writeFileSync(join(ws, "starlingai.json"), JSON.stringify({
      workspacePath: ws,
      agents: {
        defaults: { model: { primary: "mock-model" }, maxIterations: 5, turnTimeoutMs: 30_000 },
        maxTotalDelegationsPerTurn: 3,
        maxToolIterations: 10,
        ephemeralGeneration: { enabled: false, skillMatchThreshold: 0.70, architectAgentName: "agent_architect" },
      },
      subAgents: {},
      guardrails: { enabled: false },
    }), "utf-8");
    process.env["SAI_CONFIG_PATH"] = join(ws, "starlingai.json");

    const [{ AgentSession, resetSessionsForTests }, { runTurn }, { registerTool, unregisterTool }] = await Promise.all([
      import("../agent/session.js"),
      import("../agent/runtime.js"),
      import("../tools/registry.js"),
    ]);
    resetSessionsForTests();

    // Register a spy delegate tool so we can observe what swarmState the new turn sees
    let capturedSwarmState: SwarmState | undefined;
    registerTool({
      name: "delegate_to_agent",
      description: "Delegate a task to a sub-agent.",
      parameters: { type: "object", properties: { agentName: { type: "string" }, task: { type: "string" } }, required: ["task"] },
      async execute(_args, ctx) {
        capturedSwarmState = ctx.swarmState ? { ...ctx.swarmState, tasks: { ...ctx.swarmState.tasks } } : undefined;
        return { success: true, output: "delegate result", metadata: { agentName: "researcher", attemptedAgents: ["researcher"], delegationSucceeded: true } };
      },
    });

    const session = new AgentSession({ sessionId: "sess-h1", channel: "test", workspacePath: ws });

    // Simulate turn 1: inject a persisted swarm state with a completed task directly into history
    const prevSwarmState: SwarmState = {
      objective: "search for MEMS microphones",
      startedAt: new Date(Date.now() - 600_000).toISOString(),
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
      tasks: {
        task_1: {
          id: "task_1",
          title: "Search for MEMS mic arrays",
          status: "completed",
          dependsOn: [],
          signature: "search for mems mic arrays::search for flat mems microphone arrays for esp32::",
          selectedAgent: "researcher",
          attempts: [],
          output: "Found: TDK IM73A130, Infineon IM69D130, ReSpeaker 6-Mic Array",
        },
        task_2: {
          id: "task_2",
          title: "Failed browser task",
          status: "failed",
          dependsOn: [],
          signature: "failed browser task::browser navigate to site::",
          attempts: [],
          error: "timeout",
        },
      },
    };
    // Inject a fake prior assistant message with swarm state metadata
    (session as any).history = [
      { role: "user", content: "search for mics", timestamp: new Date(Date.now() - 700_000).toISOString() },
      { role: "assistant", content: "Found some results.", timestamp: new Date(Date.now() - 600_000).toISOString(), metadata: { swarmState: prevSwarmState } },
    ];

    // Turn 2: user says "try again" — the LLM calls delegate_to_agent
    streamMock.mockImplementationOnce(() => makeToolStream("c1", "delegate_to_agent", { task: "search for MEMS mic modules" }));
    streamMock.mockImplementationOnce(() => makeTextStream("Here are the results from the prior research."));

    const result = await runTurn({ session, userMessage: "try again", autoApprove: true });

    // The delegate tool should have been called
    expect(capturedSwarmState).toBeDefined();
    expect(result.swarmState?.tasks["task_1"]).toBeDefined();

    // completed task_1 from previous turn must be present in the new swarm state
    expect(capturedSwarmState!.tasks["task_1"]).toBeDefined();
    expect(capturedSwarmState!.tasks["task_1"]!.status).toBe("completed");
    expect(capturedSwarmState!.tasks["task_1"]!.output).toContain("TDK IM73A130");

    // failed task_2 must NOT be carried into the new turn (so it can be retried)
    expect(capturedSwarmState!.tasks["task_2"]).toBeUndefined();

    unregisterTool("delegate_to_agent");
  }, 30_000);

  it("does not persist carried swarm state on a direct-answer follow-up turn", async () => {
    const ws = mkdtempSync(join(tmpdir(), "sai-h1-direct-answer-"));
    mkdirSync(join(ws, ".starlingai"), { recursive: true });
    tempDirs.push(ws);

    writeFileSync(join(ws, "starlingai.json"), JSON.stringify({
      workspacePath: ws,
      agents: {
        defaults: { model: { primary: "mock-model" }, maxIterations: 5, turnTimeoutMs: 30_000 },
        maxTotalDelegationsPerTurn: 3,
        maxToolIterations: 10,
        ephemeralGeneration: { enabled: false, skillMatchThreshold: 0.70, architectAgentName: "agent_architect" },
      },
      subAgents: {},
      guardrails: { enabled: false },
    }), "utf-8");
    process.env["SAI_CONFIG_PATH"] = join(ws, "starlingai.json");

    const [{ AgentSession, resetSessionsForTests }, { runTurn }] = await Promise.all([
      import("../agent/session.js"),
      import("../agent/runtime.js"),
    ]);
    resetSessionsForTests();

    const session = new AgentSession({ sessionId: "sess-h1-direct", channel: "test", workspacePath: ws });
    const prevSwarmState: SwarmState = {
      objective: "search for MEMS microphones",
      startedAt: new Date(Date.now() - 600_000).toISOString(),
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
      tasks: {
        task_1: {
          id: "task_1",
          title: "Search for MEMS mic arrays",
          status: "completed",
          dependsOn: [],
          signature: "search for mems mic arrays::search for flat mems microphone arrays for esp32::",
          selectedAgent: "researcher",
          attempts: [],
          output: "Found: TDK IM73A130, Infineon IM69D130, ReSpeaker 6-Mic Array",
        },
      },
    };
    (session as unknown as { history: Array<Record<string, unknown>> }).history = [
      { role: "user", content: "search for mics", timestamp: new Date(Date.now() - 700_000).toISOString() },
      { role: "assistant", content: "Found some results.", timestamp: new Date(Date.now() - 600_000).toISOString(), metadata: { swarmState: prevSwarmState } },
    ];

    streamMock.mockImplementationOnce(() => makeTextStream("Direct answer without delegation."));

    const result = await runTurn({ session, userMessage: "what power rail should I use?", autoApprove: true });

    expect(result.swarmState).toBeUndefined();
    const transcript = session.toTranscript();
    const lastAssistant = [...transcript].reverse().find((message) => message.role === "assistant");
    expect(lastAssistant?.content).toContain("Direct answer without delegation.");
    expect(lastAssistant?.swarmState).toBeUndefined();
  }, 30_000);
});

// ── 2. Architect-spawned ephemeral agents disable container ────────────────

describe("H1.2: architect-spawned ephemeral agents always run in-process", () => {
  it("runArchitectFallback passes container: { disabled: true } in inlineConfig", async () => {
    const ws = mkdtempSync(join(tmpdir(), "sai-h1-ephemeral-"));
    mkdirSync(join(ws, ".starlingai"), { recursive: true });
    tempDirs.push(ws);

    writeFileSync(join(ws, "starlingai.json"), JSON.stringify({
      workspacePath: ws,
      agents: {
        defaults: { model: { primary: "mock-model" } },
        maxTotalDelegationsPerTurn: 5,
        maxToolIterations: 20,
        ephemeralGeneration: {
          enabled: true,
          skillMatchThreshold: 0.70,
          architectAgentName: "agent_architect",
        },
      },
      subAgents: {},
      guardrails: { enabled: false },
    }), "utf-8");
    process.env["SAI_CONFIG_PATH"] = join(ws, "starlingai.json");

    // Architect LLM returns a spec with web_search (a gateway-bound tool)
    completeMock.mockResolvedValue({
      content: JSON.stringify({
        agentName: "mems_mic_researcher",
        description: "Researches MEMS microphone modules",
        systemPrompt: "Find MEMS mic arrays. Call share_finding when done.",
        tools: ["web_search", "web_fetch"],
        maxIterations: 3,
      }),
      tool_calls: [],
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
      finishReason: "stop",
    });

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const delegate = getTool("delegate_to_agent");
    expect(delegate).toBeDefined();

    const swarmState: SwarmState = {
      objective: "Find MEMS mics for ESP32",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: {},
    };

    await delegate!.execute({
      task: "Find the best flat MEMS microphone arrays for ESP32 I2S recording",
    }, {
      sessionId: "sess-h1-ephemeral",
      workspacePath: ws,
      swarmState,
    });

    // The sub-agent runner must have been called for the ephemeral agent
    expect(runSubAgentWithStatsMock).toHaveBeenCalled();

    // The inlineConfig passed must have container: { disabled: true }
    const callArgs = runSubAgentWithStatsMock.mock.calls.find(
      ([opts]) => String(opts.agentName ?? "").startsWith("ephemeral:"),
    );
    expect(callArgs).toBeDefined();
    const inlineConfig = (callArgs![0] as SubAgentRunOptions).inlineConfig as Record<string, unknown> | undefined;
    expect(inlineConfig).toBeDefined();
    expect(inlineConfig!["container"]).toMatchObject({ disabled: true });
  }, 30_000);

  it("create_ephemeral_agent passes container: { disabled: true } in inlineConfig", async () => {
    const ws = mkdtempSync(join(tmpdir(), "sai-h1-create-ephemeral-"));
    mkdirSync(join(ws, ".starlingai"), { recursive: true });
    tempDirs.push(ws);

    writeFileSync(join(ws, "starlingai.json"), JSON.stringify({
      workspacePath: ws,
      agents: { defaults: { model: { primary: "mock-model" } } },
      subAgents: {},
      guardrails: { enabled: false },
    }), "utf-8");
    process.env["SAI_CONFIG_PATH"] = join(ws, "starlingai.json");

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const createEphemeral = getTool("create_ephemeral_agent");
    expect(createEphemeral).toBeDefined();

    await createEphemeral!.execute({
      agentName: "web_researcher",
      systemPrompt: "Search for products and summarize. Stop when done.",
      tools: ["web_search", "web_fetch"],
      task: "Find top 5 MEMS microphones on DigiKey",
      maxIterations: 3,
    }, {
      sessionId: "sess-h1-create-ephemeral",
      workspacePath: ws,
    });

    // runSubAgent is what create_ephemeral_agent uses (not runSubAgentWithStats)
    const { runSubAgent } = await import("../agent/sub-agent.js");
    const runSubAgentMock = vi.mocked(runSubAgent);
    expect(runSubAgentMock).toHaveBeenCalled();

    const callArgs = runSubAgentMock.mock.calls.find(
      ([opts]) => String(opts.agentName ?? "").startsWith("ephemeral:"),
    );
    expect(callArgs).toBeDefined();
    const inlineConfig = (callArgs![0] as SubAgentRunOptions).inlineConfig as Record<string, unknown> | undefined;
    expect(inlineConfig).toBeDefined();
    expect(inlineConfig!["container"]).toMatchObject({ disabled: true });
  }, 30_000);
});
