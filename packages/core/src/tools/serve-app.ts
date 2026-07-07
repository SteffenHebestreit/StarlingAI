/**
 * serve_app — run a user-built web app as a dedicated, long-lived container and
 * expose it through the gateway reverse proxy (/api/app/<id>/).
 *
 * Unlike the one-shot sub-agent sandbox (container-runner.ts), this runs a
 * persistent server container on the gateway's docker network (default
 * `starlingai-public`), so the gateway process can reach it by container NAME —
 * no host-port juggling. The gateway proxy route (gateway/index.ts) forwards
 * authenticated requests to `http://sai-app-<id>:<port>/` and injects a <base>
 * tag into HTML so relative asset URLs resolve under the /api/app/<id>/ subpath.
 *
 * Scope (v1): Node/Express (and any node-startable app). Static sites do NOT
 * need this — they are already served by /api/workspace/preview. Tier 3
 * privileged + per-call approval (it launches a long-lived networked container).
 *
 * Docker exec and the health probe are injectable so the lifecycle logic is
 * unit-testable without a docker daemon.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { resolveDockerWorkspaceMountSource } from "./workspace-mount.js";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";

const log = childLogger("tools:serve-app");

export type ServedAppRuntime = "node-express";
export type ServedAppStatus = "starting" | "running" | "failed" | "stopped";

export interface ServedApp {
  id: string;
  name: string;
  containerName: string;
  runtime: ServedAppRuntime;
  internalPort: number;
  network: string;
  image: string;
  root: string;
  command: string;
  status: ServedAppStatus;
  startedAt: number;
  sessionId: string;
  lastError?: string;
}

/** In-process registry shared with the gateway proxy route. Apps do not survive
 * a gateway restart (the containers are auto-removed) — documented limitation. */
const apps = new Map<string, ServedApp>();
export function getServedApp(id: string): ServedApp | undefined { return apps.get(id); }
export function listServedApps(): ServedApp[] { return [...apps.values()]; }
export function __resetServedAppsForTests(): void { apps.clear(); }

// ── Injectable docker exec ────────────────────────────────────────────────
export type DockerExec = (args: string[], opts?: { timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;

function defaultDockerExec(args: string[], opts?: { timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveExec) => {
    const proc = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = opts?.timeoutMs
      ? setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* already gone */ } }, opts.timeoutMs)
      : null;
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", (err) => { if (timer) clearTimeout(timer); resolveExec({ code: -1, stdout, stderr: stderr || String(err) }); });
    proc.on("close", (code) => { if (timer) clearTimeout(timer); resolveExec({ code: code ?? -1, stdout, stderr }); });
  });
}

let dockerExec: DockerExec = defaultDockerExec;
export function __setDockerExecForTests(fn: DockerExec | null): void { dockerExec = fn ?? defaultDockerExec; }

// ── Injectable health probe ───────────────────────────────────────────────
export type HealthProbe = (url: string) => Promise<boolean>;
async function defaultHealthProbe(url: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(url, { signal: ctrl.signal, redirect: "manual" });
    clearTimeout(t);
    // Any HTTP response (even 404) means the server is listening.
    return res.status > 0;
  } catch {
    return false;
  }
}
let healthProbe: HealthProbe = defaultHealthProbe;
export function __setHealthProbeForTests(fn: HealthProbe | null): void { healthProbe = fn ?? defaultHealthProbe; }

// ── Injectable app fetch (for verify_app) ─────────────────────────────────
// Full response capture (status + content-type + body) against a served app's
// internal container URL. Separate from the boolean healthProbe so verify_app can
// report what it actually found. Injectable for unit tests.
export interface AppFetchResult { status: number; contentType: string; body: string; error?: string }
export type AppFetch = (url: string, timeoutMs: number) => Promise<AppFetchResult>;
async function defaultAppFetch(url: string, timeoutMs: number): Promise<AppFetchResult> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctrl.signal, redirect: "manual", headers: { "User-Agent": "StarlingAI-verify/0.1" } });
    const raw = await res.text().catch(() => "");
    clearTimeout(t);
    return { status: res.status, contentType: res.headers.get("content-type") ?? "", body: raw.slice(0, 16_000) };
  } catch (err) {
    return { status: 0, contentType: "", body: "", error: err instanceof Error ? err.message : String(err) };
  }
}
let appFetch: AppFetch = defaultAppFetch;
export function __setAppFetchForTests(fn: AppFetch | null): void { appFetch = fn ?? defaultAppFetch; }

