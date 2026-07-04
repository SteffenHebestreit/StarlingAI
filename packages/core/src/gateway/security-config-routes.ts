/**
 * Site-credential + guardrail configuration routes for the operator dashboard.
 *
 *   GET/POST/DELETE /api/sites[/:hostname]   — per-host login credentials
 *   GET/PUT /api/guardrails, POST /reset      — runtime guardrail policy
 *
 * Extracted verbatim from gateway/index.ts (god-file seam). Closure-free —
 * module-level auth + the credentials/sites + guardrails/store helpers.
 */
import type { Hono } from "hono";
import { verifyToken, extractBearerToken } from "./auth.js";
import { listSiteCredentials, saveSiteCredential, deleteSiteCredential, getStoredSiteCredentialRecord, hasConfigSiteCredential } from "../credentials/sites.js";
import { getGuardrails, updateGuardrails, resetGuardrails } from "../guardrails/store.js";
import { childLogger } from "../logger.js";

const log = childLogger("gateway:security-config");

export function registerSecurityConfigRoutes(app: Hono): void {
  // ── Site credentials API ─────────────────────────────────────────────────
  // GET  /api/sites          — list all sites (usernames only, no passwords)
  // POST /api/sites/:host    — create or update a site credential
  // DELETE /api/sites/:host  — remove a site credential

  app.get("/api/sites", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    return c.json(listSiteCredentials());
  });

  app.post("/api/sites/:hostname", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const hostname = c.req.param("hostname");
    if (hasConfigSiteCredential(hostname)) {
      return c.json({ error: "Sites declared in starlingai.json are read-only in the dashboard" }, 403);
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const existing = getStoredSiteCredentialRecord(hostname);
    const username = String(body["username"] ?? "").trim() || (existing?.username ?? "");
    const password = String(body["password"] ?? "").trim() || (existing?.password ?? "");
    if (!username || !password) {
      return c.json({ error: "username and password are required" }, 400);
    }

    saveSiteCredential(hostname, {
      username,
      password,
      loginUrl: body["loginUrl"] ? String(body["loginUrl"]) : undefined,
      urls: body["urls"] && typeof body["urls"] === "object" && !Array.isArray(body["urls"])
        ? Object.fromEntries(Object.entries(body["urls"] as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
        : undefined,
      usernameSelector: body["usernameSelector"] ? String(body["usernameSelector"]) : undefined,
      passwordSelector: body["passwordSelector"] ? String(body["passwordSelector"]) : undefined,
      submitSelector: body["submitSelector"] ? String(body["submitSelector"]) : undefined,
      notes: body["notes"] ? String(body["notes"]) : undefined,
    });
    return c.json({ ok: true, hostname });
  });

  app.delete("/api/sites/:hostname", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    deleteSiteCredential(c.req.param("hostname"));
    return c.json({ ok: true });
  });

  // ── Guardrails API ────────────────────────────────────────────────────────
  // GET  /api/guardrails         — read current guardrail state
  // PUT  /api/guardrails         — update (partial patch)
  // POST /api/guardrails/reset   — reset to config defaults

  app.get("/api/guardrails", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    return c.json(getGuardrails());
  });

  app.put("/api/guardrails", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const patch: Parameters<typeof updateGuardrails>[0] = {};
    if (typeof body["promptInjectionBlock"] === "boolean") patch.promptInjectionBlock = body["promptInjectionBlock"];
    if (typeof body["outputSecretScan"] === "boolean") patch.outputSecretScan = body["outputSecretScan"];
    if (typeof body["maxInputLength"] === "number") patch.maxInputLength = body["maxInputLength"];
    const updated = updateGuardrails(patch);
    log.info({ patch }, "Guardrails updated");
    return c.json(updated);
  });

  app.post("/api/guardrails/reset", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const reset = resetGuardrails();
    log.info("Guardrails reset to config defaults");
    return c.json(reset);
  });
}
