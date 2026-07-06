import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as loaderModule from "../config/loader.js";
import {
  createKnowledgeBase,
  listKnowledgeBases,
  getKnowledgeBase,
  updateKnowledgeBase,
  mutateKnowledgeBase,
  removeKnowledgeBaseRecord,
  toSummary,
  slugifyKbId,
  kbSource,
  kbDocumentId,
  ambientKbSources,
  invalidateAmbientKbCache,
  type CreateKnowledgeBaseInput,
  type KnowledgeBaseRecord,
} from "../retrieval/knowledge-bases.js";

let workspacePath: string;

beforeEach(() => {
  workspacePath = mkdtempSync(join(tmpdir(), "starlingai-kb-registry-"));
  const realConfig = loaderModule.getConfig();
  vi.spyOn(loaderModule, "getConfig").mockReturnValue({
    ...realConfig,
    workspacePath,
    retrieval: {
      ...realConfig.retrieval,
      knowledgeBases: {
        ...realConfig.retrieval.knowledgeBases,
        enabled: true,
        defaultMaxPages: 150,
        maxPagesCap: 1000,
        defaultMaxDepth: 4,
        maxDepthCap: 8,
      },
    },
  } as typeof realConfig);
  invalidateAmbientKbCache(); // module-level snapshot must not leak across temp workspaces
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(workspacePath, { recursive: true, force: true });
});

async function createOk(input: Partial<CreateKnowledgeBaseInput> = {}): Promise<KnowledgeBaseRecord> {
  const res = await createKnowledgeBase({ name: "Test Docs", seedUrls: ["https://example.com/docs/"], ...input });
  if (!res.ok) throw new Error(`createOk failed: ${res.error}`);
  return res.value;
}

function expectError(res: { ok: boolean; error?: string }, match: RegExp) {
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.error).toMatch(match);
}

describe("slugifyKbId", () => {
  it("lowercases and hyphenates a display name", () => {
    expect(slugifyKbId("W3C Accessibility Docs")).toBe("w3c-accessibility-docs");
    expect(slugifyKbId("  Hello   World  ")).toBe("hello-world");
  });

  it("strips diacritics via NFKD", () => {
    expect(slugifyKbId("Über Görls Dokumentation")).toBe("uber-gorls-dokumentation");
  });

  it("truncates to 63 chars", () => {
    expect(slugifyKbId("a".repeat(80))).toBe("a".repeat(63));
  });

  it("returns '' for garbage-only names", () => {
    expect(slugifyKbId("!!! ???")).toBe("");
    expect(slugifyKbId("---")).toBe("");
    expect(slugifyKbId("")).toBe("");
  });
});

describe("kbSource + kbDocumentId", () => {
  it("kbSource prefixes the id", () => {
    expect(kbSource("my-kb")).toBe("kb:my-kb");
  });

  it("kbDocumentId is stable for the same (kb, url) and distinct otherwise", () => {
    const a1 = kbDocumentId("kb1", "https://example.com/a");
    const a2 = kbDocumentId("kb1", "https://example.com/a");
    expect(a1).toBe(a2);
    expect(a1).toMatch(/^kb-kb1-[0-9a-f]{24}$/);
    expect(kbDocumentId("kb1", "https://example.com/b")).not.toBe(a1);
    expect(kbDocumentId("kb2", "https://example.com/a")).not.toBe(a1);
  });
});

