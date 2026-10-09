/**
 * The trajectory lookup keeps its parse of the cache file while the file is unchanged
 * (finding 2026-10-05). Each lookup used to re-read and JSON-parse up to 500 lines — every one
 * carrying a full embedding vector — on the critical path before the first model call, although
 * the file only changes when a turn finishes. Keyed on size + mtime, so a write is seen at once.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

function fakeEmbed(text: string): Float32Array {
  const t = text.toLowerCase();
  const v = new Float32Array([
    (t.match(/headline|news/g)?.length ?? 0) + 0.01,
    (t.match(/weather|forecast/g)?.length ?? 0) + 0.01,
  ]);
  const norm = Math.hypot(v[0]!, v[1]!);
  return new Float32Array([v[0]! / norm, v[1]! / norm]);
}

vi.mock("../providers/embeddings.js", async () => {
  const actual = await vi.importActual<typeof import("../providers/embeddings.js")>("../providers/embeddings.js");
  return { ...actual, isEmbeddingAvailable: () => true, computeQueryEmbedding: vi.fn(async (text: string) => fakeEmbed(text)) };
});

const readLastRecords = vi.hoisted(() => vi.fn());
vi.mock("../memory/bounded-ndjson-store.js", async () => {
  const actual = await vi.importActual<typeof import("../memory/bounded-ndjson-store.js")>("../memory/bounded-ndjson-store.js");
  readLastRecords.mockImplementation(actual.readLastRecords);
  return { ...actual, readLastRecords };
});

const { lookupTrajectory, writeTrajectory, _resetTrajectoryInvalidationForTests } = await import("../memory/trajectory-cache.js");

describe("trajectory lookup — parsed tail reuse", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    _resetTrajectoryInvalidationForTests();
    readLastRecords.mockClear();
  });

  it("parses the file once while it is unchanged, and again as soon as a turn writes to it", async () => {
    const ws = mkdtempSync(join(tmpdir(), "sai-trajectory-tail-"));
    dirs.push(ws);
    await writeTrajectory({ channel: "test", normalizedQuery: "news headlines", sharedFindings: [], finalAnswer: "headlines A" }, ws, false);

    expect((await lookupTrajectory("headlines in the news", ws, false))?.entry.finalAnswer).toBe("headlines A");
    expect((await lookupTrajectory("news headlines today", ws, false))?.entry.finalAnswer).toBe("headlines A");
    expect(readLastRecords).toHaveBeenCalledTimes(1);

    // The held entry keeps one copy of its vector (the Float32Array the lookup scores with), not
    // the stored number[] beside it — the parse is held across turns and the array is its bulk.
    const hit = await lookupTrajectory("headlines in the news", ws, false);
    expect(hit).not.toBeNull();
    expect("queryEmbedding" in hit!.entry).toBe(false);
    expect(readLastRecords).toHaveBeenCalledTimes(1);

    // A finished turn appends: the next lookup must see it, not the held parse.
    await writeTrajectory({ channel: "test", normalizedQuery: "weather forecast", sharedFindings: [], finalAnswer: "sunny" }, ws, false);
    expect((await lookupTrajectory("weather forecast tomorrow", ws, false))?.entry.finalAnswer).toBe("sunny");
    expect(readLastRecords).toHaveBeenCalledTimes(2);
  });
});
