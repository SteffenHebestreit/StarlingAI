/**
 * The runtime turn deadline honours the operator's unbounded grant.
 *
 * This is the measured bug, at 1/6000 scale. Audit 3959f3ac:
 *   07:35:24  long_running_generation_resolved { outcome: "unbounded", operator: "steffen" }
 *   07:54:36  turn_timeout_recovered           { timeoutMs: 1800000 }
 * The grant reached the sub-agent's own deadline and stopped there. runtime.ts armed a
 * plain `setTimeout(() => turnAbort.abort(...))` that nothing could read the grant from,
 * so it killed the turn 19 minutes after the operator said not to.
 *
 * The two cases below are each other's control: the SAME run, the SAME budget, the SAME
 * over-running completion — one granted, one not. If the grant path ever stops working,
 * the first fails; if the deadline itself ever stops working, the second does.
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

/**
 * The audited shape, scaled: a turn budget, and a single completion that runs well past
 * it. 200 ms / 900 ms keeps the suite fast; the ratio is what matters (the real run was
 * 1,800,000 ms of budget against a completion still going at 1,615,806 ms).
 */
const TURN_BUDGET_MS = 200;
const COMPLETION_MS = 900;

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env["SAI_CONFIG_PATH"];
  vi.resetModules();
  streamMock.mockReset();
  const { resetConfigForTests } = await import("../config/loader.js");
  resetConfigForTests();
  const { resetSessionsForTests } = await import("../agent/session.js");
  resetSessionsForTests();
});

async function loadRuntime() {
  const ws = mkdtempSync(join(tmpdir(), "sai-grant-deadline-"));
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

  const [{ AgentSession, resetSessionsForTests }, { runTurn }, lrg, registry] = await Promise.all([
    import("../agent/session.js"),
    import("../agent/runtime.js"),
    import("../agent/long-running-generation.js"),
    import("../tools/registry.js"),
  ]);
  resetSessionsForTests();
  lrg.longRunningGenerationManager.resetForTests();
  return { ws, AgentSession, runTurn, lrg: lrg.longRunningGenerationManager, registry };
}

/**
 * One completion that takes COMPLETION_MS and RESPECTS the abort signal — the real
 * provider does, and a mock that ignored it would pass whatever the deadline did.
 * `onStart` runs once the turn is live, which is where the operator's grant lands
 * (runTurn clears any stale grant at turn START, so granting earlier proves nothing).
 */
function slowStream(signal: AbortSignal | undefined, onStart: () => void) {
  return (async function* () {
    onStart();
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, COMPLETION_MS);
      signal?.addEventListener("abort", () => {
        clearTimeout(t);
        reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      }, { once: true });
    });
    yield { type: "text_delta", content: "the finished deliverable" };
    yield { type: "done", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  })();
}

describe("an operator unbounded grant outranks the runtime turn deadline", () => {
  it("keeps a granted turn alive past its budget and delivers the answer", async () => {
    const { AgentSession, runTurn, lrg } = await loadRuntime();
    const session = new AgentSession({ sessionId: "sess-3959f3ac", channel: "test" });

    streamMock.mockImplementation((_m: unknown, _t: unknown, signal: AbortSignal | undefined) =>
      // The grant arrives on the sub-agent's own nested id, exactly as the dock files it.
      // Nothing here tells the runtime about it — the runtime has to find it via rootOf().
      slowStream(signal, () => lrg.markUnbounded(`sub:${session.id}:backend_coder:1`)));

    const result = await runTurn({
      session, userMessage: "build the thing", autoApprove: true,
      turnTimeoutOverrideMs: TURN_BUDGET_MS,
    });

    expect(result.response).toContain("the finished deliverable");
  }, 30_000);

  it("still kills the identical run when NO grant was made — the deadline is not disabled", async () => {
    const { AgentSession, runTurn } = await loadRuntime();
    const session = new AgentSession({ sessionId: "sess-ungranted", channel: "test" });

    streamMock.mockImplementation((_m: unknown, _t: unknown, signal: AbortSignal | undefined) =>
      slowStream(signal, () => { /* no operator, no grant */ }));

    const result = await runTurn({
      session, userMessage: "build the thing", autoApprove: true,
      turnTimeoutOverrideMs: TURN_BUDGET_MS,
    });

    // The turn is guillotined and says so: the DeadlineAbort surfaces as the turn's
    // outcome instead of the deliverable. (The never-empty invariant turns it into a
    // response rather than a throw — which is why the granted case above must assert on
    // the CONTENT, not merely on "it did not reject".)
    expect(result.response).not.toContain("the finished deliverable");
    expect(result.response).toMatch(/DeadlineAbort|deadline of 200ms/);
  }, 30_000);
});

/**
 * D5 (orchestration.excludeDelegationWaitFromTurnBudget) shipped default(true) and could
 * not move the deadline by a millisecond AT THE SHIPPED CONFIG, because the runtime armed
 * its ceiling at `turnStart + DELEGATION_WAIT_CEILING_MS` and both numbers were 1,800,000:
 *   extendDeadlineForDelegationWait(D, w, ceiling) = max(D, min(D + w, D)) = D
 *
 * The budget used here is DELEGATION_WAIT_CEILING_MS itself — imported, not retyped — so
 * the test reproduces the collision instead of asserting around it. The wall clock never
 * reaches 30 minutes: the observable is the deadline the runtime MIRRORS onto the tool
 * context after a delegation wait, which a probe tool reads on the next iteration.
 *
 * Revert (`turnStart + DELEGATION_WAIT_CEILING_MS`) and the extension is exactly zero.
 */
