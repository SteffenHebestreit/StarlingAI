import { afterEach, describe, expect, it, vi } from "vitest";
import { crc32, deflateSync } from "node:zlib";
import Jimp from "jimp";
import {
  decodesWithinDeclaredSize,
  measureImage,
  previewImageRequest,
  readImageHeaderSize,
  requestImageGeneration,
  type ImageGenerationBackendConfig,
  type ImageGenerationRequest,
} from "../multimodal/image-generation.js";
import {
  MAX_MASK_BYTES,
  applyImageSettings,
  buildImageSettingsProposal,
  collectBaseCandidates,
  describeAgentMask,
  describeImageSettingsForAgent,
  describeReusedMaskForAgent,
  describeSettingsChange,
  validateImageSettingsAnswer,
  type AgentMask,
  type BaseCandidate,
  type ChosenImageSettings,
  type ImageSettingsDecision,
} from "../multimodal/image-settings.js";

/**
 * THE SETTINGS STEP: what the person is offered before a render, and what their answer may be.
 *
 * The client is a browser tab, so every field of an answer is untrusted: a tier the deployment does
 * not have, a size the engine rejects after the render slot was waited for, an edit on an engine
 * that cannot edit, a mask that selects nothing or is the wrong size. Each must be refused against
 * the field it belongs to, and never repaired behind the person's back.
 */

const CONFIG: ImageGenerationBackendConfig = {
  api: "openai-compatible",
  baseUrl: "http://cluster:8080/v1",
  timeoutMs: 120_000,
  model: "image",
  qualityModel: "image-quality",
  tierLabels: { fast: "Segmind Vega", quality: "Qwen-Image 2.1" },
  fixedSizeModels: ["image"],
  initImageModels: ["image-quality"],
  defaultWidth: 1024,
  defaultHeight: 1024,
  defaultSteps: 20,
  defaultGuidanceScale: 7.5,
  qualityDefaults: { steps: 20, guidanceScale: 1 },
};

async function png(width: number, height: number, alpha = 255, rgba = true): Promise<Buffer> {
  const image = new Jimp(width, height, (0x336699 * 256 + alpha) >>> 0);
  return image.rgba(rgba).getBufferAsync(Jimp.MIME_PNG);
}

/** Opaque black, with a transparent rectangle where the picture may change. */
async function maskPng(width: number, height: number, hole?: { x: number; y: number; w: number; h: number }): Promise<Buffer> {
  const image = new Jimp(width, height, 0x000000ff);
  if (hole) {
    image.scan(hole.x, hole.y, hole.w, hole.h, (_x, _y, index) => {
      image.bitmap.data[index + 3] = 0;
    });
  }
  return image.getBufferAsync(Jimp.MIME_PNG);
}

const dataUrl = (bytes: Buffer, mime = "image/png") => `data:${mime};base64,${bytes.toString("base64")}`;

interface Fixture {
  base: Buffer;
  candidates: BaseCandidate[];
  agentRequest: ImageGenerationRequest;
}

/** The agent edits harbour.png (320x256); the latest render (512x512) is offered beside it. */
async function editFixture(): Promise<Fixture> {
  const base = await png(320, 256);
  const latest = await png(512, 512);
  const candidates = await collectBaseCandidates([
    { relativePath: "uploads/harbour.png", source: "agent", read: async () => base },
    { relativePath: "generated/latest.png", source: "latest_image", read: async () => latest },
  ], 6);
  return { base, candidates, agentRequest: { prompt: "a harbour", initImage: base.toString("base64") } };
}

async function editContext(fixture: Fixture, agentMask?: AgentMask, checkText?: (text: string) => { allowed: boolean; reason?: string }) {
  const proposal = buildImageSettingsProposal(CONFIG, fixture.agentRequest, fixture.candidates, agentMask);
  return { config: CONFIG, proposal, candidates: fixture.candidates, ...(agentMask ? { agentMask } : {}), ...(checkText ? { checkText } : {}) };
}

/** A complete, valid Configure answer for the edit fixture: quality tier, base c1, a painted mask. */
async function validEditAnswer(): Promise<Record<string, unknown>> {
  return {
    choice: "configure",
    settings: {
      tier: "quality",
      prompt: "a harbour at dusk",
      negativePrompt: "",
      width: 320,
      height: 256,
      steps: 24,
      guidanceScale: 1,
      seed: 42,
      edit: {
        baseCandidateId: "c1",
        strength: 0.7,
        maskDataUrl: dataUrl(await maskPng(320, 256, { x: 0, y: 0, w: 160, h: 128 })),
        maskBlur: 24,
      },
    },
  };
}

/** A valid Configure answer for a new picture on the fast engine. */
const validGenerateAnswer = (): Record<string, unknown> => ({
  choice: "configure",
  settings: {
    tier: "fast", prompt: "a lighthouse", negativePrompt: "blurry", width: 1024, height: 1024,
    steps: 20, guidanceScale: 7.5, seed: null, edit: null,
  },
});

function withSettings(answer: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  return { ...answer, settings: { ...(answer["settings"] as Record<string, unknown>), ...patch } };
}

function withEdit(answer: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const settings = answer["settings"] as Record<string, unknown>;
  return withSettings(answer, { edit: { ...(settings["edit"] as Record<string, unknown>), ...patch } });
}

