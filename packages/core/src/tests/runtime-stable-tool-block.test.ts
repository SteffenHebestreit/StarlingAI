/**
 * orchestration.stableToolBlock="freeze" — the wire tool array stops moving.
 *
 * The turn's tool array is re-derived per iteration and mutates inside a single turn: a
 * forced ("must orchestrate") iteration cuts it down to the orchestration subset. The chat
 * template renders tools adjacent to the system text, so each mutation re-prefills the whole
 * prefix behind it; the cluster measured a same-content REORDER of the tool block at 47.2 s
 * against 0.43 s for an identical one.
 *
 * These tests pin the CONTRACT, not the saving: under "freeze" every iteration of a turn
 * receives a byte-identical array and the narrowing is enforced at the call site instead.
 * The discriminance test is the "off" case: with the flag off the forced iteration's array
 * really is smaller, so a regression that silently stops freezing fails here rather than
 * passing quietly.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    applyActiveModelPreset: (model: unknown) => model,
    getChatProvider: () => provider,
    getChatProviderWithOverride: () => provider,
    // No routing tier: the receptionist and the upfront source-sensitivity judge both
    // decline, so the ONLY thing that can force orchestration here is the autonomous
    // artifact path the tests drive deliberately.
    getChatProviderForTier: () => null,
    createChatProvider: () => provider,
    tierModelDefaults: () => ({}),
  };
});

vi.mock("../guardrails/rate-limiter.js", () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })) }));
vi.mock("../guardrails/input.js", () => ({
  checkInput: vi.fn(() => ({ allowed: true, detectedPatterns: [] })),
  checkToolOutput: vi.fn(() => ({ allowed: true })),
}));
vi.mock("../guardrails/moderation.js", () => ({
  moderateInputText: vi.fn(async () => null),
  moderateToolResultText: vi.fn(async () => null),
}));
vi.mock("../guardrails/output.js", () => ({ scanOutput: vi.fn((text: string) => ({ safe: true, redacted: text })) }));

const tempConfigDirs: string[] = [];

async function loadRuntime(stableToolBlock: "off" | "freeze") {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-stable-tool-block-"));
  tempConfigDirs.push(tempDir);
  const configPath = join(tempDir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({
    agents: { mainAssistant: { toolMode: "orchestration_only" } },
    orchestration: {
      stableToolBlock,
      // The lever that makes this turn a "must orchestrate" turn without needing a
      // routing-tier provider: an --auto turn whose request asks for an artifact.
      autonomousModeAntiRefusal: true,
      forceToolChoiceWhenOrchestrationRequired: true,
      // Keep the turn short and deterministic.
      planFirst: false,
      discoveryPrefetch: false,
      qaDeliveryLoop: false,
      riskGatedQA: false,
      finalResponseQaGate: false,
    },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configPath;
  vi.resetModules();
  const [{ AgentSession, resetSessionsForTests }, { runTurn }] = await Promise.all([
    import("../agent/session.js"),
    import("../agent/runtime.js"),
  ]);
  return { AgentSession, resetSessionsForTests, runTurn };
}

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

/** The tool names each stream() call was given, in call order. */
function toolNamesPerCall(): string[][] {
  return streamMock.mock.calls.map((call) => ((call[1] ?? []) as Array<{ name: string }>).map((tool) => tool.name));
}

/** Exact serialized bytes of each call's tool array — what the KV prefix is keyed on. */
function toolBytesPerCall(): string[] {
  return streamMock.mock.calls.map((call) => JSON.stringify(call[1] ?? []));
}

const ARTIFACT_REQUEST = "build me a website about local bird species";

