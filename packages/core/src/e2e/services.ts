/**
 * Is a service a scenario `requires` available? A scenario whose service is down is SKIPPED with
 * the reason, never failed. Probes read what the gateway already reports about its dependencies:
 *
 *   gateway           GET /healthz → 200
 *   model             GET /api/health/subsystems  check "primary_model" = ok
 *   embeddings        GET /api/health/subsystems  check "embeddings" = ok
 *   engram, laya      GET /api/health/subsystems  check = ok and configured ("not configured" is ok
 *                     to the gateway — the feature is off — and down to a scenario that needs it)
 *   browser           GET /api/mcp/servers: a playwright/browser MCP server "connected", and
 *                     subsystems "browser_vnc" = ok (the MCP server drives browser-vnc over CDP)
 *   image             GET /api/multimodal/status  imageGeneration.ok
 *   speech            GET /api/multimodal/status  stt.ok and tts.ok
 *   computer-desktop  GET /api/computer-sessions/config  enabled — a configuration check only
 *   mail              the mail adapter's readiness probe (GreenMail /api/service/readiness), and
 *                     — when the repo has scripts/e2e-env.mjs — `pnpm e2e:env status --json`
 *                     ready.mail: the mail-service loaded eval@e2e.test and shows the eval user no
 *                     other account. Without that check a mail turn could reach a real mailbox, so
 *                     an environment that cannot be verified counts as down.
 *   e2e-site          GET E2E_SITE_URL (default http://localhost:18081) → any status below 500, and
 *                     ready.site of the same status (the gateway resolves the site and its SSRF
 *                     exemption is compiled); when the status cannot be read, the HTTP probe alone
 *   web-search        GET E2E_SEARXNG_URL/healthz when set; otherwise no route reports SearXNG,
 *                     so it is assumed up (marked "assumed" in the report)
 *   sandbox           GET /api/health/subsystems  check "sandbox" = ok and measured: the gateway's
 *                     canary ran a docker run through shell_exec and got both what it printed on
 *                     stdout and on stderr back. A failed run or lost output is down, and so is a
 *                     verdict the canary has not measured ("not configured"; "not checked yet", as
 *                     it starts no container while a turn runs) or a gateway too old to report it.
 *                     An ok verdict counts up to SANDBOX_VERDICT_MAX_AGE_MS old, by the ageMs the
 *                     gateway reports with it
 *
 * Answers are cached for ttlMs, and the gateway routes they share are fetched once per window.
 * Response bodies are read for the fields above only — /api/mcp/servers and the computer-use
 * config carry configuration the harness never logs.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { E2EService } from "./scenario.js";
import { describeError, isRecord, safeJsonParse, type HttpResult } from "./gateway-client.js";
import type { MailAdapter } from "./mail.js";

export interface ServiceState {
  service: E2EService;
  up: boolean;
  detail: string;
  /** No probe exists for it; taken as up. */
  assumed?: true;
}

/** `pnpm e2e:env status --json` (scripts/e2e-env.mjs), reduced to what the probes need. */
export interface E2EEnvironmentStatus {
  ready: { mail: boolean; site: boolean };
  /** What is missing for each, read from the status. */
  missing: { mail: string[]; site: string[] };
}

export type EnvironmentStatusProvider = () => Promise<E2EEnvironmentStatus | { error: string }>;

export interface ServiceProbeContext {
  gatewayUrl: string;
  /** An authenticated GET against the gateway (the "eval" identity). */
  authedGet: (path: string) => Promise<HttpResult>;
  mail?: MailAdapter | null;
  siteUrl?: string;
  searxngUrl?: string;
  /** The e2e environment's own readiness check; absent: the HTTP probes decide alone. */
  environment?: EnvironmentStatusProvider;
  timeoutMs?: number;
}

