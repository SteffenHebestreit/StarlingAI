import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * recall_context dropped every section whose subsystem threw, and when nothing was left it said
 * "No stored context matched this task yet" — a statement about stores it had not been able to
 * read. Failing sections are now named, and a pull where every section failed is a failure.
 */
const failing = vi.hoisted(() => new Set<string>());
const fail = (section: string): void => { if (failing.has(section)) throw new Error(`${section} store unreachable`); };

vi.mock("../tools/memory.js", () => ({ deriveSharedSessionId: (sessionId: string) => sessionId }));
vi.mock("../user-model/service.js", () => ({ formatUserModelGuidance: () => { fail("user"); return ""; } }));
vi.mock("../swarm/memory.js", () => ({ searchSharedFacts: async () => { fail("facts"); return []; } }));
/** What the memory search reports: by default nothing stored and the semantic check ran. */
const memorySearch = vi.hoisted(() => ({ result: null as null | Record<string, unknown> }));
vi.mock("../memory/service.js", () => ({
  searchMemoryRecordsWithStatus: async () => {
    fail("memory");
    return memorySearch.result ?? { records: [], semanticRan: true, unmatchedIds: [], notComparedSemantically: 0, candidatesByScope: {} };
  },
}));
vi.mock("../agent/session-search.js", () => ({ searchSessions: () => { fail("sessions"); return []; } }));
vi.mock("../skills/service.js", () => ({ retrieveSkillGuidance: async () => { fail("skills"); return { text: "", slugs: [] }; } }));
vi.mock("../retrieval/document-rag.js", () => ({
  retrieveDocumentContextWithStatus: async () => { fail("documents"); return { chunks: [], retrievalFailed: false }; },
}));
vi.mock("../config/loader.js", () => ({ getConfig: () => ({ agents: { defaults: { model: { embeddingModel: undefined } } } }) }));
vi.mock("../providers/index.js", () => ({ getEmbeddingProvider: () => ({}) }));

const CTX = { sessionId: "session-recall-unreadable", workspacePath: "/ws" };

describe("recall_context names the sections it could not read", () => {
  beforeAll(async () => { await import("../tools/recall-context.js"); });
  beforeEach(() => { failing.clear(); memorySearch.result = null; });

  async function recall(args: Record<string, unknown>) {
    const { getTool } = await import("../tools/registry.js");
    return getTool("recall_context")!.execute(args, CTX);
  }

  it("says which store failed instead of 'no stored context matched'", async () => {
    failing.add("memory");
    const r = await recall({ query: "what did we decide about the ferry schedule" });
    expect(r.success).toBe(true);
    expect(r.output).toContain("## Could not be read this time");
    expect(r.output).toContain("long-term memory (memory store unreachable)");
    expect(r.output).toContain("not evidence that nothing is stored");
    expect(r.output).not.toContain("No stored context matched");
    expect(r.metadata?.["unreadableSections"]).toEqual(["long-term memory (memory store unreachable)"]);
  });

  it("still says nothing matched when every store answered", async () => {
    const r = await recall({ query: "what did we decide about the ferry schedule" });
    expect(r.success).toBe(true);
    expect(r.output).toContain("No stored context matched");
    expect(r.output).not.toContain("Could not be read");
  });

  it("fails when every section asked for failed", async () => {
    failing.add("memory");
    failing.add("skills");
    const r = await recall({ query: "ferry schedule", include: ["memory", "skills"] });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/could not read any store: long-term memory .*; skills .*not evidence that nothing is stored/);
  });
});

describe("recall_context says when long-term memory was matched by word only", () => {
  beforeAll(async () => { await import("../tools/recall-context.js"); });
  beforeEach(() => { failing.clear(); memorySearch.result = null; });

  const sailing = { id: "m-sail", scope: "workspace", kind: "fact", subject: "Island ferry", content: "The island sailing leaves at 07:40.", tags: [], source: "memory_store", createdAt: "", updatedAt: "" };

  it("marks unmatched entries and says the pack is lexical only when semantic search was unavailable", async () => {
    memorySearch.result = { records: [sailing], semanticRan: false, unmatchedIds: ["m-sail"], notComparedSemantically: 0, candidatesByScope: { workspace: 1 } };
    const { getTool } = await import("../tools/registry.js");
    const r = await getTool("recall_context")!.execute({ query: "Wann fährt die Fähre ab", include: ["memory"] }, CTX);
    expect(r.success).toBe(true);
    expect(r.output).toContain("- [workspace/fact] Island ferry (no word match): The island sailing leaves at 07:40.");
    expect(r.output).toContain("Lexical only — semantic search unavailable");
    expect(r.metadata?.["memoryLexicalOnly"]).toBe(true);
  });

  it("adds nothing when the semantic check ran", async () => {
    memorySearch.result = { records: [sailing], semanticRan: true, unmatchedIds: [], notComparedSemantically: 0, candidatesByScope: { workspace: 1 } };
    const { getTool } = await import("../tools/registry.js");
    const r = await getTool("recall_context")!.execute({ query: "Wann fährt die Fähre ab", include: ["memory"] }, CTX);
    expect(r.output).toContain("- [workspace/fact] Island ferry: The island sailing leaves at 07:40.");
    expect(r.output).not.toContain("Lexical only");
  });
});