describe("the settings proposal", () => {
  it("lists each engine with what it can do and the defaults it would render with", async () => {
    const fixture = await editFixture();
    const proposal = buildImageSettingsProposal(CONFIG, { prompt: "a lighthouse" }, fixture.candidates);

    expect(proposal.engines).toEqual([
      {
        tier: "fast", model: "image", label: "Segmind Vega", fixedSize: true, canEdit: false,
        defaults: { width: 1024, height: 1024, steps: 20, guidanceScale: 7.5 }, expectedSeconds: 10,
      },
      {
        tier: "quality", model: "image-quality", label: "Qwen-Image 2.1", fixedSize: false, canEdit: true,
        defaults: { width: 1024, height: 1024, steps: 20, guidanceScale: 1 }, expectedSeconds: 170,
      },
    ]);
    expect(proposal.bounds).toEqual({
      size: { min: 256, max: 2048, step: 32, fixed: 1024 },
      steps: [1, 100], guidance: [0, 20], seed: [0, 4294967295], strength: [0.05, 1], maskBlur: [0, 256],
      promptMax: 4000, negativeMax: 2000,
    });
    expect(proposal.mode).toBe("generate");
    expect(proposal.agent).toEqual({
      prompt: "a lighthouse", tier: "fast", width: 1024, height: 1024, steps: 20, guidanceScale: 7.5, hasMask: false,
    });
  });

  it("sends each engine's time AT ITS DEFAULTS, derived from the measured reference, so 40 default steps read ~340 s", async () => {
    // The form scales `expectedSeconds` from `defaults`. When the figure was the raw 20-step
    // measurement, raising the quality default to the model's official 40 steps would have shown
    // "~3 min" for a ~6 min render — and the render's own budget would have halved with it.
    const forty: ImageGenerationBackendConfig = { ...CONFIG, qualityDefaults: { steps: 40, guidanceScale: 1 } };
    const proposal = buildImageSettingsProposal(forty, { prompt: "a lighthouse", tier: "quality" }, []);
    expect(proposal.engines.find((engine) => engine.tier === "quality")).toMatchObject({
      defaults: { steps: 40, guidanceScale: 1 }, expectedSeconds: 340,
    });
    expect(proposal.engines.find((engine) => engine.tier === "fast")).toMatchObject({ expectedSeconds: 10 });
  });

  it("shows an edit exactly as it would run: the editing engine, the base's own size, the default strength", async () => {
    const fixture = await editFixture();
    const proposal = buildImageSettingsProposal(CONFIG, fixture.agentRequest, fixture.candidates);

    expect(proposal.mode).toBe("edit");
    expect(proposal.agent).toMatchObject({
      tier: "quality", width: 320, height: 256, steps: 20, guidanceScale: 1, strength: 0.45, baseCandidateId: "c1", hasMask: false,
    });
    // One resolution for the form and the render: Auto runs what the form showed.
    expect(previewImageRequest(CONFIG, fixture.agentRequest, { width: 320, height: 256 })).toMatchObject({
      tier: "quality", width: 320, height: 256, tierUpgradedForEdit: true,
    });
  });

  it("offers candidates as thumbnails behind opaque ids, and never a path", async () => {
    const fixture = await editFixture();
    const proposal = buildImageSettingsProposal(CONFIG, fixture.agentRequest, fixture.candidates);

    expect(proposal.baseCandidates.map(({ id, label, source, width, height }) => ({ id, label, source, width, height }))).toEqual([
      { id: "c1", label: "harbour.png", source: "agent", width: 320, height: 256 },
      { id: "c2", label: "latest.png", source: "latest_image", width: 512, height: 512 },
    ]);
    for (const candidate of proposal.baseCandidates) {
      expect(candidate.thumbDataUrl).toMatch(/^data:image\/jpeg;base64,/);
      const thumb = await Jimp.read(Buffer.from(candidate.thumbDataUrl.split(",")[1]!, "base64"));
      expect(Math.max(thumb.bitmap.width, thumb.bitmap.height)).toBe(160);
    }
    const wire = JSON.stringify(proposal);
    expect(wire).not.toContain("uploads/");
    expect(wire).not.toContain("generated/");
  });

  it("keeps the first of each path, skips what cannot be read, decoded or edited at its size, and stops at the cap", async () => {
    const ok = await png(256, 256);
    const tooWide = await png(2112, 256);
    const candidates = await collectBaseCandidates([
      { relativePath: "generated/a.png", source: "latest_image", read: async () => ok },
      { relativePath: "generated\\a.png", source: "attachment", read: async () => ok },
      { relativePath: "generated/gone.png", source: "shared_fact", read: async () => { throw new Error("ENOENT"); } },
      { relativePath: "generated/notes.png", source: "shared_fact", read: async () => Buffer.from("not an image") },
      { relativePath: "uploads/panorama.png", source: "attachment", read: async () => tooWide },
      { relativePath: "generated/b.png", source: "shared_fact", read: async () => ok },
      { relativePath: "generated/c.png", source: "shared_fact", read: async () => ok },
    ], 2);

    expect(candidates.map((candidate) => [candidate.id, candidate.relativePath, candidate.source])).toEqual([
      ["c1", "generated/a.png", "latest_image"],
      ["c2", "generated/b.png", "shared_fact"],
    ]);
  });

  it("hands the painter the agent's mask as alpha only", async () => {
    const colourful = new Jimp(64, 64, 0xff0000ff);
    colourful.scan(0, 0, 32, 64, (_x, _y, index) => { colourful.bitmap.data[index + 3] = 0; });
    const mask = await describeAgentMask(await colourful.getBufferAsync(Jimp.MIME_PNG), "generated/sky-mask.png");

    expect(mask).toMatchObject({ width: 64, height: 64, relativePath: "generated/sky-mask.png" });
    const preview = await Jimp.read(Buffer.from(mask!.previewDataUrl.split(",")[1]!, "base64"));
    expect(preview.bitmap.data[0]).toBe(0); // red gone
    expect(preview.bitmap.data[3]).toBe(0); // left half still transparent
    expect(preview.bitmap.data[(40 * 4) + 3]).toBe(255);
  });
});

