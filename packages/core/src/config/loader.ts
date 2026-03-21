import { readFileSync, writeFileSync, existsSync, watchFile, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import JSON5 from "json5";
import { ConfigSchema, type Config } from "./schema.js";
import { logger } from "../logger.js";

const BASE_CONFIG_PATH = resolveConfigPath();
const MUTABLE_CONFIG_PATH = resolveMutableConfigPath(BASE_CONFIG_PATH);

let _config: Config | null = null;

export function loadConfig(): Config {
  if (_config) return _config;

  const raw = getEffectiveRawConfig();

  // Merge env overrides
  const merged = mergeEnvOverrides(raw);

  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    logger.error({ errors: result.error.flatten() }, "Config validation errors");
    throw new Error("Invalid configuration: " + JSON.stringify(result.error.flatten()));
  }

  _config = result.data;
  return _config;
}

export function getConfig(): Config {
  if (!_config) return loadConfig();
  return _config;
}

export function watchConfig(onChange: (config: Config, changedSections: string[]) => void): void {
  const watchedPaths = new Set([BASE_CONFIG_PATH, MUTABLE_CONFIG_PATH]);
  for (const filePath of watchedPaths) {
    if (!existsSync(filePath)) continue;
    watchFile(filePath, { interval: 2000 }, () => {
    logger.info("Config file changed — reloading");
    const oldConfig = _config;
    _config = null;
    try {
      const newConfig = loadConfig();
      const changed = diffConfigSections(oldConfig, newConfig);
      if (changed.length === 0) {
        logger.debug("Config file changed but no meaningful differences detected — skipping notification");
        return;
      }
      logger.info({ changedSections: changed }, "Config reloaded — notifying subscribers");
      onChange(newConfig, changed);
    } catch (err) {
      logger.error({ err }, "Failed to reload config — keeping previous config");
      // Restore previous config if reload fails
      if (oldConfig) _config = oldConfig;
    }
    });
  }
}

export function resetConfigForTests(): void { 
  import("node:fs").then(fs => fs.unwatchFile(BASE_CONFIG_PATH)); 
  import("node:fs").then(fs => fs.unwatchFile(MUTABLE_CONFIG_PATH));
  _config = null;
}

export function updateConfig(mutator: (raw: Record<string, unknown>) => void): Config {
  const raw = getEffectiveRawConfig();

  mutator(raw);
  mkdirSync(dirname(MUTABLE_CONFIG_PATH), { recursive: true });
  writeFileSync(MUTABLE_CONFIG_PATH, `${JSON.stringify(raw, null, 2)}\n`, "utf-8");
  _config = null;
  return loadConfig();
}

function getEffectiveRawConfig(): Record<string, unknown> {
  const baseRaw = readRawConfigFile(BASE_CONFIG_PATH, "base");
  if (MUTABLE_CONFIG_PATH === BASE_CONFIG_PATH) {
    return baseRaw;
  }

  const mutableRaw = readRawConfigFile(MUTABLE_CONFIG_PATH, "mutable");
  return mergeConfigObjects(baseRaw, mutableRaw);
}

function readRawConfigFile(path: string, kind: "base" | "mutable"): Record<string, unknown> {
  if (!existsSync(path)) {
    if (kind === "base") {
      logger.info({ path }, "No config file found — using defaults");
    }
    return {};
  }

  try {
    const raw = JSON5.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    logger.info({ path, kind }, "Loaded config file");
    return raw;
  } catch (err) {
    logger.error({ err, path, kind }, "Failed to parse config file — using defaults");
    return {};
  }
}

function mergeConfigObjects(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(overlay)) {
    const baseValue = merged[key];
    if (isPlainObject(baseValue) && isPlainObject(value)) {
      merged[key] = mergeConfigObjects(baseValue, value);
      continue;
    }
    merged[key] = value;
  }

  return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Compare two Config objects and return a list of top-level section names that differ.
 * Used to avoid unnecessary subscriber notifications when only whitespace/formatting changed.
 */
