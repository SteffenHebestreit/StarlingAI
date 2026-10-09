import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildAgentIndex,
  computeQueryEmbedding,
  computeRetrievalQueryEmbedding,
  resetEmbeddingSearchStateForTests,
  searchByEmbedding,
  wrapEmbeddingQueryForModel,
} from "../providers/embeddings.js";
import type { LMStudioProvider } from "../providers/lmstudio.js";
import type { SubAgentConfig } from "../config/schema.js";

/**
 * THE INSTRUCT PREFIX BELONGS ON PASSAGE RETRIEVAL AND NOWHERE ELSE.
 *
 * e1151d8 applied the Qwen3 instruction inside getOrComputeQueryEmbedding on the grounds that
 * it "is the query path". It is not — the same function embeds CORPUS text at vectorUpsert and
 * in the trajectory cache — and it is also what agent routing uses.
 *
 * That shipped, and session b9d9cf01 is what it did. "wie wird das wetter morgen?" searched
 * "weather forecast for tomorrow current conditions" against 49 agents and matched NONE, though
 * web_task_coordinator's description literally reads "the weather forecast". Measured against
 * the serving cluster, with the corpus bare in both arms:
 *
 *   bare     cos 0.6923 -> rescaled (cos+1)/2 = 0.8461  >= 0.72  -> qualifies
 *   wrapped  cos 0.4118 -> rescaled           = 0.7059  <  0.72  -> zeroed
 *
 * computeHybridRoutingScore (agent-routing.ts:94) returns 0 below that floor, and the ranked
 * list then drops it on `combinedScore > 0`, so the candidate never reaches the visible gate —
 * which is why the audit recorded resultCount 0 AND weakCount 0 AND gated false. mail_agent at
 * 0.8028 still qualified, so routing kept working just often enough to look healthy.
 *
 * On the case the instruction string actually names — a query against passages that ANSWER it —
 * the prefix helps: mean separation 0.1798 -> 0.2345 over six query/passage pairs, 6/6 rank-1.
 * So it stays, scoped to computeRetrievalQueryEmbedding.
 */

const MODEL = "lmstudio/text-embedding-qwen3-embedding-0.6b";
const AGENTS: Record<string, SubAgentConfig> = {
  web_task_coordinator: {
    description: "Freshness-only live web lookups: the weather forecast, headlines, live scores.",
    capabilities: ["live lookup"],
    tags: ["weather", "news"],
    tools: ["web_search"],
    maxIterations: 4,
  } as unknown as SubAgentConfig,
};

let embedMock: ReturnType<typeof vi.fn>;
let provider: LMStudioProvider;

/** Every embedded text, in call order — the corpus build plus every query since. */
const embeddedTexts = (): string[] => embedMock.mock.calls.flatMap((call) => call[0] as string[]);

beforeEach(async () => {
  resetEmbeddingSearchStateForTests();
  embedMock = vi.fn(async (texts: string[]) => texts.map(() => new Float32Array([0.5, 0.3, 0.1, 0.8])));
  provider = { embed: embedMock } as unknown as LMStudioProvider;
  await buildAgentIndex(AGENTS, provider, MODEL);
  embedMock.mockClear(); // drop the corpus build; the assertions below are about QUERIES
});

afterEach(() => {
  resetEmbeddingSearchStateForTests();
});

describe("embedding query asymmetry is scoped to passage retrieval", () => {
  const QUERY = "weather forecast for tomorrow current conditions";

  it("does NOT instruct the query on the agent-routing path", async () => {
    // The regression that produced "No agents matched" for a verbatim description hit.
    await searchByEmbedding(QUERY, provider, 8);

    expect(embeddedTexts()).toContain(QUERY);
    expect(embeddedTexts().some((t) => t.startsWith("Instruct:"))).toBe(false);
  });

  it("does NOT instruct on the plain path — it also embeds CORPUS text", async () => {
    // vectorUpsert and the trajectory cache reach the model through computeQueryEmbedding.
    // Instructing here prefixes documents with a query instruction, which is the inverse of
    // the asymmetry the model was trained on.
    await computeQueryEmbedding("some stored document content");

    expect(embeddedTexts().some((t) => t.startsWith("Instruct:"))).toBe(false);
  });

  it("DOES instruct a retrieval query against a bare passage corpus", async () => {
    await computeRetrievalQueryEmbedding(QUERY);

    const instructed = embeddedTexts().filter((t) => t.startsWith("Instruct:"));
    expect(instructed).toHaveLength(1);
    expect(instructed[0]).toBe(wrapEmbeddingQueryForModel(QUERY, MODEL));
    expect(instructed[0]).toContain(`Query: ${QUERY}`);
  });

  it("keeps the two forms in SEPARATE cache entries", async () => {
    // The cache was keyed on raw text, which was only safe while the wrapper was
    // unconditional. Conditional, a shared key hands one caller the other's vector — silently,
    // with a plausible similarity score attached.
    await computeQueryEmbedding(QUERY);
    await computeRetrievalQueryEmbedding(QUERY);

    const texts = embeddedTexts();
    expect(texts).toHaveLength(2);
    expect(texts).toContain(QUERY);
    expect(texts.some((t) => t.startsWith("Instruct:"))).toBe(true);
  });

  it("still serves each form from its own cache on a repeat call", async () => {
    await computeQueryEmbedding(QUERY);
    await computeQueryEmbedding(QUERY);
    await computeRetrievalQueryEmbedding(QUERY);
    await computeRetrievalQueryEmbedding(QUERY);

    // Two distinct texts, one model round-trip each — the split must not cost a cache.
    expect(embeddedTexts()).toHaveLength(2);
  });
});
