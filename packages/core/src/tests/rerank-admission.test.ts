/**
 * The rerank blend orders the admitted set; it does not decide admission.
 *
 * rerankViaTei MIN-MAX normalises the model's logits, which discards their absolute meaning
 * and substitutes the candidate's RANK inside the shortlist: the worst always receives
 * exactly 0, the best exactly 1. The old code fed that into
 * `combinedScore * 0.7 + rerankScore * 0.3` and compared the result against the fixed 0.72
 * admission floor, which made two things true by arithmetic rather than by judgement:
 *
 *   worst-reranked:  0.7 * combinedScore + 0    <= 0.70  -> below the floor, ALWAYS
 *   best-reranked:   0.7 * 0.72        + 0.3    >= 0.804 -> above the floor, ALWAYS
 *
 * So a candidate the embedding scored 1.0 was rejected for being the reranker's last pick,
 * and a candidate scraping the floor was admitted for being its first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cosFor = (routingScore: number): number => routingScore * 2 - 1;
const vectorAt = (cos: number): Float32Array => new Float32Array([cos, Math.sqrt(Math.max(0, 1 - cos * cos))]);

const AGENTS = {
  best_match: { description: "Alpha worker.", capabilities: ["work"], tags: ["work"], tools: ["web_search"], maxIterations: 4 },
  mid_match: { description: "Beta worker.", capabilities: ["work"], tags: ["work"], tools: ["web_search"], maxIterations: 4 },
  weak_match: { description: "Gamma worker.", capabilities: ["work"], tags: ["work"], tools: ["web_search"], maxIterations: 4 },
};

/** Embedding placements: best_match is a near-perfect match, the other two merely clear the floor. */
const PLACEMENT: Record<string, number> = { best_match: 0.99, mid_match: 0.75, weak_match: 0.74 };

/**
 * Raw logits from the reranker, with the best EMBEDDING match given the LOWEST one. The
 * absolute values are deliberately close together: min-max normalisation stretches them to
 * exactly [0, 1] regardless, which is the property under test.
 */
const RERANK_LOGITS: Record<string, number> = { best_match: -0.2, mid_match: 0.1, weak_match: 0.3 };

let tempDir: string | undefined;

async function routeWith(blendMode: "ordering" | "admission") {
  vi.resetModules();
  tempDir = mkdtempSync(join(tmpdir(), "starlingai-rerank-admission-"));
  const configPath = join(tempDir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({
    agents: { defaults: { model: { primary: "lmstudio/qwen", embeddingModel: "lmstudio/embed" } } },
    subAgents: AGENTS,
    retrieval: { reranker: { enabled: true, mode: "tei", baseUrl: "http://reranker:80", topK: 6, blendMode } },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configPath;
  // The agent index is cached to disk and keyed by catalog text, so two runs over the same
  // agents would otherwise share vectors and quietly measure the wrong placement.
  process.env["SAI_EMBEDDING_CACHE"] = join(tempDir, "embedding-cache.json");

  const provider = {
    embed: vi.fn(async (texts: string[]) => texts.map((text) => {
      if (!text.startsWith("Agent:")) return vectorAt(1);
      const name = Object.keys(PLACEMENT).find((candidate) => text.includes(candidate));
      return vectorAt(cosFor(name ? PLACEMENT[name]! : 0.30));
    })),
  };
  vi.doMock("../providers/index.js", async () => ({
    ...(await vi.importActual<Record<string, unknown>>("../providers/index.js")),
    getEmbeddingProvider: () => provider,
  }));

  // The real TEI contract: raw logits in, min-max normalisation applied by our own code.
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { texts?: string[] };
    const rows = (body.texts ?? []).map((text, index) => {
      const name = Object.keys(RERANK_LOGITS).find((candidate) => text.includes(candidate));
      return { index, score: name ? RERANK_LOGITS[name]! : 0 };
    });
    void url;
    return new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json" } });
  }));

  const { buildAgentIndex, resetEmbeddingSearchStateForTests } = await import("../providers/embeddings.js");
  const { _resetRerankerCircuitForTests } = await import("../retrieval/reranker.js");
  resetEmbeddingSearchStateForTests();
  _resetRerankerCircuitForTests();
  await buildAgentIndex(AGENTS as never, provider as never, "lmstudio/embed");
  const { resolveAgentRouting } = await import("../tools/agent-routing.js");
  return resolveAgentRouting("do the work", { minConfidence: "high" });
}

describe("rerank blend and the admission floor", () => {
  beforeEach(() => {
    delete process.env["SAI_CONFIG_PATH"];
    delete process.env["SAI_EMBEDDING_CACHE"];
  });
  afterEach(() => {
    vi.doUnmock("../providers/index.js");
    vi.unstubAllGlobals();
    vi.resetModules();
    delete process.env["SAI_CONFIG_PATH"];
    delete process.env["SAI_EMBEDDING_CACHE"];
    if (tempDir) { rmSync(tempDir, { recursive: true, force: true }); tempDir = undefined; }
  });

  it("keeps a near-perfect embedding match that the reranker ranked last", async () => {
    const resolution = await routeWith("ordering");

    const names = resolution.results.map((candidate) => candidate.name);
    expect(names).toContain("best_match");
    // All three cleared the embedding floor, so all three stay in the room.
    expect(names).toHaveLength(3);
    // The reported score is the pre-blend one, so it agrees with the floor and with the
    // confidence label derived from the same threshold.
    const best = resolution.results.find((candidate) => candidate.name === "best_match")!;
    expect(best.score).toBeGreaterThanOrEqual(0.72);
    expect(best.confidence).toBe("high");
  });

  it("still lets the reranker decide the ORDER", async () => {
    const resolution = await routeWith("ordering");

    // The reranker put weak_match first and best_match last. Ordering is its job, so the
    // blend must still move them, even though it no longer evicts anyone.
    const names = resolution.results.map((candidate) => candidate.name);
    expect(names.indexOf("weak_match")).toBeLessThan(names.indexOf("best_match"));
  });

  it("defaults to ordering, so the fix cannot be reverted by deleting one token", async () => {
    // Every test above passes a blendMode explicitly, so none of them pins which branch
    // PRODUCTION takes. Changing the schema default back to "admission" would leave the whole
    // suite green while restoring the defect: the reranker's last pick unadmittable however
    // well it matched.
    const { RetrievalRerankerSchema } = await import("../config/schemas/retrieval.js");
    expect(RetrievalRerankerSchema.parse({}).blendMode).toBe("ordering");
  });

  it("legacy admission mode drops that same candidate, which is why the default changed", async () => {
    const resolution = await routeWith("admission");

    // Discriminance control: identical embeddings, identical rerank order, one config value.
    // 0.7 * 0.99 + 0.3 * 0 = 0.693, under the 0.72 floor — rejected on rank, not on merit.
    const names = resolution.results.map((candidate) => candidate.name);
    expect(names).not.toContain("best_match");
    expect(names.length).toBeLessThan(3);
  });
});
