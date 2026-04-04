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
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    code: string;
    version: number;
    approvedAt: string;
    approvedBy: string;
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

export function loadDynamicTools(): void {
    ensureDir();

    const files = readdirSync(DYNAMIC_TOOLS_DIR).filter((file) => file.endsWith(".json"));
    let loaded = 0;

    for (const file of files) {
        try {
            const filePath = join(DYNAMIC_TOOLS_DIR, file);
            const raw = readFileSync(filePath, "utf-8");
            const def = JSON.parse(raw) as DynamicToolDefinition;

            if (validateDefinition(def)) {
                registerDynamicTool(def);
                loaded += 1;
            } else {
                log.warn({ file }, "Invalid dynamic tool definition — skipped");
            }
        } catch (err) {
            log.warn({ err, file }, "Failed to load dynamic tool");
        }
    }

    log.info({ loaded, total: files.length, dir: DYNAMIC_TOOLS_DIR }, "Dynamic tools loaded");
}

export function watchDynamicToolsDirectory(): void {
    ensureDir();

    try {
        _watcher = watch(DYNAMIC_TOOLS_DIR, { persistent: false }, (_eventType, filename) => {
            if (!filename || !filename.endsWith(".json")) return;

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

export function deployApprovedTool(def: DynamicToolDefinition): void {
    ensureDir();

    const existing = _loadedTools.get(def.name);
    if (existing) {
        def.previousVersion = existing.version;
        def.version = existing.version + 1;
    }

    const filePath = join(DYNAMIC_TOOLS_DIR, `${def.name}.json`);
    writeFileSync(filePath, JSON.stringify(def, null, 2), "utf-8");

    registerDynamicTool(def);

    logAudit("tool_deployed", { toolName: def.name, version: def.version, approvedBy: def.approvedBy }, {
        severity: "info",
    });

    emitSwarmEvent("tool_deployed", {
        data: { toolName: `${TOOL_NAME_PREFIX}${def.name}`, version: def.version },
    });

    log.info({ toolName: def.name, version: def.version }, "Dynamic tool deployed");
}

export function rollbackDynamicTool(toolName: string): boolean {
    const def = _loadedTools.get(toolName);
    if (!def) return false;

    const fullName = `${TOOL_NAME_PREFIX}${toolName}`;
    unregisterTool(fullName);
    _loadedTools.delete(toolName);

    try {
        unlinkSync(join(DYNAMIC_TOOLS_DIR, `${toolName}.json`));
    } catch {
        // File may already be gone.
    }

    emitSwarmEvent("tool_undeployed", {
        data: { toolName: fullName },
    });

    log.info({ toolName }, "Dynamic tool rolled back");
    return true;
}

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

export function getLoadedDynamicTools(): DynamicToolDefinition[] {
    return [..._loadedTools.values()];
}

// ── Internal ────────────────────────────────────────────────────────────────

function registerDynamicTool(def: DynamicToolDefinition): void {
    const fullName = `${TOOL_NAME_PREFIX}${def.name}`;

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

    const files = readdirSync(DYNAMIC_TOOLS_DIR).filter((file) => file.endsWith(".json"));
    const fileNames = new Set(files.map((file) => basename(file, ".json")));

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
    // Guard against prefix stacking: the tool name must not begin with the
    // system-reserved "selfdev__" prefix — that prefix is added automatically
    // by the deploy path. A name like "selfdev__something" would register as
    // "selfdev__selfdev__something", causing confusing double-prefix routing.
    if (def.name.startsWith("selfdev__")) return false;
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