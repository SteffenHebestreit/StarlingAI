import { Bot, type Context } from "grammy";
import { createSession, endSession } from "../agent/session.js";
import { runTurn } from "../agent/runtime.js";
import { getConfig } from "../config/loader.js";
import { getEffectiveChannelConfig } from "../credentials/channels.js";
import { channelSenderRefusal, checkChannelIngress, recordChannelSenderRefused, type ChannelBaseConfig } from "./base.js";
import { principalIdentity } from "../runtime/user-scope.js";
import { dispatchChannelTriggeredJob } from "./job-triggers.js";
import { childLogger } from "../logger.js";
import { deliverWithRetry } from "./delivery.js";
import { setChannelHealthCheck } from "./registry.js";
import { PRODUCT } from "../product/index.js";

const log = childLogger("channel:telegram");

// Maps Telegram chat IDs → session IDs
const chatSessions = new Map<number, string>();

/**
 * Whether a Telegram sender may be served (channels/base.ts channelSenderRefusal). A sender that may
 * not is recorded as refused, and the caller handles the update without a reply.
 */
function telegramSenderServed(fromId: number | undefined): boolean {
  if (fromId === undefined) return true;
  const sender = fromId.toString();
  const refusal = channelSenderRefusal(sender);
  if (!refusal) return true;
  recordChannelSenderRefused("telegram", sender, refusal);
  return false;
}

/** A new session for a chat, owned by its sender as a channel principal. */
function newTelegramSession(chatId: number, fromId: number | undefined): string {
  const session = createSession({
    channel: "telegram",
    ...(fromId !== undefined ? principalIdentity(fromId.toString(), "channel") : {}),
  });
  chatSessions.set(chatId, session.id);
  return session.id;
}

// Exported bot API reference for the send_telegram tool
let _botApi: Bot<Context>["api"] | null = null;

/** Send a message to a Telegram chat. Returns true on success. */
export async function sendTelegramMessage(
  chatId: number,
  text: string,
  parseMode: "Markdown" | "HTML" | undefined = "Markdown",
): Promise<{ ok: boolean; error?: string }> {
  if (!_botApi) {
    return { ok: false, error: "Telegram bot is not running" };
  }
  try {
    await _botApi.sendMessage(chatId, text, parseMode ? { parse_mode: parseMode } : {});
    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

export async function startTelegramBot(): Promise<(() => Promise<void>) | null> {
  const config = getConfig();
  const tgConfig = getEffectiveChannelConfig("telegram", config.channels.telegram);

  if (!tgConfig.enabled || !tgConfig.botToken) {
    log.info("Telegram channel disabled (no token configured)");
    return null;
  }

  const allowedUserIds = new Set(tgConfig.allowedUserIds ?? []);
  const bot = new Bot<Context>(tgConfig.botToken);

  bot.command("start", async (ctx) => {
    const userId = ctx.from?.id;
    if (userId !== undefined && allowedUserIds.size > 0 && !allowedUserIds.has(userId)) {
      await ctx.reply("Unauthorized. This bot is private.");
      return;
    }
    if (!telegramSenderServed(userId)) return;
    const sessionId = newTelegramSession(ctx.chat.id, userId);
    await ctx.reply(`${PRODUCT.name} connected. How can I help?`);
    log.info({ chatId: ctx.chat.id, sessionId }, "Telegram session started");
  });

  bot.command("reset", async (ctx) => {
    if (!telegramSenderServed(ctx.from?.id)) return;
    const sid = chatSessions.get(ctx.chat.id);
    if (sid) {
      endSession(sid);
      chatSessions.delete(ctx.chat.id);
    }
    newTelegramSession(ctx.chat.id, ctx.from?.id);
    await ctx.reply("Session reset. Fresh start!");
  });

  bot.on("message:text", async (ctx) => {
    const userId = ctx.from?.id;
    if (allowedUserIds.size > 0 && userId !== undefined && !allowedUserIds.has(userId)) {
      await ctx.reply("Unauthorized.");
      return;
    }
    // Before anything else of this message, the chat's session included: the update is handled
    // and nothing goes back.
    if (!telegramSenderServed(userId)) return;

    const tgBaseConfig: ChannelBaseConfig = {
      enabled: tgConfig.enabled ?? false,
      dmPolicy: "open",
      allowFrom: [],
      historyLimit: 50,
      perSenderRateLimitCount: 12,
      perSenderRateLimitWindowMs: 60_000,
    };
    const ingress = checkChannelIngress("telegram", String(userId ?? ctx.chat.id), tgBaseConfig);
    if (!ingress.allowed) {
      await ctx.reply("Rate limit exceeded. Please wait before sending another message.");
      return;
    }

    let sessionId = chatSessions.get(ctx.chat.id);
    if (!sessionId) sessionId = newTelegramSession(ctx.chat.id, userId);

    const triggeredJob = await dispatchChannelTriggeredJob({
      channel: "telegram",
      senderId: String(userId ?? ctx.chat.id),
      text: ctx.message.text,
    });
    if (triggeredJob.matched) {
      if (triggeredJob.responseText) {
        await deliverWithRetry(
          () => ctx.reply(triggeredJob.responseText!).then(() => undefined),
          triggeredJob.responseText,
          { channel: "telegram" },
        );
      }
      return;
    }

    const { getSession } = await import("../agent/session.js");
    const session = getSession(sessionId);
    if (!session) {
      await ctx.reply("Session error — send /start to reset.");
      return;
    }

    // Show typing indicator
    await ctx.replyWithChatAction("typing");

    const result = await runTurn({
      session,
      userMessage: ctx.message.text,
      userWords: ctx.message.text,
    });

    await deliverWithRetry(
      () => ctx.reply(result.response, { parse_mode: "Markdown" }).then(() => undefined),
      result.response,
      { channel: "telegram" }
    );
  });

  await bot.api.getMe();
  _botApi = bot.api;
  bot.start().catch(err => log.error({ err }, "Telegram bot error"));
  log.info("Telegram bot started");

  setChannelHealthCheck("telegram", async () => {
    const result = await Promise.race([
      bot.api.getMe().then(() => ({ healthy: true })),
      new Promise<{ healthy: false; error: string }>(resolve =>
        setTimeout(() => resolve({ healthy: false, error: "getMe timeout" }), 5000)
      ),
    ]);
    return result;
  });

  return async () => {
    _botApi = null;
    await bot.stop();
  };
}
