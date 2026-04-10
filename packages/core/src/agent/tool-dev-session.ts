/**
 * Tool Development Session — manages the lifecycle of a tool being
 * designed, coded, tested, and submitted for approval in the sandbox.
 *
 * Key behaviors:
 *   - No iteration cap (convergence-based, not count-based)
 *   - Lease/heartbeat-based liveness (not blind timeouts)
 *   - Progress tracking for Warden oversight
 *   - Session state persisted in ephemeral store (Redis)
 */
import { v4 as uuid } from "uuid";
import { childLogger } from "../logger.js";
import { logAudit } from "../audit/logger.js";
import { emitSwarmEvent } from "../swarm/bus.js";
import { ephemeralPut, ephemeralGet, ephemeralQuery, ephemeralDelete } from "../runtime/ephemeral-store/index.js";

const log = childLogger("tool-dev-session");

// ── Types ───────────────────────────────────────────────────────────────────

export type ToolDevStatus =
  | "developing"
  | "testing"
  | "awaiting_approval"
  | "approved"
  | "rejected"
  | "stuck"
  | "terminated";

export interface TestRun {
  input: Record<string, unknown>;
  expectedOutput?: string;
  actualOutput: string;
  passed: boolean;
  error?: string;
  durationMs: number;
}

export interface PlannedTestCase {
  input: Record<string, unknown>;
  expectedOutput?: string;
}

export interface ToolDevSession {
  id: string;
  toolName: string;
  description: string;
  parametersSchema: Record<string, unknown>;
  status: ToolDevStatus;
  iterations: number;
  identicalFailureCount: number;
  lastFailureHash: string;
  containerSpawns: number;
  startedAt: string;
  lastActivityAt: string;
  lastHeartbeatAt: string;
  /** Initial code seeded from the LLM proposal. The dev agent refines this. */
  code: string;
  /** Test cases derived from the LLM proposal, before the tool has been run. */
  plannedTestCases: PlannedTestCase[];
  testResults: TestRun[];
  approvalId?: string;
  sessionId: string;
  agentName?: string;
  terminationReason?: string;
}

// ── In-memory session registry ──────────────────────────────────────────────

const _sessions = new Map<string, ToolDevSession>();

// ── Session Management ──────────────────────────────────────────────────────

export function createToolDevSession(opts: {
  toolName: string;
  description: string;
  parametersSchema: Record<string, unknown>;
  sessionId: string;
  agentName?: string;
  /** Initial code from the LLM proposal to seed development. */
  starterCode?: string;
  /** Planned test cases from the LLM proposal, before execution. */
  plannedTestCases?: PlannedTestCase[];
}): ToolDevSession {
  const now = new Date().toISOString();
  const session: ToolDevSession = {
    id: uuid(),
    toolName: opts.toolName,
    description: opts.description,
    parametersSchema: opts.parametersSchema,
    status: "developing",
    iterations: 0,
    identicalFailureCount: 0,
    lastFailureHash: "",
    containerSpawns: 0,
    startedAt: now,
    lastActivityAt: now,
    lastHeartbeatAt: now,
    code: opts.starterCode ?? "",
    plannedTestCases: opts.plannedTestCases ?? [],
    testResults: [],
    sessionId: opts.sessionId,
    agentName: opts.agentName,
  };

  _sessions.set(session.id, session);
  persistSession(session);

  emitSwarmEvent("tool_dev_session_started", {
    sessionId: opts.sessionId,
    agentName: opts.agentName,
    data: { devSessionId: session.id, toolName: opts.toolName },
  });

  logAudit("tool_dev_session_started", { devSessionId: session.id, toolName: opts.toolName }, {
    sessionId: opts.sessionId,
    severity: "info",
  });

  log.info({ devSessionId: session.id, toolName: opts.toolName }, "Tool dev session created");
  return session;
}

export function getToolDevSession(id: string): ToolDevSession | undefined {
  return _sessions.get(id);
}

export function getActiveSessionCount(): number {
  let count = 0;
  for (const s of _sessions.values()) {
    if (s.status === "developing" || s.status === "testing") count++;
  }
  return count;
}

export function getAllActiveSessions(): ToolDevSession[] {
  return [..._sessions.values()].filter(
    (s) => s.status === "developing" || s.status === "testing",
  );
}

// ── Heartbeat & Activity ────────────────────────────────────────────────────

export function heartbeatSession(id: string): void {
  const session = _sessions.get(id);
  if (!session) return;
  session.lastHeartbeatAt = new Date().toISOString();
}

export function recordActivity(id: string): void {
  const session = _sessions.get(id);
  if (!session) return;
  const now = new Date().toISOString();
  session.lastActivityAt = now;
  session.lastHeartbeatAt = now;
  session.iterations++;
  persistSession(session);

  emitSwarmEvent("tool_dev_iteration", {
    sessionId: session.sessionId,
    data: { devSessionId: id, iterations: session.iterations, status: session.status },
  });
}

export function recordContainerSpawn(id: string): void {
  const session = _sessions.get(id);
  if (!session) return;
  session.containerSpawns++;
}

