/**
 * End-to-end crawl-loop tests: drive runCrawl (via startKbCrawl) with a stubbed
 * global fetch and a mocked engram, over a temp-dir registry. Covers the crawl
 * state machine the pure-helper tests can't — in particular the orphan-cleanup
 * regression where a page that merely FAILED transiently on a re-crawl must NOT
 * be deleted as if it had been removed from the site.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as loaderModule from "../config/loader.js";

// engram: configured + record ingest/delete calls.
const ingestCalls: Array<{ documentId?: string; source: string }> = [];
const deleteCalls: string[] = [];
vi.mock("../retrieval/engram.js", () => ({
  engramConfigured: () => true,
  engramIngest: vi.fn(async (input: { text: string; source: string; documentId?: string }) => {
    ingestCalls.push({ documentId: input.documentId, source: input.source });
    return { documentId: input.documentId ?? "doc", chunkCount: 3, keywords: [] };
  }),
  engramDeleteDocument: vi.fn(async (documentId: string) => {
    deleteCalls.push(documentId);
    return true;
  }),
}));

// Force the built-in HTML→markdown fallback (no conversion service in tests).
vi.mock("../tools/multimodal.js", () => ({
  extractDocumentBytesToMarkdown: vi.fn(async () => ""),
}));

import { startKbCrawl, isCrawlActive } from "../retrieval/kb-crawler.js";
import { createKnowledgeBase, getKnowledgeBase } from "../retrieval/knowledge-bases.js";

let workspacePath: string;

interface Route { status?: number; body?: string; contentType?: string }
let routes: Map<string, Route>;

function installFetchStub() {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const route = routes.get(url);
    if (!route) return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
    return new Response(route.body ?? "", {
      status: route.status ?? 200,
      headers: { "content-type": route.contentType ?? "text/html" },
    });
  }));
}

beforeEach(() => {
  ingestCalls.length = 0;
  deleteCalls.length = 0;
  routes = new Map();
  workspacePath = mkdtempSync(join(tmpdir(), "starlingai-kb-crawl-"));
  const realConfig = loaderModule.getConfig();
  vi.spyOn(loaderModule, "getConfig").mockReturnValue({
    ...realConfig,
    workspacePath,
    retrieval: {
      ...realConfig.retrieval,
      knowledgeBases: {
        ...realConfig.retrieval.knowledgeBases,
        enabled: true,
        allowPrivateHosts: true, // skip SSRF/DNS in tests
        requestDelayMs: 0,
        concurrency: 1,
        pageTimeoutMs: 5000,
        maxCrawlMs: 60_000,
        maxConcurrentCrawls: 2,
        maxPageBytes: 5_000_000,
        defaultMaxPages: 150,
        maxPagesCap: 1000,
        defaultMaxDepth: 4,
        maxDepthCap: 8,
      },
    },
  } as typeof realConfig);
  installFetchStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(workspacePath, { recursive: true, force: true });
});

async function crawlAndWait(id: string): Promise<void> {
  const started = await startKbCrawl(id);
  if (!started.ok) throw new Error(`startKbCrawl failed: ${started.error}`);
  // The harness's patience, not the property under test. Ten seconds holds when this file runs
  // alone and does not under the full suite with v8 coverage instrumentation and parallel
  // workers — it failed there once, on "prunes a page that genuinely disappeared", and passed
  // in isolation and on the immediate re-run. CI is slower and busier than a dev box, so the
  // bound is set where only a genuinely stuck crawl can reach it.
  const deadline = Date.now() + 30_000;
  for (;;) {
    const kb = await getKnowledgeBase(id);
    if (kb && kb.status !== "crawling" && !isCrawlActive(id)) return;
    if (Date.now() > deadline) throw new Error("crawl did not finish in time");
    await new Promise((r) => setTimeout(r, 15));
  }
}

function htmlPage(title: string, links: string[] = []): string {
  const anchors = links.map((l) => `<a href="${l}">${l}</a>`).join("\n");
  return `<html><head><title>${title}</title></head><body><h1>${title}</h1><p>Body text for ${title}.</p>${anchors}</body></html>`;
}

describe("runCrawl (stubbed fetch)", () => {
  it("crawls the seed and its in-scope links, ingesting each page", async () => {
    routes.set("https://example.com/docs/", { body: htmlPage("Index", ["https://example.com/docs/a", "https://example.com/docs/b"]) });
    routes.set("https://example.com/docs/a", { body: htmlPage("Page A") });
    routes.set("https://example.com/docs/b", { body: htmlPage("Page B") });

    const created = await createKnowledgeBase({ name: "Docs", seedUrls: ["https://example.com/docs/"], respectRobots: false });
    if (!created.ok) throw new Error(created.error);
    await crawlAndWait(created.value.id);

    const kb = await getKnowledgeBase(created.value.id);
    expect(kb?.status).toBe("ready");
    const urls = Object.keys(kb!.pages).sort();
    expect(urls).toEqual([
      "https://example.com/docs/",
      "https://example.com/docs/a",
      "https://example.com/docs/b",
    ]);
    expect(kb!.lastCrawl?.pagesIngested).toBe(3);
    expect(ingestCalls.length).toBe(3);
    // Every KB document is ingested under exactly the kb:<id> source.
    expect(ingestCalls.every((c) => c.source === `kb:${created.value.id}`)).toBe(true);
  });

  it("does NOT prune a previously-indexed page that only failed transiently this run", async () => {
    // First crawl: index → a, b, all 200.
    routes.set("https://example.com/docs/", { body: htmlPage("Index", ["https://example.com/docs/a", "https://example.com/docs/b"]) });
    routes.set("https://example.com/docs/a", { body: htmlPage("Page A v1") });
    routes.set("https://example.com/docs/b", { body: htmlPage("Page B v1") });

    const created = await createKnowledgeBase({ name: "Docs", seedUrls: ["https://example.com/docs/"], respectRobots: false });
    if (!created.ok) throw new Error(created.error);
    await crawlAndWait(created.value.id);

    const afterFirst = await getKnowledgeBase(created.value.id);
    const bDocId = afterFirst!.pages["https://example.com/docs/b"]!.documentId;
    expect(bDocId).toBeTruthy();
    deleteCalls.length = 0;

    // Second crawl: A changes (re-ingested), B now 503 (transient failure).
    routes.set("https://example.com/docs/a", { body: htmlPage("Page A v2 changed") });
    routes.set("https://example.com/docs/b", { status: 503, body: "service unavailable" });

    await crawlAndWait(created.value.id);
    const afterSecond = await getKnowledgeBase(created.value.id);

    // The bug: B, absent from seenThisRun, would be treated as orphaned and hard-deleted.
    // The fix: a transiently-failed page is spared.
    expect(deleteCalls).not.toContain(bDocId);
    expect(afterSecond!.pages["https://example.com/docs/b"]).toBeDefined();
    expect(afterSecond!.lastCrawl?.pagesRemoved ?? 0).toBe(0);
    expect(afterSecond!.lastCrawl?.pagesFailed).toBeGreaterThanOrEqual(1);
    expect(afterSecond!.status).toBe("ready");
  });

  it("prunes a page that genuinely disappeared after a complete re-crawl", async () => {
    routes.set("https://example.com/docs/", { body: htmlPage("Index", ["https://example.com/docs/a", "https://example.com/docs/b"]) });
    routes.set("https://example.com/docs/a", { body: htmlPage("Page A") });
    routes.set("https://example.com/docs/b", { body: htmlPage("Page B") });

    const created = await createKnowledgeBase({ name: "Docs", seedUrls: ["https://example.com/docs/"], respectRobots: false });
    if (!created.ok) throw new Error(created.error);
    await crawlAndWait(created.value.id);
    const bDocId = (await getKnowledgeBase(created.value.id))!.pages["https://example.com/docs/b"]!.documentId;
    deleteCalls.length = 0;

    // B is now unlinked AND unreachable (404) — a genuine removal.
    routes.set("https://example.com/docs/", { body: htmlPage("Index", ["https://example.com/docs/a"]) });
    routes.delete("https://example.com/docs/b");

    await crawlAndWait(created.value.id);
    const after = await getKnowledgeBase(created.value.id);
    expect(deleteCalls).toContain(bDocId);
    expect(after!.pages["https://example.com/docs/b"]).toBeUndefined();
    expect(after!.lastCrawl?.pagesRemoved).toBe(1);
  });

  it("skips unchanged pages by content hash on re-crawl", async () => {
    routes.set("https://example.com/docs/", { body: htmlPage("Index", ["https://example.com/docs/a"]) });
    routes.set("https://example.com/docs/a", { body: htmlPage("Page A") });

    const created = await createKnowledgeBase({ name: "Docs", seedUrls: ["https://example.com/docs/"], respectRobots: false });
    if (!created.ok) throw new Error(created.error);
    await crawlAndWait(created.value.id);
    ingestCalls.length = 0;

    // Re-crawl with identical content — nothing should be re-ingested.
    await crawlAndWait(created.value.id);
    const after = await getKnowledgeBase(created.value.id);
    expect(ingestCalls.length).toBe(0);
    expect(after!.lastCrawl?.pagesSkippedUnchanged).toBe(2);
    expect(after!.lastCrawl?.pagesIngested).toBe(0);
  });
});
