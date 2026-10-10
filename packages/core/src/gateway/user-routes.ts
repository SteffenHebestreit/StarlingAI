/**
 * Account management for the builtin username/password provider.
 *
 *   GET    /api/auth/users            — the roster (operator)
 *   POST   /api/auth/users            — create an account (admin)
 *   PATCH  /api/auth/users/:username  — set a new password (admin)
 *   DELETE /api/auth/users/:username  — delete one (admin); what it has running ends with it, and a
 *                                       tombstone keeps its name (gateway/account-lifecycle.ts)
 *
 * Extracted from gateway/index.ts so the real routes can be tested. Changing the roster is
 * ADMIN-only: it was operator-only, and operator is every account's default role, so any account
 * could delete another and create it again with a password of its own. Sessions, the per-user
 * workspace and memory were all keyed by username then, so that was a takeover of the other person's
 * identity — past the admin-only session rule, which assumes a username names one person.
 *
 * Bootstrap: `sai token` mints a bootstrap token (the `bst` claim), which auth.ts resolves by its
 * claims while the store is empty and after, so the first account is created the way it always was.
 * With auth off the gateway prints a plain admin token, which needs no store at all.
 */
import type { Hono } from "hono";
import { authenticatedUser, hashPassword, roleRank, userHasRole, type AuthRole } from "./auth.js";
import { getConfig, updateConfig } from "../config/loader.js";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";
import { endAccountActivity } from "./account-lifecycle.js";
import { aclEntriesNamingAccount } from "../guardrails/acl-entries-check.js";
import { accountRegistryEntries } from "../runtime/account-registry.js";
import { recordAccountTombstone } from "../runtime/account-tombstones.js";
import { accountLedgerPath, appendAccountLedgerEntry, mintBuiltinAccountId } from "../runtime/accounts.js";

const log = childLogger("gateway:user-routes");

/**
 * Why a new account may not take this name, or undefined when it may.
 *
 * A name that owned sessions was refused as well, because the sessions were the name's: a new
 * account under it would have taken a deleted one's over. A session is its account's by id now
 * (runtime/user-scope.ts ownsRecord) and a new account gets a new id, so it starts empty, and the
 * refusal only kept a name blocked for as long as archived sessions are kept. A deleted account's
 * tombstone does not block it either: re-creating the name is the admin's deliberate act, and the
 * delete reply listed the grants that still name it.
 */
function usernameTaken(): string | undefined {
  // The identity provider owns the namespace: its users are not in auth.users, so a duplicate
  // check there sees none of them. A local "alice" would hold the name of the SSO user "alice", and
  // every grant written for it.
  if (getConfig().auth.provider === "oidc") {
    return "Accounts come from the identity provider (auth.provider is \"oidc\"); a local account would share its usernames, and with them its users' sessions";
  }
  return undefined;
}

/** Why a password may not be set, or undefined when it may: the same rule for a new account and a reset. */
function passwordProblem(password: string): string | undefined {
  return password.length < 8 ? "password must be at least 8 characters" : undefined;
}

