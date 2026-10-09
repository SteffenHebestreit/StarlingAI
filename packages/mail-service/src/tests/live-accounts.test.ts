import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accountAllowsUser } from "../account-access.js";
import { createApp } from "../app.js";
import { loadMailServiceConfig, readAccountsOverlay } from "../config.js";
import { LiveAccounts } from "../live-accounts.js";
import type { MailAccountConfig } from "../types.js";

/**
 * The accounts overlay directory: accounts added and removed while the service runs, without
 * touching the main accounts file — how the e2e test environment wires its synthetic mailbox.
 */
const server = { host: "h", port: 993, secure: true, user: "u", pass: "p" };
const shared: MailAccountConfig = { id: "work", address: "team@example.com", imap: server, smtp: server };
const bound: MailAccountConfig = { id: "alice-only", address: "alice@example.com", allowedUsers: ["alice"], imap: server, smtp: server };

function overlayAccount(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    address: `${id}@e2e.test`,
    imap: { host: "e2e-mail", port: 3143, secure: false, user: `${id}@e2e.test`, pass: "pw" },
    smtp: { host: "e2e-mail", port: 3025, secure: false, user: `${id}@e2e.test`, pass: "pw" },
    ...extra,
  };
}

const EVAL_OVERLAY = JSON.stringify({
  accounts: [overlayAccount("eval", { allowedUsers: ["eval"] })],
  isolatedUsers: ["eval", "Eval-Viewer"],
});

describe("LiveAccounts — the accounts overlay directory", () => {
  let dir: string;
  let overlayDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "starlingai-mail-overlay-"));
    overlayDir = join(dir, "accounts.d");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves only the main accounts while the directory does not exist", async () => {
    const live = new LiveAccounts({ accounts: [shared, bound], isolatedUsers: [] }, overlayDir, 0);
    await live.refresh();
    expect(live.list.map((a) => a.id)).toEqual(["work", "alice-only"]);
    expect(live.list.every((a) => a.withheldFrom === undefined)).toBe(true);
  });

  it("adds an overlay account while running and drops it again when the file goes", async () => {
    const live = new LiveAccounts({ accounts: [shared, bound], isolatedUsers: [] }, overlayDir, 0);
    const routesView = live.list; // what createApp holds: the same array, updated in place
    await live.refresh();

    mkdirSync(overlayDir);
    writeFileSync(join(overlayDir, "e2e.json5"), EVAL_OVERLAY);
    await live.refresh();
    expect(routesView.map((a) => a.id)).toEqual(["work", "alice-only", "eval"]);

    rmSync(join(overlayDir, "e2e.json5"));
    await live.refresh();
    expect(routesView.map((a) => a.id)).toEqual(["work", "alice-only"]);
  });

  it("withholds shared accounts from isolated users, and only from them", async () => {
    mkdirSync(overlayDir);
    writeFileSync(join(overlayDir, "e2e.json5"), EVAL_OVERLAY);
    const live = new LiveAccounts({ accounts: [shared, bound], isolatedUsers: [] }, overlayDir, 0);
    await live.refresh();
    const byId = (id: string) => live.list.find((a) => a.id === id)!;

    // The isolated eval identities see the eval mailbox and nothing of the operator's mail.
    expect(accountAllowsUser(byId("work"), "eval")).toBe(false);
    expect(accountAllowsUser(byId("work"), "EVAL-viewer")).toBe(false);
    expect(accountAllowsUser(byId("eval"), "eval")).toBe(true);
    // Everyone else is unaffected, and nobody else sees the eval mailbox.
    expect(accountAllowsUser(byId("work"), "alice")).toBe(true);
    expect(accountAllowsUser(byId("work"), undefined)).toBe(true);
    expect(accountAllowsUser(byId("alice-only"), "alice")).toBe(true);
    expect(accountAllowsUser(byId("eval"), "alice")).toBe(false);

    // Once the overlay is gone, the isolation goes with it.
    rmSync(join(overlayDir, "e2e.json5"));
    await live.refresh();
    expect(accountAllowsUser(byId("work"), "eval")).toBe(true);
  });

  it("never lets an overlay replace an account, and skips a broken file without losing the rest", async () => {
    mkdirSync(overlayDir);
    writeFileSync(join(overlayDir, "a-takeover.json"), JSON.stringify({ accounts: [overlayAccount("work"), overlayAccount("extra")] }));
    writeFileSync(join(overlayDir, "b-broken.json5"), "{ accounts: [ { id: 'x' ");
    writeFileSync(join(overlayDir, "c-invalid.json"), JSON.stringify({ accounts: [{ id: "no-address" }] }));
    writeFileSync(join(overlayDir, "d-eval.jsonc"), EVAL_OVERLAY);
    writeFileSync(join(overlayDir, ".hidden.json"), JSON.stringify({ accounts: [overlayAccount("hidden")] }));
    writeFileSync(join(overlayDir, "notes.txt"), "not an accounts file");
    const live = new LiveAccounts({ accounts: [shared], isolatedUsers: [] }, overlayDir, 0);
    await live.refresh();

    expect(live.list.map((a) => a.id)).toEqual(["work", "extra", "eval"]);
    expect(live.list.find((a) => a.id === "work")!.address).toBe("team@example.com");

    const overlay = await readAccountsOverlay(overlayDir);
    expect(overlay.files.filter((f) => f.error).map((f) => f.file)).toEqual(["b-broken.json5", "c-invalid.json"]);
  });

  it("re-reads the directory at most once per interval", async () => {
    const live = new LiveAccounts({ accounts: [shared], isolatedUsers: [] }, overlayDir, 60_000);
    await live.refresh();
    mkdirSync(overlayDir);
    writeFileSync(join(overlayDir, "e2e.json5"), EVAL_OVERLAY);
    await live.refresh();
    expect(live.list.map((a) => a.id)).toEqual(["work"]);
  });

  it("is what the routes serve: /health and /api/accounts follow the overlay", async () => {
    const live = new LiveAccounts({ accounts: [shared], isolatedUsers: [] }, overlayDir, 0);
    await live.refresh();
    const store = {} as never;
    const app = createApp({ accounts: live.list, store, refreshAccounts: () => live.refresh() });

    const health = async () => (await (await app.fetch(new Request("http://m/health"))).json()) as { accounts: number };
    const visibleTo = async (user: string) => ((await (await app.fetch(new Request("http://m/api/accounts", { headers: { "X-Sai-User": user } }))).json()) as Array<{ id: string }>).map((a) => a.id);

    expect((await health()).accounts).toBe(1);
    mkdirSync(overlayDir);
    writeFileSync(join(overlayDir, "e2e.json5"), EVAL_OVERLAY);
    expect((await health()).accounts).toBe(2);
    expect(await visibleTo("eval")).toEqual(["eval"]);
    expect(await visibleTo("alice")).toEqual(["work"]);
  });
});

