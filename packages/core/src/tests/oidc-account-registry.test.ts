import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Which account an identity-provider sign-in is.
 *
 * The OIDC callback signed a person in as whatever username the ID token claimed, lowercased, and
 * threw the IdP subject away: "Alice" and "alice" (two people) were one account, a person who
 * changed the claim became whoever had the name, and a retired person's name was free at once. Each
 * subject now owns an account id and a username frozen at its first sign-in, held in the account
 * registry. These tests drive the REAL callback route; only the token exchange with the IdP is
 * replaced, by the claims a test hands it.
 */

const idp = vi.hoisted(() => ({
  /** The ID-token claims the IdP returns for a login state, and a gate the exchange waits on. */
  byState: new Map<string, { claims: Record<string, unknown>; gate?: Promise<void> }>(),
}));

vi.mock("../gateway/oidc.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/oidc.js")>();
  return {
    ...actual,
    handleCallback: async (_url: string, _verifier: string, state: string) => {
      const login = idp.byState.get(state);
      if (!login) throw new Error(`no IdP login for state ${state}`);
      await login.gate;
      const { getConfig } = await import("../config/loader.js");
      return actual.identityFromClaims(getConfig().auth.oidc!, login.claims);
    },
  };
});

const ISSUER = "https://idp.example.test/realms/sai";
const dirs: string[] = [];
let workspace = "";
let stateCounter = 0;

// The modules are loaded once for the file and their state reset between tests. Re-imported per
// test (vi.resetModules), the mocked oidc module's original came from the first test's module
// graph, and the routes of later tests read a configuration that was no longer theirs. The config
// loader fixes its file when it loads, so every test writes its own configuration to that one file.
const FILE_DIR = mkdtempSync(join(tmpdir(), "starlingai-oidc-file-"));
const CONFIG_PATH = join(FILE_DIR, "starlingai.json");
let mods: Awaited<ReturnType<typeof loadModules>>;

async function loadModules() {
  writeFileSync(CONFIG_PATH, JSON.stringify({ gateway: { jwtSecret: "o".repeat(40) } }), "utf8");
  process.env["SAI_CONFIG_PATH"] = CONFIG_PATH;
  process.env["SAI_MUTABLE_CONFIG_PATH"] = CONFIG_PATH;
  // The session store is read when the session module loads: this file's own, not the tree's.
  process.env["SAI_SESSION_STORE"] = join(FILE_DIR, "sessions.json");
  const oidc = await import("../gateway/oidc.js");
  const [{ registerAuthRoutes }, { registerAccountRoutes }, authModule, loader, registry, sessions, accounts, audit] = await Promise.all([
    import("../gateway/auth-routes.js"),
    import("../gateway/account-routes.js"),
    import("../gateway/auth.js"),
    import("../config/loader.js"),
    import("../runtime/account-registry.js"),
    import("../agent/session.js"),
    import("../runtime/accounts.js"),
    import("../audit/logger.js"),
  ]);
  return { oidc, registerAuthRoutes, registerAccountRoutes, authModule, loader, registry, sessions, accounts, audit };
}

beforeAll(async () => {
  mods = await loadModules();
});

afterAll(() => {
  for (const key of ["SAI_CONFIG_PATH", "SAI_MUTABLE_CONFIG_PATH", "SAI_SESSION_STORE"]) delete process.env[key];
  rmSync(FILE_DIR, { recursive: true, force: true });
});

function oidcAuth(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    provider: "oidc",
    oidc: { issuer: ISSUER, clientId: "sai", roleMapping: { admin: ["sai-admin"], defaultRole: "operator" }, ...extra },
    users: [],
  };
}

