import { describe, it, expect, afterEach } from "vitest";
import { ConfigSchema, ModelConfigSchema } from "../config/schema.js";
import { AnthropicProvider, enforceToolResultPairing, isAnthropicOAuthCredential, toAnthropicMessages } from "../providers/anthropic.js";
import {
  applyActiveModelPreset,
  getActiveModelPreset,
  listModelPresets,
  resolveProviderEndpointForModel,
} from "../providers/index.js";
import type { LLMMessage, LLMToolDef } from "../providers/lmstudio.js";

function makeConfig(overrides: Record<string, unknown> = {}) {
  return ConfigSchema.parse(overrides);
}

describe("anthropic credential handling", () => {
  it("sniffs OAuth tokens by their sk-ant-oat prefix", () => {
    expect(isAnthropicOAuthCredential("sk-ant-oat01-abc123")).toBe(true);
    expect(isAnthropicOAuthCredential("sk-ant-api03-abc123")).toBe(false);
    expect(isAnthropicOAuthCredential("")).toBe(false);
  });

  it("constructs the provider in the matching auth mode", () => {
    const modelConfig = ModelConfigSchema.parse({ primary: "anthropic/claude-sonnet-4-6" });
    const oauth = new AnthropicProvider("https://api.anthropic.com", "sk-ant-oat01-token", modelConfig);
    const apiKey = new AnthropicProvider("https://api.anthropic.com", "sk-ant-api03-key", modelConfig);
    expect(oauth.isOAuthMode()).toBe(true);
    expect(apiKey.isOAuthMode()).toBe(false);
  });

  it("is in OAuth mode when a managed token provider is attached even without an oat snapshot", () => {
    const modelConfig = ModelConfigSchema.parse({ primary: "anthropic/claude-sonnet-4-6" });
    const managed = new AnthropicProvider("https://api.anthropic.com", "", modelConfig, {
      tokenProvider: async () => "sk-ant-oat01-fresh",
    });
    expect(managed.isOAuthMode()).toBe(true);
  });
});

describe("anthropic endpoint resolution", () => {
  afterEach(() => {
    delete process.env["TEST_ANTHROPIC_TOKEN"];
  });

  it("resolves the anthropic provider with authToken winning over apiKey", () => {
    const config = makeConfig({
      providers: { anthropic: { apiKey: "sk-ant-api03-key", authToken: "sk-ant-oat01-token" } },
    });
    const endpoint = resolveProviderEndpointForModel("anthropic/claude-sonnet-4-6", {}, config);
    expect(endpoint.providerId).toBe("anthropic");
    expect(endpoint.baseUrl).toBe("https://api.anthropic.com");
    expect(endpoint.apiKey).toBe("sk-ant-oat01-token");
  });

  it("resolves $ENV refs in anthropic credentials", () => {
    process.env["TEST_ANTHROPIC_TOKEN"] = "sk-ant-oat01-from-env";
    const config = makeConfig({
      providers: { anthropic: { authToken: "$TEST_ANTHROPIC_TOKEN" } },
    });
    const endpoint = resolveProviderEndpointForModel("anthropic/claude-sonnet-4-6", {}, config);
    expect(endpoint.apiKey).toBe("sk-ant-oat01-from-env");
  });
});

