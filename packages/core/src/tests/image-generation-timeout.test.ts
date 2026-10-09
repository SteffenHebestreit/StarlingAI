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
  IMAGE_TRANSPORT_OPTIONS,
  ImageGenerationTimeoutError,
  ImageRenderTooLongError,
  ImageUpstreamRequestError,
  expectedImageRenderSeconds,
  imageDeviceBusyMs,
  imageRenderLimitError,
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
  it("scales with steps, area and true CFG against the tier's measured reference render", () => {
    expect(imageRenderWork(CLUSTER, { tier: "quality", steps: 20, width: 1024, height: 1024, guidanceScale: 1 })).toBe(1);
    expect(imageRenderWork(CLUSTER, { ...SESSION_807684E9, guidanceScale: 1 })).toBeCloseTo((57 / 20) * ((1344 * 768) / (1024 * 1024)), 6);
    // True CFG doubles the forward passes where the engine renders without it (guidance ≤ 1)…
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

  it("measures work from the REFERENCE render, not the configured defaults: a 40-step default gets 40 steps' time", () => {
    // The quality default moved from 20 to Qwen-Image 2.1's official 40 steps. Work measured against
    // the defaults would have called that render 1.0 — 170 s expected and the 300 s budget of a
    // 20-step one — and abandoned a ~340 s render at 300 s while the engine rendered on.
    const forty: ImageGenerationBackendConfig = { ...CLUSTER, qualityDefaults: { steps: 40, guidanceScale: 1 } };
    const atDefaults = { tier: "quality" as const, steps: 40, width: 1024, height: 1024, guidanceScale: 1 };
    expect(imageRenderWork(forty, atDefaults)).toBe(2);
    expect(expectedImageRenderSeconds(forty, atDefaults)).toBe(340);
    expect(imageRequestTimeoutMs(forty, atDefaults)).toBe(600_000);
    // The server's own limit still caps it, with the grace an answer may take to arrive.
    expect(imageRequestTimeoutMs({ ...forty, maxRenderMs: 600_000 }, atDefaults)).toBe(600_000);
    expect(imageRenderLimitError({ ...forty, maxRenderMs: 600_000 }, atDefaults)).toBeUndefined();
    // And the measurement is not moved by a heavier default: 20 steps are still 20 steps' time.
    expect(expectedImageRenderSeconds(forty, { ...atDefaults, steps: 20 })).toBe(170);
  });

  it("keeps the configured budget at the reference render, and never gives a smaller request less", () => {
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

describe("the transport under a render", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // Session 9cc3f362: 47 and 50 steps at 1344x768 had a budget of about eleven minutes and both
  // failed at exactly 300.0 s — undici's default headersTimeout, which an image endpoint trips by
  // sending its headers only once the picture is done — and the failure read as "service offline".
  it("runs every image request on a dispatcher whose own timeouts are off, so only the render's budget applies", async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init ?? {});
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("png").toString("base64") }] }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    await requestImageGeneration(CLUSTER, { prompt: "a sunset", tier: "fast" });
    expect(seen).toHaveLength(1);
    expect((seen[0] as { dispatcher?: unknown }).dispatcher).toBeDefined();
    expect(IMAGE_TRANSPORT_OPTIONS).toMatchObject({ headersTimeout: 0, bodyTimeout: 0 });
  });

  it("keeps the transport's cause, and calls only a connection that never opened unreachable", async () => {
    const failWith = (code: string) => vi.stubGlobal("fetch", vi.fn(async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(`${code} happened`), { code }) });
    }));

    failWith("UND_ERR_HEADERS_TIMEOUT");
    const midRender = await requestImageGeneration(CLUSTER, { prompt: "a sunset", tier: "fast" }).catch((error: unknown) => error);
    expect(midRender).toBeInstanceOf(ImageUpstreamRequestError);
    expect((midRender as ImageUpstreamRequestError).unreachable).toBe(false);
    expect((midRender as Error).message).toContain("UND_ERR_HEADERS_TIMEOUT");

    failWith("ECONNREFUSED");
    const refused = await requestImageGeneration(CLUSTER, { prompt: "a sunset", tier: "fast" }).catch((error: unknown) => error);
    expect((refused as ImageUpstreamRequestError).unreachable).toBe(true);
  });
});

