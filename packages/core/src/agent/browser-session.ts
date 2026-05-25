/**
 * Browser Session — registry + human-handoff signal for the noVNC browser preview.
 *
 * Some browser tasks hit a wall only a human can clear — most often a reCAPTCHA
 * on a login form. `browser_agent` runs against a headed Chrome inside the
 * `browser-vnc` container (CDP) whose display is exposed over noVNC. When the
 * agent detects a CAPTCHA it calls `requestAssist()`, which:
 *   1. flips the session to `assist_requested` (the dashboard surfaces the
 *      clickable BrowserSessionPanel and tells the operator what to solve), and
 *   2. returns a Promise the agent awaits — resolved when the operator clicks
 *      "I solved it — continue" (→ `resolveAssist()`), or when the wait times out.
 *
 * The gateway also runs an authenticated WebSocket proxy in front of websockify
 * so the embedded @novnc client reaches the browser display *behind the gateway's
 * auth*, never by exposing port 6080. `getVncTarget()` tells the proxy where to
 * dial. The whole feature is opt-in: with no browser-vnc backend reachable the
 * registry simply reports `enabled: false` and nothing surfaces in the UI.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { childLogger } from "../logger.js";
import { logAudit } from "../audit/logger.js";

const log = childLogger("agent:browser-session");

// ── Types ─────────────────────────────────────────────────────────────────────

export type BrowserSessionId = string;

export type BrowserSessionState =
  | "active"            // browser_agent is driving normally
  | "assist_requested"  // paused, waiting for a human to solve something (CAPTCHA)
  | "active_resolved"   // human resolved; agent resumed
  | "stopped";

export interface BrowserSession {
  id: BrowserSessionId;
  /** Agent that owns the browser run (usually "browser_agent"). */
  agentName: string;
  /** Orchestrator session that delegated the run, for cross-referencing. */
  parentSessionId?: string;
  state: BrowserSessionState;
  /** Short, human-readable target page (e.g. "freelancermap.de login"). */
  page?: string;
  /** Why a human is needed — shown verbatim in the dashboard. */
  assistReason?: string;
  createdAt: number;
  updatedAt: number;
  assistRequestedAt?: number;
  assistResolvedAt?: number;
}

export interface VncTarget {
  host: string;
  port: number;
  /** websockify accepts any path; "/websockify" is the noVNC convention. */
  path: string;
}

// ── Events ────────────────────────────────────────────────────────────────────

export interface BrowserSessionEvents {
  "session:registered": (session: BrowserSession) => void;
  "session:assist_requested": (sessionId: BrowserSessionId, reason: string) => void;
  "session:assist_resolved": (sessionId: BrowserSessionId, operator: string) => void;
  "session:stopped": (sessionId: BrowserSessionId, reason: string) => void;
}

// ── Manager ───────────────────────────────────────────────────────────────────

/** Default backend matches the `browser-vnc` compose service on the internal network. */
const DEFAULT_VNC_URL = "ws://browser-vnc:6080/websockify";

/** How long an unattended assist request waits before giving up (15 min). */
const DEFAULT_ASSIST_TIMEOUT_MS = 15 * 60 * 1000;

interface PendingAssist {
  resolve: (outcome: "resolved" | "timeout" | "stopped") => void;
  timer: ReturnType<typeof setTimeout>;
}

class BrowserSessionManager extends EventEmitter {
  private _sessions = new Map<BrowserSessionId, BrowserSession>();
  private _pending = new Map<BrowserSessionId, PendingAssist>();

  /** Register a browser run so the dashboard can surface a live preview for it. */
  register(opts: { agentName: string; parentSessionId?: string; page?: string }): BrowserSession {
    const now = Date.now();
    const session: BrowserSession = {
      id: randomUUID(),
      agentName: opts.agentName,
      ...(opts.parentSessionId ? { parentSessionId: opts.parentSessionId } : {}),
      ...(opts.page ? { page: opts.page } : {}),
      state: "active",
      createdAt: now,
      updatedAt: now,
    };
    this._sessions.set(session.id, session);
    logAudit("browser_session_register", { sessionId: session.id, agentName: opts.agentName });
    this.emit("session:registered", session);
    log.info({ sessionId: session.id, agentName: opts.agentName }, "Browser session registered");
    return session;
  }

