/**
 * Computer Session — types and manager for Stage 9 computer-use.
 *
 * Every computer interaction runs inside a ComputerSession, identified by
 * a random UUID.  The session manager enforces single-controller leases,
 * heartbeat watchdog (15 s / 45 s / 20 s warmup), emergency stop, and
 * max-concurrent-session limits.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { childLogger } from "../logger.js";
import { logAudit } from "../audit/logger.js";
import { getConfig } from "../config/loader.js";

const log = childLogger("agent:computer-session");

// ── Types ─────────────────────────────────────────────────────────────────────

export type ComputerSessionId = string;

export type ComputerSessionAdapter =
  | "local_vscode"
  | "remote_node"
  | "local_desktop"
  | "remote_ssh"
  | "remote_rdp"
  | "remote_vnc"
  | "ephemeral_vm";

export type ComputerSessionState =
  | "initializing"
  | "active"
  | "paused"
  | "stopping"
  | "stopped"
  | "error";

export interface MonitorInfo {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  dpiScale: number;
}

export interface DisplayTopology {
  monitors: MonitorInfo[];
  primary: number;
}

export interface ComputerSessionSnapshot {
  screenshotHash: string;
  accessibilityTree?: string;
  activeWindow?: { title: string; processName: string; bounds: { x: number; y: number; width: number; height: number } };
  timestamp: number;
  frameId: string;
  dataUrl?: string;
  width?: number;
  height?: number;
}

export interface ComputerSession {
  id: ComputerSessionId;
  adapter: ComputerSessionAdapter;
  /** Named node from computerUse.nodes (undefined = legacy adapter-level config). */
  nodeId?: string;
  state: ComputerSessionState;
  leaseOwner: string;
  displayTopology: DisplayTopology | null;
  lastSnapshot: ComputerSessionSnapshot | null;
  createdAt: number;
  updatedAt: number;
  lastHeartbeatAt: number;
  recordingEnabled: boolean;
  emergencyStopAt?: number;
  /** Rolling auto-approve window: timestamp when lease auto-approve expires. */
  leaseAutoApproveUntil?: number;
}

// ── Events ────────────────────────────────────────────────────────────────────

export interface ComputerSessionEvents {
  "session:started": (session: ComputerSession) => void;
  "session:stopped": (sessionId: ComputerSessionId, reason: string) => void;
  "session:heartbeat_lost": (sessionId: ComputerSessionId, staleMs: number) => void;
  "session:emergency_stop": (sessionId: ComputerSessionId, operator: string) => void;
  "session:lease_changed": (sessionId: ComputerSessionId, previousOwner: string, newOwner: string) => void;
  "session:state_changed": (sessionId: ComputerSessionId, from: ComputerSessionState, to: ComputerSessionState) => void;
}

// ── Manager ───────────────────────────────────────────────────────────────────

const HEARTBEAT_CHECK_INTERVAL_MS = 10_000;
const WARMUP_GRACE_MS = 20_000;

class ComputerSessionManager extends EventEmitter {
  private _sessions = new Map<ComputerSessionId, ComputerSession>();
  private _watchdogInterval: ReturnType<typeof setInterval> | null = null;

  /** Start a new computer session. */
  startSession(
    adapter: ComputerSessionAdapter,
    leaseOwner: string,
    opts?: { recordingEnabled?: boolean; nodeId?: string },
  ): ComputerSession {
    const cfg = this._getComputerConfig();
    if (!cfg.enabled) {
      throw new Error("Computer use is disabled — set computerUse.enabled = true in config");
    }

    const activeSessions = [...this._sessions.values()].filter(
      (s) => s.state !== "stopped" && s.state !== "error",
    );
    if (activeSessions.length >= cfg.maxConcurrentSessions) {
      throw new Error(
        `Max concurrent sessions (${cfg.maxConcurrentSessions}) reached`,
      );
    }

    const now = Date.now();
    const session: ComputerSession = {
      id: randomUUID(),
      adapter,
      ...(opts?.nodeId ? { nodeId: opts.nodeId } : {}),
      state: "initializing",
      leaseOwner,
      displayTopology: null,
      lastSnapshot: null,
      createdAt: now,
      updatedAt: now,
      lastHeartbeatAt: now,
      recordingEnabled: opts?.recordingEnabled ?? cfg.recordingEnabled,
    };

    this._sessions.set(session.id, session);
    this._ensureWatchdog();

    logAudit("computer_session_start", {
      sessionId: session.id,
      adapter,
      leaseOwner,
    });

    log.info({ sessionId: session.id, adapter, leaseOwner }, "Computer session started");
    return session;
  }

