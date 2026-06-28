import { describe, it, expect, vi, beforeEach } from "vitest";

// Spy on the query embedding so we can assert WHEN the rerank embed round-trip happens.
const { computeQueryEmbeddingMock } = vi.hoisted(() => ({
  computeQueryEmbeddingMock: vi.fn(async () => new Float32Array([1, 0, 0])),
}));
vi.mock("../providers/embeddings.js", async (orig) => ({
  ...(await orig<typeof import("../providers/embeddings.js")>()),
  isEmbeddingAvailable: () => true,
  computeQueryEmbedding: computeQueryEmbeddingMock,
}));

const { rerankToolsForTask } = await import("../tools/registry.js");

function defs(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    name: `tool_${i}`,
    description: `desc ${i}`,
    parameters: { type: "object", properties: {} },
  }));
}

describe("rerankToolsForTask — toolRerankMinTools threshold gate (B24)", () => {
  beforeEach(() => computeQueryEmbeddingMock.mockClear());

  it("SKIPS the embedding round-trip when the toolset is <= minTools", async () => {
    const d = defs(5);
    const out = await rerankToolsForTask(d, "do something useful", 6);
    expect(computeQueryEmbeddingMock).not.toHaveBeenCalled(); // no embed for a small toolset
    expect(out).toEqual(d);                                   // returned unchanged
  });

  it("RERANKS (one query embed) when the toolset is > minTools", async () => {
    const out = await rerankToolsForTask(defs(8), "do something useful", 6);
    expect(computeQueryEmbeddingMock).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(8);
  });

  it("defaults to minTools=1 (legacy behaviour) when no threshold is passed", async () => {
    await rerankToolsForTask(defs(2), "task"); // 2 > 1 -> reranks
    expect(computeQueryEmbeddingMock).toHaveBeenCalledTimes(1);
  });

  it("never embeds for an empty task regardless of size", async () => {
    await rerankToolsForTask(defs(20), "", 6);
    expect(computeQueryEmbeddingMock).not.toHaveBeenCalled();
  });
});
