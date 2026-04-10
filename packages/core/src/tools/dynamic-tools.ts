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
import { getConfig } from "../config/loader.js";
import { requestApprovalViaChannel } from "../approval/index.js";
import { recordSelfdevToolSuccess } from "../agent/self-improve.js";
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
    /** Promotion lifecycle: undefined / "none" = not nominated, "pending" = awaiting operator review */
    promotionStatus?: "none" | "pending" | "approved" | "rejected";
    promotionNominatedAt?: string;
    /**
     * Persisted runtime call stats — written to disk periodically so counters
     * survive gateway restarts and continue toward the promotion threshold.
     */
    runtimeCalls?: number;
    runtimeSuccesses?: number;
}

// ── Promotion queue ─────────────────────────────────────────────────────────

export interface ToolPromotionCandidate {
    toolName: string;       // bare name (without selfdev__ prefix)
    fullName: string;       // selfdev__<toolName>
    description: string;
    callCount: number;
    successCount: number;
    successRate: number;
    status: "pending" | "approved" | "rejected";
    nominatedAt: string;
    reviewedAt?: string;
    reviewedBy?: string;
}

/** Minimum runtime calls before a tool is eligible for promotion nomination. */
const PROMOTION_MIN_CALLS = 10;
/** Minimum runtime success rate (0–1) for promotion eligibility. */
const PROMOTION_MIN_SUCCESS_RATE = 0.8;

interface _CallStats { calls: number; successes: number; }
const _runtimeStats = new Map<string, _CallStats>(); // keyed by bare tool name

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

    // Seed runtime stats from persisted values (survives gateway restarts).
    // Only initialise from disk if no in-memory entry exists yet — re-registrations
    // after a hot-reload preserve the accumulated in-process counts.
    if (!_runtimeStats.has(def.name)) {
        _runtimeStats.set(def.name, {
            calls: def.runtimeCalls ?? 0,
            successes: def.runtimeSuccesses ?? 0,
        });
    }

    const handler: ToolHandler = {
        name: fullName,
        description: `[Self-developed] ${def.description}`,
        parameters: def.parameters,
        async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
            const result = await executeDynamicTool(def.code, args, ctx);
            // Track runtime call stats for promotion eligibility
            const stats = _runtimeStats.get(def.name) ?? { calls: 0, successes: 0 };
            stats.calls++;
            if (result.success) stats.successes++;
            _runtimeStats.set(def.name, stats);
            // Persist updated stats so they survive gateway restarts (debounced)
            scheduleStatsPersist(def.name);
            // Auto-nominate if threshold reached and not already nominated
            maybeNominateForPromotion(def.name);
            // Post-deployment feedback: track successful uses against the origin gap
            if (result.success) recordSelfdevToolSuccess(def.name);
            return result;
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

/** Persist updated call stats into the tool's JSON file on disk (debounced per tool). */
const _pendingStatsPersist = new Set<string>();
let _statsFlushTimer: ReturnType<typeof setTimeout> | null = null;
const STATS_FLUSH_INTERVAL_MS = 30_000;

function scheduleStatsPersist(bareToolName: string): void {
    _pendingStatsPersist.add(bareToolName);
    if (_statsFlushTimer) return;
    _statsFlushTimer = setTimeout(flushPendingStats, STATS_FLUSH_INTERVAL_MS);
}

function flushPendingStats(): void {
    _statsFlushTimer = null;
    for (const name of _pendingStatsPersist) {
        const stats = _runtimeStats.get(name);
        if (stats) persistStatsNow(name, stats);
    }
    _pendingStatsPersist.clear();
}

function persistStatsNow(bareToolName: string, stats: _CallStats): void {
    const def = _loadedTools.get(bareToolName);
    if (!def) return;
    def.runtimeCalls = stats.calls;
    def.runtimeSuccesses = stats.successes;
    try {
        const filePath = join(DYNAMIC_TOOLS_DIR, `${def.name}.json`);
        writeFileSync(filePath, JSON.stringify(def, null, 2), "utf-8");
    } catch (err) {
        log.warn({ err, toolName: bareToolName }, "Failed to persist runtime stats — counts will reset on restart");
    }
}

// ── Promotion queue public API ──────────────────────────────────────────────

function maybeNominateForPromotion(bareToolName: string): void {
    const def = _loadedTools.get(bareToolName);
    if (!def) return;
    if (def.promotionStatus && def.promotionStatus !== "none") return; // already nominated

    const stats = _runtimeStats.get(bareToolName);
    if (!stats) return;

    // Use config-driven thresholds, falling back to module-level defaults
    const config = getConfig();
    const minCalls = config.selfImprovement?.promotionMinCalls ?? PROMOTION_MIN_CALLS;
    const minSuccessRate = config.selfImprovement?.promotionMinSuccessRate ?? PROMOTION_MIN_SUCCESS_RATE;

    if (stats.calls < minCalls) return;
    const rate = stats.successes / stats.calls;
    if (rate < minSuccessRate) return;

    def.promotionStatus = "pending";
    def.promotionNominatedAt = new Date().toISOString();

    // Persist the updated definition
    try {
        const filePath = join(DYNAMIC_TOOLS_DIR, `${def.name}.json`);
        writeFileSync(filePath, JSON.stringify(def, null, 2), "utf-8");
    } catch (err) {
        log.warn({ err, toolName: bareToolName }, "Failed to persist promotion nomination");
    }

    emitSwarmEvent("tool_promotion_nominated", {
        data: { toolName: `${TOOL_NAME_PREFIX}${bareToolName}`, callCount: stats.calls, successRate: rate },
    });
    logAudit("tool_promotion_nominated", {
        toolName: `${TOOL_NAME_PREFIX}${bareToolName}`,
        callCount: stats.calls,
        successRate: rate,
    }, { severity: "info" });

    log.info({ toolName: bareToolName, callCount: stats.calls, successRate: rate },
        "Dynamic tool nominated for promotion — awaiting operator review");

    // Fire the configured approval channel if one is set
    const channelName = config.selfImprovement?.promotionApprovalChannel;
    if (channelName) {
        const fullName = `${TOOL_NAME_PREFIX}${bareToolName}`;
        requestApprovalViaChannel(channelName, "tool_promotion", {
            toolName: fullName,
            description: def.description,
            callCount: stats.calls,
            successRate: rate,
            nominatedAt: def.promotionNominatedAt,
        }).then((approved) => {
            if (approved) {
                approvePromotion(bareToolName, `approval_channel:${channelName}`);
            } else {
                rejectPromotion(bareToolName, `approval_channel:${channelName}`);
            }
        }).catch((err) => {
            log.warn({ err, toolName: bareToolName }, "Promotion approval channel request failed — nomination stays pending");
        });
    }
}

/** Return all dynamic tools that are candidates for promotion (or have been reviewed). */
export function listPromotionCandidates(): ToolPromotionCandidate[] {
    const candidates: ToolPromotionCandidate[] = [];
    for (const def of _loadedTools.values()) {
        if (!def.promotionStatus || def.promotionStatus === "none") continue;
        const stats = _runtimeStats.get(def.name) ?? { calls: 0, successes: 0 };
        candidates.push({
            toolName: def.name,
            fullName: `${TOOL_NAME_PREFIX}${def.name}`,
            description: def.description,
            callCount: stats.calls,
            successCount: stats.successes,
            successRate: stats.calls > 0 ? stats.successes / stats.calls : 0,
            status: def.promotionStatus as ToolPromotionCandidate["status"],
            nominatedAt: def.promotionNominatedAt ?? def.approvedAt,
            reviewedAt: def.promotionStatus !== "pending" ? (def.promotionNominatedAt ?? undefined) : undefined,
        });
    }
    return candidates;
}

/**
 * Approve promotion: the tool is re-registered without the selfdev__ prefix
 * at Tier 2 (still sandbox-enforced, still requires per-call approval).
 * The original selfdev__ registration remains as a fallback.
 */
export function approvePromotion(bareToolName: string, reviewedBy: string): boolean {
    const def = _loadedTools.get(bareToolName);
    if (!def || def.promotionStatus !== "pending") return false;

    def.promotionStatus = "approved";
    const reviewedAt = new Date().toISOString();

    // Persist updated status
    try {
        const filePath = join(DYNAMIC_TOOLS_DIR, `${def.name}.json`);
        writeFileSync(filePath, JSON.stringify(def, null, 2), "utf-8");
    } catch (err) {
        log.warn({ err, toolName: bareToolName }, "Failed to persist promotion approval");
    }

    // Register the promoted (non-prefixed) tool — still uses sandbox executor, still Tier 2
    const promotedHandler: ToolHandler = {
        name: bareToolName,                         // no selfdev__ prefix
        description: `[Promoted] ${def.description}`,
        parameters: def.parameters,
        async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
            return executeDynamicTool(def.code, args, ctx);
        },
    };
    try {
        registerTool(promotedHandler);
    } catch (err) {
        log.error({ err, toolName: bareToolName }, "Failed to register promoted tool");
        return false;
    }

    emitSwarmEvent("tool_promoted", {
        data: { toolName: bareToolName, promotedFrom: `${TOOL_NAME_PREFIX}${bareToolName}`, reviewedBy },
    });
    logAudit("tool_promoted", { toolName: bareToolName, reviewedBy, reviewedAt }, { severity: "info" });

    log.info({ toolName: bareToolName, reviewedBy }, "Dynamic tool promoted to catalog");
    return true;
}

