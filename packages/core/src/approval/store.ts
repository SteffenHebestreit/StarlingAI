/**
 * In-memory store for pending human-in-the-loop approval requests.
 *
 * Each entry is keyed by a UUID approvalId and holds the resolve function of
 * the Promise that blocks the agent tool call.  Entries are auto-denied and
 * pruned when their timeout fires, or earlier when resolveApproval() is called.
 */
import { randomUUID } from "node:crypto";
import { childLogger } from "../logger.js";
import { logAudit } from "../audit/logger.js";

const log = childLogger("approval:store");

// Maximum age for any pending approval — safety net for orphaned entries
const MAX_APPROVAL_AGE_MS = 30 * 60 * 1000; // 30 minutes

export interface PendingApproval {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  sceneName?: string;
  /** The shared secret used by outbound_webhook channels to authenticate callbacks */
  secret?: string;
  createdAt: string;
}

interface Entry extends PendingApproval {
  resolve: (approved: boolean) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const _pending = new Map<string, Entry>();

/**
 * Create a new pending approval and return its ID + a Promise that resolves
 * to true (approved) or false (denied / timed out).
 */
export function createPendingApproval(opts: {
  toolName: string;
  args: Record<string, unknown>;
  timeoutMs: number;
  sceneName?: string;
  secret?: string;
}): { id: string; promise: Promise<boolean> } {
  const id = randomUUID();
  let resolveOuter!: (approved: boolean) => void;
  const promise = new Promise<boolean>((resolve) => { resolveOuter = resolve; });

  const timeout = setTimeout(() => {
    _pending.delete(id);
    log.warn({ id, toolName: opts.toolName }, "Approval timed out — auto-denying");
    resolveOuter(false);
  }, opts.timeoutMs);

  _pending.set(id, {
    id,
    toolName: opts.toolName,
    args: opts.args,
    sceneName: opts.sceneName,
    secret: opts.secret,
    createdAt: new Date().toISOString(),
    resolve: resolveOuter,
    timeout,
  });

  logAudit("approval_requested", {
    approvalId: id,
    toolName: opts.toolName,
    sceneName: opts.sceneName,
    timeoutMs: opts.timeoutMs,
  }, { severity: "info" });

  return { id, promise };
}

/**
 * Resolve a pending approval.  Returns true if the entry existed, false if it
 * was already resolved, timed out, or never existed.
 */
export function resolveApproval(id: string, approved: boolean): boolean {
  const entry = _pending.get(id);
  if (!entry) return false;
  clearTimeout(entry.timeout);
  _pending.delete(id);
  entry.resolve(approved);
  log.info({ id, approved, toolName: entry.toolName }, "Approval resolved");

  logAudit("approval_resolved", {
    approvalId: id,
    approved,
    toolName: entry.toolName,
    sceneName: entry.sceneName,
    pendingDurationMs: Date.now() - new Date(entry.createdAt).getTime(),
  }, { severity: approved ? "info" : "warn" });

  return true;
}

/** Return the public-safe metadata for a pending approval (no resolve fn). */
export function getPendingApproval(id: string): PendingApproval | undefined {
  const entry = _pending.get(id);
  if (!entry) return undefined;
  return {
    id: entry.id,
    toolName: entry.toolName,
    args: entry.args,
    sceneName: entry.sceneName,
    secret: entry.secret,
    createdAt: entry.createdAt,
  };
}

// Periodic cleanup sweep for orphaned approval entries
// Safety net: if timeout didn't fire (e.g., client disconnected), auto-deny after MAX_APPROVAL_AGE_MS
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of _pending) {
    const age = now - new Date(entry.createdAt).getTime();
    if (age > MAX_APPROVAL_AGE_MS) {
      log.warn({ id, toolName: entry.toolName, ageMs: age }, "Pruning stale approval entry");
      clearTimeout(entry.timeout);
      _pending.delete(id);
      entry.resolve(false);
      logAudit("approval_resolved", {
        approvalId: id,
        approved: false,
        toolName: entry.toolName,
        reason: "stale_cleanup",
        ageMs: age,
      }, { severity: "warn" });
    }
  }
}, 60_000).unref();
