import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { logAudit } from "../audit/logger.js";
import { runTurn } from "../agent/runtime.js";
import { resetConfigForTests } from "../config/loader.js";
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
const tempConfigDirs: string[] = [];

async function loadFreshRuntimeForToolMode(
  toolMode: "hybrid" | "orchestration_only",
  extraConfig: Record<string, unknown> = {},
) {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-runtime-toolmode-"));
  tempConfigDirs.push(tempDir);
  const configPath = join(tempDir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({
    agents: {
      mainAssistant: {
        toolMode,
      },
    },
    ...extraConfig,
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configPath;
  vi.resetModules();

  const [{ AgentSession: FreshAgentSession, resetSessionsForTests: freshResetSessionsForTests }, { runTurn: freshRunTurn }, registryModule] = await Promise.all([
    import("../agent/session.js"),
    import("../agent/runtime.js"),
    import("../tools/registry.js"),
  ]);

  return {
    AgentSession: FreshAgentSession,
    resetSessionsForTests: freshResetSessionsForTests,
    runTurn: freshRunTurn,
    registerTool: registryModule.registerTool,
    unregisterTool: registryModule.unregisterTool,
  };
}

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

function createMultiToolCallStream(calls: Array<{ id: string; toolName: string; args: Record<string, unknown> }>) {
  return (async function* () {
    for (const call of calls) {
      yield { type: "tool_call_start", toolCallId: call.id, toolName: call.toolName };
      yield { type: "tool_call_delta", toolCallId: call.id, argumentsDelta: JSON.stringify(call.args) };
    }
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
  for (const dir of tempConfigDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env["SAI_CONFIG_PATH"];
  resetConfigForTests();
  unregisterTool("delegate_to_agent");
  unregisterTool("search_agents");
  unregisterTool("search_workflows");
  unregisterTool("run_workflow");
  streamMock.mockReset();
  completeMock.mockClear();
  vi.mocked(logAudit).mockClear();
  resetSessionsForTests();
});

describe("runtime delegated-loop regressions", () => {
  it("forces synthesis after delegated clarification evidence instead of re-delegating", async () => {
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
      onToolResult: (_toolCallId, _name, toolResult) => observedToolResults.push(toolResult),
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toBe("synthesized");
    expect(streamMock).toHaveBeenCalledTimes(2);
    expect(delegateExecuteMock).toHaveBeenCalledTimes(1);
    expect(observedToolResults).toHaveLength(1);
    expect(observedToolResults[0]).toContain("## Authorization Confirmed");
    expect(result.guardrailEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "synthesis_required", details: "post_orchestration_tool_call_rejected" }),
    ]));

    const toolMessages = session.getHistory().filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]?.content).toContain(`Delegated result from ${agentName}`);
    expect(toolMessages[0]?.content).not.toContain("## Authorization Confirmed");
  });

  it("synthesizes instead of spending the full delegate limit after grounded delegated clarification", async () => {
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
      output: delegatedOutputs[delegatedOutputIndex++] ?? delegatedOutputs[delegatedOutputs.length - 1] ?? "",
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
    expect(result.response).toBe("synthesized");
    expect(streamMock).toHaveBeenCalledTimes(2);
    expect(delegateExecuteMock).toHaveBeenCalledTimes(1);
    expect(result.guardrailEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "synthesis_required", details: "post_orchestration_tool_call_rejected" }),
    ]));

    const toolMessages = session.getHistory().filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]?.content).toContain("Delegated result from pentest_coordinator");
    expect(toolMessages[0]?.content).toContain("Please confirm the authorization reference from the request.");
  });

  it("resynthesizes narrated tool-trace final responses into a direct answer", async () => {
    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createDelegateToolCallStream("call_trace", {
          agentName: "researcher",
          task: "Research current penetration testing frameworks.",
        });
      }

      return createTextStream([
        "I'll search for more specific information on penetration testing frameworks and methodologies.",
        "",
        "[Tool: web_search(maxResults: 10, query: \"OWASP testing guide\") → Web Search Results for: ...]",
        "",
        "Now let me create a comprehensive document with all this information.",
      ].join("\n\n"));
    });

    const delegateExecuteMock = vi.fn(async () => ({
      success: true,
      output: "OWASP WSTG, PTES, and NIST SP 800-115 are the relevant frameworks.",
      metadata: {
        agentName: "researcher",
        attemptedAgents: ["researcher"],
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
      userMessage: "Research current penetration testing frameworks.",
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toBe("synthesized");
    expect(streamMock).toHaveBeenCalledTimes(2);
    expect(delegateExecuteMock).toHaveBeenCalledTimes(1);
    expect(completeMock).toHaveBeenCalledTimes(1);
    expect(session.getHistory().at(-1)?.content).toBe("synthesized");
  });

  it("resynthesizes empty post-tool final responses into a direct answer", async () => {
    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createDelegateToolCallStream("call_empty", {
          agentName: "researcher",
          task: "Research current penetration testing frameworks.",
        });
      }

      return createTextStream("");
    });

    const delegateExecuteMock = vi.fn(async () => ({
      success: true,
      output: "OWASP WSTG, PTES, and NIST SP 800-115 are the relevant frameworks.",
      metadata: {
        agentName: "researcher",
        attemptedAgents: ["researcher"],
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
      userMessage: "Research current penetration testing frameworks.",
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toBe("synthesized");
    expect(streamMock).toHaveBeenCalledTimes(2);
    expect(delegateExecuteMock).toHaveBeenCalledTimes(1);
    expect(completeMock).toHaveBeenCalledTimes(1);
    expect(session.getHistory().at(-1)?.content).toBe("synthesized");
  });

  it("rewrites next-turn handoff responses into a direct synthesized answer", async () => {
    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createDelegateToolCallStream("call_handoff", {
          agentName: "researcher",
          task: "Research how StarlingAI can improve itself.",
        });
      }

      return createTextStream([
        "Based on the evidence collected from the delegation attempt, here is the status of your request:",
        "",
        "No further tool calls can be made in this turn.",
        "Would you like me to initiate a new delegation attempt for this research task in the next turn?",
      ].join("\n"));
    });

    const delegateExecuteMock = vi.fn(async () => ({
      success: true,
      output: "Sub-agent produced no final response.",
      metadata: {
        agentName: "researcher",
        attemptedAgents: ["researcher"],
        delegationSucceeded: false,
        delegationOutcome: "failure",
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
      userMessage: "Research how StarlingAI can improve itself.",
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toBe("synthesized");
    expect(delegateExecuteMock).toHaveBeenCalledTimes(1);
    expect(completeMock).toHaveBeenCalledTimes(1);
    expect(session.getHistory().at(-1)?.content).toBe("synthesized");
  });

  it("forces synthesis when the model tries to delegate again after synthesis was already required", async () => {
    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createDelegateToolCallStream("chart_1", {
          task: "Show a chart of the average monthly temperature for Dresden, Germany, for the previous year.",
        });
      }

      return createDelegateToolCallStream("chart_2", {
        task: "Extract the specific monthly average temperatures for Dresden, Germany, for 2025 from the identified sources.",
      });
    });

    const delegateExecuteMock = vi.fn(async () => ({
      success: true,
      output: [
        "Delegated result from ephemeral:weather_chart_generator — TASK COMPLETED.",
        "IMPORTANT: Relay ALL specific details from the evidence below (names, numbers, values) in your answer. Do NOT paraphrase with different numbers or names.",
        "Observed evidence:",
        "The search results provide general historical averages but do not contain the specific, month-by-month average temperature data for last year (2025) required to generate a chart. The fetched URLs failed.",
        "",
        "I cannot generate the chart without the specific monthly data for 2025.",
      ].join("\n"),
      metadata: {
        agentName: "ephemeral:weather_chart_generator",
        attemptedAgents: ["ephemeral:weather_chart_generator"],
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
      userMessage: "can you show me a chart of the average temperature of each month last year in dresden (germany)",
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toBe("synthesized");
    expect(streamMock).toHaveBeenCalledTimes(2);
    expect(delegateExecuteMock).toHaveBeenCalledTimes(1);
    expect(completeMock).toHaveBeenCalledTimes(1);
    expect(result.guardrailEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "synthesis_required", details: "post_orchestration_tool_call_rejected" }),
    ]));
  });

  it("rejects tool-free continuation promises after an unfinished delegated server action and forces a retry delegation", async () => {
    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createTextStream("Ich habe den Befehl korrigiert und fuehre den Neustart nun aus.");
      }
      if (llmCallCount === 2) {
        return createDelegateToolCallStream("retry_shell_1", {
          agentName: "shell_agent",
          task: "Retry the docker compose restart on n8n-server using the user's corrected CamelCase path hint.",
        });
      }
      return createTextStream("Der Neustart wurde mit der korrigierten Vorgabe erneut angestossen.");
    });

    const delegateExecuteMock = vi.fn(async () => ({
      success: true,
      output: [
        "Delegated result from shell_agent — TASK COMPLETED.",
        "IMPORTANT: Relay ALL specific details from the evidence below.",
        "Observed evidence:",
        "Restart command accepted on the remote host.",
      ].join("\n"),
      metadata: {
        agentName: "shell_agent",
        attemptedAgents: ["shell_agent"],
        delegationSucceeded: true,
        delegationOutcome: "success",
        terminalState: "completed",
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

    session.addMessage({
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "prior_delegate_1",
        type: "function",
        function: {
          name: "delegate_to_agent",
          arguments: JSON.stringify({ agentName: "shell_agent", task: "Restart the n8n container using docker compose." }),
        },
      }],
    } as any);
    session.addMessage({
      role: "tool",
      content: [
        "Delegated result from shell_agent — PARTIAL RESULT.",
        "IMPORTANT: Use the evidence below and say clearly that the delegated work was interrupted or incomplete.",
        "Observed evidence:",
        "Good, the SSH connection works. Now let me try to find the docker-compose.yml file:",
      ].join("\n"),
      tool_call_id: "prior_delegate_1",
      metadata: {
        agentName: "shell_agent",
        delegationOutcome: "partial",
        terminalState: "max_iterations",
      },
    } as any);
    session.addMessage({
      role: "assistant",
      content: "Der Shell-Agent hat die Verbindung hergestellt, aber die Aktion wurde unterbrochen.",
    });

    const result = await runTurn({
      session,
      userMessage: "versuche es noch einmal und vergiss nicht \"Steffen\" wird in Camelcase geschrieben",
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toContain("korrigierten Vorgabe erneut angestossen");
    expect(delegateExecuteMock).toHaveBeenCalledTimes(1);
    expect(streamMock).toHaveBeenCalledTimes(3);
    expect(result.guardrailEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "delegation_required", details: "tool_free_continuation_promise_rejected" }),
    ]));
  });

  it("rewrites terminal synthesis that falsely promises another orchestration step", async () => {
    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createDelegateToolCallStream("chart_1", {
          task: "Show a chart of the average monthly temperature for Germany for 2025.",
        });
      }

      return createDelegateToolCallStream("chart_2", {
        task: "Extract the specific monthly values from the identified DWD directory.",
      });
    });

    completeMock
      .mockResolvedValueOnce({
        content: "Ich werde nun den file_analyst beauftragen, das Verzeichnis 04_Apr/ zu untersuchen.",
        tool_calls: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        finishReason: "stop",
      })
      .mockResolvedValueOnce({
        content: "Die Datenquelle und die relevanten 2025-Verzeichnisse wurden identifiziert, aber die numerischen Monatswerte wurden in diesem Turn nicht extrahiert.",
        tool_calls: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        finishReason: "stop",
      });

    const delegateExecuteMock = vi.fn(async () => ({
      success: true,
      output: [
        "Delegated result from ephemeral:dwd_data_extractor — TASK COMPLETED.",
        "IMPORTANT: Relay ALL specific details from the evidence below (names, numbers, values) in your answer. Do NOT paraphrase with different numbers or names.",
        "Observed evidence:",
        "The directory listing for https://opendata.dwd.de/climate_environment/CDC/grids_germany/monthly/air_temperature_mean/ contains subdirectories named by month.",
      ].join("\n"),
      metadata: {
        agentName: "ephemeral:dwd_data_extractor",
        attemptedAgents: ["ephemeral:dwd_data_extractor"],
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
      userMessage: "show me the average monthly temperature chart for germany last year",
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toBe("Die Datenquelle und die relevanten 2025-Verzeichnisse wurden identifiziert, aber die numerischen Monatswerte wurden in diesem Turn nicht extrahiert.");
    expect(result.response).not.toMatch(/ich werde nun|file_analyst/i);
    expect(completeMock).toHaveBeenCalledTimes(2);
  });

  it("continues the same turn when delegated evidence exposes a concrete new follow-up action", async () => {
    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createDelegateToolCallStream("weather_1", {
          task: "Locate the official monthly Germany temperature source for 2025.",
        });
      }
      if (llmCallCount === 2) {
        return createDelegateToolCallStream("weather_2", {
          task: "Fetch the contents of the first identified monthly directory and extract the raw values.",
        });
      }
      return createTextStream("The data source was identified, the first monthly directory was inspected, and the raw values were extracted.");
    });

    let delegatedCallCount = 0;
    const delegateExecuteMock = vi.fn(async () => {
      delegatedCallCount += 1;
      if (delegatedCallCount === 1) {
        return {
          success: true,
          output: [
            "Delegated result from ephemeral:dwd_data_extractor — TASK COMPLETED.",
            "IMPORTANT: Relay ALL specific details from the evidence below (names, numbers, values) in your answer. Do NOT paraphrase with different numbers or names.",
            "Observed evidence:",
            "The directory listing for the DWD monthly temperature path contains month-named subdirectories for 2025.",
            "The next logical step is to fetch the contents of the first relevant directory to determine the actual data file format and extract the raw numerical values.",
          ].join("\n"),
          metadata: {
            agentName: "ephemeral:dwd_data_extractor",
            attemptedAgents: ["ephemeral:dwd_data_extractor"],
            delegationSucceeded: true,
            terminalState: "completed",
          },
        };
      }

      return {
        success: true,
        output: [
          "Delegated result from file_analyst — TASK COMPLETED.",
          "IMPORTANT: Relay ALL specific details from the evidence below (names, numbers, values) in your answer. Do NOT paraphrase with different numbers or names.",
          "Observed evidence:",
          "The first relevant monthly directory was inspected and the raw values were extracted successfully.",
        ].join("\n"),
        metadata: {
          agentName: "file_analyst",
          attemptedAgents: ["file_analyst"],
          delegationSucceeded: true,
          terminalState: "completed",
        },
      };
    });

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
      userMessage: "show me the average monthly temperature chart for germany last year",
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toBe("The data source was identified, the first monthly directory was inspected, and the raw values were extracted.");
    expect(streamMock).toHaveBeenCalledTimes(3);
    expect(delegateExecuteMock).toHaveBeenCalledTimes(2);
    expect(result.guardrailEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "synthesis_required", details: "post_orchestration_tool_call_rejected" }),
    ]));
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

  it("returns a cached result instead of re-executing an identical tool call across iterations", async () => {
    const freshRuntime = await loadFreshRuntimeForToolMode("hybrid");

    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createToolCallStream("read_1", "read_file", { path: "workspace/agents/30-subagents-pentest.jsonc" });
      }
      if (llmCallCount === 2) {
        return createToolCallStream("read_2", "read_file", { path: "workspace/agents/30-subagents-pentest.jsonc" });
      }
      return createTextStream("I reviewed the file once and will not repeat the same read again.");
    });

    const readFileMock = vi.fn(async () => ({
      success: true,
      output: "pentest workflow content",
      metadata: { path: "workspace/agents/30-subagents-pentest.jsonc" },
    }));

    freshRuntime.registerTool({
      name: "read_file",
      description: "Read a workspace file.",
      parameters: { type: "object", properties: {} },
      execute: readFileMock,
    });

    const session = new freshRuntime.AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    const observedToolResults: string[] = [];
    const result = await freshRuntime.runTurn({
      session,
      userMessage: "Review the pentest workflow file.",
      onToolResult: (_toolCallId, _name, toolResult) => observedToolResults.push(toolResult),
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toContain("will not repeat the same read again");
    expect(readFileMock).toHaveBeenCalledTimes(1);
    expect(observedToolResults).toHaveLength(2);
    expect(observedToolResults[1]).toContain("This is a cached result");

    const toolMessages = session.getHistory().filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[1]?.content).toContain("already called 'read_file' with identical arguments");
  });

  it("treats maxIterationsOverride=0 as unlimited instead of skipping the turn loop", async () => {
    const freshRuntime = await loadFreshRuntimeForToolMode("hybrid");

    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createToolCallStream("read_once", "read_file", { path: "workspace/README.md" });
      }
      return createTextStream("I completed the requested review.");
    });

    const readFileMock = vi.fn(async () => ({
      success: true,
      output: "workspace summary",
      metadata: { path: "workspace/README.md" },
    }));

    freshRuntime.registerTool({
      name: "read_file",
      description: "Read a workspace file.",
      parameters: { type: "object", properties: {} },
      execute: readFileMock,
    });

    const session = new freshRuntime.AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    const result = await freshRuntime.runTurn({
      session,
      userMessage: "Review the workspace README.",
      maxIterationsOverride: 0,
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toContain("completed the requested review");
    expect(readFileMock).toHaveBeenCalledTimes(1);
    expect(llmCallCount).toBe(2);

    freshRuntime.unregisterTool("read_file");
  });

  it("re-delegates after a user clarification instead of carrying stale synthesis nudges into the next turn", async () => {
    let llmCallCount = 0;
    streamMock.mockImplementation((messages: Array<{ role: string; content?: string }>) => {
      llmCallCount += 1;

      if (llmCallCount === 1) {
        return createDelegateToolCallStream("clarify_1", {
          agentName: "distance_specialist",
          task: "wie lange brauche ich von worbis nach dresden",
        });
      }

      if (llmCallCount === 2) {
        return createTextStream("Bitte präzisieren Sie den Start- und Zielort.");
      }

      if (llmCallCount === 3) {
        const staleSystemLeak = messages.some((message) => message.role === "system"
          && typeof message.content === "string"
          && (message.content.startsWith("[SYNTHESIS REQUIRED]") || message.content.startsWith("[USER INTERACTION OWNERSHIP]")));
        expect(staleSystemLeak).toBe(false);
        return createDelegateToolCallStream("clarify_2", {
          agentName: "distance_specialist",
          task: "worbis bei leinefelde und dresden in sachsen",
        });
      }

      return createTextStream("Mode: car\nDistance: 215 km\nEstimated travel time: 2 h 15 min");
    });

    const delegateExecuteMock = vi.fn()
      .mockResolvedValueOnce({
        success: true,
        output: "[distance_specialist]: Multiple matches were found for Worbis.",
        metadata: {
          agentName: "distance_specialist",
          attemptedAgents: ["distance_specialist"],
          routingReason: { confidence: "high" },
        },
      })
      .mockResolvedValueOnce({
        success: true,
        output: "[distance_specialist]: Mode: car\nDistance: 215 km\nEstimated travel time: 2 h 15 min",
        metadata: {
          agentName: "distance_specialist",
          attemptedAgents: ["distance_specialist"],
          routingReason: { confidence: "high" },
        },
      });

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

    const firstTurn = await runTurn({
      session,
      userMessage: "wie lange brauche ich von worbis nach dresden",
    });

    const secondTurn = await runTurn({
      session,
      userMessage: "worbis bei leinefelde und dresden in sachsen",
    });

    expect(firstTurn.response).toContain("Bitte präzisieren Sie den Start- und Zielort");
    expect(secondTurn.blocked).toBe(false);
    expect(delegateExecuteMock).toHaveBeenCalledTimes(2);
    expect(streamMock).toHaveBeenCalledTimes(4);
  });

  it("collapses duplicate tool calls within a single model response before executing them", async () => {
    const freshRuntime = await loadFreshRuntimeForToolMode("hybrid");

    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createMultiToolCallStream([
          { id: "search_1", toolName: "web_search", args: { query: "Out of the Blue hotel Crete near Heraklion location" } },
          { id: "search_2", toolName: "web_search", args: { query: "distance Heraklion Airport to Out of the Blue Agia Pelagia" } },
          { id: "search_3", toolName: "web_search", args: { query: "driving time Heraklion Airport to Out of the Blue Agia Pelagia Crete" } },
          { id: "search_4", toolName: "web_search", args: { query: "Out of the Blue hotel Crete near Heraklion location" } },
          { id: "search_5", toolName: "web_search", args: { query: "distance Heraklion Airport to Out of the Blue Agia Pelagia" } },
          { id: "search_6", toolName: "web_search", args: { query: "driving time Heraklion Airport to Out of the Blue Agia Pelagia Crete" } },
        ]);
      }
      return createTextStream("The hotel is about 25 km from Heraklion Airport and the drive takes roughly 24 minutes.");
    });

    const webSearchMock = vi.fn(async (args: Record<string, unknown>) => ({
      success: true,
      output: `result for ${String(args.query ?? "")}`,
      metadata: { query: String(args.query ?? "") },
    }));

    freshRuntime.registerTool({
      name: "web_search",
      description: "Search the web.",
      parameters: { type: "object", properties: {} },
      execute: webSearchMock,
    });

    const session = new freshRuntime.AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    const result = await freshRuntime.runTurn({
      session,
      userMessage: "How far is Out of the Blue from Heraklion Airport?",
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toContain("25 km");
    expect(webSearchMock).toHaveBeenCalledTimes(3);

    const assistantWithTools = session.getHistory().find((message) => message.role === "assistant" && Array.isArray(message.tool_calls));
    expect(assistantWithTools?.tool_calls).toHaveLength(3);

    const toolMessages = session.getHistory().filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(3);
  });

  it("keeps only the first direct delegation when the model emits multiple delegate_to_agent calls in one response", async () => {
    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createMultiToolCallStream([
          { id: "delegate_1", toolName: "delegate_to_agent", args: { task: "Show a chart of the average temperature of each month for Germany for the previous year (2025)." } },
          { id: "delegate_2", toolName: "delegate_to_agent", args: { task: "Gather data on the average monthly temperature for Germany for the year 2025." } },
          { id: "delegate_3", toolName: "delegate_to_agent", args: { task: "Design a chart visualizing the monthly average temperatures for Germany based on provided data from 2025." } },
        ]);
      }
      return createTextStream("I executed the first delegation only and preserved the remaining turn budget for the next planning step.");
    });

    const delegateExecuteMock = vi.fn(async () => ({
      success: true,
      output: "Delegated result from mission_coordinator — TASK COMPLETED.\nObserved evidence:\nThe first orchestration step completed.",
      metadata: {
        agentName: "mission_coordinator",
        attemptedAgents: ["mission_coordinator"],
        delegationSucceeded: true,
        terminalState: "completed",
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
      userMessage: "can you show me a chart of the average temperature of each month last year in germany",
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toContain("first delegation only");
    expect(delegateExecuteMock).toHaveBeenCalledTimes(1);

    const assistantWithTools = session.getHistory().find((message) => message.role === "assistant" && Array.isArray(message.tool_calls));
    expect(assistantWithTools?.tool_calls).toHaveLength(1);
    expect(result.guardrailEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool_blocked", details: "delegate_to_agent:multiple_direct_delegations_same_response" }),
    ]));
  });

  it("keeps only the first orchestration launcher when the model mixes delegate_to_agent and parallel_delegate in one response", async () => {
    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createMultiToolCallStream([
          {
            id: "delegate_1",
            toolName: "delegate_to_agent",
            args: { task: "Retrieve and structure time-series data for the MSCI World ETF over the last 12 months to generate a comparative chart." },
          },
          {
            id: "parallel_1",
            toolName: "parallel_delegate",
            args: {
              tasks: [{ task: "Retrieve and structure time-series data for the MSCI World ETF over the last 12 months to generate a comparative chart." }],
            },
          },
        ]);
      }
      return createTextStream("I executed only the first orchestration launcher and avoided duplicate delegation.");
    });

    const delegateExecuteMock = vi.fn(async () => ({
      success: true,
      output: "Delegated result from mission_coordinator — TASK COMPLETED.\nObserved evidence:\nThe orchestration request was launched once.",
      metadata: {
        agentName: "mission_coordinator",
        attemptedAgents: ["mission_coordinator"],
        delegationSucceeded: true,
        terminalState: "completed",
      },
    }));
    const parallelExecuteMock = vi.fn(async () => ({
      success: true,
      output: "parallel should have been blocked",
    }));

    registerTool({
      name: "delegate_to_agent",
      description: "Delegate to a specialist.",
      parameters: { type: "object", properties: {} },
      execute: delegateExecuteMock,
    });
    registerTool({
      name: "parallel_delegate",
      description: "Run tasks in parallel.",
      parameters: { type: "object", properties: {} },
      execute: parallelExecuteMock,
    });

    const session = new AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    const result = await runTurn({
      session,
      userMessage: "can you give me a chart of the etf msci world for the last 12 months",
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toContain("first orchestration launcher");
    expect(delegateExecuteMock).toHaveBeenCalledTimes(1);
    expect(parallelExecuteMock).not.toHaveBeenCalled();

    const assistantWithTools = session.getHistory().find((message) => message.role === "assistant" && Array.isArray(message.tool_calls));
    expect(assistantWithTools?.tool_calls).toHaveLength(1);
    expect(assistantWithTools?.tool_calls?.[0]?.function.name).toBe("delegate_to_agent");
    expect(result.guardrailEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool_blocked", details: "parallel_delegate:multiple_orchestration_launchers_same_response" }),
    ]));
  });

  it("blocks search_agents when the model mixes routing discovery with an already-issued delegation", async () => {
    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createMultiToolCallStream([
          {
            id: "delegate_1",
            toolName: "delegate_to_agent",
            args: { task: "Generate a chart showing the performance of the MSCI World ETF over the last 12 months." },
          },
          {
            id: "search_1",
            toolName: "search_agents",
            args: { query: "financial data chart etf msci world" },
          },
        ]);
      }
      return createTextStream("The gathered figures disagree, so I cannot claim that any follow-up coordinator was already routed in this turn.");
    });

    const delegateExecuteMock = vi.fn(async () => ({
      success: true,
      output: "Delegated result from researcher — TASK COMPLETED.\nObserved evidence:\nThe available MSCI World ETF figures disagree across sources.",
      metadata: {
        agentName: "researcher",
        attemptedAgents: ["researcher"],
        delegationSucceeded: true,
        terminalState: "completed",
      },
    }));
    const searchExecuteMock = vi.fn(async () => ({
      success: true,
      output: '➡ NEXT ACTION: Call delegate_to_agent(agentName="mission_coordinator", task="<your task>") NOW.',
    }));

    registerTool({
      name: "delegate_to_agent",
      description: "Delegate to a specialist.",
      parameters: { type: "object", properties: {} },
      execute: delegateExecuteMock,
    });
    registerTool({
      name: "search_agents",
      description: "Search available specialist agents.",
      parameters: { type: "object", properties: {} },
      execute: searchExecuteMock,
    });

    const session = new AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    const result = await runTurn({
      session,
      userMessage: "can you give me a chart of the etf msci world for the last 12 months",
    });

    expect(result.blocked).toBe(false);
    expect(result.response).not.toContain("mission_coordinator");
    expect(delegateExecuteMock).toHaveBeenCalledTimes(1);
    expect(searchExecuteMock).not.toHaveBeenCalled();

    const assistantWithTools = session.getHistory().find((message) => message.role === "assistant" && Array.isArray(message.tool_calls));
    expect(assistantWithTools?.tool_calls).toHaveLength(1);
    expect(assistantWithTools?.tool_calls?.[0]?.function.name).toBe("delegate_to_agent");
    expect(result.guardrailEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool_blocked", details: "search_agents:mixed_discovery_and_orchestration_same_response" }),
    ]));
  });

  it("rewrites misleading claims that a proposed next step was already executed", async () => {
    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createDelegateToolCallStream("delegate_1", {
          task: "Fetch historical performance data for the iShares MSCI World ETF (URTH).",
        });
      }
      return createTextStream("The next step, which has been executed, is to attempt fetching the historical data from Investing.com for the iShares MSCI World ETF (URTH).");
    });

    const delegateExecuteMock = vi.fn(async () => ({
      success: true,
      output: "The attempt to fetch data from Yahoo Finance resulted in a consent/privacy settings page. The next step is to attempt fetching the historical data from Investing.com for the iShares MSCI World ETF (URTH).",
      metadata: {
        agentName: "researcher",
        attemptedAgents: ["researcher"],
        delegationSucceeded: true,
        terminalState: "completed",
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
      userMessage: "can you give me a chart of the etf msci world for the last 12 months",
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toBe("synthesized");
    expect(result.response).not.toContain("has been executed");
    expect(streamMock).toHaveBeenCalledTimes(2);
    expect(completeMock).toHaveBeenCalledTimes(1);
    expect(delegateExecuteMock).toHaveBeenCalledTimes(1);
  });

  it("reuses the top search_agents result for the next agent-less delegation", async () => {
    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createToolCallStream("search_1", "search_agents", {
          query: "browser login freelancermap",
        });
      }
      if (llmCallCount === 2) {
        return createDelegateToolCallStream("delegate_1", {
          task: "Gehe auf freelancermap.com und prüfe, ob ich neue Nachrichten habe.",
        });
      }
      return createTextStream("Ich habe den bereits gefundenen Web-Koordinator verwendet.");
    });

    const searchExecuteMock = vi.fn(async () => ({
      success: true,
      output: '➡ NEXT ACTION: Call delegate_to_agent(agentName="web_task_coordinator", task="<your task>") NOW. Do NOT call search_agents again.',
      metadata: {
        query: "browser login freelancermap",
        topResult: "web_task_coordinator",
        topResultConfidence: "high",
        topResultScore: 0.72,
        resultCount: 5,
        routingMode: "hybrid",
      },
    }));

    const delegateExecuteMock = vi.fn(async (args: Record<string, unknown>) => ({
      success: true,
      output: "Delegated result from web_task_coordinator — TASK COMPLETED.\nObserved evidence:\nThe coordinator ran with the routed agent.",
      metadata: {
        agentName: String(args["agentName"] ?? ""),
        attemptedAgents: [String(args["agentName"] ?? "")],
        delegationSucceeded: true,
        terminalState: "completed",
      },
    }));

    registerTool({
      name: "search_agents",
      description: "Search available specialist agents.",
      parameters: { type: "object", properties: {} },
      execute: searchExecuteMock,
    });

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
      userMessage: "check auf freelancermap ob ich neue nachrichten habe",
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toContain("Web-Koordinator");
    expect(searchExecuteMock).toHaveBeenCalledTimes(1);
    expect(delegateExecuteMock).toHaveBeenCalledTimes(1);
    expect(delegateExecuteMock.mock.calls[0]?.[0]).toMatchObject({
      agentName: "web_task_coordinator",
      task: "Gehe auf freelancermap.com und prüfe, ob ich neue Nachrichten habe.",
    });
  });

  it("forces specialist-agent orchestration for explicit online lookup requests instead of allowing direct web tool calls", async () => {
    let llmCallCount = 0;
    streamMock.mockImplementation((_messages, tools) => {
      llmCallCount += 1;
      const toolNames = tools.map((tool: { name: string }) => tool.name);
      expect(toolNames).toContain("delegate_to_agent");
      expect(toolNames).toContain("search_agents");
      expect(toolNames).not.toContain("web_search");
      expect(toolNames).not.toContain("web_fetch");

      if (llmCallCount === 1) {
        return createTextStream("Die Entfernung betraegt etwa 25,5 km und die Fahrzeit 24 Minuten.");
      }
      if (llmCallCount === 2) {
        return createDelegateToolCallStream("delegate_1", {
          agentName: "researcher",
          task: "Suche online nach der genauen Entfernung und Fahrzeit vom Flughafen Heraklion zum Hotel Out of the Blue in Agia Pelagia.",
        });
      }
      return createTextStream("Online gefunden: Das Out of the Blue Resort & Spa liegt rund 25,5 km vom Flughafen Heraklion entfernt; die Fahrzeit betraegt etwa 24 Minuten.");
    });

    const delegateExecuteMock = vi.fn(async () => ({
      success: true,
      output: "Out of the Blue Resort & Spa in Agia Pelagia is about 25.5 km from Heraklion Airport and the drive takes about 24 minutes.",
      metadata: {
        agentName: "researcher",
        attemptedAgents: ["researcher"],
        routingReason: { confidence: "high" },
      },
    }));

    registerTool({
      name: "delegate_to_agent",
      description: "Delegate to a specialist.",
      parameters: { type: "object", properties: {} },
      execute: delegateExecuteMock,
    });

    registerTool({
      name: "search_agents",
      description: "Search available specialist agents.",
      parameters: { type: "object", properties: {} },
      execute: async () => ({
        success: true,
        output: "researcher",
      }),
    });

    const session = new AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    const result = await runTurn({
      session,
      userMessage: "Suche online nach der genauen Entfernung und Zeit vom Flughafen Heraklion zum Hotel Out of the Blue.",
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toContain("25,5 km");
    expect(result.response).toContain("24 Minuten");
    expect(llmCallCount).toBe(3);
    expect(delegateExecuteMock).toHaveBeenCalledTimes(1);

    const assistantWithTools = session.getHistory().find((message) => message.role === "assistant" && Array.isArray(message.tool_calls));
    expect(assistantWithTools?.tool_calls).toHaveLength(1);
    expect(assistantWithTools?.tool_calls?.[0]?.function.name).toBe("delegate_to_agent");
  });

  it("forces a workflow catalog check before delegation on workflow-shaped requests", async () => {
    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createDelegateToolCallStream("workflow_delegate_1", {
          agentName: "mission_coordinator",
          task: "Find and run the right reusable audit workflow.",
        });
      }
      if (llmCallCount === 2) {
        return createToolCallStream("workflow_search_1", "search_workflows", {
          query: "reusable audit export workflow",
        });
      }
      return createTextStream("I checked the workflow catalog first and found a reusable audit workflow candidate.");
    });

    const delegateExecuteMock = vi.fn(async () => ({
      success: true,
      output: "delegate should not run",
    }));
    const searchWorkflowsMock = vi.fn(async () => ({
      success: true,
      output: "audit_export_report (scene)\nExports the session audit trail as markdown.",
      metadata: {
        matches: [
          {
            name: "audit_export_report",
            type: "scene",
          },
        ],
      },
    }));

    registerTool({
      name: "delegate_to_agent",
      description: "Delegate to a specialist.",
      parameters: { type: "object", properties: {} },
      execute: delegateExecuteMock,
    });
    registerTool({
      name: "search_workflows",
      description: "Search reusable workflows.",
      parameters: { type: "object", properties: {} },
      execute: searchWorkflowsMock,
    });

    const session = new AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    const result = await runTurn({
      session,
      userMessage: "Find a reusable workflow or scene for the audit export and use the workflow catalog first.",
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toContain("workflow catalog first");
    expect(streamMock).toHaveBeenCalledTimes(3);
    expect(delegateExecuteMock).not.toHaveBeenCalled();
    expect(searchWorkflowsMock).toHaveBeenCalledTimes(1);
    expect(result.guardrailEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "workflow_required", details: "workflow_catalog_check_rejected" }),
    ]));

    const toolMessages = session.getHistory().filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]?.content).toContain("Workflow catalog suggestions only");
  });

  it("prefers reusable workflow execution for comparison-paper requests even without explicit workflow wording", async () => {
    const freshRuntime = await loadFreshRuntimeForToolMode("hybrid", {
      scenes: {
        protocol_comparison_paper: {
          description: "Compare multiple protocols through one reusable comparison paper workflow.",
          task: "Use the reusable comparison paper workflow for the requested protocol set.",
        },
      },
    });

    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createDelegateToolCallStream("paper_delegate_1", {
          agentName: "mission_coordinator",
          task: "Write a source-grounded comparison paper about MCP, A2A, and AG-UI.",
        });
      }
      if (llmCallCount === 2) {
        return createToolCallStream("paper_workflow_1", "run_workflow", {
          name: "protocol_comparison_paper",
          workflowType: "scene",
          params: {
            topic: "MCP, A2A, and AG-UI",
          },
        });
      }
      return createTextStream("I used the reusable comparison-paper workflow instead of inventing a fresh coordinator plan.");
    });

    const delegateExecuteMock = vi.fn(async () => ({
      success: true,
      output: "delegate should not run",
    }));
    const runWorkflowMock = vi.fn(async () => ({
      success: true,
      output: "Workflow protocol_comparison_paper [scene] completed.\n\nReusable comparison workflow finished.",
      metadata: {
        workflowName: "protocol_comparison_paper",
        workflowType: "scene",
        blocked: false,
      },
    }));

    freshRuntime.registerTool({
      name: "delegate_to_agent",
      description: "Delegate to a specialist.",
      parameters: { type: "object", properties: {} },
      execute: delegateExecuteMock,
    });
    freshRuntime.registerTool({
      name: "run_workflow",
      description: "Run a reusable workflow.",
      parameters: { type: "object", properties: {} },
      execute: runWorkflowMock,
    });

    const session = new freshRuntime.AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    const result = await freshRuntime.runTurn({
      session,
      userMessage: "Write a source-grounded comparison paper about MCP, A2A, and AG-UI.",
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toContain("reusable comparison-paper workflow");
    expect(delegateExecuteMock).not.toHaveBeenCalled();
    expect(runWorkflowMock).toHaveBeenCalledTimes(1);
    expect(result.guardrailEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "workflow_required", details: "workflow_catalog_check_rejected" }),
    ]));

    const toolMessages = session.getHistory().filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]?.content).toContain("Workflow protocol_comparison_paper [scene] completed");

    freshRuntime.unregisterTool("delegate_to_agent");
    freshRuntime.unregisterTool("run_workflow");
  });

  it("forces the reusable n8n project-list workflow for plain project-list checks", async () => {
    const freshRuntime = await loadFreshRuntimeForToolMode("orchestration_only", {
      scenes: {
        n8n_project_list: {
          description: "Open the n8n Projektliste, check for neue Einträge, and stop after listing the visible workflows.",
          task: "Open {{targetUrl}}, use the named project-list URL hinted by {{projectListUrlHint}}, and list the visible workflows.",
          params: {
            targetUrl: {
              description: "Initial URL to open",
              default: "http://n8n.k2o",
            },
            projectListUrlHint: {
              description: "Labels for the project-list destination",
              default: "project-list, project-list-url, projects, projektliste",
            },
          },
        },
      },
    });

    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createToolCallStream("n8n_project_list_search_agents_1", "search_agents", {
          query: "n8n workflow project list files",
        });
      }
      if (llmCallCount === 2) {
        return createToolCallStream("n8n_project_list_run_1", "run_workflow", {
          name: "n8n_project_list",
          workflowType: "scene",
        });
      }
      return createTextStream("I used the reusable n8n project-list workflow and stopped after listing the visible workflows.");
    });

    const searchAgentsMock = vi.fn(async () => ({
      success: true,
      output: "shell_agent",
    }));
    const runWorkflowMock = vi.fn(async () => ({
      success: true,
      output: "Workflow n8n_project_list [scene] completed.\n\nProject list retrieved.",
      metadata: {
        workflowName: "n8n_project_list",
        workflowType: "scene",
        blocked: false,
      },
    }));

    freshRuntime.registerTool({
      name: "search_agents",
      description: "Search specialist agents.",
      parameters: { type: "object", properties: {} },
      execute: searchAgentsMock,
    });
    freshRuntime.registerTool({
      name: "run_workflow",
      description: "Run a reusable workflow.",
      parameters: { type: "object", properties: {} },
      execute: runWorkflowMock,
    });

    const session = new freshRuntime.AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    const result = await freshRuntime.runTurn({
      session,
      userMessage: "check meine n8n-projektliste ob ich neue einträge habe",
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toContain("reusable n8n project-list workflow");
    expect(searchAgentsMock).not.toHaveBeenCalled();
    expect(runWorkflowMock).toHaveBeenCalledTimes(1);
    expect(result.guardrailEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "workflow_required", details: "workflow_catalog_check_rejected" }),
    ]));

    const toolMessages = session.getHistory().filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]?.content).toContain("Workflow n8n_project_list [scene] completed");

    freshRuntime.unregisterTool("search_agents");
    freshRuntime.unregisterTool("run_workflow");
  });

  it("runs the reusable n8n follow-up workflow after a bare approval of the project-list candidate", async () => {
    const freshRuntime = await loadFreshRuntimeForToolMode("orchestration_only", {
      scenes: {
        n8n_project_list: {
          description: "List the visible n8n workflows and ask whether the highlighted candidate should be run.",
          task: "Open the project list and stop after listing the visible workflows.",
        },
        n8n_run_workflow: {
          description: "Run an explicitly named n8n workflow from the project list.",
          task: "Open the project list, locate {{workflowName}}, and start it.",
          params: {
            workflowName: {
              description: "Workflow to run",
            },
          },
        },
      },
    });

    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createToolCallStream("n8n_candidate_followup_search_1", "search_agents", {
          query: "start highlighted n8n workflow",
        });
      }
      if (llmCallCount === 2) {
        return createToolCallStream("n8n_candidate_followup_run_1", "run_workflow", {
          name: "n8n_run_workflow",
          workflowType: "scene",
          params: {
            workflowName: "Daily Sync Workflow",
          },
        });
      }
      return createTextStream("I started the approved n8n workflow.");
    });

    const searchAgentsMock = vi.fn(async () => ({
      success: true,
      output: "shell_agent",
    }));
    const runWorkflowMock = vi.fn(async () => ({
      success: true,
      output: "Workflow n8n_run_workflow [scene] completed.\n\nStarted Daily Sync Workflow.",
      metadata: {
        workflowName: "n8n_run_workflow",
        workflowType: "scene",
        blocked: false,
      },
    }));

    freshRuntime.registerTool({
      name: "search_agents",
      description: "Search specialist agents.",
      parameters: { type: "object", properties: {} },
      execute: searchAgentsMock,
    });
    freshRuntime.registerTool({
      name: "run_workflow",
      description: "Run a reusable workflow.",
      parameters: { type: "object", properties: {} },
      execute: runWorkflowMock,
    });

    const session = new freshRuntime.AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    session.addMessage({ role: "user", content: "check meine n8n-projektliste ob ich neue einträge habe" });
    session.addMessage({
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "prior_n8n_project_list_run",
        type: "function",
        function: {
          name: "run_workflow",
          arguments: JSON.stringify({
            name: "n8n_project_list",
            workflowType: "scene",
          }),
        },
      }],
    });
    session.addMessage({
      role: "tool",
      content: "Workflow n8n_project_list [scene] completed.\n\nVisible workflows:\n- Daily Sync Workflow\n\nShould I run Daily Sync Workflow?\nRUN_CANDIDATE: Daily Sync Workflow",
      tool_call_id: "prior_n8n_project_list_run",
      metadata: {
        workflowName: "n8n_project_list",
        workflowType: "scene",
        blocked: false,
      },
    });
    session.addMessage({
      role: "assistant",
      content: "I found Daily Sync Workflow. Should I run it?\nRUN_CANDIDATE: Daily Sync Workflow",
    });

    const result = await freshRuntime.runTurn({
      session,
      userMessage: "ja",
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toContain("approved n8n workflow");
    expect(searchAgentsMock).not.toHaveBeenCalled();
    expect(runWorkflowMock).toHaveBeenCalledTimes(1);
    expect((runWorkflowMock.mock.calls[0] as unknown as [Record<string, unknown>] | undefined)?.[0]).toEqual(expect.objectContaining({
      name: "n8n_run_workflow",
      workflowType: "scene",
      params: {
        workflowName: "Daily Sync Workflow",
      },
    }));
    expect(result.guardrailEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "workflow_required", details: "approved_run_candidate_follow_up_rejected" }),
    ]));

    const toolMessages = session.getHistory().filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[1]?.content).toContain("Workflow n8n_run_workflow [scene] completed");

    freshRuntime.unregisterTool("search_agents");
    freshRuntime.unregisterTool("run_workflow");
  });

  it("requires run_workflow after search_workflows returns a viable reusable match", async () => {
    const freshRuntime = await loadFreshRuntimeForToolMode("hybrid", {
      scenes: {
        protocol_comparison_paper: {
          description: "Compare multiple protocols through one reusable comparison paper workflow.",
          task: "Use the reusable comparison paper workflow for the requested protocol set.",
        },
      },
    });

    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createToolCallStream("workflow_search_1", "search_workflows", {
          query: "paper KI-Protokolle MCP A2A AG-UI",
          workflowType: "any",
          limit: 5,
        });
      }
      if (llmCallCount === 2) {
        return createDelegateToolCallStream("paper_delegate_after_search_1", {
          agentName: "mission_coordinator",
          task: "Write a source-grounded comparison paper about MCP, A2A, and AG-UI.",
        });
      }
      if (llmCallCount === 3) {
        return createToolCallStream("paper_workflow_after_search_1", "run_workflow", {
          name: "protocol_comparison_paper",
          workflowType: "scene",
          params: {
            topic: "MCP, A2A, and AG-UI",
          },
        });
      }
      return createTextStream("I used the reusable comparison-paper workflow after catalog search instead of delegating ad hoc.");
    });

    const delegateExecuteMock = vi.fn(async () => ({
      success: true,
      output: "delegate should not run",
    }));
    const searchWorkflowsMock = vi.fn(async () => ({
      success: true,
      output: "Workflow matches for paper KI-Protokolle MCP A2A AG-UI: protocol_comparison_paper [scene]",
      metadata: {
        workflowMatches: [
          {
            name: "protocol_comparison_paper",
            workflowType: "scene",
            score: 0.33,
            matchedTerms: ["paper", "protocol", "mcp"],
          },
        ],
      },
    }));
    const runWorkflowMock = vi.fn(async () => ({
      success: true,
      output: "Workflow protocol_comparison_paper [scene] completed.\n\nReusable comparison workflow finished.",
      metadata: {
        workflowName: "protocol_comparison_paper",
        workflowType: "scene",
        blocked: false,
      },
    }));

    freshRuntime.registerTool({
      name: "delegate_to_agent",
      description: "Delegate to a specialist.",
      parameters: { type: "object", properties: {} },
      execute: delegateExecuteMock,
    });
    freshRuntime.registerTool({
      name: "search_workflows",
      description: "Search reusable workflows.",
      parameters: { type: "object", properties: {} },
      execute: searchWorkflowsMock,
    });
    freshRuntime.registerTool({
      name: "run_workflow",
      description: "Run a reusable workflow.",
      parameters: { type: "object", properties: {} },
      execute: runWorkflowMock,
    });

    const session = new freshRuntime.AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    const result = await freshRuntime.runTurn({
      session,
      userMessage: "Kannst du mir bitte ein kurzes Paper zu KI-Protokollen mit Fokus auf MCP, A2A und AG-UI schreiben?",
    });

    expect(result.blocked).toBe(false);
    expect(streamMock).toHaveBeenCalledTimes(4);
    expect(searchWorkflowsMock).toHaveBeenCalledTimes(1);
    expect(delegateExecuteMock).not.toHaveBeenCalled();
    expect(runWorkflowMock).toHaveBeenCalledTimes(1);
    expect(result.guardrailEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "workflow_required", details: "workflow_run_required_after_search" }),
    ]));

    const toolMessages = session.getHistory().filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[0]?.content).toContain("Workflow catalog suggestions only");
    expect(toolMessages[1]?.content).toContain("Workflow protocol_comparison_paper [scene] completed");

    freshRuntime.unregisterTool("delegate_to_agent");
    freshRuntime.unregisterTool("search_workflows");
    freshRuntime.unregisterTool("run_workflow");
  });

  it("does not force run_workflow for workflow-authoring maintenance requests", async () => {
    const freshRuntime = await loadFreshRuntimeForToolMode("orchestration_only");

    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createToolCallStream("workflow_search_for_authoring_1", "search_workflows", {
          query: "n8n browser login workflow",
          workflowType: "any",
          limit: 5,
        });
      }
      if (llmCallCount === 2) {
        return createDelegateToolCallStream("workflow_authoring_delegate_1", {
          agentName: "swarm_maintainer",
          task: "Create a new workflow that opens http://n8n.k2o, fills the matching credentials, logs in, and opens the project list.",
        });
      }
      return createTextStream("I delegated the workflow creation to swarm_maintainer.");
    });

    const searchWorkflowsMock = vi.fn(async () => ({
      success: true,
      output: "Workflow matches for n8n browser login workflow: browser_inspection [scene]",
      metadata: {
        workflowMatches: [
          {
            name: "browser_inspection",
            workflowType: "scene",
            score: 0.41,
            matchedTerms: ["browser", "workflow"],
          },
        ],
      },
    }));
    const delegateExecuteMock = vi.fn(async () => ({
      success: true,
      output: "swarm_maintainer created the new workflow definition.",
    }));

    freshRuntime.registerTool({
      name: "search_workflows",
      description: "Search reusable workflows.",
      parameters: { type: "object", properties: {} },
      execute: searchWorkflowsMock,
    });
    freshRuntime.registerTool({
      name: "delegate_to_agent",
      description: "Delegate to a specialist.",
      parameters: { type: "object", properties: {} },
      execute: delegateExecuteMock,
    });

    const session = new freshRuntime.AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    const result = await freshRuntime.runTurn({
      session,
      userMessage: "lass uns einen neuen workflow generieren, der per browser-agent http://n8n.k2o öffnet, credentials einfügt und danach die project-list öffnet",
    });

    expect(searchWorkflowsMock).toHaveBeenCalledTimes(1);
    expect(delegateExecuteMock).toHaveBeenCalledTimes(1);
    expect(streamMock).toHaveBeenCalledTimes(3);
    expect(result.guardrailEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "workflow_required", details: "workflow_run_required_after_search" }),
    ]));

    const toolMessages = session.getHistory().filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[0]?.content).toContain("Workflow catalog suggestions only");
    expect(toolMessages[1]?.content).toContain("swarm_maintainer created the new workflow definition.");

    freshRuntime.unregisterTool("search_workflows");
    freshRuntime.unregisterTool("delegate_to_agent");
  });

  it("does not reject credential follow-ups for workflow authoring with a workflow catalog check", async () => {
    const freshRuntime = await loadFreshRuntimeForToolMode("orchestration_only");

    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createDelegateToolCallStream("workflow_authoring_followup_delegate_1", {
          agentName: "swarm_maintainer",
          task: "Create a new workflow that opens http://n8n.k2o, uses the matching site-data credentials to log in, and opens the project list.",
        });
      }
      return createTextStream("I delegated the workflow creation to swarm_maintainer.");
    });

    const delegateExecuteMock = vi.fn(async () => ({
      success: true,
      output: "swarm_maintainer created the new workflow definition.",
    }));
    const searchWorkflowsMock = vi.fn(async () => ({
      success: true,
      output: "Workflow matches for site-data: competitive_analysis [scene]",
      metadata: {
        workflowMatches: [
          {
            name: "competitive_analysis",
            workflowType: "scene",
            score: 0.54,
            matchedTerms: ["alles", "den", "data"],
          },
        ],
      },
    }));
    const runWorkflowMock = vi.fn(async () => ({
      success: true,
      output: "competitive_analysis ran.",
    }));

    freshRuntime.registerTool({
      name: "delegate_to_agent",
      description: "Delegate to a specialist.",
      parameters: { type: "object", properties: {} },
      execute: delegateExecuteMock,
    });
    freshRuntime.registerTool({
      name: "search_workflows",
      description: "Search reusable workflows.",
      parameters: { type: "object", properties: {} },
      execute: searchWorkflowsMock,
    });
    freshRuntime.registerTool({
      name: "run_workflow",
      description: "Run a reusable workflow.",
      parameters: { type: "object", properties: {} },
      execute: runWorkflowMock,
    });

    const session = new freshRuntime.AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    session.addMessage({ role: "user", content: "lass uns einen neuen workflow generieren" });
    session.addMessage({ role: "assistant", content: "Wo sind die Credentials hinterlegt?" });

    const result = await freshRuntime.runTurn({
      session,
      userMessage: "ist alles in den credentials hinterlegt und in den site-data",
    });

    expect(result.blocked).toBe(false);
    expect(delegateExecuteMock).toHaveBeenCalledTimes(1);
    expect(searchWorkflowsMock).not.toHaveBeenCalled();
    expect(runWorkflowMock).not.toHaveBeenCalled();
    expect(streamMock).toHaveBeenCalledTimes(2);
    expect(result.guardrailEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "workflow_required", details: "workflow_catalog_check_rejected" }),
    ]));

    freshRuntime.unregisterTool("delegate_to_agent");
    freshRuntime.unregisterTool("search_workflows");
    freshRuntime.unregisterTool("run_workflow");
  });

  it("forces delegation for workflow-authoring follow-ups instead of accepting a tool-free promise", async () => {
    const freshRuntime = await loadFreshRuntimeForToolMode("orchestration_only");

    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createTextStream("Da die Credentials in den gespeicherten Credentials und site-data hinterlegt sind, erstelle ich jetzt einen spezialisierten Workflow-Agenten, der diesen Workflow generiert.");
      }
      if (llmCallCount === 2) {
        return createDelegateToolCallStream("workflow_authoring_followup_delegate_retry_1", {
          agentName: "swarm_maintainer",
          task: "Create a new workflow that opens http://n8n.k2o, uses the matching site-data credentials to log in, and opens the project list.",
        });
      }
      return createTextStream("Ich habe die Workflow-Erstellung an swarm_maintainer delegiert.");
    });

    const delegateExecuteMock = vi.fn(async () => ({
      success: true,
      output: "swarm_maintainer created the new workflow definition.",
    }));

    freshRuntime.registerTool({
      name: "delegate_to_agent",
      description: "Delegate to a specialist.",
      parameters: { type: "object", properties: {} },
      execute: delegateExecuteMock,
    });

    const session = new freshRuntime.AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    session.addMessage({ role: "user", content: "lass uns einen neuen workflow generieren" });
    session.addMessage({ role: "assistant", content: "Wo sind die Credentials hinterlegt?" });

    const result = await freshRuntime.runTurn({
      session,
      userMessage: "ist alles in den cedentials hintelegt und in den site-data",
    });

    expect(result.blocked).toBe(false);
    expect(delegateExecuteMock).toHaveBeenCalledTimes(1);
    expect(streamMock).toHaveBeenCalledTimes(3);
    expect(result.guardrailEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "delegation_required", details: "tool_free_maintenance_answer_rejected" }),
    ]));

    freshRuntime.unregisterTool("delegate_to_agent");
  });

  it("forces an exact workflow retry after an invalid workflow name following catalog search", async () => {
    const freshRuntime = await loadFreshRuntimeForToolMode("hybrid", {
      scenes: {
        protocol_comparison_paper: {
          description: "Compare multiple protocols through one reusable comparison paper workflow.",
          task: "Use the reusable comparison paper workflow for the requested protocol set.",
        },
      },
    });

    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createToolCallStream("workflow_search_then_bad_name_1", "search_workflows", {
          query: "paper KI-Protokolle MCP A2A AG-UI",
          workflowType: "any",
          limit: 5,
        });
      }
      if (llmCallCount === 2) {
        return createToolCallStream("workflow_bad_name_then_retry_1", "run_workflow", {
          name: "paper_writer",
          workflowType: "job",
          params: {
            topic: "MCP, A2A, and AG-UI",
          },
        });
      }
      if (llmCallCount === 3) {
        return createToolCallStream("workflow_exact_retry_after_bad_name_1", "run_workflow", {
          name: "protocol_comparison_paper",
          workflowType: "scene",
          params: {
            topic: "MCP, A2A, and AG-UI",
          },
        });
      }
      return createTextStream("I corrected the workflow name and used the returned catalog match.");
    });

    const searchWorkflowsMock = vi.fn(async () => ({
      success: true,
      output: "Workflow catalog suggestions only",
      metadata: {
        workflowMatches: [
          {
            name: "protocol_comparison_paper",
            workflowType: "scene",
            score: 0.33,
            matchedTerms: ["paper", "protocol", "mcp"],
          },
        ],
      },
    }));

    let runWorkflowCallCount = 0;
    const runWorkflowMock = vi.fn(async () => {
      runWorkflowCallCount += 1;
      if (runWorkflowCallCount === 1) {
        return {
          success: false,
          output: "",
          error: "Workflow not found: paper_writer",
        };
      }
      return {
        success: true,
        output: "Workflow protocol_comparison_paper [scene] completed.\n\nReusable comparison workflow finished.",
        metadata: {
          workflowName: "protocol_comparison_paper",
          workflowType: "scene",
          blocked: false,
        },
      };
    });

    freshRuntime.registerTool({
      name: "search_workflows",
      description: "Search reusable workflows.",
      parameters: { type: "object", properties: {} },
      execute: searchWorkflowsMock,
    });
    freshRuntime.registerTool({
      name: "run_workflow",
      description: "Run a reusable workflow.",
      parameters: { type: "object", properties: {} },
      execute: runWorkflowMock,
    });

    const session = new freshRuntime.AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    const result = await freshRuntime.runTurn({
      session,
      userMessage: "Schreibe mir bitte ein kurzes Paper zu KI-Protokollen mit Fokus auf MCP, A2A und AG-UI.",
    });

    expect(result.blocked).toBe(false);
    expect(streamMock).toHaveBeenCalledTimes(4);
    expect(searchWorkflowsMock).toHaveBeenCalledTimes(1);
    expect(runWorkflowMock).toHaveBeenCalledTimes(2);
    expect(result.guardrailEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "workflow_required", details: "workflow_run_correction_required" }),
    ]));

    const toolMessages = session.getHistory().filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(3);
    expect(toolMessages[1]?.content).toContain("Workflow not found: paper_writer");
    expect(toolMessages[2]?.content).toContain("Workflow protocol_comparison_paper [scene] completed");

    freshRuntime.unregisterTool("search_workflows");
    freshRuntime.unregisterTool("run_workflow");
  });

  it("does not let short German politeness tokens misroute comparison-paper workflow detection", async () => {
    const freshRuntime = await loadFreshRuntimeForToolMode("hybrid", {
      scenes: {
        protocol_comparison_paper: {
          description: "Compare MCP and A2A through one reusable comparison paper workflow for AI protocol requests.",
          task: "Use the reusable comparison paper workflow for the requested MCP and A2A protocol set.",
        },
        api_test_suite: {
          description: "Test and validate API endpoints with structured request/response analysis and documentation.",
          task: "Use api_integrator to execute HTTP requests against the target API and produce a structured test report.",
        },
      },
    });

    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createDelegateToolCallStream("paper_delegate_polite_1", {
          agentName: "mission_coordinator",
          task: "Write a short comparison paper about MCP, A2A, and AG-UI.",
        });
      }
      if (llmCallCount === 2) {
        return createToolCallStream("paper_workflow_search_polite_1", "search_workflows", {
          query: "paper KI-Protokolle MCP A2A AG-UI",
          workflowType: "any",
          limit: 5,
        });
      }
      if (llmCallCount === 3) {
        return createToolCallStream("paper_workflow_run_polite_1", "run_workflow", {
          name: "protocol_comparison_paper",
          workflowType: "scene",
          params: {
            topic: "MCP, A2A, and AG-UI",
          },
        });
      }
      return createTextStream("I used the reusable comparison-paper workflow for the requested protocol paper.");
    });

    const delegateExecuteMock = vi.fn(async () => ({
      success: true,
      output: "delegate should not run",
    }));
    const searchWorkflowsMock = vi.fn(async () => ({
      success: true,
      output: "Workflow catalog suggestions only",
      metadata: {
        workflowMatches: [
          {
            name: "protocol_comparison_paper",
            workflowType: "scene",
            score: 0.34,
            matchedTerms: ["paper", "mcp", "a2a"],
          },
          {
            name: "api_test_suite",
            workflowType: "scene",
            score: 0.2,
            matchedTerms: ["api"],
          },
        ],
      },
    }));
    const runWorkflowMock = vi.fn(async () => ({
      success: true,
      output: "Workflow protocol_comparison_paper [scene] completed.\n\nReusable comparison workflow finished.",
      metadata: {
        workflowName: "protocol_comparison_paper",
        workflowType: "scene",
        blocked: false,
      },
    }));

    freshRuntime.registerTool({
      name: "delegate_to_agent",
      description: "Delegate to a specialist.",
      parameters: { type: "object", properties: {} },
      execute: delegateExecuteMock,
    });
    freshRuntime.registerTool({
      name: "search_workflows",
      description: "Search reusable workflows.",
      parameters: { type: "object", properties: {} },
      execute: searchWorkflowsMock,
    });
    freshRuntime.registerTool({
      name: "run_workflow",
      description: "Run a reusable workflow.",
      parameters: { type: "object", properties: {} },
      execute: runWorkflowMock,
    });

    const session = new freshRuntime.AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    const result = await freshRuntime.runTurn({
      session,
      userMessage: "Kannst du mir jetzt bitte ein kurzes Paper zum Thema KI-Protokolle schreiben? Hier im Schwerpunkt MCP, A2A und AG-UI.",
    });

    expect(result.blocked).toBe(false);
    expect(delegateExecuteMock).not.toHaveBeenCalled();
    expect(searchWorkflowsMock).toHaveBeenCalledTimes(1);
    expect(runWorkflowMock).toHaveBeenCalledTimes(1);

    const guardrailAudit = vi.mocked(logAudit).mock.calls.find((call) => (
      call[0] === "guardrail_flagged"
      && typeof call[1] === "object"
      && call[1] !== null
      && (call[1] as { type?: string }).type === "workflow_catalog_check_rejected"
    ));

    expect(guardrailAudit).toBeDefined();
    expect((guardrailAudit?.[1] as { strongestMatch?: { name?: string } }).strongestMatch?.name).toBe("protocol_comparison_paper");
    expect((guardrailAudit?.[1] as { strongestMatch?: { name?: string } }).strongestMatch?.name).not.toBe("api_test_suite");

    const toolMessages = session.getHistory().filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[0]?.content).toContain("Workflow catalog suggestions only");
    expect(toolMessages[1]?.content).toContain("Workflow protocol_comparison_paper [scene] completed");

    freshRuntime.unregisterTool("delegate_to_agent");
    freshRuntime.unregisterTool("search_workflows");
    freshRuntime.unregisterTool("run_workflow");
  });

  it("rejects search_agents detours while an exact workflow retry is required", async () => {
    const freshRuntime = await loadFreshRuntimeForToolMode("hybrid", {
      scenes: {
        protocol_comparison_paper: {
          description: "Compare multiple protocols through one reusable comparison paper workflow.",
          task: "Use the reusable comparison paper workflow for the requested protocol set.",
        },
      },
    });

    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createToolCallStream("workflow_search_then_bad_name_2", "search_workflows", {
          query: "paper KI-Protokolle MCP A2A AG-UI",
          workflowType: "any",
          limit: 5,
        });
      }
      if (llmCallCount === 2) {
        return createToolCallStream("workflow_bad_name_then_agents_1", "run_workflow", {
          name: "paper_writer",
          workflowType: "job",
          params: {
            topic: "MCP, A2A, and AG-UI",
          },
        });
      }
      if (llmCallCount === 3) {
        return createToolCallStream("workflow_agents_detour_1", "search_agents", {
          query: "researcher paper writer synthesis",
        });
      }
      if (llmCallCount === 4) {
        return createToolCallStream("workflow_exact_retry_after_detour_1", "run_workflow", {
          name: "protocol_comparison_paper",
          workflowType: "scene",
          params: {
            topic: "MCP, A2A, and AG-UI",
          },
        });
      }
      return createTextStream("I corrected the workflow name instead of detouring into agent discovery.");
    });

    const workflowMatches = [
      {
        name: "protocol_comparison_paper",
        workflowType: "scene" as const,
        score: 0.33,
        matchedTerms: ["paper", "protocol", "mcp"],
      },
    ];

    const searchWorkflowsMock = vi.fn(async () => ({
      success: true,
      output: "Workflow catalog suggestions only",
      metadata: { workflowMatches },
    }));

    const searchAgentsMock = vi.fn(async () => ({
      success: true,
      output: "This should not execute while workflow correction is pending.",
    }));

    let runWorkflowCallCount = 0;
    const runWorkflowMock = vi.fn(async () => {
      runWorkflowCallCount += 1;
      if (runWorkflowCallCount === 1) {
        return {
          success: false,
          output: "",
          error: "Workflow not found: paper_writer",
          metadata: { workflowMatches },
        };
      }
      return {
        success: true,
        output: "Workflow protocol_comparison_paper [scene] completed.\n\nReusable comparison workflow finished.",
        metadata: {
          workflowName: "protocol_comparison_paper",
          workflowType: "scene",
          blocked: false,
        },
      };
    });

    freshRuntime.registerTool({
      name: "search_workflows",
      description: "Search reusable workflows.",
      parameters: { type: "object", properties: {} },
      execute: searchWorkflowsMock,
    });
    freshRuntime.registerTool({
      name: "search_agents",
      description: "Search agents.",
      parameters: { type: "object", properties: {} },
      execute: searchAgentsMock,
    });
    freshRuntime.registerTool({
      name: "run_workflow",
      description: "Run a reusable workflow.",
      parameters: { type: "object", properties: {} },
      execute: runWorkflowMock,
    });

    const session = new freshRuntime.AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    const result = await freshRuntime.runTurn({
      session,
      userMessage: "Schreibe mir bitte ein kurzes Paper zu KI-Protokollen mit Fokus auf MCP, A2A und AG-UI.",
    });

    expect(result.blocked).toBe(false);
    expect(streamMock).toHaveBeenCalledTimes(5);
    expect(searchWorkflowsMock).toHaveBeenCalledTimes(1);
    expect(searchAgentsMock).not.toHaveBeenCalled();
    expect(runWorkflowMock).toHaveBeenCalledTimes(2);
    expect(result.guardrailEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "workflow_required", details: "workflow_run_correction_required" }),
      expect.objectContaining({ type: "workflow_required", details: "workflow_run_required_after_search" }),
    ]));

    const toolMessages = session.getHistory().filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(3);
    expect(toolMessages[1]?.content).toContain("Workflow not found: paper_writer");
    expect(toolMessages[2]?.content).toContain("Workflow protocol_comparison_paper [scene] completed");

    freshRuntime.unregisterTool("search_workflows");
    freshRuntime.unregisterTool("search_agents");
    freshRuntime.unregisterTool("run_workflow");
  });

  it("skips workflow-catalog enforcement inside active workflow execution turns", async () => {
    const freshRuntime = await loadFreshRuntimeForToolMode("hybrid", {
      scenes: {
        protocol_comparison_paper: {
          description: "Compare multiple protocols through one reusable comparison paper workflow.",
          task: "Use mission_coordinator first. Partition the requested protocols into comparison tracks and produce one grounded paper draft.",
        },
      },
    });

    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createDelegateToolCallStream("workflow_inner_delegate_1", {
          agentName: "mission_coordinator",
          task: "Compare MCP, A2A, and AG-UI using the active workflow plan.",
        });
      }
      return createTextStream("I delegated to mission_coordinator inside the active workflow without re-running workflow discovery.");
    });

    const delegateExecuteMock = vi.fn(async () => ({
      success: true,
      output: "Delegated result from mission_coordinator — TASK COMPLETED.\nObserved evidence:\nA grounded comparison plan is in progress.",
      metadata: {
        agentName: "mission_coordinator",
        attemptedAgents: ["mission_coordinator"],
        delegationSucceeded: true,
      },
    }));
    const searchWorkflowsMock = vi.fn(async () => ({
      success: true,
      output: "Workflow catalog suggestions only",
    }));
    const runWorkflowMock = vi.fn(async () => ({
      success: true,
      output: "Workflow protocol_comparison_paper [scene] completed.",
      metadata: {
        workflowName: "protocol_comparison_paper",
        workflowType: "scene",
        blocked: false,
      },
    }));

    freshRuntime.registerTool({
      name: "delegate_to_agent",
      description: "Delegate to a specialist.",
      parameters: { type: "object", properties: {} },
      execute: delegateExecuteMock,
    });
    freshRuntime.registerTool({
      name: "search_workflows",
      description: "Search reusable workflows.",
      parameters: { type: "object", properties: {} },
      execute: searchWorkflowsMock,
    });
    freshRuntime.registerTool({
      name: "run_workflow",
      description: "Run a reusable workflow.",
      parameters: { type: "object", properties: {} },
      execute: runWorkflowMock,
    });

    const session = new freshRuntime.AgentSession({
      channel: "workflow",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    const result = await freshRuntime.runTurn({
      session,
      userMessage: "Use mission_coordinator first. Partition MCP, A2A, and AG-UI into comparison tracks and draft one grounded paper.",
      _workflowExecutionStack: ["scene:protocol_comparison_paper"],
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toContain("without re-running workflow discovery");
    expect(streamMock).toHaveBeenCalledTimes(2);
    expect(delegateExecuteMock).toHaveBeenCalledTimes(1);
    expect(searchWorkflowsMock).not.toHaveBeenCalled();
    expect(runWorkflowMock).not.toHaveBeenCalled();
    expect(result.guardrailEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "workflow_required" }),
    ]));

    freshRuntime.unregisterTool("delegate_to_agent");
    freshRuntime.unregisterTool("search_workflows");
    freshRuntime.unregisterTool("run_workflow");
  });

  it("preserves blocked workflow output instead of flattening it to unknown error", async () => {
    const freshRuntime = await loadFreshRuntimeForToolMode("hybrid");

    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createToolCallStream("workflow_fail_1", "run_workflow", {
          name: "protocol_comparison_paper",
          workflowType: "scene",
        });
      }
      return createTextStream("I reported the actual workflow failure.");
    });

    const observedToolResults: string[] = [];
    const runWorkflowMock = vi.fn(async () => ({
      success: false,
      output: "Workflow protocol_comparison_paper [scene] blocked. The workflow tried to answer without delegating to a research specialist first.",
      metadata: {
        workflowName: "protocol_comparison_paper",
        workflowType: "scene",
        blocked: true,
      },
    }));

    freshRuntime.registerTool({
      name: "run_workflow",
      description: "Run a reusable workflow.",
      parameters: { type: "object", properties: {} },
      execute: runWorkflowMock,
    });

    const session = new freshRuntime.AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    const result = await freshRuntime.runTurn({
      session,
      userMessage: "Run the comparison-paper workflow and use current sources.",
      onToolResult: (_toolCallId, _name, toolResult) => observedToolResults.push(toolResult),
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toContain("actual workflow failure");
    expect(runWorkflowMock).toHaveBeenCalledTimes(1);
    expect(observedToolResults).toHaveLength(1);
    expect(observedToolResults[0]).toContain("blocked");
    expect(observedToolResults[0]).not.toContain("Unknown error");

    freshRuntime.unregisterTool("run_workflow");
  });

  it("forces synthesis after a completed workflow instead of allowing fresh delegation", async () => {
    const freshRuntime = await loadFreshRuntimeForToolMode("hybrid");

    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createToolCallStream("workflow_complete_then_delegate_1", "run_workflow", {
          name: "deep_research_dossier",
          workflowType: "scene",
        });
      }
      if (llmCallCount === 2) {
        return createDelegateToolCallStream("workflow_complete_then_delegate_2", {
          agentName: "mission_coordinator",
          task: "Continue researching MCP, A2A, and AG-UI after the workflow completed.",
        });
      }
      return createTextStream("This should not be needed.");
    });

    const delegateExecuteMock = vi.fn(async () => ({
      success: true,
      output: "delegate should not run",
    }));
    const runWorkflowMock = vi.fn(async () => ({
      success: true,
      output: "Workflow deep_research_dossier [scene] completed.\n\nValidated research dossier finished with grounded evidence.",
      metadata: {
        workflowName: "deep_research_dossier",
        workflowType: "scene",
        blocked: false,
        executedSteps: 1,
        stepCount: 1,
      },
    }));

    freshRuntime.registerTool({
      name: "delegate_to_agent",
      description: "Delegate to a specialist.",
      parameters: { type: "object", properties: {} },
      execute: delegateExecuteMock,
    });
    freshRuntime.registerTool({
      name: "run_workflow",
      description: "Run a reusable workflow.",
      parameters: { type: "object", properties: {} },
      execute: runWorkflowMock,
    });

    const session = new freshRuntime.AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    const result = await freshRuntime.runTurn({
      session,
      userMessage: "Create a source-grounded dossier about MCP, A2A, and AG-UI.",
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toBe("synthesized");
    expect(streamMock).toHaveBeenCalledTimes(2);
    expect(runWorkflowMock).toHaveBeenCalledTimes(1);
    expect(delegateExecuteMock).not.toHaveBeenCalled();
    expect(result.guardrailEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "synthesis_required", details: "post_orchestration_tool_call_rejected" }),
    ]));

    const toolMessages = session.getHistory().filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]?.content).toContain("Workflow deep_research_dossier [scene] completed");

    freshRuntime.unregisterTool("delegate_to_agent");
    freshRuntime.unregisterTool("run_workflow");
  });
});