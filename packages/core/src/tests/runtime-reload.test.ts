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

vi.mock("../providers/lmstudio.js", () => ({
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