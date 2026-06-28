/**
 * Tests for the memory-service enhancements added in this iteration:
 * - LRU cache keyed on dir mtime + explicit version bumps
 * - German stopwords in tokenization
 * - Kind-based decay factor in scoreRecord
 * - Embedding-similarity blend in searchMemoryRecords
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PRODUCT } from "../product/index.js";

const upsertMemoryToGraphMock = vi.fn(async () => undefined);

vi.mock("../memory/graph-service.js", async () => {
  const actual = await vi.importActual<typeof import("../memory/graph-service.js")>("../memory/graph-service.js");
  return {
    ...actual,
    upsertMemoryToGraph: upsertMemoryToGraphMock,
  };
});

// ── Deterministic fake embedding provider ─────────────────────────────────
// Maps any string to a 4-dim vector by counting marker words.  Similar text
// → similar vector; disjoint text → orthogonal.

function fakeEmbed(text: string): Float32Array {
  const t = text.toLowerCase();
  const v = new Float32Array(4);
  v[0] = (t.match(/latency|performance|speed/g)?.length ?? 0);
  v[1] = (t.match(/security|auth|credential/g)?.length ?? 0);
  v[2] = (t.match(/headline|news|nachrichten/g)?.length ?? 0);
  v[3] = (t.match(/email|mail|message/g)?.length ?? 0);
  for (let i = 0; i < 4; i++) v[i] = (v[i] ?? 0) + 0.01;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  for (let i = 0; i < 4; i++) v[i] = (v[i] ?? 0) / norm;
  return v;
}

vi.mock("../providers/embeddings.js", async () => {
  const actual = await vi.importActual<typeof import("../providers/embeddings.js")>("../providers/embeddings.js");
  return {
    ...actual,
    isEmbeddingAvailable: () => true,
    computeQueryEmbedding: vi.fn(async (text: string) => fakeEmbed(text)),
    cosineSimilarity: actual.cosineSimilarity,
  };
});

const {
  _clearDurableMemoryCaches,
  searchMemoryRecords,
  storeWorkspaceMemoryRecord,
} = await import("../memory/service.js");

async function flushEmbeddingWrite(): Promise<void> {
  // The embedding is written asynchronously after storeDurableMemoryRecord
  // returns — yield a few microtasks so the fs.writeFileSync completes.
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 10));
}

describe("memory service — LRU + decay + embedding", () => {
  const dirs: string[] = [];

  beforeEach(() => {
    _clearDurableMemoryCaches();
  });

  afterEach(() => {
    _clearDurableMemoryCaches();
    upsertMemoryToGraphMock.mockClear();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function mkWorkspace(): string {
    const dir = mkdtempSync(join(tmpdir(), "mem-enh-"));
    dirs.push(dir);
    return dir;
  }

  it("persists embeddings to disk for durable memory records", async () => {
    const ws = mkWorkspace();
    storeWorkspaceMemoryRecord(ws, {
      key: "latency_goal",
      subject: "Latency goal",
      content: "Keep p95 latency under 45s across all specialist calls.",
      kind: "decision",
    });
    await flushEmbeddingWrite();

    const files = readdirSync(join(ws, `${PRODUCT.stateDirName}/memory`));
    expect(files).toContain("latency_goal.json");
  });

  it("passes agent and session metadata into graph write-through for durable memory", () => {
    const ws = mkWorkspace();

    storeWorkspaceMemoryRecord(ws, {
      key: "operator_profile",
      subject: "Operator profile",
      content: "Steffen is the operator and main user of the system.",
      kind: "fact",
    }, {
      agentName: "productivity_agent",
      sessionId: "session-memory-graph-1",
    });

    expect(upsertMemoryToGraphMock).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "operator_profile",
        subject: "Operator profile",
      }),
      "productivity_agent",
      "session-memory-graph-1",
      // A4: the single shared embedding (in-flight promise) is handed to the graph
      // write-through so it does not embed the record a second time.
      expect.any(Promise),
    );
  });

  it("computes the durable embedding once and fans the SAME vector out to flat-file + graph (A4)", async () => {
    const ws = mkWorkspace();
    storeWorkspaceMemoryRecord(ws, {
      key: "latency_note",
      subject: "Latency",
      content: "Latency and performance budget for specialist calls.",
      kind: "note",
    });
    await flushEmbeddingWrite();

    // The graph write-through received the shared embedding promise as its 4th arg.
    const call = upsertMemoryToGraphMock.mock.calls.at(-1) as unknown[] | undefined;
    expect(call).toBeDefined();
    const shared = await (call![3] as Promise<Float32Array | null>);
    expect(shared).toBeInstanceOf(Float32Array);

    // …and it is byte-for-byte the vector persisted to the flat file — i.e. one embed,
    // reused, not two independent computations.
    const memDir = join(ws, `${PRODUCT.stateDirName}/memory`);
    const fileName = readdirSync(memDir).find((f) => f.startsWith("latency_note"));
    expect(fileName).toBeDefined();
    const stored = JSON.parse(readFileSync(join(memDir, fileName!), "utf-8")) as { embedding?: number[] };
    expect(stored.embedding).toEqual(Array.from(shared!));
  });

  it("applies kind-based decay: 180-day half-life decisions outrank 14-day notes of same age", async () => {
    const ws = mkWorkspace();
    const backdate = new Date();
    backdate.setDate(backdate.getDate() - 30);

    storeWorkspaceMemoryRecord(ws, {
      key: "old_decision",
      subject: "Latency budget",
      content: "Latency budget is 45 seconds.",
      kind: "decision",
    });
    storeWorkspaceMemoryRecord(ws, {
      key: "old_note",
      subject: "Latency note",
      content: "Latency note — incident observation only.",
      kind: "note",
    });
    await flushEmbeddingWrite();

    // Backdate both files to simulate 30 days old.  Then clear the cache so
    // the next read picks up the mtime change.
    const memDir = join(ws, `${PRODUCT.stateDirName}/memory`);
    for (const f of readdirSync(memDir)) {
      const fp = join(memDir, f);
      const raw = require("node:fs").readFileSync(fp, "utf-8");
      const parsed = JSON.parse(raw);
      parsed.updatedAt = backdate.toISOString();
      parsed.createdAt = backdate.toISOString();
      require("node:fs").writeFileSync(fp, JSON.stringify(parsed, null, 2), "utf-8");
    }
    _clearDurableMemoryCaches();

    const results = await searchMemoryRecords(ws, "latency");
    // Decision should rank above note — decay factor 30d on 180d half-life
    // = 0.89; on 14d half-life = 0.23.  So decision wins even though both
    // start with the same lexical score.
    expect(results.length).toBeGreaterThanOrEqual(2);
    const decision = results.find((r) => r.key === "old_decision");
    const note = results.find((r) => r.key === "old_note");
    expect(decision).toBeDefined();
    expect(note).toBeDefined();
    expect(decision!.score ?? 0).toBeGreaterThan(note!.score ?? 0);
  });

  it("uses embedding similarity to rank semantic paraphrase above disjoint match", async () => {
    const ws = mkWorkspace();
    storeWorkspaceMemoryRecord(ws, {
      key: "perf",
      subject: "Performance target",
      content: "Keep latency low and throughput stable across the swarm.",
      kind: "decision",
    });
    storeWorkspaceMemoryRecord(ws, {
      key: "email",
      subject: "Email formatting",
      content: "Use three-line summary for every outbound mail message.",
      kind: "preference",
    });
    await flushEmbeddingWrite();
    _clearDurableMemoryCaches();

    // Query has no literal overlap with "performance target" content, but
    // the embedding vector clusters with the latency/performance record.
    const results = await searchMemoryRecords(ws, "speed performance requirement");
    expect(results.length).toBeGreaterThan(0);
    // The semantically-closest record should be the performance one.
    const perfScore = results.find((r) => r.key === "perf")?.score ?? 0;
    const emailScore = results.find((r) => r.key === "email")?.score ?? 0;
    expect(perfScore).toBeGreaterThan(emailScore);
  });

  it("caches readDurableMemoryRecords by dir mtime + version", async () => {
    const ws = mkWorkspace();
    storeWorkspaceMemoryRecord(ws, {
      key: "k1",
      subject: "Alpha",
      content: "alpha content",
      kind: "fact",
    });
    await flushEmbeddingWrite();

    // Warm the cache via a search
    await searchMemoryRecords(ws, "alpha");

    const memDir = join(ws, `${PRODUCT.stateDirName}/memory`);
    const mtimeBefore = statSync(memDir).mtimeMs;

    // Second read should not change mtime (no filesystem write).
    await searchMemoryRecords(ws, "alpha");
    const mtimeAfter = statSync(memDir).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);

    // Adding a new record bumps the cache version so subsequent reads see
    // the new content.
    storeWorkspaceMemoryRecord(ws, {
      key: "k2",
      subject: "Beta",
      content: "beta content",
      kind: "fact",
    });
    await flushEmbeddingWrite();

    const after = await searchMemoryRecords(ws, "beta");
    expect(after.some((r) => r.key === "k2")).toBe(true);
  });

  it("de-weights German stopwords so content words dominate", async () => {
    const ws = mkWorkspace();
    storeWorkspaceMemoryRecord(ws, {
      key: "report_protocol",
      subject: "Berichtsprotokoll",
      content: "Das Reporting-Protokoll sendet eine Zusammenfassung an das Team.",
      kind: "decision",
    });
    storeWorkspaceMemoryRecord(ws, {
      key: "unrelated",
      subject: "Kaffeemaschine",
      content: "Das Modell der Kaffeemaschine ist wichtig und die Wartung auch.",
      kind: "note",
    });
    await flushEmbeddingWrite();
    _clearDurableMemoryCaches();

    // Query with several German stopwords — if they aren't filtered, the
    // unrelated record (which repeats "das" and "die") scores high.
    const results = await searchMemoryRecords(ws, "das reporting protokoll und die zusammenfassung");
    const reporting = results.find((r) => r.key === "report_protocol");
    const unrelated = results.find((r) => r.key === "unrelated");
    expect(reporting).toBeDefined();
    // The report_protocol record must rank above the unrelated one.
    const reportScore = reporting!.score ?? 0;
    const unrelatedScore = unrelated?.score ?? 0;
    expect(reportScore).toBeGreaterThan(unrelatedScore);
  });
});
