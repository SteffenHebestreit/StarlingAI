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
import { childLogger } from "../logger.js";
import { getEventLoopLagSnapshot, DEFAULT_WARN_MS, DEFAULT_SEVERE_MS, type EventLoopLagSnapshot } from "./event-loop-monitor.js";
import { getProviderActivitySnapshot, type ProviderActivitySnapshot } from "./provider-activity-monitor.js";
import { isEmbeddingAvailable, computeQueryEmbedding } from "../providers/embeddings.js";
import { initVectorStore, vectorStoreDimension } from "../db/vector-store.js";
import { isGraphDbAvailable, runCypher, toPlainRecords } from "../db/neo4j.js";
import { isQuestDbAvailable, questQuery } from "../db/questdb.js";
import { browserSessionManager } from "../agent/browser-session.js";

const log = childLogger("health-checks");

export type CheckStatus = "ok" | "degraded" | "unavailable";

export interface SubsystemCheck {
  name: string;
  status: CheckStatus;
  detail?: string;
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
  try {
    const rows = await questQuery("SELECT count() AS c FROM llm_usage");
    const n = Number(rows[0]?.["c"] ?? 0);
    return { name: "telemetry", status: "ok", detail: `llm_usage rows: ${n}` };
  } catch {
    // Table not created yet (no turns since boot) — reachable, just empty.
    return { name: "telemetry", status: "ok", detail: "reachable (no telemetry written yet)" };
  }
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

/** Run all subsystem probes in parallel and aggregate. */
export async function runSubsystemChecks(): Promise<SubsystemHealth> {
  const checks = await Promise.all([
    Promise.resolve(checkEventLoop()),
    Promise.resolve(checkProviderActivity()),
    checkEmbeddings(),
    checkVectorStore(),
    checkGraph(),
    checkTelemetry(),
    checkBrowserVnc(),
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
