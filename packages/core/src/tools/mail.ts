import { childLogger } from "../logger.js";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { callMailService, formatMailServiceError, ok, fail } from "./mail-service-client.js";

const log = childLogger("tool:mail");

function parseStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.map((item) => String(item));
  return [String(value)];
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
    const response = await callMailService<Array<Record<string, unknown>>>("/api/messages/search", {
      method: "POST",
      body: JSON.stringify({
        accountIds: parseStringArray(args["accountIds"]),
        mailboxes: parseStringArray(args["mailboxes"]),
        query: String(args["query"] ?? ""),
        limit: Number(args["limit"] ?? 20),
      }),
    });
    if (response.status >= 400) {
      return fail(formatMailServiceError(response));
    }
    const messages = response.body ?? [];
    const output = messages.length === 0
      ? "No messages matched the query."
      : messages.map((message) => `- [${String(message["accountId"])}] ${String(message["subject"])} from ${String(message["from"])} (${String(message["mailbox"])}#${String(message["uid"])} on ${String(message["date"])})`).join("\n");
    return ok(output, { messages });
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
    const response = await callMailService<Array<Record<string, unknown>>>("/api/messages/search", {
      method: "POST",
      body: JSON.stringify({
        accountIds: parseStringArray(args["accountIds"]),
        query: "is:unread",
        limit: Number(args["limit"] ?? 20),
      }),
    });
    if (response.status >= 400) {
      return fail(formatMailServiceError(response));
    }
    const messages = response.body ?? [];
    const output = messages.length === 0
      ? "No unread messages found."
      : messages.map((message) => `- [${String(message["accountId"])}] ${String(message["subject"])} from ${String(message["from"])} (${String(message["mailbox"])}#${String(message["uid"])} on ${String(message["date"])})`).join("\n");
    return ok(output, { messages });
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
    ].join("\n");
    return ok(output, { message });
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
    const response = await callMailService<Record<string, unknown>>(`/api/drafts/${encodeURIComponent(draftId)}/send`, {
      method: "POST",
    });
    if (response.status >= 400) {
      return fail(formatMailServiceError(response));
    }
    return ok(`Draft ${draftId} sent successfully.`, { draft: response.body });
  },
});