describe("createKnowledgeBase validation", () => {
  it("rejects an empty name", async () => {
    expectError(await createKnowledgeBase({ name: "   ", seedUrls: ["https://example.com/"] }), /name is required/);
  });

  it("rejects missing / too many seed URLs", async () => {
    expectError(await createKnowledgeBase({ name: "X", seedUrls: [] }), /at least one seed URL/);
    const many = Array.from({ length: 21 }, (_, i) => `https://example.com/${i}`);
    expectError(await createKnowledgeBase({ name: "X", seedUrls: many }), /at most 20 seed URLs/);
  });

  it("rejects invalid and non-http(s) seed URLs", async () => {
    expectError(await createKnowledgeBase({ name: "X", seedUrls: ["not a url"] }), /invalid seed URL/);
    expectError(await createKnowledgeBase({ name: "X", seedUrls: ["ftp://example.com/x"] }), /must be http\(s\)/);
  });

  it("rejects an invalid regex pattern", async () => {
    expectError(await createKnowledgeBase({ name: "X", seedUrls: ["https://example.com/"], includePatterns: ["["] }), /includePatterns contains an invalid regex/);
    expectError(await createKnowledgeBase({ name: "X", seedUrls: ["https://example.com/"], excludePatterns: ["(unclosed"] }), /excludePatterns contains an invalid regex/);
  });

  it("rejects a duplicate id", async () => {
    await createOk();
    expectError(await createKnowledgeBase({ name: "Test Docs", seedUrls: ["https://example.com/other/"] }), /already exists/);
  });

  it("rejects a non-slug explicit id, lowercases a valid one", async () => {
    expectError(await createKnowledgeBase({ name: "X", id: "has spaces", seedUrls: ["https://example.com/"] }), /id must be a slug/);
    const kb = await createOk({ id: "MyKB" });
    expect(kb.id).toBe("mykb");
  });

  it("rejects sameOriginOnly=false without includePatterns", async () => {
    expectError(
      await createKnowledgeBase({ name: "X", seedUrls: ["https://example.com/"], sameOriginOnly: false }),
      /sameOriginOnly=false requires non-empty includePatterns/,
    );
    const ok = await createKnowledgeBase({
      name: "X", seedUrls: ["https://example.com/"], sameOriginOnly: false, includePatterns: ["^https://other\\.com/"],
    });
    expect(ok.ok).toBe(true);
  });

  it("clamps maxPages/maxDepth to the configured caps and floors", async () => {
    const clamped = await createOk({ maxPages: 999999, maxDepth: 99 });
    expect(clamped.maxPages).toBe(1000);
    expect(clamped.maxDepth).toBe(8);
    const floored = await createOk({ name: "Floored", maxPages: 0, maxDepth: -5 });
    expect(floored.maxPages).toBe(1);
    expect(floored.maxDepth).toBe(0);
  });

  it("applies defaults: slug id, idle status, empty pages, dedup'd seeds, safe flags", async () => {
    const kb = await createOk({ seedUrls: ["https://example.com/docs/", "https://example.com/docs/"] });
    expect(kb.id).toBe("test-docs");
    expect(kb.status).toBe("idle");
    expect(kb.pages).toEqual({});
    expect(kb.seedUrls).toEqual(["https://example.com/docs/"]);
    expect(kb.maxPages).toBe(150);
    expect(kb.maxDepth).toBe(4);
    expect(kb.sameOriginOnly).toBe(true);
    expect(kb.respectRobots).toBe(true);
    expect(kb.ambientRetrieval).toBe(false);
  });
});

describe("getKnowledgeBase", () => {
  it("finds by id (case-insensitive) and by case-insensitive name", async () => {
    await createOk(); // name "Test Docs" → id "test-docs"
    expect((await getKnowledgeBase("test-docs"))?.id).toBe("test-docs");
    expect((await getKnowledgeBase("TEST-DOCS"))?.id).toBe("test-docs");
    expect((await getKnowledgeBase("Test Docs"))?.id).toBe("test-docs");
    expect((await getKnowledgeBase("tEsT dOcS"))?.id).toBe("test-docs");
  });

  it("returns undefined for unknown or empty needles", async () => {
    await createOk();
    expect(await getKnowledgeBase("nope")).toBeUndefined();
    expect(await getKnowledgeBase("   ")).toBeUndefined();
  });
});

