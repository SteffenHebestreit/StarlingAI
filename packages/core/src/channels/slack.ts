/**
 * Slack channel adapter — Events API mode.
 *
 * Setup in Slack app:
 *   1. Enable Event Subscriptions → Request URL: https://<your-host>/channels/slack/events
 *   2. Subscribe to bot events: message.channels, message.groups, message.im, message.mpim
 *   3. Add OAuth scopes: chat:write, channels:history, groups:history, im:history, mpim:history
 *   4. Install app to workspace → copy Bot User OAuth Token (xoxb-...)
 *   5. Copy Signing Secret from Basic Information
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { getConfig } from "../config/loader.js";
import { getEffectiveChannelConfig } from "../credentials/channels.js";
import { listPairedSenders, pairSender } from "../credentials/pairings.js";
import { checkChannelIngress, checkDmPolicy, resolveToken, getOrCreateChannelSession, runChannelTurn } from "./base.js";
import { setChannelRunning, setChannelStopped, setChannelHealthCheck } from "./registry.js";
import { childLogger } from "../logger.js";
import { deliverWithRetry } from "./delivery.js";

const log = childLogger("channel:slack");

// Startup pairing code
const PAIRING_CODE = Math.random().toString(36).slice(2, 10).toUpperCase();

export function getSlackPairingCode(): string { return PAIRING_CODE; }

/** Verify Slack request signature */
function verifySlackSignature(signingSecret: string, timestamp: string, rawBody: string, signature: string): boolean {
  const base = `v0:${timestamp}:${rawBody}`;
  const expected = "v0=" + createHmac("sha256", signingSecret).update(base).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch { return false; }
}

/** Send a message to a Slack channel via chat.postMessage */
async function slackSend(botToken: string, channel: string, text: string): Promise<void> {
  await deliverWithRetry(
    async () => {
      const res = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${botToken}` },
        body: JSON.stringify({ channel, text }),
      });
      const data = await res.json() as { ok: boolean; error?: string };
      if (!data.ok) throw new Error(`Slack API error: ${data.error}`);
    },
    text,
    { channel: "slack" }
  );
}

/**
 * Handle an incoming Slack Events API POST.
 * Called by the Hono route in gateway/index.ts.
 */
export async function handleSlackEvent(c: Context): Promise<Response> {
  const config = getConfig();
  const slackConfig = getEffectiveChannelConfig("slack", config.channels.slack);
  if (!slackConfig.enabled) return c.json({ error: "Slack channel disabled" }, 403);

  const rawBody = await c.req.text();
  const signingSecret = resolveToken(slackConfig.signingSecret);
  const botToken = resolveToken(slackConfig.botToken);

  if (!signingSecret || !botToken) {
    log.error("Slack channel missing signingSecret or botToken");
    return c.json({ error: "Channel not configured" }, 500);
  }

  // Verify signature
  const timestamp = c.req.header("X-Slack-Request-Timestamp") ?? "";
  const signature = c.req.header("X-Slack-Signature") ?? "";
  if (!verifySlackSignature(signingSecret, timestamp, rawBody, signature)) {
    log.warn("Slack signature verification failed");
    return c.json({ error: "Invalid signature" }, 401);
  }

  let body: Record<string, unknown>;
  try { body = JSON.parse(rawBody) as Record<string, unknown>; } catch { return c.json({ error: "Bad JSON" }, 400); }

  // URL verification challenge
  if (body["type"] === "url_verification") {
    return c.json({ challenge: body["challenge"] });
  }

  if (body["type"] !== "event_callback") return c.json({ ok: true });

  const event = body["event"] as Record<string, unknown>;
  if (!event || event["type"] !== "message") return c.json({ ok: true });

  // Ignore bot messages and message edits
  if (event["bot_id"] || event["subtype"]) return c.json({ ok: true });

  const senderId = String(event["user"] ?? "");
  const channelId = String(event["channel"] ?? "");
  const text = String(event["text"] ?? "").trim();
  if (!senderId || !channelId || !text) return c.json({ ok: true });

  const ingress = checkChannelIngress("slack", senderId, slackConfig);
  if (!ingress.allowed) {
    return c.json({ ok: true });
  }

  // DM policy check
  const decision = checkDmPolicy(senderId, slackConfig, new Set(listPairedSenders("slack")));

  if (decision === "deny") {
    log.info({ senderId }, "Slack DM denied by policy");
    return c.json({ ok: true });
  }

  if (decision === "pair") {
    if (text.toLowerCase().startsWith("/pair ")) {
      const code = text.slice(6).trim().toUpperCase();
      if (code === PAIRING_CODE) {
        pairSender("slack", senderId);
        await slackSend(botToken, channelId, "Paired successfully. How can I help?");
      } else {
        await slackSend(botToken, channelId, "Invalid pairing code.");
      }
    } else {
      await slackSend(botToken, channelId, `This bot requires pairing. Send: /pair ${PAIRING_CODE}`);
    }
    return c.json({ ok: true });
  }

  // Handle /reset
  if (text === "/reset") {
    const { deleteChannelSession } = await import("./base.js");
    deleteChannelSession(`slack:${senderId}`);
    await slackSend(botToken, channelId, "Session reset. Fresh start!");
    return c.json({ ok: true });
  }

  const sessionId = getOrCreateChannelSession("slack", senderId);
  // Fire and forget — Slack requires 200 within 3s
  runChannelTurn(sessionId, text).then(response =>
    slackSend(botToken, channelId, response)
  ).catch(err => log.error({ err }, "Slack turn error"));

  return c.json({ ok: true });
}

export function startSlackChannel(): void {
  const config = getConfig();
  const slackConfig = getEffectiveChannelConfig("slack", config.channels.slack);
  if (!slackConfig.enabled) return;
  const botToken = resolveToken(slackConfig.botToken);
  const signingSecret = resolveToken(slackConfig.signingSecret);
  if (!botToken || !signingSecret) {
    log.warn("Slack channel enabled but botToken/signingSecret missing — skipped");
    return;
  }
  setChannelRunning("slack", async () => { setChannelStopped("slack"); });
  setChannelHealthCheck("slack", async () => {
    const res = await fetch("https://slack.com/api/auth.test", {
      headers: { Authorization: `Bearer ${botToken}` },
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json() as { ok: boolean; error?: string };
    return data.ok ? { healthy: true } : { healthy: false, error: data.error };
  });
  log.info(`Slack channel active (Events API) — pairing code: ${PAIRING_CODE}`);
}
