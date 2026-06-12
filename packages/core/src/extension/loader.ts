/**
 * Core-extension loader — discovers `src/extensions/<name>/index.{ts,js}`
 * directories at boot, validates their manifests, and registers everything
 * they declare (tools + tiers, audit events, roles, guardrail hooks, routes,
 * lifecycle hooks).
 *
 * Failure semantics mirror the plugin loader: a broken extension is logged +
 * audited (`extension_load_failed`) and skipped; the gateway keeps booting.
 * Extensions are repo code — a compile-time error surfaces in CI long before
 * this loader runs — so runtime failures here are config/IO problems.
 *
 * Discovery root resolution:
 *   1. `SAI_EXTENSIONS_DIR` env var (tests / unusual layouts)
 *   2. `<this module's dir>/../extensions` — works for both `src/` (tsx,
 *      vitest) and compiled `dist/` because the tree shape is identical.
 * Directory names starting with `_` or `.` are skipped (the shipped
 * `_example` reference extension stays dormant).
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { childLogger } from "../logger.js";
import { logAudit } from "../audit/logger.js";
import { getConfig } from "../config/loader.js";
import { registerTool, type ToolHandler } from "../tools/registry.js";
import { ToolTier, registerExtensionToolTier } from "../guardrails/tool-tiers.js";
import { registerExtensionGroup } from "../tools/groups.js";
import { registerRoutePolicies } from "../gateway/route-policies.js";
import { registerExtensionToolKeywords } from "../providers/embeddings.js";
import {
  EXTENSION_AUDIT_EVENT_PATTERN,
  EXTENSION_NAME_PATTERN,
  _recordLoadedExtension,
  type CoreExtension,
  type CoreExtensionContext,
  type ExtensionRouteApp,
} from "./index.js";

const log = childLogger("extension-loader");

interface ActiveExtension {
  ext: CoreExtension;
  ctx: CoreExtensionContext & { config: unknown };
  /** Set when configSchema validation failed — boot is skipped. */
  configError?: string;
  booted: boolean;
}

const _active: ActiveExtension[] = [];

/**
 * Default extension importer — native ESM `import()` against a file:// URL so
 * Windows paths work and the module runs in real module context. Tests swap
 * this out via {@link setExtensionImporterForTests} (vitest's vite-node
 * cannot natively import files outside its project root).
 */
type ExtensionImporter = (entryPath: string) => Promise<{ default?: unknown }>;

async function defaultExtensionImporter(entryPath: string): Promise<{ default?: unknown }> {
  const url = pathToFileURL(entryPath).href;
  return (await import(/* @vite-ignore */ url)) as { default?: unknown };
}

let _importer: ExtensionImporter = defaultExtensionImporter;

/** Test hook: replace (or with null, restore) the module importer. */
export function setExtensionImporterForTests(importer: ExtensionImporter | null): void {
  _importer = importer ?? defaultExtensionImporter;
}

export function resolveExtensionsDir(): string {
  const fromEnv = process.env["SAI_EXTENSIONS_DIR"];
  if (fromEnv?.trim()) {
    return isAbsolute(fromEnv) ? fromEnv : resolve(process.cwd(), fromEnv);
  }
  return fileURLToPath(new URL("../extensions", import.meta.url));
}

function discoverEntryFiles(dir: string): Array<{ name: string; entry: string }> {
  if (!existsSync(dir)) return [];
  const out: Array<{ name: string; entry: string }> = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith("_") || name.startsWith(".")) continue;
    const sub = join(dir, name);
    if (!statSync(sub).isDirectory()) continue;
    // Compiled output first (dist), then source (tsx/vitest runs on src).
    const entry = ["index.js", "index.mjs", "index.ts"]
      .map((f) => join(sub, f))
      .find((p) => existsSync(p));
    if (entry) out.push({ name, entry });
    else log.warn({ dir: sub }, "extension directory has no index entry — skipped");
  }
  return out;
}

function validateManifest(dirName: string, ext: unknown): asserts ext is CoreExtension {
  if (typeof ext !== "object" || ext === null) throw new Error("default export is not an object");
  const e = ext as Partial<CoreExtension>;
  if (typeof e.name !== "string" || !EXTENSION_NAME_PATTERN.test(e.name)) {
    throw new Error(`invalid extension name ${JSON.stringify(e.name)} (must match ${EXTENSION_NAME_PATTERN})`);
  }
  if (e.name !== dirName) {
    throw new Error(`extension name "${e.name}" must match its directory name "${dirName}"`);
  }
  if (typeof e.version !== "string" || !e.version.trim()) throw new Error("missing version");
  for (const tool of e.tools ?? []) {
    if (typeof tool.name !== "string" || !/^[a-z][a-z0-9_]{1,48}$/.test(tool.name)) {
      throw new Error(`invalid tool name ${JSON.stringify(tool.name)}`);
    }
    if (typeof tool.execute !== "function") throw new Error(`tool ${tool.name}: execute is not a function`);
    if (tool.tier === undefined || tool.tier < ToolTier.ZERO_READ_ONLY || tool.tier >= ToolTier.FOUR_BLOCKED) {
      throw new Error(`tool ${tool.name}: tier must be 0–3`);
    }
  }
  for (const event of e.auditEvents ?? []) {
    if (!EXTENSION_AUDIT_EVENT_PATTERN.test(event)) {
      throw new Error(`invalid audit event name ${JSON.stringify(event)}`);
    }
  }
  for (const role of e.roles ?? []) {
    if (typeof role.name !== "string" || !/^[a-z][a-z0-9_-]{1,32}$/.test(role.name)) {
      throw new Error(`invalid role name ${JSON.stringify(role.name)}`);
    }
    if (typeof role.rank !== "number") throw new Error(`role ${role.name}: rank must be a number`);
  }
}