/** Log lines that signal a real runtime fault (not just the word "error" in app output). */
const FATAL_LOG_RE = /(unhandled(?:rejection)?|uncaughtexception|cannot find module|econnrefused|eaddrinuse|listen e[a-z]+|fatal|segmentation fault|traceback \(most recent call last\)|\b(?:error|exception):|\bthrow new )/i;

/**
 * A page is CLIENT-RENDERED when the server returns a thin shell (a mount root +
 * scripts) and the visible content only appears after JS runs in a browser —
 * Leaflet/OSM maps, canvas charts, SPAs. For these a server-side body fetch
 * proves the shell loaded, NOT that the app painted: a JS error or a failed tile
 * fetch leaves the same passing shell. We detect this so verify_app can refuse to
 * give false confidence and demand a browser DOM check, instead of silently
 * PASSing a blank map. Structural/topic-agnostic — keys off mount roots + script
 * volume + sparse visible text, never "leaflet"/"map" specifically.
 */
function looksClientRendered(body: string): boolean {
  if (!body) return false;
  const hasScript = /<script[\s>]/i.test(body);
  if (!hasScript) return false;
  // A canvas or a conventional SPA/map mount root that is populated by JS.
  const hasMountRoot = /<canvas[\s>]/i.test(body)
    || /<div[^>]+id\s*=\s*["'](?:app|root|map|chart|root-app|application)["']/i.test(body)
    || /\b(?:leaflet|maplibre|mapbox|deck\.gl|chart\.js|three\.js|react|vue|svelte)\b/i.test(body);
  if (!hasMountRoot) return false;
  // Visible text once tags/scripts/styles are stripped — a shell has very little.
  const visibleText = body
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return visibleText.length < 400;
}

// ── Config (env-driven, no schema churn) ──────────────────────────────────
function serveAppNetwork(): string { return process.env["SAI_APP_NETWORK"]?.trim() || "starlingai-public"; }
function serveAppImage(): string { return process.env["SAI_APP_NODE_IMAGE"]?.trim() || "node:22-alpine"; }
function serveAppDefaultPort(): number { return Number(process.env["SAI_APP_PORT"]) || 3000; }
function serveAppHealthTimeoutMs(): number { return Number(process.env["SAI_APP_HEALTH_TIMEOUT_MS"]) || 180_000; }
function serveAppMaxApps(): number { return Number(process.env["SAI_APP_MAX"]) || 5; }
function serveAppPollIntervalMs(): number { return Number(process.env["SAI_APP_POLL_INTERVAL_MS"]) || 2000; }

/** Reject absolute paths and any traversal so a served root stays in the workspace. */
export function sanitizeAppRoot(root: string): string | null {
  const raw = (root || "").trim();
  if (!raw) return null;
  // Reject absolute and drive-letter paths BEFORE any normalization.
  if (raw.startsWith("/") || raw.startsWith("\\") || /^[a-zA-Z]:/.test(raw)) return null;
  const cleaned = raw.replace(/[/\\]+$/, "").replace(/\\/g, "/");
  if (!cleaned) return null;
  if (/(^|\/)\.\.(\/|$)/.test(cleaned)) return null; // traversal
  return cleaned;
}

/** Insert a <base href> so an app proxied under /api/app/<id>/ resolves its
 * relative asset URLs correctly. No-op when the document already declares a base. */
export function injectBaseHref(html: string, base: string): string {
  if (/<base\s/i.test(html)) return html;
  const tag = `<base href="${base}">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}${tag}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${tag}</head>`);
  return `${tag}${html}`;
}

/** Pure, testable docker-run arg builder. */
export function buildServeRunArgs(app: ServedApp, hostAppDir: string): string[] {
  return [
    "run", "-d", "--rm", "--init",
    "--name", app.containerName,
    "--label", `starlingai.app=${app.id}`,
    "--label", `starlingai.session=${app.sessionId}`,
    "--network", app.network,
    "--memory", "512m",
    "--cpus", "1",
    "--pids-limit", "256",
    "--security-opt", "no-new-privileges",
    // Isolation parity with the shell sandbox: agent-authored server code runs
    // with NO Linux capabilities and a read-only root filesystem. The app can
    // still write its own mounted dir (/app, for `npm install` → node_modules)
    // and a tmpfs /tmp; HOME + the npm cache are pointed at /tmp so npm works
    // under the read-only root. (Root user is kept because /app is owned by the
    // gateway uid — dropping all caps + read-only is the meaningful hardening.)
    "--cap-drop", "ALL",
    "--read-only",
    "--tmpfs", "/tmp:size=256m,exec",
    "-w", "/app",
    "-e", `PORT=${app.internalPort}`,
    "-e", "HOST=0.0.0.0",
    "-e", "NODE_ENV=production",
    "-e", "HOME=/tmp",
    "-e", "npm_config_cache=/tmp/.npm",
    "-v", `${hostAppDir}:/app`,
    app.image,
    "sh", "-lc", app.command,
  ];
}

