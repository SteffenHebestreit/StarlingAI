import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as loaderModule from "../config/loader.js";
import * as engram from "../retrieval/engram.js";

// document-rag lazily imports multimodal for byte→markdown extraction; that module
// transitively pulls the whole provider stack, which this suite has no need to load.
// Stub the single function it actually calls.
const extractMock = vi.hoisted(() => vi.fn());
vi.mock("../tools/multimodal.js", () => ({ extractDocumentBytesToMarkdown: extractMock }));
import {
  retrieveDocumentContext,
  retrieveDocumentContextWithStatus,
  augmentTurnWithDocuments,
  formatDocumentContext,
  buildInlineDocumentContext,
  isLowRetrievalConfidence,
  activeScopeSources,
  resolveScopeSource,
  callerManageableSources,
  type RetrievedChunk,
} from "../retrieval/document-rag.js";

function mockDocRagConfig(documentRag: Record<string, unknown>) {
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
        maxContextChars: 6000,
        includeUserDocs: false,
        includeWorkspaceDocs: false,
        workspaceName: "workspace",
        ...documentRag,
      },
    },
  } as typeof realConfig);
}

beforeEach(() => {
  vi.spyOn(engram, "engramConfigured").mockReturnValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** Stub the detailed search (what document-rag calls); meta defaults to the
 *  pre-v0.6.0 shape (both confidence fields absent → null). */
function mockSearch(results: engram.EngramSearchResult[] | null, meta?: Partial<engram.EngramSearchMeta>) {
  return vi.spyOn(engram, "engramSearchDetailed").mockResolvedValue(
    results === null ? null : { results, meta: { topRerankScore: null, scoreGap: null, ...meta } },
  );
}

describe("scope sources", () => {
  it("session-only by default", () => {
    const spy = mockDocRagConfig({});
    expect(activeScopeSources({ sessionId: "s1", userId: "u1" })).toEqual(["session:s1"]);
    spy.mockRestore();
  });

  it("adds user + workspace when toggled on", () => {
    const spy = mockDocRagConfig({ includeUserDocs: true, includeWorkspaceDocs: true });
    expect(activeScopeSources({ sessionId: "s1", userId: "u1" })).toEqual(["session:s1", "user:u1", "workspace:workspace"]);
    spy.mockRestore();
  });

  it("resolveScopeSource returns null for user scope without a user id", () => {
    const spy = mockDocRagConfig({});
    expect(resolveScopeSource("user", { sessionId: "s1" })).toBeNull();
    expect(resolveScopeSource("session", { sessionId: "s1" })).toBe("session:s1");
    spy.mockRestore();
  });
});

describe("retrieveDocumentContext scope filtering", () => {
  it("keeps only chunks whose document is in the active scope", async () => {
    const spy = mockDocRagConfig({});
    vi.spyOn(engram, "engramListDocuments").mockResolvedValue([
      { id: "docA", title: "A", sources: ["session:s1"], chunkCount: 2 },
      { id: "docB", title: "B", sources: ["session:other"], chunkCount: 2 },
      { id: "docC", title: "C", sources: ["user:u1"], chunkCount: 2 },
    ]);
    mockSearch([
      { chunkId: "c1", documentId: "docB", text: "off-scope", summary: "", keywords: [], origin: "vector", graphDistance: 0, graphProximity: 0, retrievalScore: 0.9, medianScore: 0, fusedScore: 0.9, rerankScore: 0.9 },
      { chunkId: "c2", documentId: "docA", text: "in-scope hit", summary: "", keywords: [], origin: "vector", graphDistance: 0, graphProximity: 0, retrievalScore: 0.8, medianScore: 0, fusedScore: 0.8, rerankScore: 0.8 },
      { chunkId: "c3", documentId: "docC", text: "user-scope (off unless toggled)", summary: "", keywords: [], origin: "vector", graphDistance: 0, graphProximity: 0, retrievalScore: 0.7, medianScore: 0, fusedScore: 0.7, rerankScore: 0.7 },
    ]);

    const chunks = await retrieveDocumentContext("q", { sessionId: "s1", userId: "u1" });
    expect(chunks.map((c) => c.documentId)).toEqual(["docA"]);
    expect(chunks[0]!.text).toBe("in-scope hit");
    spy.mockRestore();
  });

  it("includes user-scope docs when includeUserDocs is on", async () => {
    const spy = mockDocRagConfig({ includeUserDocs: true });
    vi.spyOn(engram, "engramListDocuments").mockResolvedValue([
      { id: "docA", title: "A", sources: ["session:s1"], chunkCount: 1 },
      { id: "docC", title: "C", sources: ["user:u1"], chunkCount: 1 },
    ]);
    mockSearch([
      { chunkId: "c3", documentId: "docC", text: "user", summary: "", keywords: [], origin: "vector", graphDistance: 0, graphProximity: 0, retrievalScore: 0.7, medianScore: 0, fusedScore: 0.7, rerankScore: 0.7 },
    ]);
    const chunks = await retrieveDocumentContext("q", { sessionId: "s1", userId: "u1" });
    expect(chunks.map((c) => c.documentId)).toEqual(["docC"]);
    spy.mockRestore();
  });

  it("returns [] when no documents are in scope (never searches other scopes)", async () => {
    const spy = mockDocRagConfig({});
    const searchSpy = vi.spyOn(engram, "engramSearchDetailed");
    vi.spyOn(engram, "engramListDocuments").mockResolvedValue([
      { id: "docB", title: "B", sources: ["session:other"], chunkCount: 2 },
    ]);
    const chunks = await retrieveDocumentContext("q", { sessionId: "s1" });
    expect(chunks).toEqual([]);
    expect(searchSpy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("respects retrievalTopK and minRerankScore", async () => {
    const spy = mockDocRagConfig({ retrievalTopK: 1, minRerankScore: 0.5 });
    vi.spyOn(engram, "engramListDocuments").mockResolvedValue([
      { id: "docA", title: "A", sources: ["session:s1"], chunkCount: 3 },
    ]);
    mockSearch([
      { chunkId: "c1", documentId: "docA", text: "weak", summary: "", keywords: [], origin: "vector", graphDistance: 0, graphProximity: 0, retrievalScore: 0.4, medianScore: 0, fusedScore: 0.4, rerankScore: 0.4 },
      { chunkId: "c2", documentId: "docA", text: "strong", summary: "", keywords: [], origin: "vector", graphDistance: 0, graphProximity: 0, retrievalScore: 0.9, medianScore: 0, fusedScore: 0.9, rerankScore: 0.9 },
      { chunkId: "c3", documentId: "docA", text: "also strong", summary: "", keywords: [], origin: "vector", graphDistance: 0, graphProximity: 0, retrievalScore: 0.8, medianScore: 0, fusedScore: 0.8, rerankScore: 0.8 },
    ]);
    const chunks = await retrieveDocumentContext("q", { sessionId: "s1" });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe("strong"); // weak (0.4 < 0.5) dropped, top-1 of the rest
    spy.mockRestore();
  });
});

describe("formatDocumentContext", () => {
  it("returns '' for no chunks", () => {
    expect(formatDocumentContext([])).toBe("");
  });

  it("caps at maxContextChars but always keeps at least one chunk", () => {
    const spy = mockDocRagConfig({ maxContextChars: 50 });
    const chunks: RetrievedChunk[] = [
      { chunkId: "c1", documentId: "d1", title: "Doc1", text: "x".repeat(200), score: 0.9 },
      { chunkId: "c2", documentId: "d2", title: "Doc2", text: "y".repeat(200), score: 0.8 },
    ];
    const out = formatDocumentContext(chunks);
    expect(out).toContain("Doc1");
    expect(out).not.toContain("Doc2"); // second block exceeds the cap
    spy.mockRestore();
  });

  it("demotes the framing (never the excerpts) when lowConfidence is set", () => {
    const spy = mockDocRagConfig({});
    const chunks: RetrievedChunk[] = [
      { chunkId: "c1", documentId: "d1", title: "Doc1", text: "the excerpt body", score: 0.9 },
    ];
    const normal = formatDocumentContext(chunks);
    expect(normal).toContain("authoritative source context");

    const demoted = formatDocumentContext(chunks, { lowConfidence: true });
    expect(demoted).toContain("retrieval confidence for this query was LOW");
    expect(demoted).not.toContain("authoritative source context");
    expect(demoted).toContain("the excerpt body");            // excerpts always included
    expect(demoted).toContain("Do NOT conclude");             // anti-false-negative instruction
    expect(formatDocumentContext([], { lowConfidence: true })).toBe(""); // still '' when empty
    spy.mockRestore();
  });
});

describe("isLowRetrievalConfidence (CRAG Phase 1 — docs/engram-reevaluation-2026-07.md)", () => {
  const cfgOn = { confidenceDemotion: true, confidenceMinScoreGap: 0.05, confidenceMinTopRerank: null as number | null };

  it("is false when the flag is off, whatever the signals say", () => {
    expect(isLowRetrievalConfidence({ topRerankScore: 0.01, scoreGap: 0.0 }, { ...cfgOn, confidenceDemotion: false })).toBe(false);
  });

  it("is false on null meta / null fields (older engram, <3 results) — null never demotes", () => {
    expect(isLowRetrievalConfidence(null, cfgOn)).toBe(false);
    expect(isLowRetrievalConfidence(undefined, cfgOn)).toBe(false);
    expect(isLowRetrievalConfidence({ topRerankScore: null, scoreGap: null }, cfgOn)).toBe(false);
  });

  it("demotes on a reported score_gap below the threshold, not above", () => {
    expect(isLowRetrievalConfidence({ topRerankScore: null, scoreGap: 0.01 }, cfgOn)).toBe(true);
    expect(isLowRetrievalConfidence({ topRerankScore: null, scoreGap: 0.5 }, cfgOn)).toBe(false);
  });

  it("top_rerank threshold is disabled at null and demotes below the threshold when set", () => {
    // null = disabled: a very low top score alone does not demote
    expect(isLowRetrievalConfidence({ topRerankScore: -10.7, scoreGap: 0.5 }, cfgOn)).toBe(false);
    // logit-range threshold (the shipped Qwen reranker): demote below the decision boundary
    const logit = { ...cfgOn, confidenceMinTopRerank: 0 };
    expect(isLowRetrievalConfidence({ topRerankScore: -10.7, scoreGap: 0.5 }, logit)).toBe(true);  // clearly irrelevant
    expect(isLowRetrievalConfidence({ topRerankScore: 2.9, scoreGap: 0.5 }, logit)).toBe(false);   // clearly relevant
    // sigmoid-range threshold still works (unclamped, any real value allowed)
    const sigmoid = { ...cfgOn, confidenceMinTopRerank: 0.3 };
    expect(isLowRetrievalConfidence({ topRerankScore: 0.1, scoreGap: 0.5 }, sigmoid)).toBe(true);
    expect(isLowRetrievalConfidence({ topRerankScore: 0.9, scoreGap: 0.5 }, sigmoid)).toBe(false);
    // a null score never demotes even with a threshold set
    expect(isLowRetrievalConfidence({ topRerankScore: null, scoreGap: 0.5 }, logit)).toBe(false);
  });
});

describe("retrieveDocumentContextWithStatus confidence threading", () => {
  const docs = [{ id: "docA", title: "A", sources: ["session:s1"], chunkCount: 1 }];
  const hits = [
    { chunkId: "c1", documentId: "docA", text: "hit", summary: "", keywords: [], origin: "vector", graphDistance: 0, graphProximity: 0, retrievalScore: 0.8, medianScore: 0, fusedScore: 0.8, rerankScore: 0.8 },
  ];

  it("reports lowConfidence when the flag is on and the gap is weak", async () => {
    const spy = mockDocRagConfig({ confidenceDemotion: true, confidenceMinScoreGap: 0.05, confidenceMinTopRerank: 0 });
    vi.spyOn(engram, "engramListDocuments").mockResolvedValue(docs);
    mockSearch(hits, { scoreGap: 0.01 });
    const outcome = await retrieveDocumentContextWithStatus("q", { sessionId: "s1" });
    expect(outcome.lowConfidence).toBe(true);
    expect(outcome.chunks).toHaveLength(1); // chunks still returned — demote, never suppress
    expect(outcome.retrievalFailed).toBe(false);
    spy.mockRestore();
  });

  it("stays false with the flag off (default) and on pre-v0.6.0 servers (null meta fields)", async () => {
    const flagOff = mockDocRagConfig({ confidenceDemotion: false });
    vi.spyOn(engram, "engramListDocuments").mockResolvedValue(docs);
    mockSearch(hits, { scoreGap: 0.01 });
    expect((await retrieveDocumentContextWithStatus("q", { sessionId: "s1" })).lowConfidence).toBe(false);
    flagOff.mockRestore();
    vi.restoreAllMocks();
    vi.spyOn(engram, "engramConfigured").mockReturnValue(true);

    const flagOn = mockDocRagConfig({ confidenceDemotion: true });
    vi.spyOn(engram, "engramListDocuments").mockResolvedValue(docs);
    mockSearch(hits); // meta defaults: both null
    expect((await retrieveDocumentContextWithStatus("q", { sessionId: "s1" })).lowConfidence).toBe(false);
    flagOn.mockRestore();
  });

  it("search failure reports retrievalFailed, never lowConfidence", async () => {
    const spy = mockDocRagConfig({ confidenceDemotion: true });
    vi.spyOn(engram, "engramListDocuments").mockResolvedValue(docs);
    mockSearch(null);
    const outcome = await retrieveDocumentContextWithStatus("q", { sessionId: "s1" });
    expect(outcome.retrievalFailed).toBe(true);
    expect(outcome.lowConfidence).toBe(false);
    spy.mockRestore();
  });
});

describe("serverSideScopeFilter (engram sources-filter spec pre-wiring)", () => {
  const docs = [{ id: "docA", title: "A", sources: ["session:s1"], chunkCount: 1 }];
  const hits = [
    { chunkId: "c1", documentId: "docA", text: "hit", summary: "", keywords: [], origin: "vector", graphDistance: 0, graphProximity: 0, retrievalScore: 0.8, medianScore: 0, fusedScore: 0.8, rerankScore: 0.8 },
  ];

  it("does NOT send sources when the flag is off (default)", async () => {
    const spy = mockDocRagConfig({});
    vi.spyOn(engram, "engramListDocuments").mockResolvedValue(docs);
    const searchSpy = mockSearch(hits);
    await retrieveDocumentContextWithStatus("q", { sessionId: "s1" });
    expect(searchSpy).toHaveBeenCalledTimes(1);
    expect(searchSpy.mock.calls[0]![0]).not.toHaveProperty("sources");
    spy.mockRestore();
  });

  it("sends the active scope sources when the flag is on, and the post-filter still applies", async () => {
    const spy = mockDocRagConfig({ serverSideScopeFilter: true, includeUserDocs: true });
    vi.spyOn(engram, "engramListDocuments").mockResolvedValue([
      ...docs,
      { id: "docB", title: "B", sources: ["session:other"], chunkCount: 1 },
    ]);
    const searchSpy = mockSearch([
      ...hits,
      // Simulate a non-conforming server leaking an off-scope hit: the client
      // post-filter (defense-in-depth) must still drop it.
      { chunkId: "c9", documentId: "docB", text: "leak", summary: "", keywords: [], origin: "vector", graphDistance: 0, graphProximity: 0, retrievalScore: 0.9, medianScore: 0, fusedScore: 0.9, rerankScore: 0.9 },
    ]);
    const outcome = await retrieveDocumentContextWithStatus("q", { sessionId: "s1", userId: "u1" });
    expect(searchSpy.mock.calls[0]![0]).toMatchObject({ sources: ["session:s1", "user:u1"] });
    expect(outcome.chunks.map((c) => c.documentId)).toEqual(["docA"]); // leak dropped client-side
    spy.mockRestore();
  });
});

describe("buildInlineDocumentContext (audit ef9bd480 — inline a small attached doc whole)", () => {
  const offer = [{ title: "ANGEBOT.PDF", text: "Testing & QA 20 Std 1.900€\nZwischensumme 248 Std\nGesamtpreis 40.000€" }];

  it("is null when the flag is off (default) — keeps today's semantic-excerpt path", () => {
    expect(buildInlineDocumentContext(offer, { inlineSmallDocuments: false, inlineThresholdChars: 12000 })).toBeNull();
  });

  it("inlines the FULL text verbatim for a small doc when enabled", () => {
    const out = buildInlineDocumentContext(offer, { inlineSmallDocuments: true, inlineThresholdChars: 12000 });
    expect(out).not.toBeNull();
    // The page-2 rows the model wrongly called 'missing' are present verbatim.
    expect(out!).toContain("Testing & QA 20 Std 1.900€");
    expect(out!).toContain("Gesamtpreis 40.000€");
    expect(out!).toContain("[Doc: ANGEBOT.PDF — full text]");
    expect(out!).toContain("COMPLETE text");
    expect(out!).toMatch(/Do NOT claim .* is absent/);
  });

  it("falls back to retrieval (null) when the combined text exceeds the threshold", () => {
    const big = [{ title: "BIG.PDF", text: "x".repeat(13000) }];
    expect(buildInlineDocumentContext(big, { inlineSmallDocuments: true, inlineThresholdChars: 12000 })).toBeNull();
  });

  it("is null when nothing was attached this turn", () => {
    expect(buildInlineDocumentContext([], { inlineSmallDocuments: true, inlineThresholdChars: 12000 })).toBeNull();
  });

  it("sums across multiple attached docs for the threshold", () => {
    const two = [{ title: "A", text: "a".repeat(7000) }, { title: "B", text: "b".repeat(7000) }];
    // 14000 > 12000 → fall back; both are this-turn docs and would otherwise be inlined together.
    expect(buildInlineDocumentContext(two, { inlineSmallDocuments: true, inlineThresholdChars: 12000 })).toBeNull();
    const out = buildInlineDocumentContext(two, { inlineSmallDocuments: true, inlineThresholdChars: 20000 });
    expect(out!).toContain("[Doc: A — full text]");
    expect(out!).toContain("[Doc: B — full text]");
  });
});

describe("callerManageableSources — document management scope isolation", () => {
  beforeEach(() => mockDocRagConfig({ workspaceName: "acme" }));
  afterEach(() => vi.restoreAllMocks());

  it("always includes the shared workspace corpus", () => {
    const set = callerManageableSources({});
    expect(set.has("workspace:acme")).toBe(true);
    expect(set.size).toBe(1);
  });

  it("adds the caller's own user + session corpora when known", () => {
    const set = callerManageableSources({ userId: "alice", sessionId: "sess-1" });
    expect([...set].sort()).toEqual(["session:sess-1", "user:alice", "workspace:acme"]);
  });

  it("never exposes another user's or another session's sources", () => {
    const alice = callerManageableSources({ userId: "alice", sessionId: "s-a" });
    // Documents owned by bob / a different session must not intersect alice's set.
    expect(alice.has("user:bob")).toBe(false);
    expect(alice.has("session:s-b")).toBe(false);
    // The gateway filter is `doc.sources.some(s => manageable.has(s))`:
    const bobDoc = ["user:bob"];
    const sharedDoc = ["workspace:acme", "user:bob"];
    expect(bobDoc.some((s) => alice.has(s))).toBe(false);
    expect(sharedDoc.some((s) => alice.has(s))).toBe(true); // shared workspace copy still visible
  });
});

describe("augmentTurnWithDocuments — retrieval-failure is not grounding", () => {
  // Regression (session 5d9136bd turn 2): an engram TIMEOUT injected the
  // "[DOCUMENT RETRIEVAL UNAVAILABLE]" placeholder as a non-empty contextBlock, which the caller
  // counted as documentRagFoundDocs=true — silently disarming the whole source-sensitivity honesty
  // stack so memory-recited opening hours shipped as fact. The failure placeholder must report
  // retrievalUnavailable:true so the caller does NOT treat it as document grounding.
  it("marks the unavailable placeholder as retrievalUnavailable (not grounding)", async () => {
    const cfg = mockDocRagConfig({ injectContext: true, autoIngestAttachments: false });
    mockSearch(null); // engram unreachable / timed out → retrievalFailed, no chunks
    const aug = await augmentTurnWithDocuments({
      ctx: { sessionId: "s-fail", userId: "u1" },
      workspacePath: "/workspace",
      query: "welche Familienaktivitäten gibt es in Hamburg",
      attachments: [],
    });
    expect(aug.contextBlock).toContain("DOCUMENT RETRIEVAL UNAVAILABLE");
    expect(aug.retrievalUnavailable).toBe(true);
    cfg.mockRestore();
  });

  it("real retrieved content is grounding, not flagged unavailable", async () => {
    // Contrast: engram RESPONDED with a real document hit → the answer IS grounded in the user's
    // own document, so retrievalUnavailable stays false and the honesty stack treats it as grounded,
    // exactly as before. Only a retrieval FAILURE (previous test) must flip the flag.
    const cfg = mockDocRagConfig({ injectContext: true, autoIngestAttachments: false });
    vi.spyOn(engram, "engramListDocuments").mockResolvedValue([
      { id: "docA", title: "CV", sources: ["session:s-ok"], chunkCount: 1 },
    ]);
    mockSearch([
      { chunkId: "c1", documentId: "docA", text: "8 years of backend engineering.", summary: "", keywords: [], origin: "vector", graphDistance: 0, graphProximity: 0, retrievalScore: 0.8, medianScore: 0, fusedScore: 0.8, rerankScore: 0.8 },
    ]);
    const aug = await augmentTurnWithDocuments({
      ctx: { sessionId: "s-ok" },
      workspacePath: "/workspace",
      query: "what is my background",
      attachments: [],
    });
    expect(aug.retrievalUnavailable).toBe(false);
    expect(aug.contextBlock).not.toContain("DOCUMENT RETRIEVAL UNAVAILABLE");
    expect(aug.contextBlock.length).toBeGreaterThan(0);
    cfg.mockRestore();
  });
});

describe("augmentTurnWithDocuments — attachments come from the object store", () => {
  // Chat attachments are persisted with scanAndStoreUpload → putUpload, and under
  // `storage.backend: "s3"` (the bundled compose DEFAULT) putUpload writes to S3 and
  // NOTHING lands on the workspace disk. Auto-ingest used a bare readFile, so on every
  // default deployment the attachment ENOENTed, `failed` was incremented, and the turn
  // continued with no document context AND no signal anywhere — the user attaches a CV
  // and the model answers as if nothing were attached.
  const attachment = [{ filename: "cv.pdf", relativePath: "uploads/s-att/1786-cv.pdf", contentType: "application/pdf" }];

  it("reads an attachment through the object store when it is not on disk", async () => {
    const cfg = mockDocRagConfig({ injectContext: true, autoIngestAttachments: true, inlineSmallDocuments: true, inlineThresholdChars: 20000 });
    const store = await import("../storage/object-store.js");
    // Present in the store, absent from the workspace disk — the S3 deployment shape.
    const getUpload = vi.spyOn(store, "getUpload").mockResolvedValue(new Uint8Array([1, 2, 3]));
    // Stub the rest of the ingest chain so the test isolates the READ path.
    extractMock.mockResolvedValue("Jane Doe — Senior Engineer, 2019–2024.");
    vi.spyOn(engram, "engramIngest").mockResolvedValue({ documentId: "doc-cv", chunkCount: 1 } as never);
    const registry = await import("../retrieval/document-registry.js");
    vi.spyOn(registry, "registerDocument").mockResolvedValue(undefined as never);

    const aug = await augmentTurnWithDocuments({
      ctx: { sessionId: "s-att" },
      workspacePath: "/nonexistent-workspace",
      query: "update my cv",
      attachments: attachment,
    });

    expect(getUpload).toHaveBeenCalledWith("uploads/s-att/1786-cv.pdf");
    expect(aug.ingested).toBe(1);
    expect(aug.failed).toBe(0);
    expect(aug.contextBlock).toContain("Jane Doe");
    cfg.mockRestore();
  });

  it("tells the model when an attachment could not be read instead of staying silent", async () => {
    const cfg = mockDocRagConfig({ injectContext: true, autoIngestAttachments: true });
    const store = await import("../storage/object-store.js");
    vi.spyOn(store, "getUpload").mockResolvedValue(null); // not in the store either
    mockSearch([]);

    const aug = await augmentTurnWithDocuments({
      ctx: { sessionId: "s-att" },
      workspacePath: "/nonexistent-workspace",
      query: "update my cv",
      attachments: attachment,
    });

    expect(aug.failed).toBe(1);
    // The whole point: a failed attachment must be VISIBLE in the turn context, so the
    // model cannot answer from memory or claim the user attached nothing.
    expect(aug.contextBlock).toContain("ATTACHMENT NOT READABLE");
    expect(aug.contextBlock).toContain("cv.pdf");
    // ...but the notice is NOT grounding. The caller reads contextBlock together with
    // retrievalUnavailable to set documentRagFoundDocs; a non-empty block whose only
    // content is "we could not read your file" previously flipped that true and
    // disarmed the source-sensitivity classifier and both ungrounded-factual guards.
    expect(aug.retrievalUnavailable).toBe(true);
    cfg.mockRestore();
  });
});
