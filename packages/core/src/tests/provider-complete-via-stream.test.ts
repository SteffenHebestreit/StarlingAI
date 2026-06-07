import { describe, expect, it } from "vitest";
import { LMStudioProvider, type StreamChunk } from "../providers/lmstudio.js";
import type { ModelConfig } from "../config/schema.js";

/**
 * completeViaStream accumulates the streaming deltas into the same LLMResponse
 * shape complete() returns — so the sub-agent loop can use it for live token
 * progress + the per-chunk inactivity abort without changing how callers read the
 * result. Reasoning is already de-thought by stream(), so we just concatenate.
 */
const baseModelConfig: ModelConfig = {
  primary: "lmstudio/test-model",
  contextWindow: 8192,
  maxTokens: 64,
  temperature: 0,
  enableThinking: false,
};

function providerWithScriptedStream(chunks: StreamChunk[]): LMStudioProvider {
  const provider = new LMStudioProvider("http://localhost:1234/v1", "test", baseModelConfig, { maxRetries: 0 });
  (provider as unknown as { stream: () => AsyncGenerator<StreamChunk> }).stream = async function* () {
    for (const c of chunks) yield c;
  };
  return provider;
}

describe("LMStudioProvider.completeViaStream", () => {
  it("accumulates text, reasoning, tool calls, finishReason, and usage", async () => {
    const provider = providerWithScriptedStream([
      { type: "reasoning_delta", content: "thinking…" },
      { type: "text_delta", content: "The IM73A135V01 " },
      { type: "text_delta", content: "is an Infineon analog MEMS mic." },
      { type: "tool_call_start", toolCallId: "c1", toolName: "share_finding" },
      { type: "tool_call_delta", toolCallId: "c1", argumentsDelta: "{\"key\":\"mic\"," },
      { type: "tool_call_delta", toolCallId: "c1", argumentsDelta: "\"value\":\"Infineon\"}" },
      { type: "done", finishReason: "tool_calls", usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
    ]);

    const resp = await provider.completeViaStream!([{ role: "user", content: "hi" }], []);
    expect(resp.content).toBe("The IM73A135V01 is an Infineon analog MEMS mic.");
    expect(resp.reasoning).toBe("thinking…");
    expect(resp.tool_calls).toHaveLength(1);
    expect(resp.tool_calls[0]!.name).toBe("share_finding");
    expect(resp.tool_calls[0]!.arguments).toEqual({ key: "mic", value: "Infineon" });
    expect(resp.finishReason).toBe("tool_calls");
    expect(resp.usage.totalTokens).toBe(15);
  });

  it("returns null content when the model emitted only reasoning (the 'no final response' shape)", async () => {
    const provider = providerWithScriptedStream([
      { type: "reasoning_delta", content: "hmm, not sure" },
      { type: "done", finishReason: "stop" },
    ]);
    const resp = await provider.completeViaStream!([{ role: "user", content: "hi" }], []);
    expect(resp.content).toBeNull();
    expect(resp.reasoning).toBe("hmm, not sure");
    expect(resp.tool_calls).toHaveLength(0);
  });

  it("flags an unparseable tool-call argument blob instead of throwing", async () => {
    const provider = providerWithScriptedStream([
      { type: "tool_call_start", toolCallId: "c1", toolName: "do_thing" },
      { type: "tool_call_delta", toolCallId: "c1", argumentsDelta: "{not valid json" },
      { type: "done", finishReason: "tool_calls" },
    ]);
    const resp = await provider.completeViaStream!([{ role: "user", content: "hi" }], []);
    expect(resp.tool_calls[0]!.arguments["_parse_error"]).toBe(true);
    expect(resp.tool_calls[0]!.arguments["_raw"]).toContain("{not valid json");
  });

  it("treats an empty-arg tool call as {} (no false parse error)", async () => {
    const provider = providerWithScriptedStream([
      { type: "tool_call_start", toolCallId: "c1", toolName: "read_shared_facts" },
      { type: "done", finishReason: "tool_calls" },
    ]);
    const resp = await provider.completeViaStream!([{ role: "user", content: "hi" }], []);
    expect(resp.tool_calls[0]!.arguments).toEqual({});
  });
});
