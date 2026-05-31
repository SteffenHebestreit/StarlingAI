/**
 * Long-running-generation handoff — pause an agent that's productively
 * burning a lot of budget and ask the operator whether to keep going.
 *
 * Context: some legitimate tasks (deep research, generating a full
 * interactive learning website, large multi-file refactors) need many
 * minutes of inference and many thousands of completion tokens. The
 * default sub-agent timeout is set conservatively to catch runaway loops,
 * so productive long runs hit the wall and lose their work. Session
 * 00e55867 showed the failure live: content_writer had already produced
 * 21 KB of CSS + 21 KB of JS over 24 minutes and was working on the HTML
 * when the upstream model request timed out — the operator never had a
 * chance to extend the budget.
 *
 * The manager surfaces a `long_running_generation` request to the
 * dashboard's OperatorRequestsDock when a sub-agent crosses a soft
 * threshold (wall time OR accumulated completion tokens). The dashboard
 * shows the agent name, what it's been doing, current usage, and three
 * actions:
 *
 *   - `continue`  → +N minutes / +M tokens of budget for this run only.
 *   - `unbounded` → stop asking for this run; let it finish naturally.
 *   - `stop`      → synthesize from what's been collected and end.
 *
 * If the operator doesn't respond within DEFAULT_LRG_TIMEOUT_MS, the
 * default action fires (configurable per-call; defaults to `stop` so
 * idle runs don't burn forever).
 *
 * The whole thing is opt-in: the sub-agent only calls into the manager
 * when the soft threshold is crossed AND the agent hasn't already been
 * granted `unbounded` for this run.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { childLogger } from "../logger.js";
import { logAudit } from "../audit/logger.js";

const log = childLogger("agent:long-running");

/** Strip `sub:` nesting hops to the root (turn) session id. Mirrors
 *  deriveRootSessionId in sub-agent.ts so a stop is scoped to the whole turn. */
