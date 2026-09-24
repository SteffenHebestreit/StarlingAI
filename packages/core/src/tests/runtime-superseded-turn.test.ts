/**
 * A superseded turn unwinds after the turn that replaced it has started, and its teardown must
 * touch only what is its own. The Warden's abort registry is keyed by session: the old turn's
 * `finally` deleted the NEW turn's controller, so a forced Stop, a distributed cancel and a Warden
 * abort all missed the turn that was actually running (review of round 1, B #4).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PRODUCT } from "../product/index.js";

const streamMock = vi.hoisted(() => vi.fn());

vi.mock("../providers/index.js", () => {
  const provider = {
    checkHealth: async () => ({ healthy: true }),
    verifyToolCallSupport: async () => true,
    complete: async () => ({
      content: "synthesized", tool_calls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop",
    }),
    stream: (...args: unknown[]) => streamMock(...args),
    embed: async () => [],
    isHealthy: () => true,
  };
  return {
    applyActiveModelPreset: (model: unknown) => model,
    getChatProvider: () => provider,
    getChatProviderWithOverride: () => provider,
    getChatProviderForTier: () => null,
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
vi.mock("../guardrails/output.js", () => ({ scanOutput: vi.fn((t: string) => ({ safe: true, redacted: t })) }));
vi.mock("../audit/logger.js", () => ({ logAudit: vi.fn() }));

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env["SAI_CONFIG_PATH"];
  vi.resetModules();
  streamMock.mockReset();
  (await import("../config/loader.js")).resetConfigForTests();
  (await import("../agent/session.js")).resetSessionsForTests();
});

describe("a superseded turn unwinding late", () => {
  it("leaves the registration of the turn that replaced it in place", async () => {
    const ws = mkdtempSync(join(tmpdir(), "sai-superseded-turn-"));
    mkdirSync(join(ws, PRODUCT.stateDirName), { recursive: true });
    tempDirs.push(ws);
    writeFileSync(join(ws, "starlingai.json"), JSON.stringify({
      workspacePath: ws,
      agents: {
        defaults: { model: { primary: "mock-model" }, maxIterations: 5, turnTimeoutMs: 30_000 },
        maxToolIterations: 4,
        ephemeralGeneration: { enabled: false, skillMatchThreshold: 0.7, architectAgentName: "agent_architect" },
      },
      subAgents: {},
      guardrails: { enabled: false },
    }), "utf-8");
    process.env["SAI_CONFIG_PATH"] = join(ws, "starlingai.json");
    const [{ AgentSession }, { runTurn }, registry, warden] = await Promise.all([
      import("../agent/session.js"),
      import("../agent/runtime.js"),
      import("../tools/registry.js"),
      import("../agent/warden.js"),
    ]);

    // The old turn's tool hears the Stop but finishes only after the new turn is running.
    let releaseOld!: () => void;
    const oldToolDone = new Promise<void>((resolve) => { releaseOld = resolve; });
    let oldToolStarted = false;
    registry.registerTool({
      name: "delegate_to_agent",
      description: "Delegate a task to a sub-agent.",
      parameters: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
      async execute() {
        oldToolStarted = true;
        await oldToolDone;
        return { success: true, output: "child finished" };
      },
    });
    let newToolStarted = false;
    let newTurnStopped = false;
    registry.registerTool({
      name: "execute_plan",
      description: "Run a plan.",
      parameters: { type: "object", properties: {} },
      async execute(_args, ctx) {
        newToolStarted = true;
        await new Promise<void>((resolve) => ctx.signal?.addEventListener("abort", () => { newTurnStopped = true; resolve(); }, { once: true }));
        return { success: true, output: "plan stopped" };
      },
    });
    streamMock
      .mockImplementationOnce(() => toolStream("c1", "delegate_to_agent", { task: "render it" }))
      .mockImplementationOnce(() => toolStream("c2", "execute_plan", {}))
      .mockImplementation(() => textStream("done"));

    const session = new AgentSession({ sessionId: "sess-superseded", channel: "webchat" });
    const oldCaller = new AbortController();
    const oldTurn = runTurn({ session, userMessage: "render the harbour", autoApprove: true, signal: oldCaller.signal }).catch(() => undefined);
    await vi.waitFor(() => expect(oldToolStarted).toBe(true));

    // Superseded: the gateway stops the old turn and starts the new one on the same session.
    oldCaller.abort();
    const newTurn = runTurn({ session, userMessage: "make it a sunset instead", autoApprove: true }).catch(() => undefined);
    await vi.waitFor(() => expect(newToolStarted).toBe(true));
    releaseOld();
    await oldTurn;

    // The running turn is still the session's turn, and a forced Stop reaches it.
    expect(warden.isSessionTurnActive(session.id)).toBe(true);
    expect(warden.abortSessionTurnLocally(session.id, "operator_stop")).toBe(true);
    await newTurn;
    expect(newTurnStopped).toBe(true);
    registry.unregisterTool("delegate_to_agent");
    registry.unregisterTool("execute_plan");
  }, 30_000);
});

function toolStream(callId: string, toolName: string, args: Record<string, unknown>) {
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
