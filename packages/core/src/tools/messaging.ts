/**
 * Tier 3 (privileged, per-call approval) — Send messages through
 * Slack, Discord, and Email channels.
 *
 * Each tool requires the corresponding channel to be enabled and
 * configured in starlingai.json.
 */
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { sendSlackMessage } from "../channels/slack.js";
import { sendDiscordMessage } from "../channels/discord.js";
import { sendEmailMessage } from "../channels/email.js";
import { childLogger } from "../logger.js";

const log = childLogger("tool:messaging");

// ── send_slack ──────────────────────────────────────────────────────────

registerTool({
  name: "send_slack",
  description:
    "Send a text message to a Slack channel or DM. " +
    "Requires the Slack channel to be enabled with a valid bot token. " +
    "The channelId can be a channel ID (C...), user ID (U...), or channel name.",
  embeddingDescription: "Send message, post, notify via Slack channel or direct message. Slack-Nachricht senden, in Slack posten, Team benachrichtigen. Broadcast to team chat.",
  parameters: {
    type: "object",
    properties: {
      channelId: {
        type: "string",
        description: "Slack channel ID, user ID for DM, or channel name (e.g. '#general', 'C01234567').",
      },
      text: {
        type: "string",
        description: "Message text to send. Supports Slack mrkdwn formatting.",
      },
    },
    required: ["channelId", "text"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const channelId = String(args["channelId"] ?? "").trim();
    const text = String(args["text"] ?? "").trim();

    if (!channelId) return { success: false, output: "", error: "channelId is required" };
    if (!text) return { success: false, output: "", error: "text cannot be empty" };

    log.info({ channelId, sessionId: ctx.sessionId }, "send_slack executing");
    const result = await sendSlackMessage(channelId, text);

    if (result.ok) {
      return { success: true, output: `Message sent to Slack channel ${channelId}` };
    }
    return { success: false, output: "", error: result.error ?? "Unknown Slack error" };
  },
});

// ── send_discord ────────────────────────────────────────────────────────

registerTool({
  name: "send_discord",
  description:
    "Send a text message to a Discord channel. " +
    "Requires the Discord channel to be enabled with a valid bot token. " +
    "Messages over 2000 characters are automatically chunked.",
  embeddingDescription: "Send message, post to Discord channel or server. Discord-Nachricht senden, in Discord posten, Community benachrichtigen. Broadcast to Discord community.",
  parameters: {
    type: "object",
    properties: {
      channelId: {
        type: "string",
        description: "Discord channel ID (numeric snowflake, e.g. '1234567890').",
      },
      text: {
        type: "string",
        description: "Message text to send. Supports Discord markdown formatting.",
      },
    },
    required: ["channelId", "text"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const channelId = String(args["channelId"] ?? "").trim();
    const text = String(args["text"] ?? "").trim();

    if (!channelId) return { success: false, output: "", error: "channelId is required" };
    if (!/^\d+$/.test(channelId)) return { success: false, output: "", error: "channelId must be a numeric Discord snowflake ID" };
    if (!text) return { success: false, output: "", error: "text cannot be empty" };

    log.info({ channelId, sessionId: ctx.sessionId }, "send_discord executing");
    const result = await sendDiscordMessage(channelId, text);

    if (result.ok) {
      return { success: true, output: `Message sent to Discord channel ${channelId}` };
    }
    return { success: false, output: "", error: result.error ?? "Unknown Discord error" };
  },
});

// ── send_email ──────────────────────────────────────────────────────────

registerTool({
  name: "send_email",
  description:
    "Send an email via the configured SMTP transporter. " +
    "Requires the email channel to be enabled and running. " +
    "The sender address is the configured smtpFrom address.",
  embeddingDescription: "Send an email via SMTP, dispatch mail message, notify by e-mail. E-Mail versenden per SMTP, Mail schicken, Benachrichtigung per Mail. Non-approval notification channel.",
  // SEC-106 first wave: a sent mail cannot be unsent, and the payload is
  // whatever the model composed — sensitive by classification.
  effect: {
    domain: "messaging",
    reversibility: "irreversible",
    dataClassification: "sensitive",
    target: (args) => String(args["to"] ?? "unknown-recipient"),
  },
  parameters: {
    type: "object",
    properties: {
      to: {
        type: "string",
        description: "Recipient email address (e.g. 'user@example.com').",
      },
      subject: {
        type: "string",
        description: "Email subject line.",
      },
      body: {
        type: "string",
        description: "Plain-text email body.",
      },
    },
    required: ["to", "subject", "body"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const to = String(args["to"] ?? "").trim();
    const subject = String(args["subject"] ?? "").trim();
    const body = String(args["body"] ?? "").trim();

    if (!to) return { success: false, output: "", error: "to is required" };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return { success: false, output: "", error: "Invalid email address format" };
    if (!subject) return { success: false, output: "", error: "subject is required" };
    if (!body) return { success: false, output: "", error: "body cannot be empty" };

    log.info({ to, subject: subject.substring(0, 60), sessionId: ctx.sessionId }, "send_email executing");
    const result = await sendEmailMessage(to, subject, body);

    if (result.ok) {
      return { success: true, output: `Email sent to ${to} with subject "${subject}"` };
    }
    return {
      success: false,
      output: "",
      error: result.error ?? "Unknown email error",
      // SEC-106: a timeout/connection-loss after dispatch means the mail MAY
      // have been delivered — the effect receipt records outcome `unknown`.
      ...(result.dispatchUncertain ? { dispatchUncertain: true } : {}),
    };
  },
});
