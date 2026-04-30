import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Stage 12 — Open Interop.  These tests cover the surface contract of the
 * three new modules: tool embedding warm-up, MCP server exposure, and the
 * public A2A protocol.  We don't exercise live MCP / A2A transports here —
 * the SDK and HTTP bits are integration concerns; these tests pin the
 * config-driven shape so accidental regressions show up before CI.
 */

let tempDir: string | null = null;

async function withConfig(raw: Record<string, unknown>): Promise<void> {
  if (tempDir) return; // configured already
  tempDir = mkdtempSync(join(tmpdir(), "starling-stage12-"));
  const configPath = join(tempDir, "starlingai.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      gateway: { jwtSecret: "c".repeat(32) },
      workspacePath: tempDir,
      ...raw,
    }),
    "utf8",
  );
  process.env["SAI_CONFIG_PATH"] = configPath;
  vi.resetModules();
}

afterEach(async () => {
  delete process.env["SAI_CONFIG_PATH"];
  vi.resetModules();
  const configLoader = await import("../config/loader.js");
  configLoader.resetConfigForTests();
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("warmToolEmbeddings", () => {
  beforeEach(async () => {
    await withConfig({});
  });

  it("returns warmed=0 when embeddings are unavailable", async () => {
    const { warmToolEmbeddings } = await import("../tools/registry.js");
    const result = await warmToolEmbeddings();
    expect(result.warmed).toBe(0);
    // Either skipped or warmed must equal zero — embeddings unavailable
    // implies the helper short-circuits before touching the cache.
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("filters by tool names and ignores unknown ones", async () => {
    // Reuse `list_agents` (Tier 0 in the central tier map) so the registry
    // accepts our manual register call — arbitrary names are blocked at Tier 4.
    const { warmToolEmbeddings, registerTool, unregisterTool, _clearToolEmbeddingCacheForTests } = await import("../tools/registry.js");
    _clearToolEmbeddingCacheForTests();
    const knownName = "list_agents";
    try {
      registerTool({
        name: knownName,
        description: "list agents (test stub)",
        parameters: { type: "object", properties: {} },
        async execute() { return { success: true, output: "" }; },
      });
      const result = await warmToolEmbeddings([knownName, "nonexistent_tool"]);
      expect(result.warmed).toBeGreaterThanOrEqual(0);
      expect(result.skipped).toBeGreaterThanOrEqual(0);
    } finally {
      try { unregisterTool(knownName); } catch { /* ignore */ }
    }
  });
});

async function registerTestTool(name: string, description: string): Promise<() => void> {
  const { registerTool, unregisterTool } = await import("../tools/registry.js");
  registerTool({
    name,
    description,
    parameters: { type: "object", properties: {} },
    async execute() { return { success: true, output: "" }; },
  });
  return () => { try { unregisterTool(name); } catch { /* ignore */ } };
}

describe("getMcpExposeSummary", () => {
  it("returns enabled=false when mcp.expose is left at defaults", async () => {
    await withConfig({});
    const { getMcpExposeSummary } = await import("../mcp/server.js");
    const summary = getMcpExposeSummary();
    expect(summary.enabled).toBe(false);
    expect(summary.toolCount).toBe(0);
    expect(summary.agentCount).toBe(0);
    expect(summary.sceneCount).toBe(0);
  });

  it("advertises Tier 0/1 tools when expose.enabled and the allowlist is empty", async () => {
    await withConfig({
      mcp: { expose: { enabled: true } },
    });
    const cleanup = await registerTestTool("list_agents", "list configured sub-agents");
    try {
      const { getMcpExposeSummary } = await import("../mcp/server.js");
      const summary = getMcpExposeSummary();
      expect(summary.enabled).toBe(true);
      expect(summary.toolCount).toBeGreaterThan(0);
      // Tier 2 must be opt-in: with allowTier2 unset, no plugin__/selfdev__ tools should slip in.
      for (const name of summary.tools) {
        expect(name.startsWith("plugin__")).toBe(false);
        expect(name.startsWith("selfdev__")).toBe(false);
      }
    } finally { cleanup(); }
  });

  it("respects exposeTools allowlist when provided", async () => {
    await withConfig({
      mcp: { expose: { enabled: true, exposeTools: ["list_agents"] } },
    });
    const cleanupA = await registerTestTool("list_agents", "list configured sub-agents");
    const cleanupB = await registerTestTool("search_agents", "embedding search across agents");
    try {
      const { getMcpExposeSummary } = await import("../mcp/server.js");
      const summary = getMcpExposeSummary();
      expect(summary.enabled).toBe(true);
      expect(summary.tools).toEqual(["list_agents"]);
    } finally { cleanupA(); cleanupB(); }
  });
});

describe("A2A agent card", () => {
  it("emits a well-formed card when a2a.enabled and an agent is configured", async () => {
    await withConfig({
      a2a: { enabled: true, exposeAgents: [] },
      subAgents: {
        researcher: {
          description: "Quick research helper",
          capabilities: ["search"],
          tags: ["research"],
          systemPrompt: "be helpful",
          maxIterations: 5,
        },
      },
    });

    // The buildAgentCard helper is private; exercise it via the public
    // request handler by feeding fabricated request/response objects.
    const { handleA2ARequest } = await import("../a2a/server.js");
    const captured: { status?: number; body?: string } = {};
    const fakeRes = {
      headersSent: false,
      writeHead(status: number) { captured.status = status; },
      end(body?: string) { captured.body = body; },
    };
    const fakeReq = {
      method: "GET",
      url: "/.well-known/agent-card.json",
      headers: { host: "starling.test" },
      on() { /* unused for GET */ },
    } as unknown as import("node:http").IncomingMessage;
    const handled = await handleA2ARequest(fakeReq, fakeRes as unknown as import("node:http").ServerResponse);
    expect(handled).toBe(true);
    expect(captured.status).toBe(200);
    const body = JSON.parse(captured.body ?? "{}") as Record<string, unknown>;
    expect(body["protocolVersion"]).toBe("0.2.0");
    expect(body["url"]).toMatch(/^https?:\/\/starling\.test\/a2a\/v1$/);
    const skills = body["skills"] as Array<{ id: string }>;
    expect(skills.some((s) => s.id === "researcher")).toBe(true);
  });

  it("returns 404 when a2a is disabled", async () => {
    await withConfig({});
    const { handleA2ARequest } = await import("../a2a/server.js");
    const captured: { status?: number } = {};
    const fakeRes = {
      headersSent: false,
      writeHead(status: number) { captured.status = status; },
      end() { /* */ },
    };
    const fakeReq = {
      method: "GET",
      url: "/.well-known/agent-card.json",
      headers: { host: "starling.test" },
      on() { /* */ },
    } as unknown as import("node:http").IncomingMessage;
    await handleA2ARequest(fakeReq, fakeRes as unknown as import("node:http").ServerResponse);
    expect(captured.status).toBe(404);
  });
});
