import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `--agent NAME` delegates the turn to that agent (RunTurnOptions.directiveAgent, found by the E2E
 * suite 2026-10-07).
 *
 * The flag only narrowed allowedAgents to the one agent, and the orchestrator answered such a turn
 * itself: code_analyst never ran on two diagnoses the suite pinned to it, and the agent evaluations
 * that pin an agent the same way were measuring the orchestrator. Until the turn has delegated, its
 * tool call is forced and a line names the agent.
 */

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

/**
 * The specialist and the orchestration tools around it, stubbed; everything else is the real
 * registry. `delegated` holds the delegations that reached code_analyst. A delegation naming any
 * other agent gets the refusal delegate_to_agent gives an agent outside the turn's grant.
 */
const delegated = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const executed = vi.hoisted(() => [] as string[]);
vi.mock("../tools/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools/registry.js")>();
  return {
    ...actual,
    executeTool: vi.fn(async (name: string, args: Record<string, unknown>, ctx: never, meta?: never) => {
      executed.push(name);
      if (name === "delegate_to_agent" && args["agentName"] !== "code_analyst") {
        return { success: false, output: "", error: `Agent '${String(args["agentName"])}' is not permitted in this scene. Allowed agents: code_analyst` };
      }
      if (name === "delegate_to_agent") {
        delegated.push(args);
        return {
          success: true,
          output: "Delegated result from code_analyst — TASK COMPLETED.\nObserved evidence:\nTRUNCATION-IN-INVOICES-AND-RECEIPTS",
          metadata: { agentName: "code_analyst", attemptedAgents: ["code_analyst"], delegationSucceeded: true, delegationOutcome: "success", terminalState: "completed" },
        };
      }
      if (name === "create_ephemeral_agent") {
        return { success: false, output: "", error: "Unknown tool(s) requested: nope.", rejectedBeforeEffect: true };
      }
      if (name === "parallel_delegate") {
        return {
          success: true,
          output: "**[code_analyst]**:\nint() truncates the cent in invoices.py and receipts.py.",
          metadata: { taskCount: 1, succeeded: 1, failed: 0, nestedCalls: [{ tool: "delegate_to_agent", success: true }] },
        };
      }
      if (name === "search_workflows") {
        return {
          success: true,
          output: "Workflow matches: code_review [scene] (0.82)",
          metadata: { workflowMatches: [{ name: "code_review", workflowType: "scene", score: 0.82, matchedTerms: ["code", "bug", "review"] }] },
        };
      }
      if (name === "run_workflow") {
        return {
          success: true,
          output: "Workflow code_review [scene] completed.\n\nThe review found that total() truncates with int(); use round(subtotal + tax, 2).",
          metadata: { workflowName: "code_review", workflowType: "scene", blocked: false, stepCount: 1, toolCallsExecuted: 3 },
        };
      }
      return actual.executeTool(name, args, ctx, meta);
    }),
  };
});

