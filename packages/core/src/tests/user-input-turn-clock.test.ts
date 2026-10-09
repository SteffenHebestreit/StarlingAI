/**
 * The orchestrator's turn deadline holds while the person answers a question the turn asked.
 *
 * The deadline defers only to a child that is still PRODUCING; a tool parked on a person produces
 * nothing, so a turn near its budget was aborted while the question card was still open, and the
 * answer arrived at a turn that no longer existed. Scaled like the grant test beside it: a 200 ms
 * budget and a person who takes 900 ms.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PRODUCT } from "../product/index.js";
import type { UserInputOutcome } from "../agent/user-input.js";

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

const TURN_BUDGET_MS = 200;
const PERSON_ANSWERS_AFTER_MS = 900;

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env["SAI_CONFIG_PATH"];
  (await import("../agent/user-input-broker.js")).userInputBroker.resetForTests();
  vi.resetModules();
  streamMock.mockReset();
  const { resetConfigForTests } = await import("../config/loader.js");
  resetConfigForTests();
  const { resetSessionsForTests } = await import("../agent/session.js");
  resetSessionsForTests();
});

async function loadRuntime() {
  const ws = mkdtempSync(join(tmpdir(), "sai-user-input-clock-"));
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

  const [{ AgentSession, resetSessionsForTests }, { runTurn }, registry, broker] = await Promise.all([
    import("../agent/session.js"),
    import("../agent/runtime.js"),
    import("../tools/registry.js"),
    import("../agent/user-input-broker.js"),
  ]);
  resetSessionsForTests();
  broker.userInputBroker.resetForTests();
  return { AgentSession, runTurn, registry, broker: broker.userInputBroker };
}

describe("the orchestrator turn deadline and a person answering", () => {
  it("holds the deadline through the wait and delivers the answer the turn was waiting for", async () => {
    const { AgentSession, runTurn, registry, broker } = await loadRuntime();
    const session = new AgentSession({ sessionId: "sess-asks", channel: "webchat" });
    broker.openTurn("req-asks", session.id);
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    broker.attachSink(session.id, "tab-1", (event) => {
      events.push(event as { type: string; data: Record<string, unknown> });
      if (event.type !== "agent.user_input_needed") return;
      const inputId = String((event.data as Record<string, unknown>)["inputId"]);
      setTimeout(() => { void broker.respond(inputId, { tier: "quality" }, { isAdmin: false }); }, PERSON_ANSWERS_AFTER_MS);
    });

    let asked: UserInputOutcome<string> | "no requestUserInput" | undefined;
    registry.registerTool({
      name: "delegate_to_agent",
      description: "Delegate a task to a sub-agent.",
      parameters: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
      async execute(_args, ctx) {
        if (!ctx.requestUserInput) {
          asked = "no requestUserInput";
          return { success: true, output: "child finished without asking" };
        }
        asked = await ctx.requestUserInput<string>({
          kind: "image_settings",
          title: "Image settings",
          payload: {},
          validate: (raw) => ({ ok: true, value: String((raw as { tier?: unknown }).tier) }),
        });
        return { success: true, output: `child finished on ${JSON.stringify(asked)}` };
      },
    });

    streamMock
      .mockImplementationOnce(() => toolStream("c1", "delegate_to_agent", { task: "render it" }))
      .mockImplementation(() => textStream("the finished deliverable"));

    const startedAt = Date.now();
    const result = await runTurn({
      session, userMessage: "render the harbour", autoApprove: true,
      turnTimeoutOverrideMs: TURN_BUDGET_MS,
      userInput: { rootSessionId: session.id, turnId: "req-asks", mode: "interactive" },
    });
    registry.unregisterTool("delegate_to_agent");

    expect(Date.now() - startedAt).toBeGreaterThan(PERSON_ANSWERS_AFTER_MS);
    expect(asked).toMatchObject({ outcome: "configured", value: "quality" });
    // The orchestrator's own call: its id, no specialist name.
    const needed = events.find((event) => event.type === "agent.user_input_needed")!.data;
    expect(needed).toMatchObject({ requestId: "req-asks", sessionId: session.id, toolCallId: "c1" });
    expect(needed["sourceAgent"]).toBeUndefined();
    expect(result.response).toContain("the finished deliverable");
  }, 30_000);

  it("credits the waited time once, not again inside the delegation wait that contained it", async () => {
    // The budget is the delegation-wait ceiling itself, so no timer fires and the deadline the
    // runtime mirrors onto the tool context after the call shows exactly what was credited.
    const { AgentSession, runTurn, registry, broker } = await loadRuntime();
    const { DELEGATION_WAIT_CEILING_MS } = await import("../agent/delegation-budget.js");
    const session = new AgentSession({ sessionId: "sess-credit-once", channel: "webchat" });
    broker.openTurn("req-credit", session.id);
    broker.attachSink(session.id, "tab-1", (event) => {
      if (event.type !== "agent.user_input_needed") return;
      const inputId = String((event.data as Record<string, unknown>)["inputId"]);
      setTimeout(() => { void broker.respond(inputId, { tier: "fast" }, { isAdmin: false }); }, 600);
    });

    let turnContext: { _turnDeadlineMs?: number } | undefined;
    let deadlineBefore: number | undefined;
    let callMs = 0;
    registry.registerTool({
      name: "delegate_to_agent",
      description: "Delegate a task to a sub-agent.",
      parameters: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
      async execute(_args, ctx) {
        const startedAt = Date.now();
        turnContext = ctx as { _turnDeadlineMs?: number };
        deadlineBefore = turnContext._turnDeadlineMs;
        await ctx.requestUserInput?.({ kind: "image_settings", title: "Image settings", payload: {}, validate: () => ({ ok: true, value: null }) });
        callMs = Date.now() - startedAt;
        return { success: true, output: "child finished" };
      },
    });
    streamMock
      .mockImplementationOnce(() => toolStream("c1", "delegate_to_agent", { task: "render it" }))
      .mockImplementation(() => textStream("done"));

    await runTurn({
      session, userMessage: "render the harbour", autoApprove: true,
      turnTimeoutOverrideMs: DELEGATION_WAIT_CEILING_MS,
      userInput: { rootSessionId: session.id, turnId: "req-credit", mode: "interactive" },
    });
    registry.unregisterTool("delegate_to_agent");

    // The call's whole length once: the 600 ms wait as a human wait, the rest as delegation wait.
    // Counted twice, the extension would be the call plus another 600 ms.
    const extension = turnContext!._turnDeadlineMs! - deadlineBefore!;
    expect(callMs).toBeGreaterThanOrEqual(600);
    expect(extension).toBeGreaterThanOrEqual(callMs);
    expect(extension).toBeLessThan(callMs + 300);
  }, 30_000);

  it("shows a delegation inside the same call the deadline the wait moved (review #14)", async () => {
    const { AgentSession, runTurn, registry, broker } = await loadRuntime();
    const { DELEGATION_WAIT_CEILING_MS } = await import("../agent/delegation-budget.js");
    const session = new AgentSession({ sessionId: "sess-live", channel: "webchat" });
    broker.openTurn("req-live", session.id);
    broker.attachSink(session.id, "tab-1", (event) => {
      if (event.type !== "agent.user_input_needed") return;
      const inputId = String((event.data as Record<string, unknown>)["inputId"]);
      setTimeout(() => { void broker.respond(inputId, {}, { isAdmin: false }); }, 600);
    });
    const seen: { staticBefore?: number; staticAfter?: number; liveBefore?: number; liveAfter?: number } = {};
    registry.registerTool({
      name: "execute_plan",
      description: "Run a plan.",
      parameters: { type: "object", properties: {} },
      async execute(_args, ctx) {
        // Step 1 asks the person; step 2 would delegate with whatever deadline it reads now.
        seen.staticBefore = ctx._turnDeadlineMs;
        seen.liveBefore = ctx._liveTurnDeadlineMs?.();
        await ctx.requestUserInput?.({ kind: "image_settings", title: "Image settings", payload: {}, validate: () => ({ ok: true, value: null }) });
        seen.staticAfter = ctx._turnDeadlineMs;
        seen.liveAfter = ctx._liveTurnDeadlineMs?.();
        return { success: true, output: "plan finished" };
      },
    });
    streamMock
      .mockImplementationOnce(() => toolStream("c1", "execute_plan", {}))
      .mockImplementation(() => textStream("done"));

    await runTurn({
      session, userMessage: "make the hero image, then build the page", autoApprove: true,
      turnTimeoutOverrideMs: DELEGATION_WAIT_CEILING_MS,
      userInput: { rootSessionId: session.id, turnId: "req-live", mode: "interactive" },
    });
    registry.unregisterTool("execute_plan");

    expect(seen.staticAfter).toBe(seen.staticBefore);
    expect(seen.liveBefore).toBe(seen.staticBefore);
    expect(seen.liveAfter! - seen.liveBefore!).toBeGreaterThanOrEqual(600);
  }, 30_000);

  it("does not read a long answer as silence: a turn producing up to its question survives it (review #13)", async () => {
    const { AgentSession, runTurn, registry, broker } = await loadRuntime();
    // Fake the clocks the deadline runs on; leave setImmediate real so the turn's I/O still settles.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    try {
      const session = new AgentSession({ sessionId: "sess-long-answer", channel: "webchat" });
      broker.openTurn("req-long", session.id);
      broker.attachSink(session.id, "tab-1", (event) => {
        if (event.type !== "agent.user_input_needed") return;
        const inputId = String((event.data as Record<string, unknown>)["inputId"]);
        setTimeout(() => { void broker.respond(inputId, {}, { isAdmin: false }); }, 400_000);
      });
      registry.registerTool({
        name: "delegate_to_agent",
        description: "Delegate a task to a sub-agent.",
        parameters: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
        async execute(_args, ctx) {
          // The specialist works until 25 s, asks at 26 s, the person answers 400 s later, and the
          // render they configured then runs 40 s without a word.
          await new Promise((resolve) => setTimeout(resolve, 25_000));
          ctx.onSubAgentProgress?.({ agentName: "image_creator", kind: "thinking", iteration: 0 });
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          await ctx.requestUserInput?.({ kind: "image_settings", title: "Image settings", payload: {}, timeoutMs: 900_000, validate: () => ({ ok: true, value: null }) });
          await new Promise((resolve) => setTimeout(resolve, 40_000));
          return { success: true, output: "child finished the render" };
        },
      });
      streamMock
        .mockImplementationOnce(() => toolStream("c1", "delegate_to_agent", { task: "render it" }))
        .mockImplementation(() => textStream("the finished deliverable"));

      let result: Awaited<ReturnType<typeof runTurn>> | undefined;
      const turn = runTurn({
        session, userMessage: "render the harbour", autoApprove: true,
        turnTimeoutOverrideMs: 30_000,
        userInput: { rootSessionId: session.id, turnId: "req-long", mode: "interactive" },
      }).then((out) => { result = out; });
      for (let step = 0; step < 1_000 && !result; step += 1) {
        await vi.advanceTimersByTimeAsync(1_000);
        await new Promise((resolve) => setImmediate(resolve));
      }
      await turn;
      registry.unregisterTool("delegate_to_agent");

      expect(result!.performance?.finishReason).not.toBe("aborted_synthesized");
      expect(result!.response).toContain("the finished deliverable");
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);

  it("holds its deadline for approved work only up to the 24 h ceiling", async () => {
    // Review #29 bounded the gateway's hold; the runtime's own hold had no test. A hold that never
    // ends — a render that ignores its timeout — must not keep the turn and its session forever.
    const { AgentSession, runTurn, registry } = await loadRuntime();
    const { holdTurnClocks } = await import("../agent/user-input-broker.js");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    try {
      const session = new AgentSession({ sessionId: "sess-ceiling", channel: "webchat" });
      registry.registerTool({
        name: "delegate_to_agent",
        description: "Delegate a task to a sub-agent.",
        parameters: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
        async execute(_args, ctx) {
          const release = holdTurnClocks(ctx.sessionId, "image_render");
          try {
            await new Promise<void>((resolve) => {
              ctx.signal?.addEventListener("abort", () => resolve(), { once: true });
              setTimeout(resolve, 30 * 3_600_000);
            });
          } finally {
            release();
          }
          return { success: true, output: "rendered" };
        },
      });
      streamMock
        .mockImplementationOnce(() => toolStream("c1", "delegate_to_agent", { task: "render it" }))
        .mockImplementation(() => textStream("the render"));

      const startedAt = Date.now();
      let endedAt: number | undefined;
      const turn = runTurn({ session, userMessage: "render the harbour", autoApprove: true, turnTimeoutOverrideMs: TURN_BUDGET_MS })
        .then(() => { endedAt = Date.now(); }, () => { endedAt = Date.now(); });
      let heldPastBudget = false;
      for (let step = 0; step < 160 && endedAt === undefined; step += 1) {
        await vi.advanceTimersByTimeAsync(600_000);
        await new Promise((resolve) => setImmediate(resolve));
        if (Date.now() - startedAt >= 23 * 3_600_000 && endedAt === undefined) heldPastBudget = true;
      }
      registry.unregisterTool("delegate_to_agent");

      expect(heldPastBudget).toBe(true);
      expect(endedAt).toBeDefined();
      expect(endedAt! - startedAt).toBeGreaterThanOrEqual(86_400_000);
      expect(endedAt! - startedAt).toBeLessThanOrEqual(86_400_000 + 600_000);
      await turn;
    } finally {
      vi.useRealTimers();
    }
  }, 120_000);

  it("is not held by a wait an earlier turn of the session left open, on any surface", async () => {
    // Review of round 1, B #7: a turn with no question channel (AG-UI, --auto, a scene) named no
    // turn on its waits, and one it left open held every later turn of the session.
    const { AgentSession, runTurn, registry } = await loadRuntime();
    const { holdTurnClocks } = await import("../agent/user-input-broker.js");
    const session = new AgentSession({ sessionId: "sess-leftover", channel: "webchat" });
    registry.registerTool({
      name: "delegate_to_agent",
      description: "Delegate a task to a sub-agent.",
      parameters: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
      async execute(_args, ctx) {
        holdTurnClocks(ctx.sessionId, "person"); // never released
        return { success: true, output: "handed over" };
      },
    });
    let sawAbort = false;
    registry.registerTool({
      name: "execute_plan",
      description: "Run a plan.",
      parameters: { type: "object", properties: {} },
      async execute(_args, ctx) {
        await new Promise<void>((resolve) => {
          ctx.signal?.addEventListener("abort", () => { sawAbort = true; resolve(); }, { once: true });
          setTimeout(resolve, 5_000);
        });
        return { success: true, output: "step done" };
      },
    });
    streamMock
      .mockImplementationOnce(() => toolStream("c1", "delegate_to_agent", { task: "hand the browser over" }))
      .mockImplementationOnce(() => textStream("handed over"))
      .mockImplementationOnce(() => toolStream("c2", "execute_plan", {}))
      .mockImplementation(() => textStream("done"));

    await runTurn({ session, userMessage: "log in", autoApprove: true });
    const startedAt = Date.now();
    await runTurn({ session, userMessage: "fetch the invoices", autoApprove: true, turnTimeoutOverrideMs: TURN_BUDGET_MS });
    registry.unregisterTool("delegate_to_agent");
    registry.unregisterTool("execute_plan");

    // The second turn's deadline fired on time instead of holding for the first turn's wait.
    expect(sawAbort).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(4_000);
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
