/**
 * Long-running-task checkpoint routes for the Swarm dashboard.
 *
 *   GET  /api/checkpoints                    — list checkpoints (filter status/agent)
 *   POST /api/checkpoints/:taskId/resume     — resume a paused checkpoint
 *   POST /api/checkpoints/:taskId/complete   — mark a checkpoint complete
 *
 * Extracted verbatim from gateway/index.ts (god-file seam). Closure-free —
 * module-level auth + the swarm/checkpoints store helpers.
 */
import type { Hono } from "hono";
import { verifyToken, extractBearerToken } from "./auth.js";
import { listCheckpoints, resumeCheckpoint, completeCheckpoint } from "../swarm/checkpoints.js";

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
    return c.json({ checkpoints: listCheckpoints({ status, agentName }) });
  });

  app.post("/api/checkpoints/:taskId/resume", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const taskId = c.req.param("taskId");
    const cp = resumeCheckpoint(taskId);
    if (!cp) return c.json({ error: "Checkpoint not found or not in paused state" }, 404);
    return c.json({ checkpoint: cp });
  });

  app.post("/api/checkpoints/:taskId/complete", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const taskId = c.req.param("taskId");
    const ok = completeCheckpoint(taskId);
    if (!ok) return c.json({ error: "Checkpoint not found" }, 404);
    return c.json({ success: true, taskId });
  });
}
