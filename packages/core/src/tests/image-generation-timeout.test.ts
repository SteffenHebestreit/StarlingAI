/**
 * A render's time budget follows the render, a timeout says what happened, and the device is
 * treated as busy while it finishes what we abandoned.
 *
 * Session 807684e9: the user set a quality render to 57 steps at 1344x768 — about eight minutes on
 * Qwen-Image — and the fixed 300 s budget aborted it at exactly 300 s with "This operation was
 * aborted". The agent retried the same settings; the retry took the slot the abort had freed, went
 * straight into the backend's own queue behind the render nobody was waiting for any more, and was
 * aborted at 300 s as well.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ImageGenerationTimeoutError,
  expectedImageRenderSeconds,
  imageDeviceBusyMs,
  imageRenderWork,
  imageRequestTimeoutMs,
  requestImageGeneration,
  type ImageGenerationBackendConfig,
} from "../multimodal/image-generation.js";

const CLUSTER: ImageGenerationBackendConfig = {
  api: "openai-compatible",
  baseUrl: "http://cluster:8080/v1",
  model: "image",
  qualityModel: "image-quality",
  tierLabels: { fast: "Segmind Vega", quality: "Qwen-Image 2.1" },
  timeoutMs: 120_000,
  qualityTimeoutMs: 300_000,
  fixedSizeModels: ["image"],
  defaultWidth: 1024,
  defaultHeight: 1024,
  defaultSteps: 20,
  defaultGuidanceScale: 7.5,
  qualityDefaults: { steps: 20, guidanceScale: 1 },
};

/** The settings the user chose in 807684e9. */
const SESSION_807684E9 = { prompt: "a sunset, photograph", tier: "quality" as const, steps: 57, width: 1344, height: 768 };

/** A backend that never answers: the only way a request ends is our own timer. */
function hangingFetch() {
  const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("This operation was aborted")));
    }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Track how a promise settled without awaiting it, so fake time can be advanced around it. */
function watch<T>(promise: Promise<T>) {
  const state: { settled: "pending" | "resolved" | "rejected"; error?: unknown } = { settled: "pending" };
  promise.then(() => { state.settled = "resolved"; }, (error: unknown) => { state.settled = "rejected"; state.error = error; });
  return state;
}

