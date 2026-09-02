import { afterEach, describe, expect, it, vi } from "vitest";
import { rerankCandidates, _resetRerankerCircuitForTests, type RerankerCandidate } from "../retrieval/reranker.js";
import * as loaderModule from "../config/loader.js";

const CANDIDATES: RerankerCandidate[] = [
  { id: "a", title: "Apple", content: "A fruit." },
  { id: "b", title: "Paris", content: "A city." },
];

function withReranker(mode: "tei" | "llm") {
  const real = loaderModule.getConfig();
  return vi.spyOn(loaderModule, "getConfig").mockReturnValue({
    ...real,
    retrieval: {
      ...real.retrieval,
      reranker: { ...real.retrieval.reranker, enabled: true, mode, baseUrl: "http://reranker:80", timeoutMs: 5_000, topK: 10 },
    },
  } as typeof real);
}

const answering = (status: number) => vi.fn(async () => new Response("nope", { status }));

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
describe("reranker breaker — a 5xx answer is a failure, in both backends", () => {
  for (const mode of ["tei", "llm"] as const) {
    it(`${mode}: opens the circuit after three 500s and stops calling the sidecar`, async () => {
      withReranker(mode);
      const fetchMock = answering(500);
      vi.stubGlobal("fetch", fetchMock);

      for (let i = 0; i < 3; i += 1) expect(await rerankCandidates("q", CANDIDATES)).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(3);

      // Fourth call: the circuit is open — no fetch, base order kept.
      expect(await rerankCandidates("q", CANDIDATES)).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  }

  it("a per-request 4xx keeps base order for that query but is not a health signal", async () => {
    // The sidecar is up and answering; it refused THIS request (payload too large, bad model
    // name). Counting it would open the circuit for every other query.
    withReranker("tei");
    const fetchMock = answering(413);
    vi.stubGlobal("fetch", fetchMock);

    for (let i = 0; i < 4; i += 1) expect(await rerankCandidates("q", CANDIDATES)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