describe("updateKnowledgeBase", () => {
  it("updates fields, clears description with '', re-clamps bounds", async () => {
    const kb = await createOk({ description: "old" });
    const res = await updateKnowledgeBase(kb.id, {
      name: "Renamed",
      description: "",
      seedUrls: ["https://example.com/newdocs/"],
      maxPages: 5000,
      maxDepth: 42,
      ambientRetrieval: true,
      respectRobots: false,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.name).toBe("Renamed");
    expect(res.value.description).toBeUndefined();
    expect(res.value.seedUrls).toEqual(["https://example.com/newdocs/"]);
    expect(res.value.maxPages).toBe(1000);
    expect(res.value.maxDepth).toBe(8);
    expect(res.value.ambientRetrieval).toBe(true);
    expect(res.value.respectRobots).toBe(false);
    // persisted
    expect((await getKnowledgeBase(kb.id))?.name).toBe("Renamed");
  });

  it("rejects an empty name and invalid seeds without persisting", async () => {
    const kb = await createOk();
    expectError(await updateKnowledgeBase(kb.id, { name: "  " }), /name cannot be empty/);
    expectError(await updateKnowledgeBase(kb.id, { seedUrls: ["notaurl"] }), /invalid seed URL/);
    expect((await getKnowledgeBase(kb.id))?.seedUrls).toEqual(["https://example.com/docs/"]);
  });

  it("enforces the sameOriginOnly/includePatterns invariant across updates", async () => {
    const kb = await createOk();
    // flipping to cross-origin without patterns is rejected
    expectError(await updateKnowledgeBase(kb.id, { sameOriginOnly: false }), /requires non-empty includePatterns/);
    // with patterns in the same patch it passes
    const ok = await updateKnowledgeBase(kb.id, { sameOriginOnly: false, includePatterns: ["^https://other\\.com/"] });
    expect(ok.ok).toBe(true);
    // clearing the patterns while cross-origin is rejected
    expectError(await updateKnowledgeBase(kb.id, { includePatterns: null }), /requires non-empty includePatterns/);
    expect((await getKnowledgeBase(kb.id))?.includePatterns).toEqual(["^https://other\\.com/"]);
    // back to same-origin, then clearing patterns is fine
    const back = await updateKnowledgeBase(kb.id, { sameOriginOnly: true, includePatterns: null });
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.value.includePatterns).toBeUndefined();
  });

  it("returns not-found for an unknown id", async () => {
    expectError(await updateKnowledgeBase("ghost", { name: "X" }), /not found/);
  });
});

describe("mutateKnowledgeBase + removeKnowledgeBaseRecord", () => {
  it("mutate applies under the lock, bumps updatedAt, persists", async () => {
    const kb = await createOk();
    const before = kb.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    const mutated = await mutateKnowledgeBase(kb.id, (r) => {
      r.status = "ready";
      r.pages["https://example.com/docs/a"] = {
        documentId: kbDocumentId(kb.id, "https://example.com/docs/a"),
        url: "https://example.com/docs/a",
        contentHash: "h1",
        chunkCount: 3,
        lastIngestedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      };
    });
    expect(mutated?.status).toBe("ready");
    expect(mutated!.updatedAt >= before).toBe(true);
    const reread = await getKnowledgeBase(kb.id);
    expect(reread?.status).toBe("ready");
    expect(Object.keys(reread?.pages ?? {})).toHaveLength(1);
  });

  it("mutate returns undefined for an unknown id", async () => {
    expect(await mutateKnowledgeBase("ghost", () => undefined)).toBeUndefined();
  });

  it("remove returns the record and leaves the store without it", async () => {
    const kb = await createOk();
    const removed = await removeKnowledgeBaseRecord(kb.id);
    expect(removed?.id).toBe(kb.id);
    expect(await getKnowledgeBase(kb.id)).toBeUndefined();
    expect(await listKnowledgeBases()).toEqual([]);
    expect(await removeKnowledgeBaseRecord(kb.id)).toBeUndefined();
  });
});

describe("stale-crawl normalization (interrupted process)", () => {
  it("a 'crawling' record is reported failed ONLY when the live-crawl predicate denies it", async () => {
    const kb = await createOk();
    await mutateKnowledgeBase(kb.id, (r) => { r.status = "crawling"; });

    // no predicate (process that never crawls) → untouched
    expect((await listKnowledgeBases())[0]!.status).toBe("crawling");

    // predicate says the crawl is live in this process → untouched
    expect((await listKnowledgeBases({ isCrawlActive: () => true }))[0]!.status).toBe("crawling");

    // predicate says no live crawl → reported failed with the interrupted error
    const stale = (await listKnowledgeBases({ isCrawlActive: () => false }))[0]!;
    expect(stale.status).toBe("failed");
    expect(stale.lastCrawl?.stopReason).toBe("error");
    expect(stale.lastCrawl?.error).toContain("interrupted");

    // read-side only — the stored record was not clobbered
    expect((await listKnowledgeBases({ isCrawlActive: () => true }))[0]!.status).toBe("crawling");

    // getKnowledgeBase applies the same normalization
    expect((await getKnowledgeBase(kb.id, { isCrawlActive: () => false }))?.status).toBe("failed");
  });

  it("non-crawling statuses are never normalized", async () => {
    const kb = await createOk();
    await mutateKnowledgeBase(kb.id, (r) => { r.status = "ready"; });
    expect((await listKnowledgeBases({ isCrawlActive: () => false }))[0]!.status).toBe("ready");
  });
});

