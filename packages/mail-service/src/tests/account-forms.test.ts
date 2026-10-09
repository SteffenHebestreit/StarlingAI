import { describe, expect, it, vi } from "vitest";

vi.mock("../imap-client.js", () => ({
  MailAccountClient: class {
    async listMailboxes() { return []; }
  },
}));

import { createApp } from "../app.js";
import { accountAllowsUser, entryNamesCaller } from "../account-access.js";

/**
 * `allowedUsers` and `isolatedUsers` entries in three forms (the gateway's identity kinds):
 *
 *   account:<id>     an account by its immutable id (X-Sai-Account);
 *   principal:<raw>  a channel sender, an A2A peer or a scene run (X-Sai-User: principal:<raw>);
 *   <name>           an account's username, or a bootstrap token's sub (X-Sai-User: <name>).
 *
 * A bare name matched whatever X-Sai-User a caller carried, and the gateway sent a principal's raw
 * name, so a mail From address or a Telegram id equal to a listed username was granted that
 * mailbox. The gateway now sends a principal with its prefix, which no bare entry equals.
 */
const imap = { host: "h", port: 993, secure: true, user: "u", pass: "p" };
const smtp = { host: "h", port: 465, secure: true, user: "u", pass: "p" };
const ALICE_ID = "alice-0000000000000001";
const accounts = [
  { id: "shared", address: "team@example.com", imap, smtp, withheldFrom: ["principal:12345", `account:${ALICE_ID}`] },
  { id: "by-name", address: "alice@example.com", allowedUsers: ["alice"], imap, smtp },
  { id: "by-id", address: "alice2@example.com", allowedUsers: [`account:${ALICE_ID}`], imap, smtp },
  { id: "by-sender", address: "bot@example.com", allowedUsers: ["principal:12345"], imap, smtp },
];
const store = { getCategory: vi.fn(async () => null) };

async function visible(headers: Record<string, string>): Promise<string[]> {
  const res = await createApp({ accounts, store: store as never }).fetch(new Request("http://m/api/accounts", { headers }));
  return ((await res.json()) as Array<{ id: string }>).map((account) => account.id);
}

describe("mail-service entries by identity kind", () => {
  it("an account reaches its name's and its id's mailboxes, and is withheld by its id", async () => {
    expect(await visible({ "X-Sai-User": "alice", "X-Sai-Account": ALICE_ID })).toEqual(["by-name", "by-id"]);
  });

  it("an account created again under that name reaches the name's, not the old id's", async () => {
    expect(await visible({ "X-Sai-User": "alice", "X-Sai-Account": "alice-0000000000000002" })).toEqual(["shared", "by-name"]);
  });

  it("a principal with an account's name reaches no bare entry", async () => {
    expect(await visible({ "X-Sai-User": "principal:alice" })).toEqual(["shared"]);
  });

  it("principal:<raw> names that principal only, and withholds a shared account from it", async () => {
    expect(await visible({ "X-Sai-User": "principal:12345" })).toEqual(["by-sender"]);
    expect(await visible({ "X-Sai-User": "12345" })).toEqual(["shared"]);
  });

  it("matches entries without case", () => {
    expect(entryNamesCaller(`ACCOUNT:${ALICE_ID.toUpperCase()}`, { account: ALICE_ID })).toBe(true);
    expect(entryNamesCaller("Principal:12345", { user: "principal:12345" })).toBe(true);
    expect(entryNamesCaller("ALICE", { user: "alice" })).toBe(true);
  });

  it("takes a caller given as its X-Sai-User value alone, as before", () => {
    expect(accountAllowsUser(accounts[1]!, "alice")).toBe(true);
    expect(accountAllowsUser(accounts[1]!, "bob")).toBe(false);
    expect(accountAllowsUser(accounts[0]!, undefined)).toBe(true);
  });
});
