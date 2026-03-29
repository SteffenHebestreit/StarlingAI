/**
 * Warden — background anomaly monitor (Stage 3.1)
 *
 * Subscribes to the live audit stream to track rolling-window counters for
 * four classes of suspicious behaviour:
 *
 *   tool_storm              — a session accumulates >15 tool calls within 5 minutes
 *   repeated_failures       — an agent fails ≥3 times within 2 minutes
 *   tool_escape_attempt     — a sub-agent has ≥3 blocked tool calls in one session
 *   rate_limit_flood        — a channel sender is rate-limited ≥5 times within 1 minute
 *   repeated_identical_output — a tool returns the same output ≥3 times in a row (loop)
 *
 * Computer-use anomalies (Stage 9):
 *   computer_focus_thrashing      — ≥10 focus switches in 1 minute
 *   computer_click_storm          — ≥30 clicks in 1 minute → revokes lease auto-approve
 *   computer_credential_prompt_loop — ≥3 credential dialogs in 5 min → emergency stop
 *   computer_clipboard_exfiltration — ≥5 clipboard reads in 1 min → emergency stop
 *   computer_stale_loop           — 3 identical screenshot hashes in a row
 *
 * On detection:
 *   - A `warden_alert` audit event is emitted (visible in dashboard and JSONL).
 *   - For `repeated_failures` and `tool_escape_attempt`, synthetic failure
 *     outcomes are appended to the outcome log so the circuit breaker can trip.
 *   - For computer anomalies, sessions may be emergency-stopped or have their
 *     lease auto-approve revoked depending on severity.
 *
 * The Warden runs a lightweight 30-second sweep interval and an in-memory event
 * listener.  It does not hit any external service.
 */

import { logAudit, subscribeToAudit } from "../audit/logger.js";
import { appendOutcome } from "./outcomes.js";
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";
import { buildWardenIntervention, type InterventionNotice } from "./interventions.js";
import { computerSessionManager } from "./computer-session.js";

const log = childLogger("agent:warden");

// ── Rolling window thresholds ─────────────────────────────────────────────────

const TOOL_STORM_WINDOW_MS = 5 * 60 * 1_000;  // 5 min
const TOOL_STORM_THRESHOLD = 15;               // tool calls per session

const FAILURE_WINDOW_MS = 2 * 60 * 1_000;     // 2 min
const FAILURE_THRESHOLD = 3;                   // rapid consecutive failures per agent
const TOOL_ISSUE_WINDOW_MS = 2 * 60 * 1_000;   // 2 min
const TOOL_ISSUE_THRESHOLD = 3;                // suspicious tool failures per session

const ESCAPE_THRESHOLD = 3;                    // blocked tool attempts per sub-agent session

const RATE_FLOOD_WINDOW_MS = 60 * 1_000;       // 1 min
const RATE_FLOOD_THRESHOLD = 5;                // rate-limit hits per sender

// Computer-use anomaly windows
const COMPUTER_FOCUS_WINDOW_MS = 60 * 1_000;    // 1 min
const COMPUTER_FOCUS_THRESHOLD = 10;             // focus switches per session

const COMPUTER_CLICK_WINDOW_MS = 60 * 1_000;    // 1 min
const COMPUTER_CLICK_THRESHOLD = 30;             // clicks per session

const COMPUTER_CREDENTIAL_WINDOW_MS = 5 * 60 * 1_000; // 5 min
const COMPUTER_CREDENTIAL_THRESHOLD = 3;         // credential prompt detections

const COMPUTER_CLIPBOARD_WINDOW_MS = 60 * 1_000; // 1 min
const COMPUTER_CLIPBOARD_THRESHOLD = 5;           // clipboard reads per session

const COMPUTER_STALE_LOOP_THRESHOLD = 3;          // identical screenshots in a row

// ── In-memory state ───────────────────────────────────────────────────────────

/** sessionId → hit timestamps */
const _toolCallsBySession = new Map<string, number[]>();

/** agentName → failure timestamps */
const _agentFailures = new Map<string, number[]>();

