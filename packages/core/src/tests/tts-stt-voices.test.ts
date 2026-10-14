import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  HubVoiceError,
  cancelTraining,
  cloneHubVoice,
  deleteHubVoice,
  designHubVoice,
  listTrainingJobs,
  modelToRestore,
  savedVoiceIdFor,
  startTraining,
} from "../multimodal/tts-stt-voices.js";

/**
 * A TTS-STT GATEWAY'S VOICE LIBRARY (2026-10-15), against a fake of the user's speech service.
 *
 * The service runs one qwen3 model at a time and keeps whichever was chosen last: designing a voice
 * needs the VoiceDesign model, and left loaded it broke every saved voice (the cloned voice the chat
 * speaks German with). It also overwrites a saved voice of the same name without a word.
 */

type Seen = { method: string; path: string; json?: Record<string, unknown>; form?: Record<string, string[]> };
const seen: Seen[] = [];
let server: Server;
let baseUrl = "";

const BASE = "Qwen/Qwen3-TTS-12Hz-0.6B-Base";
const BIG_BASE = "Qwen/Qwen3-TTS-12Hz-1.7B-Base";
const DESIGN = "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign";

const state = {
  current: BASE as string | null,
  saved: [{ id: "luna", name: "Luna", model_used: BIG_BASE }] as Array<Record<string, unknown>>,
  trainingEnabled: true,
  designFails: false,
};

async function readRequest(req: IncomingMessage): Promise<Seen> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);
  const type = String(req.headers["content-type"] ?? "");
  const entry: Seen = { method: req.method ?? "GET", path: req.url ?? "" };
  if (type.includes("application/json") && body.length) entry.json = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
  if (type.includes("multipart/form-data")) {
    const form = await new Response(body, { headers: { "content-type": type } }).formData();
    entry.form = {};
    form.forEach((value, key) => {
      (entry.form![key] ??= []).push(typeof value === "string" ? value : `file:${(value as File).name}`);
    });
  }
  return entry;
}

const json = (res: ServerResponse, body: unknown, status = 200) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const entry = await readRequest(req);
    seen.push(entry);
    const { method, path } = entry;
    if (method === "GET" && path === "/api/providers/qwen3/saved-voices") return json(res, { provider: "qwen3", voices: state.saved });
    if (method === "POST" && path === "/api/providers/qwen3/saved-voices") {
      const name = entry.form?.["name"]?.[0] ?? "";
      return json(res, { status: "ok", voice_id: name.toLowerCase().replace(/[^a-z0-9_-]+/g, "_"), name, ref_text: "erkannt", mode: entry.form?.["mode"]?.[0] });
    }
    if (method === "DELETE" && path.startsWith("/api/providers/")) return json(res, { status: "ok" });
    if (method === "GET" && path === "/api/providers/qwen3/models") {
      return json(res, {
        provider: "qwen3",
        current_model: state.current,
        models: [
          { id: BASE, capabilities: ["voice_clone"] },
          { id: BIG_BASE, capabilities: ["voice_clone"] },
          { id: "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice", capabilities: ["custom_voice"] },
          { id: DESIGN, capabilities: ["voice_design"] },
        ],
      });
    }
    if (method === "POST" && path === "/api/providers/qwen3/models/select") {
      state.current = String(entry.json?.["model"]);
      return json(res, { provider: "qwen3", model: { id: state.current } });
    }
    if (method === "POST" && path === "/api/providers/qwen3/voice-design") {
      if (state.designFails || state.current !== DESIGN) return json(res, { detail: "Please switch to the VoiceDesign model." }, 400);
      res.writeHead(200, { "Content-Type": "audio/wav" });
      res.end(Buffer.from("RIFFdesign"));
      return;
    }
    if (path.startsWith("/api/training/") && !state.trainingEnabled) return json(res, { detail: "Not Found" }, 404);
    if (method === "GET" && path === "/api/training/jobs") {
      return json(res, [{ job_id: "j1", status: "training", progress: 42, model_name: "steffen", current_epoch: 420, total_epochs: 1000 }]);
    }
    if (method === "POST" && path === "/api/training/train") return json(res, { message: "started", job_id: "j2" });
    if (method === "DELETE" && path === "/api/training/job/j1") return json(res, { message: "cancelling" });
    json(res, { detail: "not found" }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

beforeEach(() => {
  seen.length = 0;
  state.current = BASE;
  state.trainingEnabled = true;
  state.designFails = false;
});

const hub = () => ({ baseUrl, timeoutMs: 5_000 });
const selects = () => seen.filter((entry) => entry.path === "/api/providers/qwen3/models/select").map((entry) => entry.json?.["model"]);

describe("cloning a voice", () => {
  it("derives the id the service will give the voice", () => {
    expect(savedVoiceIdFor(" My Voice! ")).toBe("my_voice");
    expect(savedVoiceIdFor("Luna")).toBe("luna");
    expect(savedVoiceIdFor("!!!")).toBe("");
  });

  it("saves it with its language, mode and transcript, and names it as the chat refers to it", async () => {
    const result = await cloneHubVoice(hub(), {
      name: "Steffen", audio: new Blob(["RIFF"]), filename: "sample.wav", language: "de-DE", referenceText: "Hallo Welt", mode: "icl",
    });
    expect(result).toEqual({ voice: "saved:steffen", name: "Steffen", referenceText: "erkannt" });
    expect(seen.at(-1)?.form).toEqual({ name: ["Steffen"], file: ["file:sample.wav"], lang: ["de"], mode: ["icl"], ref_text: ["Hallo Welt"] });
  });

  // The service overwrites a saved voice of the same name silently.
  it("refuses to save over an existing voice unless asked to replace it", async () => {
    await expect(cloneHubVoice(hub(), { name: "LUNA", audio: new Blob(["RIFF"]), filename: "a.wav" }))
      .rejects.toMatchObject({ status: 409 });
    expect(seen.some((entry) => entry.method === "POST")).toBe(false);
    await expect(cloneHubVoice(hub(), { name: "LUNA", audio: new Blob(["RIFF"]), filename: "a.wav", replace: true }))
      .resolves.toMatchObject({ voice: "saved:luna" });
  });
});

describe("deleting a voice", () => {
  it("deletes a saved voice or one trained for piper, and never a built-in one", async () => {
    await deleteHubVoice(hub(), "saved:luna");
    await deleteHubVoice(hub(), "piper:steffen");
    expect(seen.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
      "DELETE /api/providers/qwen3/saved-voices/luna",
      "DELETE /api/providers/piper/custom-voices/steffen",
    ]);
    await expect(deleteHubVoice(hub(), "magpie:Sofia")).rejects.toBeInstanceOf(HubVoiceError);
  });
});