describe("validating an answer", () => {
  it("accepts Auto and Skip, carrying 'always Auto'", async () => {
    const context = await editContext(await editFixture());

    expect(await validateImageSettingsAnswer({ choice: "auto", alwaysAuto: true }, context))
      .toMatchObject({ ok: true, outcome: "auto", value: { choice: "auto", alwaysAuto: true } });
    expect(await validateImageSettingsAnswer({ choice: "skip" }, context))
      .toMatchObject({ ok: true, outcome: "cancelled", value: { choice: "skip", alwaysAuto: false } });
  });

  it("accepts a complete edit and measures the painted region", async () => {
    const fixture = await editFixture();
    const verdict = await validateImageSettingsAnswer(await validEditAnswer(), await editContext(fixture));

    expect(verdict.ok).toBe(true);
    const settings = (verdict as { value: ImageSettingsDecision }).value.settings!;
    expect(settings).toMatchObject({ tier: "quality", prompt: "a harbour at dusk", width: 320, height: 256, steps: 24, seed: 42 });
    expect(settings.edit!.base.id).toBe("c1");
    expect(settings.edit!.mask!.coverage).toBeCloseTo(0.25, 5);
    expect((verdict as { summary?: string }).summary).toContain("painted a mask (~25% of the picture)");
  });

  it("accepts a new picture on the fixed-size engine at its one size", async () => {
    const verdict = await validateImageSettingsAnswer(validGenerateAnswer(), await editContext(await editFixture()));
    expect(verdict.ok, JSON.stringify(verdict)).toBe(true);
  });

  it("accepts the quality engine's own 16:9 shape, 1376x768, which the old 64-pixel grid refused", async () => {
    // round(√(1024² × 16/9) / 32) × 32 — how Qwen-Image 2.1's pipeline sizes a 1 MP picture; rendered live at it.
    const answer = withSettings(validGenerateAnswer(), { tier: "quality", width: 1376, height: 768, guidanceScale: 1 });
    const verdict = await validateImageSettingsAnswer(answer, await editContext(await editFixture()));
    expect(verdict.ok, JSON.stringify(verdict)).toBe(true);
  });

  const rejectsGenerate: Array<[string, (answer: Record<string, unknown>) => Record<string, unknown>, string, RegExp]> = [
    ["a tier the deployment does not have", (a) => withSettings(a, { tier: "ultra" }), "settings.tier", /must be one of: fast, quality/],
    ["an empty prompt", (a) => withSettings(a, { prompt: "   " }), "settings.prompt", /must not be empty/],
    ["a prompt over 4000 characters", (a) => withSettings(a, { prompt: "x".repeat(4001) }), "settings.prompt", /at most 4000 characters/],
    ["a negative prompt over 2000 characters", (a) => withSettings(a, { negativePrompt: "x".repeat(2001) }), "settings.negativePrompt", /at most 2000 characters/],
    ["a negative prompt that is not text", (a) => withSettings(a, { negativePrompt: 5 }), "settings.negativePrompt", /must be text/],
    ["steps of 0", (a) => withSettings(a, { steps: 0 }), "settings.steps", /whole number from 1 to 100/],
    ["fractional steps", (a) => withSettings(a, { steps: 2.5 }), "settings.steps", /whole number from 1 to 100/],
    ["guidance above 20", (a) => withSettings(a, { guidanceScale: 21 }), "settings.guidanceScale", /number from 0 to 20/],
    ["guidance as text", (a) => withSettings(a, { guidanceScale: "7" }), "settings.guidanceScale", /number from 0 to 20/],
    ["a negative seed", (a) => withSettings(a, { seed: -1 }), "settings.seed", /whole number from 0 to 4294967295/],
    ["a seed past 2^32-1", (a) => withSettings(a, { seed: 4_294_967_296 }), "settings.seed", /whole number from 0 to 4294967295/],
    ["a size the fixed-size engine rejects", (a) => withSettings(a, { width: 512, height: 512 }), "settings.width", /Segmind Vega renders 1024x1024 only/],
    ["a fractional width", (a) => withSettings(a, { width: 1024.5 }), "settings.width", /whole numbers/],
    ["a size off the 32-pixel grid", (a) => withSettings(a, { tier: "quality", width: 1000, height: 768 }), "settings.width", /in steps of 32/],
    ["a size past the bounds", (a) => withSettings(a, { tier: "quality", width: 1024, height: 4096 }), "settings.height", /from 256 to 2048/],
    ["an edit block that is not an object", (a) => withSettings(a, { edit: "c1" }), "settings.edit", /must be an object/],
  ];

  it.each(rejectsGenerate)("rejects %s", async (_name, mutate, field, message) => {
    const verdict = await validateImageSettingsAnswer(mutate(validGenerateAnswer()), await editContext(await editFixture()));
    expect(verdict.ok).toBe(false);
    expect((verdict as { errors: Array<{ field: string; message: string }> }).errors.filter((error) => error.field === field && message.test(error.message))).toHaveLength(1);
  });

  const rejectsEdit: Array<[string, (answer: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>, string, RegExp]> = [
    ["an edit on the engine that cannot edit", (a) => withSettings(a, { tier: "fast" }), "settings.tier", /Segmind Vega cannot edit a picture; choose Qwen-Image 2.1/],
    ["a base the form never offered", (a) => withEdit(a, { baseCandidateId: "../../.env" }), "settings.edit.baseCandidateId", /not one of the offered pictures/],
    ["a strength below 0.05", (a) => withEdit(a, { strength: 0.01 }), "settings.edit.strength", /number from 0.05 to 1/],
    ["a feather past 256", (a) => withEdit(a, { maskBlur: 300 }), "settings.edit.maskBlur", /whole number from 0 to 256/],
    ["a size other than the base's", (a) => withSettings(a, { width: 384, height: 256 }), "settings.width", /must be 320x256, the size of the base picture/],
    ["a mask that is not a PNG data URL", (a) => withEdit(a, { maskDataUrl: "data:image/jpeg;base64,/9j/4AAQ" }), "settings.edit.maskDataUrl", /must be a PNG data URL/],
    ["a mask whose bytes are not a PNG", (a) => withEdit(a, { maskDataUrl: dataUrl(Buffer.from("GIF89a-not-png")) }), "settings.edit.maskDataUrl", /not a PNG/],
    ["a mask with no alpha channel", async (a) => withEdit(a, { maskDataUrl: dataUrl(await png(320, 256, 255, false)) }), "settings.edit.maskDataUrl", /has no transparency/],
    ["a mask of another size", async (a) => withEdit(a, { maskDataUrl: dataUrl(await maskPng(512, 512, { x: 0, y: 0, w: 10, h: 10 })) }), "settings.edit.maskDataUrl", /is 512x512; it must be 320x256/],
    ["a mask that selects nothing", async (a) => withEdit(a, { maskDataUrl: dataUrl(await maskPng(320, 256)) }), "settings.edit.maskDataUrl", /selects nothing/],
    ["a mask that selects everything", async (a) => withEdit(a, { maskDataUrl: dataUrl(await maskPng(320, 256, { x: 0, y: 0, w: 320, h: 256 })) }), "settings.edit.maskDataUrl", /selects the whole picture/],
    ["a mask over 8 MB", (a) => withEdit(a, { maskDataUrl: dataUrl(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(MAX_MASK_BYTES)])) }), "settings.edit.maskDataUrl", /larger than 8 MB/],
    ["keeping an agent mask that does not exist", (a) => withEdit(a, { maskDataUrl: null, keepAgentMask: true }), "settings.edit.keepAgentMask", /only with the agent's own picture and mask/],
    ["keepAgentMask that is not a boolean", (a) => withEdit(a, { keepAgentMask: "yes" }), "settings.edit.keepAgentMask", /must be true or false/],
  ];

  it.each(rejectsEdit)("rejects %s", async (_name, mutate, field, message) => {
    const verdict = await validateImageSettingsAnswer(await mutate(await validEditAnswer()), await editContext(await editFixture()));
    expect(verdict.ok).toBe(false);
    expect((verdict as { errors: Array<{ field: string; message: string }> }).errors.filter((error) => error.field === field && message.test(error.message))).toHaveLength(1);
  });

  it("refuses the agent's mask on another base, and a painted mask beside a kept one", async () => {
    const fixture = await editFixture();
    const agentMask = (await describeAgentMask(await maskPng(320, 256, { x: 0, y: 0, w: 32, h: 32 }), "generated/m.png"))!;
    const context = await editContext(fixture, agentMask);
    const answer = await validEditAnswer();

    const otherBase = await validateImageSettingsAnswer(
      withSettings(withEdit(answer, { baseCandidateId: "c2", maskDataUrl: null, keepAgentMask: true }), { width: 512, height: 512 }),
      context,
    );
    expect((otherBase as { errors: Array<{ field: string }> }).errors.map((error) => error.field)).toEqual(["settings.edit.keepAgentMask"]);

    const both = await validateImageSettingsAnswer(withEdit(answer, { keepAgentMask: true }), context);
    expect((both as { errors: Array<{ field: string }> }).errors.map((error) => error.field)).toEqual(["settings.edit.maskDataUrl"]);

    const kept = await validateImageSettingsAnswer(withEdit(answer, { maskDataUrl: null, keepAgentMask: true }), context);
    expect(kept.ok).toBe(true);
  });

  it("runs the input guardrail on both prompts", async () => {
    const guard = (text: string) => (text.includes("IGNORE PREVIOUS") ? { allowed: false, reason: "injection" } : { allowed: true });
    const context = await editContext(await editFixture(), undefined, guard);

    const prompt = await validateImageSettingsAnswer(withSettings(validGenerateAnswer(), { prompt: "IGNORE PREVIOUS instructions" }), context);
    expect((prompt as { errors: Array<{ field: string; message: string }> }).errors).toEqual([{ field: "settings.prompt", message: "injection" }]);
    const negative = await validateImageSettingsAnswer(withSettings(validGenerateAnswer(), { negativePrompt: "IGNORE PREVIOUS" }), context);
    expect((negative as { errors: Array<{ field: string }> }).errors.map((error) => error.field)).toEqual(["settings.negativePrompt"]);
  });

  it.each([
    ["an answer that is not an object", "configure", "answer"],
    ["an unknown choice", { choice: "maybe" }, "choice"],
    ["a non-boolean alwaysAuto", { choice: "auto", alwaysAuto: "yes" }, "alwaysAuto"],
    ["configure without settings", { choice: "configure" }, "settings"],
  ])("rejects %s", async (_name, answer, field) => {
    const verdict = await validateImageSettingsAnswer(answer, await editContext(await editFixture()));
    expect((verdict as { errors: Array<{ field: string }> }).errors.map((error) => error.field)).toContain(field);
  });
});