function defaultStartCommand(entry: string, internalPort: number): string {
  // Install deps when a manifest is present, then start. The app MUST bind
  // 0.0.0.0:$PORT (we pass PORT) so the gateway can reach it by container name.
  const safeEntry = entry.replace(/[^\w./-]/g, "");
  return `if [ -f package.json ]; then npm install --no-audit --no-fund --loglevel=error || exit 1; fi; `
    + `if [ -f package.json ] && grep -q '"start"' package.json; then exec npm start; else exec node ${safeEntry || "server.js"}; fi`;
}

/** Structural container-liveness probe used while waiting for an app to listen.
 * "exited": the container is gone (--rm removed it after it exited) or reports Running=false.
 * "unknown": a transient inspect error — the caller keeps polling (never a false early-fail).
 * Lets the health-poll distinguish "still booting" from "crashed on boot" without any
 * knowledge of WHAT the app is — purely docker state. */
async function containerLiveness(name: string): Promise<"alive" | "exited" | "unknown"> {
  const r = await dockerExec(["inspect", "-f", "{{.State.Running}}", name], { timeoutMs: 5000 })
    .catch(() => ({ code: -1, stdout: "", stderr: "" }));
  const combined = `${r.stdout} ${r.stderr}`.toLowerCase();
  if (/no such (?:object|container)/.test(combined)) return "exited"; // removed by --rm after exit
  if (r.code === 0) {
    const state = r.stdout.trim().toLowerCase();
    if (state === "false") return "exited"; // exited but not yet reaped
    if (state === "true") return "alive";
  }
  return "unknown"; // transient inspect error — don't bail, keep polling
}

function appSummary(app: ServedApp): Record<string, unknown> {
  return {
    id: app.id,
    name: app.name,
    status: app.status,
    runtime: app.runtime,
    previewPath: `/api/app/${app.id}/`,
    container: app.containerName,
    internalPort: app.internalPort,
    root: app.root,
    startedAt: new Date(app.startedAt).toISOString(),
    ...(app.lastError ? { lastError: app.lastError } : {}),
  };
}