/** Reads the status JSON of scripts/e2e-env.mjs; `ready` decides, the rest only explains. */
export function interpretEnvironmentStatus(json: unknown): E2EEnvironmentStatus | { error: string } {
  if (!isRecord(json) || !isRecord(json["ready"])) return { error: "the status has no ready block" };
  const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
  const services = record(json["services"]);
  const endpoints = record(json["hostEndpoints"]);
  const config = record(json["config"]);
  const mailService = record(json["mailService"]);
  const gateway = record(json["gateway"]);
  const container = (name: string): string | null => {
    const entry = services[name];
    if (!isRecord(entry)) return `${name} container not created`;
    return entry["state"] === "running" && entry["health"] === "healthy" ? null : `${name} container ${String(entry["state"])}/${String(entry["health"])}`;
  };
  const missing: E2EEnvironmentStatus["missing"] = { mail: [], site: [] };
  const mailContainer = container("e2e-mail");
  if (mailContainer) missing.mail.push(mailContainer);
  if (record(endpoints["mailApi"])["up"] !== true) missing.mail.push("GreenMail API not reachable on the host");
  if (!config["mailOverlay"]) missing.mail.push("eval account file missing (pnpm e2e:env up)");
  if (mailService["evalAccountLoaded"] !== true) missing.mail.push("the mail-service has not loaded eval@e2e.test");
  if (mailService["otherAccountsVisibleToEval"] !== 0) {
    const visible = mailService["otherAccountsVisibleToEval"];
    missing.mail.push(`mailbox isolation unverified: ${typeof visible === "number" ? visible : "unknown"} other account(s) visible to eval`);
  }
  const siteContainer = container("e2e-site");
  if (siteContainer) missing.site.push(siteContainer);
  if (record(endpoints["site"])["up"] !== true) missing.site.push("site not reachable on the host");
  if (config["compiledAllowsSite"] !== true) missing.site.push("the site's SSRF exemption is not in starlingai.json (pnpm e2e:env up)");
  if (gateway["imageSupportsAllowlist"] !== true) missing.site.push("the gateway image does not honour guardrails.allowedPrivateHosts");
  if (!gateway["resolvesSite"]) missing.site.push("the gateway cannot resolve the site's host name");
  const ready = record(json["ready"]);
  return { ready: { mail: ready["mail"] === true, site: ready["site"] === true }, missing };
}

/** The JSON `node scripts/e2e-env.mjs status --json` printed, or why there is none. */
export type EnvironmentStatusSource = () => Promise<{ json: unknown } | { error: string }>;

/**
 * Runs `node scripts/e2e-env.mjs status --json` (read-only; it exits 1 while something is
 * missing and still prints the status). null when the repo has no such script. One answer serves
 * five minutes — the status runs a few docker commands — and both its readers (the service probes
 * and the mail-isolation preflight) share it.
 */
export function environmentStatusSource(repoRoot: string, ttlMs = 5 * 60_000): EnvironmentStatusSource | null {
  const script = join(repoRoot, "scripts", "e2e-env.mjs");
  if (!existsSync(script)) return null;
  let cached: { at: number; status: Promise<{ json: unknown } | { error: string }> } | null = null;
  return () => {
    if (cached && Date.now() - cached.at < ttlMs) return cached.status;
    const status = new Promise<{ json: unknown } | { error: string }>((resolveStatus) => {
      execFile(process.execPath, [script, "status", "--json"], { cwd: repoRoot, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        const parsed = safeJsonParse(String(stdout).trim());
        if (parsed !== undefined) return resolveStatus({ json: parsed });
        const why = String(stderr).trim().split(/\r?\n/)[0] || (err ? err.message : "no output");
        resolveStatus({ error: `pnpm e2e:env status --json gave no status (${why})` });
      });
    });
    cached = { at: Date.now(), status };
    return status;
  };
}

export function environmentFromSource(source: EnvironmentStatusSource): EnvironmentStatusProvider {
  return async () => {
    const raw = await source();
    return "error" in raw ? raw : interpretEnvironmentStatus(raw.json);
  };
}

/** The probes' reading of the e2e environment status; null when the repo has no e2e-env script. */
export function environmentStatusFromScript(repoRoot: string, ttlMs = 5 * 60_000): EnvironmentStatusProvider | null {
  const source = environmentStatusSource(repoRoot, ttlMs);
  return source ? environmentFromSource(source) : null;
}

// ── Preflight: no eval turn may reach the operator's mail ─────────────────────

export interface MailIsolationVerdict {
  safe: boolean;
  detail: string;
}

export type MailIsolationCheck = () => Promise<MailIsolationVerdict>;

