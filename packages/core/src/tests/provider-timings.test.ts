import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelConfig } from "../config/schema.js";

/**
 * WHERE A MODEL CALL'S TIME WENT, ON THE ROW THAT RECORDS THE CALL.
 *
 * The latency question this deployment keeps asking (is the time prompt processing, a cache miss,
 * a queue, or generation?) could only be inferred from the provider_model_call rows: a
 * time-to-first-token spike at unchanged promptTokens was read as a re-prefill. llama-server
 * answers it directly, with a `timings` object on every non-streamed response and on the last
 * chunk of a streamed one, and the provider dropped it. These tests pin the rows that carry it:
 *
 *  - complete() and stream() copy llama-server's timings onto the row, and a backend that sends
 *    none leaves the row exactly as it was;
 *  - a stream row is timed from the send, as a complete() row is, with the wait for the response
 *    headers reported separately (headersMs), so the two modes' rows can be compared;
 *  - the prompt-cache warm-up's calls carry their own label instead of none, or of the turn that
 *    happened to arm them;
 *  - analyze_image's raw request to the same server leaves a row of the same shape.
 */

const rows: Array<{ type: string; data: Record<string, unknown>; opts?: Record<string, unknown> }> = [];
vi.mock("../audit/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../audit/logger.js")>();
  return {
    ...actual,
    logAudit: vi.fn((type: string, data: Record<string, unknown>, opts?: Record<string, unknown>) => {
      rows.push({ type, data, ...(opts ? { opts } : {}) });
    }),
  };
});

const modelCalls = () => rows.filter((r) => r.type === "provider_model_call");

const base: ModelConfig = {
  primary: "lmstudio/qwen",
  contextWindow: 32_768,
  maxTokens: 64,
  temperature: 0,
  enableThinking: false,
} as ModelConfig;

/** llama-server's timings object as it arrives on the wire, extra fields included. */
const LLAMA_TIMINGS = {
  cache_n: 12_991,
  prompt_n: 925,
  prompt_ms: 1_010.4,
  prompt_per_token_ms: 1.09,
  prompt_per_second: 915.5,
  predicted_n: 5,
  predicted_ms: 89.3,
  predicted_per_token_ms: 17.86,
  predicted_per_second: 56.0,
};
const EXPECTED_TIMINGS = { cacheN: 12_991, promptN: 925, promptMs: 1_010.4, predictedN: 5, predictedMs: 89.3 };

/** The keys a complete() row carried before timings existed, plus the head hashes every row now
 *  carries (providers/prompt-head.ts: they describe the request, so they need no server). A row
 *  from a backend with no timings must still have exactly these: no `timings: undefined`, no
 *  empty object. */
const COMPLETE_ROW_KEYS = [
  "completionTokens", "controls", "durationMs", "finishReason", "messageCount", "mode", "model",
  "promptTokens", "reasoningChars", "reasoningTokens", "toolCount",
  "headHash", "toolsHash", "systemHash", "systemChars",
].sort();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function providerModule() {
  return import("../providers/lmstudio.js");
}

function withClient<T extends object>(provider: T, create: (body: unknown, opts?: { signal?: AbortSignal }) => unknown): T {
  (provider as unknown as { client: unknown }).client = { chat: { completions: { create } } };
  return provider;
}

