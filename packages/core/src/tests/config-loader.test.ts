import { afterEach, describe, expect, it, vi } from "vitest";
import { PRODUCT } from "../product/index.js";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import JSON5 from "json5";

function wait(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

// Sub-agents are organized into role-based files under workspace/agents/ (orchestration,
// research-analysis, authoring-content, engineering, …). These tests assert prompt/tool
// CONTENT, not file layout, so merge every *.jsonc subAgents map rather than hardcoding a file.
function loadWorkspaceSubAgents(): Record<string, { systemPrompt?: string; tools?: string[] }> {
  const dir = resolve(process.cwd(), "../../workspace/agents");
  const merged: Record<string, { systemPrompt?: string; tools?: string[] }> = {};
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".jsonc")) continue;
    const raw = JSON5.parse(readFileSync(join(dir, file), "utf8")) as {
      subAgents?: Record<string, { systemPrompt?: string; tools?: string[] }>;
    };
    Object.assign(merged, raw.subAgents ?? {});
  }
  return merged;
}

describe("config loader mutable overlay", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    delete process.env["SAI_WORKSPACE_CONFIG_PATH"];
    delete process.env["SAI_MUTABLE_CONFIG_PATH"];
    delete process.env["SAI_LMSTUDIO_URL"];
    delete process.env["SAI_LMSTUDIO_API_KEY"];
    delete process.env["SAI_DEFAULT_MODEL"];
    delete process.env["SAI_PRIMARY_MODEL_URL"];
    delete process.env["SAI_PRIMARY_MODEL_KEY"];
    delete process.env["SAI_PRIMARY_MODEL"];
    delete process.env["SAI_FALLBACK_MODEL"];
    delete process.env["SAI_EMBEDDING_MODEL"];
    delete process.env["SAI_ROUTING_MODEL"];
    for (const k of ["SAI_AUTH_PROVIDER", "SAI_OIDC_ISSUER", "SAI_OIDC_CLIENT_ID", "SAI_OIDC_CLIENT_SECRET", "SAI_OIDC_PUBLIC_URL", "SAI_OIDC_A2A_ENABLED"]) delete process.env[k];
    for (const k of ["SAI_STORAGE_BACKEND", "SAI_S3_ENDPOINT", "SAI_S3_BUCKET", "SAI_S3_REGION", "SAI_S3_ACCESS_KEY_ID", "SAI_S3_SECRET_ACCESS_KEY", "SAI_S3_FORCE_PATH_STYLE", "SAI_UPLOAD_SCAN", "SAI_CLAMD_HOST", "SAI_CLAMD_PORT"]) delete process.env[k];
    vi.restoreAllMocks();
    vi.resetModules();

    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
  });

  it("writes dashboard updates to the mutable overlay when configured", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-config-overlay-"));
    const baseConfigPath = join(tempDir, "starlingai.base.json");
    const mutableConfigPath = join(tempDir, "starlingai.runtime.json");

    writeFileSync(baseConfigPath, JSON.stringify({
      multimodal: {
        maxUploadBytes: 1_048_576,
        files: {
          baseUrl: "http://files-base",
          timeoutMs: 30_000,
          toolName: "file_to_markdown",
        },
        stt: {
          baseUrl: "http://stt-base",
          timeoutMs: 30_000,
          model: "Qwen/Qwen3-ASR-1.7B",
        },
        tts: {
          baseUrl: "http://tts-base",
          timeoutMs: 30_000,
          model: "Qwen/Qwen3-TTS-12Hz-0.6B-Instruct",
          defaultLanguage: "English",
          defaultSpeaker: "Vivian",
          defaultQuality: "medium",
        },
        wakeWord: {
          enabled: false,
          language: "en-US",
          keywords: ["Luna"],
          stopPhrases: ["stop listening"],
          silenceTimeoutMs: 4000,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = baseConfigPath;
    process.env["SAI_MUTABLE_CONFIG_PATH"] = mutableConfigPath;
    vi.resetModules();

    const configLoader = await import("../config/loader.js");

    try {
      const initialConfig = configLoader.loadConfig();
      expect(initialConfig.multimodal.stt.model).toBe("Qwen/Qwen3-ASR-1.7B");
      expect(existsSync(mutableConfigPath)).toBe(false);

      const updatedConfig = configLoader.updateConfig((raw) => {
        raw["multimodal"] = {
          maxUploadBytes: 4_194_304,
          files: {
            baseUrl: "http://files-overlay",
            timeoutMs: 45_000,
            toolName: "file_to_markdown",
          },
          stt: {
            baseUrl: "http://stt-overlay",
            timeoutMs: 45_000,
            model: "Qwen/Qwen3-ASR-1.7B-quantized",
          },
          tts: {
            baseUrl: "http://tts-overlay",
            timeoutMs: 45_000,
            model: "Qwen/Qwen3-TTS-12Hz-0.6B-Instruct",
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
      });

      expect(updatedConfig.multimodal.stt.model).toBe("Qwen/Qwen3-ASR-1.7B-quantized");
      expect(updatedConfig.multimodal.wakeWord.language).toBe("de-DE");
      expect(existsSync(mutableConfigPath)).toBe(true);

      const baseContents = readFileSync(baseConfigPath, "utf8");
      expect(baseContents).toContain("Qwen/Qwen3-ASR-1.7B");
      expect(baseContents).not.toContain("Qwen/Qwen3-ASR-1.7B-quantized");

      const mutableContents = readFileSync(mutableConfigPath, "utf8");
      expect(mutableContents).toContain("Qwen/Qwen3-ASR-1.7B-quantized");
      expect(mutableContents).toContain("Hallo Guarded");

      configLoader.resetConfigForTests();
      const reloadedConfig = configLoader.loadConfig();
      expect(reloadedConfig.multimodal.stt.model).toBe("Qwen/Qwen3-ASR-1.7B-quantized");
      expect(reloadedConfig.multimodal.files.baseUrl).toBe("http://files-overlay");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("loads split config shards from a config directory", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-config-directory-"));
    const configDir = join(tempDir, "starling_config");
    mkdirSync(join(configDir, "agents"), { recursive: true });
    mkdirSync(join(configDir, "providers"), { recursive: true });
    mkdirSync(join(configDir, "channels"), { recursive: true });

    writeFileSync(join(configDir, "agents", "10-defaults.jsonc"), `{
      // Agent defaults can live in their own shard.
      agents: {
        defaults: {
          model: {
            primary: "lmstudio/qwen/qwen3.6-35b-a3b"
          }
        }
      }
    }\n`, "utf8");

    writeFileSync(join(configDir, "agents", "20-runtime.json"), JSON.stringify({
      agents: {
        mainAssistant: {
          toolMode: "delegate_only",
          customInstructions: "Prefer terse checklists unless the user asks for depth.",
        },
        rateLimit: {
          requestsPerMinute: 15,
        },
      },
    }, null, 2), "utf8");

    writeFileSync(join(configDir, "providers", "10-lmstudio.json"), JSON.stringify({
      providers: {
        lmstudio: {
          baseUrl: "http://split-config-lmstudio:1234/v1",
          apiKey: "lm-studio",
        },
      },
    }, null, 2), "utf8");

    writeFileSync(join(configDir, "channels", "10-webchat.json"), JSON.stringify({
      channels: {
        webchat: {
          enabled: true,
          port: 3301,
        },
      },
    }, null, 2), "utf8");

    process.env["SAI_CONFIG_PATH"] = configDir;
    vi.resetModules();

    const configLoader = await import("../config/loader.js");

    try {
      const config = configLoader.loadConfig();
      const compiledPath = join(tempDir, PRODUCT.configFileName);

      expect(config.agents.defaults.model.primary).toBe("lmstudio/qwen/qwen3.6-35b-a3b");
      expect(config.agents.mainAssistant.toolMode).toBe("delegate_only");
      expect(config.agents.mainAssistant.customInstructions).toBe("Prefer terse checklists unless the user asks for depth.");
      expect(config.agents.rateLimit.requestsPerMinute).toBe(15);
      expect(config.providers.lmstudio?.baseUrl).toBe("http://split-config-lmstudio:1234/v1");
      expect(config.channels.webchat.port).toBe(3301);
      expect(existsSync(compiledPath)).toBe(true);
      expect(readFileSync(compiledPath, "utf8")).toContain('"delegate_only"');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("overrides LM Studio baseUrl and apiKey from environment variables", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-config-env-lmstudio-"));
    const baseConfigPath = join(tempDir, "starlingai.json");

    writeFileSync(baseConfigPath, JSON.stringify({
      providers: {
        lmstudio: {
          baseUrl: "http://config-lmstudio:1234/v1",
          apiKey: "config-api-key",
          timeoutMs: 30000,
          maxRetries: 3,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = baseConfigPath;
    process.env["SAI_LMSTUDIO_URL"] = "http://env-lmstudio:1234/v1";
    process.env["SAI_LMSTUDIO_API_KEY"] = "env-api-key";
    vi.resetModules();

    const configLoader = await import("../config/loader.js");

    try {
      const config = configLoader.loadConfig();

      expect(config.providers.lmstudio?.baseUrl).toBe("http://env-lmstudio:1234/v1");
      expect(config.providers.lmstudio?.apiKey).toBe("env-api-key");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("overrides the primary provider from the neutral SAI_PRIMARY_MODEL_* vars (which win over the SAI_LMSTUDIO_* aliases)", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-config-env-primary-"));
    const baseConfigPath = join(tempDir, "starlingai.json");
    writeFileSync(baseConfigPath, JSON.stringify({
      providers: { lmstudio: { baseUrl: "http://config:1234/v1", apiKey: "config-key" } },
      agents: { defaults: { model: { primary: "lmstudio/config-model" } } },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = baseConfigPath;
    // The neutral primary vars point at a DIFFERENT engine (Ollama) and must win over the
    // legacy lmstudio aliases set alongside them.
    process.env["SAI_PRIMARY_MODEL_URL"] = "http://ollama:11434/v1";
    process.env["SAI_PRIMARY_MODEL_KEY"] = "primary-key";
    process.env["SAI_PRIMARY_MODEL"] = "lmstudio/llama3.3";
    process.env["SAI_LMSTUDIO_URL"] = "http://legacy:1234/v1";
    process.env["SAI_LMSTUDIO_API_KEY"] = "legacy-key";
    vi.resetModules();
    const configLoader = await import("../config/loader.js");
    try {
      const config = configLoader.loadConfig();
      expect(config.providers.lmstudio?.baseUrl).toBe("http://ollama:11434/v1");
      expect(config.providers.lmstudio?.apiKey).toBe("primary-key");
      expect(config.agents.defaults.model.primary).toBe("lmstudio/llama3.3");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("still honors the legacy SAI_LMSTUDIO_* aliases when the neutral vars are unset (back-compat)", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-config-env-alias-"));
    const baseConfigPath = join(tempDir, "starlingai.json");
    writeFileSync(baseConfigPath, JSON.stringify({
      providers: { lmstudio: { baseUrl: "http://config:1234/v1", apiKey: "config-key" } },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = baseConfigPath;
    process.env["SAI_LMSTUDIO_URL"] = "http://legacy:1234/v1";
    process.env["SAI_LMSTUDIO_API_KEY"] = "legacy-key";
    vi.resetModules();
    const configLoader = await import("../config/loader.js");
    try {
      const config = configLoader.loadConfig();
      expect(config.providers.lmstudio?.baseUrl).toBe("http://legacy:1234/v1");
      expect(config.providers.lmstudio?.apiKey).toBe("legacy-key");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("overrides the default agent model from SAI_DEFAULT_MODEL (Docker-only wizard wiring)", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-config-env-model-"));
    const baseConfigPath = join(tempDir, "starlingai.json");

    writeFileSync(baseConfigPath, JSON.stringify({
      agents: {
        defaults: {
          model: { primary: "lmstudio/qwen/qwen3.6-35b-a3b", temperature: 0.4 },
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = baseConfigPath;
    process.env["SAI_DEFAULT_MODEL"] = "ollama/qwen2.5:7b";
    vi.resetModules();

    const configLoader = await import("../config/loader.js");

    try {
      const config = configLoader.loadConfig();
      expect(config.agents.defaults.model.primary).toBe("ollama/qwen2.5:7b");
      // Sibling fields under the same model block are preserved.
      expect(config.agents.defaults.model.temperature).toBe(0.4);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("SAI_PRIMARY_MODEL seeds fallback too (single-model backend has no separate fallback)", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-config-fallback-"));
    const baseConfigPath = join(tempDir, "starlingai.json");
    writeFileSync(baseConfigPath, JSON.stringify({
      agents: { defaults: { model: {
        primary: "lmstudio/qwen/qwen3.6-35b-a3b",
        fallback: "lmstudio/qwen/qwen3.6-35b-a3b",
      } } },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = baseConfigPath;
    process.env["SAI_PRIMARY_MODEL"] = "anthropic/claude-sonnet-4-6";
    vi.resetModules();
    const configLoader = await import("../config/loader.js");
    try {
      const model = configLoader.loadConfig().agents.defaults.model;
      expect(model.primary).toBe("anthropic/claude-sonnet-4-6");
      // The Qwen fallback would point Anthropic at a model it doesn't serve — follow primary.
      expect(model.fallback).toBe("anthropic/claude-sonnet-4-6");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("overrides fallback / embedding / routing tiers from their own env vars (empty = disable)", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-config-tiers-"));
    const baseConfigPath = join(tempDir, "starlingai.json");
    writeFileSync(baseConfigPath, JSON.stringify({
      agents: { defaults: { model: {
        primary: "lmstudio/qwen/qwen3.6-35b-a3b",
        fallback: "lmstudio/qwen/qwen3.6-35b-a3b",
        embeddingModel: "lmstudio/text-embedding-qwen3-embedding-0.6b",
        tiers: { routing: "lmstudio/qwen/qwen3.5-9b" },
      } } },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = baseConfigPath;
    process.env["SAI_PRIMARY_MODEL"] = "anthropic/claude-sonnet-4-6";
    process.env["SAI_FALLBACK_MODEL"] = "anthropic/claude-haiku-4-6";
    process.env["SAI_EMBEDDING_MODEL"] = ""; // disable vector embeddings (RAG → keyword)
    process.env["SAI_ROUTING_MODEL"] = ""; // disable the fast-lane
    vi.resetModules();
    const configLoader = await import("../config/loader.js");
    try {
      const model = configLoader.loadConfig().agents.defaults.model;
      expect(model.primary).toBe("anthropic/claude-sonnet-4-6");
      // Explicit fallback override wins over the primary-seeded default.
      expect(model.fallback).toBe("anthropic/claude-haiku-4-6");
      // Empty string means "disable this tier", not "leave the pinned Qwen id".
      expect(model.embeddingModel).toBe("");
      expect(model.tiers?.routing).toBe("");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("enables OIDC SSO from SAI_AUTH_PROVIDER + SAI_OIDC_* env (secret kept as a ref)", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-config-oidc-"));
    const baseConfigPath = join(tempDir, "starlingai.json");
    writeFileSync(baseConfigPath, JSON.stringify({ gateway: { port: 8765 } }), "utf8");
    process.env["SAI_CONFIG_PATH"] = baseConfigPath;
    process.env["SAI_AUTH_PROVIDER"] = "oidc";
    process.env["SAI_OIDC_ISSUER"] = "http://keycloak:8080/realms/starlingai";
    process.env["SAI_OIDC_CLIENT_ID"] = "starlingai";
    process.env["SAI_OIDC_CLIENT_SECRET"] = "super-secret-value";
    process.env["SAI_OIDC_A2A_ENABLED"] = "true";
    process.env["SAI_OIDC_A2A_AUDIENCE"] = "starlingai-a2a"; // required when a2a is enabled
    vi.resetModules();
    const configLoader = await import("../config/loader.js");
    try {
      const auth = configLoader.loadConfig().auth;
      expect(auth.enabled).toBe(true);
      expect(auth.provider).toBe("oidc");
      expect(auth.oidc?.issuer).toBe("http://keycloak:8080/realms/starlingai");
      expect(auth.oidc?.clientId).toBe("starlingai");
      // The secret is stored as a $ENV REF, never the raw value — so it stays out
      // of the compiled config; oidc.ts resolves it from env at runtime.
      expect(auth.oidc?.clientSecret).toBe("$SAI_OIDC_CLIENT_SECRET");
      expect(auth.oidc?.a2a.enabled).toBe(true);
      expect(auth.oidc?.a2a.audience).toBe("starlingai-a2a");
    } finally {
      delete process.env["SAI_OIDC_A2A_ENABLED"];
      delete process.env["SAI_OIDC_A2A_AUDIENCE"];
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("enables S3 upload storage + scanning from SAI_STORAGE_* / SAI_S3_* / SAI_UPLOAD_SCAN env", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-config-storage-"));
    const baseConfigPath = join(tempDir, "starlingai.json");
    writeFileSync(baseConfigPath, JSON.stringify({ gateway: { port: 8765 } }), "utf8");
    process.env["SAI_CONFIG_PATH"] = baseConfigPath;
    process.env["SAI_STORAGE_BACKEND"] = "s3";
    process.env["SAI_S3_ENDPOINT"] = "http://seaweedfs:8333";
    process.env["SAI_S3_BUCKET"] = "uploads";
    process.env["SAI_S3_ACCESS_KEY_ID"] = "AKIA-value";
    process.env["SAI_S3_SECRET_ACCESS_KEY"] = "secret-value";
    process.env["SAI_UPLOAD_SCAN"] = "true";
    process.env["SAI_CLAMD_HOST"] = "clamav";
    vi.resetModules();
    const configLoader = await import("../config/loader.js");
    try {
      const storage = configLoader.loadConfig().storage;
      expect(storage.backend).toBe("s3");
      expect(storage.s3.endpoint).toBe("http://seaweedfs:8333");
      expect(storage.s3.bucket).toBe("uploads");
      // Keys are kept as $ENV REFS, not the raw values.
      expect(storage.s3.accessKeyId).toBe("$SAI_S3_ACCESS_KEY_ID");
      expect(storage.s3.secretAccessKey).toBe("$SAI_S3_SECRET_ACCESS_KEY");
      expect(storage.scan.enabled).toBe(true);
      expect(storage.scan.clamdHost).toBe("clamav");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("defaults the interactive orchestrator turn ceiling to 10 minutes", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-config-turn-timeout-"));
    const baseConfigPath = join(tempDir, "starlingai.json");
    writeFileSync(baseConfigPath, JSON.stringify({ gateway: { port: 8765 } }), "utf8");

    process.env["SAI_CONFIG_PATH"] = baseConfigPath;
    vi.resetModules();
    const configLoader = await import("../config/loader.js");

    try {
      // A stuck coordinator cascade must not be able to churn for half an hour;
      // the hard interactive ceiling is 10 min (was 30 min). Scenes/jobs set
      // their own per-job timeout and are unaffected.
      expect(configLoader.loadConfig().gateway.turnTimeoutMs).toBe(600000);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("writes runtime updates into runtime.overrides.json for directory configs", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-config-directory-overlay-"));
    const configDir = join(tempDir, "starling_config");
    const overlayPath = join(configDir, "runtime", "runtime.overrides.json");
    mkdirSync(join(configDir, "multimodal"), { recursive: true });

    writeFileSync(join(configDir, "multimodal", "10-core.json"), JSON.stringify({
      multimodal: {
        maxUploadBytes: 1_048_576,
        files: {
          baseUrl: "http://files-base",
          timeoutMs: 30_000,
          toolName: "file_to_markdown",
        },
        stt: {
          baseUrl: "http://stt-base",
          timeoutMs: 30_000,
          model: "Qwen/Qwen3-ASR-1.7B",
        },
      },
    }, null, 2), "utf8");

    process.env["SAI_CONFIG_PATH"] = configDir;
    vi.resetModules();

    const configLoader = await import("../config/loader.js");

    try {
      const initialConfig = configLoader.loadConfig();
      expect(initialConfig.multimodal.files.baseUrl).toBe("http://files-base");
      expect(existsSync(overlayPath)).toBe(false);

      const updatedConfig = configLoader.updateConfig((raw) => {
        raw["multimodal"] = {
          maxUploadBytes: 4_194_304,
          files: {
            baseUrl: "http://files-overlay",
            timeoutMs: 30_000,
            toolName: "file_to_markdown",
          },
          stt: {
            baseUrl: "http://stt-base",
            timeoutMs: 30_000,
            model: "Qwen/Qwen3-ASR-1.7B",
          },
        };
      });

      expect(updatedConfig.multimodal.maxUploadBytes).toBe(4_194_304);
      expect(updatedConfig.multimodal.files.baseUrl).toBe("http://files-overlay");
      expect(existsSync(overlayPath)).toBe(true);

      const baseContents = readFileSync(join(configDir, "multimodal", "10-core.json"), "utf8");
      expect(baseContents).toContain("http://files-base");
      expect(baseContents).not.toContain("http://files-overlay");

      const overlayContents = JSON5.parse(readFileSync(overlayPath, "utf8")) as {
        multimodal?: {
          maxUploadBytes?: number;
          files?: {
            baseUrl?: string;
            timeoutMs?: number;
            toolName?: string;
          };
          stt?: {
            model?: string;
          };
        };
      };

      expect(overlayContents.multimodal?.maxUploadBytes).toBe(4_194_304);
      expect(overlayContents.multimodal?.files?.baseUrl).toBe("http://files-overlay");
      expect(overlayContents.multimodal?.files?.toolName).toBeUndefined();
      expect(overlayContents.multimodal?.stt?.model).toBeUndefined();

      configLoader.resetConfigForTests();
      const reloadedConfig = configLoader.loadConfig();
      expect(reloadedConfig.multimodal.files.baseUrl).toBe("http://files-overlay");
      expect(reloadedConfig.multimodal.stt.model).toBe("Qwen/Qwen3-ASR-1.7B");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps a base-shard key REMOVED via updateConfig removed across reloads (tombstone)", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-config-tombstone-"));
    const configDir = join(tempDir, "starling_config");
    const overlayPath = join(configDir, "runtime", "runtime.overrides.json");
    mkdirSync(join(configDir, "providers"), { recursive: true });

    // Base shard defines an optional provider block.
    writeFileSync(join(configDir, "providers", "10-core.json"), JSON.stringify({
      providers: {
        lmstudio: { baseUrl: "http://lm:1234/v1", apiKey: "lm-studio", timeoutMs: 30_000, maxRetries: 3 },
      },
    }, null, 2), "utf8");

    process.env["SAI_CONFIG_PATH"] = configDir;
    vi.resetModules();
    const configLoader = await import("../config/loader.js");

    try {
      expect(configLoader.loadConfig().providers.lmstudio?.baseUrl).toBe("http://lm:1234/v1");

      // Delete the base-shard key through updateConfig.
      const updated = configLoader.updateConfig((raw) => {
        delete (raw["providers"] as Record<string, unknown>)["lmstudio"];
      });
      expect(updated.providers.lmstudio).toBeUndefined();

      // The overlay records an explicit tombstone (not just an absence).
      const overlay = JSON5.parse(readFileSync(overlayPath, "utf8")) as { providers?: Record<string, unknown> };
      expect(overlay.providers?.["lmstudio"]).toBe("__sai_deleted__");

      // The deletion SURVIVES a reload (previously the base merge silently re-added it).
      configLoader.resetConfigForTests();
      expect(configLoader.loadConfig().providers.lmstudio).toBeUndefined();

      // Re-adding it through a later update overrides the tombstone.
      const readded = configLoader.updateConfig((raw) => {
        (raw["providers"] as Record<string, unknown>)["lmstudio"] = { baseUrl: "http://lm2:1234/v1", apiKey: "k", timeoutMs: 30_000, maxRetries: 3 };
      });
      expect(readded.providers.lmstudio?.baseUrl).toBe("http://lm2:1234/v1");
      configLoader.resetConfigForTests();
      expect(configLoader.loadConfig().providers.lmstudio?.baseUrl).toBe("http://lm2:1234/v1");
    } finally {
      configLoader.resetConfigForTests();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("ships a pentest coordinator prompt that forbids false start claims", () => {
    const rootConfigPath = resolve(process.cwd(), "../../starlingai.example.json");
    const raw = JSON5.parse(readFileSync(rootConfigPath, "utf8")) as {
      subAgents?: Record<string, { systemPrompt?: string }>;
    };

    const prompt = raw.subAgents?.["pentest_coordinator"]?.systemPrompt ?? "";

    expect(prompt).toContain("your next response MUST be a tool call, not a status update");
    expect(prompt).toContain("Never say the pentest has started");
    expect(prompt).toContain("successful `pentest_set_scope` call");
    expect(prompt).toContain("successful delegation/orchestration call in the same turn");
    expect(prompt).toContain("treat that as sufficient and do not ask the user to confirm it again");
    expect(prompt).toContain("Do not invent ad-hoc specialists");
  });

  it("ships writer-style workspace agents that escalate missing evidence instead of drafting placeholders", () => {
    const subAgents = loadWorkspaceSubAgents();

    const paperAuthor = subAgents["paper_author"];
    const summarizer = subAgents["summarizer"];
    const meetingBriefingAgent = subAgents["meeting_briefing_agent"];

    expect(paperAuthor?.tools).toEqual(expect.arrayContaining(["search_agents", "delegate_to_agent"]));
    expect(summarizer?.tools).toEqual(expect.arrayContaining(["search_agents", "delegate_to_agent"]));
    expect(meetingBriefingAgent?.tools).toEqual(expect.arrayContaining(["search_agents", "delegate_to_agent"]));

    expect(paperAuthor?.systemPrompt).toContain("do not draft a placeholder paper or generic report");
    expect(paperAuthor?.systemPrompt).toContain("evidence must be collected before drafting can begin");
    expect(summarizer?.systemPrompt).toContain("do not improvise a summary from assumptions");
    expect(meetingBriefingAgent?.systemPrompt).toContain("do not invent status updates or placeholder conclusions");
  });

  it("ships coordinator and review prompts that treat missing artifact access as a review-input issue", () => {
    const subAgents = loadWorkspaceSubAgents();

    const missionCoordinator = subAgents["mission_coordinator"];
    const qualitySupervisor = subAgents["quality_supervisor"];

    expect(missionCoordinator?.systemPrompt).toContain("If a draft, diagram, or other artifact already exists and the blocker is missing path or read access to that artifact");
    expect(qualitySupervisor?.systemPrompt).toContain("Use any artifact paths or filenames present in shared facts, partial results, or task context before guessing filenames");
    expect(qualitySupervisor?.systemPrompt).toContain("Do not recommend new research or fresh evidence gathering when the failure is missing review input rather than missing evidence");
  });

  it("ships anti-hallucination prompt rules for evidence-bearing delegations", () => {
    // The main-assistant `agents` block lives in 00-platform.jsonc after the agent-tier
    // reorg; 10-core-agents.jsonc now holds only the core-tier subAgents.
    const coreAgentsPath = resolve(process.cwd(), "../../workspace/agents/00-platform.jsonc");

    const coreRaw = JSON5.parse(readFileSync(coreAgentsPath, "utf8")) as {
      agents?: { mainAssistant?: { customInstructions?: string } };
    };

    const mainAssistantInstructions = coreRaw.agents?.mainAssistant?.customInstructions ?? "";
    const webTaskCoordinator = loadWorkspaceSubAgents()["web_task_coordinator"];

    expect(mainAssistantInstructions).toContain("Retrieved evidence overrides prior assumptions");
    expect(mainAssistantInstructions).toContain("Never state a source, manufacturer, URL, spec, or number that is not in the current evidence");
    expect(mainAssistantInstructions).toContain("do NOT fabricate the gaps");

    expect(webTaskCoordinator?.systemPrompt).toContain("delegate directly to researcher unless browser interaction is actually required");
    expect(webTaskCoordinator?.systemPrompt).toContain("treat that evidence as authoritative for the turn");
    expect(webTaskCoordinator?.systemPrompt).toContain("stop repeating the disproved assumption");
    expect(webTaskCoordinator?.systemPrompt).toContain("synthesize immediately instead of performing more routing or discovery calls");
  });

  it("keeps main and desktop prompts access-method driven rather than app-script specific", () => {
    // The main-assistant `agents` block lives in 00-platform.jsonc after the agent-tier
    // reorg; 10-core-agents.jsonc now holds only the core-tier subAgents.
    const coreAgentsPath = resolve(process.cwd(), "../../workspace/agents/00-platform.jsonc");

    const coreRaw = JSON5.parse(readFileSync(coreAgentsPath, "utf8")) as {
      agents?: { mainAssistant?: { customInstructions?: string } };
    };

    const mainAssistantInstructions = coreRaw.agents?.mainAssistant?.customInstructions ?? "";
    const computerUseAgent = loadWorkspaceSubAgents()["computer_use_agent"];
    const computerUsePrompt = computerUseAgent?.systemPrompt ?? "";

    expect(mainAssistantInstructions).toContain("networked-service API on a known host");
    expect(mainAssistantInstructions).toContain("desktop/UI specialist only when visual interaction is genuinely required");
    expect(mainAssistantInstructions).not.toContain("LM STUDIO SHORTCUT");
    expect(mainAssistantInstructions).not.toContain("1234/v1/models");

    expect(computerUsePrompt).toContain("API-FIRST RULE FOR DIRECTLY QUERYABLE SERVICES");
    expect(computerUsePrompt).toContain("GENERIC PANEL OR TEXT-ENTRY WORKFLOW");
    expect(computerUsePrompt).not.toContain("VS CODE COPILOT CHAT WORKFLOW");
    expect(computerUsePrompt).not.toContain("Visual Studio Code");
    expect(computerUsePrompt).not.toContain("LM Studio");
  });

  it("does not reload single-file config when unrelated runtime data files change", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-config-watch-"));
    const baseConfigPath = join(tempDir, "starlingai.json");
    const mutableConfigPath = join(tempDir, "starlingai.runtime.json");
    const unrelatedRuntimePath = join(tempDir, "session-store.json");

    writeFileSync(baseConfigPath, JSON.stringify({
      gateway: { port: 8765 },
      agents: {
        defaults: {
          model: { primary: "lmstudio/test-model" },
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = baseConfigPath;
    process.env["SAI_MUTABLE_CONFIG_PATH"] = mutableConfigPath;
    vi.resetModules();

    const configLoader = await import("../config/loader.js");
    const onChange = vi.fn();

    try {
      configLoader.loadConfig();
      configLoader.watchConfig(onChange);

      writeFileSync(unrelatedRuntimePath, JSON.stringify({ turns: 1 }), "utf8");
      await wait(400);

      expect(onChange).not.toHaveBeenCalled();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not reload directory config when unrelated files change under an external mutable data directory", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-config-directory-watch-"));
    const configDir = join(tempDir, "config");
    const workspaceDir = join(tempDir, "workspace");
    const mutableDataDir = join(tempDir, "data");
    const mutableConfigPath = join(mutableDataDir, "starlingai.runtime.json");
    const unrelatedRuntimePath = join(mutableDataDir, "audit.jsonl");

    mkdirSync(join(configDir, "gateway"), { recursive: true });
    mkdirSync(join(workspaceDir, "agents"), { recursive: true });
    mkdirSync(mutableDataDir, { recursive: true });

    writeFileSync(join(configDir, "gateway", "10-gateway.json"), JSON.stringify({
      gateway: { port: 8765 },
    }, null, 2), "utf8");

    writeFileSync(join(workspaceDir, "agents", "10-defaults.json"), JSON.stringify({
      agents: {
        defaults: {
          model: { primary: "lmstudio/test-model" },
        },
      },
    }, null, 2), "utf8");

    process.env["SAI_CONFIG_PATH"] = configDir;
    process.env["SAI_WORKSPACE_CONFIG_PATH"] = workspaceDir;
    process.env["SAI_MUTABLE_CONFIG_PATH"] = mutableConfigPath;
    vi.resetModules();

    const configLoader = await import("../config/loader.js");

    try {
      configLoader.loadConfig();
      configLoader.watchConfig(() => undefined);
      await wait(250);

      const stableConfig = configLoader.getConfig();
      writeFileSync(unrelatedRuntimePath, '{"event":"audit"}\n', "utf8");
      await wait(400);

      expect(configLoader.getConfig()).toBe(stableConfig);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Workspace zoning: the shard sweep must skip the working zones. Before this
  // guard, ANY .json an agent wrote into generated/ (or a user uploaded, or a
  // dynamic-tool bundle in tools/) was merged into the live config on reload —
  // a generated data.json with a top-level "subAgents" or "gateway" key would
  // silently reconfigure the swarm.
  it("does not sweep working zones (generated/, uploads/, tools/) into the config merge", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "starlingai-config-zones-"));
    const configDir = join(tempDir, "config");
    const workspaceDir = join(tempDir, "workspace");

    mkdirSync(join(configDir, "gateway"), { recursive: true });
    writeFileSync(join(configDir, "gateway", "10-gateway.json"), JSON.stringify({
      gateway: { port: 8765 },
    }), "utf8");

    mkdirSync(join(workspaceDir, "agents"), { recursive: true });
    writeFileSync(join(workspaceDir, "agents", "10-test.jsonc"), JSON.stringify({
      subAgents: { zone_probe: { description: "legitimate config-zone agent" } },
    }), "utf8");

    // Poison files in each working zone — none may reach the merge.
    mkdirSync(join(workspaceDir, "generated", "reports"), { recursive: true });
    writeFileSync(join(workspaceDir, "generated", "reports", "data.json"), JSON.stringify({
      gateway: { port: 9999 },
      subAgents: { evil_generated: { description: "agent-planted" } },
    }), "utf8");
    mkdirSync(join(workspaceDir, "uploads"), { recursive: true });
    writeFileSync(join(workspaceDir, "uploads", "attachment.json"), JSON.stringify({
      subAgents: { evil_upload: { description: "user-uploaded" } },
    }), "utf8");
    mkdirSync(join(workspaceDir, "tools"), { recursive: true });
    writeFileSync(join(workspaceDir, "tools", "csv_to_json.json"), JSON.stringify({
      name: "csv_to_json", description: "dynamic tool bundle", code: "return {};", version: 1,
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configDir;
    process.env["SAI_WORKSPACE_CONFIG_PATH"] = workspaceDir;
    vi.resetModules();

    const configLoader = await import("../config/loader.js");

    try {
      const config = configLoader.loadConfig();
      expect(config.gateway.port).toBe(8765);
      expect(config.subAgents["zone_probe"]).toBeDefined();
      expect(config.subAgents["evil_generated"]).toBeUndefined();
      expect(config.subAgents["evil_upload"]).toBeUndefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});