/**
 * Sign-in routes:
 *
 *   GET  /api/auth/mode           — which login the screen offers (public)
 *   GET  /api/auth/oidc/login     — start an identity-provider sign-in
 *   GET  /api/auth/oidc/callback  — finish it and mint a session token
 *   POST /api/auth/login          — username and password (builtin or an extension store)
 *   GET  /api/auth/me             — who the token is
 *
 * Extracted from gateway/index.ts so the real routes can be tested.
 *
 * Under multi-user auth every session token minted here names its account by id (the `aid` claim)
 * besides its username: a builtin record's `id`, or the account registry's id for an
 * identity-provider subject. auth.ts resolves a token only while that account still holds that
 * username, so a name deleted and created again, or claimed by another IdP subject, is not the
 * account an earlier token was minted for. An extension credential store's own user id already is
 * immutable and stays the token's `sub`.
 */
import type { Hono } from "hono";
import { getConfig } from "../config/loader.js";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";
import { getExtensionAuthProvider } from "../extension/index.js";
import {
  ACCOUNT_ID_CLAIM,
  authenticatedUser,
  builtinSignInProblem,
  checkAuthRateLimit,
  clearAuthFailures,
  createToken,
  recordAuthFailure,
  verifyPassword,
} from "./auth.js";
import { buildLoginUrl, handleCallback, oidcPublicBase, OidcSignInRefused, OIDC_CALLBACK_PATH, stashLoginState, takeLoginState } from "./oidc.js";
import { resolveOidcSignIn } from "./oidc-accounts.js";

const log = childLogger("gateway");

