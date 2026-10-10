/**
 * The account migration, for whoever holds the host:
 *
 *   POST /api/admin/account-migration — a dry run (the default; writes nothing, runs on the live
 *                                       gateway), or with `apply` and the dry run's `plan` hash, the
 *                                       apply (only in a maintenance boot)
 *
 * The migration can move or archive every account's data, so an admin role is not enough: an
 * identity provider maps that role from claims the deployment does not control. The route takes a
 * bootstrap token only (the `bst` claim), which `sai migrate-account-ids` mints from the JWT secret
 * in `.env`, that is, with access to the host. A route policy admits admins only, before the route
 * itself checks the token's kind.
 *
 * The body is runtime/account-migration.ts's request; the reply is its plan, and with `apply` what
 * each step did. 409 when an apply is asked outside a maintenance boot, when the state changed since
 * the dry run (its decisions, not its counts), or while another run is in progress.
 */
import type { Hono } from "hono";
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";
import { authenticatedUser, userHasRole } from "./auth.js";
import { findRoutePolicy, registerRoutePolicies } from "./route-policies.js";
import {
  defaultAccountMigrationBackends,
  parseAccountMigrationRequest,
  runAccountMigration,
  type AccountMigrationBackends,
} from "../runtime/account-migration.js";

const log = childLogger("gateway:account-migration");

export const ACCOUNT_MIGRATION_ROUTE = "/api/admin/account-migration";

/** The body is a handful of flags; anything larger is not one. */
const MAX_BODY_BYTES = 64 * 1024;

export function registerAccountMigrationRoutes(
  app: Hono,
  backends: () => Promise<AccountMigrationBackends> = defaultAccountMigrationBackends,
): void {
  // Admins only, enforced by the policy gate in front of every /api route, then the token's kind here.
  if (!findRoutePolicy("POST", ACCOUNT_MIGRATION_ROUTE)) {
    registerRoutePolicies("core:account-migration", [{ method: "POST", pattern: ACCOUNT_MIGRATION_ROUTE, roles: ["admin"] }]);
  }

  app.post(ACCOUNT_MIGRATION_ROUTE, async (c) => {
    const caller = await authenticatedUser(c.req.header("Authorization"));
    if (!caller) return c.json({ error: "Unauthorized" }, 401);
    if (getConfig().auth?.enabled !== true) {
      return c.json({ error: "Multi-user auth is off: storage is not partitioned by account, so there is nothing to migrate" }, 409);
    }
    if (caller.principal !== "bootstrap" || !userHasRole(caller, "admin")) {
      return c.json({ error: "The account migration takes a bootstrap admin token (`sai migrate-account-ids` mints one from .env)" }, 403);
    }
    const length = Number(c.req.header("content-length") ?? 0);
    if (length > MAX_BODY_BYTES) return c.json({ error: "Request body too large" }, 413);
    let body: unknown = {};
    const text = await c.req.text();
    if (text.length > MAX_BODY_BYTES) return c.json({ error: "Request body too large" }, 413);
    if (text.trim()) {
      try { body = JSON.parse(text); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
    }
    const request = parseAccountMigrationRequest(body);
    if ("error" in request) return c.json({ error: request.error }, 400);
    try {
      const result = await runAccountMigration(request, await backends(), caller.username);
      if (result.status === 409) return c.json({ error: result.error, ...(result.plan ? { plan: result.plan } : {}) }, 409);
      return c.json({ plan: result.plan, ...(result.applied ? { applied: result.applied } : {}) });
    } catch (err) {
      log.error({ err }, "The account migration failed");
      return c.json({ error: `The account migration failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });
}