describe("model presets (Local ⇄ Claude switch)", () => {
  it("exposes an implicit claude preset when the anthropic provider is credentialed", () => {
    const config = makeConfig({ providers: { anthropic: { authToken: "sk-ant-oat01-token" } } });
    const presets = listModelPresets(config);
    expect(presets).toEqual([
      { name: "claude", label: "Claude", primary: "anthropic/claude-sonnet-4-6", implicit: true },
    ]);
  });

  it("has no implicit preset without anthropic credentials", () => {
    expect(listModelPresets(makeConfig())).toEqual([]);
  });

  it("drives the implicit preset model from providers.anthropic.defaultModel (dashboard picker)", () => {
    const config = makeConfig({
      providers: { anthropic: { authToken: "sk-ant-oat01-token", defaultModel: "claude-opus-4-8" } },
    });
    expect(listModelPresets(config)).toEqual([
      { name: "claude", label: "Claude", primary: "anthropic/claude-opus-4-8", implicit: true },
    ]);
  });

  it("lets an explicit claude preset override the implicit one", () => {
    const config = makeConfig({
      providers: { anthropic: { apiKey: "sk-ant-api03-key" } },
      agents: { defaults: { modelPresets: { claude: { label: "Claude Opus", primary: "anthropic/claude-opus-4-8" } } } },
    });
    const presets = listModelPresets(config);
    expect(presets).toEqual([
      { name: "claude", label: "Claude Opus", primary: "anthropic/claude-opus-4-8", implicit: false },
    ]);
  });

  it("applies the active preset over the default model and keeps local as fallback", () => {
    const config = makeConfig({
      providers: { anthropic: { authToken: "sk-ant-oat01-token" } },
      agents: { defaults: { activeModelPreset: "claude" } },
    });
    const base = ModelConfigSchema.parse({
      primary: "lmstudio/qwen3-32b",
      baseUrl: "http://localhost:1234/v1",
      apiKey: "local-key",
      enableThinking: true,
      tiers: { synthesis: "lmstudio/qwen3-7b" },
    });
    const applied = applyActiveModelPreset(base, config);
    expect(applied.primary).toBe("anthropic/claude-sonnet-4-6");
    expect(applied.fallback).toBe("lmstudio/qwen3-32b");
    // Endpoint overrides belong to the replaced model; tiers are local-tuned.
    expect(applied.baseUrl).toBeUndefined();
    expect(applied.apiKey).toBeUndefined();
    expect(applied.tiers).toBeUndefined();
    // Behavioral fields survive.
    expect(applied.enableThinking).toBe(true);
  });

  it("overrides per-agent model overrides too (whole-swarm switch)", () => {
    const config = makeConfig({
      providers: { anthropic: { authToken: "sk-ant-oat01-token" } },
      agents: { defaults: { activeModelPreset: "claude" } },
    });
    const agentModel = ModelConfigSchema.parse({ primary: "openrouter/minimax/minimax-m3" });
    const applied = applyActiveModelPreset(agentModel, config);
    expect(applied.primary).toBe("anthropic/claude-sonnet-4-6");
    expect(applied.fallback).toBe("openrouter/minimax/minimax-m3");
  });

  it("is a no-op when no preset is active or the name is unknown", () => {
    const base = ModelConfigSchema.parse({ primary: "lmstudio/qwen3-32b" });
    expect(applyActiveModelPreset(base, makeConfig())).toBe(base);

    const unknown = makeConfig({ agents: { defaults: { activeModelPreset: "nope" } } });
    expect(getActiveModelPreset(unknown)).toBeNull();
    expect(applyActiveModelPreset(base, unknown)).toBe(base);
  });

  it("treats an empty activeModelPreset (the overlay 'off' value) as inactive", () => {
    const config = makeConfig({
      providers: { anthropic: { authToken: "sk-ant-oat01-token" } },
      agents: { defaults: { activeModelPreset: "" } },
    });
    expect(getActiveModelPreset(config)).toBeNull();
  });
});

