import { describe, expect, it, vi } from "vitest";
import { LMStudioProvider, normalizeMessagesForModel, salvageToolCallArguments, splitReasoning, stripModelControlTokens, type LLMMessage } from "../providers/lmstudio.js";

describe("splitReasoning", () => {
  it("returns content unchanged when there is no reasoning", () => {
    expect(splitReasoning("Just the answer.")).toEqual({ content: "Just the answer." });
  });

  it("takes reasoning from the reasoning_content field and leaves content clean", () => {
    expect(splitReasoning("The final answer.", "Let me think step by step…")).toEqual({
      content: "The final answer.",
      reasoning: "Let me think step by step…",
    });
  });

  it("extracts inline <think> blocks out of the content", () => {
    const r = splitReasoning("<think>weighing options</think>The answer is 42.");
    expect(r.content).toBe("The answer is 42.");
    expect(r.reasoning).toBe("weighing options");
  });

  it("treats an unterminated <think> (token budget exhausted) as all-reasoning", () => {
    const r = splitReasoning("<think>I will start by checking the curriculum and then");
    expect(r.content).toBeNull();
    expect(r.reasoning).toBe("I will start by checking the curriculum and then");
  });

  it("merges the field and inline reasoning", () => {
    const r = splitReasoning("<think>inline thought</think>Done.", "field thought");
    expect(r.content).toBe("Done.");
    expect(r.reasoning).toBe("field thought\n\ninline thought");
  });

  it("extracts Gemma 4 <thought> blocks out of the content", () => {
    const r = splitReasoning("<thought>reasoning about the steps</thought>Final answer.");
    expect(r.content).toBe("Final answer.");
    expect(r.reasoning).toBe("reasoning about the steps");
  });

  it("treats an unterminated <thought> as all-reasoning", () => {
    const r = splitReasoning("<thought>still working through the logic");
    expect(r.content).toBeNull();
    expect(r.reasoning).toBe("still working through the logic");
  });
});

describe("stripModelControlTokens", () => {
  it("removes Harmony/template control tokens (both <|x|> and malformed <|x>)", () => {
    expect(stripModelControlTokens("Today'<|channel>s date")).toBe("Today's date");
    expect(stripModelControlTokens("done<|im_end|> ok")).toBe("done ok");
    expect(stripModelControlTokens("a<|channel|>b<|message|>c")).toBe("abc");
  });

  it("strips DeepSeek full-width-pipe tokens <｜...｜> (U+FF5C, with ▁ separators)", () => {
    expect(stripModelControlTokens("answer<｜end▁of▁sentence｜>")).toBe("answer");
    expect(stripModelControlTokens("<｜User｜>hi<｜Assistant｜>")).toBe("hi");
    expect(stripModelControlTokens("call<｜tool▁calls▁begin｜>x")).toBe("callx");
  });

  it("strips known angle/bracket literal tokens (Gemma turn, Mistral INST)", () => {
    expect(stripModelControlTokens("a<start_of_turn>b<end_of_turn>c")).toBe("abc");
    expect(stripModelControlTokens("[INST] hi [/INST]")).toBe(" hi ");
    expect(stripModelControlTokens("x[TOOL_CALLS]y[AVAILABLE_TOOLS]z")).toBe("xyz");
  });

  it("leaves legitimate angle-bracket / markdown text untouched (only known literals stripped)", () => {
    expect(stripModelControlTokens("use <html> and <Foo> and <s>strike</s> tags")).toBe("use <html> and <Foo> and <s>strike</s> tags");
    expect(stripModelControlTokens("a < b and c > d")).toBe("a < b and c > d");
    expect(stripModelControlTokens("see [link](url) and [1] and [a, b]")).toBe("see [link](url) and [1] and [a, b]");
    expect(stripModelControlTokens("no tokens here")).toBe("no tokens here");
  });
});

describe("salvageToolCallArguments (tolerant tool-arg parsing)", () => {
  it("parses a clean JSON object string", () => {
    expect(salvageToolCallArguments('{"name":"researcher","task":"news"}'))
      .toEqual({ name: "researcher", task: "news" });
  });

  it("recovers JSON when a Gemma <thought> block is prepended to the args", () => {
    const raw = '<thought>I should record a plan first.</thought>{"plan":["step one"]}';
    expect(salvageToolCallArguments(raw)).toEqual({ plan: ["step one"] });
  });

  it("recovers JSON wrapped in a ```json code fence", () => {
    const raw = '```json\n{"agent":"web_coder","task":"edit"}\n```';
    expect(salvageToolCallArguments(raw)).toEqual({ agent: "web_coder", task: "edit" });
  });

  it("strips a Gemma control token spliced INSIDE a string value (audit 37382e95)", () => {
    // The raw JSON is structurally valid — the `<|channel>` sits inside the task
    // string, so a plain parse would keep it and corrupt the delegated task.
    const raw = '{"task":"Get today\'<|channel>s news for June 16, 2026"}';
    expect(salvageToolCallArguments(raw)).toEqual({ task: "Get today's news for June 16, 2026" });
  });

  it("strips standard <|channel|> / <|im_end|> control tokens too", () => {
    expect(salvageToolCallArguments('{"a":"x<|channel|>y","b":"z<|im_end|>"}'))
      .toEqual({ a: "xy", b: "z" });
  });

  it("extracts the first balanced object even with trailing prose", () => {
    const raw = '{"name":"record_plan","steps":[{"id":1}]}  // that should do it';
    expect(salvageToolCallArguments(raw)).toEqual({ name: "record_plan", steps: [{ id: 1 }] });
  });

  it("does not get confused by braces inside string values", () => {
    expect(salvageToolCallArguments('{"text":"use {curly} braces"}'))
      .toEqual({ text: "use {curly} braces" });
  });

  it("returns null when nothing JSON-shaped is present", () => {
    expect(salvageToolCallArguments("I cannot do that.")).toBeNull();
    expect(salvageToolCallArguments("")).toBeNull();
    expect(salvageToolCallArguments(undefined)).toBeNull();
  });

  it("rejects a bare JSON array (tool args must be an object)", () => {
    expect(salvageToolCallArguments('["a","b"]')).toBeNull();
  });

  it("handles content that is entirely a closed think block (no answer)", () => {
    const r = splitReasoning("<think>all I did was think</think>");
    expect(r.content).toBeNull();
    expect(r.reasoning).toBe("all I did was think");
  });
});

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
