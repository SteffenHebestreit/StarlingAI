import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalCallback, ToolContext } from "../tools/registry.js";

/**
 * `--auto` (RunTurnOptions.autoApprove) answers the approvals a turn's tools ask for, but not a step
 * the scene names in humanInLoopSteps: tools/registry.ts enforces those unconditionally. The turn
 * used to replace its approval callback with `async () => true`, and that answered the scene's
 * steps as well, so `/run <scene> --auto` ran them with nobody asked.
 *
 * Two stubbed tools the orchestrator has in every tool mode: list_capability_gaps needs no approval
 * by its tier, so it asks only as a scene step; schedule_remove asks by its tier
 * (requiresPerCallApproval) and is not a step, so --auto still answers it.
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

const STEP_TOOL = "list_capability_gaps";
const TIER_TOOL = "schedule_remove";

function toolCallStream(id: string, toolName: string, args: Record<string, unknown>) {
  return (async function* () {
    yield { type: "tool_call_start", toolCallId: id, toolName };
    yield { type: "tool_call_delta", toolCallId: id, argumentsDelta: JSON.stringify(args) };
    yield { type: "done", finishReason: "tool_calls", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  })();
}

function answerStream(text: string) {
  return (async function* () {
    yield { type: "text_delta", content: text };
    yield { type: "done", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  })();
}

/** Every message the given provider.stream call was sent, as one text. */
const promptOf = (callIndex: number): string =>
  ((streamMock.mock.calls[callIndex]?.[0] ?? []) as Array<{ content?: unknown }>)
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n");

const dirs: string[] = [];

/** The runtime on a fresh module graph, with both tools stubbed; `ran` lists the stubs that ran. */
async function loadRuntime(stepToolBody?: (ctx: ToolContext) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "sai-auto-hitl-"));
  dirs.push(dir);
  writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
    workspacePath: dir,
    agents: { mainAssistant: { toolMode: "orchestration_only" } },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
  vi.resetModules();
  const registry = await import("../tools/registry.js");
  const ran: string[] = [];
  for (const name of [STEP_TOOL, TIER_TOOL]) {
    registry.registerTool({
      name,
      description: `Test stub of ${name}.`,
      parameters: { type: "object", properties: {} },
      async execute(_args, ctx) {
        ran.push(name);
        if (name === STEP_TOOL && stepToolBody) await stepToolBody(ctx);
        return { success: true, output: `${name} ran` };
      },
    });
  }
  const { AgentSession } = await import("../agent/session.js");
  const { runTurn } = await import("../agent/runtime.js");
  const session = new AgentSession({ channel: "test", workspacePath: dir, systemPrompt: "You are a test agent." });
  return { registry, runTurn, session, ran };
}

/** The model calls the scene step, then the tier-gated tool, then answers. */
function scriptBothCalls(): void {
  let call = 0;
  streamMock.mockImplementation(() => {
    call += 1;
    if (call === 1) return toolCallStream("call_step", STEP_TOOL, {});
    if (call === 2) return toolCallStream("call_tier", TIER_TOOL, { id: "sched-1" });
    return answerStream("Done.");
  });
}

describe("--auto still asks a person for a humanInLoopSteps step", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    streamMock.mockReset();
    completeMock.mockClear();
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it("asks the caller's callback for the step and answers the tier-gated tool itself", async () => {
    const { runTurn, session, ran } = await loadRuntime();
    scriptBothCalls();
    const approvalCallback = vi.fn<ApprovalCallback>(async () => true);

    await runTurn({ session, userMessage: "Run the scene.", autoApprove: true, humanInLoopSteps: [STEP_TOOL], approvalCallback });

    expect(approvalCallback).toHaveBeenCalledTimes(1);
    expect(approvalCallback).toHaveBeenCalledWith(STEP_TOOL, {}, { humanInLoopStep: true });
    expect(ran).toEqual([STEP_TOOL, TIER_TOOL]);
  });

  it("does not run the step when the person denies it", async () => {
    const { runTurn, session, ran } = await loadRuntime();
    scriptBothCalls();
    const approvalCallback = vi.fn<ApprovalCallback>(async () => false);

    await runTurn({ session, userMessage: "Run the scene.", autoApprove: true, humanInLoopSteps: [STEP_TOOL], approvalCallback });

    expect(approvalCallback).toHaveBeenCalledTimes(1);
    expect(ran).toEqual([TIER_TOOL]);
    expect(promptOf(1)).toContain(`Tool '${STEP_TOOL}' execution denied by user`);
  });

  it("refuses the step when there is nobody to ask, and still answers the tier-gated tool", async () => {
    const { runTurn, session, ran } = await loadRuntime();
    scriptBothCalls();

    await runTurn({ session, userMessage: "Run the scene.", autoApprove: true, humanInLoopSteps: [STEP_TOOL] });

    expect(ran).toEqual([TIER_TOOL]);
    expect(promptOf(1)).toContain(`Tool '${STEP_TOOL}' requires human approval`);
    expect(promptOf(1)).toContain("no approval channel is available");
  });

  // A sub-agent, or a nested workflow's turn, inherits the turn's callback with the steps of the
  // scene it runs added to humanInLoopSteps. That step is not in the outer turn's list, and the
  // outer --auto callback must not answer it either.
  it("asks for a step that only a nested context names, through the outer --auto callback", async () => {
    const nested: Array<{ success: boolean; error?: string }> = [];
    const { registry, runTurn, session, ran } = await loadRuntime(async (ctx) => {
      if (ran.length > 1) return;
      nested.push(await registry.executeTool(TIER_TOOL, { id: "nested" }, { ...ctx, humanInLoopSteps: [TIER_TOOL] }));
    });
    let call = 0;
    streamMock.mockImplementation(() => {
      call += 1;
      return call === 1 ? toolCallStream("call_outer", STEP_TOOL, {}) : answerStream("Done.");
    });
    const approvalCallback = vi.fn<ApprovalCallback>(async () => false);

    // The outer turn names no step: --auto answers its own calls.
    await runTurn({ session, userMessage: "Run the workflow.", autoApprove: true, approvalCallback });

    expect(approvalCallback).toHaveBeenCalledTimes(1);
    expect(approvalCallback).toHaveBeenCalledWith(TIER_TOOL, { id: "nested" }, { humanInLoopStep: true });
    expect(nested[0]?.success).toBe(false);
    expect(nested[0]?.error).toContain("execution denied by user");
    expect(ran).toEqual([STEP_TOOL]);
  });

  it("leaves a turn without --auto to its callback, as before", async () => {
    const { runTurn, session, ran } = await loadRuntime();
    scriptBothCalls();
    const approvalCallback = vi.fn<ApprovalCallback>(async () => true);

    await runTurn({ session, userMessage: "Run the scene.", humanInLoopSteps: [STEP_TOOL], approvalCallback });

    expect(approvalCallback.mock.calls.map(([tool, , request]) => [tool, request])).toEqual([
      [STEP_TOOL, { humanInLoopStep: true }],
      [TIER_TOOL, { humanInLoopStep: false }],
    ]);
    expect(ran).toEqual([STEP_TOOL, TIER_TOOL]);
  });
});