/**
 * From the e2e environment status: the accounts the RUNNING mail-service shows `X-Sai-User: eval`
 * (GET /api/accounts inside its container). Any of them not bound to eval (allowedUsers without
 * "eval") is a shared account — the operator's own mail — and makes the run unsafe. A mail-service
 * that is not running is safe; one that runs but could not be asked is not.
 */
export function mailIsolationVerdict(json: unknown): MailIsolationVerdict {
  const mailService = isRecord(json) && isRecord(json["mailService"]) ? json["mailService"] : null;
  if (!mailService) return { safe: false, detail: "cannot verify mail isolation: the e2e environment status has no mailService block" };
  if (mailService["running"] !== true) return { safe: true, detail: "the mail-service container is not running" };
  // sharedAccountsVisibleToEval counts accounts not bound to eval; otherAccountsVisibleToEval (older
  // scripts) every account but the eval mailbox — stricter, never looser.
  const shared = typeof mailService["sharedAccountsVisibleToEval"] === "number"
    ? mailService["sharedAccountsVisibleToEval"]
    : typeof mailService["otherAccountsVisibleToEval"] === "number" ? mailService["otherAccountsVisibleToEval"] : null;
  if (shared === null) return { safe: false, detail: "cannot verify mail isolation: the mail-service runs, but the accounts it shows eval could not be read" };
  if (shared > 0) return { safe: false, detail: `eval can see ${shared} shared mail account(s) — rebuild the mail-service image and run pnpm e2e:setup` };
  return { safe: true, detail: "eval sees no shared mail account" };
}

/** The preflight over the environment status; without the e2e-env script nothing can be verified. */
export function mailIsolationCheck(source: EnvironmentStatusSource | null): MailIsolationCheck {
  return async () => {
    if (!source) return { safe: false, detail: "cannot verify mail isolation: scripts/e2e-env.mjs not found" };
    const raw = await source();
    if ("error" in raw) return { safe: false, detail: `cannot verify mail isolation: ${raw.error}` };
    return mailIsolationVerdict(raw.json);
  };
}

export const DEFAULT_E2E_SITE_URL = "http://localhost:18081";

/**
 * The oldest ok sandbox verdict a scenario runs on: three of the canary's five-minute verdicts
 * (SANDBOX_CANARY_TTL_MS, observability/health-checks.ts). The canary starts no container while a
 * turn runs, so a gateway that is never idle (a turn that never ends, a turn waiting on an approval
 * with no turn timeout, a run at --concurrency 2) served its last verdict for as long as that
 * lasted, and a sandbox broken in the meantime ran its scenarios on a dead channel. Between the
 * scenarios of a run at concurrency 1 the canary re-measures, so a verdict stays well inside this.
 */
export const SANDBOX_VERDICT_MAX_AGE_MS = 15 * 60_000;

export class ServiceProber {
  private readonly cache = new Map<E2EService, { at: number; state: Promise<ServiceState> }>();
  private readonly shared = new Map<string, { at: number; result: Promise<HttpResult> }>();

  constructor(private readonly ctx: ServiceProbeContext, private readonly ttlMs = 60_000) {}

  async check(services: readonly E2EService[]): Promise<ServiceState[]> {
    return Promise.all([...new Set(services)].map((service) => this.state(service)));
  }

  private state(service: E2EService): Promise<ServiceState> {
    const cached = this.cache.get(service);
    if (cached && Date.now() - cached.at < this.ttlMs) return cached.state;
    const state = this.probe(service).catch((err: unknown): ServiceState => ({ service, up: false, detail: `probe failed: ${describeError(err)}` }));
    this.cache.set(service, { at: Date.now(), state });
    return state;
  }

  private gatewayGet(path: string): Promise<HttpResult> {
    const cached = this.shared.get(path);
    if (cached && Date.now() - cached.at < this.ttlMs) return cached.result;
    const result = this.ctx.authedGet(path);
    this.shared.set(path, { at: Date.now(), result });
    result.catch(() => this.shared.delete(path));
    return result;
  }

