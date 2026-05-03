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
      userMessage: "Research portable recorder MCU options.",
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
      "## Recherche-Ergebnis: Ultra-flache Mikrofon-Arrays für ESP32",
      "",
      "### Keine fertige ultra-flache 5-Mic-I2S-Lösung",
      "Es gibt kein fertiges Breakout-Board, das gleichzeitig sehr flach, 5 Mikrofone stark und direkt für ESP32-I2S optimiert ist.",
      "",
      "### Beste Custom-PCB-Kandidaten",
      "| Mikrofon | Schnittstelle | Dicke | SNR | Hinweis |",
      "|----------|--------------|-------|-----|---------|",
      "| Infineon ICS-43434 | I2S | 1.0mm | 67dB | Standard Philips I2S, kein Timing-Hack nötig |",
      "| Knowles SPH0645LM4H | I2S | 1.0mm | 64dB | Non-Standard, ESP32 Workaround nötig |",
      "| Infineon IM73A130/131 | PDM | 0.85mm | 66dB | Dünnste Option, PDM über ESP32 lesbar |",
      "",
      "### PDM-zu-I2S/TDM-Option",
      "- TLV320ADCX360: 4 Kanäle, 5x5mm WQFN, I2S/TDM, 24-bit, Low-Power.",
      "- Empfehlung: Custom PCB mit 4 bis 5 Mics und Record-/Sync-Button statt fertigem HAT-Board.",
      "",
      "### Fazit",
      "1. ICS-43434 ist die beste Standard-I2S-Option für ein flaches ESP32-Design.",
      "2. IM73A130 ist die dünnste Option, wenn PDM im Layout akzeptabel ist.",
      "3. Für dein Projekt ist ein Custom-Array mit lokalem Record/On-Button und getrenntem Sync-Button die realistischste Bauform.",
    ].join("\n");

    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createDelegateToolCallStream("call_empty_backstop", {
          agentName: "researcher",
          task: "Find ultra-flat microphone arrays for an ESP32 recorder.",
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
      userMessage: "Find ultra-flat microphone arrays for an ESP32 recorder.",
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toContain("## Recherche-Ergebnis: Ultra-flache Mikrofon-Arrays für ESP32");
    expect(result.response).toContain("ICS-43434");
    expect(result.response).not.toContain("I wasn't able to generate a usable reply for that turn");
    expect(streamMock).toHaveBeenCalledTimes(2);
    expect(delegateExecuteMock).toHaveBeenCalledTimes(1);
    expect(completeMock).toHaveBeenCalledTimes(1);
    expect(session.getHistory().at(-1)?.content).toContain("TLV320ADCX360");
  });

  it("falls back to rich delegated evidence when resynthesis is still too short", async () => {
    const detailedEvidence = [
      "1. ESP32-P4: Includes a dual-core RISC-V application subsystem plus dedicated low-power control logic for richer local audio pipelines and UI orchestration. Current vendor and ecosystem writeups position it as the strongest forward-looking Espressif option when local DSP, display work, and more ambitious coordination logic need to live on the same portable recorder board without immediately offloading everything to a host computer.",
      "2. STM32U5: Remains attractive for ultra-low-power capture workloads when long battery runtime matters more than aggressive on-device inference throughput. In the portable-recorder context it keeps surfacing as the conservative choice for long unattended capture, sleep-heavy duty cycles, and carefully budgeted power rails, even though it does not bring the same integrated Wi-Fi-first developer story as ESP32-class parts.",
      "3. RP2350: Adds stronger general-purpose compute than older RP2040 boards but still depends heavily on external audio front-end choices for serious multi-mic capture. The practical takeaway from recent examples is that it can absolutely record audio, but the path from proof-of-concept I2S capture to a polished OTA recorder still involves more integration work, more board bring-up effort, and more custom software than the ESP32-S3 baseline most builders already know.",
      "4. nRF5340: Best fit when BLE-centric audio transport matters, but Wi-Fi-first OTA streaming still favors ESP-class parts unless a companion radio is acceptable. That makes it attractive for low-power earbuds, BLE microphones, or split architectures, but less compelling when the goal is one self-contained card-sized recorder that should capture, buffer, and push audio over Wi-Fi without bolting on extra network silicon or a second controller.",
      "5. ReSpeaker-style flat microphone arrays remain the main off-the-shelf option; most credit-card-form-factor builds still require custom PCB work for exact geometry and enclosure constraints. The market still offers voice-assistant-oriented modules and Raspberry Pi accessories, but not a turnkey 4-5 microphone flat recorder reference board with the exact thickness, button layout, battery path, and ESP32 integration this project needs.",
      "6. A practical 2026 stack still pairs Wi-Fi-first ESP32-class silicon with a custom array PCB when OTA audio streaming matters more than turnkey module reuse. That conclusion survives the latest part comparisons because the integration burden, radio story, software examples, and developer throughput still matter just as much as raw MCU capability when the end goal is a portable transcription recorder rather than a lab-only audio demo board.",
    ].join("\n\n");

    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createDelegateToolCallStream("coverage_delegate_1", {
          agentName: "web_task_coordinator",
          task: "Research the best 2026 MCU options for portable recording.",
        });
      }

      return createTextStream([
        "1. ESP32-P4 is strong for audio.",
        "2. STM32U5 is efficient.",
        "3. RP2350 is capable.",
        "4. nRF5340 is useful for BLE.",
        "5. Flat mic arrays still need custom PCB work.",
        "6. ESP32-class Wi-Fi remains practical.",
      ].join("\n"));
    });

    completeMock.mockResolvedValueOnce({
      content: [
        "1. ESP32-P4 remains a strong option.",
        "2. STM32U5 is low power.",
        "3. RP2350 is newer.",
        "4. nRF5340 targets BLE audio.",
        "5. Custom PCB arrays are still common.",
        "6. Wi-Fi-first ESP32-class parts remain practical.",
      ].join("\n"),
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
      userMessage: "Which MCU options are best in 2026 for portable recording?",
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
      userMessage: "Research how StarlingAI can improve itself.",
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
      "# Verified hardware guide",
      "",
      ...Array.from({ length: 16 }, (_, index) => `- Evidence item ${index + 1}: IM73A135V01 remains an analog differential microphone with confirmed source-backed design detail ${index + 1}.`),
      "",
      "Use the five-microphone circular ADC architecture for the quality-focused build.",
    ].join("\n");

    let llmCallCount = 0;
    streamMock.mockImplementation(() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return createDelegateToolCallStream("hardware_1", {
          task: "Research the microphone hardware design.",
        });
      }

      return createDelegateToolCallStream("hardware_2", {
        task: "Repeat the same hardware research again.",
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
      userMessage: "Create a source-backed hardware guide for the microphone recorder.",
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toContain("Verified hardware guide");
    expect(result.response).toContain("Evidence item 16");
    expect(result.performance?.finishReason).toBe("synthesis_required_tool_call_rejected");
    expect(streamMock).toHaveBeenCalledTimes(2);
    expect(delegateExecuteMock).toHaveBeenCalledTimes(1);
    expect(completeMock).not.toHaveBeenCalled();
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

  it("falls back to a temporary research agent when search_agents returns no match on source-sensitive turns", async () => {
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
        weakCount: 0,
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
    expect(result.response).toContain("temporary specialist");
    expect(searchExecuteMock).toHaveBeenCalledTimes(1);
    expect(createEphemeralExecuteMock).toHaveBeenCalledTimes(1);
    expect(delegateExecuteMock).not.toHaveBeenCalled();
    expect(createEphemeralExecuteMock.mock.calls[0]?.[0]).toMatchObject({
      agentName: "ephemeral_research_specialist",
      task: "Use current sources to recommend exact ESP32 MEMS microphone components and verify product choices.",
      tools: expect.arrayContaining(["web_search", "web_fetch"]),
    });
    expect(statuses).toEqual(expect.arrayContaining([
      "Agent discovery returned no usable match, so I am falling back to a required research specialist instead of searching again.",
    ]));
    expect(logAudit).toHaveBeenCalledWith(
      "tool_call_recovered",
      expect.objectContaining({
        originalTool: "search_agents",
        rewrittenTo: "create_ephemeral_agent",
        reason: "search_agents_no_match_fallback",
        recoveredAgentName: "ephemeral_research_specialist",
      }),
      expect.objectContaining({ severity: "warn" }),
    );
    expect(logAudit).toHaveBeenCalledWith(
      "guardrail_flagged",
      expect.objectContaining({ type: "agent_discovery_no_match_fallback" }),
      expect.objectContaining({ severity: "warn" }),
    );
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
      return createTextStream("Ja, das ist jetzt eine konsistente Richtung: IM73A135V01 mit externem ADC, 5er-Kreisarray, steifes resin-gedrucktes Gehaeuse und leitfaehige Beschichtung als Shielding-Konzept.");
    });

    const priorEvidence = [
      "Delegated result from researcher — TASK COMPLETED.",
      "Observed evidence:",
      "## Verified microphone evidence",
      "- IM73A135V01 is an analog differential MEMS microphone, not I2S.",
      "- SNR is 73 dB(A) at 2.75 V, making it attractive when maximum audio quality matters.",
      "- Using it with an external ADC is the correct architecture if quality matters more than simplicity.",
      "- A circular five-microphone array is appropriate for beamforming and spatial filtering.",
      "- The ESP32-S3 remains a reasonable controller for buffering and OTA sync.",
      "- Mechanical shielding and acoustic venting matter for transcription quality.",
      "- Keep microphone analog routing quiet and separate from ESP32 RF/power noise.",
      "- Electroplated housing can help shielding if isolated from microphone acoustic ports.",
    ].join("\n");

    const session = new AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });
    session.addMessage({ role: "user", content: "Design a portable microphone recorder with exact source-backed component choices." });
    session.addMessage({
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "prior_delegate",
        type: "function",
        function: { name: "delegate_to_agent", arguments: JSON.stringify({ task: "Research microphone architecture." }) },
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
      userMessage: "ok, thx...we will use them with adc because giving the best quality is what it is all about. We will use the circle with 5 mics and resin-3d-print the housing and than electroplating it",
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toContain("5er-Kreisarray");
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

    const delegateExecuteMock = vi.fn(async () => ({
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