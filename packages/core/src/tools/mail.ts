import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";
import { scanBytes } from "../storage/scanner.js";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { callMailService, formatMailServiceError, ok, fail, type MailServiceResponse } from "./mail-service-client.js";
import { resolveWorkspaceWritePath } from "./workspace-path.js";
import { currentRequestContext } from "../runtime/request-context.js";
import { rootSessionOf } from "../agent/session-ids.js";

const log = childLogger("tool:mail");

function parseStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.map((item) => String(item));
  return [String(value)];
}

type MessageSummary = Record<string, unknown>;

interface MailboxCount {
  accountId: string;
  mailbox: string;
  matched: number;
  exists: number | null;
}

/** The listing and, from a mail service that sends them, how many each mailbox matched and holds. */
function searchResult(response: MailServiceResponse<unknown>): { messages: MessageSummary[]; counts: MailboxCount[] } {
  const body = response.body;
  if (Array.isArray(body)) return { messages: body as MessageSummary[], counts: [] };
  const record = (body ?? {}) as { messages?: unknown; counts?: unknown };
  return {
    messages: Array.isArray(record.messages) ? record.messages as MessageSummary[] : [],
    counts: Array.isArray(record.counts) ? record.counts as MailboxCount[] : [],
  };
}

function messageLine(message: MessageSummary): string {
  const attachments = Number(message["attachmentCount"] ?? 0);
  const attachmentNote = attachments > 0 ? ` — ${attachments} attachment${attachments === 1 ? "" : "s"}` : "";
  return `- [${String(message["accountId"])}] ${String(message["subject"])} from ${String(message["from"])} (${String(message["mailbox"])}#${String(message["uid"])} on ${String(message["date"])})${attachmentNote}`;
}

/**
 * One line per mailbox searched: what matched, what is listed, what the mailbox holds. A listing
 * stops at `limit`; read without these, 50 listed messages were reported as "the mailbox holds 48".
 */
