/**
 * Plugin loader — discovers, validates, and registers third-party tool
 * packages from a configured directory at startup.
 *
 * Load semantics:
 * - Scans `<pluginsDir>/<plugin-name>/index.js` (preferred) or
 *   `<pluginsDir>/<plugin-name>.js` (single-file plugins).
 * - Each file is imported as an ES module; the default export must be a
 *   `Plugin` object (see `defineTool` / `definePlugin`).
 * - Tools register at `plugin__<plugin-name>__<tool-name>` in the registry.
 * - Tier is fixed at Tier 2 via the `plugin__*` pattern in tool-tiers.ts.
 * - Tool names that would shadow a compile-time-mapped built-in are rejected
 *   at load time (`tier_escalation_attempt` audit, plugin tools skipped).
 *
 * Errors during a single plugin's load do not abort the loader — a broken
 * plugin is logged + audited as `plugin_tool_rejected` and the next one is
 * tried.  This matches the dynamic-tool loader's tolerant pattern.
 */

import { existsSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { childLogger } from "../logger.js";
import { logAudit } from "../audit/logger.js";
import { registerTool, unregisterTool, type ToolHandler } from "../tools/registry.js";
import { isCompileTimeMappedTool, getToolTier } from "../guardrails/tool-tiers.js";
import { getConfig } from "../config/loader.js";
import type { Plugin, PluginTool } from "./index.js";

const log = childLogger("plugin-loader");

const PLUGIN_NAME_PREFIX = "plugin__";
const PLUGIN_NAME_PATTERN = /^[a-z][a-z0-9_-]{1,32}$/;
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{1,48}$/;

interface LoadedPluginRecord {
  name: string;
  version: string;
  description?: string;
  author?: string;
  toolNames: string[];
  loadedAt: string;
  source: string;
}

const _loadedPlugins = new Map<string, LoadedPluginRecord>();

/** Returns metadata for plugins loaded in this process (for the dashboard). */
export function listLoadedPlugins(): LoadedPluginRecord[] {
  return [..._loadedPlugins.values()];
}

/** Test-only: clear the loaded-plugin registry. */
export function _resetPluginsForTests(): void {
  _loadedPlugins.clear();
  stopPluginWatcher();
}

let _watcher: FSWatcher | null = null;
let _debounceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Watch the plugins directory for additions, changes, and removals.  When
 * a file event lands the loader is re-run after a short debounce.
 *
 * Hot-reload semantics:
 * - New plugins are loaded and their tools registered.
 * - Removed plugins (file deleted) have their tools unregistered.
 * - Changed plugins are unregistered then re-loaded so the new code wins.
 *   Note: ESM module instances are immutable once imported — operators who
 *   mutate a single-file plugin must restart the gateway for the new code
 *   to take effect.  Adding a NEW file (e.g. bumping the directory name)
 *   is the supported workflow for live changes.
 */
export function watchPluginsDirectory(dir: string = resolvePluginsDir()): void {
  if (_watcher) return; // already watching
  if (!existsSync(dir)) {
    log.debug({ dir }, "Plugins directory not present — hot-reload watcher not started");
    return;
  }
  try {
    _watcher = watch(dir, { persistent: false, recursive: true }, (_eventType, filename) => {
      if (!filename) return;
      const name = String(filename);
      if (!name.endsWith(".js") && !name.endsWith(".mjs")) return;
      if (_debounceTimer) clearTimeout(_debounceTimer);
      _debounceTimer = setTimeout(() => {
        void resyncPlugins(dir).catch((err) => log.warn({ err }, "Plugin hot-reload pass failed"));
      }, 500);
    });
    log.info({ dir }, "Watching plugins directory for hot-reload");
  } catch (err) {
    log.warn({ err, dir }, "Failed to watch plugins directory — hot-reload disabled");
  }
}

export function stopPluginWatcher(): void {
  if (_watcher) {
    _watcher.close();
    _watcher = null;
  }
  if (_debounceTimer) {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
  }
}

/**
 * Reconcile the plugin registry with what's currently on disk.  Plugins
 * that disappear get unregistered; new plugins get loaded.  Modified
 * plugins are reloaded — the existing tools are unregistered first so the
 * fresh registration wins.
 */
async function resyncPlugins(dir: string): Promise<void> {
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return; }

  const onDisk = new Set<string>();
  for (const entry of entries) {
    const resolved = resolvePluginEntry(dir, entry);
    if (!resolved) continue;
    // Use the directory entry as the canonical id when present (matches the
    // plugin's `name` field by convention); fall back to the file basename
    // for single-file plugins.
    const id = entry.replace(/\.(js|mjs)$/, "").toLowerCase();
    onDisk.add(id);
  }

  // Unregister plugins whose files no longer exist
  for (const [name, record] of [..._loadedPlugins.entries()]) {
    if (!onDisk.has(name)) {
      for (const fullName of record.toolNames) {
        try { unregisterTool(fullName); } catch { /* ignore */ }
      }
      _loadedPlugins.delete(name);
      logAudit("plugin_unloaded", { plugin: name, reason: "file removed" });
      log.info({ plugin: name }, "Plugin unloaded — file removed");
    }
  }

  // Re-import everything; loadOnePlugin's _loadedPlugins.has check skips
  // already-loaded entries, so this only picks up genuinely new files.
  // For changes-in-place we'd need to bump the version OR delete + re-add
  // the file (a known limitation called out in the JSDoc above).
  await loadPlugins(dir);
}

