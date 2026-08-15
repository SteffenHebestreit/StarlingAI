import { describe, expect, it, vi } from "vitest";
import { LMStudioProvider } from "../providers/lmstudio.js";
import type { ModelConfig } from "../config/schema.js";

/**
 * A stream that produced real work and THEN died must not throw the work away.
 *
 * Observed in production: a content_writer run on qwen3.8-27b emitted 278 chunks,
 * went quiet inside a reasoning block, and the transport killed it. The whole turn
 * was reported as an error and four useful iterations were discarded — even though
 * the downstream QA gate, artifact verification and loop detector could all have
 * acted on what had already been produced.
 *
 * Salvage returns the partial result with finishReason "length" (which callers
 * already treat as incomplete) instead of throwing. An OPERATOR cancel is different:
 * the user asked for it to stop, so that abort still propagates.
 */
const base: ModelConfig = {
  primary: "lmstudio/qwen/qwen3.8-27b",
  contextWindow: 32_768,
  maxTokens: 256,
  temperature: 0,
  enableThinking: true,
};

/** Provider whose stream() yields `chunks`, then throws `err`. */
function providerYieldingThen(chunks: unknown[], err: Error): LMStudioProvider {
  const p = new LMStudioProvider("http://localhost:1234/v1", "k", base, { maxRetries: 0 });
  (p as unknown as { stream: unknown }).stream = async function* () {
    for (const c of chunks) yield c;
    throw err;
  };
  return p;
}

describe("completeViaStream — partial salvage", () => {
  it("keeps text produced before the stream died", async () => {
    const p = providerYieldingThen(
      [{ type: "text_delta", content: "Half a report" }],
      new Error("terminated"),
    );
    const r = await p.completeViaStream([{ role: "user", content: "go" }], []);
    expect(r.content).toBe("Half a report");
    expect(r.finishReason).toBe("length");   // incomplete, not success
  });

  it("keeps a tool call the model had already emitted", async () => {
    const p = providerYieldingThen([
      { type: "tool_call_start", toolCallId: "t1", toolName: "read_file" },
      { type: "tool_call_delta", toolCallId: "t1", argumentsDelta: '{"path":"a.md"}' },
    ], new Error("terminated"));

    const r = await p.completeViaStream([{ role: "user", content: "go" }], []);
    expect(r.tool_calls).toHaveLength(1);
    expect(r.tool_calls[0]!.name).toBe("read_file");
    expect(r.tool_calls[0]!.arguments).toEqual({ path: "a.md" });
  });

  it("keeps reasoning even when no answer text arrived — the observed failure shape", async () => {
    const p = providerYieldingThen(
      [{ type: "reasoning_delta", content: "thinking hard about the structure" }],
      new Error("terminated: Body Timeout Error"),
    );
    const r = await p.completeViaStream([{ role: "user", content: "go" }], []);
    expect(r.reasoning).toContain("thinking hard");
    expect(r.finishReason).toBe("length");
  });

  it("still throws when the stream produced NOTHING — there is nothing to salvage", async () => {
    const p = providerYieldingThen([], new Error("terminated"));
    await expect(p.completeViaStream([{ role: "user", content: "go" }], []))
      .rejects.toThrow(/terminated/);
  });

  it("still throws on an OPERATOR cancel, even with content buffered", async () => {
    const ac = new AbortController();
    const p = new LMStudioProvider("http://localhost:1234/v1", "k", base, { maxRetries: 0 });
    (p as unknown as { stream: unknown }).stream = async function* () {
      yield { type: "text_delta", content: "partial work" };
      ac.abort();                       // the user pressed stop
      throw new Error("aborted");
    };
    await expect(p.completeViaStream([{ role: "user", content: "go" }], [], ac.signal))
      .rejects.toThrow(/aborted/);
  });

  it("a clean stream is unaffected", async () => {
    const p = new LMStudioProvider("http://localhost:1234/v1", "k", base, { maxRetries: 0 });
    (p as unknown as { stream: unknown }).stream = async function* () {
      yield { type: "text_delta", content: "all done" };
      yield { type: "done", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } };
    };
    const r = await p.completeViaStream([{ role: "user", content: "go" }], []);
    expect(r.content).toBe("all done");
    expect(r.finishReason).toBe("stop");
    expect(r.usage.totalTokens).toBe(3);
  });
});