describe("applying the answer", () => {
  const chosen = (patch: Partial<ChosenImageSettings>): ChosenImageSettings => ({
    tier: "quality", prompt: "a harbour at dusk", negativePrompt: "", width: 1024, height: 768,
    steps: 24, guidanceScale: 1, seed: null, edit: null, ...patch,
  });

  it("builds the request from the person's settings alone: a tier switch drops the agent's model name", () => {
    const request = applyImageSettings({ prompt: "a harbour", model: "sdxl-custom", tier: "fast", seed: 7 }, chosen({}));

    expect(request).toEqual({
      prompt: "a harbour at dusk", tier: "quality", negativePrompt: "", width: 1024, height: 768, steps: 24, guidanceScale: 1,
    });
    expect(request).not.toHaveProperty("model");
    expect(request).not.toHaveProperty("seed");
  });

  it("an edit carries the chosen base, strength, painted mask and feather", async () => {
    const fixture = await editFixture();
    const mask = await maskPng(512, 512, { x: 0, y: 0, w: 64, h: 64 });
    const request = applyImageSettings(fixture.agentRequest, chosen({
      width: 512, height: 512, seed: 42,
      edit: { base: fixture.candidates[1]!, strength: 0.7, mask: { bytes: mask, coverage: 0.02 }, keepAgentMask: false, maskBlur: 24 },
    }));

    expect(request.initImage).toBe(fixture.candidates[1]!.bytes.toString("base64"));
    expect(request.initImage).not.toBe(fixture.agentRequest.initImage);
    expect(request).toMatchObject({ strength: 0.7, mask: mask.toString("base64"), maskBlur: 24, seed: 42 });
  });

  it("keeps the agent's mask only when asked to, and drops it with the base", async () => {
    const fixture = await editFixture();
    const agentRequest = { ...fixture.agentRequest, mask: "QUdFTlQ=", maskBlur: 12 };
    const base = fixture.candidates[0]!;

    expect(applyImageSettings(agentRequest, chosen({ width: 320, height: 256, edit: { base, strength: 0.6, keepAgentMask: true } })))
      .toMatchObject({ mask: "QUdFTlQ=", maskBlur: 12 });
    const unmasked = applyImageSettings(agentRequest, chosen({ width: 320, height: 256, edit: { base, strength: 0.6, keepAgentMask: false } }));
    expect(unmasked).not.toHaveProperty("mask");
    const fresh = applyImageSettings(agentRequest, chosen({}));
    expect(fresh).not.toHaveProperty("initImage");
    expect(fresh).not.toHaveProperty("mask");
  });

  it("names what changed, and tells the agent to report the settings that ran", async () => {
    const fixture = await editFixture();
    const proposal = buildImageSettingsProposal(CONFIG, { prompt: "a harbour" }, fixture.candidates);
    const change = describeSettingsChange(proposal, chosen({ width: 1024, height: 1024, seed: 42 }));

    expect(change.changed).toEqual(["tier", "prompt", "steps", "guidanceScale", "seed"]);
    expect(change.summary).toBe("changed tier fast→quality, prompt, steps 24, guidance 1, seed 42");

    const note = describeImageSettingsForAgent({ source: "user", ran: "quality tier (Qwen-Image 2.1), 1024x1024", change, prompt: "a harbour at dusk" });
    expect(note).toBe(
      " — SETTINGS chosen by the user in the settings step: quality tier (Qwen-Image 2.1), 1024x1024."
      + " They changed tier fast→quality, prompt, steps 24, guidance 1, seed 42."
      + ' Their prompt: "a harbour at dusk".'
      + " Report THESE settings, not the ones you proposed, and do not re-render to restore yours.",
    );
    expect(describeImageSettingsForAgent({ source: "auto" })).toBe(" — SETTINGS: yours; the user chose Auto.");
    expect(describeImageSettingsForAgent({ source: "timeout" })).toBe(" — SETTINGS: yours; the user did not answer the settings step in time.");
    expect(describeImageSettingsForAgent({ source: "session_preference" })).toBe(" — SETTINGS: yours; this chat is set to Auto.");
    // Where nobody could be asked the output stays exactly what it was before this step existed.
    expect(describeImageSettingsForAgent({ source: "no_channel" })).toBe("");
    // A painted mask the person kept in Configure is named by their settings already.
    expect(describeReusedMaskForAgent("generated/harbour.png", "user")).toBe("");
  });

  it("an unchanged Configure says the agent's settings were kept", async () => {
    const fixture = await editFixture();
    const proposal = buildImageSettingsProposal(CONFIG, { prompt: "a lighthouse" }, fixture.candidates);
    const change = describeSettingsChange(proposal, chosen({ tier: "fast", prompt: "a lighthouse", width: 1024, height: 1024, steps: 20, guidanceScale: 7.5 }));
    expect(change).toEqual({ changed: [], summary: "kept the agent's settings" });
  });
});

