/**
 * One in-flight generation per model, and per model only.
 *
 * sd-server generates serially. A second request for the same model does not run in
 * parallel — it waits inside the backend with our client clock already running. Measured on
 * the cluster, a quality image takes 136-143 s against a 210 s client cap, so two requests
 * arriving together put the second at 280 s: abandoned by us at 210 s having generated for
 * about 70. The client would have reported a timeout for a request that was going to
 * succeed, which is the same class of mistake the backend's own 60 s peer header timeout
 * made — a cap shorter than the work it is capping.
 *
 * Per MODEL rather than globally, because the tiers sit on different devices. That is not an
 * assumption: an NPU job issued during an iGPU generation returned in 14.9 s against 9.9 s
 * idle, so they contend mildly and do not block. A global slot would park a 10-second fast
 * request behind a 140-second quality one for no hardware reason, which is why the
 * cross-model test below matters as much as the same-model one.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  requestImageGeneration,
  type ImageGenerationBackendConfig,
} from "../multimodal/image-generation.js";

const CLUSTER: ImageGenerationBackendConfig = {
  api: "openai-compatible",
  baseUrl: "http://cluster:8080/v1",
  model: "image",
  qualityModel: "image-quality",
  timeoutMs: 120_000,
  qualityTimeoutMs: 210_000,
};

// steps/guidanceScale are required by ImageGenerationRequest; the values are irrelevant
// here because the stubbed backend never renders anything.
const SQUARE = { prompt: "a lighthouse", width: 1024, height: 1024, steps: 20, guidanceScale: 7 };

/** Let queued microtasks settle so a slot handoff has actually happened. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

/**
 * A fetch that blocks until released, recording peak simultaneous calls per model.
 *
 * The peak is the measurement. Counting total calls would not distinguish a gate that works
 * from no gate at all, since both eventually issue every request.
 */
function blockingFetch() {
  const inFlight = new Map<string, number>();
  const peak = new Map<string, number>();
  const waiting: Array<() => void> = [];

  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const model = String((JSON.parse(String(init?.body)) as { model: string }).model);
    const now = (inFlight.get(model) ?? 0) + 1;
    inFlight.set(model, now);
    peak.set(model, Math.max(peak.get(model) ?? 0, now));

    await new Promise<void>((resolve) => { waiting.push(resolve); });

    inFlight.set(model, (inFlight.get(model) ?? 1) - 1);
    return new Response(JSON.stringify({ data: [{ b64_json: "QUJD" }] }), {
      headers: { "Content-Type": "application/json" },
    });
  });

  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    peakFor: (model: string) => peak.get(model) ?? 0,
    started: () => fetchMock.mock.calls.length,
    /** Release everything currently blocked, repeatedly, until nothing new starts. */
    async drain() {
      for (let round = 0; round < 10; round += 1) {
        while (waiting.length > 0) waiting.shift()!();
        await settle();
        if (waiting.length === 0) break;
      }
      while (waiting.length > 0) waiting.shift()!();
      await settle();
    },
  };
}