describe("designing a voice", () => {
  it("loads the design model for the design only, and loads the one before back", async () => {
    const audio = await designHubVoice(hub(), { description: "warm, calm", text: "Hallo", language: "de" });
    expect(await audio.text()).toBe("RIFFdesign");
    expect(selects()).toEqual([DESIGN, BASE]);
    expect(state.current).toBe(BASE);
    expect(seen.find((entry) => entry.path.endsWith("/voice-design"))?.json).toEqual({ text: "Hallo", voice_description: "warm, calm", lang: "de" });
  });

  it("loads the model back even when the design fails", async () => {
    state.designFails = true;
    await expect(designHubVoice(hub(), { description: "x", text: "y" })).rejects.toMatchObject({ status: 400 });
    expect(state.current).toBe(BASE);
  });

  it("with no model loaded (idle), loads back the one the saved voices were made with", async () => {
    state.current = null;
    await designHubVoice(hub(), { description: "x", text: "y" });
    expect(selects()).toEqual([DESIGN, BIG_BASE]);
  });

  it("found left on the design model, it designs and still leaves a voice model loaded", async () => {
    state.current = DESIGN;
    await designHubVoice(hub(), { description: "x", text: "y" });
    expect(selects()).toEqual([BIG_BASE]);
  });

  it("runs designs one at a time, so they do not switch the shared model under each other", async () => {
    await Promise.all([designHubVoice(hub(), { description: "a", text: "a" }), designHubVoice(hub(), { description: "b", text: "b" })]);
    expect(selects()).toEqual([DESIGN, BASE, DESIGN, BASE]);
  });

  it("restores the model before, or the saved voices' model, or the first Base", () => {
    const models = [{ id: BASE, capabilities: ["voice_clone"] }, { id: DESIGN, capabilities: ["voice_design"] }];
    expect(modelToRestore("Custom", models, [])).toBe("Custom");
    expect(modelToRestore(undefined, models, [{ modelUsed: "gone" }])).toBe(BASE);
    expect(modelToRestore(DESIGN, models, [])).toBe(BASE);
  });
});

describe("training (experimental)", () => {
  it("lists jobs with their progress", async () => {
    expect(await listTrainingJobs(hub())).toEqual({
      enabled: true,
      jobs: [{ id: "j1", status: "training", progress: 42, modelName: "steffen", currentEpoch: 420, totalEpochs: 1000 }],
    });
  });

  it("says when the service has training switched off", async () => {
    state.trainingEnabled = false;
    expect(await listTrainingJobs(hub())).toEqual({ enabled: false, jobs: [] });
    await expect(startTraining(hub(), { name: "x", files: [{ audio: new Blob(["a"]), filename: "a.wav" }] }))
      .rejects.toThrow(/switched off/);
  });

  it("starts a job from recordings and cancels one", async () => {
    const started = await startTraining(hub(), {
      name: "steffen", language: "en", files: [{ audio: new Blob(["a"]), filename: "a.wav" }, { audio: new Blob(["b"]), filename: "b.wav" }],
    });
    expect(started).toEqual({ jobId: "j2" });
    expect(seen.at(-1)?.form).toEqual({ model_name: ["steffen"], language: ["en"], sample_rate: ["22050"], audio_files: ["file:a.wav", "file:b.wav"] });
    await cancelTraining(hub(), "j1");
    expect(seen.at(-1)).toMatchObject({ method: "DELETE", path: "/api/training/job/j1" });
    await expect(startTraining(hub(), { name: "bad name", files: [] })).rejects.toMatchObject({ status: 400 });
  });
});
