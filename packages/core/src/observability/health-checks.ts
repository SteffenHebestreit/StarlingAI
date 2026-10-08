/**
 * Subsystem self-checks — surface SILENT degradation.
 *
 * Several subsystems fail quietly: embeddings can return all-zero vectors (the
 * LM Studio base64 bug), graph write-through can error on every call, telemetry
 * can stop flowing — all while the system "looks" healthy because the writes are
 * fire-and-forget. These active probes turn those silent failures into a visible
 * signal on /api/health/subsystems (and feed the dashboard).
 *
 * Kept off the cheap /healthz liveness probe so the Docker healthcheck stays
 * fast and never flaps on a degraded-but-live subsystem.
 */
import { randomBytes } from "node:crypto";
import { childLogger } from "../logger.js";
import type { ToolHandler } from "../tools/registry.js";
import { getEventLoopLagSnapshot, DEFAULT_WARN_MS, DEFAULT_SEVERE_MS, type EventLoopLagSnapshot } from "./event-loop-monitor.js";
import { getProviderActivitySnapshot, type ProviderActivitySnapshot } from "./provider-activity-monitor.js";
import { isEmbeddingAvailable, computeQueryEmbedding } from "../providers/embeddings.js";
import { initVectorStore, vectorStoreDimension } from "../db/vector-store.js";
import { isGraphDbAvailable, runCypher, toPlainRecords } from "../db/neo4j.js";
import { isQuestDbAvailable, questQuery } from "../db/questdb.js";
import { getTelemetryWriteHealth } from "./telemetry.js";
import { getAuditWriteStatus } from "../audit/logger.js";
import { browserSessionManager } from "../agent/browser-session.js";
import { engramConfigured, engramHealth } from "../retrieval/engram.js";
import { layaConfigured, layaHealth } from "../decisions/laya-client.js";

const log = childLogger("health-checks");

export type CheckStatus = "ok" | "degraded" | "unavailable";

export interface SubsystemCheck {
  name: string;
  status: CheckStatus;
  detail?: string;
  /**
   * When a check that serves a cached verdict measured it (ISO time). Absent on the checks that
   * probe on every call, and on a canary that has not measured anything (checkSandbox).
   */
  checkedAt?: string;
}

export interface SubsystemHealth {
  /** false if any subsystem is fully unavailable. "degraded" alone stays true (live but impaired). */
  healthy: boolean;
  degraded: boolean;
  checks: SubsystemCheck[];
}

/**
 * Pure classifier for an embedding probe vector — the highest-value check.
 * A non-null vector of all zeros means the embedding pipeline is broken
 * (e.g. base64 mis-decode) and every semantic feature is silently degraded.
 */
export function classifyEmbeddingProbe(vec: Float32Array | number[] | null | undefined): SubsystemCheck {
  if (!vec || vec.length === 0) {
    return { name: "embeddings", status: "unavailable", detail: "embed returned an empty vector" };
  }
  let nonZero = false;
  for (const v of vec) { if (v !== 0) { nonZero = true; break; } }
  return nonZero
    ? { name: "embeddings", status: "ok", detail: `dim ${vec.length}` }
    : { name: "embeddings", status: "degraded", detail: "all-zero vectors — embedding encoding/model is broken" };
}

/**
 * Pure classifier for the event-loop lag snapshot. Reports `degraded` (never
 * `unavailable`, so a transient GC spike can't flip the whole gateway to 503)
 * once a sampling window contains a stall past the warn floor; the detail spells
 * out whether it was merely elevated or a freeze long enough to flap health. The
 * snapshot reflects the last sampled window, so a stall in progress right now may
 * not show until the sampler runs again — the `event_loop_lag` audit row is the
 * point-in-time record.
 */
