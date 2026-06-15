import { describe, it, expect, vi, afterEach } from "vitest";
import { rerankCandidates, type RerankerCandidate } from "../retrieval/reranker.js";
import * as loaderModule from "../config/loader.js";

const CANDIDATES: RerankerCandidate[] = [
  { id: "a", title: "Apple", content: "A fruit that grows on trees." },
  { id: "b", title: "Paris", content: "The capital city of France." },
  { id: "c", title: "Banana", content: "A long yellow fruit." },
];

function withRerankerConfig(reranker: Record<string, unknown>) {
  const realConfig = loaderModule.getConfig();
  return vi.spyOn(loaderModule, "getConfig").mockReturnValue({
    ...realConfig,
    retrieval: {
      ...realConfig.retrieval,
      reranker: { ...realConfig.retrieval.reranker, ...reranker },
    },
  } as typeof realConfig);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rerankCandidates", () => {
  it("returns null when disabled", async () => {
    const spy = withRerankerConfig({ enabled: false });
    expect(await rerankCandidates("q", CANDIDATES)).toBeNull();
    spy.mockRestore();
  });

  it("returns null when fewer than 2 candidates", async () => {
    const spy = withRerankerConfig({ enabled: true, mode: "tei" });
    expect(await rerankCandidates("q", CANDIDATES.slice(0, 1))).toBeNull();
    spy.mockRestore();
  });

  it("scores via the TEI /rerank contract and normalizes to [0,1]", async () => {
    const spy = withRerankerConfig({ enabled: true, mode: "tei", baseUrl: "http://reranker:80" });
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("http://reranker:80/rerank");
      const body = JSON.parse(String(init.body));
      expect(body.query).toBe("which fruit?");
      expect(body.texts).toHaveLength(3);
      // TEI returns [{index, score}] with raw (non-normalized) scores
      return new Response(JSON.stringify([
        { index: 0, score: 4 },
        { index: 2, score: 2 },
        { index: 1, score: 0 },
      ]), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const scores = await rerankCandidates("which fruit?", CANDIDATES);
    expect(scores).not.toBeNull();
    // min-max normalized: 4→1, 0→0, 2→0.5
    expect(scores!.get("a")).toBeCloseTo(1, 5);
    expect(scores!.get("b")).toBeCloseTo(0, 5);
    expect(scores!.get("c")).toBeCloseTo(0.5, 5);
    expect(fetchMock).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it("supports the Infinity/Cohere-style {results:[{index,relevance_score}]} shape", async () => {
    const spy = withRerankerConfig({ enabled: true, mode: "tei" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      results: [
        { index: 1, relevance_score: 0.9 },
        { index: 0, relevance_score: 0.1 },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } })));

    const scores = await rerankCandidates("q", CANDIDATES);
    expect(scores).not.toBeNull();
    expect(scores!.get("b")).toBeCloseTo(1, 5);
    expect(scores!.get("a")).toBeCloseTo(0, 5);
    spy.mockRestore();
  });

  it("returns null (keeps base order) when the TEI endpoint errors", async () => {
    const spy = withRerankerConfig({ enabled: true, mode: "tei" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    expect(await rerankCandidates("q", CANDIDATES)).toBeNull();
    spy.mockRestore();
  });

  it("scores via the LLM chat-completions contract in mode 'llm'", async () => {
    const spy = withRerankerConfig({ enabled: true, mode: "llm", baseUrl: "http://lm:1234/v1" });
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("http://lm:1234/v1/chat/completions");
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ results: [{ id: "b", score: 0.95 }, { id: "a", score: 0.2 }] }) } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const scores = await rerankCandidates("capital of france?", CANDIDATES);
    expect(scores).not.toBeNull();
    expect(scores!.get("b")).toBeCloseTo(0.95, 5);
    expect(scores!.get("a")).toBeCloseTo(0.2, 5);
    spy.mockRestore();
  });
});
