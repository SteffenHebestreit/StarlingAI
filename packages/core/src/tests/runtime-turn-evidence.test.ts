import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../tools/registry.js";

/**
 * THE JUDGE'S VERDICT REACHES THE TURN'S TOOLS (ToolContext.turnEvidence).
 *
 * The up-front judge said "needs outside facts" on the E2E turns 2f31f387 / 9ddd881f / f4fdf38e,
 * but its verdict fed only the turn's own enforcement, so the research gate never saw it and a
 * German plan step ran on web_coder (plan-step-evidence-gate.test.ts covers the gate). This file
 * pins the wiring: the context the runtime hands a delegation carries the verdict on the
 * orchestrator's own turn, and nowhere else. Without it the gate's turn trigger is silently inert.
 */

const routing = vi.hoisted(() => ({ verdict: "VERDICT: yes" }));
const streamMock = vi.hoisted(() => vi.fn());

vi.mock("../providers/index.js", () => {
  const reply = (content: string) => ({ content, tool_calls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop" });
  const provider = {
    checkHealth: async () => ({ healthy: true }),
    verifyToolCallSupport: async () => true,
    complete: async () => reply("synthesized"),
    stream: (...args: unknown[]) => streamMock(...(args as [])),
    embed: async () => [],
    isHealthy: () => true,
  };
  // The judge names itself in its system prompt; any other routing-tier call gets an empty reply.
  const routingProvider = {
    ...provider,
    complete: async (messages: Array<{ content: unknown }>) =>
      reply(String(messages[0]?.content ?? "").includes("You are a routing classifier") ? routing.verdict : ""),
  };
  return {
    applyActiveModelPreset: (model: unknown) => model,
    createChatProvider: () => provider,
    tierModelDefaults: () => ({ enableThinking: false, reasoningEffort: "none" }),
    getChatProvider: () => provider,
    getChatProviderWithOverride: () => provider,
    getChatProviderForTier: (tier: string) => (tier === "routing" ? routingProvider : null),
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

/** The context each delegation was handed; the delegation itself is stubbed. */
const delegatedWith = vi.hoisted(() => [] as ToolContext[]);
vi.mock("../tools/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools/registry.js")>();
  return {
    ...actual,
    executeTool: vi.fn(async (name: string, args: Record<string, unknown>, ctx: ToolContext, meta?: never) => {
      if (name === "delegate_to_agent") {
        delegatedWith.push(ctx);
        return {
          success: true,
          output: "Delegated result from researcher — TASK COMPLETED.\nObserved evidence:\nFounded 1987 (impressum).",
          metadata: { agentName: "researcher", delegationSucceeded: true, delegationOutcome: "success", terminalState: "completed" },
        };
      }
      return actual.executeTool(name, args, ctx, meta);
    }),
  };
});

function delegateStream() {
  return (async function* () {
    yield { type: "tool_call_start", toolCallId: "call_delegate", toolName: "delegate_to_agent" };
    yield { type: "tool_call_delta", toolCallId: "call_delegate", argumentsDelta: JSON.stringify({ agentName: "researcher", task: "Die Website abrufen und das Gründungsjahr ermitteln." }) };
    yield { type: "done", finishReason: "tool_calls", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  })();
}

function answerStream(text: string) {
  return (async function* () {
    yield { type: "text_delta", content: text };
    yield { type: "done", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  })();
}

async function loadRuntime() {
  const dir = mkdtempSync(join(tmpdir(), "sai-turn-evidence-"));
  writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
    workspacePath: dir,
    agents: { mainAssistant: { toolMode: "orchestration_only" } },
    orchestration: { upfrontSourceSensitiveClassifier: true },
    receptionist: { enabled: false },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
  vi.resetModules();
  const { AgentSession } = await import("../agent/session.js");
  const { runTurn } = await import("../agent/runtime.js");
  return { AgentSession, runTurn };
}

const MESSAGE = "Wann wurde die Nordlicht Werkzeuge GmbH gegründet? Ihre Website ist http://www.nordlicht-werkzeuge.test/";

/** Runs one turn whose model delegates once and then answers; returns the context of that delegation. */
async function delegationContext(opts: { channel?: string; directiveAgent?: string; workflowStack?: string[] } = {}): Promise<ToolContext | undefined> {
  const { AgentSession, runTurn } = await loadRuntime();
  let call = 0;
  streamMock.mockImplementation(() => {
    call += 1;
    return call === 1 ? delegateStream() : answerStream("Die Nordlicht Werkzeuge GmbH wurde 1987 gegründet.");
  });
  const session = new AgentSession({
    channel: opts.channel ?? "test",
    workspacePath: mkdtempSync(join(tmpdir(), "sai-turn-evidence-ws-")),
    systemPrompt: "You are a test agent.",
  });
  await runTurn({
    session,
    userMessage: MESSAGE,
    ...(opts.directiveAgent ? { directiveAgent: opts.directiveAgent, allowedAgents: [opts.directiveAgent] } : {}),
    ...(opts.workflowStack ? { _workflowExecutionStack: opts.workflowStack } : {}),
  });
  return delegatedWith[0];
}

describe("the up-front judge's verdict on the turn's tool context", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    streamMock.mockReset();
    delegatedWith.length = 0;
    routing.verdict = "VERDICT: yes";
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
  });

  it("hands a yes to the delegations of the orchestrator's own turn", async () => {
    const ctx = await delegationContext();

    expect(ctx, "the model's delegation never reached the tool").toBeDefined();
    expect(ctx!.turnEvidence).toEqual({ required: true });
  });

  it("adds nothing when the judge said no", async () => {
    routing.verdict = "VERDICT: no";
    const ctx = await delegationContext();

    expect(ctx, "the model's delegation never reached the tool").toBeDefined();
    expect("turnEvidence" in ctx!).toBe(false);
  });

  it("adds nothing on a directed turn or a workflow's turn, even when the judge said yes", async () => {
    // Each runs the agents someone named — the user with --agent, a scene's author — so the
    // research gate's turn trigger has nothing to correct there.
    const directed = await delegationContext({ directiveAgent: "researcher" });
    delegatedWith.length = 0;
    const workflowChannel = await delegationContext({ channel: "workflow" });
    delegatedWith.length = 0;
    const workflowStep = await delegationContext({ workflowStack: ["scene:company_facts"] });

    for (const [label, ctx] of [["directed", directed], ["workflow channel", workflowChannel], ["workflow step", workflowStep]] as const) {
      expect(ctx, `${label}: the model's delegation never reached the tool`).toBeDefined();
      expect(ctx!.turnEvidence, label).toBeUndefined();
    }
  });
});