/** sessionId → suspicious tool issues */
const _toolIssuesBySession = new Map<string, Array<{ ts: number; issueCode: string; toolName?: string }>>();

/** sub-agent sessionId → { agentName, count } */
const _blockedAttempts = new Map<string, { agentName: string; count: number }>();

/** "channel:senderId" → rate-limit hit timestamps */
const _rateLimitHits = new Map<string, number[]>();

/**
 * sessionId → breach details for turns that exceeded their SLO.
 * Fired immediately on detection (not on sweep) but recorded here for stats.
 */
const _sloBreaches = new Map<string, { turnDurationMs: number; firstTokenMs?: number; sloBudgetMs: number }>();

/** computerSessionId → focus-switch timestamps */
const _computerFocusSwitches = new Map<string, number[]>();

/** computerSessionId → click timestamps */
const _computerClicks = new Map<string, number[]>();

/** computerSessionId → credential prompt detection timestamps */
const _computerCredentialPrompts = new Map<string, number[]>();

/** computerSessionId → clipboard read timestamps */
const _computerClipboardReads = new Map<string, number[]>();

/** computerSessionId → last N screenshot hashes (ring buffer for stale detection) */
const _computerScreenshotHashes = new Map<string, string[]>();

let _alertsEmitted = 0;
let _wardenInterval: ReturnType<typeof setInterval> | null = null;
let _unsubscribeAudit: (() => void) | null = null;

// ── Public API ────────────────────────────────────────────────────────────────

export interface WardenAlert {
  type: "tool_storm" | "repeated_failures" | "tool_escape_attempt" | "rate_limit_flood" | "turn_slo_breach" | "tool_failure_spike" | "repeated_identical_output" | "computer_focus_thrashing" | "computer_click_storm" | "computer_credential_prompt_loop" | "computer_clipboard_exfiltration" | "computer_stale_loop";
  severity: "warn" | "error";
  subject: string;
  detail: string;
  action: "logged" | "circuit_tripped" | "session_emergency_stopped" | "lease_auto_revoked";
  intervention?: InterventionNotice;
}

export function getWardenStats(): { running: boolean; alertsEmitted: number } {
  return { running: _wardenInterval !== null, alertsEmitted: _alertsEmitted };
}

