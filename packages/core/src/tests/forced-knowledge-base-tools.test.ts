import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A SOURCE-SENSITIVE TURN MAY GET ITS SOURCE FROM THE KNOWLEDGE BASE THE USER NAMED.
 *
 * E2E core-ix-kb-documentation-rag, 2026-10-08: "Suche in der Wissensdatenbank „core-ix-nw-doku“: …".
 * The up-front judge called the question source-sensitive, so the turn had to orchestrate before it
 * answered, and under orchestration.stableToolBlock "freeze" the forced iterations carried the
 * forced-orchestration allowlist at the call site. That allowlist held only delegation tools, so both
 * of the model's list_knowledge_bases calls were refused as must_orchestrate, the turn was cut off
 * after two fully blocked iterations, and the evidence-free synthesis told the user the knowledge base
 * was blocked. The knowledge-base reads are the retrieval such a turn is forced to go and do.
 */

const streamMock = vi.hoisted(() => vi.fn());
const completeMock = vi.hoisted(() => vi.fn(async () => ({
  content: "synthesized",
  tool_calls: [],
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  finishReason: "stop",
})));
/** The routing tier. Its "VERDICT: yes" is the up-front judge calling the question source-sensitive. */
const routingCompleteMock = vi.hoisted(() => vi.fn(async () => ({
  content: "VERDICT: yes",
  tool_calls: [],
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  finishReason: "stop",
})));
const auditMock = vi.hoisted(() => vi.fn());
/** The tool-output screens. Each lets everything through unless a test says otherwise. */
const checkToolOutputMock = vi.hoisted(() => vi.fn((_text: string): { allowed: boolean; reason?: string } => ({ allowed: true })));
const moderateToolResultTextMock = vi.hoisted(() => vi.fn(async (_text: string): Promise<Record<string, unknown> | null> => null));

vi.mock("../providers/index.js", () => {
  const provider = {
    checkHealth: async () => ({ healthy: true }),
    verifyToolCallSupport: async () => true,
    complete: (...args: unknown[]) => completeMock(...(args as [])),
    stream: (...args: unknown[]) => streamMock(...(args as [])),
    embed: async () => [],
    isHealthy: () => true,
  };
  const routingProvider = { ...provider, complete: (...args: unknown[]) => routingCompleteMock(...(args as [])) };
  return {
    applyActiveModelPreset: (model: unknown) => model,
    getChatProvider: () => provider,
    getChatProviderWithOverride: () => provider,
    getChatProviderForTier: (tier: string) => (tier === "routing" ? routingProvider : null),
    createChatProvider: () => provider,
    tierModelDefaults: () => ({}),
  };
});

vi.mock("../guardrails/rate-limiter.js", () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })) }));
vi.mock("../guardrails/input.js", () => ({
  checkInput: vi.fn(() => ({ allowed: true, detectedPatterns: [] })),
  checkToolOutput: (text: string) => checkToolOutputMock(text),
}));
vi.mock("../guardrails/moderation.js", () => ({
  moderateInputText: vi.fn(async () => null),
  moderateToolResultText: (text: string) => moderateToolResultTextMock(text),
}));
vi.mock("../guardrails/output.js", () => ({ scanOutput: vi.fn((text: string) => ({ safe: true, redacted: text })) }));
vi.mock("../audit/logger.js", () => ({ logAudit: auditMock }));

// The knowledge base the user names: one crawled page, ready. The real tool runs; only the store
// and the engram search beneath it are replaced.
const KB_ID = "core-ix-nw-doku";
const kbRecord = {
  id: KB_ID,
  name: "E2E Nordlicht Doku (core-ix)",
  seedUrls: ["http://www.nordlicht-werkzeuge.test/dokumentation.html"],
  maxPages: 1,
  maxDepth: 0,
  sameOriginOnly: true,
  respectRobots: true,
  ambientRetrieval: false,
  scope: "workspace" as const,
  createdAt: "2026-10-08T22:29:00.000Z",
  updatedAt: "2026-10-08T22:29:32.000Z",
  status: "ready" as const,
  pages: {
    "http://www.nordlicht-werkzeuge.test/dokumentation.html": {
      url: "http://www.nordlicht-werkzeuge.test/dokumentation.html",
      documentId: "doc-nw-1",
      title: "Dokumentation NW-AS 18",
    },
  },
};
const searchKnowledgeBaseMock = vi.hoisted(() => vi.fn());
/** The knowledge-base worker use_knowledge_base runs: only its result is stood in for. */
const runEphemeralWorkerMock = vi.hoisted(() => vi.fn());

