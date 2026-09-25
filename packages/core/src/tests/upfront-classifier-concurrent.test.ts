import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * THE UP-FRONT SOURCE-SENSITIVITY CLASSIFIER STARTS AFTER THE FAST LANE, NOT BEFORE IT.
 *
 * The classifier is a routing-tier call that reads only the user message, so it is issued
 * speculatively — before the two conditions that can make its verdict unwanted (an
 * evidence-reuse follow-up, a document-grounded turn) are known — and consumed further down.
 * WHERE it is issued is the thing this file pins:
 *
 *  - Not before the receptionist. Both calls resolve to the same llama-swap selector
 *    (lmstudio/qwen), and on a fast-lane turn nobody ever reads the verdict: a trivial "hi"
 *    was paying GPU contention (2.1 s alone vs 4.06 s with four in flight, measured on the
 *    station) plus an aborted request for an answer that was thrown away.
 *  - After the fast-lane return and before the document-RAG search, so on a turn that does
 *    escalate the request overlaps the engram search — retrieval work on another host, not GPU.
 *
 * The assertions are on the provider boundary: which routing call was issued when, and the
 * state of the AbortSignal the classifier's request received.
 */

/** Which routing call is this? The judge's system prompt names itself; the receptionist's carries the sentinel. */
const routingCalls = vi.hoisted(() => ({
  classifier: [] as Array<{ signal: AbortSignal | undefined }>,
  /** How many classifier requests were already in flight when the receptionist's was issued. */
  classifierCallsWhenReceptionistIssued: -1,
  receptionistReply: null as null | { resolve: (text: string) => void },
  classifierVerdict: "VERDICT: no",
}));
const streamMock = vi.hoisted(() => vi.fn());
const routingCompleteMock = vi.hoisted(() => vi.fn(async (messages: Array<{ content: unknown }>, _tools: unknown[], signal?: AbortSignal) => {
  const system = String(messages[0]?.content ?? "");
  const reply = (content: string) => ({ content, tool_calls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop" });
  if (system.includes("You are a routing classifier")) {
    routingCalls.classifier.push({ signal });
    return reply(routingCalls.classifierVerdict);
  }
  if (system.includes("<ESCALATE>")) {
    routingCalls.classifierCallsWhenReceptionistIssued = routingCalls.classifier.length;
    // Deferred: the test decides WHEN the front desk answers, so it can look at what was
    // issued while the receptionist was still pending.
    return new Promise<ReturnType<typeof reply>>((resolve) => {
      routingCalls.receptionistReply = { resolve: (text) => resolve(reply(text)) };
    });
  }
  throw new Error("unexpected routing-tier call: " + system.slice(0, 80));
}));
const logAuditMock = vi.hoisted(() => vi.fn());
/**
 * Switchable document-RAG outcome: a context block marks the turn as document-grounded.
 * `classifierCallsWhenRagIssued` is how the overlap is observed — how many classifier requests
 * were already on the wire when the engram search started.
 */
const ragState = vi.hoisted(() => ({ contextBlock: null as string | null, classifierCallsWhenRagIssued: -1 }));

vi.mock("../providers/index.js", () => {
  const provider = {
    checkHealth: async () => ({ healthy: true }),
    verifyToolCallSupport: async () => true,
    complete: async () => ({ content: "synthesized", tool_calls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop" }),
    stream: (...args: unknown[]) => streamMock(...(args as [])),
    embed: async () => [],
    isHealthy: () => true,
  };
  const routingProvider = { ...provider, complete: (...args: unknown[]) => routingCompleteMock(...(args as [never, never, never])) };
  return {
    applyActiveModelPreset: (model: unknown) => model,
    createChatProvider: () => provider,
    tierModelDefaults: () => ({ enableThinking: false, reasoningEffort: "none" }),
    getChatProvider: () => provider,
    getChatProviderWithOverride: () => provider,
    getChatProviderForTier: (tier: string) => (tier === "routing" ? routingProvider : null),
  };
});
vi.mock("../retrieval/document-rag.js", () => ({
  augmentTurnWithDocuments: async () => {
    ragState.classifierCallsWhenRagIssued = routingCalls.classifier.length;
    return {
      ingested: 0,
      failed: 0,
      contextBlock: ragState.contextBlock,
      retrievalUnavailable: false,
    };
  },
}));
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
vi.mock("../audit/logger.js", () => ({ logAudit: (...args: unknown[]) => logAuditMock(...args) }));

async function loadRuntime(config: { receptionistEnabled: boolean; decisions?: Record<string, unknown> }) {
  const dir = mkdtempSync(join(tmpdir(), "sai-upfront-concurrent-"));
  writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
    agents: { mainAssistant: { toolMode: "orchestration_only" } },
    orchestration: { upfrontSourceSensitiveClassifier: true },
    receptionist: { enabled: config.receptionistEnabled },
    ...(config.decisions ? { decisions: { ledger: { path: join(dir, "ledger.jsonl") }, ...config.decisions } } : {}),
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
  vi.resetModules();
  const [{ AgentSession }, { runTurn }] = await Promise.all([
    import("../agent/session.js"),
    import("../agent/runtime.js"),
  ]);
  return { AgentSession, runTurn };
}

/** Wait until the receptionist micro-call has been issued (its deferred reply exists). */
async function receptionistIssued(): Promise<{ resolve: (text: string) => void }> {
  for (let i = 0; i < 200 && !routingCalls.receptionistReply; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!routingCalls.receptionistReply) throw new Error("receptionist micro-call was never issued");
  return routingCalls.receptionistReply;
}

const upfrontAuditTypes = () => logAuditMock.mock.calls
  .map((args) => (args[1] as { type?: string } | undefined)?.type ?? "")
  .filter((type) => type.startsWith("upfront_source_sensitive"));

describe("up-front source-sensitivity classifier — issued after the fast lane, overlapping document RAG", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    streamMock.mockReset();
    routingCompleteMock.mockClear();
    logAuditMock.mockClear();
    routingCalls.classifier.length = 0;
    routingCalls.classifierCallsWhenReceptionistIssued = -1;
    routingCalls.receptionistReply = null;
    routingCalls.classifierVerdict = "VERDICT: no";
    ragState.contextBlock = null;
    ragState.classifierCallsWhenRagIssued = -1;
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
  });

  it("issues NO classifier request at all on a turn the front desk answers", async () => {
    const { AgentSession, runTurn } = await loadRuntime({ receptionistEnabled: true });
    const session = new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "You are a test agent." });

    // "hi": no dynamic guidance, short + conversational — fast-lane eligible.
    const turn = runTurn({ session, userMessage: "hi" });
    const receptionist = await receptionistIssued();

    // While the receptionist is still deciding, the classifier has not been issued — the
    // second call on the shared selector is what the contention was, and it is simply absent.
    expect(routingCalls.classifierCallsWhenReceptionistIssued, "a classifier request was already in flight when the receptionist's went out").toBe(0);
    expect(routingCalls.classifier, "classifier request issued before the fast lane resolved").toHaveLength(0);

    receptionist.resolve("Hallo! Wie kann ich helfen?");
    const out = await turn;
    expect(out.performance?.finishReason).toBe("receptionist_fast_lane");

    // The front desk answered and the turn returned without ever asking the judge anything —
    // so there is no request to abort, no aborted-completion error row, and no verdict.
    expect(routingCalls.classifier, "the fast lane paid for a classifier verdict nobody read").toHaveLength(0);
    expect(streamMock).not.toHaveBeenCalled();
    expect(upfrontAuditTypes()).toEqual([]);
  });

  it("issues it once the receptionist escalates, and consumes that verdict", async () => {
    const { AgentSession, runTurn } = await loadRuntime({ receptionistEnabled: true });
    const session = new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "You are a test agent." });
    let classifierAbortedWhenOrchestratorStarted: boolean | undefined;
    streamMock.mockImplementation(() => {
      classifierAbortedWhenOrchestratorStarted = routingCalls.classifier[0]?.signal?.aborted;
      return (async function* () {
        yield { type: "text_delta", content: "done" };
        yield { type: "done", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      })();
    });

    const turn = runTurn({ session, userMessage: "hi" });
    const receptionist = await receptionistIssued();
    expect(routingCalls.classifierCallsWhenReceptionistIssued).toBe(0);
    receptionist.resolve("<ESCALATE>");
    await turn;

    // Exactly one request, issued after the escalation and awaited (not re-requested), and
    // never cancelled — and it was already on the wire when the engram search started, which
    // is the overlap the placement buys.
    expect(routingCalls.classifier).toHaveLength(1);
    expect(ragState.classifierCallsWhenRagIssued, "the classifier request did not overlap the document-RAG search").toBe(1);
    expect(streamMock).toHaveBeenCalled();
    expect(classifierAbortedWhenOrchestratorStarted).toBe(false);
    expect(upfrontAuditTypes()).toEqual(["upfront_source_sensitive_clear"]);
  });

  it("says in the audit whether the judge answered: an empty reply is a fail-safe clear, not a judged one", async () => {
    // "clear 6 of 6" could not rule out six empty replies (review of the thinking-off verdicts, D3a).
    const upfrontRows = () => logAuditMock.mock.calls
      .map((args) => args[1] as { type?: string; answered?: boolean } | undefined)
      .filter((row) => row?.type?.startsWith("upfront_source_sensitive"));
    streamMock.mockImplementation(() => (async function* () {
      yield { type: "text_delta", content: "done" };
      yield { type: "done", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    })());
    const saved = routingCalls.classifierVerdict;
    try {
      for (const [verdict, answered] of [["VERDICT: no", true], ["", false]] as const) {
        logAuditMock.mockClear();
        routingCalls.classifierVerdict = verdict;
        const { AgentSession, runTurn } = await loadRuntime({ receptionistEnabled: false });
        const session = new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "You are a test agent." });
        await runTurn({ session, userMessage: "what changed in the deposit rules this year?" });
        expect(upfrontRows(), JSON.stringify(verdict)).toEqual([{ type: "upfront_source_sensitive_clear", answered }]);
      }
    } finally {
      routingCalls.classifierVerdict = saved;
    }
  });

  it("aborts the speculative request and logs no verdict when the turn turns out to be document-grounded", async () => {
    ragState.contextBlock = "the attached file says so";
    const { AgentSession, runTurn } = await loadRuntime({ receptionistEnabled: false });
    const session = new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "You are a test agent." });
    streamMock.mockImplementation(() => (async function* () {
      yield { type: "text_delta", content: "done" };
      yield { type: "done", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    })());

    await runTurn({ session, userMessage: "how does the deposit scheme work?" });

    // Issued speculatively (the RAG outcome is not known when the request goes out) and
    // overlapping the search itself ...
    expect(routingCalls.classifier).toHaveLength(1);
    expect(ragState.classifierCallsWhenRagIssued).toBe(1);
    // ... then cancelled and ignored once the document grounding made the verdict irrelevant:
    // the audit sees neither a verdict row nor a no-routing-tier row, exactly as before.
    expect(routingCalls.classifier[0]!.signal?.aborted).toBe(true);
    expect(upfrontAuditTypes()).toEqual([]);
  });

  // The Laya decision layer: a verdict Laya may give replaces the routing-tier judge's, and the
  // judge's request — on the wire already — is cancelled rather than waited for.
  it("takes Laya's verdict when its mode allows, and cancels the judge's request", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      answers: { source_sensitive: { choice: "yes", probabilities: { yes: 0.96, no: 0.04 } } },
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    try {
      const { AgentSession, runTurn } = await loadRuntime({
        receptionistEnabled: false,
        decisions: { baseUrl: "http://laya:8080", points: { source_sensitive: { mode: "laya", threshold: 0.9 } } },
      });
      const session = new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "You are a test agent." });
      streamMock.mockImplementation(() => (async function* () {
        yield { type: "text_delta", content: "done" };
        yield { type: "done", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      })());
      // The routing tier would say "no" (the harness default): only Laya's "yes" can produce "detected".
      await runTurn({ session, userMessage: "Wie funktioniert das Pfandsystem in Dänemark und wer betreibt es?" });

      const rows = logAuditMock.mock.calls
        .map((args) => args[1] as { type?: string; decidedBy?: string } | undefined)
        .filter((data) => data?.type?.startsWith("upfront_source_sensitive"));
      expect(rows).toEqual([{ type: "upfront_source_sensitive_detected", answered: true, decidedBy: "laya" }]);
      expect(routingCalls.classifier).toHaveLength(1);
      expect(routingCalls.classifier[0]!.signal?.aborted, "the replaced judge's request kept running").toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
