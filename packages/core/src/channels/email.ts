/**
 * Email channel adapter — IMAP polling + SMTP send.
 *
 * Requires optional peer dependencies:
 *   pnpm add imapflow nodemailer
 *
 * If those packages are not installed the channel logs a clear
 * installation hint and exits gracefully without crashing the gateway.
 *
 * Setup in starlingai.json:
 *   "channels": {
 *     "email": {
 *       "enabled": true,
 *       "imapHost": "imap.example.com",
 *       "imapPort": 993,
 *       "imapUser": "$EMAIL_USER",
 *       "imapPassword": "$EMAIL_PASSWORD",
 *       "smtpHost": "smtp.example.com",
 *       "smtpPort": 587,
 *       "smtpUser": "$EMAIL_USER",
 *       "smtpPassword": "$EMAIL_PASSWORD",
 *       "smtpFrom": "bot@example.com",
 *       "pollIntervalMs": 30000
 *     }
 *   }
 */
import { getConfig } from "../config/loader.js";
import { getEffectiveChannelConfig } from "../credentials/channels.js";
import { resolveToken, getOrCreateChannelSession, runChannelTurn } from "./base.js";
import { dispatchChannelTriggeredJob } from "./job-triggers.js";
import { setChannelStopped, setChannelError, setChannelHealthCheck, setChannelRunning } from "./registry.js";
import { childLogger } from "../logger.js";
import { deliverWithRetry } from "./delivery.js";

const log = childLogger("channel:email");
const INSTALL_HINT = "Email channel requires: pnpm add imapflow nodemailer";

// Module-level ref for outbound email — set when channel starts, cleared on stop
let _sendMail: ((to: string, subject: string, text: string) => Promise<void>) | null = null;

export type EmailStopFn = () => Promise<void>;

