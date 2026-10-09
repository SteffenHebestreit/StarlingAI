import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const disconnectSpies = new Map<string, ReturnType<typeof vi.fn>>();
const providerInstances: Array<{ baseUrl: string; apiKey: string; modelConfig: Record<string, unknown> }> = [];

vi.mock("../mcp/client.js", () => ({
  connectMcpServer: vi.fn(async (serverName: string) => {
    const disconnect = vi.fn(async () => {});
    disconnectSpies.set(serverName, disconnect);

    const toolsByServer: Record<string, Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>> = {
      alpha: [{ name: "search", description: "alpha search", inputSchema: { type: "object", properties: {} } }],
      beta: [{ name: "fetch", description: "beta fetch", inputSchema: { type: "object", properties: {} } }],
    };

    return {
      serverName,
      client: { callTool: vi.fn() },
      tools: toolsByServer[serverName] ?? [],
      disconnect,
    };
  }),
  cleanupConfiguredDockerMcpContainers: vi.fn(async () => {}),
}));

vi.mock("../providers/lmstudio.js", async (importActual) => ({
  // Spread the real module: sub-agent.ts and its helpers import value exports
  // (computePromptTokenBudget, DeadlineAbort, ...) from here, and a mock that
  // replaced the whole module broke every time production code grew an export.
  ...(await importActual<typeof import("../providers/lmstudio.js")>()),
  LMStudioProvider: class MockLMStudioProvider {
    constructor(baseUrl: string, apiKey: string, modelConfig: Record<string, unknown>) {
      providerInstances.push({ baseUrl, apiKey, modelConfig });
    }

    async checkHealth() {
      return { healthy: true, loadedModel: "mock-model" };
    }

    async verifyToolCallSupport() {
      return true;
    }
  },
}));

