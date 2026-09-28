/**
 * The intent readout's post-turn shadow, through a whole runTurn — it must observe, and change
 * nothing: the same turn with the flag off and in shadow makes the same calls and gives the same
 * answer; the readout is asked only once runTurn has resolved; a nested turn is not shadowed on its
 * own; and the row the turn gets holds what the turn did and none of the user's words.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CompletionCallOptions, LLMResponse, LLMTokenLogprob } from "../providers/lmstudio.js";

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
    getChatProviderForTier: () => provider,
    createChatProvider: () => provider,
    tierModelDefaults: () => ({ enableThinking: false, reasoningEffort: "none" }),
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

// vi.doMock, not a hoisted mock: loadRuntime() resets the module registry per test (see
// runtime-facet-triage-shadow.test.ts). The tap needs subscribeToAudit, so the mock broadcasts.
const auditEvents: Array<[string, Record<string, unknown>, { sessionId?: string } | undefined]> = [];
const subscribers = new Set<(event: { type: string; sessionId?: string; data: Record<string, unknown> }) => void>();
const tempConfigDirs: string[] = [];

/** The discovery prefetch's capsule, answered after `delayMs` (the prompt waits 2.5 s for it). */
interface CapsuleStub {
  agents: string[];
  delayMs?: number;
}