function sseStream(chunks: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

beforeEach(() => { rows.length = 0; });

describe("readServerTimings", () => {
  it("maps llama-server's fields and drops the rest", async () => {
    const { readServerTimings } = await providerModule();
    expect(readServerTimings(LLAMA_TIMINGS)).toEqual(EXPECTED_TIMINGS);
  });

  it("leaves out what the server marked unknown (-1) or did not send, and returns nothing for no timings", async () => {
    const { readServerTimings } = await providerModule();
    // A zero would read as "nothing was cached"; -1 is llama-server's "no value".
    expect(readServerTimings({ cache_n: -1, prompt_n: 384, prompt_ms: 410.2 })).toEqual({ promptN: 384, promptMs: 410.2 });
    expect(readServerTimings({ cache_n: 0, prompt_n: 384 })).toEqual({ cacheN: 0, promptN: 384 });
    for (const none of [undefined, null, "timings", 12, [], {}, { prompt_per_second: 900 }, { prompt_n: "925" }, { prompt_n: Number.NaN }]) {
      expect(readServerTimings(none), JSON.stringify(none)).toBeUndefined();
    }
  });
});

describe("complete() — the server's timings on the row", () => {
  it("copies llama-server's timings from a non-streamed response", async () => {
    const { LMStudioProvider } = await providerModule();
    const provider = withClient(new LMStudioProvider("http://localhost:1234/v1", "test", base, { maxRetries: 0 }), async () => ({
      choices: [{ message: { content: "VERDICT: no", tool_calls: [] }, finish_reason: "stop" }],
      usage: { prompt_tokens: 13_916, completion_tokens: 5, total_tokens: 13_921 },
      timings: LLAMA_TIMINGS,
    }));

    await provider.complete([{ role: "user", content: "Ist das quellenkritisch?" }], []);

    const calls = modelCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.data["timings"]).toEqual(EXPECTED_TIMINGS);
    expect(calls[0]!.data["promptTokens"]).toBe(13_916);
  });

  it("leaves the row unchanged when the backend sends no timings", async () => {
    const { LMStudioProvider } = await providerModule();
    const provider = withClient(new LMStudioProvider("http://localhost:1234/v1", "test", base, { maxRetries: 0 }), async () => ({
      choices: [{ message: { content: "no", tool_calls: [] }, finish_reason: "stop" }],
      usage: { prompt_tokens: 528, completion_tokens: 6, total_tokens: 534 },
    }));

    await provider.complete([{ role: "user", content: "is this source-sensitive?" }], []);

    const row = modelCalls()[0]!.data;
    // Neither a timings key nor the stream-only headersMs: other providers' rows are as they were.
    expect(Object.keys(row).sort()).toEqual(COMPLETE_ROW_KEYS);
  });

  it("writes no timings on a failed call either", async () => {
    const { LMStudioProvider } = await providerModule();
    const provider = withClient(new LMStudioProvider("http://localhost:1234/v1", "test", base, { maxRetries: 0 }), async () => {
      throw new Error("connect ECONNREFUSED");
    });

    await expect(provider.complete([{ role: "user", content: "hi" }], [])).rejects.toThrow();

    const row = modelCalls()[0]!.data;
    expect(row["finishReason"]).toBe("error");
    expect(Object.keys(row).sort()).toEqual(COMPLETE_ROW_KEYS);
  });

  it("names the head it sent: the folded system text and the tool block in wire order", async () => {
    // M0 of the cache plan. The orchestrator's forced iterations send a SUBSET of its tools
    // (record_plan while no plan exists, execute_plan once one does), and c297c5ea's first two
    // forced calls were both cold because the subset flipped between them; the rows only said
    // toolCount 10. With toolsHash on the row that switch is visible, and headHash names the
    // whole head (the leading system run as the provider folds it + the tools).
    const { LMStudioProvider } = await providerModule();
    const { promptHeadSignature } = await import("../providers/prompt-head.js");
    const provider = withClient(new LMStudioProvider("http://localhost:1234/v1", "test", base, { maxRetries: 0 }), async () => ({
      choices: [{ message: { content: "ok", tool_calls: [] }, finish_reason: "stop" }],
      usage: { prompt_tokens: 40, completion_tokens: 1, total_tokens: 41 },
    }));
    const tool = (name: string) => ({ name, description: `${name} tool`, parameters: { type: "object", properties: {} } });
    const full = [tool("delegate_to_agent"), tool("record_plan"), tool("memory_store")];
    const subset = [tool("delegate_to_agent"), tool("record_plan")];
    const messages = [
      { role: "system" as const, content: "  Lean base.  " },
      { role: "system" as const, content: "Module." },
      { role: "user" as const, content: "hi" },
    ];

    await provider.complete(messages, full);
    await provider.complete(messages, subset);
    await provider.complete(messages, [...full].reverse());

    const [a, b, c] = modelCalls().map((r) => r.data);
    // The provider folds the leading run (trimmed, joined by a blank line) before the wire.
    expect(a!["headHash"]).toBe(promptHeadSignature("Lean base.\n\nModule.", full).headHash);
    expect(a!["systemChars"]).toBe("Lean base.\n\nModule.".length);
    expect(b!["systemHash"]).toBe(a!["systemHash"]);
    expect(b!["toolsHash"]).not.toBe(a!["toolsHash"]);
    expect(b!["headHash"]).not.toBe(a!["headHash"]);
    // Same tools, other order: a different head on the wire, so a different hash.
    expect(c!["toolsHash"]).not.toBe(a!["toolsHash"]);
  });
});