function rootOf(sessionId: string): string {
  let current = sessionId;
  while (current.startsWith("sub:")) {
    const inner = current.slice("sub:".length);
    const lastColon = inner.lastIndexOf(":");
    if (lastColon === -1) return inner;
    const secondLastColon = inner.lastIndexOf(":", lastColon - 1);
    if (secondLastColon === -1) return inner;
    current = inner.slice(0, secondLastColon);
  }
  return current;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type LongRunningRequestId = string;
export type LongRunningOutcome = "continue" | "unbounded" | "stop" | "timeout";
export type LongRunningState = "pending" | "resolved" | "stopped";

export interface LongRunningRequest {
  id: LongRunningRequestId;
  /** Sub-agent name (content_writer, researcher, …). */
  agentName: string;
  /** Parent (orchestrator) session id, so the dashboard can correlate. */
  parentSessionId?: string;
  /** The sub-agent's own session id. */
  runSessionId: string;
  /** Short human-readable summary the dashboard shows verbatim. */
  reason: string;
  state: LongRunningState;
  /** Wall time the run has burned so far, ms. */
  elapsedMs: number;
  /** Completion tokens the run has burned so far. */
  completionTokens: number;
  /** Iteration index when the request was raised. */
  iterations: number;
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number;
  resolvedOutcome?: LongRunningOutcome;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

/** Default soft thresholds; only one needs to cross to fire a request. */
export const DEFAULT_SOFT_THRESHOLD_MS = 3 * 60 * 1000;        // 3 minutes wall time
export const DEFAULT_SOFT_THRESHOLD_TOKENS = 8_000;             // accumulated completion tokens
/** Default wait for the operator to respond before falling back to the default
 *  outcome (`stop` for normal runs, `continue` for operator-pre-authorized ones).
 *  Kept short (1.5 min): a normal run that the operator ignores winds down fast
 *  and synthesizes from what it has, instead of sitting idle for minutes. Audit
 *  687a224b sat through repeated 5-min waits while a stuck run looped. */
const DEFAULT_LRG_TIMEOUT_MS = 90 * 1000;                       // 1.5 minutes
/** Default budget granted by a single `continue` response (per axis). */
export const DEFAULT_CONTINUE_GRANT_MS = 5 * 60 * 1000;         // +5 minutes
export const DEFAULT_CONTINUE_GRANT_TOKENS = 8_000;             // +8K completion tokens

// ── Events ────────────────────────────────────────────────────────────────────

export interface LongRunningEvents {
  "lrg:requested": (request: LongRunningRequest) => void;
  "lrg:resolved": (requestId: LongRunningRequestId, outcome: LongRunningOutcome, operator: string) => void;
}

// ── Manager ───────────────────────────────────────────────────────────────────

interface PendingRequest {
  resolve: (outcome: LongRunningOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  /** What the runtime falls back to if the operator never responds. */
  defaultOutcome: LongRunningOutcome;
}

class LongRunningGenerationManager extends EventEmitter {
  private _requests = new Map<LongRunningRequestId, LongRunningRequest>();
  private _pending = new Map<LongRunningRequestId, PendingRequest>();
  /** Run sessions that the operator has already granted `unbounded` to. */
  private _unboundedRuns = new Set<string>();
  /** Root (turn) sessions where the operator explicitly chose `stop`. Every
   *  subsequent long-running prompt in the SAME turn auto-stops instead of
   *  re-asking — otherwise a coordinator that re-delegates spawns fresh
   *  sub-agents that prompt the operator again (the ask→stop→ask loop).
   *  Cleared at the start of each turn via clearStopRequested(). */
  private _stopRequestedRoots = new Set<string>();

  /**
   * Ask the operator whether to keep going. Resolves when the operator
   * responds (`continue`, `unbounded`, `stop`) or when the wait times
   * out (falls back to `defaultOutcome`, default `stop`).
   *
   * Caller is the sub-agent loop, AFTER it has confirmed the run has
   * crossed a soft threshold AND has not previously been granted
   * `unbounded` for this run.
   */
  requestContinuation(opts: {
    agentName: string;
    runSessionId: string;
    parentSessionId?: string;
    reason: string;
    elapsedMs: number;
    completionTokens: number;
    iterations: number;
    /** Operator-response timeout. Defaults to 5 min. */
    waitTimeoutMs?: number;
    /** Fallback outcome when the operator never responds. Defaults to "stop". */
    defaultOutcome?: LongRunningOutcome;
  }): Promise<LongRunningOutcome> {
    // Short-circuit: once a run has been granted "unbounded", further
    // threshold crossings on the same run are no-ops.
    if (this._unboundedRuns.has(opts.runSessionId)) {
      return Promise.resolve("unbounded");
    }

    // Short-circuit: the operator already chose `stop` for this turn — auto-stop
    // every subsequent run in the same turn instead of re-prompting. This is what
    // ends the ask→stop→re-delegate→ask loop when a coordinator keeps spawning
    // fresh sub-agents after the operator has said to stop.
    const root = rootOf(opts.runSessionId);
    if (this._stopRequestedRoots.has(root)) {
      logAudit("long_running_generation_auto_stopped", {
        agentName: opts.agentName,
        runSessionId: opts.runSessionId,
        reason: "operator_stopped_turn",
      }, { sessionId: opts.parentSessionId, severity: "info" });
      return Promise.resolve("stop");
    }

    // Idempotent on (runSessionId): if a prior request is still pending
    // for this run, attach to the same wait instead of stacking N alerts.
    const existing = [...this._requests.values()].find(
      (r) => r.state === "pending" && r.runSessionId === opts.runSessionId,
    );
    if (existing) {
      const pending = this._pending.get(existing.id);
      if (pending) {
        return new Promise((resolve) => {
          const prior = pending.resolve;
          pending.resolve = (outcome) => { prior(outcome); resolve(outcome); };
        });
      }
    }

    const now = Date.now();
    const request: LongRunningRequest = {
      id: randomUUID(),
      agentName: opts.agentName,
      runSessionId: opts.runSessionId,
      ...(opts.parentSessionId ? { parentSessionId: opts.parentSessionId } : {}),
      reason: opts.reason,
      state: "pending",
      elapsedMs: opts.elapsedMs,
      completionTokens: opts.completionTokens,
      iterations: opts.iterations,
      createdAt: now,
      updatedAt: now,
    };
    this._requests.set(request.id, request);

    const defaultOutcome: LongRunningOutcome = opts.defaultOutcome ?? "stop";
    const waitTimeoutMs = opts.waitTimeoutMs ?? DEFAULT_LRG_TIMEOUT_MS;

    logAudit("long_running_generation_requested", {
      requestId: request.id,
      agentName: request.agentName,
      runSessionId: request.runSessionId,
      reason: request.reason,
      elapsedMs: request.elapsedMs,
      completionTokens: request.completionTokens,
      iterations: request.iterations,
      waitTimeoutMs,
      defaultOutcome,
    }, { sessionId: request.parentSessionId, severity: "warn" });
    log.warn({
      requestId: request.id,
      agentName: opts.agentName,
      runSessionId: opts.runSessionId,
      elapsedMs: opts.elapsedMs,
      completionTokens: opts.completionTokens,
    }, "Long-running generation requested operator decision");
    this.emit("lrg:requested", request);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const pending = this._pending.get(request.id);
        this._pending.delete(request.id);
        const r = this._requests.get(request.id);
        if (r && r.state === "pending") {
          r.state = "resolved";
          r.resolvedAt = Date.now();
          r.resolvedOutcome = defaultOutcome;
          r.updatedAt = r.resolvedAt;
        }
        logAudit("long_running_generation_timeout", {
          requestId: request.id,
          agentName: opts.agentName,
          runSessionId: opts.runSessionId,
          appliedOutcome: defaultOutcome,
        }, { sessionId: opts.parentSessionId, severity: "warn" });
        log.warn({ requestId: request.id, appliedOutcome: defaultOutcome }, "Long-running generation request timed out — applying defaultOutcome");
        // The audit row still uses long_running_generation_timeout so the
        // dashboard shows the operator didn't respond in time, but the
        // caller receives defaultOutcome ("continue" when the operator
        // pre-authorized an unbounded run, "stop" otherwise).
        if (pending) pending.resolve(defaultOutcome);
        else resolve(defaultOutcome);
      }, waitTimeoutMs);
      timer.unref?.();
      this._pending.set(request.id, { resolve, timer, defaultOutcome });
    });
  }

  /**
   * Operator picked an action in the dashboard. Returns the request that
   * was resolved so the caller can audit it, or null when the id is stale.
   */
  resolveRequest(
    requestId: LongRunningRequestId,
    outcome: "continue" | "unbounded" | "stop",
    operator = "operator",
  ): LongRunningRequest | null {
    const request = this._requests.get(requestId);
    if (!request || request.state !== "pending") return null;
    const pending = this._pending.get(requestId);

    request.state = "resolved";
    request.resolvedAt = Date.now();
    request.resolvedOutcome = outcome;
    request.updatedAt = request.resolvedAt;

    if (outcome === "unbounded") {
      this._unboundedRuns.add(request.runSessionId);
    }

    // An explicit `stop` means the operator wants this turn to wind down — mark
    // the turn so further sub-agents auto-stop, and resolve any sibling prompts
    // already pending in the same turn so the operator isn't asked again.
    if (outcome === "stop") {
      const root = rootOf(request.runSessionId);
      this._stopRequestedRoots.add(root);
      for (const sibling of [...this._requests.values()]) {
        if (sibling.id === requestId || sibling.state !== "pending") continue;
        if (rootOf(sibling.runSessionId) !== root) continue;
        const sp = this._pending.get(sibling.id);
        sibling.state = "resolved";
        sibling.resolvedAt = Date.now();
        sibling.resolvedOutcome = "stop";
        sibling.updatedAt = sibling.resolvedAt;
        if (sp) {
          clearTimeout(sp.timer);
          this._pending.delete(sibling.id);
          sp.resolve("stop");
        }
      }
    }

    logAudit("long_running_generation_resolved", {
      requestId,
      agentName: request.agentName,
      runSessionId: request.runSessionId,
      outcome,
      operator,
      waitedMs: request.resolvedAt - request.createdAt,
    }, { sessionId: request.parentSessionId, severity: "info" });
    log.info({ requestId, outcome, operator }, "Long-running generation request resolved");
    this.emit("lrg:resolved", requestId, outcome, operator);

    if (pending) {
      clearTimeout(pending.timer);
      this._pending.delete(requestId);
      pending.resolve(outcome);
    }
    return request;
  }

  /** Stop awaiting any pending request for a given run (called when the run ends). */
  stop(runSessionId: string, reason = "run_ended"): void {
    for (const request of [...this._requests.values()]) {
      if (request.runSessionId !== runSessionId || request.state !== "pending") continue;
      const pending = this._pending.get(request.id);
      request.state = "stopped";
      request.updatedAt = Date.now();
      logAudit("long_running_generation_stopped", {
        requestId: request.id,
        agentName: request.agentName,
        runSessionId,
        reason,
      }, { sessionId: request.parentSessionId, severity: "info" });
      if (pending) {
        clearTimeout(pending.timer);
        this._pending.delete(request.id);
        pending.resolve(pending.defaultOutcome);
      }
    }
  }

  /** Has this run been granted unbounded budget? Cheap; suitable for the
   *  per-iteration check in the sub-agent loop before deciding to ask. */
  isUnbounded(runSessionId: string): boolean {
    return this._unboundedRuns.has(runSessionId);
  }

  /** Clear the per-turn `stop` latch for a root session. Called at the start of
   *  each orchestrator turn so an operator stop in one turn never auto-stops the
   *  next. */
  clearStopRequested(rootSessionId: string): void {
    this._stopRequestedRoots.delete(rootSessionId);
  }

  /** Has the operator chosen `stop` for this turn already? */
  isStopRequested(runSessionId: string): boolean {
    return this._stopRequestedRoots.has(rootOf(runSessionId));
  }

  getRequest(requestId: LongRunningRequestId): LongRunningRequest | undefined {
    return this._requests.get(requestId);
  }

  /** Pending requests, newest first. The dashboard polls this. */
  listPending(): LongRunningRequest[] {
    return [...this._requests.values()]
      .filter((r) => r.state === "pending")
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Reset for tests. */
  resetForTests(): void {
    for (const p of this._pending.values()) clearTimeout(p.timer);
    this._pending.clear();
    this._requests.clear();
    this._unboundedRuns.clear();
    this._stopRequestedRoots.clear();
    this.removeAllListeners();
  }
}

// Singleton
export const longRunningGenerationManager = new LongRunningGenerationManager();
