import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
          model: "whisper-1",
        },
        tts: {
          baseUrl: "http://tts-base",
          timeoutMs: 30_000,
          defaultLanguage: "en_US",
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
      expect(initialConfig.multimodal.stt.model).toBe("whisper-1");
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
            model: "whisper-large-v3",
          },
          tts: {
            baseUrl: "http://tts-overlay",
            timeoutMs: 45_000,
            defaultLanguage: "de_DE",
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

      expect(updatedConfig.multimodal.stt.model).toBe("whisper-large-v3");
      expect(updatedConfig.multimodal.wakeWord.language).toBe("de-DE");
      expect(existsSync(mutableConfigPath)).toBe(true);

      const baseContents = readFileSync(baseConfigPath, "utf8");
      expect(baseContents).toContain("whisper-1");
      expect(baseContents).not.toContain("whisper-large-v3");

      const mutableContents = readFileSync(mutableConfigPath, "utf8");
      expect(mutableContents).toContain("whisper-large-v3");
      expect(mutableContents).toContain("Hallo Guarded");

      configLoader.resetConfigForTests();
      const reloadedConfig = configLoader.loadConfig();
      expect(reloadedConfig.multimodal.stt.model).toBe("whisper-large-v3");
      expect(reloadedConfig.multimodal.files.baseUrl).toBe("http://files-overlay");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});