vi.mock("../retrieval/knowledge-bases.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../retrieval/knowledge-bases.js")>();
  return {
    ...actual,
    getKnowledgeBase: async (idOrName: string) => (idOrName.trim().toLowerCase() === KB_ID ? kbRecord : undefined),
    listKnowledgeBases: async () => [kbRecord],
  };
});
vi.mock("../retrieval/kb-crawler.js", () => ({ isCrawlActive: () => false }));
vi.mock("../retrieval/engram.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../retrieval/engram.js")>();
  return { ...actual, engramConfigured: () => true };
});
vi.mock("../retrieval/document-rag.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../retrieval/document-rag.js")>();
  return {
    ...actual,
    // No attached documents on this turn: the per-turn document pass finds nothing.
    augmentTurnWithDocuments: async () => ({ ingested: 0, failed: 0, contextBlock: "", retrievalUnavailable: false }),
    searchKnowledgeBase: (...args: unknown[]) => searchKnowledgeBaseMock(...args),
  };
});
vi.mock("../tools/ephemeral-agent-factory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools/ephemeral-agent-factory.js")>();
  return { ...actual, runEphemeralWorker: (...args: unknown[]) => runEphemeralWorkerMock(...args) };
});

const KB_QUESTION = `Suche in der Wissensdatenbank „${KB_ID}“: Wie lange dauert es, den Akku-Pack NW-3104 mit dem Schnellladegerät NW-LG 18 von 0 auf 80 % zu laden, und nach wie vielen Betriebsstunden soll das Getriebefett des Akku-Schraubers NW-AS 18 geprüft werden?`;

const KB_EXCERPTS = [
  {
    chunkId: "c1",
    documentId: "doc-nw-1",
    title: "Dokumentation NW-AS 18",
    url: "http://www.nordlicht-werkzeuge.test/dokumentation.html",
    text: "Der Akku-Pack NW-3104 (18 V) ist mit dem Schnellladegerät NW-LG 18 in 38 Minuten von 0 % auf 80 % geladen.",
    score: 0.91,
  },
  {
    chunkId: "c2",
    documentId: "doc-nw-1",
    title: "Dokumentation NW-AS 18",
    url: "http://www.nordlicht-werkzeuge.test/dokumentation.html",
    text: "Getriebefett alle 150 Betriebsstunden prüfen.",
    score: 0.88,
  },
];

const tempDirs: string[] = [];

async function loadRuntime(orchestration: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sai-forced-kb-"));
  tempDirs.push(dir);
  writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
    agents: { mainAssistant: { toolMode: "orchestration_only" } },
    retrieval: { knowledgeBases: { enabled: true } },
    orchestration: {
      // The deployment's shape: the up-front judge forces a source-sensitive turn, and the
      // forced subset is enforced at the call site over a frozen tool block.
      upfrontSourceSensitiveClassifier: true,
      forceToolChoiceWhenOrchestrationRequired: true,
      stableToolBlock: "freeze",
      // Keep the turn short and deterministic: no research delegation run on the turn's behalf.
      autoResearchOnRefusal: false,
      planFirst: false,
      discoveryPrefetch: false,
      qaDeliveryLoop: false,
      riskGatedQA: false,
      finalResponseQaGate: false,
      ...orchestration,
    },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
  vi.resetModules();
  const [{ AgentSession, resetSessionsForTests }, { runTurn }] = await Promise.all([
    import("../agent/session.js"),
    import("../agent/runtime.js"),
    // Registers the knowledge-base tools in this module graph's registry, as the gateway's
    // built-in registration does: they are in the orchestrator's always-available set.
    import("../tools/knowledge-bases.js"),
  ]);
  resetSessionsForTests();
  return { AgentSession, runTurn };
}

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

/** The model searches the knowledge base on its first call and answers from the excerpts after. */
function searchThenAnswer(answer: string) {
  let call = 0;
  streamMock.mockImplementation(() => {
    call += 1;
    return call === 1
      ? toolCallStream("kb1", "search_knowledge_base", { knowledge_base: KB_ID, query: "Ladezeit NW-3104 NW-LG 18 0 auf 80 %; Getriebefett Prüfintervall NW-AS 18" })
      : textStream(answer);
  });
}

const streamOptions = () => streamMock.mock.calls.map((args) => args[3] as Record<string, unknown> | undefined);
const toolNamesOfCall = (index: number) => ((streamMock.mock.calls[index]?.[1] ?? []) as Array<{ name: string }>).map((tool) => tool.name);
const auditTypes = () => auditMock.mock.calls.map((call) => {
  const [event, data] = call as [string, Record<string, unknown> | undefined];
  return typeof data?.["type"] === "string" ? `${event}:${data["type"] as string}` : event;
});

afterEach(async () => {
  delete process.env["SAI_CONFIG_PATH"];
  streamMock.mockReset();
  completeMock.mockReset();
  routingCompleteMock.mockClear();
  auditMock.mockClear();
  searchKnowledgeBaseMock.mockReset();
  runEphemeralWorkerMock.mockReset();
  checkToolOutputMock.mockImplementation(() => ({ allowed: true }));
  moderateToolResultTextMock.mockImplementation(async () => null);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
  (await import("../config/loader.js")).resetConfigForTests();
});