async function loadRuntime(intentReadout: "off" | "shadow", opts: { capsule?: CapsuleStub; receptionist?: boolean } = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-intent-shadow-"));
  tempConfigDirs.push(tempDir);
  const configPath = join(tempDir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({
    ...(opts.receptionist ? { receptionist: { enabled: true } } : {}),
    agents: { mainAssistant: { toolMode: "orchestration_only" } },
    orchestration: {
      intentReadout,
      // The judge is one of the outcomes the row records.
      upfrontSourceSensitiveClassifier: true,
      planFirst: false,
      discoveryPrefetch: Boolean(opts.capsule),
      qaDeliveryLoop: false,
      riskGatedQA: false,
      finalResponseQaGate: false,
    },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configPath;
  vi.resetModules();
  auditEvents.length = 0;
  subscribers.clear();
  vi.doMock("../audit/logger.js", () => ({
    logAudit: (type: string, data: Record<string, unknown>, opts?: { sessionId?: string }) => {
      auditEvents.push([type, data, opts]);
      for (const subscriber of subscribers) subscriber({ type, sessionId: opts?.sessionId, data });
    },
    subscribeToAudit: (fn: (event: { type: string; sessionId?: string; data: Record<string, unknown> }) => void) => {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  }));
  const capsule = opts.capsule;
  if (capsule) {
    vi.doMock("../agent/discovery-prefetch.js", () => ({
      formatDiscoveryCapsule: () => "",
      prefetchCapabilityCandidates: async (_query: string, prefetchOpts?: { onAgents?: (names: readonly string[]) => void }) => {
        if (capsule.delayMs) await new Promise((resolve) => setTimeout(resolve, capsule.delayMs));
        prefetchOpts?.onAgents?.(capsule.agents);
        return `[CAPABILITY CANDIDATES — discovered up-front for this turn]\n${capsule.agents.map((name) => `- ${name}`).join("\n")}`;
      },
    }));
  } else {
    vi.doUnmock("../agent/discovery-prefetch.js");
  }
  const [{ AgentSession, resetSessionsForTests }, { runTurn }, shadow, requestContext, { INTENT_FACETS }] = await Promise.all([
    import("../agent/session.js"),
    import("../agent/runtime.js"),
    import("../agent/intent-shadow.js"),
    import("../runtime/request-context.js"),
    import("../decisions/intent-readout.js"),
  ]);
  resetSessionsForTests();
  return { AgentSession, runTurn, shadow, requestContext, INTENT_FACETS };
}

function tok(token: string, top: Array<[string, number]> = [[token, -0.01], ["\n", -6]]): LLMTokenLogprob {
  return { token, logprob: top.find(([t]) => t === token)?.[1] ?? -0.01, topLogprobs: top.map(([t, logprob]) => ({ token: t, logprob })) };
}

/** The readout's reply: every facet on letter A (yes on the yes/no facets), then the restatement. */
function intentReply(facetNames: readonly string[], query: string): LLMResponse {
  const tokens: LLMTokenLogprob[] = [];
  for (const name of facetNames) {
    if (tokens.length > 0) tokens.push(tok("\n"));
    tokens.push(tok(name), tok(":"), tok(" A", [[" A", -0.03], [" B", -3.8], ["\n", -7]]));
  }
  tokens.push(tok("\n"), tok("query_en"), tok(":"), tok(` ${query}`));
  return {
    content: tokens.map((entry) => entry.token).join(""),
    tool_calls: [],
    usage: { promptTokens: 0, completionTokens: tokens.length, totalTokens: tokens.length },
    finishReason: "stop",
    logprobs: tokens,
  } as unknown as LLMResponse;
}

function textStream(text: string) {
  return (async function* () {
    yield { type: "text_delta", content: text };
    yield { type: "done", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  })();
}

/** Every complete() call that carried the readout's grammar. */
function readoutCalls(): unknown[][] {
  return completeMock.mock.calls.filter((call) => Boolean((call[3] as CompletionCallOptions | undefined)?.grammar));
}

function shadowRows(): Array<Record<string, unknown>> {
  return auditEvents.filter(([type]) => type === "intent_readout_shadow").map(([, data]) => data);
}

/** The pre-route question: one token, the letter's top list (askReadout). */
function letterReply(letter: string): LLMResponse {
  return {
    content: letter,
    tool_calls: [],
    usage: { promptTokens: 0, completionTokens: 1, totalTokens: 1 },
    finishReason: "stop",
    logprobs: [tok(letter, [[letter, -0.02], [letter === "A" ? "B" : "A", -4.5], ["C", -6]])],
  } as unknown as LLMResponse;
}

function wireProvider(facetNames: readonly string[], query = "Explain the current base rate."): void {
  completeMock.mockImplementation(async (_messages: unknown, _tools: unknown, _signal: unknown, options?: CompletionCallOptions) => (
    options?.grammar
      ? intentReply(facetNames, query)
      : options?.logprobs && options.maxTokens === 1
        ? letterReply("B")
        : { content: "VERDICT: yes", tool_calls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop" }
  ));
  streamMock.mockImplementation(() => textStream("Here is the answer."));
}

/** Every one-token letter call: the pre-route question (decisions.readout is off here, so nothing else asks one). */
function preRouteCalls(): unknown[][] {
  return completeMock.mock.calls.filter((call) => {
    const options = call[3] as CompletionCallOptions | undefined;
    return !options?.grammar && options?.logprobs === true && options.maxTokens === 1;
  });
}

const QUESTION = "what does the current base rate look like";

afterEach(() => {
  streamMock.mockReset();
  completeMock.mockReset();
  delete process.env["SAI_CONFIG_PATH"];
  for (const dir of tempConfigDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("intentReadout through runTurn", () => {
  it("changes nothing the turn does: the same calls and the same answer, flag off or in shadow", async () => {
    const results: Array<{ response: string; streams: number; completes: number; shadowCallsAtResolve: number }> = [];
    for (const mode of ["off", "shadow"] as const) {
      const { AgentSession, runTurn, shadow, INTENT_FACETS } = await loadRuntime(mode);
      wireProvider(INTENT_FACETS.map((facet) => facet.name));
      const out = await runTurn({
        session: new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "You are a test agent." }),
        userMessage: QUESTION,
      });
      // Resolved: the reply is out, and the shadow has not been asked yet.
      const shadowCallsAtResolve = readoutCalls().length;
      const streams = streamMock.mock.calls.length;
      const completes = completeMock.mock.calls.length - shadowCallsAtResolve;
      await shadow.settleIntentShadowForTests();
      results.push({ response: out.response, streams, completes, shadowCallsAtResolve });
      if (mode === "off") {
        expect(readoutCalls()).toHaveLength(0);
        expect(shadowRows()).toHaveLength(0);
      } else {
        expect(readoutCalls()).toHaveLength(1);
        expect(shadowRows()).toHaveLength(1);
      }
      streamMock.mockReset();
      completeMock.mockReset();
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[1]!.shadowCallsAtResolve).toBe(0);
  });

  it("logs the readout beside the judge's verdict and the turn's own facts, attributed to the turn", async () => {
    const { AgentSession, runTurn, shadow, INTENT_FACETS } = await loadRuntime("shadow");
    wireProvider(INTENT_FACETS.map((facet) => facet.name));
    const session = new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "You are a test agent." });
    await runTurn({ session, userMessage: QUESTION });
    await shadow.settleIntentShadowForTests();
    const row = shadowRows()[0] as { status: string; actual: Record<string, unknown>; readout: { facets: Record<string, { choice: string }> } };
    expect(row.status).toBe("ok");
    expect(row.readout.facets["source_sensitive"]!.choice).toBe("yes");
    expect(row.actual).toMatchObject({
      fastLane: "not_offered",
      judge: { status: "answered", verdict: true },
      subAgentRuns: 0,
      firstAgent: null,
      workflowRuns: 0,
    });
    expect(typeof row.actual["wallMs"]).toBe("number");
    const opts = auditEvents.find(([type]) => type === "intent_readout_shadow")![2];
    expect(opts?.sessionId).toBe(session.id);
  });

  it("shadows a turn the front desk answered, and reads that off the turn's own row", async () => {
    // The one direct outcome decision=answer_direct is checked against. The front desk's row is
    // written inside the turn's request context, so the tap's own-turn filter (inTurn) keeps it.
    const { AgentSession, runTurn, shadow, INTENT_FACETS } = await loadRuntime("shadow", { receptionist: true });
    wireProvider(INTENT_FACETS.map((facet) => facet.name));
    const out = await runTurn({ session: new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "t" }), userMessage: "hi there" });
    await shadow.settleIntentShadowForTests();
    // The orchestrator never ran: the reply is the front desk's.
    expect(streamMock).not.toHaveBeenCalled();
    expect(out.response).toBe("VERDICT: yes");
    const rows = shadowRows() as Array<{ status: string; actual: Record<string, unknown> }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("ok");
    expect(rows[0]!.actual).toMatchObject({ fastLane: "answered", fastLaneReason: null, subAgentRuns: 0, moduleChars: null });
  });

  it("is aborted by the next turn's start", async () => {
    const { AgentSession, runTurn, shadow, INTENT_FACETS } = await loadRuntime("shadow");
    wireProvider(INTENT_FACETS.map((facet) => facet.name));
    let aborted = false;
    completeMock.mockImplementation((_messages: unknown, _tools: unknown, signal: AbortSignal | undefined, options?: CompletionCallOptions) => {
      if (!options?.grammar) return Promise.resolve({ content: "VERDICT: no", tool_calls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop" });
      // The first readout hangs until the next turn aborts it; later ones answer.
      if (readoutCalls().length > 1) return Promise.resolve(intentReply(INTENT_FACETS.map((facet) => facet.name), "Later."));
      return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true }));
    });
    await runTurn({ session: new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "t" }), userMessage: QUESTION });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(readoutCalls()).toHaveLength(1);
    expect(aborted).toBe(false);
    await runTurn({ session: new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "t" }), userMessage: "and the one before that" });
    expect(aborted).toBe(true);
    await shadow.settleIntentShadowForTests();
    expect(shadowRows().map((row) => row["status"])).toEqual(["aborted", "ok"]);
  });

  it("reads the new request against the PREVIOUS exchange, as the facet triage does", async () => {
    const { AgentSession, runTurn, shadow, INTENT_FACETS } = await loadRuntime("shadow");
    wireProvider(INTENT_FACETS.map((facet) => facet.name));
    const session = new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "t" });
    await runTurn({ session, userMessage: "first question about rates" });
    await shadow.settleIntentShadowForTests();
    await runTurn({ session, userMessage: "and the one before that" });
    await shadow.settleIntentShadowForTests();
    const cases = readoutCalls().map((call) => String((call[0] as Array<{ content: unknown }>).at(-1)!.content));
    expect(cases).toHaveLength(2);
    expect(cases[0]).toBe("Request:\nfirst question about rates");
    // The digest is the first exchange; read after the turn it would have been the second one's own.
    expect(cases[1]).toBe(
      "Previous turn (for reference only — label the NEW request):\nUser asked: first question about rates\n"
      + "Assistant answered: Here is the answer.\n\nNew request:\nand the one before that",
    );
    expect(shadowRows().map((row) => row["priorDigest"])).toEqual([false, true]);
  });

  it("does not shadow a turn run inside another (a workflow step)", async () => {
    const { AgentSession, runTurn, shadow, requestContext, INTENT_FACETS } = await loadRuntime("shadow");
    wireProvider(INTENT_FACETS.map((facet) => facet.name));
    await requestContext.runWithRequestContext({ sessionId: "outer", agentName: "main", callSite: "main_turn" }, () => runTurn({
      session: new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "t" }),
      userMessage: QUESTION,
    }));
    await shadow.settleIntentShadowForTests();
    expect(readoutCalls()).toHaveLength(0);
    expect(shadowRows()).toHaveLength(0);
  });

  it("asks the pre-route question over the capsule the first iteration got", async () => {
    const { AgentSession, runTurn, shadow, INTENT_FACETS } = await loadRuntime("shadow", { capsule: { agents: ["researcher", "web_coder"] } });
    wireProvider(INTENT_FACETS.map((facet) => facet.name));
    await runTurn({ session: new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "t" }), userMessage: QUESTION });
    expect(preRouteCalls()).toHaveLength(0);
    await shadow.settleIntentShadowForTests();
    expect(preRouteCalls()).toHaveLength(1);
    const row = shadowRows()[0] as { actual: { capsule: unknown }; preRoute: Record<string, unknown> };
    expect(row.actual.capsule).toEqual({ status: "ok", agents: ["researcher", "web_coder"], trimmed: false });
    // Letter B of [researcher, web_coder, none].
    expect(row.preRoute).toMatchObject({ status: "ok", choice: "web_coder", none: false });
  });

  it("does not count a capsule that came after the prompt stopped waiting for it", async () => {
    const { AgentSession, runTurn, shadow, INTENT_FACETS } = await loadRuntime("shadow", { capsule: { agents: ["researcher"], delayMs: 2_700 } });
    wireProvider(INTENT_FACETS.map((facet) => facet.name));
    await runTurn({ session: new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "t" }), userMessage: QUESTION });
    await new Promise((resolve) => setTimeout(resolve, 400));
    await shadow.settleIntentShadowForTests();
    expect(preRouteCalls()).toHaveLength(0);
    const row = shadowRows()[0] as { actual: { capsule: unknown }; preRoute: Record<string, unknown> };
    expect(row.actual.capsule).toEqual({ status: "timeout", agents: [], trimmed: false });
    expect(row.preRoute["status"]).toBe("no_candidates");
  }, 20_000);

  it("writes none of the user's words, nor the restatement, into the row", async () => {
    const { AgentSession, runTurn, shadow, INTENT_FACETS } = await loadRuntime("shadow");
    const canaryMessage = "Wie teuer ist das Zwitscherbaumticket beim Kanarienverkehrsverbund heute";
    wireProvider(INTENT_FACETS.map((facet) => facet.name), "How expensive is the Pfefferminzkobold ticket today");
    await runTurn({ session: new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "t" }), userMessage: canaryMessage });
    await shadow.settleIntentShadowForTests();
    const rows = shadowRows();
    expect(rows).toHaveLength(1);
    const text = JSON.stringify(rows);
    for (const word of ["Zwitscherbaumticket", "Kanarienverkehrsverbund", "Pfefferminzkobold", "teuer"]) expect(text).not.toContain(word);
    expect(rows[0]!["messageChars"]).toBe(canaryMessage.length);
  });
});