describe("stream() — the server's timings, and a clock that starts at the send", () => {
  const streamedAnswer = (last: Record<string, unknown>) => [
    { choices: [{ delta: { role: "assistant", content: "" } }] },
    { choices: [{ delta: { content: "Hallo" } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    last,
  ];

  it("copies the timings from the stream's last chunk (the usage chunk, whose choices are empty)", async () => {
    const { LMStudioProvider } = await providerModule();
    const provider = withClient(new LMStudioProvider("http://localhost:1234/v1", "test", base, { maxRetries: 0 }), async () =>
      sseStream(streamedAnswer({
        choices: [],
        usage: { prompt_tokens: 13_916, completion_tokens: 5, total_tokens: 13_921 },
        timings: LLAMA_TIMINGS,
      })));

    const response = await provider.completeViaStream([{ role: "user", content: "Sag hallo" }], []);

    expect(response.content).toBe("Hallo");
    const row = modelCalls()[0]!.data;
    expect(row["mode"]).toBe("stream");
    expect(row["timings"]).toEqual(EXPECTED_TIMINGS);
    expect(row["promptTokens"]).toBe(13_916);
  });

  it("has no timings key when the stream carried none", async () => {
    const { LMStudioProvider } = await providerModule();
    const provider = withClient(new LMStudioProvider("http://localhost:1234/v1", "test", base, { maxRetries: 0 }), async () =>
      sseStream(streamedAnswer({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 1, total_tokens: 21 } })));

    for await (const _chunk of provider.stream([{ role: "user", content: "say hi" }], [])) { /* drain */ }

    const row = modelCalls()[0]!.data;
    expect(row).not.toHaveProperty("timings");
    expect(Object.keys(row).sort()).toEqual([...COMPLETE_ROW_KEYS, "headersMs", "ttftMs"].sort());
  });

  it("counts the wait for the response headers in durationMs and ttftMs, and reports it as headersMs", async () => {
    // create() resolves when the response headers arrive. Anything the server does before
    // that (llama-swap routing, a model load, a wait for a free slot) is what this delay stands
    // for, and complete() has always counted it.
    const HEADER_WAIT_MS = 80;
    const { LMStudioProvider } = await providerModule();
    const provider = withClient(new LMStudioProvider("http://localhost:1234/v1", "test", base, { maxRetries: 0 }), async () => {
      await sleep(HEADER_WAIT_MS);
      return sseStream(streamedAnswer({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 1, total_tokens: 21 } }));
    });

    for await (const _chunk of provider.stream([{ role: "user", content: "say hi" }], [])) { /* drain */ }

    const row = modelCalls()[0]!.data;
    const headersMs = row["headersMs"] as number;
    const ttftMs = row["ttftMs"] as number;
    const durationMs = row["durationMs"] as number;
    // A few ms of timer slack below the delay; the old clock read ~0 for all three.
    expect(headersMs).toBeGreaterThanOrEqual(HEADER_WAIT_MS - 10);
    expect(ttftMs).toBeGreaterThanOrEqual(headersMs);
    expect(durationMs).toBeGreaterThanOrEqual(ttftMs);
  });

  it("puts headersMs and whatever timings arrived on the row of a stream the caller aborted", async () => {
    const { LMStudioProvider } = await providerModule();
    const ac = new AbortController();
    const provider = withClient(new LMStudioProvider("http://localhost:1234/v1", "test", base, { maxRetries: 0 }), async (_body, opts) => ({
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: "partial" } }], timings: { prompt_n: 700, cache_n: 12_000, prompt_ms: 800 } };
        // openai-node ends the iterator silently on a caller abort.
        while (!opts?.signal?.aborted) await sleep(5);
      },
    }));
    setTimeout(() => ac.abort(), 30);

    await expect((async () => {
      for await (const _chunk of provider.stream([{ role: "user", content: "hi" }], [], ac.signal)) { /* drain */ }
    })()).rejects.toThrow();

    const row = modelCalls()[0]!.data;
    expect(row["finishReason"]).toBe("aborted");
    expect(row["headersMs"]).toBeTypeOf("number");
    expect(row["timings"]).toEqual({ promptN: 700, cacheN: 12_000, promptMs: 800 });
  });
});

describe("the prompt-cache warm-up — its calls carry their own label", () => {
  let tempDir: string | undefined;
  afterEach(async () => {
    vi.doUnmock("../providers/index.js");
    delete process.env["SAI_CONFIG_PATH"];
    if (tempDir) { rmSync(tempDir, { recursive: true, force: true }); tempDir = undefined; }
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
  });

  it("labels the warm-up cache_warm / cache_warmer, not the turn whose context armed it", async () => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), "starlingai-warm-attribution-"));
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      agents: {
        defaults: { model: { primary: "lmstudio/qwen" } },
        mainAssistant: { toolMode: "orchestration_only" },
        performance: { promptCacheWarmKeeper: true },
      },
      subAgents: {},
      workspacePath: tempDir,
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;

    // A real provider with a fake transport, so the assertion is on the audit row itself. It is
    // built inside the factory so it shares this module graph's request context with the warmer.
    vi.doMock("../providers/index.js", async () => {
      const { LMStudioProvider } = await import("../providers/lmstudio.js");
      const provider = withClient(new LMStudioProvider("http://localhost:1234/v1", "test", base, { maxRetries: 0 }), async () => ({
        choices: [{ message: { content: "ok", tool_calls: [] }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12_991, completion_tokens: 3, total_tokens: 12_994 },
      }));
      return {
        ...(await vi.importActual<Record<string, unknown>>("../providers/index.js")),
        getChatProvider: () => provider,
      };
    });
    await import("../tools/register-builtins.js");
    const { runWithRequestContext } = await import("../runtime/request-context.js");
    const warmer = await import("../agent/cache-warmer.js");

    // Armed from inside a turn's context: without its own label the row would read as the
    // orchestrator's call in that session, which is the one thing a warm-up is not.
    runWithRequestContext({ sessionId: "session-of-the-last-turn", agentName: "main", callSite: "main_turn" }, () => {
      warmer.startCacheWarmer();
    });
    for (let i = 0; i < 200 && modelCalls().length === 0; i += 1) await sleep(10);
    warmer.stopCacheWarmer();

    const calls = modelCalls();
    expect(calls, "the warm-up made no model call").toHaveLength(1);
    expect(calls[0]!.data["callSite"]).toBe("cache_warm");
    expect(calls[0]!.data["agentName"]).toBe("cache_warmer");
    expect(calls[0]!.opts?.["sessionId"], "the warm-up belongs to no session").toBeUndefined();
  });
});