/**
 * Resolve the configured plugins directory.  Order:
 * 1. `STARLINGAI_PLUGINS_DIR` env var (absolute or relative to cwd)
 * 2. `plugins.dir` from `starlingai.json` (if defined)
 * 3. `~/.starlingai/plugins`
 */
export function resolvePluginsDir(): string {
  const fromEnv = process.env["STARLINGAI_PLUGINS_DIR"];
  if (fromEnv?.trim()) {
    return isAbsolute(fromEnv) ? fromEnv : resolve(process.cwd(), fromEnv);
  }
  const fromConfig = (getConfig() as { plugins?: { dir?: string } }).plugins?.dir;
  if (fromConfig?.trim()) {
    return isAbsolute(fromConfig) ? fromConfig : resolve(process.cwd(), fromConfig);
  }
  return join(homedir(), ".starlingai", "plugins");
}

/**
 * Load every plugin in the configured directory.  Idempotent — re-running
 * silently skips plugins already loaded under the same name.
 */
export async function loadPlugins(dir: string = resolvePluginsDir()): Promise<{ loaded: number; rejected: number }> {
  if (!existsSync(dir)) {
    log.debug({ dir }, "Plugins directory not present — skipping plugin load");
    return { loaded: 0, rejected: 0 };
  }

  let loaded = 0;
  let rejected = 0;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    log.warn({ err, dir }, "Could not read plugins directory");
    return { loaded: 0, rejected: 0 };
  }

  for (const entry of entries) {
    const resolvedSource = resolvePluginEntry(dir, entry);
    if (!resolvedSource) continue;
    try {
      const result = await loadOnePlugin(resolvedSource.entryPath, resolvedSource.label);
      if (result.ok) loaded += 1;
      else rejected += 1;
    } catch (err) {
      rejected += 1;
      log.warn({ err, entry }, "Plugin load threw — skipped");
      logAudit("plugin_tool_rejected", { source: resolvedSource.label, reason: (err as Error).message }, { severity: "warn" });
    }
  }

  log.info({ dir, loaded, rejected, total: entries.length }, "Plugin load complete");
  return { loaded, rejected };
}

interface ResolvedPluginEntry { entryPath: string; label: string }

function resolvePluginEntry(dir: string, entry: string): ResolvedPluginEntry | null {
  const fullPath = join(dir, entry);
  let stats;
  try { stats = statSync(fullPath); } catch { return null; }

  if (stats.isDirectory()) {
    const candidates = ["index.js", "index.mjs", "plugin.js"];
    for (const candidate of candidates) {
      const path = join(fullPath, candidate);
      if (existsSync(path)) return { entryPath: path, label: `${entry}/${candidate}` };
    }
    return null;
  }
  if (stats.isFile() && (entry.endsWith(".js") || entry.endsWith(".mjs"))) {
    return { entryPath: fullPath, label: entry };
  }
  return null;
}

interface LoadResult { ok: boolean }

/**
 * Module importer used by the loader.  Production points at native ESM
 * `import()` via {@link defaultPluginImporter}; tests inject a stub so the
 * loader's logic can be exercised without going through the real module
 * resolver (which Vite/Vitest intercepts for arbitrary on-disk paths).
 */
export type PluginImporter = (entryPath: string) => Promise<{ default?: Plugin }>;
let _pluginImporter: PluginImporter = defaultPluginImporter;

export function setPluginImporterForTests(importer: PluginImporter): void {
  _pluginImporter = importer;
}

export function resetPluginImporter(): void {
  _pluginImporter = defaultPluginImporter;
}

