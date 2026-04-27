import { readFileSync, writeFileSync, existsSync, watchFile, unwatchFile, mkdirSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import JSON5 from "json5";
import { ConfigSchema, type Config } from "./schema.js";
import { validateComputerUseConfig } from "./computer-use-schema.js";
import { logger } from "../logger.js";

type ConfigSourceType = "file" | "directory";

type ConfigSource = {
  basePath: string;
  baseType: ConfigSourceType;
  /** Optional second directory (workspace/) merged on top of basePath. */
  workspacePath: string | null;
  mutablePath: string;
  compiledPath: string;
};

const DEFAULT_CONFIG_FILE_NAME = "starlingai.json";
const DEFAULT_CONFIG_DIRECTORY_NAME = "config";
const DEFAULT_WORKSPACE_DIRECTORY_NAME = "workspace";
const LEGACY_CONFIG_DIRECTORY_NAMES = ["starling_config", "starling-config"];
const DEFAULT_RUNTIME_DIRECTORY_NAME = "runtime";
const DEFAULT_RUNTIME_OVERLAY_FILE_NAME = "runtime.overrides.json";

const CONFIG_SOURCE = resolveConfigSource();

let _config: Config | null = null;
const activeWatchedFiles = new Set<string>();
const activeDirectoryWatchers: FSWatcher[] = [];

export function loadConfig(): Config {
  if (_config) return _config;

  const raw = getEffectiveRawConfig();

  // Merge env overrides
  const merged = mergeEnvOverrides(raw);

  // Validate computerUse block separately with Joi before Zod pass-through
  if (merged.computerUse !== undefined) {
    try {
      merged.computerUse = validateComputerUseConfig(merged.computerUse);
    } catch (err) {
      logger.error({ err }, "Computer use config validation failed");
      throw err;
    }
  }

  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    logger.error({ errors: result.error.flatten() }, "Config validation errors");
    throw new Error("Invalid configuration: " + JSON.stringify(result.error.flatten()));
  }

  // Two-zone layout detected → enforce workspace path from directory detection
  // so file-writing tools target the workspace/ subdirectory, not the repo root.
  if (CONFIG_SOURCE.workspacePath) {
    result.data.workspacePath = CONFIG_SOURCE.workspacePath;
  }

  _config = result.data;
  writeCompiledConfig(_config);
  return _config;
}

export function getConfig(): Config {
  if (!_config) return loadConfig();
  return _config;
}

export function watchConfig(onChange: (config: Config, changedSections: string[]) => void): void {
  clearConfigWatchers();

  let reloadTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleReload = () => {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      logger.info("Config changed — reloading");
      const oldConfig = _config;
      _config = null;
      try {
        const newConfig = loadConfig();
        const changed = diffConfigSections(oldConfig, newConfig);
        if (changed.length === 0) {
          logger.debug("Config changed but no meaningful differences detected — skipping notification");
          return;
        }
        logger.info({ changedSections: changed }, "Config reloaded — notifying subscribers");
        onChange(newConfig, changed);
      } catch (err) {
        logger.error({ err }, "Failed to reload config — keeping previous config");
        if (oldConfig) _config = oldConfig;
      }
    }, 100);
  };

  for (const filePath of getWatchedFilePaths(CONFIG_SOURCE)) {
    watchFile(filePath, { interval: 2000 }, scheduleReload);
    activeWatchedFiles.add(filePath);
  }

  for (const directoryPath of getWatchedDirectoryPaths(CONFIG_SOURCE)) {
    if (!existsSync(directoryPath) || !isExistingDirectory(directoryPath)) continue;
    try {
      activeDirectoryWatchers.push(watch(directoryPath, { persistent: false }, scheduleReload));
    } catch (err) {
      logger.warn({ err, directoryPath }, "Failed to watch config directory");
    }
  }
}

export function resetConfigForTests(): void { 
  clearConfigWatchers();
  _config = null;
}

export function updateConfig(mutator: (raw: Record<string, unknown>) => void): Config {
  const baseRaw = getBaseRawConfig();
  const raw = getEffectiveRawConfig();

  mutator(raw);
  const rawToPersist = CONFIG_SOURCE.mutablePath === CONFIG_SOURCE.basePath
    ? raw
    : buildOverlayConfig(baseRaw, raw);

  mkdirSync(dirname(CONFIG_SOURCE.mutablePath), { recursive: true });
  writeFileSync(CONFIG_SOURCE.mutablePath, `${JSON.stringify(rawToPersist, null, 2)}\n`, "utf-8");
  _config = null;
  return loadConfig();
}

