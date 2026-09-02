import { afterEach, describe, expect, it, vi } from "vitest";
import { rerankCandidates, _resetRerankerCircuitForTests, type RerankerCandidate } from "../retrieval/reranker.js";
import * as loaderModule from "../config/loader.js";

const CANDIDATES: RerankerCandidate[] = [
  { id: "a", title: "Apple", content: "A fruit." },
  { id: "b", title: "Paris", content: "A city." },
];

function withTeiReranker() {
  const real = loaderModule.getConfig();
  return vi.spyOn(loaderModule, "getConfig").mockReturnValue({
    ...real,
    retrieval: {
      ...real.retrieval,
      reranker: { ...real.retrieval.reranker, enabled: true, mode: "tei", baseUrl: "http://reranker:80", timeoutMs: 5_000, topK: 10 },
    },
  } as typeof real);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  _resetRerankerCircuitForTests();
});

/**
 * The deployed TEI sidecar answered 500 on every call. A non-2xx reply was returned as `null` —
 * which the caller recorded as a SUCCESS — so the breaker never opened and every document-RAG
 * query paid a full round trip to a reranker that could not rerank.
 */
describe("reranker breaker — a non-2xx answer is a failure", () => {
  it("opens the circuit after three 500s and stops calling the sidecar", async () => {
    withTeiReranker();
    const fetchMock = vi.fn(async () => new Response("Internal Server Error", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    for (let i = 0; i < 3; i += 1) expect(await rerankCandidates("q", CANDIDATES)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Fourth call: the circuit is open — no fetch, base order kept.
    expect(await rerankCandidates("q", CANDIDATES)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