describe("an edit with no size renders at its base's size", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubEdits() {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      return new Response(JSON.stringify({
        data: [{ b64_json: "QUJD" }],
        usage: { mode: "img2img", strength: Math.fround(Number(body["strength"])) },
      }), { headers: { "Content-Type": "application/json" } });
    }));
    return bodies;
  }

  it("asks for 1024x768 when the base is 1024x768, not the square default", async () => {
    const bodies = stubEdits();
    const base = (await png(1024, 768)).toString("base64");

    const result = await requestImageGeneration(CONFIG, { prompt: "add a boat", initImage: base, strength: 0.6 });

    expect(bodies[0]!["size"]).toBe("1024x768");
    expect(result).toMatchObject({ width: 1024, height: 768 });
  });

  it("still honours an explicit size, a fixed-size engine and a base outside the bounds", async () => {
    const bodies = stubEdits();
    const base = (await png(1024, 768)).toString("base64");

    await requestImageGeneration(CONFIG, { prompt: "add a boat", initImage: base, width: 512, height: 512 });
    expect(bodies[0]!["size"]).toBe("512x512");

    const fixedEditor = { ...CONFIG, fixedSizeModels: ["image", "image-quality"] };
    expect(previewImageRequest(fixedEditor, { prompt: "x", initImage: base }, { width: 1024, height: 768 }))
      .toMatchObject({ width: 1024, height: 1024 });
    expect(previewImageRequest(CONFIG, { prompt: "x", initImage: base }, { width: 4032, height: 3024 }))
      .toMatchObject({ width: 1024, height: 1024 });
    // A new picture never takes a base's size.
    expect(previewImageRequest(CONFIG, { prompt: "x", tier: "quality" }, { width: 1024, height: 768 }))
      .toMatchObject({ width: 1024, height: 1024 });
  });
});

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** One PNG chunk, CRC and all: pngjs checks it, so a crafted file decodes as far as it would. */
function pngChunk(type: string, data: Buffer): Buffer {
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed) >>> 0);
  return Buffer.concat([length, typed, crc]);
}

/** An 8-bit RGBA IHDR — colour type 6, so the file passes the alpha check. */
function ihdr(width: number, height: number, interlaced = false): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8;
  data[9] = 6;
  data[12] = interlaced ? 1 : 0;
  return pngChunk("IHDR", data);
}

const IEND = pngChunk("IEND", Buffer.alloc(0));

/**
 * A PNG that DECLARES a size in its IHDR and carries no real pixels — what an upload or a painted
 * mask looks like to the decoder before it allocates.
 */
function pngDeclaring(width: number, height: number): Buffer {
  return Buffer.concat([PNG_SIGNATURE, ihdr(width, height), pngChunk("IDAT", Buffer.from("garbage")), IEND]);
}

/** 320x256 by its first IHDR and `side`x`side` by a second, with pixels for the second: pngjs keeps the last. */
function pngDeclaringTwice(side: number): Buffer {
  const pixels = deflateSync(Buffer.alloc(side * (1 + side * 4)));
  return Buffer.concat([PNG_SIGNATURE, ihdr(320, 256), ihdr(side, side), pngChunk("IDAT", pixels), IEND]);
}

/** The bytes an Adam7 RGBA picture's pixel stream holds: per pass, each row's filter byte and pixels. */
function adam7Bytes(width: number, height: number): number {
  const passes = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] as const;
  return passes.reduce((total, [x, y, stepX, stepY]) => {
    const passWidth = Math.ceil((width - x) / stepX);
    const passHeight = Math.ceil((height - y) / stepY);
    return passWidth > 0 && passHeight > 0 ? total + passHeight * (1 + passWidth * 4) : total;
  }, 0);
}

/** An interlaced RGBA PNG whose pixel stream inflates to `rawBytes` — its honest length when left out. */
function interlacedPng(width: number, height: number, rawBytes = adam7Bytes(width, height)): Buffer {
  return Buffer.concat([PNG_SIGNATURE, ihdr(width, height, true), pngChunk("IDAT", deflateSync(Buffer.alloc(rawBytes))), IEND]);
}

/** A JPEG whose APP1 carries this EXIF body: a TIFF structure, as a camera writes it. */
async function jpegWithExif(width: number, height: number, tiff: Buffer): Promise<Buffer> {
  const plain = await new Jimp(width, height, 0x336699ff).getBufferAsync(Jimp.MIME_JPEG);
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body]);
  return Buffer.concat([plain.subarray(0, 2), app1, plain.subarray(2)]);
}

/** A big-endian EXIF body: IFD0 at 8 with these 12-byte entries, then whatever `after` holds (IFD0's next-IFD pointer first). */
function exifBody(entries: number[][], after: number[]): Buffer {
  return Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, entries.length >> 8, entries.length & 0xff, ...entries.flat(), ...after]);
}

/** An Orientation entry: SHORT, one value. */
const orientationEntry = (orientation: number): number[] => [0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00];

/** A JPEG carrying an EXIF Orientation tag in IFD0 — 6 is "turn 90° clockwise", how a phone stores a portrait. */
async function jpegOriented(width: number, height: number, orientation: number): Promise<Buffer> {
  return jpegWithExif(width, height, exifBody([orientationEntry(orientation)], [0x00, 0x00, 0x00, 0x00]));
}

function jpegSegment(marker: number, body: number[]): Buffer {
  return Buffer.from([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body]);
}

/** Adobe's APP14, behind which jpeg-js turns 4 components into pixels. */
const ADOBE_SEGMENT = jpegSegment(0xee, [...Buffer.from("Adobe\0", "latin1"), 100, 0, 0, 0, 0, 0]);

/**
 * A baseline JPEG that honestly declares `side`x`side` with `components` components and has no
 * scan: what jpeg-js allocates for, every component, before it looks at the count.
 */
function jpegWithComponents(components: number, extra: Buffer[] = [], side = 2048): Buffer {
  const frame = [8, side >> 8, side & 0xff, side >> 8, side & 0xff, components];
  for (let id = 1; id <= components; id++) frame.push(id, 0x11, 0);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    ...extra,
    jpegSegment(0xdb, [0x00, ...new Array<number>(64).fill(1)]),
    jpegSegment(0xc0, frame),
    jpegSegment(0xc4, [0x00, 1, ...new Array<number>(15).fill(0), 0x00]),
    jpegSegment(0xc4, [0x10, 1, ...new Array<number>(15).fill(0), 0x00]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

/**
 * A progressive grey 2048x2048 JPEG of `scans` scans: every block's DC, then tiny AC scans, each an
 * end-of-band run over every block. All it declares is honest, and jpeg-js walks the whole picture
 * once per scan.
 */
function jpegOfScans(scans: number): Buffer {
  const side = 2048;
  const entropy = (bits: string): Buffer => {
    const padded = bits + "1".repeat((8 - (bits.length % 8)) % 8);
    const bytes: number[] = [];
    for (let at = 0; at < padded.length; at += 8) {
      const byte = parseInt(padded.slice(at, at + 8), 2);
      bytes.push(byte, ...(byte === 0xff ? [0x00] : []));
    }
    return Buffer.from(bytes);
  };
  const acScan = [jpegSegment(0xda, [1, 1, 0x00, 1, 63, 0x00]), entropy(`0${"1".repeat(14)}0${"1".repeat(14)}0${"0".repeat(14)}`)];
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegSegment(0xdb, [0x00, ...new Array<number>(64).fill(1)]),
    jpegSegment(0xc2, [8, side >> 8, side & 0xff, side >> 8, side & 0xff, 1, 1, 0x11, 0]),
    jpegSegment(0xc4, [0x00, 1, ...new Array<number>(15).fill(0), 0x00]),
    jpegSegment(0xc4, [0x10, 1, ...new Array<number>(15).fill(0), 0xe0]),
    jpegSegment(0xda, [1, 1, 0x00, 0, 0, 0x00]),
    entropy("0".repeat((side / 8) * (side / 8))),
    ...Array.from({ length: scans - 1 }, () => acScan).flat(),
    Buffer.from([0xff, 0xd9]),
  ]);
}

