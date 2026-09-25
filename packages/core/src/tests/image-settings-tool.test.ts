import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Jimp from "jimp";
import type { ToolContext } from "../tools/registry.js";
import { DECLINED_BY_USER_METADATA_KEY, isDeclinedByUser, type UserInputOutcome, type UserInputRequest } from "../agent/user-input.js";

/**
 * generate_image's settings step, end to end through the tool: the proposal it builds from the
 * chat's own pictures, the answer the person gives, and what actually reaches the backend.
 *
 * The person's choice must be what renders — their engine, their base picture, their painted mask —
 * and the agent must be told so in words it reads, or it reports its own settings and "restores"
 * them with a second render.
 */

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const IMAGE_CONFIG = {
  baseUrl: "http://cluster.local:8080/v1",
  api: "openai-compatible",
  model: "image",
  qualityModel: "image-quality",
  fixedSizeModels: ["image"],
  initImageModels: ["image-quality"],
  qualityDefaults: { steps: 20, guidanceScale: 1 },
  defaultGuidanceScale: 7.5,
  defaultSteps: 20,
  tierLabels: { fast: "Segmind Vega", quality: "Qwen-Image 2.1" },
};

interface Post {
  url: string;
  fields: Record<string, string>;
  files: Record<string, Buffer>;
}

/** The cluster: /models answers, generations and edits render, an edit reports what it applied. */
function stubCluster(opts: { offline?: boolean; hang?: boolean; hangFirst?: boolean; onRender?: () => void; renderFailCode?: string } = {}) {
  const posts: Post[] = [];
  let renders = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!init?.method || init.method === "GET") {
      if (opts.offline) throw new Error("fetch failed");
      return new Response(JSON.stringify({ data: [{ id: "image" }, { id: "image-quality" }] }), { status: 200 });
    }
    opts.onRender?.();
    renders += 1;
    // A render that dies below HTTP, the way undici reports it: "fetch failed" with the cause's code.
    if (opts.renderFailCode) {
      throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(`${opts.renderFailCode} happened`), { code: opts.renderFailCode }) });
    }
    if (opts.hang || (opts.hangFirst && renders === 1)) {
      // A render that outlasts its budget: only our own timer ends it.
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("This operation was aborted")));
      });
    }
    const post: Post = { url, fields: {}, files: {} };
    if (init.body instanceof FormData) {
      // (The DOM iterable typings are not in this package's lib, so entries() is typed by hand.)
      for (const [key, value] of (init.body as unknown as { entries(): Iterable<[string, string | Blob]> }).entries()) {
        if (typeof value === "string") post.fields[key] = value;
        else post.files[key] = Buffer.from(await value.arrayBuffer());
      }
    } else {
      for (const [key, value] of Object.entries(JSON.parse(String(init.body)) as Record<string, unknown>)) {
        if (key === "image" || key === "mask") post.files[key] = Buffer.from(String(value), "base64");
        else post.fields[key] = String(value);
      }
    }
    posts.push(post);
    const strength = Number(post.fields["strength"]);
    const usage = url.endsWith("/images/edits")
      ? { mode: "img2img", strength: Math.fround(strength), ...(post.files["mask"] ? { mask: { respected: true, edited_delta: 30, protected_delta: 1 } } : {}) }
      : undefined;
    return new Response(JSON.stringify({ data: [{ b64_json: PNG_1X1 }], ...(usage ? { usage } : {}) }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, posts };
}

async function png(width: number, height: number): Promise<Buffer> {
  return new Jimp(width, height, 0x336699ff).getBufferAsync(Jimp.MIME_PNG);
}

async function maskPng(width: number, height: number): Promise<Buffer> {
  const image = new Jimp(width, height, 0x000000ff);
  image.scan(0, 0, Math.floor(width / 2), height, (_x, _y, index) => { image.bitmap.data[index + 3] = 0; });
  return image.getBufferAsync(Jimp.MIME_PNG);
}

type Ask = NonNullable<ToolContext["requestUserInput"]>;

/**
 * A stand-in for the dashboard: builds the payload as the broker would, lets `answer` read it, runs
 * the request's own validator, and settles the way the broker settles.
 */