describe("the forced-orchestration allowlist — knowledge-base reads", () => {
  it("keeps the three knowledge-base reads and drops the knowledge-base mutations", async () => {
    const { filterForcedOrchestrationTools } = await import("../agent/forced-orchestration-tools.js");
    const tools = [
      "list_knowledge_bases", "search_knowledge_base", "use_knowledge_base",
      "create_knowledge_base", "manage_knowledge_base", "memory_store", "delegate_to_agent",
    ].map((name) => ({ name }));
    expect(filterForcedOrchestrationTools(tools, { planRecorded: true }).map((tool) => tool.name)).toEqual([
      "list_knowledge_bases", "search_knowledge_base", "use_knowledge_base", "delegate_to_agent",
    ]);
  });
});

describe("a source-sensitive turn under stableToolBlock freeze", () => {
  it("can call search_knowledge_base on the forced call, and the call runs instead of being refused", async () => {
    const { AgentSession, runTurn } = await loadRuntime();
    searchKnowledgeBaseMock.mockResolvedValue({ chunks: KB_EXCERPTS, retrievalFailed: false, lowConfidence: false });
    searchThenAnswer("Laut Wissensdatenbank: 38 Minuten bis 80 %, Getriebefett alle 150 Betriebsstunden prüfen.");

    const session = new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "You are a test agent." });
    const toolResults: Array<{ name: string; result: string }> = [];
    await runTurn({
      session,
      userMessage: KB_QUESTION,
      onToolResult: (_id, name, result) => { toolResults.push({ name, result }); },
    });

    // The judge ran and forced the first call, or this proves nothing about the forced path.
    expect(routingCompleteMock, "the up-front judge did not run").toHaveBeenCalled();
    expect(streamOptions()[0]?.["toolChoice"], "the first call was not the forced call").toBe("required");
    // Under freeze the tool is on the wire either way; what decides is the call-site allowlist.
    expect(toolNamesOfCall(0)).toContain("search_knowledge_base");

    const search = toolResults.find((entry) => entry.name === "search_knowledge_base");
    expect(search, "search_knowledge_base produced no result").toBeDefined();
    expect(search!.result).not.toContain("cannot advance this turn yet");
    expect(search!.result).toContain("38 Minuten");
    expect(searchKnowledgeBaseMock).toHaveBeenCalledTimes(1);
    expect((searchKnowledgeBaseMock.mock.calls[0]![0] as { id: string }).id).toBe(KB_ID);
    expect(auditTypes()).not.toContain("tool_restriction_refused");
  }, 60_000);
});

describe("retrievedKnowledgeBaseContent — what counts as a knowledge-base read that grounds the turn", () => {
  it("counts a search that returned excerpts and a knowledge-base worker that ran, and nothing else", async () => {
    const { retrievedKnowledgeBaseContent } = await import("../agent/turn-tool-contribution.js");
    expect(retrievedKnowledgeBaseContent("search_knowledge_base", { success: true, metadata: { hits: 2, kbId: KB_ID } })).toBe(true);
    expect(retrievedKnowledgeBaseContent("use_knowledge_base", { success: true, metadata: { kbId: KB_ID } })).toBe(true);
  });

  it("fails closed: a search that found nothing reports success, and does not count", async () => {
    const { retrievedKnowledgeBaseContent } = await import("../agent/turn-tool-contribution.js");
    expect(retrievedKnowledgeBaseContent("search_knowledge_base", { success: true, metadata: { hits: 0, kbId: KB_ID } })).toBe(false);
    expect(retrievedKnowledgeBaseContent("search_knowledge_base", { success: true })).toBe(false);
    expect(retrievedKnowledgeBaseContent("search_knowledge_base", { success: true, metadata: { hits: "2" } })).toBe(false);
    expect(retrievedKnowledgeBaseContent("search_knowledge_base", { success: false, metadata: { hits: 2 } })).toBe(false);
    expect(retrievedKnowledgeBaseContent("use_knowledge_base", { success: false })).toBe(false);
    // Discovery is not retrieval: listing the knowledge bases returns names, not content.
    expect(retrievedKnowledgeBaseContent("list_knowledge_bases", { success: true, metadata: { count: 1 } })).toBe(false);
    expect(retrievedKnowledgeBaseContent("search_documents", { success: true, metadata: { hits: 2 } })).toBe(false);
  });
});

