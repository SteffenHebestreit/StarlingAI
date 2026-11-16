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
import { policyAdmitsRole } from "../gateway/route-policies.js";
import { sameAccountId, type Identity } from "../runtime/accounts.js";
import {
  durableApprovalsEnabled,
  recordApprovalDecision,
  pruneExpiredDecisions,
} from "./durable-store.js";

const log = childLogger("approval:store");

/**
 * - "channel": a scene or job run's approval sent to an approval channel (Slack, a webhook),
 *   decided with its secret, or by an operator from the dashboard.
 * - "routed": a tool call whose approval policy names who may grant it (approval/routed.ts),
 *   decided only by a signed-in caller that policy admits. It has no secret.
 */
export type PendingApprovalKind = "channel" | "routed";

export interface PendingApproval {
  id: string;
  kind: PendingApprovalKind;
  toolName: string;
  args: Record<string, unknown>;
  sceneName?: string;
  /** The shared secret used by outbound_webhook channels to authenticate callbacks */
  secret?: string;
  createdAt: string;
  /** Stable idempotency key (job + step + tool + args) for the durable decision cache. */
  idempotencyKey?: string;
  /** Routed only: the roles that may decide it (policyAdmitsRole). */
  approverRoles?: readonly string[];
  /** Routed only: the requester may not decide it, whatever their role. */
  distinctApprover?: boolean;
  /** Routed only: who asked, and as which role (unset when it is not known). */
  requester?: Identity;
  requesterRole?: string;
  /** Routed only: the session the call was made in. Kept here, never listed. */
  sessionId?: string;
}

/** Who decided an approval, when a signed-in caller did. */
export interface ApprovalDecider {
  identity?: Identity;
  role: string;
}

/** How a pending approval ended. */
export interface ApprovalDecision {
  approved: boolean;
  /** Set when a caller decided it through resolveApproval with their identity. */
  decidedBy?: ApprovalDecider;
  reason: "decided" | "timeout" | "cancelled";
}

/**
 * The caller a listing is for: who they are, their role, and whether they hold operator rank
 * (gateway/auth.ts userHasRole), which channel approvals need.
 */
export interface ApprovalViewer {
  identity?: Identity;
  role: string;
  operatorRank: boolean;
}

/** A pending approval as it is listed: no secret, no idempotency key, no session. */
export interface PendingApprovalView {
  id: string;
  kind: PendingApprovalKind;
  toolName: string;
  args: Record<string, unknown>;
  sceneName?: string;
  createdAt: string;
  approverRoles?: readonly string[];
  distinctApprover?: boolean;
  /** The requester's name. */
  requester?: string;
  requesterRole?: string;
  expiresAt?: string;
}

interface Entry extends PendingApproval {
  settle: (decision: ApprovalDecision) => void;
  timeout: ReturnType<typeof setTimeout>;
  /** Absolute deadline (createdAt + timeoutMs). The safety-net prune honours
   *  this rather than a flat cap, so a legitimately long approval (durable) is
   *  not killed early. */
  expiresAt: number;
}

/**
 * Whether two identities may be the same person, for a rule that needs a second one. Account ids
 * decide when both carry one; otherwise the names do, so two records of one person, one written
 * with an account and one without, still count as one. An identity that is not known matches none.
 */
export function maybeSamePerson(left: Identity | undefined, right: Identity | undefined): boolean {
  if (!left || !right) return false;
  if (left.account && right.account) return sameAccountId(left.account, right.account);
  return left.userId !== undefined && left.userId === right.userId;
}

/**
 * Why `caller` may not decide a routed approval, or undefined when they may: "not_approver" when
 * their role is not one the policy admits, "requester" when a second person must approve and they
 * asked for it.
 */
