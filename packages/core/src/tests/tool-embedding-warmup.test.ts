import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 2026-10-23: the model host's name stopped resolving. The startup warm-up sent one embedding
 * request per tool, all at once; ~250 failing lookups held the resolver threads every DNS lookup
 * shares, the gateway's own connections timed out behind them, and it never started listening.
 */
const embed = vi.hoisted(() => ({ calls: [] as number[], answer: true }));
vi.mock("../providers/embeddings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providers/embeddings.js")>();
  return {
    ...actual,
    isEmbeddingAvailable: () => true,
    computeTextEmbeddings: async (texts: string[]) => {
      embed.calls.push(texts.length);
      return texts.map(() => (embed.answer ? new Float32Array([0.1, 0.2, 0.3]) : null));
    },
    computeQueryEmbedding: async () => { throw new Error("the warm-up must not embed one tool at a time"); },
  };
});

describe("the startup tool-embedding warm-up", () => {
  afterEach(() => { embed.calls.length = 0; embed.answer = true; });

  const registered = async () => {
    const registry = await import("../tools/registry.js");
    // The gateway's built-in tools, as startup registers them: more than one batch.
    await import("../tools/register-builtins.js");
    registry._clearToolEmbeddingCacheForTests();
    return registry;
  };

  it("embeds the tools in batches, one request each", async () => {
    const { warmToolEmbeddings, getAllTools, TOOL_EMBEDDING_WARM_BATCH } = await registered();
    const tools = getAllTools().length;
    expect(tools).toBeGreaterThan(TOOL_EMBEDDING_WARM_BATCH);

    const result = await warmToolEmbeddings();
    expect(embed.calls).toHaveLength(Math.ceil(tools / TOOL_EMBEDDING_WARM_BATCH));
    expect(embed.calls.every((size) => size <= TOOL_EMBEDDING_WARM_BATCH)).toBe(true);
    expect(result.warmed).toBe(tools);

    // Warmed tools are not embedded again.
    embed.calls.length = 0;
    expect((await warmToolEmbeddings()).skipped).toBe(tools);
    expect(embed.calls).toEqual([]);
  });

  it("stops at the first batch the provider could not answer", async () => {
    const { warmToolEmbeddings, getAllTools, TOOL_EMBEDDING_WARM_BATCH } = await registered();
    expect(getAllTools().length).toBeGreaterThan(TOOL_EMBEDDING_WARM_BATCH);
    embed.answer = false;

    const result = await warmToolEmbeddings();
    expect(embed.calls).toHaveLength(1);
    expect(result.warmed).toBe(0);
  });
});