describe("the image server's own limit", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** llama-swap in front of the cluster: its peer transport gives up after 600 s (session fa673f2c). */
  const LIMITED: ImageGenerationBackendConfig = { ...CLUSTER, maxRenderMs: 600_000 };
  /** The agent's own re-render in fa673f2c: about 17 minutes, cut at 600 s twice. */
  const FA673F2C_RERENDER = { tier: "quality" as const, steps: 60, width: 1024, height: 1024, guidanceScale: 2.5 };
  const LLAMA_SWAP_CUT = JSON.stringify({ src: "llama-swap", error: { message: "peer proxy error: net/http: timeout awaiting response headers" } });

  /** Every request is answered with `status` and `body` after `afterMs`. */
  function answersAfter(afterMs: number, status: number, body: string) {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response(body, { status, headers: { "Content-Type": "application/json" } })), afterMs);
      init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("This operation was aborted")); });
    }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("refuses the fa673f2c re-render before sending it, and says guidance 1 would fit", async () => {
    const message = imageRenderLimitError(LIMITED, FA673F2C_RERENDER);
    expect(message).toContain("Qwen-Image 2.1 (the quality tier) would need about 17 min for 60 steps at 1024x1024 with guidance 2.5");
    expect(message).toContain("the image server gives up on any render after 10 min, so it would fail. Nothing was rendered.");
    expect(message).toContain("At guidance 1, the engine's default, the same steps and size take about 9 min");
    expect(message).toContain("guidance above 1 doubles the time on this engine");

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const refused = await requestImageGeneration(LIMITED, { prompt: "x", ...FA673F2C_RERENDER }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ImageRenderTooLongError);
    expect((refused as Error).message).toBe(message);
    expect(fetchMock, "a render the server would cut off went out anyway").not.toHaveBeenCalled();
  });

  it("lets through what the server can finish: the user's own 50 steps at 1344x768 (414 s measured) and 807684e9's 57", () => {
    expect(imageRenderLimitError(LIMITED, { tier: "quality", steps: 50, width: 1344, height: 768, guidanceScale: 1 })).toBeUndefined();
    expect(imageRenderLimitError(LIMITED, { ...SESSION_807684E9, guidanceScale: 1 })).toBeUndefined();
    expect(imageRenderLimitError(LIMITED, { tier: "fast", steps: 40, width: 1024, height: 1024, guidanceScale: 2.5 })).toBeUndefined();
    // No limit configured, no refusal: a backend without a proxy in front has nothing to cut it.
    expect(imageRenderLimitError(CLUSTER, FA673F2C_RERENDER)).toBeUndefined();
  });

  it("draws the line at 90% of the limit and names the steps that fit", () => {
    const at = (steps: number) => imageRenderLimitError(LIMITED, { tier: "quality", steps, width: 1344, height: 768, guidanceScale: 1 });
    expect(at(64), "64 steps at 1344x768 is 536 s, inside 540").toBeUndefined();
    expect(at(65), "65 steps is 544 s").toBeDefined();
    expect(at(80)).toContain("At 1344x768, at most 64 steps fit.");
    // Too long even at the default guidance: the steps that fit are counted without the doubling.
    expect(imageRenderLimitError(LIMITED, { tier: "quality", steps: 100, width: 1024, height: 1024, guidanceScale: 3 }))
      .toContain("At 1024x1024 with guidance 1 (guidance above 1 doubles the time on this engine), at most 63 steps fit.");
  });

  it("never waits much past the moment the server gives up", () => {
    const shape = { ...SESSION_807684E9, guidanceScale: 1 };
    expect(imageRequestTimeoutMs(CLUSTER, shape)).toBeGreaterThan(800_000);
    expect(imageRequestTimeoutMs(LIMITED, shape)).toBe(630_000);
    expect(imageRequestTimeoutMs(LIMITED, { tier: "quality", steps: 20, width: 1024, height: 1024, guidanceScale: 1 })).toBe(300_000);
  });

  it("reads llama-swap's 502 at the limit as the server's cut: a timeout that says so, with what fits, and the device busy", async () => {
    vi.useFakeTimers();
    // No limit configured, so the request goes out, as it did in fa673f2c.
    const config = { ...CLUSTER, qualityModel: "q-server-cut" };
    answersAfter(600_000, 502, LLAMA_SWAP_CUT);
    const run = watch(requestImageGeneration(config, { prompt: "x", ...FA673F2C_RERENDER }));
    await vi.advanceTimersByTimeAsync(600_001);

    const error = run.error as ImageGenerationTimeoutError;
    expect(error, "the cut surfaced as a bare HTTP 502 the agent retried").toBeInstanceOf(ImageGenerationTimeoutError);
    expect(error.details.cutByServerAfterMs).toBe(600_000);
    expect(error.message).toContain("Qwen-Image 2.1 (the quality tier) was still rendering when the image server gave up waiting after 10 min");
    expect(error.message).toContain("60 steps at 1024x1024 were expected to take about 17 min");
    expect(error.message).toContain("do NOT call generate_image again with the same settings");
    expect(error.message).toContain("At guidance 1, the engine's default, the same steps and size take about 9 min");
    // Where the cut came from survives: the proxy, the missing headers, the status.
    expect(error.message).toContain("The server said: Image generation failed (q-server-cut) (HTTP 502): peer proxy error: net/http: timeout awaiting response headers");
    // The engine renders on: 1020 s expected, 600 s gone, 1 ms of it since the cut.
    expect(imageDeviceBusyMs(config, "quality")).toBe(419_999);
  });

  it("does not blame the settings for a cut they should have fitted inside", async () => {
    vi.useFakeTimers();
    const config = { ...CLUSTER, qualityModel: "q-server-cut-fits" };
    answersAfter(600_000, 504, "upstream request timeout");
    const run = watch(requestImageGeneration(config, { prompt: "x", tier: "quality", steps: 50, width: 1344, height: 768 }));
    await vi.advanceTimersByTimeAsync(600_001);

    const error = run.error as ImageGenerationTimeoutError;
    expect(error).toBeInstanceOf(ImageGenerationTimeoutError);
    expect(error.message).toContain("These settings fit within that limit, so the engine was most likely still busy with another render first.");
    expect(error.message).not.toContain("steps fit");
    // Past its estimate already, so the device is given the minimum rather than nothing.
    expect(imageDeviceBusyMs(config, "quality")).toBe(59_999);
  });

  it("leaves a timeout reply that came at once an ordinary failure: no render was running to cut", async () => {
    vi.useFakeTimers();
    const config = { ...CLUSTER, qualityModel: "q-server-instant" };
    answersAfter(1_000, 502, LLAMA_SWAP_CUT);
    const run = watch(requestImageGeneration(config, { prompt: "x", ...FA673F2C_RERENDER }));
    await vi.advanceTimersByTimeAsync(1_001);

    expect(run.settled).toBe("rejected");
    expect(run.error).not.toBeInstanceOf(ImageGenerationTimeoutError);
    expect((run.error as Error).message).toContain("timeout awaiting response headers");
    expect(imageDeviceBusyMs(config, "quality"), "a device marked busy for a render that never ran").toBe(0);
  });

  it("leaves a 502 that is not a timeout an ordinary failure — the control", async () => {
    vi.useFakeTimers();
    const config = { ...CLUSTER, qualityModel: "q-server-502" };
    answersAfter(45_000, 502, JSON.stringify({ error: { message: "peer proxy error: dial tcp 10.0.0.2:8080: connection refused" } }));
    const run = watch(requestImageGeneration(config, { prompt: "x", tier: "quality" }));
    await vi.advanceTimersByTimeAsync(45_001);

    expect(run.settled).toBe("rejected");
    expect(run.error).not.toBeInstanceOf(ImageGenerationTimeoutError);
    expect((run.error as Error).message).toContain("connection refused");
    expect(imageDeviceBusyMs(config, "quality")).toBe(0);
  });
});
