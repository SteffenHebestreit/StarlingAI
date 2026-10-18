import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const scan = vi.hoisted(() => ({ verdict: { clean: true } as { clean: boolean; signature?: string; oversize?: boolean } | Error }));

vi.mock("../storage/scanner.js", () => ({
  scanBytes: vi.fn(async () => {
    if (scan.verdict instanceof Error) throw scan.verdict;
    return scan.verdict;
  }),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function run(toolName: string, args: Record<string, unknown>, workspacePath = "/workspace") {
  const { getTool } = await import("../tools/registry.js");
  return getTool(toolName)!.execute(args, { sessionId: `session-${toolName}`, workspacePath });
}

describe("mail tools", () => {
  beforeAll(async () => {
    await import("../tools/mail.js");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    scan.verdict = { clean: true };
  });

  it("searches across multiple mail accounts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([
      {
        accountId: "work",
        mailbox: "INBOX",
        uid: 42,
        subject: "Invoice",
        from: "billing@example.com",
        date: "2026-04-01T10:00:00.000Z",
      },
    ])));

    const result = await run("mail_search", { accountIds: ["work", "personal"], query: "is:unread", limit: 10 });

    expect(result.success).toBe(true);
    expect(result.output).toContain("[work] Invoice");
  });

  it("says how many messages matched and how many the mailbox holds, not only what it lists", async () => {
    // 50 listed of 570 were reported as "the mailbox holds 48 messages" (session 56d4f3e4).
    const fetchMock = vi.fn(async () => jsonResponse({
      messages: [
        { accountId: "work", mailbox: "INBOX", uid: 1232, subject: "Card moved", from: "board@example.com", date: "2026-10-02T08:32:14.000Z", attachmentCount: 0 },
        { accountId: "work", mailbox: "INBOX", uid: 1231, subject: "Billing", from: "tom@example.com", date: "2026-10-02T05:49:01.000Z", attachmentCount: 1 },
      ],
      counts: [{ accountId: "work", mailbox: "INBOX", matched: 570, exists: 570 }],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await run("mail_search", { accountIds: "work", limit: 2 });

    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toMatchObject({ withCounts: true });
    expect(result.output).toContain("work/INBOX: 570 matched, the newest 2 listed; the mailbox holds 570.");
    expect(result.output).toContain("INBOX#1231 on 2026-10-02T05:49:01.000Z) — 1 attachment");
    expect(result.output).not.toContain("INBOX#1232 on 2026-10-02T08:32:14.000Z) —");
  });

  it("tells an empty search apart from an empty mailbox", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      messages: [],
      counts: [{ accountId: "work", mailbox: "INBOX", matched: 0, exists: 570 }],
    })));

    const result = await run("mail_list_unread", { accountIds: "work" });

    expect(result.output).toContain("work/INBOX: 0 matched; the mailbox holds 570.");
    expect(result.output).toContain("No unread messages found.");
  });

  it("lists a read message's attachments, and says so when there are none", async () => {
    // The agent reported a 400 KB PDF as "no attachment": the read output never mentioned one.
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      subject: "Billing", from: "tom@example.com", to: "me@example.com", date: "2026-10-02T05:49:01.000Z",
      textBody: "Fill it in and send it back.",
      attachments: [
        { index: 1, filename: "billing.pdf", contentType: "application/pdf", size: 412779, embedded: false },
        { index: 2, filename: "logo.png", contentType: "image/png", size: 2048, embedded: true },
      ],
    })));
    const withAttachments = await run("mail_read", { accountId: "work", mailbox: "INBOX", uid: 1231 });
    expect(withAttachments.output).toContain("Attachments (2)");
    expect(withAttachments.output).toContain("1. billing.pdf (application/pdf, 403 KB)");
    expect(withAttachments.output).toContain("2. logo.png (image/png, 2 KB) — shown inside the message body");
    expect(withAttachments.output).toContain("mail_save_attachment");

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ subject: "Hi", textBody: "Hello", attachments: [] })));
    const without = await run("mail_read", { accountId: "work", mailbox: "INBOX", uid: 7 });
    expect(without.output).toContain("Attachments: none.");
  });

  it("passes on why the mail service refused, also when it answers in plain text", async () => {
    // An address passed as accountId came back as a bare "HTTP 404"; the agent then reported the
    // message as missing instead of retrying with the account id.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Unknown account: me@example.com. Account ids: work.", { status: 404 })));

    const result = await run("mail_read", { accountId: "me@example.com", mailbox: "INBOX", uid: 1231 });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Mail service returned HTTP 404: Unknown account: me@example.com. Account ids: work.");
  });

  describe("saving an attachment", () => {
    const pdf = Buffer.from("%PDF-1.7 billing form");
    const attachmentBody = { accountId: "work", index: 1, filename: "Reisekosten/../Hamburg.pdf", contentType: "application/pdf", size: pdf.length, embedded: false, contentBase64: pdf.toString("base64") };
    let workspace = "";

    afterEach(async () => {
      if (workspace) await rm(workspace, { recursive: true, force: true });
      workspace = "";
    });

    it("writes a clean attachment into the workspace and names the path to read it from", async () => {
      workspace = await mkdtemp(join(tmpdir(), "mail-attachment-"));
      const fetchMock = vi.fn(async () => jsonResponse(attachmentBody));
      vi.stubGlobal("fetch", fetchMock);

      const result = await run("mail_save_attachment", { accountId: "me@example.com", mailbox: "INBOX", uid: 1231, index: 1 }, workspace);

      expect(result.success).toBe(true);
      const path = String(result.metadata?.["path"]);
      expect(path).toMatch(/mail-attachments\/work\/INBOX-1231\/Hamburg\.pdf$/);
      expect(result.output).toContain(path);
      expect(result.output).toContain("extract_file_content");
      expect(await readFile(join(workspace, path))).toEqual(pdf);
      expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ accountId: "me@example.com", mailbox: "INBOX", uid: 1231, index: 1 });
    });

    it("keeps a sender-chosen file name to one plain segment", async () => {
      workspace = await mkdtemp(join(tmpdir(), "mail-attachment-"));
      for (const [filename, expected] of [["..", "attachment-2"], ["..\\..\\.env", "env"], ["Rechnung März.pdf", "Rechnung_März.pdf"]] as const) {
        vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ...attachmentBody, filename })));
        const result = await run("mail_save_attachment", { accountId: "work", mailbox: "INBOX", uid: 1231, index: 2 }, workspace);
        expect(String(result.metadata?.["path"])).toMatch(new RegExp(`mail-attachments/work/INBOX-1231/${expected.replace(".", "\\.")}$`));
      }
    });

    it("refuses an infected attachment, and one it could not scan, without writing anything", async () => {
      workspace = await mkdtemp(join(tmpdir(), "mail-attachment-"));
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(attachmentBody)));

      scan.verdict = { clean: false, signature: "Eicar-Signature" };
      const infected = await run("mail_save_attachment", { accountId: "work", mailbox: "INBOX", uid: 1231 }, workspace);
      expect(infected.success).toBe(false);
      expect(infected.error).toContain("Eicar-Signature");

      scan.verdict = new Error("connect ECONNREFUSED");
      const unscanned = await run("mail_save_attachment", { accountId: "work", mailbox: "INBOX", uid: 1231 }, workspace);
      expect(unscanned.success).toBe(false);
      expect(unscanned.error).toContain("virus scanning is unavailable");

      const { readdir } = await import("node:fs/promises");
      expect(await readdir(workspace, { recursive: true })).toEqual([]);
    });
  });

  it("sends drafts through the mail service endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ id: "draft-1", status: "sent" })));

    const result = await run("mail_send_draft", { draftId: "draft-1" });

    expect(result.success).toBe(true);
    expect(result.output).toContain("draft-1");
  });
});
