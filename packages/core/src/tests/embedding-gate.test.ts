/**
 * The embedding concurrency ceiling.
 *
 * The endpoint serves a small fixed number of embedding requests at once. Nothing on this
 * side knew that, and the callers cannot see each other: the agent index build, every routing
 * query, memory writes, skill lookup, self-improvement, the failover binding. Over the limit
 * the endpoint refuses a connection, and the caller reports it as "the embedding backend is
 * unavailable" — a message that sends the reader after the wrong thing entirely.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetEmbeddingGateForTests,
  getEmbeddingGateStats,
  setEmbeddingConcurrency,
  withEmbeddingSlot,
} from "../providers/embedding-gate.js";

afterEach(() => { _resetEmbeddingGateForTests(); vi.unstubAllEnvs(); });

/** A task that reports the concurrency it observed, so the ceiling is measured, not assumed. */
function makeTracker() {
  let live = 0;
  let peak = 0;
  const order: number[] = [];
  const run = (id: number, release: Promise<void>) => withEmbeddingSlot(async () => {
    live += 1;
    if (live > peak) peak = live;
    order.push(id);
    await release;
    live -= 1;
    return id;
  });
  return { run, peak: () => peak, order };
}

describe("embedding concurrency gate", () => {
  it("never lets more than the limit run at once", async () => {
    _resetEmbeddingGateForTests(2);
    const tracker = makeTracker();
    let releaseAll: () => void;
    const gate = new Promise<void>((resolve) => { releaseAll = resolve; });

    const all = Promise.all(Array.from({ length: 10 }, (_, i) => tracker.run(i, gate)));
    // Everything that could start has started; the rest are queued behind the ceiling.
    await Promise.resolve();
    expect(getEmbeddingGateStats().inFlight).toBe(2);
    expect(getEmbeddingGateStats().waiting).toBe(8);

    releaseAll!();
    await all;
    expect(tracker.peak()).toBe(2);
    expect(getEmbeddingGateStats().inFlight).toBe(0);
    expect(getEmbeddingGateStats().waiting).toBe(0);
  });

  it("lets a higher limit through, so the ceiling is the ceiling and not the code", async () => {
    // Discriminance control for the case above: identical work, one number changed. Without
    // this, a gate that simply serialised everything would pass the first test.
    _resetEmbeddingGateForTests(5);
    const tracker = makeTracker();
    let releaseAll: () => void;
    const gate = new Promise<void>((resolve) => { releaseAll = resolve; });

    const all = Promise.all(Array.from({ length: 10 }, (_, i) => tracker.run(i, gate)));
    await Promise.resolve();
    expect(getEmbeddingGateStats().inFlight).toBe(5);

    releaseAll!();
    await all;
    expect(tracker.peak()).toBe(5);
  });

  it("queues FIFO, so a burst cannot starve the request that arrived first", async () => {
    _resetEmbeddingGateForTests(1);
    const tracker = makeTracker();
    const releases: Array<() => void> = [];
    const tasks = Array.from({ length: 4 }, (_, i) => {
      const p = new Promise<void>((resolve) => { releases.push(resolve); });
      return tracker.run(i, p);
    });

    for (const release of releases) { release(); await Promise.resolve(); }
    await Promise.all(tasks);
    expect(tracker.order).toEqual([0, 1, 2, 3]);
  });

  it("releases the slot when the work THROWS", async () => {
    _resetEmbeddingGateForTests(1);
    // A throwing call that kept its slot would shrink the ceiling permanently, and the
    // symptom — embeddings getting slower and then stopping — would look nothing like the
    // cause. An embedding call throws routinely: timeouts, refused connections, 5xx.
    await expect(withEmbeddingSlot(async () => { throw new Error("backend refused"); })).rejects.toThrow("backend refused");
    expect(getEmbeddingGateStats().inFlight).toBe(0);

    // The next call must still get through.
    await expect(withEmbeddingSlot(async () => "ok")).resolves.toBe("ok");
  });

  it("raising the limit at runtime releases waiters immediately", async () => {
    _resetEmbeddingGateForTests(1);
    const tracker = makeTracker();
    let releaseAll: () => void;
    const gate = new Promise<void>((resolve) => { releaseAll = resolve; });
    const all = Promise.all(Array.from({ length: 4 }, (_, i) => tracker.run(i, gate)));
    await Promise.resolve();
    expect(getEmbeddingGateStats().inFlight).toBe(1);

    setEmbeddingConcurrency(3);
    await Promise.resolve();
    expect(getEmbeddingGateStats().inFlight).toBe(3);

    releaseAll!();
    await all;
  });

  it("reports what the ceiling actually cost", async () => {
    _resetEmbeddingGateForTests(1);
    let releaseAll: () => void;
    const gate = new Promise<void>((resolve) => { releaseAll = resolve; });
    const all = Promise.all(Array.from({ length: 3 }, () => withEmbeddingSlot(async () => { await gate; })));
    await Promise.resolve();
    releaseAll!();
    await all;

    const stats = getEmbeddingGateStats();
    // Two of the three had to wait. A `queued` of zero would mean the ceiling never bound,
    // which is the number that says whether the limit is set anywhere near the right place.
    expect(stats.queued).toBe(2);
    expect(stats.peakInFlight).toBe(1);
  });

  it("clamps a nonsensical limit rather than deadlocking on it", async () => {
    _resetEmbeddingGateForTests(2);
    setEmbeddingConcurrency(0);
    // A limit of zero would admit nobody, ever, and every embedding call would hang forever.
    expect(getEmbeddingGateStats().limit).toBe(1);
    await expect(withEmbeddingSlot(async () => "ok")).resolves.toBe("ok");
  });
});