  /** Transition session to active state. Called after adapter init succeeds. */
  activateSession(sessionId: ComputerSessionId, topology?: DisplayTopology): void {
    const session = this._requireSession(sessionId);
    const prev = session.state;
    session.state = "active";
    const now = Date.now();
    session.updatedAt = now;
    session.lastHeartbeatAt = now;
    if (topology) session.displayTopology = topology;
    this.emit("session:state_changed", sessionId, prev, "active");
    this.emit("session:started", session);
  }

  /** Attach to an existing session, taking over the lease. */
  attachSession(
    sessionId: ComputerSessionId,
    newOwner: string,
    force = false,
  ): ComputerSession {
    const session = this._requireSession(sessionId);
    if (session.leaseOwner !== newOwner && !force) {
      throw new Error(
        `Session ${sessionId} is owned by '${session.leaseOwner}'. Use forceAttach to take over.`,
      );
    }
    const previousOwner = session.leaseOwner;
    session.leaseOwner = newOwner;
    session.updatedAt = Date.now();
    session.leaseAutoApproveUntil = undefined; // revoke on takeover

    logAudit("computer_session_attach", {
      sessionId,
      previousOwner,
      newOwner,
      forced: force,
    });

    this.emit("session:lease_changed", sessionId, previousOwner, newOwner);
    log.info({ sessionId, previousOwner, newOwner, force }, "Lease changed");
    return session;
  }

  /** Detach from session (release lease). */
  detachSession(sessionId: ComputerSessionId): void {
    const session = this._requireSession(sessionId);
    session.leaseOwner = "";
    session.leaseAutoApproveUntil = undefined;
    session.updatedAt = Date.now();
  }

  /** Graceful stop. */
  stopSession(sessionId: ComputerSessionId, reason = "requested"): void {
    const session = this._get(sessionId);
    if (!session || session.state === "stopped" || session.state === "error") return;

    const prev = session.state;
    session.state = "stopping";
    session.updatedAt = Date.now();

    // Mark as stopped immediately (adapter cleanup is the caller's responsibility)
    session.state = "stopped";
    session.leaseAutoApproveUntil = undefined;

    logAudit("computer_session_stop", { sessionId, reason });
    this.emit("session:state_changed", sessionId, prev, "stopped");
    this.emit("session:stopped", sessionId, reason);

    log.info({ sessionId, reason }, "Computer session stopped");
  }

  /** Emergency stop — immediate, revoke lease, audit. */
  emergencyStop(sessionId: ComputerSessionId, operator = "system"): void {
    const session = this._get(sessionId);
    if (!session || session.state === "stopped") return;

    const prev = session.state;
    session.state = "stopped";
    session.emergencyStopAt = Date.now();
    session.leaseOwner = "";
    session.leaseAutoApproveUntil = undefined;
    session.updatedAt = Date.now();

    logAudit("computer_session_emergency_stop", { sessionId, operator });
    this.emit("session:state_changed", sessionId, prev, "stopped");
    this.emit("session:emergency_stop", sessionId, operator);
    this.emit("session:stopped", sessionId, "emergency_stop");

    log.warn({ sessionId, operator }, "Computer session EMERGENCY STOPPED");
  }

  /** Update heartbeat timestamp.  Also revives paused sessions. */
  heartbeat(sessionId: ComputerSessionId): void {
    const session = this._get(sessionId);
    if (!session) return;
    if (session.state === "active") {
      session.lastHeartbeatAt = Date.now();
    } else if (session.state === "paused") {
      this.resumeSession(sessionId);
    }
  }

  /**
   * Resume a paused session — transitions paused → active and refreshes
   * the heartbeat timestamp so the watchdog doesn't immediately re-pause.
   */
  resumeSession(sessionId: ComputerSessionId): void {
    const session = this._requireSession(sessionId);
    if (session.state !== "paused") return;
    const prev = session.state;
    session.state = "active";
    session.lastHeartbeatAt = Date.now();
    session.updatedAt = Date.now();
    this.emit("session:state_changed", sessionId, prev, "active");
    log.info({ sessionId }, "Computer session resumed from paused state");
  }

  /** Update last snapshot (after an action or capture). */
  updateSnapshot(sessionId: ComputerSessionId, snapshot: ComputerSessionSnapshot): void {
    const session = this._get(sessionId);
    if (session) {
      session.lastSnapshot = snapshot;
      session.updatedAt = Date.now();
    }
  }

