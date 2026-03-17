/**
 * Base types and helpers shared by all inbound message channels.
 */
import { createSession, getSession, endSession } from "../agent/session.js";
import { runTurn } from "../agent/runtime.js";
import { logAudit } from "../audit/logger.js";
import { recordChannelIngressDenied } from "./registry.js";

export type DmPolicy = "open" | "allowlist" | "pairing" | "disabled";

export interface ChannelBaseConfig {
  enabled: boolean;
  dmPolicy: DmPolicy;
  allowFrom: string[];
  historyLimit: number;
  perSenderRateLimitCount: number;
  perSenderRateLimitWindowMs: number;
}

interface SenderWindowState {
  hits: number[];
}

const _senderWindows = new Map<string, SenderWindowState>();

/** Result of a dm-policy check */
export type PolicyDecision = "allow" | "pair" | "deny";

/**
 * Check whether a sender is allowed to message the bot.
 * @param senderId   Channel-native sender identifier
 * @param config     The channel's base config
 * @param pairedIds  Set of sender IDs that have already completed pairing
 */
export function checkDmPolicy(
  senderId: string,
  config: ChannelBaseConfig,
  pairedIds: Set<string>
): PolicyDecision {
  if (config.dmPolicy === "disabled") return "deny";
  if (config.dmPolicy === "open") return "allow";
  if (config.allowFrom.includes("*") || config.allowFrom.includes(senderId)) return "allow";
  if (config.dmPolicy === "pairing") {
    return pairedIds.has(senderId) ? "allow" : "pair";
  }
  // allowlist — not in list
  return "deny";
}

/** Resolve a $ENV_VAR token reference */
export function resolveToken(value: string | undefined): string {
  if (!value) return "";
  return value.startsWith("$") ? (process.env[value.slice(1)] ?? "") : value;
}

export function checkChannelIngress(
  channelType: string,
  senderId: string,
  config: ChannelBaseConfig,
): { allowed: boolean; retryAfterMs?: number } {
  const maxMessages = config.perSenderRateLimitCount;
  const windowMs = config.perSenderRateLimitWindowMs;
  const key = `${channelType}:${senderId}`;
  const now = Date.now();
  const existing = _senderWindows.get(key) ?? { hits: [] };
  existing.hits = existing.hits.filter((timestamp) => now - timestamp < windowMs);

  if (existing.hits.length >= maxMessages) {
    const retryAfterMs = Math.max(0, windowMs - (now - existing.hits[0]!));
    _senderWindows.set(key, existing);
    recordChannelIngressDenied(channelType);
    logAudit("rate_limited", {
      scope: "channel_ingress",
      channel: channelType,
      senderId,
      maxMessages,
      windowMs,
      retryAfterMs,
    }, { channel: channelType, userId: senderId, severity: "warn" });
    return { allowed: false, retryAfterMs };
  }

  existing.hits.push(now);
  _senderWindows.set(key, existing);
  return { allowed: true };
}

export function resetChannelIngressForTests(): void {
  _senderWindows.clear();
}

// ─── Per-channel session map helpers ─────────────────────────────────────────

const _sessions = new Map<string, string>(); // key → sessionId

export function getChannelSession(key: string): string | undefined {
  return _sessions.get(key);
}

export function setChannelSession(key: string, sessionId: string): void {
  _sessions.set(key, sessionId);
}

export function deleteChannelSession(key: string): void {
  const sid = _sessions.get(key);
  if (sid) {
    endSession(sid);
    _sessions.delete(key);
  }
}

/**
 * Get or create a session for a sender on a given channel.
 */
export function getOrCreateChannelSession(channelType: string, senderId: string): string {
  const key = `${channelType}:${senderId}`;
  let sid = _sessions.get(key);
  if (sid && getSession(sid)) return sid;
  const session = createSession({ channel: channelType, userId: senderId });
  _sessions.set(key, session.id);
  return session.id;
}

/**
 * Run a turn and return the text response.
 */
export async function runChannelTurn(sessionId: string, text: string): Promise<string> {
  const session = getSession(sessionId);
  if (!session) return "Session expired — please send /reset to start over.";
  const result = await runTurn({ session, userMessage: text });
  return result.response;
}
