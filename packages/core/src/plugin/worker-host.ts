/**
 * SEC-105 (ADR-007): plugin worker host — gateway side of the isolation model.
 *
 * Spawns each trusted plugin into its OWN child process with a MINIMAL
 * environment: no gateway secrets (JWT/master/provider keys), no backend URLs
 * — only baseline OS vars plus the env names the plugin's manifest declared.
 * Import-time plugin code therefore runs where it can neither read gateway
 * process state nor crash the gateway.
 *
 * Containment contract:
 *  - init handshake timeout → plugin rejected (never half-loaded);
 *  - per-invoke timeout → that CALL fails; the worker (whose event loop is
 *    still healthy for async hangs) keeps serving other calls;
 *  - worker exit/crash → all pending invokes fail, the plugin is DEGRADED
 *    (fast-fail on further calls), the gateway never sees the crash as an
 *    exception.
 *
 * The host exposes an importer with the SAME shape as the in-process ESM
 * importer, returning a Plugin whose tools RPC into the worker — so the
 * loader's validation/registration path is reused unchanged.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { childLogger } from "../logger.js";
import { logAudit } from "../audit/logger.js";
import type { Plugin } from "./index.js";

const log = childLogger("plugin-worker-host");

const INIT_TIMEOUT_MS = 15_000;
const DEFAULT_INVOKE_TIMEOUT_MS = 30_000;

/** Baseline OS vars a Node child needs to function at all. Everything else is
 *  withheld unless the plugin's manifest declared it. */
const BASELINE_ENV_VARS = ["PATH", "Path", "SYSTEMROOT", "SystemRoot", "windir", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "COMSPEC"];