function coverageLines(messages: MessageSummary[], counts: MailboxCount[]): string[] {
  return counts.map((count) => {
    const listed = messages.filter((message) => message["accountId"] === count.accountId && message["mailbox"] === count.mailbox).length;
    const listing = count.matched === 0 ? "" : listed < count.matched ? `, the newest ${listed} listed` : ", all listed";
    const holds = count.exists === null ? "" : `; the mailbox holds ${count.exists}`;
    return `${count.accountId}/${count.mailbox}: ${count.matched} matched${listing}${holds}.`;
  });
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The attachments section of a read message. "none" is said outright: with no section at all, an
 * agent asked for "the document in that mail" reported a 400 KB PDF as missing.
 */
function attachmentLines(attachments: unknown): string[] {
  if (!Array.isArray(attachments)) return [];
  if (attachments.length === 0) return ["", "Attachments: none."];
  return [
    "",
    `Attachments (${attachments.length}) — mail_save_attachment saves one into the workspace by its number; extract_file_content then reads it:`,
    ...attachments.map((entry: Record<string, unknown>, position: number) => {
      const index = typeof entry["index"] === "number" ? entry["index"] : position + 1;
      const embedded = entry["embedded"] === true ? " — shown inside the message body (a logo or inline picture)" : "";
      return `${index}. ${String(entry["filename"] ?? "")} (${String(entry["contentType"] ?? "")}, ${formatBytes(Number(entry["size"] ?? 0))})${embedded}`;
    }),
  ];
}

/** A path segment from an account id or mailbox name: no separators, nothing to climb with. */
function pathSegment(value: string): string {
  return value.replace(/[^\w.@-]+/g, "_").replace(/^\.+/, "").slice(0, 80) || "_";
}

/** The attachment's own name, kept recognisable: its last segment, no leading dots, no separators. */
function attachmentFileName(filename: string, index: number): string {
  return basename(filename.replace(/\\/g, "/")).replace(/[^\p{L}\p{N}_.-]+/gu, "_").replace(/^\.+/, "").slice(-180) || `attachment-${index}`;
}

registerTool({
  name: "mail_list_accounts",
  description: "List configured mail accounts from the headless mail service.",
  embeddingDescription: "List, show, enumerate available mail accounts or mailboxes configured. Verfügbare Mail-Konten auflisten, E-Mail-Konten anzeigen, konfigurierte Postfächer. Account discovery.",
  parameters: { type: "object", properties: {} },
  async execute(): Promise<ToolResult> {
    const response = await callMailService<Array<{ id: string; address: string; displayName?: string }>>("/api/accounts");
    if (response.status >= 400) {
      return fail(formatMailServiceError(response));
    }
    const accounts = response.body ?? [];
    const output = accounts.length === 0
      ? "No mail accounts are configured."
      : accounts.map((account) => `- ${account.id}: ${account.displayName ?? account.address} <${account.address}>`).join("\n");
    return ok(output, { accounts });
  },
});

registerTool({
  name: "mail_list_mailboxes",
  description: "List mailboxes for a configured mail account.",
  parameters: {
    type: "object",
    properties: {
      accountId: { type: "string", description: "Configured mail account ID." },
    },
    required: ["accountId"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const accountId = String(args["accountId"] ?? "").trim();
    if (!accountId) return fail("accountId is required");
    const response = await callMailService<Array<{ path: string; name: string; specialUse?: string | null }>>(`/api/accounts/${encodeURIComponent(accountId)}/mailboxes`);
    if (response.status >= 400) {
      return fail(formatMailServiceError(response));
    }
    const mailboxes = response.body ?? [];
    return ok(mailboxes.map((mailbox) => `- ${mailbox.path}${mailbox.specialUse ? ` (${mailbox.specialUse})` : ""}`).join("\n") || "No mailboxes found.", { accountId, mailboxes });
  },
});

registerTool({
  name: "mail_create_mailbox",
  description: "Create a mailbox or folder for a configured mail account.",
  parameters: {
    type: "object",
    properties: {
      accountId: { type: "string", description: "Configured mail account ID." },
      path: { type: "string", description: "Mailbox path to create, for example 'Projects/Invoices'." },
    },
    required: ["accountId", "path"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const accountId = String(args["accountId"] ?? "").trim();
    const path = String(args["path"] ?? "").trim();
    if (!accountId || !path) return fail("accountId and path are required");
    const response = await callMailService<Record<string, unknown>>("/api/mailboxes", {
      method: "POST",
      body: JSON.stringify({ accountId, path }),
    });
    if (response.status >= 400) {
      return fail(formatMailServiceError(response));
    }
    return ok(`Mailbox '${String(response.body["path"] ?? path)}' is available for account ${accountId}.`, { mailbox: response.body });
  },
});

registerTool({
  name: "mail_delete_mailbox",
  description: "Delete an empty mailbox or folder for a configured mail account.",
  parameters: {
    type: "object",
    properties: {
      accountId: { type: "string", description: "Configured mail account ID." },
      path: { type: "string", description: "Mailbox path to delete." },
    },
    required: ["accountId", "path"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const accountId = String(args["accountId"] ?? "").trim();
    const path = String(args["path"] ?? "").trim();
    if (!accountId || !path) return fail("accountId and path are required");
    const response = await callMailService<Record<string, unknown>>("/api/mailboxes", {
      method: "DELETE",
      body: JSON.stringify({ accountId, path }),
    });
    if (response.status >= 400) {
      return fail(formatMailServiceError(response));
    }
    return ok(`Mailbox '${String(response.body["path"] ?? path)}' deleted for account ${accountId}.`, { mailbox: response.body });
  },
});

registerTool({
  name: "mail_search",
  description: "Search messages across one or more configured mail accounts.",
  embeddingDescription: "Search, find, look up, query emails or mail messages. E-Mails durchsuchen, Nachrichten finden, Postfach durchsuchen. Find mail by sender, subject, content, date.",
  parameters: {
    type: "object",
    properties: {
      accountIds: {
        oneOf: [
          { type: "array", items: { type: "string" } },
          { type: "string" },
        ],
        description: "One account ID or an array of account IDs. Omit to search all accounts.",
      },
      mailboxes: {
        oneOf: [
          { type: "array", items: { type: "string" } },
          { type: "string" },
        ],
        description: "One mailbox or an array of mailboxes. Defaults to INBOX.",
      },
      query: { type: "string", description: "Gmail-style search query." },
      limit: { type: "number", description: "Maximum number of messages to return.", default: 20 },
    },
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const response = await callMailService<unknown>("/api/messages/search", {
      method: "POST",
      body: JSON.stringify({
        accountIds: parseStringArray(args["accountIds"]),
        mailboxes: parseStringArray(args["mailboxes"]),
        query: String(args["query"] ?? ""),
        limit: Number(args["limit"] ?? 20),
        withCounts: true,
      }),
    });
    if (response.status >= 400) {
      return fail(formatMailServiceError(response));
    }
    const { messages, counts } = searchResult(response);
    const output = [
      ...coverageLines(messages, counts),
      ...(messages.length === 0 ? ["No messages matched the query."] : messages.map(messageLine)),
    ].join("\n");
    return ok(output, { messages, counts });
  },
});

registerTool({
  name: "mail_list_unread",
  description: "List unread messages across one or more configured mail accounts.",
  embeddingDescription: "List, show, check unread emails or new messages in inbox. Ungelesene E-Mails anzeigen, neue Nachrichten prüfen, Posteingang checken. Unread inbox overview.",
  parameters: {
    type: "object",
    properties: {
      accountIds: {
        oneOf: [
          { type: "array", items: { type: "string" } },
          { type: "string" },
        ],
        description: "One account ID or an array of account IDs. Omit to search all accounts.",
      },
      limit: { type: "number", description: "Maximum unread messages to return.", default: 20 },
    },
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const response = await callMailService<unknown>("/api/messages/search", {
      method: "POST",
      body: JSON.stringify({
        accountIds: parseStringArray(args["accountIds"]),
        query: "is:unread",
        limit: Number(args["limit"] ?? 20),
        withCounts: true,
      }),
    });
    if (response.status >= 400) {
      return fail(formatMailServiceError(response));
    }
    const { messages, counts } = searchResult(response);
    const output = [
      ...coverageLines(messages, counts),
      ...(messages.length === 0 ? ["No unread messages found."] : messages.map(messageLine)),
    ].join("\n");
    return ok(output, { messages, counts });
  },
});

registerTool({
  name: "mail_read",
  description: "Read a specific mail message by account, mailbox, and UID.",
  embeddingDescription: "Read, open, view, display the full content of an email message. E-Mail öffnen, Nachricht lesen, Mailinhalt anzeigen. Get full message body and headers.",
  parameters: {
    type: "object",
    properties: {
      accountId: { type: "string" },
      mailbox: { type: "string" },
      uid: { type: "number" },
    },
    required: ["accountId", "mailbox", "uid"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const accountId = String(args["accountId"] ?? "").trim();
    const mailbox = String(args["mailbox"] ?? "").trim();
    const uid = Number(args["uid"] ?? 0);
    if (!accountId || !mailbox || !Number.isInteger(uid) || uid <= 0) {
      return fail("accountId, mailbox, and positive integer uid are required");
    }
    const response = await callMailService<Record<string, unknown>>("/api/messages/read", {
      method: "POST",
      body: JSON.stringify({ accountId, mailbox, uid }),
    });
    if (response.status >= 400) {
      return fail(formatMailServiceError(response));
    }
    const message = response.body;
    const output = [
      `Subject: ${String(message["subject"] ?? "")}`,
      `From: ${String(message["from"] ?? "")}`,
      `To: ${String(message["to"] ?? "")}`,
      `Date: ${String(message["date"] ?? "")}`,
      "",
      String(message["textBody"] ?? ""),
      ...attachmentLines(message["attachments"]),
    ].join("\n");
    return ok(output, { message });
  },
});

registerTool({
  name: "mail_save_attachment",
  description: "Save one attachment of a mail message into the workspace, virus-scanned, so extract_file_content can read it. index is the attachment number mail_read lists.",
  embeddingDescription: "Save, download, open an email attachment: a PDF, form, or document attached to a mail. E-Mail-Anhang speichern, Anhang herunterladen, angehängtes Dokument oder Formular öffnen. Attachment to workspace file.",
  parameters: {
    type: "object",
    properties: {
      accountId: { type: "string" },
      mailbox: { type: "string" },
      uid: { type: "number" },
      index: { type: "number", description: "Attachment number as mail_read lists it (1 = first).", default: 1 },
    },
    required: ["accountId", "mailbox", "uid"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const accountId = String(args["accountId"] ?? "").trim();
    const mailbox = String(args["mailbox"] ?? "").trim();
    const uid = Number(args["uid"] ?? 0);
    const index = Number(args["index"] ?? 1);
    if (!accountId || !mailbox || !Number.isInteger(uid) || uid <= 0 || !Number.isInteger(index) || index <= 0) {
      return fail("accountId, mailbox, a positive integer uid and a positive integer index are required");
    }
    const response = await callMailService<Record<string, unknown>>("/api/messages/attachment", {
      method: "POST",
      body: JSON.stringify({ accountId, mailbox, uid, index }),
    });
    if (response.status >= 400) {
      return fail(formatMailServiceError(response));
    }
    const filename = String(response.body["filename"] ?? `attachment-${index}`);
    const contentType = String(response.body["contentType"] ?? "application/octet-stream");
    const bytes = Buffer.from(String(response.body["contentBase64"] ?? ""), "base64");

    const owner = String(response.body["accountId"] ?? accountId);
    const relativeTarget = `mail-attachments/${pathSegment(owner)}/${pathSegment(mailbox)}-${uid}/${attachmentFileName(filename, index)}`;
    // Mail is the commonest way malware arrives. The same fail-closed scan every upload passes
    // runs before the file lands where agents read and the workspace serves it.
    try {
      const verdict = await scanBytes(bytes);
      if (verdict.oversize) {
        logAudit("upload_oversize_rejected", { key: relativeTarget, size: bytes.length, route: "mail_save_attachment" }, { sessionId: ctx.sessionId, severity: "warn" });
        return fail("The attachment was not saved: it is too large to virus-scan.");
      }
      if (!verdict.clean) {
        logAudit("upload_infected", { key: relativeTarget, signature: verdict.signature ?? "unknown", route: "mail_save_attachment" }, { sessionId: ctx.sessionId, severity: "warn" });
        return fail(`The attachment was not saved: the virus scan found ${verdict.signature ?? "malware"}.`);
      }
    } catch (err) {
      logAudit("upload_scan_failed", { key: relativeTarget, error: err instanceof Error ? err.message : String(err), route: "mail_save_attachment" }, { sessionId: ctx.sessionId, severity: "error" });
      return fail("The attachment was not saved: virus scanning is unavailable right now.");
    }

    let target: { resolved: string; relativePath: string };
    try {
      target = resolveWorkspaceWritePath(relativeTarget, ctx.workspacePath);
    } catch {
      return fail("The attachment's file name does not resolve inside the workspace.");
    }
    try {
      await mkdir(dirname(target.resolved), { recursive: true });
      await writeFile(target.resolved, bytes);
    } catch (err) {
      return fail(`The attachment could not be written: ${err instanceof Error ? err.message : String(err)}`);
    }
    log.info({ path: target.relativePath, bytes: bytes.length }, "mail_save_attachment wrote the attachment");
    return ok(
      `Saved attachment ${index} of message ${uid}, ${filename} (${contentType}, ${formatBytes(bytes.length)}), to ${target.relativePath}. Read it with extract_file_content and that path.`,
      { path: target.relativePath, filename, contentType, size: bytes.length },
    );
  },
});

registerTool({
  name: "mail_prepare_draft",
  description: "Create a draft email for a specific configured mail account.",
  embeddingDescription: "Compose, write, draft, create a new email or reply. E-Mail verfassen, Entwurf erstellen, Antwort schreiben. Draft outbound mail with subject and body.",
  parameters: {
    type: "object",
    properties: {
      accountId: { type: "string" },
      to: { type: "array", items: { type: "string" } },
      cc: { type: "array", items: { type: "string" } },
      bcc: { type: "array", items: { type: "string" } },
      subject: { type: "string" },
      textBody: { type: "string" },
      htmlBody: { type: "string" },
    },
    required: ["accountId", "to", "subject", "textBody"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const payload = {
      accountId: String(args["accountId"] ?? "").trim(),
      to: parseStringArray(args["to"]) ?? [],
      cc: parseStringArray(args["cc"]) ?? [],
      bcc: parseStringArray(args["bcc"]) ?? [],
      subject: String(args["subject"] ?? "").trim(),
      textBody: String(args["textBody"] ?? ""),
      htmlBody: args["htmlBody"] ? String(args["htmlBody"]) : undefined,
    };
    if (!payload.accountId || payload.to.length === 0 || !payload.subject || !payload.textBody) {
      return fail("accountId, to, subject, and textBody are required");
    }
    log.info({ sessionId: ctx.sessionId, accountId: payload.accountId, to: payload.to }, "mail_prepare_draft executing");
    const response = await callMailService<Record<string, unknown>>("/api/drafts", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (response.status >= 400) {
      return fail(formatMailServiceError(response));
    }
    const draft = response.body;
    return ok(`Draft ${String(draft["id"])} prepared for ${payload.to.join(", ")} with subject "${payload.subject}"`, { draft });
  },
});

registerTool({
  name: "mail_update_draft",
  description: "Update an existing mail draft.",
  parameters: {
    type: "object",
    properties: {
      draftId: { type: "string" },
      to: { type: "array", items: { type: "string" } },
      cc: { type: "array", items: { type: "string" } },
      bcc: { type: "array", items: { type: "string" } },
      subject: { type: "string" },
      textBody: { type: "string" },
      htmlBody: { type: "string" },
    },
    required: ["draftId"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const draftId = String(args["draftId"] ?? "").trim();
    if (!draftId) return fail("draftId is required");
    const response = await callMailService<Record<string, unknown>>(`/api/drafts/${encodeURIComponent(draftId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        ...(args["to"] !== undefined ? { to: parseStringArray(args["to"]) ?? [] } : {}),
        ...(args["cc"] !== undefined ? { cc: parseStringArray(args["cc"]) ?? [] } : {}),
        ...(args["bcc"] !== undefined ? { bcc: parseStringArray(args["bcc"]) ?? [] } : {}),
        ...(args["subject"] !== undefined ? { subject: String(args["subject"]) } : {}),
        ...(args["textBody"] !== undefined ? { textBody: String(args["textBody"]) } : {}),
        ...(args["htmlBody"] !== undefined ? { htmlBody: String(args["htmlBody"]) } : {}),
      }),
    });
    if (response.status >= 400) {
      return fail(formatMailServiceError(response));
    }
    return ok(`Draft ${draftId} updated.`, { draft: response.body });
  },
});

registerTool({
  name: "mail_get_draft",
  description: "Read a prepared mail draft from the headless mail service.",
  parameters: {
    type: "object",
    properties: {
      draftId: { type: "string" },
    },
    required: ["draftId"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const draftId = String(args["draftId"] ?? "").trim();
    if (!draftId) return fail("draftId is required");
    const response = await callMailService<Record<string, unknown>>(`/api/drafts/${encodeURIComponent(draftId)}`);
    if (response.status >= 400) {
      return fail(formatMailServiceError(response));
    }
    const draft = response.body;
    return ok([
      `Draft ID: ${String(draft["id"] ?? draftId)}`,
      `Account: ${String(draft["accountId"] ?? "")}`,
      `To: ${Array.isArray(draft["to"]) ? (draft["to"] as string[]).join(", ") : ""}`,
      `Subject: ${String(draft["subject"] ?? "")}`,
      "",
      String(draft["textBody"] ?? ""),
    ].join("\n"), { draft });
  },
});

registerTool({
  name: "mail_categorize",
  description: "Persist local categories and notes for specific mail messages.",
  parameters: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            accountId: { type: "string" },
            mailbox: { type: "string" },
            uid: { type: "number" },
            category: { type: "string" },
            note: { type: "string" },
          },
          required: ["accountId", "mailbox", "uid", "category"],
        },
      },
    },
    required: ["items"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const items = Array.isArray(args["items"]) ? args["items"] : [];
    if (items.length === 0) return fail("items must be a non-empty array");
    const response = await callMailService<Record<string, unknown>>("/api/messages/categorize", {
      method: "POST",
      body: JSON.stringify({ items }),
    });
    if (response.status >= 400) {
      return fail(formatMailServiceError(response));
    }
    return ok(`Categorized ${String(response.body["count"] ?? items.length)} message(s).`, { result: response.body });
  },
});

registerTool({
  name: "mail_move",
  description: "Move one or more mail messages into another mailbox or folder.",
  parameters: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            accountId: { type: "string" },
            mailbox: { type: "string" },
            uid: { type: "number" },
          },
          required: ["accountId", "mailbox", "uid"],
        },
      },
      destinationMailbox: { type: "string", description: "Mailbox or folder path to move the messages into." },
      createDestination: { type: "boolean", description: "Create the destination mailbox first if it does not exist.", default: false },
    },
    required: ["items", "destinationMailbox"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const items = Array.isArray(args["items"]) ? args["items"] : [];
    const destinationMailbox = String(args["destinationMailbox"] ?? "").trim();
    if (items.length === 0 || !destinationMailbox) return fail("items and destinationMailbox are required");
    const response = await callMailService<Record<string, unknown>>("/api/messages/move", {
      method: "POST",
      body: JSON.stringify({
        items,
        destinationMailbox,
        createDestination: Boolean(args["createDestination"] ?? false),
      }),
    });
    if (response.status >= 400) {
      return fail(formatMailServiceError(response));
    }
    return ok(`Moved ${String(response.body["count"] ?? items.length)} message(s) to ${destinationMailbox}.`, { result: response.body });
  },
});

registerTool({
  name: "mail_delete",
  description: "Delete one or more mail messages. By default this moves them to Trash when the account supports it.",
  parameters: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            accountId: { type: "string" },
            mailbox: { type: "string" },
            uid: { type: "number" },
          },
          required: ["accountId", "mailbox", "uid"],
        },
      },
      permanent: { type: "boolean", description: "If true, permanently delete instead of moving to Trash when possible.", default: false },
    },
    required: ["items"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const items = Array.isArray(args["items"]) ? args["items"] : [];
    if (items.length === 0) return fail("items must be a non-empty array");
    const response = await callMailService<Record<string, unknown>>("/api/messages/delete", {
      method: "POST",
      body: JSON.stringify({
        items,
        permanent: Boolean(args["permanent"] ?? false),
      }),
    });
    if (response.status >= 400) {
      return fail(formatMailServiceError(response));
    }
    const permanent = Boolean(response.body["permanent"] ?? false);
    return ok(`${permanent ? "Deleted" : "Moved to Trash"} ${String(response.body["count"] ?? items.length)} message(s).`, { result: response.body });
  },
});

/**
 * The messages each turn has sent, by recipients and subject.
 *
 * The mail service sends a draft once; a second draft of the same reply is another draft. In the E2E
 * run of 2026-10-23 a plan gave mail_agent one step to read the customer's mail and the next to answer
 * it. The first run answered it as well, and the second wrote the answer again and sent it: the
 * customer got it twice. So a turn sends one message to the same recipients under the same subject,
 * whichever run of it sends: the turn is the request context's turn id, which every run a turn starts
 * inherits.
 */
const sentByTurn = new Map<string, Array<{ recipients: string; subject: string; draftId: string; at: string }>>();
const SENT_TURNS_KEPT = 256;

function sendTurnKey(ctx: ToolContext): string {
  return currentRequestContext()?.turnId ?? `${rootSessionOf(ctx.sessionId)}@${ctx.turnStartedAt ?? ""}`;
}

function recipientsKey(draft: Record<string, unknown>): string {
  const list = (value: unknown) => Array.isArray(value) ? value.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean) : [];
  return [...new Set([...list(draft["to"]), ...list(draft["cc"]), ...list(draft["bcc"])])].sort().join(",");
}

function subjectKey(subject: unknown): string {
  return String(subject ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

registerTool({
  name: "mail_send_draft",
  description: "Send a prepared mail draft through the configured mail account. This tool always requires user approval.",
  embeddingDescription: "Send, dispatch, deliver, transmit an email or message. E-Mail senden, verschicken, abschicken, verschicken. Requires approval. Final step after drafting.",
  parameters: {
    type: "object",
    properties: {
      draftId: { type: "string" },
    },
    required: ["draftId"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const draftId = String(args["draftId"] ?? "").trim();
    if (!draftId) return fail("draftId is required");
    log.info({ sessionId: ctx.sessionId, draftId }, "mail_send_draft executing");
    const turn = sendTurnKey(ctx);
    // Unread, the draft is sent as before: the service answers the send itself.
    const pending = await callMailService<Record<string, unknown>>(`/api/drafts/${encodeURIComponent(draftId)}`, { method: "GET" })
      .catch(() => ({ status: 599, body: {} as Record<string, unknown> }));
    const recipients = pending.status < 400 ? recipientsKey(pending.body) : "";
    const subject = pending.status < 400 ? subjectKey(pending.body["subject"]) : "";
    const earlier = recipients ? sentByTurn.get(turn)?.find((sent) => sent.recipients === recipients && sent.subject === subject) : undefined;
    if (earlier) {
      logAudit("guardrail_flagged", { type: "mail_send_repeat_refused", draftId, earlierDraftId: earlier.draftId }, { sessionId: ctx.sessionId, severity: "warn" });
      return fail(`Not sent: this turn already sent draft ${earlier.draftId} to ${recipients} with the subject "${String(pending.body["subject"] ?? "")}" (${earlier.at}). Report that message as the one sent; do not send it again.`);
    }
    const response = await callMailService<Record<string, unknown>>(`/api/drafts/${encodeURIComponent(draftId)}/send`, {
      method: "POST",
    });
    if (response.status >= 400) {
      return fail(formatMailServiceError(response));
    }
    if (recipients) {
      if (!sentByTurn.has(turn) && sentByTurn.size >= SENT_TURNS_KEPT) sentByTurn.delete(sentByTurn.keys().next().value!);
      sentByTurn.set(turn, [...(sentByTurn.get(turn) ?? []), { recipients, subject, draftId, at: new Date().toISOString() }]);
    }
    return ok(`Draft ${draftId} sent successfully.`, { draft: response.body });
  },
});