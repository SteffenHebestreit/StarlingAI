import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import WebSocket from "ws";
import { DEFAULT_TTS_CHUNK_MAX_CHARS } from "../multimodal/tts-chunking.js";

function createPcmWav(sampleCount: number, seed = 0): Buffer {
  const dataSize = sampleCount * 2;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(22_050, 24);
  wav.writeUInt32LE(44_100, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    wav.writeInt16LE(seed + index, 44 + (index * 2));
  }
  return wav;
}

function readPcmWavDataSize(wav: Buffer): number {
  return wav.readUInt32LE(40);
}

describe("gateway HTTP bridge", () => {
  const gatewayTestTimeoutMs = 45_000;
  let upstreamServer: ReturnType<typeof createServer> | null = null;

  beforeEach(() => {
    upstreamServer = null;
  });

  afterEach(async () => {
    if (upstreamServer) {
      await new Promise<void>((resolve, reject) => {
        upstreamServer?.closeAllConnections?.();
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
    delete process.env["SAI_USER_MEMORY_PATH"];
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

    const jobs = await import("../agent/jobs.js");
    await jobs.resetJobsForTests();

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
    await gateway.start();

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
      await flushAuditLogForTests();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, gatewayTestTimeoutMs);

  it("allows configured browser origins for direct gateway access", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-cors-"));
    const port = 18100 + Math.floor(Math.random() * 1000);
    const configPath = join(tempDir, "starlingai.json");
    const allowedOrigin = "https://chat.internal.example";

    writeFileSync(configPath, JSON.stringify({
      gateway: {
        port,
        jwtSecret: "k".repeat(32),
        publicUrl: "https://gateway.internal.example",
        corsAllowedOrigins: [allowedOrigin],
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    delete process.env["SAI_JWT_SECRET"];
    process.env["SAI_MASTER_KEY"] = "m".repeat(32);
    process.env["SAI_CRED_STORE"] = join(tempDir, ".starlingai", "credentials.enc");
    process.env["SAI_AUDIT_LOG"] = join(tempDir, ".starlingai", "audit.jsonl");

    vi.resetModules();

    const { createGateway } = await import("../gateway/index.js");
    const gateway = createGateway();
    await gateway.start();

    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      await waitForHealth(`${baseUrl}/healthz`);

      const response = await fetch(`${baseUrl}/healthz`, {
        method: "OPTIONS",
        headers: {
          Origin: allowedOrigin,
          "Access-Control-Request-Method": "GET",
        },
      });

      expect(response.ok).toBe(true);
      expect(response.headers.get("access-control-allow-origin")).toBe(allowedOrigin);
      expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    } finally {
      await gateway.stop();
      await flushAuditLogForTests();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, gatewayTestTimeoutMs);

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
    await gateway.start();

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
      await flushAuditLogForTests();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, gatewayTestTimeoutMs);

  it("round-trips the structured personality profile through the gateway API", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-personality-api-"));
    const port = 19150 + Math.floor(Math.random() * 1000);
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      gateway: {
        port,
        jwtSecret: "p".repeat(32),
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    delete process.env["SAI_JWT_SECRET"];
    process.env["SAI_MASTER_KEY"] = "m".repeat(32);
    process.env["SAI_CRED_STORE"] = join(tempDir, ".starlingai", "credentials.enc");
    process.env["SAI_AUDIT_LOG"] = join(tempDir, ".starlingai", "audit.jsonl");
    process.env["SAI_USER_MEMORY_PATH"] = join(tempDir, ".starlingai", "state");

    vi.resetModules();

    const [{ createGateway }, auth] = await Promise.all([
      import("../gateway/index.js"),
      import("../gateway/auth.js"),
    ]);

    const gateway = createGateway();
    await gateway.start();

    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      await waitForHealth(`${baseUrl}/healthz`);

      const token = await auth.createToken("admin", { role: "admin" });

      const initialResponse = await fetch(`${baseUrl}/api/personality`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(initialResponse.status).toBe(200);
      const initial = await initialResponse.json() as {
        schemaVersion: number;
        identity: { core: string };
        collaboration: { defaults: string[]; avoidances: string[] };
      };
      expect(initial.schemaVersion).toBe(2);
      expect(initial.identity.core).toBeTruthy();
      expect(initial.collaboration.defaults.length).toBeGreaterThan(0);

      const updateResponse = await fetch(`${baseUrl}/api/personality`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          schemaVersion: 2,
          identity: {
            core: "A rigorous but slightly sharper implementation partner.",
          },
          voice: {
            tone: ["Measured.", "Blunt when tradeoffs matter."],
            style: ["State the constraint, then recommend."],
            quirks: ["Dry humor in short bursts."],
          },
          collaboration: {
            defaults: ["Lead with the decisive tradeoff."],
            avoidances: ["Do not pad the answer with generic reassurance."],
          },
          growth: {
            notes: ["The user likes stronger architectural judgment."],
          },
          reason: "Refined the durable operating shape",
        }),
      });

      expect(updateResponse.status).toBe(200);
      const updated = await updateResponse.json() as {
        schemaVersion: number;
        identity: { core: string };
        voice: { tone: string[] };
        collaboration: { defaults: string[]; avoidances: string[] };
        growth: { notes: string[] };
        updatedBy: string;
      };
      expect(updated).toMatchObject({
        schemaVersion: 2,
        identity: { core: "A rigorous but slightly sharper implementation partner." },
        collaboration: {
          defaults: ["Lead with the decisive tradeoff."],
          avoidances: ["Do not pad the answer with generic reassurance."],
        },
        growth: {
          notes: ["The user likes stronger architectural judgment."],
        },
        updatedBy: "user",
      });
      expect(updated.voice.tone).toContain("Measured.");

      const resetResponse = await fetch(`${baseUrl}/api/personality/reset`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(resetResponse.status).toBe(200);
      const reset = await resetResponse.json() as {
        schemaVersion: number;
        identity: { core: string };
        collaboration: { defaults: string[]; avoidances: string[] };
        updatedBy: string;
      };
      expect(reset.schemaVersion).toBe(2);
      expect(reset.updatedBy).toBe("user");
      expect(reset.identity.core).not.toBe("A rigorous but slightly sharper implementation partner.");
      expect(reset.collaboration.defaults.length).toBeGreaterThan(0);
    } finally {
      await gateway.stop();
      auth.resetAuthStateForTests();
      await flushAuditLogForTests();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, gatewayTestTimeoutMs);

  it("lists scene metadata from config and runtime storage through the gateway API", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-scenes-catalog-"));
    const port = 19250 + Math.floor(Math.random() * 1000);
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      gateway: {
        port,
        jwtSecret: "r".repeat(32),
      },
      scenes: {
        code_review: {
          description: "Review a repository for bugs and regressions",
          task: "Review {{repo|packages/core}} for regressions and summarize the findings.",
          allowedAgents: ["git_developer", "project_planner"],
          humanInLoopSteps: ["git_commit", "send_email"],
          approvalChannel: "ops_review",
          params: {
            repo: {
              description: "Repository path to review",
              default: "packages/core",
            },
          },
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
    await gateway.start();

    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      await waitForHealth(`${baseUrl}/healthz`);
      const token = await auth.createToken("admin", { role: "admin" });

      const createResponse = await fetch(`${baseUrl}/api/scenes/runtime_review`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          description: "Runtime review workflow",
          task: "Inspect the changed files and summarize the highest-risk regressions.",
          webhookKey: "runtime-webhook-key-123456",
        }),
      });
      expect(createResponse.status).toBe(200);

      const listResponse = await fetch(`${baseUrl}/api/scenes`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(listResponse.status).toBe(200);

      const scenes = await listResponse.json() as Array<{
        name: string;
        source: string;
        description: string;
        task: string;
        webhookKey?: string;
        allowedAgents?: string[];
        humanInLoopSteps?: string[];
        approvalChannel?: string;
        params?: Record<string, { description?: string; default?: string }>;
      }>;

      const configScene = scenes.find((scene) => scene.name === "code_review");
      expect(configScene).toMatchObject({
        source: "config",
        description: "Review a repository for bugs and regressions",
        allowedAgents: ["git_developer", "project_planner"],
        humanInLoopSteps: ["git_commit", "send_email"],
        approvalChannel: "ops_review",
      });
      expect(configScene?.params).toEqual({
        repo: {
          description: "Repository path to review",
          default: "packages/core",
        },
      });

      const runtimeScene = scenes.find((scene) => scene.name === "runtime_review");
      expect(runtimeScene).toMatchObject({
        source: "store",
        description: "Runtime review workflow",
        task: "Inspect the changed files and summarize the highest-risk regressions.",
        webhookKey: "runtime-webhook-key-123456",
      });
      expect(runtimeScene?.allowedAgents).toBeUndefined();
      expect(runtimeScene?.humanInLoopSteps).toBeUndefined();
      expect(runtimeScene?.approvalChannel).toBeUndefined();
    } finally {
      await gateway.stop();
      auth.resetAuthStateForTests();
      await flushAuditLogForTests();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, gatewayTestTimeoutMs);

  it("lists recent scene jobs and supports status filtering", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-scene-jobs-"));
    const port = 19500 + Math.floor(Math.random() * 1000);
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      gateway: {
        port,
        jwtSecret: "s".repeat(32),
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    delete process.env["SAI_JWT_SECRET"];
    process.env["SAI_MASTER_KEY"] = "m".repeat(32);
    process.env["SAI_CRED_STORE"] = join(tempDir, ".starlingai", "credentials.enc");
    process.env["SAI_AUDIT_LOG"] = join(tempDir, ".starlingai", "audit.jsonl");

    vi.resetModules();

    const [{ createGateway }, auth, jobs] = await Promise.all([
      import("../gateway/index.js"),
      import("../gateway/auth.js"),
      import("../agent/jobs.js"),
    ]);

    const gateway = createGateway();
    await gateway.start();

    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      await waitForHealth(`${baseUrl}/healthz`);

      const first = await jobs.createJob({
        sceneName: "deep_research",
        task: "Research alpha",
        params: { topic: "alpha" },
        userId: "admin",
        turnTimeoutMs: 30_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = await jobs.createJob({
        sceneName: "deep_research",
        task: "Research beta",
        params: { topic: "beta" },
        userId: "admin",
        turnTimeoutMs: 30_000,
      });
      await jobs.cancelJob(second.id);

      const token = await auth.createToken("admin", { role: "admin" });

      const listResponse = await fetch(`${baseUrl}/api/scenes/jobs?limit=10`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(listResponse.status).toBe(200);
      const listed = await listResponse.json() as { jobs: Array<{ id: string; status: string }> };
      expect(listed.jobs.map((job) => job.id)).toEqual([second.id, first.id]);

      const filteredResponse = await fetch(`${baseUrl}/api/scenes/jobs?status=cancelled`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(filteredResponse.status).toBe(200);
      const filtered = await filteredResponse.json() as { jobs: Array<{ id: string; status: string }> };
      expect(filtered.jobs).toHaveLength(1);
      expect(filtered.jobs[0]).toMatchObject({ id: second.id, status: "cancelled" });
    } finally {
      await gateway.stop();
      auth.resetAuthStateForTests();
      await flushAuditLogForTests();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, gatewayTestTimeoutMs);

  it("persists websocket auth failures to the audit log", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-audit-log-"));
    const port = 19750 + Math.floor(Math.random() * 1000);
    const configPath = join(tempDir, "starlingai.json");
    const auditLogPath = join(tempDir, ".starlingai", "audit.jsonl");

    writeFileSync(configPath, JSON.stringify({
      gateway: {
        port,
        jwtSecret: "t".repeat(32),
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    delete process.env["SAI_JWT_SECRET"];
    process.env["SAI_MASTER_KEY"] = "m".repeat(32);
    process.env["SAI_CRED_STORE"] = join(tempDir, ".starlingai", "credentials.enc");
    process.env["SAI_AUDIT_LOG"] = auditLogPath;

    vi.resetModules();

    const [{ createGateway }, audit] = await Promise.all([
      import("../gateway/index.js"),
      import("../audit/logger.js"),
    ]);

    const gateway = createGateway();
    await gateway.start();

    try {
      await waitForHealth(`http://127.0.0.1:${port}/healthz`);

      const closeCode = await waitForWebSocketClose(`ws://127.0.0.1:${port}/ws?token=invalid-token`);
      expect(closeCode).toBe(4401);

      await audit.flushAuditLog();

      const authFailures = readAuditEvents(auditLogPath).filter((event) => event.type === "auth_failure");
      expect(authFailures).toHaveLength(1);
      expect(authFailures[0]).toMatchObject({
        severity: "warn",
        data: {
          ip: expect.any(String),
        },
      });
    } finally {
      await gateway.stop();
      await flushAuditLogForTests();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, gatewayTestTimeoutMs);

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
    await gateway.start();

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
      await flushAuditLogForTests();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, gatewayTestTimeoutMs);

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
    await gateway.start();

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
        supported: true,
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
      await flushAuditLogForTests();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, gatewayTestTimeoutMs);

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
    await gateway.start();

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
      await flushAuditLogForTests();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, gatewayTestTimeoutMs);

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
    await gateway.start();

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
      expect(body.components.find((component) => component.name === "model_endpoints")).toBeTruthy();
    } finally {
      await gateway.stop();
      auth.resetAuthStateForTests();
      await flushAuditLogForTests();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, gatewayTestTimeoutMs);

  it("round-trips model routing config and persists sub-agent endpoint patches", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-model-routing-"));
    const port = 22500 + Math.floor(Math.random() * 1000);
    const upstreamPort = 25500 + Math.floor(Math.random() * 1000);
    const configPath = join(tempDir, "starlingai.json");
    const upstreamBaseUrl = `http://127.0.0.1:${upstreamPort}/v1`;

    upstreamServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          data: [
            { id: "lmstudio/orchestrator-a" },
            { id: "lmstudio/orchestrator-b" },
            { id: "embed-a" },
            { id: "embed-b" },
            { id: "reranker-a" },
            { id: "reranker-b" },
            { id: "guard-a" },
            { id: "guard-b" },
            { id: "agent-a" },
          ],
        }));
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
        jwtSecret: "h".repeat(32),
      },
      providers: {
        lmstudio: {
          baseUrl: upstreamBaseUrl,
          apiKey: "provider-key",
        },
      },
      agents: {
        defaults: {
          model: {
            primary: "lmstudio/orchestrator-a",
            baseUrl: upstreamBaseUrl,
            apiKey: "orch-key-a",
            embeddingModel: "embed-a",
            embeddingBaseUrl: upstreamBaseUrl,
            embeddingApiKey: "embed-key-a",
          },
        },
      },
      retrieval: {
        reranker: {
          enabled: true,
          model: "reranker-a",
          baseUrl: upstreamBaseUrl,
          apiKey: "rerank-key-a",
        },
      },
      guardrails: {
        modelModeration: {
          enabled: true,
          model: "guard-a",
          baseUrl: upstreamBaseUrl,
          apiKey: "guard-key-a",
        },
      },
      subAgents: {
        coder: {
          description: "Writes and edits code.",
          capabilities: ["coding"],
          tools: ["read_file"],
          model: {
            primary: "agent-a",
          },
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
    await gateway.start();

    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      await waitForHealth(`${baseUrl}/healthz`);
      const token = await auth.createToken("admin", { role: "admin" });

      const beforeResponse = await fetch(`${baseUrl}/api/model-endpoints/config`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(beforeResponse.status).toBe(200);
      const beforeBody = await beforeResponse.json() as {
        orchestrator: { primary: string; baseUrl?: string; apiKey?: string };
        embeddings: { embeddingModel?: string; embeddingBaseUrl?: string; embeddingApiKey?: string };
        reranker: { enabled: boolean; model: string; baseUrl: string; apiKey: string };
        guard: { enabled: boolean; model: string; baseUrl: string; apiKey: string };
      };
      expect(beforeBody.orchestrator).toMatchObject({
        primary: "lmstudio/orchestrator-a",
        baseUrl: upstreamBaseUrl,
        apiKey: "orch-key-a",
      });
      expect(beforeBody.embeddings).toMatchObject({
        embeddingModel: "embed-a",
        embeddingBaseUrl: upstreamBaseUrl,
        embeddingApiKey: "embed-key-a",
      });
      expect(beforeBody.reranker).toMatchObject({
        enabled: true,
        model: "reranker-a",
      });
      expect(beforeBody.guard).toMatchObject({
        enabled: true,
        model: "guard-a",
      });

      const updatePayload = {
        orchestrator: {
          primary: "lmstudio/orchestrator-b",
          baseUrl: upstreamBaseUrl,
          apiKey: "orch-key-b",
        },
        embeddings: {
          embeddingModel: "embed-b",
          embeddingBaseUrl: upstreamBaseUrl,
          embeddingApiKey: "embed-key-b",
        },
        reranker: {
          enabled: true,
          model: "reranker-b",
          baseUrl: upstreamBaseUrl,
          apiKey: "rerank-key-b",
        },
        guard: {
          enabled: true,
          model: "guard-b",
          baseUrl: upstreamBaseUrl,
          apiKey: "guard-key-b",
        },
      };

      const updateResponse = await fetch(`${baseUrl}/api/model-endpoints/config`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(updatePayload),
      });
      expect(updateResponse.status).toBe(200);
      const updateBody = await updateResponse.json() as typeof updatePayload;
      expect(updateBody).toMatchObject(updatePayload);

      const statusResponse = await fetch(`${baseUrl}/api/model-endpoints/status`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(statusResponse.status).toBe(200);
      const statusBody = await statusResponse.json() as {
        healthy: boolean;
        endpoints: Array<{ role: string; ok: boolean; matchedModel?: string }>;
      };
      expect(statusBody.healthy).toBe(true);
      expect(statusBody.endpoints.find((endpoint) => endpoint.role === "orchestrator")).toMatchObject({
        ok: true,
        matchedModel: "lmstudio/orchestrator-b",
      });
      expect(statusBody.endpoints.find((endpoint) => endpoint.role === "embeddings")).toMatchObject({
        ok: true,
        matchedModel: "embed-b",
      });

      const patchResponse = await fetch(`${baseUrl}/api/agents/coder/model`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          baseUrl: upstreamBaseUrl,
          apiKey: "agent-key",
          enableThinking: true,
        }),
      });
      expect(patchResponse.status).toBe(200);
      const patchBody = await patchResponse.json() as { model: Record<string, unknown> };
      expect(patchBody.model).toMatchObject({
        primary: "agent-a",
        baseUrl: upstreamBaseUrl,
        apiKey: "agent-key",
        enableThinking: true,
      });

      const agentsResponse = await fetch(`${baseUrl}/api/agents`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(agentsResponse.status).toBe(200);
      const agentsBody = await agentsResponse.json() as Array<{ name: string; model: Record<string, unknown> }>;
      expect(agentsBody.find((agent) => agent.name === "coder")?.model).toMatchObject({
        primary: "agent-a",
        baseUrl: upstreamBaseUrl,
        apiKey: "agent-key",
        enableThinking: true,
      });
    } finally {
      await gateway.stop();
      auth.resetAuthStateForTests();
      await flushAuditLogForTests();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, gatewayTestTimeoutMs);

  it("exposes provider runtime status for failover chains", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-provider-status-"));
    const port = 22600 + Math.floor(Math.random() * 1000);
    const upstreamPort = 25600 + Math.floor(Math.random() * 1000);
    const configPath = join(tempDir, "starlingai.json");
    const upstreamBaseUrl = `http://127.0.0.1:${upstreamPort}/v1`;

    upstreamServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          data: [
            { id: "lmstudio/orchestrator-a" },
            { id: "lmstudio/orchestrator-b" },
          ],
        }));
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
        jwtSecret: "i".repeat(32),
      },
      providers: {
        lmstudio: {
          baseUrl: upstreamBaseUrl,
          apiKey: "provider-key",
          timeoutMs: 45_000,
          maxRetries: 2,
        },
      },
      agents: {
        defaults: {
          model: {
            primary: "lmstudio/orchestrator-a",
            fallback: "lmstudio/orchestrator-b",
            baseUrl: upstreamBaseUrl,
            apiKey: "orch-key-a",
            maxTokens: 2048,
          },
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
    await gateway.start();

    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      await waitForHealth(`${baseUrl}/healthz`);
      const token = await auth.createToken("admin", { role: "admin" });

      const response = await fetch(`${baseUrl}/api/providers/status`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(response.status).toBe(200);
      const body = await response.json() as {
        healthy: boolean;
        mode: string;
        activeModel?: string;
        endpoints: Array<{
          priority: string;
          active: boolean;
          healthy: boolean;
          requestTimeoutMs?: number;
          configuredMaxRetries?: number;
          lastHealthCheckAt?: string;
        }>;
      };

      expect(body.healthy).toBe(true);
      expect(body.mode).toBe("failover");
      expect(body.activeModel).toBe("lmstudio/orchestrator-a");
      expect(body.endpoints).toHaveLength(2);
      expect(body.endpoints.find((endpoint) => endpoint.priority === "primary")).toMatchObject({
        active: true,
        healthy: true,
        requestTimeoutMs: 71_200,
        configuredMaxRetries: 2,
      });
      expect(body.endpoints.find((endpoint) => endpoint.priority === "primary")?.lastHealthCheckAt).toBeTruthy();
      expect(body.endpoints.find((endpoint) => endpoint.priority === "fallback")).toMatchObject({
        active: false,
        healthy: true,
        requestTimeoutMs: 71_200,
        configuredMaxRetries: 2,
      });
    } finally {
      await gateway.stop();
      auth.resetAuthStateForTests();
      await flushAuditLogForTests();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, gatewayTestTimeoutMs);

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
    await gateway.start();

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
      await flushAuditLogForTests();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, gatewayTestTimeoutMs);

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
        res.end(JSON.stringify({ models: { "Qwen/Qwen3-TTS-12Hz-0.6B-Instruct": { capabilities: ["tts", "voice_clone", "custom_voice"] } }, current_model: "Qwen/Qwen3-TTS-12Hz-0.6B-Instruct" }));
        return;
      }

      if (req.method === "POST" && req.url === "/voices/save") {
        expect(req.headers["content-type"]).toContain("multipart/form-data");
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          expect(body).toContain('name="name"');
          expect(body).toContain("Steffen Voice");
          expect(body).toContain('name="lang"');
          expect(body).toContain("English");
          expect(body).toContain('name="ref_text"');
          expect(body).toContain("Hallo aus dem Beispielclip");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", voice_id: "saved-steffen", name: "Steffen Voice", ref_text: "hello from the saved profile" }));
        });
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
        stt: { baseUrl: `http://127.0.0.1:${upstreamPort}`, model: "Qwen/Qwen3-ASR-1.7B" },
        tts: { baseUrl: `http://127.0.0.1:${upstreamPort}`, api: "qwen-compatible", defaultSpeaker: "Vivian" },
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
    await gateway.start();

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

      const saveVoiceForm = new FormData();
      saveVoiceForm.append("name", "Steffen Voice");
      saveVoiceForm.append("language", "English");
      saveVoiceForm.append("referenceText", "Hallo aus dem Beispielclip");
      saveVoiceForm.append("file", new File([new Uint8Array([5, 6, 7, 8])], "voice.wav", { type: "audio/wav" }));
      const saveVoiceResponse = await fetch(`${baseUrl}/api/multimodal/voices/save`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: saveVoiceForm,
      });
      expect(saveVoiceResponse.status).toBe(200);
      const saveVoiceBody = await saveVoiceResponse.json() as { voice_id: string; name: string };
      expect(saveVoiceBody).toMatchObject({ voice_id: "saved-steffen", name: "Steffen Voice" });

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
          model: "Qwen/Qwen3-TTS-12Hz-0.6B-Instruct",
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
      await flushAuditLogForTests();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, gatewayTestTimeoutMs);

  it("falls back to plain qwen TTS when config supplies a default voice sample but the selected model lacks voice_clone", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-multimodal-fallback-"));
    const port = 23500 + Math.floor(Math.random() * 1000);
    const upstreamPort = 24500 + Math.floor(Math.random() * 1000);
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(join(tempDir, "voice-sample.wav"), Buffer.from([0x52, 0x49, 0x46, 0x46]));

    upstreamServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.url === "/health" || req.url === "/api/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "healthy" }));
        return;
      }

      if (req.method === "GET" && req.url === "/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ models: { "Qwen/Qwen3-TTS-12Hz-1.7B": { capabilities: ["tts"] } }, current_model: "Qwen/Qwen3-TTS-12Hz-1.7B" }));
        return;
      }

      if (req.method === "POST" && req.url === "/load_model") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      if (req.method === "POST" && req.url === "/tts") {
        let rawBody = "";
        req.on("data", (chunk: Buffer) => { rawBody += chunk.toString(); });
        req.on("end", () => {
          const body = JSON.parse(rawBody) as { text: string; speaker: string };
          expect(body.text).toBe("fallback speech");
          expect(body.speaker).toBe("Vivian");
          res.writeHead(200, { "Content-Type": "audio/wav" });
          res.end(Buffer.from("RIFFfallback"));
        });
        return;
      }

      if (req.url?.startsWith("/clone") || req.url?.includes("/voices/save")) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "clone path should not be called" }));
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
      workspacePath: tempDir,
      multimodal: {
        tts: {
          baseUrl: `http://127.0.0.1:${upstreamPort}`,
          api: "qwen-compatible",
          model: "Qwen/Qwen3-TTS-12Hz-1.7B",
          defaultSpeaker: "Vivian",
          voiceSamplePath: "voice-sample.wav",
          voiceSampleText: "sample voice",
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
    await gateway.start();

    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      await waitForHealth(`${baseUrl}/healthz`);
      const token = await auth.createToken("admin", { role: "admin" });

      const ttsResponse = await fetch(`${baseUrl}/api/multimodal/tts`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: "fallback speech" }),
      });

      expect(ttsResponse.status).toBe(200);
      expect(ttsResponse.headers.get("content-type")).toContain("audio/wav");
      const ttsBytes = Buffer.from(await ttsResponse.arrayBuffer());
      expect(ttsBytes.subarray(0, 4).toString()).toBe("RIFF");
    } finally {
      await gateway.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, gatewayTestTimeoutMs);

  it("splits long qwen TTS requests into smaller synth calls and merges the WAV output", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-multimodal-chunked-"));
    const port = 25700 + Math.floor(Math.random() * 1000);
    const upstreamPort = 26700 + Math.floor(Math.random() * 1000);
    const configPath = join(tempDir, "starlingai.json");
    const upstreamTexts: string[] = [];

    upstreamServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.url === "/health" || req.url === "/api/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "healthy" }));
        return;
      }

      if (req.method === "GET" && req.url === "/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          models: {
            "Qwen/Qwen3-TTS-12Hz-0.6B-Instruct": { capabilities: ["tts", "custom_voice"] },
          },
          current_model: "Qwen/Qwen3-TTS-12Hz-0.6B-Instruct",
        }));
        return;
      }

      if (req.method === "POST" && req.url === "/load_model") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      if (req.method === "POST" && req.url === "/tts") {
        let rawBody = "";
        req.on("data", (chunk: Buffer) => { rawBody += chunk.toString(); });
        req.on("end", () => {
          const body = JSON.parse(rawBody) as { text: string; speaker: string };
          upstreamTexts.push(body.text);
          expect(body.speaker).toBe("Vivian");
          expect(body.text.length).toBeLessThanOrEqual(DEFAULT_TTS_CHUNK_MAX_CHARS);
          const wav = createPcmWav(upstreamTexts.length + 2, upstreamTexts.length * 100);
          res.writeHead(200, { "Content-Type": "audio/wav" });
          res.end(wav);
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
        tts: {
          baseUrl: `http://127.0.0.1:${upstreamPort}`,
          api: "qwen-compatible",
          model: "Qwen/Qwen3-TTS-12Hz-0.6B-Instruct",
          defaultLanguage: "English",
          defaultSpeaker: "Vivian",
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
    await gateway.start();

    const baseUrl = `http://127.0.0.1:${port}`;
    const longText = Array.from(
      { length: 12 },
      (_, index) => `Sentence ${index + 1} explains how StarlingAI should keep each text to speech request small enough to avoid CUDA memory spikes.`,
    ).join(" ");

    try {
      await waitForHealth(`${baseUrl}/healthz`);
      const token = await auth.createToken("admin", { role: "admin" });

      const response = await fetch(`${baseUrl}/api/multimodal/tts`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: longText }),
      });

      expect(response.status).toBe(200);
      expect(upstreamTexts.length).toBeGreaterThan(1);
      const wav = Buffer.from(await response.arrayBuffer());
      expect(wav.subarray(0, 4).toString()).toBe("RIFF");
      expect(readPcmWavDataSize(wav)).toBe(upstreamTexts.reduce((sum, _text, index) => sum + ((index + 3) * 2), 0));
    } finally {
      await gateway.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, gatewayTestTimeoutMs);

  it("returns a clear error when plain qwen TTS is requested against a voice-clone-only model", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-multimodal-voice-clone-only-"));
    const port = 24600 + Math.floor(Math.random() * 1000);
    const upstreamPort = 25600 + Math.floor(Math.random() * 1000);
    const configPath = join(tempDir, "starlingai.json");

    upstreamServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "healthy" }));
        return;
      }

      if (req.method === "GET" && req.url === "/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          models: { "Qwen/Qwen3-TTS-12Hz-1.7B-Base": { name: "1.7B Base", capabilities: ["tts", "voice_clone"] } },
          current_model: "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
        }));
        return;
      }

      if (req.method === "POST" && req.url === "/load_model") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      if (req.method === "POST" && req.url === "/tts") {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "gateway should reject before reaching upstream /tts" }));
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
        tts: {
          baseUrl: `http://127.0.0.1:${upstreamPort}`,
          api: "qwen-compatible",
          model: "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
          defaultSpeaker: "Vivian",
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
    await gateway.start();

    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      await waitForHealth(`${baseUrl}/healthz`);
      const token = await auth.createToken("admin", { role: "admin" });

      const ttsResponse = await fetch(`${baseUrl}/api/multimodal/tts`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: "plain speech" }),
      });

      expect(ttsResponse.status).toBe(400);
      await expect(ttsResponse.json()).resolves.toMatchObject({
        error: expect.stringContaining("does not support built-in speaker synthesis"),
      });
    } finally {
      await gateway.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, gatewayTestTimeoutMs);
});

async function waitForHealth(url: string): Promise<void> {
  const deadline = Date.now() + 15_000;

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
  const deadline = Date.now() + 15_000;

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

async function waitForWebSocketClose(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error(`WebSocket did not close in time: ${url}`));
    }, 5_000);

    socket.once("close", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });

    socket.once("unexpected-response", (_request, response) => {
      clearTimeout(timeout);
      reject(new Error(`Unexpected websocket HTTP response: ${response.statusCode ?? "unknown"}`));
    });

    socket.once("error", () => {
      // Connection failures still surface a close event for auth rejection.
    });
  });
}

function readAuditEvents(auditLogPath: string): Array<{
  type: string;
  severity?: string;
  data?: Record<string, unknown>;
}> {
  if (!existsSync(auditLogPath)) return [];
  return readFileSync(auditLogPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as {
      type: string;
      severity?: string;
      data?: Record<string, unknown>;
    });
}

async function flushAuditLogForTests(): Promise<void> {
  try {
    const audit = await import("../audit/logger.js");
    await audit.flushAuditLog();
  } catch {
    // Some tests may not load the audit logger.
  }
}