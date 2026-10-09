/**
 * A failed generation must carry the upstream's reason, not a generic sentence.
 *
 * Live against the cluster, both image tiers returned HTTP 502 at exactly 60 s with this
 * body:
 *
 *   {"src":"llama-swap","error":{"message":"peer proxy error: net/http: timeout awaiting
 *    response headers","type":"server_error","param":null,"code":"bad_gateway"}}
 *
 * and the tool reported `Image generation failed (image)`. Every word that said WHERE the
 * failure was — a proxy, not the model; no response headers, not a refused prompt; 502, not
 * a timeout on our side — was dropped, because the extractor required the JSON detail to be
 * a string and `error` here is an object.
 *
 * That is the same failure mode as a test harness that swallows exceptions: the work still
 * fails, but the evidence that would locate it never survives the boundary. A client that
 * cannot repeat what the server told it turns a backend regression into a mystery on our
 * side of the wire.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  checkImageGenerationHealth,
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

const SQUARE = { prompt: "a lighthouse", width: 1024, height: 1024, steps: 20, guidanceScale: 7 };

/** The exact body the cluster's llama-swap returned on the 502. */
const LLAMA_SWAP_502 = {
  src: "llama-swap",
  error: {
    message: "peer proxy error: net/http: timeout awaiting response headers",
    type: "server_error",
    param: null,
    code: "bad_gateway",
  },
};

function stubFetch(body: string, init: ResponseInit): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response(body, init));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function failureMessage(): Promise<string> {
  try {
    await requestImageGeneration(CLUSTER, SQUARE);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the generation to fail");
}

describe("upstream image-generation failures", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("repeats a NESTED upstream message — the llama-swap 502 seen live", async () => {
    stubFetch(JSON.stringify(LLAMA_SWAP_502), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });

    const message = await failureMessage();

    // The three facts that located the failure. Losing any one of them sends the reader
    // looking in the wrong place.
    expect(message).toContain("peer proxy error");
    expect(message).toContain("timeout awaiting response headers");
    expect(message).toContain("502");
    // Still says which model, so a tier-specific failure stays attributable.
    expect(message).toContain("image");
  });

  it("does NOT stop at the generic fallback — the control for the case above", async () => {
    // Without this, an extractor that returned `Image generation failed (image)` and nothing
    // else would satisfy the `toContain("image")` assertion above and look correct.
    stubFetch(JSON.stringify(LLAMA_SWAP_502), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });

    const message = await failureMessage();

    expect(message).not.toBe("Image generation failed (image)");
    expect(message.length).toBeGreaterThan("Image generation failed (image)".length + 40);
  });

  it("EXTRACTS from a JSON body served with the wrong content-type, rather than dumping it", async () => {
    // Proxies and error pages routinely mislabel their bodies. Gating the parse on the
    // content-type header meant the richer branch never ran for exactly the hops most
    // likely to be the problem.
    //
    // Asserting only that "peer proxy error" survives would not discriminate: the old code
    // reached its text branch here and pasted the whole body in, substring included. What
    // is new is that the message is the DETAIL, not the envelope — so the JSON scaffolding
    // is gone, and a 240-char truncation can no longer eat the message to preserve `src`.
    stubFetch(JSON.stringify(LLAMA_SWAP_502), {
      status: 502,
      headers: { "Content-Type": "text/plain" },
    });

    const message = await failureMessage();

    expect(message).toContain("peer proxy error");
    expect(message).not.toContain("llama-swap");
    expect(message).not.toContain("{");
  });

  it("falls back to the raw text when the body is not JSON at all", async () => {
    // A no-regression control rather than a test of the fix: this path behaved correctly
    // before and must keep doing so. It passes against the old extractor too, by design.
    stubFetch("<html><body><h1>504 Gateway Time-out</h1></body></html>", {
      status: 504,
      headers: { "Content-Type": "text/html" },
    });

    const message = await failureMessage();

    expect(message).toContain("504 Gateway Time-out");
    expect(message).toContain("504");
  });

  it("says the body was empty rather than implying it was never read", async () => {
    stubFetch("", { status: 503 });

    const message = await failureMessage();

    expect(message).toContain("503");
    expect(message).toContain("empty body");
  });

  it("carries the upstream reason through the HEALTH probe too", async () => {
    // The probe is what a operator reads first when generation stops working, so it has the
    // same obligation. It used to name only the status it already knew.
    stubFetch(JSON.stringify(LLAMA_SWAP_502), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });

    const health = await checkImageGenerationHealth(CLUSTER);

    expect(health.ok).toBe(false);
    expect(health.status).toBe(502);
    expect(health.error).toContain("peer proxy error");
    // The status appears once, not twice: the fallback used to interpolate it as well.
    expect(health.error?.match(/502/g) ?? []).toHaveLength(1);
  });

  it("still reports a plain OpenAI-shaped error, where the detail is one level down", async () => {
    stubFetch(
      JSON.stringify({ error: { message: "model image-quality is not loaded", code: "model_not_found" } }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );

    expect(await failureMessage()).toContain("model image-quality is not loaded");
  });
});
