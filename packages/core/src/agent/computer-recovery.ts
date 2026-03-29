/**
 * Computer-use recovery strategies (Stage 9C)
 *
 * When a computer-use action fails or the agent appears stuck,
 * these strategies attempt automated recovery before escalating
 * to the intervention system.
 *
 * Strategies (tried in order per failure class):
 *   - focus_recovery:   Re-focus the target window
 *   - screenshot_retry: Retake screenshot after a brief delay
 *   - escape_dismiss:   Press Escape to dismiss unexpected dialogs
 *   - alt_tab_recover:  Alt+Tab to return to the expected application
 *   - session_restart:  Stop and restart the computer session
 */

import type { ComputerAdapter, ActionResult } from "./computer-adapters/base.js";
import { computerSessionManager } from "./computer-session.js";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";

const log = childLogger("agent:computer-recovery");

// ── Types ─────────────────────────────────────────────────────────────────────

export type RecoveryReason =
  | "action_failed"
  | "focus_lost"
  | "dialog_blocking"
  | "stale_screenshot"
  | "adapter_unhealthy"
  | "timeout";

export interface RecoveryAttempt {
  reason: RecoveryReason;
  strategy: string;
  success: boolean;
  durationMs: number;
  detail: string;
}

export interface RecoveryResult {
  recovered: boolean;
  attempts: RecoveryAttempt[];
  finalStrategy: string | null;
}

// ── Strategy registry ─────────────────────────────────────────────────────────

interface RecoveryStrategy {
  name: string;
  appliesTo: RecoveryReason[];
  execute: (adapter: ComputerAdapter, sessionId: string, context: RecoveryContext) => Promise<RecoveryAttempt>;
}

interface RecoveryContext {
  reason: RecoveryReason;
  failedAction?: string;
  expectedWindow?: string;
  lastError?: string;
}

const strategies: RecoveryStrategy[] = [
  {
    name: "screenshot_retry",
    appliesTo: ["stale_screenshot", "action_failed"],
    execute: async (adapter, sessionId) => {
      const start = Date.now();
      try {
        await delay(500);
        const snapshot = await adapter.captureSnapshot();
        const ok = snapshot.screenshotHash.length > 0;
        return {
          reason: "stale_screenshot",
          strategy: "screenshot_retry",
          success: ok,
          durationMs: Date.now() - start,
          detail: ok ? "Retook screenshot successfully" : "Screenshot retry returned empty image",
        };
      } catch (err) {
        return {
          reason: "stale_screenshot",
          strategy: "screenshot_retry",
          success: false,
          durationMs: Date.now() - start,
          detail: `Screenshot retry threw: ${(err as Error).message}`,
        };
      }
    },
  },

  {
    name: "escape_dismiss",
    appliesTo: ["dialog_blocking", "focus_lost"],
    execute: async (adapter, sessionId, context) => {
      const start = Date.now();
      try {
        const result = await adapter.executeAction({
          type: "hotkey",
          keys: "Escape",
        });
        await delay(300);
        const healthy = await adapter.isHealthy();
        return {
          reason: context.reason,
          strategy: "escape_dismiss",
          success: result.success && healthy,
          durationMs: Date.now() - start,
          detail: result.success ? "Pressed Escape to dismiss dialog" : `Escape failed: ${result.error}`,
        };
      } catch (err) {
        return {
          reason: context.reason,
          strategy: "escape_dismiss",
          success: false,
          durationMs: Date.now() - start,
          detail: `Escape dismiss threw: ${(err as Error).message}`,
        };
      }
    },
  },

  {
    name: "focus_recovery",
    appliesTo: ["focus_lost", "action_failed"],
    execute: async (adapter, sessionId, context) => {
      const start = Date.now();
      try {
        if (!context.expectedWindow) {
          return {
            reason: context.reason,
            strategy: "focus_recovery",
            success: false,
            durationMs: Date.now() - start,
            detail: "No expected window title to recover focus to",
          };
        }
        const result = await adapter.executeAction({
          type: "focus_window",
          titlePattern: context.expectedWindow,
        });
        return {
          reason: context.reason,
          strategy: "focus_recovery",
          success: result.success,
          durationMs: Date.now() - start,
          detail: result.success
            ? `Refocused window: ${context.expectedWindow}`
            : `Focus recovery failed: ${result.error}`,
        };
      } catch (err) {
        return {
          reason: context.reason,
          strategy: "focus_recovery",
          success: false,
          durationMs: Date.now() - start,
          detail: `Focus recovery threw: ${(err as Error).message}`,
        };
      }
    },
  },

  {
    name: "alt_tab_recover",
    appliesTo: ["focus_lost", "dialog_blocking"],
    execute: async (adapter, sessionId, context) => {
      const start = Date.now();
      try {
        const result = await adapter.executeAction({
          type: "hotkey",
          keys: "Alt+Tab",
        });
        await delay(500);
        return {
          reason: context.reason,
          strategy: "alt_tab_recover",
          success: result.success,
          durationMs: Date.now() - start,
          detail: result.success ? "Alt+Tab to switch application" : `Alt+Tab failed: ${result.error}`,
        };
      } catch (err) {
        return {
          reason: context.reason,
          strategy: "alt_tab_recover",
          success: false,
          durationMs: Date.now() - start,
          detail: `Alt+Tab threw: ${(err as Error).message}`,
        };
      }
    },
  },

  {
    name: "session_restart",
    appliesTo: ["adapter_unhealthy", "timeout"],
    execute: async (_adapter, sessionId, context) => {
      const start = Date.now();
      try {
        computerSessionManager.emergencyStop(sessionId, `recovery:${context.reason}`);
        return {
          reason: context.reason,
          strategy: "session_restart",
          success: true,
          durationMs: Date.now() - start,
          detail: `Session ${sessionId} emergency stopped for recovery`,
        };
      } catch (err) {
        return {
          reason: context.reason,
          strategy: "session_restart",
          success: false,
          durationMs: Date.now() - start,
          detail: `Session restart failed: ${(err as Error).message}`,
        };
      }
    },
  },
];