export function buildMinimalWorkerEnv(envAllowlist: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [...BASELINE_ENV_VARS, ...envAllowlist]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Resolve how to launch the worker entry: compiled dist when present,
 *  otherwise the TS source via the workspace tsx CLI (dev/test). */
function resolveWorkerCommand(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const distEntry = join(here, "worker-main.js");
  if (existsSync(distEntry)) return [distEntry];
  const srcEntry = join(here, "worker-main.ts");
  // packages/core/src/plugin → packages/core
  const coreRoot = join(here, "..", "..");
  const tsx = join(coreRoot, "node_modules", "tsx", "dist", "cli.mjs");
  if (existsSync(tsx) && existsSync(srcEntry)) return [tsx, srcEntry];
  throw new Error("plugin worker entry not found (neither dist worker-main.js nor tsx+src)");
}

interface PendingInvoke {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface PluginWorkerHandle {
  /** True once the worker died or failed — every further invoke fast-fails. */
  degraded: boolean;
  invoke: (tool: string, args: Record<string, unknown>, context: { sessionId: string; workspacePath: string }, timeoutMs?: number) => Promise<unknown>;
  dispose: () => void;
}

interface ReadyMessage {
  name: string;
  version: string;
  description?: string;
  author?: string;
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown>; timeoutMs?: number }>;
}

/** Spawn a worker for one plugin and complete the init handshake. */
export async function spawnPluginWorker(
  entryPath: string,
  opts: { pluginId: string; envAllowlist?: string[]; networkHosts?: string[]; defaultInvokeTimeoutMs?: number } ,
): Promise<{ handle: PluginWorkerHandle; ready: ReadyMessage }> {
  const command = resolveWorkerCommand();
  const child: ChildProcess = spawn(process.execPath, command, {
    env: buildMinimalWorkerEnv(opts.envAllowlist ?? []),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const pending = new Map<string, PendingInvoke>();
  // Set while the init handshake is outstanding so a worker that dies BEFORE
  // "ready" rejects immediately instead of stalling out the full init timeout.
  let rejectInit: ((err: Error) => void) | null = null;
  // Deliberate teardown (hot-reload, unload, shutdown) is not a crash: the
  // flag routes degrade() away from the crash audit that operators alert on.
  let disposedIntentionally = false;

  const handle: PluginWorkerHandle = {
    degraded: false,
    invoke: (tool, args, context, timeoutMs) => new Promise((resolve, reject) => {
      if (handle.degraded) {
        reject(new Error(`plugin '${opts.pluginId}' worker is degraded (crashed earlier) — call refused`));
        return;
      }
      const id = randomUUID();
      const timer = setTimeout(() => {
        if (pending.delete(id)) {
          reject(new Error(`plugin '${opts.pluginId}' tool '${tool}' timed out after ${timeoutMs ?? opts.defaultInvokeTimeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MS}ms in the worker`));
        }
      }, timeoutMs ?? opts.defaultInvokeTimeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MS);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      // A write can race the child's death before its 'exit' event dispatches;
      // the stream error listener below turns that into degrade(), and the
      // guard here keeps the throw out of the gateway.
      try {
        child.stdin!.write(`${JSON.stringify({ type: "invoke", id, tool, args, context })}\n`);
      } catch (err) {
        degrade(`stdin write failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
    dispose: () => {
      disposedIntentionally = true;
      try { child.kill(); } catch { /* already gone */ }
    },
  };

  const degrade = (reason: string): void => {
    if (handle.degraded) return;
    handle.degraded = true;
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`plugin '${opts.pluginId}' worker died: ${reason}`));
      pending.delete(id);
    }
    if (rejectInit) {
      const reject = rejectInit;
      rejectInit = null;
      reject(new Error(`plugin '${opts.pluginId}' worker died before ready: ${reason}`));
    }
    if (disposedIntentionally) {
      log.info({ plugin: opts.pluginId }, "Plugin worker disposed");
    } else {
      logAudit("plugin_worker_crashed", { plugin: opts.pluginId, reason: reason.slice(0, 300) }, { severity: "warn" });
      log.warn({ plugin: opts.pluginId, reason }, "Plugin worker degraded");
    }
  };

  // An EPIPE/write-after-destroy on the child's stdio emits a stream 'error'
  // event; without listeners it becomes an uncaughtException that would take
  // the GATEWAY down with the plugin — the exact inversion of the containment
  // contract. Route every stream error into degrade().
  child.stdin!.on("error", (err) => degrade(`stdin error: ${err.message}`));
  child.stdout!.on("error", (err) => degrade(`stdout error: ${err.message}`));
  child.stderr!.on("error", () => { /* stderr loss is harmless */ });

  const stderrChunks: string[] = [];
  child.stderr!.on("data", (chunk: Buffer) => { if (stderrChunks.length < 50) stderrChunks.push(chunk.toString()); });
  child.on("exit", (code) => degrade(`exit code ${code}${stderrChunks.length ? ` — ${stderrChunks.join("").slice(-300)}` : ""}`));
  child.on("error", (err) => degrade(err.message));

  const ready = await new Promise<ReadyMessage>((resolve, reject) => {
    const initTimer = setTimeout(() => {
      rejectInit = null;
      handle.dispose();
      reject(new Error(`plugin '${opts.pluginId}' worker init timed out after ${INIT_TIMEOUT_MS}ms`));
    }, INIT_TIMEOUT_MS);
    initTimer.unref?.();
    // degrade() consumes this when the worker dies before "ready" — instant
    // rejection instead of a full init-timeout stall per broken plugin.
    rejectInit = (err) => { clearTimeout(initTimer); reject(err); };

    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      let message: Record<string, unknown>;
      try { message = JSON.parse(line); } catch { return; }
      switch (message["type"]) {
        case "ready":
          clearTimeout(initTimer);
          rejectInit = null;
          resolve(message as unknown as ReadyMessage);
          break;
        case "result": {
          const entry = pending.get(String(message["id"]));
          if (entry) { pending.delete(String(message["id"])); clearTimeout(entry.timer); entry.resolve(message["result"]); }
          break;
        }
        case "invoke_error": {
          const entry = pending.get(String(message["id"]));
          if (entry) { pending.delete(String(message["id"])); clearTimeout(entry.timer); entry.reject(new Error(String(message["error"] ?? "plugin tool error"))); }
          break;
        }
        case "fatal":
          clearTimeout(initTimer);
          rejectInit = null;
          reject(new Error(String(message["error"] ?? "plugin worker fatal error")));
          break;
      }
    });

    try {
      child.stdin!.write(`${JSON.stringify({ type: "init", entryPath, networkHosts: opts.networkHosts ?? [] })}\n`);
    } catch (err) {
      degrade(`init write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  logAudit("plugin_worker_started", { plugin: opts.pluginId, tools: ready.tools.map((t) => t.name) }, { severity: "info" });
  return { handle, ready };
}

const _workerHandles = new Map<string, PluginWorkerHandle>();

/** Dispose one plugin's worker (unload, rejected load). Safe when absent. */
export function disposePluginWorker(pluginId: string): void {
  const handle = _workerHandles.get(pluginId);
  if (handle) {
    handle.dispose();
    _workerHandles.delete(pluginId);
  }
}

/** Dispose every worker (gateway shutdown / tests). */
export function disposeAllPluginWorkers(): void {
  for (const handle of _workerHandles.values()) handle.dispose();
  _workerHandles.clear();
}

/**
 * Importer with the same shape as the in-process ESM importer: returns a
 * Plugin whose tools RPC into the worker. Plugs into the loader's existing
 * validation/registration path unchanged.
 */
export async function importPluginViaWorker(
  entryPath: string,
  opts: { pluginId: string; envAllowlist?: string[]; networkHosts?: string[] },
): Promise<{ default?: Plugin }> {
  const { handle, ready } = await spawnPluginWorker(entryPath, opts);
  _workerHandles.get(opts.pluginId)?.dispose();
  _workerHandles.set(opts.pluginId, handle);

  const plugin: Plugin = {
    name: ready.name,
    version: ready.version,
    ...(ready.description ? { description: ready.description } : {}),
    ...(ready.author ? { author: ready.author } : {}),
    tools: ready.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(tool.timeoutMs ? { timeoutMs: tool.timeoutMs } : {}),
      execute: async (args, context) => {
        try {
          const result = await handle.invoke(tool.name, args, {
            sessionId: context.sessionId,
            workspacePath: context.workspacePath,
          }, tool.timeoutMs);
          // Tools return ToolResult-shaped objects; tolerate primitives from
          // simple plugins by wrapping them.
          if (result && typeof result === "object" && "success" in (result as Record<string, unknown>)) {
            return result as { success: boolean; output: string };
          }
          return { success: true, output: String(result ?? "") };
        } catch (err) {
          return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
        }
      },
    })),
  };
  return { default: plugin };
}
