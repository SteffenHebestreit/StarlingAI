import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as loaderModule from "../config/loader.js";

/**
 * Finding S4 (2026-10-05): the knowledge-base registry read EVERY failure as "no knowledge bases".
 * A damaged file, a permission error or a Windows sharing violation mid-rename answered "No
 * knowledge bases available to you yet", and createKnowledgeBase then wrote a registry holding
 * only its new record over the one it had failed to read. Reads ran outside the write lock, and on
 * Windows a rename cannot replace a file another handle has open, so a reader made the crawler's
 * write fail with EPERM. Each test below fails with that behaviour restored.
 */

// Pass-through rename that a test can make refuse (EPERM) or stall, and a readFile it can refuse.
const renameControl = vi.hoisted(() => ({
  impl: null as null | ((from: string, to: string, real: (from: string, to: string) => Promise<void>) => Promise<void>),
  calls: 0,
  readRefusals: 0,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const rename = (from: string, to: string): Promise<void> => {
    renameControl.calls += 1;
    return renameControl.impl ? renameControl.impl(from, to, actual.rename) : actual.rename(from, to);
  };
  const readFile = ((...args: Parameters<typeof actual.readFile>) => {
    if (renameControl.readRefusals > 0 && String(args[0]).endsWith(".knowledge-bases.json")) {
      renameControl.readRefusals -= 1;
      return Promise.reject(Object.assign(new Error("EBUSY: resource busy or locked, open"), { code: "EBUSY" }));
    }
    return actual.readFile(...args);
  }) as typeof actual.readFile;
  return { ...actual, rename, readFile, default: { ...actual, rename, readFile } };
});

vi.mock("../retrieval/engram.js", () => ({
  engramConfigured: () => true,
  engramIngest: vi.fn(async () => null),
  engramDeleteDocument: vi.fn(async () => true),
}));

import {
  createKnowledgeBase,
  listKnowledgeBases,
  getKnowledgeBase,
  updateKnowledgeBase,
  mutateKnowledgeBase,
  removeKnowledgeBaseRecord,
  invalidateAmbientKbCache,
  KnowledgeBaseRegistryUnreadableError,
} from "../retrieval/knowledge-bases.js";

let workspacePath: string;
const storeDir = () => join(workspacePath, "uploads");
const storeFile = () => join(storeDir(), ".knowledge-bases.json");

function eperm(): Error {
  return Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
}

beforeEach(() => {
  renameControl.impl = null;
  renameControl.calls = 0;
  renameControl.readRefusals = 0;
  workspacePath = mkdtempSync(join(tmpdir(), "starlingai-kb-integrity-"));
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
        maxConcurrentCrawls: 2,
      },
    },
  } as typeof realConfig);
  invalidateAmbientKbCache();
});

afterEach(() => {
  renameControl.impl = null;
  vi.restoreAllMocks();
  rmSync(workspacePath, { recursive: true, force: true });
});

async function createOk(name = "Docs") {
  const res = await createKnowledgeBase({ name, seedUrls: ["https://example.com/docs/"] });
  if (!res.ok) throw new Error(res.error);
  return res.value;
}