describe("the render budget follows the request", () => {
  it("scales with steps, area and true CFG against the tier's own defaults", () => {
    expect(imageRenderWork(CLUSTER, { tier: "quality", steps: 20, width: 1024, height: 1024, guidanceScale: 1 })).toBe(1);
    expect(imageRenderWork(CLUSTER, { ...SESSION_807684E9, guidanceScale: 1 })).toBeCloseTo((57 / 20) * ((1344 * 768) / (1024 * 1024)), 6);
    // True CFG doubles the forward passes where the engine's default is embedded guidance (≤ 1)…
    expect(imageRenderWork(CLUSTER, { tier: "quality", steps: 20, width: 1024, height: 1024, guidanceScale: 4 })).toBe(2);
    // …and not on an engine that already runs CFG at its default.
    expect(imageRenderWork(CLUSTER, { tier: "fast", steps: 20, width: 1024, height: 1024, guidanceScale: 9 })).toBe(1);
  });

  it("gives 57 steps at 1344x768 about 2.8 times the quality budget, and expects about eight minutes", () => {
    const shape = { ...SESSION_807684E9, guidanceScale: 1 };
    expect(imageRequestTimeoutMs(CLUSTER, shape)).toBeGreaterThan(300_000 * 2.8);
    expect(imageRequestTimeoutMs(CLUSTER, shape)).toBeLessThan(300_000 * 2.81);
    expect(expectedImageRenderSeconds(CLUSTER, shape)).toBeCloseTo(170 * 2.8055, 0);
  });

  it("keeps the configured budget at the defaults, and never gives a smaller request less", () => {
    expect(imageRequestTimeoutMs(CLUSTER, { tier: "quality", steps: 20, width: 1024, height: 1024, guidanceScale: 1 })).toBe(300_000);
    expect(imageRequestTimeoutMs(CLUSTER, { tier: "quality", steps: 8, width: 512, height: 512, guidanceScale: 1 })).toBe(300_000);
    expect(imageRequestTimeoutMs(CLUSTER, { tier: "fast", steps: 20, width: 1024, height: 1024, guidanceScale: 7.5 })).toBe(120_000);
  });

  it("refuses steps and sizes past the bounds before anything is sent, instead of budgeting hours for them", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      // 1000 steps at 2048x2048 with true CFG: 400 times a default render, a 33-hour budget.
      await expect(requestImageGeneration(CLUSTER, { prompt: "x", tier: "quality", steps: 1000, width: 2048, height: 2048, guidanceScale: 4 }))
        .rejects.toThrow("steps must be a whole number from 1 to 100 (asked for 1000). Nothing was rendered.");
      await expect(requestImageGeneration(CLUSTER, { prompt: "x", tier: "quality", width: 4096, height: 1024 }))
        .rejects.toThrow("width must be a whole number of pixels up to 2048 (asked for 4096)");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("a render is abandoned at its own budget, and says why", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("lets 57 steps at 1344x768 run past 300 s, and times it out near 300 s × 2.8", async () => {
    vi.useFakeTimers();
    hangingFetch();
    const run = watch(requestImageGeneration({ ...CLUSTER, qualityModel: "q-807" }, SESSION_807684E9));

    await vi.advanceTimersByTimeAsync(800_000);
    expect(run.settled, "aborted at the flat 300 s budget — the defect in 807684e9").toBe("pending");
    await vi.advanceTimersByTimeAsync(50_000);
    expect(run.settled).toBe("rejected");
    expect(run.error).toBeInstanceOf(ImageGenerationTimeoutError);
  });

  it("keeps a default render at the configured 300 s, and gives a small one no less", async () => {
    vi.useFakeTimers();
    hangingFetch();
    const standard = watch(requestImageGeneration({ ...CLUSTER, qualityModel: "q-default" }, { prompt: "x", tier: "quality" }));
    const small = watch(requestImageGeneration({ ...CLUSTER, qualityModel: "q-small" }, { prompt: "x", tier: "quality", steps: 8, width: 512, height: 512 }));

    await vi.advanceTimersByTimeAsync(299_000);
    expect(standard.settled).toBe("pending");
    expect(small.settled, "a smaller request lost the margin the configured budget carries").toBe("pending");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(standard.settled).toBe("rejected");
    expect(small.settled).toBe("rejected");
  });

  it("names the engine, the limit, the settings, the expected time, and says not to retry them", async () => {
    vi.useFakeTimers();
    hangingFetch();
    const run = watch(requestImageGeneration({ ...CLUSTER, qualityModel: "q-words" }, SESSION_807684E9));
    await vi.advanceTimersByTimeAsync(900_000);

    const error = run.error as ImageGenerationTimeoutError;
    expect(error).toBeInstanceOf(ImageGenerationTimeoutError);
    expect(error.message).toContain("Qwen-Image 2.1 (the quality tier) did not finish within 14 min");
    expect(error.message).toContain("57 steps at 1344x768 were expected to take about 8 min");
    expect(error.message).toContain("renders one picture at a time and keeps working on an abandoned one");
    expect(error.message).toContain("do NOT call generate_image again with the same settings");
    expect(error.message).toContain("offer fewer steps or a smaller size");
    expect(error.message).not.toContain("aborted");
    expect(error.details).toMatchObject({ tier: "quality", model: "q-words", steps: 57, width: 1344, height: 768 });
    expect(error.details.timeoutMs).toBe(imageRequestTimeoutMs(CLUSTER, { ...SESSION_807684E9, guidanceScale: 1 }));
  });

  it("scales the AUTOMATIC1111 route's budget too", async () => {
    vi.useFakeTimers();
    hangingFetch();
    const viaA1111: ImageGenerationBackendConfig = {
      ...CLUSTER,
      qualityBackend: { api: "automatic1111-compatible", baseUrl: "http://worker:8080", model: "qwen-a1111", timeoutMs: 300_000 },
    };
    const run = watch(requestImageGeneration(viaA1111, { prompt: "x", tier: "quality", steps: 40 }));

    await vi.advanceTimersByTimeAsync(590_000);
    expect(run.settled, "the A1111 adapter kept the flat budget").toBe("pending");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(run.error).toBeInstanceOf(ImageGenerationTimeoutError);
  });

  it("scales the ComfyUI deadline too", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/prompt")
      ? new Response(JSON.stringify({ prompt_id: "p1" }), { headers: { "Content-Type": "application/json" } })
      // Still rendering: the history has no entry yet.
      : new Response(JSON.stringify({}), { headers: { "Content-Type": "application/json" } })));
    const comfy: ImageGenerationBackendConfig = { api: "comfyui", baseUrl: "http://comfy:8188", model: "sdxl", timeoutMs: 10_000, defaultSteps: 20 };
    const run = watch(requestImageGeneration(comfy, { prompt: "x", steps: 40, width: 1024, height: 1024 }));

    await vi.advanceTimersByTimeAsync(15_000);
    expect(run.settled, "the ComfyUI deadline kept the flat budget").toBe("pending");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run.error).toBeInstanceOf(ImageGenerationTimeoutError);
  });
});

