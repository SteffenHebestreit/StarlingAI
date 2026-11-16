/**
 * Interactive computer-use + browser session dashboard routes.
 *
 *   /api/computer-sessions[...]  — list / get / active / emergency-stop /
 *                                  heartbeat / config for computer-use sessions
 *   /api/browser-sessions[...]   — list / get / active / config / resolve-assist
 *                                  for the noVNC live-preview + human-handoff flow
 *
 * The live browser pixels travel over the authenticated WS proxy at
 * /ws/browser-vnc/:id (wired in the gateway's upgrade dispatcher); these REST
 * routes carry the state (which sessions are live, which wait on a human, the
 * operator's "I solved it — continue" resolution).
 *
 * Extracted verbatim from gateway/index.ts (god-file seam). Closure-free —
 * module-level auth/getConfig + the module-singleton session managers.
 *
 * Under multi-user auth a session is its owner's (gateway/session-route-access.ts): the owner of
 * the chat that holds a computer session's lease, or that delegated a browser run, sees it whole
 * and drives it, and so does an admin. A session the caller may not use answers as a missing one
 * does. Any operator may emergency-stop any computer session, and sees the others in a listing
 * without their frames, window text or lease owner. The computer-use config (node hosts, the
 * remote-access URL, credential variable names) is an admin's; anyone else learns whether computer
 * use is on.
 */
import type { Context, Hono } from "hono";
import { verifyToken, extractBearerToken, authenticatedUser, callerIdentity, type AuthenticatedUser } from "./auth.js";
import { getConfig } from "../config/loader.js";
import { computerSessionManager, type SessionControlActor } from "../agent/computer-session.js";
import { browserSessionManager } from "../agent/browser-session.js";
import {
  callerHasRank,
  callerMayUseBrowserSession,
  callerMayUseComputerSession,
  computerSessionsVisibleTo,
} from "./session-route-access.js";

/** The request's caller, or null when it carries no valid token (the route answers 401). */
async function routeCaller(c: Context): Promise<{ user: AuthenticatedUser | null } | null> {
  const header = c.req.header("Authorization");
  const token = extractBearerToken(header);
  if (!token || !await verifyToken(token)) return null;
  return { user: await authenticatedUser(header) };
}

/** The caller as a stop or a handoff records it: who the token resolved to, never client text. */
function restActor(user: AuthenticatedUser | null): SessionControlActor {
  const identity = callerIdentity(user);
  return { ...(identity ? { identity } : {}), ...(user ? { role: user.role } : {}), via: "rest" };
}

const OPERATOR_REQUIRED = { error: "Operator role required for this action" } as const;

