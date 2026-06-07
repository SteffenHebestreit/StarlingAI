/**
 * Provider activity monitor — in-flight visibility into the remote LLM.
 *
 * The provider (LM Studio / Ollama / vLLM on a separate box — e.g. a Strix
 * Halo) is reached over HTTP, so a long turn is a long HTTP wait, not a blocked
 * gateway loop. The per-provider stats in lmstudio.ts only record latency AFTER
 * a call finishes, so while a 12-minute research call is in flight there is no
 * signal at all about whether the model is:
 *   - producing tokens (decoding — healthy, just slow),
 *   - still processing the prompt (prefill — no output yet, can be many seconds
 *     for a 20K-token prompt on a slow APU), or
 *   - stalled (the remote stopped sending and is effectively hung).
 *
 * This monitor tracks each in-flight call and, for streaming calls, the token
 * progress (time-to-first-token + inter-token silence) so those three states
 * can be told apart live. It feeds `/readyz`, the subsystem health check, and a
 * `provider_stall` audit row when a call goes silent past the threshold.
 *
 * NOTE: a non-streaming `complete()` call has no token granularity — the monitor
 * can only report how long it has been awaiting a response. The research
 * sub-agents use `complete()`, so true producing-vs-prefill detection on that
 * path requires switching it to the streaming accumulator (tracked separately).
 */
import { randomUUID } from "node:crypto";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";

const log = childLogger("observability:provider");

export const DEFAULT_PROVIDER_SAMPLE_MS = 5_000;
/** No first token after this long ⇒ the model is deep in prompt processing or stuck. */
export const DEFAULT_PROVIDER_PREFILL_WARN_MS = 60_000;
/** A streaming call that produced tokens then went silent this long ⇒ stalled. */
export const DEFAULT_PROVIDER_STALL_MS = 45_000;
/** A non-streaming complete() open this long ⇒ flag it (no token granularity to say more). */
export const DEFAULT_PROVIDER_AWAIT_WARN_MS = 90_000;

export type ProviderCallMode = "complete" | "stream";

/**
 * Live classification of an in-flight call:
 * - `producing`       streaming and a token arrived recently — healthy, just slow.
 * - `prefill`         streaming, no first token yet, within the prefill grace.
 * - `awaiting_output` no token for a worrying while (streaming: past prefill grace;
 *                     complete: open past the await warn) — chewing the prompt or stuck.
 * - `stalled`         streaming, produced tokens then went silent past the stall window.
 * - `awaiting`        complete() in flight, still within budget (no token granularity).
 */
export type ProviderCallState = "producing" | "prefill" | "awaiting_output" | "stalled" | "awaiting";

interface InFlightCall {
  id: string;
  model: string;
  mode: ProviderCallMode;
  startedAt: number;
  firstTokenAt?: number;
  lastTokenAt?: number;
  chunkCount: number;
  lastAuditedState?: ProviderCallState;
}

export interface ProviderCallSnapshot {
  id: string;
  model: string;
  mode: ProviderCallMode;
  elapsedMs: number;
  /** Time-to-first-token, ms (streaming only, once a token has arrived). */
  ttftMs?: number;
  /** Silence since the last token, ms (streaming only, once a token has arrived). */
  silentMs?: number;
  chunkCount: number;
  state: ProviderCallState;
}

export interface ProviderActivitySnapshot {
  sampledAt: string;
  inFlight: number;
  /** The call most worth attention (stalled/awaiting first, else longest-running). */
  worst: ProviderCallSnapshot | null;
}

interface Thresholds {
  prefillWarnMs: number;
  stallMs: number;
  awaitWarnMs: number;
}

