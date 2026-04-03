import { beforeEach, describe, expect, it, vi } from "vitest";

const listMailboxesMock = vi.fn();
const createMailboxMock = vi.fn();
const deleteMailboxMock = vi.fn();
const searchMock = vi.fn();
const readMessageMock = vi.fn();
const moveMessageMock = vi.fn();
const deleteMessageMock = vi.fn();

vi.mock("../imap-client.js", () => ({
  MailAccountClient: class {
    async listMailboxes() {
      return listMailboxesMock();
    }

    async createMailbox(path: string) {
      return createMailboxMock(path);
    }

    async deleteMailbox(path: string) {
      return deleteMailboxMock(path);
    }

    async search(query: string, mailboxes?: string[], limit?: number) {
      return searchMock(query, mailboxes, limit);
    }

    async readMessage(mailbox: string, uid: number) {
      return readMessageMock(mailbox, uid);
    }

    async moveMessage(mailbox: string, uid: number, destinationMailbox: string) {
      return moveMessageMock(mailbox, uid, destinationMailbox);
    }

    async deleteMessage(mailbox: string, uid: number, permanent?: boolean) {
      return deleteMessageMock(mailbox, uid, permanent);
    }
  },
}));

vi.mock("../email-parser.js", () => ({
  EmailParser: {
    parse: vi.fn(async (message: Record<string, unknown>) => ({
      accountId: String(message["accountId"] ?? "work"),
      mailbox: String(message["mailbox"] ?? "INBOX"),
      uid: Number(message["uid"] ?? 1),
      messageId: "msg-1",
      from: "sender@example.com",
      to: "user@example.com",
      cc: "",
      subject: "Subject",
      date: "2026-04-03T00:00:00.000Z",
      html: "",
      textBody: "Body",
      attachments: [],
    })),
  },
}));

import { createApp } from "../app.js";

const accounts = [{
  id: "work",
  address: "user@example.com",
  imap: { host: "imap.example.com", port: 993, secure: true, user: "user", pass: "pass" },
  smtp: { host: "smtp.example.com", port: 465, secure: true, user: "user", pass: "pass" },
}];

const store = {
  getCategory: vi.fn(async () => null),
  categorize: vi.fn(async () => undefined),
  createDraft: vi.fn(),
  getDraft: vi.fn(),
  updateDraft: vi.fn(),
  markDraftSent: vi.fn(),
};

describe("mail service app", () => {
  beforeEach(() => {
    listMailboxesMock.mockReset();
    createMailboxMock.mockReset();
    deleteMailboxMock.mockReset();
    searchMock.mockReset();
    readMessageMock.mockReset();
    moveMessageMock.mockReset();
    deleteMessageMock.mockReset();
    store.getCategory.mockClear();
  });

  it("creates a mailbox for an account", async () => {
    createMailboxMock.mockResolvedValue({
      path: "Projects/Invoices",
      name: "Invoices",
      specialUse: null,
      delimiter: "/",
    });

    const app = createApp({ accounts, store: store as never });
    const response = await app.fetch(new Request("http://mail.local/api/mailboxes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: "work", path: "Projects/Invoices" }),
    }));

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ path: "Projects/Invoices" });
    expect(createMailboxMock).toHaveBeenCalledWith("Projects/Invoices");
  });

  it("moves messages and creates the destination mailbox when requested", async () => {
    createMailboxMock.mockResolvedValue({
      path: "Projects/Invoices",
      name: "Invoices",
      specialUse: null,
      delimiter: "/",
    });
    moveMessageMock.mockResolvedValue({ destination: "Projects/Invoices" });

    const app = createApp({ accounts, store: store as never });
    const response = await app.fetch(new Request("http://mail.local/api/messages/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [{ accountId: "work", mailbox: "INBOX", uid: 42 }],
        destinationMailbox: "Projects/Invoices",
        createDestination: true,
      }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ count: 1, destinationMailbox: "Projects/Invoices" });
    expect(createMailboxMock).toHaveBeenCalledWith("Projects/Invoices");
    expect(moveMessageMock).toHaveBeenCalledWith("INBOX", 42, "Projects/Invoices");
  });

  it("deletes an empty mailbox for an account", async () => {
    deleteMailboxMock.mockResolvedValue({ deleted: true, path: "Projects/Invoices" });

    const app = createApp({ accounts, store: store as never });
    const response = await app.fetch(new Request("http://mail.local/api/mailboxes", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: "work", path: "Projects/Invoices" }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ deleted: true, path: "Projects/Invoices" });
    expect(deleteMailboxMock).toHaveBeenCalledWith("Projects/Invoices");
  });

  it("deletes messages through the delete endpoint", async () => {
    deleteMessageMock.mockResolvedValue({ deleted: true, movedToTrash: true, destination: "Trash" });

    const app = createApp({ accounts, store: store as never });
    const response = await app.fetch(new Request("http://mail.local/api/messages/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [{ accountId: "work", mailbox: "INBOX", uid: 99 }],
        permanent: false,
      }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ count: 1, permanent: false });
    expect(deleteMessageMock).toHaveBeenCalledWith("INBOX", 99, false);
  });
});
