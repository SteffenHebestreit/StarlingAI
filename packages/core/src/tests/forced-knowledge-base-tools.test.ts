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
  checkToolOutput: vi.fn(() => ({ allowed: true })),
}));
vi.mock("../guardrails/moderation.js", () => ({
  moderateInputText: vi.fn(async () => null),
  moderateToolResultText: vi.fn(async () => null),
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

const KB_QUESTION = `Suche in der Wissensdatenbank „${KB_ID}“: Wie lange dauert es, den Akku-Pack NW-3104 mit dem Schnellladegerät NW-LG 18 von 0 auf 80 % zu laden, und nach wie vielen Betriebsstunden soll das Getriebefett des Akku-Schraubers NW-AS 18 geprüft werden?`;

const KB_EXCERPTS = [
  {
    chunkId: "c1",
    documentId: "doc-nw-1",
    title: "Dokumentation NW-AS 18",
    url: "http://www.nordlicht-werkzeuge.test/dokumentation.html",
    text: "Der Akku-Pack NW-3104 ist mit dem Schnellladegerät NW-LG 18 in 38 Minuten von 0 auf 80 % geladen.",
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
  completeMock.mockClear();
  routingCompleteMock.mockClear();
  auditMock.mockClear();
  searchKnowledgeBaseMock.mockReset();
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
