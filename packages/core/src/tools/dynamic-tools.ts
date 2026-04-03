/**
 * Dynamic Tools — hot-deploy manager for self-developed tools.
 *
 * Approved tools are persisted as JSON bundles in .starlingai/dynamic_tools/.
 * A file watcher detects new/changed/removed tools and registers or
 * unregisters them in the live tool registry at runtime — no rebuild required.
 *
 * All dynamic tools:
 *   - Are prefixed with selfdev__ (e.g. selfdev__csv_to_json)
 *   - Always execute in the Docker sandbox (never on host)
 *   - Require per-call approval (Tier 2)
 *   - Are discoverable via list_agents and search_agents
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, watch, type FSWatcher } from "node:fs";
import { join, basename } from "node:path";
import { childLogger } from "../logger.js";
import { registerTool, unregisterTool, type ToolHandler, type ToolContext, type ToolResult } from "./registry.js";
import { executeDynamicTool } from "./dynamic-tool-executor.js";
import { logAudit } from "../audit/logger.js";
import { emitSwarmEvent } from "../swarm/bus.js";
import type { TestRun } from "../agent/tool-dev-session.js";

const log = childLogger("dynamic-tools");

// ── Candidate bundle format ─────────────────────────────────────────────────

export interface DynamicToolDefinition {
  name: string;                           // without selfdev__ prefix
  description: string;
  parameters: Record<string, unknown>;    // JSON Schema
  code: string;                           // TypeScript source
  version: number;
  approvedAt: string;
  approvedBy: string;                     // "human", channel name, or "auto"
  testResults: TestRun[];
  devSessionId?: string;
  previousVersion?: number;
}

// ── Constants ───────────────────────────────────────────────────────────────

const DYNAMIC_TOOLS_DIR = join(
  process.env["SAI_DATA_DIR"] ?? (process.env["HOME"] ?? "/data"),
  ".starlingai",
  "dynamic_tools",
);

const TOOL_NAME_PREFIX = "selfdev__";

// ── State ───────────────────────────────────────────────────────────────────

const _loadedTools = new Map<string, DynamicToolDefinition>();
let _watcher: FSWatcher | null = null;
let _debounceTimer: ReturnType<typeof setTimeout> | null = null;

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Load all dynamic tools from disk and register them.
 * Called once at gateway startup.
 */
export function loadDynamicTools(): void {
  ensureDir();

  const files = readdirSync(DYNAMIC_TOOLS_DIR).filter((f) => f.endsWith(".json"));
  let loaded = 0;

  for (const file of files) {
    try {
      const filePath = join(DYNAMIC_TOOLS_DIR, file);
      const raw = readFileSync(filePath, "utf-8");
      const def = JSON.parse(raw) as DynamicToolDefinition;

      if (validateDefinition(def)) {
        registerDynamicTool(def);
        loaded++;
      } else {
        log.warn({ file }, "Invalid dynamic tool definition — skipped");
      }
    } catch (err) {
      log.warn({ err, file }, "Failed to load dynamic tool");
    }
  }

  log.info({ loaded, total: files.length, dir: DYNAMIC_TOOLS_DIR }, "Dynamic tools loaded");
}

/**
 * Start watching the dynamic tools directory for changes.
 * Uses fs.watch with debounce (same pattern as config/loader.ts).
 */
export function watchDynamicToolsDirectory(): void {
  ensureDir();

  try {
    _watcher = watch(DYNAMIC_TOOLS_DIR, { persistent: false }, (_eventType, filename) => {
      if (!filename || !filename.endsWith(".json")) return;

      // Debounce: 500ms to batch rapid changes
      if (_debounceTimer) clearTimeout(_debounceTimer);
      _debounceTimer = setTimeout(() => {
        syncDynamicTools();
      }, 500);
    });

    log.info({ dir: DYNAMIC_TOOLS_DIR }, "Watching dynamic tools directory");
  } catch (err) {
    log.warn({ err }, "Failed to watch dynamic tools directory — hot-deploy disabled");
  }
}

/**
 * Deploy a tool after approval.
 * Writes the definition to disk, which triggers the watcher to register it.
 */