export function startWarden(): void {
  if (_wardenInterval) return;

  _unsubscribeAudit = subscribeToAudit((event) => {
    const now = Date.now();

    // ── Tool call accumulation ───────────────────────────────────────────────
    if (
      (event.type === "tool_call_requested" || event.type === "sub_agent_tool_call") &&
      event.sessionId
    ) {
      const hits = _toolCallsBySession.get(event.sessionId) ?? [];
      hits.push(now);
      _toolCallsBySession.set(event.sessionId, hits);
    }

    // ── Sub-agent failure accumulation ───────────────────────────────────────
    if (event.type === "sub_agent_max_iterations") {
      const agentName = String(event.data["agentName"] ?? "");
      if (agentName) {
        const failures = _agentFailures.get(agentName) ?? [];
        failures.push(now);
        _agentFailures.set(agentName, failures);
      }
    }

    if (event.sessionId && (
      event.type === "tool_call_failed"
      || event.type === "tool_output_blocked"
      || (event.type === "tool_call_completed" && event.data["suspiciousReturn"] === true)
    )) {
      const issues = _toolIssuesBySession.get(event.sessionId) ?? [];
      issues.push({
        ts: now,
        issueCode: String(event.data["issueCode"] ?? "unknown_issue"),
        toolName: event.data["tool"] ? String(event.data["tool"]) : undefined,
      });
      _toolIssuesBySession.set(event.sessionId, issues);
    }

    // ── Blocked tool accumulation (escape attempts) ──────────────────────────
    if (event.type === "sub_agent_tool_blocked" && event.sessionId) {
      const agentName = String(event.data["agentName"] ?? "unknown");
      const existing = _blockedAttempts.get(event.sessionId);
      _blockedAttempts.set(event.sessionId, {
        agentName,
        count: (existing?.count ?? 0) + 1,
      });
    }

    // ── Rate-limit hit accumulation ──────────────────────────────────────────
    if (event.type === "rate_limited" && event.data["scope"] === "channel_ingress") {
      const channel = String(event.data["channel"] ?? "");
      const senderId = String(event.data["senderId"] ?? "");
      if (channel && senderId) {
        const key = `${channel}:${senderId}`;
        const hits = _rateLimitHits.get(key) ?? [];
        hits.push(now);
        _rateLimitHits.set(key, hits);
      }
    }

    // ── Computer-use action accumulation ────────────────────────────────────
    if (event.type === "computer_action" && event.data["computerSessionId"]) {
      const csId = String(event.data["computerSessionId"]);
      const actionType = String(event.data["actionType"] ?? "");

      // Focus switch tracking
      if (actionType === "focus_window") {
        const hits = _computerFocusSwitches.get(csId) ?? [];
        hits.push(now);
        _computerFocusSwitches.set(csId, hits);
      }

      // Click tracking
      if (actionType === "click") {
        const hits = _computerClicks.get(csId) ?? [];
        hits.push(now);
        _computerClicks.set(csId, hits);
      }

      // Clipboard read tracking
      if (actionType === "clipboard_read") {
        const hits = _computerClipboardReads.get(csId) ?? [];
        hits.push(now);
        _computerClipboardReads.set(csId, hits);
      }

      // Screenshot hash tracking for stale loop detection
      if (event.data["screenshotHash"]) {
        const hash = String(event.data["screenshotHash"]);
        const hashes = _computerScreenshotHashes.get(csId) ?? [];
        hashes.push(hash);
        // Keep only the last COMPUTER_STALE_LOOP_THRESHOLD + 1 entries
        if (hashes.length > COMPUTER_STALE_LOOP_THRESHOLD + 1) {
          hashes.splice(0, hashes.length - (COMPUTER_STALE_LOOP_THRESHOLD + 1));
        }
        _computerScreenshotHashes.set(csId, hashes);
      }
    }

    // Credential prompt detection (emitted by vision pipeline)
    if (event.type === "computer_credential_prompt_detected" && event.data["computerSessionId"]) {
      const csId = String(event.data["computerSessionId"]);
      const hits = _computerCredentialPrompts.get(csId) ?? [];
      hits.push(now);
      _computerCredentialPrompts.set(csId, hits);
    }

    // ── Identical output loop detection ──────────────────────────────────────
    // Fires immediately when the runtime reports a tool returning the same output
    // multiple times in a row — indicating the agent is stuck in a loop.
    if (
      event.type === "tool_call_completed" &&
      event.data["repeatedIdenticalOutput"] === true &&
      event.sessionId
    ) {
      const toolName = String(event.data["tool"] ?? "unknown");
      const alert = makeAlert(
        "repeated_identical_output",
        "warn",
        `${toolName}@${event.sessionId.slice(0, 20)}`,
        `Tool '${toolName}' returned identical output repeatedly in session ${event.sessionId.slice(0, 20)} — loop detected`,
        "logged",
      );
      emitAlert(alert);
    }

    // ── Turn SLO breach detection ────────────────────────────────────────────
    // Fires immediately (not on sweep) when a completed turn exceeds the configured
    // latency budget. Reads per-class SLOs from config.
    if (event.type === "turn_performance" && event.sessionId) {
      const turnDurationMs = Number(event.data["turnDurationMs"] ?? 0);
      const firstTokenMs = event.data["firstModelResponseMs"] != null
        ? Number(event.data["firstModelResponseMs"])
        : undefined;

      if (turnDurationMs > 0) {
        const config = getConfig();
        const perf = config.agents.performance;
        // Sub-agent sessions start with "sub:" prefix; orchestrator sessions don't.
        const isSubAgent = event.sessionId.startsWith("sub:");
        const sloMs = isSubAgent ? perf.subAgentTurnSloMs : perf.orchestratorTurnSloMs;

        const turnBreach = turnDurationMs > sloMs;
        const firstTokenBreach = firstTokenMs !== undefined && firstTokenMs > perf.firstTokenSloMs;

        if (turnBreach || firstTokenBreach) {
          const breachType = turnBreach ? "turn_duration" : "first_token";
          const breachMs = turnBreach ? turnDurationMs : firstTokenMs!;
          const sloUsed = turnBreach ? sloMs : perf.firstTokenSloMs;

          _sloBreaches.set(event.sessionId, { turnDurationMs, firstTokenMs, sloBudgetMs: sloMs });

          const alert = makeAlert(
            "turn_slo_breach",
            "warn",
            event.sessionId,
            `${isSubAgent ? "Sub-agent" : "Orchestrator"} session ${event.sessionId.slice(0, 20)} exceeded ${breachType} SLO: ${breachMs}ms > ${sloUsed}ms budget`,
            "logged",
          );
          emitAlert(alert);
        }
      }
    }
  });

  _wardenInterval = setInterval(sweepAnomalies, 30_000);
  _wardenInterval.unref();

  log.info("Warden started — monitoring for anomalies");
}