  /** Refresh the lease auto-approve window. */
  refreshLeaseAutoApprove(sessionId: ComputerSessionId, windowMs = 15 * 60 * 1000): void {
    const session = this._get(sessionId);
    if (session && session.state === "active") {
      session.leaseAutoApproveUntil = Date.now() + windowMs;
    }
  }

  /** Revoke lease auto-approve (e.g. on Warden anomaly). */
  revokeLeaseAutoApprove(sessionId: ComputerSessionId): void {
    const session = this._get(sessionId);
    if (session) {
      session.leaseAutoApproveUntil = undefined;
    }
  }

  /** Check if tool is auto-approved within lease window. */
  isLeaseAutoApproved(sessionId: ComputerSessionId): boolean {
    const session = this._get(sessionId);
    if (!session || !session.leaseAutoApproveUntil) return false;
    return Date.now() < session.leaseAutoApproveUntil;
  }

  getSession(sessionId: ComputerSessionId): ComputerSession | undefined {
    return this._get(sessionId);
  }

  listSessions(): ComputerSession[] {
    return [...this._sessions.values()];
  }

  listActiveSessions(): ComputerSession[] {
    return [...this._sessions.values()].filter(
      (s) => s.state === "active" || s.state === "initializing" || s.state === "paused",
    );
  }

  /** Shut down the manager — stop watchdog, stop all sessions. */
  shutdown(): void {
    if (this._watchdogInterval) {
      clearInterval(this._watchdogInterval);
      this._watchdogInterval = null;
    }
    for (const session of this._sessions.values()) {
      if (session.state !== "stopped" && session.state !== "error") {
        this.stopSession(session.id, "manager_shutdown");
      }
    }
  }

  /** Reset for tests. */
  resetForTests(): void {
    this.shutdown();
    this._sessions.clear();
    this.removeAllListeners();
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private _get(id: ComputerSessionId): ComputerSession | undefined {
    return this._sessions.get(id);
  }

  private _requireSession(id: ComputerSessionId): ComputerSession {
    const session = this._sessions.get(id);
    if (!session) throw new Error(`Computer session '${id}' not found`);
    return session;
  }

  private _getComputerConfig() {
    const cfg = getConfig();
    return (cfg as Record<string, unknown>)["computerUse"] as {
      enabled: boolean;
      maxConcurrentSessions: number;
      recordingEnabled: boolean;
      heartbeatIntervalMs: number;
      heartbeatTimeoutMs: number;
      sessionTimeoutMs: number;
    } ?? {
      enabled: false,
      maxConcurrentSessions: 3,
      recordingEnabled: false,
      heartbeatIntervalMs: 15_000,
      heartbeatTimeoutMs: 45_000,
      sessionTimeoutMs: 1_800_000,
    };
  }

  private _ensureWatchdog(): void {
    if (this._watchdogInterval) return;
    this._watchdogInterval = setInterval(() => this._watchdogSweep(), HEARTBEAT_CHECK_INTERVAL_MS);
    this._watchdogInterval.unref();
  }

  private _watchdogSweep(): void {
    const now = Date.now();
    const cfg = this._getComputerConfig();

    for (const session of this._sessions.values()) {
      if (session.state !== "active") continue;

      // Warmup grace: don't fire heartbeat loss for sessions that just started
      if (now - session.createdAt < WARMUP_GRACE_MS) continue;

      // Heartbeat timeout
      const staleness = now - session.lastHeartbeatAt;
      if (staleness > cfg.heartbeatTimeoutMs) {
        log.warn(
          { sessionId: session.id, staleMs: staleness },
          "Computer session heartbeat lost — pausing",
        );
        const prev = session.state;
        session.state = "paused";
        session.updatedAt = now;
        this.emit("session:state_changed", session.id, prev, "paused");
        this.emit("session:heartbeat_lost", session.id, staleness);

        logAudit("computer_heartbeat_lost", {
          sessionId: session.id,
          staleMs: staleness,
        });
      }

      // Session timeout
      if (now - session.createdAt > cfg.sessionTimeoutMs) {
        log.warn({ sessionId: session.id }, "Computer session timed out");
        this.stopSession(session.id, "session_timeout");
      }
    }

    // Clean up terminated sessions older than 5 minutes
    for (const [id, session] of this._sessions) {
      if (
        (session.state === "stopped" || session.state === "error") &&
        now - session.updatedAt > 5 * 60 * 1000
      ) {
        this._sessions.delete(id);
      }
    }
  }
}

// Singleton
export const computerSessionManager = new ComputerSessionManager();
