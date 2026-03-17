import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

describe("gateway HTTP bridge", () => {
  let upstreamServer: ReturnType<typeof createServer> | null = null;

  beforeEach(() => {
    upstreamServer = null;
  });

  afterEach(async () => {
    if (upstreamServer) {
      await new Promise<void>((resolve, reject) => {
        upstreamServer?.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      upstreamServer = null;
    }
    delete process.env["SAI_CONFIG_PATH"];
    delete process.env["SAI_JWT_SECRET"];
    delete process.env["SAI_MASTER_KEY"];
    delete process.env["SAI_CRED_STORE"];
    delete process.env["SAI_AUDIT_LOG"];
    vi.resetModules();

    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();

    const auth = await import("../gateway/auth.js");
    auth.resetAuthStateForTests();

    const providers = await import("../providers/index.js");
    providers.resetProvidersForTests();

    const guardrails = await import("../guardrails/store.js");
    guardrails.resetGuardrailsForTests();

    const runtimeStatus = await import("../runtime/status.js");
    runtimeStatus.resetRuntimeStatusForTests();

    const registry = await import("../channels/registry.js");
    registry.resetChannelRegistryForTests();
  });

  it("forwards authenticated JSON request bodies to Hono routes", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-gateway-"));
    const port = 18000 + Math.floor(Math.random() * 1000);
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      gateway: {
        port,
        jwtSecret: "d".repeat(32),
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    delete process.env["SAI_JWT_SECRET"];
    process.env["SAI_MASTER_KEY"] = "m".repeat(32);
    process.env["SAI_CRED_STORE"] = join(tempDir, ".starlingai", "credentials.enc");
    process.env["SAI_AUDIT_LOG"] = join(tempDir, ".starlingai", "audit.jsonl");

    vi.resetModules();

    const [{ createGateway }, auth] = await Promise.all([
      import("../gateway/index.js"),
      import("../gateway/auth.js"),
    ]);

    const gateway = createGateway();
    gateway.start();

    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      await waitForHealth(`${baseUrl}/healthz`);

      const token = await auth.createToken("admin", { role: "admin" });
      const response = await fetch(`${baseUrl}/api/guardrails`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          promptInjectionBlock: false,
          outputSecretScan: false,
          maxInputLength: 4096,
        }),
      });

      expect(response.status).toBe(200);
      const updated = await response.json() as Record<string, unknown>;
      expect(updated["promptInjectionBlock"]).toBe(false);
      expect(updated["outputSecretScan"]).toBe(false);
      expect(updated["maxInputLength"]).toBe(4096);

      const verifyResponse = await fetch(`${baseUrl}/api/guardrails`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(verifyResponse.status).toBe(200);
      const current = await verifyResponse.json() as Record<string, unknown>;
      expect(current["promptInjectionBlock"]).toBe(false);
      expect(current["outputSecretScan"]).toBe(false);
      expect(current["maxInputLength"]).toBe(4096);
    } finally {
      await gateway.stop();
      auth.resetAuthStateForTests();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("rejects dashboard writes to config-owned resources and preserves stored site passwords", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-settings-"));
    const port = 19000 + Math.floor(Math.random() * 1000);
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      gateway: {
        port,
        jwtSecret: "e".repeat(32),
      },
      sites: {
        "example.com": {
          username: "config-user",
          password: "dev-password",
        },
      },
      scenes: {
        readonly_scene: {
          description: "Read-only",
          task: "Do not edit",
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    delete process.env["SAI_JWT_SECRET"];
    process.env["SAI_MASTER_KEY"] = "m".repeat(32);
    process.env["SAI_CRED_STORE"] = join(tempDir, ".starlingai", "credentials.enc");
    process.env["SAI_AUDIT_LOG"] = join(tempDir, ".starlingai", "audit.jsonl");

    vi.resetModules();

    const [{ createGateway }, auth, sites] = await Promise.all([
      import("../gateway/index.js"),
      import("../gateway/auth.js"),
      import("../credentials/sites.js"),
    ]);

    const gateway = createGateway();
    gateway.start();

    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      await waitForHealth(`${baseUrl}/healthz`);

      const token = await auth.createToken("admin", { role: "admin" });

      const siteUpdate = await fetch(`${baseUrl}/api/sites/example.com`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ username: "shadowed", password: "shadowed" }),
      });
      expect(siteUpdate.status).toBe(403);

      const sceneUpdate = await fetch(`${baseUrl}/api/scenes/readonly_scene`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ description: "shadowed", task: "shadowed" }),
      });
      expect(sceneUpdate.status).toBe(403);

      const createSite = await fetch(`${baseUrl}/api/sites/runtime.example`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ username: "runtime-user", password: "runtime-secret" }),
      });
      expect(createSite.status).toBe(200);

      const updateSite = await fetch(`${baseUrl}/api/sites/runtime.example`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ username: "runtime-user-2" }),
      });
      expect(updateSite.status).toBe(200);

      const stored = sites.resolveSiteCredential("runtime.example");
      expect(stored?.username).toBe("runtime-user-2");
      expect(stored?.password).toBe("runtime-secret");
    } finally {
      await gateway.stop();
      auth.resetAuthStateForTests();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("serves effective channel config and accepts telegram dashboard settings", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-channels-"));
    const port = 20000 + Math.floor(Math.random() * 1000);
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      gateway: {
        port,
        jwtSecret: "f".repeat(32),
      },
      channels: {
        telegram: {
          enabled: false,
          allowedUserIds: [123],
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    delete process.env["SAI_JWT_SECRET"];
    process.env["SAI_MASTER_KEY"] = "m".repeat(32);
    process.env["SAI_CRED_STORE"] = join(tempDir, ".starlingai", "credentials.enc");
    process.env["SAI_AUDIT_LOG"] = join(tempDir, ".starlingai", "audit.jsonl");

    vi.resetModules();

    const [{ createGateway }, auth, channelStore] = await Promise.all([
      import("../gateway/index.js"),
      import("../gateway/auth.js"),
      import("../credentials/channels.js"),
    ]);

    const gateway = createGateway();
    gateway.start();

    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      await waitForHealth(`${baseUrl}/healthz`);

      const token = await auth.createToken("admin", { role: "admin" });

      const before = await fetch(`${baseUrl}/api/channels/telegram`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(before.status).toBe(200);
      const beforeBody = await before.json() as { source: string; config: Record<string, unknown> };
      expect(beforeBody.source).toBe("config");
      expect(beforeBody.config["enabled"]).toBe(false);
      expect(beforeBody.config["allowedUserIds"]).toEqual([123]);

      const update = await fetch(`${baseUrl}/api/channels/telegram`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          enabled: true,
          botToken: "123456:telegram-token",
          allowedUserIds: [111, 222],
        }),
      });
      expect(update.status).toBe(200);

      const after = await fetch(`${baseUrl}/api/channels/telegram`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(after.status).toBe(200);
      const afterBody = await after.json() as { source: string; config: Record<string, unknown> };
      expect(afterBody.source).toBe("store");
      expect(afterBody.config["enabled"]).toBe(true);
      expect(afterBody.config["allowedUserIds"]).toEqual([111, 222]);
      expect(afterBody.config["botToken"]).toBe("••••••••");

      const stored = channelStore.getStoredChannelConfig("telegram");
      expect(stored?.botToken).toBe("123456:telegram-token");
      expect(stored?.allowedUserIds).toEqual([111, 222]);

      const statuses = await fetch(`${baseUrl}/api/channels`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(statuses.status).toBe(200);
      const statusBody = await statuses.json() as Array<{ type: string; enabled: boolean; running: boolean; error?: string }>;
      expect(statusBody.find((status) => status.type === "telegram")).toMatchObject({
        enabled: true,
        running: false,
      });
      expect(statusBody.find((status) => status.type === "telegram")?.error).toContain("Telegram startup failed");
    } finally {
      await gateway.stop();
      auth.resetAuthStateForTests();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("reconciles channel runtime state after dashboard updates and deletes", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-channel-runtime-"));
    const port = 21000 + Math.floor(Math.random() * 1000);
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      gateway: {
        port,
        jwtSecret: "g".repeat(32),
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    delete process.env["SAI_JWT_SECRET"];
    process.env["SAI_MASTER_KEY"] = "m".repeat(32);
    process.env["SAI_CRED_STORE"] = join(tempDir, ".starlingai", "credentials.enc");
    process.env["SAI_AUDIT_LOG"] = join(tempDir, ".starlingai", "audit.jsonl");

    vi.resetModules();

    const [{ createGateway }, auth] = await Promise.all([
      import("../gateway/index.js"),
      import("../gateway/auth.js"),
    ]);

    const gateway = createGateway();
    gateway.start();

    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      await waitForHealth(`${baseUrl}/healthz`);

      const token = await auth.createToken("admin", { role: "admin" });

      const initialStatuses = await fetch(`${baseUrl}/api/channels`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(initialStatuses.status).toBe(200);
      const initialBody = await initialStatuses.json() as Array<{ type: string; supported?: boolean; reason?: string }>;
      expect(initialBody.find((status) => status.type === "email")).toMatchObject({
        supported: true,
      });
      expect(initialBody.find((status) => status.type === "signal")).toMatchObject({
        supported: false,
        reason: "Channel runtime is not implemented yet",
      });

      const enable = await fetch(`${baseUrl}/api/channels/slack`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          enabled: true,
          botToken: "xoxb-runtime-token",
          signingSecret: "runtime-signing-secret",
        }),
      });
      expect(enable.status).toBe(200);

      await waitForChannelStatus(baseUrl, token, "slack", { enabled: true, running: true });

      const disable = await fetch(`${baseUrl}/api/channels/slack`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(disable.status).toBe(200);

      await waitForChannelStatus(baseUrl, token, "slack", { enabled: false, running: false });
    } finally {
      await gateway.stop();
      auth.resetAuthStateForTests();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("exposes channel latency and SLO metrics via channel APIs", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-channel-metrics-"));
    const port = 21500 + Math.floor(Math.random() * 1000);
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      gateway: {
        port,
        jwtSecret: "h".repeat(32),
      },
      workspacePath: tempDir,
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    delete process.env["SAI_JWT_SECRET"];
    process.env["SAI_MASTER_KEY"] = "m".repeat(32);
    process.env["SAI_CRED_STORE"] = join(tempDir, ".starlingai", "credentials.enc");
    process.env["SAI_AUDIT_LOG"] = join(tempDir, ".starlingai", "audit.jsonl");

    vi.resetModules();

    const [{ createGateway }, auth, registry, deadLetters] = await Promise.all([
      import("../gateway/index.js"),
      import("../gateway/auth.js"),
      import("../channels/registry.js"),
      import("../channels/dead-letter.js"),
    ]);

    const gateway = createGateway();
    gateway.start();

    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      await waitForHealth(`${baseUrl}/healthz`);

      registry.registerChannel("slack", true);
      registry.recordChannelDelivery("slack", true, undefined, 120);
      registry.recordChannelDelivery("slack", false, "temporary failure", 480);
      deadLetters.appendDeadLetter({
        channel: "slack",
        messagePreview: "hello",
        error: "temporary failure",
        attempts: 3,
      });

      const token = await auth.createToken("admin", { role: "admin" });

      const statusesResponse = await fetch(`${baseUrl}/api/channels`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(statusesResponse.status).toBe(200);
      const statuses = await statusesResponse.json() as Array<{
        type: string;
        metrics?: {
          deliveryLatency?: { sampleCount: number; p50Ms?: number; p95Ms?: number };
          deliverySlo?: { totalDeliveries: number; successRatePct: number };
          deliveryWindows?: { last5m?: { failed: number; successRatePct: number } };
        };
        operatorState?: { severity: string; summary: string };
      }>;
      expect(statuses.find((status) => status.type === "slack")?.metrics?.deliveryLatency).toMatchObject({
        sampleCount: 2,
        p50Ms: 120,
        p95Ms: 480,
      });
      expect(statuses.find((status) => status.type === "slack")?.metrics?.deliverySlo).toMatchObject({
        totalDeliveries: 2,
        successRatePct: 50,
      });
      expect(statuses.find((status) => status.type === "slack")?.metrics?.deliveryWindows?.last5m).toMatchObject({
        failed: 1,
        successRatePct: 50,
      });
      expect(statuses.find((status) => status.type === "slack")?.operatorState).toMatchObject({
        severity: "warning",
      });

      const detailResponse = await fetch(`${baseUrl}/api/channels/slack`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(detailResponse.status).toBe(200);
      const detail = await detailResponse.json() as {
        status?: {
          metrics?: {
            deliveryLatency?: { sampleCount: number; lastMs?: number; maxMs?: number };
            deliverySlo?: { totalDeliveries: number; successRatePct: number };
            deliveryWindows?: { last5m?: { failed: number } };
          };
          operatorState?: { severity: string; summary: string };
        };
        operator?: {
          recentDeadLetters?: Array<{ channel: string; error: string }>;
          recoveryProcedures?: string[];
        };
      };
      expect(detail.status?.metrics?.deliveryLatency).toMatchObject({
        sampleCount: 2,
        lastMs: 480,
        maxMs: 480,
      });
      expect(detail.status?.metrics?.deliverySlo).toMatchObject({
        totalDeliveries: 2,
        successRatePct: 50,
      });
      expect(detail.status?.metrics?.deliveryWindows?.last5m).toMatchObject({
        failed: 1,
      });
      expect(detail.status?.operatorState).toMatchObject({
        severity: "warning",
      });
      expect(detail.operator?.recentDeadLetters?.[0]).toMatchObject({
        channel: "slack",
        error: "temporary failure",
      });
      expect(detail.operator?.recoveryProcedures?.length).toBeGreaterThan(0);
    } finally {
      await gateway.stop();
      auth.resetAuthStateForTests();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("exposes runtime reconciliation status for operators", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-runtime-status-"));
    const port = 22000 + Math.floor(Math.random() * 1000);
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      gateway: {
        port,
        jwtSecret: "h".repeat(32),
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    delete process.env["SAI_JWT_SECRET"];
    process.env["SAI_MASTER_KEY"] = "m".repeat(32);
    process.env["SAI_CRED_STORE"] = join(tempDir, ".starlingai", "credentials.enc");
    process.env["SAI_AUDIT_LOG"] = join(tempDir, ".starlingai", "audit.jsonl");

    vi.resetModules();

    const [{ createGateway }, auth] = await Promise.all([
      import("../gateway/index.js"),
      import("../gateway/auth.js"),
    ]);

    const gateway = createGateway();
    gateway.start();

    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      await waitForHealth(`${baseUrl}/healthz`);
      const token = await auth.createToken("admin", { role: "admin" });

      const response = await fetch(`${baseUrl}/api/runtime/status`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(response.status).toBe(200);
      const body = await response.json() as {
        healthy: boolean;
        components: Array<{ name: string; healthy: boolean }>;
      };
      expect(Array.isArray(body.components)).toBe(true);
      expect(body.components.find((component) => component.name === "channels")).toBeTruthy();
      expect(body.components.find((component) => component.name === "webhooks")).toBeTruthy();
      expect(body.components.find((component) => component.name === "mcp")).toBeTruthy();
      expect(body.components.find((component) => component.name === "providers")).toBeTruthy();
      expect(body.components.find((component) => component.name === "approvals")).toBeTruthy();
      expect(body.components.find((component) => component.name === "config_reload")).toBeTruthy();
    } finally {
      await gateway.stop();
      auth.resetAuthStateForTests();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("resolves agent routing through the dashboard API", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-agent-resolve-"));
    const port = 23000 + Math.floor(Math.random() * 1000);
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      gateway: {
        port,
        jwtSecret: "i".repeat(32),
      },
      agents: {
        defaults: {
          model: { primary: "lmstudio/qwen3.5-9b" },
        },
      },
      subAgents: {
        browser_agent: {
          description: "Logs into sites and automates forms in the browser.",
          capabilities: ["browser automation", "login flows"],
          tools: ["get_site_credentials", "mcp__playwright__browser_click", "mcp__playwright__browser_type"],
          maxIterations: 6,
        },
        researcher: {
          description: "Finds facts on the web and summarizes them.",
          capabilities: ["web research"],
          tools: ["web_search"],
          maxIterations: 4,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    delete process.env["SAI_JWT_SECRET"];
    process.env["SAI_MASTER_KEY"] = "m".repeat(32);
    process.env["SAI_CRED_STORE"] = join(tempDir, ".starlingai", "credentials.enc");
    process.env["SAI_AUDIT_LOG"] = join(tempDir, ".starlingai", "audit.jsonl");

    vi.resetModules();

    const [{ createGateway }, auth] = await Promise.all([
      import("../gateway/index.js"),
      import("../gateway/auth.js"),
    ]);

    const gateway = createGateway();
    gateway.start();

    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      await waitForHealth(`${baseUrl}/healthz`);
      const token = await auth.createToken("admin", { role: "admin" });

      const response = await fetch(`${baseUrl}/api/agents/resolve?query=${encodeURIComponent("login form automation")}&minConfidence=medium`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(response.status).toBe(200);
      const body = await response.json() as {
        query: string;
        minConfidence: string;
        results: Array<{ name: string; confidence: string; capabilities: string[] }>;
        weakCandidates: Array<{ name: string }>;
      };
      expect(body.query).toBe("login form automation");
      expect(body.minConfidence).toBe("medium");
      expect(body.results[0]).toMatchObject({
        name: "browser_agent",
        confidence: expect.stringMatching(/^(high|medium)$/),
      });
      expect(body.results[0]?.capabilities).toContain("browser automation");
      expect(body.weakCandidates).toEqual([]);
    } finally {
      await gateway.stop();
      auth.resetAuthStateForTests();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("proxies multimodal file, STT, TTS, and voice listing routes", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-multimodal-"));
    const port = 23500 + Math.floor(Math.random() * 1000);
    const upstreamPort = 24500 + Math.floor(Math.random() * 1000);
    const configPath = join(tempDir, "starlingai.json");

    upstreamServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.url === "/health" || req.url === "/api/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "healthy" }));
        return;
      }

      if (req.method === "GET" && req.url === "/voices") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ voices: [{ id: "saved-demo", name: "Saved Demo", lang: "English" }] }));
        return;
      }

      if (req.method === "GET" && req.url === "/speakers") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ speakers: ["Vivian", "Ryan"] }));
        return;
      }

      if (req.method === "GET" && req.url === "/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ models: { "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice": { capabilities: ["tts", "custom_voice"] } }, current_model: "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice" }));
        return;
      }

      if (req.method === "POST" && req.url === "/load_model") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      if (req.method === "POST" && req.url === "/api/tools/file_to_markdown") {
        // Gateway sends multipart/form-data to the backend; drain and respond
        expect(req.headers["content-type"]).toContain("multipart/form-data");
        req.resume();
        req.on("end", () => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, filename: "report.txt", markdown: "# Converted\n\nhello world" }));
        });
        return;
      }

      if (req.method === "POST" && req.url === "/v1/audio/transcriptions") {
        expect(req.headers["content-type"]).toContain("multipart/form-data");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ text: "transcribed speech", language: "en", duration: 1.2 }));
        return;
      }

      if (req.method === "POST" && req.url === "/tts") {
        let rawBody = "";
        req.on("data", (chunk: Buffer) => { rawBody += chunk.toString(); });
        req.on("end", () => {
          const body = JSON.parse(rawBody) as { text: string; lang: string; speaker: string };
          expect(body.text).toBe("speak this");
          expect(body.lang).toBe("English");
          expect(body.speaker).toBe("Vivian");
          res.writeHead(200, { "Content-Type": "audio/wav" });
          res.end(Buffer.from("RIFFtest"));
        });
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    });

    await new Promise<void>((resolve, reject) => {
      upstreamServer?.listen(upstreamPort, "127.0.0.1", (error?: Error) => {
        if (error) reject(error);
        else resolve();
      });
    });

    writeFileSync(configPath, JSON.stringify({
      gateway: {
        port,
        jwtSecret: "j".repeat(32),
      },
      multimodal: {
        files: { baseUrl: `http://127.0.0.1:${upstreamPort}` },
        stt: { baseUrl: `http://127.0.0.1:${upstreamPort}` },
        tts: { baseUrl: `http://127.0.0.1:${upstreamPort}` },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    delete process.env["SAI_JWT_SECRET"];
    process.env["SAI_MASTER_KEY"] = "m".repeat(32);
    process.env["SAI_CRED_STORE"] = join(tempDir, ".starlingai", "credentials.enc");
    process.env["SAI_AUDIT_LOG"] = join(tempDir, ".starlingai", "audit.jsonl");

    vi.resetModules();

    const [{ createGateway }, auth] = await Promise.all([
      import("../gateway/index.js"),
      import("../gateway/auth.js"),
    ]);

    const gateway = createGateway();
    gateway.start();

    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      await waitForHealth(`${baseUrl}/healthz`);
      const token = await auth.createToken("admin", { role: "admin" });

      const fileForm = new FormData();
      fileForm.append("file", new File(["hello world"], "report.txt", { type: "text/plain" }));
      const fileResponse = await fetch(`${baseUrl}/api/multimodal/file-to-markdown`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: fileForm,
      });
      expect(fileResponse.status).toBe(200);
      const fileBody = await fileResponse.json() as { markdown: string };
      expect(fileBody.markdown).toContain("Converted");

      const audioForm = new FormData();
      audioForm.append("file", new File([new Uint8Array([1, 2, 3, 4])], "sample.wav", { type: "audio/wav" }));
      const sttResponse = await fetch(`${baseUrl}/api/multimodal/transcribe`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: audioForm,
      });
      expect(sttResponse.status).toBe(200);
      const sttBody = await sttResponse.json() as { text: string; language: string };
      expect(sttBody).toMatchObject({ text: "transcribed speech", language: "en" });

      const voicesResponse = await fetch(`${baseUrl}/api/multimodal/voices`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(voicesResponse.status).toBe(200);
      const voicesBody = await voicesResponse.json() as { voices: Array<{ id: string }>; speakers: string[] };
      expect(voicesBody.voices[0]?.id).toBe("saved-demo");
      expect(voicesBody.speakers).toContain("Vivian");

      const ttsResponse = await fetch(`${baseUrl}/api/multimodal/tts`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: "speak this" }),
      });
      expect(ttsResponse.status).toBe(200);
      expect(ttsResponse.headers.get("content-type")).toContain("audio/wav");
      const ttsBytes = Buffer.from(await ttsResponse.arrayBuffer());
      expect(ttsBytes.subarray(0, 4).toString()).toBe("RIFF");

      const statusResponse = await fetch(`${baseUrl}/api/multimodal/status`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(statusResponse.status).toBe(200);
      const statusBody = await statusResponse.json() as { files: { ok: boolean }; stt: { ok: boolean }; tts: { ok: boolean }; wakeWord: { enabled: boolean } };
      expect(statusBody.files.ok).toBe(true);
      expect(statusBody.stt.ok).toBe(true);
      expect(statusBody.tts.ok).toBe(true);

      const configResponse = await fetch(`${baseUrl}/api/multimodal/config`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(configResponse.status).toBe(200);
      const configBody = await configResponse.json() as { stt: { model: string }; wakeWord: { language: string } };
      expect(configBody.stt.model).toBe("Qwen/Qwen3-ASR-1.7B");
      expect(configBody.wakeWord.language).toBe("en-US");

      const updatedConfig = {
        maxUploadBytes: 4_194_304,
        files: {
          baseUrl: `http://127.0.0.1:${upstreamPort}`,
          toolName: "file_to_markdown",
          timeoutMs: 45_000,
        },
        stt: {
          baseUrl: `http://127.0.0.1:${upstreamPort}`,
          timeoutMs: 45_000,
          model: "Qwen/Qwen3-ASR-1.7B",
        },
        tts: {
          baseUrl: `http://127.0.0.1:${upstreamPort}`,
          model: "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
          timeoutMs: 45_000,
          defaultLanguage: "German",
          defaultSpeaker: "Ryan",
          defaultQuality: "high",
        },
        wakeWord: {
          enabled: true,
          language: "de-DE",
          keywords: ["Hallo Guarded"],
          stopPhrases: ["stopp"],
          silenceTimeoutMs: 2500,
        },
      };

      const updateResponse = await fetch(`${baseUrl}/api/multimodal/config`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(updatedConfig),
      });
      expect(updateResponse.status).toBe(200);
      const updatedBody = await updateResponse.json() as typeof updatedConfig;
      expect(updatedBody.stt.model).toBe("Qwen/Qwen3-ASR-1.7B");
      expect(updatedBody.wakeWord.keywords).toEqual(["Hallo Guarded"]);

      const refreshedStatusResponse = await fetch(`${baseUrl}/api/multimodal/status`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(refreshedStatusResponse.status).toBe(200);
      const refreshedStatusBody = await refreshedStatusResponse.json() as { wakeWord: { enabled: boolean; language: string; keywords: string[] } };
      expect(refreshedStatusBody.wakeWord.enabled).toBe(true);
      expect(refreshedStatusBody.wakeWord.language).toBe("de-DE");
      expect(refreshedStatusBody.wakeWord.keywords).toEqual(["Hallo Guarded"]);
    } finally {
      await gateway.stop();
      auth.resetAuthStateForTests();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 15_000);
});

async function waitForHealth(url: string): Promise<void> {
  const deadline = Date.now() + 5000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server not ready yet.
    }

    await new Promise(resolve => setTimeout(resolve, 100));
  }

  throw new Error(`Gateway did not become ready: ${url}`);
}

async function waitForChannelStatus(
  baseUrl: string,
  token: string,
  type: string,
  expected: { enabled: boolean; running: boolean },
): Promise<void> {
  const deadline = Date.now() + 5000;

  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/channels`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.ok) {
      const statuses = await response.json() as Array<{ type: string; enabled: boolean; running: boolean }>;
      const match = statuses.find((status) => status.type === type);
      if (match && match.enabled === expected.enabled && match.running === expected.running) {
        return;
      }
    }

    await new Promise(resolve => setTimeout(resolve, 100));
  }

  throw new Error(`Channel status did not converge for ${type}`);
}