describe("image generation concurrency", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("runs ONE generation at a time for the same model", async () => {
    const net = blockingFetch();

    const both = Promise.all([
      requestImageGeneration(CLUSTER, { ...SQUARE, tier: "quality" }),
      requestImageGeneration(CLUSTER, { ...SQUARE, tier: "quality" }),
    ]);
    await settle();

    // The second request must still be waiting for a slot, not sitting in the backend's
    // queue burning its own timeout.
    expect(net.started()).toBe(1);
    expect(net.peakFor("image-quality")).toBe(1);

    await net.drain();
    const results = await both;

    // Both still complete — this gate queues, it never refuses.
    expect(results).toHaveLength(2);
    expect(net.peakFor("image-quality")).toBe(1);
    expect(net.started()).toBe(2);
  });

  it("does NOT serialize different models — the control that keeps the gate per-device", async () => {
    // Without this, a single global slot would pass the test above while making the fast
    // tier wait out a 140-second quality generation. The hardware says they can overlap.
    const net = blockingFetch();

    const both = Promise.all([
      requestImageGeneration(CLUSTER, { ...SQUARE, tier: "quality" }),
      requestImageGeneration(CLUSTER, { ...SQUARE, tier: "fast" }),
    ]);
    await settle();

    expect(net.started()).toBe(2);
    expect(net.peakFor("image-quality")).toBe(1);
    expect(net.peakFor("image")).toBe(1);

    await net.drain();
    await both;
  });

  it("rejects an invalid request IMMEDIATELY instead of queueing it behind a generation", async () => {
    // Validation sits before the slot for this reason. A size this endpoint refuses is
    // knowable without the network, and making it wait out someone else's 140-second image
    // before saying so would be a worse answer delivered later.
    const net = blockingFetch();

    const running = requestImageGeneration(CLUSTER, { ...SQUARE, tier: "quality" });
    await settle();
    expect(net.started()).toBe(1);

    await expect(
      requestImageGeneration(CLUSTER, { ...SQUARE, width: 512, height: 512, tier: "quality" }),
    ).rejects.toThrow(/1024x1024 only/);

    // And it never touched the network: the rejection is local.
    expect(net.started()).toBe(1);

    await net.drain();
    await running;
  });

  it("follows the CONFIGURED ceiling, because the device count is deployment-specific", async () => {
    // The cluster's fast tier gained a second NPU station and now load-balances across both:
    // six concurrent requests finished in 38.5 s in a 9.9 / 10.0 / 19.5 / 19.5 / 29.1 / 38.5
    // stagger, which is two at a time. A hardcoded ceiling of one would leave half of it
    // idle, so the number comes from config.
    const twoStations: ImageGenerationBackendConfig = {
      ...CLUSTER,
      maxConcurrentPerModel: { image: 2 },
    };
    const net = blockingFetch();

    const all = Promise.all([
      requestImageGeneration(twoStations, { ...SQUARE, tier: "fast" }),
      requestImageGeneration(twoStations, { ...SQUARE, tier: "fast" }),
      requestImageGeneration(twoStations, { ...SQUARE, tier: "fast" }),
    ]);
    await settle();

    // Two on the wire, the third holding — the stagger, reproduced.
    expect(net.started()).toBe(2);
    expect(net.peakFor("image")).toBe(2);

    await net.drain();
    await all;
    expect(net.started()).toBe(3);
    // And it never exceeded the ceiling on the way.
    expect(net.peakFor("image")).toBe(2);
  });

  it("keeps the OTHER model at its own ceiling when one model is raised", async () => {
    // The control: raising the fast tier must not raise the single-iGPU quality tier, where
    // a second concurrent request would sit in the backend burning its own timeout.
    const twoStations: ImageGenerationBackendConfig = {
      ...CLUSTER,
      maxConcurrentPerModel: { image: 2 },
    };
    const net = blockingFetch();

    const all = Promise.all([
      requestImageGeneration(twoStations, { ...SQUARE, tier: "quality" }),
      requestImageGeneration(twoStations, { ...SQUARE, tier: "quality" }),
    ]);
    await settle();

    expect(net.peakFor("image-quality")).toBe(1);
    expect(net.started()).toBe(1);

    await net.drain();
    await all;
  });

  it("sends the FAST model when no tier is given — the default that protects the cluster", async () => {
    // The tier is a cost choice paid by everyone else on the machine, so the absence of a
    // choice has to resolve to the cheap one. Live, an agent asked for `quality` four times
    // on a request that said "schnell": ~2.5 min each, serialising the iGPU. The wording
    // that invited that is fixed separately; this pins the code-level default underneath it.
    const net = blockingFetch();
    const run = requestImageGeneration(CLUSTER, { ...SQUARE });
    await settle();

    const body = JSON.parse(String(net.fetchMock.mock.calls[0]![1]?.body)) as { model: string };
    expect(body.model).toBe("image");

    await net.drain();
    await run;
  });

  it("sends the QUALITY model only when that tier is asked for — the control", async () => {
    const net = blockingFetch();
    const run = requestImageGeneration(CLUSTER, { ...SQUARE, tier: "quality" });
    await settle();

    const body = JSON.parse(String(net.fetchMock.mock.calls[0]![1]?.body)) as { model: string };
    expect(body.model).toBe("image-quality");

    await net.drain();
    await run;
  });

  it("releases the slot when a generation FAILS, so one error does not wedge the tier", async () => {
    // The release is in a `finally`. Without it a single 502 would leave the slot held and
    // every later request for that model would queue forever — a failure that looks like a
    // hang rather than like the error that caused it.
    const fetchMock = vi.fn(async () => new Response("upstream on fire", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestImageGeneration(CLUSTER, { ...SQUARE, tier: "quality" })).rejects.toThrow(/502/);
    await expect(requestImageGeneration(CLUSTER, { ...SQUARE, tier: "quality" })).rejects.toThrow(/502/);

    // The second attempt reached the network at all, which is the thing being asserted.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
