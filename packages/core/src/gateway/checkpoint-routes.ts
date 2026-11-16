/**
 * Long-running-task checkpoint routes for the Swarm dashboard.
 *
 *   GET  /api/checkpoints                    — list checkpoints (filter status/agent)
 *   POST /api/checkpoints/:taskId/resume     — resume a paused checkpoint
 *   POST /api/checkpoints/:taskId/complete   — mark a checkpoint complete
 *
 * Extracted verbatim from gateway/index.ts (god-file seam). Closure-free —
 * module-level auth + the swarm/checkpoints store helpers.
 *
 * A checkpoint holds a delegated run's task, progress note, work summary and saved state, so it is
 * listed and acted on only by a caller it belongs to (callerMayUseCheckpoint), every one of them by
 * an admin, and by anyone with auth off. All three routes served every account's checkpoints to any
 * caller that signed in.
 */
import type { Hono } from "hono";
import { getConfig } from "../config/loader.js";
import type { Identity } from "../runtime/accounts.js";
import { ownsRecord, recordHasOwner } from "../runtime/user-scope.js";
import { verifyToken, extractBearerToken, authenticatedUser, callerIdentity, userHasRole, type AuthenticatedUser } from "./auth.js";
import { callerMayUseSession, owningChatSessionId } from "./session-route-access.js";
import { getCheckpoint, listCheckpoints, resumeCheckpoint, completeCheckpoint, type TaskCheckpoint } from "../swarm/checkpoints.js";

/**
 * The owner the run stamped on a checkpoint, or undefined. A record read back from disk is not
 * checked for shape, so an owner that is not an identity naming someone counts as none.
 */
function stampedOwner(checkpoint: TaskCheckpoint): Identity | undefined {
  const owner: unknown = checkpoint.owner;
  if (typeof owner !== "object" || owner === null) return undefined;
  const fields = owner as Record<string, unknown>;
  if (["userId", "account", "principal"].some((key) => fields[key] !== undefined && typeof fields[key] !== "string")) return undefined;
  return recordHasOwner(owner as Identity) ? owner as Identity : undefined;
}

/**
 * Whether `caller` may see and act on a checkpoint: with auth off and for an admin, every one.
 *
 * Otherwise the run's own: the account it executed as, which it stamped on the checkpoint
 * (TaskCheckpoint.owner), compared by identity (ownsRecord). Not the chat the run was delegated
 * from: an A2A or MCP run works in a session that has no record, and a scene job's session is
 * pruned an hour after the job while its checkpoints are kept a day, so the account's own runs
 * would have been an admin's alone. One that names no owner (written before owners were stamped,
 * or by a run that executed as nobody) is the chat's (callerMayUseSession), and with no chat
 * behind it, an admin's.
 */
function callerMayUseCheckpoint(caller: AuthenticatedUser | null, checkpoint: TaskCheckpoint): boolean {
  if (getConfig().auth?.enabled !== true || userHasRole(caller, "admin")) return true;
  const owner = stampedOwner(checkpoint);
  if (owner) return ownsRecord(callerIdentity(caller), owner);
  // One with no parent session is nobody's.
  const parentSessionId = typeof checkpoint.parentSessionId === "string" ? checkpoint.parentSessionId : "";
  return callerMayUseSession(caller, owningChatSessionId(parentSessionId));
}

/** A checkpoint as the routes send it: whose it is decides who gets it, and is no part of it. */
function checkpointForWire(checkpoint: TaskCheckpoint): Omit<TaskCheckpoint, "owner"> {
  const { owner, ...wire } = checkpoint;
  return wire;
}

/** A checkpoint id `caller` may act on, or undefined: one it may not use reads as not found. */
async function checkpointOfCaller(authHeader: string | undefined, taskId: string): Promise<TaskCheckpoint | undefined> {
  const checkpoint = getCheckpoint(taskId);
  if (!checkpoint) return undefined;
  return callerMayUseCheckpoint(await authenticatedUser(authHeader), checkpoint) ? checkpoint : undefined;
}

export function registerCheckpointRoutes(app: Hono): void {
  // ── Long-running task checkpoints ─────────────────────────────────────────
  app.get("/api/checkpoints", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const statusParam = c.req.query("status");
    const agentName = c.req.query("agentName");
    const validStatuses = ["active", "paused", "resumed", "completed", "failed"] as const;
    type CS = typeof validStatuses[number];
    const status = validStatuses.includes(statusParam as CS) ? (statusParam as CS) : undefined;
    const caller = await authenticatedUser(c.req.header("Authorization"));
    const checkpoints = listCheckpoints({ status, agentName })
      .filter((checkpoint) => callerMayUseCheckpoint(caller, checkpoint))
      .map(checkpointForWire);
    return c.json({ checkpoints });
  });

  app.post("/api/checkpoints/:taskId/resume", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const taskId = c.req.param("taskId");
    // Someone else's checkpoint gets the reply a missing one gets, so the id is not confirmed.
    const cp = await checkpointOfCaller(c.req.header("Authorization"), taskId) ? resumeCheckpoint(taskId) : null;
    if (!cp) return c.json({ error: "Checkpoint not found or not in paused state" }, 404);
    return c.json({ checkpoint: checkpointForWire(cp) });
  });

  app.post("/api/checkpoints/:taskId/complete", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const taskId = c.req.param("taskId");
    const ok = await checkpointOfCaller(c.req.header("Authorization"), taskId) ? completeCheckpoint(taskId) : false;
    if (!ok) return c.json({ error: "Checkpoint not found" }, 404);
    return c.json({ success: true, taskId });
  });
}