// ── Code & Test Management ──────────────────────────────────────────────────

export function updateCode(id: string, code: string): void {
  const session = _sessions.get(id);
  if (!session) return;
  session.code = code;
  session.status = "developing";
  recordActivity(id);
}

export function recordTestResults(id: string, results: TestRun[]): void {
  const session = _sessions.get(id);
  if (!session) return;
  session.testResults = results;
  session.status = "testing";

  // Track identical failure patterns for stuck detection
  const failedTests = results.filter((r) => !r.passed);
  if (failedTests.length > 0) {
    const failureHash = simpleHash(
      failedTests.map((t) => t.error ?? t.actualOutput).join("|"),
    );
    if (failureHash === session.lastFailureHash) {
      session.identicalFailureCount++;
    } else {
      session.identicalFailureCount = 1;
      session.lastFailureHash = failureHash;
    }
  } else {
    session.identicalFailureCount = 0;
    session.lastFailureHash = "";
  }

  recordActivity(id);
}

export function allTestsPassing(id: string): boolean {
  const session = _sessions.get(id);
  if (!session || session.testResults.length === 0) return false;
  return session.testResults.every((t) => t.passed);
}

// ── Status Transitions ──────────────────────────────────────────────────────

export function markAwaitingApproval(id: string, approvalId: string): void {
  const session = _sessions.get(id);
  if (!session) return;
  session.status = "awaiting_approval";
  session.approvalId = approvalId;
  recordActivity(id);
}

export function markApproved(id: string): void {
  const session = _sessions.get(id);
  if (!session) return;
  session.status = "approved";
  persistSession(session);
  emitCompletion(session, "approved");
}

export function markRejected(id: string): void {
  const session = _sessions.get(id);
  if (!session) return;
  session.status = "rejected";
  persistSession(session);
  emitCompletion(session, "rejected");
}

export function terminateSession(id: string, reason: string): void {
  const session = _sessions.get(id);
  if (!session) return;

  if (session.status === "approved" || session.status === "rejected" || session.status === "terminated") {
    return; // Already in terminal state
  }

  session.status = "terminated";
  session.terminationReason = reason;
  persistSession(session);

  emitSwarmEvent("tool_dev_session_stuck", {
    sessionId: session.sessionId,
    data: { devSessionId: id, reason, iterations: session.iterations },
  });

  logAudit("tool_dev_session_terminated", { devSessionId: id, toolName: session.toolName, reason, iterations: session.iterations }, {
    sessionId: session.sessionId,
    severity: "warn",
  });

  log.warn({ devSessionId: id, toolName: session.toolName, reason }, "Tool dev session terminated");
}

export function markStuck(id: string, reason: string): void {
  const session = _sessions.get(id);
  if (!session) return;
  session.status = "stuck";
  session.terminationReason = reason;
  persistSession(session);

  emitSwarmEvent("tool_dev_session_stuck", {
    sessionId: session.sessionId,
    data: { devSessionId: id, reason, iterations: session.iterations },
  });

  log.warn({ devSessionId: id, reason }, "Tool dev session stuck");
}

// ── Persistence (ephemeral store) ───────────────────────────────────────────

function persistSession(session: ToolDevSession): void {
  ephemeralPut({
    namespace: "dev-session-lease",
    key: session.id,
    value: JSON.stringify(session),
    sessionId: session.sessionId,
    agentName: session.agentName,
  }).catch((err) => {
    log.warn({ err, devSessionId: session.id }, "Failed to persist dev session");
  });
}

export async function loadPersistedSessions(): Promise<void> {
  try {
    const entries = await ephemeralQuery({ namespace: "dev-session-lease", limit: 100 });
    for (const entry of entries) {
      try {
        const session = JSON.parse(entry.value) as ToolDevSession;
        if (session.status === "developing" || session.status === "testing") {
          // Recover active sessions — mark as stuck if they were interrupted
          session.status = "stuck";
          session.terminationReason = "Process restart — session interrupted";
        }
        _sessions.set(session.id, session);
      } catch {
        // Skip corrupt entries
      }
    }
    log.info({ recovered: _sessions.size }, "Loaded persisted dev sessions");
  } catch (err) {
    log.warn({ err }, "Failed to load persisted dev sessions");
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function emitCompletion(session: ToolDevSession, outcome: string): void {
  emitSwarmEvent("tool_dev_session_completed", {
    sessionId: session.sessionId,
    data: {
      devSessionId: session.id,
      toolName: session.toolName,
      outcome,
      iterations: session.iterations,
      testsPassed: session.testResults.filter((t) => t.passed).length,
      testsFailed: session.testResults.filter((t) => !t.passed).length,
    },
  });

  logAudit("tool_dev_session_completed", {
    devSessionId: session.id,
    toolName: session.toolName,
    outcome,
    iterations: session.iterations,
  }, {
    sessionId: session.sessionId,
    severity: "info",
  });
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash + chr) | 0;
  }
  return hash.toString(36);
}
