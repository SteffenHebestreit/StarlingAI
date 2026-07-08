/**
 * WhatsApp channel adapter — Meta Cloud API.
 *
 * Setup:
 *   1. Create a Meta app at developers.facebook.com
 *   2. Add WhatsApp product → get a test phone number
 *   3. Set Webhook URL: https://<your-host>/channels/whatsapp/webhook
 *   4. Set Verify Token (same as config.channels.whatsapp.verifyToken)
 *   5. Subscribe to webhook fields: messages
 *   6. Copy Permanent Access Token → config.channels.whatsapp.accessToken
 *   7. Copy Phone Number ID → config.channels.whatsapp.phoneNumberId
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { getConfig } from "../config/loader.js";
import { getEffectiveChannelConfig } from "../credentials/channels.js";
import { listPairedSenders, pairSender } from "../credentials/pairings.js";
import { checkChannelIngress, checkDmPolicy, resolveToken, getOrCreateChannelSession, deleteChannelSession, runChannelTurn } from "./base.js";
import { dispatchChannelTriggeredJob } from "./job-triggers.js";
import { setChannelHealthCheck, setChannelRunning, setChannelStopped } from "./registry.js";
import { childLogger } from "../logger.js";
import { deliverWithRetry } from "./delivery.js";

const log = childLogger("channel:whatsapp");

const PAIRING_CODE = Math.random().toString(36).slice(2, 10).toUpperCase();

// ── Replay-window deduplication ───────────────────────────────────────────────
// Meta may deliver the same webhook more than once. Track recently seen message
// IDs so we can discard duplicates without double-processing them.
const REPLAY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

const _seenMessageIds = new Map<string, number>(); // messageId → first-seen timestamp

function isReplay(messageId: string): boolean {
  const now = Date.now();
  // Prune expired entries to prevent unbounded growth
  for (const [id, ts] of _seenMessageIds) {
    if (now - ts > REPLAY_WINDOW_MS) _seenMessageIds.delete(id);
  }
  if (_seenMessageIds.has(messageId)) return true;
  _seenMessageIds.set(messageId, now);
  return false;
}

export function verifyWhatsappSignature(appSecret: string, rawBody: string, signature: string): boolean {
  const expected = `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

async function waSend(accessToken: string, phoneNumberId: string, to: string, text: string): Promise<void> {
  const url = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;
  await deliverWithRetry(
    async () => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to,
          type: "text",
          text: { body: text },
        }),
      });
      if (!res.ok) {
        throw new Error(`WhatsApp API ${res.status}: ${await res.text()}`);
      }
    },
    text,
    { channel: "whatsapp" },
  );
}

/** GET handler — webhook verification challenge */
export function handleWhatsappVerify(c: Context): Response {
  const config = getConfig();
  const waConfig = getEffectiveChannelConfig("whatsapp", config.channels.whatsapp);
  const verifyToken = resolveToken(waConfig.verifyToken);
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");
  if (mode === "subscribe" && token === verifyToken) {
    return c.text(challenge ?? "");
  }
  return c.text("Forbidden", 403);
}

/** POST handler — incoming messages */
export async function handleWhatsappEvent(c: Context): Promise<Response> {
  const config = getConfig();
  const waConfig = getEffectiveChannelConfig("whatsapp", config.channels.whatsapp);
  if (!waConfig.enabled) return c.json({ ok: false });

  const rawBody = await c.req.text();
  const appSecret = resolveToken(waConfig.appSecret);
  const signature = c.req.header("X-Hub-Signature-256") ?? "";
  if (appSecret && !verifyWhatsappSignature(appSecret, rawBody, signature)) {
    log.warn("WhatsApp signature verification failed");
    return c.json({ ok: false, error: "Invalid signature" }, 401);
  }

  const accessToken = resolveToken(waConfig.accessToken);
  const phoneNumberId = resolveToken(waConfig.phoneNumberId);

  let body: Record<string, unknown>;
  try { body = JSON.parse(rawBody) as Record<string, unknown>; } catch { return c.json({ ok: false }); }

  // Meta webhook structure: body.entry[].changes[].value.messages[]
  const entries = (body["entry"] as Array<Record<string, unknown>>) ?? [];
  for (const entry of entries) {
    const changes = (entry["changes"] as Array<Record<string, unknown>>) ?? [];
    for (const change of changes) {
      const value = change["value"] as Record<string, unknown>;
      const messages = (value["messages"] as Array<Record<string, unknown>>) ?? [];
      for (const message of messages) {
        if (message["type"] !== "text") continue;
        const messageId = String(message["id"] ?? "");
        if (messageId && isReplay(messageId)) {
          log.debug({ messageId }, "Discarding duplicate WhatsApp webhook delivery");
          continue;
        }
        const senderId = String(message["from"] ?? "");
        const text = ((message["text"] as Record<string, unknown>)?.["body"] as string ?? "").trim();
        if (!senderId || !text) continue;

        const ingress = checkChannelIngress("whatsapp", senderId, waConfig);
        if (!ingress.allowed) continue;

        const decision = checkDmPolicy(senderId, waConfig, new Set(listPairedSenders("whatsapp")));

        if (decision === "deny") continue;

        if (decision === "pair") {
          if (text.toLowerCase().startsWith("/pair ")) {
            const code = text.slice(6).trim().toUpperCase();
            if (code === PAIRING_CODE) {
              pairSender("whatsapp", senderId);
              await waSend(accessToken, phoneNumberId, senderId, "Paired successfully! How can I help?");
            } else {
              await waSend(accessToken, phoneNumberId, senderId, "Invalid pairing code.");
            }
          } else {
            await waSend(accessToken, phoneNumberId, senderId, `Send: /pair ${PAIRING_CODE} to authorize this bot.`);
          }
          continue;
        }

        if (text === "/reset") {
          deleteChannelSession(`whatsapp:${senderId}`);
          await waSend(accessToken, phoneNumberId, senderId, "Session reset.");
          continue;
        }

        const triggeredJob = await dispatchChannelTriggeredJob({ channel: "whatsapp", senderId, text });
        if (triggeredJob.matched) {
          if (triggeredJob.responseText) {
            await waSend(accessToken, phoneNumberId, senderId, triggeredJob.responseText);
          }
          continue;
        }

        const sessionId = await getOrCreateChannelSession("whatsapp", senderId);
        runChannelTurn(sessionId, text)
          .then(response => waSend(accessToken, phoneNumberId, senderId, response))
          .catch(err => log.error({ err }, "WhatsApp turn error"));
      }
    }
  }

  return c.json({ ok: true });
}

export function startWhatsappChannel(): void {
  const config = getConfig();
  const waConfig = getEffectiveChannelConfig("whatsapp", config.channels.whatsapp);
  if (!waConfig.enabled) return;
  const accessToken = resolveToken(waConfig.accessToken);
  const phoneNumberId = resolveToken(waConfig.phoneNumberId);
  if (!accessToken || !phoneNumberId) {
    log.warn("WhatsApp channel enabled but accessToken/phoneNumberId missing — skipped");
    return;
  }
  setChannelRunning("whatsapp", async () => { setChannelStopped("whatsapp"); });
  setChannelHealthCheck("whatsapp", async () => {
    const url = `https://graph.facebook.com/v18.0/${phoneNumberId}?fields=id`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return { healthy: false, error: `WhatsApp API ${res.status}` };
    }
    return { healthy: true };
  });
  log.info(`WhatsApp channel active — pairing code: ${PAIRING_CODE}`);
}
