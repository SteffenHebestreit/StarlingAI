import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testAccount } from "./support/test-account.js";

/**
 * A channel sender that may not be served under multi-user auth is refused per message.
 *
 * A channel sender is a principal whose storage is keyed by its raw id, and the data an account
 * kept before account ids sits under the segment of its username, the same formula. A Telegram user
 * whose id is an account's username, or a mail From an identity-provider account's address, would
 * read and write that account's data; under an extension auth provider a sender whose id is a
 * provider user's id would be that account outright. Such a message is handled with no session, no
 * turn and no reply, and audited. The mail poll used to open the session outside its per-message
 * `try`: a throw there left the loop, the message stayed unseen, was fetched first on every later
 * poll, and no mail after it was read again.
 */

const bot = vi.hoisted(() => ({ commands: new Map<string, (ctx: unknown) => Promise<void>>(), on: new Map<string, (ctx: unknown) => Promise<void>>() }));
vi.mock("grammy", () => ({
  Bot: class {
    api = { getMe: async () => ({}) };
    command(name: string, handler: (ctx: unknown) => Promise<void>) { bot.commands.set(name, handler); }
    on(event: string, handler: (ctx: unknown) => Promise<void>) { bot.on.set(event, handler); }
    start() { return Promise.resolve(); }
    async stop() {}
  },
}));

interface Mail { uid: number; from: string; text: string }
const imap = vi.hoisted(() => ({ messages: [] as Mail[], seen: [] as number[], polled: null as null | (() => void) }));
vi.mock("imapflow", () => ({
  ImapFlow: class {
    async connect() {}
    async getMailboxLock() { return { release() {} }; }
    async *fetch() {
      for (const mail of imap.messages) {
        yield { uid: mail.uid, flags: [], envelope: { from: [{ address: mail.from }], subject: `about ${mail.uid}` }, source: Buffer.from(`Subject: x\r\n\r\n${mail.text}`) };
      }
    }
    async messageFlagsAdd(range: { uid: number }, flags: string[]) {
      if (flags.includes("\\Seen")) imap.seen.push(range.uid);
    }
    async logout() { imap.polled?.(); }
  },
}));

const mailed = vi.hoisted(() => [] as Array<{ to: string; text: string }>);
vi.mock("nodemailer", () => ({
  createTransport: () => ({ sendMail: async (mail: { to: string; text: string }) => { mailed.push({ to: mail.to, text: mail.text }); } }),
}));

const turns = vi.hoisted(() => [] as Array<{ channel: string; identity: unknown; message: string }>);
vi.mock("../agent/runtime.js", () => ({
  runTurn: async (opts: { session: { channel: string; identity(): unknown }; userMessage: string }) => {
    turns.push({ channel: opts.session.channel, identity: opts.session.identity(), message: opts.userMessage });
    return { response: "the reply", toolCallsExecuted: 0, guardrailEvents: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, blocked: false };
  },
}));

const channelConfig = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("../credentials/channels.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../credentials/channels.js")>();
  return { ...actual, getEffectiveChannelConfig: (_type: string, base: Record<string, unknown>) => ({ ...base, ...channelConfig.value }) };
});

/** Senders whose Redis lookup fails, as a Redis outage does. */
const redisFailsFor = vi.hoisted(() => new Set<string>());
vi.mock("../agent/session-redis.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agent/session-redis.js")>();
  return {
    ...actual,
    getChannelSessionId: async (channel: string, sender: string) => {
      if (redisFailsFor.has(sender)) throw new Error("redis: connection refused");
      return actual.getChannelSessionId(channel, sender);
    },
  };
});

const audits = vi.hoisted(() => [] as Array<{ event: string; data: Record<string, unknown>; opts: Record<string, unknown> }>);
vi.mock("../audit/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../audit/logger.js")>();
  return {
    ...actual,
    logAudit: (event: string, data: Record<string, unknown> = {}, opts: Record<string, unknown> = {}) => {
      audits.push({ event, data, opts });
    },
  };
});