/** A JPEG with a second frame header, declaring `width`x`height`, right after its first. */
function jpegWithSecondFrame(jpeg: Buffer, width: number, height: number): Buffer {
  let offset = 2;
  while (jpeg[offset + 1] !== 0xc0) offset += 2 + jpeg.readUInt16BE(offset + 2);
  const end = offset + 2 + jpeg.readUInt16BE(offset + 2);
  const second = Buffer.from(jpeg.subarray(offset, end));
  second.writeUInt16BE(height, 5);
  second.writeUInt16BE(width, 7);
  return Buffer.concat([jpeg.subarray(0, end), second, jpeg.subarray(end)]);
}

/** A GIF with a `screen` and one frame of `frame` pixels at its origin. */
function gif(screen: [number, number], frame: [number, number]): Buffer {
  const header = Buffer.alloc(13);
  header.write("GIF89a", 0, "latin1");
  header.writeUInt16LE(screen[0], 6);
  header.writeUInt16LE(screen[1], 8);
  const descriptor = Buffer.alloc(10);
  descriptor[0] = 0x2c;
  descriptor.writeUInt16LE(frame[0], 5);
  descriptor.writeUInt16LE(frame[1], 7);
  // LZW minimum code size 2, one two-byte sub-block, its terminator, then the trailer.
  return Buffer.concat([header, descriptor, Buffer.from([0x02, 0x02, 0x44, 0x01, 0x00, 0x3b])]);
}

/** A WebP that names its size in a VP8X chunk — nothing Jimp here can decode. */
function webpDeclaring(width: number, height: number): Buffer {
  const webp = Buffer.alloc(30);
  webp.write("RIFF", 0, "latin1");
  webp.write("WEBPVP8X", 8, "latin1");
  webp.writeUIntLE(width - 1, 24, 3);
  webp.writeUIntLE(height - 1, 27, 3);
  return webp;
}

describe("a picture's size is read from its header before anything decodes it", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads PNG, JPEG, BMP, GIF, WebP and TIFF headers, and nothing else", async () => {
    expect(readImageHeaderSize(await png(320, 256))).toEqual({ width: 320, height: 256 });
    expect(readImageHeaderSize(await new Jimp(300, 200, 0x336699ff).getBufferAsync(Jimp.MIME_JPEG))).toEqual({ width: 300, height: 200 });
    expect(readImageHeaderSize(await new Jimp(64, 48, 0x336699ff).getBufferAsync(Jimp.MIME_BMP))).toEqual({ width: 64, height: 48 });
    expect(readImageHeaderSize(await new Jimp(64, 48, 0x336699ff).getBufferAsync(Jimp.MIME_GIF))).toEqual({ width: 64, height: 48 });
    expect(readImageHeaderSize(gif([640, 480], [640, 480]))).toEqual({ width: 640, height: 480 });
    expect(readImageHeaderSize(await new Jimp(64, 48, 0x336699ff).getBufferAsync(Jimp.MIME_TIFF))).toEqual({ width: 64, height: 48 });
    expect(readImageHeaderSize(webpDeclaring(800, 600))).toEqual({ width: 800, height: 600 });
    expect(readImageHeaderSize(pngDeclaring(20_000, 20_000))).toEqual({ width: 20_000, height: 20_000 });
    expect(readImageHeaderSize(Buffer.from("not an image"))).toBeUndefined();
    expect(readImageHeaderSize((await png(320, 256)).subarray(0, 20))).toBeUndefined();
  });

  it("refuses a painted mask that declares another size without decoding it", async () => {
    const context = await editContext(await editFixture());
    const read = vi.spyOn(Jimp, "read");
    const verdict = await validateImageSettingsAnswer(
      withEdit(await validEditAnswer(), { maskDataUrl: dataUrl(pngDeclaring(20_000, 20_000)) }),
      context,
    );

    expect((verdict as { errors: Array<{ field: string; message: string }> }).errors)
      .toEqual([{ field: "settings.edit.maskDataUrl", message: "is 20000x20000; it must be 320x256, the size of the base picture" }]);
    expect(read, "the mask was decoded before its size was checked").not.toHaveBeenCalled();
  });

  it("skips a candidate that declares a size outside the bounds without decoding it", async () => {
    const ok = await png(256, 256);
    const read = vi.spyOn(Jimp, "read");
    const candidates = await collectBaseCandidates([
      { relativePath: "uploads/bomb.png", source: "attachment", read: async () => pngDeclaring(20_000, 20_000) },
      { relativePath: "uploads/phone.png", source: "attachment", read: async () => pngDeclaring(4032, 3024) },
      { relativePath: "generated/ok.png", source: "latest_image", read: async () => ok },
    ], 6);

    expect(candidates.map((candidate) => candidate.relativePath)).toEqual(["generated/ok.png"]);
    expect(read, "only the picture that fits is decoded, for its thumbnail").toHaveBeenCalledTimes(1);
  });

  it("measures an edit's base from its header", async () => {
    const read = vi.spyOn(Jimp, "read");
    expect(await measureImage((await png(1024, 768)).toString("base64"))).toEqual({ width: 1024, height: 768 });
    expect(await measureImage(pngDeclaring(20_000, 20_000).toString("base64"))).toEqual({ width: 20_000, height: 20_000 });
    expect(read).not.toHaveBeenCalled();
  });
});

/**
 * One declaration is not always the one the decoder reads (the review of #20/#26): a PNG with a
 * second IHDR, an interlaced PNG whose pixel stream inflates past its size, a JPEG with a second
 * frame, a GIF whose first frame outgrows its screen. Each passed a header check and then decoded —
 * or began to — at whatever size the crafted part said, holding the gateway while it did.
 */
