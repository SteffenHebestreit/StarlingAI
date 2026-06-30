import { z } from "zod";

export const ChannelWebChatSchema = z.object({
  enabled: z.boolean().default(true),
  port: z.number().int().min(1024).max(65535).default(3001),
});

export const ChannelTelegramSchema = z.object({
  enabled: z.boolean().default(false),
  botToken: z.string().min(1).optional(),
  allowedUserIds: z.array(z.number().int()).default([]),
});

// ─── Channel base (shared fields for all inbound message channels) ────────────
const ChannelBaseSchema = z.object({
  enabled: z.boolean().default(false),
  /** How unknown senders are handled */
  dmPolicy: z.enum(["open", "allowlist", "pairing", "disabled"]).default("pairing"),
  /** Sender IDs to allow (channel-specific format). "*" = all. */
  allowFrom: z.array(z.string()).default([]),
  /** Max messages kept per chat session */
  historyLimit: z.number().int().min(1).max(500).default(50),
  /** Per-sender inbound message budget within the rolling window */
  perSenderRateLimitCount: z.number().int().min(1).max(200).default(12),
  /** Rolling window for per-sender inbound rate limits */
  perSenderRateLimitWindowMs: z.number().int().min(1000).max(3_600_000).default(60_000),
});

export const ChannelSlackSchema = ChannelBaseSchema.extend({
  /** xoxb-... Bot User OAuth Token */
  botToken: z.string().optional(),
  /** xapp-... App-Level Token (Socket Mode) — leave empty for Events API mode */
  appToken: z.string().optional(),
  /** Signing secret for verifying Events API requests */
  signingSecret: z.string().optional(),
});

export const ChannelDiscordSchema = ChannelBaseSchema.extend({
  /** Bot token from Discord Developer Portal */
  token: z.string().optional(),
  /** Restrict to specific guild (server) IDs; empty = respond in all guilds + DMs */
  guildIds: z.array(z.string()).default([]),
});

export const ChannelWhatsappSchema = ChannelBaseSchema.extend({
  /** Webhook verify token (set same value in Meta Developer Console) */
  verifyToken: z.string().optional(),
  /** Meta app secret used to validate X-Hub-Signature-256 on inbound webhooks */
  appSecret: z.string().optional(),
  /** Permanent access token or $ENV_VAR for the Meta Graph API */
  accessToken: z.string().optional(),
  /** WhatsApp Business phone number ID from Meta Console */
  phoneNumberId: z.string().optional(),
});

export const ChannelEmailSchema = ChannelBaseSchema.extend({
  imapHost: z.string().optional(),
  imapPort: z.number().int().default(993),
  imapUser: z.string().optional(),
  imapPassword: z.string().optional(),
  smtpHost: z.string().optional(),
  smtpPort: z.number().int().default(587),
  smtpUser: z.string().optional(),
  smtpPassword: z.string().optional(),
  smtpFrom: z.string().optional(),
  pollIntervalMs: z.number().int().min(5000).default(30_000),
});

export const ChannelSignalSchema = ChannelBaseSchema.extend({
  /** Registered Signal account (phone number) */
  account: z.string().optional(),
  /** Path to signal-cli binary */
  signalCliPath: z.string().default("signal-cli"),
});

export const ChannelsSchema = z.object({
  webchat: ChannelWebChatSchema.default({}),
  telegram: ChannelTelegramSchema.default({}),
  slack: ChannelSlackSchema.default({}),
  discord: ChannelDiscordSchema.default({}),
  whatsapp: ChannelWhatsappSchema.default({}),
  email: ChannelEmailSchema.default({}),
  signal: ChannelSignalSchema.default({}),
});

export type ChannelSlackConfig = z.infer<typeof ChannelSlackSchema>;
export type ChannelDiscordConfig = z.infer<typeof ChannelDiscordSchema>;
export type ChannelWhatsappConfig = z.infer<typeof ChannelWhatsappSchema>;
export type ChannelEmailConfig = z.infer<typeof ChannelEmailSchema>;
export type ChannelSignalConfig = z.infer<typeof ChannelSignalSchema>;
