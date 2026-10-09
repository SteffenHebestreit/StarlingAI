/**
 * "Ask again" is not "your request was wrong".
 *
 * This endpoint documents two temporary refusals. 429 is a busy signal — each tier renders
 * one image at a time, a second request waits, and a third is refused outright rather than
 * queued behind a two-minute job. 503 is the fast tier saying its neural accelerator wedged,
 * that it rebuilt itself, and that the request should be repeated; the operator hit exactly
 * that wedge once while bringing the cluster up.
 *
 * Reporting either as "image generation failed" hands the user a dead end for a condition
 * the server said was temporary, and the agent above it then tells them to go and use some
 * other service. So both are retried, bounded, and everything else still fails at once —
 * retrying a 400 would just spend the cluster's time reproducing a rejection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  qualityTimeoutMs: 300_000,
  fixedSizeModels: ["image"],
};

const REQUEST = { prompt: "a lighthouse", width: 1024, height: 1024, steps: 20, guidanceScale: 7.5 };

const OK = () => new Response(JSON.stringify({ data: [{ b64_json: "QUJD" }] }), {
  headers: { "Content-Type": "application/json" },
});
const BUSY = () => new Response(JSON.stringify({ error: { message: "tier is busy" } }), {
  status: 429, headers: { "Content-Type": "application/json" },
});
const WEDGED = () => new Response(JSON.stringify({ error: { message: "accelerator rebuilt, retry" } }), {
  status: 503, headers: { "Content-Type": "application/json" },
});
const BAD = () => new Response(JSON.stringify({ error: { message: "prompt is required" } }), {
  status: 400, headers: { "Content-Type": "application/json" },
});

/** Queue of responses, one per attempt. */
function stubSequence(...responses: Array<() => Response>) {
  let i = 0;
  const fetchMock = vi.fn(async () => (responses[Math.min(i++, responses.length - 1)]!)());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Run a generation to completion while driving the backoff timers. */
async function runWithTimers<T>(work: Promise<T>): Promise<T> {
  const settled = work.then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e }));
  // Each advance releases one backoff and lets the next attempt's promises resolve.
  for (let i = 0; i < 6; i += 1) await vi.advanceTimersByTimeAsync(5_000);
  const outcome = await settled;
  if (!outcome.ok) throw outcome.e;
  return outcome.v;
}

describe("temporary refusals from the image endpoint", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("retries a 429 busy signal and succeeds", async () => {
    const fetchMock = stubSequence(BUSY, OK);

    const result = await runWithTimers(requestImageGeneration(CLUSTER, { ...REQUEST }));

    expect(result.imageBase64).toBe("QUJD");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 503 from the fast tier's wedged accelerator", async () => {
    const fetchMock = stubSequence(WEDGED, OK);

    const result = await runWithTimers(requestImageGeneration(CLUSTER, { ...REQUEST }));

    expect(result.imageBase64).toBe("QUJD");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a 400 — the control that keeps the retry narrow", async () => {
    // Without this, retrying everything would spend the cluster's time reproducing a
    // rejection the server already explained, and hide the explanation behind a delay.
    const fetchMock = stubSequence(BAD, OK);

    await expect(runWithTimers(requestImageGeneration(CLUSTER, { ...REQUEST })))
      .rejects.toThrow(/prompt is required/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after a bounded number of attempts, reporting the upstream reason", async () => {
    // The other control: a tier that is busy indefinitely must not hold the caller forever.
    const fetchMock = stubSequence(BUSY, BUSY, BUSY, BUSY);

    await expect(runWithTimers(requestImageGeneration(CLUSTER, { ...REQUEST })))
      .rejects.toThrow(/tier is busy/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("still names the status when it finally fails", async () => {
    stubSequence(BUSY, BUSY, BUSY);

    await expect(runWithTimers(requestImageGeneration(CLUSTER, { ...REQUEST })))
      .rejects.toThrow(/429/);
  });
});