describe("a picture decodes only within the size it declares", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses a picture that declares its size twice, without decoding it", async () => {
    const twice = pngDeclaringTwice(1500);
    const frames = jpegWithSecondFrame(await new Jimp(64, 48, 0x336699ff).getBufferAsync(Jimp.MIME_JPEG), 2000, 2000);
    expect(readImageHeaderSize(twice)).toBeUndefined();
    expect(readImageHeaderSize(frames)).toBeUndefined();

    const context = await editContext(await editFixture());
    const read = vi.spyOn(Jimp, "read");
    const verdict = await validateImageSettingsAnswer(withEdit(await validEditAnswer(), { maskDataUrl: dataUrl(twice) }), context);
    const candidates = await collectBaseCandidates([
      { relativePath: "uploads/twice.png", source: "attachment", read: async () => twice },
      { relativePath: "uploads/frames.jpg", source: "attachment", read: async () => frames },
    ], 6);

    expect((verdict as { errors: Array<{ field: string; message: string }> }).errors)
      .toEqual([{ field: "settings.edit.maskDataUrl", message: "does not decode as a PNG" }]);
    expect(candidates).toEqual([]);
    expect(read, "a second declaration was decoded").not.toHaveBeenCalled();
  });

  it("decodes an interlaced PNG only when its pixels fit the size it declares", async () => {
    const honest = interlacedPng(320, 256);
    const bomb = interlacedPng(320, 256, 64 * 1024 * 1024);
    expect(bomb.length, "the crafted file is small").toBeLessThan(200_000);
    expect(decodesWithinDeclaredSize(honest)).toBe(true);
    expect(decodesWithinDeclaredSize(bomb)).toBe(false);
    // The cap is exactly what the size needs, odd sides included: one byte more is refused.
    for (const [width, height] of [[320, 256], [321, 257], [7, 3]] as const) {
      expect(decodesWithinDeclaredSize(interlacedPng(width, height)), `${width}x${height}`).toBe(true);
      expect(decodesWithinDeclaredSize(interlacedPng(width, height, adam7Bytes(width, height) + 1)), `${width}x${height} + 1`).toBe(false);
    }

    const context = await editContext(await editFixture());
    const read = vi.spyOn(Jimp, "read");
    const candidates = await collectBaseCandidates([
      { relativePath: "uploads/bomb.png", source: "attachment", read: async () => bomb },
      { relativePath: "uploads/honest.png", source: "attachment", read: async () => honest },
    ], 6);
    const verdict = await validateImageSettingsAnswer(withEdit(await validEditAnswer(), { maskDataUrl: dataUrl(bomb) }), context);

    expect(candidates.map(({ relativePath, width, height }) => [relativePath, width, height])).toEqual([["uploads/honest.png", 320, 256]]);
    expect(candidates[0]!.thumbDataUrl).toMatch(/^data:image\/jpeg;base64,/);
    expect((verdict as { errors: Array<{ field: string; message: string }> }).errors)
      .toEqual([{ field: "settings.edit.maskDataUrl", message: "does not decode as a PNG" }]);
    expect(read, "only the honest picture is decoded, for its thumbnail").toHaveBeenCalledTimes(1);
  });

  it("decodes a JPEG only with components jpeg-js outputs and no more scans than an encoder writes", async () => {
    // 187 bytes naming 20 components held the gateway 836 ms and took RSS to 1 GB before jpeg-js
    // threw "Unsupported color mode"; 2000 scans of 16 bytes each walk the picture 2000 times.
    const components = jpegWithComponents(20);
    const scans = jpegOfScans(2000);
    expect(components.length).toBeLessThan(200);
    expect([1, 2, 3, 4, 20].map((count) => decodesWithinDeclaredSize(jpegWithComponents(count)))).toEqual([true, false, true, false, false]);
    expect(decodesWithinDeclaredSize(jpegWithComponents(4, [ADOBE_SEGMENT])), "CMYK behind Adobe's APP14").toBe(true);
    expect([64, 65].map((count) => decodesWithinDeclaredSize(jpegOfScans(count)))).toEqual([true, false]);

    const read = vi.spyOn(Jimp, "read");
    const candidates = await collectBaseCandidates([
      { relativePath: "uploads/scans.jpg", source: "agent", read: async () => scans },
      { relativePath: "uploads/components.jpg", source: "attachment", read: async () => components },
    ], 6);
    // The agent's own keeps the size it declares, without a thumbnail; the other is not offered.
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ source: "agent", width: 2048, height: 2048, fitsBounds: true, thumbDataUrl: "" });
    expect(read, "a JPEG jpeg-js would not keep to its size was decoded").not.toHaveBeenCalled();
  });

  it("reads a broken EXIF as Jimp does: no turn, and the size still read", async () => {
    const make = [0x01, 0x0f, 0x00, 0x02, 0x00, 0x00, 0x00, 0x04, 0x41, 0x42, 0x43, 0x00]; // Make "ABC"
    const cases: Array<[string, Buffer, { width: number; height: number }]> = [
      // No orientation, and IFD0's pointer to IFD1 cut off: the size was lost, so Auto rendered square.
      ["next-IFD pointer cut off", exifBody([make], [0x00, 0x00]), { width: 64, height: 48 }],
      ["IFD1 out of range", exifBody([make], [0x00, 0x00, 0xff, 0xf0]), { width: 64, height: 48 }],
      // Turned 6 in IFD0, but exif-parser throws on IFD1, so Jimp does not turn it at all.
      ["IFD0 turned, IFD1 out of range", exifBody([orientationEntry(6)], [0x00, 0x00, 0xff, 0xf0]), { width: 64, height: 48 }],
      // The orientation is in IFD1 only, and Jimp turns by it.
      ["orientation in IFD1", exifBody([make], [0x00, 0x00, 0x00, 0x1a, 0x00, 0x01, ...orientationEntry(6), 0x00, 0x00, 0x00, 0x00]), { width: 48, height: 64 }],
    ];
    for (const [name, tiff, shown] of cases) {
      const photo = await jpegWithExif(64, 48, tiff);
      const decoded = (await Jimp.read(photo)).bitmap;
      expect({ width: decoded.width, height: decoded.height }, `${name}: Jimp`).toEqual(shown);
      expect(readImageHeaderSize(photo), name).toEqual(shown);
    }
  });

  it("does not decode a JPEG with more EXIF than a camera writes", async () => {
    const entries = (count: number) => Array.from({ length: count }, () => [0x01, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x40, 0x00, 0x00]);
    const camera = await jpegWithExif(64, 48, exifBody(entries(2048), [0x00, 0x00, 0x00, 0x00]));
    const crafted = await jpegWithExif(64, 48, exifBody(entries(2049), [0x00, 0x00, 0x00, 0x00]));
    expect(readImageHeaderSize(camera)).toEqual({ width: 64, height: 48 });
    expect(readImageHeaderSize(crafted)).toBeUndefined();

    const read = vi.spyOn(Jimp, "read");
    expect(await collectBaseCandidates([{ relativePath: "uploads/exif.jpg", source: "attachment", read: async () => crafted }], 6)).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it("stops a JPEG at its end, and holds a GIF's first frame to its screen", async () => {
    const photo = await new Jimp(64, 48, 0x336699ff).getBufferAsync(Jimp.MIME_JPEG);
    // A phone appends a second picture (a depth map) after EOI; the decoder never reads it.
    const appended = Buffer.concat([photo, await new Jimp(96, 96, 0x336699ff).getBufferAsync(Jimp.MIME_JPEG)]);
    expect(readImageHeaderSize(appended)).toEqual({ width: 64, height: 48 });

    const outgrown = gif([320, 256], [4000, 4000]);
    expect(readImageHeaderSize(outgrown)).toBeUndefined();
    const read = vi.spyOn(Jimp, "read");
    expect(await collectBaseCandidates([{ relativePath: "uploads/anim.gif", source: "attachment", read: async () => outgrown }], 6)).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it("reads a TIFF's size and an OS/2 bitmap's, and hands neither to the decoder", async () => {
    const tiff = await new Jimp(640, 480, 0x336699ff).getBufferAsync(Jimp.MIME_TIFF);
    const os2 = Buffer.alloc(32);
    os2.write("BM", 0, "latin1");
    os2.writeUInt32LE(12, 14);
    os2.writeUInt16LE(100, 18);
    os2.writeUInt16LE(80, 20);
    expect(readImageHeaderSize(os2)).toEqual({ width: 100, height: 80 });
    expect(decodesWithinDeclaredSize(os2)).toBe(false);
    expect(decodesWithinDeclaredSize(tiff)).toBe(false);

    const read = vi.spyOn(Jimp, "read");
    const candidates = await collectBaseCandidates([
      { relativePath: "uploads/scan.tif", source: "agent", read: async () => tiff },
      { relativePath: "uploads/other.tif", source: "attachment", read: async () => tiff },
    ], 6);
    // The agent's own TIFF keeps its shape, without a thumbnail; another is not offered.
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ source: "agent", width: 640, height: 480, fitsBounds: true, thumbDataUrl: "", mime: "image/tiff" });
    expect(await measureImage(tiff.toString("base64"))).toEqual({ width: 640, height: 480 });
    expect(read).not.toHaveBeenCalled();
  });

  it("reads a JPEG's size as it is shown, so the card, the form and Auto agree", async () => {
    for (const [orientation, shown] of [[6, { width: 48, height: 64 }], [8, { width: 48, height: 64 }], [3, { width: 64, height: 48 }]] as const) {
      const photo = await jpegOriented(64, 48, orientation);
      const decoded = (await Jimp.read(photo)).bitmap;
      expect({ width: decoded.width, height: decoded.height }, `orientation ${orientation}`).toEqual(shown);
      expect(readImageHeaderSize(photo), `orientation ${orientation}`).toEqual(shown);
    }

    const portrait = await jpegOriented(2048, 1536, 6);
    const candidates = await collectBaseCandidates([{ relativePath: "uploads/portrait.jpg", source: "agent", read: async () => portrait }], 6);
    const request = { prompt: "a warmer sky", initImage: portrait.toString("base64") };
    const proposal = buildImageSettingsProposal(CONFIG, request, candidates);
    const auto = previewImageRequest(CONFIG, request, await measureImage(request.initImage));
    expect(candidates[0]).toMatchObject({ width: 1536, height: 2048 });
    expect(proposal.agent).toMatchObject({ width: 1536, height: 2048 });
    expect(auto).toMatchObject({ width: 1536, height: 2048 });
  });
});

