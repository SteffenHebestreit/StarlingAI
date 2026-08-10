import { beforeEach, describe, expect, it, vi } from "vitest";

const listMailboxesMock = vi.fn();
const createMailboxMock = vi.fn();
const searchMock = vi.fn();
const moveMessageMock = vi.fn();
const deleteMessageMock = vi.fn();

vi.mock("../imap-client.js", () => ({
  MailAccountClient: class {
    async listMailboxes() { return listMailboxesMock(); }
    async createMailbox(path: string) { return createMailboxMock(path); }
    async searchSummaries(query: string, mailboxes?: string[], limit?: number) { return searchMock(query, mailboxes, limit); }
    async readMessage() { return null; }
    async moveMessage(mailbox: string, uid: number, dest: string) { moveMessageMock(mailbox, uid, dest); return { destination: dest }; }
    async deleteMessage(mailbox: string, uid: number, permanent?: boolean) { deleteMessageMock(mailbox, uid, permanent); return { movedToTrash: true }; }
  },
}));

vi.mock("../email-parser.js", () => ({
  EmailParser: { parse: vi.fn(async (m: Record<string, unknown>) => ({ accountId: String(m["accountId"] ?? "shared"), mailbox: "INBOX", uid: 1, subject: "s", from: "f", date: "2026-01-01T00:00:00Z" })) },
}));

import { createApp } from "../app.js";

const accounts = [
  { id: "shared", address: "team@example.com", imap: { host: "h", port: 993, secure: true, user: "u", pass: "p" }, smtp: { host: "h", port: 465, secure: true, user: "u", pass: "p" } },
  { id: "alice-only", address: "alice@example.com", allowedUsers: ["alice"], imap: { host: "h", port: 993, secure: true, user: "u", pass: "p" }, smtp: { host: "h", port: 465, secure: true, user: "u", pass: "p" } },
];

const store = { getCategory: vi.fn(async () => null), categorize: vi.fn(), createDraft: vi.fn(), getDraft: vi.fn(), updateDraft: vi.fn(), markDraftSent: vi.fn() };

function app() { return createApp({ accounts, store: store as never }); }

describe("mail-service per-user access control", () => {
  beforeEach(() => { listMailboxesMock.mockReset(); createMailboxMock.mockReset(); searchMock.mockReset(); moveMessageMock.mockReset(); deleteMessageMock.mockReset(); });

  it("lists all accounts for the allowed user", async () => {
    const res = await app().fetch(new Request("http://m/api/accounts", { headers: { "X-Sai-User": "alice" } }));
    const ids = (await res.json() as Array<{ id: string }>).map((a) => a.id);
    expect(ids).toEqual(["shared", "alice-only"]);
  });

  it("hides restricted accounts from other users", async () => {
    const res = await app().fetch(new Request("http://m/api/accounts", { headers: { "X-Sai-User": "bob" } }));
    const ids = (await res.json() as Array<{ id: string }>).map((a) => a.id);
    expect(ids).toEqual(["shared"]);
  });

  it("lists all accounts when no user header is present (single-user / auth off)", async () => {
    const res = await app().fetch(new Request("http://m/api/accounts"));
    const ids = (await res.json() as Array<{ id: string }>).map((a) => a.id);
    expect(ids).toEqual(["shared", "alice-only"]);
  });

  it("hides restricted accounts from an unidentified caller when auth is on", async () => {
    // A missing header means "there is no user" on a single-operator install and
    // "the header was dropped" on a multi-user one. Where gateway auth is enabled
    // the deployment sets this flag, and a bound account then cannot be reached by
    // simply omitting the header — an access list you can opt out of is not one.
    process.env["SAI_MAIL_REQUIRE_IDENTIFIED_USER"] = "true";
    try {
      const res = await app().fetch(new Request("http://m/api/accounts"));
      const ids = (await res.json() as Array<{ id: string }>).map((a) => a.id);
      expect(ids).toEqual(["shared"]);
    } finally {
      delete process.env["SAI_MAIL_REQUIRE_IDENTIFIED_USER"];
    }
  });

  it("403s a restricted account for a disallowed user", async () => {
    const res = await app().fetch(new Request("http://m/api/mailboxes", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Sai-User": "bob" },
      body: JSON.stringify({ accountId: "alice-only", path: "X" }),
    }));
    expect(res.status).toBe(403);
    expect(createMailboxMock).not.toHaveBeenCalled();
  });

  it("allows a restricted account for the allowed user", async () => {
    createMailboxMock.mockResolvedValue({ path: "X", name: "X", specialUse: null, delimiter: "/" });
    const res = await app().fetch(new Request("http://m/api/mailboxes", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Sai-User": "alice" },
      body: JSON.stringify({ accountId: "alice-only", path: "X" }),
    }));
    expect(res.status).toBe(201);
    expect(createMailboxMock).toHaveBeenCalled();
  });

  it("restricts search to accounts the user may access", async () => {
    searchMock.mockResolvedValue([]);
    await app().fetch(new Request("http://m/api/messages/search", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Sai-User": "bob" },
      body: JSON.stringify({ query: "x" }),
    }));
    // Only the shared account is searched (alice-only filtered out for bob).
    expect(searchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects draft creation for a restricted account", async () => {
    const res = await app().fetch(new Request("http://m/api/drafts", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Sai-User": "bob" },
      body: JSON.stringify({ accountId: "alice-only", to: ["recipient@example.com"], subject: "Hello", textBody: "Body" }),
    }));
    expect(res.status).toBe(403);
    expect(store.createDraft).not.toHaveBeenCalled();
  });

  it("rejects a mixed-account category batch before it mutates state", async () => {
    const res = await app().fetch(new Request("http://m/api/messages/categorize", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Sai-User": "bob" },
      body: JSON.stringify({ items: [
        { accountId: "shared", mailbox: "INBOX", uid: 1, category: "ok" },
        { accountId: "alice-only", mailbox: "INBOX", uid: 2, category: "private" },
      ] }),
    }));
    expect(res.status).toBe(403);
    expect(store.categorize).not.toHaveBeenCalled();
  });

  it("rejects a mixed-account move batch before moving any message", async () => {
    const res = await app().fetch(new Request("http://m/api/messages/move", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Sai-User": "bob" },
      body: JSON.stringify({ destinationMailbox: "Archive", items: [
        { accountId: "shared", mailbox: "INBOX", uid: 1 },
        { accountId: "alice-only", mailbox: "INBOX", uid: 2 },
      ] }),
    }));
    expect(res.status).toBe(403);
    expect(moveMessageMock).not.toHaveBeenCalled();
  });

  it("rejects a mixed-account delete batch before deleting any message", async () => {
    const res = await app().fetch(new Request("http://m/api/messages/delete", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Sai-User": "bob" },
      body: JSON.stringify({ permanent: true, items: [
        { accountId: "shared", mailbox: "INBOX", uid: 1 },
        { accountId: "alice-only", mailbox: "INBOX", uid: 2 },
      ] }),
    }));
    expect(res.status).toBe(403);
    expect(deleteMessageMock).not.toHaveBeenCalled();
  });
});