async function boot(auth: Record<string, unknown> = oidcAuth()) {
  workspace = mkdtempSync(join(tmpdir(), "starlingai-oidc-accounts-"));
  dirs.push(workspace);
  writeFileSync(CONFIG_PATH, JSON.stringify({ gateway: { jwtSecret: "o".repeat(40) }, workspacePath: workspace, auth }), "utf8");
  process.env["SAI_AUDIT_LOG"] = join(workspace, "audit.jsonl");
  const { oidc, registerAuthRoutes, registerAccountRoutes, authModule, loader, registry, sessions, accounts } = mods;
  loader.resetConfigForTests();
  registry.resetAccountRegistryForTests();
  authModule.resetAuthStateForTests();
  const app = new Hono();
  registerAuthRoutes(app);
  registerAccountRoutes(app);

  /** Starts a sign-in whose ID token carries `claims`; `send` finishes it at the callback. */
  const begin = (claims: Record<string, unknown>, gate?: Promise<void>) => {
    const state = `state-${++stateCounter}`;
    oidc.stashLoginState(state, "verifier");
    idp.byState.set(state, { claims: { iss: ISSUER, realm_access: { roles: [] }, ...claims }, ...(gate ? { gate } : {}) });
    return async () => {
      const response = await app.request(`/api/auth/oidc/callback?state=${state}&code=abc`);
      const fragment = new URL(response.headers.get("location") ?? "http://x/").hash.slice(1);
      const params = new URLSearchParams(fragment);
      return { token: params.get("sai_token") ?? undefined, error: params.get("sai_error") ?? undefined };
    };
  };
  const signIn = async (claims: Record<string, unknown>) => begin(claims)();
  const resolve = (token: string) => authModule.authenticatedUser(`Bearer ${token}`);
  const adminToken = () => authModule.createToken("admin", { role: "admin", bst: true });
  const adminPost = async (path: string, token?: string) => app.request(path, {
    method: "POST",
    headers: { Authorization: `Bearer ${token ?? await adminToken()}` },
  });
  const entries = () => registry.accountRegistryEntries();
  const registryFile = () => join(workspace, ".starlingai", "accounts.json");
  return { app, authModule, loader, registry, sessions, accounts, begin, signIn, resolve, adminToken, adminPost, entries, registryFile };
}

