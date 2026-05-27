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