describe("toAnthropicMessages", () => {
  it("maps leading system messages to the system param and folds tool flows", () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "You are StarlingAI." },
      { role: "system", content: "Stay terse." },
      { role: "user", content: "What's the weather in Berlin?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "tc_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Berlin"}' } }],
      },
      { role: "tool", content: "18°C, cloudy", tool_call_id: "tc_1" },
    ];

    const { system, messages: out } = toAnthropicMessages(messages);
    expect(system).toBe("You are StarlingAI.\n\nStay terse.");
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ role: "user", content: "What's the weather in Berlin?" });
    expect(out[1]).toEqual({
      role: "assistant",
      content: [{ type: "tool_use", id: "tc_1", name: "get_weather", input: { city: "Berlin" } }],
    });
    expect(out[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tc_1", content: "18°C, cloudy" }],
    });
  });

  it("groups consecutive tool results into one user turn", () => {
    const messages: LLMMessage[] = [
      { role: "user", content: "Run both tools" },
      {
        role: "assistant",
        content: "Running.",
        tool_calls: [
          { id: "a", type: "function", function: { name: "t1", arguments: "{}" } },
          { id: "b", type: "function", function: { name: "t2", arguments: "not-json" } },
        ],
      },
      { role: "tool", content: "r1", tool_call_id: "a" },
      { role: "tool", content: "r2", tool_call_id: "b" },
    ];

    const { messages: out } = toAnthropicMessages(messages);
    expect(out).toHaveLength(3);
    const assistant = out[1]!;
    expect(Array.isArray(assistant.content) && assistant.content).toHaveLength(3); // text + 2 tool_use
    // Unparseable arguments degrade to {} instead of crashing the turn.
    const toolUseB = (assistant.content as Array<{ type: string; input?: unknown }>).find(
      (block) => block.type === "tool_use" && (block as { id?: string }).id === "b",
    );
    expect(toolUseB?.input).toEqual({});
    const results = out[2]!;
    expect(results.role).toBe("user");
    expect(Array.isArray(results.content) && results.content).toHaveLength(2);
  });

  it("ensures the first message is a user turn and folds mid-conversation system text", () => {
    const messages: LLMMessage[] = [
      { role: "assistant", content: "Earlier answer." },
      { role: "system", content: "Mode changed to terse." },
      { role: "user", content: "Continue." },
    ];

    const { system, messages: out } = toAnthropicMessages(messages);
    expect(system).toBeUndefined();
    expect(out[0]).toEqual({ role: "user", content: "(continuing session)" });
    expect(out[2]).toEqual({ role: "user", content: "Mode changed to terse." });
    expect(out[3]).toEqual({ role: "user", content: "Continue." });
  });

  it("synthesizes a tool_result when a tool message was dropped from history (audit f0143008)", () => {
    // read_shared_facts' "No shared facts available yet" result was classified
    // boilerplate and never pushed; the API would 400 the whole request.
    const messages: LLMMessage[] = [
      { role: "user", content: "Research the topic" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "tc_facts", type: "function", function: { name: "read_shared_facts", arguments: "{}" } },
          { id: "tc_search", type: "function", function: { name: "web_search", arguments: '{"query":"x"}' } },
        ],
      },
      // Only the web_search result made it into history.
      { role: "tool", content: "search results...", tool_call_id: "tc_search" },
    ];

    const { messages: out } = toAnthropicMessages(messages);
    const results = out[2]!;
    expect(results.role).toBe("user");
    const blocks = results.content as Array<{ type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }>;
    expect(blocks.map((b) => b.tool_use_id)).toEqual(["tc_facts", "tc_search"]);
    const synthesized = blocks.find((b) => b.tool_use_id === "tc_facts")!;
    expect(synthesized.is_error).toBe(true);
    expect(synthesized.content).toContain("not recorded");
    const recorded = blocks.find((b) => b.tool_use_id === "tc_search")!;
    expect(recorded.content).toBe("search results...");
  });

  it("repairs a trailing assistant tool_use with no results at all (abort mid-batch)", () => {
    const messages: LLMMessage[] = [
      { role: "user", content: "Build the file" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "tc_w", type: "function", function: { name: "write_file", arguments: "{}" } }],
      },
      // Aborted before any result was pushed; a synthesis call now reuses this history.
      { role: "system", content: "[FINAL ANSWER REQUIRED] Synthesize now." },
    ];

    const { messages: out } = toAnthropicMessages(messages);
    expect(out[1]!.role).toBe("assistant");
    const results = out[2]!;
    expect(results.role).toBe("user");
    const blocks = results.content as Array<{ type: string; tool_use_id?: string; is_error?: boolean }>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.tool_use_id).toBe("tc_w");
    expect(blocks[0]!.is_error).toBe(true);
    // The synthesis instruction survives, after the synthesized results turn.
    expect(out[3]).toEqual({ role: "user", content: "[FINAL ANSWER REQUIRED] Synthesize now." });
  });
});

