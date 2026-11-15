/**
 * Routed approvals: per-call approvals that go to the people who may grant them.
 *
 * A tool's approval normally goes wherever the call's approval callback reaches. For a chat that is
 * the requester's own socket, so the person who asked approves their own call, and nobody else ever
 * sees it. A tool that declares an approval policy (guardrails/tool-tiers.ts ToolApprovalPolicy)
 * names the roles that may grant it. executeTool keeps the requester's own approval card only for
 * the person who sent the message, in a chat of their own, with a role that policy admits now
 * (RequestContext.sender); every other call comes here: it waits in the approval store as a
 * "routed" entry, which only a signed-in caller the policy admits can list and decide (the operator
 * requests in the dashboard, POST /api/approval/:id), and the approvers are told it is waiting.
 */
import { childLogger } from "../logger.js";
import { logAudit } from "../audit/logger.js";
import { holdTurnClocks } from "../agent/user-input-broker.js";
import { publishNotification } from "../runtime/notifications.js";
import type { Identity } from "../runtime/accounts.js";
import {
  cancelPendingApproval,
  createPendingApproval,
  getPendingApproval,
  resolveApproval,
  routedApproverRefusal,
  type ApprovalDecider,
} from "./store.js";

const log = childLogger("approval:routed");

/** A tool call that now waits for an approver, as the requester is told of it. */
export interface ApprovalPendingEvent {
  approvalId: string;
  toolName: string;
  approverRoles: readonly string[];
  distinctApprover: boolean;
  expiresAt: string;
}

export type ApprovalPendingOutcome = "approved" | "denied" | "timeout" | "cancelled";

/**
 * Told when a call starts waiting for someone else's approval. It may return a function, which is
 * called once with how the wait ended.
 */
export type ApprovalPendingListener = (
  event: ApprovalPendingEvent,
) => void | ((outcome: ApprovalPendingOutcome) => void);

type ApprovalCallback = (toolName: string, args: Record<string, unknown>) => Promise<boolean>;

const requesterCallbacks = new WeakSet<ApprovalCallback>();

/**
 * Mark an approval callback as one that puts the question to the person who made the request (a
 * chat's own approval card), and returns it. Only a marked callback can serve a requester an
 * approval policy admits: an unmarked one may answer by itself (`--auto`, the legacy A2A route's
 * autoApprove, a scene's channel that anyone holding the link can answer), so a call through it is
 * routed. Sub-agents receive the parent's callback itself, so the mark travels with it.
 */
export function requesterApprovalCallback<T extends ApprovalCallback>(callback: T): T {
  requesterCallbacks.add(callback);
  return callback;
}

/** Whether a callback was marked by requesterApprovalCallback. */
export function isRequesterApprovalCallback(callback: ApprovalCallback | undefined): boolean {
  return callback !== undefined && requesterCallbacks.has(callback);
}

export interface RoutedApprovalRequest {
  toolName: string;
  args: Record<string, unknown>;
  /** The session the call was made in: the wait holds its run's clocks (holdTurnClocks). */
  sessionId?: string;
  /** Who asked, and as which role: the person who sent the message (RequestContext.sender), else
   *  the call's own. A second person (`distinctApprover`) is anyone but them. */
  requester?: Identity;
  requesterRole?: string;
  approverRoles: readonly string[];
  distinctApprover?: boolean;
  timeoutMs: number;
  /** The turn's abort signal: a stopped turn withdraws its request. */
  signal?: AbortSignal;
  onPending?: ApprovalPendingListener;
}

export interface RoutedApprovalResult {
  /** True only for a grant by a signed-in approver (decidedBy set). */
  approved: boolean;
  outcome: ApprovalPendingOutcome;
  approvalId?: string;
  decidedBy?: ApprovalDecider;
}

