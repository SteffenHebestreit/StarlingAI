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
  callerCanAccessKb,
  filterAccessibleKbs,
  type CreateKnowledgeBaseInput,
  type KnowledgeBaseRecord,
} from "../retrieval/knowledge-bases.js";
import { requireOperator } from "../tools/knowledge-bases.js";

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
      scope: "workspace", // legacy record without a scope field normalizes to workspace
      hasWorker: false,
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

// ── Scoping (session / user / workspace), mirroring documents + memory ────────

describe("callerCanAccessKb + filterAccessibleKbs", () => {
  const ws = { scope: "workspace" as const };
  const legacy = {}; // no scope field at all → treated as workspace
  const userOwned = { scope: "user" as const, ownerId: "u1" };
  const userNoOwner = { scope: "user" as const }; // user scope, unassigned owner
  const sess = { scope: "session" as const, sessionId: "s1" };

  it("workspace and legacy (scope-less) KBs are visible to everyone, incl. an empty context", () => {
    expect(callerCanAccessKb(ws, {})).toBe(true);
    expect(callerCanAccessKb(ws, { userId: "u9", sessionId: "s9" })).toBe(true);
    expect(callerCanAccessKb(legacy, {})).toBe(true); // scope undefined normalizes to workspace
  });

  it("a user KB is visible only to its owner (different/absent userId → hidden)", () => {
    expect(callerCanAccessKb(userOwned, { userId: "u1" })).toBe(true);
    expect(callerCanAccessKb(userOwned, { userId: "u2" })).toBe(false);
    expect(callerCanAccessKb(userOwned, {})).toBe(false);
  });

  it("a user KB with NO owner stays visible (single-user / unassigned corpus)", () => {
    expect(callerCanAccessKb(userNoOwner, {})).toBe(true);
    expect(callerCanAccessKb(userNoOwner, { userId: "whoever" })).toBe(true);
  });

  it("a session KB is visible only to the matching session (absent sessionId → hidden)", () => {
    expect(callerCanAccessKb(sess, { sessionId: "s1" })).toBe(true);
    expect(callerCanAccessKb(sess, { sessionId: "s2" })).toBe(false);
    expect(callerCanAccessKb(sess, {})).toBe(false);
    expect(callerCanAccessKb(sess, { userId: "s1" })).toBe(false); // a userId is not a session match
  });

  it("filterAccessibleKbs keeps only the caller's accessible KBs", () => {
    const all = [ws, userOwned, userNoOwner, sess];
    expect(filterAccessibleKbs(all, { userId: "u1" })).toEqual([ws, userOwned, userNoOwner]);
    expect(filterAccessibleKbs(all, { sessionId: "s1" })).toEqual([ws, userNoOwner, sess]);
    expect(filterAccessibleKbs(all, {})).toEqual([ws, userNoOwner]);
  });
});

describe("createKnowledgeBase — scope + worker", () => {
  it("defaults to workspace scope with no owner/session stamps", async () => {
    const kb = await createOk();
    expect(kb.scope).toBe("workspace");
    expect(kb.ownerId).toBeUndefined();
    expect(kb.sessionId).toBeUndefined();
  });

  it("requires a sessionId for session scope and an ownerId for user scope", async () => {
    expectError(
      await createKnowledgeBase({ name: "S", seedUrls: ["https://example.com/"], scope: "session" }),
      /session-scoped knowledge bases require a sessionId/,
    );
    expectError(
      await createKnowledgeBase({ name: "U", seedUrls: ["https://example.com/"], scope: "user" }),
      /user-scoped knowledge bases require an authenticated user/,
    );
  });

  it("stamps ONLY the matching scope's identity — a user KB carries ownerId, not sessionId", async () => {
    const kb = await createOk({ name: "User KB", scope: "user", ownerId: "u1", sessionId: "sess-1" });
    expect(kb.scope).toBe("user");
    expect(kb.ownerId).toBe("u1");
    expect(kb.sessionId).toBeUndefined(); // the session stamp is not applied to a user KB
  });

  it("stamps ONLY the matching scope's identity — a session KB carries sessionId, not ownerId", async () => {
    const kb = await createOk({ name: "Session KB", scope: "session", ownerId: "u1", sessionId: "sess-1" });
    expect(kb.scope).toBe("session");
    expect(kb.sessionId).toBe("sess-1");
    expect(kb.ownerId).toBeUndefined();
  });

  it("keeps a valid worker template (instructions trimmed, tools deduped, model/limits kept)", async () => {
    const kb = await createOk({
      name: "Worker KB",
      worker: {
        instructions: "  audit against the KB  ",
        tools: ["web_fetch", "web_fetch", "browser_axe_audit"],
        model: { primary: "lmstudio/qwen/qwen3.5-9b", temperature: 0.2, maxTokens: 4096 },
        maxIterations: 4,
        timeoutMs: 120_000,
      },
    });
    expect(kb.worker).toEqual({
      instructions: "audit against the KB",
      tools: ["web_fetch", "browser_axe_audit"],
      model: { primary: "lmstudio/qwen/qwen3.5-9b", temperature: 0.2, maxTokens: 4096 },
      maxIterations: 4,
      timeoutMs: 120_000,
    });
  });

  it("drops an empty (or whitespace-only) worker to undefined", async () => {
    expect((await createOk({ name: "Empty Worker", worker: {} })).worker).toBeUndefined();
    expect((await createOk({ name: "Blank Instr", worker: { instructions: "   " } })).worker).toBeUndefined();
  });

  it("rejects an over-long worker.instructions and too many worker.tools", async () => {
    expectError(
      await createKnowledgeBase({ name: "Big", seedUrls: ["https://example.com/"], worker: { instructions: "x".repeat(8001) } }),
      /worker\.instructions exceeds 8000 characters/,
    );
    const tools = Array.from({ length: 21 }, (_, i) => `tool_${i}`);
    expectError(
      await createKnowledgeBase({ name: "ManyTools", seedUrls: ["https://example.com/"], worker: { tools } }),
      /worker\.tools may have at most 20 entries/,
    );
  });
});

