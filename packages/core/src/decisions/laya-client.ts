/**
 * The client of the Laya sidecar's generic decision endpoint (docker/laya):
 *
 *   POST {baseUrl}/v1/decide
 *   { "questions": [{ "id", "question", "options": { key: description }, "state": { ... } }] }
 *   → { "answers": { id: { "choice": key, "probabilities": { key: p } } }, "model": "...", "ms": 12 }
 *
 * Never throws: every failure is `null`, and the caller's incumbent decides. A sidecar that is down
 * would otherwise cost every decision its full timeout, so after a run of failures it is not asked
 * for a cooldown; the first answer after that closes the breaker again.
 */
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";
import type { DecisionPointDefinition } from "./points.js";

const log = childLogger("decisions:laya");

const FAILURE_THRESHOLD = 3;
const COOLDOWN_MS = 60_000;
let consecutiveFailures = 0;
let circuitOpenUntil = 0;

export interface LayaAnswer {
  /** The option Laya scored highest. */
  choice: string;
  /** Laya's probability for each option. */
  probabilities: Record<string, number>;
  /** The probability of `choice`. */
  top: number;
  /** Round trip, as measured here. */
  ms: number;
}

/** Is a sidecar configured at all? Without one, no point asks Laya whatever its mode. */
export function layaConfigured(): boolean {
  return Boolean(getConfig().decisions?.baseUrl?.trim());
}

function endpoint(path: string): string {
  return `${getConfig().decisions.baseUrl.trim().replace(/\/+$/, "")}${path}`;
}

function recordSuccess(): void {
  consecutiveFailures = 0;
  circuitOpenUntil = 0;
}

function recordFailure(now: number, reason: string): void {
  consecutiveFailures += 1;
  if (consecutiveFailures >= FAILURE_THRESHOLD && circuitOpenUntil <= now) {
    circuitOpenUntil = now + COOLDOWN_MS;
    log.warn({ failures: consecutiveFailures, cooldownMs: COOLDOWN_MS, reason }, "Laya circuit opened — incumbents decide until the cooldown ends");
  }
}

/** The answer for one question, checked against the options it was offered. */
function readAnswer(raw: unknown, options: Readonly<Record<string, string>>, ms: number): LayaAnswer | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const choice = typeof record["choice"] === "string" ? record["choice"] : undefined;
  const probabilitiesRaw = record["probabilities"];
  if (!choice || !(choice in options) || !probabilitiesRaw || typeof probabilitiesRaw !== "object") return null;
  const probabilities: Record<string, number> = {};
  for (const key of Object.keys(options)) {
    const value = (probabilitiesRaw as Record<string, unknown>)[key];
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    probabilities[key] = value;
  }
  const top = probabilities[choice]!;
  // The choice must be the argmax of what it sent: anything else is a contract break, not an answer.
  if (Object.values(probabilities).some((p) => p > top + 1e-9)) return null;
  return { choice, probabilities, top, ms };
}

/**
 * Ask Laya one decision point's question about one case. `null` when no sidecar is configured,
 * the breaker is open, the request fails or times out, or the answer does not fit the options.
 */
export async function askLaya(
  point: DecisionPointDefinition,
  state: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<LayaAnswer | null> {
  if (!layaConfigured()) return null;
  const now = Date.now();
  if (circuitOpenUntil > now) return null;
  const timeoutMs = getConfig().decisions.timeoutMs;
  const started = Date.now();
  try {
    const response = await fetch(endpoint("/v1/decide"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questions: [{ id: point.id, question: point.question, options: point.options, state }] }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      recordFailure(Date.now(), `HTTP ${response.status}`);
      return null;
    }
    const body = await response.json() as { answers?: Record<string, unknown> };
    const answer = readAnswer(body.answers?.[point.id], point.options, Date.now() - started);
    if (!answer) {
      recordFailure(Date.now(), "answer does not fit the options");
      return null;
    }
    recordSuccess();
    return answer;
  } catch (err) {
    // The caller's own abort is not the sidecar's failure.
    if (!signal?.aborted) recordFailure(Date.now(), err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** The sidecar's own health report, bypassing the breaker; null when it cannot be reached. */
export async function layaHealth(timeoutMs = 3_000): Promise<Record<string, unknown> | null> {
  if (!layaConfigured()) return null;
  try {
    const response = await fetch(endpoint("/health"), { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    return await response.json() as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Test-only: close the breaker. */
export function resetLayaClientForTests(): void {
  consecutiveFailures = 0;
  circuitOpenUntil = 0;
}
