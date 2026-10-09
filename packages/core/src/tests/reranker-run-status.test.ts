/**
 * Reranker run status: did reranking actually take part in this process's scores?
 *
 * This matters because the routing admission floor is applied AFTER the rerank blend
 * (`combinedScore * 0.7 + rerankScore * 0.3`). A run the reranker sat out therefore scores a
 * different pipeline from production — same catalog, same query, different absolute numbers
 * against a fixed 0.72 gate. Measured on this repo's own stack: the sidecar sits on an
 * internal docker network, so every canary and eval run from a developer machine was
 * pre-blend while production was post-blend, and nothing in either report said so.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetRerankerCircuitForTests,
  getRerankerRunStatus,
  rerankCandidates,
  type RerankerCandidate,
} from "../retrieval/reranker.js";
import * as loaderModule from "../config/loader.js";

const CANDIDATES: RerankerCandidate[] = [
  { id: "a", title: "Apple", content: "A fruit that grows on trees." },
  { id: "b", title: "Paris", content: "The capital city of France." },
];

function withRerankerConfig(reranker: Record<string, unknown>) {
  const realConfig = loaderModule.getConfig();
  return vi.spyOn(loaderModule, "getConfig").mockReturnValue({
    ...realConfig,
    retrieval: { ...realConfig.retrieval, reranker: { ...realConfig.retrieval.reranker, ...reranker } },
  } as typeof realConfig);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  _resetRerankerCircuitForTests();
});

describe("reranker run status", () => {
  it("counts an unreachable backend as failed, never as applied", async () => {
    withRerankerConfig({ enabled: true, mode: "tei", baseUrl: "http://reranker:80" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("fetch failed"); }));

    expect(await rerankCandidates("q", CANDIDATES)).toBeNull();

    const status = getRerankerRunStatus();
    expect(status.enabled).toBe(true);
    expect(status.attempted).toBe(1);
    // The number that decides whether a run is comparable to production.
    expect(status.applied).toBe(0);
    expect(status.failed).toBe(1);
    expect(status.lastError).toContain("fetch failed");
  });

  it("counts a successful rerank as applied, so a healthy run is not flagged", async () => {
    withRerankerConfig({ enabled: true, mode: "tei", baseUrl: "http://reranker:80", topK: 6 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify([{ index: 0, score: 0.9 }, { index: 1, score: 0.1 }]),
      { status: 200, headers: { "content-type": "application/json" } },
    )));

    const scores = await rerankCandidates("q", CANDIDATES);
    expect(scores).not.toBeNull();

    // Discriminance control for the case above: same code path, reachable backend.
    const status = getRerankerRunStatus();
    expect(status.applied).toBe(1);
    expect(status.failed).toBe(0);
    expect(status.lastError).toBeUndefined();
  });

  it("separates circuit-open skips from attempts, so a cooled-down run is not read as healthy", async () => {
    withRerankerConfig({ enabled: true, mode: "tei", baseUrl: "http://reranker:80" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connection refused"); }));

    // Three consecutive failures open the circuit; everything after is skipped, not attempted.
    for (let i = 0; i < 6; i += 1) await rerankCandidates("q", CANDIDATES);

    const status = getRerankerRunStatus();
    expect(status.applied).toBe(0);
    expect(status.circuitOpen).toBe(true);
    expect(status.skippedCircuitOpen).toBeGreaterThan(0);
    // Counting a skip as an attempt would understate how thoroughly the reranker was absent.
    expect(status.attempted + status.skippedCircuitOpen).toBe(6);
  });

  it("reports disabled without inventing attempts", async () => {
    withRerankerConfig({ enabled: false });
    expect(await rerankCandidates("q", CANDIDATES)).toBeNull();

    const status = getRerankerRunStatus();
    expect(status.enabled).toBe(false);
    expect(status.attempted).toBe(0);
    expect(status.applied).toBe(0);
    // "Not configured" and "configured but never answered" are different situations, and only
    // the second one should stop a baseline from being recorded.
    expect(status.failed).toBe(0);
  });
});
