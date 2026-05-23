import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { EmailParser } from "./email-parser.js";
import { MailAccountClient } from "./imap-client.js";
import { log } from "./logger.js";
import { sendDraft } from "./smtp-client.js";
import type { CategoryRecord, DraftRecord, MailAccountConfig, MailSummary } from "./types.js";
import { DraftStore } from "./draft-store.js";
import { calendarRoutes } from "./calendar-routes.js";
import { contactsRoutes } from "./contacts-routes.js";
import { accountAllowsUser, getAccount } from "./account-access.js";

const SearchRequestSchema = z.object({
  accountIds: z.array(z.string()).optional(),
  mailboxes: z.array(z.string()).optional(),
  query: z.string().default(""),
  limit: z.number().int().min(1).max(200).default(50),
});

const ReadRequestSchema = z.object({
  accountId: z.string().min(1),
  mailbox: z.string().min(1),
  uid: z.number().int().positive(),
});

const MailboxCreateSchema = z.object({
  accountId: z.string().min(1),
  path: z.string().min(1),
});

const MailboxDeleteSchema = z.object({
  accountId: z.string().min(1),
  path: z.string().min(1),
});

const MessageActionItemSchema = z.object({
  accountId: z.string().min(1),
  mailbox: z.string().min(1),
  uid: z.number().int().positive(),
});

const MessageMoveSchema = z.object({
  items: z.array(MessageActionItemSchema).min(1),
  destinationMailbox: z.string().min(1),
  createDestination: z.boolean().default(false),
});

const MessageDeleteSchema = z.object({
  items: z.array(MessageActionItemSchema).min(1),
  permanent: z.boolean().default(false),
});

const DraftCreateSchema = z.object({
  accountId: z.string().min(1),
  to: z.array(z.string().email()).min(1),
  cc: z.array(z.string().email()).default([]),
  bcc: z.array(z.string().email()).default([]),
  subject: z.string().min(1),
  textBody: z.string().min(1),
  htmlBody: z.string().optional(),
  replyTo: z.object({
    accountId: z.string().min(1),
    mailbox: z.string().min(1),
    uid: z.number().int().positive(),
  }).optional(),
});

const DraftUpdateSchema = DraftCreateSchema.partial().omit({ accountId: true });

const CategorizeRequestSchema = z.object({
  items: z.array(z.object({
    accountId: z.string().min(1),
    mailbox: z.string().min(1),
    uid: z.number().int().positive(),
    category: z.string().min(1),
    note: z.string().optional(),
  })).min(1),
});

function buildSummary(parsed: Awaited<ReturnType<typeof EmailParser.parse>>, category: CategoryRecord | null): MailSummary {
  return {
    accountId: parsed.accountId,
    mailbox: parsed.mailbox,
    uid: parsed.uid,
    messageId: parsed.messageId,
    from: parsed.from,
    to: parsed.to,
    cc: parsed.cc,
    subject: parsed.subject,
    date: parsed.date,
    attachmentCount: parsed.attachments.length,
    categories: category ? [category.category] : [],
    note: category?.note,
    textPreview: parsed.textBody.slice(0, 240),
  };
}

// Per-user account access (mail/calendar/contacts share accountAllowsUser +
// getAccount from account-access.ts).

/**
 * Build the mail-service Hono app.
 *
 * Mounts every `/api/*` route (accounts, mailboxes, messages, drafts,
 * calendar, contacts) plus `/health`. When `authToken` is provided, every
 * non-health request must carry `Authorization: Bearer <token>`; otherwise
 * the service runs open and should only be reachable on a private network.
 *
 * `store` owns the on-disk draft and category persistence at
 * `MailServiceRuntimeConfig.dataPath`.
 */
