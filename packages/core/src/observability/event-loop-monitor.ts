/**
 * Event-loop lag monitor — turns "the gateway went unhealthy" into a measured
 * signal.
 *
 * The gateway is a single Node event loop. Awaiting an LLM/tool HTTP response is
 * async I/O and does NOT block that loop — other sessions, jobs, and scenes keep
 * running while one agent waits. So when the cheap `/healthz` probe flaps or the
 * web client's heartbeat times out *during a long local-model call* (e.g. a slow
 * Strix Halo generation), the question is: did the loop actually stall, or is the
 * unhealthiness coming from somewhere else (a provider-bound health probe, a
 * connection pool)?
 *
 * This monitor answers that. It uses libuv's own `monitorEventLoopDelay`
 * histogram (negligible overhead — a C-level timer) to record how long the loop
 * was blocked between ticks, samples it on an interval, and:
 *   - keeps the latest snapshot for the health endpoints / dashboard, and
 *   - emits an `event_loop_lag` audit row (warn) whenever a sampling window
 *     contains a stall past the warn threshold, so it can be correlated by
 *     timestamp with the long-running LLM/tool audit events.
 *
 * If lag stays low while the gateway looks unhealthy, the cause is NOT the event
 * loop (look at the provider / health probe). If lag spikes, there is a
 * synchronous hotspot on the main thread (large JSON.parse of a response, a
 * heavy regex/guardrail pass, sync compression, etc.) — the real case for
 * offloading that specific step to a worker pool.
 */
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";

const log = childLogger("observability:event-loop");

/** Sampling window — how often the histogram is read and reset. */
export const DEFAULT_SAMPLE_MS = 5_000;
/** A window whose worst stall reaches this is logged/audited as elevated lag. */
export const DEFAULT_WARN_MS = 250;
/** A stall this long means the loop was frozen long enough to flap health/heartbeats. */
export const DEFAULT_SEVERE_MS = 2_000;

export interface EventLoopLagSnapshot {
  /** ISO timestamp of when this window was sampled. */
  sampledAt: string;
  /** Length of the sampling window in ms. */
  windowMs: number;
  /** Mean loop delay across the window, ms. */
  meanMs: number;
  /** Worst single stall in the window, ms — the number that matters for "did it freeze". */
  maxMs: number;
  /** 99th-percentile loop delay across the window, ms. */
  p99Ms: number;
  /** Worst stall observed since the monitor started, ms. */
  peakMs: number;
}

interface MonitorState {
  histogram: IntervalHistogram;
  timer: ReturnType<typeof setInterval>;
  windowMs: number;
  warnMs: number;
  severeMs: number;
  peakMs: number;
}

let state: MonitorState | null = null;
let lastSnapshot: EventLoopLagSnapshot | null = null;

function resolveEnvMs(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** Round nanoseconds to milliseconds with one decimal. */
function nsToMs(ns: number): number {
  if (!Number.isFinite(ns) || ns <= 0) return 0;
  return Math.round(ns / 1e5) / 10;
}

/**
 * Read + reset the histogram for the elapsed window, refresh the snapshot, and
 * audit when the worst stall crosses the warn threshold. Exposed for tests so a
 * window can be sampled deterministically without waiting on the timer.
 */
export function sampleEventLoopLag(): EventLoopLagSnapshot | null {
  if (!state) return null;
  const { histogram } = state;
  const meanMs = nsToMs(histogram.mean);
  const maxMs = nsToMs(histogram.max);
  const p99Ms = nsToMs(histogram.percentile(99));
  histogram.reset();

  state.peakMs = Math.max(state.peakMs, maxMs);
  const snapshot: EventLoopLagSnapshot = {
    sampledAt: new Date().toISOString(),
    windowMs: state.windowMs,
    meanMs,
    maxMs,
    p99Ms,
    peakMs: state.peakMs,
  };
  lastSnapshot = snapshot;

  if (maxMs >= state.warnMs) {
    const severe = maxMs >= state.severeMs;
    logAudit("event_loop_lag", {
      maxMs,
      meanMs,
      p99Ms,
      windowMs: state.windowMs,
      warnMs: state.warnMs,
      severe,
    }, { severity: severe ? "error" : "warn" });
    log.warn(
      { maxMs, meanMs, p99Ms, windowMs: state.windowMs, severe },
      severe
        ? "Event loop was BLOCKED long enough to flap health/heartbeats — a synchronous main-thread hotspot, not I/O wait"
        : "Elevated event-loop lag detected",
    );
  }

  return snapshot;
}

/**
 * Start sampling event-loop delay. Idempotent. Thresholds and window are tunable
 * per host (a Strix Halo box may want a higher warn floor than a server) via
 * SAI_EVENT_LOOP_SAMPLE_MS / SAI_EVENT_LOOP_LAG_WARN_MS / SAI_EVENT_LOOP_LAG_SEVERE_MS.
 */
export function startEventLoopMonitor(opts?: { windowMs?: number; warnMs?: number; severeMs?: number }): void {
  if (state) return;
  const windowMs = opts?.windowMs ?? resolveEnvMs("SAI_EVENT_LOOP_SAMPLE_MS", DEFAULT_SAMPLE_MS);
  const warnMs = opts?.warnMs ?? resolveEnvMs("SAI_EVENT_LOOP_LAG_WARN_MS", DEFAULT_WARN_MS);
  const severeMs = opts?.severeMs ?? resolveEnvMs("SAI_EVENT_LOOP_LAG_SEVERE_MS", DEFAULT_SEVERE_MS);

  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const timer = setInterval(() => {
    try { sampleEventLoopLag(); } catch (err) { log.debug({ err }, "event-loop sample failed"); }
  }, windowMs);
  timer.unref?.();

  state = { histogram, timer, windowMs, warnMs, severeMs, peakMs: 0 };
  log.info({ windowMs, warnMs, severeMs }, "Event-loop lag monitor started");
}

export function stopEventLoopMonitor(): void {
  if (!state) return;
  clearInterval(state.timer);
  state.histogram.disable();
  state = null;
}

/** Latest sampled snapshot, or null when the monitor has not produced one yet. */
export function getEventLoopLagSnapshot(): EventLoopLagSnapshot | null {
  return lastSnapshot;
}

/** Reset module state for tests. */
export function resetEventLoopMonitorForTests(): void {
  stopEventLoopMonitor();
  lastSnapshot = null;
}
