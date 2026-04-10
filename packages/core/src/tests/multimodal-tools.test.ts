import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_TTS_CHUNK_MAX_CHARS } from "../multimodal/tts-chunking.js";

function createPcmWav(sampleCount: number, seed = 0): Uint8Array {
  const dataSize = sampleCount * 2;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    wav.writeInt16LE(seed + index, 44 + (index * 2));
  }
  return new Uint8Array(wav);
}

function readPcmWavDataSize(wav: Buffer): number {
  return wav.readUInt32LE(40);
}

const mcpConnections = new Map<string, { client: { callTool: ReturnType<typeof vi.fn> } }>();

vi.mock("../mcp/registry.js", () => ({
  getMcpConnections: () => mcpConnections,
}));

const BASE_CONFIG = {
  workspacePath: "",
  providers: {
    lmstudio: {
      baseUrl: "http://vision.local/v1",
      apiKey: "test-key",
    },
  },
  multimodal: {
    files: {
      baseUrl: "http://files.local",
      timeoutMs: 5_000,
      toolName: "file_to_markdown",
      visionModel: "lmstudio/qwen2-vl",
    },
    stt: {
      baseUrl: "http://stt.local",
      timeoutMs: 5_000,
      model: "Qwen/Qwen3-ASR-1.7B",
    },
    tts: {
      baseUrl: "http://tts.local",
      api: "qwen-compatible",
      timeoutMs: 5_000,
      model: "Qwen/Qwen3-TTS-12Hz-0.6B-Instruct",
      defaultLanguage: "English",
      defaultSpeaker: "Vivian",
      defaultQuality: "medium",
    },
  },
};

