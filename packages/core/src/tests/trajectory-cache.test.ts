/**
 * G33 — Trajectory cache tests.
 *
 * Covers:
 *   - write/read round-trip (similar query returns cached entry)
 *   - freshness decay (expired entries are not returned)
 *   - similarity threshold (dissimilar queries do not match)
 *   - credential redaction (entries with secrets are not persisted)
 *   - freshness-sensitive bypass (always returns null)
 */

import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// ── Mock the embedding provider ─────────────────────────────────────────
// Deterministic 4-dim embeddings per query — similar text → similar vector.
function fakeEmbed(text: string): Float32Array {
  const t = text.toLowerCase();
  // Crude bag-of-feature: count occurrences of marker words
  const v = new Float32Array(4);
  v[0] = (t.match(/headline/g)?.length ?? 0) + (t.match(/news/g)?.length ?? 0);
  v[1] = (t.match(/weather/g)?.length ?? 0) + (t.match(/forecast/g)?.length ?? 0);
  v[2] = (t.match(/code|review|security/g)?.length ?? 0);
  v[3] = (t.match(/email|draft|message/g)?.length ?? 0);
  // Add a small constant to avoid zero vectors (cosine undefined)
  for (let i = 0; i < 4; i++) v[i] += 0.01;
  // Normalise
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  for (let i = 0; i < 4; i++) v[i] = v[i] / norm;
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

// Import AFTER mock is registered
const { lookupTrajectory, writeTrajectory, invalidateTrajectory, _resetTrajectoryInvalidationForTests } =
  await import("../memory/trajectory-cache.js");

// ── Tests ──────────────────────────────────────────────────────────────────

describe("G33: trajectory cache", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    _resetTrajectoryInvalidationForTests();
  });

  function makeWorkspace(): string {
    const ws = mkdtempSync(join(tmpdir(), "sai-trajectory-"));
    tempDirs.push(ws);
    return ws;
  }

  it("round-trips a stored entry for a semantically similar query", async () => {
    const ws = makeWorkspace();
    await writeTrajectory({
      channel: "test",
      normalizedQuery: "what are the headlines today",
      sharedFindings: ["Tagesschau: lead story A", "Reuters: lead story B"],
      finalAnswer: "Today's headlines: A and B.",
    }, ws, false);

    // File should exist
    const cachePath = join(ws, ".starlingai", "trajectory_cache.ndjson");
    expect(existsSync(cachePath)).toBe(true);

    // Similar query (same marker words) should match
    const hit = await lookupTrajectory("show me the headlines news", ws, false);
    expect(hit).not.toBeNull();
    expect(hit?.entry.finalAnswer).toContain("Today's headlines");
    expect(hit?.entry.sharedFindings).toHaveLength(2);
    expect(hit?.similarity).toBeGreaterThanOrEqual(0.86);
  });

  it("skips entries that have been invalidated this process", async () => {
    const ws = makeWorkspace();
    await writeTrajectory({
      channel: "test",
      normalizedQuery: "what are the headlines today",
      sharedFindings: ["news A"],
      finalAnswer: "Headlines: A",
    }, ws, false);

    const first = await lookupTrajectory("show me the headlines news", ws, false);
    expect(first).not.toBeNull();

    invalidateTrajectory({
      normalizedQuery: first!.entry.normalizedQuery,
      finishedAt: first!.entry.finishedAt,
    });

    const second = await lookupTrajectory("show me the headlines news", ws, false);
    expect(second).toBeNull();
  });

  it("returns null for a dissimilar query (below similarity threshold)", async () => {
    const ws = makeWorkspace();
    await writeTrajectory({
      channel: "test",
      normalizedQuery: "what are the headlines today",
      sharedFindings: ["news A"],
      finalAnswer: "Headlines: A",
    }, ws, false);

    // Completely different topic — no marker overlap
    const hit = await lookupTrajectory("draft an email about the project", ws, false);
    expect(hit).toBeNull();
  });

  it("returns null when freshnessSensitive=true on lookup", async () => {
    const ws = makeWorkspace();
    await writeTrajectory({
      channel: "test",
      normalizedQuery: "what's the weather forecast",
      sharedFindings: ["sunny 24C"],
      finalAnswer: "Weather: sunny 24C",
    }, ws, false);

    const hit = await lookupTrajectory("what's the weather forecast", ws, /* fresh */ true);
    expect(hit).toBeNull();
  });

  it("does not persist entries containing credential-shaped tokens", async () => {
    const ws = makeWorkspace();
    await writeTrajectory({
      channel: "test",
      normalizedQuery: "headlines today",
      sharedFindings: ["api_key=sk-abc123 leaked in source"],
      finalAnswer: "Headlines today",
    }, ws, false);

    // File should NOT have been created
    const cachePath = join(ws, ".starlingai", "trajectory_cache.ndjson");
    expect(existsSync(cachePath)).toBe(false);
  });

  it("does not return expired entries (TTL enforced on read)", async () => {
    const ws = makeWorkspace();
    await writeTrajectory({
      channel: "test",
      normalizedQuery: "headlines today",
      sharedFindings: ["old news"],
      finalAnswer: "Old headlines",
    }, ws, true /* fresh-sensitive → 30 min TTL */);

    // Manually rewrite the entry with a finishedAt of 2 hours ago
    const cachePath = join(ws, ".starlingai", "trajectory_cache.ndjson");
    const raw = readFileSync(cachePath, "utf-8").trim();
    const entry = JSON.parse(raw);
    entry.finishedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(cachePath, JSON.stringify(entry) + "\n", "utf-8");

    // Note: lookup with freshnessSensitive=true bypasses cache entirely.
    // To verify TTL specifically we read with freshnessSensitive=false but
    // the entry's own ttlSeconds (1800 from FRESH_TTL_SECONDS) is short.
    const hit = await lookupTrajectory("headlines today", ws, false);
    expect(hit).toBeNull();
  });

  it("returns null when no cache file exists", async () => {
    const ws = makeWorkspace();
    const hit = await lookupTrajectory("anything", ws, false);
    expect(hit).toBeNull();
  });
});
