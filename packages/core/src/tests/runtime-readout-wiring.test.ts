/**
 * The logit readout (decisions.readout) at the two decision points the turn itself asks: the
 * up-front source-sensitivity judge and the post-draft ungrounded-claim judge (agent/runtime.ts).
 * Neither function is exported, so a turn runs against a provider spy: with the readout `on` for a
 * point, its question goes out as ONE readout call (logprobs, one token) labelled as the judge's
 * own readout, and the judge's written verdict is never asked; with it off, nothing asks for
 * logprobs at all. No model is called.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

type Msg = { role: string; content: string };
type Call = { options: { logprobs?: boolean; maxTokens?: number } | undefined; attribution: Record<string, unknown>; system: string };

const streamMock = vi.hoisted(() => vi.fn());
const completeMock = vi.hoisted(() => vi.fn());

vi.mock("../providers/index.js", () => {
  const provider = {
    checkHealth: async () => ({ healthy: true }),
    verifyToolCallSupport: async () => true,
    complete: (...args: unknown[]) => completeMock(...args),
    stream: (...args: unknown[]) => streamMock(...args),
    embed: async () => [],
    isHealthy: () => true,
  };
  return {
    applyActiveModelPreset: (model: unknown) => model,
    getChatProvider: () => provider,
    getChatProviderWithOverride: () => provider,
    // Both judges run on the routing tier.
    getChatProviderForTier: () => provider,
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
vi.mock("../audit/logger.js", () => ({ logAudit: vi.fn(), subscribeToAudit: vi.fn() }));

import { AgentSession, resetSessionsForTests } from "../agent/session.js";
import { runTurn } from "../agent/runtime.js";
import { getConfig, resetConfigForTests } from "../config/loader.js";
import { SOURCE_SENSITIVE, UNGROUNDED_DRAFT } from "../decisions/points.js";
import { currentCallAttribution } from "../runtime/request-context.js";

/** A tool-free draft long enough for the post-draft judge, with nothing in it the structural counter flags. */
const DRAFT = ("A hash map keeps its entries in buckets chosen by a hash of the key, so a lookup reads one bucket "
  + "instead of the whole collection; when two keys share a bucket, the bucket holds both and the lookup compares them. ").repeat(4);

function spy(): Call[] {
  const calls: Call[] = [];
  completeMock.mockImplementation(async (messages: Msg[], _tools: unknown, _signal: unknown, options: Call["options"]) => {
    calls.push({ options, attribution: { ...currentCallAttribution().data }, system: messages[0]?.content ?? "" });
    // A readout answers "B" — "no" for both judges — with the letters holding nearly all the mass.
    const top = [{ token: "B", logprob: Math.log(0.9) }, { token: "A", logprob: Math.log(0.09) }, { token: "The", logprob: Math.log(0.01) }];
    return options?.logprobs
      ? { content: "B", tool_calls: [], usage: { promptTokens: 0, completionTokens: 1, totalTokens: 1 }, finishReason: "length", logprobs: [{ ...top[0]!, topLogprobs: top }] }
      : { content: "no", tool_calls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop" };
  });
  streamMock.mockImplementation(() => (async function* () {
    yield { type: "text_delta", content: DRAFT };
    yield { type: "done", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  })());
  return calls;
}

async function runJudgedTurn(readout: Record<string, "off" | "shadow" | "on">): Promise<Call[]> {
  const config = getConfig();
  config.agents.mainAssistant.toolMode = "orchestration_only";
  config.orchestration.upfrontSourceSensitiveClassifier = true;
  config.orchestration.semanticUngroundedFactualGuard = true;
  config.decisions.baseUrl = "";
  config.decisions.readout = { ...config.decisions.readout, defaultMode: "off", points: readout };
  const calls = spy();
  const session = new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "You are a test agent." });
  await runTurn({ session, userMessage: "How does a hash map find a key so quickly?" });
  return calls;
}

const judgedBy = (calls: Call[], agentName: string) => calls.filter((call) => call.attribution["agentName"] === agentName && call.attribution["callSite"] === "routing_tier");

afterEach(() => {
  resetConfigForTests();
  streamMock.mockReset();
  completeMock.mockReset();
  resetSessionsForTests();
});

describe("the turn's own decision points read by their logits", () => {
  it("off, as deployed: both judges write their verdicts, and nothing asks for logprobs", async () => {
    const calls = await runJudgedTurn({});
    expect(judgedBy(calls, "source_sensitivity_judge")).toHaveLength(1);
    expect(judgedBy(calls, "ungrounded_claim_judge")).toHaveLength(1);
    expect(calls.filter((call) => call.options?.logprobs)).toEqual([]);
  });

  it("on: the source judge's question is one readout on its own provider, and its written verdict is not asked", async () => {
    const calls = await runJudgedTurn({ source_sensitive: "on" });
    const readouts = judgedBy(calls, "source_sensitivity_judge_readout");
    expect(readouts).toHaveLength(1);
    expect(readouts[0]!.options).toMatchObject({ logprobs: true, maxTokens: 1 });
    expect(readouts[0]!.system).toContain(SOURCE_SENSITIVE.question);
    expect(judgedBy(calls, "source_sensitivity_judge")).toHaveLength(0);
  });

  it("on: the post-draft judge's question is one readout too, and its written verdict is not asked", async () => {
    const calls = await runJudgedTurn({ ungrounded_draft: "on" });
    const readouts = judgedBy(calls, "ungrounded_claim_judge_readout");
    expect(readouts).toHaveLength(1);
    expect(readouts[0]!.system).toContain(UNGROUNDED_DRAFT.question);
    expect(judgedBy(calls, "ungrounded_claim_judge")).toHaveLength(0);
  });
});