/** A response that calls one tool; `args` as a string is sent as the raw argument text. */
function toolStream(name: string, args: Record<string, unknown> | string) {
  return (async function* () {
    yield { type: "tool_call_start", toolCallId: `call_${name}`, toolName: name };
    yield { type: "tool_call_delta", toolCallId: `call_${name}`, argumentsDelta: typeof args === "string" ? args : JSON.stringify(args) };
    yield { type: "done", finishReason: "tool_calls", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  })();
}

function delegateStream() {
  return toolStream("delegate_to_agent", { agentName: "code_analyst", task: "Find the bug in invoices.py." });
}

function answerStream(text: string) {
  return (async function* () {
    yield { type: "text_delta", content: text };
    yield { type: "done", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  })();
}

const CODE_ANALYST = {
  description: "Analyzes source code and finds bugs.",
  capabilities: ["code analysis"],
  tags: ["code"],
  tools: ["read_file"],
  maxIterations: 4,
};

async function loadRuntime(extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sai-directive-"));
  writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
    agents: { mainAssistant: { toolMode: "orchestration_only" } },
    ...extra,
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
  vi.resetModules();
  const { AgentSession } = await import("../agent/session.js");
  const { runTurn } = await import("../agent/runtime.js");
  return { AgentSession, runTurn };
}

/** Every message the given provider.stream call was sent, as one text. */
const promptOf = (callIndex: number): string =>
  ((streamMock.mock.calls[callIndex]?.[0] ?? []) as Array<{ content?: unknown }>)
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n");
/** The tool choice the given provider.stream call was made with. */
const toolChoiceOf = (callIndex: number): unknown =>
  (streamMock.mock.calls[callIndex]?.[3] as { toolChoice?: unknown } | undefined)?.toolChoice;

const MESSAGE = "Why does invoices.py undercharge by a cent? def total(subtotal, tax): return int(subtotal + tax)";
const DIRECTIVE_LINE = 'directed this request to the agent "code_analyst"';
const ANSWER = "Both files truncate with int(); round instead. MODEL-ANSWER";

describe("a turn the user directed to one agent", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    streamMock.mockReset();
    completeMock.mockClear();
    delegated.length = 0;
    executed.length = 0;
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
  });

  it("forces the delegation to that agent, then answers freely from its result", async () => {
    const { AgentSession, runTurn } = await loadRuntime();
    let call = 0;
    streamMock.mockImplementation(() => {
      call += 1;
      return call === 1 ? delegateStream() : answerStream("Both files truncate with int(); round instead.");
    });

    const session = new AgentSession({ channel: "test", workspacePath: mkdtempSync(join(tmpdir(), "sai-directive-ws-")), systemPrompt: "You are a test agent." });
    await runTurn({ session, userMessage: MESSAGE, allowedAgents: ["code_analyst"], directiveAgent: "code_analyst" });

    expect(toolChoiceOf(0)).toBe("required");
    expect(promptOf(0)).toContain(DIRECTIVE_LINE);
    expect(delegated).toHaveLength(1);
    // Delegated: the answer is the model's own again.
    expect(toolChoiceOf(1)).toBeUndefined();
    expect(promptOf(1)).not.toContain(DIRECTIVE_LINE);
  });

  it("dispatches the delegation itself when the model answers in prose anyway", async () => {
    // Live, the local model wrote 13,000 characters of prose under `tool_choice: required`, and the
    // turn shipped them (E2E, 2026-10-07).
    const { AgentSession, runTurn } = await loadRuntime();
    let call = 0;
    streamMock.mockImplementation(() => {
      call += 1;
      return call === 1
        ? answerStream("int() truncates; use round(). I answered this myself instead of delegating.")
        : answerStream("Both files truncate with int(); round instead.");
    });

    const session = new AgentSession({ channel: "test", workspacePath: mkdtempSync(join(tmpdir(), "sai-directive-ws-")), systemPrompt: "You are a test agent." });
    const result = await runTurn({ session, userMessage: MESSAGE, allowedAgents: ["code_analyst"], directiveAgent: "code_analyst" });

    expect(delegated).toHaveLength(1);
    expect(delegated[0]).toMatchObject({ agentName: "code_analyst", task: MESSAGE });
    expect(result.response).not.toContain("I answered this myself");
  });

  it("forces nothing when the agents are only narrowed (a scene's grant)", async () => {
    const { AgentSession, runTurn } = await loadRuntime();
    streamMock.mockImplementation(() => answerStream("int() truncates; use round()."));

    const session = new AgentSession({ channel: "test", workspacePath: mkdtempSync(join(tmpdir(), "sai-directive-ws-")), systemPrompt: "You are a test agent." });
    await runTurn({ session, userMessage: MESSAGE, allowedAgents: ["code_analyst"] });

    expect(toolChoiceOf(0)).toBeUndefined();
    expect(promptOf(0)).not.toContain(DIRECTIVE_LINE);
  });

  // The directive used to be released by the delegation tally, which is kept on the REQUEST: a call
  // that never reached the named agent released it, and a call that did reach it without counting
  // (the agent's name called as a tool) left it pending (review of 0b5089e/a3773aa, 2026-10-08).
  it.each([
    ["the delegation's arguments could not be parsed", () => toolStream("delegate_to_agent", "<<not json>>")],
    ["a delegation to another agent was refused", () => toolStream("delegate_to_agent", { agentName: "coder", task: "Find the bug in invoices.py." })],
    ["an ephemeral agent was turned away before it ran", () => toolStream("create_ephemeral_agent", { agentName: "x", systemPrompt: "s", tools: ["nope"], task: "Find the bug." })],
  ])("stays directed when %s", async (_label, firstResponse) => {
    const { AgentSession, runTurn } = await loadRuntime();
    let call = 0;
    streamMock.mockImplementation(() => {
      call += 1;
      return call === 1 ? firstResponse() : answerStream("I answered this myself: int() truncates; use round().");
    });

    const session = new AgentSession({ channel: "test", workspacePath: mkdtempSync(join(tmpdir(), "sai-directive-ws-")), systemPrompt: "You are a test agent." });
    await runTurn({ session, userMessage: MESSAGE, allowedAgents: ["code_analyst"], directiveAgent: "code_analyst" });

    expect(toolChoiceOf(1)).toBe("required");
    expect(promptOf(1)).toContain(DIRECTIVE_LINE);
    expect(delegated).toHaveLength(1);
    expect(delegated[0]).toMatchObject({ agentName: "code_analyst", task: MESSAGE });
  });

  it("is released once the named agent ran, even when the model called it by name as a tool", async () => {
    const { AgentSession, runTurn } = await loadRuntime({ subAgents: { code_analyst: CODE_ANALYST } });
    let call = 0;
    streamMock.mockImplementation(() => {
      call += 1;
      return call === 1 ? toolStream("code_analyst", { task: "Find the bug in invoices.py." }) : answerStream(ANSWER);
    });

    const session = new AgentSession({ channel: "test", workspacePath: mkdtempSync(join(tmpdir(), "sai-directive-ws-")), systemPrompt: "You are a test agent." });
    const result = await runTurn({ session, userMessage: MESSAGE, allowedAgents: ["code_analyst"], directiveAgent: "code_analyst" });

    expect(delegated).toHaveLength(1);
    expect(toolChoiceOf(1)).toBeUndefined();
    expect(promptOf(1)).not.toContain(DIRECTIVE_LINE);
    expect(result.response).toContain("MODEL-ANSWER");
  });

  it("is released once a fan-out reported a delegation that ran", async () => {
    // A tool that reports the calls it made (parallel_delegate, execute_plan) names no agent; on a
    // turn whose grant is the named agent alone, a delegation that ran is that agent's.
    const { AgentSession, runTurn } = await loadRuntime();
    let call = 0;
    streamMock.mockImplementation(() => {
      call += 1;
      return call === 1
        ? toolStream("parallel_delegate", { tasks: [{ agentName: "code_analyst", task: "Find the bug in invoices.py." }] })
        : answerStream(ANSWER);
    });

    const session = new AgentSession({ channel: "test", workspacePath: mkdtempSync(join(tmpdir(), "sai-directive-ws-")), systemPrompt: "You are a test agent." });
    const result = await runTurn({ session, userMessage: MESSAGE, allowedAgents: ["code_analyst"], directiveAgent: "code_analyst" });

    expect(executed).toEqual(["parallel_delegate"]);
    expect(toolChoiceOf(1)).toBeUndefined();
    expect(promptOf(1)).not.toContain(DIRECTIVE_LINE);
    expect(result.response).toContain("MODEL-ANSWER");
  });

  it("delegates to the named agent after a workflow ran, and answers from both", async () => {
    // run_workflow adds nothing to the delegation tally, so after a completed workflow the
    // directive stayed pending next to the [SYNTHESIS REQUIRED] note: the model's answer was
    // replaced by the delegation, the synthesis-required guard rejected that, and the turn shipped a
    // forced "RESEARCH INCOMPLETE" partial answer while code_analyst never ran.
    const { AgentSession, runTurn } = await loadRuntime();
    let call = 0;
    streamMock.mockImplementation(() => {
      call += 1;
      return call === 1 ? toolStream("run_workflow", { name: "code_review", workflowType: "scene" }) : answerStream(ANSWER);
    });

    const session = new AgentSession({ channel: "test", workspacePath: mkdtempSync(join(tmpdir(), "sai-directive-ws-")), systemPrompt: "You are a test agent." });
    const result = await runTurn({ session, userMessage: MESSAGE, allowedAgents: ["code_analyst"], directiveAgent: "code_analyst" });

    expect(executed).toContain("run_workflow");
    expect(delegated).toHaveLength(1);
    expect(delegated[0]).toMatchObject({ agentName: "code_analyst" });
    expect(result.performance?.finishReason).not.toBe("synthesis_required_tool_call_rejected");
    expect(result.response).toContain("MODEL-ANSWER");
  });

  it("runs the delegation to the named agent instead of the workflow a catalog search matched", async () => {
    // The workflow-run nudge dropped the directed delegation once and then rewrote it into the
    // matched workflow, so the turn ran a workflow nobody asked for before the named agent.
    const { AgentSession, runTurn } = await loadRuntime();
    let call = 0;
    streamMock.mockImplementation(() => {
      call += 1;
      if (call === 1) return toolStream("search_workflows", { query: "code bug review" });
      if (call === 2) return delegateStream();
      return answerStream(ANSWER);
    });

    const session = new AgentSession({ channel: "test", workspacePath: mkdtempSync(join(tmpdir(), "sai-directive-ws-")), systemPrompt: "You are a test agent." });
    const result = await runTurn({ session, userMessage: MESSAGE, allowedAgents: ["code_analyst"], directiveAgent: "code_analyst" });

    expect(executed).not.toContain("run_workflow");
    expect(delegated).toHaveLength(1);
    expect(result.response).toContain("MODEL-ANSWER");
  });
});
