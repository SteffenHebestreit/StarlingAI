import { beforeAll, describe, expect, it, vi } from "vitest";

// Keep deriveSharedSessionId real-ish (identity for non-"sub:" ids) without
// pulling the heavy tools/memory dependency graph.
vi.mock("../tools/memory.js", () => ({
  deriveSharedSessionId: (sessionId: string) => sessionId,
}));

vi.mock("../user-model/service.js", () => ({
  formatUserModelGuidance: () => "Goals: ship a lean, task-conditional prompt.",
}));

vi.mock("../swarm/memory.js", () => ({
  searchSharedFacts: async () => [
    { key: "chosen_endpoint", value: "http://host.docker.internal:1234/v1", score: 0.91 },
  ],
}));

vi.mock("../memory/service.js", () => ({
  searchMemoryRecordsWithStatus: async () => ({
    records: [
      { id: "m1", scope: "user", kind: "preference", subject: "provider", content: "prefers LM Studio over cloud", tags: [], source: "user", createdAt: "", updatedAt: "" },
    ],
    semanticRan: true,
    unmatchedIds: [],
    notComparedSemantically: 0,
    candidatesByScope: { user: 1 },
  }),
}));

vi.mock("../agent/session-search.js", () => ({
  searchSessions: () => [
    { id: "abc123def456789", channel: "webchat", updatedAt: "2026-05-21T10:00:00.000Z", messageCount: 6, matchedTerms: ["prompt"], snippet: "earlier prompt-diet discussion", score: 1 },
  ],
}));

vi.mock("../skills/service.js", () => ({
  retrieveSkillGuidance: async () => ({ text: "- ship-lean-prompt: gate intent modules off the classifier", slugs: ["ship-lean-prompt"] }),
}));

vi.mock("../config/loader.js", () => ({
  getConfig: () => ({ agents: { defaults: { model: { embeddingModel: undefined } } } }),
}));

vi.mock("../providers/index.js", () => ({
  getEmbeddingProvider: () => ({}),
}));

const CTX = { sessionId: "session-recall", workspacePath: "F:/StarlingAI" };

describe("recall_context tool", () => {
  beforeAll(async () => {
    await import("../tools/recall-context.js");
  });

  it("aggregates every memory subsystem into one compact pack", async () => {
    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("recall_context");
    expect(tool).toBeDefined();

    const result = await tool!.execute({ query: "make the prompt leaner" }, CTX);

    expect(result.success).toBe(true);
    expect(result.output).toContain('# Planning context for: "make the prompt leaner"');
    expect(result.output).toContain("## User model");
    expect(result.output).toContain("## Working memory (this session)");
    expect(result.output).toContain("chosen_endpoint");
    expect(result.output).toContain("## Relevant long-term memory");
    expect(result.output).toContain("prefers LM Studio");
    expect(result.output).toContain("## Recent related sessions");
    expect(result.output).toContain("## Relevant skills");
    expect(result.metadata).toMatchObject({
      userModel: true,
      sharedFacts: 1,
      memories: 1,
      sessions: 1,
      skills: 1,
    });
  });

  it("honors the include filter and omits the other sections", async () => {
    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("recall_context");

    const result = await tool!.execute({ query: "anything", include: ["skills"] }, CTX);

    expect(result.success).toBe(true);
    expect(result.output).toContain("## Relevant skills");
    expect(result.output).not.toContain("## User model");
    expect(result.output).not.toContain("## Relevant long-term memory");
    expect(result.output).not.toContain("## Recent related sessions");
    expect(result.metadata).not.toHaveProperty("memories");
  });

  it("searches long-term memory when the user section is asked for", async () => {
    // What the user asked to be remembered is a memory record, not part of the user model: a recall
    // of "user" + "facts" (what the model asked for, live) has to find a stored preference.
    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("recall_context");

    const result = await tool!.execute({ query: "which provider do I prefer", include: ["user", "facts"] }, CTX);

    expect(result.success).toBe(true);
    expect(result.output).toContain("## User model");
    expect(result.output).toContain("## Relevant long-term memory");
    expect(result.output).toContain("prefers LM Studio");
    expect(result.output).not.toContain("## Recent related sessions");
  });

  it("requires a query", async () => {
    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("recall_context");

    const result = await tool!.execute({ query: "   " }, CTX);
    expect(result.success).toBe(false);
  });
});