export function classifyEventLoopLag(
  snap: EventLoopLagSnapshot | null,
  warnMs = DEFAULT_WARN_MS,
  severeMs = DEFAULT_SEVERE_MS,
): SubsystemCheck {
  if (!snap) return { name: "event_loop", status: "ok", detail: "no sample yet" };
  if (snap.maxMs >= severeMs) {
    return {
      name: "event_loop",
      status: "degraded",
      detail: `loop blocked ${snap.maxMs}ms in the last ${Math.round(snap.windowMs / 1000)}s (peak ${snap.peakMs}ms) — synchronous main-thread hotspot, not I/O wait`,
    };
  }
  if (snap.maxMs >= warnMs) {
    return {
      name: "event_loop",
      status: "degraded",
      detail: `elevated loop lag: worst ${snap.maxMs}ms, mean ${snap.meanMs}ms, p99 ${snap.p99Ms}ms`,
    };
  }
  return { name: "event_loop", status: "ok", detail: `worst ${snap.maxMs}ms, mean ${snap.meanMs}ms` };
}

function checkEventLoop(): SubsystemCheck {
  return classifyEventLoopLag(getEventLoopLagSnapshot());
}

/**
 * Pure classifier for in-flight provider activity. `degraded` (never
 * `unavailable` — a slow-but-working remote must not flip the gateway to 503)
 * when an in-flight call is stalled or has produced no output for a worrying
 * while; the detail says which. Idle (no calls) is `ok`.
 */
export function classifyProviderActivity(snap: ProviderActivitySnapshot | null): SubsystemCheck {
  if (!snap || snap.inFlight === 0 || !snap.worst) {
    return { name: "provider_activity", status: "ok", detail: snap ? `${snap?.inFlight ?? 0} call(s) in flight` : "no sample yet" };
  }
  const w = snap.worst;
  const secs = Math.round(w.elapsedMs / 1000);
  if (w.state === "stalled") {
    return { name: "provider_activity", status: "degraded", detail: `remote produced tokens then went silent ${Math.round((w.silentMs ?? 0) / 1000)}s ago (${w.model}, ${secs}s elapsed) — stream stalled` };
  }
  if (w.state === "awaiting_output") {
    return { name: "provider_activity", status: "degraded", detail: w.mode === "stream"
      ? `remote has produced no tokens after ${secs}s (${w.model}) — still processing the prompt or stuck`
      : `non-streaming call awaiting a response for ${secs}s (${w.model}) — no token granularity` };
  }
  return { name: "provider_activity", status: "ok", detail: `${snap.inFlight} call(s) in flight; worst ${w.state} (${w.model}, ${secs}s)` };
}

function checkProviderActivity(): SubsystemCheck {
  return classifyProviderActivity(getProviderActivitySnapshot());
}

async function checkEmbeddings(): Promise<SubsystemCheck> {
  if (!isEmbeddingAvailable()) {
    return { name: "embeddings", status: "unavailable", detail: "no embedding model ready" };
  }
  try {
    const vec = await computeQueryEmbedding("subsystem health probe");
    return classifyEmbeddingProbe(vec);
  } catch (err) {
    return { name: "embeddings", status: "unavailable", detail: summarize(err) };
  }
}

async function checkVectorStore(): Promise<SubsystemCheck> {
  if (!process.env["DATABASE_URL"]) {
    return { name: "vector_store", status: "unavailable", detail: "no DATABASE_URL" };
  }
  try {
    const ready = await initVectorStore();
    return ready
      ? { name: "vector_store", status: "ok", detail: `pgvector dim ${vectorStoreDimension()}` }
      : { name: "vector_store", status: "degraded", detail: "pgvector not ready (extension/embedding model)" };
  } catch (err) {
    return { name: "vector_store", status: "unavailable", detail: summarize(err) };
  }
}