export function createApp(opts: { accounts: MailAccountConfig[]; store: DraftStore; authToken?: string }) {
  const app = new Hono();

  app.use("*", async (c, next) => {
    if (!opts.authToken) {
      await next();
      return;
    }
    const auth = c.req.header("authorization") ?? "";
    if (auth !== `Bearer ${opts.authToken}`) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });

  app.get("/health", (c) => c.json({ ok: true, accounts: opts.accounts.length }));

  app.get("/api/accounts", (c) => {
    const user = c.req.header("x-sai-user");
    return c.json(opts.accounts.filter((a) => accountAllowsUser(a, user)).map((account) => ({
      id: account.id,
      address: account.address,
      displayName: account.displayName,
      allowedUsers: account.allowedUsers ?? [],
    })));
  });

  app.get("/api/accounts/:accountId/mailboxes", async (c) => {
    const account = getAccount(opts.accounts, c.req.param("accountId"), c.req.header("x-sai-user"));
    const client = new MailAccountClient(account);
    return c.json(await client.listMailboxes());
  });

  app.post("/api/mailboxes", async (c) => {
    const body = MailboxCreateSchema.parse(await c.req.json());
    const account = getAccount(opts.accounts, body.accountId, c.req.header("x-sai-user"));
    const client = new MailAccountClient(account);
    const mailbox = await client.createMailbox(body.path);
    return c.json(mailbox, 201);
  });

  app.delete("/api/mailboxes", async (c) => {
    const body = MailboxDeleteSchema.parse(await c.req.json());
    const account = getAccount(opts.accounts, body.accountId, c.req.header("x-sai-user"));
    const client = new MailAccountClient(account);
    const deleted = await client.deleteMailbox(body.path);
    return c.json(deleted);
  });

  app.post("/api/messages/search", async (c) => {
    const body = SearchRequestSchema.parse(await c.req.json());
    const user = c.req.header("x-sai-user");
    const targetAccounts = (body.accountIds?.length
      ? opts.accounts.filter((account) => body.accountIds?.includes(account.id))
      : opts.accounts).filter((account) => accountAllowsUser(account, user));

    const summaries: MailSummary[] = [];
    for (const account of targetAccounts) {
      const client = new MailAccountClient(account);
      const messages = await client.search(body.query, body.mailboxes ?? ["INBOX"], body.limit);
      for (const message of messages) {
        const parsed = await EmailParser.parse(message);
        const category = await opts.store.getCategory({ accountId: parsed.accountId, mailbox: parsed.mailbox, uid: parsed.uid });
        summaries.push(buildSummary(parsed, category));
      }
    }

    summaries.sort((left, right) => new Date(right.date).getTime() - new Date(left.date).getTime());
    return c.json(summaries.slice(0, body.limit));
  });

  app.post("/api/messages/read", async (c) => {
    const body = ReadRequestSchema.parse(await c.req.json());
    const account = getAccount(opts.accounts, body.accountId, c.req.header("x-sai-user"));
    const client = new MailAccountClient(account);
    const message = await client.readMessage(body.mailbox, body.uid);
    if (!message) {
      return c.json({ error: "Message not found" }, 404);
    }
    const parsed = await EmailParser.parse(message);
    const category = await opts.store.getCategory({ accountId: parsed.accountId, mailbox: parsed.mailbox, uid: parsed.uid });
    return c.json({
      ...parsed,
      categories: category ? [category.category] : [],
      note: category?.note,
    });
  });

  app.post("/api/messages/move", async (c) => {
    const body = MessageMoveSchema.parse(await c.req.json());
    const grouped = new Map<string, typeof body.items>();
    for (const item of body.items) {
      const items = grouped.get(item.accountId) ?? [];
      items.push(item);
      grouped.set(item.accountId, items);
    }

    const results: Array<Record<string, unknown>> = [];
    for (const [accountId, items] of grouped.entries()) {
      const account = getAccount(opts.accounts, accountId, c.req.header("x-sai-user"));
      const client = new MailAccountClient(account);
      if (body.createDestination) {
        await client.createMailbox(body.destinationMailbox);
      }
      for (const item of items) {
        const moved = await client.moveMessage(item.mailbox, item.uid, body.destinationMailbox);
        results.push({ ...item, destinationMailbox: moved.destination });
      }
    }

    return c.json({ ok: true, count: results.length, destinationMailbox: body.destinationMailbox, results });
  });

  app.post("/api/messages/delete", async (c) => {
    const body = MessageDeleteSchema.parse(await c.req.json());
    const grouped = new Map<string, typeof body.items>();
    for (const item of body.items) {
      const items = grouped.get(item.accountId) ?? [];
      items.push(item);
      grouped.set(item.accountId, items);
    }

    const results: Array<Record<string, unknown>> = [];
    for (const [accountId, items] of grouped.entries()) {
      const account = getAccount(opts.accounts, accountId, c.req.header("x-sai-user"));
      const client = new MailAccountClient(account);
      for (const item of items) {
        const deleted = await client.deleteMessage(item.mailbox, item.uid, body.permanent);
        results.push({
          ...item,
          movedToTrash: deleted.movedToTrash,
          destinationMailbox: deleted.destination ?? null,
        });
      }
    }

    return c.json({ ok: true, count: results.length, permanent: body.permanent, results });
  });

  app.post("/api/messages/categorize", async (c) => {
    const body = CategorizeRequestSchema.parse(await c.req.json());
    const now = new Date().toISOString();
    await opts.store.categorize(body.items.map((item) => ({ ...item, updatedAt: now })));
    return c.json({ ok: true, count: body.items.length });
  });

  app.post("/api/drafts", async (c) => {
    const body = DraftCreateSchema.parse(await c.req.json());
    getAccount(opts.accounts, body.accountId);
    const draft = await opts.store.createDraft(body);
    return c.json(draft, 201);
  });

  app.get("/api/drafts/:draftId", async (c) => {
    const draft = await opts.store.getDraft(c.req.param("draftId"));
    if (!draft) return c.json({ error: "Draft not found" }, 404);
    getAccount(opts.accounts, draft.accountId, c.req.header("x-sai-user")); // 403 if not owned
    return c.json(draft);
  });

  app.patch("/api/drafts/:draftId", async (c) => {
    const existing = await opts.store.getDraft(c.req.param("draftId"));
    if (!existing) return c.json({ error: "Draft not found" }, 404);
    getAccount(opts.accounts, existing.accountId, c.req.header("x-sai-user")); // 403 if not owned
    const patch = DraftUpdateSchema.parse(await c.req.json());
    const draft = await opts.store.updateDraft(c.req.param("draftId"), patch);
    if (!draft) return c.json({ error: "Draft not found" }, 404);
    return c.json(draft);
  });

  app.post("/api/drafts/:draftId/send", async (c) => {
    const draft = await opts.store.getDraft(c.req.param("draftId"));
    if (!draft) return c.json({ error: "Draft not found" }, 404);
    if (draft.status === "sent") return c.json({ error: "Draft already sent" }, 409);
    const account = getAccount(opts.accounts, draft.accountId, c.req.header("x-sai-user"));
    await sendDraft(account, draft);
    const updated = await opts.store.markDraftSent(draft.id);
    return c.json(updated);
  });

  app.route("", calendarRoutes(opts.accounts));
  app.route("", contactsRoutes(opts.accounts));

  app.onError((err, c) => {
    log.error({ err }, "mail service request failed");
    if (err instanceof HTTPException) {
      return err.getResponse();
    }
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  });

  return app;
}