export function registerAuthRoutes(app: Hono): void {
  // Public (pre-auth) endpoint so the login screen can pick the right default tab.
  // With multi-user auth OFF there are no accounts — username/password login only
  // 503s — so the client should default to the token tab. Exposes nothing sensitive
  // (just whether account login is available).
  app.get("/api/auth/mode", (c) => {
    const auth = getConfig().auth;
    return c.json({
      authEnabled: auth.enabled === true,
      // The identity backend, so the login screen shows "Sign in with SSO" (oidc)
      // vs the username/password + token form (builtin).
      provider: auth.enabled ? auth.provider : "builtin",
    });
  });

  // ── OIDC SSO (auth.provider = "oidc") ────────────────────────────────────
  // Start: redirect the browser to the IdP (PKCE + state stashed server-side).
  app.get("/api/auth/oidc/login", async (c) => {
    const auth = getConfig().auth;
    if (!auth.enabled || auth.provider !== "oidc") return c.json({ error: "OIDC login is not enabled" }, 404);
    try {
      const origin = new URL(c.req.url).origin;
      const { url, codeVerifier, state } = await buildLoginUrl(origin);
      stashLoginState(state, codeVerifier);
      return c.redirect(url);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, "OIDC login start failed");
      return c.json({ error: "OIDC login unavailable — check the issuer configuration" }, 503);
    }
  });

  // Callback: exchange the code, mint OUR session JWT (mapping IdP roles), and hand
  // it to the SPA via the URL FRAGMENT (never the query — fragments aren't logged or
  // sent to the server). The SPA reads it on load, stores it, clears the hash, connects.
  app.get(OIDC_CALLBACK_PATH, async (c) => {
    const auth = getConfig().auth;
    const origin = new URL(c.req.url).origin;
    const base = oidcPublicBase(origin);
    if (!auth.enabled || auth.provider !== "oidc") return c.json({ error: "OIDC login is not enabled" }, 404);
    const state = c.req.query("state");
    const codeVerifier = state ? takeLoginState(state) : null;
    if (!state || !codeVerifier) return c.json({ error: "Invalid or expired login state" }, 400);
    try {
      const query = new URL(c.req.url).searchParams.toString();
      const currentUrl = `${base}${OIDC_CALLBACK_PATH}?${query}`;
      const identity = await handleCallback(currentUrl, codeVerifier, state);
      // The subject's account, created on its first sign-in. Synchronous: two callbacks that come
      // back together cannot both claim one name.
      const signIn = resolveOidcSignIn(identity);
      if (signIn.usernameChangeRequested) {
        logAudit("auth_oidc_username_change_requested", {
          account: signIn.entry.id,
          username: signIn.entry.username,
          requestedUsername: signIn.usernameChangeRequested,
        }, { userId: signIn.entry.username, severity: "warn" });
      }
      const token = await createToken(signIn.entry.username, {
        role: identity.role,
        [ACCOUNT_ID_CLAIM]: signIn.entry.id,
        ...(identity.displayName ? { displayName: identity.displayName } : {}),
      });
      logAudit("auth_success", {
        username: signIn.entry.username,
        role: identity.role,
        via: "oidc",
        account: signIn.entry.id,
        ...(signIn.created ? { accountCreated: true } : {}),
      }, { userId: signIn.entry.username });
      return c.redirect(`${base}/#sai_token=${encodeURIComponent(token)}`);
    } catch (err) {
      if (err instanceof OidcSignInRefused) {
        logAudit(err.auditType, { reason: err.message, ...(err.username ? { username: err.username } : {}) }, {
          ...(err.username ? { userId: err.username } : {}),
          severity: "warn",
        });
        log.warn({ reason: err.message }, "OIDC sign-in refused");
        return c.redirect(`${base}/#sai_error=${encodeURIComponent(err.userMessage)}`);
      }
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "OIDC callback failed");
      return c.redirect(`${base}/#sai_error=${encodeURIComponent("SSO login failed")}`);
    }
  });

  app.post("/api/auth/login", async (c) => {
    // Rate-limit identity: the real transport peer (spoof-proof, stamped by the
    // node bridge) by default; only trust the client-controlled X-Forwarded-For
    // when explicitly opted in for a reverse-proxy deployment.
    const peer = c.req.header("x-gateway-peer-addr") ?? "unknown";
    const ip = getConfig().auth.trustProxyHeader
      ? (c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() || peer)
      : peer;
    const rate = checkAuthRateLimit(ip);
    if (!rate.allowed) {
      return c.json({ error: "Too many failed attempts. Try again later." }, 429);
    }

    let body: { username?: unknown; password?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!username || !password) {
      return c.json({ error: "Username and password are required" }, 400);
    }

    // Extension credential backend (e.g. a fork's encrypted user store)
    // replaces the config-file user list entirely when registered.
    const authProvider = getExtensionAuthProvider();
    if (authProvider) {
      const providerUser = await authProvider.verifyCredentials(username, password);
      if (!providerUser) {
        recordAuthFailure(ip);
        return c.json({ error: "Invalid username or password" }, 401);
      }
      clearAuthFailures(ip);
      // Merge the provider's free-form claims FIRST and strip reserved security
      // keys, so a malicious/compromised extension provider cannot override the
      // authoritative `role` (privilege escalation) or `sub` in the minted JWT.
      // `scope` is reserved too: it marks capability tokens, which verifyToken
      // rejects — a provider setting it would brick its own users' sessions.
      // `aid` and `bst` are reserved as well: they bind a token to an account id or mark it a
      // bootstrap token, and auth.ts ignores both under an extension store, whose own user id is
      // the account. Stripped here so no token minted for a provider user carries either.
      const {
        role: _ignoredRole,
        sub: _ignoredSub,
        scope: _ignoredScope,
        aid: _ignoredAccountId,
        bst: _ignoredBootstrap,
        ...safeClaims
      } = providerUser.claims ?? {};
      const token = await createToken(providerUser.id, {
        ...safeClaims,
        role: providerUser.role,
        ...(providerUser.displayName ? { displayName: providerUser.displayName } : {}),
      });
      logAudit("auth_success", { username: providerUser.username, role: providerUser.role }, { userId: providerUser.id });
      return c.json({
        token,
        username: providerUser.username,
        displayName: providerUser.displayName,
        role: providerUser.role,
        user: providerUser,
      });
    }

    const authConfig = getConfig().auth;
    if (!authConfig.enabled) {
      return c.json({ error: "Username/password login is disabled. Set auth.enabled = true and configure auth.users[] to enable it." }, 503);
    }

    const user = authConfig.users.find((u) => u.username.toLowerCase() === username);
    if (!user) {
      recordAuthFailure(ip);
      return c.json({ error: "Invalid username or password" }, 401);
    }

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      recordAuthFailure(ip);
      return c.json({ error: "Invalid username or password" }, 401);
    }

    clearAuthFailures(ip);
    // After the password, so the reply tells only the account's own holder that the account exists.
    // An account without an id predates account ids: its storage is still keyed by its name and
    // waits for the account migration, so it does not sign in until then.
    const refused = builtinSignInProblem(user);
    if (refused) {
      logAudit("auth_account_refused", { username: user.username, reason: refused }, { userId: user.username, severity: "warn" });
      return c.json({ error: refused }, 403);
    }
    const token = await createToken(user.username, {
      role: user.role,
      [ACCOUNT_ID_CLAIM]: user.id,
      ...(user.displayName ? { displayName: user.displayName } : {}),
    });
    logAudit("auth_success", { username: user.username, role: user.role, account: user.id }, { userId: user.username });
    return c.json({
      token,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
    });
  });

  app.get("/api/auth/me", async (c) => {
    const user = await authenticatedUser(c.req.header("Authorization"));
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    // With an extension credential backend, also verify the account still
    // exists and surface its full public record (extra fields like kvnr).
    const authProvider = getExtensionAuthProvider();
    if (authProvider) {
      const record = authProvider.getUserById(user.username);
      if (!record) return c.json({ error: "User no longer exists" }, 401);
      return c.json({ ...user, user: record });
    }
    return c.json(user);
  });
}
