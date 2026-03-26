import { getConfig } from "../config/loader.js";
import { CHANNEL_TYPES, type ChannelType, getEffectiveChannelConfig } from "../credentials/channels.js";
import { childLogger } from "../logger.js";
import { resolveToken } from "./base.js";
import { getChannelStatuses, registerChannel, setChannelError, setChannelRunning, setChannelStopped } from "./registry.js";
import { startDiscordChannel } from "./discord.js";
import { startSlackChannel } from "./slack.js";
import { startTelegramBot } from "./telegram.js";
import { startWhatsappChannel } from "./whatsapp.js";
import { startEmailChannel } from "./email.js";
import { startSignalChannel } from "./signal.js";
import { markRuntimeComponentAttempt, markRuntimeComponentFailure, markRuntimeComponentSuccess } from "../runtime/status.js";

const log = childLogger("channels:runtime");
const UNSUPPORTED_CHANNEL_REASON = "Channel runtime is not implemented yet";

const managedStops = new Map<ChannelType, () => Promise<void>>();
let channelSyncQueue: Promise<void> = Promise.resolve();

export function syncAllChannels(): Promise<void> {
  return enqueueChannelSync(async () => {
    for (const type of CHANNEL_TYPES) {
      await syncChannelNow(type);
    }
  });
}

export function reloadChannel(type: ChannelType): Promise<void> {
  return enqueueChannelSync(() => syncChannelNow(type));
}

export function stopManagedChannels(): Promise<void> {
  return enqueueChannelSync(async () => {
    for (const type of CHANNEL_TYPES) {
      await stopManagedChannel(type);
      registerChannel(type, false);
    }
  });
}

export function isChannelRuntimeSupported(type: ChannelType): boolean {
  return type === "telegram" || type === "slack" || type === "discord" || type === "whatsapp" || type === "email" || type === "signal";
}

export function getChannelRuntimeSupport(type: ChannelType): { supported: boolean; reason?: string } {
  if (isChannelRuntimeSupported(type)) {
    return { supported: true };
  }

  return { supported: false, reason: UNSUPPORTED_CHANNEL_REASON };
}

function enqueueChannelSync(operation: () => Promise<void>): Promise<void> {
  const next = channelSyncQueue.then(async () => {
    markRuntimeComponentAttempt("channels");
    try {
      await operation();
      const statuses = getChannelStatusesForStatus();
      markRuntimeComponentSuccess("channels", {
        enabled: statuses.filter((status) => status.enabled).length,
        running: statuses.filter((status) => status.running).length,
        unhealthy: statuses.filter((status) => status.error).length,
      }, { healthy: statuses.every((status) => !status.error) });
    } catch (err) {
      markRuntimeComponentFailure("channels", err);
      throw err;
    }
  }, async () => {
    markRuntimeComponentAttempt("channels");
    try {
      await operation();
      const statuses = getChannelStatusesForStatus();
      markRuntimeComponentSuccess("channels", {
        enabled: statuses.filter((status) => status.enabled).length,
        running: statuses.filter((status) => status.running).length,
        unhealthy: statuses.filter((status) => status.error).length,
      }, { healthy: statuses.every((status) => !status.error) });
    } catch (err) {
      markRuntimeComponentFailure("channels", err);
      throw err;
    }
  });
  channelSyncQueue = next.catch((err) => {
    log.error({ err }, "Channel sync failed");
  });
  return next;
}

async function syncChannelNow(type: ChannelType): Promise<void> {
  const effective = getEffectiveConfig(type);
  registerChannel(type, Boolean(effective.enabled));

  await stopManagedChannel(type);

  if (!effective.enabled) {
    setChannelStopped(type);
    return;
  }

  switch (type) {
    case "telegram": {
      if (!resolveToken(effective.botToken)) {
        setChannelError(type, "Telegram channel enabled but botToken missing");
        return;
      }

      let stop: (() => Promise<void>) | null;
      try {
        stop = await startTelegramBot();
      } catch (err) {
        setChannelError(type, `Telegram startup failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }

      if (!stop) {
        setChannelError(type, "Telegram channel failed to start");
        return;
      }

      setChannelRunning(type, rememberManagedStop(type, stop));
      return;
    }

    case "discord": {
      if (!resolveToken(effective.token)) {
        setChannelError(type, "Discord channel enabled but token missing");
        return;
      }

      const stop = startDiscordChannel();
      setChannelRunning(type, rememberManagedStop(type, stop));
      return;
    }

    case "slack": {
      if (!resolveToken(effective.botToken) || !resolveToken(effective.signingSecret)) {
        setChannelError(type, "Slack channel enabled but botToken/signingSecret missing");
        return;
      }

      startSlackChannel();
      return;
    }

    case "whatsapp": {
      if (!resolveToken(effective.accessToken) || !resolveToken(effective.phoneNumberId)) {
        setChannelError(type, "WhatsApp channel enabled but accessToken/phoneNumberId missing");
        return;
      }

      startWhatsappChannel();
      return;
    }

    case "email": {
      let stopFn: (() => Promise<void>) | null;
      try {
        stopFn = await startEmailChannel();
      } catch (err) {
        setChannelError(type, `Email startup failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      if (stopFn) {
        rememberManagedStop(type, stopFn);
      }
      return;
    }

    case "signal": {
      if (!resolveToken(effective.account)) {
        setChannelError(type, "Signal channel enabled but account missing");
        return;
      }

      let stopFn: (() => Promise<void>) | null;
      try {
        stopFn = await startSignalChannel();
      } catch (err) {
        setChannelError(type, `Signal startup failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }

      if (!stopFn) {
        setChannelError(type, "Signal channel failed to start");
        return;
      }

      setChannelRunning(type, rememberManagedStop(type, stopFn));
      return;
    }
  }
}

async function stopManagedChannel(type: ChannelType): Promise<void> {
  const stop = managedStops.get(type);
  if (!stop) {
    setChannelStopped(type);
    return;
  }

  managedStops.delete(type);
  await stop();
  setChannelStopped(type);
}

function rememberManagedStop(type: ChannelType, stop: () => Promise<void>): () => Promise<void> {
  const wrappedStop = async () => {
    try {
      await stop();
    } finally {
      managedStops.delete(type);
      setChannelStopped(type);
    }
  };

  managedStops.set(type, wrappedStop);
  return wrappedStop;
}

function getEffectiveConfig<T extends ChannelType>(type: T) {
  const config = getConfig();
  return getEffectiveChannelConfig(type, config.channels[type]);
}

function getChannelStatusesForStatus() {
  return getChannelStatuses();
}