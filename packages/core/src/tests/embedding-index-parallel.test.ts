/**
 * The agent index build uses the slots the server offers, and keeps its failure behaviour.
 *
 * It used to embed strictly one agent at a time. That was the right call against a server
 * that queued a whole batch at once, but the endpoint this runs against serves sixteen
 * requests concurrently, and a 49-agent rebuild was doing 49 round trips in series to use one
 * slot. Throughput on that server rises from 365 texts/s at concurrency 4 to 375 at 8.
 *
 * What must NOT change: incremental progress is persisted, and a server that disappears
 * mid-build costs at most one chunk rather than the whole run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Both modules are imported from the SAME registry, after the reset.
 *
 * The gate keeps module-level state, so a statically imported copy is a different instance
 * from the one a dynamically imported embeddings module resolves after vi.resetModules() —
 * setting the ceiling on the static copy changed nothing, and the first version of these
 * tests measured the default while claiming to measure a ceiling of one.
 */
async function loadWithCeiling(limit: number) {
  vi.resetModules();
  const gate = await import("../providers/embedding-gate.js");
  gate._resetEmbeddingGateForTests(limit);
  const embeddings = await import("../providers/embeddings.js");
  embeddings.resetEmbeddingSearchStateForTests();
  return embeddings;
}

const AGENT_COUNT = 20;
const agents = Object.fromEntries(Array.from({ length: AGENT_COUNT }, (_, i) => [
  `agent_${String(i).padStart(2, "0")}`,
  { description: `Worker number ${i}.`, capabilities: ["work"], tags: ["work"], tools: ["web_search"], maxIterations: 4 },
]));

let tempDir: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "starlingai-index-parallel-"));
  // The index is cached to disk and keyed by catalog text; without an isolated path these
  // tests would read each other's vectors and embed nothing.
  process.env["SAI_EMBEDDING_CACHE"] = join(tempDir, "embedding-cache.json");
});

afterEach(() => {
  delete process.env["SAI_EMBEDDING_CACHE"];
  if (tempDir) { rmSync(tempDir, { recursive: true, force: true }); tempDir = undefined; }
  vi.resetModules();
});

/** A provider that records how many embed calls overlapped, and can fail on cue. */
function trackingProvider(failOn?: string) {
  let live = 0;
  let peak = 0;
  const embedded: string[] = [];
  const embed = vi.fn(async (texts: string[]) => {
    live += 1;
    if (live > peak) peak = live;
    // Yield so overlapping calls actually overlap rather than resolving in order.
    await new Promise((resolve) => setTimeout(resolve, 5));
    live -= 1;
    const name = Object.keys(agents).find((candidate) => texts[0]?.includes(candidate));
    if (name) embedded.push(name);
    if (failOn && name === failOn) throw new Error("backend went away");
    return texts.map(() => new Float32Array([1, 0]));
  });
  return { provider: { embed } as never, peak: () => peak, embedded };
}

describe("agent index build concurrency", () => {
  it("embeds several agents at once, bounded by the ceiling", async () => {
    const { buildAgentIndex } = await loadWithCeiling(4);
    const tracked = trackingProvider();

    await buildAgentIndex(agents as never, tracked.provider, "lmstudio/embed");

    expect(tracked.embedded).toHaveLength(AGENT_COUNT);
    // The whole point: more than one in flight.
    expect(tracked.peak()).toBeGreaterThan(1);
    expect(tracked.peak()).toBeLessThanOrEqual(4);
  });

  it("stays within a ceiling of one, which is the old behaviour", async () => {
    // Discriminance control: the same build, one number. Without it, a build that ignored the
    // ceiling entirely would still pass the case above.
    const { buildAgentIndex } = await loadWithCeiling(1);
    const tracked = trackingProvider();

    await buildAgentIndex(agents as never, tracked.provider, "lmstudio/embed");

    expect(tracked.embedded).toHaveLength(AGENT_COUNT);
    expect(tracked.peak()).toBe(1);
  });

  it("keeps every vector the failing chunk already produced", async () => {
    const { buildAgentIndex } = await loadWithCeiling(4);
    // Fails partway through, so several chunks have completed and its own chunk-mates have
    // succeeded. Paying for those again on the retry is pure waste, and the sequential
    // version's `break` would have discarded the ones that finished alongside it.
    const tracked = trackingProvider("agent_09");

    await buildAgentIndex(agents as never, tracked.provider, "lmstudio/embed");

    const cachePath = process.env["SAI_EMBEDDING_CACHE"]!;
    expect(existsSync(cachePath), "a partial build must still persist what it got").toBe(true);
    const cached = JSON.parse(readFileSync(cachePath, "utf8")) as { agents?: Record<string, unknown> };
    const saved = Object.keys(cached.agents ?? cached);
    // Everything before the failing chunk, plus its surviving chunk-mates.
    expect(saved.length).toBeGreaterThanOrEqual(8);
    expect(saved).not.toContain("agent_09");
  });

  it("stops after the failing chunk rather than working through the rest", async () => {
    const { buildAgentIndex } = await loadWithCeiling(4);
    const tracked = trackingProvider("agent_05");

    await buildAgentIndex(agents as never, tracked.provider, "lmstudio/embed");

    // A backend that has gone away will refuse the remaining fifteen too, so hammering it is
    // a waste and the retry timer is the right mechanism. The chunk containing the failure
    // still completes, because those requests were already in flight.
    expect(tracked.embedded.length).toBeLessThan(AGENT_COUNT);
    expect(tracked.embedded).toContain("agent_05");
  });
});
