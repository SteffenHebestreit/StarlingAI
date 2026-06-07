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
import { buildModelVisibleToolResult, runTurn } from "../agent/runtime.js";
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

function createTextThenToolCallStream(text: string, callId: string, toolName: string, args: Record<string, unknown>) {
  return (async function* () {
    yield { type: "text_delta", content: text };
    yield { type: "tool_call_start", toolCallId: callId, toolName };
    yield { type: "tool_call_delta", toolCallId: callId, argumentsDelta: JSON.stringify(args) };
    yield {
      type: "done",
      finishReason: "tool_calls",
      usage: { promptTokens: 1, completionTokens: 4096, totalTokens: 4097 },
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

function createThrowingStream(message: string) {
  return (async function* () {
    throw new Error(message);
  })();
}

function createLengthLimitedTextStream(text: string) {
  return (async function* () {
    yield { type: "text_delta", content: text };
    yield {
      type: "done",
      finishReason: "length",
      usage: { promptTokens: 1, completionTokens: 4096, totalTokens: 4097 },
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
  unregisterTool("create_ephemeral_agent");
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
    expect(result.performance?.finishReason).toBe("synthesis_required_tool_call_rejected");
    expect(streamMock).toHaveBeenCalledTimes(2);
    expect(delegateExecuteMock).toHaveBeenCalledTimes(1);
    expect(observedToolResults).toHaveLength(1);
    expect(observedToolResults[0]).toContain("## Authorization Confirmed");
    expect(result.guardrailEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "synthesis_required", details: "post_orchestration_tool_call_rejected" }),
    ]));
    expect(logAudit).toHaveBeenCalledWith(
      "turn_scorecard",
      expect.objectContaining({
        forcedSynthesisFired: true,
        finishReason: "synthesis_required_tool_call_rejected",
      }),
      expect.objectContaining({ severity: "warn" }),
    );

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
    expect(result.performance?.finishReason).toBe("user_response_required_tool_call_rejected");
    expect(streamMock).toHaveBeenCalledTimes(2);
    expect(delegateExecuteMock).toHaveBeenCalledTimes(1);
    expect(result.guardrailEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "synthesis_required", details: "post_orchestration_tool_call_rejected" }),
    ]));
    expect(logAudit).toHaveBeenCalledWith(
      "turn_scorecard",
      expect.objectContaining({
        forcedSynthesisFired: true,
        finishReason: "user_response_required_tool_call_rejected",
      }),
      expect.objectContaining({ severity: "warn" }),
    );

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

  it("emits a scorecard when the max-iteration terminal synthesis path returns", async () => {
    const fresh = await loadFreshRuntimeForToolMode("hybrid");
    streamMock.mockImplementation(() => createToolCallStream("web_1", "web_search", { query: "portable recorder mcu" }));

    const webSearchExecuteMock = vi.fn(async () => ({
      success: true,
      output: "Observed evidence:\nESP32-P4 and STM32U5 are relevant MCU options.",
    }));

    fresh.registerTool({
      name: "web_search",
      description: "Search the web.",
      parameters: { type: "object", properties: {} },
      execute: webSearchExecuteMock,
    });

    const session = new fresh.AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    const result = await fresh.runTurn({
      session,
      // Avoid a leading "research" command (now classified source-sensitive) —
      // this test exercises the max-iteration synthesis mechanic, not routing.
      userMessage: "Summarize portable recorder MCU options.",
      maxIterationsOverride: 1,
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toBe("synthesized");
    expect(result.performance?.finishReason).toBe("max_tool_iterations");
    expect(streamMock).toHaveBeenCalledTimes(1);
    expect(webSearchExecuteMock).toHaveBeenCalledTimes(1);
    expect(completeMock).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(
      "turn_scorecard",
      expect.objectContaining({
        forcedSynthesisFired: false,
        finishReason: "max_tool_iterations",
        finalAnswerLength: "synthesized".length,
        toolIterations: 1,
      }),
      expect.objectContaining({ severity: "warn" }),
    );
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

  it("falls back to delegated evidence when both the final draft and forced synthesis are empty", async () => {
    const delegatedEvidence = [
      "## Recherche-Ergebnis: Robuste Edge-Service-Integration",
      "",
      "### Kein fertiger One-Click-Adapter",
      "Es gibt keinen fertigen Adapter, der gleichzeitig Offline-Pufferung, klare Sync-Zustaende und zentralisierte Gateway-Konfiguration abdeckt.",
      "",
      "### Beste Integrationskandidaten",
      "| Baustein | Rolle | Vorteil | Hinweis |",
      "|----------|------|---------|---------|",
      "| Gateway-Config | Endpoint-Quelle | Zentral | Kein Duplikat in Clients |",
      "| Local Queue | Offline-Puffer | Robust | Bounded retries noetig |",
      "| Sync Worker | Uebertragung | Explizit | Status sichtbar halten |",
      "",
      "### Queue-zu-Sync-Option",
      "- Bounded Sync Queue: 4 Prioritaetsklassen, Retry-Budget, Low-Power-Modus.",
      "- Empfehlung: lokaler Puffer mit Record-/Sync-Button statt dauerhaftem Polling.",
      "",
      "### Fazit",
      "1. Zentralisierte Gateway-Konfiguration ist die robusteste Basis fuer das Deployment.",
      "2. Eine lokale Queue ist die realistischste Option bei intermittierender Verbindung.",
      "3. Fuer dein Projekt ist ein expliziter Sync-Modus mit getrenntem Record- und Sync-Status die klarste Bauform.",
    ].join("\n");

    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createDelegateToolCallStream("call_empty_backstop", {
          agentName: "researcher",
          task: "Find robust edge-service integration patterns for an offline-capable recorder.",
        });
      }

      return createTextStream("");
    });

    completeMock.mockImplementationOnce(async () => ({
      content: "",
      tool_calls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: "stop",
    }));

    const delegateExecuteMock = vi.fn(async () => ({
      success: true,
      output: delegatedEvidence,
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
      userMessage: "Find robust edge-service integration patterns for an offline-capable recorder.",
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toContain("## Recherche-Ergebnis: Robuste Edge-Service-Integration");
    expect(result.response).toContain("Gateway-Config");
    expect(result.response).not.toContain("I wasn't able to generate a usable reply for that turn");
    expect(streamMock).toHaveBeenCalledTimes(2);
    expect(delegateExecuteMock).toHaveBeenCalledTimes(1);
    expect(completeMock).toHaveBeenCalledTimes(1);
    expect(session.getHistory().at(-1)?.content).toContain("Bounded Sync Queue");
  });

  it("falls back to rich delegated evidence when resynthesis is still too short", async () => {
    const detailedEvidence = [
      "1. Centralized endpoint configuration remains the strongest current fit when the deployment needs one authoritative runtime source and minimal client-side drift.",
      "2. A bounded local queue remains attractive when long offline windows matter more than immediate server-side processing.",
      "3. An explicit sync worker adds useful control but still depends on careful retry budgets, observability, and clear status transitions for a polished field deployment.",
      "4. Push-based delivery is best when connectivity is reliable, but offline-first capture still favors local buffering unless a companion transport is acceptable.",
      "5. Off-the-shelf workflow modules remain useful for prototypes; exact product constraints still usually require a small custom integration layer.",
      "6. A practical 2026 stack still pairs centralized configuration with a bounded local queue when reliability matters more than turnkey module reuse.",
      "7. Verification should happen before drafting the final recommendation: inspect the active endpoint source, inspect retry limits, inspect sync state transitions, and only then summarize what is actually supported by evidence.",
      "8. Shared findings should be read before launching another research wave so the coordinator can reuse endpoint, queue, and sync-worker facts that are already known instead of delegating the same lookup again.",
      "9. The final response should be grounded in shared findings and delegated evidence: include confirmed endpoint ownership, offline behavior, retry policy, and unknowns rather than relying on model memory about generic edge deployments.",
    ].join("\n\n");

    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createDelegateToolCallStream("coverage_delegate_1", {
          agentName: "web_task_coordinator",
          task: "Research the best 2026 runtime options for offline-capable service integration.",
        });
      }

      return createTextStream([
        "1. Centralized config is useful.",
        "2. Local queues help.",
      ].join("\n"));
    });

    completeMock.mockResolvedValueOnce({
      content: "Short synthesis.",
      tool_calls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: "stop",
    });

    const delegateExecuteMock = vi.fn(async () => ({
      success: true,
      output: detailedEvidence,
      metadata: {
        agentName: "web_task_coordinator",
        attemptedAgents: ["web_task_coordinator"],
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

    const result = await runTurn({
      session,
      userMessage: "Which runtime options are best in 2026 for offline-capable service integration?",
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toBe(detailedEvidence);
    expect(streamMock).toHaveBeenCalledTimes(2);
    expect(completeMock).toHaveBeenCalledTimes(1);
    expect(delegateExecuteMock).toHaveBeenCalledTimes(1);
  });

  it("uses grounded delegate evidence and asks the user whether to raise the limit when the per-turn delegation limit is hit", async () => {
    const detailedEvidence = [
      "1. ESP32-P4 remains the strongest current fit when the recorder needs local UI control, stronger DSP headroom, and a practical Wi-Fi-first developer path on one compact battery-powered board.",
      "2. STM32U5 remains the conservative low-power option when unattended runtime and sleep-heavy duty cycles matter more than aggressive on-device audio or inference work.",
      "3. RP2350 is capable but still shifts too much burden onto custom board bring-up and external audio-front-end integration for a polished OTA recorder build.",
      "4. nRF5340 is better when BLE audio transport is the main goal, but it is less compelling than ESP32-class parts for a self-contained Wi-Fi recorder.",
      "5. Flat multi-mic recorder arrays still mostly require custom PCB work if the target is a credit-card form factor with exact geometry and battery constraints.",
      "6. The practical direction is still an ESP32-class Wi-Fi MCU plus a custom microphone array PCB rather than waiting for a turnkey off-the-shelf recorder board.",
      "Next step: inspect the battery-runtime trade-off notes before deciding whether to keep delegating or stop here.",
    ].join("\n\n");

    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      return createDelegateToolCallStream(`limit_stop_${llmCallCount}`, {
        agentName: "web_task_coordinator",
        task: `Research portable recorder MCU options pass ${llmCallCount}`,
      });
    });

    const delegateExecuteMock = vi.fn(async () => ({
      success: true,
      output: detailedEvidence,
      metadata: {
        agentName: "web_task_coordinator",
        attemptedAgents: ["web_task_coordinator"],
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

    const result = await runTurn({
      session,
      userMessage: "Keep researching the best portable recorder MCU stack.",
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toContain("best grounded result collected so far");
    expect(result.response).toContain("ESP32-P4 remains the strongest current fit");
    expect(result.response).toContain("tell me to raise the delegation limit for this task");
    expect(result.response).toContain("Otherwise, we can stop here.");
    expect(streamMock).toHaveBeenCalledTimes(6);
    expect(delegateExecuteMock).toHaveBeenCalledTimes(5);
    expect(completeMock).toHaveBeenCalledTimes(0);
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
      // Avoid a leading "research" command (now classified source-sensitive) —
      // this test exercises the next-turn-handoff rewrite, not routing.
      userMessage: "Summarize how StarlingAI can improve itself.",
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toBe("synthesized");
    expect(delegateExecuteMock).toHaveBeenCalledTimes(1);
    expect(completeMock).toHaveBeenCalledTimes(1);
    expect(session.getHistory().at(-1)?.content).toBe("synthesized");
  });

  it("does not stream provisional final text live after tool-backed turns", async () => {
    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createDelegateToolCallStream("call_no_live_post_tool_text", {
          agentName: "researcher",
          task: "Research current penetration testing frameworks.",
        });
      }

      return createTextStream("This provisional streamed text should not be emitted live.");
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

    const chunks: string[] = [];
    const result = await runTurn({
      session,
      userMessage: "Research current penetration testing frameworks.",
      onChunk: (text) => chunks.push(text),
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toBe("This provisional streamed text should not be emitted live.");
    expect(chunks).toEqual([]);
    expect(streamMock).toHaveBeenCalledTimes(2);
    expect(delegateExecuteMock).toHaveBeenCalledTimes(1);
    expect(completeMock).toHaveBeenCalledTimes(0);
  });

  it("does not leak mixed text/tool-call drafts and stops unavailable write_file loops", async () => {
    streamMock
      .mockImplementationOnce(() => createTextThenToolCallStream(
        "This is a long provisional artifact draft that must not be streamed.",
        "write_file_1",
        "write_file",
        { path: "artifacts/guide.md", content: "# Guide\nDraft" },
      ))
      .mockImplementationOnce(() => createTextThenToolCallStream(
        "This is the repeated provisional artifact draft that must also stay hidden.",
        "write_file_2",
        "write_file",
        { path: "artifacts/guide.md", content: "# Guide\nDraft" },
      ));
    completeMock.mockResolvedValueOnce({
      content: "I could not create the file directly in this turn, so I am stopping the tool loop and reporting the available result.",
      tool_calls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: "stop",
    });

    const session = new AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    const chunks: string[] = [];
    const result = await runTurn({
      session,
      userMessage: "Research current hardware components and create a downloadable file with the answer.",
      onChunk: (text) => chunks.push(text),
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toContain("stopping the tool loop");
    expect(chunks).toEqual(["I could not create the file directly in this turn, so I am stopping the tool loop and reporting the available result."]);
    expect(chunks.join("")).not.toContain("provisional artifact draft");
    expect(streamMock).toHaveBeenCalledTimes(2);
    expect(completeMock).toHaveBeenCalledTimes(1);
    expect(result.guardrailEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "assistant_text_suppressed", details: "tool_call_response" }),
    ]));
    expect(result.performance?.finishReason).toBe("all_tool_calls_blocked");
    expect(logAudit).toHaveBeenCalledWith(
      "assistant_text_with_tool_calls_suppressed",
      expect.objectContaining({ toolNames: ["write_file"] }),
      expect.objectContaining({ severity: "warn" }),
    );
    expect(logAudit).toHaveBeenCalledWith(
      "tool_loop_detected",
      expect.objectContaining({ reason: "all_tool_calls_blocked" }),
      expect.objectContaining({ severity: "warn" }),
    );
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
    // The mock synthesis returns the literal "synthesized" — a 12-char
    // reply that the runtime now correctly recognizes as underpowered
    // when substantial delegated evidence is available.  In that case
    // the response is the evidence-backstop content rather than the
    // synthesis fragment.  This is the fix for "all info gathered but
    // no answer" turns: the user gets the actual evidence the agent
    // collected, not a 50-100 char apology.  The guardrail still fires
    // and synthesis is still attempted — only the FINAL response prefers
    // evidence over a stub-length synthesis output.
    expect(result.response).toContain("Delegated result from ephemeral:weather_chart_generator");
    expect(result.response).toContain("specific, month-by-month average temperature data for last year (2025)");
    expect(streamMock).toHaveBeenCalledTimes(2);
    expect(delegateExecuteMock).toHaveBeenCalledTimes(1);
    expect(completeMock).toHaveBeenCalledTimes(1);
    expect(result.guardrailEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "synthesis_required", details: "post_orchestration_tool_call_rejected" }),
    ]));
  });

  it("uses rich delegated evidence directly when the model tries another delegation after synthesis is required", async () => {
    const richEvidence = [
      "# Verified integration guide",
      "",
      ...Array.from({ length: 16 }, (_, index) => `- Evidence item ${index + 1}: The inspected integration keeps the confirmed endpoint, credential scope, and retry behavior aligned with source-backed detail ${index + 1}.`),
      "",
      "Use the centralized configuration path for the quality-focused build.",
    ].join("\n");

    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createDelegateToolCallStream("integration_1", {
          task: "Research the service integration design.",
        });
      }

      return createDelegateToolCallStream("integration_2", {
        task: "Repeat the same integration research again.",
      });
    });

    const delegateExecuteMock = vi.fn(async () => ({
      success: true,
      output: [
        "Delegated result from researcher — TASK COMPLETED.",
        "Observed evidence:",
        richEvidence,
      ].join("\n"),
      metadata: {
        agentName: "researcher",
        attemptedAgents: ["researcher"],
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

    const result = await runTurn({
      session,
      userMessage: "Create a source-backed integration guide for the service deployment.",
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toContain("Verified integration guide");
    expect(result.response).toContain("Evidence item 16");
    expect(result.performance?.finishReason).toBe("synthesis_required_tool_call_rejected");
    expect(streamMock).toHaveBeenCalledTimes(2);
    expect(delegateExecuteMock).toHaveBeenCalledTimes(1);
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("wraps raw workspace config dumps as failed maintenance evidence", () => {
    const rawConfigDump = [
      ".starlingai/ agent_outcomes.ndjson README.md agents/ 10-core-agents.jsonc 21-orchestration.jsonc jobs/ 10-jobs.jsonc scenes/ 10-scenes.jsonc",
      "",
      "{ \"subAgents\": { \"browser_agent\": { \"model\": { \"primary\": \"lmstudio/qwen/qwen3.6-35b-a3b\" }, \"systemPrompt\": \"You are a browser automation specialist.\" } } }",
      "",
      "#### Tool Calls",
      "- list_files",
      "- read_file",
    ].join("\n");

    const visible = buildModelVisibleToolResult("delegate_to_agent", rawConfigDump, {
      agentName: "prompt_optimizer",
      attemptedAgents: ["swarm_maintainer", "coder", "prompt_optimizer"],
      delegationSucceeded: true,
      delegationOutcome: "partial",
      terminalState: "completed",
    });

    expect(visible).toContain("TASK FAILED");
    expect(visible).toContain("only returned raw workspace/config read output");
    expect(visible).not.toContain(".starlingai/");
    expect(visible).not.toContain("10-core-agents.jsonc");
  });

  it("uses workflow-execution evidence directly when the model tries another delegation after synthesis is required", async () => {
    // Regression: when run_workflow returns a substantive dossier and the
    // model then emits another tool call past [SYNTHESIS REQUIRED], the
    // terminal-evidence backstop must prefer the workflow dossier over the
    // suppressed preamble text. Previously the backstop only matched
    // delegate_to_agent / parallel_delegate / run_task_graph results, so
    // workflow output was treated as "no evidence available" and the user
    // received a 222-char "let me research…" preamble instead of the 14k
    // dossier the workflow had already produced.
    const workflowDossier = [
      "# Portable ESP32 audio recorder dossier",
      "",
      ...Array.from({ length: 16 }, (_, index) => `- Component decision ${index + 1}: verified part, datasheet URL, and rationale captured for slice ${index + 1}.`),
      "",
      "Final recommended bill of materials and pin layout follow above.",
    ].join("\n");

    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createToolCallStream("wf_run_1", "run_workflow", {
          name: "deep_research",
          workflowType: "scene",
          params: { topic: "Portable ESP32 audio recorder" },
        });
      }

      return createDelegateToolCallStream("post_synth_delegate", {
        agentName: "mission_coordinator",
        task: "Re-run the same research again.",
      });
    });

    const workflowExecuteMock = vi.fn(async () => ({
      success: true,
      output: [
        "Workflow deep_research [scene] completed. Executed steps: 1/1.",
        "IMPORTANT: Treat this as executed workflow output, not a plan.",
        "Observed evidence:",
        workflowDossier,
      ].join("\n"),
      metadata: {
        workflowName: "deep_research",
        workflowType: "scene",
        blocked: false,
        toolCallsExecuted: 2,
        stepCount: 1,
      },
    }));

    registerTool({
      name: "run_workflow",
      description: "Run a reusable workflow.",
      parameters: { type: "object", properties: {} },
      execute: workflowExecuteMock,
    });

    const session = new AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    try {
      const result = await runTurn({
        session,
        userMessage: "Build me a portable ESP32 recorder dossier with components and a layout.",
      });

      expect(result.blocked).toBe(false);
      expect(result.response).toContain("Portable ESP32 audio recorder dossier");
      expect(result.response).toContain("Component decision 16");
      expect(result.performance?.finishReason).toBe("synthesis_required_tool_call_rejected");
      expect(workflowExecuteMock).toHaveBeenCalledTimes(1);
    } finally {
      unregisterTool("run_workflow");
    }
  });

  it("persists recovered delegated evidence when the parent LLM fails after tool work", async () => {
    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createDelegateToolCallStream("delegate-timeout-artifact", {
          agentName: "mission_coordinator",
          task: "Research and write the portable recorder deliverable.",
        });
      }
      return createThrowingStream("context window overflow after delegation");
    });

    const recoveredArtifactEvidence = [
      "Sub-agent 'mission_coordinator' timed out after 480000ms after finishing the current operation",
      "Partial progress before interruption:",
      "- Tool calls executed: 7 (search_agents, delegate_to_agent, search_workflows, write_file)",
      "- Iterations completed: 4",
      "- Artifacts collected: 1 (workspace/esp32-mic-array-project/README.md)",
      "Recovered evidence snippets from completed tools:",
      "- Saved artifact workspace/esp32-mic-array-project/README.md (486 chars) via write_file. Preview: # ESP32 5-Mikrofon Array - Aufnahmegeraet fuer OTA-Transkription Projektuebersicht: sehr flaches batteriebetriebenes Aufnahmegeraet mit 5 MEMS-Mikrofonen.",
    ].join("\n");

    const delegateExecuteMock = vi.fn(async () => ({
      success: true,
      output: [
        "Delegated result from mission_coordinator — PARTIAL PROGRESS (TIMEOUT).",
        "Observed evidence:",
        recoveredArtifactEvidence,
      ].join("\n"),
      metadata: {
        agentName: "mission_coordinator",
        attemptedAgents: ["mission_coordinator"],
        delegationSucceeded: true,
        delegationOutcome: "partial",
        terminalState: "timeout",
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
      userMessage: "ich brauche source-backed product suggestions and a layout for a portable ESP32 recorder",
    });

    expect(result.blocked).toBe(false);
    expect(result.performance?.finishReason).toBe("llm_error_evidence_backstop");
    expect(result.response).toContain("Die bisher belastbare Evidenz aus diesem Lauf");
    expect(result.response).toContain("workspace/esp32-mic-array-project/README.md");
    expect(result.response).toContain("5-Mikrofon Array");
    expect(delegateExecuteMock).toHaveBeenCalledTimes(1);
    expect(completeMock).not.toHaveBeenCalled();

    const transcript = session.toTranscript();
    expect(transcript.at(-1)?.role).toBe("assistant");
    expect(transcript.at(-1)?.content).toContain("workspace/esp32-mic-array-project/README.md");
  });

  it("reformats the raw shared-facts dump into a readable answer when synthesis is bypassed with shared-facts evidence", async () => {
    // Regression: when a delegation timed out and only auto-shared findings
    // (e.g. multiple `auto_researcher_web_search_xxx` shared facts) survive,
    // the bypass-with-evidence path used to surface the raw bullet dump
    // verbatim — `- auto_researcher_web_search_<hash>: [researcher/web_search]
    // ...` lines truncated mid-word at "...". The user saw what looked like
    // debug output instead of an answer. The runtime now strips the
    // `auto_xxx:` keys and the `[agent/tool]` tags, finishes truncated text
    // at sentence/word boundaries, and adds a clear preamble explaining the
    // research was interrupted.
    const sessionId = "sess-shared-facts-readability-regression";
    const {
      AgentSession: FreshAgentSession,
      runTurn: freshRunTurn,
      registerTool: freshRegisterTool,
    } = await loadFreshRuntimeForToolMode("orchestration_only");
    const { writeSharedFact, resetSharedMemoryForTests } = await import("../swarm/memory.js");
    await resetSharedMemoryForTests();

    const session = new FreshAgentSession({
      sessionId,
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    // Pre-populate the parent session's shared facts the way the auto-share
    // mechanism would after a sub-sub-agent collected web_search evidence.
    // The follow-up partial-timeout delegation surfaces no usable inline
    // evidence, so the runtime falls back to these shared facts.
    await writeSharedFact(
      sessionId,
      "auto_researcher_web_search_aaa",
      "[researcher/web_search] **Web Search Results for:** \"ESP32-S3 I2S PDM microphone input\" (via searxng) **integration of multiple microphones in same ESP32-S3 I2S interface** https://electronics.stackexchange.com/questions/698757 The ESP32 supports 8 channels as four data wires sending 2 I2S channels each. **I2S Audio Interface of ESP32** https://circuitlabs.net/i2s-audio-interface-of-esp32/ Learn to use the I2S interface for digital audio input and output. **ESP32 + multiple i2S MEMS microphones** https://forum.arduino.cc/t/esp32-multiple-i2s-mems-microphones/623438 Connect one I/O pin for each INMP441 to the CHIPEN pin and...",
    );
    await writeSharedFact(
      sessionId,
      "auto_researcher_web_search_bbb",
      "[researcher/web_search] **Web Search Results for:** \"microphone array beamforming\" (via searxng) **Design of a ceiling-microphone array for speech applications** https://www.ikt.uni-hannover.de/fileadmin/ikt/D_Forschung/D_Publikationen/DAGA2017_Mortsiefer.pdf A microphone array increases the speech intelligibility in challenging acoustic situations by creating a highly directive pick-up pattern that captures...",
    );

    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createDelegateToolCallStream("interrupted_research", {
          agentName: "mission_coordinator",
          task: "Research a portable hardware project.",
        });
      }
      return createDelegateToolCallStream("post_synth_search", {
        agentName: "researcher",
        task: "Look it up again.",
      });
    });

    const delegateExecuteMock = vi.fn(async () => ({
      success: true,
      output: [
        "Delegated result from mission_coordinator — PARTIAL PROGRESS (TIMEOUT).",
        "IMPORTANT: The specialist timed out.",
        "Observed evidence:",
        "Task is already running via mission_coordinator.",
      ].join("\n"),
      metadata: {
        agentName: "mission_coordinator",
        attemptedAgents: ["mission_coordinator"],
        delegationSucceeded: true,
        delegationOutcome: "partial",
        terminalState: "timeout",
      },
    }));

    freshRegisterTool({
      name: "delegate_to_agent",
      description: "Delegate to a specialist.",
      parameters: { type: "object", properties: {} },
      execute: delegateExecuteMock,
    });

    try {
      const result = await freshRunTurn({
        session,
        userMessage: "ich möchte ein sehr portables, batterie powered aufnahmegerät bauen mit einem ESP32 und einem array of 5 microphones. what improvements would you add to have the best quality for transcription",
      });

      expect(result.blocked).toBe(false);
      // The user-facing message must NOT contain raw shared-fact keys or the
      // `[agent/tool]` provenance tag — those are debug artifacts.
      expect(result.response).not.toMatch(/auto_researcher_web_search_/);
      expect(result.response).not.toContain("[researcher/web_search]");
      // It MUST contain the actual research evidence so the user sees value.
      expect(result.response).toContain("ESP32");
      expect(result.response).toContain("microphone array");
      // And it must be wrapped with a clear preamble explaining the situation.
      expect(result.response).toMatch(/Recherche.*unterbrochen|Dossier/i);
      expect(result.performance?.finishReason).toBe("synthesis_required_tool_call_rejected");
    } finally {
      await resetSharedMemoryForTests();
    }
  });

  it("reformats a coordinator-baked shared-facts dump (read_shared_facts shape) into a readable answer", async () => {
    // Regression: when a coordinator's final synthesis times out at the LLM
    // provider after collecting shared findings, its partial-progress output
    // bakes the raw `read_shared_facts` tool result into the evidence
    // snippet. The delegation tool result that reaches the main assistant
    // then contains `- read_shared_facts: ## Shared Session Facts (N)
    // **auto_xxx**: <value> **auto_yyy**: <value> ...` on a single flattened
    // line. The previous formatter only matched `- auto_xxx:` shape, so this
    // shape went straight to the user as debug output.
    const sessionId = "sess-coordinator-baked-shared-facts-regression";
    const {
      AgentSession: FreshAgentSession,
      runTurn: freshRunTurn,
      registerTool: freshRegisterTool,
    } = await loadFreshRuntimeForToolMode("orchestration_only");

    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createDelegateToolCallStream("baked_shared_facts", {
          agentName: "mission_coordinator",
          task: "Research a portable hardware project.",
        });
      }
      return createDelegateToolCallStream("post_synth_search", {
        agentName: "researcher",
        task: "Look it up again.",
      });
    });

    const sharedFactsBakedEvidence = [
      "- read_shared_facts: ## Shared Session Facts (5) **auto_researcher_web_search_v2wtqq**: [researcher/web_search] **Web Search Results for:** \"USB-C battery charging module portable device TP4056 BQ24743 alternatives 2025\" (via searxng) **Battery Charging Module Type C: Best Picks for 2025 - Accio** https://www.accio.com/plp/battery-charging-module-type-c Find top-rated battery charging modules with USB PD support. **auto_researcher_web_search_aaa**: [researcher/web_search] **Web Search Results for:** \"ESP32 PDM I2S microphone interface\" (via searxng) **integration of multiple microphones in same ESP32-S3 I2S interface** https://electronics.stackexchange.com/questions/698757 The ESP32 supports 8 channels as four data wires sending 2 I2S channels each. **auto_researcher_web_search_bbb**: [researcher/web_search] **Web Search Results for:** \"IM73A135V01 MEMS microphone\" (via searxng) **IM73A135V01 Datasheet (PDF) - Infineon** https://www.alldatasheet.com/datasheet-pdf/pdf/1388108/INFINEON/IM73A135V01.html",
    ].join("\n");

    const delegateExecuteMock = vi.fn(async () => ({
      success: true,
      output: [
        "Delegated result from mission_coordinator — PARTIAL PROGRESS (TIMEOUT).",
        "IMPORTANT: The specialist timed out.",
        "Observed evidence:",
        sharedFactsBakedEvidence,
      ].join("\n"),
      metadata: {
        agentName: "mission_coordinator",
        attemptedAgents: ["mission_coordinator"],
        delegationSucceeded: true,
        delegationOutcome: "partial",
        terminalState: "timeout",
      },
    }));

    freshRegisterTool({
      name: "delegate_to_agent",
      description: "Delegate to a specialist.",
      parameters: { type: "object", properties: {} },
      execute: delegateExecuteMock,
    });

    const session = new FreshAgentSession({
      sessionId,
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    const result = await freshRunTurn({
      session,
      userMessage: "ich möchte ein sehr portables, batterie powered aufnahmegerät bauen mit einem ESP32 und einem array of 5 microphones. what improvements would you add to have the best quality for transcription",
    });

    expect(result.blocked).toBe(false);
    // The user-facing message must NOT contain raw shared-fact keys, the
    // `[agent/tool]` provenance tag, or the `## Shared Session Facts`
    // / `read_shared_facts:` framing — those are all debug artifacts.
    expect(result.response).not.toMatch(/auto_researcher_web_search_/);
    expect(result.response).not.toContain("[researcher/web_search]");
    expect(result.response).not.toContain("## Shared Session Facts");
    expect(result.response).not.toMatch(/^- read_shared_facts:/m);
    // It MUST contain the actual research evidence so the user sees value.
    expect(result.response).toContain("ESP32");
    expect(result.response).toContain("IM73A135V01");
    expect(result.response).toContain("USB");
    // And it must be wrapped with a clear preamble explaining the situation.
    expect(result.response).toMatch(/Recherche.*unterbrochen|Dossier/i);
    expect(result.performance?.finishReason).toBe("synthesis_required_tool_call_rejected");
  });

  it("reformats read_shared_facts-prefixed delegated evidence with plain auto keys", async () => {
    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createDelegateToolCallStream("hardware_research_partial_1", {
          agentName: "mission_coordinator",
          task: "Research portable recorder hardware.",
        });
      }
      return createDelegateToolCallStream("hardware_research_partial_2", {
        agentName: "researcher",
        task: "Retry the same hardware research.",
      });
    });

    const delegateExecuteMock = vi.fn(async () => ({
      success: true,
      output: [
        "Delegated result from mission_coordinator — PARTIAL PROGRESS (TIMEOUT).",
        "IMPORTANT: The specialist timed out.",
        "Observed evidence:",
        "- read_shared_facts: ## Shared Session Facts (2) auto_researcher_web_search_mic: [researcher/web_search] Web Search Results for: \"IM73A135V01 MEMS microphone datasheet\" (via searxng) IM73A135V01 Datasheet(PDF) - Infineon Technologies AG https://www.alldatasheet.com/datasheet-pdf/pdf/1388108/INFINEON/IM73A135V01.html The IM73A135V01 is designed for high-performance audio capture. auto_researcher_web_search_esp32: [researcher/web_search] Web Search Results for: \"ESP32 PDM I2S microphone interface support\" (via searxng) I2S Audio Interface of ESP32 https://circuitlabs.net/i2s-audio-interface-of-esp32/ Learn to use the I2S interface for digital audio input and output.",
      ].join("\n"),
      metadata: {
        agentName: "mission_coordinator",
        attemptedAgents: ["mission_coordinator"],
        delegationSucceeded: true,
        delegationOutcome: "partial",
        terminalState: "timeout",
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
      userMessage: "ich brauche ein portables ESP32 Aufnahmegeraet und will wissen ob IM73A135V01 passt",
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toContain("Die Recherche wurde unterbrochen");
    expect(result.response).toContain("IM73A135V01 Datasheet(PDF) - Infineon Technologies AG");
    expect(result.response).toContain("I2S Audio Interface of ESP32");
    expect(result.response).not.toContain("read_shared_facts:");
    expect(result.response).not.toContain("auto_researcher_web_search_");
    expect(result.response).not.toContain("[researcher/web_search]");
    expect(result.performance?.finishReason).toBe("synthesis_required_tool_call_rejected");
    expect(delegateExecuteMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces extracted evidence instead of raw timeout scaffolding when a partial delegation is forced to synthesize", async () => {
    const extractedEvidence = Array.from(
      { length: 6 },
      (_, index) => `- Verified integration finding ${index + 1}: the coordinator recovered source-backed snippet ${index + 1} with concrete endpoint and retry guidance for the deployment.`,
    ).join("\n");

    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createDelegateToolCallStream("integration_partial_1", {
          agentName: "mission_coordinator",
          task: "Research the portable service integration design.",
        });
      }

      return createDelegateToolCallStream("integration_partial_2", {
        agentName: "mission_coordinator",
        task: "Retry the same integration design mission again.",
      });
    });

    const delegateExecuteMock = vi.fn(async () => ({
      success: true,
      output: [
        "Sub-agent 'mission_coordinator' timed out after 480000ms",
        "Partial progress before interruption:",
        `- parallel_1 [completed] Integration slice via researcher | ${extractedEvidence}`,
        "- task_1 [running] Final synthesis via mission_coordinator",
        "- Tool calls executed: 4 (search_agents, search_workflows, parallel_delegate, read_shared_facts)",
        "- Iterations completed: 3",
        "Recovered evidence snippets from completed tools:",
        "- search_agents: No agents matched \"service integration endpoint retry configuration deployment\".",
      ].join("\n"),
      metadata: {
        agentName: "mission_coordinator",
        attemptedAgents: ["mission_coordinator"],
        delegationSucceeded: true,
        delegationOutcome: "partial",
        terminalState: "timeout",
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
      userMessage: "Design a source-backed portable service integration.",
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toContain("Verified integration finding 6");
    expect(result.response).not.toContain("Sub-agent 'mission_coordinator' timed out");
    expect(result.response).not.toContain("Tool calls executed:");
    expect(result.response).not.toContain("Iterations completed:");
    expect(result.performance?.finishReason).toBe("synthesis_required_tool_call_rejected");
    expect(streamMock).toHaveBeenCalledTimes(2);
    expect(delegateExecuteMock).toHaveBeenCalledTimes(1);
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("uses short single-line partial delegated evidence instead of the generic fallback after synthesis-required rejection", async () => {
    const shortPartialEvidence = "Verified implementation direction: keep the external endpoint as an unverified candidate until the inspected deployment confirms it; plan local buffering plus explicit sync rather than assuming continuous connectivity.";

    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createDelegateToolCallStream("integration_partial_inline_1", {
          agentName: "mission_coordinator",
          task: "Research the portable integration design.",
        });
      }

      return createDelegateToolCallStream("integration_partial_inline_2", {
        agentName: "mission_coordinator",
        task: "Retry the same integration design mission again.",
      });
    });

    const delegateExecuteMock = vi.fn(async () => ({
      success: true,
      output: [
        "Sub-agent 'mission_coordinator' produced no final response after substantive work.",
        `Partial progress before interruption: - parallel_1 [partial] Integration research | ${shortPartialEvidence}`,
      ].join("\n"),
      metadata: {
        agentName: "mission_coordinator",
        attemptedAgents: ["mission_coordinator"],
        delegationSucceeded: true,
        delegationOutcome: "partial",
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
      userMessage: "Design a source-backed portable service integration.",
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toContain("external endpoint as an unverified candidate");
    expect(result.response).toContain("explicit sync");
    expect(result.response).not.toContain("I wasn't able to generate a usable reply for that turn");
    expect(result.performance?.finishReason).toBe("synthesis_required_tool_call_rejected");
    expect(streamMock).toHaveBeenCalledTimes(2);
    expect(delegateExecuteMock).toHaveBeenCalledTimes(1);
    expect(completeMock).toHaveBeenCalledTimes(1);
  });

  it("uses shared findings as the generic terminal backstop when delegated progress is only status chatter", async () => {
    const sessionId = "sess-generic-shared-fact-backstop";
    const {
      AgentSession: FreshAgentSession,
      runTurn: freshRunTurn,
      registerTool: freshRegisterTool,
    } = await loadFreshRuntimeForToolMode("orchestration_only");
    const { writeSharedFact } = await import("../swarm/memory.js");

    await writeSharedFact(
      sessionId,
      "verified_sync_endpoint",
      "Verified endpoint: http://internal-gateway:8787. Sync worker keeps a local retry queue before OTA upload so failed batches can be retried without losing captured audio.",
    );

    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createDelegateToolCallStream("delegate_generic_shared_fact_1", {
          agentName: "mission_coordinator",
          task: "Inspect the deployment integration behavior.",
        });
      }

      return createDelegateToolCallStream("delegate_generic_shared_fact_2", {
        agentName: "mission_coordinator",
        task: "Retry the same deployment integration investigation.",
      });
    });

    const delegateExecuteMock = vi.fn(async () => ({
      success: true,
      output: [
        "Sub-agent 'mission_coordinator' timed out after 480000ms",
        "Partial progress before interruption:",
        "- search_workflows [partial] No workflows matched \"deployment integration retry architecture\" strongly enough.",
        "- search_agents [partial] No agents matched \"deployment integration endpoint ownership\".",
      ].join("\n"),
      metadata: {
        agentName: "mission_coordinator",
        attemptedAgents: ["mission_coordinator"],
        delegationSucceeded: true,
        delegationOutcome: "partial",
        terminalState: "timeout",
      },
    }));

    freshRegisterTool({
      name: "delegate_to_agent",
      description: "Delegate to a specialist.",
      parameters: { type: "object", properties: {} },
      execute: delegateExecuteMock,
    });

    const session = new FreshAgentSession({
      sessionId,
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    const result = await freshRunTurn({
      session,
      userMessage: "Summarize the deployment integration and retry behavior.",
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toContain("http://internal-gateway:8787");
    expect(result.response).toContain("local retry queue");
    expect(result.response).not.toContain("No workflows matched");
    expect(result.response).not.toContain("No agents matched");
    expect(result.performance?.finishReason).toBe("synthesis_required_tool_call_rejected");
    expect(streamMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(streamMock.mock.calls.length).toBeLessThanOrEqual(3);
    expect(delegateExecuteMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(delegateExecuteMock.mock.calls.length).toBeLessThanOrEqual(2);
    expect(completeMock).toHaveBeenCalledTimes(1);
  });

  it("uses shared findings instead of source-sensitive delegation scaffolding in generic terminal recovery", async () => {
    const sessionId = "sess-generic-source-echo-backstop";
    const {
      AgentSession: FreshAgentSession,
      runTurn: freshRunTurn,
      registerTool: freshRegisterTool,
    } = await loadFreshRuntimeForToolMode("orchestration_only");
    const { writeSharedFact } = await import("../swarm/memory.js");

    await writeSharedFact(
      sessionId,
      "verified_microphone_identity",
      "Verified evidence so far: IM73A135V01 is an Infineon analog MEMS microphone candidate. Interface, array topology, ESP32 wiring, and the remaining BOM still need current-source verification.",
    );

    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createDelegateToolCallStream("delegate_source_echo_1", {
          agentName: "mission_coordinator",
          task: "Research the portable recorder hardware design.",
        });
      }

      return createDelegateToolCallStream("delegate_source_echo_2", {
        agentName: "mission_coordinator",
        task: "Retry the same portable recorder hardware design mission.",
      });
    });

    const delegateExecuteMock = vi.fn(async () => ({
      success: true,
      output: [
        "Sub-agent 'mission_coordinator' produced no final response after substantive work.",
        "Partial progress before interruption:",
        "- parallel_delegate [partial] **[researcher]**: ich möchte ein sehr portables, batterie powered aufnahmegerät bauen via mission_coordinator SOURCE-SENSITIVE DELEGATION SLICE 1/4",
      ].join("\n"),
      metadata: {
        agentName: "mission_coordinator",
        attemptedAgents: ["mission_coordinator"],
        delegationSucceeded: true,
        delegationOutcome: "partial",
        terminalState: "completed",
      },
    }));

    freshRegisterTool({
      name: "delegate_to_agent",
      description: "Delegate to a specialist.",
      parameters: { type: "object", properties: {} },
      execute: delegateExecuteMock,
    });

    const session = new FreshAgentSession({
      sessionId,
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    const result = await freshRunTurn({
      session,
      userMessage: "Verify the recorder hardware design and microphone choice with current evidence.",
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toContain("Infineon analog MEMS microphone candidate");
    expect(result.response).toContain("still need current-source verification");
    expect(result.response).not.toContain("SOURCE-SENSITIVE DELEGATION SLICE");
    expect(result.response).not.toContain("ich möchte ein sehr portables");
    expect(result.performance?.finishReason).toBe("synthesis_required_tool_call_rejected");
    expect(streamMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(streamMock.mock.calls.length).toBeLessThanOrEqual(3);
    expect(delegateExecuteMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(delegateExecuteMock.mock.calls.length).toBeLessThanOrEqual(2);
    expect(completeMock).toHaveBeenCalledTimes(1);
  });

  it("preserves substantive delegated evidence over an underpowered rewrite when evidence contains future-action phrasing", async () => {
    const coordinatorSynthesis = [
      "## Verified integration notes",
      "",
      "The delegated run collected concrete evidence from inspected service configuration and runtime logs.",
      "I will now summarize the confirmed operational details:",
      "",
      "- **Service**: gateway",
      "- **Observed status**: healthy",
      "- **Configured endpoint**: http://internal-gateway:8787",
      "- **Required follow-up**: update the client to use the configured endpoint value exactly as observed.",
      "- **Risk**: using a stale host value causes all dependent requests to fail before authentication.",
      "",
      "**Design implication**: keep endpoint configuration centralized and do not duplicate it in callers.",
      "Ich werde die Ergebnisse als finales Resultat übergeben.",
    ].join("\n");

    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createDelegateToolCallStream("coordinator_1", {
          agentName: "mission_coordinator",
          task: "Verify the service integration settings from inspected runtime evidence.",
        });
      }
      // Model tries to delegate again after [SYNTHESIS REQUIRED] is injected
      return createDelegateToolCallStream("coordinator_2", {
        agentName: "mission_coordinator",
        task: "Retry the same verification again.",
      });
    });

    const delegateExecuteMock = vi.fn(async () => ({
      success: true,
      output: coordinatorSynthesis,
      metadata: {
        agentName: "mission_coordinator",
        attemptedAgents: ["mission_coordinator"],
        delegationSucceeded: true,
        delegationOutcome: "partial",
        terminalState: "timeout",
      },
    }));

    // The default completeMock returns "synthesized" (12 chars) — an underpowered stub.
    // The fix ensures rewriteTerminalResponseIfNeeded falls back to the original evidence
    // rather than using this stub as the final answer.

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
      userMessage: "Check the service integration settings and summarize the confirmed endpoint.",
    });

    expect(result.blocked).toBe(false);
    // The delegated evidence (which contains the real answer) must be surfaced,
    // NOT the "synthesized" (12-char) stub returned by the default completeMock.
    expect(result.response).toContain("gateway");
    expect(result.response).toContain("http://internal-gateway:8787");
    expect(result.response).not.toContain("synthesized");
    expect(result.performance?.finishReason).toBe("synthesis_required_tool_call_rejected");
    expect(streamMock).toHaveBeenCalledTimes(2);
    expect(delegateExecuteMock).toHaveBeenCalledTimes(1);
    // forceSynthesis is called because the evidence contains future-action
    // phrasing, but the underpowered rewrite is discarded.
    expect(completeMock).toHaveBeenCalledTimes(1);
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

  it("resynthesizes empty direct replies instead of surfacing a no-response placeholder", async () => {
    streamMock.mockImplementation(() => createTextStream(""));

    const session = new AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    const result = await runTurn({
      session,
      userMessage: "Eine Zusammenfassung der wichtigsten Ereignisse",
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toBe("synthesized");
    expect(result.response).not.toBe("(no response)");
    expect(completeMock).toHaveBeenCalledTimes(1);
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

  it("blocks search_agents even when discovery appears before delegation in the same response", async () => {
    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createMultiToolCallStream([
          {
            id: "search_1",
            toolName: "search_agents",
            args: { query: "portable embedded audio hardware specialist" },
          },
          {
            id: "delegate_1",
            toolName: "delegate_to_agent",
            args: { task: "Recommend a portable ESP32-based transcription recorder design." },
          },
        ]);
      }
      return createTextStream("I kept the direct delegation instead of burning another routing pass.");
    });

    const delegateExecuteMock = vi.fn(async () => ({
      success: true,
      output: "Delegated result from researcher — TASK COMPLETED.",
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
      userMessage: "design a portable transcription recorder",
    });

    expect(result.blocked).toBe(false);
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
        suggestedFallbackAgents: ["browser_agent", "researcher"],
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
      fallbackAgents: ["browser_agent", "researcher"],
      task: "Gehe auf freelancermap.com und prüfe, ob ich neue Nachrichten habe.",
    });
  });

  it("reuses the top search_agents result for the next swarm_delegate call", async () => {
    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createToolCallStream("search_1", "search_agents", {
          query: "web search news headlines",
        });
      }
      if (llmCallCount === 2) {
        return createToolCallStream("swarm_1", "swarm_delegate", {
          task: "Ermittle die aktuellen Top-Headlines von heute.",
        });
      }
      return createTextStream("Ich habe den bereits gefundenen Web-Koordinator direkt verwendet.");
    });

    const searchExecuteMock = vi.fn(async () => ({
      success: true,
      output: '➡ NEXT ACTION: Call delegate_to_agent(agentName="web_task_coordinator", task="<your task>") NOW. Do NOT call search_agents again.',
      metadata: {
        query: "web search news headlines",
        topResult: "web_task_coordinator",
        topResultConfidence: "high",
        topResultScore: 0.72,
        suggestedFallbackAgents: ["researcher"],
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

    const swarmDelegateExecuteMock = vi.fn(async () => ({
      success: false,
      output: "",
      error: "swarm_delegate should have been recovered to delegate_to_agent",
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

    registerTool({
      name: "swarm_delegate",
      description: "Delegate to the swarm.",
      parameters: { type: "object", properties: {} },
      execute: swarmDelegateExecuteMock,
    });

    const session = new AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    const result = await runTurn({
      session,
      userMessage: "Was sind die Headlines von Heute?",
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toContain("Web-Koordinator");
    expect(searchExecuteMock).toHaveBeenCalledTimes(1);
    expect(delegateExecuteMock).toHaveBeenCalledTimes(1);
    expect(swarmDelegateExecuteMock).not.toHaveBeenCalled();
    expect(delegateExecuteMock.mock.calls[0]?.[0]).toMatchObject({
      agentName: "web_task_coordinator",
      fallbackAgents: ["researcher"],
      task: "Ermittle die aktuellen Top-Headlines von heute.",
    });
  });

  it("falls back to a configured research path when search_agents returns no strong match on source-sensitive turns", async () => {
    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createMultiToolCallStream([
          {
            id: "search_no_match_1",
            toolName: "search_agents",
            args: { query: "hardware electronics embedded circuit design" },
          },
          {
            id: "search_no_match_2",
            toolName: "search_agents",
            args: { query: "research component sourcing product recommendation" },
          },
        ]);
      }
      return createTextStream("I routed the research through the temporary specialist and am reporting the gathered evidence.");
    });

    const searchExecuteMock = vi.fn(async () => ({
      success: true,
      output: 'No agents matched "hardware electronics embedded circuit design". Do not call search_agents again for this turn.',
      metadata: {
        query: "hardware electronics embedded circuit design",
        minConfidence: "medium",
        routingMode: "hybrid",
        resultCount: 0,
        weakCount: 3,
        topResult: null,
      },
    }));

    const delegateExecuteMock = vi.fn(async (args: Record<string, unknown>) => ({
      success: true,
      output: "Delegated result from mission_coordinator — TASK COMPLETED.\nObserved evidence:\nThe fallback coordinator gathered component evidence.",
      metadata: {
        agentName: String(args["agentName"] ?? ""),
        attemptedAgents: [String(args["agentName"] ?? "")],
        delegationSucceeded: true,
        terminalState: "completed",
      },
    }));

    const createEphemeralExecuteMock = vi.fn(async (args: Record<string, unknown>) => ({
      success: true,
      output: "Ephemeral research specialist — TASK COMPLETED.\nObserved evidence:\nThe temporary specialist gathered component evidence.",
      metadata: {
        agentName: String(args["agentName"] ?? ""),
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

    registerTool({
      name: "create_ephemeral_agent",
      description: "Create and run a temporary specialist.",
      parameters: { type: "object", properties: {} },
      execute: createEphemeralExecuteMock,
    });

    const statuses: string[] = [];
    const session = new AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    const result = await runTurn({
      session,
      userMessage: "Use current sources to recommend exact ESP32 MEMS microphone components and verify product choices.",
      onStatus: (status) => statuses.push(status.message),
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toContain("gathered evidence");
    expect(searchExecuteMock).toHaveBeenCalledTimes(1);
    expect(delegateExecuteMock).toHaveBeenCalledTimes(1);
    expect(createEphemeralExecuteMock).not.toHaveBeenCalled();
    expect(delegateExecuteMock.mock.calls[0]?.[0]).toMatchObject({
      // Single-domain research → direct researcher, no coordinator hop (de-layering).
      agentName: "researcher",
      task: "Use current sources to recommend exact ESP32 MEMS microphone components and verify product choices.",
    });
    expect(statuses).toEqual(expect.arrayContaining([
      "Agent discovery returned no usable match, so I am falling back to a required research specialist instead of searching again.",
    ]));
    expect(logAudit).toHaveBeenCalledWith(
      "tool_call_recovered",
      expect.objectContaining({
        originalTool: "search_agents",
        rewrittenTo: "delegate_to_agent",
        reason: "search_agents_no_match_fallback",
        recoveredAgentName: "researcher",
      }),
      expect.objectContaining({ severity: "warn" }),
    );
    expect(logAudit).toHaveBeenCalledWith(
      "guardrail_flagged",
      expect.objectContaining({ type: "agent_discovery_no_match_fallback" }),
      expect.objectContaining({ severity: "warn" }),
    );
  });

  it("enforces the original user request when a fallback delegate call adds unsupported source-sensitive claims", async () => {
    const userMessage = "Use current sources to compare exact ZX-9000 recorder battery options and verify product choices.";
    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createToolCallStream("search_no_match", "search_agents", { query: "portable recorder battery component sourcing" });
      }
      if (llmCallCount === 2) {
        return createDelegateToolCallStream("delegate_claims", {
          agentName: "mission_coordinator",
          fallbackAgents: ["researcher"],
          task: "Research the ZX-9000 as a VendorX USB-C-only recorder with 5000mAh requirements and recommend compatible batteries.",
        });
      }
      return createTextStream("The fallback coordinator gathered verified battery evidence.");
    });

    const searchExecuteMock = vi.fn(async () => ({
      success: true,
      output: 'No agents matched "portable recorder battery component sourcing". Do not call search_agents again for this turn.',
      metadata: {
        query: "portable recorder battery component sourcing",
        minConfidence: "medium",
        routingMode: "hybrid",
        resultCount: 0,
        weakCount: 0,
        topResult: null,
      },
    }));

    const delegateExecuteMock = vi.fn(async (args: Record<string, unknown>) => ({
      success: true,
      output: "Delegated result from mission_coordinator — TASK COMPLETED.\nObserved evidence:\nVerified battery evidence.",
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

    const result = await runTurn({ session, userMessage });

    expect(result.blocked).toBe(false);
    expect(delegateExecuteMock).toHaveBeenCalledTimes(1);
    expect(delegateExecuteMock.mock.calls[0]?.[0]).toMatchObject({
      // Single-domain research → the required-research route prefers the direct
      // researcher; the explicit coordinator pick is rewritten to it (de-layering).
      agentName: "researcher",
      fallbackAgents: [],
      task: userMessage,
    });
    const historyText = session.getHistory()
      .map((message) => JSON.stringify(message))
      .join("\n");
    expect(historyText).not.toContain("VendorX USB-C-only");
    expect(logAudit).toHaveBeenCalledWith(
      "tool_call_recovered",
      expect.objectContaining({
        originalTool: "delegate_to_agent",
        rewrittenTo: "delegate_to_agent",
        reason: "required_research_original_task_enforced",
        recoveredAgentName: "researcher",
      }),
      expect.objectContaining({ severity: "info" }),
    );
  });

  it("enforces the original user request before the first source-sensitive delegation is executed", async () => {
    const userMessage = "Use current sources to verify the exact ZX-9000 product manufacturer and interface before recommending parts.";
    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createDelegateToolCallStream("delegate_unsafe", {
          agentName: "researcher",
          task: "Research the ST ZX-9000 from VendorX as an I2S-only product and prepare recommendations.",
          context: "VendorX and I2S are already established facts.",
        });
      }
      return createTextStream("The specialist gathered verified evidence.");
    });

    const delegateExecuteMock = vi.fn(async (args: Record<string, unknown>) => ({
      success: true,
      output: "Delegated result from researcher — TASK COMPLETED.\nObserved evidence:\nVerified product evidence.",
      metadata: {
        agentName: String(args["agentName"] ?? ""),
        attemptedAgents: [String(args["agentName"] ?? "")],
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

    const result = await runTurn({ session, userMessage });

    expect(result.blocked).toBe(false);
    expect(delegateExecuteMock).toHaveBeenCalledTimes(1);
    const delegatedArgs = delegateExecuteMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(delegatedArgs["agentName"]).toBe("researcher");
    expect(String(delegatedArgs["task"])).toContain("SOURCE-SENSITIVE DELEGATION");
    expect(String(delegatedArgs["task"])).toContain(userMessage);
    expect(String(delegatedArgs["task"])).not.toContain("ST ZX-9000");
    expect(String(delegatedArgs["task"])).not.toContain("VendorX");
    expect(String(delegatedArgs["task"])).not.toContain("I2S-only");
    expect(delegatedArgs).not.toHaveProperty("context");
    const historyText = session.getHistory().map((message) => JSON.stringify(message)).join("\n");
    expect(historyText).not.toContain("VendorX and I2S are already established facts");
    expect(logAudit).toHaveBeenCalledWith(
      "tool_call_recovered",
      expect.objectContaining({
        originalTool: "delegate_to_agent",
        rewrittenTo: "delegate_to_agent",
        reason: "source_sensitive_original_request_enforced",
      }),
      expect.objectContaining({ severity: "info" }),
    );
  });

  it("keeps source-sensitive parallel slices distinct while stripping unsupported assumptions", async () => {
    const userMessage = "Use current sources to verify the exact ZX-9000 product manufacturer and interface before recommending battery, charging, and layout decisions.";
    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createToolCallStream("parallel_source_sensitive", "parallel_delegate", {
          tasks: [
            { agentName: "researcher", task: "Verify the VendorX ZX-9000 USB-C interface." },
            { agentName: "researcher", task: "Find ST ZX-9000 pricing and supplier data." },
            { agentName: "researcher", task: "Prepare layout advice assuming I2S output and credit-card placement." },
          ],
        });
      }

      return createTextStream("Parallel grounded research launched once per distinct slice.");
    });

    const parallelExecuteMock = vi.fn(async (args: Record<string, unknown>) => ({
      success: true,
      output: "Delegated result from mission_coordinator — TASK COMPLETED.\nObserved evidence:\nParallel slices launched.",
      metadata: {
        taskCount: Array.isArray(args["tasks"]) ? args["tasks"].length : 0,
      },
    }));

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

    const result = await runTurn({ session, userMessage });

    expect(result.blocked).toBe(false);
    expect(result.response).toContain("distinct slice");
    expect(parallelExecuteMock).toHaveBeenCalledTimes(1);

    const parallelArgs = parallelExecuteMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const taskSpecs = Array.isArray(parallelArgs["tasks"])
      ? parallelArgs["tasks"] as Array<Record<string, unknown>>
      : [];
    const taskTexts = taskSpecs.map((taskSpec) => String(taskSpec["task"] ?? ""));

    expect(taskTexts).toHaveLength(3);
    expect(new Set(taskTexts).size).toBe(3);
    expect(taskTexts.join("\n")).toContain(userMessage);
    expect(taskTexts.join("\n")).toContain("Focus for this slice");
    // Topic-agnostic, gather-framed verification focus (research-framed so embedding
    // routing picks researcher over source_verifier; replaced the overfit per-topic buckets).
    expect(taskTexts.join("\n")).toContain("gather and confirm every concrete fact");
    expect(taskTexts.join("\n")).not.toContain("VendorX");
    expect(taskTexts.join("\n")).not.toContain("ST ZX-9000");
    expect(taskTexts.join("\n")).not.toContain("assuming I2S");
    expect(logAudit).toHaveBeenCalledWith(
      "tool_call_recovered",
      expect.objectContaining({
        originalTool: "parallel_delegate",
        rewrittenTo: "parallel_delegate",
        reason: "source_sensitive_original_request_enforced",
      }),
      expect.objectContaining({ severity: "info" }),
    );
  });

  it("keeps source-sensitive swarm retries on the original request after a failed delegation", async () => {
    const userMessage = "Use current sources to verify the exact IM73A135V01 manufacturer and interface before recommending an ESP32 audio design.";
    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createDelegateToolCallStream("delegate_failed_first", {
          agentName: "mission_coordinator",
          task: "Research IM73A135V01 evidence.",
        });
      }
      if (llmCallCount === 2) {
        return createToolCallStream("swarm_retry_unsafe", "swarm_delegate", {
          task: "Verify that IM73A135V01 is an ST MEMS I2S/PDM omnidirectional microphone, then recommend ESP32 wiring.",
          routingQuery: "hardware design microphone array ESP32 BOM",
        });
      }
      return createTextStream("ST MEMS I2S/PDM is verified and the complete design is ready.");
    });

    const delegateExecuteMock = vi.fn(async () => ({
      success: false,
      output: "",
      error: "Coordinator timed out before collecting usable evidence.",
      metadata: {
        agentName: "mission_coordinator",
        attemptedAgents: ["mission_coordinator"],
        delegationSucceeded: false,
      },
    }));
    const swarmExecuteMock = vi.fn(async (_args: Record<string, unknown>) => ({
      success: false,
      output: "",
      error: "Architect-designed agent could not complete the task.",
      metadata: {
        agentName: "ephemeral:hardware_design_researcher",
        delegationSucceeded: false,
      },
    }));

    registerTool({
      name: "delegate_to_agent",
      description: "Delegate to a specialist.",
      parameters: { type: "object", properties: {} },
      execute: delegateExecuteMock,
    });
    registerTool({
      name: "swarm_delegate",
      description: "Delegate through autonomous swarm routing.",
      parameters: { type: "object", properties: {} },
      execute: swarmExecuteMock,
    });

    const session = new AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    const result = await runTurn({ session, userMessage });

    expect(result.blocked).toBe(false);
    expect(swarmExecuteMock).toHaveBeenCalledTimes(1);
    const swarmArgs = swarmExecuteMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(String(swarmArgs["task"])).toContain("SOURCE-SENSITIVE DELEGATION");
    expect(String(swarmArgs["task"])).toContain(userMessage);
    expect(String(swarmArgs["task"])).not.toContain("ST MEMS");
    expect(String(swarmArgs["task"])).not.toContain("I2S/PDM omnidirectional");
    const historyText = session.getHistory().map((message) => JSON.stringify(message)).join("\n");
    expect(historyText).not.toContain("ST MEMS I2S/PDM");
    expect(logAudit).toHaveBeenCalledWith(
      "tool_call_recovered",
      expect.objectContaining({
        originalTool: "swarm_delegate",
        rewrittenTo: "swarm_delegate",
        reason: "source_sensitive_original_request_enforced",
      }),
      expect.objectContaining({ severity: "info" }),
    );
  });

  it("blocks source-sensitive final answers after delegation fails before usable evidence is gathered", async () => {
    const userMessage = "Use current sources to verify the exact ZX-9000 product manufacturer and interface before recommending parts.";
    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createDelegateToolCallStream("delegate_failed", {
          agentName: "researcher",
          task: "Research ZX-9000 product evidence.",
        });
      }
      return createTextStream("VendorX ZX-9000 is definitely an I2S-only product, so here is the complete design guide.");
    });

    const delegateExecuteMock = vi.fn(async () => ({
      success: false,
      output: "",
      error: "Provider returned HTTP 500 before any source was fetched.",
      metadata: {
        agentName: "researcher",
        attemptedAgents: ["researcher"],
        delegationSucceeded: false,
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

    const result = await runTurn({ session, userMessage });

    expect(result.blocked).toBe(false);
    expect(result.response).toContain("belastbare Quellen- oder Tool-Evidenz");
    expect(result.response).not.toContain("VendorX");
    expect(result.response).not.toContain("I2S-only");
    expect(logAudit).toHaveBeenCalledWith(
      "guardrail_flagged",
      expect.objectContaining({ type: "source_sensitive_final_answer_without_evidence_blocked" }),
      expect.objectContaining({ severity: "warn" }),
    );
  });

  it("surfaces shared findings instead of accepting a fabricated rewrite after a source-sensitive partial failure", async () => {
    const userMessage = "Use current sources to verify the exact ZX-9000 product manufacturer and interface before recommending parts.";
    const sessionId = "sess-source-shared-fact-backstop";
    const {
      AgentSession: FreshAgentSession,
      runTurn: freshRunTurn,
      registerTool: freshRegisterTool,
    } = await loadFreshRuntimeForToolMode("orchestration_only");
    const { writeSharedFact } = await import("../swarm/memory.js");
    await writeSharedFact(
      sessionId,
      "verified_component_identity",
      "Official component evidence identifies ZX-9000 as an Infineon analog microphone candidate. Interface, pricing, and broader design recommendations remain incomplete in the current evidence.",
    );

    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createDelegateToolCallStream("delegate_partial_shared_fact", {
          agentName: "mission_coordinator",
          task: "Research ZX-9000 product evidence.",
        });
      }
      return createTextStream("VendorX ZX-9000 is definitely an I2S-only product, so here is the complete design guide.");
    });

    const delegateExecuteMock = vi.fn(async () => ({
      success: true,
      output: [
        "Sub-agent 'mission_coordinator' timed out after 480000ms",
        "Partial progress before interruption:",
        "- search_workflows [partial] No workflows matched \"hardware design guide electronics components BOM schematic\" strongly enough.",
      ].join("\n"),
      metadata: {
        agentName: "mission_coordinator",
        attemptedAgents: ["mission_coordinator"],
        delegationSucceeded: true,
        delegationOutcome: "partial",
        terminalState: "timeout",
      },
    }));

    freshRegisterTool({
      name: "delegate_to_agent",
      description: "Delegate to a specialist.",
      parameters: { type: "object", properties: {} },
      execute: delegateExecuteMock,
    });

    const session = new FreshAgentSession({
      sessionId,
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    const result = await freshRunTurn({ session, userMessage });

    expect(result.blocked).toBe(false);
    expect(result.response).toContain("belastbare Evidenz");
    expect(result.response).toContain("Infineon analog microphone candidate");
    expect(result.response).toContain("remain incomplete");
    expect(result.response).not.toContain("VendorX");
    expect(result.response).not.toContain("I2S-only");
    expect(logAudit).toHaveBeenCalledWith(
      "guardrail_flagged",
      expect.objectContaining({ type: "source_sensitive_failed_delegation_evidence_backstop" }),
      expect.objectContaining({ severity: "warn" }),
    );
  });

  it("rewrites fabricated complete answers after a source-sensitive partial timeout with usable evidence", async () => {
    const userMessage = "Nutze aktuelle Quellen fuer ein portables Audio-Recorder-Design mit Produktvorschlaegen, Verdrahtung und Verbesserungen fuer Transkription.";
    const sessionId = "sess-source-partial-timeout-late-guard";
    const {
      AgentSession: FreshAgentSession,
      runTurn: freshRunTurn,
      registerTool: freshRegisterTool,
    } = await loadFreshRuntimeForToolMode("orchestration_only");

    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createDelegateToolCallStream("delegate_partial_timeout_guard", {
          agentName: "mission_coordinator",
          task: "Research the portable audio recorder design with current sources.",
        });
      }
      return createTextStream("IM73A135V01 is definitely the right choice, here is the complete BOM, the exact ESP32 wiring, and the final layout guide.");
    });

    const delegateExecuteMock = vi.fn(async () => ({
      success: true,
      output: [
        "Sub-agent 'mission_coordinator' timed out after 480000ms",
        "Partial progress before interruption:",
        "- parallel_1 [partial] Component identity research | Official evidence so far identifies IM73A135V01 as an Infineon analog microphone candidate. Interface, ESP32 wiring, charger selection, and the broader BOM remain unverified in the collected evidence.",
      ].join("\n"),
      metadata: {
        agentName: "mission_coordinator",
        attemptedAgents: ["mission_coordinator"],
        delegationSucceeded: true,
        delegationOutcome: "partial",
        terminalState: "timeout",
      },
    }));

    freshRegisterTool({
      name: "delegate_to_agent",
      description: "Delegate to a specialist.",
      parameters: { type: "object", properties: {} },
      execute: delegateExecuteMock,
    });

    const session = new FreshAgentSession({
      sessionId,
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    const result = await freshRunTurn({ session, userMessage });

    expect(result.blocked).toBe(false);
    expect(result.response).toContain("belastbare Evidenz");
    expect(result.response).toContain("Infineon analog microphone candidate");
    expect(result.response).toContain("remain unverified");
    expect(result.response).not.toContain("definitely the right choice");
    expect(result.response).not.toContain("complete BOM");
    expect(logAudit).toHaveBeenCalledWith(
      "guardrail_flagged",
      expect.objectContaining({
        type: "source_sensitive_failed_delegation_evidence_backstop",
        finalResponseTransparent: false,
      }),
      expect.objectContaining({ severity: "warn" }),
    );
  });

  it("bounds broad source-sensitive answers to sparse reused session evidence instead of inventing the missing design", async () => {
    const userMessage = [
      "ich möchte ein sehr portables, batterie powered aufnahmegerät bauen",
      "dazu brauche ich ein sehr flaches microfon modul mit sehr hoher qualität (oder ein array)",
      "ich denke daran es wahrscheinlich mit einem esp32 zu verbinden um die aufnahmen ota zu syncronisieren",
      "what else do i need and how do i put all of it together",
      "can you give me product suggestions as well as a layout how to connect everything together",
      "what improvements would you add to have the best quality for transcription",
    ].join("\n");
    const sessionId = "sess-source-sparse-reuse-backstop";
    const {
      AgentSession: FreshAgentSession,
      runTurn: freshRunTurn,
      registerTool: freshRegisterTool,
    } = await loadFreshRuntimeForToolMode("orchestration_only");

    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createDelegateToolCallStream("delegate_sparse_memory_reuse", {
          agentName: "researcher",
          task: "Research the portable recorder hardware design with current sources.",
        });
      }
      return createTextStream("IM73A135V01 is analog, so use SPH0645 and here is the complete ESP32-S3 pinout, the charger choice, the full BOM, and the final credit-card layout.");
    });

    const delegateExecuteMock = vi.fn(async () => ({
      success: true,
      output: [
        "Reused relevant session/task memory for 'portable recorder hardware research' instead of launching another duplicate research pass.",
        "",
        "## Shared facts already gathered",
        "- **im73a135v01_critical_specs** (20%): Infineon IM73A135V01: Analog differential output MEMS microphone (NOT I2S/digital). SNR 73 dB(A), AOP 124 dB, IP57 water/dust resistant. Supply voltage 2.3–3.3 V.",
        "- **sph0645lm4h_specs** (20%): Sensory SPH0645LM4H-B: Digital I2S MEMS microphone. SNR 66 dB, AOP 119 dB. Supply voltage 1.6–3.6 V. Package SMD-4P 2.8×1.9×0.7 mm.",
        "- **inmp441_specs** (20%): TDK INMP441: Digital I2S MEMS microphone. SNR 66 dB, frequency response 50 Hz–17 kHz. Supply voltage 1.6–3.6 V. Package 4.8×2.8×0.97 mm.",
      ].join("\n"),
      metadata: {
        agentName: "researcher",
        attemptedAgents: ["researcher"],
        delegationSucceeded: true,
        reused: true,
        reusedFromSessionMemory: true,
        factCount: 3,
        partialCount: 0,
      },
    }));

    freshRegisterTool({
      name: "delegate_to_agent",
      description: "Delegate to a specialist.",
      parameters: { type: "object", properties: {} },
      execute: delegateExecuteMock,
    });

    const session = new FreshAgentSession({
      sessionId,
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    const result = await freshRunTurn({ session, userMessage });

    expect(result.blocked).toBe(false);
    expect(result.response).toContain("belastbare Evidenz");
    expect(result.response).toContain("Analog differential output MEMS microphone");
    expect(result.response).toContain("SPH0645LM4H-B");
    expect(result.response).toMatch(/unverifiziert|unvollst/);
    expect(result.response).not.toContain("complete ESP32-S3 pinout");
    expect(result.response).not.toContain("final credit-card layout");
    expect(logAudit).toHaveBeenCalledWith(
      "guardrail_flagged",
      expect.objectContaining({ type: "source_sensitive_failed_delegation_evidence_backstop" }),
      expect.objectContaining({ severity: "warn" }),
    );
  });

  it("cleans source-sensitive recovered evidence instead of dumping raw snapshots", async () => {
    const userMessage = "Use current sources to verify ESP32-S3 audio evidence and what remains missing for IM73A135V01.";
    const sessionId = "sess-source-bounded-recovery-synthesis";
    const {
      AgentSession: FreshAgentSession,
      runTurn: freshRunTurn,
      registerTool: freshRegisterTool,
    } = await loadFreshRuntimeForToolMode("orchestration_only");
    const { writeSharedFact } = await import("../swarm/memory.js");
    await writeSharedFact(
      sessionId,
      "auto_researcher_web_fetch_esp32s3_i2s",
      "[researcher/web_fetch] Content from: https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-reference/peripherals/i2s.html Page Title: Inter-IC Sound (I2S) - ESP32-S3 - ESP-IDF Programming Guide. Page Snapshot: yaml generic navigation search docs.",
    );
    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createDelegateToolCallStream("delegate_partial_raw_evidence", {
          agentName: "mission_coordinator",
          task: "Research ESP32-S3 audio evidence and IM73A135V01.",
        });
      }
      return createTextStream("IM73A135V01 is verified as ST I2S/PDM and the full layout is complete.");
    });

    const delegateExecuteMock = vi.fn(async () => ({
      success: true,
      output: [
        "Sub-agent 'mission_coordinator' timed out after 480000ms",
        "Partial progress before interruption:",
        "- search_workflows [partial] No workflows matched \"hardware design BOM\" strongly enough.",
      ].join("\n"),
      metadata: {
        agentName: "mission_coordinator",
        attemptedAgents: ["mission_coordinator"],
        delegationSucceeded: true,
        delegationOutcome: "partial",
        terminalState: "timeout",
      },
    }));

    freshRegisterTool({
      name: "delegate_to_agent",
      description: "Delegate to a specialist.",
      parameters: { type: "object", properties: {} },
      execute: delegateExecuteMock,
    });

    const session = new FreshAgentSession({
      sessionId,
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    const result = await freshRunTurn({ session, userMessage });

    expect(result.blocked).toBe(false);
    expect(result.response).toContain("docs.espressif.com");
    expect(result.response).toContain("ESP-IDF Programming Guide");
    expect(result.response).toContain("unverifiziert");
    expect(result.response).not.toContain("Page Snapshot");
    expect(result.response).not.toContain("yaml generic navigation");
    expect(result.response).not.toContain("ST I2S/PDM");
  });

  it("forces specialist-agent orchestration for explicit online lookup requests instead of allowing direct web tool calls", async () => {
    let llmCallCount = 0;
    streamMock.mockImplementation((_messages, tools) => {
      llmCallCount += 1;
      const toolNames = tools.map((tool: { name: string }) => tool.name);
      expect(toolNames).toContain("delegate_to_agent");
      if (llmCallCount === 1) {
        expect(toolNames).toContain("search_agents");
      } else {
        expect(toolNames).not.toContain("search_agents");
      }
      expect(toolNames).not.toContain("list_agents");
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

  it("does not force fresh research for short follow-up decisions that can use prior delegated evidence", async () => {
    streamMock.mockImplementation((messages: Array<{ role: string; content?: string | null }>) => {
      const systemText = messages
        .filter((message) => message.role === "system")
        .map((message) => String(message.content ?? ""))
        .join("\n");
      expect(systemText).toContain("CONTINUATION FROM PRIOR EVIDENCE");
      expect(systemText).not.toContain("You MUST use an orchestration tool");
      return createTextStream("Ja, das ist jetzt eine konsistente Richtung: zentrale Konfiguration, lokaler Puffer, expliziter Sync-Modus und klare Trennung von Laufzeit- und UI-Verantwortung.");
    });

    const priorEvidence = [
      "Delegated result from researcher — TASK COMPLETED.",
      "Observed evidence:",
      "## Verified integration evidence",
      "- The service endpoint must remain centralized in configuration.",
      "- Local buffering is required when connectivity is intermittent.",
      "- Explicit sync mode is preferable to continuous network activity for a battery-powered deployment.",
      "- Runtime and UI responsibilities should stay separated.",
      "- The controller remains a reasonable place for buffering and status signalling.",
      "- Mechanical controls should map to clear record and sync states.",
      "- Network retries should be bounded and observable.",
      "- Power-sensitive workflows should avoid idle polling.",
    ].join("\n");

    const session = new AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });
    session.addMessage({ role: "user", content: "Design a portable service integration with exact source-backed deployment choices." });
    session.addMessage({
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "prior_delegate",
        type: "function",
        function: { name: "delegate_to_agent", arguments: JSON.stringify({ task: "Research service integration architecture." }) },
      }],
    });
    session.addMessage({
      role: "tool",
      tool_call_id: "prior_delegate",
      content: priorEvidence,
      metadata: {
        agentName: "researcher",
        attemptedAgents: ["researcher"],
        delegationSucceeded: true,
        delegationOutcome: "success",
        terminalState: "completed",
      },
    });
    session.addMessage({ role: "assistant", content: "Prior answer from delegated evidence." });

    const result = await runTurn({
      session,
      userMessage: "ok, thx...we will go with the recommended modules and keep the endpoint centralized because reliability is what it is all about. We will use the explicit sync mode and keep UI responsibilities separated.",
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toContain("expliziter Sync-Modus");
    expect(streamMock).toHaveBeenCalledTimes(1);
    expect(completeMock).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalledWith(
      "guardrail_flagged",
      expect.objectContaining({ type: "tool_free_research_answer_rejected" }),
      expect.anything(),
    );
    expect(logAudit).toHaveBeenCalledWith(
      "turn_guidance_applied",
      expect.objectContaining({ reusedPriorDelegatedEvidence: true }),
      expect.objectContaining({ severity: "info" }),
    );
  });

  it("forces artifact-producing delegation for downloadable HTML requests even when earlier turns had tool history", async () => {
    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createTextStream("<!DOCTYPE html><html><body><h1>Portable Recorder How-To</h1></body></html>");
      }
      if (llmCallCount === 2) {
        return createDelegateToolCallStream("artifact_delegate_1", {
          agentName: "content_writer",
          task: "Create a downloadable HTML how-to blog page for the portable ESP32 recorder design from the prior discussion. Save/export it as an artifact and return the artifact path, not the full HTML source.",
        });
      }
      return createTextStream("Die HTML-Anleitung wurde als Artefakt erstellt: artifacts/portable-recorder-how-to.html");
    });

    const delegateExecuteMock = vi.fn(async (_args: Record<string, unknown>) => ({
      success: true,
      output: "Artifact created: artifacts/portable-recorder-how-to.html",
      metadata: {
        agentName: "content_writer",
        attemptedAgents: ["content_writer"],
        artifacts: [
          {
            outputPath: "artifacts/portable-recorder-how-to.html",
            artifactKind: "document",
            sourceTool: "generate_document",
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
      name: "search_agents",
      description: "Search available specialist agents.",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ success: true, output: "content_writer" }),
    });

    const statuses: string[] = [];
    const session = new AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });
    session.addMessage({ role: "user", content: "Earlier source-sensitive request" });
    session.addMessage({
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "old_search",
        type: "function",
        function: { name: "search_agents", arguments: JSON.stringify({ query: "old search" }) },
      }],
    });
    session.addMessage({
      role: "tool",
      tool_call_id: "old_search",
      content: "No agents matched the old search.",
    });

    const result = await runTurn({
      session,
      userMessage: "now generate a downloadable html page as detailed instruction / how to do blog. If possible generate artifacts we can see here",
      onStatus: (status) => statuses.push(status.message),
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toContain("artifacts/portable-recorder-how-to.html");
    expect(result.response).not.toContain("<!DOCTYPE html>");
    expect(llmCallCount).toBe(3);
    expect(delegateExecuteMock).toHaveBeenCalledTimes(1);
    expect(delegateExecuteMock.mock.calls[0]?.[0]).toMatchObject({ agentName: "content_writer" });
    expect(statuses).toEqual(expect.arrayContaining([
      "Selecting the required specialist path before drafting the answer.",
      "The draft skipped artifact creation, so I am retrying with the required specialist workflow.",
    ]));
    expect(logAudit).toHaveBeenCalledWith(
      "guardrail_flagged",
      expect.objectContaining({ type: "tool_free_artifact_answer_rejected" }),
      expect.objectContaining({ severity: "warn" }),
    );
  });

  it("trusts the model's direct answer on a research-sensitive turn by default (no forced delegation)", async () => {
    // Phase 2: with trustModelRouting on (default), a freshness-sensitive turn the
    // model chooses to answer directly is accepted on the first pass — no nudge,
    // no rejection, no wasted round-trip. This is the fix for the blank reply to
    // "kannst du jetzt eigene skills erlernen?".
    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      return createTextStream("Here is what I know about the latest 2026 updates from my own knowledge.");
    });

    const session = new AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    const result = await runTurn({
      session,
      userMessage: "What are the latest 2026 AI breakthroughs?",
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toContain("latest 2026 updates");
    expect(llmCallCount).toBe(1);
    expect(result.guardrailEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "delegation_required" }),
    ]));
    expect(result.guardrailEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "routing_nudge_released" }),
    ]));
  });

  it("never-empty: strict trustModelRouting=false still releases the draft after one nudge", async () => {
    // Phase 1 safety net: even in strict mode, a model that insists on answering
    // tool-free is nudged once and then released — the turn never ends empty.
    // (autoResearchOnRefusal disabled here so this asserts the release FALLBACK; the
    // auto-research path is covered by the next test.)
    const freshRuntime = await loadFreshRuntimeForToolMode("orchestration_only", {
      agents: { mainAssistant: { toolMode: "orchestration_only", trustModelRouting: false } },
      orchestration: { autoResearchOnRefusal: false },
    });

    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      return createTextStream("Here is what I know about the latest 2026 updates from my own knowledge.");
    });

    const session = new freshRuntime.AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    const result = await freshRuntime.runTurn({
      session,
      userMessage: "What are the latest 2026 AI breakthroughs?",
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toContain("latest 2026 updates");
    expect(llmCallCount).toBe(2);
    expect(result.guardrailEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "delegation_required", details: "tool_free_research_answer_rejected" }),
      expect.objectContaining({ type: "routing_nudge_released", details: "tool_free_research_answer_rejected" }),
    ]));
  });

  it("auto-researches instead of releasing when the model refuses to delegate on a source-sensitive turn", async () => {
    // Audit bdbace34: a source-sensitive hardware build shipped FABRICATED mic specs
    // because the model answered tool-free and the runtime released after one nudge.
    // With autoResearchOnRefusal (default on), the runtime auto-runs a research
    // delegation and synthesizes from the gathered findings instead of the draft.
    const freshRuntime = await loadFreshRuntimeForToolMode("orchestration_only");
    const { writeSharedFact } = await import("../swarm/memory.js");

    let autoDelegateCalls = 0;
    freshRuntime.registerTool({
      name: "delegate_to_agent",
      description: "Delegate to a specialist.",
      parameters: { type: "object", properties: {} },
      execute: async (_args: Record<string, unknown>, ctx: { sessionId: string }) => {
        autoDelegateCalls += 1;
        await writeSharedFact(
          ctx.sessionId,
          "researcher_verified_mic",
          "Infineon IM73A135V01: analog differential MEMS microphone, SNR 73 dB(A), AOP 135 dBSPL, IP57. "
          + "Needs an external ADC for an ESP32-S3 (it is analog, not PDM/I2S). Source: infineon.com datasheet.",
        );
        return {
          success: true,
          output: "[researcher]: verified the microphone specs and sourcing from the official datasheet.",
          metadata: { delegationSucceeded: true },
        };
      },
    });

    // The model keeps answering tool-free from training data (with WRONG specs).
    streamMock.mockImplementation(() => createTextStream(
      "Der IM73A135V01 ist ein PDM-MEMS-Mikrofon mit ~63 dB SNR (aus meinem Wissen).",
    ));

    const session = new freshRuntime.AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    const result = await freshRuntime.runTurn({
      session,
      userMessage: "Verify the recorder hardware design and microphone choice with current evidence.",
    });

    // The runtime auto-delegated research instead of shipping the draft.
    expect(autoDelegateCalls).toBeGreaterThanOrEqual(1);
    expect(logAudit).toHaveBeenCalledWith(
      "guardrail_flagged",
      expect.objectContaining({ type: "source_sensitive_auto_research_delegated" }),
      expect.anything(),
    );
    // The hallucinated draft was NOT released; the answer is grounded in the findings.
    expect(result.guardrailEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "routing_nudge_released" }),
    ]));
    expect(result.blocked).toBe(false);
    expect(result.response).toContain("73 dB");
  });

  it("lean context injection (default on) injects the recall_context digest + emits prompt_section_sizes telemetry", async () => {
    streamMock.mockImplementation(() => createTextStream("Direct answer."));

    const session = new AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    const result = await runTurn({ session, userMessage: "hello there" });

    expect(result.blocked).toBe(false);
    const messages = streamMock.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
    const systemText = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    expect(systemText).toContain("are NOT preloaded into this prompt");
    expect(logAudit).toHaveBeenCalledWith(
      "prompt_section_sizes",
      expect.objectContaining({ leanContextInjection: true }),
      expect.anything(),
    );
  });

  it("explicit leanContextInjection=false restores full context injection (no digest)", async () => {
    const freshRuntime = await loadFreshRuntimeForToolMode("orchestration_only", {
      agents: { mainAssistant: { toolMode: "orchestration_only" }, performance: { leanContextInjection: false } },
    });

    streamMock.mockImplementation(() => createTextStream("Direct answer."));

    const session = new freshRuntime.AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    const result = await freshRuntime.runTurn({ session, userMessage: "hello there" });

    expect(result.blocked).toBe(false);
    const messages = streamMock.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
    const systemText = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    expect(systemText).not.toContain("are NOT preloaded into this prompt");
  });

  it("task-conditional prompt is off by default (intent-routing rules present in the base prompt)", async () => {
    const session = new AgentSession({ channel: "test", workspacePath: "/workspace" });
    expect(session.getSystemPrompt()).toContain("are computer-use tasks, not pentest tasks");
  });

  it("taskConditionalPrompt=true drops the always-on intent-routing rules", async () => {
    const freshRuntime = await loadFreshRuntimeForToolMode("orchestration_only", {
      agents: { mainAssistant: { toolMode: "orchestration_only" }, performance: { taskConditionalPrompt: true } },
    });

    const session = new freshRuntime.AgentSession({ channel: "test", workspacePath: "/workspace" });
    const prompt = session.getSystemPrompt();

    // Opt-in lean mode: the redundant always-on intent rules are dropped...
    expect(prompt).not.toContain("are computer-use tasks, not pentest tasks");
    expect(prompt).not.toContain("route the task to swarm_maintainer when available");
    // ...but the rest of the base prompt is intact.
    expect(prompt).toContain("Tool Use Discipline");
  });

  it("treats create_ephemeral_agent as a current-turn orchestration attempt for source-sensitive requests", async () => {
    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createToolCallStream("ephemeral_hardware_1", "create_ephemeral_agent", {
          agentName: "embedded_hardware_designer",
          task: "Draft a hardware design guide from the gathered ESP32 microphone evidence.",
        });
      }
      return createTextStream("I used the attempted hardware specialist path and am reporting the best available partial design now.");
    });

    const createEphemeralAgentMock = vi.fn(async () => ({
      success: true,
      output: "Created ephemeral:embedded_hardware_designer, but the sub-agent timed out before producing a full answer.",
      metadata: {
        agentName: "ephemeral:embedded_hardware_designer",
        terminalState: "timeout",
      },
    }));

    registerTool({
      name: "create_ephemeral_agent",
      description: "Create and run a temporary specialist agent.",
      parameters: { type: "object", properties: {} },
      execute: createEphemeralAgentMock,
    });

    const statuses: string[] = [];
    const session = new AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    const result = await runTurn({
      session,
      userMessage: "Use current sources to design a portable ESP32 MEMS microphone recorder and recommend exact components.",
      onStatus: (status) => statuses.push(status.message),
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toContain("best available partial design");
    expect(llmCallCount).toBe(2);
    expect(createEphemeralAgentMock).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual(expect.arrayContaining([
      "Selecting the required specialist path before drafting the answer.",
      "Reviewing completed tool results and preparing the final response.",
    ]));
    expect(logAudit).not.toHaveBeenCalledWith(
      "guardrail_flagged",
      expect.objectContaining({ type: "tool_free_research_answer_rejected" }),
      expect.anything(),
    );
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

  it("releases workflow-catalog enforcement after one nudge instead of blocking into an empty answer", async () => {
    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      // The model insists on direct delegation, skipping the catalog check on
      // both the initial call and the post-nudge retry.
      if (llmCallCount === 1 || llmCallCount === 2) {
        return createDelegateToolCallStream(`wf_persist_${llmCallCount}`, {
          agentName: "mission_coordinator",
          task: "Run the audit export.",
        });
      }
      return createTextStream("Here is the audit export result.");
    });

    const delegateExecuteMock = vi.fn(async () => ({ success: true, output: "audit export done" }));
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
      execute: vi.fn(async () => ({ success: true, output: "no exact match" })),
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

    // Soft nudge, then trust the model — never a hard block into an empty answer.
    expect(result.blocked).toBe(false);
    expect(delegateExecuteMock).toHaveBeenCalled();
    expect(result.response).toContain("audit export result");
    expect(result.guardrailEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "workflow_required", details: "workflow_catalog_check_rejected" }),
      expect.objectContaining({ type: "workflow_required", details: "workflow_catalog_check_released" }),
    ]));
  });

  it("prefers reusable workflow execution for comparison-paper requests even without explicit workflow wording", async () => {
    const freshRuntime = await loadFreshRuntimeForToolMode("hybrid", {
      scenes: {
        protocol_comparison_paper: {
          description: "Compare multiple protocols through one reusable comparison paper workflow.",
          task: "Use the reusable comparison paper workflow for the requested protocol set.",
          triggers: {
            patterns: [
              { all: ["\\bpaper\\b", "\\b(write|draft|prepare|schreib(?:en|e)?|verfass(?:en|e)?)\\b"] },
            ],
          },
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
          triggers: {
            patterns: [
              { all: ["\\bn8n\\b", "\\b(projektliste|project[\\s-]?list|workflows?|einträge|eintraege|entries)\\b"] },
            ],
          },
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
          triggers: {
            patterns: [
              { all: ["\\bn8n\\b", "\\b(projektliste|project[\\s-]?list|workflows?|einträge|eintraege|entries)\\b"] },
            ],
          },
        },
        n8n_run_workflow: {
          description: "Run an explicitly named n8n workflow from the project list.",
          task: "Open the project list, locate {{workflowName}}, and start it.",
          triggers: {
            patterns: [
              { all: ["\\bn8n\\b", "\\b(start|run|ausführ(?:en|e)?|ausfuehr(?:en|e)?|starte(?:n)?)\\b"] },
            ],
          },
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
          triggers: {
            patterns: [
              { all: ["\\bpaper\\b", "\\b(write|draft|prepare|schreib(?:en|e)?|verfass(?:en|e)?)\\b"] },
            ],
          },
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

  it("routes workflow-authoring maintenance requests through the maintainer instead of workflow execution", async () => {
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

    expect(searchWorkflowsMock).not.toHaveBeenCalled();
    expect(delegateExecuteMock).toHaveBeenCalledTimes(1);
    expect(streamMock).toHaveBeenCalledTimes(3);
    expect(result.guardrailEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "workflow_required", details: "workflow_run_required_after_search" }),
    ]));
    expect(result.guardrailEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "delegation_required", details: "maintenance_misroute_rejected" }),
    ]));

    const toolMessages = session.getHistory().filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]?.content).toContain("swarm_maintainer created the new workflow definition.");

    freshRuntime.unregisterTool("search_workflows");
    freshRuntime.unregisterTool("delegate_to_agent");
  });

  it("routes scene-update maintenance requests to swarm_maintainer instead of workflow search", async () => {
    const freshRuntime = await loadFreshRuntimeForToolMode("orchestration_only");

    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createToolCallStream("scene_update_workflow_search_1", "search_workflows", {
          query: "apply_job scene n8n freelancermap credentials",
          workflowType: "scene",
          limit: 5,
        });
      }
      if (llmCallCount === 2) {
        return createDelegateToolCallStream("scene_update_delegate_1", {
          agentName: "swarm_maintainer",
          task: "Update the existing apply_jobs scene so it uses stored credentials for n8n.k2o and freelancermap.com and applies to the next suitable row.",
        });
      }
      return createTextStream("I routed the scene update to swarm_maintainer.");
    });

    const searchWorkflowsMock = vi.fn(async () => ({
      success: true,
      output: "Workflow catalog suggestions only",
    }));
    const delegateExecuteMock = vi.fn(async () => ({
      success: true,
      output: "swarm_maintainer updated workspace/scenes/10-scenes.jsonc and verified the apply_jobs scene.",
      metadata: {
        agentName: "swarm_maintainer",
        attemptedAgents: ["swarm_maintainer"],
        delegationSucceeded: true,
      },
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
      userMessage: "we should update the apply_job scene-> use stored credentials for n8n.k2o and freelancermap.com, check the n8n application table, then apply to the next fitting freelancermap row",
    });

    expect(result.blocked).toBe(false);
    expect(searchWorkflowsMock).not.toHaveBeenCalled();
    expect(delegateExecuteMock).toHaveBeenCalledTimes(1);
    expect(streamMock).toHaveBeenCalledTimes(3);
    expect(result.guardrailEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "delegation_required", details: "maintenance_misroute_rejected" }),
    ]));

    const toolMessages = session.getHistory().filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]?.content).toContain("swarm_maintainer updated workspace/scenes/10-scenes.jsonc");

    freshRuntime.unregisterTool("search_workflows");
    freshRuntime.unregisterTool("delegate_to_agent");
  });

  it("resynthesizes narrated Tool Call final text instead of leaking it", async () => {
    const freshRuntime = await loadFreshRuntimeForToolMode("hybrid");

    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createToolCallStream("workflow_search_then_narrated_tool_1", "search_workflows", {
          query: "reusable workflow availability",
          workflowType: "any",
          limit: 5,
        });
      }
      return createTextStream("[Tool Call] delegate_to_agent(agentName: \"swarm_maintainer\", task: \"Update apply_jobs\")");
    });
    completeMock.mockResolvedValueOnce({
      content: "The previous response only narrated a tool call; no delegation executed in that text.",
      tool_calls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: "stop",
    });

    const searchWorkflowsMock = vi.fn(async () => ({
      success: true,
      output: "No workflows matched reusable workflow availability strongly enough.",
      metadata: { workflowMatches: [] },
    }));

    freshRuntime.registerTool({
      name: "search_workflows",
      description: "Search reusable workflows.",
      parameters: { type: "object", properties: {} },
      execute: searchWorkflowsMock,
    });

    const session = new freshRuntime.AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    const result = await freshRuntime.runTurn({
      session,
      userMessage: "Check the reusable workflow catalog for this note.",
    });

    expect(result.blocked).toBe(false);
    expect(searchWorkflowsMock).toHaveBeenCalledTimes(1);
    expect(completeMock).toHaveBeenCalledTimes(1);
    expect(result.response).not.toContain("[Tool Call]");
    expect(result.response).toContain("only narrated a tool call");

    freshRuntime.unregisterTool("search_workflows");
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
          triggers: {
            patterns: [
              { all: ["\\bpaper\\b", "\\b(write|draft|prepare|schreib(?:en|e)?|verfass(?:en|e)?)\\b"] },
            ],
          },
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
          triggers: {
            patterns: [
              { all: ["\\bpaper\\b", "\\b(write|draft|prepare|schreib(?:en|e)?|verfass(?:en|e)?)\\b"] },
            ],
          },
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
          triggers: {
            patterns: [
              { all: ["\\bpaper\\b", "\\b(write|draft|prepare|schreib(?:en|e)?|verfass(?:en|e)?)\\b"] },
            ],
          },
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
          triggers: {
            patterns: [
              { all: ["\\bpaper\\b", "\\b(write|draft|prepare|schreib(?:en|e)?|verfass(?:en|e)?)\\b"] },
            ],
          },
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

  it("forces synthesis after a warden stop instead of allowing fresh delegation", async () => {
    const freshRuntime = await loadFreshRuntimeForToolMode("hybrid");

    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      return createDelegateToolCallStream(`warden_stop_delegate_${llmCallCount}`, {
        agentName: "mission_coordinator",
        task: `Continue researching after repeated failures (${llmCallCount}).`,
      });
    });

    const delegateExecuteMock = vi.fn(async () => ({
      success: true,
      output: "Delegated result from mission_coordinator — TASK FAILED.\nObserved evidence:\nAll candidate agents failed.",
      metadata: {
        agentName: "mission_coordinator",
        attemptedAgents: ["mission_coordinator"],
        delegationSucceeded: false,
        delegationOutcome: "failure",
        terminalState: "completed",
      },
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

    const result = await freshRuntime.runTurn({
      session,
      userMessage: "Summarize what happened.",
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toBe("synthesized");
    expect(streamMock).toHaveBeenCalledTimes(3);
    expect(delegateExecuteMock).toHaveBeenCalledTimes(2);
    expect(result.guardrailEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "synthesis_required", details: "post_orchestration_tool_call_rejected" }),
    ]));

    const toolMessages = session.getHistory().filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(2);
    expect(session.getHistory().some((message) =>
      message.role === "system"
      && typeof message.content === "string"
      && message.content.startsWith("[WARDEN STOP — FORCED SYNTHESIS]"),
    )).toBe(true);

    freshRuntime.unregisterTool("delegate_to_agent");
  });

  it("continues a direct answer when the provider stops at the output length cap", async () => {
    streamMock
      .mockImplementationOnce(() => createLengthLimitedTextStream("Part one of a long answer. "))
      .mockImplementationOnce(() => createTextStream("Part two finishes the answer."));

    const session = new AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    const streamedChunks: string[] = [];
    const result = await runTurn({
      session,
      userMessage: "Give a long answer.",
      onChunk: (text) => streamedChunks.push(text),
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toBe("Part one of a long answer. Part two finishes the answer.");
    expect(result.performance?.finishReason).toBe("stop");
    expect(result.usage.completionTokens).toBe(4097);
    expect(streamedChunks.join("")).toBe("Part one of a long answer. Part two finishes the answer.");
    expect(streamMock).toHaveBeenCalledTimes(2);
  });
});