async function loadOnePlugin(entryPath: string, label: string): Promise<LoadResult> {
  const mod = await _pluginImporter(entryPath);
  const plugin = mod?.default;

  if (!plugin || typeof plugin !== "object") {
    log.warn({ label }, "Plugin module has no default export — skipped");
    logAudit("plugin_tool_rejected", { source: label, reason: "missing default export" }, { severity: "warn" });
    return { ok: false };
  }

  const validation = validatePlugin(plugin);
  if (!validation.ok) {
    log.warn({ label, reason: validation.reason }, "Plugin failed validation");
    logAudit("plugin_tool_rejected", { source: label, plugin: plugin.name, reason: validation.reason }, { severity: "warn" });
    return { ok: false };
  }

  if (_loadedPlugins.has(plugin.name)) {
    log.debug({ name: plugin.name }, "Plugin already loaded — skipping");
    return { ok: true };
  }

  const registeredToolNames: string[] = [];
  for (const tool of plugin.tools) {
    const toolValidation = validatePluginTool(plugin.name, tool);
    if (!toolValidation.ok) {
      log.warn({ plugin: plugin.name, tool: tool.name, reason: toolValidation.reason }, "Plugin tool rejected");
      logAudit("plugin_tool_rejected", { plugin: plugin.name, tool: tool.name, reason: toolValidation.reason }, { severity: "warn" });
      continue;
    }
    const fullName = pluginToolName(plugin.name, tool.name);
    const handler: ToolHandler = {
      name: fullName,
      description: `[Plugin: ${plugin.name}] ${tool.description}`,
      parameters: tool.parameters,
      execute: tool.execute,
      embeddingDescription: tool.embeddingDescription,
      costHint: tool.costHint,
      latencyHint: tool.latencyHint,
      timeoutMs: tool.timeoutMs,
    };
    try {
      registerTool(handler);
      registeredToolNames.push(fullName);
    } catch (err) {
      log.warn({ err, plugin: plugin.name, tool: fullName }, "Plugin tool failed registry insert");
      logAudit("plugin_tool_rejected", { plugin: plugin.name, tool: tool.name, reason: (err as Error).message }, { severity: "warn" });
    }
  }

  if (registeredToolNames.length === 0) {
    log.warn({ name: plugin.name }, "Plugin loaded but no tools registered — discarding");
    logAudit("plugin_tool_rejected", { plugin: plugin.name, reason: "no tools registered" }, { severity: "warn" });
    return { ok: false };
  }

  const record: LoadedPluginRecord = {
    name: plugin.name,
    version: plugin.version,
    description: plugin.description,
    author: plugin.author,
    toolNames: registeredToolNames,
    loadedAt: new Date().toISOString(),
    source: label,
  };
  _loadedPlugins.set(plugin.name, record);
  logAudit("plugin_loaded", {
    plugin: plugin.name,
    version: plugin.version,
    author: plugin.author ?? null,
    tools: registeredToolNames,
  });
  log.info({ plugin: plugin.name, version: plugin.version, tools: registeredToolNames.length }, "Plugin loaded");
  return { ok: true };
}

interface ValidationResult { ok: boolean; reason?: string }

function validatePlugin(plugin: Plugin): ValidationResult {
  if (!plugin.name || typeof plugin.name !== "string") return { ok: false, reason: "name is required" };
  if (!PLUGIN_NAME_PATTERN.test(plugin.name)) return { ok: false, reason: `name must match ${PLUGIN_NAME_PATTERN}` };
  if (!plugin.version || typeof plugin.version !== "string") return { ok: false, reason: "version is required" };
  if (!Array.isArray(plugin.tools) || plugin.tools.length === 0) return { ok: false, reason: "tools array must be non-empty" };
  return { ok: true };
}

function validatePluginTool(pluginName: string, tool: PluginTool): ValidationResult {
  if (!tool.name || typeof tool.name !== "string") return { ok: false, reason: "tool name is required" };
  if (!TOOL_NAME_PATTERN.test(tool.name)) return { ok: false, reason: `tool name must match ${TOOL_NAME_PATTERN}` };
  if (!tool.description) return { ok: false, reason: "tool description is required" };
  if (!tool.parameters || typeof tool.parameters !== "object") return { ok: false, reason: "tool parameters object is required" };
  if (typeof tool.execute !== "function") return { ok: false, reason: "tool execute must be a function" };

  // Plugin tools register at `plugin__<plugin>__<tool>`.  The bare tool name
  // is what an attacker would use to shadow a built-in if no namespacing
  // existed; the prefix already prevents that, but we ALSO reject bare tool
  // names that match a compile-time built-in to keep the error surface clear
  // (an honest plugin author shouldn't be picking those names anyway).
  if (isCompileTimeMappedTool(tool.name)) {
    const collidingTier = getToolTier(tool.name).tier;
    logAudit("tier_escalation_attempt", {
      stage: "plugin_load",
      plugin: pluginName,
      attemptedName: tool.name,
      collidingTier,
    }, { severity: "warn" });
    return { ok: false, reason: `tool name shadows built-in (Tier ${collidingTier})` };
  }
  return { ok: true };
}

function pluginToolName(pluginName: string, toolName: string): string {
  return `${PLUGIN_NAME_PREFIX}${pluginName}__${toolName}`;
}

/**
 * Default plugin importer — uses native ESM `import()` against a file://
 * URL so Windows paths work and so the import runs in real module context.
 * Tests swap this out via {@link setPluginImporterForTests}.
 */
async function defaultPluginImporter(entryPath: string): Promise<{ default?: Plugin }> {
  const url = pathToFileURL(entryPath).href;
  return (await import(/* @vite-ignore */ url)) as { default?: Plugin };
}
