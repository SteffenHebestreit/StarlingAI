import { describe, expect, it } from "vitest";
import type { LLMMessage } from "../providers/lmstudio.js";
import { normalizeMessagesForModel } from "../providers/lmstudio.js";

/**
 * Turn assembly emits the system prompt as ~10 separate system messages and appends more
 * mid-conversation as steering directives. That is legal OpenAI Chat Completions, and a
 * chat template is free to be stricter — Qwen3's raises on the SECOND system message
 * because only index 0 is `loop.first`. Measured against a live LM Studio host: one
 * leading system message 200, two 400, system-after-user 400. On such a model every turn
 * failed before the agent did anything.
 */

const MODEL = "qwen/qwen3.6-35b-a3b";

function roles(messages: ReturnType<typeof normalizeMessagesForModel>): string[] {
  return messages.map((m) => m.role);
}

describe("normalizeMessagesForModel — system folding", () => {
  it("merges a run of leading system messages into exactly one", () => {
    const out = normalizeMessagesForModel(
      [
        { role: "system", content: "base prompt" },
        { role: "system", content: "tool catalogue" },
        { role: "system", content: "memory digest" },
        { role: "user", content: "hallo" },
      ] as LLMMessage[],
      MODEL,
    );
    expect(roles(out)).toEqual(["system", "user"]);
    expect(out[0]!.content).toBe("base prompt\n\ntool catalogue\n\nmemory digest");
  });

  it("keeps mid-conversation steering in place, as user-turn context", () => {
    const out = normalizeMessagesForModel(
      [
        { role: "system", content: "base" },
        { role: "user", content: "do the thing" },
        { role: "assistant", content: "delegating" },
        { role: "system", content: "[CONTINUE ORCHESTRATION] keep going" },
      ] as LLMMessage[],
      MODEL,
    );
    expect(roles(out)).toEqual(["system", "user", "assistant", "user"]);
    // Position preserved, not hoisted into the head: these directives are written to be
    // the most recent instruction the model has seen.
    expect(out[3]!.content).toBe("[CONTINUE ORCHESTRATION] keep going");
  });

  it("leaves exactly one system message alone", () => {
    const input = [
      { role: "system", content: "base" },
      { role: "user", content: "hi" },
    ] as LLMMessage[];
    expect(normalizeMessagesForModel(input, MODEL)).toEqual(input);
  });

  it("never emits a second system message, whatever the input shape", () => {
    const out = normalizeMessagesForModel(
      [
        { role: "system", content: "a" },
        { role: "system", content: "b" },
        { role: "user", content: "u1" },
        { role: "system", content: "c" },
        { role: "assistant", content: "a1" },
        { role: "system", content: "d" },
        { role: "user", content: "u2" },
      ] as LLMMessage[],
      MODEL,
    );
    expect(out.filter((m) => m.role === "system")).toHaveLength(1);
    expect(roles(out).indexOf("system")).toBe(0);
  });

  it("drops an all-empty leading run rather than sending a blank system message", () => {
    const out = normalizeMessagesForModel(
      [
        { role: "system", content: "   " },
        { role: "user", content: "hi" },
      ] as LLMMessage[],
      MODEL,
    );
    expect(roles(out)).toEqual(["user"]);
  });

  it("handles a conversation with no system message at all", () => {
    const input = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ] as LLMMessage[];
    expect(normalizeMessagesForModel(input, MODEL)).toEqual(input);
  });

  it("preserves tool calls and tool results untouched", () => {
    const out = normalizeMessagesForModel(
      [
        { role: "system", content: "a" },
        { role: "system", content: "b" },
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "c1", type: "function", function: { name: "open_process", arguments: "{}" } }],
        },
        { role: "tool", content: "{\"process_id\":\"prc_1\"}", tool_call_id: "c1" },
      ] as unknown as LLMMessage[],
      MODEL,
    );
    expect(roles(out)).toEqual(["system", "user", "assistant", "tool"]);
    expect((out[2] as { tool_calls?: unknown[] }).tool_calls).toHaveLength(1);
    expect((out[3] as { tool_call_id?: string }).tool_call_id).toBe("c1");
  });

  it("still folds everything into a user turn for Gemma, which has no system role", () => {
    const out = normalizeMessagesForModel(
      [
        { role: "system", content: "base" },
        { role: "system", content: "more" },
        { role: "user", content: "hallo" },
      ] as LLMMessage[],
      "google/gemma-3-27b",
    );
    expect(out.every((m) => m.role !== "system")).toBe(true);
    expect(String(out[0]!.content)).toContain("base");
    expect(String(out[0]!.content)).toContain("more");
    expect(String(out[0]!.content)).toContain("hallo");
  });
});