export function deployApprovedTool(def: DynamicToolDefinition): void {
  ensureDir();

  // Check for existing version and bump
  const existing = _loadedTools.get(def.name);
  if (existing) {
    def.previousVersion = existing.version;
    def.version = existing.version + 1;
  }

  const filePath = join(DYNAMIC_TOOLS_DIR, `${def.name}.json`);
  writeFileSync(filePath, JSON.stringify(def, null, 2), "utf-8");

  // Also register immediately (don't wait for watcher)
  registerDynamicTool(def);

  logAudit("tool_deployed", { toolName: def.name, version: def.version, approvedBy: def.approvedBy }, {
    severity: "info",
  });

  emitSwarmEvent("tool_deployed", {
    data: { toolName: `${TOOL_NAME_PREFIX}${def.name}`, version: def.version },
  });

  log.info({ toolName: def.name, version: def.version }, "Dynamic tool deployed");
}

/**
 * Rollback a dynamic tool — unregister and optionally restore previous version.
 */
export function rollbackDynamicTool(toolName: string): boolean {
  const def = _loadedTools.get(toolName);
  if (!def) return false;

  const fullName = `${TOOL_NAME_PREFIX}${toolName}`;
  unregisterTool(fullName);
  _loadedTools.delete(toolName);

  // Remove the file
  try {
    unlinkSync(join(DYNAMIC_TOOLS_DIR, `${toolName}.json`));
  } catch {
    // File may already be gone
  }

  emitSwarmEvent("tool_undeployed", {
    data: { toolName: fullName },
  });

  log.info({ toolName }, "Dynamic tool rolled back");
  return true;
}

/**
 * Stop watching and unregister all dynamic tools.
 */
export function shutdownDynamicTools(): void {
  if (_watcher) {
    _watcher.close();
    _watcher = null;
  }
  if (_debounceTimer) {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
  }

  for (const name of _loadedTools.keys()) {
    unregisterTool(`${TOOL_NAME_PREFIX}${name}`);
  }
  _loadedTools.clear();

  log.info("Dynamic tools shut down");
}

/**
 * Get list of all loaded dynamic tools.
 */
export function getLoadedDynamicTools(): DynamicToolDefinition[] {
  return [..._loadedTools.values()];
}

// ── Internal ────────────────────────────────────────────────────────────────

function registerDynamicTool(def: DynamicToolDefinition): void {
  const fullName = `${TOOL_NAME_PREFIX}${def.name}`;

  // Unregister if already loaded (version upgrade)
  if (_loadedTools.has(def.name)) {
    unregisterTool(fullName);
  }

  const handler: ToolHandler = {
    name: fullName,
    description: `[Self-developed] ${def.description}`,
    parameters: def.parameters,
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      return executeDynamicTool(def.code, args, ctx);
    },
  };

  try {
    registerTool(handler);
    _loadedTools.set(def.name, def);
    log.info({ toolName: fullName, version: def.version }, "Dynamic tool registered");
  } catch (err) {
    log.error({ err, toolName: fullName }, "Failed to register dynamic tool");
  }
}

function syncDynamicTools(): void {
  if (!existsSync(DYNAMIC_TOOLS_DIR)) return;

  const files = readdirSync(DYNAMIC_TOOLS_DIR).filter((f) => f.endsWith(".json"));
  const fileNames = new Set(files.map((f) => basename(f, ".json")));

  // Register new / updated tools
  for (const file of files) {
    try {
      const filePath = join(DYNAMIC_TOOLS_DIR, file);
      const raw = readFileSync(filePath, "utf-8");
      const def = JSON.parse(raw) as DynamicToolDefinition;

      if (!validateDefinition(def)) continue;

      const existing = _loadedTools.get(def.name);
      if (!existing || existing.version !== def.version || existing.approvedAt !== def.approvedAt) {
        registerDynamicTool(def);
      }
    } catch (err) {
      log.warn({ err, file }, "Failed to sync dynamic tool");
    }
  }

  // Unregister removed tools
  for (const name of _loadedTools.keys()) {
    if (!fileNames.has(name)) {
      unregisterTool(`${TOOL_NAME_PREFIX}${name}`);
      _loadedTools.delete(name);
      log.info({ toolName: name }, "Dynamic tool unregistered (file removed)");
    }
  }
}

function validateDefinition(def: DynamicToolDefinition): boolean {
  if (!def.name || typeof def.name !== "string") return false;
  if (!/^[a-z][a-z0-9_]{1,48}$/.test(def.name)) return false;
  if (!def.description) return false;
  if (!def.code) return false;
  if (!def.parameters || typeof def.parameters !== "object") return false;
  if (!def.approvedAt) return false;
  if (!def.approvedBy) return false;
  if (typeof def.version !== "number") return false;
  return true;
}

function ensureDir(): void {
  if (!existsSync(DYNAMIC_TOOLS_DIR)) {
    mkdirSync(DYNAMIC_TOOLS_DIR, { recursive: true });
  }
}