export function stopWarden(): void {
  if (_wardenInterval) {
    clearInterval(_wardenInterval);
    _wardenInterval = null;
  }
  if (_unsubscribeAudit) {
    _unsubscribeAudit();
    _unsubscribeAudit = null;
  }
  log.info("Warden stopped");
}

/** Exported for tests — trigger a sweep synchronously. */
export function sweepAnomaliesNow(): WardenAlert[] {
  return sweepAnomalies();
}

export function resetWardenForTests(): void {
  _toolCallsBySession.clear();
  _agentFailures.clear();
  _blockedAttempts.clear();
  _rateLimitHits.clear();
  _sloBreaches.clear();
  _toolIssuesBySession.clear();
  _computerFocusSwitches.clear();
  _computerClicks.clear();
  _computerCredentialPrompts.clear();
  _computerClipboardReads.clear();
  _computerScreenshotHashes.clear();
  _alertsEmitted = 0;
}

// ── Anomaly sweep ─────────────────────────────────────────────────────────────

function sweepAnomalies(): WardenAlert[] {
  const now = Date.now();
  const alerts: WardenAlert[] = [];

  // 1. Tool storm ──────────────────────────────────────────────────────────────
  for (const [sessionId, timestamps] of _toolCallsBySession) {
    const recent = timestamps.filter(t => now - t < TOOL_STORM_WINDOW_MS);
    if (recent.length === 0) {
      _toolCallsBySession.delete(sessionId);
      continue;
    }
    _toolCallsBySession.set(sessionId, recent);

    if (recent.length >= TOOL_STORM_THRESHOLD) {
      const alert = makeAlert(
        "tool_storm",
        "warn",
        sessionId,
        `Session accumulated ${recent.length} tool calls in the last 5 minutes`,
        "logged",
      );
      emitAlert(alert);
      alerts.push(alert);
      // Reset window so we don't re-fire on the same spike
      _toolCallsBySession.set(sessionId, []);
    }
  }

  // 2. Suspicious tool failure spike ─────────────────────────────────────────
  for (const [sessionId, issues] of _toolIssuesBySession) {
    const recent = issues.filter(issue => now - issue.ts < TOOL_ISSUE_WINDOW_MS);
    if (recent.length === 0) {
      _toolIssuesBySession.delete(sessionId);
      continue;
    }
    _toolIssuesBySession.set(sessionId, recent);

    if (recent.length >= TOOL_ISSUE_THRESHOLD) {
      const issueSummary = recent
        .slice(-3)
        .map(issue => issue.toolName ? `${issue.toolName}:${issue.issueCode}` : issue.issueCode)
        .join(", ");
      const alert = makeAlert(
        "tool_failure_spike",
        "warn",
        sessionId,
        `Session accumulated ${recent.length} suspicious tool failures/returns in the last 2 minutes (${issueSummary})`,
        "logged",
      );
      emitAlert(alert);
      alerts.push(alert);
      _toolIssuesBySession.set(sessionId, []);
    }
  }

  // 3. Repeated agent failures ─────────────────────────────────────────────────
  for (const [agentName, timestamps] of _agentFailures) {
    const recent = timestamps.filter(t => now - t < FAILURE_WINDOW_MS);
    if (recent.length === 0) {
      _agentFailures.delete(agentName);
      continue;
    }
    _agentFailures.set(agentName, recent);

    if (recent.length >= FAILURE_THRESHOLD) {
      // Reinforce the circuit breaker: append synthetic failures
      const config = getConfig();
      for (let i = 0; i < 3; i++) {
        appendOutcome(config.workspacePath, {
          ts: new Date().toISOString(),
          agent: agentName,
          task: "warden:rapid_failure_detected",
          outcome: "failure",
          iterations: 0,
          totalTokens: 0,
          error: "warden: repeated rapid failures",
        });
      }
      const alert = makeAlert(
        "repeated_failures",
        "error",
        agentName,
        `Agent '${agentName}' failed ${recent.length} times within 2 minutes — circuit breaker reinforced`,
        "circuit_tripped",
      );
      emitAlert(alert);
      alerts.push(alert);
      _agentFailures.delete(agentName);
    }
  }

  // 4. Tool escape attempts ────────────────────────────────────────────────────
  for (const [sessionId, { agentName, count }] of _blockedAttempts) {
    if (count >= ESCAPE_THRESHOLD) {
      const config = getConfig();
      appendOutcome(config.workspacePath, {
        ts: new Date().toISOString(),
        agent: agentName,
        task: "warden:tool_escape_attempt",
        outcome: "failure",
        iterations: 0,
        totalTokens: 0,
        error: "warden: repeated blocked tool calls",
      });
      const alert = makeAlert(
        "tool_escape_attempt",
        "error",
        `${agentName}@${sessionId.slice(0, 20)}`,
        `Sub-agent '${agentName}' attempted ${count} blocked tool calls — circuit breaker reinforced`,
        "circuit_tripped",
      );
      emitAlert(alert);
      alerts.push(alert);
      _blockedAttempts.delete(sessionId);
    }
  }

  // 5. Rate limit flood ────────────────────────────────────────────────────────
  for (const [key, timestamps] of _rateLimitHits) {
    const recent = timestamps.filter(t => now - t < RATE_FLOOD_WINDOW_MS);
    if (recent.length === 0) {
      _rateLimitHits.delete(key);
      continue;
    }
    _rateLimitHits.set(key, recent);

    if (recent.length >= RATE_FLOOD_THRESHOLD) {
      const alert = makeAlert(
        "rate_limit_flood",
        "warn",
        key,
        `Sender '${key}' hit rate limits ${recent.length} times in 1 minute`,
        "logged",
      );
      emitAlert(alert);
      alerts.push(alert);
      _rateLimitHits.set(key, []);
    }
  }

  // 6. Computer focus thrashing ──────────────────────────────────────────────
  for (const [csId, timestamps] of _computerFocusSwitches) {
    const recent = timestamps.filter(t => now - t < COMPUTER_FOCUS_WINDOW_MS);
    if (recent.length === 0) {
      _computerFocusSwitches.delete(csId);
      continue;
    }
    _computerFocusSwitches.set(csId, recent);

    if (recent.length >= COMPUTER_FOCUS_THRESHOLD) {
      const alert = makeAlert(
        "computer_focus_thrashing",
        "warn",
        csId,
        `Computer session ${csId.slice(0, 20)} switched focus ${recent.length} times in 1 minute`,
        "logged",
      );
      emitAlert(alert);
      alerts.push(alert);
      _computerFocusSwitches.set(csId, []);
    }
  }

  // 7. Computer click storm ──────────────────────────────────────────────────
  for (const [csId, timestamps] of _computerClicks) {
    const recent = timestamps.filter(t => now - t < COMPUTER_CLICK_WINDOW_MS);
    if (recent.length === 0) {
      _computerClicks.delete(csId);
      continue;
    }
    _computerClicks.set(csId, recent);

    if (recent.length >= COMPUTER_CLICK_THRESHOLD) {
      computerSessionManager.revokeLeaseAutoApprove(csId);
      const alert = makeAlert(
        "computer_click_storm",
        "warn",
        csId,
        `Computer session ${csId.slice(0, 20)} produced ${recent.length} clicks in 1 minute — lease auto-approve revoked`,
        "lease_auto_revoked",
      );
      emitAlert(alert);
      alerts.push(alert);
      _computerClicks.set(csId, []);
    }
  }

  // 8. Computer credential prompt loop ───────────────────────────────────────
  for (const [csId, timestamps] of _computerCredentialPrompts) {
    const recent = timestamps.filter(t => now - t < COMPUTER_CREDENTIAL_WINDOW_MS);
    if (recent.length === 0) {
      _computerCredentialPrompts.delete(csId);
      continue;
    }
    _computerCredentialPrompts.set(csId, recent);

    if (recent.length >= COMPUTER_CREDENTIAL_THRESHOLD) {
      computerSessionManager.emergencyStop(csId, "warden:credential_prompt_loop");
      const alert = makeAlert(
        "computer_credential_prompt_loop",
        "error",
        csId,
        `Computer session ${csId.slice(0, 20)} encountered ${recent.length} credential prompts in 5 minutes — session emergency-stopped`,
        "session_emergency_stopped",
      );
      emitAlert(alert);
      alerts.push(alert);
      _computerCredentialPrompts.delete(csId);
    }
  }

  // 9. Computer clipboard exfiltration ───────────────────────────────────────
  for (const [csId, timestamps] of _computerClipboardReads) {
    const recent = timestamps.filter(t => now - t < COMPUTER_CLIPBOARD_WINDOW_MS);
    if (recent.length === 0) {
      _computerClipboardReads.delete(csId);
      continue;
    }
    _computerClipboardReads.set(csId, recent);

    if (recent.length >= COMPUTER_CLIPBOARD_THRESHOLD) {
      computerSessionManager.emergencyStop(csId, "warden:clipboard_exfiltration");
      const alert = makeAlert(
        "computer_clipboard_exfiltration",
        "error",
        csId,
        `Computer session ${csId.slice(0, 20)} read clipboard ${recent.length} times in 1 minute — session emergency-stopped`,
        "session_emergency_stopped",
      );
      emitAlert(alert);
      alerts.push(alert);
      _computerClipboardReads.delete(csId);
    }
  }

  // 10. Computer stale loop ──────────────────────────────────────────────────
  for (const [csId, hashes] of _computerScreenshotHashes) {
    if (hashes.length >= COMPUTER_STALE_LOOP_THRESHOLD) {
      const tail = hashes.slice(-COMPUTER_STALE_LOOP_THRESHOLD);
      const allSame = tail.every(h => h === tail[0]);
      if (allSame) {
        const alert = makeAlert(
          "computer_stale_loop",
          "warn",
          csId,
          `Computer session ${csId.slice(0, 20)} produced ${COMPUTER_STALE_LOOP_THRESHOLD} identical screenshots — agent may be stuck`,
          "logged",
        );
        emitAlert(alert);
        alerts.push(alert);
        _computerScreenshotHashes.set(csId, []);
      }
    }
  }

  return alerts;
}

function makeAlert(
  type: WardenAlert["type"],
  severity: WardenAlert["severity"],
  subject: string,
  detail: string,
  action: WardenAlert["action"],
): WardenAlert {
  return {
    type,
    severity,
    subject,
    detail,
    action,
    intervention: buildWardenIntervention(type, detail, subject),
  };
}

function emitAlert(alert: WardenAlert): void {
  _alertsEmitted++;
  logAudit(
    "warden_alert",
    {
      alertType: alert.type,
      subject: alert.subject,
      detail: alert.detail,
      action: alert.action,
      intervention: alert.intervention,
    },
    { severity: alert.severity, channel: "warden" },
  );
  log[alert.severity]({ alertType: alert.type, subject: alert.subject }, `Warden: ${alert.detail}`);
}