async function checkGraph(): Promise<SubsystemCheck> {
  if (!isGraphDbAvailable()) {
    return { name: "graph", status: "unavailable", detail: "MemGraph offline" };
  }
  try {
    const result = await runCypher("MATCH (n) RETURN count(n) AS c", {}, {});
    const nodes = result ? Number(toPlainRecords(result)[0]?.["c"] ?? 0) : 0;
    return { name: "graph", status: "ok", detail: `${nodes} nodes` };
  } catch (err) {
    // Reachable driver but queries error (e.g. a transaction-mode bug) is a
    // real degradation worth surfacing, not a hard outage.
    return { name: "graph", status: "degraded", detail: summarize(err) };
  }
}

async function checkTelemetry(): Promise<SubsystemCheck> {
  if (!isQuestDbAvailable()) {
    return { name: "telemetry", status: "unavailable", detail: "no QUESTDB_URL" };
  }
  try {
    await questQuery("SELECT 1"); // reachability probe
  } catch (err) {
    return { name: "telemetry", status: "unavailable", detail: summarize(err) };
  }
  // QuestDB is reachable — but the fire-and-forget batched writes may STILL be
  // dropping. Surface that, or "reachable" masks a write path that's silently
  // losing cost/latency rows.
  const w = getTelemetryWriteHealth();
  const dropped = w.droppedLines > 0;
  const dropDetail = dropped
    ? ` — DROPPED ${w.droppedLines} line(s) in ${w.failedBatches} batch(es)${w.lastError ? `: ${w.lastError}` : ""}`
    : "";
  const status: CheckStatus = dropped ? "degraded" : "ok";
  try {
    const rows = await questQuery("SELECT count() AS c FROM llm_usage");
    const n = Number(rows[0]?.["c"] ?? 0);
    return { name: "telemetry", status, detail: `llm_usage rows: ${n}${dropDetail}` };
  } catch {
    // Table not created yet (no turns since boot) — reachable, just empty.
    return { name: "telemetry", status, detail: `reachable (no telemetry written yet)${dropDetail}` };
  }
}

/**
 * Audit writes are serialized and fire-and-forget, so a failing append (disk
 * full, permission change) is otherwise silent — the same lost-write class as
 * telemetry above. Surface it so the audit trail can't degrade unnoticed.
 */
function checkAudit(): SubsystemCheck {
  const w = getAuditWriteStatus();
  if (w.failedWrites > 0) {
    return {
      name: "audit",
      status: "degraded",
      detail: `FAILED ${w.failedWrites} write(s)${w.lastWriteFailureAt ? ` (last ${w.lastWriteFailureAt})` : ""}, ${w.pendingWrites} pending`,
    };
  }
  return { name: "audit", status: "ok", detail: `${w.pendingWrites} pending` };
}

/**
 * browser-vnc is opt-in (no env, no probe). When configured but the websockify
 * port can't be reached, the noVNC dashboard panel hangs at "connecting" — same
 * silent-failure class as the embedding zero-vector bug, so it belongs here.
 */
async function checkBrowserVnc(): Promise<SubsystemCheck> {
  // Opt-in: when the operator explicitly disables the feature
  // (BROWSER_VNC_WS_URL=""), that's a correctly-configured state — report ok.
  if (!browserSessionManager.isEnabled()) {
    return { name: "browser_vnc", status: "ok", detail: "browser preview disabled by config" };
  }
  const ok = await browserSessionManager.pingBackend();
  return ok
    ? { name: "browser_vnc", status: "ok", detail: "websockify reachable" }
    : { name: "browser_vnc", status: "degraded", detail: "browser-vnc container unreachable on its websockify port" };
}

/**
 * engram RAG is an optional enhancement (maintainer-homelab-pinned by default, inert
 * on most installs). Probe it only when configured, and report a configured-but-
 * unreachable service as `degraded` rather than `unavailable` so a down RAG
 * sidecar never flips the whole gateway to 503.
 */
async function checkEngram(): Promise<SubsystemCheck> {
  if (!engramConfigured()) {
    return { name: "engram", status: "ok", detail: "not configured (RAG enhancement off)" };
  }
  try {
    const ok = await engramHealth();
    return ok
      ? { name: "engram", status: "ok", detail: "reachable" }
      : { name: "engram", status: "degraded", detail: "configured but health probe failed" };
  } catch (err) {
    return { name: "engram", status: "degraded", detail: summarize(err) };
  }
}

