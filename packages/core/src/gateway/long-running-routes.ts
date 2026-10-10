/**
 * Long-running-generation routes: the dashboard's dock of sub-agent runs that crossed a soft
 * threshold, and the operator's decision on one (continue / unbounded / stop). See
 * agent/long-running-generation.ts for the failure mode this addresses.
 *
 *   GET  /api/long-running/active        — the pending requests the caller may see
 *   POST /api/long-running/:id/respond   — decide one of them
 *
 * Moved out of gateway/index.ts with the ownership rule below.
 *
 * Under multi-user auth both routes only needed a valid token: every account listed every other
 * account's paused runs (agent names, the run's session ids, how long they had worked) and could
 * stop or unbound any of them. A request now belongs to the owner of the chat its run was started
 * from (its parentSessionId, followed back through nested runs to the chat), compared by identity
 * (ownsRecord): an account sees and decides its own; an admin sees and decides all. A request whose
 * chat this process does not hold, or that names none (an A2A or job run), or whose chat predates
 * account ids, is an admin's alone. Deciding also takes the operator role, as every mutation does.
 * With one operator both routes are as they were.
 */
import type { Hono } from "hono";
import { authenticatedUser, callerIdentity, extractBearerToken, userHasRole, verifyToken, type AuthenticatedUser } from "./auth.js";
import { getConfig } from "../config/loader.js";
import { longRunningGenerationManager, type LongRunningRequest } from "../agent/long-running-generation.js";
import { getSessionRecord } from "../agent/session.js";
import { rootSessionOf } from "../agent/session-ids.js";
import { ownsRecord } from "../runtime/user-scope.js";

/** Whether `user` may see and decide a long-running request under multi-user auth. */
function mayHandleLongRunningRequest(user: AuthenticatedUser | null, request: LongRunningRequest): boolean {
  if (userHasRole(user, "admin")) return true;
  if (!request.parentSessionId) return false;
  const chat = getSessionRecord(rootSessionOf(request.parentSessionId, ["sub:", "workflow:"]));
  return chat !== undefined && ownsRecord(callerIdentity(user), chat.identity());
}

export function registerLongRunningRoutes(app: Hono): void {
  app.get("/api/long-running/active", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const pending = longRunningGenerationManager.listPending();
    if (getConfig().auth?.enabled !== true) return c.json(pending);
    const user = await authenticatedUser(c.req.header("Authorization"));
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    return c.json(pending.filter((request) => mayHandleLongRunningRequest(user, request)));
  });

  app.post("/api/long-running/:id/respond", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    let body: { outcome?: unknown };
    try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
    const outcome = typeof body.outcome === "string" ? body.outcome : "";
    if (outcome !== "continue" && outcome !== "unbounded" && outcome !== "stop") {
      return c.json({ error: "outcome must be one of: continue, unbounded, stop" }, 400);
    }
    const user = await authenticatedUser(c.req.header("Authorization"));
    if (getConfig().auth?.enabled === true) {
      if (!user) return c.json({ error: "Unauthorized" }, 401);
      if (!userHasRole(user, "operator")) return c.json({ error: "Operator role required" }, 403);
      // Another account's request reads as one that does not exist: the reply says nothing of it.
      const request = longRunningGenerationManager.getRequest(c.req.param("id"));
      if (!request || !mayHandleLongRunningRequest(user, request)) {
        return c.json({ error: "Request not found or already resolved" }, 404);
      }
    }
    const resolved = longRunningGenerationManager.resolveRequest(
      c.req.param("id"),
      outcome,
      user?.username ?? "operator",
    );
    if (!resolved) return c.json({ error: "Request not found or already resolved" }, 404);
    return c.json({ ok: true, request: resolved });
  });
}
