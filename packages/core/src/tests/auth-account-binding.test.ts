import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { testAccount, testAccountId } from "./support/test-account.js";

/**
 * A session token names its account by id (the `aid` claim), not by username alone.
 *
 * authenticatedUser used to resolve a token by its `sub`: an account deleted and created again
 * under the same name was signed in with the old account's token, a token for a name with no
 * record resolved when it claimed role admin, and under provider "oidc" no token was checked
 * against any store. These tests mount the REAL sign-in and account routes.
 */

const SECRET = "k".repeat(40);
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const dirs: string[] = [];
let workspace = "";

function writeConfig(auth: Record<string, unknown>): void {
  workspace = mkdtempSync(join(tmpdir(), "starlingai-account-binding-"));
  dirs.push(workspace);
  const configPath = join(workspace, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({ gateway: { jwtSecret: SECRET }, workspacePath: workspace, auth }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configPath;
  process.env["SAI_MUTABLE_CONFIG_PATH"] = configPath;
  process.env["SAI_AUDIT_LOG"] = join(workspace, "audit.jsonl");
  // The session store is read when the session module loads: this deployment's own, not the tree's.
  process.env["SAI_SESSION_STORE"] = join(workspace, "sessions.json");
}

async function boot(auth: Record<string, unknown>) {
  writeConfig(auth);
  vi.resetModules();
  const [{ registerAuthRoutes }, { registerUserRoutes }, authModule, loader, extension] = await Promise.all([
    import("../gateway/auth-routes.js"),
    import("../gateway/user-routes.js"),
    import("../gateway/auth.js"),
    import("../config/loader.js"),
    import("../extension/index.js"),
  ]);
  const app = new Hono();
  registerAuthRoutes(app);
  registerUserRoutes(app);
  const login = async (username: string, password: string) => app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const tokenOf = async (response: Response) => ((await response.json()) as { token: string }).token;
  const resolve = (token: string) => authModule.authenticatedUser(`Bearer ${token}`);
  const bootstrapToken = (sub = "admin", role = "admin") => authModule.createToken(sub, { role, bst: true });
  const createAccount = async (as: string, username: string, password: string) => app.request("/api/auth/users", {
    method: "POST",
    headers: { Authorization: `Bearer ${as}`, "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const deleteAccount = async (as: string, username: string) => app.request(`/api/auth/users/${username}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${as}` },
  });
  const idOf = (username: string) => loader.getConfig().auth.users.find((u) => u.username === username)?.id;
  return { app, authModule, loader, extension, login, tokenOf, resolve, bootstrapToken, createAccount, deleteAccount, idOf };
}

function payloadOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
}

afterEach(async () => {
  const audit = await import("../audit/logger.js");
  await audit.flushAuditLog();
  const extension = await import("../extension/index.js");
  extension._resetExtensionsForTests();
  const registry = await import("../runtime/account-registry.js");
  registry.resetAccountRegistryForTests();
  const loader = await import("../config/loader.js");
  loader.resetConfigForTests();
  const auth = await import("../gateway/auth.js");
  auth.resetAuthStateForTests();
  delete process.env["SAI_CONFIG_PATH"];
  delete process.env["SAI_MUTABLE_CONFIG_PATH"];
  delete process.env["SAI_AUDIT_LOG"];
  delete process.env["SAI_SESSION_STORE"];
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

describe("a session token is bound to the account id it was minted for", () => {
  it("is refused once its account is deleted and the name created again", async () => {
    const { login, tokenOf, resolve, bootstrapToken, createAccount, deleteAccount, idOf } = await boot({
      enabled: true,
      users: [testAccount("root", "admin").record],
    });
    const admin = await bootstrapToken();
    expect((await createAccount(admin, "alice", "first-alice-password")).status).toBe(200);
    const oldId = idOf("alice");
    const oldToken = await tokenOf(await login("alice", "first-alice-password"));
    expect(payloadOf(oldToken)["aid"]).toBe(oldId);
    expect((await resolve(oldToken))?.account).toBe(oldId);

    // Deleted, and a new person given the name (with a password of their own).
    expect((await deleteAccount(admin, "alice")).status).toBe(200);
    expect((await createAccount(admin, "alice", "second-alice-password")).status).toBe(200);
    expect(idOf("alice")).not.toBe(oldId);

    // The first alice's token is not the second alice's account.
    expect(await resolve(oldToken)).toBeNull();
    const newToken = await tokenOf(await login("alice", "second-alice-password"));
    expect((await resolve(newToken))?.account).toBe(idOf("alice"));
  });

  it("refuses a roster account's token that names no account id, or another one", async () => {
    const alice = testAccount("alice");
    const bob = testAccount("bob");
    const { authModule, resolve } = await boot({ enabled: true, users: [alice.record, bob.record] });
    expect(await resolve(await authModule.createToken("alice", { role: "operator" }))).toBeNull();
    expect(await resolve(await authModule.createToken("alice", { role: "operator", aid: bob.id }))).toBeNull();
    expect(await resolve(await authModule.createToken("bob", { role: "operator", aid: alice.id }))).toBeNull();
    expect(await resolve(await authModule.createToken("alice", { role: "operator", aid: 42 }))).toBeNull();
    expect(await resolve(await authModule.createToken("alice", alice.claims))).toEqual({
      username: "alice", role: "operator", displayName: undefined, account: alice.id,
    });
  });

  it("signs in no account without an id, and says so only to whoever knows its password", async () => {
    const { authModule } = await boot({ enabled: false, users: [] });
    const passwordHash = await authModule.hashPassword("legacy-password");
    const { login, resolve } = await boot({
      enabled: true,
      users: [{ username: "legacy", passwordHash, role: "operator", createdAt: "2026-01-01T00:00:00Z" }, testAccount("root", "admin").record],
    });
    // A wrong password is the plain refusal, as for a name that does not exist.
    expect((await login("legacy", "wrong-password")).status).toBe(401);
    const refused = await login("legacy", "legacy-password");
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toContain("no account id");
    // And no token of that name resolves, whatever it claims.
    const fresh = await import("../gateway/auth.js");
    expect(await resolve(await fresh.createToken("legacy", { role: "operator" }))).toBeNull();
  });

  it("resolves a bootstrap token as the bootstrap principal, even where an account has its name", async () => {
    const admin = testAccount("admin", "operator");
    const { authModule, resolve, bootstrapToken } = await boot({ enabled: true, users: [admin.record] });
    // The account named admin is an operator, and its token is that account.
    expect(await resolve(await authModule.createToken("admin", admin.claims))).toMatchObject({ role: "operator", account: admin.id });
    // The bootstrap token is not that account: a principal of its own, with the role it was minted with.
    const principal = await resolve(await bootstrapToken("admin", "admin"));
    expect(principal).toEqual({ username: "admin", role: "admin", displayName: undefined, principal: "bootstrap" });
    expect(principal).not.toHaveProperty("account");
    // Its subject is recorded for the account migration, once.
    await resolve(await bootstrapToken("admin", "admin"));
    const registry = JSON.parse(readFileSync(join(workspace, ".starlingai", "accounts.json"), "utf8")) as { bootstrapSubs: string[] };
    expect(registry.bootstrapSubs).toEqual(["admin"]);
    // A token carrying both claims was not minted here.
    expect(await resolve(await authModule.createToken("admin", { role: "admin", bst: true, aid: admin.id }))).toBeNull();
    expect(await resolve(await authModule.createToken("admin", { role: "admin", bst: "yes" }))).toBeNull();
  });

  it("resolves a token with neither claim only while the deployment holds no account at all", async () => {
    const empty = await boot({ enabled: true, users: [] });
    const plainAdmin = await empty.authModule.createToken("admin", { role: "admin" });
    expect(await empty.resolve(plainAdmin)).toEqual({ username: "admin", role: "admin", displayName: undefined });

    // One builtin account: the window is shut, an admin claim notwithstanding.
    const withAccount = await boot({ enabled: true, users: [testAccount("alice").record] });
    expect(await withAccount.resolve(await withAccount.authModule.createToken("admin", { role: "admin" }))).toBeNull();

    // No builtin account, but an identity-provider account: shut too.
    writeConfig({ enabled: true, users: [] });
    mkdirSync(join(workspace, ".starlingai"), { recursive: true });
    writeFileSync(join(workspace, ".starlingai", "accounts.json"), JSON.stringify({
      version: 1,
      bootstrapSubs: [],
      accounts: [{ id: "oidc-0123456789abcdef", issuer: "https://idp.example.test", subject: "s-1", username: "carol", status: "active", firstSeenAt: "2026-10-09T00:00:00Z", lastSeenAt: "2026-10-09T00:00:00Z" }],
    }));
    vi.resetModules();
    const withRegistry = await import("../gateway/auth.js");
    expect(await withRegistry.authenticatedUser(`Bearer ${await withRegistry.createToken("admin", { role: "admin" })}`)).toBeNull();

    // A registry that cannot be read keeps it shut as well.
    writeConfig({ enabled: true, users: [] });
    mkdirSync(join(workspace, ".starlingai"), { recursive: true });
    writeFileSync(join(workspace, ".starlingai", "accounts.json"), "{ not json");
    vi.resetModules();
    const unreadable = await import("../gateway/auth.js");
    expect(await unreadable.authenticatedUser(`Bearer ${await unreadable.createToken("admin", { role: "admin" })}`)).toBeNull();
  });

  it("refuses a deleted builtin account's token under provider oidc too (mixed mode)", async () => {
    const alice = testAccount("alice");
    const bob = testAccount("bob");
    const { authModule, loader, resolve } = await boot({
      enabled: true,
      provider: "oidc",
      oidc: { issuer: "https://idp.example.test/realms/sai", clientId: "sai", roleMapping: { defaultRole: "operator" } },
      users: [alice.record, bob.record],
    });
    const token = await authModule.createToken("alice", alice.claims);
    expect((await resolve(token))?.account).toBe(alice.id);
    loader.updateConfig((raw) => {
      const auth = raw["auth"] as { users: Array<{ username: string }> };
      auth.users = auth.users.filter((user) => user.username !== "alice");
    });
    expect(await resolve(token)).toBeNull();
  });
});

describe("an extension credential store", () => {
  it("never mints the reserved claims into a token, and ignores them in one", async () => {
    const { extension, authModule, login, tokenOf, resolve } = await boot({ enabled: true, users: [] });
    const carol = {
      id: "u-17",
      username: "carol",
      role: "operator",
      claims: { aid: testAccountId("alice"), bst: true, kvnr: "A123456789" },
    };
    extension._recordLoadedExtension(
      { name: "store", version: "1", toolNames: [], auditEvents: [], roles: [], loadedAt: "", source: "test" },
      {
        name: "store",
        version: "1",
        authProvider: {
          verifyCredentials: async (username) => (username === "carol" ? carol : null),
          getUserById: (id) => (id === "u-17" ? carol : null),
        },
      },
    );
    const token = await tokenOf(await login("carol", "any-password"));
    const claims = payloadOf(token);
    expect(claims["kvnr"]).toBe("A123456789");
    expect(claims).not.toHaveProperty("aid");
    expect(claims).not.toHaveProperty("bst");

    const { extensionAccountId } = await import("../runtime/accounts.js");
    expect(await resolve(token)).toEqual({ username: "u-17", role: "operator", displayName: undefined, account: extensionAccountId("u-17") });
    // A token minted with both claims by other means is still only the store's user.
    const forged = await authModule.createToken("u-17", { role: "admin", aid: testAccountId("alice"), bst: true });
    expect(await resolve(forged)).toEqual({ username: "u-17", role: "operator", displayName: undefined, account: extensionAccountId("u-17") });
    // Bootstrap tokens are not supported under an extension store, as before.
    expect(await resolve(await authModule.createToken("admin", { role: "admin", bst: true }))).toBeNull();
  });
});

describe("the bootstrap tokens the scripts mint", () => {
  it("sai token (gen-token.mjs) mints one that resolves as the bootstrap principal", async () => {
    const admin = testAccount("admin", "operator");
    const { resolve } = await boot({ enabled: true, users: [admin.record] });
    const token = execFileSync(process.execPath, [join(REPO_ROOT, "scripts", "gen-token.mjs")], {
      cwd: workspace,
      env: { ...process.env, SAI_JWT_SECRET: SECRET },
      encoding: "utf8",
    }).trim();
    expect(payloadOf(token)["bst"]).toBe(true);
    expect(await resolve(token)).toMatchObject({ username: "admin", role: "admin", principal: "bootstrap" });
  });

  it("the setup wizard's dashboard token does too", async () => {
    const { resolve } = await boot({ enabled: true, users: [testAccount("admin", "operator").record] });
    // Every secret present, so the wizard rotates nothing and writes only into this directory.
    const filler = (char: string) => char.repeat(48);
    writeFileSync(join(workspace, ".env"), [
      `SAI_JWT_SECRET=${SECRET}`,
      `SAI_MASTER_KEY=${filler("m")}`,
      `POSTGRES_PASSWORD=${filler("p")}`,
      `SAI_MAIL_SERVICE_TOKEN=${filler("t")}`,
      `SAI_COMPUTER_REMOTE_TOKEN=${filler("c")}`,
      "SAI_S3_ACCESS_KEY_ID=starlingai",
      `SAI_S3_SECRET_ACCESS_KEY=${filler("s")}`,
      "",
    ].join("\n"));
    execFileSync(process.execPath, [join(REPO_ROOT, "scripts", "setup-wizard.mjs"), "--defaults"], {
      cwd: workspace,
      env: { ...process.env, SAI_SETUP_BACKEND: "byo-openai", SAI_SETUP_IAM: "builtin" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const token = readFileSync(join(workspace, ".starlingai", "dashboard-token.txt"), "utf8").trim();
    expect(payloadOf(token)["bst"]).toBe(true);
    expect(await resolve(token)).toMatchObject({ username: "admin", role: "admin", principal: "bootstrap" });
  });
});
