import { describe, expect, it } from "vitest";
import { collectStream } from "../agent/runtime.js";
import type { StreamChunk, LLMResponse } from "../providers/lmstudio.js";

/**
 * NINETEEN MINUTES, PROSE IN HAND, NOTHING DELIVERED.
 *
 * Live incident, session 40dbcb5f (2026-09-08). One orchestrator model call ran 1,146,845 ms.
 * When it ended the runtime was holding reasoning and answer text, and the turn delivered zero
 * characters to the user.
 *
 * Two independent defects produced that, and this file pins the consumer half. `collectStream`
 * is the orchestrator's stream consumer and it had no try/catch, so any throw from the provider
 * discarded every character accumulated above it. The salvage that makes a cut survivable lives
 * in `completeViaStream` — which sub-agents use and the orchestrator does not. The one agent
 * whose budget must cover many calls plus delegations had the least protected answer path in
 * the system.
 *
 * The provider half (a caller abort being recorded as `finishReason: "stop"` because
 * openai@4.104.0 swallows AbortError) is pinned in provider-stream-abort-not-success.test.ts.
 */

async function* chunks(items: StreamChunk[], thenThrow?: Error): AsyncGenerator<StreamChunk> {
  for (const c of items) yield c;
  if (thenThrow) throw thenThrow;
}

const text = (content: string): StreamChunk => ({ type: "text_delta", content } as StreamChunk);
const reasoning = (content: string): StreamChunk => ({ type: "reasoning_delta", content } as StreamChunk);

const partialOf = (err: unknown): LLMResponse | undefined =>
  (err as { partialResponse?: LLMResponse } | null)?.partialResponse;

describe("collectStream salvages what a cut orchestrator call already produced", () => {
  it("attaches the accumulated prose to the error instead of dropping it", async () => {
    const boom = new Error("LLM stream aborted before it finished: DeadlineAbort");
    const gen = chunks([text("The three databases compared here are "), text("Qdrant, Weaviate and Milvus.")], boom);

    await expect(collectStream(gen)).rejects.toThrow(boom);

    // Re-run to inspect the thrown error (rejects.toThrow consumes it).
    let caught: unknown;
    try {
      await collectStream(chunks([text("The three databases compared here are "), text("Qdrant, Weaviate and Milvus.")], boom));
    } catch (e) { caught = e; }
    const partial = partialOf(caught);
    expect(partial).toBeDefined();
    expect(partial!.content).toBe("The three databases compared here are Qdrant, Weaviate and Milvus.");
    expect(partial!.finishReason).toBe("incomplete");
  });

  it("still THROWS — a cut turn must not be reported as a finished one", async () => {
    // The salvage must not swallow. Classification downstream keys on the error's identity:
    // a DeadlineAbort resynthesizes, an operator cancel propagates, a burn abort is a verdict.
    const boom = new Error("DeadlineAbort");
    await expect(collectStream(chunks([text("partial")], boom))).rejects.toThrow("DeadlineAbort");
  });

  it("carries reasoning across too, but reasoning is not an answer", async () => {
    const boom = new Error("cut");
    let caught: unknown;
    try {
      await collectStream(chunks([reasoning("thinking about vector stores"), text("Answer: ")], boom));
    } catch (e) { caught = e; }
    const partial = partialOf(caught);
    expect(partial!.reasoning).toBe("thinking about vector stores");
    expect(partial!.content).toBe("Answer: ");
  });

  it("drops a half-streamed tool call — truncated arguments must never be dispatched", async () => {
    const boom = new Error("cut mid tool call");
    let caught: unknown;
    try {
      await collectStream(chunks([
        { type: "tool_call_start", toolCallId: "c1", toolName: "web_search" } as StreamChunk,
        { type: "tool_call_delta", toolCallId: "c1", argumentsDelta: '{"query": "vect' } as StreamChunk,
      ], boom));
    } catch (e) { caught = e; }
    const partial = partialOf(caught);
    // Either salvaged into something usable or dropped — but never a truncated-JSON call that
    // would be dispatched with half its arguments.
    for (const call of partial!.tool_calls ?? []) {
      expect(call.arguments).not.toHaveProperty("_parse_error");
      expect(Object.keys(call.arguments).length).toBeGreaterThan(0);
    }
  });

  it("a stream that ends normally is unaffected — no caveat, no incomplete marker", async () => {
    // The regression that matters most here: the try/catch must not change the healthy path.
    const res = await collectStream(chunks([
      text("A complete answer."),
      { type: "done", finishReason: "stop", usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 } } as StreamChunk,
    ]));
    expect(res.content).toBe("A complete answer.");
    expect(res.finishReason).toBe("stop");
    expect(res.usage.totalTokens).toBe(14);
  });

  it("streams text to the sink as it arrives, cut or not", async () => {
    const seen: string[] = [];
    try {
      await collectStream(chunks([text("one "), text("two")], new Error("cut")), (t) => seen.push(t));
    } catch { /* expected */ }
    expect(seen).toEqual(["one ", "two"]);
  });
});
