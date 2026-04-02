import { beforeEach, describe, expect, it, vi } from "vitest";
import { FailoverChatProvider, type FailoverProviderBinding } from "../providers/failover.js";
import type { ChatProvider, LLMMessage, LLMResponse, LLMToolDef, StreamChunk } from "../providers/lmstudio.js";
import { logAudit } from "../audit/logger.js";

vi.mock("../audit/logger.js", () => ({
  logAudit: vi.fn(),
}));

function createResponse(content: string): LLMResponse {
  return {
    content,
    tool_calls: [],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    finishReason: "stop",
  };
}

function createProvider(overrides: Partial<ChatProvider> = {}): ChatProvider {
  return {
    checkHealth: async () => ({ healthy: true, loadedModel: "mock-model" }),
    verifyToolCallSupport: async () => true,
    complete: async () => createResponse("ok"),
    async *stream(): AsyncGenerator<StreamChunk> {
      yield { type: "text_delta", content: "ok" };
      yield { type: "done", finishReason: "stop" };
    },
    embed: async () => [],
    isHealthy: () => true,
    ...overrides,
  };
}

function createBinding(
  priority: "primary" | "fallback" | "cloudFallback",
  baseUrl: string,
  provider: ChatProvider,
): FailoverProviderBinding {
  return {
    endpoint: {
      providerId: priority === "cloudFallback" ? "openai" : "lmstudio",
      model: `${priority}/model`,
      baseUrl,
      apiKey: "test-key",
      priority,
    },
    provider,
  };
}

describe("FailoverChatProvider", () => {
  beforeEach(() => {
    vi.mocked(logAudit).mockClear();
  });

  it("falls back on transient completion errors", async () => {
    const primaryComplete = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:1234");
    });
    const fallbackComplete = vi.fn(async () => createResponse("fallback response"));

    const provider = new FailoverChatProvider([
      createBinding("primary", "http://primary/v1", createProvider({ complete: primaryComplete })),
      createBinding("fallback", "http://fallback/v1", createProvider({ complete: fallbackComplete })),
    ]);

    const result = await provider.complete([] as LLMMessage[], [] as LLMToolDef[]);

    expect(result.content).toBe("fallback response");
    expect(primaryComplete).toHaveBeenCalledTimes(1);
    expect(fallbackComplete).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logAudit).mock.calls.some(([type, data]) => type === "provider_failover" && data["operation"] === "complete")).toBe(true);
  });

  it("does not fall back on hard completion errors", async () => {
    const primaryComplete = vi.fn(async () => {
      throw new Error("HTTP 401 unauthorized");
    });
    const fallbackComplete = vi.fn(async () => createResponse("should not run"));

    const provider = new FailoverChatProvider([
      createBinding("primary", "http://primary/v1", createProvider({ complete: primaryComplete })),
      createBinding("fallback", "http://fallback/v1", createProvider({ complete: fallbackComplete })),
    ]);

    await expect(provider.complete([] as LLMMessage[], [] as LLMToolDef[])).rejects.toThrow("401");
    expect(fallbackComplete).not.toHaveBeenCalled();
  });

  it("falls back on stream failure before the first chunk", async () => {
    const provider = new FailoverChatProvider([
      createBinding("primary", "http://primary/v1", createProvider({
        async *stream(): AsyncGenerator<StreamChunk> {
          throw new Error("fetch failed");
        },
      })),
      createBinding("fallback", "http://fallback/v1", createProvider({
        async *stream(): AsyncGenerator<StreamChunk> {
          yield { type: "text_delta", content: "hello" };
          yield { type: "done", finishReason: "stop" };
        },
      })),
    ]);

    const chunks: StreamChunk[] = [];
    for await (const chunk of provider.stream([] as LLMMessage[], [] as LLMToolDef[])) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { type: "text_delta", content: "hello" },
      { type: "done", finishReason: "stop" },
    ]);
    expect(vi.mocked(logAudit).mock.calls.some(([type, data]) => type === "provider_failover" && data["operation"] === "stream")).toBe(true);
  });

  it("logs recovery when a previously failing primary succeeds again", async () => {
    let primaryHealthy = false;
    const primaryComplete = vi.fn(async () => {
      if (!primaryHealthy) {
        throw new Error("HTTP 503 service unavailable");
      }
      return createResponse("primary recovered");
    });

    const provider = new FailoverChatProvider([
      createBinding("primary", "http://primary/v1", createProvider({ complete: primaryComplete })),
      createBinding("fallback", "http://fallback/v1", createProvider({ complete: async () => createResponse("fallback") })),
    ]);

    await provider.complete([] as LLMMessage[], [] as LLMToolDef[]);
    primaryHealthy = true;

    const result = await provider.complete([] as LLMMessage[], [] as LLMToolDef[]);

    expect(result.content).toBe("primary recovered");
    expect(vi.mocked(logAudit).mock.calls.some(([type, data]) => type === "provider_recovered" && data["priority"] === "primary")).toBe(true);
  });

  it("reports active fallback and open primary circuit after repeated transient failures", async () => {
    const provider = new FailoverChatProvider([
      createBinding("primary", "http://primary/v1", createProvider({
        complete: async () => {
          throw new Error("connect ECONNREFUSED 127.0.0.1:1234");
        },
      })),
      createBinding("fallback", "http://fallback/v1", createProvider({
        complete: async () => createResponse("fallback"),
      })),
    ]);

    await provider.complete([] as LLMMessage[], [] as LLMToolDef[]);
    await provider.complete([] as LLMMessage[], [] as LLMToolDef[]);

    const primaryStatus = provider.getRuntimeStatus().find((entry) => entry.priority === "primary");
    const fallbackStatus = provider.getRuntimeStatus().find((entry) => entry.priority === "fallback");

    expect(primaryStatus).toMatchObject({
      active: false,
      available: false,
      circuitState: "open",
      consecutiveFailures: 2,
    });
    expect(fallbackStatus).toMatchObject({
      active: true,
      available: true,
      circuitState: "closed",
    });
  });
});