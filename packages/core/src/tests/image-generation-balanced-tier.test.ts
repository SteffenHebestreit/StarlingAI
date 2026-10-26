/**
 * The balanced tier: an engine between the fast and the quality one, which EDITS BY REFERENCE.
 *
 * Measured 2026-10-26 on the cluster (FLUX 3 Image Klein on the quality engine's graphics chip):
 * 64.6 s at 1024x1024 against 10 s fast and 322-335 s quality, and an edit that reads the base
 * picture beside the instruction — "add a sloth, keep everything else" kept the scene — rather than
 * re-noising it from a strength. So an edit there sends no strength and takes no mask, a masked
 * edit has to go to an engine that edits the picture itself, and the two engines on one chip must
 * not render at once: two together each take about twice as long, enough to push a 40-step quality
 * render past the image server's own limit.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  expectedImageRenderSeconds,
  imageEditTier,
  imageTierChoices,
  requestImageGeneration,
  type ImageGenerationBackendConfig,
} from "../multimodal/image-generation.js";

const CLUSTER: ImageGenerationBackendConfig = {
  api: "openai-compatible",
  baseUrl: "http://cluster:8080/v1",
  model: "image",
  balancedModel: "image-balanced",
  qualityModel: "image-quality",
  tierLabels: { fast: "Segmind Vega", balanced: "FLUX 3 Image Klein", quality: "Qwen-Image 2.1" },
  timeoutMs: 120_000,
  qualityTimeoutMs: 300_000,
  balancedTimeoutMs: 180_000,
  fixedSizeModels: ["image"],
  initImageModels: ["image-quality", "image-balanced"],
  referenceEditModels: ["image-balanced"],
  deviceGroups: { igpu: ["image-quality", "image-balanced"] },
  defaultWidth: 1024,
  defaultHeight: 1024,
  defaultSteps: 20,
  defaultGuidanceScale: 7.5,
  qualityDefaults: { steps: 40, guidanceScale: 1 },
  balancedDefaults: { steps: 16, guidanceScale: 1 },
};

const BASE = Buffer.from("pretend-png-bytes").toString("base64");
const MASK = Buffer.from("pretend-mask-bytes").toString("base64");

interface Seen { url: string; json?: Record<string, unknown>; form?: FormData }

/** Answers like the cluster's endpoint: a reference edit reports mode "reference", an img2img edit its strength. */
function stub(usageFor: (seen: Seen) => Record<string, unknown> | undefined = defaultUsage) {
  const calls: Seen[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const seen: Seen = init?.body instanceof FormData
      ? { url: String(input), form: init.body }
      : { url: String(input), json: JSON.parse(String(init?.body)) as Record<string, unknown> };
    calls.push(seen);
    const usage = usageFor(seen);
    return new Response(JSON.stringify({ data: [{ b64_json: "QUJD" }], ...(usage ? { usage } : {}) }), {
      headers: { "Content-Type": "application/json" },
    });
  }));
  return calls;
}

function defaultUsage(seen: Seen): Record<string, unknown> | undefined {
  if (!seen.url.endsWith("/images/edits")) return undefined;
  const model = seen.json?.["model"] ?? seen.form?.get("model");
  if (model === "image-balanced") return { mode: "reference" };
  const strength = Number(seen.json?.["strength"] ?? seen.form?.get("strength"));
  return {
    mode: "img2img",
    strength: Math.fround(strength),
    ...(seen.form?.get("mask")
      ? { mask: { semantics: "alpha", coverage: 0.5, respected: true, feather_px: 24, edited_delta: 20, protected_delta: 0.5 } }
      : {}),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the balanced tier", () => {
  it("is listed between the fast and the quality engine, in order of cost", () => {
    expect(imageTierChoices(CLUSTER).map((choice) => choice.tier)).toEqual(["fast", "balanced", "quality"]);
  });

  it("renders on its own engine with its own defaults", async () => {
    const calls = stub();

    const result = await requestImageGeneration(CLUSTER, { prompt: "a jungle river", tier: "balanced" });

    expect(calls[0]!.json).toMatchObject({ model: "image-balanced", steps: 16, guidance_scale: 1, size: "1024x1024" });
    expect(result.tier).toBe("balanced");
  });

  it("is refused where the deployment has none, before anything is sent", async () => {
    const calls = stub();
    const { balancedModel: _none, ...twoTiers } = CLUSTER;

    await expect(requestImageGeneration(twoTiers, { prompt: "a jungle river", tier: "balanced" }))
      .rejects.toThrow("The balanced tier was requested but multimodal.imageGeneration.balancedModel is not set");
    expect(calls).toHaveLength(0);
  });

  it("expects a reference edit to take 2.45 times a new picture, as measured", () => {
    const shape = { tier: "balanced" as const, width: 1024, height: 1024, steps: 16, guidanceScale: 1 };
    expect(expectedImageRenderSeconds(CLUSTER, shape)).toBe(65);
    expect(expectedImageRenderSeconds(CLUSTER, { ...shape, referenceEdit: true })).toBeCloseTo(159.25, 2);
  });
});

