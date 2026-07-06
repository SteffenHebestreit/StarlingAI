import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as loaderModule from "../config/loader.js";
import * as engram from "../retrieval/engram.js";
import { searchKnowledgeBase } from "../retrieval/document-rag.js";
import {
  kbDocumentId,
  ambientKbSources,
  invalidateAmbientKbCache,
  createKnowledgeBase,
  mutateKnowledgeBase,
  kbSource,
  type KnowledgeBaseRecord,
} from "../retrieval/knowledge-bases.js";

// searchKnowledgeBase — KB-scoped retrieval with engram mocked, mirroring
// document-rag.test.ts's config + engram spy approach.

function mockDocRagConfig(documentRag: Record<string, unknown> = {}) {
  const realConfig = loaderModule.getConfig();
  return vi.spyOn(loaderModule, "getConfig").mockReturnValue({
    ...realConfig,
    retrieval: {
      ...realConfig.retrieval,
      documentRag: {
        ...realConfig.retrieval.documentRag,
        enabled: true,
        retrievalTopK: 6,
        candidateTopK: 30,
        minRerankScore: 0,
        confidenceDemotion: false,
        ...documentRag,
      },
    },
  } as typeof realConfig);
}

function mockSearch(results: engram.EngramSearchResult[] | null, meta?: Partial<engram.EngramSearchMeta>) {
  return vi.spyOn(engram, "engramSearchDetailed").mockResolvedValue(
    results === null ? null : { results, meta: { topRerankScore: null, scoreGap: null, ...meta } },
  );
}

function hit(chunkId: string, documentId: string, text: string, score: number): engram.EngramSearchResult {
  return {
    chunkId, documentId, text,
    summary: "", keywords: [], origin: "vector", graphDistance: 0, graphProximity: 0,
    retrievalScore: score, medianScore: 0, fusedScore: score, rerankScore: score,
  };
}

interface PageSpec { documentId: string; url: string; title?: string }

function kb(pages: PageSpec[]): KnowledgeBaseRecord {
  const now = new Date().toISOString();
  const pageMap: KnowledgeBaseRecord["pages"] = {};
  for (const p of pages) {
    pageMap[p.url] = {
      documentId: p.documentId,
      url: p.url,
      ...(p.title ? { title: p.title } : {}),
      contentHash: "h",
      lastIngestedAt: now,
      lastSeenAt: now,
    };
  }
  return {
    id: "docs", name: "Docs", seedUrls: ["https://example.com/docs/"],
    maxPages: 100, maxDepth: 3, sameOriginOnly: true, respectRobots: true, ambientRetrieval: false,
    createdAt: now, updatedAt: now, status: "ready", pages: pageMap,
  };
}

const pageA: PageSpec = { documentId: kbDocumentId("docs", "https://example.com/docs/a"), url: "https://example.com/docs/a", title: "Page A" };
const pageB: PageSpec = { documentId: kbDocumentId("docs", "https://example.com/docs/b"), url: "https://example.com/docs/b" }; // no title