async function startApp(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const root = sanitizeAppRoot(String(args["root"] ?? ""));
  if (!root) {
    return { success: false, output: "", error: "A workspace-relative 'root' directory (containing the app, e.g. 'generated/my-app') is required and must stay inside the workspace." };
  }
  const running = listServedApps().filter((a) => a.status === "running" || a.status === "starting");
  if (running.length >= serveAppMaxApps()) {
    return { success: false, output: "", error: `Too many running apps (${running.length}/${serveAppMaxApps()}). Stop one with serve_app(action:"stop", id:...) first.` };
  }

  const id = randomUUID().slice(0, 8);
  const internalPort = Number(args["port"]) > 0 ? Number(args["port"]) : serveAppDefaultPort();
  const entry = String(args["entry"] ?? "server.js");
  const command = (typeof args["command"] === "string" && args["command"].trim())
    ? String(args["command"]).trim()
    : defaultStartCommand(entry, internalPort);

  const app: ServedApp = {
    id,
    name: String(args["name"] ?? root),
    containerName: `sai-app-${id}`,
    runtime: "node-express",
    internalPort,
    network: serveAppNetwork(),
    image: serveAppImage(),
    root,
    command,
    status: "starting",
    startedAt: Date.now(),
    sessionId: ctx.sessionId,
  };
  apps.set(id, app);

  const hostAppDir = `${resolveDockerWorkspaceMountSource(ctx.workspacePath).replace(/[/\\]+$/, "")}/${root}`;
  logAudit("serve_app_started", { id, container: app.containerName, root, network: app.network, image: app.image }, { sessionId: ctx.sessionId, severity: "warn" });

  const run = await dockerExec(buildServeRunArgs(app, hostAppDir), { timeoutMs: 60_000 });
  if (run.code !== 0) {
    app.status = "failed";
    app.lastError = (run.stderr || run.stdout || "docker run failed").trim().slice(0, 600);
    if (/cannot connect to the docker daemon|is the docker daemon running/i.test(app.lastError)) {
      app.lastError = "Docker daemon is not reachable from the gateway — serve_app requires the dockerized gateway with docker access.";
    }
    return { success: false, output: "", error: `Failed to launch app container: ${app.lastError}`, metadata: appSummary(app) };
  }

  // Health-poll the app by container name on the shared network until it listens —
  // but bail the moment its container EXITS. A --rm container that crashed on boot
  // (or whose `npm install` couldn't reach the registry in the sandbox) is already
  // gone; polling a dead name for the full timeout wastes minutes and then yields
  // the misleading "bind 0.0.0.0:$PORT" diagnosis (the server never even ran).
  // Liveness is structural docker state, so "still booting" ≠ "exited".
  const probeUrl = `http://${app.containerName}:${app.internalPort}/`;
  const deadline = Date.now() + serveAppHealthTimeoutMs();
  let healthy = false;
  let containerExited = false;
  for (;;) {
    if (ctx.signal?.aborted) break;
    if (await healthProbe(probeUrl)) { healthy = true; break; }
    if ((await containerLiveness(app.containerName)) === "exited") { containerExited = true; break; }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, serveAppPollIntervalMs()));
  }

  if (!healthy) {
    const logs = await dockerExec(["logs", "--tail", "40", app.containerName], { timeoutMs: 8000 }).catch(() => ({ code: -1, stdout: "", stderr: "" }));
    const logTail = (logs.stdout || logs.stderr || "").trim();
    app.status = "failed";
    if (containerExited) {
      // The start command RAN and the container EXITED before binding the port — a
      // boot crash, or (most often in the sandbox) the default command's `npm install`
      // step could not reach the registry. Name the real cause so the agent fixes the
      // right thing instead of chasing the bind address for the full timeout.
      const installsDeps = /npm\s+(?:install|ci)\b/.test(app.command);
      const hint = installsDeps
        ? "The start command runs `npm install`, which fails when the sandbox cannot reach the npm registry. Prefer a ZERO-DEPENDENCY server (Node's built-in `http` module — no package dependencies, no install) so it boots offline, or pass a `command` that skips the install."
        : "The start command exited before the server listened — check for a boot crash (missing file, syntax error, unhandled exception, wrong entry).";
      app.lastError = `App container exited during startup before it listened on port ${app.internalPort}. ${hint}`;
      return {
        success: false,
        output: `App '${app.name}' container exited during startup — it never listened on port ${app.internalPort}.\n${hint}`
          + (logTail ? `\nLast container logs:\n${logTail.slice(-1500)}` : "\n(No container logs — it was removed on exit.)"),
        error: app.lastError,
        metadata: appSummary(app),
      };
    }
    app.lastError = `App did not start listening on port ${app.internalPort} within ${Math.round(serveAppHealthTimeoutMs() / 1000)}s. Make sure the server binds 0.0.0.0:$PORT.`;
    return {
      success: false,
      output: `App '${app.name}' launched but never became reachable.\nLast container logs:\n${(logTail || "(none)").slice(-1500)}`,
      error: app.lastError,
      metadata: appSummary(app),
    };
  }

  app.status = "running";
  logAudit("serve_app_running", { id, container: app.containerName, previewPath: `/api/app/${id}/` }, { sessionId: ctx.sessionId });
  return {
    success: true,
    output: `App '${app.name}' is running. Open it at /api/app/${id}/ (served through the gateway, requires the dashboard token). Stop it with serve_app(action:"stop", id:"${id}").`,
    metadata: appSummary(app),
  };
}

async function stopApp(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const id = String(args["id"] ?? "").trim();
  if (!id) return { success: false, output: "", error: "'id' is required to stop an app (use action:\"list\" to see running apps)." };
  const app = apps.get(id);
  if (!app) return { success: false, output: "", error: `No app with id '${id}'.` };
  await dockerExec(["rm", "-f", app.containerName], { timeoutMs: 15_000 }).catch(() => undefined);
  app.status = "stopped";
  apps.delete(id);
  logAudit("serve_app_stopped", { id, container: app.containerName }, { sessionId: ctx.sessionId });
  return { success: true, output: `Stopped app '${app.name}' (${id}).`, metadata: { id, status: "stopped" } };
}

