import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as loaderModule from "../config/loader.js";
import * as engram from "../retrieval/engram.js";
import {
  retrieveDocumentContext,
  formatDocumentContext,
  activeScopeSources,
  resolveScopeSource,
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
    vi.spyOn(engram, "engramSearch").mockResolvedValue([
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
    vi.spyOn(engram, "engramSearch").mockResolvedValue([
      { chunkId: "c3", documentId: "docC", text: "user", summary: "", keywords: [], origin: "vector", graphDistance: 0, graphProximity: 0, retrievalScore: 0.7, medianScore: 0, fusedScore: 0.7, rerankScore: 0.7 },
    ]);
    const chunks = await retrieveDocumentContext("q", { sessionId: "s1", userId: "u1" });
    expect(chunks.map((c) => c.documentId)).toEqual(["docC"]);
    spy.mockRestore();
  });

  it("returns [] when no documents are in scope (never searches other scopes)", async () => {
    const spy = mockDocRagConfig({});
    const searchSpy = vi.spyOn(engram, "engramSearch");
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
    vi.spyOn(engram, "engramSearch").mockResolvedValue([
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
});