describe("multimodal and browser direct tools", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-multimodal-tools-"));
  let baseConfigPath: string;

  beforeAll(async () => {
    baseConfigPath = join(tempDir, "starlingai.json");
    writeFileSync(baseConfigPath, JSON.stringify({ ...BASE_CONFIG, workspacePath: tempDir }), "utf8");

    process.env["SAI_CONFIG_PATH"] = baseConfigPath;
    vi.resetModules();
    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
    await import("../tools/multimodal.js");
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    mcpConnections.clear();
    process.env["SAI_CONFIG_PATH"] = baseConfigPath;
    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
  });

  afterAll(() => {
    delete process.env["SAI_CONFIG_PATH"];
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── extract_file_content ───────────────────────────────────────────────────

  it("converts a workspace file through the REST extract_file_content tool", async () => {
    const filePath = join(tempDir, "report.txt");
    writeFileSync(filePath, "hello world", "utf8");

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      markdown: "# Converted\n\nhello world",
      filename: "report.txt",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("extract_file_content");
    expect(tool).toBeDefined();

    const result = await tool!.execute({ path: "report.txt" }, {
      sessionId: "session-1",
      workspacePath: tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("# Converted");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0] as unknown[] | undefined;
    expect(String(firstCall?.[0])).toBe("http://files.local/api/tools/file_to_markdown");
  });

  it("routes extract_file_content through an MCP server when configured", async () => {
    const filePath = join(tempDir, "doc.txt");
    writeFileSync(filePath, "document content", "utf8");

    const callTool = vi.fn(async () => ({
      content: [{ type: "text", text: '{"markdown": "# MCP Content", "filename": "doc.txt"}' }],
      isError: false,
    }));
    mcpConnections.set("file_converter", { client: { callTool } });

    // Spy on getConfig to inject mcpServer without touching the config file
    const loaderModule = await import("../config/loader.js");
    const realConfig = loaderModule.getConfig();
    const spy = vi.spyOn(loaderModule, "getConfig").mockReturnValue({
      ...realConfig,
      multimodal: {
        ...realConfig.multimodal,
        files: { ...realConfig.multimodal.files, mcpServer: "file_converter" },
      },
    } as typeof realConfig);

    try {
      const { getTool } = await import("../tools/registry.js");
      const tool = getTool("extract_file_content");

      const result = await tool!.execute({ path: "doc.txt" }, {
        sessionId: "session-mcp",
        workspacePath: tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain("# MCP Content");
      expect(callTool).toHaveBeenCalledWith({
        name: "file_to_markdown",
        arguments: expect.objectContaining({ filename: "doc.txt" }),
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("returns failure when extract_file_content receives an empty markdown response", async () => {
    writeFileSync(join(tempDir, "empty.txt"), "content", "utf8");

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      markdown: "",
      filename: "empty.txt",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));

    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("extract_file_content");

    const result = await tool!.execute({ path: "empty.txt" }, {
      sessionId: "session-3",
      workspacePath: tempDir,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No markdown content/);
  });

  it("rejects a path that escapes the workspace in extract_file_content", async () => {
    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("extract_file_content");

    const result = await tool!.execute({ path: "../../etc/passwd" }, {
      sessionId: "session-escape",
      workspacePath: tempDir,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/escapes workspace/);
  });

  // ── transcribe_audio ───────────────────────────────────────────────────────

  it("transcribes an audio file via the OpenAI-compatible STT endpoint", async () => {
    writeFileSync(join(tempDir, "speech.wav"), Buffer.from([0x52, 0x49, 0x46, 0x46]));

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      text: "Hello from the transcript.",
      language: "en",
      duration: 3.5,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));

    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("transcribe_audio");
    expect(tool).toBeDefined();

    const result = await tool!.execute({ path: "speech.wav" }, {
      sessionId: "session-stt",
      workspacePath: tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe("Hello from the transcript.");
    expect(result.metadata).toMatchObject({ path: "speech.wav", language: "en" });
  });

  it("assembles transcript from a segments array", async () => {
    writeFileSync(join(tempDir, "segments.mp3"), Buffer.from([0xff, 0xfb]));

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      segments: [{ text: "First part." }, { text: "Second part." }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));

    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("transcribe_audio");

    const result = await tool!.execute({ path: "segments.mp3" }, {
      sessionId: "session-stt-seg",
      workspacePath: tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe("First part. Second part.");
  });

  it("falls back to /transcribe when the OpenAI STT endpoint returns 404", async () => {
    writeFileSync(join(tempDir, "fallback.wav"), Buffer.from([0x52, 0x49, 0x46, 0x46]));

    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      callCount++;
      if (url.includes("/v1/audio/transcriptions")) {
        return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain" } });
      }
      return new Response(JSON.stringify({ text: "Fallback transcript." }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));

    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("transcribe_audio");

    const result = await tool!.execute({ path: "fallback.wav" }, {
      sessionId: "session-stt-fallback",
      workspacePath: tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe("Fallback transcript.");
    expect(callCount).toBe(2);
  });

  it("can target transcribe-only STT backends without probing OpenAI routes", async () => {
    writeFileSync(join(tempDir, "transcribe-only.wav"), Buffer.from([0x52, 0x49, 0x46, 0x46]));

    const loaderModule = await import("../config/loader.js");
    const realConfig = loaderModule.getConfig();
    const spy = vi.spyOn(loaderModule, "getConfig").mockReturnValue({
      ...realConfig,
      multimodal: {
        ...realConfig.multimodal,
        stt: { ...realConfig.multimodal.stt, api: "transcribe-only" },
      },
    } as typeof realConfig);

    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify({ text: `only:${url}` }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const { getTool } = await import("../tools/registry.js");
      const tool = getTool("transcribe_audio");

      const result = await tool!.execute({ path: "transcribe-only.wav" }, {
        sessionId: "session-stt-transcribe-only",
        workspacePath: tempDir,
      });

      expect(result.success).toBe(true);
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://stt.local/transcribe");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("normalizes locale-style STT language codes for transcribe-only backends and retries without language on failure", async () => {
    writeFileSync(join(tempDir, "transcribe-only-locale.wav"), Buffer.from([0x52, 0x49, 0x46, 0x46]));

    const loaderModule = await import("../config/loader.js");
    const realConfig = loaderModule.getConfig();
    const spy = vi.spyOn(loaderModule, "getConfig").mockReturnValue({
      ...realConfig,
      multimodal: {
        ...realConfig.multimodal,
        stt: { ...realConfig.multimodal.stt, api: "transcribe-only" },
      },
    } as typeof realConfig);

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const form = init?.body as FormData;
      const language = form.get("language");
      if (language === "de") {
        return new Response(JSON.stringify({ error: "unsupported locale variant" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ text: "retried transcript" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const { getTool } = await import("../tools/registry.js");
      const tool = getTool("transcribe_audio");

      const result = await tool!.execute({ path: "transcribe-only-locale.wav", language: "de-DE" }, {
        sessionId: "session-stt-transcribe-only-locale",
        workspacePath: tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.output).toBe("retried transcript");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const firstForm = fetchMock.mock.calls[0]?.[1]?.body as FormData;
      const secondForm = fetchMock.mock.calls[1]?.[1]?.body as FormData;
      expect(firstForm.get("language")).toBe("de");
      expect(secondForm.get("language")).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("returns failure when the STT service responds with a non-200 error", async () => {
    writeFileSync(join(tempDir, "bad.wav"), Buffer.from([0x52, 0x49, 0x46, 0x46]));

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: "Model not found",
    }), {
      status: 422,
      headers: { "Content-Type": "application/json" },
    })));

    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("transcribe_audio");

    const result = await tool!.execute({ path: "bad.wav" }, {
      sessionId: "session-stt-err",
      workspacePath: tempDir,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Model not found/);
  });

  // ── list_tts_voices ────────────────────────────────────────────────────────

  it("lists TTS voices from the configured backend", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/voices")) {
        return new Response(JSON.stringify({
          voices: [
            { id: "saved-amy", name: "Amy", lang: "English" },
            { id: "saved-joe", name: "Joe", lang: "German" },
          ],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/speakers")) {
        return new Response(JSON.stringify({ speakers: ["Vivian", "Ryan"] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        models: { "Qwen/Qwen3-TTS-12Hz-0.6B-Instruct": { capabilities: ["tts", "voice_clone"] } },
        current_model: "Qwen/Qwen3-TTS-12Hz-0.6B-Instruct",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));

    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("list_tts_voices");
    expect(tool).toBeDefined();

    const result = await tool!.execute({}, {
      sessionId: "session-voices",
      workspacePath: tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Amy");
    expect(result.output).toContain("Joe");
    expect(result.metadata).toMatchObject({ voiceCount: 2 });
  });

  it("surfaces the upstream error when list_tts_voices receives a non-200 response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      detail: "TTS service unavailable",
    }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    })));

    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("list_tts_voices");

    const result = await tool!.execute({}, {
      sessionId: "session-voices-err",
      workspacePath: tempDir,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/TTS service unavailable/);
  });

  // ── synthesize_speech ──────────────────────────────────────────────────────

  it("synthesizes speech and writes the audio file to the workspace", async () => {
    const fakeWav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x10]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(fakeWav, {
      status: 200,
      headers: { "Content-Type": "audio/wav" },
    })));

    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("synthesize_speech");
    expect(tool).toBeDefined();

    const result = await tool!.execute({ text: "Hello world", outputPath: "hello.wav" }, {
      sessionId: "session-tts",
      workspacePath: tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("hello.wav");
    expect(result.metadata).toMatchObject({ outputPath: "hello.wav", bytes: fakeWav.byteLength });
    expect(existsSync(join(tempDir, "hello.wav"))).toBe(true);
  });

  it("splits long OpenAI-compatible TTS requests and merges the WAV output before writing it", async () => {
    const loaderModule = await import("../config/loader.js");
    const realConfig = loaderModule.getConfig();
    const spy = vi.spyOn(loaderModule, "getConfig").mockReturnValue({
      ...realConfig,
      multimodal: {
        ...realConfig.multimodal,
        tts: {
          ...realConfig.multimodal.tts,
          api: "openai-compatible",
          model: "openai-compatible/tts-1",
          defaultSpeaker: "alloy",
        },
      },
    } as typeof realConfig);

    const upstreamInputs: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://tts.local/v1/audio/speech");
      const body = JSON.parse(String(init?.body)) as { input: string; voice: string };
      upstreamInputs.push(body.input);
      expect(body.voice).toBe("alloy");
      expect(body.input.length).toBeLessThanOrEqual(DEFAULT_TTS_CHUNK_MAX_CHARS);
      return new Response(createPcmWav(upstreamInputs.length + 1, upstreamInputs.length * 50), {
        status: 200,
        headers: { "Content-Type": "audio/wav" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const longText = Array.from(
      { length: 12 },
      (_, index) => `Sentence ${index + 1} keeps the reply natural while ensuring the text to speech backend receives smaller requests.`,
    ).join(" ");

    try {
      const { getTool } = await import("../tools/registry.js");
      const tool = getTool("synthesize_speech");

      const result = await tool!.execute({ text: longText, outputPath: "chunked-openai.wav" }, {
        sessionId: "session-tts-openai-chunked",
        workspacePath: tempDir,
      });

      expect(result.success).toBe(true);
      expect(upstreamInputs.length).toBeGreaterThan(1);
      expect(fetchMock).toHaveBeenCalledTimes(upstreamInputs.length);

      const wav = readFileSync(join(tempDir, "chunked-openai.wav"));
      expect(wav.subarray(0, 4).toString()).toBe("RIFF");
      expect(readPcmWavDataSize(wav)).toBe(upstreamInputs.reduce((sum, _text, index) => sum + ((index + 2) * 2), 0));
      expect(result.metadata).toMatchObject({ outputPath: "chunked-openai.wav", bytes: wav.byteLength });
    } finally {
      spy.mockRestore();
    }
  });

  it("writes TTS output to a generated path when outputPath is omitted", async () => {
    const fakeWav = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(fakeWav, {
      status: 200,
      headers: { "Content-Type": "audio/wav" },
    })));

    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("synthesize_speech");

    const result = await tool!.execute({ text: "Auto path" }, {
      sessionId: "session-tts-auto",
      workspacePath: tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain(".starlingai/generated/tts-");
    expect(result.output).toContain(".wav");
  });

  it("sends voice and language overrides in the TTS request body", async () => {
    const fakeWav = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/load_model")) {
        return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      const body = JSON.parse(String(init?.body));
      expect(body.lang).toBe("German");
      expect(body.speaker).toBe("de_DE-thorsten-medium");
      expect(body.text).toBe("Guten Tag");
      return new Response(fakeWav, {
        status: 200,
        headers: { "Content-Type": "audio/wav" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("synthesize_speech");

    await tool!.execute(
      { text: "Guten Tag", speaker: "de_DE-thorsten-medium", language: "de", outputPath: "de.wav" },
      { sessionId: "session-tts-de", workspacePath: tempDir },
    );

    const ttsCall = fetchMock.mock.calls[1] as unknown[] | undefined;
    const initArg = ttsCall?.[1] as RequestInit;
    const body = JSON.parse(String(initArg.body));
    expect(body.speaker).toBe("de_DE-thorsten-medium");
    expect(body.lang).toBe("German");
    expect(body.text).toBe("Guten Tag");
  });

  it("posts to the correct TTS URL", async () => {
    const fakeWav = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/load_model")) {
        return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(fakeWav, {
        status: 200,
        headers: { "Content-Type": "audio/wav" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("synthesize_speech");

    await tool!.execute({ text: "Test", outputPath: "out.wav" }, {
      sessionId: "session-tts-url",
      workspacePath: tempDir,
    });

    const ttsUrlCall = fetchMock.mock.calls[1] as unknown[] | undefined;
    const url = String(ttsUrlCall?.[0]);
    expect(url).toBe("http://tts.local/tts");
  });

  it("can use OpenAI-compatible TTS backends while keeping Qwen as a special case", async () => {
    const fakeWav = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
    const loaderModule = await import("../config/loader.js");
    const realConfig = loaderModule.getConfig();
    const spy = vi.spyOn(loaderModule, "getConfig").mockReturnValue({
      ...realConfig,
      multimodal: {
        ...realConfig.multimodal,
        tts: {
          ...realConfig.multimodal.tts,
          api: "openai-compatible",
          model: "openai-compatible/tts-1",
          defaultSpeaker: "alloy",
        },
      },
    } as typeof realConfig);

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://tts.local/v1/audio/speech");
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("openai-compatible/tts-1");
      expect(body.input).toBe("Hello open audio");
      expect(body.voice).toBe("alloy");
      return new Response(fakeWav, {
        status: 200,
        headers: { "Content-Type": "audio/wav" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const { getTool } = await import("../tools/registry.js");
      const tool = getTool("synthesize_speech");

      const result = await tool!.execute({ text: "Hello open audio", outputPath: "openai.wav" }, {
        sessionId: "session-tts-openai",
        workspacePath: tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain("openai.wav");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("returns failure when the TTS service responds with a non-200 error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: "Voice not found",
    }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    })));

    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("synthesize_speech");

    const result = await tool!.execute({ text: "Test" }, {
      sessionId: "session-tts-err",
      workspacePath: tempDir,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Voice not found/);
  });

  it("falls back to plain qwen TTS when only a configured default voice sample is present but the model lacks voice_clone", async () => {
    const loaderModule = await import("../config/loader.js");
    const realConfig = loaderModule.getConfig();
    writeFileSync(join(tempDir, "voice-sample.wav"), Buffer.from([0x52, 0x49, 0x46, 0x46]));

    const spy = vi.spyOn(loaderModule, "getConfig").mockReturnValue({
      ...realConfig,
      multimodal: {
        ...realConfig.multimodal,
        tts: {
          ...realConfig.multimodal.tts,
          api: "qwen-compatible",
          baseUrl: "http://tts.local",
          model: "Qwen/Qwen3-TTS-12Hz-1.7B",
          defaultSpeaker: "Vivian",
          voiceSamplePath: "voice-sample.wav",
          voiceSampleText: "sample voice",
        },
      },
    } as typeof realConfig);

    const fakeWav = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({
          models: { "Qwen/Qwen3-TTS-12Hz-1.7B": { capabilities: ["tts"] } },
          current_model: "Qwen/Qwen3-TTS-12Hz-1.7B",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/load_model")) {
        return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/tts")) {
        return new Response(fakeWav, {
          status: 200,
          headers: { "Content-Type": "audio/wav" },
        });
      }
      throw new Error(`Unexpected TTS URL ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const { getTool } = await import("../tools/registry.js");
      const tool = getTool("synthesize_speech");

      const result = await tool!.execute({ text: "Hello fallback", outputPath: "fallback.wav" }, {
        sessionId: "session-tts-fallback",
        workspacePath: tempDir,
      });

      expect(result.success).toBe(true);
      expect(fetchMock.mock.calls.some((call) => String(call[0]).endsWith("/clone") || String(call[0]).endsWith("/clone-with-ref-text"))).toBe(false);
      expect(fetchMock.mock.calls.some((call) => String(call[0]).endsWith("/tts"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  // ── analyze_image ──────────────────────────────────────────────────────────

  it("analyzes a PNG image via the configured vision model", async () => {
    // minimal PNG header bytes
    const pngBytes = Buffer.from("89504e470d0a1a0a", "hex");
    writeFileSync(join(tempDir, "screenshot.png"), pngBytes);

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{
        message: { role: "assistant", content: "The image shows a Submit button." },
      }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));

    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("analyze_image");
    expect(tool).toBeDefined();

    const result = await tool!.execute({ path: "screenshot.png" }, {
      sessionId: "session-vision",
      workspacePath: tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Submit button");
    expect(result.metadata).toMatchObject({ path: "screenshot.png", model: "lmstudio/qwen2-vl" });
  });

  it("accepts a /workspace-prefixed path for analyze_image", async () => {
    mkdirSync(join(tempDir, "uploads"), { recursive: true });
    writeFileSync(join(tempDir, "uploads", "workspace-shot.png"), Buffer.from("89504e470d0a1a0a", "hex"));

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{
        message: { role: "assistant", content: "The screenshot shows a login form." },
      }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));

    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("analyze_image");

    const result = await tool!.execute({ path: "/workspace/uploads/workspace-shot.png" }, {
      sessionId: "session-vision-workspace-prefix",
      workspacePath: tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("login form");
  });

  it("sends the correct vision model ID and endpoint to LM Studio", async () => {
    const pngBytes = Buffer.from("89504e470d0a1a0a", "hex");
    writeFileSync(join(tempDir, "chart.png"), pngBytes);

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "A bar chart." } }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("analyze_image");

    await tool!.execute({ path: "chart.png", prompt: "Describe the chart" }, {
      sessionId: "session-vision-model",
      workspacePath: tempDir,
    });

    const visionCall = fetchMock.mock.calls[0] as unknown[] | undefined;
    const url = String(visionCall?.[0]);
    const init = visionCall?.[1] as RequestInit;
    expect(url).toBe("http://vision.local/v1/chat/completions");
    const body = JSON.parse(String(init.body));
    // "lmstudio/" prefix stripped → "qwen2-vl"
    expect(body.model).toBe("qwen2-vl");
    expect(body.messages[0].content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "image_url" })]),
    );
  });

  it("prefers a dedicated vision endpoint when configured", async () => {
    const pngBytes = Buffer.from("89504e470d0a1a0a", "hex");
    writeFileSync(join(tempDir, "dedicated-vision.png"), pngBytes);

    const loaderModule = await import("../config/loader.js");
    const realConfig = loaderModule.getConfig();
    const spy = vi.spyOn(loaderModule, "getConfig").mockReturnValue({
      ...realConfig,
      multimodal: {
        ...realConfig.multimodal,
        files: {
          ...realConfig.multimodal.files,
          visionBaseUrl: "http://vision-dedicated.local/v1",
          visionApiKey: "vision-key",
        },
      },
    } as typeof realConfig);

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "Dedicated vision endpoint." } }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const { getTool } = await import("../tools/registry.js");
      const tool = getTool("analyze_image");

      await tool!.execute({ path: "dedicated-vision.png", prompt: "Describe the image" }, {
        sessionId: "session-dedicated-vision",
        workspacePath: tempDir,
      });

      const visionCall = fetchMock.mock.calls[0] as unknown[] | undefined;
      const url = String(visionCall?.[0]);
      const init = visionCall?.[1] as RequestInit;
      expect(url).toBe("http://vision-dedicated.local/v1/chat/completions");
      expect(init.headers).toMatchObject({ Authorization: "Bearer vision-key" });
    } finally {
      spy.mockRestore();
    }
  });

  it("resolves named provider endpoints for vision models", async () => {
    const pngBytes = Buffer.from("89504e470d0a1a0a", "hex");
    writeFileSync(join(tempDir, "named-provider-vision.png"), pngBytes);

    const loaderModule = await import("../config/loader.js");
    const realConfig = loaderModule.getConfig();
    const spy = vi.spyOn(loaderModule, "getConfig").mockReturnValue({
      ...realConfig,
      providers: {
        ...realConfig.providers,
        openaiCompatible: {
          ...(realConfig.providers.openaiCompatible ?? {}),
          vision_vllm: {
            baseUrl: "http://vision-vllm.local/v1",
            apiKey: "vision-vllm-key",
            timeoutMs: 5_000,
            maxRetries: 3,
          },
        },
      },
      multimodal: {
        ...realConfig.multimodal,
        files: {
          ...realConfig.multimodal.files,
          visionModel: "vision_vllm/Qwen/Qwen2.5-VL-7B-Instruct",
          visionBaseUrl: undefined,
          visionApiKey: undefined,
        },
      },
    } as typeof realConfig);

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "Named provider vision." } }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const { getTool } = await import("../tools/registry.js");
      const tool = getTool("analyze_image");

      await tool!.execute({ path: "named-provider-vision.png" }, {
        sessionId: "session-named-provider-vision",
        workspacePath: tempDir,
      });

      const visionCall = fetchMock.mock.calls[0] as unknown[] | undefined;
      expect(String(visionCall?.[0])).toBe("http://vision-vllm.local/v1/chat/completions");
      expect((visionCall?.[1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer vision-vllm-key" });
    } finally {
      spy.mockRestore();
    }
  });

  it("returns failure when no vision model is configured for analyze_image", async () => {
    writeFileSync(join(tempDir, "no-model.png"), Buffer.from("89504e470d0a1a0a", "hex"));

    // Spy on getConfig to strip visionModel without touching the config file
    const loaderModule = await import("../config/loader.js");
    const realConfig = loaderModule.getConfig();
    const spy = vi.spyOn(loaderModule, "getConfig").mockReturnValue({
      ...realConfig,
      multimodal: {
        ...realConfig.multimodal,
        files: { ...realConfig.multimodal.files, visionModel: undefined },
      },
    } as typeof realConfig);

    try {
      const { getTool } = await import("../tools/registry.js");
      const tool = getTool("analyze_image");

      const result = await tool!.execute({ path: "no-model.png" }, {
        sessionId: "session-no-model",
        workspacePath: tempDir,
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/No vision model/);
    } finally {
      spy.mockRestore();
    }
  });

  it("returns failure when analyze_image is called on a non-image file", async () => {
    writeFileSync(join(tempDir, "data.csv"), "a,b\n1,2", "utf8");

    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("analyze_image");

    const result = await tool!.execute({ path: "data.csv" }, {
      sessionId: "session-vision-type",
      workspacePath: tempDir,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Unsupported image type/);
  });

  // ── browser tools ──────────────────────────────────────────────────────────

  it("routes browser_snapshot through the Playwright MCP wrapper", async () => {
    const callTool = vi.fn(async () => ({
      content: [{ type: "text", text: "page snapshot" }],
      isError: false,
    }));
    mcpConnections.set("playwright", { client: { callTool } });

    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("browser_snapshot");
    expect(tool).toBeDefined();

    const result = await tool!.execute({}, {
      sessionId: "session-browser",
      workspacePath: tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe("page snapshot");
    expect(result.metadata).toMatchObject({ server: "playwright", tool: "browser_snapshot" });
    expect(callTool).toHaveBeenCalledWith({ name: "browser_snapshot", arguments: {} });
  });

  it("routes browser_navigate with url argument through Playwright MCP", async () => {
    const callTool = vi.fn(async () => ({
      content: [{ type: "text", text: "navigated" }],
      isError: false,
    }));
    mcpConnections.set("playwright", { client: { callTool } });

    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("browser_navigate");
    expect(tool).toBeDefined();

    const result = await tool!.execute({ url: "https://example.com" }, {
      sessionId: "session-nav",
      workspacePath: tempDir,
    });

    expect(result.success).toBe(true);
    expect(callTool).toHaveBeenCalledWith({
      name: "browser_navigate",
      arguments: { url: "https://example.com" },
    });
  });

  it("routes browser_click with element and ref through Playwright MCP", async () => {
    const callTool = vi.fn(async () => ({
      content: [{ type: "text", text: "clicked" }],
      isError: false,
    }));
    mcpConnections.set("playwright", { client: { callTool } });

    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("browser_click");

    const result = await tool!.execute({ element: "Submit button", ref: "e42" }, {
      sessionId: "session-click",
      workspacePath: tempDir,
    });

    expect(result.success).toBe(true);
    expect(callTool).toHaveBeenCalledWith({
      name: "browser_click",
      arguments: { element: "Submit button", ref: "e42" },
    });
  });

  it("routes browser_type through Playwright MCP", async () => {
    const callTool = vi.fn(async () => ({
      content: [{ type: "text", text: "typed" }],
      isError: false,
    }));
    mcpConnections.set("playwright", { client: { callTool } });

    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("browser_type");

    const result = await tool!.execute(
      { element: "Email field", ref: "e10", text: "user@example.com" },
      { sessionId: "session-type", workspacePath: tempDir },
    );

    expect(result.success).toBe(true);
    expect(callTool).toHaveBeenCalledWith({
      name: "browser_type",
      arguments: { element: "Email field", ref: "e10", text: "user@example.com" },
    });
  });

  it("returns failure when Playwright MCP server is not connected", async () => {
    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("browser_snapshot");

    const result = await tool!.execute({}, {
      sessionId: "session-no-playwright",
      workspacePath: tempDir,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Playwright MCP server is not connected/);
  });

  it("returns failure when the Playwright MCP call itself reports an error", async () => {
    const callTool = vi.fn(async () => ({
      content: [{ type: "text", text: "element not found" }],
      isError: true,
    }));
    mcpConnections.set("playwright", { client: { callTool } });

    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("browser_click");

    const result = await tool!.execute({ element: "Ghost button", ref: "e99" }, {
      sessionId: "session-browser-err",
      workspacePath: tempDir,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/element not found/);
  });
});
