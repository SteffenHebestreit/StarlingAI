/**
 * Account management for the builtin username/password provider.
 *
 *   GET    /api/auth/users            — the roster (operator)
 *   POST   /api/auth/users            — create an account (admin)
 *   PATCH  /api/auth/users/:username  — set a new password (admin)
 *   DELETE /api/auth/users/:username  — delete one (admin)
 *
 * Extracted from gateway/index.ts so the real routes can be tested. Changing the roster is
 * ADMIN-only: it was operator-only, and operator is every account's default role, so any account
 * could delete another and create it again with a password of its own. Sessions, the per-user
 * workspace and memory are all keyed by username, so that was a takeover of the other person's
 * identity — past the admin-only session rule, which assumes a username names one person.
 *
 * Bootstrap is unchanged: `sai token` mints an admin token (and so does the token the gateway
 * prints with auth off), and auth.ts resolves such a token by its claims while the store is empty
 * and after, so the first account is created the way it always was.
 */
import type { Hono } from "hono";
import { authenticatedUser, hashPassword, roleRank, userHasRole, type AuthRole } from "./auth.js";
import { getConfig, updateConfig } from "../config/loader.js";
import { getAllSessions } from "../agent/session.js";
import { logAudit } from "../audit/logger.js";

/**
 * Why a new account may not take this name, or undefined when it may.
 *
 * Whoever holds a username holds everything keyed by it, so a name already in use by someone the
 * store does not list — an identity-provider user, or the owner of sessions this gateway still
 * holds (a deleted account's, say) — is not free.
 */
function usernameTaken(username: string): string | undefined {
  // The identity provider owns the namespace: its users are not in auth.users, so a duplicate
  // check there sees none of them, and under OIDC auth.ts trusts a token's claims without a store
  // lookup. A local "alice" would be the SSO user "alice" (oidc.ts lowercases the same way).
  if (getConfig().auth.provider === "oidc") {
    return "Accounts come from the identity provider (auth.provider is \"oidc\"); a local account would share its usernames, and with them its users' sessions";
  }
  const owned = getAllSessions({ includeArchived: true }).some((session) => session.userId?.toLowerCase() === username);
  if (owned) {
    return `'${username}' already owns sessions on this gateway; a new account under that name would take them over`;
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
    // Never admin: auth.ts treats an admin claim with no account behind it as a bootstrap token,
    // so a deleted admin account's token would outlive the account.
    const role: AuthRole = body.role === "viewer" ? "viewer" : "operator";
    if (!username || !/^[a-z0-9_.-]+$/.test(username)) {
      return c.json({ error: "username must be alphanumeric/_/-/." }, 400);
    }
    const weak = passwordProblem(password);
    if (weak) return c.json({ error: weak }, 400);

    if (getConfig().auth.users.find((u) => u.username.toLowerCase() === username)) {
      return c.json({ error: `User '${username}' already exists` }, 409);
    }
    const taken = usernameTaken(username);
    if (taken) return c.json({ error: taken }, 409);

    const passwordHash = await hashPassword(password);
    const createdAt = new Date().toISOString();

    updateConfig((raw) => {
      const auth = (raw["auth"] = (raw["auth"] as Record<string, unknown>) ?? {});
      const users = (auth["users"] = (auth["users"] as unknown[] | undefined) ?? []);
      (users as unknown[]).push({ username, passwordHash, displayName, role, createdAt });
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

    updateConfig((raw) => {
      const auth = (raw["auth"] as Record<string, unknown>) ?? {};
      auth["users"] = remaining.map((u) => ({
        username: u.username,
        passwordHash: u.passwordHash,
        role: u.role,
        ...(u.displayName ? { displayName: u.displayName } : {}),
        ...(u.createdAt ? { createdAt: u.createdAt } : {}),
      }));
      raw["auth"] = auth;
    });

    logAudit("auth_user_deleted", { actor: actor.username, username: target, role: targetUser.role }, { userId: actor.username, severity: "warn" });
    return c.json({ ok: true });
  });
}
