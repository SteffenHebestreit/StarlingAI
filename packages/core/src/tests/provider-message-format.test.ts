import { describe, expect, it, vi } from "vitest";
import { LMStudioProvider, normalizeMessagesForModel, type LLMMessage } from "../providers/lmstudio.js";

describe("normalizeMessagesForModel", () => {
  it("folds Gemma system prompts into the first user turn", () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "You are a precise code reviewer." },
      { role: "system", content: "Today's date: 2026-04-03" },
      { role: "user", content: "Review this diff." },
      { role: "assistant", content: "Ready." },
    ];

    const normalized = normalizeMessagesForModel(messages, "gemma-4-26b-a4b-it");

    expect(normalized).toHaveLength(2);
    expect(normalized[0]).toMatchObject({ role: "user" });
    expect(normalized[0]?.content).toContain("Follow these instructions for the entire conversation.");
    expect(normalized[0]?.content).toContain("You are a precise code reviewer.");
    expect(normalized[0]?.content).toContain("Today's date: 2026-04-03");
    expect(normalized[0]?.content).toContain("Current request or continuation:\nReview this diff.");
    expect(normalized[1]).toMatchObject({ role: "assistant", content: "Ready." });
  });

  it("adds a synthetic user instruction turn for Gemma when no user message exists yet", () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "You are a tool-calling assistant." },
      { role: "assistant", content: "Waiting for input." },
    ];

    const normalized = normalizeMessagesForModel(messages, "lmstudio/gemma-4-26b-a4b-it");

    expect(normalized[0]).toMatchObject({ role: "user" });
    expect(normalized[0]?.content).toContain("You are a tool-calling assistant.");
    expect(normalized[1]).toMatchObject({ role: "assistant", content: "Waiting for input." });
  });

  it("keeps non-Gemma chat messages unchanged", () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "System rules" },
      { role: "user", content: "Task" },
    ];

    const normalized = normalizeMessagesForModel(messages, "qwen3.6-35b-a3b");

    expect(normalized).toEqual(messages);
  });

  it("strips the provider prefix for embedding model requests", async () => {
    const provider = new LMStudioProvider(
      "http://example.com/v1",
      "test-key",
      {
        primary: "lmstudio/gemma-4-26b-a4b-it",
        contextWindow: 32768,
        temperature: 0.3,
        maxTokens: 1024,
        enableThinking: false,
      },
    );

    const create = vi.fn().mockResolvedValue({
      data: [{ embedding: [0.1, 0.2, 0.3] }],
    });

    (provider as unknown as { client: { embeddings: { create: typeof create } } }).client = {
      embeddings: { create },
    };

    await provider.embed(["hello"], "lmstudio/text-embedding-qwen3-embedding-0.6b");

    expect(create).toHaveBeenCalledWith({
      model: "text-embedding-qwen3-embedding-0.6b",
      input: ["hello"],
      // Forced to avoid the OpenAI SDK's base64 default, which LM Studio
      // mis-decodes into all-zero vectors.
      encoding_format: "float",
    });
  });

  it("passes enable_thinking through for Gemma models without forcing Qwen sampling defaults", async () => {
    const provider = new LMStudioProvider(
      "http://example.com/v1",
      "test-key",
      {
        primary: "lmstudio/gemma-4-e4b-it",
        contextWindow: 32768,
        temperature: 0.2,
        maxTokens: 1024,
        enableThinking: true,
      },
    );

    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "done", tool_calls: [] }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    (provider as unknown as { client: { chat: { completions: { create: typeof create } } } }).client = {
      chat: { completions: { create } },
    };

    await provider.complete([{ role: "user", content: "Do the task." }], [], undefined);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gemma-4-e4b-it",
        temperature: 0.2,
        extra_body: { chat_template_kwargs: { enable_thinking: true } },
      }),
      // The provider wraps every call in a hard-timeout AbortController and
      // hands the combined signal to the SDK, so the second arg always carries
      // a real AbortSignal — never literal `undefined`.
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
