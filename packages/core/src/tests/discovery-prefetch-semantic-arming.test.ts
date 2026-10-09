/**
 * What arms an --auto turn's forced first call from the discovery prefetch when routing runs on
 * embeddings, as it does wherever an embedding model is configured (the deployed stack).
 *
 * prefetchRoutedToDeliverableEmitter asks for a top agent at high confidence that holds a
 * deliverable-emitting tool. On the embedding path the confidence part filters nothing: the
 * prefetch admits an agent only at a semantic score of 0.72 or more, and 0.72 is also where "high"
 * begins, so every agent the capsule lists is high. The condition there is the top agent's tools
 * alone, whether or not the request asks for a deliverable. These cases run the real routing, the
 * real prefetch and the real predicate with only the embedding search stubbed, so a change that
 * narrows or widens the condition on this path shows up here, and the comments that describe it
 * have to change with it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiscoveryCapsuleAgent } from "../agent/discovery-prefetch.js";

/** Scores as the embedding path ranks them, on routing's 0..1 scale. */
const semanticScores = vi.hoisted(() => ({ current: {} as Record<string, number> }));

vi.mock("../providers/embeddings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../providers/embeddings.js")>()),
  isEmbeddingAvailable: () => true,
  // Routing maps a cosine similarity c to (c + 1) / 2, so hand it the cosine of each score.
  searchByEmbedding: async () => Object.entries(semanticScores.current)
    .map(([agentName, score]) => ({ agentName, description: agentName, score: score * 2 - 1 })),
}));
vi.mock("../providers/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../providers/index.js")>()),
  getEmbeddingProvider: () => ({}),
}));
vi.mock("../retrieval/reranker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../retrieval/reranker.js")>()),
  rerankCandidates: async () => null,
}));
vi.mock("../tools/workflow-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tools/workflow-catalog.js")>()),
  searchWorkflowCandidates: async () => [],
}));
vi.mock("../audit/logger.js", () => ({ logAudit: vi.fn(), subscribeToAudit: () => () => {} }));

/** A question about a chart: the word lists see no request to build one. */
const QUESTION = "how does a Gantt chart work?";

const tempDirs: string[] = [];

async function load(scores: Record<string, number>) {
  const dir = mkdtempSync(join(tmpdir(), "sai-prefetch-semantic-arming-"));
  tempDirs.push(dir);
  const workspacePath = join(dir, "workspace");
  mkdirSync(join(workspacePath, ".starlingai"), { recursive: true });
  writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
    workspacePath,
    agents: { defaults: { model: { primary: "lmstudio/qwen", embeddingModel: "test-embedding" } } },
    subAgents: {
      diagram_designer: {
        description: "Draws diagrams.",
        systemPrompt: "Draw.",
        tools: ["read_file", "generate_mermaid_diagram", "generate_document", "write_file"],
      },
      researcher: { description: "Finds sources.", systemPrompt: "Research.", tools: ["web_search", "web_fetch", "write_file"] },
    },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
  vi.resetModules();
  semanticScores.current = scores;
  const [turnSetup, deliverableIntent] = await Promise.all([
    import("../agent/turn-setup.js"),
    import("../agent/deliverable-intent.js"),
  ]);
  return { turnSetup, deliverableIntent };
}

/** The agents the prefetch reports for a message, through the same call the runtime makes. */
async function capsuleAgents(turnSetup: Awaited<ReturnType<typeof load>>["turnSetup"], userMessage: string) {
  let seen: DiscoveryCapsuleAgent[] | undefined;
  await turnSetup.startDiscoveryPrefetch({
    userMessage,
    sessionId: "s-semantic",
    budgetMs: 10_000,
    onCapsuleAgents: (agents) => { seen = [...agents]; },
  });
  return seen;
}

afterEach(async () => {
  delete process.env["SAI_CONFIG_PATH"];
  vi.resetModules();
  (await import("../config/loader.js")).resetConfigForTests();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the prefetch's --auto arm when routing runs on embeddings", () => {
  it("every agent the prefetch admits is high: just over the floor is high, just under is not listed", async () => {
    const { turnSetup } = await load({ diagram_designer: 0.73, researcher: 0.71 });
    expect(await capsuleAgents(turnSetup, QUESTION)).toEqual([{ name: "diagram_designer", confidence: "high" }]);

    const both = await load({ researcher: 0.95, diagram_designer: 0.73 });
    expect(await capsuleAgents(both.turnSetup, QUESTION)).toEqual([
      { name: "researcher", confidence: "high" },
      { name: "diagram_designer", confidence: "high" },
    ]);
  });

  it("so a question that routes to an agent holding a generator arms the forced call, and one routed elsewhere does not", async () => {
    const { turnSetup, deliverableIntent } = await load({ diagram_designer: 0.73 });
    expect(deliverableIntent.classifyDeliverableIntent(QUESTION).wantsArtifact).toBe(false);
    expect(turnSetup.prefetchRoutedToDeliverableEmitter((await capsuleAgents(turnSetup, QUESTION)) ?? [])).toBe(true);

    const researcherFirst = await load({ researcher: 0.95, diagram_designer: 0.73 });
    expect(researcherFirst.turnSetup.prefetchRoutedToDeliverableEmitter(
      (await capsuleAgents(researcherFirst.turnSetup, QUESTION)) ?? [],
    )).toBe(false);
  });
});