describe("a knowledge-base read that brought content back grounds a source-sensitive turn", () => {
  // Drawn from the two excerpts, dense in figures, and long enough for the structural ungrounded tier
  // to judge it. No URL: the citation guard is not what this covers.
  const GROUNDED_ANSWER = [
    "Laut der Wissensdatenbank core-ix-nw-doku (Kurzanleitung NW-AS 18):",
    "Der Akku-Pack NW-3104 (18 V) ist mit dem Schnellladegerät NW-LG 18 in 38 Minuten von 0 % auf 80 % geladen.",
    "Das Getriebefett des Akku-Schraubers NW-AS 18 soll alle 150 Betriebsstunden geprüft werden.",
    "Beide Angaben stammen aus den gefundenen Auszügen der Dokumentation; eine Ladezeit über 80 % hinaus",
    "und weitere Wartungsintervalle nennen diese Auszüge nicht, deshalb gebe ich dazu keine Werte an.",
  ].join(" ");
  const GUARDS = { ungroundedFactualAnswerGuard: true, semanticUngroundedFactualGuard: true };

  it("releases the forced orchestration and ships the answer drawn from the excerpts, with no research retry", async () => {
    // The fixture must be one the ungrounded-draft tiers would reject if the turn counted as unretrieved.
    const { looksLikeUnsourcedSpecificClaims } = await import("../agent/citation-honesty.js");
    expect(looksLikeUnsourcedSpecificClaims(GROUNDED_ANSWER)).toBe(true);

    const { AgentSession, runTurn } = await loadRuntime(GUARDS);
    searchKnowledgeBaseMock.mockResolvedValue({ chunks: KB_EXCERPTS, retrievalFailed: false, lowConfidence: false });
    searchThenAnswer(GROUNDED_ANSWER);

    const session = new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "You are a test agent." });
    const output = await runTurn({ session, userMessage: KB_QUESTION });

    expect(streamOptions()[0]?.["toolChoice"], "the first call was not the forced call").toBe("required");
    // The search released the requirement, so the next call is an ordinary one...
    expect(streamOptions()[1]?.["toolChoice"], "the call after the knowledge-base search was still forced").toBeUndefined();
    // ...whose answer stands: no rejection, no second drafting call, no caveat.
    const types = auditTypes();
    expect(types).not.toContain("guardrail_flagged:tool_free_research_answer_rejected");
    expect(types).not.toContain("guardrail_flagged:semantic_ungrounded_factual_detected");
    expect(streamMock).toHaveBeenCalledTimes(2);
    expect(output.response).toContain("38 Minuten");
    expect(output.response).toContain("150 Betriebsstunden");
    expect(output.response).not.toContain("NICHT mit aktuellen Online-Quellen");
  }, 60_000);

  it("a search that found nothing leaves the turn forced", async () => {
    const { AgentSession, runTurn } = await loadRuntime(GUARDS);
    searchKnowledgeBaseMock.mockResolvedValue({ chunks: [], retrievalFailed: false, lowConfidence: false });
    searchThenAnswer(GROUNDED_ANSWER);

    const session = new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "You are a test agent." });
    await runTurn({ session, userMessage: KB_QUESTION });

    expect(searchKnowledgeBaseMock).toHaveBeenCalledTimes(1);
    expect(streamOptions()[1]?.["toolChoice"], "an empty search released the research requirement").toBe("required");
  }, 60_000);

  // Crawled pages are untrusted, and a page about chat templates or LLM tooling can carry the very
  // tags the injection screen blocks. Such a search has hits, but the model sees only the block error.
  const blocksTheExcerpts = (text: string) => text.includes("38 Minuten");
  it.each([
    ["the prompt-injection screen", () => {
      checkToolOutputMock.mockImplementation((text) => (blocksTheExcerpts(text)
        ? { allowed: false, reason: "suspicious payload" }
        : { allowed: true }));
    }],
    ["the moderation model", () => {
      moderateToolResultTextMock.mockImplementation(async (text) => (blocksTheExcerpts(text)
        ? { blocked: true, flagged: true, categories: ["test"], summary: "blocked in test" }
        : null));
    }],
  ])("a search whose excerpts %s blocked leaves the turn forced", async (_screen, block) => {
    const { AgentSession, runTurn } = await loadRuntime(GUARDS);
    searchKnowledgeBaseMock.mockResolvedValue({ chunks: KB_EXCERPTS, retrievalFailed: false, lowConfidence: false });
    block();
    searchThenAnswer(GROUNDED_ANSWER);

    const session = new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "You are a test agent." });
    const toolResults: Array<{ name: string; result: string }> = [];
    await runTurn({
      session,
      userMessage: KB_QUESTION,
      onToolResult: (_id, name, result) => { toolResults.push({ name, result }); },
    });

    // The search found the excerpts, and the model was handed the block error in their place.
    expect(searchKnowledgeBaseMock).toHaveBeenCalledTimes(1);
    const search = toolResults.find((entry) => entry.name === "search_knowledge_base");
    expect(search?.result).toMatch(/^Error: Tool output blocked/);
    expect(auditTypes()).toContain("tool_output_blocked");
    expect(streamOptions()[1]?.["toolChoice"], "a blocked search released the research requirement").toBe("required");
  }, 60_000);
});