export function routedApproverRefusal(
  entry: Pick<PendingApproval, "approverRoles" | "distinctApprover" | "requester">,
  caller: { identity?: Identity; role: string },
): "not_approver" | "requester" | undefined {
  if (!policyAdmitsRole({ roles: [...(entry.approverRoles ?? [])] }, caller.role)) return "not_approver";
  if (entry.distinctApprover && maybeSamePerson(caller.identity, entry.requester)) return "requester";
  return undefined;
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
 * to true (approved) or false (denied / timed out). `decision` resolves at the
 * same moment with how it ended and, for a routed approval, who decided it.
 */
export function createPendingApproval(opts: {
  toolName: string;
  args: Record<string, unknown>;
  timeoutMs: number;
  sceneName?: string;
  secret?: string;
  /** Stable idempotency key enabling durable decision caching (async channels). */
  idempotencyKey?: string;
  /** Defaults to "channel". A routed approval never carries a secret. */
  kind?: PendingApprovalKind;
  approverRoles?: readonly string[];
  distinctApprover?: boolean;
  requester?: Identity;
  requesterRole?: string;
  sessionId?: string;
}): { id: string; promise: Promise<boolean>; decision: Promise<ApprovalDecision>; expiresAt: string } {
  const id = randomUUID();
  let settleOuter!: (decision: ApprovalDecision) => void;
  const decision = new Promise<ApprovalDecision>((resolve) => { settleOuter = resolve; });
  const promise = decision.then((outcome) => outcome.approved);
  const kind = opts.kind ?? "channel";

  const createdAt = new Date().toISOString();
  const expiresAt = Date.now() + opts.timeoutMs;
  const entry: Entry = {
    id,
    kind,
    toolName: opts.toolName,
    args: opts.args,
    sceneName: opts.sceneName,
    secret: kind === "routed" ? undefined : opts.secret,
    idempotencyKey: opts.idempotencyKey,
    createdAt,
    ...(kind === "routed"
      ? {
        approverRoles: [...(opts.approverRoles ?? [])],
        ...(opts.distinctApprover ? { distinctApprover: true } : {}),
        ...(opts.requester ? { requester: opts.requester } : {}),
        ...(opts.requesterRole ? { requesterRole: opts.requesterRole } : {}),
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      }
      : {}),
    expiresAt,
    settle: settleOuter,
    timeout: setTimeout(() => {
      _pending.delete(id);
      log.warn({ id, toolName: opts.toolName }, "Approval timed out — auto-denying");
      settleOuter({ approved: false, reason: "timeout" });
    }, opts.timeoutMs),
  };

  _pending.set(id, entry);

  logAudit("approval_requested", {
    approvalId: id,
    toolName: opts.toolName,
    sceneName: opts.sceneName,
    timeoutMs: opts.timeoutMs,
    durable: durableApprovalsEnabled() && Boolean(opts.idempotencyKey),
    ...(kind === "routed" ? { kind } : {}),
  }, { severity: "info" });

  return { id, promise, decision, expiresAt: new Date(expiresAt).toISOString() };
}

/**
 * Resolve a pending approval.  Returns true if the entry existed, false if it
 * was already resolved, timed out, or never existed. `decidedBy` is the
 * signed-in caller who decided it, recorded with the decision.
 */
export function resolveApproval(id: string, approved: boolean, decidedBy?: ApprovalDecider): boolean {
  const entry = _pending.get(id);
  if (!entry) return false;
  clearTimeout(entry.timeout);
  _pending.delete(id);
  cacheApprovalIfGranted(entry, approved);
  entry.settle({ approved, reason: "decided", ...(decidedBy ? { decidedBy } : {}) });
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

/**
 * Withdraw a pending approval nobody decided, because the call waiting on it is gone (its turn was
 * stopped). Denies it; returns false when it was no longer pending.
 */
export function cancelPendingApproval(id: string): boolean {
  const entry = _pending.get(id);
  if (!entry) return false;
  clearTimeout(entry.timeout);
  _pending.delete(id);
  entry.settle({ approved: false, reason: "cancelled" });
  logAudit("approval_resolved", {
    approvalId: id,
    approved: false,
    toolName: entry.toolName,
    reason: "cancelled",
  }, { severity: "warn" });
  return true;
}

/** Whether a listing for `viewer` shows this entry; every entry when there is no viewer. */
function visibleTo(entry: Entry, viewer: ApprovalViewer | undefined): boolean {
  if (!viewer) return true;
  // A routed approval goes to the people who may decide it, and not to a requester who may not.
  if (entry.kind === "routed") return routedApproverRefusal(entry, viewer) === undefined;
  // A channel approval, as the dashboard has always listed them, to whoever may decide one there:
  // operator rank (the gateway's mutation gate), not a viewer.
  return viewer.operatorRank;
}

/**
 * List currently-pending approvals (public-safe, no resolve fn / secret), the
 * ones `viewer` may decide. Without a viewer, every one: for in-process use
 * only; a listing for a caller always names them.
 */
export function listPendingApprovals(viewer?: ApprovalViewer): PendingApprovalView[] {
  return [..._pending.values()].filter((entry) => visibleTo(entry, viewer)).map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    toolName: entry.toolName,
    args: entry.args,
    sceneName: entry.sceneName,
    createdAt: entry.createdAt,
    ...(entry.kind === "routed"
      ? {
        approverRoles: entry.approverRoles,
        ...(entry.distinctApprover ? { distinctApprover: true } : {}),
        ...(entry.requester?.userId ? { requester: entry.requester.userId } : {}),
        ...(entry.requesterRole ? { requesterRole: entry.requesterRole } : {}),
        expiresAt: new Date(entry.expiresAt).toISOString(),
      }
      : {}),
  }));
}

/** Return the public-safe metadata for a pending approval (no resolve fn). */
export function getPendingApproval(id: string): PendingApproval | undefined {
  const entry = _pending.get(id);
  if (!entry) return undefined;
  return {
    id: entry.id,
    kind: entry.kind,
    toolName: entry.toolName,
    args: entry.args,
    sceneName: entry.sceneName,
    secret: entry.secret,
    createdAt: entry.createdAt,
    ...(entry.kind === "routed"
      ? {
        approverRoles: entry.approverRoles,
        ...(entry.distinctApprover ? { distinctApprover: true } : {}),
        ...(entry.requester ? { requester: entry.requester } : {}),
        ...(entry.requesterRole ? { requesterRole: entry.requesterRole } : {}),
        ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
      }
      : {}),
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
      entry.settle({ approved: false, reason: "timeout" });
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