describe("analyze_image — a provider_model_call row for the vision request", () => {
  let tempDir: string | undefined;
  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env["SAI_CONFIG_PATH"];
    if (tempDir) { rmSync(tempDir, { recursive: true, force: true }); tempDir = undefined; }
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
  });

  async function loadVision() {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), "starlingai-vision-row-"));
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      workspacePath: tempDir,
      providers: { lmstudio: { baseUrl: "http://vision.local/v1", apiKey: "test-key" } },
      multimodal: { files: { baseUrl: "http://files.local", timeoutMs: 5_000, toolName: "file_to_markdown", visionModel: "lmstudio/qwen" } },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    const { runWithRequestContext } = await import("../runtime/request-context.js");
    const { analyzeImageBytes } = await import("../tools/multimodal.js");
    return { runWithRequestContext, analyzeImageBytes };
  }

  const png = new Uint8Array(Buffer.from("89504e470d0a1a0a", "hex"));
  const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

  it("records the call as vision / analyze_image, with usage, timings and the agent that asked", async () => {
    const { runWithRequestContext, analyzeImageBytes } = await loadVision();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      choices: [{ message: { role: "assistant", content: "  Eine Katze sitzt auf dem Sofa.  " }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1_210, completion_tokens: 612, total_tokens: 1_822 },
      timings: { prompt_n: 1_210, cache_n: 0, prompt_ms: 1_402.7, predicted_n: 612, predicted_ms: 10_928.6 },
    })));

    const text = await runWithRequestContext(
      { sessionId: "sub:s1:image_creator:1", agentName: "image_creator", callSite: "sub_agent" },
      () => analyzeImageBytes(png, "image/png", "lmstudio/qwen", "Is there a cat?"),
    );

    // Behaviour unchanged: the answer is what it always was.
    expect(text).toBe("Eine Katze sitzt auf dem Sofa.");
    const calls = modelCalls();
    expect(calls).toHaveLength(1);
    const { data, opts } = calls[0]!;
    expect(data).toMatchObject({
      agentName: "analyze_image",
      callSite: "vision",
      requestedBy: "image_creator",
      model: "qwen",
      mode: "complete",
      promptTokens: 1_210,
      completionTokens: 612,
      reasoningTokens: null,
      finishReason: "stop",
      toolCount: 0,
      messageCount: 1,
      controls: { reasoningEffort: null, enableThinking: false, cachePrompt: false },
      timings: { promptN: 1_210, cacheN: 0, promptMs: 1_402.7, predictedN: 612, predictedMs: 10_928.6 },
    });
    expect(data["durationMs"]).toBeTypeOf("number");
    expect(opts?.["sessionId"]).toBe("sub:s1:image_creator:1");
  });

  it("has no timings key when the server sent none", async () => {
    const { analyzeImageBytes } = await loadVision();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      choices: [{ message: { content: "A bar chart." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 900, completion_tokens: 4, total_tokens: 904 },
    })));

    await analyzeImageBytes(png, "image/png", "lmstudio/qwen", "Describe the chart");

    const row = modelCalls()[0]!.data;
    expect(row).not.toHaveProperty("timings");
    expect(row["promptTokens"]).toBe(900);
  });

  it("still writes the row when the vision call fails, and still throws", async () => {
    const { analyzeImageBytes } = await loadVision();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "model not loaded" }, 503)));

    await expect(analyzeImageBytes(png, "image/png", "lmstudio/qwen", "What is this?")).rejects.toThrow("model not loaded");

    const calls = modelCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.data).toMatchObject({
      agentName: "analyze_image",
      callSite: "vision",
      finishReason: "error",
      promptTokens: null,
      completionTokens: null,
      reasoningChars: null,
    });
    expect(calls[0]!.data["durationMs"]).toBeTypeOf("number");
  });
});