describe("the excerpts a search returned reach the model's next call", () => {
  // E2E 2026-10-09: the crawled page's excerpt opened with its title and navigation, so the charge
  // time sat at character 1,109 of the result. The frame cut the result to 600 characters and the
  // collapsed history to 500, and the model searched again for what it had already found.
  const PAGE_CHROME = [
    "# Dokumentation NW-AS 18 | Nordlicht Werkzeuge",
    ...["Startseite", "Produkte", "Akku-Werkzeuge", "Ladegeräte", "Zubehör", "Ersatzteile", "Service", "Downloads",
      "Händlersuche", "Garantie", "Reparatur", "Schulungen", "Presse", "Karriere", "Lieferstatus", "Kontakt"]
      .map((label) => `- [${label}](/${label.toLowerCase().replace(/[^a-z]+/g, "-")}.html)`),
  ].join("\n");

  it("the call after the search reads a passage that sits past character 600 of the result", async () => {
    const { AgentSession, runTurn } = await loadRuntime();
    const [charge, grease] = KB_EXCERPTS;
    searchKnowledgeBaseMock.mockResolvedValue({
      chunks: [{ ...charge!, text: `${PAGE_CHROME}\n\n${charge!.text}` }, grease!],
      retrievalFailed: false,
      lowConfidence: false,
    });
    searchThenAnswer("Laut Wissensdatenbank: 38 Minuten bis 80 %, Getriebefett alle 150 Betriebsstunden prüfen.");

    const session = new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "You are a test agent." });
    const toolResults: Array<{ name: string; result: string }> = [];
    await runTurn({
      session,
      userMessage: KB_QUESTION,
      onToolResult: (_id, name, result) => { toolResults.push({ name, result }); },
    });

    const search = toolResults.find((entry) => entry.name === "search_knowledge_base");
    expect(search?.result.indexOf(charge!.text), "the fixture's passage does not sit past character 600").toBeGreaterThan(600);
    expect(streamMock.mock.calls.length, "the turn made no call after the search").toBeGreaterThanOrEqual(2);
    const nextCall = (streamMock.mock.calls[1]![0] as Array<{ content?: unknown }>)
      .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "")))
      .join("\n");
    expect(nextCall).toContain(charge!.text);
    expect(nextCall).toContain(grease!.text);
  }, 60_000);

  it("a low-confidence search says so ahead of its excerpts, so the cut to the retrieval budget keeps the note", async () => {
    await loadRuntime();
    const { getTool } = await import("../tools/registry.js");
    const { buildModelVisibleToolResult } = await import("../agent/tool-result-format.js");
    const { getConfig } = await import("../config/loader.js");
    getConfig().retrieval.documentRag.maxContextChars = 6000;
    // Six long excerpts of a crawled site, as the default top-k returns them: past the budget.
    const chunks = Array.from({ length: 6 }, (_, i) => ({
      ...KB_EXCERPTS[0]!,
      chunkId: `c${i}`,
      text: `Abschnitt ${i + 1}: ${"Wartungshinweis zum Akku-Schrauber NW-AS 18. ".repeat(30)}`,
    }));
    searchKnowledgeBaseMock.mockResolvedValue({ chunks, retrievalFailed: false, lowConfidence: true });

    const result = await getTool("search_knowledge_base")!.execute(
      { knowledge_base: KB_ID, query: "Wartung NW-AS 18" },
      { sessionId: "kb-low-confidence", workspacePath: "/workspace" } as never,
    );
    expect(result.success).toBe(true);
    const visible = buildModelVisibleToolResult("search_knowledge_base", result.output, result.metadata);
    expect(visible, "the fixture does not run past the budget").toMatch(/\[Cut to fit the context budget: /);
    expect(visible.length).toBeLessThanOrEqual(6000);
    expect(visible).toContain("retrieval confidence for this query was LOW");
    expect(visible).toContain("Abschnitt 1:");
  }, 60_000);
});