afterEach(() => {
  streamMock.mockReset();
  completeMock.mockClear();
  delete process.env["SAI_CONFIG_PATH"];
  for (const dir of tempConfigDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("buildIterationToolRestriction", () => {
  // The restriction is what CARRIES the narrowing under freeze, so it is asserted directly.
  // An earlier version derived it from the un-narrowed active array, which made the
  // discovery branch contain every tool — the narrowing was deleted, not relocated, and no
  // whole-turn test could see it because the refusal simply never fired.
  const tools = [
    { name: "delegate_to_agent" }, { name: "search_agents" }, { name: "list_agents" },
    { name: "memory_store" }, { name: "record_plan" },
  ];
  const forcedTools = [{ name: "delegate_to_agent" }, { name: "record_plan" }];

  it("withholds exactly the discovery tools and keeps everything else callable", async () => {
    const { buildIterationToolRestriction } = await import("../agent/runtime.js");
    const restriction = buildIterationToolRestriction({
      tools, forcedTools, forceToolChoice: false, withholdDiscoveryTools: true,
    });
    expect(restriction?.reason).toBe("discovery_withheld");
    expect(restriction!.allowed.has("search_agents")).toBe(false);
    expect(restriction!.allowed.has("list_agents")).toBe(false);
    // Everything that is not a repeat search stays available — this is a narrowing, not a
    // forced-orchestration gate.
    expect(restriction!.allowed.has("delegate_to_agent")).toBe(true);
    expect(restriction!.allowed.has("memory_store")).toBe(true);
    expect(restriction!.allowed.size).toBe(3);
  });

  it("forcing subsumes the discovery narrowing", async () => {
    const { buildIterationToolRestriction } = await import("../agent/runtime.js");
    const restriction = buildIterationToolRestriction({
      tools, forcedTools, forceToolChoice: true, withholdDiscoveryTools: true,
    });
    expect(restriction?.reason).toBe("must_orchestrate");
    expect([...restriction!.allowed].sort()).toEqual(["delegate_to_agent", "record_plan"]);
  });

  it("returns undefined when neither narrowing applies, so an ordinary iteration is unrestricted", async () => {
    const { buildIterationToolRestriction } = await import("../agent/runtime.js");
    expect(buildIterationToolRestriction({
      tools, forcedTools, forceToolChoice: false, withholdDiscoveryTools: false,
    })).toBeUndefined();
  });
});

describe("orchestration.stableToolBlock", () => {
  it('freeze: every iteration of a turn receives a byte-identical tool array, including the forced one', async () => {
    const { AgentSession, resetSessionsForTests, runTurn } = await loadRuntime("freeze");
    resetSessionsForTests();
    const session = new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "You are a test agent." });

    // Iteration 0 is the forced one (must orchestrate, nothing delegated yet): the model
    // answers it with a delegation, which releases the force for iteration 1.
    streamMock
      .mockImplementationOnce(() => toolCallStream("c1", "delegate_to_agent", {
        agentName: "content_writer",
        task: "Draft a short page about local bird species.",
      }))
      .mockImplementationOnce(() => textStream("Here is the page."));

    await runTurn({ session, userMessage: ARTIFACT_REQUEST, autoApprove: true });

    const bytes = toolBytesPerCall();
    expect(bytes.length).toBeGreaterThanOrEqual(2);
    // The contract: not merely the same NAMES but the same bytes in the same order.
    expect(new Set(bytes).size).toBe(1);
  });

  it('off: the forced iteration is served a strictly smaller array (the behaviour freeze removes)', async () => {
    const { AgentSession, resetSessionsForTests, runTurn } = await loadRuntime("off");
    resetSessionsForTests();
    const session = new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "You are a test agent." });

    streamMock
      .mockImplementationOnce(() => toolCallStream("c1", "delegate_to_agent", {
        agentName: "content_writer",
        task: "Draft a short page about local bird species.",
      }))
      .mockImplementationOnce(() => textStream("Here is the page."));

    await runTurn({ session, userMessage: ARTIFACT_REQUEST, autoApprove: true });

    const names = toolNamesPerCall();
    expect(names.length).toBeGreaterThanOrEqual(2);
    // Forced iteration 0 is cut down to the orchestration subset; the released
    // iteration 1 gets the full block back. This is the mid-turn mutation.
    expect(names[0]!.length).toBeLessThan(names[1]!.length);
    expect(new Set(toolBytesPerCall()).size).toBeGreaterThan(1);
  });

  it('freeze: a tool that cannot advance a forced turn is refused at the call site, not executed', async () => {
    const { AgentSession, resetSessionsForTests, runTurn } = await loadRuntime("freeze");
    resetSessionsForTests();
    const session = new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "You are a test agent." });

    // memory_store is on the wire under freeze (the array is not narrowed), so the model
    // can pick it to satisfy tool_choice:"required" — the loop that audit be828e39 recorded.
    // The call-site restriction is what stops it.
    streamMock
      .mockImplementationOnce(() => toolCallStream("c1", "memory_store", { kind: "fact", content: "birds exist" }))
      .mockImplementationOnce(() => toolCallStream("c2", "delegate_to_agent", {
        agentName: "content_writer",
        task: "Draft a short page about local bird species.",
      }))
      .mockImplementationOnce(() => textStream("Here is the page."));

    const toolResults: Array<{ name: string; result: string }> = [];
    await runTurn({
      session,
      userMessage: ARTIFACT_REQUEST,
      autoApprove: true,
      onToolResult: (_id, name, result) => { toolResults.push({ name, result }); },
    });

    const refusal = toolResults.find((entry) => entry.name === "memory_store");
    expect(refusal).toBeDefined();
    expect(refusal!.result).toContain("cannot advance this turn yet");
    // The message must name what WOULD satisfy the requirement — the model has to be able
    // to act on the refusal, otherwise it re-picks the same tool next iteration.
    expect(refusal!.result).toContain("delegate_to_agent");
    // And the array still never moved.
    expect(new Set(toolBytesPerCall()).size).toBe(1);
  });
});