beforeEach(() => {
  vi.spyOn(engram, "engramConfigured").mockReturnValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("searchKnowledgeBase", () => {
  it("returns empty without calling engram for a KB with no crawled pages", async () => {
    mockDocRagConfig();
    const searchSpy = vi.spyOn(engram, "engramSearchDetailed");
    const outcome = await searchKnowledgeBase(kb([]), "how do I frobnicate?");
    expect(outcome).toEqual({ chunks: [], retrievalFailed: false, lowConfidence: false });
    expect(searchSpy).not.toHaveBeenCalled();
  });

  it("returns empty without calling engram for a blank query or unconfigured engram", async () => {
    mockDocRagConfig();
    const searchSpy = vi.spyOn(engram, "engramSearchDetailed");
    expect(await searchKnowledgeBase(kb([pageA]), "   ")).toEqual({ chunks: [], retrievalFailed: false, lowConfidence: false });
    vi.spyOn(engram, "engramConfigured").mockReturnValue(false);
    expect(await searchKnowledgeBase(kb([pageA]), "q")).toEqual({ chunks: [], retrievalFailed: false, lowConfidence: false });
    expect(searchSpy).not.toHaveBeenCalled();
  });

  it("reports retrievalFailed when engram search returns null", async () => {
    mockDocRagConfig();
    mockSearch(null);
    const outcome = await searchKnowledgeBase(kb([pageA]), "q");
    expect(outcome.retrievalFailed).toBe(true);
    expect(outcome.chunks).toEqual([]);
    expect(outcome.lowConfidence).toBe(false);
  });

  it("always sends the KB source filter and a generous finalTopK", async () => {
    mockDocRagConfig();
    const searchSpy = mockSearch([hit("c1", pageA.documentId, "hit", 0.9)]);
    await searchKnowledgeBase(kb([pageA]), "q");
    expect(searchSpy).toHaveBeenCalledTimes(1);
    expect(searchSpy.mock.calls[0]![0]).toMatchObject({
      query: "q",
      sources: ["kb:docs"],
      finalTopK: 30, // max(candidateTopK=30, limit*3=18)
    });
  });

  it("filters out off-KB documentIds (older engram without the sources filter)", async () => {
    mockDocRagConfig();
    mockSearch([
      hit("c1", "some-user-doc", "cross-corpus leak", 0.95),
      hit("c2", pageA.documentId, "in-KB hit", 0.8),
    ]);
    const outcome = await searchKnowledgeBase(kb([pageA]), "q");
    expect(outcome.chunks.map((c) => c.documentId)).toEqual([pageA.documentId]);
    expect(outcome.chunks[0]!.text).toBe("in-KB hit");
  });

  it("respects minRerankScore", async () => {
    mockDocRagConfig({ minRerankScore: 0.5 });
    mockSearch([
      hit("c1", pageA.documentId, "weak", 0.4),
      hit("c2", pageA.documentId, "strong", 0.9),
    ]);
    const outcome = await searchKnowledgeBase(kb([pageA]), "q");
    expect(outcome.chunks.map((c) => c.text)).toEqual(["strong"]);
  });

  it("attaches url/title from the KB's pages map and the kb: source token", async () => {
    mockDocRagConfig();
    mockSearch([
      hit("c1", pageA.documentId, "titled hit", 0.9),
      hit("c2", pageB.documentId, "untitled hit", 0.8),
    ]);
    const outcome = await searchKnowledgeBase(kb([pageA, pageB]), "q");
    expect(outcome.chunks).toEqual([
      {
        chunkId: "c1",
        documentId: pageA.documentId,
        title: "Page A",
        source: "kb:docs",
        url: "https://example.com/docs/a",
        text: "titled hit",
        score: 0.9,
      },
      {
        chunkId: "c2",
        documentId: pageB.documentId,
        source: "kb:docs",
        url: "https://example.com/docs/b",
        text: "untitled hit",
        score: 0.8,
      },
    ]);
    expect(outcome.chunks[1]!.title).toBeUndefined(); // page without a crawled title
  });

  it("trims to topK (and clamps a nonsense topK up to 1)", async () => {
    mockDocRagConfig();
    const hits = [
      hit("c1", pageA.documentId, "first", 0.9),
      hit("c2", pageA.documentId, "second", 0.8),
      hit("c3", pageA.documentId, "third", 0.7),
    ];
    mockSearch(hits);
    const two = await searchKnowledgeBase(kb([pageA]), "q", 2);
    expect(two.chunks.map((c) => c.chunkId)).toEqual(["c1", "c2"]);

    mockSearch(hits);
    const clamped = await searchKnowledgeBase(kb([pageA]), "q", 0);
    expect(clamped.chunks).toHaveLength(1);
  });

  it("threads the CRAG lowConfidence signal (demote, never suppress)", async () => {
    mockDocRagConfig({ confidenceDemotion: true, confidenceMinScoreGap: 0.05, confidenceMinTopRerank: null });
    mockSearch([hit("c1", pageA.documentId, "hit", 0.9)], { scoreGap: 0.01 });
    const outcome = await searchKnowledgeBase(kb([pageA]), "q");
    expect(outcome.lowConfidence).toBe(true);
    expect(outcome.chunks).toHaveLength(1); // chunks still returned
    expect(outcome.retrievalFailed).toBe(false);
  });
});

// ── ambientKbSources — the per-turn [DOCUMENT CONTEXT] union, scope-filtered ──
// Runs over a real temp-workspace registry (the manifest, not engram): the
// per-caller access filter is applied to a short-TTL descriptor snapshot, so the
// SAME snapshot yields different in-scope sets for different callers. The module
// cache must be invalidated per test (it persists across temp workspaces).

describe("ambientKbSources — scope filtering", () => {
  let workspacePath: string;

  beforeEach(() => {
    workspacePath = mkdtempSync(join(tmpdir(), "starlingai-kb-ambient-"));
    const realConfig = loaderModule.getConfig();
    vi.spyOn(loaderModule, "getConfig").mockReturnValue({
      ...realConfig,
      workspacePath,
      retrieval: {
        ...realConfig.retrieval,
        knowledgeBases: { ...realConfig.retrieval.knowledgeBases, enabled: true },
      },
    } as typeof realConfig);
    invalidateAmbientKbCache(); // module-level snapshot must not leak across temp workspaces
  });

  afterEach(() => {
    rmSync(workspacePath, { recursive: true, force: true });
  });

  /** Create a KB and mark it ready (ambient eligibility needs status "ready"). */
  async function ready(input: Parameters<typeof createKnowledgeBase>[0]): Promise<string> {
    const res = await createKnowledgeBase(input);
    if (!res.ok) throw new Error(res.error);
    await mutateKnowledgeBase(res.value.id, (r) => { r.status = "ready"; });
    return res.value.id;
  }

  it("returns only ready + ambient + accessible KBs, filtered per caller from one snapshot", async () => {
    const wsId = await ready({ name: "WS Ambient", seedUrls: ["https://example.com/a"], ambientRetrieval: true });
    const userId = await ready({ name: "User Ambient", seedUrls: ["https://example.com/b"], ambientRetrieval: true, scope: "user", ownerId: "u1" });
    const sessId = await ready({ name: "Session Ambient", seedUrls: ["https://example.com/c"], ambientRetrieval: true, scope: "session", sessionId: "s1" });
    // ready but ambient OFF — never joins the union
    await ready({ name: "WS Explicit", seedUrls: ["https://example.com/d"], ambientRetrieval: false });
    // ambient ON but NOT ready — excluded
    const notReady = await createKnowledgeBase({ name: "Crawling Ambient", seedUrls: ["https://example.com/e"], ambientRetrieval: true });
    expect(notReady.ok).toBe(true);

    // Owner of the user KB, inside its session → sees all three ambient-ready KBs.
    expect((await ambientKbSources({ userId: "u1", sessionId: "s1" })).sort())
      .toEqual([kbSource(wsId), kbSource(userId), kbSource(sessId)].sort());

    // Same cached descriptor snapshot, different caller → different in-scope set.
    expect((await ambientKbSources({ userId: "u1" })).sort())
      .toEqual([kbSource(wsId), kbSource(userId)].sort()); // no session → session KB drops

    expect(await ambientKbSources({ userId: "u2", sessionId: "s2" }))
      .toEqual([kbSource(wsId)]); // foreign user + foreign session → workspace only

    expect(await ambientKbSources({})).toEqual([kbSource(wsId)]); // anonymous → workspace only
  });

  it("a user-scoped ambient KB still needs to be ready, and only its owner ever sees it", async () => {
    const created = await createKnowledgeBase({ name: "User Not Ready", seedUrls: ["https://example.com/x"], ambientRetrieval: true, scope: "user", ownerId: "u1" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // idle → not ambient-eligible yet, even for the owner
    expect(await ambientKbSources({ userId: "u1" })).toEqual([]);
    await mutateKnowledgeBase(created.value.id, (r) => { r.status = "ready"; });
    expect(await ambientKbSources({ userId: "u1" })).toEqual([kbSource(created.value.id)]);
    expect(await ambientKbSources({ userId: "u2" })).toEqual([]); // owner-only, even when ready
  });
});
