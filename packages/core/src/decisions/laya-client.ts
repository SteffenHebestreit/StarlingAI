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

/** laya-browser's next step for one page (`POST /v1/browser/step`, docker/laya/app/browser.py). */
export interface LayaBrowserStep {
  /** CLICK, TYPE_TEXT, SELECT, one of the page's controls (SCROLL_DOWN, SCROLL_UP, PRESS_ENTER, WAIT), DONE or BLOCKED. */
  operation: string;
  operationProbability: number;
  operationProbabilities: Record<string, number>;
  /** For CLICK, TYPE_TEXT and SELECT: the element, named by the observation's own action id and node. */
  target: {
    index: string;
    actionId: string;
    node: number | null;
    kind: string;
    label: string;
    role: string | null;
    value?: string;
    probability: number;
    alternatives: Array<{ index: string; actionId: string; node: number | null; label: string; probability: number }>;
  } | null;
  /** For a control: the control. */
  control: { actionId: string; kind: string; label: string; delta?: number; key?: string } | null;
  /** Round trip, as measured here. */
  ms: number;
}

function finiteProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 + 1e-9;
}

/** The step as the sidecar sent it, checked; null for anything that does not fit the contract. */
function readBrowserStep(raw: unknown, ms: number): LayaBrowserStep | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  const operation = body["operation"];
  const probabilities = body["operationProbabilities"];
  if (typeof operation !== "string" || !finiteProbability(body["operationProbability"])) return null;
  if (!probabilities || typeof probabilities !== "object") return null;
  const operationProbabilities: Record<string, number> = {};
  for (const [key, value] of Object.entries(probabilities as Record<string, unknown>)) {
    if (!finiteProbability(value)) return null;
    operationProbabilities[key] = value;
  }
  if (operationProbabilities[operation] === undefined) return null;
  const target = body["target"];
  const control = body["control"];
  if (target !== null && target !== undefined) {
    const t = target as Record<string, unknown>;
    if (typeof t["actionId"] !== "string" || !finiteProbability(t["probability"]) || typeof t["label"] !== "string") return null;
    if (t["node"] !== null && t["node"] !== undefined && typeof t["node"] !== "number") return null;
  }
  if (control !== null && control !== undefined && typeof (control as Record<string, unknown>)["actionId"] !== "string") return null;
  return {
    operation,
    operationProbability: body["operationProbability"] as number,
    operationProbabilities,
    target: target ? {
      ...(target as NonNullable<LayaBrowserStep["target"]>),
      node: typeof (target as Record<string, unknown>)["node"] === "number" ? (target as { node: number }).node : null,
      alternatives: Array.isArray((target as Record<string, unknown>)["alternatives"])
        ? (target as { alternatives: NonNullable<LayaBrowserStep["target"]>["alternatives"] }).alternatives
        : [],
    } : null,
    control: control ? (control as NonNullable<LayaBrowserStep["control"]>) : null,
    ms,
  };
}

/**
 * Ask laya-browser for the next step on one observed page. `null` when no sidecar is configured,
 * the breaker is open, the request fails or times out (`decisions.browser.timeoutMs`), or the
 * answer does not fit the contract. Shares the breaker with `askLaya`: it is one sidecar.
 */
export async function askLayaBrowser(
  body: { goal: string; observation: Record<string, unknown>; history: unknown[]; excluded?: string[] },
  signal?: AbortSignal,
): Promise<LayaBrowserStep | null> {
  if (!layaConfigured()) return null;
  const now = Date.now();
  if (circuitOpenUntil > now) return null;
  const timeoutMs = getConfig().decisions.browser?.timeoutMs ?? 5_000;
  const started = Date.now();
  try {
    const response = await fetch(endpoint("/v1/browser/step"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      recordFailure(Date.now(), `browser step HTTP ${response.status}`);
      return null;
    }
    const step = readBrowserStep(await response.json(), Date.now() - started);
    if (!step) {
      recordFailure(Date.now(), "browser step does not fit the contract");
      return null;
    }
    recordSuccess();
    return step;
  } catch (err) {
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