describe("ambientKbSources", () => {
  it("returns only ready + ambientRetrieval KBs and reflects writes", async () => {
    const a = await createOk({ name: "Alpha", ambientRetrieval: true });
    const b = await createOk({ name: "Beta", ambientRetrieval: true });
    await createOk({ name: "Gamma" }); // ambient off

    expect(await ambientKbSources()).toEqual([]); // none ready yet

    await mutateKnowledgeBase(a.id, (r) => { r.status = "ready"; });
    expect(await ambientKbSources()).toEqual([kbSource(a.id)]); // write busted the snapshot

    await mutateKnowledgeBase(b.id, (r) => { r.status = "ready"; });
    await mutateKnowledgeBase("gamma", (r) => { r.status = "ready"; }); // ready but NOT ambient
    expect((await ambientKbSources()).sort()).toEqual([kbSource(a.id), kbSource(b.id)].sort());

    // failed KBs drop out; ambient opt-out drops out
    await mutateKnowledgeBase(a.id, (r) => { r.status = "failed"; });
    expect(await ambientKbSources()).toEqual([kbSource(b.id)]);
    const off = await updateKnowledgeBase(b.id, { ambientRetrieval: false });
    expect(off.ok).toBe(true);
    expect(await ambientKbSources()).toEqual([]);
  });

  it("is [] when the knowledgeBases feature flag is off", async () => {
    const a = await createOk({ name: "Alpha", ambientRetrieval: true });
    await mutateKnowledgeBase(a.id, (r) => { r.status = "ready"; });
    expect(await ambientKbSources()).toEqual([kbSource(a.id)]);

    const cfg = loaderModule.getConfig();
    vi.spyOn(loaderModule, "getConfig").mockReturnValue({
      ...cfg,
      retrieval: { ...cfg.retrieval, knowledgeBases: { ...cfg.retrieval.knowledgeBases, enabled: false } },
    } as typeof cfg);
    invalidateAmbientKbCache();
    expect(await ambientKbSources()).toEqual([]);
  });
});

describe("toSummary", () => {
  it("elides the pages map, sums chunk counts, omits absent optionals", () => {
    const now = new Date().toISOString();
    const record: KnowledgeBaseRecord = {
      id: "docs",
      name: "Docs",
      seedUrls: ["https://example.com/docs/"],
      maxPages: 100,
      maxDepth: 3,
      sameOriginOnly: true,
      respectRobots: true,
      ambientRetrieval: false,
      createdAt: now,
      updatedAt: now,
      status: "ready",
      pages: {
        "https://example.com/docs/a": { documentId: "d1", url: "https://example.com/docs/a", contentHash: "h", chunkCount: 3, lastIngestedAt: now, lastSeenAt: now },
        "https://example.com/docs/b": { documentId: "d2", url: "https://example.com/docs/b", contentHash: "h", chunkCount: 2, lastIngestedAt: now, lastSeenAt: now },
        "https://example.com/docs/c": { documentId: "d3", url: "https://example.com/docs/c", contentHash: "h", lastIngestedAt: now, lastSeenAt: now }, // no chunkCount
      },
    };
    const summary = toSummary(record);
    expect(summary).toEqual({
      id: "docs",
      name: "Docs",
      seedUrls: ["https://example.com/docs/"],
      status: "ready",
      ambientRetrieval: false,
      pageCount: 3,
      chunkCount: 5,
      maxPages: 100,
      maxDepth: 3,
      createdAt: now,
      updatedAt: now,
    });
    expect("pages" in summary).toBe(false);
    expect(summary.description).toBeUndefined();
    expect(summary.lastCrawl).toBeUndefined();
  });
});
