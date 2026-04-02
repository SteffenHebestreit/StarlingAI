/**
 * Discord channel adapter — Gateway WebSocket.
 *
 * Setup:
 *   1. Create a bot at discord.com/developers
 *   2. Enable Privileged Intents: Message Content Intent
 *   3. Copy Bot Token → config.channels.discord.token
 *   4. Invite bot with permissions: Send Messages, Read Message History
 */
import WebSocket from "ws";
import { getConfig } from "../config/loader.js";
import { getEffectiveChannelConfig } from "../credentials/channels.js";
import { listPairedSenders, pairSender } from "../credentials/pairings.js";
import { checkChannelIngress, checkDmPolicy, resolveToken, getOrCreateChannelSession, deleteChannelSession, runChannelTurn } from "./base.js";
import { dispatchChannelTriggeredJob } from "./job-triggers.js";
import { setChannelRunning, setChannelStopped, setChannelError, setChannelHealthCheck } from "./registry.js";
import { childLogger } from "../logger.js";
import { deliverWithRetry } from "./delivery.js";

const log = childLogger("channel:discord");

// Discord Gateway intents
const INTENTS =
  (1 << 9)  |  // GUILD_MESSAGES
  (1 << 12) |  // DIRECT_MESSAGES
  (1 << 15);   // MESSAGE_CONTENT

const PAIRING_CODE = Math.random().toString(36).slice(2, 10).toUpperCase();
const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

interface GatewayPayload {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

export function getDiscordPairingCode(): string { return PAIRING_CODE; }

/** Send a Discord message via REST API */
async function discordSend(token: string, channelId: string, content: string): Promise<void> {
  // Discord has a 2000 char limit per message
  const chunks: string[] = [];
  for (let i = 0; i < content.length; i += 1900) chunks.push(content.slice(i, i + 1900));
  for (const chunk of chunks) {
    await deliverWithRetry(
      async () => {
        const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bot ${token}` },
          body: JSON.stringify({ content: chunk }),
        });
        if (!res.ok) throw new Error(`Discord API ${res.status}: ${await res.text()}`);
      },
      chunk,
      { channel: "discord" }
    );
  }
}

/**
 * Send a Discord message using the configured bot token.
 * Callable from tools — reads token from channel config.
 */
export async function sendDiscordMessage(
  channelId: string,
  content: string,
): Promise<{ ok: boolean; error?: string }> {
  const config = getConfig();
  const discordConfig = getEffectiveChannelConfig("discord", config.channels.discord);
  const token = resolveToken(discordConfig.token);
  if (!token) return { ok: false, error: "Discord bot token not configured" };
  try {
    await discordSend(token, channelId, content);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function startDiscordChannel(): () => Promise<void> {
  const config = getConfig();
  const discordConfig = getEffectiveChannelConfig("discord", config.channels.discord);
  if (!discordConfig.enabled) return async () => {};

  const token = resolveToken(discordConfig.token);
  if (!token) {
    log.warn("Discord channel enabled but token missing — skipped");
    return async () => {};
  }

  let ws: WebSocket | null = null;
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  let seq: number | null = null;
  let stopped = false;

  function connect(): void {
    if (stopped) return;
    ws = new WebSocket(GATEWAY_URL);

    ws.on("message", async (raw) => {
      let payload: GatewayPayload;
      try { payload = JSON.parse(raw.toString()) as GatewayPayload; } catch { return; }

      if (payload.s !== null && payload.s !== undefined) seq = payload.s;

      switch (payload.op) {
        case 10: { // HELLO
          const d = payload.d as { heartbeat_interval: number };
          heartbeatInterval = setInterval(() => {
            ws?.send(JSON.stringify({ op: 1, d: seq }));
          }, d.heartbeat_interval);
          // Identify
          ws!.send(JSON.stringify({
            op: 2,
            d: {
              token,
              intents: INTENTS,
              properties: { os: "linux", browser: "starlingai", device: "starlingai" },
            },
          }));
          break;
        }

        case 0: { // DISPATCH
          if (payload.t === "MESSAGE_CREATE") {
            const msg = payload.d as Record<string, unknown>;
            // Ignore bot messages
            const author = msg["author"] as Record<string, unknown>;
            if (author["bot"]) break;

            const guildId = msg["guild_id"] as string | undefined;
            const channelId = String(msg["channel_id"] ?? "");
            const senderId = String(author["id"] ?? "");
            const content = String(msg["content"] ?? "").trim();

            if (!content || !senderId) break;

            const ingress = checkChannelIngress("discord", senderId, discordConfig);
            if (!ingress.allowed) break;

            // Guild filter
            if (discordConfig.guildIds.length > 0 && guildId && !discordConfig.guildIds.includes(guildId)) break;

            const decision = checkDmPolicy(senderId, discordConfig, new Set(listPairedSenders("discord")));

            if (decision === "deny") break;

            if (decision === "pair") {
              if (content.toLowerCase().startsWith("/pair ")) {
                const code = content.slice(6).trim().toUpperCase();
                if (code === PAIRING_CODE) {
                  pairSender("discord", senderId);
                  await discordSend(token, channelId, "Paired successfully. How can I help?");
                } else {
                  await discordSend(token, channelId, "Invalid pairing code.");
                }
              } else {
                await discordSend(token, channelId, `This bot requires pairing. Send: /pair ${PAIRING_CODE}`);
              }
              break;
            }

            if (content === "/reset") {
              deleteChannelSession(`discord:${senderId}`);
              await discordSend(token, channelId, "Session reset.");
              break;
            }

            const triggeredJob = await dispatchChannelTriggeredJob({ channel: "discord", senderId, text: content });
            if (triggeredJob.matched) {
              if (triggeredJob.responseText) {
                await discordSend(token, channelId, triggeredJob.responseText);
              }
              break;
            }

            const sessionId = getOrCreateChannelSession("discord", senderId);
            runChannelTurn(sessionId, content)
              .then(response => discordSend(token, channelId, response))
              .catch(err => log.error({ err }, "Discord turn error"));
          }
          break;
        }

        case 7: // RECONNECT
          ws?.close();
          setTimeout(connect, 2000);
          break;

        case 9: // INVALID SESSION
          setTimeout(connect, 5000);
          break;
      }
    });

    ws.on("close", () => {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      if (!stopped) setTimeout(connect, 5000);
    });

    ws.on("error", (err) => {
      log.error({ err }, "Discord WS error");
      setChannelError("discord", String(err));
    });
  }

  connect();
  setChannelRunning("discord", async () => {
    stopped = true;
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    ws?.close();
    setChannelStopped("discord");
  });
  setChannelHealthCheck("discord", async () => {
    const res = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return { healthy: false, error: `Discord API ${res.status}` };
    }
    return { healthy: true };
  });
  log.info(`Discord channel started — pairing code: ${PAIRING_CODE}`);

  return async () => {
    stopped = true;
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    ws?.close();
    setChannelStopped("discord");
  };
}