function resolveEnvMs(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function thresholds(): Thresholds {
  return {
    prefillWarnMs: resolveEnvMs("SAI_PROVIDER_PREFILL_WARN_MS", DEFAULT_PROVIDER_PREFILL_WARN_MS),
    stallMs: resolveEnvMs("SAI_PROVIDER_STALL_MS", DEFAULT_PROVIDER_STALL_MS),
    awaitWarnMs: resolveEnvMs("SAI_PROVIDER_AWAIT_WARN_MS", DEFAULT_PROVIDER_AWAIT_WARN_MS),
  };
}

const _inFlight = new Map<string, InFlightCall>();
let _timer: ReturnType<typeof setInterval> | null = null;
let _lastSnapshot: ProviderActivitySnapshot | null = null;

/**
 * Pure classifier for one in-flight call. Exposed for tests so every state can
 * be exercised without real timing.
 */
export function classifyProviderCall(call: InFlightCall, now: number, t: Thresholds = thresholds()): ProviderCallState {
  const elapsed = now - call.startedAt;
  if (call.mode === "stream") {
    if (call.firstTokenAt === undefined) {
      return elapsed >= t.prefillWarnMs ? "awaiting_output" : "prefill";
    }
    const silent = now - (call.lastTokenAt ?? call.firstTokenAt);
    return silent >= t.stallMs ? "stalled" : "producing";
  }
  // complete(): no token granularity — only total duration.
  return elapsed >= t.awaitWarnMs ? "awaiting_output" : "awaiting";
}

function snapshotOf(call: InFlightCall, now: number, t: Thresholds): ProviderCallSnapshot {
  return {
    id: call.id,
    model: call.model,
    mode: call.mode,
    elapsedMs: now - call.startedAt,
    ...(call.firstTokenAt !== undefined ? { ttftMs: call.firstTokenAt - call.startedAt } : {}),
    ...(call.firstTokenAt !== undefined ? { silentMs: now - (call.lastTokenAt ?? call.firstTokenAt) } : {}),
    chunkCount: call.chunkCount,
    state: classifyProviderCall(call, now, t),
  };
}

const ATTENTION_RANK: Record<ProviderCallState, number> = {
  stalled: 4,
  awaiting_output: 3,
  awaiting: 1,
  prefill: 1,
  producing: 0,
};

/** Begin tracking an in-flight provider call. Returns the id to pass back to record/end. */
export function beginProviderCall(meta: { model: string; mode: ProviderCallMode }): string {
  const id = randomUUID();
  _inFlight.set(id, { id, model: meta.model, mode: meta.mode, startedAt: Date.now(), chunkCount: 0 });
  return id;
}

/** Record that the remote produced output (a streamed token/chunk). No-op for unknown ids. */
export function recordProviderToken(id: string): void {
  const call = _inFlight.get(id);
  if (!call) return;
  const now = Date.now();
  if (call.firstTokenAt === undefined) call.firstTokenAt = now;
  call.lastTokenAt = now;
  call.chunkCount += 1;
}

/** Stop tracking an in-flight call (success, error, or abort). */
export function endProviderCall(id: string): void {
  _inFlight.delete(id);
}

/** Read all in-flight calls now (does not depend on the sampler having run). */
export function getProviderActivitySnapshot(): ProviderActivitySnapshot {
  const now = Date.now();
  const t = thresholds();
  let worst: ProviderCallSnapshot | null = null;
  for (const call of _inFlight.values()) {
    const snap = snapshotOf(call, now, t);
    if (
      !worst
      || ATTENTION_RANK[snap.state] > ATTENTION_RANK[worst.state]
      || (ATTENTION_RANK[snap.state] === ATTENTION_RANK[worst.state] && snap.elapsedMs > worst.elapsedMs)
    ) {
      worst = snap;
    }
  }
  const snapshot: ProviderActivitySnapshot = {
    sampledAt: new Date(now).toISOString(),
    inFlight: _inFlight.size,
    worst,
  };
  _lastSnapshot = snapshot;
  return snapshot;
}

/** Last snapshot produced by the sampler or a getProviderActivitySnapshot() call. */
export function getLastProviderActivitySnapshot(): ProviderActivitySnapshot | null {
  return _lastSnapshot;
}

function sample(): void {
  const now = Date.now();
  const t = thresholds();
  for (const call of _inFlight.values()) {
    const state = classifyProviderCall(call, now, t);
    // Audit only on a transition INTO a concerning state, so a long call logs
    // once when it goes silent rather than every sampling tick.
    if ((state === "stalled" || state === "awaiting_output") && call.lastAuditedState !== state) {
      const elapsedMs = now - call.startedAt;
      logAudit("provider_stall", {
        model: call.model,
        mode: call.mode,
        state,
        elapsedMs,
        ...(call.firstTokenAt !== undefined ? { ttftMs: call.firstTokenAt - call.startedAt } : {}),
        ...(call.firstTokenAt !== undefined ? { silentMs: now - (call.lastTokenAt ?? call.firstTokenAt) } : {}),
        chunkCount: call.chunkCount,
      }, { severity: "warn" });
      log.warn(
        { model: call.model, mode: call.mode, state, elapsedMs, chunkCount: call.chunkCount },
        call.mode === "stream"
          ? (state === "stalled"
            ? "Remote LLM produced tokens then went silent — stream stalled"
            : "Remote LLM has produced no tokens yet — still processing the prompt or stuck")
          : "Non-streaming LLM call has been awaiting a response for a long time",
      );
    }
    call.lastAuditedState = state;
  }
  getProviderActivitySnapshot();
}

export function startProviderActivityMonitor(opts?: { sampleMs?: number }): void {
  if (_timer) return;
  const sampleMs = opts?.sampleMs ?? resolveEnvMs("SAI_PROVIDER_SAMPLE_MS", DEFAULT_PROVIDER_SAMPLE_MS);
  _timer = setInterval(() => {
    try { sample(); } catch (err) { log.debug({ err }, "provider activity sample failed"); }
  }, sampleMs);
  _timer.unref?.();
  log.info({ sampleMs }, "Provider activity monitor started");
}

export function stopProviderActivityMonitor(): void {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

/** Reset module state for tests. */
export function resetProviderActivityMonitorForTests(): void {
  stopProviderActivityMonitor();
  _inFlight.clear();
  _lastSnapshot = null;
}