function person(answer: (payload: Record<string, unknown>) => unknown, rootSessionId: string) {
  const seen: { request?: UserInputRequest<unknown>; payload?: Record<string, unknown>; errors?: unknown } = {};
  const ask = vi.fn(async (request: UserInputRequest<unknown>): Promise<UserInputOutcome<unknown>> => {
    seen.request = request;
    const payload = typeof request.payload === "function" ? await request.payload() : request.payload;
    seen.payload = payload;
    const verdict = await request.validate(answer(payload));
    if (!verdict.ok) {
      seen.errors = verdict.errors;
      return { outcome: "auto", reason: "timeout", waitedMs: 1, rootSessionId };
    }
    const extras = { waitedMs: 1500, rootSessionId, ...(verdict.summary ? { summary: verdict.summary } : {}) };
    if (verdict.outcome === "auto") return { outcome: "auto", reason: "user", value: verdict.value, ...extras };
    if (verdict.outcome === "cancelled") return { outcome: "cancelled", reason: "user_skipped", value: verdict.value, ...extras };
    return { outcome: "configured", value: verdict.value, ...extras };
  });
  return { ask: ask as unknown as Ask, mock: ask, seen };
}

describe("generate_image: the settings step", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-image-settings-"));
  const configPath = join(tempDir, "starlingai.json");
  let getTool: typeof import("../tools/registry.js").getTool;
  let session: typeof import("../agent/session.js");
  let memory: typeof import("../swarm/memory.js");
  let broker: typeof import("../agent/user-input-broker.js");

  const writeConfig = async (settingsPrompt?: Record<string, unknown>, imageConfig: Record<string, unknown> = {}) => {
    writeFileSync(configPath, JSON.stringify({
      workspacePath: tempDir,
      gateway: { jwtSecret: "t".repeat(32) },
      multimodal: { imageGeneration: { ...IMAGE_CONFIG, ...imageConfig, ...(settingsPrompt ? { settingsPrompt } : {}) } },
    }), "utf8");
    (await import("../config/loader.js")).resetConfigForTests();
  };

  beforeAll(async () => {
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();
    await writeConfig();
    await import("../tools/multimodal.js");
    ({ getTool } = await import("../tools/registry.js"));
    session = await import("../agent/session.js");
    memory = await import("../swarm/memory.js");
    broker = await import("../agent/user-input-broker.js");
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await memory.resetSharedMemoryForTests();
    for (const active of session.getAllSessions()) session.endSession(active.id);
    await writeConfig();
  });

  afterAll(() => {
    delete process.env["SAI_CONFIG_PATH"];
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** A chat whose last render is generated/harbour.png and whose user uploaded uploads/boat.png. */
  async function chatWithPictures() {
    const chat = session.createSession({ channel: "webchat" });
    mkdirSync(join(tempDir, "generated"), { recursive: true });
    mkdirSync(join(tempDir, "uploads"), { recursive: true });
    const harbour = await png(320, 256);
    writeFileSync(join(tempDir, "generated", "harbour.png"), harbour);
    writeFileSync(join(tempDir, "uploads", "boat.png"), await png(256, 256));
    await memory.writeSharedFact(chat.id, "latest_image", "generated/harbour.png");
    chat.addMessage({
      role: "user",
      content: "here is my boat",
      metadata: { attachments: [{ filename: "boat.png", relativePath: "uploads/boat.png", contentType: "image/png" }] },
    });
    return { chat, harbour };
  }

  const run = (args: Record<string, unknown>, ctx: Partial<ToolContext>) =>
    getTool("generate_image")!.execute(args, { sessionId: "chat", workspacePath: tempDir, ...ctx } as ToolContext);

  it("renders the person's engine, base picture and painted mask, and tells the agent so", async () => {
    const { chat, harbour } = await chatWithPictures();
    const mask = await maskPng(320, 256);
    const { posts } = stubCluster();
    const words = { opening: "", midTurn: [] as string[] };
    const { ask, seen } = person((payload) => {
      const candidates = payload["baseCandidates"] as Array<{ id: string; label: string }>;
      return {
        choice: "configure",
        settings: {
          tier: "quality", prompt: "a harbour at dusk, photograph", negativePrompt: "", width: 320, height: 256,
          steps: 24, guidanceScale: 1, seed: 42,
          edit: {
            baseCandidateId: candidates.find((candidate) => candidate.label === "harbour.png")!.id,
            strength: 0.7, maskDataUrl: `data:image/png;base64,${mask.toString("base64")}`, maskBlur: 24,
          },
        },
      };
    }, chat.id);

    const result = await run({ prompt: "a harbour" }, { sessionId: `sub:${chat.id}:image_creator:1`, requestUserInput: ask, turnUserWords: words });

    expect(result.success, String(result.error)).toBe(true);
    // The proposal offered the chat's own pictures, newest render first, and the agent's plan.
    expect((seen.payload!["baseCandidates"] as Array<{ label: string; source: string }>).map(({ label, source }) => [label, source]))
      .toEqual([["harbour.png", "latest_image"], ["boat.png", "attachment"]]);
    expect(seen.payload!["agent"]).toMatchObject({ tier: "fast", width: 1024, height: 1024, prompt: "a harbour" });

    // What reached the backend is the person's request, not the agent's.
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toMatch(/\/images\/edits$/);
    expect(posts[0]!.fields).toMatchObject({
      model: "image-quality", prompt: "a harbour at dusk, photograph", size: "320x256",
      steps: "24", guidance_scale: "1", seed: "42", strength: "0.7", mask_blur: "24",
    });
    expect(posts[0]!.files["image"]!.equals(harbour)).toBe(true);
    expect(posts[0]!.files["mask"]!.equals(mask)).toBe(true);

    // The painted mask is kept for reuse.
    const settings = result.metadata!["settings"] as Record<string, unknown>;
    expect(settings).toMatchObject({ source: "user", waitedMs: 1500, baseImage: "generated/harbour.png" });
    expect(settings["changed"]).toEqual(["tier", "prompt", "size", "steps", "guidanceScale", "seed", "baseImage", "strength", "mask", "maskBlur"]);
    const maskPath = String(settings["maskPath"]);
    expect(maskPath).toMatch(/^generated\/image-masks\/harbour-mask-\d+\.png$/);
    expect(readFileSync(join(tempDir, maskPath)).equals(mask)).toBe(true);
    expect(await memory.readSharedFact(chat.id, "latest_mask")).toBe(maskPath);

    // The agent reads what ran and who chose it; later specialists read it as the person's words.
    expect(result.output).toContain("SETTINGS chosen by the user in the settings step: quality tier (Qwen-Image 2.1), 320x256, 24 steps, guidance 1, seed 42");
    expect(result.output).toContain(`an edit of generated/harbour.png at strength 0.7 with the mask ${maskPath} (~50% may change)`);
    expect(result.output).toContain('Their prompt: "a harbour at dusk, photograph"');
    expect(result.output).toContain("do not re-render to restore yours");
    expect(words.midTurn).toHaveLength(1);
    expect(words.midTurn[0]).toMatch(/^\(image settings\) changed tier fast→quality, prompt, size 320x256/);
    expect(words.midTurn[0]).toContain('their prompt: "a harbour at dusk, photograph"');
  });

  it("offers the agent's own base first and renders an untouched Auto at that base's size", async () => {
    const { chat } = await chatWithPictures();
    writeFileSync(join(tempDir, "uploads", "wide.png"), await png(1024, 768));
    const { posts } = stubCluster();
    const { ask, seen } = person(() => ({ choice: "auto" }), chat.id);

    const result = await run(
      { prompt: "add a lighthouse", baseImage: "uploads/wide.png", strength: 0.3 },
      { sessionId: `sub:${chat.id}:image_creator:1`, requestUserInput: ask },
    );

    expect(result.success, String(result.error)).toBe(true);
    const candidates = seen.payload!["baseCandidates"] as Array<{ id: string; label: string; source: string }>;
    expect(candidates[0]).toMatchObject({ label: "wide.png", source: "agent" });
    expect(seen.payload!["agent"]).toMatchObject({ tier: "quality", width: 1024, height: 768, strength: 0.3, baseCandidateId: candidates[0]!.id });
    expect(posts[0]!.fields).toMatchObject({ model: "image-quality", size: "1024x768", strength: "0.3" });
    expect(result.output).toContain(" — SETTINGS: yours; the user chose Auto.");
    expect(result.metadata!["settings"]).toEqual({ source: "auto", changed: [], waitedMs: 1500 });
  });

  it("a skipped render renders nothing and tells the agent not to retry", async () => {
    const { chat } = await chatWithPictures();
    const { fetchMock } = stubCluster();
    const words = { opening: "", midTurn: [] as string[] };
    const { ask } = person(() => ({ choice: "skip" }), chat.id);

    const result = await run({ prompt: "a harbour" }, { requestUserInput: ask, turnUserWords: words });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/skipped this render.*nothing was rendered\. Do not retry; tell the user and ask what they want instead\./);
    // Only the health probe went out.
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
    expect(words.midTurn).toEqual(["(image settings) skipped this render"]);
    // Tagged, so the chat shows the user's own choice as "Skipped by you", not as a failed step —
    // and flagged, so the orchestrator's run record lists it as declined rather than as a broken render.
    expect(result.metadata).toEqual({ settings: { source: "user_skipped", changed: [], waitedMs: 1500 }, [DECLINED_BY_USER_METADATA_KEY]: true });
    expect(isDeclinedByUser(result.metadata)).toBe(true);
  });

  it("'always Auto' is kept on the chat, so later renders are not put to the person", async () => {
    const { chat } = await chatWithPictures();
    const { posts } = stubCluster();
    const { ask, seen } = person(() => ({ choice: "auto", alwaysAuto: true }), chat.id);

    const result = await run({ prompt: "a harbour" }, { requestUserInput: ask });

    expect(result.success, String(result.error)).toBe(true);
    expect(posts[0]!.fields).toMatchObject({ model: "image", size: "1024x1024" });
    expect(session.getSessionRecord(chat.id)!.getSettings().imageSettingsPrompt).toBe("auto");
    // The broker reads this before building anything for the next render.
    expect(seen.request!.autoIf!({ imageSettingsPrompt: "auto" })).toBe(true);
    expect(seen.request!.autoIf!({})).toBe(false);
  });

  it("a rejected answer does not render the person's settings", async () => {
    const { chat } = await chatWithPictures();
    const { posts } = stubCluster();
    const { ask, seen } = person(() => ({
      choice: "configure",
      settings: { tier: "fast", prompt: "a harbour", negativePrompt: "", width: 512, height: 512, steps: 20, guidanceScale: 7.5, seed: null, edit: null },
    }), chat.id);

    const result = await run({ prompt: "a harbour" }, { requestUserInput: ask });

    expect(seen.errors).toEqual([{ field: "settings.width", message: "Segmind Vega renders 1024x1024 only" }]);
    // The stand-in let it time out: the agent's own request ran.
    expect(result.success, String(result.error)).toBe(true);
    expect(posts[0]!.fields).toMatchObject({ size: "1024x1024" });
  });

  it("asks nobody where nobody can answer, when switched off, or when the backend is down", async () => {
    await chatWithPictures();
    stubCluster();
    const plain = await run({ prompt: "a harbour" }, {});
    expect(plain.success, String(plain.error)).toBe(true);
    expect(plain.output).not.toContain("SETTINGS");
    expect(plain.metadata).not.toHaveProperty("settings");

    const noChannel = await run({ prompt: "a harbour" }, {
      requestUserInput: (async () => ({ outcome: "auto", reason: "no_channel", waitedMs: 0 })) as unknown as Ask,
    });
    expect(noChannel.output).not.toContain("SETTINGS");
    expect(noChannel.metadata).not.toHaveProperty("settings");

    await writeConfig({ enabled: false });
    const off = person(() => ({ choice: "skip" }), "chat");
    expect((await run({ prompt: "a harbour" }, { requestUserInput: off.ask })).success).toBe(true);
    expect(off.mock).not.toHaveBeenCalled();

    await writeConfig();
    vi.unstubAllGlobals();
    stubCluster({ offline: true });
    const down = person(() => ({ choice: "auto" }), "chat");
    const offline = await run({ prompt: "a harbour" }, { requestUserInput: down.ask });
    expect(offline.success).toBe(false);
    expect(down.mock).not.toHaveBeenCalled();
  });

  // Session 9cc3f362: two quality renders cut at 300 s by the transport were reported as "service is
  // offline" while the service was up — any "fetch failed" read as offline.
  it("calls the service offline only when it could not be reached, and passes any other transport failure on", async () => {
    await writeConfig();
    vi.unstubAllGlobals();
    stubCluster({ renderFailCode: "UND_ERR_HEADERS_TIMEOUT" });
    const cutShort = await run({ prompt: "a harbour" }, {});
    expect(cutShort.success).toBe(false);
    expect(cutShort.error).not.toContain("offline");
    expect(cutShort.error).toContain("UND_ERR_HEADERS_TIMEOUT");

    vi.unstubAllGlobals();
    stubCluster({ renderFailCode: "ECONNREFUSED" });
    const refused = await run({ prompt: "a harbour" }, {});
    expect(refused.error).toContain("Image generation service is offline");
  });

  it("serves a full-size preview only for the ids it offered", async () => {
    const { chat, harbour } = await chatWithPictures();
    stubCluster();
    const { ask, seen } = person(() => ({ choice: "auto" }), chat.id);
    await run({ prompt: "a harbour" }, { sessionId: `sub:${chat.id}:image_creator:1`, requestUserInput: ask });

    const id = (seen.payload!["baseCandidates"] as Array<{ id: string; label: string }>).find((c) => c.label === "harbour.png")!.id;
    expect(await seen.request!.preview!(id)).toEqual({ dataUrl: `data:image/png;base64,${harbour.toString("base64")}`, width: 320, height: 256 });
    expect(await seen.request!.preview!("generated/harbour.png")).toBeNull();
  });

  it("tells the agent the user may change its settings and paint a mask it cannot", async () => {
    const { getToolsAsLLMDefs } = await import("../tools/registry.js");
    const [def] = getToolsAsLLMDefs(["generate_image"]);
    const mask = String(((def!.parameters as { properties: Record<string, { description?: string }> }).properties["mask"])?.description);

    expect(def!.description).toContain("paint a mask, or skip the render");
    expect(def!.description).toContain("never re-render to restore yours");
    expect(mask).toContain("you cannot draw one");
    expect(mask).toContain("can paint one in the settings step");
    // A painted mask is one region of one picture; the agent cannot see which.
    expect(mask).toContain("reuse it only to change that SAME region again");
    expect(mask).not.toContain("none of the image tools can draw one");
  });

  it("the session setting round-trips through session.get and session.updateSettings", async () => {
    const { RpcConnection } = await import("../gateway/rpc.js");
    const chat = session.createSession({ channel: "webchat" });
    const sent: Array<Record<string, unknown>> = [];
    const conn = new RpcConnection({ readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw) as Record<string, unknown>) } as never);
    let n = 0;
    const call = async (method: string, params: Record<string, unknown>) => {
      const id = `${method}-${n++}`;
      await conn.handleMessage(JSON.stringify({ id, method, params }));
      return sent.find((event) => event["type"] === "rpc.response" && event["id"] === id) as { ok: boolean; payload?: Record<string, unknown>; error?: string };
    };
    const settingOf = async () => ((await call("session.get", { sessionId: chat.id })).payload!["settings"] as Record<string, unknown>)["imageSettingsPrompt"];

    expect(await settingOf()).toBe("ask");
    const updated = await call("session.updateSettings", { sessionId: chat.id, imageSettingsPrompt: "auto" });
    expect((updated.payload!["settings"] as Record<string, unknown>)["imageSettingsPrompt"]).toBe("auto");
    expect(await settingOf()).toBe("auto");
    await call("session.updateSettings", { sessionId: chat.id, imageSettingsPrompt: "ask" });
    expect(chat.getSettings()).not.toHaveProperty("imageSettingsPrompt");
    expect(await settingOf()).toBe("ask");
    const bad = await call("session.updateSettings", { sessionId: chat.id, imageSettingsPrompt: "sometimes" });
    expect(bad.ok).toBe(false);
    conn.close();
  });

  it("writes an unnamed render once under generated/, not into a hidden doubled directory", async () => {
    await chatWithPictures();
    stubCluster();
    const result = await run({ prompt: "a harbour" }, {});

    expect(result.success, String(result.error)).toBe(true);
    // 807684e9: every default came out as generated/.starlingai/generated/image-<ts>.png.
    expect(String(result.metadata!["outputPath"])).toMatch(/^generated\/image-\d+\.png$/);
    expect(readFileSync(join(tempDir, String(result.metadata!["outputPath"]))).length).toBeGreaterThan(0);
  });

  it("offers the agent's own base even when no earlier picture may be offered", async () => {
    const { chat } = await chatWithPictures();
    await writeConfig({ maxBaseCandidates: 0 });
    stubCluster();
    const { ask, seen } = person(() => ({ choice: "auto" }), chat.id);

    await run({ prompt: "add a boat", baseImage: "generated/harbour.png" }, { sessionId: `sub:${chat.id}:image_creator:1`, requestUserInput: ask });

    expect((seen.payload!["baseCandidates"] as Array<{ label: string; source: string }>).map(({ label, source }) => [label, source]))
      .toEqual([["harbour.png", "agent"]]);
    expect(seen.payload!["agent"]).toMatchObject({ baseCandidateId: "c1" });
  });

  it("says a render ran out of time, what it was, and not to try the same settings again", async () => {
    const { chat } = await chatWithPictures();
    stubCluster({ hang: true });
    const { ask } = person(() => ({ choice: "auto" }), chat.id);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = run({ prompt: "a harbour", tier: "quality", steps: 40 }, { requestUserInput: ask });
      await vi.advanceTimersByTimeAsync(2 * 210_000 + 1_000);
      const result = await pending;

      expect(result.success).toBe(false);
      expect(result.error).toContain("Qwen-Image 2.1 (the quality tier) did not finish within 7 min");
      expect(result.error).toContain("40 steps at 1024x1024 were expected to take about 6 min");
      expect(result.error).toContain("do NOT call generate_image again with the same settings");
      expect(result.dispatchUncertain).toBe(true);
      expect(result.metadata).toMatchObject({
        timedOut: true, tier: "quality", timeoutMs: 420_000, expectedSeconds: 340, steps: 40, width: 1024, height: 1024,
        settings: { source: "auto" },
      });
    } finally {
      vi.useRealTimers();
      // The engine is now marked busy with the abandoned render; the next test must not wait it out.
      (await import("../multimodal/image-generation.js")).resetImageDeviceBusyForTests();
    }
  });

  it("holds the run's clocks for a render the user answered for, and only for the render", async () => {
    const { chat } = await chatWithPictures();
    const holds = () => broker.userInputBroker.openHumanWaits().filter((wait) => wait.reason === "image_render").length;
    const during: number[] = [];
    stubCluster({ onRender: () => during.push(holds()) });

    const answered = person(() => ({ choice: "auto" }), chat.id);
    expect((await run({ prompt: "a harbour" }, { requestUserInput: answered.ask })).success).toBe(true);
    const configured = person(() => ({
      choice: "configure",
      settings: { tier: "fast", prompt: "a harbour", negativePrompt: "", width: 1024, height: 1024, steps: 12, guidanceScale: 7.5, seed: null, edit: null },
    }), chat.id);
    expect((await run({ prompt: "a harbour" }, { requestUserInput: configured.ask })).success).toBe(true);
    expect(during, "the render ran with the clocks running").toEqual([1, 1]);
    expect(holds(), "the hold outlived the render").toBe(0);

    // Nobody answered: a deadline, a standing Auto, no channel at all — the clocks run as usual.
    during.length = 0;
    for (const reason of ["timeout", "session_preference", "no_channel"] as const) {
      await run({ prompt: "a harbour" }, { requestUserInput: (async () => ({ outcome: "auto", reason, waitedMs: 0 })) as unknown as Ask });
    }
    await run({ prompt: "a harbour" }, {});
    expect(during).toEqual([0, 0, 0, 0]);
  });

  it("refuses the painted mask on any picture but the one it was painted for and the render made with it", async () => {
    const { chat } = await chatWithPictures();
    const { posts } = stubCluster();
    const sessionId = `sub:${chat.id}:image_creator:1`;
    const maskBytes = await maskPng(320, 256);
    const painted = person((payload) => ({
      choice: "configure",
      settings: {
        tier: "quality", prompt: "a stormy sky", negativePrompt: "", width: 320, height: 256, steps: 20, guidanceScale: 1, seed: null,
        edit: {
          baseCandidateId: (payload["baseCandidates"] as Array<{ id: string; label: string }>).find((c) => c.label === "harbour.png")!.id,
          strength: 0.7,
          maskDataUrl: `data:image/png;base64,${maskBytes.toString("base64")}`,
        },
      },
    }), chat.id);
    const first = await run({ prompt: "a stormy sky" }, { sessionId, requestUserInput: painted.ask });
    expect(first.success, String(first.error)).toBe(true);
    const mask = String(await memory.readSharedFact(chat.id, "latest_mask"));
    const rendered = String(first.metadata!["outputPath"]);
    expect(JSON.parse(String(await memory.readSharedFact(chat.id, "latest_mask_base")))).toEqual(["generated/harbour.png", rendered]);

    // "Now remove the boat" on another picture: refused before anyone is asked or anything renders.
    const asked = person(() => ({ choice: "auto" }), chat.id);
    const refused = await run({ prompt: "remove the boat", baseImage: "uploads/boat.png", mask, strength: 0.7 }, { sessionId, requestUserInput: asked.ask });
    expect(refused.success).toBe(false);
    expect(refused.error).toContain(`The mask ${mask} was painted for generated/harbour.png, not for uploads/boat.png`);
    expect(refused.error).toContain("call generate_image without `mask`");
    expect(asked.mock).not.toHaveBeenCalled();
    expect(posts).toHaveLength(1);

    // "Change it again" on the render it made, and the picture it was painted for: allowed.
    for (const baseImage of [rendered, "generated/harbour.png"]) {
      const again = await run({ prompt: "stormier", baseImage, mask, strength: 0.7 }, { sessionId, requestUserInput: person(() => ({ choice: "auto" }), chat.id).ask });
      expect(again.success, String(again.error)).toBe(true);
    }
    expect(posts).toHaveLength(3);
  });

  it("says when the region painted earlier was used again, on the card and to the agent", async () => {
    const { chat } = await chatWithPictures();
    stubCluster();
    const sessionId = `sub:${chat.id}:image_creator:1`;
    const maskBytes = await maskPng(320, 256);
    const painted = person((payload) => ({
      choice: "configure",
      settings: {
        tier: "quality", prompt: "a stormy sky", negativePrompt: "", width: 320, height: 256, steps: 20, guidanceScale: 1, seed: null,
        edit: {
          baseCandidateId: (payload["baseCandidates"] as Array<{ id: string; label: string }>).find((c) => c.label === "harbour.png")!.id,
          strength: 0.7,
          maskDataUrl: `data:image/png;base64,${maskBytes.toString("base64")}`,
        },
      },
    }), chat.id);
    const first = await run({ prompt: "a stormy sky" }, { sessionId, requestUserInput: painted.ask });
    const rendered = String(first.metadata!["outputPath"]);
    const mask = String(await memory.readSharedFact(chat.id, "latest_mask"));

    // "Remove the boat" on the stormy render, with the sky's mask: the tool cannot tell it from
    // "stormier". The card shows the region, and the agent hears whether anyone confirmed it.
    const auto = person(() => ({ choice: "auto" }), chat.id);
    const confirmed = await run({ prompt: "remove the boat", baseImage: rendered, mask, strength: 0.7 }, { sessionId, requestUserInput: auto.ask });
    expect(confirmed.success, String(confirmed.error)).toBe(true);
    expect(auto.seen.payload!["agentMask"]).toMatchObject({ width: 320, height: 256, paintedEarlier: true });
    expect(confirmed.output).toContain(
      " — MASK: this re-used the region the user painted earlier on generated/harbour.png; the settings card showed it and they chose Auto.",
    );

    // Each render made with the mask is the picture it fits next.
    let latest = String(confirmed.metadata!["outputPath"]);
    for (const reason of ["timeout", "session_preference"] as const) {
      const unconfirmed = await run(
        { prompt: "remove the boat", baseImage: latest, mask, strength: 0.7 },
        { sessionId, requestUserInput: (async () => ({ outcome: "auto", reason, waitedMs: 0 })) as unknown as Ask },
      );
      expect(unconfirmed.output, reason).toContain(
        " — MASK: this re-used the region the user painted earlier on generated/harbour.png, and nobody confirmed it for this request:",
      );
      latest = String(unconfirmed.metadata!["outputPath"]);
    }
    // Where no card could be shown at all, nobody confirmed it either.
    const unasked = await run({ prompt: "remove the boat", baseImage: latest, mask, strength: 0.7 }, { sessionId });
    expect(unasked.success, String(unasked.error)).toBe(true);
    expect(unasked.output).toContain(
      " — MASK: this re-used the region the user painted earlier on generated/harbour.png, and nobody confirmed it for this request:",
    );

    // A mask the agent was handed that the user never painted here is the agent's own business.
    mkdirSync(join(tempDir, "uploads"), { recursive: true });
    writeFileSync(join(tempDir, "uploads", "sky-mask.png"), maskBytes);
    const own = person(() => ({ choice: "auto" }), chat.id);
    const supplied = await run({ prompt: "stormier", baseImage: "generated/harbour.png", mask: "uploads/sky-mask.png", strength: 0.7 }, { sessionId, requestUserInput: own.ask });
    expect(supplied.output).not.toContain("MASK:");
    expect(own.seen.payload!["agentMask"]).not.toHaveProperty("paintedEarlier");
  });

  it("refuses steps and sizes past the bounds before anyone is asked or anything is sent", async () => {
    const { chat } = await chatWithPictures();
    const { fetchMock } = stubCluster();
    const asked = person(() => ({ choice: "auto" }), chat.id);

    const result = await run({ prompt: "a harbour", tier: "quality", steps: 1000, width: 2048, height: 2048 }, { requestUserInput: asked.ask });

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "steps must be a whole number from 1 to 100 (asked for 1000). Nothing was rendered: call again within those bounds,"
      + " or leave them out for the engine's defaults.",
    );
    expect(asked.mock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says when a render first waited for the engine to finish one that timed out, and shows that wait on the card", async () => {
    const { chat } = await chatWithPictures();
    stubCluster({ hangFirst: true });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const abandoned = run({ prompt: "a harbour", tier: "quality", steps: 40 }, { requestUserInput: person(() => ({ choice: "auto" }), chat.id).ask });
      await vi.advanceTimersByTimeAsync(2 * 210_000 + 1_000);
      expect((await abandoned).metadata).toMatchObject({ timedOut: true, expectedSeconds: 340 });

      const next = person(() => ({ choice: "auto" }), chat.id);
      const pending = run({ prompt: "a harbour", tier: "quality" }, { requestUserInput: next.ask });
      await vi.advanceTimersByTimeAsync(341_000);
      const result = await pending;

      const engines = next.seen.payload!["engines"] as Array<{ tier: string; busySeconds?: number }>;
      expect(engines.find((engine) => engine.tier === "quality")!.busySeconds).toBeGreaterThan(330);
      expect(engines.find((engine) => engine.tier === "fast")).not.toHaveProperty("busySeconds");
      expect(result.success, String(result.error)).toBe(true);
      expect(result.output).toMatch(/on the quality tier \(Qwen-Image 2\.1\) in [\d.]+ s, after waiting 3[34]\d s for the engine to finish an earlier render that timed out\./);
      expect(Number(result.metadata!["deviceWaitMs"])).toBeGreaterThan(330_000);
    } finally {
      vi.useRealTimers();
      (await import("../multimodal/image-generation.js")).resetImageDeviceBusyForTests();
    }
  });

  // Session fa673f2c: llama-swap cut two ~17-minute quality renders at exactly 600 s.
  it("refuses a render the image server would cut off before anyone is asked, and says what would fit", async () => {
    await writeConfig(undefined, { maxRenderMs: 600_000 });
    const { chat } = await chatWithPictures();
    const { fetchMock } = stubCluster();
    const asked = person(() => ({ choice: "auto" }), chat.id);

    const result = await run({ prompt: "the amazon, photograph", tier: "quality", steps: 60, guidanceScale: 2.5 }, { requestUserInput: asked.ask });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Qwen-Image 2.1 (the quality tier) would need about 17 min for 60 steps at 1024x1024 with guidance 2.5");
    expect(result.error).toContain("At guidance 1, the engine's default, the same steps and size take about 9 min");
    expect(asked.mock, "an impossible render was put to the person").not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST"), "the render went out").toBe(false);
  });

  it("gives the form the server's limit, and refuses settings past it against the steps with what fits", async () => {
    await writeConfig(undefined, { maxRenderMs: 600_000 });
    const { chat } = await chatWithPictures();
    const { posts } = stubCluster();
    const { ask, seen } = person(() => ({
      choice: "configure",
      settings: { tier: "quality", prompt: "the amazon", negativePrompt: "", width: 1344, height: 768, steps: 80, guidanceScale: 1, seed: null, edit: null },
    }), chat.id);

    const result = await run({ prompt: "the amazon", tier: "quality" }, { requestUserInput: ask });

    expect(seen.payload!["renderLimit"]).toEqual({ allowedSeconds: 540, serverSeconds: 600 });
    expect(seen.errors).toEqual([{
      field: "settings.steps",
      message: "about 11 min, and the image server stops any render after 10 min. At 1344x768, at most 64 steps fit.",
    }]);
    // The refused settings did not render; the stand-in lets the card run out, so the agent's did.
    expect(result.success, String(result.error)).toBe(true);
    expect(posts[0]!.fields).toMatchObject({ steps: "20", size: "1024x1024" });
  });

  it("gives the form no limit where the server has none", async () => {
    const { chat } = await chatWithPictures();
    stubCluster();
    const { ask, seen } = person(() => ({ choice: "auto" }), chat.id);
    await run({ prompt: "the amazon", tier: "quality" }, { requestUserInput: ask });
    expect(seen.payload).not.toHaveProperty("renderLimit");
  });

  // Session fa673f2c: after "skip", the agent sent the same picture again within seconds, twice.
  it("does not put a picture the person skipped to them again in the same turn — another picture, or the next turn, it does", async () => {
    const { chat } = await chatWithPictures();
    const { fetchMock } = stubCluster();
    const words = { opening: "", midTurn: [] as string[] };
    const { ask, mock } = person(() => ({ choice: "skip" }), chat.id);

    await run({ prompt: "The Amazon rainforest, photograph", tier: "fast" }, { requestUserInput: ask, turnUserWords: words });
    const again = await run({ prompt: "the amazon  rainforest, photograph", tier: "quality", steps: 30 }, { requestUserInput: ask, turnUserWords: words });

    expect(mock, "the skipped picture was put to the person again").toHaveBeenCalledTimes(1);
    expect(again.success).toBe(false);
    expect(again.error).toContain("The user already skipped this picture in the settings step this turn");
    expect(again.error).toContain("Do not call generate_image for it again");
    expect(isDeclinedByUser(again.metadata)).toBe(true);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);

    await run({ prompt: "a toucan on a branch, photograph" }, { requestUserInput: ask, turnUserWords: words });
    expect(mock, "a different picture is the person's to decide").toHaveBeenCalledTimes(2);
    await run({ prompt: "The Amazon rainforest, photograph" }, { requestUserInput: ask, turnUserWords: { opening: "", midTurn: [] } });
    expect(mock, "the next turn may ask for it again").toHaveBeenCalledTimes(3);
  });
});
