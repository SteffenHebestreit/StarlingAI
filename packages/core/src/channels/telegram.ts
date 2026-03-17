import { Bot, type Context } from "grammy";
import { createSession, endSession } from "../agent/session.js";
import { runTurn } from "../agent/runtime.js";
import { getConfig } from "../config/loader.js";
import { getEffectiveChannelConfig } from "../credentials/channels.js";
import { checkChannelIngress, type ChannelBaseConfig } from "./base.js";
import { childLogger } from "../logger.js";
import { deliverWithRetry } from "./delivery.js";
import { setChannelHealthCheck } from "./registry.js";

const log = childLogger("channel:telegram");

// Maps Telegram chat IDs → session IDs
const chatSessions = new Map<number, string>();

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
    const session = createSession({
      channel: "telegram",
      userId: userId?.toString(),
    });
    chatSessions.set(ctx.chat.id, session.id);
    await ctx.reply("StarlingAI connected. How can I help?");
    log.info({ chatId: ctx.chat.id, sessionId: session.id }, "Telegram session started");
  });

  bot.command("reset", async (ctx) => {
    const sid = chatSessions.get(ctx.chat.id);
    if (sid) {
      endSession(sid);
      chatSessions.delete(ctx.chat.id);
    }
    const session = createSession({ channel: "telegram", userId: ctx.from?.id?.toString() });
    chatSessions.set(ctx.chat.id, session.id);
    await ctx.reply("Session reset. Fresh start!");
  });

  bot.on("message:text", async (ctx) => {
    const userId = ctx.from?.id;
    if (allowedUserIds.size > 0 && userId !== undefined && !allowedUserIds.has(userId)) {
      await ctx.reply("Unauthorized.");
      return;
    }

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
    if (!sessionId) {
      const session = createSession({ channel: "telegram", userId: userId?.toString() });
      chatSessions.set(ctx.chat.id, session.id);
      sessionId = session.id;
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
    });

    await deliverWithRetry(
      () => ctx.reply(result.response, { parse_mode: "Markdown" }).then(() => undefined),
      result.response,
      { channel: "telegram" }
    );
  });

  await bot.api.getMe();
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
    await bot.stop();
  };
}