async function appLogs(args: Record<string, unknown>): Promise<ToolResult> {
  const id = String(args["id"] ?? "").trim();
  const app = id ? apps.get(id) : undefined;
  if (!app) return { success: false, output: "", error: `No app with id '${id}'.` };
  const tail = Math.min(Math.max(Number(args["tail"]) || 80, 1), 500);
  const logs = await dockerExec(["logs", "--tail", String(tail), app.containerName], { timeoutMs: 8000 }).catch(() => ({ code: -1, stdout: "", stderr: "" }));
  return { success: true, output: (logs.stdout || logs.stderr || "(no logs)").slice(-4000), metadata: appSummary(app) };
}

async function verifyApp(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const id = String(args["id"] ?? "").trim();
  const app = id ? apps.get(id) : undefined;
  if (!app) return { success: false, output: "", error: `No app with id '${id}'. Start it with serve_app first, then verify it (use serve_app action:"list" to see ids).` };
  if (app.status !== "running") {
    const logs = await dockerExec(["logs", "--tail", "40", app.containerName], { timeoutMs: 8000 }).catch(() => ({ code: -1, stdout: "", stderr: "" }));
    return {
      success: false,
      output: `App '${app.name}' is not running (status: ${app.status}). It must boot before it can be verified.\nLast logs:\n${(logs.stdout || logs.stderr || "(none)").slice(-1500)}`,
      error: app.lastError ?? `App status is '${app.status}'.`,
      metadata: appSummary(app),
    };
  }

  const rawPath = String(args["path"] ?? "/").trim() || "/";
  const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  const expectContent = typeof args["expectContent"] === "string" ? String(args["expectContent"]).trim() : "";
  const url = `http://${app.containerName}:${app.internalPort}${path}`;

  const res = await appFetch(url, 12_000);
  const logs = await dockerExec(["logs", "--tail", "60", app.containerName], { timeoutMs: 8000 }).catch(() => ({ code: -1, stdout: "", stderr: "" }));
  const logText = `${logs.stdout || ""}\n${logs.stderr || ""}`;
  const errorLines = logText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && FATAL_LOG_RE.test(l)).slice(0, 8);

  const reachable = res.status > 0 && res.error === undefined;
  const httpOk = res.status >= 200 && res.status < 400;
  const contentPresent = expectContent ? res.body.toLowerCase().includes(expectContent.toLowerCase()) : undefined;
  const verdictPass = reachable && httpOk && contentPresent !== false;
  // For a client-rendered app a server-side fetch only proves the shell loaded.
  // A passing verdict here is NOT a confirmation that it painted.
  const clientRendered = reachable && httpOk && looksClientRendered(res.body);
  const renderConfirmed = clientRendered ? false : verdictPass;

  const lines: string[] = [];
  const verdictLabel = verdictPass ? (clientRendered ? "🟡 PASS (server) — RENDER UNCONFIRMED" : "✅ PASS") : "❌ FAIL";
  lines.push(`${verdictLabel} — verified ${path} on app '${app.name}'.`);
  lines.push(reachable ? `HTTP ${res.status} (${res.contentType || "no content-type"}), ${res.body.length} bytes.` : `UNREACHABLE: ${res.error ?? "no response"}.`);
  if (expectContent) lines.push(contentPresent ? `Expected content "${expectContent}" is present${clientRendered ? " in the shell HTML (not necessarily the rendered DOM)" : ""}.` : `Expected content "${expectContent}" was NOT found in the response.`);
  if (errorLines.length) lines.push(`⚠ Runtime error lines in the container logs:\n${errorLines.map((l) => `  ${l}`).join("\n")}`);
  if (verdictPass && clientRendered) {
    // The false-confidence case: shell loads, server check passes, but a JS error
    // or a failed tile/data fetch would leave this exact passing shell. Demand a
    // real DOM check before this counts as done — client-side JS errors never
    // reach the container logs the server-side scan above reads.
    lines.push("This app is CLIENT-RENDERED (map/canvas/SPA). The server answered, but this does NOT prove the UI actually painted — a JS error or a failed tile/data fetch would leave this same passing shell.");
    lines.push(`REQUIRED before declaring done: browser_navigate to the preview URL (/api/app/${app.id}/${path === "/" ? "" : path.replace(/^\//, "")}), then browser_snapshot (or browser_evaluate) and assert the expected element actually rendered (map tiles/markers, chart canvas, list rows) and the browser console has no errors.`);
  }
  if (reachable && res.body.trim()) lines.push(`Response head:\n${res.body.slice(0, 600)}`);
  if (!verdictPass) {
    lines.push(
      !reachable ? "Fix: ensure the server binds 0.0.0.0:$PORT and does not crash on boot (check serve_app logs)."
      : !httpOk ? `Fix: the route returned HTTP ${res.status}. Check the route/handler and the logs above.`
      : "Fix: the page rendered but is missing the expected content — check the template/data path.",
    );
    lines.push("Then re-run verify_app. For visual/DOM checks (client-side rendering, layout), browser_navigate to the previewPath and browser_snapshot.");
  }

  logAudit("verify_app", { id: app.id, path, status: res.status, verdict: verdictPass ? "pass" : "fail", clientRendered, renderConfirmed, errorLogLines: errorLines.length }, { sessionId: ctx.sessionId, severity: verdictPass ? "info" : "warn" });

  return {
    success: verdictPass,
    output: lines.join("\n"),
    ...(verdictPass ? {} : { error: reachable ? `Verification failed (HTTP ${res.status}${contentPresent === false ? ", missing expected content" : ""}).` : `App unreachable: ${res.error ?? "no response"}.` }),
    metadata: {
      ...appSummary(app),
      verdict: verdictPass ? "pass" : "fail",
      clientRendered,
      renderConfirmed,
      httpStatus: res.status,
      contentType: res.contentType,
      contentPresent,
      bodyLength: res.body.length,
      errorLogLines: errorLines,
      checkedPath: path,
    },
  };
}