describe("the delegation-wait exclusion can actually extend the deadline", () => {
  it("pushes the turn deadline out past a budget equal to the delegation-wait ceiling", async () => {
    const { AgentSession, runTurn, registry } = await loadRuntime();
    const { DELEGATION_WAIT_CEILING_MS } = await import("../agent/delegation-budget.js");
    const session = new AgentSession({ sessionId: "sess-d5", channel: "test" });

    const DELEGATION_WAIT_MS = 300;
    // The runtime mirrors the extended deadline onto the LIVE tool context after a
    // delegation-wait tool returns, so holding the context reference and reading it once
    // the turn is over shows what the next delegation would have been handed.
    let deadlineAtDelegation: number | undefined;
    let turnContext: { _turnDeadlineMs?: number } | undefined;

    registry.registerTool({
      name: "delegate_to_agent",
      description: "Delegate a task to a sub-agent.",
      parameters: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
      async execute(_args, ctx) {
        turnContext = ctx as { _turnDeadlineMs?: number };
        deadlineAtDelegation = turnContext._turnDeadlineMs;
        await new Promise((r) => setTimeout(r, DELEGATION_WAIT_MS));
        return { success: true, output: "child finished" };
      },
    });

    streamMock
      .mockImplementationOnce(() => toolStream("c1", "delegate_to_agent", { task: "build it" }))
      .mockImplementation(() => textStream("done"));

    const startedAt = Date.now();
    await runTurn({
      session, userMessage: "delegate then report", autoApprove: true,
      turnTimeoutOverrideMs: DELEGATION_WAIT_CEILING_MS,
    });

    registry.unregisterTool("delegate_to_agent");

    // Before the wait: at most the plain budget. After it: strictly beyond, by roughly the
    // time the orchestrator sat blocked on the child.
    expect(deadlineAtDelegation!).toBeLessThanOrEqual(startedAt + DELEGATION_WAIT_CEILING_MS);
    expect(turnContext?._turnDeadlineMs).toBeGreaterThan(startedAt + DELEGATION_WAIT_CEILING_MS);
  }, 30_000);
});

/**
 * The turn deadline is a LIVENESS PROBE, not a budget — the last of six hard timers.
 *
 * Run 5 (2026-08-18): the sub-agent's own deadline extended twice on evidence of progress
 * and the gateway clock paused for the delegation wait, and then this timer fired at
 * exactly 30:00 and cancelled a delegate that had been building for 1,611 seconds and was
 * still writing. The parent sits BLOCKED inside delegate_to_agent for that whole stretch,
 * so its own liveness is its child's: every chunk the child emits arrives as a progress
 * event. A child still producing is not a stuck turn.
 *
 * The pair below are each other's control: identical budget, identical over-running
 * delegation, differing only in whether the child reports progress. Remove the deferral and
 * the first fails; remove the deadline and the second does.
 */
describe("the turn deadline defers to a delegated child that is still producing", () => {
  it("keeps the turn alive while the child emits progress, and delivers the answer", async () => {
    const { AgentSession, runTurn, registry } = await loadRuntime();
    const session = new AgentSession({ sessionId: "sess-live-child", channel: "test" });

    registry.registerTool({
      name: "delegate_to_agent",
      description: "Delegate a task to a sub-agent.",
      parameters: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
      async execute(_args, ctx) {
        // A child that is working: it reports reasoning while it runs past the parent's
        // budget, exactly as a real sub-agent's stream does.
        for (let i = 0; i < 4; i++) {
          ctx.onSubAgentProgress?.({
            agentName: "web_coder", kind: "reasoning", iteration: i,
            reasoning: `composing subsystem ${i}`,
          });
          await new Promise((r) => setTimeout(r, COMPLETION_MS / 4));
        }
        return { success: true, output: "child finished the build" };
      },
    });

    streamMock
      .mockImplementationOnce(() => toolStream("c1", "delegate_to_agent", { task: "build it" }))
      .mockImplementation(() => textStream("the finished deliverable"));

    const result = await runTurn({
      session, userMessage: "delegate then report", autoApprove: true,
      turnTimeoutOverrideMs: TURN_BUDGET_MS,
    });
    registry.unregisterTool("delegate_to_agent");

    expect(result.response).toContain("the finished deliverable");
  }, 30_000);

  it("still kills an identical turn whose child goes silent — the deadline is not disabled", async () => {
    const { AgentSession, runTurn, registry } = await loadRuntime();
    const session = new AgentSession({ sessionId: "sess-silent-child", channel: "test" });

    registry.registerTool({
      name: "delegate_to_agent",
      description: "Delegate a task to a sub-agent.",
      parameters: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
      async execute() {
        // Same duration, same shape — but nothing to show for it. This is the wedged run
        // the deadline still has to end.
        await new Promise((r) => setTimeout(r, COMPLETION_MS));
        return { success: true, output: "child finished the build" };
      },
    });

    streamMock
      .mockImplementationOnce(() => toolStream("c1", "delegate_to_agent", { task: "build it" }))
      .mockImplementation(() => textStream("the finished deliverable"));

    const result = await runTurn({
      session, userMessage: "delegate then report", autoApprove: true,
      turnTimeoutOverrideMs: TURN_BUDGET_MS,
    });
    registry.unregisterTool("delegate_to_agent");

    expect(result.response).not.toContain("the finished deliverable");
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
