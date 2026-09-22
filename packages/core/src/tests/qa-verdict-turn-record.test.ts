import { afterEach, describe, expect, it, vi } from "vitest";

const streamMock = vi.hoisted(() => vi.fn());
const completeMock = vi.hoisted(() => vi.fn(async (_messages: Array<{ role: string; content: string }>) => ({
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
    stream: (...args: unknown[]) => streamMock(...args),
    embed: async () => [],
    isHealthy: () => true,
  };
  return {
    applyActiveModelPreset: (model: unknown) => model,
    getChatProvider: () => provider,
    getChatProviderWithOverride: () => provider,
    getChatProviderForTier: () => null,
    createChatProvider: () => provider,
    tierModelDefaults: (tier: string) => (tier === "routing" ? { enableThinking: false, reasoningEffort: "none" } : {}),
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

import { formatQaTurnRecord } from "../agent/qa-turn-record.js";
import { AgentSession, resetSessionsForTests } from "../agent/session.js";
import { runTurn } from "../agent/runtime.js";
import { persistTurnPlan } from "../agent/turn-plan.js";
import { getConfig, resetConfigForTests } from "../config/loader.js";
import { registerTool, unregisterTool } from "../tools/registry.js";

// Session f4ebf47b, turn 4: the user asked for the Qwen model, record_plan's only criterion was
// about style, the file was rendered on the fast tier, and the answer said Qwen.
const USER_WORDS = "nimm das qwen model, nicht den fast-tier";
const CRITERION = "Bild zeigt realistischen Sonnenuntergang am Strand ohne Cartoon/Anime-Stil";
const ARTIFACT = {
  sourceAgent: "image_creator",
  sourceTool: "generate_image",
  outputPath: "generated/images/sunset_qwen.png",
  filename: "sunset_qwen.png",
  dataUrl: "data:image/png;base64,QUJD",
  model: "image",
  tier: "fast",
  elapsedMs: 9995,
};
const PROVENANCE_LINE = "- generated/images/sunset_qwen.png (generate_image by image_creator; tier fast, model image, 10.0 s)";
const ANSWER = "Hier ist dein Bild: ein realistischer Sonnenuntergang am Strand, generiert mit dem Qwen-Modell. "
  + "Die Datei liegt unter generated/images/sunset_qwen.png. Das Licht fällt flach über das Wasser, die Wolken "
  + "leuchten orange, und im Vordergrund liegt nasser Sand, in dem sich der Himmel spiegelt.";

const user = (content: string, metadata?: Record<string, unknown>) => ({ role: "user", content, ...(metadata ? { metadata } : {}) });
const tool = (metadata: Record<string, unknown>) => ({ role: "tool", content: "ok", metadata });

describe("formatQaTurnRecord", () => {
  it("lists the file with the tier and model its tool recorded, and the user's words, with a rule for each", () => {
    const block = formatQaTurnRecord(
      [user("mach ein bild"), tool({ agentName: "image_creator", artifacts: [ARTIFACT] })],
      { opening: USER_WORDS, midTurn: [] },
    );
    const lines = block.split("\n");
    expect(lines[0]).toBe("");
    expect(lines).toContain(PROVENANCE_LINE);
    expect(lines).toContain(USER_WORDS);
    expect(block).toContain("attributes a file to an engine, tier or model other than the one recorded above FAILS");
    expect(block).toContain("ignores a constraint the user stated in these words");
    expect(block).not.toContain("data:image");
  });

  it("reads a direct tool result, whose file fields sit at the top of its metadata", () => {
    const { sourceAgent: _agent, sourceTool: _tool, ...direct } = ARTIFACT;
    const block = formatQaTurnRecord([user("mach ein bild"), tool(direct)], undefined);
    expect(block).toContain("- generated/images/sunset_qwen.png (tier fast, model image, 10.0 s)");
    expect(block).not.toContain("The user's own words");
  });

  it("covers the whole turn and nothing before it: a mid-turn message does not cut it, a previous turn is left out", () => {
    const block = formatQaTurnRecord([
      user("erstes bild"),
      tool({ artifacts: [{ ...ARTIFACT, outputPath: "generated/images/old.png" }] }),
      user("mach es realer"),
      tool({ artifacts: [ARTIFACT] }),
      user(USER_WORDS, { midTurn: true }),
    ], { opening: "mach es realer", midTurn: [USER_WORDS] });
    expect(block).toContain("generated/images/sunset_qwen.png");
    expect(block).not.toContain("old.png");
    expect(block).toContain(`(added mid-turn) ${USER_WORDS}`);
  });

  it("states the attribution rule only when an engine, tier or model is on record", () => {
    const block = formatQaTurnRecord([user("schreib"), tool({ outputPath: "notes/plan.md", filename: "plan.md" })], undefined);
    expect(block).toContain("- notes/plan.md");
    expect(block).not.toContain("FAILS");
    const wordsOnly = formatQaTurnRecord([user("schreib")], { opening: "auf Englisch bitte", midTurn: [] });
    expect(wordsOnly).not.toContain("Files produced");
    expect(wordsOnly).not.toContain("attributes a file");
    expect(wordsOnly).toContain("ignores a constraint the user stated in these words");
  });

  it("is empty when the turn produced no file and no words of the user's are known", () => {
    // A scene or job template opens its turn with no user words: the opening is "".
    expect(formatQaTurnRecord([user("template"), tool({ agentName: "researcher" })], { opening: "", midTurn: [] })).toBe("");
    expect(formatQaTurnRecord([user("template")], undefined)).toBe("");
  });
});

describe("the QA delivery verdict at runtime", () => {
  afterEach(() => {
    resetConfigForTests();
    unregisterTool("delegate_to_agent");
    streamMock.mockReset();
    completeMock.mockClear();
    resetSessionsForTests();
  });

  const verdictPrompts = (): string[] => completeMock.mock.calls
    .map(([messages]) => messages)
    .filter((messages) => messages[0]?.content.startsWith("You are a concise QA reviewer"))
    .map((messages) => messages[1]!.content);

  async function runImageTurn(opts: { artifacts: Array<Record<string, unknown>>; userWords?: string }): Promise<string[]> {
    getConfig().orchestration.qaDeliveryLoop = true;
    // The final answer, not a relayed specialist output, is what this checks.
    getConfig().orchestration.relaySingleDeliverable = false;
    const session = new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "You are a test agent." });
    let llmCalls = 0;
    streamMock.mockImplementation(() => {
      llmCalls += 1;
      return llmCalls === 1
        ? toolCallStream("delegate_1", "delegate_to_agent", { agentName: "image_creator", task: "Render a realistic beach sunset." })
        : textStream(ANSWER);
    });
    completeMock.mockImplementation(async (messages) => ({
      content: messages[0]?.content.startsWith("You are a concise QA reviewer") ? "PASS" : "synthesized",
      tool_calls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: "stop",
    }));
    registerTool({
      name: "delegate_to_agent",
      description: "Delegate to a specialist.",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        // What record_plan stores: the turn clears the plan slot when it starts.
        await persistTurnPlan(session.id, {
          objective: "Realistic beach sunset",
          steps: [],
          acceptanceCriteria: [CRITERION],
          stopConditions: [],
          riskTier: "low",
          wide: false,
          createdAt: new Date().toISOString(),
        });
        return {
          success: true,
          output: "[image_creator]: Das Bild wurde mit dem Qwen-Modell generiert: generated/images/sunset_qwen.png",
          metadata: { agentName: "image_creator", delegationSucceeded: true, artifacts: opts.artifacts },
        };
      },
    });
    await runTurn({ session, userMessage: opts.userWords ?? "Render a realistic beach sunset.", ...(opts.userWords ? { userWords: opts.userWords } : {}) });
    return verdictPrompts();
  }

  it("shows the reviewer the recorded tier and model of the file and the user's own words", async () => {
    const prompts = await runImageTurn({ artifacts: [ARTIFACT], userWords: USER_WORDS });
    expect(prompts).toHaveLength(1);
    const [beforeAnswer] = prompts[0]!.split("\nANSWER:\n");
    expect(beforeAnswer).toContain(`1. ${CRITERION}`);
    expect(beforeAnswer).toContain(PROVENANCE_LINE);
    expect(beforeAnswer).toContain(USER_WORDS);
    expect(beforeAnswer).toContain("other than the one recorded above FAILS");
  });

  it("leaves the verdict prompt as it was when there is no file and no user's words", async () => {
    const prompts = await runImageTurn({ artifacts: [] });
    expect(prompts).toHaveLength(1);
    const [beforeAnswer, afterAnswer] = prompts[0]!.split("\nANSWER:\n");
    expect(beforeAnswer).toBe([
      "You are a strict QA reviewer. Judge ONLY whether the ANSWER below satisfies EVERY acceptance criterion for the user's task. Do not rewrite it.",
      "Acceptance criteria:",
      `1. ${CRITERION}`,
      "",
    ].join("\n"));
    expect(afterAnswer).toMatch(/\n\nReply on a SINGLE line\. If every criterion is fully met and the answer is internally consistent, reply exactly: PASS\nAlso FAIL when the answer reveals work OUTSIDE/);
  });
});

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