export function registerUserRoutes(app: Hono): void {
  app.get("/api/auth/users", async (c) => {
    const user = await authenticatedUser(c.req.header("Authorization"));
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    // Reading the roster is operator-level; a read-only viewer must not enumerate the accounts.
    // Changing it is admin-only (below).
    if (!userHasRole(user, "operator")) {
      return c.json({ error: "Operator role required" }, 403);
    }
    const users = getConfig().auth.users.map((u) => ({
      username: u.username,
      displayName: u.displayName,
      role: u.role,
      createdAt: u.createdAt,
    }));
    // The provider tells the page whether accounts are made here at all (not under OIDC).
    return c.json({ enabled: getConfig().auth.enabled, provider: getConfig().auth.provider, users });
  });

  app.post("/api/auth/users", async (c) => {
    const actor = await authenticatedUser(c.req.header("Authorization"));
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    if (!userHasRole(actor, "admin")) {
      return c.json({ error: "Admin role required to manage accounts" }, 403);
    }

    let body: { username?: unknown; password?: unknown; displayName?: unknown; role?: unknown };
    try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const displayName = typeof body.displayName === "string" ? body.displayName : undefined;
    // Never admin. The rule came from auth.ts taking any admin claim with no account behind it for a
    // bootstrap token, so a deleted admin account's token outlived the account. Bootstrap tokens now
    // carry their own claim, but whether this route may make admins is a decision of its own, so the
    // rule stays.
    const role: AuthRole = body.role === "viewer" ? "viewer" : "operator";
    if (!username || !/^[a-z0-9_.-]+$/.test(username)) {
      return c.json({ error: "username must be alphanumeric/_/-/." }, 400);
    }
    const weak = passwordProblem(password);
    if (weak) return c.json({ error: weak }, 400);

    if (getConfig().auth.users.find((u) => u.username.toLowerCase() === username)) {
      return c.json({ error: `User '${username}' already exists` }, 409);
    }
    const taken = usernameTaken();
    if (taken) return c.json({ error: taken }, 409);

    const passwordHash = await hashPassword(password);
    const createdAt = new Date().toISOString();
    // The account's storage key, minted here and never derived from the name: a name deleted and
    // created again gets a new id, so nothing the old account left is the new one's. The ledger
    // entry tells an account created now from one that predates ids, whose data a migration may
    // move only when an admin names the pair. It is written first; when it cannot be, no account
    // is made, so every id this route hands out is on record.
    const id = mintBuiltinAccountId(username, [
      ...getConfig().auth.users.flatMap((u) => (u.id ? [u.id] : [])),
      // Identity-provider accounts hold ids in the same space (mixed mode signs both in).
      ...accountRegistryEntries().map((entry) => entry.id),
    ]);
    try {
      appendAccountLedgerEntry(accountLedgerPath(getConfig().workspacePath), { event: "created", id, username, at: createdAt });
    } catch (err) {
      log.error({ err, username }, "Could not record the new account's id; the account was not created");
      return c.json({ error: "Could not record the new account's id; nothing was created" }, 500);
    }

    updateConfig((raw) => {
      const auth = (raw["auth"] = (raw["auth"] as Record<string, unknown>) ?? {});
      const users = (auth["users"] = (auth["users"] as unknown[] | undefined) ?? []);
      (users as unknown[]).push({ username, passwordHash, displayName, role, createdAt, id });
      // Auto-enable so the first added user makes the feature usable.
      if (auth["enabled"] !== true) auth["enabled"] = true;
    });

    logAudit("auth_user_created", { actor: actor.username, username, displayName: displayName ?? null, role }, { userId: actor.username, severity: "info" });
    return c.json({ username, displayName, role, createdAt });
  });

  // A new password for an existing account. Refusing to re-create a name that owns sessions left
  // no way to reset a forgotten password short of editing the config file; this is that way, for
  // the same admin who could delete the account anyway. Tokens already issued stay valid until
  // they expire — a reset is not a sign-out.
  app.patch("/api/auth/users/:username", async (c) => {
    const actor = await authenticatedUser(c.req.header("Authorization"));
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    if (!userHasRole(actor, "admin")) {
      return c.json({ error: "Admin role required to manage accounts" }, 403);
    }

    let body: { password?: unknown };
    try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
    const password = typeof body.password === "string" ? body.password : "";
    const weak = passwordProblem(password);
    if (weak) return c.json({ error: weak }, 400);

    const target = c.req.param("username").toLowerCase();
    if (!getConfig().auth.users.some((u) => u.username.toLowerCase() === target)) {
      return c.json({ error: `User '${target}' not found` }, 404);
    }
    const passwordHash = await hashPassword(password);
    updateConfig((raw) => {
      const auth = (raw["auth"] as Record<string, unknown>) ?? {};
      const users = Array.isArray(auth["users"]) ? auth["users"] as Array<Record<string, unknown>> : [];
      for (const record of users) {
        if (String(record["username"] ?? "").toLowerCase() === target) record["passwordHash"] = passwordHash;
      }
      raw["auth"] = { ...auth, users };
    });

    logAudit("auth_user_password_reset", { actor: actor.username, username: target }, { userId: actor.username, severity: "warn" });
    return c.json({ ok: true });
  });

  app.delete("/api/auth/users/:username", async (c) => {
    const actor = await authenticatedUser(c.req.header("Authorization"));
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    if (!userHasRole(actor, "admin")) {
      return c.json({ error: "Admin role required to manage accounts" }, 403);
    }

    const target = c.req.param("username").toLowerCase();
    const targetUser = getConfig().auth.users.find((u) => u.username.toLowerCase() === target);
    if (!targetUser) {
      return c.json({ error: `User '${target}' not found` }, 404);
    }
    const remaining = getConfig().auth.users.filter((u) => u.username.toLowerCase() !== target);
    // Prevent locking the deployment out: at least one account that can operate must remain.
    // Viewers don't count toward this floor; admins do (counting only "operator" refused deleting
    // a viewer from a roster of one admin and some viewers).
    const remainingOperators = remaining.filter((u) => roleRank(u.role) >= roleRank("operator"));
    if (remainingOperators.length === 0) {
      return c.json({ error: "Refusing to delete the last operator — promote another account first" }, 400);
    }
    // And one that can manage accounts: only an admin can, and no route makes one, so deleting the
    // last admin (yourself, say) left only `sai token` to get back in.
    if (roleRank(targetUser.role) >= roleRank("admin") && !remaining.some((u) => roleRank(u.role) >= roleRank("admin"))) {
      return c.json({ error: "Refusing to delete the last admin — no one else could manage accounts" }, 400);
    }

    // The tombstone first: it is what keeps the name from a channel sender (whose bucket would be the
    // one the account kept before ids) and from a new identity-provider subject (who would hold every
    // grant written for it). When it cannot be written, the account is not deleted.
    const retiredAt = new Date().toISOString();
    try {
      recordAccountTombstone({ ...(targetUser.id ? { id: targetUser.id } : {}), username: target, kind: "builtin", retiredAt, by: actor.username });
    } catch (err) {
      log.error({ err, username: target }, "Could not record the deleted account's tombstone; the account was not deleted");
      return c.json({ error: "Could not record the account's deletion; nothing was deleted" }, 500);
    }

    updateConfig((raw) => {
      const auth = (raw["auth"] as Record<string, unknown>) ?? {};
      // Every remaining record keeps its id. The remap names its fields, and without this one each
      // delete stripped every other account's id, which keys that account's storage.
      auth["users"] = remaining.map((u) => ({
        username: u.username,
        passwordHash: u.passwordHash,
        role: u.role,
        ...(u.displayName ? { displayName: u.displayName } : {}),
        ...(u.createdAt ? { createdAt: u.createdAt } : {}),
        ...(u.id ? { id: u.id } : {}),
      }));
      raw["auth"] = auth;
    });

    // Its tokens stop resolving at once (auth.ts finds no record holding the id). What the account
    // has running ends now as well: its sockets, sessions and turns, jobs, schedules, MCP sessions
    // and A2A tasks. A record without an id signed nothing in and has nothing stamped with one.
    const ended = targetUser.id ? await endAccountActivity(targetUser.id, "account deleted", actor.username) : undefined;
    // Grants that still name the account: an account created again under the name gets every bare one.
    const aclReferences = aclEntriesNamingAccount(target, targetUser.id);

    logAudit("auth_user_deleted", {
      actor: actor.username,
      username: target,
      role: targetUser.role,
      ...(targetUser.id ? { account: targetUser.id } : {}),
      ...(ended ? { ended } : {}),
      aclReferences,
    }, { userId: actor.username, severity: "warn" });
    return c.json({ ok: true, ...(ended ? { ended } : {}), aclReferences });
  });
}