// ── Public API ────────────────────────────────────────────────────────────────

const MAX_RECOVERY_ATTEMPTS = 3;

/**
 * Attempt automated recovery for a computer-use failure.
 * Tries applicable strategies in order until one succeeds or all fail.
 */
export async function attemptRecovery(
  adapter: ComputerAdapter,
  sessionId: string,
  reason: RecoveryReason,
  context: Omit<RecoveryContext, "reason"> = {},
): Promise<RecoveryResult> {
  const fullContext: RecoveryContext = { ...context, reason };
  const applicable = strategies.filter(s => s.appliesTo.includes(reason));
  const attempts: RecoveryAttempt[] = [];

  log.info({ sessionId, reason, strategyCount: applicable.length }, "Attempting recovery");

  for (const strategy of applicable.slice(0, MAX_RECOVERY_ATTEMPTS)) {
    const attempt = await strategy.execute(adapter, sessionId, fullContext);
    attempts.push(attempt);

    logAudit("computer_action", {
      computerSessionId: sessionId,
      actionType: `recovery:${strategy.name}`,
      success: attempt.success,
      durationMs: attempt.durationMs,
      detail: attempt.detail,
    });

    if (attempt.success) {
      log.info({ sessionId, strategy: strategy.name }, "Recovery succeeded");
      return { recovered: true, attempts, finalStrategy: strategy.name };
    }

    log.warn({ sessionId, strategy: strategy.name }, `Recovery strategy failed: ${attempt.detail}`);
  }

  log.error({ sessionId, reason, attemptCount: attempts.length }, "All recovery strategies exhausted");
  return { recovered: false, attempts, finalStrategy: null };
}

/**
 * Quick health check + recovery for an adapter before performing an action.
 * Returns true if the adapter is healthy (or was recovered).
 */
export async function ensureAdapterHealthy(
  adapter: ComputerAdapter,
  sessionId: string,
): Promise<boolean> {
  const healthy = await adapter.isHealthy();
  if (healthy) return true;

  const result = await attemptRecovery(adapter, sessionId, "adapter_unhealthy");
  return result.recovered;
}

// ── Internal ──────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
