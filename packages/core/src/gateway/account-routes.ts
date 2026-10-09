/**
 * Identity-provider accounts, for admins:
 *
 *   GET  /api/admin/accounts                        — the account registry
 *   POST /api/admin/accounts/:id/rename             — give the account the username its IdP now claims
 *   POST /api/admin/accounts/:id/retire             — the account no longer signs in
 *   POST /api/admin/accounts/:id/release-username   — a retired account's names may be claimed again
 *   POST /api/admin/accounts/:id/decline-legacy     — a pending account starts without the data
 *                                                     stored under its name before account ids
 *
 * An OIDC account's username is frozen at its first sign-in (gateway/oidc-accounts.ts): access
 * lists and other people's grants name it, so it changes only when an admin approves, and a name an
 * account held is never handed to anyone else unless an admin releases it. Every change is audited.
 * A renamed or retired account's tokens stop resolving at once, because auth.ts requires the account
 * to be active and to hold the token's username.
 */
import type { Hono } from "hono";
import { getConfig } from "../config/loader.js";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";
import {
  accountRegistryEntries,
  accountRegistryEntryById,
  accountRegistryReadable,
  accountRegistryUsernameHolder,
  changeAccountRegistry,
  type AccountRegistryEntry,
} from "../runtime/account-registry.js";
import { authenticatedUser, userHasRole } from "./auth.js";

const log = childLogger("gateway:account-routes");

type RouteResult = { status: 200; entry: AccountRegistryEntry } | { status: 404 | 409 | 500; error: string };

/** Applies `change` to the entry with this id; `change` returns an error to refuse. */
function changeEntry(id: string, change: (entry: AccountRegistryEntry) => { status: 409; error: string } | void): RouteResult {
  const current = accountRegistryEntryById(id);
  if (!current) return { status: 404, error: `Account '${id}' not found` };
  try {
    return changeAccountRegistry((doc): RouteResult => {
      const entry = doc.accounts.find((candidate) => candidate.id === current.id)!;
      const refused = change(entry);
      if (refused) throw new RefusedChange(refused.error);
      return { status: 200, entry: structuredClone(entry) };
    });
  } catch (err) {
    if (err instanceof RefusedChange) return { status: 409, error: err.message };
    log.error({ err, account: id }, "Could not write the account registry");
    return { status: 500, error: "Could not write the account registry; nothing was changed" };
  }
}

/** A refusal raised inside a registry change, so the change is abandoned before anything is written. */
class RefusedChange extends Error {}

export function registerAccountRoutes(app: Hono): void {
  const admin = async (authorization: string | undefined) => {
    const actor = await authenticatedUser(authorization);
    if (!actor) return { error: "Unauthorized", status: 401 as const };
    if (!userHasRole(actor, "admin")) return { error: "Admin role required to manage accounts", status: 403 as const };
    return { actor };
  };

  app.get("/api/admin/accounts", async (c) => {
    const gate = await admin(c.req.header("Authorization"));
    if ("error" in gate) return c.json({ error: gate.error }, gate.status);
    return c.json({ readable: accountRegistryReadable(), accounts: accountRegistryEntries() });
  });

  app.post("/api/admin/accounts/:id/rename", async (c) => {
    const gate = await admin(c.req.header("Authorization"));
    if ("error" in gate) return c.json({ error: gate.error }, gate.status);
    const id = c.req.param("id");
    let previous = "";
    const result = changeEntry(id, (entry) => {
      const requested = entry.requestedUsername;
      if (!requested) return { status: 409, error: "The identity provider has not asked for another username" };
      if (entry.status === "retired") return { status: 409, error: "A retired account is not renamed" };
      const holder = accountRegistryUsernameHolder(requested);
      if (holder === "unreadable" || (holder && holder.id !== entry.id)) return { status: 409, error: `'${requested}' is held by another account` };
      if (getConfig().auth.users.some((user) => user.username.toLowerCase() === requested)) return { status: 409, error: `'${requested}' is held by a builtin account` };
      previous = entry.username;
      // The old name stays held by this account, so a grant an admin wrote for it does not pass to
      // whoever claims it next.
      entry.formerUsernames = [...new Set([...(entry.formerUsernames ?? []), entry.username])].filter((name) => name !== requested);
      entry.username = requested;
      delete entry.requestedUsername;
    });
    if (result.status !== 200) return c.json({ error: result.error }, result.status);
    logAudit("auth_account_renamed", { actor: gate.actor.username, account: result.entry.id, from: previous, to: result.entry.username }, { userId: gate.actor.username, severity: "warn" });
    return c.json({ account: result.entry });
  });

  app.post("/api/admin/accounts/:id/retire", async (c) => {
    const gate = await admin(c.req.header("Authorization"));
    if ("error" in gate) return c.json({ error: gate.error }, gate.status);
    const result = changeEntry(c.req.param("id"), (entry) => {
      if (entry.status === "retired") return { status: 409, error: "The account is already retired" };
      entry.status = "retired";
      entry.retiredAt = new Date().toISOString();
    });
    if (result.status !== 200) return c.json({ error: result.error }, result.status);
    logAudit("auth_account_retired", { actor: gate.actor.username, account: result.entry.id, username: result.entry.username }, { userId: gate.actor.username, severity: "warn" });
    return c.json({ account: result.entry });
  });

  app.post("/api/admin/accounts/:id/release-username", async (c) => {
    const gate = await admin(c.req.header("Authorization"));
    if ("error" in gate) return c.json({ error: gate.error }, gate.status);
    const result = changeEntry(c.req.param("id"), (entry) => {
      if (entry.status !== "retired") return { status: 409, error: "Only a retired account's names are released" };
      entry.usernameReleased = true;
    });
    if (result.status !== 200) return c.json({ error: result.error }, result.status);
    logAudit("auth_account_username_released", {
      actor: gate.actor.username,
      account: result.entry.id,
      usernames: [result.entry.username, ...(result.entry.formerUsernames ?? [])],
    }, { userId: gate.actor.username, severity: "warn" });
    return c.json({ account: result.entry });
  });

  app.post("/api/admin/accounts/:id/decline-legacy", async (c) => {
    const gate = await admin(c.req.header("Authorization"));
    if ("error" in gate) return c.json({ error: gate.error }, gate.status);
    const result = changeEntry(c.req.param("id"), (entry) => {
      if (entry.status !== "pending" || !entry.legacy) return { status: 409, error: "The account is not waiting for the account migration" };
      // No data moves: what was stored under the name stays where it is, and the account starts
      // empty. Safe on a running gateway.
      entry.status = "active";
      entry.legacy = { ...entry.legacy, decision: "declined", decidedAt: new Date().toISOString() };
    });
    if (result.status !== 200) return c.json({ error: result.error }, result.status);
    logAudit("auth_account_legacy_declined", { actor: gate.actor.username, account: result.entry.id, username: result.entry.username }, { userId: gate.actor.username, severity: "warn" });
    return c.json({ account: result.entry });
  });
}