/**
 * The Laya decision sidecar, when configured. Optional like engram: every decision point falls back to its
 * incumbent without it, so an unreachable sidecar is `degraded`, never `unavailable`. A sidecar that fell back to
 * the CPU after a CUDA error answers ~10x slower and reports that in its own status.
 */
async function checkLaya(): Promise<SubsystemCheck> {
  if (!layaConfigured()) return { name: "laya", status: "ok", detail: "not configured (decision layer off)" };
  const health = await layaHealth();
  if (!health) return { name: "laya", status: "degraded", detail: "configured but unreachable — incumbents decide" };
  const models = (health["models"] ?? {}) as Record<string, { loaded?: boolean; device?: string | null; error?: string }>;
  const detail = Object.entries(models)
    .map(([name, model]) => `${name}: ${model.error ? "error" : model.loaded ? model.device ?? "loaded" : "loading"}`)
    .join(", ");
  return { name: "laya", status: health["status"] === "ok" || health["status"] === "loading" ? "ok" : "degraded", detail: detail || String(health["status"]) };
}

/**
 * Primary chat-model reachability. The #1 first-run confusion is a stack that
 * boots "healthy" while the model endpoint (a local LM Studio / Ollama the user
 * hasn't started yet) is unreachable — so every turn fails with an empty answer
 * and no explanation. Actively probe the OpenAI-compatible endpoint's /models so
 * the dashboard can surface "no model endpoint reachable — connect a provider".
 * Hosted providers (Anthropic) are not probed (reachability is a given; a bad key
 * surfaces on the first turn), so we never false-alarm on them.
 */
