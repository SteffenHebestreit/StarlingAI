import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelConfig } from "../config/schema.js";
import type { LLMMessage } from "../providers/lmstudio.js";

/**
 * A CALLER CANCEL IS NOT A PROVIDER FAILURE.
 *
 * complete()'s catch could not tell "the caller aborted me on purpose" from "the remote broke":
 * every abort ran recordRequestFailure — failureCount and lastError on the instance, which is
 * what the health snapshot and the failover breaker read — and logged "OpenAI-compatible
 * completion failed" at ERROR level. The speculative source-sensitivity classifier aborts on the
 * commonest turn shapes there are (an evidence-reuse follow-up, a document-grounded turn), so the
 * routing-tier instance collected a fake failure and an error row on ordinary turns.
 *
 * The assertions are on the mechanism: the instance's own runtime snapshot (what the health
 * endpoint and the breaker read) and the level the logger was called at.
 */

const logCalls = vi.hoisted(() => [] as Array<{ level: string; msg: string }>);
vi.mock("../logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logger.js")>();
  const record = (level: string) => (obj: unknown, msg?: string) => {
    logCalls.push({ level, msg: typeof msg === "string" ? msg : String(obj) });
  };
  return {
    ...actual,
    childLogger: () => ({
      trace: record("trace"),
      debug: record("debug"),
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
      fatal: record("fatal"),
    }),
  };
});

const auditRows = vi.hoisted(() => [] as Array<{ event: string; data: Record<string, unknown> }>);
vi.mock("../audit/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../audit/logger.js")>();
  return {
    ...actual,
    logAudit: (event: string, data: Record<string, unknown>) => { auditRows.push({ event, data }); },
  };
});

const { LMStudioProvider } = await import("../providers/lmstudio.js");

const base: ModelConfig = {
  primary: "lmstudio/qwen",
  contextWindow: 8192,
  maxTokens: 64,
} as ModelConfig;

const messages: LLMMessage[] = [
  { role: "system", content: "You are a routing classifier." },
  { role: "user", content: "Is this question source-sensitive?" },
];

/** A provider whose transport always rejects with `err`. maxRetries 0 → one attempt. */
function failingProvider(err: Error) {
  const provider = new LMStudioProvider("http://localhost:1234/v1", "test", base, { maxRetries: 0 });
  (provider as unknown as { client: unknown }).client = {
    chat: { completions: { create: async () => { throw err; } } },
  };
  return provider;
}

function abortError(): Error {
  const err = new Error("Request was aborted.");
  err.name = "AbortError";
  return err;
}

const levels = () => logCalls.map((c) => c.level);

/**
 * …AND IT IS STILL ON THE RECORD.
 *
 * complete()'s catch wrote no provider_model_call row at all, so every latency percentile read
 * off this path counted the calls that RETURNED — the same survivor bias the September audit
 * found when the openai SDK laundered caller aborts into clean stops, and the one the Anthropic
 * provider's catch has just been given rows for. Duration is precisely the figure a failed call
 * was losing, so the row has to exist even though the call reported no usage.
 */
describe("complete() — a failed or cancelled call still leaves a provider_model_call row", () => {
  // Both buffers are module-level and shared with the describe below, whose assertions are on
  // the ABSENCE of an error line — leaving this block's rows behind would fail it for free.
  afterEach(() => { auditRows.length = 0; logCalls.length = 0; });

  const modelCalls = () => auditRows.filter((r) => r.event === "provider_model_call");

  it("records a cancel as an 'aborted' row", async () => {
    const provider = failingProvider(abortError());
    const controller = new AbortController();
    controller.abort();

    await expect(provider.complete(messages, [], controller.signal)).rejects.toThrow();

    expect(modelCalls(), "a cancelled call left no row — percentiles stay survivor-only").toHaveLength(1);
    expect(modelCalls()[0]!.data["finishReason"]).toBe("aborted");
    expect(modelCalls()[0]!.data["mode"]).toBe("complete");
    expect(modelCalls()[0]!.data["durationMs"]).toBeTypeOf("number");
  });

  it("records a transport failure as an 'error' row, one per attempt", async () => {
    const provider = new LMStudioProvider("http://localhost:1234/v1", "test", base, { maxRetries: 1 });
    (provider as unknown as { client: unknown }).client = {
      chat: { completions: { create: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:1234"); } } },
    };

    await expect(provider.complete(messages, [])).rejects.toThrow();

    // maxRetries 1 → two attempts, and each one is a call the remote was asked to serve.
    expect(modelCalls()).toHaveLength(2);
    expect(modelCalls().map((r) => r.data["finishReason"])).toEqual(["error", "error"]);
  });
});

describe("complete() — an aborted request is not counted or logged as a provider failure", () => {
  afterEach(() => { logCalls.length = 0; auditRows.length = 0; });

  it("leaves the health counters clean and logs the cancel at debug", async () => {
    const provider = failingProvider(abortError());
    const controller = new AbortController();
    controller.abort();

    await expect(provider.complete(messages, [], controller.signal)).rejects.toThrow(/OpenAI-compatible request failed/);

    // The counters the health snapshot and the failover breaker read: untouched by a cancel.
    const snapshot = provider.getRuntimeSnapshot();
    expect(snapshot.failureCount, "a caller cancel bumped failureCount").toBe(0);
    expect(snapshot.lastError, "a caller cancel wrote lastError").toBeUndefined();
    expect(snapshot.lastFailureAt).toBeUndefined();

    // And the operator's log: one debug line, no error row.
    expect(levels(), "a caller cancel logged at error level").not.toContain("error");
    expect(logCalls.filter((c) => c.level === "debug").map((c) => c.msg))
      .toContain("OpenAI-compatible completion cancelled by the caller");
  });

  it("still counts and logs a real transport failure (no cancel in sight)", async () => {
    const provider = failingProvider(new Error("connect ECONNREFUSED 127.0.0.1:1234"));

    await expect(provider.complete(messages, [])).rejects.toThrow(/OpenAI-compatible request failed/);

    const snapshot = provider.getRuntimeSnapshot();
    expect(snapshot.failureCount, "a genuine failure stopped being counted").toBe(1);
    expect(snapshot.lastError).toContain("ECONNREFUSED");
    expect(levels()).toContain("error");
  });
});