/** Put the call to the approvers and wait for their decision; a timeout or a stopped turn denies. */
export async function requestRoutedApproval(request: RoutedApprovalRequest): Promise<RoutedApprovalResult> {
  if (request.signal?.aborted) return { approved: false, outcome: "cancelled" };
  const distinctApprover = request.distinctApprover === true;
  const { id, decision, expiresAt } = createPendingApproval({
    kind: "routed",
    toolName: request.toolName,
    args: request.args,
    timeoutMs: request.timeoutMs,
    approverRoles: request.approverRoles,
    distinctApprover,
    ...(request.requester ? { requester: request.requester } : {}),
    ...(request.requesterRole ? { requesterRole: request.requesterRole } : {}),
    ...(request.sessionId ? { sessionId: request.sessionId } : {}),
  });

  // No arguments: they can hold anything the call is about, and the audit outlives the request.
  logAudit("approval_routed_requested", {
    tool: request.toolName,
    approvalId: id,
    approverRoles: [...request.approverRoles],
    requester: request.requester?.userId ?? null,
    requesterRole: request.requesterRole ?? null,
    distinctApprover,
  }, {
    ...(request.sessionId ? { sessionId: request.sessionId } : {}),
    ...(request.requester?.userId ? { userId: request.requester.userId } : {}),
    severity: "info",
  });

  try {
    publishNotification({
      title: "Approval needed",
      message: `${request.requester?.userId ?? "A run"} asks to run ${request.toolName}. `
        + `${request.approverRoles.join(" or ")} can decide it under Operator requests.`,
      level: "warn",
      category: "approval",
      audienceRoles: request.approverRoles,
    });
  } catch (err) {
    log.warn({ err, approvalId: id }, "Could not notify the approvers of a routed approval");
  }

  let settleListener: ((outcome: ApprovalPendingOutcome) => void) | undefined;
  try {
    const settle = request.onPending?.({
      approvalId: id,
      toolName: request.toolName,
      approverRoles: request.approverRoles,
      distinctApprover,
      expiresAt,
    });
    if (typeof settle === "function") settleListener = settle;
  } catch (err) {
    log.warn({ err, approvalId: id }, "Could not tell the requester that a call waits for an approver");
  }

  const withdraw = () => { cancelPendingApproval(id); };
  request.signal?.addEventListener("abort", withdraw, { once: true });
  // The run waits for a person, as it does for ask_user, and one at another workstation: the wait
  // holds the run's clocks (its turn deadline, the chat's watchdog, a sub-agent's deadline) and
  // credits them its length, so `timeoutMs` bounds it, not what is left of the turn's budget.
  const releaseClocks = request.sessionId ? holdTurnClocks(request.sessionId, "routed_approval") : undefined;
  let result;
  try {
    result = await decision;
  } finally {
    releaseClocks?.();
    request.signal?.removeEventListener("abort", withdraw);
  }

  const approved = result.approved && result.reason === "decided" && result.decidedBy !== undefined;
  const outcome: ApprovalPendingOutcome = result.reason === "decided" ? (approved ? "approved" : "denied") : result.reason;
  logAudit("approval_routed_resolved", {
    tool: request.toolName,
    approvalId: id,
    approved,
    outcome,
    decidedBy: result.decidedBy?.identity?.userId ?? null,
    role: result.decidedBy?.role ?? null,
  }, {
    ...(request.sessionId ? { sessionId: request.sessionId } : {}),
    severity: approved ? "info" : "warn",
  });
  try {
    settleListener?.(outcome);
  } catch (err) {
    log.warn({ err, approvalId: id }, "Could not tell the requester how a routed approval ended");
  }
  return { approved, outcome, approvalId: id, ...(result.decidedBy ? { decidedBy: result.decidedBy } : {}) };
}

/** How a signed-in caller's answer to a routed approval went. */
export type RoutedDecision =
  | { outcome: "decided" }
  | { outcome: "not_found" }
  | { outcome: "refused"; reason: "not_approver" | "requester"; approverRoles: readonly string[] };

/**
 * A signed-in caller's answer to a routed approval (POST /api/approval/:id): refused unless the
 * policy admits the caller's role and, with a second person required, the caller is not the
 * requester. A decision records who made it. "not_found" when the id names no routed approval that
 * is still pending (another approver may have just decided it).
 */
export function decideRoutedApproval(
  id: string,
  approved: boolean,
  caller: { identity?: Identity; role: string },
): RoutedDecision {
  const pending = getPendingApproval(id);
  if (pending?.kind !== "routed") return { outcome: "not_found" };
  const refusal = routedApproverRefusal(pending, caller);
  if (refusal) return { outcome: "refused", reason: refusal, approverRoles: pending.approverRoles ?? [] };
  const decidedBy: ApprovalDecider = { ...(caller.identity ? { identity: caller.identity } : {}), role: caller.role };
  return resolveApproval(id, approved, decidedBy) ? { outcome: "decided" } : { outcome: "not_found" };
}