describe("the device stays busy after a timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** The first call hangs until our timer aborts it; every later one answers after `renderMs`. */
  function firstHangsThenRenders(renderMs: number) {
    const started: Array<{ model: string; at: number }> = [];
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const model = String((JSON.parse(String(init?.body)) as { model: string }).model);
      started.push({ model, at: Date.now() });
      if (started.length === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("This operation was aborted")));
        });
      }
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response(JSON.stringify({ data: [{ b64_json: "QUJD" }] }), {
          headers: { "Content-Type": "application/json" },
        })), renderMs);
        init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("This operation was aborted")); });
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    return { fetchMock, started };
  }

  it("makes the next request wait out the abandoned render BEFORE its own clock starts", async () => {
    vi.useFakeTimers();
    const config = { ...CLUSTER, qualityModel: "q-busy" };
    // The retry's own render takes 250 s: inside its 300 s budget only if the wait did not count.
    const net = firstHangsThenRenders(250_000);

    const first = watch(requestImageGeneration(config, { prompt: "x", tier: "quality" }));
    await vi.advanceTimersByTimeAsync(300_001);
    expect(first.error).toBeInstanceOf(ImageGenerationTimeoutError);

    const retry = watch(requestImageGeneration(config, { prompt: "x", tier: "quality" }));
    await vi.advanceTimersByTimeAsync(169_000);
    expect(net.started, "the retry went into the backend's queue while it was still rendering").toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(net.started).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(250_000);
    expect(retry.settled, "the wait was charged to the retry's own budget").toBe("resolved");
  });

  it("says how long a render waited for the device, and tells the settings step while it is busy", async () => {
    vi.useFakeTimers();
    const config = { ...CLUSTER, qualityModel: "q-busy-said" };
    firstHangsThenRenders(10_000);

    expect(imageDeviceBusyMs(config, "quality")).toBe(0);
    const first = watch(requestImageGeneration(config, { prompt: "x", tier: "quality" }));
    await vi.advanceTimersByTimeAsync(300_001);
    expect(first.error).toBeInstanceOf(ImageGenerationTimeoutError);
    // The abandoned render's expected time, 170 s, less the millisecond already gone.
    expect(imageDeviceBusyMs(config, "quality")).toBe(169_999);
    expect(imageDeviceBusyMs(config, "fast"), "the other engine is free").toBe(0);

    const retry = requestImageGeneration(config, { prompt: "x", tier: "quality" });
    await vi.advanceTimersByTimeAsync(169_999 + 10_000);
    expect(await retry).toMatchObject({ deviceWaitMs: 169_999, tier: "quality" });
    expect(imageDeviceBusyMs(config, "quality"), "a finished render frees the device").toBe(0);
  });

  it("clears the mark when a render finishes, even while the abandoned one's time is not up", async () => {
    vi.useFakeTimers();
    // Two at a time on this model: one request is abandoned while another is still rendering.
    const config = { ...CLUSTER, qualityModel: "q-busy-pair", maxConcurrentPerModel: { "q-busy-pair": 2 } };
    const net = firstHangsThenRenders(250_000);

    const abandoned = watch(requestImageGeneration(config, { prompt: "x", tier: "quality" }));
    await vi.advanceTimersByTimeAsync(100_000);
    const inFlight = watch(requestImageGeneration(config, { prompt: "x", tier: "quality" }));
    await vi.advanceTimersByTimeAsync(200_001);
    expect(abandoned.error, "abandoned at 300 s, marked busy until 470 s").toBeInstanceOf(ImageGenerationTimeoutError);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(inFlight.settled, "the other render finished at 350 s").toBe("resolved");

    // The device just proved it is free: the next request goes out at once, not at 470 s.
    const next = watch(requestImageGeneration(config, { prompt: "x", tier: "quality" }));
    await vi.advanceTimersByTimeAsync(1);
    expect(net.started, "the next request waited out a render that had already finished").toHaveLength(3);
    await vi.advanceTimersByTimeAsync(250_000);
    expect(next.settled).toBe("resolved");
  });

  it("does not hold back the OTHER model — the control", async () => {
    vi.useFakeTimers();
    const config = { ...CLUSTER, qualityModel: "q-busy-control", model: "fast-control" };
    const net = firstHangsThenRenders(5_000);

    const first = watch(requestImageGeneration(config, { prompt: "x", tier: "quality" }));
    await vi.advanceTimersByTimeAsync(300_001);
    expect(first.error).toBeInstanceOf(ImageGenerationTimeoutError);

    const fast = watch(requestImageGeneration(config, { prompt: "x", tier: "fast" }));
    await vi.advanceTimersByTimeAsync(1);
    expect(net.started.map((call) => call.model)).toEqual(["q-busy-control", "fast-control"]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fast.settled).toBe("resolved");
  });
});