describe("the provider routes embeddings through the gate", () => {
  /**
   * End to end: a config value, through the provider, to observed concurrency.
   *
   * Written this way because the first version set the gate directly and asserted on that.
   * It failed, and the failure was the point: `provider.embed` re-reads
   * `retrieval.embeddingConcurrency` on every call, so a limit set by hand is overwritten
   * before the first request goes out. A test that had guessed the config default instead
   * would have passed while proving nothing about the wiring.
   */
  async function peakConcurrencyWithConfiguredLimit(limit: number): Promise<number> {
    const dir = mkdtempSync(join(tmpdir(), "starlingai-embed-gate-"));
    try {
      const configPath = join(dir, "starlingai.json");
      writeFileSync(configPath, JSON.stringify({
        agents: { defaults: { model: { primary: "lmstudio/qwen", embeddingModel: "lmstudio/embed" } } },
        subAgents: {},
        retrieval: { embeddingConcurrency: limit },
      }), "utf8");
      process.env["SAI_CONFIG_PATH"] = configPath;
      vi.resetModules();

      let live = 0;
      let peak = 0;
      let releaseAll: () => void;
      const gate = new Promise<void>((resolve) => { releaseAll = resolve; });
      const create = vi.fn(async () => {
        live += 1;
        if (live > peak) peak = live;
        await gate;
        live -= 1;
        return { data: [{ embedding: [0.1, 0.2] }] };
      });

      const { LMStudioProvider } = await import("../providers/lmstudio.js");
      // The endpoint is never reached: the client is replaced below and `create` is a stub.
      const provider = new LMStudioProvider(
        "http://localhost:1/v1",
        "test-key",
        { primary: "lmstudio/qwen", embeddingModel: "lmstudio/embed" } as never,
      );
      (provider as unknown as { client: unknown }).client = { embeddings: { create } } as never;

      const calls = Promise.all(Array.from({ length: 12 }, () => provider.embed(["text"], "lmstudio/embed")));
      // Let every call reach the gate before any of them is allowed to finish.
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      releaseAll!();
      await calls;
      expect(create).toHaveBeenCalledTimes(12);
      return peak;
    } finally {
      delete process.env["SAI_CONFIG_PATH"];
      rmSync(dir, { recursive: true, force: true });
      vi.resetModules();
      const configLoader = await import("../config/loader.js");
      configLoader.resetConfigForTests();
    }
  }

  it("bounds concurrent provider.embed calls at the configured ceiling", async () => {
    // The point of putting the ceiling in the provider rather than in each caller: a caller
    // that knows nothing about it is bounded anyway.
    expect(await peakConcurrencyWithConfiguredLimit(2)).toBeLessThanOrEqual(2);
  });

  it("lets a higher configured ceiling through", async () => {
    // Discriminance control: identical work, one config value. Without it, a provider that
    // simply serialised every embed would pass the case above.
    const peak = await peakConcurrencyWithConfiguredLimit(6);
    expect(peak).toBeGreaterThan(2);
    expect(peak).toBeLessThanOrEqual(6);
  });
});
