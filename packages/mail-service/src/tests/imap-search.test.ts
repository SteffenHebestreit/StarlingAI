import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 2026-10-17: the agent told the user their mailbox was empty. The INBOX held 570 messages; imapflow
 * had switched on IMAP4rev2, which Strato offers, and in that mode Strato answers SEARCH ALL with an
 * empty ESEARCH. Every search found nothing, and nothing said so.
 */

const state = vi.hoisted(() => ({
  options: [] as Array<Record<string, unknown>>,
  searchResult: [] as number[],
  exists: 570,
}));

vi.mock("imapflow", () => ({
  ImapFlow: class {
    mailbox = { exists: state.exists };
    constructor(options: Record<string, unknown>) {
      state.options.push(options);
    }
    async connect() {}
    async list() { return []; }
    async getMailboxLock() { return { release: () => undefined }; }
    async search() { return state.searchResult; }
    async *fetch() { /* no messages */ }
    async logout() {}
  },
}));

const { MailAccountClient, assertSearchConsistent } = await import("../imap-client.js");

const account = {
  id: "work",
  address: "me@example.com",
  imap: { host: "imap.example.com", port: 993, secure: true, user: "me", pass: "secret" },
  smtp: { host: "smtp.example.com", port: 465, secure: true, user: "me", pass: "secret" },
} as never;

describe("searching a mailbox", () => {
  beforeEach(() => {
    state.options.length = 0;
    state.searchResult = [];
    state.exists = 570;
  });

  it("connects without switching on the extensions the server offers", async () => {
    await new MailAccountClient(account).searchSummaries("is:unread", ["INBOX"], 5);
    expect(state.options[0]).toMatchObject({ disableAutoEnable: true });
  });

  it("fails, rather than answer 'no messages', when a search for everything finds none in a full mailbox", async () => {
    await expect(new MailAccountClient(account).searchSummaries("", ["INBOX"], 2)).rejects.toThrow(/INBOX, which holds 570/);
  });

  it("answers an ordinary empty result for a narrower query, or a mailbox that is empty", async () => {
    await expect(new MailAccountClient(account).searchSummaries("is:unread", ["INBOX"], 5)).resolves.toEqual([]);
    state.exists = 0;
    await expect(new MailAccountClient(account).searchSummaries("", ["INBOX"], 5)).resolves.toEqual([]);
  });

  it("reports how many messages matched and how many the mailbox holds, beyond the ones it lists", async () => {
    state.searchResult = [3, 9, 27];
    const counts: Array<Record<string, unknown>> = [];
    await new MailAccountClient(account).searchSummaries("is:unread", ["INBOX"], 2, counts);
    expect(counts).toEqual([{ accountId: "work", mailbox: "INBOX", matched: 3, exists: 570 }]);
  });

  it("judges only a search for everything", () => {
    expect(() => assertSearchConsistent("INBOX", { all: true }, 0, 3)).toThrow();
    expect(() => assertSearchConsistent("INBOX", { all: true }, 3, 3)).not.toThrow();
    expect(() => assertSearchConsistent("INBOX", { all: true, seen: false }, 0, 3)).not.toThrow();
    expect(() => assertSearchConsistent("INBOX", { all: true }, 0, undefined)).not.toThrow();
  });
});
