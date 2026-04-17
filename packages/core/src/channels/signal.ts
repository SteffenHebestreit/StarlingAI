import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getConfig } from "../config/loader.js";
import type { ChannelSignalConfig } from "../config/schema.js";
import { getEffectiveChannelConfig } from "../credentials/channels.js";
import { listPairedSenders, pairSender } from "../credentials/pairings.js";
import {
  checkChannelIngress,
  checkDmPolicy,
  deleteChannelSession,
  getOrCreateChannelSession,
  resolveToken,
  runChannelTurn,
} from "./base.js";
import { deliverWithRetry } from "./delivery.js";
import { dispatchChannelTriggeredJob } from "./job-triggers.js";
import { childLogger } from "../logger.js";
import { setChannelHealthCheck } from "./registry.js";

const log = childLogger("channel:signal");
const execFileAsync = promisify(execFile);

const PAIRING_CODE = Math.random().toString(36).slice(2, 10).toUpperCase();
const RECEIVE_TIMEOUT_SECONDS = 1;
const RECEIVE_EXEC_TIMEOUT_MS = 8_000;
const HEALTHCHECK_TIMEOUT_MS = 8_000;
const POLL_INTERVAL_MS = 3_000;
const REPLAY_WINDOW_MS = 5 * 60 * 1000;

interface SignalCliResult {
  stdout: string;
  stderr: string;
}

type SignalCliExecutor = (binaryPath: string, args: string[], timeoutMs: number) => Promise<SignalCliResult>;
type EffectiveSignalConfig = ChannelSignalConfig & { account?: string; signalCliPath?: string };

export interface SignalInboundMessage {
  senderId: string;
  text: string;
  timestamp: number;
}

const _seenMessageIds = new Map<string, number>();

