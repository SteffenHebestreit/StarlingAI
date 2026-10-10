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
 *
 * Under multi-user auth the operator gate alone let every account read every other account's
 * missions (objectives, events, spend) and cancel their turns: operator is the role every account
 * gets by default. A mission now belongs to the owner of its root session (the chat it runs in),
 * else to the account stamped on it (account_id), compared by identity (ownsRecord): an account
 * lists, reads and cancels its own; an admin all of them. A mission that names no owner this process
 * can resolve, or only a name from before account ids, is an admin's alone. With one operator the
 * routes are as they were.
 */
import type { Hono } from "hono";
import { authenticatedUser, callerIdentity, userHasRole, type AuthenticatedUser } from "./auth.js";
import { getConfig } from "../config/loader.js";
import { getMissionFlightRecord, listMissionSummaries } from "../swarm/mission-flight-recorder.js";
import { cancelMission } from "../swarm/mission-control.js";
import { getMissionStore, type MissionRecord } from "../swarm/mission-store.js";
import { getSessionRecord } from "../agent/session.js";
import { ownsRecord } from "../runtime/user-scope.js";
import type { Identity } from "../runtime/accounts.js";

/** The most missions a listing returns, and the most it reads to find a non-admin's own. */
const MAX_LIST = 500;

/** Who a mission belongs to: its root session's owner while this process holds that session, else
 *  the account stamped on it (with the name it was stamped with), else the name alone. */
function missionOwner(mission: Pick<MissionRecord, "rootSessionId" | "userId" | "account">): Identity | undefined {
  const root = getSessionRecord(mission.rootSessionId)?.identity();
  if (root) return root;
  if (mission.account) return { userId: mission.userId ?? mission.account, account: mission.account };
  return mission.userId !== undefined ? { userId: mission.userId } : undefined;
}

/** Whether `user` may list, read or cancel a mission. Everyone with one operator; under multi-user
 *  auth an admin, or the mission's owner by identity. */
function mayUseMission(user: AuthenticatedUser, mission: Pick<MissionRecord, "rootSessionId" | "userId" | "account">): boolean {
  if (getConfig().auth?.enabled !== true) return true;
  if (userHasRole(user, "admin")) return true;
  return ownsRecord(callerIdentity(user), missionOwner(mission));
}

/** Mission ids are randomUUIDs; reject a malformed id as 404 before it reaches
 *  a store backend that would throw on the cast (Postgres uuid column). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerMissionRoutes(app: Hono): void {
  app.get("/api/missions", async (c) => {
    const user = await authenticatedUser(c.req.header("Authorization"));
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    if (!userHasRole(user, "operator")) return c.json({ error: "Operator role required" }, 403);
    const limitParam = Number(c.req.query("limit"));
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, MAX_LIST) : 100;
    if (getConfig().auth?.enabled !== true || userHasRole(user, "admin")) {
      return c.json({ missions: await listMissionSummaries(limit) });
    }
    // A non-admin's own, the newest first: read the widest window and keep `limit` of its own, so
    // other accounts' newer missions do not crowd its own out of a short page.
    const own = (await listMissionSummaries(MAX_LIST)).filter((mission) => mayUseMission(user, mission));
    return c.json({ missions: own.slice(0, limit) });
  });

  app.get("/api/missions/:id", async (c) => {
    const user = await authenticatedUser(c.req.header("Authorization"));
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    if (!userHasRole(user, "operator")) return c.json({ error: "Operator role required" }, 403);
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "Mission not found" }, 404);
    const record = await getMissionFlightRecord(id);
    // Another account's mission reads as missing: its id says nothing about whether it exists.
    if (!record || !mayUseMission(user, record.mission)) return c.json({ error: "Mission not found" }, 404);
    return c.json(record);
  });

  app.post("/api/missions/:id/cancel", async (c) => {
    const user = await authenticatedUser(c.req.header("Authorization"));
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    if (!userHasRole(user, "operator")) return c.json({ error: "Operator role required" }, 403);
    const missionId = c.req.param("id");
    if (!UUID_RE.test(missionId)) return c.json({ error: "Mission not found" }, 404);

    // Only a mission the caller may use is cancelled; checked before anything is changed.
    if (getConfig().auth?.enabled === true) {
      const mission = await (await getMissionStore()).getMission(missionId);
      if (!mission || !mayUseMission(user, mission)) return c.json({ error: "Mission not found" }, 404);
    }

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
