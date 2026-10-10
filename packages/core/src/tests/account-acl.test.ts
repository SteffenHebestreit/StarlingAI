import { afterEach, describe, expect, it, vi } from "vitest";
import * as configLoader from "../config/loader.js";
import { aclEntryMatches, canAccessResource } from "../guardrails/resource-access.js";
import { bareAclEntriesNamingNoAccount } from "../guardrails/acl-entries-check.js";
import { mailIdentityHeaders, callMailService } from "../tools/mail-service-client.js";
import { runWithRequestContext } from "../runtime/request-context.js";
import type { Identity } from "../runtime/accounts.js";

/**
 * `allowedUsers` entries match by identity kind under multi-user auth (S3, design §3.9).
 *
 * A bare entry matched any caller whose raw name was the same string: a Telegram id, a mail From
 * address, an A2A peer's `sub`, a scene run, or an account created again under a deleted one's
 * name. Under multi-user auth a bare name now grants only an account by its username (or a
 * bootstrap token by its `sub`); `account:<id>` names one account for good; `principal:<raw>` names
 * a principal. The mail-service gets the caller in the same forms. With one operator, by name.
 */

const ALICE: Identity = { userId: "alice", account: "alice-0000000000000001" };
const RECREATED_ALICE: Identity = { userId: "alice", account: "alice-0000000000000002" };
const TELEGRAM_ALICE: Identity = { userId: "alice", principal: "channel" };
const TELEGRAM_12345: Identity = { userId: "12345", principal: "channel" };
const BOOTSTRAP: Identity = { userId: "admin", principal: "bootstrap" };

function withAuth(enabled: boolean): void {
  vi.spyOn(configLoader, "getConfig").mockReturnValue(
    { auth: { enabled }, mail: { serviceUrl: "http://mail.test", timeoutMs: 1000 } } as unknown as ReturnType<typeof configLoader.getConfig>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("allowedUsers under multi-user auth", () => {
  it("a channel principal never matches a bare entry, even with an account's name", () => {
    withAuth(true);
    expect(canAccessResource(TELEGRAM_ALICE, { allowedUsers: ["alice"] })).toBe(false);
    expect(canAccessResource(TELEGRAM_12345, { allowedUsers: ["12345"] })).toBe(false);
    // The account of that name does.
    expect(canAccessResource(ALICE, { allowedUsers: ["alice"] })).toBe(true);
    // So does a bootstrap token with that sub, as before: an instance credential.
    expect(canAccessResource(BOOTSTRAP, { allowedUsers: ["admin"] })).toBe(true);
  });

  it("account:<id> matches that account only, not another of the same name", () => {
    withAuth(true);
    const entry = [`account:${ALICE.account}`];
    expect(canAccessResource(ALICE, { allowedUsers: entry })).toBe(true);
    expect(canAccessResource(RECREATED_ALICE, { allowedUsers: entry })).toBe(false);
    expect(canAccessResource(TELEGRAM_ALICE, { allowedUsers: entry })).toBe(false);
    expect(aclEntryMatches(`ACCOUNT:${ALICE.account!.toUpperCase()}`, ALICE)).toBe(true);
  });

  it("principal:<raw> matches only that principal", () => {
    withAuth(true);
    const entry = ["principal:12345"];
    expect(canAccessResource(TELEGRAM_12345, { allowedUsers: entry })).toBe(true);
    expect(canAccessResource({ userId: "12345", account: "u-0000000000000003" }, { allowedUsers: entry })).toBe(false);
    expect(canAccessResource({ userId: "12345", principal: "bootstrap" }, { allowedUsers: entry })).toBe(false);
    expect(canAccessResource({ userId: "67890", principal: "channel" }, { allowedUsers: entry })).toBe(false);
  });

  it("a name with no kind is a principal here, as it is for storage", () => {
    withAuth(true);
    expect(canAccessResource({ userId: "alice" }, { allowedUsers: ["alice"] })).toBe(false);
    expect(canAccessResource({ userId: "alice" }, { allowedUsers: ["principal:alice"] })).toBe(true);
    expect(canAccessResource(undefined, { allowedUsers: ["alice"] })).toBe(false);
  });

  it("with one operator, every entry is a name, as before", () => {
    withAuth(false);
    expect(canAccessResource(TELEGRAM_ALICE, { allowedUsers: ["alice"] })).toBe(true);
    expect(canAccessResource({ userId: "bob" }, { allowedUsers: ["alice"] })).toBe(false);
    expect(canAccessResource(undefined, { allowedUsers: ["alice"] })).toBe(true);
  });

  it("the boot check names the bare entries no account holds, and only those", () => {
    const found = bareAclEntriesNamingNoAccount([
      { where: "sites.example.com", entries: ["alice", "12345", "principal:67890", `account:${ALICE.account}`] },
      { where: "computerUse.nodes.lab", entries: ["Admin"] },
    ], new Set(["alice", "admin"]));
    expect(found).toEqual([{ where: "sites.example.com", entry: "12345" }]);
  });
});

describe("the mail-service headers", () => {
  it("name the caller in the form its entries take", () => {
    withAuth(true);
    expect(mailIdentityHeaders(ALICE)).toEqual({ "X-Sai-User": "alice", "X-Sai-Account": ALICE.account });
    expect(mailIdentityHeaders(BOOTSTRAP)).toEqual({ "X-Sai-User": "admin" });
    expect(mailIdentityHeaders(TELEGRAM_ALICE)).toEqual({ "X-Sai-User": "principal:alice" });
    expect(mailIdentityHeaders({ userId: "scene:digest", principal: "synthetic" })).toEqual({ "X-Sai-User": "principal:scene:digest" });
    expect(mailIdentityHeaders({ userId: "alice" })).toEqual({ "X-Sai-User": "principal:alice" });
    expect(mailIdentityHeaders(undefined)).toEqual({});
  });

  it("go out on a mail-service call made for the identity of the work", async () => {
    withAuth(true);
    const seen: Array<Record<string, string>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
      seen.push(init.headers);
      return new Response("[]", { status: 200 });
    }));
    await runWithRequestContext({ identity: TELEGRAM_ALICE }, () => callMailService("/api/accounts"));
    await runWithRequestContext({ identity: ALICE }, () => callMailService("/api/accounts"));
    expect(seen[0]?.["X-Sai-User"]).toBe("principal:alice");
    expect(seen[0]?.["X-Sai-Account"]).toBeUndefined();
    expect(seen[1]?.["X-Sai-User"]).toBe("alice");
    expect(seen[1]?.["X-Sai-Account"]).toBe(ALICE.account);
  });

  it("with one operator, carry the name alone, as before", () => {
    withAuth(false);
    expect(mailIdentityHeaders({ userId: "alice" })).toEqual({ "X-Sai-User": "alice" });
  });
});