function getEffectiveRawConfig(): Record<string, unknown> {
  const baseRaw = getBaseRawConfig();
  if (CONFIG_SOURCE.mutablePath === CONFIG_SOURCE.basePath) {
    return baseRaw;
  }

  const mutableRaw = readRawConfigFile(CONFIG_SOURCE.mutablePath, "mutable");
  return mergeConfigObjects(baseRaw, mutableRaw);
}

function getBaseRawConfig(): Record<string, unknown> {
  if (CONFIG_SOURCE.baseType === "directory") {
    const base = readRawConfigDirectory(CONFIG_SOURCE.basePath, CONFIG_SOURCE.mutablePath);
    if (CONFIG_SOURCE.workspacePath) {
      const workspace = readRawConfigDirectory(CONFIG_SOURCE.workspacePath, CONFIG_SOURCE.mutablePath);
      return mergeConfigObjects(base, workspace);
    }
    return base;
  }
  return readRawConfigFile(CONFIG_SOURCE.basePath, "base");
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

function readRawConfigDirectory(directoryPath: string, mutablePath: string): Record<string, unknown> {
  if (!existsSync(directoryPath) || !isExistingDirectory(directoryPath)) {
    logger.info({ path: directoryPath }, "No config directory found — using defaults");
    return {};
  }

  const merged: Record<string, unknown> = {};
  const shardPaths = collectConfigShardPaths(directoryPath, mutablePath, CONFIG_SOURCE.compiledPath);

  for (const shardPath of shardPaths) {
    const shardRaw = readRawConfigFile(shardPath, "base");
    Object.assign(merged, mergeConfigObjects(merged, shardRaw));
  }

  logger.info({
    path: directoryPath,
    shards: shardPaths.map((filePath) => relative(directoryPath, filePath).replace(/\\/g, "/")),
  }, "Loaded config directory");
  return merged;
}

function collectConfigShardPaths(directoryPath: string, mutablePath: string, compiledPath: string): string[] {
  const shardPaths: string[] = [];
  const visit = (currentPath: string) => {
    for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
      const nextPath = resolve(currentPath, entry.name);
      if (entry.isDirectory()) {
        visit(nextPath);
        continue;
      }
      if (!entry.isFile() || !isSupportedConfigFile(entry.name)) continue;
      if (nextPath === mutablePath || nextPath === compiledPath) continue;
      shardPaths.push(nextPath);
    }
  };

  visit(directoryPath);
  return shardPaths.sort((left, right) => relative(directoryPath, left).localeCompare(relative(directoryPath, right)));
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

function writeCompiledConfig(config: Config): void {
  if (CONFIG_SOURCE.baseType !== "directory") return;

  try {
    mkdirSync(dirname(CONFIG_SOURCE.compiledPath), { recursive: true });
    const serialized = `${JSON.stringify(config, null, 2)}\n`;
    if (existsSync(CONFIG_SOURCE.compiledPath)) {
      const existing = readFileSync(CONFIG_SOURCE.compiledPath, "utf-8");
      if (existing === serialized) return;
    }
    writeFileSync(CONFIG_SOURCE.compiledPath, serialized, "utf-8");
  } catch (err) {
    logger.warn({ err, path: CONFIG_SOURCE.compiledPath }, "Failed to write compiled config artifact");
  }
}

function buildOverlayConfig(base: Record<string, unknown>, updated: Record<string, unknown>): Record<string, unknown> {
  const overlay: Record<string, unknown> = {};

  for (const [key, updatedValue] of Object.entries(updated)) {
    const baseValue = base[key];
    if (isPlainObject(baseValue) && isPlainObject(updatedValue)) {
      const nestedOverlay = buildOverlayConfig(baseValue, updatedValue);
      if (Object.keys(nestedOverlay).length > 0) {
        overlay[key] = nestedOverlay;
      }
      continue;
    }

    if (!deepEqual(baseValue, updatedValue)) {
      overlay[key] = updatedValue;
    }
  }

  return overlay;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Order-independent deep equality for JSON-compatible values. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]));
  }

  return false;
}

function isSupportedConfigFile(fileName: string): boolean {
  const extension = extname(fileName).toLowerCase();
  return extension === ".json" || extension === ".jsonc";
}