describe("an edit goes to the cheapest engine that can take it", () => {
  it("sends an edit with no tier to the balanced engine BY REFERENCE: the picture, no strength", async () => {
    const calls = stub();

    const result = await requestImageGeneration(CLUSTER, {
      prompt: "Add a sloth on the right tree. Keep everything else.", initImage: BASE, strength: 0.6, width: 1024, height: 1024,
    });

    const sent = calls[0]!;
    expect(sent.url).toMatch(/\/images\/edits$/);
    expect(sent.json).toMatchObject({ model: "image-balanced", image: BASE });
    // The endpoint refuses `strength` by name for a reference engine; it must never be sent.
    expect(sent.json).not.toHaveProperty("strength");
    expect(result).toMatchObject({ tier: "balanced", tierUpgradedForEdit: true, referenceEdit: true });
  });

  it("sends a MASKED edit to the engine that edits the picture itself, with its strength", async () => {
    const calls = stub();

    const result = await requestImageGeneration(CLUSTER, {
      prompt: "boulders on the sand", initImage: BASE, mask: MASK, strength: 0.7, width: 1024, height: 1024,
    });

    const sent = calls[0]!;
    expect(sent.form, "a masked edit goes multipart").toBeInstanceOf(FormData);
    expect(sent.form!.get("model")).toBe("image-quality");
    expect(sent.form!.get("strength")).toBe("0.7");
    expect(result).toMatchObject({ tier: "quality", tierUpgradedForEdit: true });
    expect(result.referenceEdit).toBeUndefined();
  });

  it("moves a masked edit OFF the balanced engine even when that engine was named", async () => {
    const calls = stub();

    await requestImageGeneration(CLUSTER, {
      prompt: "boulders on the sand", model: "image-balanced", initImage: BASE, mask: MASK, strength: 0.7, width: 1024, height: 1024,
    });

    expect(calls[0]!.form!.get("model")).toBe("image-quality");
  });

  it("refuses a mask outright where no engine that takes one can edit, before anything is sent", async () => {
    const calls = stub();
    const referenceOnly: ImageGenerationBackendConfig = { ...CLUSTER, initImageModels: ["image-balanced"] };
    expect(imageEditTier(referenceOnly, { masked: true })).toBeUndefined();

    await expect(requestImageGeneration(referenceOnly, {
      prompt: "boulders on the sand", tier: "balanced", initImage: BASE, mask: MASK, width: 1024, height: 1024,
    })).rejects.toThrow("FLUX 3 Image Klein edits by reference and cannot take a mask");
    expect(calls).toHaveLength(0);
  });

  it("does not call a reference edit applied when the endpoint answered as img2img", async () => {
    // A model listed in referenceEditModels whose endpoint was left on img2img reports "img2img":
    // the picture it returns was not made by reading the base as a reference.
    stub((seen) => (seen.url.endsWith("/images/edits") ? { mode: "img2img", strength: 0.55 } : undefined));

    await expect(requestImageGeneration(CLUSTER, {
      prompt: "Add a sloth.", tier: "balanced", initImage: BASE, width: 1024, height: 1024,
    })).rejects.toThrow('The backend did not read the base image as a reference (mode "img2img")');
  });
});

describe("two engines on one graphics chip render one at a time", () => {
  /** Holds every request until released, and counts how many were in flight at once. */
  function holdingFetch() {
    const state = { inFlight: 0, maxInFlight: 0, releases: [] as Array<() => void> };
    vi.stubGlobal("fetch", vi.fn(async () => {
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      await new Promise<void>((release) => state.releases.push(release));
      state.inFlight -= 1;
      return new Response(JSON.stringify({ data: [{ b64_json: "QUJD" }] }), { headers: { "Content-Type": "application/json" } });
    }));
    return state;
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

  it("queues a quality render behind a balanced one on the same device", async () => {
    const backend = holdingFetch();

    const balanced = requestImageGeneration(CLUSTER, { prompt: "a jungle", tier: "balanced" });
    const quality = requestImageGeneration(CLUSTER, { prompt: "a jungle", tier: "quality" });
    try {
      await tick();
      expect(backend.releases, "the second render waits at the device's slot, not inside the backend").toHaveLength(1);

      backend.releases.shift()!();
      await balanced;
      await tick();
      backend.releases.shift()!();
      await quality;
      expect(backend.maxInFlight).toBe(1);
    } finally {
      // A failed assertion must not leave a render holding the device's slot for the next test.
      for (const release of backend.releases.splice(0)) release();
      await Promise.allSettled([balanced, quality]);
    }
  });

  it("lets them overlap without the device group — the control", async () => {
    const backend = holdingFetch();
    const { deviceGroups: _none, ...ungrouped } = CLUSTER;

    const balanced = requestImageGeneration(ungrouped, { prompt: "a jungle", tier: "balanced" });
    const quality = requestImageGeneration(ungrouped, { prompt: "a jungle", tier: "quality" });
    await tick();
    expect(backend.releases).toHaveLength(2);

    for (const release of backend.releases.splice(0)) release();
    await Promise.all([balanced, quality]);
    expect(backend.maxInFlight).toBe(2);
  });
});
