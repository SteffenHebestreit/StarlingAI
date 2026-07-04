/**
 * Channel configuration routes for the operator dashboard — list channel
 * statuses and read/update/delete a single channel's stored config, with an
 * operator-facing health summary + recovery procedures per channel.
 *
 * Extracted from gateway/index.ts (god-file seam). The two pure helper functions
 * (buildChannelOperatorState, getChannelRecoveryProcedures) were closure-local
 * and are lifted alongside the routes (kept inside the registrar).
 */
import type { Hono } from "hono";
import { verifyToken, extractBearerToken } from "./auth.js";
import { getConfig } from "../config/loader.js";
import { getChannelStatuses } from "../channels/registry.js";
import { CHANNEL_TYPES, getStoredChannelConfig, saveChannelConfig, deleteChannelConfig, getEffectiveChannelConfig, getChannelConfigSource, redactChannelSecrets, type StoredChannelConfig } from "../credentials/channels.js";
import { getChannelRuntimeSupport, reloadChannel } from "../channels/runtime.js";
import { readDeadLetters, type DeadLetterEntry } from "../channels/dead-letter.js";

export function registerChannelRoutes(app: Hono): void {
  function buildChannelOperatorState(
    status: {
      type: string;
      enabled: boolean;
      running: boolean;
      supported?: boolean;
      reason?: string | null;
      error?: string;
      health?: { healthy: boolean; error?: string };
      metrics?: {
        ingressDenied?: number;
        lastDeliveryError?: string;
        deliveryWindows?: { last5m?: { failed: number } };
      };
    },
    recentDeadLetters: DeadLetterEntry[],
  ): { severity: "ok" | "warning" | "critical"; summary: string } {
    if (status.supported === false) {
      return { severity: "warning", summary: status.reason ?? "Runtime not implemented" };
    }
    if (status.error) {
      return { severity: "critical", summary: status.error };
    }
    if (status.health && !status.health.healthy) {
      return { severity: "critical", summary: status.health.error ?? "Health check failing" };
    }
    const recentFailures = status.metrics?.deliveryWindows?.last5m?.failed ?? 0;
    if (recentFailures > 0 || recentDeadLetters.length > 0 || status.metrics?.lastDeliveryError) {
      return {
        severity: "warning",
        summary: recentFailures > 0
          ? recentFailures + " delivery failure" + (recentFailures === 1 ? "" : "s") + " in the last 5 minutes"
          : "Recent delivery failures require attention",
      };
    }
    if ((status.metrics?.ingressDenied ?? 0) > 0) {
      return { severity: "warning", summary: "Ingress requests were blocked by policy or rate limiting" };
    }
    if (status.enabled && !status.running) {
      return { severity: "warning", summary: "Channel is enabled but not running" };
    }
    if (!status.enabled) {
      return { severity: "ok", summary: "Channel is disabled" };
    }
    return { severity: "ok", summary: "Channel is operating normally" };
  }

  function getChannelRecoveryProcedures(type: string): string[] {
    switch (type) {
      case "telegram":
        return [
          "Verify botToken is configured and valid by calling Telegram getMe or reopening the dashboard channel status.",
          "Confirm allowedUserIds is empty or includes the sender if the bot appears reachable but ignores messages.",
          "Restart the gateway after token changes so the Grammy bot reconnects cleanly.",
        ];
      case "slack":
        return [
          "Verify botToken and signingSecret are set and that Slack auth.test succeeds.",
          "If using Events API, confirm the public callback URL is reachable and still matches Slack app settings.",
          "If using Socket Mode, confirm appToken is present and reinstall the app after scope changes.",
        ];
      case "discord":
        return [
          "Verify the bot token and confirm Message Content Intent remains enabled in the Discord developer portal.",
          "Check guildIds restrictions and bot channel permissions if messages arrive in some servers but not others.",
          "Restart the gateway to force a fresh Discord gateway session after token or intent changes.",
        ];
      case "whatsapp":
        return [
          "Confirm accessToken, phoneNumberId, verifyToken, and appSecret all match the Meta app and webhook configuration.",
          "Verify the public webhook URL is reachable and that inbound requests pass X-Hub-Signature-256 validation.",
          "Rotate the access token or re-register the webhook if Meta starts returning authorization or signature errors.",
        ];
      case "email":
        return [
          "Verify IMAP and SMTP credentials separately, especially app passwords for Gmail or Microsoft 365 accounts.",
          "Check pollIntervalMs and mailbox connectivity if inbound mail is delayed but outbound SMTP works.",
          "Restart the gateway after credential changes so the poller reconnects with the new settings.",
        ];
      case "signal":
        return [
          "Verify signal-cli is installed on the gateway host and that channels.signal.signalCliPath points to the correct binary.",
          "Confirm channels.signal.account is already linked or registered in signal-cli and appears in signal-cli listAccounts output.",
          "If Signal stops receiving messages, rerun signal-cli receive manually to confirm the local account session is still healthy.",
        ];
      default:
        return ["Review the channel config, runtime status, and recent dead-letter entries before retrying delivery."];
    }
  }

  app.get("/api/channels", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const currentConfig = getConfig();
    const registeredStatuses = new Map(getChannelStatuses().map((status) => [status.type, status]));
    const statuses = CHANNEL_TYPES.map((type) => {
      const status = registeredStatuses.get(type);
      const channelStatus = {
        type,
        enabled: status?.enabled ?? Boolean(getEffectiveChannelConfig(type, currentConfig.channels[type]).enabled),
        running: status?.running ?? false,
        error: status?.error,
        health: status?.health,
        metrics: status?.metrics,
        ...getChannelRuntimeSupport(type),
      };
      return {
        ...channelStatus,
        operatorState: buildChannelOperatorState(channelStatus, []),
      };
    });
    return c.json(statuses);
  });

  app.get("/api/channels/:type", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const type = c.req.param("type") as Parameters<typeof getStoredChannelConfig>[0];
    if (!CHANNEL_TYPES.includes(type)) {
      return c.json({ error: `Unknown channel type: ${type}` }, 400);
    }

    const currentConfig = getConfig();
    const effective = getEffectiveChannelConfig(type, currentConfig.channels[type]);
    const status = getChannelStatuses().find((entry) => entry.type === type) ?? {
      type,
      enabled: Boolean(effective.enabled),
      running: false,
    };
    const runtimeSupport = getChannelRuntimeSupport(type);
    const recentDeadLetters = readDeadLetters({ channel: type, limit: 5 });
    return c.json({
      type,
      source: getChannelConfigSource(type),
      config: redactChannelSecrets(effective),
      status: {
        ...status,
        ...runtimeSupport,
        operatorState: buildChannelOperatorState({ ...status, ...runtimeSupport }, recentDeadLetters),
      },
      operator: {
        recentDeadLetters,
        recoveryProcedures: getChannelRecoveryProcedures(type),
      },
    });
  });

  app.put("/api/channels/:type", async (c) => {
    const authToken = extractBearerToken(c.req.header("Authorization"));
    if (!authToken || !await verifyToken(authToken)) return c.json({ error: "Unauthorized" }, 401);

    const type = c.req.param("type");
    if (!CHANNEL_TYPES.includes(type as Parameters<typeof saveChannelConfig>[0])) {
      return c.json({ error: `Unknown channel type: ${type}` }, 400);
    }

    let body: StoredChannelConfig;
    try { body = await c.req.json<StoredChannelConfig>(); } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    // If a field is "••••••••" (redacted placeholder), preserve existing value
    const currentConfig = getConfig();
    const existing = getEffectiveChannelConfig(type as Parameters<typeof saveChannelConfig>[0], currentConfig.channels[type as keyof typeof currentConfig.channels]);
    const secretFields = ["botToken", "appToken", "signingSecret", "token", "appSecret", "accessToken", "imapPassword", "smtpPassword"] as const;
    for (const f of secretFields) {
      if ((body as Record<string, unknown>)[f] === "••••••••") {
        (body as Record<string, unknown>)[f] = existing[f];
      }
    }

    saveChannelConfig(type as Parameters<typeof saveChannelConfig>[0], body);
    await reloadChannel(type as Parameters<typeof saveChannelConfig>[0]);
    return c.json({ ok: true, type });
  });

  app.delete("/api/channels/:type", async (c) => {
    const authToken = extractBearerToken(c.req.header("Authorization"));
    if (!authToken || !await verifyToken(authToken)) return c.json({ error: "Unauthorized" }, 401);

    const type = c.req.param("type");
    if (!CHANNEL_TYPES.includes(type as Parameters<typeof deleteChannelConfig>[0])) {
      return c.json({ error: `Unknown channel type: ${type}` }, 400);
    }
    deleteChannelConfig(type as Parameters<typeof deleteChannelConfig>[0]);
    await reloadChannel(type as Parameters<typeof deleteChannelConfig>[0]);
    return c.json({ ok: true });
  });
}