async function auditTypes(): Promise<string[]> {
  await mods.audit.flushAuditLog();
  const path = join(workspace, "audit.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { type: string }).type);
}

afterEach(async () => {
  idp.byState.clear();
  await mods.audit.flushAuditLog();
  mods.sessions.resetSessionsForTests();
  mods.registry.resetAccountRegistryForTests();
  mods.loader.resetConfigForTests();
  mods.authModule.resetAuthStateForTests();
  delete process.env["SAI_AUDIT_LOG"];
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("an identity-provider subject owns one account", () => {
  it("refuses a second subject whose username differs from the first only in case", async () => {
    const { signIn, resolve, entries, accounts } = await boot();
    const first = await signIn({ sub: "subject-1", preferred_username: "Alice" });
    expect(first.error).toBeUndefined();
    const alice = await resolve(first.token!);
    expect(alice).toMatchObject({ username: "alice", role: "operator" });
    expect(alice?.account).toMatch(/^oidc-[0-9a-f]{16}$/);
    expect(alice?.account).toMatch(accounts.ACCOUNT_ID_RE);

    const second = await signIn({ sub: "subject-2", preferred_username: "alice" });
    expect(second.token).toBeUndefined();
    expect(second.error).toMatch(/held by another account/);
    expect(entries().map((entry) => [entry.subject, entry.username])).toEqual([["subject-1", "alice"]]);
    expect(await auditTypes()).toContain("auth_oidc_username_conflict");

    // The first subject signs in again as the same account.
    const again = await signIn({ sub: "subject-1", preferred_username: "alice" });
    expect((await resolve(again.token!))?.account).toBe(alice?.account);
  });

  it("creates exactly one account when two first sign-ins for one name finish together", async () => {
    const { begin, resolve, entries } = await boot();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const one = begin({ sub: "subject-1", preferred_username: "bob" }, gate);
    const two = begin({ sub: "subject-2", preferred_username: "bob" }, gate);
    const pending = Promise.all([one(), two()]);
    release();
    const results = await pending;
    expect(results.filter((result) => result.token).length).toBe(1);
    expect(results.filter((result) => result.error).length).toBe(1);
    expect(entries().filter((entry) => entry.username === "bob").length).toBe(1);
    const winner = results.find((result) => result.token)!;
    expect((await resolve(winner.token!))?.account).toBe(entries()[0]!.id);
  });

  it("keeps the frozen username when the IdP claims another, until an admin approves it", async () => {
    const { signIn, resolve, adminPost, entries, authModule } = await boot();
    const first = await signIn({ sub: "subject-1", preferred_username: "alice" });
    const id = (await resolve(first.token!))!.account!;

    const renamed = await signIn({ sub: "subject-1", preferred_username: "alice.smith" });
    expect(await resolve(renamed.token!)).toMatchObject({ username: "alice", account: id });
    expect(entries()[0]).toMatchObject({ username: "alice", requestedUsername: "alice.smith" });
    expect(await auditTypes()).toContain("auth_oidc_username_change_requested");

    // An operator may not approve it.
    const operator = await authModule.createToken("olga", { role: "operator", bst: true });
    expect((await adminPost(`/api/admin/accounts/${id}/rename`, operator)).status).toBe(403);

    expect((await adminPost(`/api/admin/accounts/${id}/rename`)).status).toBe(200);
    expect(entries()[0]).toMatchObject({ username: "alice.smith", formerUsernames: ["alice"] });
    expect(entries()[0]).not.toHaveProperty("requestedUsername");
    // Tokens minted under the old name name an account that no longer holds it.
    expect(await resolve(renamed.token!)).toBeNull();
    const after = await signIn({ sub: "subject-1", preferred_username: "alice.smith" });
    expect(await resolve(after.token!)).toMatchObject({ username: "alice.smith", account: id });
    // The old name stays this account's: nobody else is given it, or the grants written for it.
    expect((await signIn({ sub: "subject-2", preferred_username: "alice" })).error).toMatch(/held by another account/);
    expect(await auditTypes()).toContain("auth_account_renamed");
  });

  it("does not hand a retired account's name to a new subject until an admin releases it", async () => {
    const { signIn, resolve, adminPost, entries } = await boot();
    const first = await signIn({ sub: "subject-1", preferred_username: "carol" });
    const oldId = (await resolve(first.token!))!.account!;
    expect((await adminPost(`/api/admin/accounts/${oldId}/release-username`)).status).toBe(409); // not retired yet
    expect((await adminPost(`/api/admin/accounts/${oldId}/retire`)).status).toBe(200);

    // Its tokens stop at once, and it does not sign in again.
    expect(await resolve(first.token!)).toBeNull();
    expect((await signIn({ sub: "subject-1", preferred_username: "carol" })).error).toMatch(/retired/);
    // Nor does anyone else as carol.
    expect((await signIn({ sub: "subject-2", preferred_username: "carol" })).error).toMatch(/held by another account/);

    expect((await adminPost(`/api/admin/accounts/${oldId}/release-username`)).status).toBe(200);
    const next = await signIn({ sub: "subject-2", preferred_username: "carol" });
    const newAccount = (await resolve(next.token!))!.account!;
    expect(newAccount).not.toBe(oldId);
    expect(entries().map((entry) => [entry.subject, entry.status])).toEqual([["subject-1", "retired"], ["subject-2", "active"]]);
    expect(await auditTypes()).toEqual(expect.arrayContaining(["auth_account_retired", "auth_account_username_released"]));
  });

  it("accepts an email address as the username only when the IdP verified it", async () => {
    const { signIn, resolve, entries } = await boot(oidcAuth({ usernameClaim: "email" }));
    const unverified = await signIn({ sub: "subject-1", email: "eve@example.com", email_verified: false });
    expect(unverified.token).toBeUndefined();
    expect(unverified.error).toMatch(/not verified/);
    expect((await signIn({ sub: "subject-1", email: "eve@example.com" })).token).toBeUndefined();
    expect(entries()).toEqual([]);
    expect(await auditTypes()).toContain("auth_oidc_unverified_email");

    const verified = await signIn({ sub: "subject-1", email: "Eve@Example.com", email_verified: true });
    expect(await resolve(verified.token!)).toMatchObject({ username: "eve@example.com" });
  });

  it("refuses a username a principal could carry", async () => {
    const { signIn, entries } = await boot();
    for (const name of ["telegram:12345", "has space", "line\nbreak", "-leading-dash", ""]) {
      const result = await signIn({ sub: `subject-${name.length}`, preferred_username: name || undefined, ...(name ? {} : { sub: "" }) });
      expect(result.token, JSON.stringify(name)).toBeUndefined();
    }
    expect(entries()).toEqual([]);
  });

  it("keeps the IdP user admin and a bootstrap admin token two identities", async () => {
    const { signIn, resolve, adminToken, accounts } = await boot();
    // The bootstrap token's bucket holds data; it is not the IdP user's to inherit.
    mkdirSync(join(workspace, "users", accounts.principalSegment("admin")), { recursive: true });
    const idpAdmin = await signIn({ sub: "keycloak-admin", preferred_username: "admin", realm_access: { roles: ["sai-admin"] } });
    expect(idpAdmin.error).toBeUndefined();
    const account = await resolve(idpAdmin.token!);
    const bootstrap = await resolve(await adminToken());
    expect(account).toMatchObject({ username: "admin", role: "admin" });
    expect(account?.account).toMatch(/^oidc-/);
    expect(bootstrap).toMatchObject({ username: "admin", role: "admin", principal: "bootstrap" });
    expect(bootstrap?.account).toBeUndefined();
    // Two storage keys: the account id, and the bootstrap principal's segment.
    expect(account?.account).not.toBe(accounts.principalSegment("admin"));
  });

  it("holds a subject whose name has data from before account ids until an admin decides", async () => {
    const { signIn, resolve, adminPost, entries, sessions, accounts } = await boot();
    mkdirSync(join(workspace, "users", accounts.safeUserSegment("dora")), { recursive: true });
    const held = await signIn({ sub: "subject-1", preferred_username: "dora" });
    expect(held.token).toBeUndefined();
    expect(held.error).toMatch(/migration pending/i);
    expect(entries()[0]).toMatchObject({ username: "dora", status: "pending", legacy: { segment: accounts.safeUserSegment("dora") } });
    expect((await signIn({ sub: "subject-1", preferred_username: "dora" })).error).toMatch(/migration pending/i);

    expect((await adminPost(`/api/admin/accounts/${entries()[0]!.id}/decline-legacy`)).status).toBe(200);
    expect(entries()[0]).toMatchObject({ status: "active", legacy: { decision: "declined" } });
    const signedIn = await signIn({ sub: "subject-1", preferred_username: "dora" });
    expect((await resolve(signedIn.token!))?.account).toBe(entries()[0]!.id);

    // A session the name owns counts the same as a directory.
    sessions.createSession({ channel: "webchat", userId: "erik", workspacePath: workspace });
    expect((await signIn({ sub: "subject-2", preferred_username: "erik" })).error).toMatch(/migration pending/i);
  });

  it("resolves an identity-provider token only while the provider is oidc", async () => {
    const { signIn, resolve, loader } = await boot();
    const token = (await signIn({ sub: "subject-1", preferred_username: "fred" })).token!;
    expect(await resolve(token)).not.toBeNull();
    loader.updateConfig((raw) => { (raw["auth"] as Record<string, unknown>)["provider"] = "builtin"; });
    expect(await resolve(token)).toBeNull();
  });

  it("never writes over a registry it cannot read, and signs nobody in through it", async () => {
    const { signIn, registryFile, adminPost } = await boot();
    mkdirSync(join(workspace, ".starlingai"), { recursive: true });
    writeFileSync(registryFile(), "{ this is not the registry");
    const refused = await signIn({ sub: "subject-1", preferred_username: "gina" });
    expect(refused.token).toBeUndefined();
    expect(readFileSync(registryFile(), "utf8")).toBe("{ this is not the registry");
    const listed = await adminPost("/api/admin/accounts/oidc-0123456789abcdef/retire");
    expect(listed.status).toBe(404);
    expect(readFileSync(registryFile(), "utf8")).toBe("{ this is not the registry");
  });

  it("creates no account when the registry cannot be written", async () => {
    const { signIn, entries } = await boot();
    // The state directory is a file: nothing can be written under it.
    writeFileSync(join(workspace, ".starlingai"), "not a directory");
    expect((await signIn({ sub: "subject-1", preferred_username: "hugo" })).token).toBeUndefined();
    expect(entries()).toEqual([]);
  });
});