export async function startEmailChannel(): Promise<EmailStopFn | null> {
  const config = getConfig();
  const emailConfig = getEffectiveChannelConfig("email", config.channels.email);

  if (!emailConfig.enabled) return null;

  const imapHost = resolveToken(emailConfig.imapHost);
  const imapUser = resolveToken(emailConfig.imapUser);
  const imapPassword = resolveToken(emailConfig.imapPassword);
  const smtpHost = resolveToken(emailConfig.smtpHost);
  const smtpUser = resolveToken(emailConfig.smtpUser);
  const smtpPassword = resolveToken(emailConfig.smtpPassword);
  const smtpFrom = emailConfig.smtpFrom ?? imapUser;
  const smtpPort = emailConfig.smtpPort ?? 587;
  const imapPort = emailConfig.imapPort ?? 993;
  const pollIntervalMs = emailConfig.pollIntervalMs ?? 30_000;

  if (!imapHost || !imapUser || !imapPassword || !smtpHost || !smtpUser || !smtpPassword) {
    setChannelError("email", "Email channel enabled but IMAP/SMTP credentials are incomplete");
    return null;
  }

  // Dynamic imports — degrade gracefully if packages are not installed
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ImapFlowCtor: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let nodemailer: any;

  try {
    ImapFlowCtor = (await import("imapflow" as string)).ImapFlow;
  } catch {
    const msg = `${INSTALL_HINT} — imapflow not found`;
    log.error(msg);
    setChannelError("email", msg);
    return null;
  }

  try {
    nodemailer = await import("nodemailer" as string);
  } catch {
    const msg = `${INSTALL_HINT} — nodemailer not found`;
    log.error(msg);
    setChannelError("email", msg);
    return null;
  }

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: { user: smtpUser, pass: smtpPassword },
  });

  async function sendReply(to: string, subject: string, text: string): Promise<void> {
    await deliverWithRetry(
      () => transporter.sendMail({
        from: smtpFrom,
        to,
        subject: subject.startsWith("Re:") ? subject : `Re: ${subject}`,
        text,
      }).then(() => undefined),
      text,
      { channel: "email" },
    );
  }

  // Expose outbound email at module level for tool use
  _sendMail = async (to: string, subject: string, text: string) => {
    await deliverWithRetry(
      () => transporter.sendMail({ from: smtpFrom, to, subject, text }).then(() => undefined),
      text,
      { channel: "email" },
    );
  };

  async function pollOnce(): Promise<void> {
    const client = new ImapFlowCtor({
      host: imapHost,
      port: imapPort,
      secure: imapPort === 993,
      auth: { user: imapUser, pass: imapPassword },
      logger: false,
    });

    try {
      await client.connect();
      const lock = await client.getMailboxLock("INBOX");
      try {
        for await (const message of client.fetch("1:*", { envelope: true, source: true }) as AsyncIterable<Record<string, unknown>>) {
          const flags = new Set(message["flags"] as string[] ?? []);
          if (flags.has("\\Seen")) continue;

          const envelope = message["envelope"] as Record<string, unknown> | undefined;
          const fromArr = envelope?.["from"] as Array<{ address?: string }> | undefined;
          const from = fromArr?.[0]?.address ?? "";
          const subject = String(envelope?.["subject"] ?? "(no subject)");
          const rawSource = message["source"] as Buffer;
          const textBody = extractTextBody(rawSource.toString("utf-8"));

          if (!from || !textBody.trim()) continue;

          const sessionId = getOrCreateChannelSession("email", from);
          log.info({ from, subject }, "Email received");

          try {
            const triggeredJob = await dispatchChannelTriggeredJob({ channel: "email", senderId: from, text: textBody.trim() });
            if (triggeredJob.matched) {
              if (triggeredJob.responseText) {
                await sendReply(from, subject, triggeredJob.responseText);
              }
              await client.messageFlagsAdd({ uid: message["uid"] as number }, ["\\Seen"], { uid: true });
              continue;
            }

            const response = await runChannelTurn(sessionId, `Subject: ${subject}\n\n${textBody}`);
            await sendReply(from, subject, response);
          } catch (err) {
            log.error({ err, from }, "Email turn failed");
          }

          await client.messageFlagsAdd({ uid: message["uid"] as number }, ["\\Seen"], { uid: true });
        }
      } finally {
        lock.release();
      }
      await client.logout();
    } catch (err) {
      log.warn({ err }, "IMAP poll error");
    }
  }

  let stopped = false;
  let pollHandle: ReturnType<typeof setTimeout> | null = null;

  async function schedulePoll(): Promise<void> {
    if (stopped) return;
    try { await pollOnce(); } catch { /* logged inside pollOnce */ }
    if (!stopped) pollHandle = setTimeout(() => void schedulePoll(), pollIntervalMs);
  }

  void schedulePoll();

  setChannelHealthCheck("email", async () => {
    const client = new ImapFlowCtor({
      host: imapHost, port: imapPort,
      secure: imapPort === 993,
      auth: { user: imapUser, pass: imapPassword },
      logger: false,
    });
    try {
      await Promise.race([
        client.connect().then(() => client.logout()),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("IMAP connect timeout")), 8000)
        ),
      ]);
      return { healthy: true };
    } catch (err) {
      return { healthy: false, error: String(err) };
    }
  });

  log.info({ imapHost, pollIntervalMs }, "Email channel started");

  const stop: EmailStopFn = async () => {
    stopped = true;
    if (pollHandle) clearTimeout(pollHandle);
    _sendMail = null;
    setChannelStopped("email");
  };

  setChannelRunning("email", stop);
  return stop;
}

/**
 * Send an email using the running email channel's SMTP transporter.
 * Callable from tools — requires the email channel to be started.
 */
export async function sendEmailMessage(
  to: string,
  subject: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!_sendMail) return { ok: false, error: "Email channel not running or not configured" };
  try {
    await _sendMail(to, subject, text);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Extract plain-text body from raw RFC 2822 email */
function extractTextBody(raw: string): string {
  const boundaryMatch = raw.match(/boundary="?([^"\r\n;]+)"?/i);
  if (boundaryMatch) {
    const boundary = boundaryMatch[1]!;
    const parts = raw.split(`--${boundary}`);
    for (const part of parts) {
      if (/content-type:\s*text\/plain/i.test(part)) {
        const bodyStart = part.indexOf("\r\n\r\n");
        if (bodyStart >= 0) return part.slice(bodyStart + 4).replace(/=\r\n/g, "").trim();
      }
    }
  }
  const bodyStart = raw.indexOf("\r\n\r\n");
  if (bodyStart >= 0) return raw.slice(bodyStart + 4).trim();
  return raw.trim();
}