describe("runtime reload reconciliation", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    vi.unstubAllGlobals();
    vi.resetModules();
    disconnectSpies.clear();
    providerInstances.length = 0;

    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();

    const providers = await import("../providers/index.js");
    providers.resetProvidersForTests();

    const runtimeStatus = await import("../runtime/status.js");
    runtimeStatus.resetRuntimeStatusForTests();

    const { shutdownMcpServers } = await import("../mcp/registry.js");
    await shutdownMcpServers();
  });

  it("removes stale webhook tools when config changes", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-webhooks-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      webhooks: {
        alpha: { description: "Alpha", url: "https://example.com/alpha", method: "POST" },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const [{ syncWebhookTools }, { getTool }, configLoader] = await Promise.all([
      import("../tools/webhooks.js"),
      import("../tools/registry.js"),
      import("../config/loader.js"),
    ]);

    try {
      syncWebhookTools();
      expect(getTool("webhook__alpha")).toBeDefined();

      writeFileSync(configPath, JSON.stringify({
        webhooks: {
          beta: { description: "Beta", url: "https://example.com/beta", method: "GET" },
        },
      }), "utf8");
      configLoader.resetConfigForTests();

      syncWebhookTools();
      expect(getTool("webhook__alpha")).toBeUndefined();
      expect(getTool("webhook__beta")).toBeDefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("removes stale MCP bridged tools when configured servers change", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-mcp-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      mcp: {
        servers: {
          alpha: { transport: "stdio", command: "echo", args: [], autoStart: true },
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const [{ syncMcpServers }, { getTool }, configLoader] = await Promise.all([
      import("../mcp/registry.js"),
      import("../tools/registry.js"),
      import("../config/loader.js"),
    ]);

    try {
      await syncMcpServers();
      expect(getTool("mcp__alpha__search")).toBeDefined();

      writeFileSync(configPath, JSON.stringify({
        mcp: {
          servers: {
            beta: { transport: "stdio", command: "echo", args: [], autoStart: true },
          },
        },
      }), "utf8");
      configLoader.resetConfigForTests();

      await syncMcpServers();
      expect(getTool("mcp__alpha__search")).toBeUndefined();
      expect(getTool("mcp__beta__fetch")).toBeDefined();
      expect(disconnectSpies.get("alpha")).toHaveBeenCalled();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rebuilds the LM Studio provider when config changes", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-providers-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      providers: {
        lmstudio: { baseUrl: "http://localhost:1234/v1", apiKey: "first-key" },
      },
      agents: {
        defaults: {
          model: { primary: "lmstudio/first-model" },
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const [providers, configLoader] = await Promise.all([
      import("../providers/index.js"),
      import("../config/loader.js"),
    ]);

    try {
      const first = providers.getLMStudioProvider();
      expect(providerInstances).toHaveLength(1);
      expect(providerInstances[0]?.baseUrl).toBe("http://localhost:1234/v1");
      expect(providerInstances[0]?.apiKey).toBe("first-key");

      writeFileSync(configPath, JSON.stringify({
        providers: {
          lmstudio: { baseUrl: "http://localhost:4321/v1", apiKey: "second-key" },
        },
        agents: {
          defaults: {
            model: { primary: "lmstudio/second-model" },
          },
        },
      }), "utf8");
      configLoader.resetConfigForTests();

      const second = providers.getLMStudioProvider();
      expect(second).not.toBe(first);
      expect(providerInstances).toHaveLength(2);
      expect(providerInstances[1]?.baseUrl).toBe("http://localhost:4321/v1");
      expect(providerInstances[1]?.apiKey).toBe("second-key");
      expect(providerInstances[1]?.modelConfig).toMatchObject({ primary: "lmstudio/second-model" });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("prefers model-level endpoint overrides over the global LM Studio provider config", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-provider-override-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      providers: {
        lmstudio: { baseUrl: "http://localhost:1234/v1", apiKey: "global-key" },
        openaiCompatible: {
          openai: {
            baseUrl: "https://api.openai.test/v1",
            apiKey: "openai-test-key",
          },
        },
      },
      agents: {
        defaults: {
          model: {
            primary: "lmstudio/external-model",
            baseUrl: "http://localhost:8000/v1",
            apiKey: "external-key",
          },
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const providers = await import("../providers/index.js");

    try {
      providers.getLMStudioProvider();
      expect(providerInstances.at(-1)?.baseUrl).toBe("http://localhost:8000/v1");
      expect(providerInstances.at(-1)?.apiKey).toBe("external-key");

      providers.getLMStudioProviderWithOverride({ enableThinking: true });
      expect(providerInstances.at(-1)?.baseUrl).toBe("http://localhost:8000/v1");
      expect(providerInstances.at(-1)?.apiKey).toBe("external-key");
      expect(providerInstances.at(-1)?.modelConfig).toMatchObject({
        primary: "lmstudio/external-model",
        enableThinking: true,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uses dedicated embedding endpoint overrides when configured", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-embedding-override-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      providers: {
        lmstudio: { baseUrl: "http://localhost:1234/v1", apiKey: "global-key" },
      },
      agents: {
        defaults: {
          model: {
            primary: "lmstudio/general-model",
            embeddingModel: "lmstudio/qwen-embed",
            embeddingBaseUrl: "http://localhost:7000/v1",
            embeddingApiKey: "embed-key",
          },
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const providers = await import("../providers/index.js");

    try {
      providers.getEmbeddingProvider();
      expect(providerInstances.at(-1)?.baseUrl).toBe("http://localhost:7000/v1");
      expect(providerInstances.at(-1)?.apiKey).toBe("embed-key");
      expect(providerInstances.at(-1)?.modelConfig).toMatchObject({
        embeddingModel: "lmstudio/qwen-embed",
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("resolves named OpenAI-compatible providers from the model prefix", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-named-provider-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      providers: {
        lmstudio: { baseUrl: "http://localhost:1234/v1", apiKey: "global-key" },
        openaiCompatible: {
          coder_vllm: { baseUrl: "http://localhost:8000/v1", apiKey: "vllm-key" },
        },
      },
      agents: {
        defaults: {
          model: {
            primary: "coder_vllm/Qwen/Qwen3-Coder-30B-A3B-Instruct",
            embeddingModel: "coder_vllm/text-embedding-qwen3-embedding-0.6b",
          },
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const providers = await import("../providers/index.js");

    try {
      providers.getChatProvider();
      expect(providerInstances.at(-1)?.baseUrl).toBe("http://localhost:8000/v1");
      expect(providerInstances.at(-1)?.apiKey).toBe("vllm-key");
      expect(providerInstances.at(-1)?.modelConfig).toMatchObject({
        primary: "coder_vllm/Qwen/Qwen3-Coder-30B-A3B-Instruct",
      });

      providers.getEmbeddingProvider();
      expect(providerInstances.at(-1)?.baseUrl).toBe("http://localhost:8000/v1");
      expect(providerInstances.at(-1)?.apiKey).toBe("vllm-key");
      expect(providerInstances.at(-1)?.modelConfig).toMatchObject({
        embeddingModel: "coder_vllm/text-embedding-qwen3-embedding-0.6b",
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("tracks external model endpoint health in runtime status", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-model-endpoints-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      providers: {
        lmstudio: { baseUrl: "http://localhost:1234/v1", apiKey: "global-key" },
      },
      agents: {
        defaults: {
          model: {
            primary: "lmstudio/general-model",
            fallback: "lmstudio/general-fallback-model",
            cloudFallback: "openai/general-cloud-model",
            embeddingModel: "lmstudio/embed-model",
            embeddingBaseUrl: "http://localhost:7000/v1",
          },
        },
      },
      subAgents: {
        repo_engineer: {
          description: "Repo work",
          tools: ["read_file"],
          model: {
            primary: "lmstudio/coder-model",
            baseUrl: "http://localhost:8000/v1",
          },
        },
      },
      retrieval: {
        reranker: {
          enabled: true,
          baseUrl: "http://localhost:8100/v1",
          apiKey: "reranker",
          model: "Qwen/Qwen3-Reranker-4B",
        },
      },
      guardrails: {
        modelModeration: {
          enabled: true,
          baseUrl: "http://localhost:8200/v1",
          apiKey: "guard",
          model: "Qwen/Qwen3Guard-Gen-4B",
        },
      },
      multimodal: {
        files: {
          baseUrl: "http://files.local",
          visionModel: "lmstudio/vision-model",
          visionBaseUrl: "http://localhost:8300/v1",
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("http://localhost:8100/")) {
        return new Response("down", { status: 503 });
      }

      const advertisedModels = url.startsWith("http://localhost:7000/")
        ? [{ id: "embed-model" }]
        : url.startsWith("http://localhost:1234/")
          ? [{ id: "general-model" }, { id: "general-fallback-model" }]
          : url.startsWith("https://api.openai.test/")
            ? [{ id: "general-cloud-model" }]
        : url.startsWith("http://localhost:8000/")
          ? [{ id: "coder-model" }]
          : url.startsWith("http://localhost:8200/")
            ? [{ id: "Qwen/Qwen3Guard-Gen-4B" }]
            : url.startsWith("http://localhost:8300/")
              ? [{ id: "vision-model" }]
              : [{ id: "general-model" }];

      return new Response(JSON.stringify({ data: advertisedModels }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const [{ syncModelEndpointRuntimeStatus }, runtimeStatus] = await Promise.all([
      import("../runtime/model-endpoints.js"),
      import("../runtime/status.js"),
    ]);

    try {
      const endpoints = await syncModelEndpointRuntimeStatus();
      expect(endpoints.some((endpoint) => endpoint.role === "orchestrator")).toBe(true);
      expect(endpoints.some((endpoint) => endpoint.role === "orchestrator:fallback")).toBe(true);
      expect(endpoints.some((endpoint) => endpoint.role === "orchestrator:cloudFallback")).toBe(true);
      expect(endpoints.some((endpoint) => endpoint.role === "embeddings")).toBe(true);
      expect(endpoints.some((endpoint) => endpoint.role === "subagent:repo_engineer")).toBe(true);
      expect(endpoints.some((endpoint) => endpoint.role === "vision")).toBe(true);
      expect(endpoints.some((endpoint) => endpoint.role === "guard")).toBe(true);
      expect(endpoints.some((endpoint) => endpoint.role === "reranker" && endpoint.ok === false)).toBe(true);

      const snapshot = runtimeStatus.getRuntimeStatusSnapshot();
      const component = snapshot.components.find((entry) => entry.name === "model_endpoints");
      expect(component?.healthy).toBe(false);
      expect(component?.lastError).toContain("model endpoint(s) unhealthy");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("marks approval routing degraded when config references missing approval dependencies", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-approvals-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      approvalChannels: {
        slack_ops: { type: "slack", webhookUrl: "https://hooks.slack.test/abc", timeoutMs: 60000 },
        outbound_ops: { type: "outbound_webhook", url: "https://example.com/approve", secret: "$MISSING_APPROVAL_SECRET", timeoutMs: 60000 },
      },
      scenes: {
        deploy: {
          description: "Deploy scene",
          task: "Ship it",
          approvalChannel: "missing_channel",
          humanInLoopSteps: ["shell_exec"],
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    delete process.env["MISSING_APPROVAL_SECRET"];
    vi.resetModules();

    const [{ syncApprovalRuntimeStatus }, runtimeStatus] = await Promise.all([
      import("../approval/status.js"),
      import("../runtime/status.js"),
    ]);

    try {
      syncApprovalRuntimeStatus();
      const snapshot = runtimeStatus.getRuntimeStatusSnapshot();
      const approvals = snapshot.components.find((component) => component.name === "approvals");

      expect(approvals?.healthy).toBe(false);
      expect(approvals?.lastError).toContain("approval configuration issue");
      expect((approvals?.details?.issues as string[] | undefined)?.some((issue) => issue.includes("gateway.publicUrl"))).toBe(true);
      expect((approvals?.details?.issues as string[] | undefined)?.some((issue) => issue.includes("missing approval channel"))).toBe(true);
      expect((approvals?.details?.issues as string[] | undefined)?.some((issue) => issue.includes("$MISSING_APPROVAL_SECRET"))).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});