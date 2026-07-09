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
import {
  durableApprovalsEnabled,
  recordApprovalDecision,
  pruneExpiredDecisions,
} from "./durable-store.js";

const log = childLogger("approval:store");

export interface PendingApproval {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  sceneName?: string;
  /** The shared secret used by outbound_webhook channels to authenticate callbacks */
  secret?: string;
  createdAt: string;
  /** Stable idempotency key (job + step + tool + args) for the durable decision cache. */
  idempotencyKey?: string;
}

interface Entry extends PendingApproval {
  resolve: (approved: boolean) => void;
  timeout: ReturnType<typeof setTimeout>;
  /** Absolute deadline (createdAt + timeoutMs). The safety-net prune honours
   *  this rather than a flat cap, so a legitimately long approval (durable) is
   *  not killed early. */
  expiresAt: number;
}

/** Cache a GRANTED approval so a post-restart re-run of the same scene step
 *  honours it instead of re-prompting. Denials and safety-net timeouts are
 *  never cached (a re-run re-prompts). No-op unless durableApprovals is on. */
function cacheApprovalIfGranted(entry: Entry, approved: boolean): void {
  if (approved && durableApprovalsEnabled() && entry.idempotencyKey) {
    recordApprovalDecision(entry.idempotencyKey, approved, entry.toolName);
  }
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
  /** Stable idempotency key enabling durable decision caching (async channels). */
  idempotencyKey?: string;
}): { id: string; promise: Promise<boolean> } {
  const id = randomUUID();
  let resolveOuter!: (approved: boolean) => void;
  const promise = new Promise<boolean>((resolve) => { resolveOuter = resolve; });

  const createdAt = new Date().toISOString();
  const entry: Entry = {
    id,
    toolName: opts.toolName,
    args: opts.args,
    sceneName: opts.sceneName,
    secret: opts.secret,
    idempotencyKey: opts.idempotencyKey,
    createdAt,
    expiresAt: Date.now() + opts.timeoutMs,
    resolve: resolveOuter,
    timeout: setTimeout(() => {
      _pending.delete(id);
      log.warn({ id, toolName: opts.toolName }, "Approval timed out — auto-denying");
      resolveOuter(false);
    }, opts.timeoutMs),
  };

  _pending.set(id, entry);

  logAudit("approval_requested", {
    approvalId: id,
    toolName: opts.toolName,
    sceneName: opts.sceneName,
    timeoutMs: opts.timeoutMs,
    durable: durableApprovalsEnabled() && Boolean(opts.idempotencyKey),
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
  cacheApprovalIfGranted(entry, approved);
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

/** List all currently-pending approvals (public-safe, no resolve fn / secret). */
export function listPendingApprovals(): PendingApproval[] {
  return [..._pending.values()].map((entry) => ({
    id: entry.id,
    toolName: entry.toolName,
    args: entry.args,
    sceneName: entry.sceneName,
    createdAt: entry.createdAt,
  }));
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

// Periodic safety-net sweep for orphaned approval entries: if an entry's own
// timeout somehow didn't fire, auto-deny once its real deadline (createdAt +
// timeoutMs) has passed. Honouring the per-entry deadline rather than a flat cap
// means a legitimately long approval (durable, hours-long timeout) is not killed
// early. Also prunes expired durable decision files (no-op unless the flag is on).
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of _pending) {
    if (now >= entry.expiresAt) {
      log.warn({ id, toolName: entry.toolName }, "Pruning stale approval entry past its deadline");
      clearTimeout(entry.timeout);
      _pending.delete(id);
      entry.resolve(false);
      logAudit("approval_resolved", {
        approvalId: id,
        approved: false,
        toolName: entry.toolName,
        reason: "stale_cleanup",
      }, { severity: "warn" });
    }
  }
  pruneExpiredDecisions();
}, 60_000).unref();
