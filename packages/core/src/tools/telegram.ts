/**
 * Tier 3 (privileged, per-call approval) — Send a Telegram message
 * via the running Telegram bot.
 */
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { sendTelegramMessage } from "../channels/telegram.js";
import { childLogger } from "../logger.js";

const log = childLogger("tool:telegram");

registerTool({
  name: "send_telegram",
  description:
    "Send a text message to a Telegram chat via the running Telegram bot. " +
    "Requires the Telegram channel to be enabled and the bot to be running. " +
    "The chatId is the numeric Telegram chat/user ID.",
  embeddingDescription: "Send message via Telegram bot, push alert to Telegram chat. Telegram-Nachricht senden, Nachricht an Telegram-Bot, kurze Alarmmeldung verschicken.",
  parameters: {
    type: "object",
    properties: {
      chatId: {
        type: "number",
        description: "Telegram chat ID (numeric) to send the message to.",
      },
      text: {
        type: "string",
        description: "Message text to send. Supports Markdown formatting.",
      },
      parseMode: {
        type: "string",
        enum: ["Markdown", "HTML", "none"],
        description: "Message formatting mode (default: Markdown).",
        default: "Markdown",
      },
    },
    required: ["chatId", "text"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const chatId = Number(args["chatId"]);
    const text = String(args["text"] ?? "");
    const parseModeArg = String(args["parseMode"] ?? "Markdown");

    if (!Number.isInteger(chatId)) {
      return { success: false, output: "", error: "chatId must be an integer" };
    }
    if (!text.trim()) {
      return { success: false, output: "", error: "text cannot be empty" };
    }

    const parseMode = parseModeArg === "none" ? undefined : (parseModeArg as "Markdown" | "HTML");

    log.info({ chatId, textLength: text.length, sessionId: ctx.sessionId }, "send_telegram");

    const result = await sendTelegramMessage(chatId, text, parseMode);

    if (!result.ok) {
      return { success: false, output: "", error: result.error ?? "Unknown send error" };
    }

    return {
      success: true,
      output: `Message sent to Telegram chat ${chatId}.`,
      metadata: { chatId, textLength: text.length },
    };
  },
});
