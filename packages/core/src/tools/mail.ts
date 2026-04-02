import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";

const log = childLogger("tool:mail");

interface MailServiceResult<T = unknown> {
  status: number;
  body: T;
}

function formatMailServiceError<T>(response: MailServiceResult<T>): string {
  const body = response.body as Record<string, unknown> | null | undefined;
  const detail = typeof body?.["error"] === "string"
    ? body.error
    : typeof body?.["message"] === "string"
      ? body.message
      : "";
  return detail
    ? `Mail service returned HTTP ${response.status}: ${detail}`
    : `Mail service returned HTTP ${response.status}`;
}

function resolveMailConfig() {
  const config = getConfig().mail;
  return {
    serviceUrl: process.env["SAI_MAIL_SERVICE_URL"] ?? config.serviceUrl,
    timeoutMs: Number(process.env["SAI_MAIL_SERVICE_TIMEOUT_MS"] ?? config.timeoutMs),
    authToken: process.env["SAI_MAIL_SERVICE_TOKEN"] ?? config.authToken,
  };
}

async function callMailService<T>(
  path: string,
  init?: RequestInit,
): Promise<MailServiceResult<T>> {
  const config = resolveMailConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(`${config.serviceUrl}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(config.authToken ? { Authorization: `Bearer ${config.authToken}` } : {}),
        ...(init?.headers ?? {}),
      },
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({})) as T;
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function ok(output: string, metadata?: Record<string, unknown>): ToolResult {
  return { success: true, output, metadata };
}

function fail(error: string, metadata?: Record<string, unknown>): ToolResult {
  return { success: false, output: "", error, metadata };
}

function parseStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.map((item) => String(item));
  return [String(value)];
}

registerTool({
  name: "mail_list_accounts",
  description: "List configured mail accounts from the headless mail service.",
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
  name: "mail_search",
  description: "Search messages across one or more configured mail accounts.",
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
  name: "mail_send_draft",
  description: "Send a prepared mail draft through the configured mail account. This tool always requires user approval.",
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