  private async plainGet(url: string): Promise<number> {
    const response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(this.ctx.timeoutMs ?? 10_000) });
    await response.arrayBuffer().catch(() => undefined);
    return response.status;
  }

  private async subsystem(name: string): Promise<{ status: string; detail: string; checkedAt?: string; ageMs?: number } | string> {
    const result = await this.gatewayGet("/api/health/subsystems");
    // 503 means "something is unavailable" and still carries the checks.
    if (result.status !== 200 && result.status !== 503) return `GET /api/health/subsystems answered HTTP ${result.status}`;
    const checks = isRecord(result.json) && Array.isArray(result.json["checks"]) ? result.json["checks"] : [];
    const check = checks.find((entry): entry is Record<string, unknown> => isRecord(entry) && entry["name"] === name);
    if (!check) return `GET /api/health/subsystems reports no "${name}" check`;
    const ageMs = check["ageMs"];
    return {
      status: String(check["status"] ?? "unknown"),
      detail: typeof check["detail"] === "string" ? check["detail"] : "",
      ...(typeof check["checkedAt"] === "string" ? { checkedAt: check["checkedAt"] } : {}),
      ...(typeof ageMs === "number" && Number.isFinite(ageMs) && ageMs >= 0 ? { ageMs } : {}),
    };
  }

  private async subsystemState(service: E2EService, name: string, requireConfigured = false): Promise<ServiceState> {
    const check = await this.subsystem(name);
    if (typeof check === "string") return { service, up: false, detail: check };
    const notConfigured = /not configured/i.test(check.detail);
    const up = check.status === "ok" && !(requireConfigured && notConfigured);
    return { service, up, detail: `${name}: ${check.status}${check.detail ? ` — ${check.detail}` : ""}` };
  }

  private async multimodal(): Promise<Record<string, unknown> | string> {
    const result = await this.gatewayGet("/api/multimodal/status");
    if (result.status !== 200 || !isRecord(result.json)) return `GET /api/multimodal/status answered HTTP ${result.status}`;
    return result.json;
  }

  private async probe(service: E2EService): Promise<ServiceState> {
    switch (service) {
      case "gateway": {
        try {
          const status = await this.plainGet(`${this.ctx.gatewayUrl}/healthz`);
          return { service, up: status === 200, detail: `GET /healthz → ${status}` };
        } catch (err) {
          return { service, up: false, detail: `gateway unreachable at ${this.ctx.gatewayUrl} (${describeError(err)})` };
        }
      }
      case "model":
        return this.subsystemState(service, "primary_model");
      case "embeddings":
        return this.subsystemState(service, "embeddings");
      case "engram":
        return this.subsystemState(service, "engram", true);
      case "laya":
        return this.subsystemState(service, "laya", true);
      case "browser": {
        const servers = await this.gatewayGet("/api/mcp/servers");
        if (servers.status !== 200) return { service, up: false, detail: `GET /api/mcp/servers answered HTTP ${servers.status}` };
        const list = isRecord(servers.json) && Array.isArray(servers.json["servers"]) ? servers.json["servers"] : [];
        const browserServers = list.filter((entry): entry is Record<string, unknown> =>
          isRecord(entry) && typeof entry["id"] === "string" && /playwright|browser/i.test(entry["id"]));
        const connected = browserServers.find((entry) => entry["status"] === "connected");
        if (!connected) {
          const seen = browserServers.map((entry) => `${String(entry["id"])}: ${String(entry["status"])}`).join(", ");
          return { service, up: false, detail: `no browser MCP server connected${seen ? ` (${seen})` : ""}` };
        }
        const vnc = await this.subsystemState(service, "browser_vnc");
        return vnc.up ? { service, up: true, detail: `MCP ${String(connected["id"])} connected; ${vnc.detail}` } : vnc;
      }
      case "image": {
        const status = await this.multimodal();
        if (typeof status === "string") return { service, up: false, detail: status };
        const image = isRecord(status["imageGeneration"]) ? status["imageGeneration"] : null;
        return image?.["ok"] === true
          ? { service, up: true, detail: "imageGeneration ok" }
          : { service, up: false, detail: `imageGeneration: ${typeof image?.["error"] === "string" ? image["error"] : "not ok"}` };
      }
      case "speech": {
        const status = await this.multimodal();
        if (typeof status === "string") return { service, up: false, detail: status };
        const stt = isRecord(status["stt"]) ? status["stt"] : null;
        const tts = isRecord(status["tts"]) ? status["tts"] : null;
        const up = stt?.["ok"] === true && tts?.["ok"] === true;
        const describe = (name: string, entry: Record<string, unknown> | null): string =>
          `${name} ${entry?.["ok"] === true ? "ok" : typeof entry?.["error"] === "string" ? entry["error"] : "not ok"}`;
        return { service, up, detail: `${describe("stt", stt)}; ${describe("tts", tts)}` };
      }
      case "computer-desktop": {
        const result = await this.gatewayGet("/api/computer-sessions/config");
        if (result.status !== 200) return { service, up: false, detail: `GET /api/computer-sessions/config answered HTTP ${result.status}` };
        const enabled = isRecord(result.json) && result.json["enabled"] === true;
        return { service, up: enabled, detail: enabled ? "computer use enabled (configuration check only)" : "computer use is disabled in the gateway config" };
      }
      case "mail": {
        if (!this.ctx.mail) return { service, up: false, detail: "no mail adapter configured" };
        const probe = await this.ctx.mail.probe();
        if (!probe.up || !this.ctx.environment) return { service, up: probe.up, detail: probe.detail };
        const environment = await this.ctx.environment();
        if ("error" in environment) return { service, up: false, detail: `cannot verify the eval mailbox and its isolation: ${environment.error}` };
        return environment.ready.mail
          ? { service, up: true, detail: `${probe.detail}; eval mailbox loaded and isolated` }
          : { service, up: false, detail: `e2e environment not ready for mail: ${environment.missing.mail.join("; ") || "see pnpm e2e:env status"}` };
      }
      case "e2e-site": {
        const url = this.ctx.siteUrl ?? DEFAULT_E2E_SITE_URL;
        let status: number;
        try {
          status = await this.plainGet(url);
        } catch (err) {
          return { service, up: false, detail: `e2e site unreachable at ${url} (${describeError(err)})` };
        }
        if (status >= 500) return { service, up: false, detail: `GET ${url} → ${status}` };
        if (!this.ctx.environment) return { service, up: true, detail: `GET ${url} → ${status}` };
        const environment = await this.ctx.environment();
        if ("error" in environment) return { service, up: true, detail: `GET ${url} → ${status} (environment not verified: ${environment.error})` };
        return environment.ready.site
          ? { service, up: true, detail: `GET ${url} → ${status}; reachable for agents` }
          : { service, up: false, detail: `e2e environment not ready for the site: ${environment.missing.site.join("; ") || "see pnpm e2e:env status"}` };
      }
      case "web-search": {
        if (!this.ctx.searxngUrl) return { service, up: true, assumed: true, detail: "no probe (set E2E_SEARXNG_URL to probe SearXNG)" };
        const url = `${this.ctx.searxngUrl.replace(/\/+$/, "")}/healthz`;
        try {
          const status = await this.plainGet(url);
          return { service, up: status === 200, detail: `GET ${url} → ${status}` };
        } catch (err) {
          return { service, up: false, detail: `SearXNG unreachable at ${url} (${describeError(err)})` };
        }
      }
      case "sandbox": {
        // This was assumed up, and from July to 2026-10-07 the docker-socket proxy dropped every
        // sandbox command's output: the sandbox scenario was graded on whatever the coder made of
        // "(no output)". Only a verdict the canary measured lets a scenario that needs it run.
        const check = await this.subsystem("sandbox");
        if (typeof check === "string") return { service, up: false, detail: check };
        const detail = `sandbox: ${check.status}${check.detail ? ` — ${check.detail}` : ""}`;
        if (check.status !== "ok" || check.checkedAt === undefined) return { service, up: false, detail };
        // The age the gateway counts, never checkedAt against this host's clock: the gateway's VM
        // clock can drift from it (WSL2 after sleep).
        if (check.ageMs === undefined) return { service, up: false, detail: "sandbox verdict of unknown age: the gateway reports no ageMs with it" };
        if (check.ageMs > SANDBOX_VERDICT_MAX_AGE_MS) {
          const minutes = Math.ceil(check.ageMs / 60_000);
          return { service, up: false, detail: `sandbox verdict ${minutes} min old, not re-measured while turns run, over the ${SANDBOX_VERDICT_MAX_AGE_MS / 60_000} min a scenario takes` };
        }
        return { service, up: true, detail };
      }
      default: {
        const unknown: never = service;
        return { service: unknown, up: false, detail: "unknown service" };
      }
    }
  }
}