function diffConfigSections(oldConfig: Config | null, newConfig: Config): string[] {
  if (!oldConfig) return ["_initial"];
  const changed: string[] = [];
  const allKeys = new Set([...Object.keys(oldConfig), ...Object.keys(newConfig)]) as Set<keyof Config>;
  for (const key of allKeys) {
    if (JSON.stringify(oldConfig[key]) !== JSON.stringify(newConfig[key])) {
      changed.push(key);
    }
  }
  return changed;
}

function mergeEnvOverrides(raw: Record<string, unknown>): Record<string, unknown> {
  // Overlay env variables on top of file config
  const env = process.env;

  if (env["SAI_GATEWAY_PORT"]) {
    const gw = (raw["gateway"] as Record<string, unknown> | undefined) ?? {};
    raw["gateway"] = { ...gw, port: parseInt(env["SAI_GATEWAY_PORT"], 10) };
  }
  if (env["SAI_JWT_SECRET"]) {
    const gw = (raw["gateway"] as Record<string, unknown> | undefined) ?? {};
    raw["gateway"] = { ...(gw as object), jwtSecret: env["SAI_JWT_SECRET"] };
  }
  if (env["SAI_LMSTUDIO_URL"]) {
    const p = (raw["providers"] as Record<string, unknown> | undefined) ?? {};
    const lms = (p["lmstudio"] as Record<string, unknown> | undefined) ?? {};
    raw["providers"] = { ...(p as object), lmstudio: { ...lms, baseUrl: env["SAI_LMSTUDIO_URL"] } };
  }
  if (env["ANTHROPIC_API_KEY"]) {
    const p = (raw["providers"] as Record<string, unknown> | undefined) ?? {};
    const ant = (p["anthropic"] as Record<string, unknown> | undefined) ?? {};
    raw["providers"] = { ...(p as object), anthropic: { ...ant, apiKey: env["ANTHROPIC_API_KEY"] } };
  }
  if (env["TELEGRAM_BOT_TOKEN"]) {
    const ch = (raw["channels"] as Record<string, unknown> | undefined) ?? {};
    const tg = (ch["telegram"] as Record<string, unknown> | undefined) ?? {};
    raw["channels"] = { ...(ch as object), telegram: { ...tg, enabled: true, botToken: env["TELEGRAM_BOT_TOKEN"] } };
  }
  if (env["SAI_MULTIMODAL_FILES_URL"] || env["SAI_MULTIMODAL_STT_URL"] || env["SAI_MULTIMODAL_TTS_URL"]) {
    const multimodal = (raw["multimodal"] as Record<string, unknown> | undefined) ?? {};
    const files = (multimodal["files"] as Record<string, unknown> | undefined) ?? {};
    const stt = (multimodal["stt"] as Record<string, unknown> | undefined) ?? {};
    const tts = (multimodal["tts"] as Record<string, unknown> | undefined) ?? {};
    raw["multimodal"] = {
      ...(multimodal as object),
      files: env["SAI_MULTIMODAL_FILES_URL"] ? { ...files, baseUrl: env["SAI_MULTIMODAL_FILES_URL"] } : files,
      stt: env["SAI_MULTIMODAL_STT_URL"] ? { ...stt, baseUrl: env["SAI_MULTIMODAL_STT_URL"] } : stt,
      tts: env["SAI_MULTIMODAL_TTS_URL"] ? { ...tts, baseUrl: env["SAI_MULTIMODAL_TTS_URL"] } : tts,
    };
  }

  return raw;
}

function resolveConfigPath(): string {
  const explicit = process.env["SAI_CONFIG_PATH"];
  if (explicit?.trim()) return resolve(explicit);

  const workspaceConfig = resolve(process.cwd(), "starlingai.json");
  const homeConfig = resolve(homedir(), ".starlingai", "starlingai.json");

  if (existsSync(workspaceConfig)) return workspaceConfig;
  if (existsSync(homeConfig)) return homeConfig;
  return workspaceConfig;
}

function resolveMutableConfigPath(baseConfigPath: string): string {
  const explicit = process.env["SAI_MUTABLE_CONFIG_PATH"];
  if (explicit?.trim()) return resolve(explicit);
  return baseConfigPath;
}