/** Reject promotion: mark as rejected so the tool stays as selfdev__ only. */
export function rejectPromotion(bareToolName: string, reviewedBy: string): boolean {
    const def = _loadedTools.get(bareToolName);
    if (!def || def.promotionStatus !== "pending") return false;

    def.promotionStatus = "rejected";

    try {
        const filePath = join(DYNAMIC_TOOLS_DIR, `${def.name}.json`);
        writeFileSync(filePath, JSON.stringify(def, null, 2), "utf-8");
    } catch (err) {
        log.warn({ err, toolName: bareToolName }, "Failed to persist promotion rejection");
    }

    logAudit("tool_promotion_rejected", { toolName: `${TOOL_NAME_PREFIX}${bareToolName}`, reviewedBy }, { severity: "info" });
    log.info({ toolName: bareToolName, reviewedBy }, "Dynamic tool promotion rejected");
    return true;
}

/** Return runtime call statistics for all loaded dynamic tools. */
export function getDynamicToolStats(): Array<{ toolName: string; fullName: string; calls: number; successes: number; successRate: number; promotionStatus?: string }> {
    return [..._loadedTools.values()].map(def => {
        const stats = _runtimeStats.get(def.name) ?? { calls: 0, successes: 0 };
        return {
            toolName: def.name,
            fullName: `${TOOL_NAME_PREFIX}${def.name}`,
            calls: stats.calls,
            successes: stats.successes,
            successRate: stats.calls > 0 ? stats.successes / stats.calls : 0,
            promotionStatus: def.promotionStatus,
        };
    });
}

// ── Definition validation ───────────────────────────────────────────────────

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