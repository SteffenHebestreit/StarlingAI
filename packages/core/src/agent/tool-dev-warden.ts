/**
 * Tool Development Warden — specialized oversight for dev sessions.
 *
 * Monitors active tool development sessions for:
 *   - Idle timeout (no activity for maxIdleMs)
 *   - Iteration velocity (warn and escalate, but do not hard-stop on count alone)
 *   - Container storm (>20 spawns)
 *   - Identical failure loops (same error 5+ times)
 *   - Lease/heartbeat liveness
 *
 * Uses convergence-based completion criteria instead of hard iteration caps.
 * When a session is stuck, it marks it blocked and requires operator intervention
 * rather than silently killing it.
 *
 * Integrates with the main Warden via shared anomaly types and audit events.
 */
import { childLogger } from "../logger.js";
import { logAudit } from "../audit/logger.js";
import { getConfig } from "../config/loader.js";
import {
  getAllActiveSessions,
  getToolDevSession,
  markStuck,
  terminateSession,
  type ToolDevSession,
} from "./tool-dev-session.js";

const log = childLogger("tool-dev-warden");

// ── Thresholds ──────────────────────────────────────────────────────────────

const WARN_ITERATION_THRESHOLDS = [50, 100, 200] as const;
const MAX_CONTAINER_SPAWNS = 20;
const IDENTICAL_FAILURE_THRESHOLD = 5;

// ── State ───────────────────────────────────────────────────────────────────

let _sweepInterval: ReturnType<typeof setInterval> | null = null;
const SWEEP_INTERVAL_MS = 15_000; // 15 seconds — more frequent than main warden

// Track warnings to avoid spamming (one warning per threshold per session)
const _warned = new Map<string, Set<string>>();

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Start the tool-dev warden sweep loop.
 */
export function startToolDevWarden(): void {
  if (_sweepInterval) return;

  _sweepInterval = setInterval(() => {
    try {
      sweepActiveSessions();
    } catch (err) {
      log.error({ err }, "Tool-dev warden sweep failed");
    }
  }, SWEEP_INTERVAL_MS);

  // Don't prevent process exit
  if (_sweepInterval && typeof _sweepInterval === "object" && "unref" in _sweepInterval) {
    (_sweepInterval as NodeJS.Timeout).unref();
  }

  log.info({ intervalMs: SWEEP_INTERVAL_MS }, "Tool-dev warden started");
}

/**
 * Stop the tool-dev warden.
 */
export function stopToolDevWarden(): void {
  if (_sweepInterval) {
    clearInterval(_sweepInterval);
    _sweepInterval = null;
  }
  _warned.clear();
  log.info("Tool-dev warden stopped");
}

/**
 * Check a specific session (called from swarm event handler).
 */
export function checkSession(sessionId: string): void {
  const session = getToolDevSession(sessionId);
  if (!session) return;
  evaluateSession(session);
}

// ── Sweep Logic ─────────────────────────────────────────────────────────────