const defaultSignalCliExecutor: SignalCliExecutor = async (binaryPath, args, timeoutMs) => {
  const { stdout, stderr } = await execFileAsync(binaryPath, args, {
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  return { stdout, stderr };
};

let signalCliExecutor: SignalCliExecutor = defaultSignalCliExecutor;

export function setSignalCliExecutorForTests(executor?: SignalCliExecutor): void {
  signalCliExecutor = executor ?? defaultSignalCliExecutor;
}

export function resetSignalReplayWindowForTests(): void {
  _seenMessageIds.clear();
}

export function getSignalPairingCode(): string {
  return PAIRING_CODE;
}

export async function startSignalChannel(): Promise<(() => Promise<void>) | null> {
  const config = getConfig();
  const signalConfig = getEffectiveChannelConfig("signal", config.channels.signal) as EffectiveSignalConfig;

  if (!signalConfig.enabled) return null;

  const account = resolveToken(signalConfig.account);
  const signalCliPath = signalConfig.signalCliPath?.trim() || "signal-cli";

  if (!account) {
    log.info("Signal channel disabled (no account configured)");
    return null;
  }

  const initialHealth = await checkSignalAccount(signalCliPath, account);
  if (!initialHealth.healthy) {
    throw new Error(initialHealth.error ?? "Signal account is unavailable");
  }

  let stopped = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;

  const schedulePoll = (delayMs: number) => {
    if (stopped) return;
    pollTimer = setTimeout(() => {
      void pollOnce();
    }, delayMs);
    pollTimer.unref?.();
  };

  const pollOnce = async () => {
    if (stopped) return;

    try {
      const received = await receiveSignalMessages(signalCliPath, account);
      for (const message of received) {
        await handleSignalMessage(signalCliPath, account, signalConfig, message);
      }
    } catch (err) {
      if (!stopped) {
        log.warn({ err }, "Signal receive poll failed");
      }
    } finally {
      schedulePoll(POLL_INTERVAL_MS);
    }
  };

  setChannelHealthCheck("signal", async () => checkSignalAccount(signalCliPath, account));
  schedulePoll(0);
  log.info(`Signal channel active — pairing code: ${PAIRING_CODE}`);

  return async () => {
    stopped = true;
    if (pollTimer) clearTimeout(pollTimer);
  };
}

async function handleSignalMessage(
  signalCliPath: string,
  account: string,
  signalConfig: EffectiveSignalConfig,
  message: SignalInboundMessage,
): Promise<void> {
  if (isReplay(message)) return;

  const ingress = checkChannelIngress("signal", message.senderId, signalConfig);
  if (!ingress.allowed) {
    await sendSignalMessage(signalCliPath, account, message.senderId, "Rate limit exceeded. Please wait before sending another message.");
    return;
  }

  const decision = checkDmPolicy(message.senderId, signalConfig, new Set(listPairedSenders("signal")));

  if (decision === "deny") {
    return;
  }

  if (decision === "pair") {
    if (message.text.toLowerCase().startsWith("/pair ")) {
      const code = message.text.slice(6).trim().toUpperCase();
      if (code === PAIRING_CODE) {
        pairSender("signal", message.senderId);
        await sendSignalMessage(signalCliPath, account, message.senderId, "Paired successfully. How can I help?");
      } else {
        await sendSignalMessage(signalCliPath, account, message.senderId, "Invalid pairing code.");
      }
    } else {
      await sendSignalMessage(signalCliPath, account, message.senderId, `This bot requires pairing. Send: /pair ${PAIRING_CODE}`);
    }
    return;
  }

  if (message.text === "/reset") {
    deleteChannelSession(`signal:${message.senderId}`);
    await sendSignalMessage(signalCliPath, account, message.senderId, "Session reset.");
    return;
  }

  const triggeredJob = await dispatchChannelTriggeredJob({ channel: "signal", senderId: message.senderId, text: message.text });
  if (triggeredJob.matched) {
    if (triggeredJob.responseText) {
      await sendSignalMessage(signalCliPath, account, message.senderId, triggeredJob.responseText);
    }
    return;
  }

  const sessionId = await getOrCreateChannelSession("signal", message.senderId);
  runChannelTurn(sessionId, message.text)
    .then((response) => sendSignalMessage(signalCliPath, account, message.senderId, response))
    .catch((err) => log.error({ err }, "Signal turn error"));
}

async function sendSignalMessage(signalCliPath: string, account: string, recipient: string, content: string): Promise<void> {
  const chunks = splitSignalMessage(content);

  for (const chunk of chunks) {
    const delivery = await deliverWithRetry(
      async () => {
        await signalCliExecutor(signalCliPath, ["-a", account, "send", "-m", chunk, recipient], HEALTHCHECK_TIMEOUT_MS);
      },
      chunk,
      { channel: "signal" },
    );

    if (!delivery.delivered) {
      throw new Error(delivery.error ?? "Signal delivery failed");
    }
  }
}

async function receiveSignalMessages(signalCliPath: string, account: string): Promise<SignalInboundMessage[]> {
  const { stdout } = await signalCliExecutor(
    signalCliPath,
    [
      "-a",
      account,
      "--output=json",
      "receive",
      "--timeout",
      String(RECEIVE_TIMEOUT_SECONDS),
      "--ignore-attachments",
      "--ignore-stories",
      "--ignore-avatars",
      "--ignore-stickers",
    ],
    RECEIVE_EXEC_TIMEOUT_MS,
  );

  return parseSignalReceiveOutput(stdout);
}

async function checkSignalAccount(signalCliPath: string, account: string): Promise<{ healthy: boolean; error?: string }> {
  try {
    const { stdout } = await signalCliExecutor(signalCliPath, ["--output=json", "listAccounts"], HEALTHCHECK_TIMEOUT_MS);
    const accounts = parseSignalAccountsOutput(stdout);
    if (!accounts.includes(account)) {
      return { healthy: false, error: `Signal account ${account} is not registered in signal-cli` };
    }
    return { healthy: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { healthy: false, error: message };
  }
}

function isReplay(message: SignalInboundMessage): boolean {
  const now = Date.now();
  for (const [id, ts] of _seenMessageIds) {
    if (now - ts > REPLAY_WINDOW_MS) {
      _seenMessageIds.delete(id);
    }
  }

  const replayKey = `${message.senderId}:${message.timestamp}:${message.text}`;
  if (_seenMessageIds.has(replayKey)) return true;
  _seenMessageIds.set(replayKey, now);
  return false;
}

function splitSignalMessage(content: string): string[] {
  if (!content) return [""];
  const chunks: string[] = [];
  for (let index = 0; index < content.length; index += 3000) {
    chunks.push(content.slice(index, index + 3000));
  }
  return chunks;
}

export function parseSignalAccountsOutput(stdout: string): string[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .flatMap((entry) => typeof entry?.["number"] === "string" ? [String(entry["number"])] : [])
      .filter(Boolean);
  } catch {
    return trimmed
      .split(/\r?\n/)
      .map((line) => line.replace(/^Number:\s*/, "").trim())
      .filter(Boolean);
  }
}

export function parseSignalReceiveOutput(stdout: string): SignalInboundMessage[] {
  const messages: SignalInboundMessage[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const envelope = asRecord(parsed["envelope"]);
    if (!envelope) continue;
    if (asRecord(envelope["syncMessage"])) continue;

    const dataMessage = asRecord(envelope["dataMessage"]);
    if (!dataMessage || asRecord(dataMessage["groupInfo"])) continue;

    const senderId = firstNonEmptyString(envelope["sourceNumber"], envelope["source"], envelope["sourceUuid"]);
    const text = typeof dataMessage["message"] === "string" ? dataMessage["message"].trim() : "";
    const timestamp = Number(envelope["timestamp"] ?? dataMessage["timestamp"] ?? Date.now());

    if (!senderId || !text) continue;

    messages.push({
      senderId,
      text,
      timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
    });
  }

  return messages;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}