describe("updateKnowledgeBase — scope re-stamp + worker", () => {
  it("user→session clears ownerId and sets sessionId (and requires one)", async () => {
    const kb = await createOk({ name: "US KB", scope: "user", ownerId: "u1" });
    // switching to session with no sessionId available is rejected (not persisted)
    expectError(await updateKnowledgeBase(kb.id, { scope: "session" }), /session scope requires a sessionId/);
    expect((await getKnowledgeBase(kb.id))?.scope).toBe("user");

    const res = await updateKnowledgeBase(kb.id, { scope: "session", sessionId: "sess-9" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.scope).toBe("session");
    expect(res.value.sessionId).toBe("sess-9");
    expect(res.value.ownerId).toBeUndefined();
  });

  it("session→user clears sessionId and sets ownerId", async () => {
    const kb = await createOk({ name: "SU KB", scope: "session", sessionId: "sess-1" });
    const res = await updateKnowledgeBase(kb.id, { scope: "user", ownerId: "u2" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.scope).toBe("user");
    expect(res.value.ownerId).toBe("u2");
    expect(res.value.sessionId).toBeUndefined();
  });

  it("→workspace clears both the owner and the session stamp", async () => {
    const kb = await createOk({ name: "WS KB", scope: "user", ownerId: "u1" });
    const res = await updateKnowledgeBase(kb.id, { scope: "workspace" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.scope).toBe("workspace");
    expect(res.value.ownerId).toBeUndefined();
    expect(res.value.sessionId).toBeUndefined();
  });

  it("rejects an invalid scope", async () => {
    const kb = await createOk();
    expectError(await updateKnowledgeBase(kb.id, { scope: "public" as never }), /scope must be one of/);
  });

  it("replaces the worker template and clears it with worker:null", async () => {
    const kb = await createOk({ name: "Worker Upd", worker: { instructions: "first" } });
    const replaced = await updateKnowledgeBase(kb.id, { worker: { instructions: "second", tools: ["web_fetch"] } });
    expect(replaced.ok).toBe(true);
    if (replaced.ok) expect(replaced.value.worker).toEqual({ instructions: "second", tools: ["web_fetch"] });
    const cleared = await updateKnowledgeBase(kb.id, { worker: null });
    expect(cleared.ok).toBe(true);
    if (cleared.ok) expect(cleared.value.worker).toBeUndefined();
  });
});

describe("toSummary — scope + hasWorker", () => {
  const base = (over: Partial<KnowledgeBaseRecord>): KnowledgeBaseRecord => {
    const now = new Date().toISOString();
    return {
      id: "k", name: "K", seedUrls: ["https://example.com/"],
      maxPages: 10, maxDepth: 2, sameOriginOnly: true, respectRobots: true, ambientRetrieval: false,
      createdAt: now, updatedAt: now, status: "ready", pages: {}, ...over,
    };
  };

  it("reflects a user scope + ownerId", () => {
    const s = toSummary(base({ scope: "user", ownerId: "u1" }));
    expect(s.scope).toBe("user");
    expect(s.ownerId).toBe("u1");
  });

  it("hasWorker is true only when the worker has instructions or tools", () => {
    expect(toSummary(base({ worker: { instructions: "do X" } })).hasWorker).toBe(true);
    expect(toSummary(base({ worker: { tools: ["web_fetch"] } })).hasWorker).toBe(true);
    expect(toSummary(base({ worker: { model: { temperature: 0.1 } } })).hasWorker).toBe(false); // model-only ≠ usable worker
    expect(toSummary(base({})).hasWorker).toBe(false);
  });
});

describe("requireOperator — KB mutations are operator-only under active auth", () => {
  const mockAuth = (auth: Record<string, unknown> | undefined) => {
    const realConfig = loaderModule.getConfig();
    vi.spyOn(loaderModule, "getConfig").mockReturnValue({ ...realConfig, auth } as typeof realConfig);
  };
  const ctx = (userRole?: string) =>
    ({ sessionId: "s", workspacePath, ...(userRole ? { userRole } : {}) }) as unknown as import("../tools/registry.js").ToolContext;

  it("allows when auth is disabled (single-operator back-compat)", async () => {
    mockAuth({ enabled: false });
    expect(await requireOperator(ctx("viewer"))).toBeNull();
  });

  it("allows when auth is on but no role was threaded (channel/token turn)", async () => {
    mockAuth({ enabled: true, provider: "builtin", users: [] });
    expect(await requireOperator(ctx(undefined))).toBeNull();
  });

  it("refuses a viewer, allows operator and admin, under active auth", async () => {
    mockAuth({ enabled: true, provider: "builtin", users: [] });
    const viewer = await requireOperator(ctx("viewer"));
    expect(viewer?.success).toBe(false);
    expect(viewer?.error).toMatch(/operator role/i);
    expect(await requireOperator(ctx("operator"))).toBeNull();
    expect(await requireOperator(ctx("admin"))).toBeNull();
  });
});