function sweepActiveSessions(): void {
  const sessions = getAllActiveSessions();
  if (sessions.length === 0) return;

  const config = getConfig();
  const maxIdleMs = config.toolDevelopment.maxIdleMs;
  const maxSessionMs = config.toolDevelopment.maxSessionDurationMs;
  const now = Date.now();

  for (const session of sessions) {
    // 1. Session duration limit
    const sessionAge = now - new Date(session.startedAt).getTime();
    if (sessionAge > maxSessionMs) {
      emitAlert(session, "tool_dev_runaway", `Session exceeded max duration (${Math.round(maxSessionMs / 60_000)}min)`);
      terminateSession(session.id, `Max session duration exceeded (${Math.round(sessionAge / 60_000)}min)`);
      continue;
    }

    // 2. Idle detection — no activity for maxIdleMs
    const idleMs = now - new Date(session.lastActivityAt).getTime();
    if (idleMs > maxIdleMs) {
      emitAlert(session, "tool_dev_stuck", `No activity for ${Math.round(idleMs / 1000)}s`);
      markStuck(session.id, `Idle timeout — no activity for ${Math.round(idleMs / 1000)}s`);
      continue;
    }

    // 3. Heartbeat liveness — 2x idle threshold without heartbeat
    const heartbeatAge = now - new Date(session.lastHeartbeatAt).getTime();
    if (heartbeatAge > maxIdleMs * 2) {
      emitAlert(session, "tool_dev_stuck", `No heartbeat for ${Math.round(heartbeatAge / 1000)}s`);
      markStuck(session.id, `Heartbeat timeout — no heartbeat for ${Math.round(heartbeatAge / 1000)}s`);
      continue;
    }

    // 4. Run convergence checks
    evaluateSession(session);
  }

  // Clean up warnings for terminated sessions
  for (const id of _warned.keys()) {
    if (!sessions.some((s) => s.id === id)) {
      _warned.delete(id);
    }
  }
}

function evaluateSession(session: ToolDevSession): void {
  // 5. Iteration escalation (warning-only; session count alone never terminates work)
  for (const threshold of WARN_ITERATION_THRESHOLDS) {
    const warnKey = `iterations:${threshold}`;
    if (session.iterations < threshold || hasWarned(session.id, warnKey)) continue;
    markWarned(session.id, warnKey);
    emitAlert(
      session,
      "tool_dev_stuck",
      `${session.iterations} iterations without completion — inspect the current approach, but keep the session alive if it is still making progress.`,
    );

    log.warn(
      { devSessionId: session.id, iterations: session.iterations, threshold },
      "Dev session iteration escalation — operator review recommended",
    );
  }

  // 6. Container storm
  if (session.containerSpawns > MAX_CONTAINER_SPAWNS) {
    emitAlert(session, "tool_dev_runaway", `Container storm: ${session.containerSpawns} spawns`);
    terminateSession(session.id, `Container storm — ${session.containerSpawns} spawns exceeded limit of ${MAX_CONTAINER_SPAWNS}`);
    return;
  }

  // 7. Identical failure loop
  if (session.identicalFailureCount >= IDENTICAL_FAILURE_THRESHOLD && !hasWarned(session.id, "identical_failure")) {
    markWarned(session.id, "identical_failure");
    emitAlert(
      session,
      "tool_dev_stuck",
      `Same test failure repeated ${session.identicalFailureCount} times — the current approach may not work. ` +
      `Consider: (1) simplifying the tool, (2) changing the algorithm, (3) splitting into smaller tools.`,
    );
  }

  // 8. Zero delta detection — if iterations increase but code doesn't change
  // (Tracked via the session's code hash — would need more state; leaving
  // as iteration + identical-failure combo for now)
}

// ── Alert Emission ──────────────────────────────────────────────────────────

function emitAlert(
  session: ToolDevSession,
  alertType: "tool_dev_stuck" | "tool_dev_runaway",
  message: string,
): void {
  logAudit(`warden:${alertType}`, {
    devSessionId: session.id,
    toolName: session.toolName,
    iterations: session.iterations,
    containerSpawns: session.containerSpawns,
    identicalFailureCount: session.identicalFailureCount,
    message,
  }, {
    sessionId: session.sessionId,
    severity: alertType === "tool_dev_runaway" ? "error" : "warn",
  });

  log.warn(
    { devSessionId: session.id, alertType, iterations: session.iterations },
    message,
  );
}

// ── Warning dedup ───────────────────────────────────────────────────────────

function hasWarned(sessionId: string, type: string): boolean {
  return _warned.get(sessionId)?.has(type) ?? false;
}

function markWarned(sessionId: string, type: string): void {
  if (!_warned.has(sessionId)) _warned.set(sessionId, new Set());
  _warned.get(sessionId)!.add(type);
}