async function checkPrimaryModel(): Promise<SubsystemCheck> {
  try {
    const [{ resolveProviderEndpoint }, { getConfig }] = await Promise.all([
      import("../providers/index.js"),
      import("../config/loader.js"),
    ]);
    const cfg = getConfig();
    const endpoint = resolveProviderEndpoint(cfg.agents.defaults.model, cfg);
    if (endpoint.providerId === "anthropic") {
      return { name: "primary_model", status: "ok", detail: "hosted provider (Anthropic) — not actively probed" };
    }
    const baseUrl = endpoint.baseUrl?.replace(/\/$/, "");
    if (!baseUrl) {
      return { name: "primary_model", status: "unavailable", detail: "no model endpoint reachable — connect a provider" };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(`${baseUrl}/models`, {
        headers: endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {},
        signal: controller.signal,
      });
      // Any HTTP response means the endpoint is UP. 401/403 = up but the key is
      // rejected (degraded, not down). 404 (no /models route) still proves reach.
      if (res.status === 401 || res.status === 403) {
        return { name: "primary_model", status: "degraded", detail: `endpoint reachable but rejected the API key (${res.status})` };
      }
      return { name: "primary_model", status: "ok", detail: `${endpoint.model} endpoint reachable (${res.status})` };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return { name: "primary_model", status: "unavailable", detail: `no model endpoint reachable — connect a provider (${summarize(err)})` };
  }
}

// ── Sandbox canary ────────────────────────────────────────────────────────────
//
// From July until 9f7e61f the docker-socket proxy dropped the output of every attached `docker
// run`. shell_exec and run_script answered "(no output)" for every command, nothing checked the
// sandbox (this route had no check for it, and the E2E harness assumed it up), and the coder of
// session 3c0c5ce1 (2026-10-07) could not tell a dead channel from a silent script: it spent seven
// calls on it and then made its figures up. The canary runs a command through shell_exec's own
// docker run, socket proxy included, and requires what it printed on stdout and on stderr back.

/** How long one canary verdict serves. A run starts a container, and the dashboard polls this route every 30 s. */
export const SANDBOX_CANARY_TTL_MS = 5 * 60_000;

/** The session the canary's shell_exec call logs under. */
const SANDBOX_CANARY_SESSION = "health:sandbox-canary";

export interface SandboxCanaryProbe {
  /** The fixed shell command; it contains neither value below. */
  command: string;
  /** What the command prints on stdout. */
  stdout: string;
  /** What the command prints on stderr. */
  stderr: string;
}

/**
 * A fresh probe: one random value per stream. Each is printed from two halves, so the command line
 * never holds a value it must hand back: Node's "Command failed: docker run …" error repeats the
 * whole command line, and a command echoed back must not pass for its output.
 *
 * The two printfs are joined with &&, not ';'. shell_exec runs a command behind `mkdir -p
 * '/workspace' && cd '/workspace' &&`, and ';' binds looser than &&: when the sandbox could not use
 * its workdir, the stderr printf still ran and the run exited 0, so the canary reported lost stdout
 * and pointed at the docker-socket-proxy while every real command failed on that prefix.
 */
export function sandboxCanaryProbe(): SandboxCanaryProbe {
  const out = randomBytes(8).toString("hex");
  const err = randomBytes(8).toString("hex");
  return {
    command: `printf '%s-%s\\n' sai-canary-out ${out} && printf '%s-%s\\n' sai-canary-err ${err} >&2`,
    stdout: `sai-canary-out-${out}`,
    stderr: `sai-canary-err-${err}`,
  };
}

/**
 * Pure classifier for one canary run, from what shell_exec handed back (stdout and stderr joined).
 * ok takes a docker run that succeeded and both values back. A workdir the sandbox cannot use fails
 * the run in the shell's own words (the printfs follow shell_exec's prefix through &&). Both values
 * back mean every part of the command ran and the shell exited 0, so a failed run with both values
 * back lost the exit status on the way, and shell_exec would call every command failed: that is not
 * ok either. A run that succeeded without the values lost its output: degraded, naming the stream.
 *
 * Never `unavailable`, like engram and Laya above: a broken sandbox stops the tools that run code,
 * not the gateway, and a checkout with no Docker at all must not turn this route to 503.
 */
export function classifySandboxCanary(
  probe: SandboxCanaryProbe,
  result: { success: boolean; output?: string; error?: string },
  elapsedMs: number,
): SubsystemCheck {
  if (!result.success) {
    return { name: "sandbox", status: "degraded", detail: `docker run failed: ${describeSandboxFailure(result.error)}` };
  }
  const output = result.output ?? "";
  const stdoutBack = output.includes(probe.stdout);
  const stderrBack = output.includes(probe.stderr);
  if (stdoutBack && stderrBack) {
    return { name: "sandbox", status: "ok", detail: `a docker run through shell_exec handed back stdout and stderr (${elapsedMs} ms)` };
  }
  if (!stdoutBack && !stderrBack) {
    return {
      name: "sandbox",
      status: "degraded",
      detail: "output lost: docker run exited 0, but neither stdout nor stderr came back, so shell_exec and run_script answer \"(no output)\" to every command (check the docker-socket-proxy)",
    };
  }
  const lost = stdoutBack ? "stderr" : "stdout";
  return {
    name: "sandbox",
    status: "degraded",
    detail: `output lost: docker run exited 0, but its ${lost} never came back, so shell_exec and run_script miss what a command prints there (check the docker-socket-proxy)`,
  };
}

/** A failed canary run's error on one line, without the docker command line Node's message repeats. */
function describeSandboxFailure(error: string | undefined): string {
  const text = (error ?? "").replace(/Command failed: [^\n]*\n?/, "").replace(/:\s*$/, "").trim();
  return text ? summarize(text) : "no error message";
}

let sandboxCanary: { at: number; check: SubsystemCheck } | null = null;
let sandboxCanaryRun: Promise<SubsystemCheck> | null = null;

/** One canary run through the registered shell_exec handler. Never rejects: the route awaits it beside every other check. */
async function runSandboxCanary(shell: ToolHandler): Promise<SubsystemCheck> {
  try {
    const probe = sandboxCanaryProbe();
    const started = Date.now();
    const { getConfig } = await import("../config/loader.js");
    // The handler itself, not executeTool: an internal probe with a fixed command and no caller
    // input, so it never waits on the per-call approval shell_exec asks of a turn's calls.
    const result = await shell.execute({ command: probe.command }, { sessionId: SANDBOX_CANARY_SESSION, workspacePath: getConfig().workspacePath });
    return classifySandboxCanary(probe, result, Date.now() - started);
  } catch (err) {
    return { name: "sandbox", status: "degraded", detail: `the canary could not run: ${summarize(err)}` };
  }
}

/**
 * The sandbox canary as a subsystem check. A verdict serves SANDBOX_CANARY_TTL_MS, and callers that
 * arrive while a run is in flight share it. While a turn is running it starts no container: it
 * reports the last verdict with its age, or "not checked yet" before the first one.
 */
export async function checkSandbox(): Promise<SubsystemCheck> {
  let shell: ToolHandler | undefined;
  let turnsRunning: number;
  try {
    const [{ getTool }, { orchestratorTurnsRunning }] = await Promise.all([
      import("../tools/registry.js"),
      import("../agent/cache-warmer.js"),
    ]);
    shell = getTool("shell_exec");
    turnsRunning = orchestratorTurnsRunning();
  } catch (err) {
    return { name: "sandbox", status: "degraded", detail: `the canary could not load: ${summarize(err)}` };
  }
  // Nothing below awaits before a run is registered, so callers that arrive together share one run.
  if (!shell) return { name: "sandbox", status: "ok", detail: "not configured (shell_exec is disabled by config)" };
  const ageMs = sandboxCanary ? Date.now() - sandboxCanary.at : Infinity;
  if (sandboxCanary && ageMs < SANDBOX_CANARY_TTL_MS) return sandboxCanary.check;
  if (sandboxCanaryRun) return sandboxCanaryRun;
  if (turnsRunning > 0) {
    if (!sandboxCanary) {
      return { name: "sandbox", status: "ok", detail: "not checked yet: the canary starts no container while a turn is running" };
    }
    const last = sandboxCanary.check;
    return { ...last, detail: `${last.detail ?? ""} (measured ${Math.round(ageMs / 60_000)} min ago; not re-run while a turn is running)` };
  }
  const run = runSandboxCanary(shell).then((measured) => {
    const at = Date.now();
    const check = { ...measured, checkedAt: new Date(at).toISOString() };
    sandboxCanary = { at, check };
    sandboxCanaryRun = null;
    return check;
  });
  sandboxCanaryRun = run;
  return run;
}

/** Forget the last canary verdict and any run in flight (tests). */
export function resetSandboxCanaryForTests(): void {
  sandboxCanary = null;
  sandboxCanaryRun = null;
}

/** Run all subsystem probes in parallel and aggregate. */
export async function runSubsystemChecks(): Promise<SubsystemHealth> {
  const checks = await Promise.all([
    Promise.resolve(checkEventLoop()),
    Promise.resolve(checkProviderActivity()),
    checkPrimaryModel(),
    checkEmbeddings(),
    checkVectorStore(),
    checkGraph(),
    checkTelemetry(),
    Promise.resolve(checkAudit()),
    checkBrowserVnc(),
    checkEngram(),
    checkLaya(),
    checkSandbox(),
  ]);
  const healthy = checks.every((c) => c.status !== "unavailable");
  const degraded = checks.some((c) => c.status === "degraded");
  if (!healthy || degraded) {
    log.warn({ checks }, "Subsystem health check found impaired subsystems");
  }
  return { healthy, degraded, checks };
}

function summarize(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").slice(0, 120);
}