export function registerSessionDashboardRoutes(app: Hono): void {
  // ── Computer-use session routes ────────────────────────────────────────────

  app.get("/api/computer-sessions", async (c) => {
    const caller = await routeCaller(c);
    if (!caller) return c.json({ error: "Unauthorized" }, 401);
    return c.json(computerSessionsVisibleTo(caller.user, computerSessionManager.listSessions()));
  });

  app.get("/api/computer-sessions/active", async (c) => {
    const caller = await routeCaller(c);
    if (!caller) return c.json({ error: "Unauthorized" }, 401);
    return c.json(computerSessionsVisibleTo(caller.user, computerSessionManager.listActiveSessions()));
  });

  // MUST stay ahead of "/:id" — Hono matches in registration order, so a later
  // literal route is shadowed by an earlier parameterized one ("config" would be
  // read as a session id and always 404).
  app.get("/api/computer-sessions/config", async (c) => {
    const caller = await routeCaller(c);
    if (!caller) return c.json({ error: "Unauthorized" }, 401);
    const cfg = getConfig();
    const computerUse = (cfg as Record<string, unknown>)["computerUse"] ?? {};
    // The block names node hosts and ports, the remote-access URL and credential variables: an
    // admin's. Anyone else gets whether it is on, as /api/browser-sessions/config answers, which is
    // what the e2e harness's computer-desktop probe reads (as an operator).
    if (!callerHasRank(caller.user, "admin")) {
      return c.json({ enabled: (computerUse as { enabled?: unknown }).enabled === true });
    }
    return c.json(computerUse);
  });

  app.get("/api/computer-sessions/:id", async (c) => {
    const caller = await routeCaller(c);
    if (!caller) return c.json({ error: "Unauthorized" }, 401);
    const session = computerSessionManager.getSession(c.req.param("id"));
    if (!session || !callerMayUseComputerSession(caller.user, session)) return c.json({ error: "Session not found" }, 404);
    return c.json(session);
  });

  app.post("/api/computer-sessions/:id/emergency-stop", async (c) => {
    const caller = await routeCaller(c);
    if (!caller) return c.json({ error: "Unauthorized" }, 401);
    // Operator rank, for any session, as for every REST POST under multi-user auth (the gateway's role
    // gate refuses a viewer's before this route runs). The socket draws the same line: its
    // computer.emergency_stop needs operator rank too (gateway/rpc-policy.ts).
    if (!callerHasRank(caller.user, "operator")) return c.json(OPERATOR_REQUIRED, 403);
    const id = c.req.param("id");
    const body = await c.req.json<{ reason?: unknown }>().catch((): { reason?: unknown } => ({}));
    const reason = String(body?.reason ?? "api:manual_stop");
    computerSessionManager.emergencyStop(id, restActor(caller.user), reason);
    return c.json({ ok: true });
  });

  app.post("/api/computer-sessions/:id/heartbeat", async (c) => {
    const caller = await routeCaller(c);
    if (!caller) return c.json({ error: "Unauthorized" }, 401);
    const id = c.req.param("id");
    const session = computerSessionManager.getSession(id);
    if (!session || !callerMayUseComputerSession(caller.user, session)) return c.json({ error: "Session not found" }, 404);
    computerSessionManager.heartbeat(id);
    return c.json({ ok: true });
  });

  // ── Browser-session routes (noVNC live preview + human handoff) ──────────────
  // The live pixels travel over the authenticated WS proxy at /ws/browser-vnc/:id
  // (wired in the upgrade dispatcher below); these REST routes carry the state:
  // which sessions are live, which are waiting on a human, and the operator's
  // "I solved it — continue" resolution.

  // Tells the dashboard whether to offer the browser preview at all (a backend
  // must be reachable) without leaking the internal target.
  app.get("/api/browser-sessions/config", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const enabled = browserSessionManager.isEnabled();
    // Probe the backend only when the feature is configured at all — saves a
    // pointless TCP attempt when the env var is empty.
    const reachable = enabled ? await browserSessionManager.pingBackend() : false;
    return c.json({ enabled, reachable });
  });

  app.get("/api/browser-sessions", async (c) => {
    const caller = await routeCaller(c);
    if (!caller) return c.json({ error: "Unauthorized" }, 401);
    return c.json(browserSessionManager.listSessions().filter((session) => callerMayUseBrowserSession(caller.user, session)));
  });

  app.get("/api/browser-sessions/active", async (c) => {
    const caller = await routeCaller(c);
    if (!caller) return c.json({ error: "Unauthorized" }, 401);
    return c.json(browserSessionManager.listActiveSessions().filter((session) => callerMayUseBrowserSession(caller.user, session)));
  });

  app.get("/api/browser-sessions/:id", async (c) => {
    const caller = await routeCaller(c);
    if (!caller) return c.json({ error: "Unauthorized" }, 401);
    const session = browserSessionManager.getSession(c.req.param("id"));
    if (!session || !callerMayUseBrowserSession(caller.user, session)) return c.json({ error: "Session not found" }, 404);
    return c.json(session);
  });

  // Operator clicked "I solved it — continue" — unblocks the waiting agent. The owner of the run
  // (or an admin) answers it, and a viewer, who may change nothing, does not.
  app.post("/api/browser-sessions/:id/resolve-assist", async (c) => {
    const caller = await routeCaller(c);
    if (!caller) return c.json({ error: "Unauthorized" }, 401);
    if (!callerHasRank(caller.user, "operator")) return c.json(OPERATOR_REQUIRED, 403);
    const id = c.req.param("id");
    const session = browserSessionManager.getSession(id);
    if (!session || !callerMayUseBrowserSession(caller.user, session)) return c.json({ error: "Session not found" }, 404);
    const ok = browserSessionManager.resolveAssist(id, caller.user ? restActor(caller.user) : "operator");
    if (!ok) return c.json({ error: "Session not found" }, 404);
    return c.json({ ok: true });
  });
}
