/**
 * THE BROWSER IS RESTARTED WHEN IT STOPS TAKING CONNECTIONS.
 *
 * The playwright MCP server drives the headed browser-vnc Chrome over CDP. In the E2E run of
 * 2026-10-22 that Chrome stopped completing Playwright's CDP connections: every browser call
 * timed out after 30 s at "<ws connecting> ws://browser-vnc:9222/devtools/browser/…" for half an
 * hour, browser runs looped on screenshots and waits, and the browser came back only when the
 * operator's side restarted the container (a stack rebuild does not: its image does not change).
 *
 * Two calls in a row that time out while connecting (Playwright's own call log, not the page's
 * words) restart the container the CDP endpoint names, found by its compose service label: stop,
 * start, and wait until the endpoint answers. Never while a person is working in that browser
 * (request_human_assist), at most once per RECOVERY_COOLDOWN_MS, one recovery at a time, each one
 * audited. `docker restart` is not a route the socket proxy passes; stop and start are.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";

const log = childLogger("tool:browser-watchdog");
const execFileAsync = promisify(execFile);

/** Playwright's call log for a CDP connection that never completed. */
const CONNECT_HANG_RE = /TimeoutError[\s\S]*(?:<ws connecting>|retrieving websocket url)/;
export const HANGS_BEFORE_RECOVERY = 2;
export const RECOVERY_COOLDOWN_MS = 10 * 60_000;
const CDP_READY_TIMEOUT_MS = 60_000;

export interface BrowserWatchdogDeps {
  /** The CDP endpoint the browser server connects to (`--cdp-endpoint`), or null when it launches its own. */
  endpoint: () => string | null;
  docker: (args: string[]) => Promise<string>;
  cdpReady: (endpoint: string) => Promise<boolean>;
  assistPending: () => boolean;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface BrowserWatchdog {
  noteSuccess(): void;
  /** Counts a failed browser call; returns the recovery it started, if it started one. */
  noteFailure(error: string): Promise<void> | null;
}

export function createBrowserWatchdog(deps: BrowserWatchdogDeps): BrowserWatchdog {
  let hangs = 0;
  let lastRecoveryAt = Number.NEGATIVE_INFINITY;
  let recovering: Promise<void> | null = null;

  const recover = async (endpoint: string, hangCount: number): Promise<void> => {
    const service = new URL(endpoint).hostname;
    const audit = (outcome: string, extra: Record<string, unknown> = {}) =>
      logAudit("browser_watchdog_recovery", { service, hangs: hangCount, outcome, ...extra }, { severity: outcome === "restarted" ? "warn" : "error" });
    try {
      const ids = (await deps.docker(["ps", "-q", "--filter", `label=com.docker.compose.service=${service}`])).split(/\s+/).filter(Boolean);
      if (ids.length !== 1) {
        audit("not_restarted", { reason: ids.length === 0 ? "no container for the CDP endpoint's service" : "more than one container for the service" });
        return;
      }
      await deps.docker(["stop", "-t", "5", ids[0]!]);
      await deps.docker(["start", ids[0]!]);
      const deadline = deps.now() + CDP_READY_TIMEOUT_MS;
      while (!(await deps.cdpReady(endpoint))) {
        if (deps.now() >= deadline) {
          audit("restarted_not_ready");
          return;
        }
        await deps.sleep(2_000);
      }
      log.warn({ service, hangs: hangCount }, "Browser restarted after its CDP connections hung");
      audit("restarted");
    } catch (err) {
      log.error({ err, service }, "Browser watchdog could not restart the browser");
      audit("failed", { error: String(err).slice(0, 300) });
    }
  };

  return {
    noteSuccess() {
      hangs = 0;
    },
    noteFailure(error) {
      if (!CONNECT_HANG_RE.test(error)) {
        hangs = 0;
        return null;
      }
      hangs += 1;
      const endpoint = deps.endpoint();
      if (hangs < HANGS_BEFORE_RECOVERY || !endpoint || recovering) return null;
      if (deps.now() - lastRecoveryAt < RECOVERY_COOLDOWN_MS) return null;
      if (deps.assistPending()) return null;
      lastRecoveryAt = deps.now();
      const hangCount = hangs;
      hangs = 0;
      recovering = recover(endpoint, hangCount).finally(() => { recovering = null; });
      return recovering;
    },
  };
}

/** The endpoint after `--cdp-endpoint` in the playwright server's configured args. */
export function cdpEndpointOf(args: readonly unknown[] | undefined): string | null {
  if (!args) return null;
  const at = args.indexOf("--cdp-endpoint");
  const value = at >= 0 ? args[at + 1] : undefined;
  if (typeof value !== "string") return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

let shared: BrowserWatchdog | undefined;

/** The gateway's watchdog over the playwright server's browser. */
export async function browserWatchdog(): Promise<BrowserWatchdog> {
  if (shared) return shared;
  const [{ getConfig }, { browserSessionManager }] = await Promise.all([
    import("../config/loader.js"),
    import("../agent/browser-session.js"),
  ]);
  shared = createBrowserWatchdog({
    endpoint: () => {
      const server = getConfig().mcp?.servers?.["playwright"] as { args?: unknown[] } | undefined;
      return cdpEndpointOf(server?.args);
    },
    docker: async (args) => (await execFileAsync("docker", args, { timeout: 60_000 })).stdout,
    cdpReady: async (endpoint) => {
      try {
        const res = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(5_000) });
        return res.ok;
      } catch {
        return false;
      }
    },
    assistPending: () => browserSessionManager.listAwaitingAssist().length > 0,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  return shared;
}