function registerExtension(ext: CoreExtension, source: string): void {
  // Group first so config-driven disabling recognizes the extension's group
  // name without warnings.
  registerExtensionGroup(ext.name);

  if (ext.routePolicies?.length) {
    registerRoutePolicies(ext.name, ext.routePolicies);
  }

  if (ext.toolKeywords?.length) {
    registerExtensionToolKeywords(ext.toolKeywords);
  }

  const toolNames: string[] = [];
  for (const tool of ext.tools ?? []) {
    // Tier BEFORE registerTool — unknown names are BLOCKED and would throw.
    registerExtensionToolTier(
      tool.name,
      {
        tier: tool.tier,
        description: tool.description,
        requiresPerCallApproval: tool.requiresPerCallApproval ?? false,
        requiresSandbox: tool.requiresSandbox ?? false,
      },
      ext.name,
    );
    const handler: ToolHandler = {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      execute: tool.execute,
      group: tool.group ?? ext.name,
      ...(tool.embeddingDescription ? { embeddingDescription: tool.embeddingDescription } : {}),
      ...(tool.costHint ? { costHint: tool.costHint } : {}),
      ...(tool.latencyHint ? { latencyHint: tool.latencyHint } : {}),
      ...(tool.timeoutMs ? { timeoutMs: tool.timeoutMs } : {}),
    };
    registerTool(handler);
    toolNames.push(tool.name);
  }

  const ctx: ActiveExtension["ctx"] = {
    name: ext.name,
    log: childLogger(`ext:${ext.name}`),
    config: undefined,
  };
  _active.push({ ext, ctx, booted: false });

  _recordLoadedExtension(
    {
      name: ext.name,
      version: ext.version,
      ...(ext.description ? { description: ext.description } : {}),
      toolNames,
      auditEvents: (ext.auditEvents ?? []).map((e) => `${ext.name}.${e}`),
      roles: ext.roles ?? [],
      loadedAt: new Date().toISOString(),
      source,
    },
    ext,
  );
}

/**
 * Discover + register all extensions. Idempotent per process (a second call
 * skips already-loaded names). Returns load counters for startup logging.
 */
export async function loadCoreExtensions(): Promise<{ loaded: number; failed: number; dir: string }> {
  const dir = resolveExtensionsDir();
  let loaded = 0;
  let failed = 0;
  for (const { name, entry } of discoverEntryFiles(dir)) {
    if (_active.some((a) => a.ext.name === name)) continue;
    try {
      const mod = await _importer(entry);
      validateManifest(name, mod.default);
      registerExtension(mod.default, entry);
      loaded++;
      log.info({ extension: name, tools: mod.default.tools?.length ?? 0 }, "core extension loaded");
      logAudit("extension_loaded", { extension: name, source: entry });
    } catch (err) {
      failed++;
      log.error({ extension: name, entry, err }, "core extension failed to load — skipped");
      logAudit("extension_load_failed", { extension: name, source: entry, error: String(err) }, { severity: "error" });
    }
  }
  return { loaded, failed, dir };
}

/**
 * Mount every loaded extension's routes. Called by createGateway() AFTER all
 * core routes so extensions cannot shadow core endpoints.
 */
export function mountExtensionRoutes(app: ExtensionRouteApp): void {
  for (const active of _active) {
    if (!active.ext.registerRoutes) continue;
    try {
      active.ext.registerRoutes(app, active.ctx);
    } catch (err) {
      log.error({ extension: active.ext.name, err }, "extension route registration failed — its routes are unavailable");
    }
  }
}

/**
 * Validate config slices and run boot hooks. Call once during startup, after
 * core subsystems (graph/vector stores, providers) are initialized and before
 * the gateway starts listening.
 */
export async function runExtensionBoot(): Promise<void> {
  for (const active of _active) {
    if (active.booted) continue;
    const { ext, ctx } = active;
    const slice = (getConfig() as { extensions?: Record<string, unknown> }).extensions?.[ext.name];
    try {
      (ctx as { config: unknown }).config = ext.configSchema ? ext.configSchema.parse(slice ?? {}) : slice;
    } catch (err) {
      active.configError = String(err);
      log.error(
        { extension: ext.name, err },
        `extensions.${ext.name} config is invalid — boot hook skipped, extension may misbehave`,
      );
      continue;
    }
    try {
      await ext.boot?.(ctx);
      active.booted = true;
    } catch (err) {
      log.error({ extension: ext.name, err }, "extension boot hook failed — continuing startup");
    }
  }
}

/** Run shutdown hooks in reverse load order. Errors are logged, not thrown. */
export async function runExtensionShutdown(): Promise<void> {
  for (const active of [..._active].reverse()) {
    try {
      await active.ext.shutdown?.();
    } catch (err) {
      log.warn({ extension: active.ext.name, err }, "extension shutdown hook failed");
    }
  }
}

/** Test hook: forget all loaded extensions (does not unregister their tools). */
export function _resetExtensionLoaderForTests(): void {
  _active.length = 0;
}