const FILE_DIR = mkdtempSync(join(tmpdir(), "starlingai-channel-refusal-"));
const CONFIG_PATH = join(FILE_DIR, "starlingai.json");

async function loadModules() {
  writeFileSync(CONFIG_PATH, JSON.stringify({ gateway: { jwtSecret: "c".repeat(40) } }), "utf8");
  process.env["SAI_CONFIG_PATH"] = CONFIG_PATH;
  process.env["SAI_MUTABLE_CONFIG_PATH"] = CONFIG_PATH;
  process.env["SAI_SESSION_STORE"] = join(FILE_DIR, "sessions.json");
  const loader = await import("../config/loader.js");
  const registry = await import("../runtime/account-registry.js");
  const extension = await import("../extension/index.js");
  const sessions = await import("../agent/session.js");
  const telegram = await import("../channels/telegram.js");
  const email = await import("../channels/email.js");
  return { loader, registry, extension, sessions, telegram, email };
}

let mods: Awaited<ReturnType<typeof loadModules>>;

beforeAll(async () => {
  mods = await loadModules();
});

afterAll(() => {
  mods.loader.resetConfigForTests();
  for (const key of ["SAI_CONFIG_PATH", "SAI_MUTABLE_CONFIG_PATH", "SAI_SESSION_STORE"]) delete process.env[key];
  rmSync(FILE_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  bot.commands.clear();
  bot.on.clear();
  imap.messages = [];
  imap.seen.length = 0;
  mailed.length = 0;
  turns.length = 0;
  audits.length = 0;
  redisFailsFor.clear();
});

afterEach(() => {
  mods.extension._resetExtensionsForTests();
  mods.sessions.resetSessionsForTests();
});

const NOW = "2026-10-09T00:00:00.000Z";

/** This test's configuration: multi-user auth (or not), the account "12345", and an IdP account
 *  holding a mail address. */
function configure(authEnabled: boolean): void {
  const workspace = mkdtempSync(join(FILE_DIR, "ws-"));
  mkdirSync(join(workspace, ".starlingai"), { recursive: true });
  writeFileSync(join(workspace, ".starlingai", "accounts.json"), JSON.stringify({
    version: 1,
    bootstrapSubs: [],
    accounts: [{ id: `oidc-${"4".repeat(16)}`, issuer: "https://idp", subject: "s-1", username: "alice@example.com", status: "active", firstSeenAt: NOW, lastSeenAt: NOW }],
  }), "utf8");
  writeFileSync(CONFIG_PATH, JSON.stringify({
    gateway: { jwtSecret: "c".repeat(40) },
    workspacePath: workspace,
    auth: { enabled: authEnabled, users: [testAccount("12345").record] },
  }), "utf8");
  mods.loader.resetConfigForTests();
  mods.loader.loadConfig();
  mods.registry.resetAccountRegistryForTests();
}

function telegramMessage(fromId: number, text = "hello") {
  return {
    from: { id: fromId },
    chat: { id: fromId * 10 },
    message: { text },
    reply: vi.fn(async () => undefined),
    replyWithChatAction: vi.fn(async () => undefined),
  };
}

async function startTelegram(): Promise<(ctx: unknown) => Promise<void>> {
  channelConfig.value = { enabled: true, botToken: "123:test", allowedUserIds: [] };
  const stop = await mods.telegram.startTelegramBot();
  expect(stop).not.toBeNull();
  await stop!();
  return bot.on.get("message:text")!;
}

const refusals = () => audits.filter((row) => row.event === "channel_sender_refused");

describe("Telegram", () => {
  it("refuses a sender whose id is an account's username: no session, no turn, no reply", async () => {
    configure(true);
    const onText = await startTelegram();
    const message = telegramMessage(12345);
    await onText(message);
    expect(message.reply).not.toHaveBeenCalled();
    expect(turns).toEqual([]);
    expect(mods.sessions.getAllSessions({ includeArchived: true })).toEqual([]);
    expect(refusals()).toEqual([expect.objectContaining({ data: expect.objectContaining({ channel: "telegram" }), opts: expect.objectContaining({ userId: "12345" }) })]);

    // So are /start and /reset from that sender.
    const start = telegramMessage(12345);
    await bot.commands.get("start")!(start);
    await bot.commands.get("reset")!(telegramMessage(12345));
    expect(start.reply).not.toHaveBeenCalled();
    expect(mods.sessions.getAllSessions({ includeArchived: true })).toEqual([]);
  });

  it("refuses a sender whose id is a user id of an extension auth provider", async () => {
    configure(true);
    mods.extension._recordLoadedExtension(
      { name: "store", version: "1", toolNames: [], auditEvents: [], roles: [], loadedAt: "", source: "test" },
      {
        name: "store",
        version: "1",
        authProvider: {
          verifyCredentials: async () => null,
          getUserById: (id) => (id === "777" ? { id: "777", username: "dora", role: "operator" } : null),
        },
      },
    );
    const onText = await startTelegram();
    const message = telegramMessage(777);
    await onText(message);
    expect(message.reply).not.toHaveBeenCalled();
    expect(turns).toEqual([]);
    expect(refusals()).toHaveLength(1);
  });

  it("serves any other sender as a channel principal", async () => {
    configure(true);
    const onText = await startTelegram();
    const message = telegramMessage(555, "what is new");
    await onText(message);
    expect(turns).toEqual([{ channel: "telegram", identity: { userId: "555", principal: "channel" }, message: "what is new" }]);
    expect(message.reply).toHaveBeenCalledTimes(1);
    expect(refusals()).toEqual([]);
  });

  it("serves every sender with multi-user auth off, as before", async () => {
    configure(false);
    const onText = await startTelegram();
    const message = telegramMessage(12345);
    await onText(message);
    expect(turns).toEqual([{ channel: "telegram", identity: { userId: "12345" }, message: "hello" }]);
    expect(refusals()).toEqual([]);
  });
});

describe("email", () => {
  async function pollOnce(messages: Mail[]): Promise<void> {
    imap.messages = messages;
    channelConfig.value = {
      enabled: true,
      imapHost: "imap.example.test", imapUser: "bot@example.test", imapPassword: "pw",
      smtpHost: "smtp.example.test", smtpUser: "bot@example.test", smtpPassword: "pw",
      pollIntervalMs: 3_600_000,
    };
    const polled = new Promise<void>((resolve) => { imap.polled = resolve; });
    const stop = await mods.email.startEmailChannel();
    expect(stop).not.toBeNull();
    await polled;
    await stop!();
  }

  it("marks a refused sender's message seen, sends nothing back, and reads the next message", async () => {
    configure(true);
    await pollOnce([
      { uid: 1, from: "alice@example.com", text: "send me the files" },
      { uid: 2, from: "bob@example.com", text: "status?" },
    ]);
    expect(imap.seen).toEqual([1, 2]);
    expect(mailed.map((mail) => mail.to)).toEqual(["bob@example.com"]);
    expect(turns).toEqual([{ channel: "email", identity: { userId: "bob@example.com", principal: "channel" }, message: "Subject: about 2\n\nstatus?" }]);
    expect(refusals()).toEqual([expect.objectContaining({ opts: expect.objectContaining({ userId: "alice@example.com" }) })]);
  });

  it("marks a message seen and reads the next one when opening its session fails", async () => {
    configure(true);
    redisFailsFor.add("carol@example.com");
    await pollOnce([
      { uid: 1, from: "carol@example.com", text: "first" },
      { uid: 2, from: "bob@example.com", text: "second" },
    ]);
    expect(imap.seen).toEqual([1, 2]);
    expect(mailed.map((mail) => mail.to)).toEqual(["bob@example.com"]);
    expect(turns.map((turn) => turn.message)).toEqual(["Subject: about 2\n\nsecond"]);
  });
});