describe("the turn loop's own notes on a retrieval result survive its cut to the budget", () => {
  const SEARCH_ARGS = { knowledge_base: KB_ID, query: "Ladezeit NW-3104 NW-LG 18 0 auf 80 %" };
  const CUT_LINE = /\[Cut to fit the context budget: the remaining \d+ characters of this result are not shown\.\]/;

  type ScriptedCall = [callId: string, toolName: string, args: Record<string, unknown>];

  /** The model sends each iteration's calls in one response, and answers after the last. */
  function callsThenAnswer(iterations: ScriptedCall[][], answer: string) {
    let call = 0;
    streamMock.mockImplementation(() => {
      const calls = iterations[call];
      call += 1;
      if (!calls) return textStream(answer);
      return (async function* () {
        for (const [callId, toolName, args] of calls) {
          yield { type: "tool_call_start", toolCallId: callId, toolName };
          yield { type: "tool_call_delta", toolCallId: callId, argumentsDelta: JSON.stringify(args) };
        }
        yield { type: "done", finishReason: "tool_calls", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      })();
    });
  }

  /** What the turn stored as the model-visible result of one call. */
  const storedResult = (session: { getHistory(): readonly unknown[] }, callId: string): string | undefined =>
    (session.getHistory() as ReadonlyArray<{ role: string; tool_call_id?: string; content?: string | null }>)
      .find((message) => message.role === "tool" && message.tool_call_id === callId)?.content ?? undefined;

  it("a search that keeps failing the same way keeps the identical-output notice after the cut line", async () => {
    const { AgentSession, runTurn } = await loadRuntime();
    (await import("../config/loader.js")).getConfig().retrieval.documentRag.maxContextChars = 500;
    // The store's error, echoed whole, runs past the budget. A failed call is not served from the
    // identical-arguments cache, so the third one runs and gets the loop's notice. The listing in the
    // second iteration succeeds: two iterations whose every call failed end the turn first.
    searchKnowledgeBaseMock.mockRejectedValue(new Error(`engram search failed: ${"upstream connection reset by peer; ".repeat(20)}`));
    callsThenAnswer([
      [["kb1", "search_knowledge_base", SEARCH_ARGS]],
      [["kb2", "search_knowledge_base", SEARCH_ARGS], ["list1", "list_knowledge_bases", {}]],
      [["kb3", "search_knowledge_base", SEARCH_ARGS]],
    ], "Die Wissensdatenbank ist gerade nicht erreichbar.");

    const session = new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "You are a test agent." });
    await runTurn({ session, userMessage: KB_QUESTION });

    expect(searchKnowledgeBaseMock).toHaveBeenCalledTimes(3);
    const third = storedResult(session, "kb3");
    expect(third, "the third search left no result").toBeDefined();
    expect(third).toMatch(CUT_LINE);
    expect(third).toMatch(/not shown\.\]\n\n\[System notice: search_knowledge_base has returned identical output 3 times in a row\. You are stuck in a loop\. [^\n]*\]$/);
  }, 60_000);
});

