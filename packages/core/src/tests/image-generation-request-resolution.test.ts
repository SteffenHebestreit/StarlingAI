/**
 * Defaults are resolved ONCE, so no caller can get them wrong by omission.
 *
 * They used to be resolved by each caller. The agent tool did it correctly; the REST route
 * at /api/multimodal/generate-image did not, and the failure was total rather than subtle:
 * a caller naming `image-quality` without a tier got the FAST tier's guidance of 7.5, which
 * on a model whose own config calls CFG redundant roughly DOUBLES its ~170s render, judged
 * against the FAST tier's 120s timeout. Every default-sized request aborted at 120s, the
 * caller got a 502, and the device carried on producing an image nobody would receive —
 * while the released concurrency slot let the next caller queue behind the orphan inside the
 * backend, which is the exact thing the gate exists to prevent.
 *
 * So these tests are about what happens when a caller says NOTHING. A rule that only works
 * when every call site remembers it is not a rule.
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
  qualityTimeoutMs: 300_000,
  fixedSizeModels: ["image"],
  defaultWidth: 1024,
  defaultHeight: 1024,
  defaultSteps: 20,
  defaultGuidanceScale: 7.5,
  qualityDefaults: { steps: 20, guidanceScale: 1 },
};

/** Records the request body and the timeout the adapter chose. */
function stub() {
  const calls: Array<{ body: Record<string, unknown>; signal: AbortSignal | null }> = [];
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown>, signal: init?.signal ?? null });
    return new Response(JSON.stringify({ data: [{ b64_json: "QUJD" }] }), {
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

describe("image request resolution", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("infers the QUALITY tier from the model when no tier is given", async () => {
    // The REST route's exact shape: a prompt and a model, nothing else.
    const net = stub();

    await requestImageGeneration(CLUSTER, { prompt: "a lighthouse", model: "image-quality" });

    const body = net.calls[0]!.body;
    expect(body["model"]).toBe("image-quality");
    // The number that was wrong: 7.5 here doubles this model's render for a worse picture.
    expect(body["guidance_scale"]).toBe(1);
    expect(body["steps"]).toBe(20);
  });

  it("keeps the FAST tier's guidance when the model is the fast one — the control", async () => {
    // Without this, always applying the quality defaults would satisfy the case above while
    // flattening the tier that genuinely wants 7.5.
    const net = stub();

    await requestImageGeneration(CLUSTER, { prompt: "a lighthouse" });

    expect(net.calls[0]!.body["model"]).toBe("image");
    expect(net.calls[0]!.body["guidance_scale"]).toBe(7.5);
  });

  it("fills width and height from config when the caller omits them", async () => {
    const net = stub();

    await requestImageGeneration(CLUSTER, { prompt: "a lighthouse" });

    expect(net.calls[0]!.body["size"]).toBe("1024x1024");
  });

  it("lets the NAMED MODEL decide the tier, overriding a contradictory tier", async () => {
    // This case used to assert the opposite — that a stated tier beat the model — and that
    // assertion re-created the exact defect described at the top of this file. `image-quality`
    // at the fast tier's guidance of 7.5 roughly doubles a ~170s render and then judges it
    // against the fast tier's 120s timeout, so it aborts every time while the device keeps
    // going. The old rule simply required the caller to say `tier: "fast"` out loud to earn it.
    //
    // The two are not independent knobs: a tier's whole job is to pick a model and the
    // sampling defaults that suit it, so a named model has already chosen its tier.
    const net = stub();

    await requestImageGeneration(CLUSTER, { prompt: "a lighthouse", model: "image-quality", tier: "fast" });

    expect(net.calls[0]!.body["model"]).toBe("image-quality");
    expect(net.calls[0]!.body["guidance_scale"]).toBe(1);
  });

  it("does the same in the other direction — the fast model never gets quality's defaults", async () => {
    // `{model: "image", tier: "quality"}` rendered on the FAST model while taking the quality
    // tier's steps, guidance and 300s budget, and reported `tier: "quality"` back to the
    // caller: a render on one engine labelled as the other. This is the direction a settings
    // UI hits, because a UI offers model and quality as separate controls.
    const net = stub();

    const result = await requestImageGeneration(CLUSTER, {
      prompt: "a lighthouse", model: "image", tier: "quality",
    });

    expect(net.calls[0]!.body["model"]).toBe("image");
    expect(net.calls[0]!.body["guidance_scale"]).toBe(7.5);
    // And the report back matches what actually ran, rather than what was asked for.
    expect(result.tier).toBe("fast");
  });

  it("keeps honouring a stated tier for a model outside the configured pair", async () => {
    // The control that keeps the rule from becoming "ignore the tier". A station-local id is
    // neither `image` nor `image-quality`, so nothing can be derived from it and the caller's
    // stated tier is the only signal for which sampling defaults to use.
    const net = stub();

    await requestImageGeneration(CLUSTER, {
      prompt: "a lighthouse", model: "corsair/qwen-image", tier: "quality",
    });

    expect(net.calls[0]!.body["model"]).toBe("corsair/qwen-image");
    expect(net.calls[0]!.body["guidance_scale"]).toBe(1);
  });

  it("lets an explicit parameter win over every default", async () => {
    const net = stub();

    await requestImageGeneration(CLUSTER, {
      prompt: "a lighthouse", model: "image-quality", steps: 4, guidanceScale: 3, width: 512, height: 768,
    });

    const body = net.calls[0]!.body;
    expect(body["steps"]).toBe(4);
    expect(body["guidance_scale"]).toBe(3);
    expect(body["size"]).toBe("512x768");
  });

  it("gives the quality tier its own TIMEOUT when the tier was inferred from the model", async () => {
    // The other half of the defect, and the half that actually burned the device: a 120s cap
    // on a ~170s render aborts every time, and the abort is invisible to the backend, which
    // keeps going. A request that survives past 120s but dies after 300s proves the resolved
    // tier chose qualityTimeoutMs rather than timeoutMs.
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", vi.fn((_i: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")));
        })));

      let settled: "pending" | "rejected" = "pending";
      const run = requestImageGeneration(CLUSTER, { prompt: "a lighthouse", model: "image-quality" })
        .catch(() => { settled = "rejected"; });

      await vi.advanceTimersByTimeAsync(150_000);
      expect(settled, "aborted at the FAST tier's 120s cap — the bug").toBe("pending");

      await vi.advanceTimersByTimeAsync(200_000);
      expect(settled, "never aborted at all — an unbounded request is its own defect").toBe("rejected");
      await run;
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds the FAST tier to its shorter timeout — the control", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", vi.fn((_i: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")));
        })));

      let settled: "pending" | "rejected" = "pending";
      const run = requestImageGeneration(CLUSTER, { prompt: "a lighthouse" })
        .catch(() => { settled = "rejected"; });

      await vi.advanceTimersByTimeAsync(150_000);
      expect(settled, "the fast tier must NOT inherit the quality budget").toBe("rejected");
      await run;
    } finally {
      vi.useRealTimers();
    }
  });
});
