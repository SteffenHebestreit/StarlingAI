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

async function loadFreshRuntimeForToolMode(toolMode: "hybrid" | "orchestration_only") {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-runtime-toolmode-"));
  tempConfigDirs.push(tempDir);
  const configPath = join(tempDir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({
    agents: {
      mainAssistant: {
        toolMode,
      },
    },
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
  streamMock.mockReset();
  completeMock.mockClear();
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

  it("forces specialist-agent orchestration for explicit online lookup requests instead of allowing direct web tool calls", async () => {
    let llmCallCount = 0;
    streamMock.mockImplementation((_messages, tools) => {
      llmCallCount += 1;
      const toolNames = tools.map((tool) => tool.name);
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
});