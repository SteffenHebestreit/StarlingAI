import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import JSON5 from "json5";

describe("config loader mutable overlay", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    delete process.env["SAI_MUTABLE_CONFIG_PATH"];
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
            primary: "lmstudio/qwen/qwen3.5-35b-a3b"
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
      const compiledPath = join(tempDir, "starlingai.json");

      expect(config.agents.defaults.model.primary).toBe("lmstudio/qwen/qwen3.5-35b-a3b");
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
});