describe("citations in an answer from this turn's knowledge-base read are its sources", () => {
  const PAGE_URL = "http://www.nordlicht-werkzeuge.test/dokumentation.html";
  const CITED_ANSWER = [
    "Laut der Wissensdatenbank core-ix-nw-doku: Der Akku-Pack NW-3104 (18 V) ist mit dem Schnellladegerät",
    "NW-LG 18 in 38 Minuten von 0 % auf 80 % geladen, und das Getriebefett des Akku-Schraubers NW-AS 18 soll",
    `alle 150 Betriebsstunden geprüft werden. Quelle: [Dokumentation NW-AS 18](${PAGE_URL})`,
  ].join(" ");
  // A datasheet no tool returned, cited beside the page the search did return: bare, and as a link.
  const MADE_UP_URL = "https://www.nordlicht-werkzeuge.example/datenblatt-nw3104.pdf";
  const MADE_UP_LINK = "https://www.nordlicht-werkzeuge.example/wartung-nw-as-18.html";
  const MIXED_ANSWER = `${CITED_ANSWER} Datenblatt: ${MADE_UP_URL} und [Wartungsplan](${MADE_UP_LINK}).`;
  const UNVERIFIED_BANNER = "NICHT mit aktuellen Online-Quellen";

  async function citationGuard() {
    await loadRuntime({ citationHonestyGuard: true });
    return (await import("../agent/turn-terminal-guards.js")).applyCitationHonestyGuard;
  }

  function params(finalResponse: string, sourceUrls: string[], userMessage = KB_QUESTION) {
    return {
      finalResponse,
      userMessage,
      sessionId: "kb-citation-session",
      turnToolCallCounts: new Map([["search_knowledge_base", 1]]),
      turnDelegationCount: 0,
      workflowRunCompletedThisTurn: false,
      turnShareFindingCount: 0,
      turnKnowledgeBaseSourceUrls: new Set(sourceUrls),
      guardrailEvents: [] as Array<{ type: string; details: string }>,
    };
  }

  it("the control: with no knowledge-base page this turn, the same citation is stripped and caveated", async () => {
    const applyCitationHonestyGuard = await citationGuard();
    const { finalResponse } = await applyCitationHonestyGuard(params(CITED_ANSWER, []));
    expect(finalResponse).not.toContain(PAGE_URL);
    expect(finalResponse).toContain(UNVERIFIED_BANNER);
    expect(auditTypes()).toContain("guardrail_flagged:fabricated_citations_stripped");
  });

  it("keeps the knowledge-base page the answer cites, with no caveat", async () => {
    const applyCitationHonestyGuard = await citationGuard();
    const { finalResponse } = await applyCitationHonestyGuard(params(CITED_ANSWER, [PAGE_URL]));
    expect(finalResponse).toBe(CITED_ANSWER);
    expect(auditTypes()).not.toContain("guardrail_flagged:fabricated_citations_stripped");
  });

  it("the page cited bare, before punctuation, with a fragment or in another host case is still the page", async () => {
    const applyCitationHonestyGuard = await citationGuard();
    const otherCase = PAGE_URL.replace("www.nordlicht-werkzeuge.test", "WWW.Nordlicht-Werkzeuge.test");
    const answer = `${CITED_ANSWER} Siehe auch ${PAGE_URL}. Abschnitt: ${PAGE_URL}#akku, oder **${otherCase}**`;
    const { finalResponse } = await applyCitationHonestyGuard(params(answer, [PAGE_URL]));
    expect(finalResponse).toBe(answer);
  });

  it("strips every URL no knowledge-base read returned, keeps the page one did, and caveats the answer", async () => {
    const applyCitationHonestyGuard = await citationGuard();
    const { finalResponse } = await applyCitationHonestyGuard(params(MIXED_ANSWER, [PAGE_URL]));
    expect(finalResponse).not.toContain(MADE_UP_URL);
    expect(finalResponse).not.toContain(MADE_UP_LINK);
    expect(finalResponse).toContain("Wartungsplan");
    expect(finalResponse).toContain(`[Dokumentation NW-AS 18](${PAGE_URL})`);
    expect(finalResponse).toContain(UNVERIFIED_BANNER);
    expect(auditTypes()).toContain("guardrail_flagged:fabricated_citations_stripped");
  });

  it("does not stand in for reading a URL the user gave", async () => {
    const applyCitationHonestyGuard = await citationGuard();
    const userMessage = `${KB_QUESTION} Vergleiche das mit https://www.example.test/datenblatt.html`;
    const longAnswer = `${CITED_ANSWER} ${"Das Datenblatt nennt dieselben Werte. ".repeat(8)}`;
    const { finalResponse } = await applyCitationHonestyGuard(params(longAnswer, [PAGE_URL], userMessage));
    expect(auditTypes()).toContain("guardrail_flagged:url_content_unverified_no_fetch");
    expect(finalResponse).not.toBe(longAnswer);
  });

  it("a whole turn: the answer from the knowledge-base search ships with the page it cites", async () => {
    const { AgentSession, runTurn } = await loadRuntime({ citationHonestyGuard: true });
    searchKnowledgeBaseMock.mockResolvedValue({ chunks: KB_EXCERPTS, retrievalFailed: false, lowConfidence: false });
    searchThenAnswer(CITED_ANSWER);

    const session = new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "You are a test agent." });
    const output = await runTurn({ session, userMessage: KB_QUESTION });

    expect(output.response).toContain(PAGE_URL);
    expect(auditTypes()).not.toContain("guardrail_flagged:fabricated_citations_stripped");
  }, 60_000);

  it("a whole turn: a made-up datasheet beside the page the search returned is stripped, and the page stays", async () => {
    const { AgentSession, runTurn } = await loadRuntime({ citationHonestyGuard: true });
    searchKnowledgeBaseMock.mockResolvedValue({ chunks: KB_EXCERPTS, retrievalFailed: false, lowConfidence: false });
    searchThenAnswer(MIXED_ANSWER);

    const session = new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "You are a test agent." });
    const output = await runTurn({ session, userMessage: KB_QUESTION });

    expect(output.response).toContain(PAGE_URL);
    expect(output.response).not.toContain(MADE_UP_URL);
    expect(output.response).not.toContain(MADE_UP_LINK);
    expect(output.response).toContain(UNVERIFIED_BANNER);
    expect(auditTypes()).toContain("guardrail_flagged:fabricated_citations_stripped");
  }, 60_000);

  it("a whole turn: a search whose excerpts the screen blocked returned no page to cite", async () => {
    // Not source-sensitive, so nothing forces the turn on: the answer after the blocked search is the
    // one that ships, and the page it cites is one the model never saw.
    const { AgentSession, runTurn } = await loadRuntime({ citationHonestyGuard: true, upfrontSourceSensitiveClassifier: false });
    searchKnowledgeBaseMock.mockResolvedValue({ chunks: KB_EXCERPTS, retrievalFailed: false, lowConfidence: false });
    checkToolOutputMock.mockImplementation((text) => (text.includes("38 Minuten") ? { allowed: false, reason: "suspicious payload" } : { allowed: true }));
    searchThenAnswer(CITED_ANSWER);

    const session = new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "You are a test agent." });
    const output = await runTurn({ session, userMessage: KB_QUESTION });

    expect(auditTypes()).toContain("tool_output_blocked");
    expect(output.response).not.toContain(PAGE_URL);
    expect(auditTypes()).toContain("guardrail_flagged:fabricated_citations_stripped");
  }, 60_000);

  it("a whole turn: the pages a knowledge-base worker cites are sources, and a URL the answer adds is not", async () => {
    const { AgentSession, runTurn } = await loadRuntime({ citationHonestyGuard: true });
    runEphemeralWorkerMock.mockResolvedValue({
      success: true,
      output: `38 Minuten von 0 % auf 80 %; Getriebefett alle 150 Betriebsstunden prüfen. Quelle: ${PAGE_URL}`,
      grantedTools: ["search_knowledge_base", "list_knowledge_bases"],
      rejectedTools: [],
    });
    let call = 0;
    streamMock.mockImplementation(() => {
      call += 1;
      return call === 1
        ? toolCallStream("kbw1", "use_knowledge_base", { knowledge_base: KB_ID, task: "Ladezeit NW-3104 und Getriebefett-Intervall NW-AS 18" })
        : textStream(MIXED_ANSWER);
    });

    const session = new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "You are a test agent." });
    const output = await runTurn({ session, userMessage: KB_QUESTION });

    expect(runEphemeralWorkerMock).toHaveBeenCalledTimes(1);
    expect(output.response).toContain(PAGE_URL);
    expect(output.response).not.toContain(MADE_UP_URL);
    expect(output.response).not.toContain(MADE_UP_LINK);
    expect(auditTypes()).toContain("guardrail_flagged:fabricated_citations_stripped");
  }, 60_000);

  it("a turn cut off after the search: the synthesized answer keeps the page it cites too", async () => {
    // The iteration ceiling ends the turn right after the knowledge-base search, so the answer is
    // the terminal synthesis, and it reaches the citation guard through the backstop path.
    const { AgentSession, runTurn } = await loadRuntime({ citationHonestyGuard: true });
    searchKnowledgeBaseMock.mockResolvedValue({ chunks: KB_EXCERPTS, retrievalFailed: false, lowConfidence: false });
    searchThenAnswer(CITED_ANSWER);
    completeMock.mockImplementation(async () => ({
      content: CITED_ANSWER,
      tool_calls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: "stop",
    }));

    const session = new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "You are a test agent." });
    const output = await runTurn({ session, userMessage: KB_QUESTION, maxIterationsOverride: 1 });

    expect(streamMock).toHaveBeenCalledTimes(1);
    expect(searchKnowledgeBaseMock).toHaveBeenCalledTimes(1);
    expect(output.response).toContain(PAGE_URL);
    expect(auditTypes()).not.toContain("guardrail_flagged:fabricated_citations_stripped");
  }, 60_000);

  it("a turn cut off after the search: a made-up URL in the synthesized answer is stripped there too", async () => {
    const { AgentSession, runTurn } = await loadRuntime({ citationHonestyGuard: true });
    searchKnowledgeBaseMock.mockResolvedValue({ chunks: KB_EXCERPTS, retrievalFailed: false, lowConfidence: false });
    searchThenAnswer(MIXED_ANSWER);
    completeMock.mockImplementation(async () => ({
      content: MIXED_ANSWER,
      tool_calls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: "stop",
    }));

    const session = new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "You are a test agent." });
    const output = await runTurn({ session, userMessage: KB_QUESTION, maxIterationsOverride: 1 });

    expect(streamMock).toHaveBeenCalledTimes(1);
    expect(output.response).toContain(PAGE_URL);
    expect(output.response).not.toContain(MADE_UP_URL);
    expect(auditTypes()).toContain("guardrail_flagged:fabricated_citations_stripped");
  }, 60_000);
});