describe("loadMailServiceConfig — overlay directory + isolatedUsers", () => {
  const previous = {
    configPath: process.env["SAI_MAIL_SERVICE_CONFIG_PATH"],
    accountsDir: process.env["SAI_MAIL_SERVICE_ACCOUNTS_DIR"],
  };
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "starlingai-mail-config-"));
  });

  afterEach(() => {
    for (const [key, value] of [["SAI_MAIL_SERVICE_CONFIG_PATH", previous.configPath], ["SAI_MAIL_SERVICE_ACCOUNTS_DIR", previous.accountsDir]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("defaults the overlay directory to accounts.d beside the accounts file, and reads isolatedUsers", async () => {
    const configPath = join(dir, "accounts.json");
    writeFileSync(configPath, JSON.stringify({ accounts: [overlayAccount("main")], isolatedUsers: ["guest"] }));
    process.env["SAI_MAIL_SERVICE_CONFIG_PATH"] = configPath;
    delete process.env["SAI_MAIL_SERVICE_ACCOUNTS_DIR"];

    const config = await loadMailServiceConfig();
    expect(config.accountsDir).toBe(join(dir, "accounts.d"));
    expect(config.isolatedUsers).toEqual(["guest"]);
    expect(config.accounts.map((a) => a.id)).toEqual(["main"]);
  });

  it("takes the overlay directory from SAI_MAIL_SERVICE_ACCOUNTS_DIR, also with no accounts file", async () => {
    process.env["SAI_MAIL_SERVICE_CONFIG_PATH"] = join(dir, "missing.json");
    process.env["SAI_MAIL_SERVICE_ACCOUNTS_DIR"] = join(dir, "elsewhere");

    const config = await loadMailServiceConfig();
    expect(config.accountsDir).toBe(join(dir, "elsewhere"));
    expect(config.accounts).toEqual([]);
    expect(config.isolatedUsers).toEqual([]);
  });
});
