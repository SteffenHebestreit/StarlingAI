import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalPendingListener } from "../approval/routed.js";

/**
 * A turn tells its chat when one of its calls waits for someone else's approval
 * (RunTurnOptions.onApprovalPending, approval/routed.ts). The listener rides the request context,
 * so a call inside a specialist or a workflow step, which builds its own ToolContext, still reaches
 * the chat that asked; a nested turn inherits it, and one given its own keeps that. The person who
 * sent the turn's message (RunTurnOptions.sender), whom an approval policy asks about, rides it the
 * same way.
 *
 * The model is stubbed. Its calls run inside the turn's request context, so they see what the
 * turn's tool calls would see.
 */

const seen = vi.hoisted(() => [] as unknown[]);
const seenSenders = vi.hoisted(() => [] as unknown[]);
const readContext = vi.hoisted(() => ({ current: (): unknown => undefined, sender: (): unknown => undefined }));
const streamMock = vi.hoisted(() => vi.fn());
const completeMock = vi.hoisted(() => vi.fn());

vi.mock("../providers/index.js", () => {
  const provider = {
    checkHealth: async () => ({ healthy: true }),
    verifyToolCallSupport: async () => true,
    complete: (...args: unknown[]) => completeMock(...(args as [])),
    stream: (...args: unknown[]) => streamMock(...(args as [])),
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
vi.mock("../guardrails/output.js", () => ({ scanOutput: vi.fn((text: string) => ({ safe: true, redacted: text })) }));
vi.mock("../audit/logger.js", () => ({ logAudit: vi.fn() }));

function answerStream(text: string) {
  return (async function* () {
    yield { type: "text_delta", content: text };
    yield { type: "done", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  })();
}

async function loadRuntime() {
  const dir = mkdtempSync(join(tmpdir(), "sai-approval-pending-"));
  writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
    agents: { mainAssistant: { toolMode: "orchestration_only" } },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
  vi.resetModules();
  const { AgentSession } = await import("../agent/session.js");
  const { runTurn } = await import("../agent/runtime.js");
  const requestContext = await import("../runtime/request-context.js");
  readContext.current = () => requestContext.currentRequestContext()?.onApprovalPending;
  readContext.sender = () => requestContext.currentRequestContext()?.sender;
  streamMock.mockImplementation(() => {
    seen.push(readContext.current());
    seenSenders.push(readContext.sender());
    return answerStream("Done.");
  });
  completeMock.mockImplementation(async () => {
    seen.push(readContext.current());
    seenSenders.push(readContext.sender());
    return { content: "Done.", tool_calls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop" };
  });
  const session = () => new AgentSession({ channel: "test", workspacePath: mkdtempSync(join(tmpdir(), "sai-approval-pending-ws-")), systemPrompt: "You are a test agent." });
  return { session, runTurn, requestContext };
}

describe("a turn's approval-pending listener", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    streamMock.mockReset();
    completeMock.mockReset();
    seen.length = 0;
    seenSenders.length = 0;
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
  });

  it("rides the turn's request context", async () => {
    const { session, runTurn } = await loadRuntime();
    const listener: ApprovalPendingListener = vi.fn();
    await runTurn({ session: session(), userMessage: "Export the record.", onApprovalPending: listener });
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set([listener]));
  });

  it("is inherited by a nested turn, and a turn given its own keeps that", async () => {
    const { session, runTurn, requestContext } = await loadRuntime();
    const outer: ApprovalPendingListener = vi.fn();
    const own: ApprovalPendingListener = vi.fn();
    await requestContext.runWithRequestContext({ onApprovalPending: outer }, () =>
      runTurn({ session: session(), userMessage: "Run the workflow step." }));
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set([outer]));

    seen.length = 0;
    await requestContext.runWithRequestContext({ onApprovalPending: outer }, () =>
      runTurn({ session: session(), userMessage: "Run the workflow step.", onApprovalPending: own }));
    expect(new Set(seen)).toEqual(new Set([own]));
  });

  it("is absent from a turn nobody gave one", async () => {
    const { session, runTurn } = await loadRuntime();
    await runTurn({ session: session(), userMessage: "Export the record." });
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set([undefined]));
    // Nor does such a turn name anyone who sent it.
    expect(new Set(seenSenders)).toEqual(new Set([undefined]));
  });
});

describe("the person who sent a turn's message (RunTurnOptions.sender)", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    streamMock.mockReset();
    completeMock.mockReset();
    seen.length = 0;
    seenSenders.length = 0;
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
  });

  it("rides the turn's request context; a nested turn inherits it, and one given its own keeps that", async () => {
    // An approval policy asks who sent the message from inside any run the turn starts, so the
    // sender rides the context like the approval-pending listener does.
    const { session, runTurn, requestContext } = await loadRuntime();
    const sender = () => ({ identity: { userId: "root" }, role: "admin" });
    await runTurn({ session: session(), userMessage: "Export the record.", sender });
    expect(seenSenders.length).toBeGreaterThan(0);
    expect(new Set(seenSenders)).toEqual(new Set([sender]));

    seenSenders.length = 0;
    await requestContext.runWithRequestContext({ sender }, () => runTurn({ session: session(), userMessage: "Run the workflow step." }));
    expect(new Set(seenSenders)).toEqual(new Set([sender]));

    seenSenders.length = 0;
    const own = () => ({ identity: { userId: "olga" }, role: "operator" });
    await requestContext.runWithRequestContext({ sender }, () =>
      runTurn({ session: session(), userMessage: "Run the workflow step.", sender: own }));
    expect(new Set(seenSenders)).toEqual(new Set([own]));
  });
});