describe("knowledgeBaseSourceUrls — the pages a knowledge-base read returned", () => {
  it("reads the URLs a counted read reported, and nothing from a read that does not count", async () => {
    const { knowledgeBaseSourceUrls } = await import("../agent/turn-tool-contribution.js");
    const urls = ["http://a.test/1", "http://a.test/2"];
    expect(knowledgeBaseSourceUrls("search_knowledge_base", { success: true, metadata: { hits: 2, sourceUrls: urls } })).toEqual(urls);
    expect(knowledgeBaseSourceUrls("use_knowledge_base", { success: true, metadata: { sourceUrls: urls } })).toEqual(urls);
    expect(knowledgeBaseSourceUrls("search_knowledge_base", { success: true, metadata: { hits: 0, sourceUrls: urls } })).toEqual([]);
    expect(knowledgeBaseSourceUrls("search_knowledge_base", { success: false, metadata: { hits: 2, sourceUrls: urls } })).toEqual([]);
    expect(knowledgeBaseSourceUrls("search_documents", { success: true, metadata: { hits: 2, sourceUrls: urls } })).toEqual([]);
    expect(knowledgeBaseSourceUrls("search_knowledge_base", { success: true, metadata: { hits: 2, sourceUrls: "http://a.test/1" } })).toEqual([]);
    expect(knowledgeBaseSourceUrls("search_knowledge_base", { success: true, metadata: { hits: 2, sourceUrls: ["http://a.test/1", 7, ""] } })).toEqual(["http://a.test/1"]);
  });
});