  /**
   * Pause the run and ask a human for help. Resolves when the operator clicks
   * "continue" (`resolveAssist`), when the session is stopped, or on timeout.
   * Caller (browser_agent) awaits the returned promise before resuming.
   */
  requestAssist(
    sessionId: BrowserSessionId,
    reason: string,
    opts?: { page?: string; timeoutMs?: number },
  ): Promise<"resolved" | "timeout" | "stopped"> {
    const session = this._sessions.get(sessionId);
    if (!session) return Promise.resolve("stopped");

    // Idempotent: if assistance is already pending, reuse the same wait.
    const existing = this._pending.get(sessionId);
    if (existing) {
      return new Promise((resolve) => {
        const prior = existing.resolve;
        existing.resolve = (outcome) => { prior(outcome); resolve(outcome); };
      });
    }

    session.state = "assist_requested";
    session.assistReason = reason;
    if (opts?.page) session.page = opts.page;
    session.assistRequestedAt = Date.now();
    session.updatedAt = session.assistRequestedAt;

    logAudit("browser_session_assist_requested", { sessionId, reason });
    this.emit("session:assist_requested", sessionId, reason);
    log.warn({ sessionId, reason }, "Browser session requested human assistance");

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._pending.delete(sessionId);
        const s = this._sessions.get(sessionId);
        if (s && s.state === "assist_requested") {
          s.state = "active";
          s.updatedAt = Date.now();
        }
        logAudit("browser_session_assist_timeout", { sessionId });
        log.warn({ sessionId }, "Browser session assist timed out");
        resolve("timeout");
      }, opts?.timeoutMs ?? DEFAULT_ASSIST_TIMEOUT_MS);
      timer.unref?.();
      this._pending.set(sessionId, { resolve, timer });
    });
  }

  /** Operator clicked "I solved it — continue". Resumes the waiting agent. */
  resolveAssist(sessionId: BrowserSessionId, operator = "operator"): boolean {
    const pending = this._pending.get(sessionId);
    const session = this._sessions.get(sessionId);
    if (!session) return false;

    session.state = "active_resolved";
    session.assistResolvedAt = Date.now();
    session.updatedAt = session.assistResolvedAt;
    session.assistReason = undefined;

    logAudit("browser_session_assist_resolved", { sessionId, operator });
    this.emit("session:assist_resolved", sessionId, operator);
    log.info({ sessionId, operator }, "Browser session assist resolved by human");

    if (pending) {
      clearTimeout(pending.timer);
      this._pending.delete(sessionId);
      pending.resolve("resolved");
      return true;
    }
    // No agent was waiting (e.g. resolved after timeout) — still a valid state flip.
    return true;
  }

  /** End a browser run; unblocks any pending assist with a "stopped" outcome. */
  stop(sessionId: BrowserSessionId, reason = "completed"): void {
    const session = this._sessions.get(sessionId);
    if (!session) return;
    const pending = this._pending.get(sessionId);
    if (pending) {
      clearTimeout(pending.timer);
      this._pending.delete(sessionId);
      pending.resolve("stopped");
    }
    session.state = "stopped";
    session.updatedAt = Date.now();
    logAudit("browser_session_stop", { sessionId, reason });
    this.emit("session:stopped", sessionId, reason);
    log.info({ sessionId, reason }, "Browser session stopped");
  }

  getSession(sessionId: BrowserSessionId): BrowserSession | undefined {
    return this._sessions.get(sessionId);
  }

  listSessions(): BrowserSession[] {
    return [...this._sessions.values()];
  }

  /** Sessions worth showing live (anything not yet stopped). */
  listActiveSessions(): BrowserSession[] {
    return [...this._sessions.values()].filter((s) => s.state !== "stopped");
  }

  /** Sessions currently waiting on a human. */
  listAwaitingAssist(): BrowserSession[] {
    return [...this._sessions.values()].filter((s) => s.state === "assist_requested");
  }

  /**
   * Where the noVNC proxy should dial. Reads $BROWSER_VNC_WS_URL (default
   * ws://browser-vnc:6080/websockify). Returns null when explicitly disabled
   * via BROWSER_VNC_WS_URL="" so the feature can be turned off cleanly.
   */
  getVncTarget(): VncTarget | null {
    const raw = process.env["BROWSER_VNC_WS_URL"];
    if (raw === "") return null; // explicitly disabled
    try {
      const u = new URL(raw || DEFAULT_VNC_URL);
      return {
        host: u.hostname,
        port: u.port ? Number(u.port) : 6080,
        path: u.pathname && u.pathname !== "/" ? u.pathname : "/websockify",
      };
    } catch {
      log.warn({ raw }, "Invalid BROWSER_VNC_WS_URL — falling back to default");
      const u = new URL(DEFAULT_VNC_URL);
      return { host: u.hostname, port: Number(u.port), path: u.pathname };
    }
  }

  /** Whether the browser preview/handoff is available (a backend is configured). */
  isEnabled(): boolean {
    return this.getVncTarget() !== null;
  }

  /** Reset for tests. */
  resetForTests(): void {
    for (const p of this._pending.values()) clearTimeout(p.timer);
    this._pending.clear();
    this._sessions.clear();
    this.removeAllListeners();
  }
}

// Singleton
export const browserSessionManager = new BrowserSessionManager();