function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isPathContainedBy(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
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
  if (env["SAI_LMSTUDIO_API_KEY"]) {
    const p = (raw["providers"] as Record<string, unknown> | undefined) ?? {};
    const lms = (p["lmstudio"] as Record<string, unknown> | undefined) ?? {};
    raw["providers"] = { ...(p as object), lmstudio: { ...lms, apiKey: env["SAI_LMSTUDIO_API_KEY"] } };
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
  if (env["SAI_COMPUTER_USE_ENABLED"] || env["SAI_COMPUTER_REMOTE_NODE_URL"] || env["SAI_COMPUTER_REMOTE_NODE_TOKEN"] || env["SAI_COMPUTER_REMOTE_NODE_LABEL"]) {
    const computerUse = (raw["computerUse"] as Record<string, unknown> | undefined) ?? {};
    const adapters = (computerUse["adapters"] as Record<string, unknown> | undefined) ?? {};
    const remoteNode = (adapters["remote_node"] as Record<string, unknown> | undefined) ?? {};
    raw["computerUse"] = {
      ...computerUse,
      ...(env["SAI_COMPUTER_USE_ENABLED"]
        ? {
            enabled: !["0", "false", "False", "FALSE"].includes(env["SAI_COMPUTER_USE_ENABLED"]),
          }
        : {}),
      adapters: {
        ...adapters,
        remote_node: {
          ...remoteNode,
          ...(env["SAI_COMPUTER_REMOTE_NODE_URL"] ? { baseUrl: env["SAI_COMPUTER_REMOTE_NODE_URL"] } : {}),
          ...(env["SAI_COMPUTER_REMOTE_NODE_TOKEN"] ? { authToken: env["SAI_COMPUTER_REMOTE_NODE_TOKEN"] } : {}),
          ...(env["SAI_COMPUTER_REMOTE_NODE_LABEL"] ? { label: env["SAI_COMPUTER_REMOTE_NODE_LABEL"] } : {}),
        },
      },
    };
  }

  return raw;
}

function resolveConfigSource(): ConfigSource {
  const { basePath, workspacePath } = resolveConfigPaths();
  const baseType = inferConfigSourceType(basePath);
  const mutableBase = workspacePath ?? basePath;
  return {
    basePath,
    baseType,
    workspacePath,
    mutablePath: resolveMutableConfigPath(mutableBase, baseType),
    compiledPath: resolveCompiledConfigPath(basePath, baseType),
  };
}

function resolveConfigPaths(): { basePath: string; workspacePath: string | null } {
  const explicit = process.env["SAI_CONFIG_PATH"];
  if (explicit?.trim()) {
    const explicitWorkspace = process.env["SAI_WORKSPACE_CONFIG_PATH"];
    return {
      basePath: resolve(explicit),
      workspacePath: explicitWorkspace?.trim() ? resolve(explicitWorkspace) : null,
    };
  }

  // Two-zone layout: config/ + workspace/
  const twoZoneConfigDir = resolve(process.cwd(), DEFAULT_CONFIG_DIRECTORY_NAME);
  const twoZoneWorkspaceDir = resolve(process.cwd(), DEFAULT_WORKSPACE_DIRECTORY_NAME);
  if (existsSync(twoZoneConfigDir) && existsSync(twoZoneWorkspaceDir)) {
    return { basePath: twoZoneConfigDir, workspacePath: twoZoneWorkspaceDir };
  }

  // Legacy single-directory layouts
  for (const legacyName of LEGACY_CONFIG_DIRECTORY_NAMES) {
    const legacyDir = resolve(process.cwd(), legacyName);
    if (existsSync(legacyDir)) {
      logger.warn({ path: legacyDir }, "Using legacy config directory — migrate to config/ + workspace/ layout");
      return { basePath: legacyDir, workspacePath: null };
    }
  }

  // Single-file fallback
  const workspaceConfigFile = resolve(process.cwd(), DEFAULT_CONFIG_FILE_NAME);
  if (existsSync(workspaceConfigFile)) return { basePath: workspaceConfigFile, workspacePath: null };

  // Home directory fallbacks
  const homeConfigDir = resolve(homedir(), ".starlingai", DEFAULT_CONFIG_DIRECTORY_NAME);
  const homeWorkspaceDir = resolve(homedir(), ".starlingai", DEFAULT_WORKSPACE_DIRECTORY_NAME);
  if (existsSync(homeConfigDir) && existsSync(homeWorkspaceDir)) {
    return { basePath: homeConfigDir, workspacePath: homeWorkspaceDir };
  }
  for (const legacyName of LEGACY_CONFIG_DIRECTORY_NAMES) {
    const legacyDir = resolve(homedir(), ".starlingai", legacyName);
    if (existsSync(legacyDir)) {
      logger.warn({ path: legacyDir }, "Using legacy config directory — migrate to config/ + workspace/ layout");
      return { basePath: legacyDir, workspacePath: null };
    }
  }
  const homeConfigFile = resolve(homedir(), ".starlingai", DEFAULT_CONFIG_FILE_NAME);
  if (existsSync(homeConfigFile)) return { basePath: homeConfigFile, workspacePath: null };

  // Default: expect two-zone layout
  return { basePath: twoZoneConfigDir, workspacePath: twoZoneWorkspaceDir };
}

function resolveMutableConfigPath(mutableBase: string, baseType: ConfigSourceType): string {
  const explicit = process.env["SAI_MUTABLE_CONFIG_PATH"];
  if (explicit?.trim()) {
    const resolvedExplicit = resolve(explicit);
    return inferConfigSourceType(resolvedExplicit) === "directory"
      ? join(resolvedExplicit, DEFAULT_RUNTIME_DIRECTORY_NAME, DEFAULT_RUNTIME_OVERLAY_FILE_NAME)
      : resolvedExplicit;
  }

  if (baseType === "directory" || inferConfigSourceType(mutableBase) === "directory") {
    return join(mutableBase, DEFAULT_RUNTIME_DIRECTORY_NAME, DEFAULT_RUNTIME_OVERLAY_FILE_NAME);
  }
  return mutableBase;
}

function resolveCompiledConfigPath(baseConfigPath: string, baseType: ConfigSourceType): string {
  if (baseType === "directory") {
    // In two-zone layout, compiled artifact goes to repo root (parent of config/)
    return join(dirname(baseConfigPath), DEFAULT_CONFIG_FILE_NAME);
  }
  return baseConfigPath;
}

function inferConfigSourceType(path: string): ConfigSourceType {
  if (existsSync(path)) {
    return isExistingDirectory(path) ? "directory" : "file";
  }

  const extension = extname(path).toLowerCase();
  if (extension === ".json" || extension === ".jsonc") return "file";
  const normalizedBaseName = basename(path).toLowerCase();
  if ([DEFAULT_CONFIG_DIRECTORY_NAME, DEFAULT_WORKSPACE_DIRECTORY_NAME, ...LEGACY_CONFIG_DIRECTORY_NAMES].includes(normalizedBaseName)) return "directory";
  return "directory";
}

function getWatchedFilePaths(configSource: ConfigSource): string[] {
  const watchedPaths = new Set<string>();
  if (configSource.baseType === "file") {
    watchedPaths.add(configSource.basePath);
  }
  watchedPaths.add(configSource.mutablePath);
  return [...watchedPaths];
}

function getWatchedDirectoryPaths(configSource: ConfigSource): string[] {
  const watchedDirectories = new Set<string>();
  if (configSource.baseType !== "directory" && !configSource.workspacePath) {
    return [];
  }

  const addDirectoryTree = (path: string) => {
    watchedDirectories.add(path);
    if (!existsSync(path) || !isExistingDirectory(path)) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      addDirectoryTree(resolve(path, entry.name));
    }
  };

  if (configSource.baseType === "directory") {
    addDirectoryTree(configSource.basePath);
  }
  if (configSource.workspacePath) {
    addDirectoryTree(configSource.workspacePath);
  }
  const mutableDirectoryPath = dirname(configSource.mutablePath);
  const mutableDirectoryWithinConfigTree =
    (configSource.baseType === "directory" && isPathContainedBy(configSource.basePath, mutableDirectoryPath))
    || (configSource.workspacePath !== null && isPathContainedBy(configSource.workspacePath, mutableDirectoryPath));
  if (mutableDirectoryWithinConfigTree) {
    // Avoid watching unrelated runtime-data roots like /data when the mutable overlay lives outside the config tree.
    addDirectoryTree(mutableDirectoryPath);
  }
  return [...watchedDirectories];
}

function clearConfigWatchers(): void {
  for (const filePath of activeWatchedFiles) {
    unwatchFile(filePath);
  }
  activeWatchedFiles.clear();

  for (const watcher of activeDirectoryWatchers.splice(0, activeDirectoryWatchers.length)) {
    watcher.close();
  }
}
