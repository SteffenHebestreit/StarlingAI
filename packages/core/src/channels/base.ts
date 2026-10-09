/**
 * Base types and helpers shared by all inbound message channels.
 */
import { createSession, getSession, endSession, resolveSession } from "../agent/session.js";
import { getChannelSessionId, setChannelSessionId } from "../agent/session-redis.js";
import { runTurn } from "../agent/runtime.js";
import { logAudit } from "../audit/logger.js";
import { getConfig } from "../config/loader.js";
import { getExtensionAuthProvider } from "../extension/index.js";
import { childLogger } from "../logger.js";
import { AccountNotThreadedError, principalIdentity, reservedUsernameProblem } from "../runtime/user-scope.js";
import { recordChannelIngressDenied } from "./registry.js";

const log = childLogger("channel:base");

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

export function deleteChannelSession(key: string): void {
  const sid = _sessions.get(key);
  if (sid) {
    endSession(sid);
    _sessions.delete(key);
  }
}

// ─── Senders that may not be served (multi-user auth) ────────────────────────
// A channel sender is a principal: its storage is keyed by its raw id, the segment that id always
// had. An account's storage is keyed by its immutable id, but the data an account kept before ids
// existed sits under the segment of its USERNAME, which is that same formula. A Telegram user whose
// id is an account's username, or a mail From an OIDC account's address, would read and write that
// account's data; under an extension auth provider an account's id is the formula of the provider's
// user id, so a sender with that id would be the account outright. Such a sender is refused: no
// session, no turn and no reply, which tells the sender nothing about the account. With one
// operator nothing is partitioned and every sender is served, as before.

/** A sender a channel does not serve, and why (for the audit, never for the sender). */
export interface ChannelSenderRefused {
  refused: string;
}

/** The session a sender is served in, or the refusal. */
export type ChannelSessionResult = { sessionId: string } | ChannelSenderRefused;

/** Why `senderId` may not be served as a channel principal, or undefined when it may. A config
 *  that cannot be read refuses. */
export function channelSenderRefusal(senderId: string): string | undefined {
  try {
    if (getConfig().auth?.enabled !== true) return undefined;
    const problem = reservedUsernameProblem(senderId);
    if (problem) return `the sender id ${problem}`;
    if (getExtensionAuthProvider()?.getUserById(senderId)) return "the sender id is a user id of the deployment's auth provider";
    return undefined;
  } catch (err) {
    return `the sender could not be checked (${err instanceof Error ? err.message : String(err)})`;
  }
}

/**
 * Records a refused sender: audited as `channel_sender_refused` and logged. The adapter marks the
 * message handled and sends nothing back.
 */
export function recordChannelSenderRefused(channelType: string, senderId: string, reason: string): void {
  logAudit("channel_sender_refused", { channel: channelType, reason }, { channel: channelType, userId: senderId, severity: "warn" });
  log.warn({ channel: channelType, reason }, "Channel message refused: the sender may not be served under multi-user auth");
}

/**
 * Get or create a session for a sender on a given channel, or the refusal of a sender that may not
 * be served (channelSenderRefusal), checked before any session is reused or made. A session is the
 * sender's as a channel principal. Async to support cross-instance Redis channel-session routing.
 */
export async function getOrCreateChannelSession(channelType: string, senderId: string): Promise<ChannelSessionResult> {
  const refusal = channelSenderRefusal(senderId);
  if (refusal) return { refused: refusal };
  const key = `${channelType}:${senderId}`;

  try {
    // 1. Check local in-process map first (fastest path).
    const localSid = _sessions.get(key);
    if (localSid && getSession(localSid)) return { sessionId: localSid };

    // 2. Check Redis for a session that was created on another instance.
    const redisSid = await getChannelSessionId(channelType, senderId);
    if (redisSid) {
      const redisSession = await resolveSession(redisSid);
      if (redisSession) {
        _sessions.set(key, redisSid);
        return { sessionId: redisSid };
      }
    }

    // 3. Create a fresh session and publish the mapping.
    const session = createSession({ channel: channelType, ...principalIdentity(senderId, "channel") });
    _sessions.set(key, session.id);
    void setChannelSessionId(channelType, senderId, session.id);
    return { sessionId: session.id };
  } catch (err) {
    // A storage derivation that refused an identity it could not place is a refusal of this one
    // message, never a failure of the channel.
    if (err instanceof AccountNotThreadedError) return { refused: err.message };
    throw err;
  }
}

/**
 * Run a turn and return the text response.
 */
export async function runChannelTurn(sessionId: string, text: string): Promise<string> {
  const session = getSession(sessionId);
  if (!session) return "Session expired — please send /reset to start over.";
  // Every channel hands this what the sender wrote, so it is also what specialists are shown as
  // the user's own words.
  const result = await runTurn({ session, userMessage: text, userWords: text });
  return result.response;
}
