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
 */
import type { Hono } from "hono";
import { verifyToken, extractBearerToken, authenticatedUser } from "./auth.js";
import { getConfig } from "../config/loader.js";
import { computerSessionManager } from "../agent/computer-session.js";
import { browserSessionManager } from "../agent/browser-session.js";

export function registerSessionDashboardRoutes(app: Hono): void {
  // ── Computer-use session routes ────────────────────────────────────────────

  app.get("/api/computer-sessions", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    return c.json(computerSessionManager.listSessions());
  });

  app.get("/api/computer-sessions/active", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    return c.json(computerSessionManager.listActiveSessions());
  });

  // MUST stay ahead of "/:id" — Hono matches in registration order, so a later
  // literal route is shadowed by an earlier parameterized one ("config" would be
  // read as a session id and always 404).
  app.get("/api/computer-sessions/config", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const cfg = getConfig();
    const computerUse = (cfg as Record<string, unknown>)["computerUse"] ?? {};
    return c.json(computerUse);
  });

  app.get("/api/computer-sessions/:id", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const id = c.req.param("id");
    const sessions = computerSessionManager.listSessions();
    const session = sessions.find(s => s.id === id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    return c.json(session);
  });

  app.post("/api/computer-sessions/:id/emergency-stop", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const id = c.req.param("id");
    const body = await c.req.json<{ reason?: string }>().catch((): { reason?: string } => ({}));
    const reason = body.reason ?? "api:manual_stop";
    computerSessionManager.emergencyStop(id, reason);
    return c.json({ ok: true });
  });

  app.post("/api/computer-sessions/:id/heartbeat", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const id = c.req.param("id");
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
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    return c.json(browserSessionManager.listSessions());
  });

  app.get("/api/browser-sessions/active", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    return c.json(browserSessionManager.listActiveSessions());
  });

  app.get("/api/browser-sessions/:id", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const session = browserSessionManager.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "Session not found" }, 404);
    return c.json(session);
  });

  // Operator clicked "I solved it — continue" — unblocks the waiting agent.
  app.post("/api/browser-sessions/:id/resolve-assist", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const user = await authenticatedUser(c.req.header("Authorization"));
    const ok = browserSessionManager.resolveAssist(c.req.param("id"), user?.username ?? "operator");
    if (!ok) return c.json({ error: "Session not found" }, 404);
    return c.json({ ok: true });
  });
}