describe("anthropic prompt caching (cache_control breakpoints)", () => {
  const modelConfig = ModelConfigSchema.parse({ primary: "anthropic/claude-sonnet-4-6" });
  const messages: LLMMessage[] = [
    { role: "system", content: "You are StarlingAI." },
    { role: "user", content: "hi" },
  ];
  const tools: LLMToolDef[] = [
    { name: "t1", description: "d1", parameters: { type: "object", properties: {} } },
    { name: "t2", description: "d2", parameters: { type: "object", properties: {} } },
  ];

  // Swap in a client stub that captures the request params (TS `private` is not
  // enforced at runtime) and returns a minimal valid Messages response.
  function captureParams(provider: AnthropicProvider): { get: () => Record<string, unknown> } {
    let captured: Record<string, unknown> = {};
    (provider as unknown as { client: unknown }).client = {
      messages: {
        create: async (params: Record<string, unknown>) => {
          captured = params;
          return { content: [{ type: "text", text: "ok" }], usage: { input_tokens: 5, output_tokens: 2 }, stop_reason: "end_turn" };
        },
      },
    };
    return { get: () => captured };
  }

  it("places a breakpoint on the last tool and the system block by default (API-key mode)", async () => {
    const p = new AnthropicProvider("https://api.anthropic.com", "sk-ant-api03-key", modelConfig);
    const cap = captureParams(p);
    await p.complete(messages, tools);
    const params = cap.get();

    const system = params["system"] as Array<{ cache_control?: unknown }>;
    expect(Array.isArray(system)).toBe(true);
    expect(system[system.length - 1]!.cache_control).toEqual({ type: "ephemeral" });

    const reqTools = params["tools"] as Array<{ cache_control?: unknown }>;
    expect(reqTools[reqTools.length - 1]!.cache_control).toEqual({ type: "ephemeral" });
    expect(reqTools[0]!.cache_control).toBeUndefined(); // only the last tool carries it
  });

  it("emits no breakpoints when promptCaching is disabled (system stays a plain string)", async () => {
    const p = new AnthropicProvider("https://api.anthropic.com", "sk-ant-api03-key", modelConfig, { promptCaching: false });
    const cap = captureParams(p);
    await p.complete(messages, tools);
    const params = cap.get();

    expect(typeof params["system"]).toBe("string");
    const reqTools = params["tools"] as Array<{ cache_control?: unknown }>;
    expect(reqTools.every((t) => t.cache_control === undefined)).toBe(true);
  });

  it("breakpoints the real system block, not the Claude Code identity, in OAuth mode", async () => {
    const p = new AnthropicProvider("https://api.anthropic.com", "sk-ant-oat01-token", modelConfig);
    const cap = captureParams(p);
    await p.complete(messages, tools);
    const system = cap.get()["system"] as Array<{ text: string; cache_control?: unknown }>;
    expect(system).toHaveLength(2); // [identity, real system prompt]
    expect(system[0]!.cache_control).toBeUndefined();
    expect(system[1]!.cache_control).toEqual({ type: "ephemeral" });
  });
});

describe("enforceToolResultPairing", () => {
  it("returns well-formed histories unchanged (same reference)", () => {
    const messages = [
      { role: "user" as const, content: "hi" },
      {
        role: "assistant" as const,
        content: [{ type: "tool_use" as const, id: "a", name: "t", input: {} }],
      },
      {
        role: "user" as const,
        content: [{ type: "tool_result" as const, tool_use_id: "a", content: "ok" }],
      },
      { role: "assistant" as const, content: "done" },
    ];
    const repaired = enforceToolResultPairing(messages);
    expect(repaired.messages).toBe(messages);
    expect(repaired.synthesizedResultIds).toEqual([]);
    expect(repaired.orphanedResultIds).toEqual([]);
  });

  it("re-homes results separated from their tool_use by an interleaved text turn", () => {
    const messages = [
      { role: "user" as const, content: "hi" },
      {
        role: "assistant" as const,
        content: [{ type: "tool_use" as const, id: "a", name: "t", input: {} }],
      },
      { role: "user" as const, content: "[SHARED FINDINGS CHECK] new facts arrived" },
      {
        role: "user" as const,
        content: [{ type: "tool_result" as const, tool_use_id: "a", content: "ok" }],
      },
    ];
    const repaired = enforceToolResultPairing(messages);
    expect(repaired.synthesizedResultIds).toEqual([]);
    expect(repaired.messages[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "a", content: "ok" }],
    });
    expect(repaired.messages[3]).toEqual({ role: "user", content: "[SHARED FINDINGS CHECK] new facts arrived" });
  });

  it("downgrades orphaned tool_results to plain text", () => {
    const messages = [
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: "no tools used" },
      {
        role: "user" as const,
        content: [{ type: "tool_result" as const, tool_use_id: "ghost", content: "stray output" }],
      },
    ];
    const repaired = enforceToolResultPairing(messages);
    expect(repaired.orphanedResultIds).toEqual(["ghost"]);
    expect(repaired.messages[2]).toEqual({
      role: "user",
      content: [{ type: "text", text: "[tool result]\nstray output" }],
    });
  });
});
