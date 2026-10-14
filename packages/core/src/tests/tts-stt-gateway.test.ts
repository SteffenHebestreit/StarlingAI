import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  fetchHubVoiceCatalog,
  formatHubVoice,
  hubLanguage,
  hubVoiceFor,
  parseHubVoice,
  requestHubSpeech,
} from "../multimodal/tts-stt-gateway.js";

/**
 * A TTS-STT GATEWAY'S VOICES (2026-10-14).
 *
 * The user's speech service runs several engines behind one host. Its OpenAI route always speaks with
 * the default engine, and a cloned voice ("Luna") is spoken only at its saved-voice route, with the
 * language as `lang` — a `language` field there is ignored, and the voice speaks German.
 */

type Seen = { path: string; json?: Record<string, unknown>; form?: Record<string, string> };
const seen: Seen[] = [];
let server: Server;
let baseUrl = "";

async function readRequest(req: IncomingMessage): Promise<Seen> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);
  const type = String(req.headers["content-type"] ?? "");
  const entry: Seen = { path: req.url ?? "" };
  if (type.includes("application/json")) entry.json = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
  if (type.includes("multipart/form-data")) {
    const form = await new Response(body, { headers: { "content-type": type } }).formData();
    entry.form = {};
    form.forEach((value, key) => { if (typeof value === "string") entry.form![key] = value; });
  }
  return entry;
}

const json = (res: ServerResponse, body: unknown) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const entry = await readRequest(req);
    seen.push(entry);
    if (req.method === "POST" && (entry.path === "/api/tts" || entry.path.startsWith("/api/providers/qwen3/saved-voices/"))) {
      res.writeHead(200, { "Content-Type": "audio/wav" });
      res.end(Buffer.from("RIFF"));
      return;
    }
    if (entry.path === "/providers") {
      return json(res, { providers: { piper: { kind: "tts" }, qwen3: { kind: "tts" }, whisper: { kind: "stt" } } });
    }
    if (entry.path === "/api/providers/piper/voices") {
      return json(res, { voices: [{ id: "de_DE-thorsten-medium", name: "de_DE-thorsten-medium", language: "de_DE", kind: "default" }] });
    }
    if (entry.path === "/api/providers/qwen3/saved-voices") {
      return json(res, { provider: "qwen3", voices: [{ id: "luna", name: "Luna", language: "German" }] });
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ detail: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

beforeEach(() => { seen.length = 0; });

describe("voice references", () => {
  it("name an engine's voice, or a saved voice, and nothing without an engine", () => {
    expect(parseHubVoice("piper:de_DE-thorsten-medium")).toEqual({ kind: "engine", engine: "piper", voice: "de_DE-thorsten-medium" });
    expect(parseHubVoice("saved:luna")).toEqual({ kind: "saved", id: "luna" });
    expect(parseHubVoice("magpie:")).toEqual({ kind: "engine", engine: "magpie" });
    expect(parseHubVoice("Vivian")).toBeUndefined();
    expect(parseHubVoice("saved:")).toBeUndefined();
    expect(formatHubVoice({ kind: "saved", id: "luna" })).toBe("saved:luna");
  });

  it("carry the language as a two-letter code, or auto", () => {
    expect(["de-DE", "German", "de", "DE_de", "en-US", "", undefined, "auto", "Klingonisch"].map(hubLanguage))
      .toEqual(["de", "de", "de", "de", "en", "auto", "auto", "auto", "auto"]);
  });

  it("pick the voice the request names, else the language's, else the one for any language", () => {
    const voices = { de: "saved:luna", "*": "piper:en_US-lessac-medium" };
    expect(hubVoiceFor(voices, "de-DE")).toEqual({ kind: "saved", id: "luna" });
    expect(hubVoiceFor(voices, "en")).toEqual({ kind: "engine", engine: "piper", voice: "en_US-lessac-medium" });
    expect(hubVoiceFor(voices, "de", "magpie:Sofia")).toEqual({ kind: "engine", engine: "magpie", voice: "Sofia" });
    expect(hubVoiceFor({}, "de")).toBeUndefined();
  });
});

describe("requestHubSpeech", () => {
  const connection = () => ({ baseUrl, timeoutMs: 5_000 });

  it("speaks a saved voice at its saved-voice route, with the language as `lang`", async () => {
    const response = await requestHubSpeech({ ...connection(), text: "Einen Moment.", language: "de-DE", voice: { kind: "saved", id: "luna" } });
    expect(response.status).toBe(200);
    expect(seen[0]).toEqual({ path: "/api/providers/qwen3/saved-voices/luna/tts", form: { text: "Einen Moment.", lang: "de" } });
  });

  it("speaks an engine's voice at /api/tts, as WAV, in the request's language", async () => {
    await requestHubSpeech({ ...connection(), text: "One moment.", language: "en", voice: { kind: "engine", engine: "piper", voice: "en_US-lessac-medium" }, speed: 1.1 });
    expect(seen[0]).toEqual({
      path: "/api/tts",
      json: { provider: "piper", text: "One moment.", language: "en", output_format: "wav", voice: "en_US-lessac-medium", speed: 1.1 },
    });
  });

  it("speaks with piper when no voice is configured", async () => {
    await requestHubSpeech({ ...connection(), text: "Hallo.", language: undefined });
    expect(seen[0]?.json).toEqual({ provider: "piper", text: "Hallo.", language: "auto", output_format: "wav" });
  });
});

describe("fetchHubVoiceCatalog", () => {
  it("lists every TTS engine's voices and the saved voices, as references to configure", async () => {
    const catalog = await fetchHubVoiceCatalog({ baseUrl, timeoutMs: 5_000 });
    expect(catalog.engines).toEqual(["piper", "qwen3"]);
    expect(catalog.voices).toEqual([
      { id: "piper:de_DE-thorsten-medium", name: "de_DE-thorsten-medium", engine: "piper", kind: "builtin", language: "de_DE" },
      { id: "saved:luna", name: "Luna", engine: "qwen3", kind: "saved", language: "German" },
    ]);
  });
});