registerTool({
  name: "verify_app",
  description: "Verify a web app you built and started with serve_app actually boots and serves correctly BEFORE declaring the task done. Fetches the running app server-side (no token needed), checks the HTTP status and (optionally) that expected content is present, and surfaces runtime error lines from the container logs. Returns PASS/FAIL with a concrete fix hint; on FAIL, fix the code and re-run. For a CLIENT-RENDERED app (map/canvas/SPA) it returns 'PASS (server) — RENDER UNCONFIRMED' because a server fetch only proves the shell loaded, not that the UI painted; you MUST then browser_navigate to the preview URL + browser_snapshot/browser_evaluate to confirm the render before declaring done.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "The served app id (from serve_app start / list)." },
      path: { type: "string", description: "Path to check (default '/'). Use a specific route to verify it, e.g. '/api/health'." },
      expectContent: { type: "string", description: "Optional substring that must appear in the response body (e.g. a heading or marker) — proves the page rendered, not just that the server answered." },
    },
    required: ["id"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      return await verifyApp(args, ctx);
    } catch (err) {
      log.error({ err }, "verify_app failed");
      return { success: false, output: "", error: `verify_app failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
});

registerTool({
  name: "serve_app",
  description: "Run a built web app as a live, dedicated container and expose it through the gateway at /api/app/<id>/. Use for DYNAMIC apps that need a running server (Node/Express). A static site or reveal.js deck does NOT need this — it is already served by the workspace preview. Actions: start (default; needs 'root' = the workspace folder containing the app, e.g. 'generated/my-app', with the server binding 0.0.0.0:$PORT), stop (needs 'id'), list, logs (needs 'id').",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["start", "stop", "list", "logs"], description: "Lifecycle action (default start)" },
      root: { type: "string", description: "For start: workspace-relative directory containing the app (package.json/server.js), e.g. 'generated/my-app'." },
      runtime: { type: "string", enum: ["node-express"], description: "App runtime (default node-express)." },
      entry: { type: "string", description: "Entry file for the default start command when there is no npm 'start' script (default server.js)." },
      command: { type: "string", description: "Optional shell command to start the server (overrides the default install+start). Must keep the server in the foreground and bind 0.0.0.0:$PORT." },
      port: { type: "number", description: "Internal port the server listens on (default 3000). Passed to the container as $PORT." },
      name: { type: "string", description: "Optional human label for the app." },
      id: { type: "string", description: "App id for stop/logs." },
      tail: { type: "number", description: "For logs: number of trailing lines (default 80)." },
    },
    required: [],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = String(args["action"] ?? "start").trim() || "start";
    try {
      switch (action) {
        case "start": return await startApp(args, ctx);
        case "stop": return await stopApp(args, ctx);
        case "logs": return await appLogs(args);
        case "list": return { success: true, output: listServedApps().length === 0 ? "No apps running." : listServedApps().map((a) => `- ${a.id} '${a.name}' [${a.status}] → /api/app/${a.id}/`).join("\n"), metadata: { apps: listServedApps().map(appSummary) } };
        default: return { success: false, output: "", error: `Unknown action '${action}'. Use start | stop | list | logs.` };
      }
    } catch (err) {
      log.error({ err, action }, "serve_app failed");
      return { success: false, output: "", error: `serve_app ${action} failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
});
