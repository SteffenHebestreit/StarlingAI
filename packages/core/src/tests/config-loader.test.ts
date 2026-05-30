import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import JSON5 from "json5";

function wait(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

describe("config loader mutable overlay", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    delete process.env["SAI_WORKSPACE_CONFIG_PATH"];
    delete process.env["SAI_MUTABLE_CONFIG_PATH"];
    delete process.env["SAI_LMSTUDIO_URL"];
    delete process.env["SAI_LMSTUDIO_API_KEY"];
    delete process.env["SAI_DEFAULT_MODEL"];
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
      const compiledPath = join(tempDir, "starlingai.json");

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
    const workspaceAgentsPath = resolve(process.cwd(), "../../workspace/agents/20-subagents-general.jsonc");
    const raw = JSON5.parse(readFileSync(workspaceAgentsPath, "utf8")) as {
      subAgents?: Record<string, { systemPrompt?: string; tools?: string[] }>;
    };

    const paperAuthor = raw.subAgents?.["paper_author"];
    const summarizer = raw.subAgents?.["summarizer"];
    const meetingBriefingAgent = raw.subAgents?.["meeting_briefing_agent"];

    expect(paperAuthor?.tools).toEqual(expect.arrayContaining(["search_agents", "delegate_to_agent"]));
    expect(summarizer?.tools).toEqual(expect.arrayContaining(["search_agents", "delegate_to_agent"]));
    expect(meetingBriefingAgent?.tools).toEqual(expect.arrayContaining(["search_agents", "delegate_to_agent"]));

    expect(paperAuthor?.systemPrompt).toContain("do not draft a placeholder paper or generic report");
    expect(paperAuthor?.systemPrompt).toContain("evidence must be collected before drafting can begin");
    expect(summarizer?.systemPrompt).toContain("do not improvise a summary from assumptions");
    expect(meetingBriefingAgent?.systemPrompt).toContain("do not invent status updates or placeholder conclusions");
  });

  it("ships coordinator and review prompts that treat missing artifact access as a review-input issue", () => {
    const workspaceAgentsPath = resolve(process.cwd(), "../../workspace/agents/20-subagents-general.jsonc");
    const raw = JSON5.parse(readFileSync(workspaceAgentsPath, "utf8")) as {
      subAgents?: Record<string, { systemPrompt?: string }>;
    };

    const missionCoordinator = raw.subAgents?.["mission_coordinator"];
    const qualitySupervisor = raw.subAgents?.["quality_supervisor"];

    expect(missionCoordinator?.systemPrompt).toContain("If a draft, diagram, or other artifact already exists and the blocker is missing path or read access to that artifact");
    expect(qualitySupervisor?.systemPrompt).toContain("Use any artifact paths or filenames present in shared facts, partial results, or task context before guessing filenames");
    expect(qualitySupervisor?.systemPrompt).toContain("Do not recommend new research or fresh evidence gathering when the failure is missing review input rather than missing evidence");
  });

  it("ships anti-hallucination prompt rules for evidence-bearing delegations", () => {
    const coreAgentsPath = resolve(process.cwd(), "../../workspace/agents/10-core-agents.jsonc");
    const workspaceAgentsPath = resolve(process.cwd(), "../../workspace/agents/20-subagents-general.jsonc");

    const coreRaw = JSON5.parse(readFileSync(coreAgentsPath, "utf8")) as {
      agents?: { mainAssistant?: { customInstructions?: string } };
    };
    const workspaceRaw = JSON5.parse(readFileSync(workspaceAgentsPath, "utf8")) as {
      subAgents?: Record<string, { systemPrompt?: string }>;
    };

    const mainAssistantInstructions = coreRaw.agents?.mainAssistant?.customInstructions ?? "";
    const webTaskCoordinator = workspaceRaw.subAgents?.["web_task_coordinator"];

    expect(mainAssistantInstructions).toContain("Retrieved evidence overrides prior assumptions");
    expect(mainAssistantInstructions).toContain("Never state a source, manufacturer, URL, spec, or number that is not in the current evidence");
    expect(mainAssistantInstructions).toContain("do NOT fabricate the gaps");

    expect(webTaskCoordinator?.systemPrompt).toContain("delegate directly to researcher unless browser interaction is actually required");
    expect(webTaskCoordinator?.systemPrompt).toContain("treat that evidence as authoritative for the turn");
    expect(webTaskCoordinator?.systemPrompt).toContain("stop repeating the disproved assumption");
    expect(webTaskCoordinator?.systemPrompt).toContain("synthesize immediately instead of performing more routing or discovery calls");
  });

  it("keeps main and desktop prompts access-method driven rather than app-script specific", () => {
    const coreAgentsPath = resolve(process.cwd(), "../../workspace/agents/10-core-agents.jsonc");
    const workspaceAgentsPath = resolve(process.cwd(), "../../workspace/agents/20-subagents-general.jsonc");

    const coreRaw = JSON5.parse(readFileSync(coreAgentsPath, "utf8")) as {
      agents?: { mainAssistant?: { customInstructions?: string } };
    };
    const workspaceRaw = JSON5.parse(readFileSync(workspaceAgentsPath, "utf8")) as {
      subAgents?: Record<string, { systemPrompt?: string }>;
    };

    const mainAssistantInstructions = coreRaw.agents?.mainAssistant?.customInstructions ?? "";
    const computerUseAgent = workspaceRaw.subAgents?.["computer_use_agent"];
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
});