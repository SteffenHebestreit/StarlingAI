/**
 * UX-501 / UX-502: mission flight-recorder + mission controls.
 *
 *   GET  /api/missions            — recent missions with cost summary
 *   GET  /api/missions/:id        — full flight record: mission + events + budget
 *   POST /api/missions/:id/cancel — distributed-cancel the mission's root session
 *                                   (CTL-205) and record a terminal event ONLY
 *                                   when the cancel is confirmed to take effect
 *
 * The flight recorder is a cross-mission OPERATOR console — a mission's objective
 * is a free-text prompt and its events name other users' work — so every route
 * requires operator (rank ≥ operator, so admins pass too; viewers do not). The
 * check is in-handler via userHasRole (rank-based), the authoritative gate, so
 * it is exercised by unit tests on a bare app and an admin token is never
 * exact-match-rejected. Per-user scoping (letting a viewer see their OWN
 * missions) is a possible future refinement.
 */
import type { Hono } from "hono";
import { authenticatedUser, userHasRole } from "./auth.js";
import { getMissionFlightRecord, listMissionSummaries } from "../swarm/mission-flight-recorder.js";
import { cancelMission } from "../swarm/mission-control.js";

/** Mission ids are randomUUIDs; reject a malformed id as 404 before it reaches
 *  a store backend that would throw on the cast (Postgres uuid column). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerMissionRoutes(app: Hono): void {
  app.get("/api/missions", async (c) => {
    const user = await authenticatedUser(c.req.header("Authorization"));
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    if (!userHasRole(user, "operator")) return c.json({ error: "Operator role required" }, 403);
    const limitParam = Number(c.req.query("limit"));
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 500) : 100;
    return c.json({ missions: await listMissionSummaries(limit) });
  });

  app.get("/api/missions/:id", async (c) => {
    const user = await authenticatedUser(c.req.header("Authorization"));
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    if (!userHasRole(user, "operator")) return c.json({ error: "Operator role required" }, 403);
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "Mission not found" }, 404);
    const record = await getMissionFlightRecord(id);
    if (!record) return c.json({ error: "Mission not found" }, 404);
    return c.json(record);
  });

  app.post("/api/missions/:id/cancel", async (c) => {
    const user = await authenticatedUser(c.req.header("Authorization"));
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    if (!userHasRole(user, "operator")) return c.json({ error: "Operator role required" }, 403);
    const missionId = c.req.param("id");
    if (!UUID_RE.test(missionId)) return c.json({ error: "Mission not found" }, 404);

    const body = await c.req.json<{ reason?: string }>().catch((): { reason?: string } => ({}));
    const result = await cancelMission(missionId, { actor: user.username, reason: body.reason });

    switch (result.outcome) {
      case "not_found":
        return c.json({ error: "Mission not found" }, 404);
      case "already_terminal":
        return c.json({ ok: true, status: result.status, alreadyTerminal: true });
      case "unconfirmed":
        // The cancel was issued but could not be confirmed to stop the turn —
        // the mission stays active so the operator can retry, and the UI shows why.
        return c.json({ ok: false, status: "active", unconfirmed: true, commandId: result.commandId, reason: result.reason }, 409);
      case "cancelled":
        return c.json({ ok: true, status: "cancelled", commandId: result.commandId, abortedLocally: result.abortedLocally });
    }
  });
}
