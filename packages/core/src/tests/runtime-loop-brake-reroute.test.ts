/**
 * An orchestration turn that a loop brake stopped before any specialist had worked on it gets one
 * re-dispatch of the request before its synthesis.
 *
 * In orchestration_only without --auto nothing forces the orchestrator to delegate, and it holds no
 * file tool. In the E2E run of 2026-10-10 (guards-no-claimed-update-of-missing-file) "change the
 * heading in <file>" called search_tools, then stored "the heading was updated" in memory three
 * times until the streak brake stopped it; guards-list-files-on-a-file called execute_plan with no
 * plan and memory_store with no content until every call had been blocked twice. Both went straight
 * to the synthesis with nothing delegated, and the answers said only that no tool had run, although
 * the discovery prefetch had admitted file-capable specialists for both requests.
 *
 * The runtime now calls runCorrectiveReroute once (agent/turn-corrective.ts): the request as the user
 * wrote it, through delegate_to_agent with no agent named, and the specialist's answer is shipped.
 * Not on a turn that delegated, ran with --auto, retrieved evidence of its own, or whose prefetch
 * admitted no agent.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LLMMessage } from "../providers/lmstudio.js";

const streamMock = vi.hoisted(() => vi.fn());
const auditMock = vi.hoisted(() => vi.fn());
const completeMock = vi.hoisted(() => vi.fn(async (_messages: LLMMessage[]) => ({
  content: "Synthesized from the turn's own results.",
  tool_calls: [],
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  finishReason: "stop",
})));

vi.mock("../providers/index.js", () => {
  const provider = {
    checkHealth: async () => ({ healthy: true }),
    verifyToolCallSupport: async () => true,
    complete: (...args: Parameters<typeof completeMock>) => completeMock(...args),
    stream: (...args: unknown[]) => streamMock(...args),
    embed: async () => [],
    isHealthy: () => true,
  };
  return {
    applyActiveModelPreset: (model: unknown) => model,
    getActiveModelPreset: () => undefined,
    getChatProvider: () => provider,
    getChatProviderWithOverride: () => provider,
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
vi.mock("../audit/logger.js", () => ({
  logAudit: (...args: unknown[]) => auditMock(...args),
  subscribeToAudit: () => () => {},
}));

const REQUEST = "Ändere die Hauptüberschrift in generated/e2e-guards/sommeraktion.html auf „Sommeraktion 2026“.";
const SPECIALIST_ANSWER = "Die Datei generated/e2e-guards/sommeraktion.html existiert im Workspace nicht; es wurde nichts geändert.";

type CapsuleAgent = { name: string; confidence?: string };

const tempDirs: string[] = [];
/** The delegate_to_agent calls of the turn, the model's and the runtime's. */
const delegations: Array<Record<string, unknown>> = [];

