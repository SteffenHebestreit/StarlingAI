import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Session 56d4f3e4 (2026-10-17): asked for "the document in the second mail", the agent passed the
 * account's address as its id (a bare "HTTP 404" came back), read the message without seeing its
 * 400 KB PDF, and reported "no attachment". These cover the account lookup, the error body, the
 * attachment listing and download, and the counts a search reports.
 */

const state = vi.hoisted(() => ({
  source: "",
  searches: [] as Array<{ accountId: string; query: string }>,
}));

vi.mock("../imap-client.js", () => ({
  MailAccountClient: class {
    constructor(private readonly account: { id: string }) {}
    async searchSummaries(query: string, _mailboxes: string[], _limit: number, counts?: Array<Record<string, unknown>>) {
      state.searches.push({ accountId: this.account.id, query });
      counts?.push({ accountId: this.account.id, mailbox: "INBOX", matched: 570, exists: 570 });
      return [{ accountId: this.account.id, mailbox: "INBOX", uid: 1231, messageId: "m", from: "tom@example.com", to: "", cc: "", subject: "Billing", date: "2026-10-02T05:49:01.000Z", attachmentCount: 1, textPreview: "" }];
    }
    async readMessage(mailbox: string, uid: number) {
      return { accountId: this.account.id, mailbox, uid, source: Buffer.from(state.source) };
    }
  },
}));

import { createApp } from "../app.js";

/** A logo shown inside the HTML (multipart/related), then a PDF sent alongside it. */
const MESSAGE_WITH_PDF = [
  "From: Tom <tom@example.com>", "To: me@example.com", "Subject: Billing", "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="mixed"', "", "--mixed",
  'Content-Type: multipart/related; boundary="rel"', "", "--rel",
  "Content-Type: text/html; charset=utf-8", "", '<p>Fill it in and send it back.</p><img src="cid:logo@x">', "--rel",
  "Content-Type: image/png", "Content-ID: <logo@x>", 'Content-Disposition: inline; filename="logo.png"', "Content-Transfer-Encoding: base64", "", "iVBORw0KGgo=", "--rel--",
  "--mixed", 'Content-Type: application/pdf; name="billing.pdf"', 'Content-Disposition: attachment; filename="billing.pdf"', "Content-Transfer-Encoding: base64", "", Buffer.from("%PDF-1.7 billing").toString("base64"), "--mixed--", "",
].join("\r\n");

const credentials = { imap: { host: "h", port: 993, secure: true, user: "u", pass: "p" }, smtp: { host: "h", port: 465, secure: true, user: "u", pass: "p" } };
const accounts = [
  { id: "work", address: "Me@Example.com", ...credentials },
  { id: "alice-only", address: "alice@example.com", allowedUsers: ["alice"], ...credentials },
];
const store = { getCategory: vi.fn(async () => null) };

function post(path: string, body: unknown, user = "bob") {
  return createApp({ accounts, store: store as never }).fetch(new Request(`http://m${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Sai-User": user },
    body: JSON.stringify(body),
  }));
}

describe("naming an account", () => {
  beforeEach(() => {
    state.source = MESSAGE_WITH_PDF;
    state.searches.length = 0;
  });

  it("finds it by its address as well as its id, ignoring case", async () => {
    const response = await post("/api/messages/read", { accountId: "me@example.com", mailbox: "INBOX", uid: 1231 });
    expect(response.status).toBe(200);
    expect((await response.json() as { accountId: string }).accountId).toBe("work");
  });

  it("answers an unknown account in JSON, naming the ids the caller may use", async () => {
    const response = await post("/api/messages/read", { accountId: "nobody@example.com", mailbox: "INBOX", uid: 1 });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Unknown account: nobody@example.com. Account ids: work." });
  });

  it("fails a search naming an unknown account instead of answering that nothing matched", async () => {
    const response = await post("/api/messages/search", { accountIds: ["typo"], query: "" });
    expect(response.status).toBe(404);
    expect(state.searches).toEqual([]);
  });

  it("searches an account named by its address once, even when named twice", async () => {
    const response = await post("/api/messages/search", { accountIds: ["ME@example.com", "work"], query: "" });
    expect(response.status).toBe(200);
    expect(state.searches).toEqual([{ accountId: "work", query: "" }]);
  });

  it("still refuses an account the caller may not use", async () => {
    const response = await post("/api/messages/search", { accountIds: ["alice@example.com"], query: "" });
    expect(response.status).toBe(403);
    expect(state.searches).toEqual([]);
  });
});

describe("search counts", () => {
  it("come with the listing when asked for, and the bare list stays the default", async () => {
    const counted = await (await post("/api/messages/search", { accountIds: ["work"], query: "", limit: 1, withCounts: true })).json() as { messages: unknown[]; counts: unknown[] };
    expect(counted.messages).toHaveLength(1);
    expect(counted.counts).toEqual([{ accountId: "work", mailbox: "INBOX", matched: 570, exists: 570 }]);

    const bare = await (await post("/api/messages/search", { accountIds: ["work"], query: "" })).json();
    expect(Array.isArray(bare)).toBe(true);
  });
});

describe("attachments", () => {
  beforeEach(() => {
    state.source = MESSAGE_WITH_PDF;
  });

  it("are listed with the number that fetches them, and an embedded logo is marked as such", async () => {
    const message = await (await post("/api/messages/read", { accountId: "work", mailbox: "INBOX", uid: 1231 })).json() as { attachments: unknown[] };
    expect(message.attachments).toEqual([
      { index: 1, filename: "logo.png", contentType: "image/png", size: 8, embedded: true },
      { index: 2, filename: "billing.pdf", contentType: "application/pdf", size: 16, embedded: false },
    ]);
  });

  it("are handed out by that number with their bytes", async () => {
    const response = await post("/api/messages/attachment", { accountId: "me@example.com", mailbox: "INBOX", uid: 1231, index: 2 });
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ accountId: "work", index: 2, filename: "billing.pdf", contentType: "application/pdf", size: 16, embedded: false });
    expect(Buffer.from(String(body["contentBase64"]), "base64").toString("latin1")).toBe("%PDF-1.7 billing");
  });

  it("answer a number past the last one with how many there are", async () => {
    const response = await post("/api/messages/attachment", { accountId: "work", mailbox: "INBOX", uid: 1231, index: 3 });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Message 1231 has 2 attachment(s); there is no attachment 3." });
  });
});
