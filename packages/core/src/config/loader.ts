import { readFileSync, writeFileSync, existsSync, watchFile, unwatchFile, mkdirSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import JSON5 from "json5";
import { ConfigSchema, type Config, type SubAgentConfig } from "./schema.js";
import { validateComputerUseConfig } from "./computer-use-schema.js";
import { compareShardPaths, isNonConfigShardDirectory, NON_CONFIG_BASE_ZONES, NON_CONFIG_WORKSPACE_ZONES, sweepEntryKind, topLevelLinkHoldsConfig } from "../tools/workspace-zones.js";
import { isWorkspaceContainmentError, withContainedWorkspaceFile } from "../tools/workspace-containment.js";
import { logger } from "../logger.js";

import { PRODUCT } from "../product/index.js";

type ConfigSourceType = "file" | "directory";

type ConfigSource = {
  basePath: string;
  baseType: ConfigSourceType;
  /** Optional second directory (workspace/) merged on top of basePath. */
  workspacePath: string | null;
  mutablePath: string;
  compiledPath: string;
};

const DEFAULT_CONFIG_FILE_NAME = PRODUCT.configFileName;
const DEFAULT_CONFIG_DIRECTORY_NAME = "config";
const DEFAULT_WORKSPACE_DIRECTORY_NAME = "workspace";
const LEGACY_CONFIG_DIRECTORY_NAMES = ["starling_config", "starling-config"];
export const DEFAULT_RUNTIME_DIRECTORY_NAME = "runtime";
const DEFAULT_RUNTIME_OVERLAY_FILE_NAME = "runtime.overrides.json";

/**
 * Sentinel written into the mutable overlay to record that updateConfig removed a
 * key present in a base shard. A plain `null` would be ambiguous (null is a valid
 * configured value), so use a distinctive string that cannot collide with real JSON.
 * Honored ONLY when applying the mutable overlay (applyMutableOverlay) — never in
 * base+workspace shard merging, so one shard can't silently null out another's key.
 */
const CONFIG_TOMBSTONE = "__sai_deleted__";

const CONFIG_SOURCE = resolveConfigSource();

let _config: Config | null = null;
const activeWatchedFiles = new Set<string>();
const activeDirectoryWatchers: FSWatcher[] = [];

/**
 * Sub-agents a runtime client adds to the loaded config: the A2A client bridges each peer skill in
 * as one. They are not config — never saved, never in a preview (a save is judged on the config as
 * it loads from disk), never in the compiled artifact the bidder and sub-agent containers read. But
 * every fresh load rebuilt the loaded config without them, and every save reloads: a sub-agent
 * PATCH, now saved, dropped the peer's skills from delegation until the next card refresh, up to
 * 15 minutes later (r4 A-security #3). So each load lays them back over.
 */
const _runtimeSubAgents = new Map<string, SubAgentConfig>();

export function setRuntimeSubAgent(name: string, agent: SubAgentConfig): void {
  _runtimeSubAgents.set(name, agent);
  (getConfig().subAgents as Record<string, SubAgentConfig>)[name] = agent;
}

export function deleteRuntimeSubAgent(name: string): void {
  _runtimeSubAgents.delete(name);
  if (_config) delete (_config.subAgents as Record<string, SubAgentConfig>)[name];
}

/**
 * Whether the loaded sub-agent `name` is one a runtime client laid over the config: the one
 * withoutRuntimeSubAgents leaves out. Told apart as "loaded but not on disk", every check parsed
 * the config on disk again, and named an agent deleted on disk but not yet reloaded a peer's
 * (review of r6 leftovers, 2).
 */
export function isRuntimeSubAgent(name: string): boolean {
  const agent = _runtimeSubAgents.get(name);
  return agent !== undefined && getConfig().subAgents[name] === agent;
}

/** A candidate harness for one arm of a harness-lab run (harness-lab/arm.ts): prompt text only. */
export interface LabPromptOverlay {
  /** Replaces agents.mainAssistant.customInstructions. */
  mainAssistantInstructions?: string;
  /** Replaces subAgents.<name>.systemPrompt; every name must be a loaded sub-agent. */
  subAgentPrompts?: Record<string, string>;
}

/** The overlay in force and what it replaced on the config it was last laid on. */
let _labOverlay: {
  overlay: LabPromptOverlay;
  laidOn: Config | null;
  mainAssistant: Config["agents"]["mainAssistant"] | undefined;
  subAgents: Map<string, SubAgentConfig>;
} | null = null;

function layLabOverlay(config: Config): void {
  if (!_labOverlay) return;
  const { overlay } = _labOverlay;
  _labOverlay.laidOn = config;
  _labOverlay.subAgents = new Map();
  _labOverlay.mainAssistant = undefined;
  if (overlay.mainAssistantInstructions !== undefined) {
    _labOverlay.mainAssistant = config.agents.mainAssistant;
    config.agents.mainAssistant = { ...config.agents.mainAssistant, customInstructions: overlay.mainAssistantInstructions };
  }
  const subAgents = config.subAgents as Record<string, SubAgentConfig>;
  for (const [name, systemPrompt] of Object.entries(overlay.subAgentPrompts ?? {})) {
    const base = subAgents[name];
    if (!base) continue;
    _labOverlay.subAgents.set(name, base);
    subAgents[name] = { ...base, systemPrompt };
  }
}

/**
 * Lay a candidate harness's prompts over the loaded config, in memory, until the returned restore
 * runs: the harness lab's arms (harness-lab/arm.ts). Never saved, and laid back over a reload.
 * Unlike setRuntimeSubAgent, which marks an A2A peer's agents as not config, it leaves an agent a
 * configured one, so a proposal for it is still possible. Only the dedicated lab process may lay it
 * (SAI_HARNESS_LAB_PROCESS=1): in the gateway it would change every live turn.
 */
/** The dedicated harness-lab process (harness-lab/bootstrap.ts), never the gateway. */
export function isHarnessLabProcess(): boolean {
  return process.env["SAI_HARNESS_LAB_PROCESS"] === "1";
}

export function applyLabPromptOverlay(overlay: LabPromptOverlay): () => void {
  if (!isHarnessLabProcess()) {
    throw new Error("applyLabPromptOverlay runs only in the harness-lab process (SAI_HARNESS_LAB_PROCESS=1)");
  }
  if (_labOverlay) throw new Error("A lab prompt overlay is already in force; restore it first");
  const config = getConfig();
  const missing = Object.keys(overlay.subAgentPrompts ?? {}).filter((name) => !config.subAgents[name]);
  if (missing.length > 0) throw new Error(`No loaded sub-agent named ${missing.join(", ")}`);
  _labOverlay = { overlay, laidOn: null, mainAssistant: undefined, subAgents: new Map() };
  layLabOverlay(config);
  return () => {
    const laid = _labOverlay;
    _labOverlay = null;
    if (!laid || laid.laidOn !== _config || !_config) return;
    if (laid.mainAssistant) _config.agents.mainAssistant = laid.mainAssistant;
    for (const [name, base] of laid.subAgents) (_config.subAgents as Record<string, SubAgentConfig>)[name] = base;
  };
}

export function loadConfig(opts: { skipCompiledWrite?: boolean } = {}): Config {
  if (_config) return _config;

  _config = parseRawConfig(getEffectiveRawConfig());
  for (const [name, agent] of _runtimeSubAgents) (_config.subAgents as Record<string, SubAgentConfig>)[name] = agent;
  layLabOverlay(_config);
  // The watch path skips this and writes only when a section actually changed (B21),
  // avoiding a redundant 277KB serialize + read on no-op reloads. Cold boot and
  // updateConfig keep writing so the compiled artifact + sub-agent containers stay current.
  // The harness-lab process never writes it: its config carries a candidate's prompts, and the
  // artifact is the deployment's.
  if (!opts.skipCompiledWrite && !isHarnessLabProcess()) writeCompiledConfig(_config);
  return _config;
}

/** The effective raw config as the runtime reads it: env overrides laid over, then validated. */
function parseRawConfig(raw: Record<string, unknown>): Config {
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

  return result.data;
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
        const newConfig = loadConfig({ skipCompiledWrite: true });
        const changed = diffConfigSections(oldConfig, newConfig);
        if (changed.length === 0) {
          logger.debug("Config changed but no meaningful differences detected — skipping notification");
          return;
        }
        // A section actually changed — persist the compiled artifact (skipped above
        // for the no-op case) so freshly-spawned sub-agent containers see the update.
        writeCompiledConfig(newConfig);
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
  // The runtime overlay file is the deployment's live config: a lab run proposes, it never writes.
  if (isHarnessLabProcess()) throw new Error("The harness-lab process does not change the deployment's config");
  const baseRaw = getBaseRawConfig();
  const raw = getEffectiveRawConfig();

  mutator(raw);
  const rawToPersist = persistedRawConfig(baseRaw, raw);

  mkdirSync(dirname(CONFIG_SOURCE.mutablePath), { recursive: true });
  writeFileSync(CONFIG_SOURCE.mutablePath, `${JSON.stringify(rawToPersist, null, 2)}\n`, "utf-8");
  _config = null;
  return loadConfig();
}

/**
 * Whether the account roster (`auth.users`) is one the runtime writes: the config is one file that
 * updateConfig writes whole, or the runtime overlay holds the list (an overlay list replaces a
 * shard's). Otherwise the list comes from a base shard, the operator's own file, which nothing here
 * edits: the account migration prints the id to paste into it instead of writing one.
 */
export function rosterWrittenByRuntime(): boolean {
  if (CONFIG_SOURCE.mutablePath === CONFIG_SOURCE.basePath) return true;
  const auth = readRawConfigFile(CONFIG_SOURCE.mutablePath, "mutable")["auth"];
  return isPlainObject(auth) && Array.isArray(auth["users"]);
}

/**
 * The config `updateConfig(mutator)` would load, without writing anything. It is not the mutated
 * raw config: the write goes through JSON, which drops an `undefined`, so a value a base shard sets
 * comes back; and the env overrides outrank what was written (SAI_PRIMARY_MODEL pins the model).
 * A route that must judge what a save leaves in effect — which key goes where — judges this.
 */
export function previewConfigUpdate(mutator: (raw: Record<string, unknown>) => void): Config {
  const baseRaw = getBaseRawConfig();
  const raw = getEffectiveRawConfig();
  mutator(raw);
  const written = JSON.parse(JSON.stringify(persistedRawConfig(baseRaw, raw))) as Record<string, unknown>;
  return parseRawConfig(CONFIG_SOURCE.mutablePath === CONFIG_SOURCE.basePath
    ? applyConfigRemovals(written)
    : applyMutableOverlay(baseRaw, written));
}

/** What updateConfig writes for the mutated effective config: the whole file, or the overlay on the base. */
function persistedRawConfig(baseRaw: Record<string, unknown>, raw: Record<string, unknown>): Record<string, unknown> {
  return CONFIG_SOURCE.mutablePath === CONFIG_SOURCE.basePath
    ? raw
    : buildOverlayConfig(baseRaw, raw);
}

function getEffectiveRawConfig(): Record<string, unknown> {
  const baseRaw = getBaseRawConfig();
  if (CONFIG_SOURCE.mutablePath === CONFIG_SOURCE.basePath) {
    return baseRaw;
  }

  const mutableRaw = readRawConfigFile(CONFIG_SOURCE.mutablePath, "mutable");
  return applyMutableOverlay(baseRaw, mutableRaw);
}

function getBaseRawConfig(): Record<string, unknown> {
  if (CONFIG_SOURCE.baseType === "directory") {
    // Two-zone layout: each tree skips its own non-config zones. A single legacy directory holds
    // both kinds, so it skips both.
    const baseZones = CONFIG_SOURCE.workspacePath
      ? NON_CONFIG_BASE_ZONES
      : new Set([...NON_CONFIG_BASE_ZONES, ...NON_CONFIG_WORKSPACE_ZONES]);
    const base = readRawConfigDirectory(CONFIG_SOURCE.basePath, CONFIG_SOURCE.mutablePath, baseZones);
    if (CONFIG_SOURCE.workspacePath) {
      const workspace = readRawConfigDirectory(CONFIG_SOURCE.workspacePath, CONFIG_SOURCE.mutablePath, NON_CONFIG_WORKSPACE_ZONES);
      return applyConfigRemovals(mergeConfigObjects(base, workspace));
    }
    return applyConfigRemovals(base);
  }
  return applyConfigRemovals(readRawConfigFile(CONFIG_SOURCE.basePath, "base"));
}

/**
 * Drop every dot-path listed in the merged config's `configRemovals`.
 *
 * Shard merging deliberately never deletes: `mergeConfigObjects` only ever adds
 * or overwrites, so one shard can't null out another's key by accident. That
 * leaves a fork with no way to REMOVE something upstream ships — the only way to
 * drop, say, an unwanted built-in sub-agent was to edit the upstream shard, which
 * is exactly the rebase conflict the fork-owned-surfaces model exists to prevent.
 * (`CONFIG_TOMBSTONE` doesn't help: it is confined to the runtime overlay.)
 *
 * So removal is EXPLICIT rather than implicit — a shard names what it wants gone
 * and nothing is deleted unless it was asked for by path. Applied after the whole
 * base+workspace fold (so any shard may contribute the list) and before the
 * mutable overlay and Zod (so a runtime override can still re-add a key, and
 * emptied sections are refilled by their schema defaults).
 */
function applyConfigRemovals(raw: Record<string, unknown>): Record<string, unknown> {
  const removals = raw["configRemovals"];
  if (!Array.isArray(removals) || removals.length === 0) return raw;

  for (const entry of removals) {
    if (typeof entry !== "string" || entry.length === 0) continue;
    const segments = entry.split(".");
    let cursor: Record<string, unknown> = raw;
    let removable = true;

    // Walk to the parent of the leaf; a path through a non-object simply doesn't
    // match anything, which is the same "nothing to remove" case as a typo.
    for (const segment of segments.slice(0, -1)) {
      const next = cursor[segment];
      if (!isPlainObject(next)) {
        removable = false;
        break;
      }
      cursor = next;
    }

    const leaf = segments[segments.length - 1]!;
    if (removable && leaf in cursor) {
      delete cursor[leaf];
      logger.info({ path: entry }, "Removed config path via configRemovals");
    } else {
      // Tolerated, not fatal — mirrors disabled-tool handling, and keeps a fork
      // booting after upstream renames or drops something it had removed.
      logger.warn({ path: entry }, "configRemovals path not found — ignoring");
    }
  }

  return raw;
}

function readRawConfigFile(path: string, kind: "base" | "mutable", text?: string): Record<string, unknown> {
  if (text === undefined && !existsSync(path)) {
    if (kind === "base") {
      logger.info({ path }, "No config file found — using defaults");
    }
    return {};
  }

  try {
    const raw = JSON5.parse(text ?? readFileSync(path, "utf-8")) as Record<string, unknown>;
    logger.info({ path, kind }, "Loaded config file");
    return raw;
  } catch (err) {
    // A corrupt BASE shard must be fatal: silently returning {} makes Zod backfill
    // defaults, so a single syntax typo would boot the gateway with a section
    // reverted to defaults (e.g. auth/providers) instead of failing fast. A corrupt
    // MUTABLE runtime overlay stays non-fatal so a bad hot-write can't brick boot.
    if (kind === "base") {
      logger.error({ err, path, kind }, "Failed to parse config file — refusing to boot with partial config");
      throw new Error(`Invalid configuration: failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    logger.error({ err, path, kind }, "Failed to parse mutable config overlay — ignoring overlay");
    return {};
  }
}

function readRawConfigDirectory(directoryPath: string, mutablePath: string, zones: ReadonlySet<string>): Record<string, unknown> {
  if (!existsSync(directoryPath) || !isExistingDirectory(directoryPath)) {
    logger.info({ path: directoryPath }, "No config directory found — using defaults");
    return {};
  }

  const merged: Record<string, unknown> = {};
  const shardPaths = collectConfigShardPaths(directoryPath, mutablePath, CONFIG_SOURCE.compiledPath, zones);

  for (const shardPath of shardPaths) {
    const text = readSweptShardText(shardPath, directoryPath);
    if (text === null) continue;
    const shardRaw = readRawConfigFile(shardPath, "base", text);
    Object.assign(merged, mergeConfigObjects(merged, shardRaw));
  }

  logger.info({
    path: directoryPath,
    shards: shardPaths.map((filePath) => relative(directoryPath, filePath).replace(/\\/g, "/")),
  }, "Loaded config directory");
  return merged;
}

/**
 * A swept shard's text, or null where it is no longer a regular file in its place in the tree.
 *
 * The sweep found it a regular file with no link on the way (collectConfigShardPaths), and the
 * full-scope sandbox can still swap it, or a directory above it, for a link before it is read. So it
 * is read held to its zone (tools/workspace-containment.ts): on Linux, where the open file really is
 * is read back from its descriptor and must lie in the zone it was found in; elsewhere the same
 * check is made right before the open. One removed since the sweep is skipped, as before.
 */
function readSweptShardText(shardPath: string, directoryPath: string): string | null {
  try {
    return withContainedWorkspaceFile(shardPath, directoryPath, { mode: "read" }, (file) => file.read().toString("utf-8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") return null;
    if (!isWorkspaceContainmentError(err)) throw err;
    logger.warn({ path: shardPath }, "Skipped a config shard that is no longer a regular file in its place in the tree");
    return null;
  }
}

function collectConfigShardPaths(directoryPath: string, mutablePath: string, compiledPath: string, zones: ReadonlySet<string>): string[] {
  const shardPaths: string[] = [];
  const visit = (currentPath: string, depth: number) => {
    for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
      const nextPath = resolve(currentPath, entry.name);
      // By lstat, never through a link (sweepEntryKind): the full-scope sandbox writes the zones.
      const kind = sweepEntryKind(nextPath);
      if (kind === "link") {
        if (isNonConfigShardDirectory(entry.name, depth, zones)) continue;
        if (depth === 0 && topLevelLinkHoldsConfig(nextPath, isSupportedConfigFile(entry.name))) {
          // The operator's layout, not a sandbox's: everything behind it is missing from the config.
          logger.error(
            { path: nextPath },
            "A link at the top of the config tree is not read, so everything behind it is left out of the configuration. Replace "
              + "the link with what it points to, or make the whole config or workspace directory the link instead, which is read through",
          );
        } else {
          logger.warn({ path: nextPath }, "Skipped a link in the config tree: a shard is read only from a regular file, and no link is followed");
        }
        continue;
      }
      if (kind === "directory") {
        // Working zones (generated/, uploads/, tools/, users/) hold agent output, user
        // uploads, and dynamic-tool bundles — NOT config, and neither do hidden state
        // dirs. Sweeping them would let an agent-written data.json (or a malicious
        // upload with a top-level "agents" key) merge straight into the live config.
        if (isNonConfigShardDirectory(entry.name, depth, zones)) continue;
        visit(nextPath, depth + 1);
        continue;
      }
      if (kind !== "file" || !isSupportedConfigFile(entry.name)) continue;
      if (nextPath === mutablePath || nextPath === compiledPath) continue;
      shardPaths.push(nextPath);
    }
  };

  visit(directoryPath, 0);
  return shardPaths.sort(compareShardPaths(directoryPath));
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

/**
 * Merge the MUTABLE overlay onto the base, honoring CONFIG_TOMBSTONE markers so a
 * key that updateConfig removed from a base shard stays removed across reloads.
 * Distinct from mergeConfigObjects (which never deletes) so tombstone semantics are
 * confined to the runtime overlay and can't leak into base+workspace shard merging.
 */
function applyMutableOverlay(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(overlay)) {
    if (value === CONFIG_TOMBSTONE) {
      delete merged[key];
      continue;
    }
    const baseValue = merged[key];
    if (isPlainObject(baseValue) && isPlainObject(value)) {
      merged[key] = applyMutableOverlay(baseValue, value);
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
    const serialized = `${JSON.stringify(withoutRuntimeSubAgents(config), null, 2)}\n`;
    if (existsSync(CONFIG_SOURCE.compiledPath)) {
      const existing = readFileSync(CONFIG_SOURCE.compiledPath, "utf-8");
      if (existing === serialized) return;
    }
    writeFileSync(CONFIG_SOURCE.compiledPath, serialized, "utf-8");
  } catch (err) {
    logger.warn({ err, path: CONFIG_SOURCE.compiledPath }, "Failed to write compiled config artifact");
  }
}

/** The loaded config without the sub-agents a runtime client laid over it (see setRuntimeSubAgent). */
function withoutRuntimeSubAgents(config: Config): Config {
  if (_runtimeSubAgents.size === 0) return config;
  const subAgents = Object.fromEntries(Object.entries(config.subAgents).filter(([name, agent]) => _runtimeSubAgents.get(name) !== agent));
  return { ...config, subAgents };
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

  // A base-shard key the mutator REMOVED won't appear in `updated`, so it produces
  // no overlay entry above and would be silently re-added by the base merge on the
  // next reload. Record an explicit tombstone so the removal survives. (Nested
  // objects whose keys were all removed yield an all-tombstone nestedOverlay, which
  // is non-empty and so is still emitted by the guard above.)
  for (const key of Object.keys(base)) {
    if (!Object.prototype.hasOwnProperty.call(updated, key)) {
      overlay[key] = CONFIG_TOMBSTONE;
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

// Per-section serialized strings, cached per Config object. loadConfig returns a
// fresh parse each reload, so the previous config (now `oldConfig`) was already
// serialized on the prior diff — only the NEW config is serialized this time,
// roughly halving the diff cost (the big subAgents/scenes/jobs blocks dominate).
// WeakMap so GC'd configs never leak.
const _sectionSerializeCache = new WeakMap<Config, Map<keyof Config, string>>();
function serializeConfigSections(config: Config): Map<keyof Config, string> {
  const cached = _sectionSerializeCache.get(config);
  if (cached) return cached;
  const map = new Map<keyof Config, string>();
  for (const key of Object.keys(config) as (keyof Config)[]) {
    map.set(key, JSON.stringify(config[key]));
  }
  _sectionSerializeCache.set(config, map);
  return map;
}

/**
 * Compare two Config objects and return a list of top-level section names that differ.
 * Used to avoid unnecessary subscriber notifications when only whitespace/formatting changed.
 */
function diffConfigSections(oldConfig: Config | null, newConfig: Config): string[] {
  if (!oldConfig) return ["_initial"];
  const oldSections = serializeConfigSections(oldConfig);
  const newSections = serializeConfigSections(newConfig);
  const changed: string[] = [];
  const allKeys = new Set([...oldSections.keys(), ...newSections.keys()]);
  for (const key of allKeys) {
    if (oldSections.get(key) !== newSections.get(key)) {
      changed.push(key as string);
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
  // The Laya sidecar: `sai start --laya` runs it and sets this, so the decision layer finds it
  // exactly when it is running. A baseUrl written in config wins over it.
  if (env["SAI_LAYA_URL"]?.trim()) {
    const decisions = (raw["decisions"] as Record<string, unknown> | undefined) ?? {};
    if (typeof decisions["baseUrl"] !== "string" || !decisions["baseUrl"].trim()) {
      raw["decisions"] = { ...decisions, baseUrl: env["SAI_LAYA_URL"].trim() };
    }
  }
  // Primary model provider endpoint — provider-NEUTRAL. The primary provider may be LM Studio,
  // Ollama, vLLM, llama.cpp, LocalAI, OpenRouter, or ANY OpenAI-compatible server; it just
  // happens to be wired through the `lmstudio` provider slot (an OpenAI-compatible adapter).
  // SAI_PRIMARY_MODEL_URL is canonical; SAI_LMSTUDIO_URL is a deprecated back-compat alias.
  const primaryModelUrl = env["SAI_PRIMARY_MODEL_URL"] ?? env["SAI_LMSTUDIO_URL"];
  if (primaryModelUrl) {
    const p = (raw["providers"] as Record<string, unknown> | undefined) ?? {};
    const lms = (p["lmstudio"] as Record<string, unknown> | undefined) ?? {};
    raw["providers"] = { ...(p as object), lmstudio: { ...lms, baseUrl: primaryModelUrl } };
  }
  // Image generation on the SAME OpenAI-compatible endpoint as chat.
  //
  // Only when the api is `openai-compatible`: a cluster that serves chat and images behind one
  // base URL would otherwise carry that URL twice, and the copy that nobody moved is the one
  // that breaks. An A1111 or ComfyUI deployment keeps its own endpoint untouched, and an
  // explicitly configured baseUrl always wins over this.
  if (primaryModelUrl) {
    const mm = (raw["multimodal"] as Record<string, unknown> | undefined) ?? {};
    const img = (mm["imageGeneration"] as Record<string, unknown> | undefined);
    if (img && img["api"] === "openai-compatible" && !String(img["baseUrl"] ?? "").trim()) {
      raw["multimodal"] = { ...(mm as object), imageGeneration: { ...img, baseUrl: primaryModelUrl } };
    }
  }

  // Primary provider API key — needed in general, not just for one engine (LM Studio uses a
  // placeholder, OpenRouter a real key, Ollama often none). SAI_PRIMARY_MODEL_KEY is canonical;
  // SAI_LMSTUDIO_API_KEY is the back-compat alias.
  const primaryModelKey = env["SAI_PRIMARY_MODEL_KEY"] ?? env["SAI_LMSTUDIO_API_KEY"];
  if (primaryModelKey) {
    const p = (raw["providers"] as Record<string, unknown> | undefined) ?? {};
    const lms = (p["lmstudio"] as Record<string, unknown> | undefined) ?? {};
    raw["providers"] = { ...(p as object), lmstudio: { ...lms, apiKey: primaryModelKey } };
  }
  // A System One decision model on the same llama-swap as chat (decisions.systemOne): with a model
  // named and no baseUrl of its own it follows SAI_PRIMARY_MODEL_URL and the primary key, as image
  // generation does, so the two endpoints cannot drift and the key is never written into config. A
  // baseUrl or apiKey set in config wins.
  const decisionsRaw = raw["decisions"] as Record<string, unknown> | undefined;
  const systemOneRaw = decisionsRaw?.["systemOne"] as Record<string, unknown> | undefined;
  if (systemOneRaw && String(systemOneRaw["model"] ?? "").trim() && !String(systemOneRaw["baseUrl"] ?? "").trim() && primaryModelUrl) {
    raw["decisions"] = {
      ...decisionsRaw,
      systemOne: {
        ...systemOneRaw,
        baseUrl: primaryModelUrl,
        ...(!String(systemOneRaw["apiKey"] ?? "").trim() && primaryModelKey ? { apiKey: primaryModelKey } : {}),
      },
    };
  }
  if (env["ANTHROPIC_API_KEY"]) {
    const p = (raw["providers"] as Record<string, unknown> | undefined) ?? {};
    const ant = (p["anthropic"] as Record<string, unknown> | undefined) ?? {};
    raw["providers"] = { ...(p as object), anthropic: { ...ant, apiKey: env["ANTHROPIC_API_KEY"] } };
  }
  if (env["ANTHROPIC_AUTH_TOKEN"] || env["CLAUDE_CODE_OAUTH_TOKEN"]) {
    // OAuth bearer token (sk-ant-oat...) — e.g. from Claude Code's `claude setup-token`.
    // Bills the Claude subscription instead of API pay-per-use; wins over apiKey.
    const p = (raw["providers"] as Record<string, unknown> | undefined) ?? {};
    const ant = (p["anthropic"] as Record<string, unknown> | undefined) ?? {};
    raw["providers"] = {
      ...(p as object),
      anthropic: { ...ant, authToken: env["ANTHROPIC_AUTH_TOKEN"] || env["CLAUDE_CODE_OAUTH_TOKEN"] },
    };
  }
  // Agent model tiers from env, so a Docker-only / wizard install can pin the WHOLE
  // model config (not just primary) without hand-editing config shards. Previously
  // only `primary` was overridable, which silently broke non-Qwen backends: the
  // fallback, embedding, and routing-tier ids stayed pinned to the maintainer's
  // Qwen models, so document RAG / semantic memory (embeddings) and the fast-lane
  // (routing) hit models the chosen endpoint doesn't serve.
  //   SAI_PRIMARY_MODEL   — canonical (SAI_DEFAULT_MODEL is the back-compat alias);
  //                         also seeds `fallback` unless SAI_FALLBACK_MODEL is set,
  //                         since a single-model backend has no separate fallback.
  //   SAI_FALLBACK_MODEL  — overrides fallback explicitly.
  //   SAI_EMBEDDING_MODEL — overrides the embedding model; set EMPTY to disable
  //                         vector embeddings (RAG degrades to keyword) instead of
  //                         pinning a model the endpoint lacks.
  //   SAI_ROUTING_MODEL   — overrides the routing tier; set EMPTY to disable the
  //                         fast-lane (turns take the full path).
  // For the tier overrides an empty string is meaningful ("disable"), so they gate
  // on presence (!== undefined), not truthiness.
  const primaryModel = env["SAI_PRIMARY_MODEL"] ?? env["SAI_DEFAULT_MODEL"];
  const fallbackModel = env["SAI_FALLBACK_MODEL"];
  const embeddingModel = env["SAI_EMBEDDING_MODEL"];
  const routingModel = env["SAI_ROUTING_MODEL"];
  if (primaryModel || fallbackModel !== undefined || embeddingModel !== undefined || routingModel !== undefined) {
    const agents = (raw["agents"] as Record<string, unknown> | undefined) ?? {};
    const defaults = (agents["defaults"] as Record<string, unknown> | undefined) ?? {};
    const model = (defaults["model"] as Record<string, unknown> | undefined) ?? {};
    const nextModel: Record<string, unknown> = { ...(model as object) };
    if (primaryModel) {
      nextModel["primary"] = primaryModel;
      if (fallbackModel === undefined) nextModel["fallback"] = primaryModel;
    }
    if (fallbackModel !== undefined) nextModel["fallback"] = fallbackModel;
    if (embeddingModel !== undefined) nextModel["embeddingModel"] = embeddingModel;
    if (routingModel !== undefined) {
      const tiers = (model["tiers"] as Record<string, unknown> | undefined) ?? {};
      nextModel["tiers"] = { ...(tiers as object), routing: routingModel };
    }
    raw["agents"] = {
      ...(agents as object),
      defaults: { ...(defaults as object), model: nextModel },
    };
  }
  if (env["TELEGRAM_BOT_TOKEN"]) {
    const ch = (raw["channels"] as Record<string, unknown> | undefined) ?? {};
    const tg = (ch["telegram"] as Record<string, unknown> | undefined) ?? {};
    raw["channels"] = { ...(ch as object), telegram: { ...tg, enabled: true, botToken: env["TELEGRAM_BOT_TOKEN"] } };
  }
  // Email channel — enabled ONLY when it is actually configured. An IMAP host plus
  // credentials is the minimum that can work; without them the adapter would spin on
  // a connection it can never make. Configured means on, unconfigured means off, so
  // there is no separate flag to remember and no half-enabled state. Mirrors the
  // TELEGRAM_BOT_TOKEN rule above. An explicit `enabled: false` in a shard still
  // wins, so an operator can hold it back while leaving credentials in place.
  if (env["SAI_EMAIL_IMAP_HOST"] && env["SAI_EMAIL_IMAP_USER"] && env["SAI_EMAIL_IMAP_PASSWORD"]) {
    const ch = (raw["channels"] as Record<string, unknown> | undefined) ?? {};
    const email = (ch["email"] as Record<string, unknown> | undefined) ?? {};
    raw["channels"] = {
      ...(ch as object),
      email: {
        ...email,
        enabled: email["enabled"] === false ? false : true,
        imapHost: env["SAI_EMAIL_IMAP_HOST"],
        imapUser: env["SAI_EMAIL_IMAP_USER"],
        imapPassword: env["SAI_EMAIL_IMAP_PASSWORD"],
        ...(env["SAI_EMAIL_IMAP_PORT"] ? { imapPort: Number(env["SAI_EMAIL_IMAP_PORT"]) } : {}),
        ...(env["SAI_EMAIL_SMTP_HOST"] ? { smtpHost: env["SAI_EMAIL_SMTP_HOST"] } : {}),
        ...(env["SAI_EMAIL_SMTP_PORT"] ? { smtpPort: Number(env["SAI_EMAIL_SMTP_PORT"]) } : {}),
        ...(env["SAI_EMAIL_SMTP_USER"] ? { smtpUser: env["SAI_EMAIL_SMTP_USER"] } : {}),
        ...(env["SAI_EMAIL_SMTP_PASSWORD"] ? { smtpPassword: env["SAI_EMAIL_SMTP_PASSWORD"] } : {}),
        ...(env["SAI_EMAIL_SMTP_FROM"] ? { smtpFrom: env["SAI_EMAIL_SMTP_FROM"] } : {}),
      },
    };
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
  // OIDC/SSO identity backend from env (Docker-first / setup wizard). Setting
  // SAI_AUTH_PROVIDER=oidc turns auth ON and selects the OIDC provider; the
  // SAI_OIDC_* vars fill auth.oidc. The client secret is stored as a $ENV REF
  // (resolved at runtime), so it never lands in the compiled starlingai.json.
  if (env["SAI_AUTH_PROVIDER"] || env["SAI_OIDC_ISSUER"]) {
    const auth = (raw["auth"] as Record<string, unknown> | undefined) ?? {};
    const oidc = (auth["oidc"] as Record<string, unknown> | undefined) ?? {};
    const nextOidc: Record<string, unknown> = { ...(oidc as object) };
    if (env["SAI_OIDC_ISSUER"]) nextOidc["issuer"] = env["SAI_OIDC_ISSUER"];
    if (env["SAI_OIDC_CLIENT_ID"]) nextOidc["clientId"] = env["SAI_OIDC_CLIENT_ID"];
    if (env["SAI_OIDC_CLIENT_SECRET"]) nextOidc["clientSecret"] = "$SAI_OIDC_CLIENT_SECRET";
    if (env["SAI_OIDC_PUBLIC_URL"]) nextOidc["publicUrl"] = env["SAI_OIDC_PUBLIC_URL"];
    if (env["SAI_OIDC_A2A_ENABLED"] || env["SAI_OIDC_A2A_AUDIENCE"]) {
      const a2a: Record<string, unknown> = { ...((oidc["a2a"] as Record<string, unknown> | undefined) ?? {}) };
      if (env["SAI_OIDC_A2A_ENABLED"]) {
        a2a["enabled"] = ["1", "true", "yes", "on"].includes(env["SAI_OIDC_A2A_ENABLED"].trim().toLowerCase());
      }
      // Required when a2a.enabled (audience confusion guard) — expose it via env so an
      // A2A-via-env setup can actually satisfy the config-validation requirement.
      if (env["SAI_OIDC_A2A_AUDIENCE"]) a2a["audience"] = env["SAI_OIDC_A2A_AUDIENCE"];
      nextOidc["a2a"] = a2a;
    }
    const isOidc = env["SAI_AUTH_PROVIDER"] === "oidc";
    raw["auth"] = {
      ...(auth as object),
      ...(isOidc ? { enabled: true, provider: "oidc" } : {}),
      ...(Object.keys(nextOidc).length ? { oidc: nextOidc } : {}),
    };
  }
  // Upload storage + malware scanning from env (Docker-first / bundled default).
  // The bundled compose sets SAI_STORAGE_BACKEND=s3 + SAI_UPLOAD_SCAN=true; keys
  // are kept as $ENV refs so they never land in the compiled config.
  const truthy = (v?: string) => ["1", "true", "yes", "on"].includes((v ?? "").trim().toLowerCase());
  if (env["SAI_STORAGE_BACKEND"] || env["SAI_S3_ENDPOINT"] || env["SAI_UPLOAD_SCAN"] || env["SAI_CLAMD_HOST"]) {
    const storage = (raw["storage"] as Record<string, unknown> | undefined) ?? {};
    const s3 = (storage["s3"] as Record<string, unknown> | undefined) ?? {};
    const scan = (storage["scan"] as Record<string, unknown> | undefined) ?? {};
    const nextS3: Record<string, unknown> = { ...(s3 as object) };
    if (env["SAI_S3_ENDPOINT"]) nextS3["endpoint"] = env["SAI_S3_ENDPOINT"];
    if (env["SAI_S3_REGION"]) nextS3["region"] = env["SAI_S3_REGION"];
    if (env["SAI_S3_BUCKET"]) nextS3["bucket"] = env["SAI_S3_BUCKET"];
    if (env["SAI_S3_ACCESS_KEY_ID"]) nextS3["accessKeyId"] = "$SAI_S3_ACCESS_KEY_ID";
    if (env["SAI_S3_SECRET_ACCESS_KEY"]) nextS3["secretAccessKey"] = "$SAI_S3_SECRET_ACCESS_KEY";
    if (env["SAI_S3_FORCE_PATH_STYLE"] !== undefined) nextS3["forcePathStyle"] = truthy(env["SAI_S3_FORCE_PATH_STYLE"]);
    const nextScan: Record<string, unknown> = { ...(scan as object) };
    if (env["SAI_UPLOAD_SCAN"] !== undefined) nextScan["enabled"] = truthy(env["SAI_UPLOAD_SCAN"]);
    if (env["SAI_CLAMD_HOST"]) nextScan["clamdHost"] = env["SAI_CLAMD_HOST"];
    if (env["SAI_CLAMD_PORT"]) nextScan["clamdPort"] = Number(env["SAI_CLAMD_PORT"]);
    raw["storage"] = {
      ...(storage as object),
      ...(env["SAI_STORAGE_BACKEND"] ? { backend: env["SAI_STORAGE_BACKEND"] === "s3" ? "s3" : "local" } : {}),
      ...(Object.keys(nextS3).length ? { s3: nextS3 } : {}),
      ...(Object.keys(nextScan).length ? { scan: nextScan } : {}),
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
            // Truthy ALLOWLIST (fail-closed): only 1/true/yes/on (any case, trimmed)
            // enable this privileged capability. The old blocklist enabled it for
            // every value except four exact strings, so `disabled`/`no`/`FaLsE`/typos
            // silently turned it ON.
            enabled: ["1", "true", "yes", "on"].includes(env["SAI_COMPUTER_USE_ENABLED"].trim().toLowerCase()),
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
  const homeConfigDir = resolve(homedir(), PRODUCT.stateDirName, DEFAULT_CONFIG_DIRECTORY_NAME);
  const homeWorkspaceDir = resolve(homedir(), PRODUCT.stateDirName, DEFAULT_WORKSPACE_DIRECTORY_NAME);
  if (existsSync(homeConfigDir) && existsSync(homeWorkspaceDir)) {
    return { basePath: homeConfigDir, workspacePath: homeWorkspaceDir };
  }
  for (const legacyName of LEGACY_CONFIG_DIRECTORY_NAMES) {
    const legacyDir = resolve(homedir(), PRODUCT.stateDirName, legacyName);
    if (existsSync(legacyDir)) {
      logger.warn({ path: legacyDir }, "Using legacy config directory — migrate to config/ + workspace/ layout");
      return { basePath: legacyDir, workspacePath: null };
    }
  }
  const homeConfigFile = resolve(homedir(), PRODUCT.stateDirName, DEFAULT_CONFIG_FILE_NAME);
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
      // No link is followed here either; the sweep warns about each (collectConfigShardPaths).
      const next = resolve(path, entry.name);
      if (sweepEntryKind(next) !== "directory") continue;
      addDirectoryTree(next);
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