afterEach(() => {
  streamMock.mockReset();
  auditMock.mockReset();
  completeMock.mockClear();
  delegations.length = 0;
  delete process.env["SAI_CONFIG_PATH"];
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function load(options: { capsule?: CapsuleAgent[]; delegationSucceeds?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sai-loop-brake-reroute-"));
  tempDirs.push(dir);
  const workspacePath = join(dir, "workspace");
  mkdirSync(join(workspacePath, ".starlingai"), { recursive: true });
  writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
    workspacePath,
    agents: { mainAssistant: { toolMode: "orchestration_only" }, performance: { leanContextInjection: true } },
    subAgents: {
      content_writer: { description: "Writes and edits workspace files.", systemPrompt: "Write.", tools: ["read_file", "write_file", "edit_file", "list_files"] },
    },
    orchestration: {
      discoveryPrefetch: true,
      planFirst: false,
      qaDeliveryLoop: false,
      riskGatedQA: false,
      finalResponseQaGate: false,
    },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
  vi.resetModules();
  const capsule = options.capsule ?? [{ name: "content_writer", confidence: "high" }];
  vi.doMock("../agent/discovery-prefetch.js", () => ({
    formatDiscoveryCapsule: () => "",
    prefetchCapabilityCandidates: async (
      _query: string,
      prefetchOpts?: { onAgents?: (names: readonly string[], agents: readonly CapsuleAgent[]) => void },
    ) => {
      prefetchOpts?.onAgents?.(capsule.map((agent) => agent.name), capsule);
      return capsule.length === 0 ? "" : `[CAPABILITY CANDIDATES — discovered up-front for this turn]\n${capsule.map((agent) => `- ${agent.name}`).join("\n")}`;
    },
  }));
  const { AgentSession, resetSessionsForTests } = await import("../agent/session.js");
  const { runTurn } = await import("../agent/runtime.js");
  // Registers delegate_to_agent and the other orchestration tools, as the gateway does.
  await import("../tools/sub-agent.js");
  const { registerTool } = await import("../tools/registry.js");
  resetSessionsForTests();
  registerTool({
    name: "delegate_to_agent",
    description: "delegate a task",
    parameters: { type: "object", properties: { agentName: { type: "string" }, task: { type: "string" } } },
    execute: async (args: Record<string, unknown>) => {
      delegations.push(args);
      return options.delegationSucceeds === false
        ? { success: false, output: "", error: "The specialist could not run." }
        : { success: true, output: SPECIALIST_ANSWER, metadata: { delegationOutcome: "success", agentName: "content_writer" } };
    },
  });
  registerTool({
    name: "search_tools",
    description: "search the tool catalog",
    parameters: { type: "object", properties: { query: { type: "string" } } },
    execute: async (args: Record<string, unknown>) => ({ success: true, output: `read_file matches "${String(args["query"])}".` }),
  });
  registerTool({
    name: "memory_store",
    description: "store a memory",
    parameters: { type: "object", properties: { key: { type: "string" }, content: { type: "string" } } },
    execute: async () => ({ success: false, output: "", error: "content is required" }),
  });
  registerTool({
    name: "search_documents",
    description: "search the user's documents",
    parameters: { type: "object", properties: { query: { type: "string" } } },
    execute: async () => ({ success: true, output: "sommeraktion.pdf: Sommeraktion 2025, Rabatte bis 30 %." }),
  });
  const session = new AgentSession({ channel: "test", workspacePath, systemPrompt: "You are a test agent." });
  return { session, runTurn };
}

function toolCallStream(callId: string, toolName: string, args: Record<string, unknown>) {
  return (async function* () {
    yield { type: "tool_call_start", toolCallId: callId, toolName };
    yield { type: "tool_call_delta", toolCallId: callId, argumentsDelta: JSON.stringify(args) };
    yield { type: "done", finishReason: "tool_calls", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  })();
}

/** A model that looks for a file tool it does not hold, on every call, after `first` if given. */
function scriptLoopingModel(first?: () => ReturnType<typeof toolCallStream>) {
  let call = 0;
  streamMock.mockImplementation(() => {
    call += 1;
    if (call === 1 && first) return first();
    return toolCallStream(`s${call}`, "search_tools", { query: `read file from workspace ${call}` });
  });
}

const auditRows = (type: string) => auditMock.mock.calls
  .filter(([event, data]) => event === "guardrail_flagged" && (data as { type?: string }).type === type)
  .map(([, data]) => data as Record<string, unknown>);

const brakeRows = () => auditMock.mock.calls
  .filter(([event]) => event === "tool_loop_detected")
  .map(([, data]) => (data as { reason?: string }).reason);

describe("a zero-delegation orchestration turn stopped by a loop brake", () => {
  it("re-dispatches the request once at the streak brake, and ships the specialist's answer", async () => {
    const { session, runTurn } = await load();
    scriptLoopingModel();

    const result = await runTurn({ session, userMessage: REQUEST });

    expect(brakeRows()).toEqual(["tool_streak_across_iterations"]);
    expect(delegations).toHaveLength(1);
    expect(delegations[0]).toEqual({ task: REQUEST });
    expect(result.response).toContain(SPECIALIST_ANSWER);
    expect(auditRows("loop_brake_reroute_delegated")).toEqual([
      expect.objectContaining({ brake: "tool_streak_across_iterations" }),
    ]);
    // The answer is the specialist's: no synthesis was written over it.
    expect(completeMock.mock.calls.some(([messages]) => JSON.stringify(messages).includes("tool-call limit"))).toBe(false);
  });

  it("re-dispatches it once when every call was blocked", async () => {
    const { session, runTurn } = await load();
    streamMock.mockImplementation(() => toolCallStream(`m${streamMock.mock.calls.length}`, "memory_store", { key: "generated/e2e-guards/inventur", content: "" }));

    const result = await runTurn({ session, userMessage: "Liste den Inhalt des Ordners generated/e2e-guards/inventur auf." });

    expect(brakeRows()).toEqual(["all_tool_calls_blocked"]);
    expect(delegations).toHaveLength(1);
    expect(result.response).toContain(SPECIALIST_ANSWER);
  });

  it("falls back to the synthesis when the specialist returns nothing, without claiming nothing changed", async () => {
    const { session, runTurn } = await load({ delegationSucceeds: false });
    streamMock.mockImplementation(() => toolCallStream(`m${streamMock.mock.calls.length}`, "memory_store", { key: "k", content: "" }));

    const result = await runTurn({ session, userMessage: REQUEST });

    expect(delegations).toHaveLength(1);
    expect(result.response).toContain("Synthesized from the turn's own results.");
    const instructions = completeMock.mock.calls.map(([messages]) => String(messages.at(-1)?.content ?? ""));
    expect(instructions.some((text) => text.includes("tool-call limit"))).toBe(true);
    expect(instructions.some((text) => text.includes("NOTHING was created or changed"))).toBe(false);
  });

  it("control: a turn that delegated is left as it was", async () => {
    const { session, runTurn } = await load({ delegationSucceeds: false });
    scriptLoopingModel(() => toolCallStream("d1", "delegate_to_agent", { agentName: "content_writer", task: "Change the heading." }));

    await runTurn({ session, userMessage: REQUEST });

    expect(brakeRows()).toEqual(["tool_streak_across_iterations"]);
    // The model's delegation only.
    expect(delegations).toEqual([{ agentName: "content_writer", task: "Change the heading." }]);
    expect(auditRows("loop_brake_reroute_delegated")).toEqual([]);
  });

  it("control: an --auto turn, a turn that retrieved evidence, and a turn whose prefetch admitted no agent are left as they were", async () => {
    {
      const { session, runTurn } = await load();
      scriptLoopingModel();
      await runTurn({ session, userMessage: REQUEST, autoApprove: true });
      expect(brakeRows()).toEqual(["tool_streak_across_iterations"]);
      expect(delegations).toEqual([]);
    }
    auditMock.mockReset();
    {
      const { session, runTurn } = await load();
      scriptLoopingModel(() => toolCallStream("r1", "search_documents", { query: "sommeraktion" }));
      await runTurn({ session, userMessage: REQUEST });
      expect(brakeRows()).toEqual(["tool_streak_across_iterations"]);
      expect(delegations).toEqual([]);
    }
    auditMock.mockReset();
    {
      const { session, runTurn } = await load({ capsule: [] });
      scriptLoopingModel();
      await runTurn({ session, userMessage: REQUEST });
      expect(brakeRows()).toEqual(["tool_streak_across_iterations"]);
      expect(delegations).toEqual([]);
    }
  });
});