describe("knowledge-base registry: only a missing file is empty", () => {
  it("a registry that does not exist yet reads as no knowledge bases", async () => {
    expect(await listKnowledgeBases()).toEqual([]);
    expect(await getKnowledgeBase("anything")).toBeUndefined();
  });

  it("a damaged registry throws on every read and nothing is ever written over it", async () => {
    mkdirSync(storeDir(), { recursive: true });
    const damaged = '{"version":1,"kbs":[{"id":"precious","name":"Precious"'; // truncated
    writeFileSync(storeFile(), damaged);

    await expect(listKnowledgeBases()).rejects.toBeInstanceOf(KnowledgeBaseRegistryUnreadableError);
    await expect(getKnowledgeBase("precious")).rejects.toBeInstanceOf(KnowledgeBaseRegistryUnreadableError);
    await expect(createKnowledgeBase({ name: "New", seedUrls: ["https://example.com/"] })).rejects.toBeInstanceOf(KnowledgeBaseRegistryUnreadableError);
    await expect(updateKnowledgeBase("precious", { name: "x" })).rejects.toBeInstanceOf(KnowledgeBaseRegistryUnreadableError);
    await expect(mutateKnowledgeBase("precious", (kb) => { kb.name = "x"; })).rejects.toBeInstanceOf(KnowledgeBaseRegistryUnreadableError);
    await expect(removeKnowledgeBaseRecord("precious")).rejects.toBeInstanceOf(KnowledgeBaseRegistryUnreadableError);

    expect(readFileSync(storeFile(), "utf8")).toBe(damaged);   // still there to be repaired
    expect(renameControl.calls).toBe(0);
  });

  it("a read error other than ENOENT throws instead of reading as empty", async () => {
    mkdirSync(storeFile(), { recursive: true });   // EISDIR: the path exists but is not readable as a file
    await expect(listKnowledgeBases()).rejects.toBeInstanceOf(KnowledgeBaseRegistryUnreadableError);
  });

  it("list_knowledge_bases says the registry is unreadable, never that none exist", async () => {
    await import("../tools/knowledge-bases.js");
    const { getTool } = await import("../tools/registry.js");
    mkdirSync(storeDir(), { recursive: true });
    writeFileSync(storeFile(), "not json at all");

    const r = await getTool("list_knowledge_bases")!.execute({}, { sessionId: "s", workspacePath });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/could not be read/);
    expect(r.error).toMatch(/NOT evidence that no knowledge bases exist/);
    expect(`${r.output}${r.error}`).not.toMatch(/No knowledge bases available/);

    const one = await getTool("search_knowledge_base")!.execute({ knowledge_base: "precious", query: "q" }, { sessionId: "s", workspacePath });
    expect(one.error).toMatch(/could not be read/);
  });

  it("a crawl start against an unreadable registry fails cleanly and releases its slot", async () => {
    const { startKbCrawl, isCrawlActive } = await import("../retrieval/kb-crawler.js");
    mkdirSync(storeDir(), { recursive: true });
    writeFileSync(storeFile(), "{");
    const started = await startKbCrawl("precious");
    expect(started.ok).toBe(false);
    expect(isCrawlActive("precious")).toBe(false);
  });
});

describe("knowledge-base registry: writes survive Windows sharing violations", () => {
  it("retries a rename refused with EPERM and lands the write", async () => {
    let refusals = 0;
    renameControl.impl = async (from, to, real) => {
      if (refusals < 2) { refusals += 1; throw eperm(); }
      return real(from, to);
    };
    const kb = await createOk("Retried");
    expect(refusals).toBe(2);
    const onDisk = JSON.parse(readFileSync(storeFile(), "utf8")) as { kbs: Array<{ id: string }> };
    expect(onDisk.kbs.map((k) => k.id)).toEqual([kb.id]);
  });

  it("a read refused for a moment (EBUSY) is retried, not reported as unreadable or empty", async () => {
    const kb = await createOk("Busy");
    renameControl.readRefusals = 2;
    expect((await listKnowledgeBases()).map((k) => k.id)).toEqual([kb.id]);
    expect(renameControl.readRefusals).toBe(0);
  });

  it("a rename that never succeeds throws, leaves the registry as it was, and removes its temp file", async () => {
    await createOk("Before");
    const before = readFileSync(storeFile(), "utf8");
    renameControl.impl = async () => { throw eperm(); };
    await expect(mutateKnowledgeBase("before", (kb) => { kb.name = "After"; })).rejects.toMatchObject({ code: "EPERM" });
    expect(readFileSync(storeFile(), "utf8")).toBe(before);
    expect(readdirSync(storeDir()).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("knowledge-base registry: reads take the write lock", () => {
  it("a read issued during a write waits for it and sees the written record", async () => {
    await createOk("Original");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let renameEntered!: () => void;
    const entered = new Promise<void>((resolve) => { renameEntered = resolve; });
    renameControl.impl = async (from, to, real) => {
      renameEntered();
      await gate;   // the write is mid-rename: on Windows an open reader makes this fail
      return real(from, to);
    };

    try {
      const writing = mutateKnowledgeBase("original", (kb) => { kb.name = "Renamed"; });
      await entered;
      let settled = false;
      const reading = getKnowledgeBase("original").then((kb) => { settled = true; return kb; });
      const listing = listKnowledgeBases();
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(settled).toBe(false);   // queued behind the write, not reading the file under it

      release();
      await writing;
      expect((await reading)?.name).toBe("Renamed");
      expect((await listing).map((kb) => kb.name)).toEqual(["Renamed"]);
    } finally {
      release();
      renameControl.impl = null;
    }
  });
});