describe("the agent's own base is always on offer", () => {
  it("is offered at a cap of 0, without a thumbnail when it cannot be decoded, and flagged when too large", async () => {
    const [large, ...rest] = await collectBaseCandidates([
      { relativePath: "uploads/phone.png", source: "agent", read: async () => pngDeclaring(4032, 3024) },
      { relativePath: "generated/latest.png", source: "latest_image", read: async () => png(512, 512) },
    ], 0);
    expect(large).toMatchObject({ id: "c1", source: "agent", width: 4032, height: 3024, fitsBounds: false, thumbDataUrl: "" });
    expect(rest).toEqual([]);

    const [undecodable] = await collectBaseCandidates([{ relativePath: "uploads/photo.webp", source: "agent", read: async () => webpDeclaring(800, 600) }], 6);
    expect(undecodable).toMatchObject({ source: "agent", width: 800, height: 600, fitsBounds: true, thumbDataUrl: "", mime: "image/webp" });
  });

  it("keeps Configure an edit of that picture, at the size Auto would render it", async () => {
    const phone = pngDeclaring(4032, 3024);
    const candidates = await collectBaseCandidates([{ relativePath: "uploads/phone.png", source: "agent", read: async () => phone }], 6);
    const proposal = buildImageSettingsProposal(CONFIG, { prompt: "make the sky warmer", initImage: phone.toString("base64") }, candidates);
    expect(proposal.agent).toMatchObject({ baseCandidateId: "c1", width: 1024, height: 1024 });
    expect(proposal.baseCandidates[0]).toMatchObject({ id: "c1", fitsBounds: false });
    const context = { config: CONFIG, proposal, candidates };
    const answer = {
      choice: "configure",
      settings: {
        tier: "quality", prompt: "make the sky warmer", negativePrompt: "", width: 1024, height: 1024,
        steps: 30, guidanceScale: 1, seed: null, edit: { baseCandidateId: "c1", strength: 0.45 },
      },
    };

    const verdict = await validateImageSettingsAnswer(answer, context);
    expect(verdict.ok, JSON.stringify(verdict)).toBe(true);
    expect((verdict as { summary?: string }).summary).toBe("changed steps 30");

    const atOwnSize = await validateImageSettingsAnswer(withSettings(answer, { width: 4032, height: 3024 }), context);
    expect((atOwnSize as { errors: Array<{ message: string }> }).errors.map((error) => error.message))
      .toEqual(["must be 1024x1024; the base picture is too large to edit at its own size"]);
    const masked = await validateImageSettingsAnswer(withEdit(answer, { maskDataUrl: dataUrl(await maskPng(320, 256, { x: 0, y: 0, w: 8, h: 8 })) }), context);
    expect((masked as { errors: Array<{ field: string; message: string }> }).errors)
      .toEqual([{ field: "settings.edit.maskDataUrl", message: "this picture is too large to paint a mask on; render without one" }]);
  });

  it("never records a base the person was not offered as one they dropped", () => {
    const proposal = buildImageSettingsProposal(CONFIG, { prompt: "x", initImage: "QUJD" }, []);
    expect(proposal.mode).toBe("edit");
    const change = describeSettingsChange(proposal, {
      tier: "quality", prompt: "x", negativePrompt: "", width: 1024, height: 1024, steps: 20, guidanceScale: 1, seed: null, edit: null,
    });
    expect(change.changed).not.toContain("baseImage");
  });
});
