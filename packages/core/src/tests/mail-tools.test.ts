import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

describe("mail tools", () => {
  beforeAll(async () => {
    await import("../tools/mail.js");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("searches across multiple mail accounts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      status: 200,
      json: async () => ([
        {
          accountId: "work",
          mailbox: "INBOX",
          uid: 42,
          subject: "Invoice",
          from: "billing@example.com",
          date: "2026-04-01T10:00:00.000Z",
        },
      ]),
    })));

    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("mail_search");
    const result = await tool!.execute({
      accountIds: ["work", "personal"],
      query: "is:unread",
      limit: 10,
    }, {
      sessionId: "session-mail-search",
      workspacePath: "/workspace",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("[work] Invoice");
  });

  it("sends drafts through the mail service endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      status: 200,
      json: async () => ({ id: "draft-1", status: "sent" }),
    })));

    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("mail_send_draft");
    const result = await tool!.execute({ draftId: "draft-1" }, {
      sessionId: "session-mail-send",
      workspacePath: "/workspace",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("draft-1");
  });
});