/**
 * Runtime channel configuration store.
 *
 * Channel configs use the validated config file as a baseline and apply any
 * dashboard-managed overrides from the encrypted credential store on top.
 *
 * Store key format:  channel:<type>:config  →  JSON string of partial channel config
 */
import { getCredential, setCredential, deleteCredential } from "./store.js";
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";

const log = childLogger("credentials:channels");

const CHANNEL_KEY = (type: string) => `channel:${type}:config`;

export type ChannelType = "slack" | "discord" | "whatsapp" | "email" | "signal" | "telegram" | "webchat";

export const CHANNEL_TYPES: ChannelType[] = ["slack", "discord", "whatsapp", "email", "signal", "telegram"];

export interface StoredChannelConfig {
  enabled?: boolean;
  dmPolicy?: string;
  allowFrom?: string[];
  historyLimit?: number;
  perSenderRateLimitCount?: number;
  perSenderRateLimitWindowMs?: number;
  // Telegram
  botToken?: string;
  allowedUserIds?: number[];
  // Slack
  appToken?: string;
  signingSecret?: string;
  // Discord
  token?: string;
  guildIds?: string[];
  // WhatsApp
  verifyToken?: string;
  appSecret?: string;
  accessToken?: string;
  phoneNumberId?: string;
  // Email
  imapHost?: string;
  imapPort?: number;
  imapUser?: string;
  imapPassword?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPassword?: string;
  smtpFrom?: string;
  // Signal
  account?: string;
  signalCliPath?: string;
}

export interface ChannelSummary {
  type: ChannelType;
  source: "config" | "store" | "default";
  enabled: boolean;
  dmPolicy: string;
  /** Tokens/secrets are always redacted in the summary */
  configured: boolean;
}

export function getStoredChannelConfig(type: ChannelType): StoredChannelConfig | null {
  const raw = getCredential(CHANNEL_KEY(type));
  if (!raw) return null;
  try { return JSON.parse(raw) as StoredChannelConfig; } catch { return null; }
}

export function saveChannelConfig(type: ChannelType, config: StoredChannelConfig): void {
  setCredential(CHANNEL_KEY(type), JSON.stringify(config));
  log.info({ type }, "Channel config saved to store");
}

export function deleteChannelConfig(type: ChannelType): void {
  deleteCredential(CHANNEL_KEY(type));
  log.info({ type }, "Channel config deleted from store");
}

export function getEffectiveChannelConfig<T extends Record<string, unknown>>(type: ChannelType, baseConfig: T): T & StoredChannelConfig {
  return {
    ...baseConfig,
    ...(getStoredChannelConfig(type) ?? {}),
  };
}

export function getChannelConfigSource(type: ChannelType): "config" | "store" {
  return getStoredChannelConfig(type) ? "store" : "config";
}

export function getConfiguredChannelTypes(): ChannelType[] {
  const channels = getConfig().channels;
  return CHANNEL_TYPES.filter((type) => {
    const effective = getEffectiveChannelConfig(type, channels[type]);
    return Boolean(effective.enabled);
  });
}

const SECRET_FIELDS = ["botToken", "appToken", "signingSecret", "token", "appSecret", "accessToken", "imapPassword", "smtpPassword"] as const;

export function redactChannelSecrets<T extends object>(config: T): T {
  const redacted = { ...config } as T & Partial<Record<(typeof SECRET_FIELDS)[number], unknown>>;
  for (const key of SECRET_FIELDS) {
    if (typeof redacted[key] === "string" && redacted[key]) {
      redacted[key] = "••••••••";
    }
  }
  return redacted;
}
