/**
 * Test-environment mailbox for the scenario "mail" step, behind a small interface so the backend
 * can be swapped. The concrete backend is GreenMail (eval/e2e/ENVIRONMENT.md, docker-compose.e2e.yml):
 *
 *   REST (E2E_MAIL_API, default http://localhost:18080) — greenmail-openapi.yml:
 *     GET  /api/service/readiness                    → 200 when running
 *     GET  /api/configuration                        → {serverSetups: [{protocol, port, …}]}
 *     GET  /api/user/{emailOrLogin}/messages/INBOX   → [{uid, "Message-ID", subject, contentType, mimeMessage}]
 *                                                      (400 "User … not found" before any mail arrived)
 *     POST /api/mail/purge                           → {message: "Purged mails"} — every mailbox
 *   SMTP for delivery: GreenMail's REST API has no endpoint that stores a message, so `deliver`
 *   sends one through its SMTP server — E2E_MAIL_SMTP ("host:port"), default the API's host on
 *   13025, the host port the e2e environment publishes for the container's 3025.
 *
 *   E2E_MAIL_INBOX (default eval@e2e.test) is the test account's address: where `deliver` puts a
 *   message and what `expect` reads when its match names no recipient.
 */
import nodemailer from "nodemailer";
import { describeError, isRecord } from "./gateway-client.js";

export const DEFAULT_MAIL_API = "http://localhost:18080";
export const DEFAULT_MAIL_INBOX = "eval@e2e.test";
/** The host port docker-compose.e2e.yml maps to GreenMail's SMTP (3025 in the container). */
export const DEFAULT_MAIL_SMTP_PORT = 13025;

export interface OutgoingMail {
  to: string;
  from: string;
  subject: string;
  text: string;
}

export interface MailMessageSummary {
  id: string;
  /** The mailbox it was read from. */
  recipient: string;
  from: string;
  to: string;
  subject: string;
  /** Decoded text of the body (text/plain parts, else text/html without tags). */
  body: string;
}

export interface MailProbe {
  up: boolean;
  detail: string;
}

export interface MailAdapter {
  readonly name: string;
  /** The test account's address: the recipient of `deliver`, the default mailbox of `expect`. */
  readonly inbox: string;
  deliver(message: OutgoingMail): Promise<void>;
  list(recipient: string): Promise<MailMessageSummary[]>;
  /** Empties every mailbox. */
  clear(): Promise<void>;
  probe(): Promise<MailProbe>;
}

export interface SmtpTarget {
  host: string;
  port: number;
}

export type SmtpSender = (target: SmtpTarget, message: OutgoingMail) => Promise<void>;

export interface GreenMailOptions {
  apiBase?: string;
  inbox?: string;
  /** Explicit SMTP target; when absent, the API's host and the smtp port /api/configuration
   *  reports — right only where GreenMail's ports are published unchanged. */
  smtp?: SmtpTarget;
  /** Sends one message over SMTP (default: nodemailer). */
  send?: SmtpSender;
  timeoutMs?: number;
}

export function parseSmtpTarget(value: string, fallbackHost: string): SmtpTarget | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = /^(?:(.+):)?(\d{1,5})$/.exec(trimmed);
  if (!match) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { host: match[1]?.trim() || fallbackHost, port };
}

const sendWithNodemailer: SmtpSender = async (target, message) => {
  const transport = nodemailer.createTransport({
    host: target.host,
    port: target.port,
    secure: false,
    ignoreTLS: true,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });
  try {
    await transport.sendMail({ from: message.from, to: message.to, subject: message.subject, text: message.text });
  } finally {
    transport.close();
  }
};

export class GreenMailAdapter implements MailAdapter {
  readonly name = "greenmail";
  readonly inbox: string;
  private readonly apiBase: string;
  private readonly explicitSmtp: SmtpTarget | undefined;
  private readonly send: SmtpSender;
  private readonly timeoutMs: number;

  constructor(opts: GreenMailOptions = {}) {
    this.apiBase = (opts.apiBase ?? DEFAULT_MAIL_API).replace(/\/+$/, "");
    this.inbox = opts.inbox ?? DEFAULT_MAIL_INBOX;
    this.explicitSmtp = opts.smtp;
    this.send = opts.send ?? sendWithNodemailer;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  async probe(): Promise<MailProbe> {
    try {
      const response = await this.request("GET", "/api/service/readiness");
      return response.status === 200
        ? { up: true, detail: `GreenMail ready at ${this.apiBase}` }
        : { up: false, detail: `GreenMail at ${this.apiBase} not ready (HTTP ${response.status})` };
    } catch (err) {
      return { up: false, detail: `GreenMail API unreachable at ${this.apiBase} (${describeError(err)})` };
    }
  }

  async deliver(message: OutgoingMail): Promise<void> {
    const target = this.explicitSmtp ?? await this.smtpFromConfiguration();
    try {
      await this.send(target, message);
    } catch (err) {
      throw new Error(`SMTP delivery to ${target.host}:${target.port} failed: ${describeError(err)}`);
    }
  }

  async list(recipient: string): Promise<MailMessageSummary[]> {
    const response = await this.request("GET", `/api/user/${encodeURIComponent(recipient)}/messages/INBOX`);
    // GreenMail creates a mailbox on its first message; before that the user is unknown.
    if (response.status === 400 && /not found/i.test(response.text)) return [];
    if (response.status !== 200) throw new Error(`GreenMail: listing ${recipient} answered HTTP ${response.status}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.text);
    } catch {
      throw new Error(`GreenMail: listing ${recipient} answered non-JSON`);
    }
    if (!Array.isArray(parsed)) throw new Error(`GreenMail: listing ${recipient} answered ${typeof parsed}, expected an array`);
    return parsed.filter(isRecord).map((entry, index) => {
      const mime = parseMimeMessage(typeof entry["mimeMessage"] === "string" ? entry["mimeMessage"] : "");
      const subject = typeof entry["subject"] === "string" ? entry["subject"] : mime.headers["subject"] ?? "";
      return {
        id: typeof entry["uid"] === "string" || typeof entry["uid"] === "number" ? String(entry["uid"]) : String(index),
        recipient,
        from: mime.headers["from"] ?? "",
        to: mime.headers["to"] ?? "",
        subject,
        body: mime.text,
      };
    });
  }

  async clear(): Promise<void> {
    const response = await this.request("POST", "/api/mail/purge");
    // A failed purge still answers 200, with a message that says so.
    if (response.status !== 200 || !/purged/i.test(response.text)) {
      throw new Error(`GreenMail purge failed: HTTP ${response.status} ${response.text.slice(0, 200)}`);
    }
  }

  private async smtpFromConfiguration(): Promise<SmtpTarget> {
    const host = new URL(this.apiBase).hostname;
    const response = await this.request("GET", "/api/configuration");
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.text);
    } catch {
      parsed = undefined;
    }
    const setups = isRecord(parsed) && Array.isArray(parsed["serverSetups"]) ? parsed["serverSetups"] : [];
    const smtp = setups.find((setup): setup is Record<string, unknown> => isRecord(setup) && setup["protocol"] === "smtp");
    const port = smtp && typeof smtp["port"] === "number" ? smtp["port"] : undefined;
    if (!port) throw new Error(`GreenMail at ${this.apiBase} reports no smtp server; set E2E_MAIL_SMTP=host:port`);
    return { host, port };
  }

  private async request(method: "GET" | "POST", path: string): Promise<{ status: number; text: string }> {
    const response = await fetch(`${this.apiBase}${path}`, { method, signal: AbortSignal.timeout(this.timeoutMs) });
    return { status: response.status, text: await response.text().catch(() => "") };
  }
}

export function mailAdapterFromEnv(env: NodeJS.ProcessEnv = process.env): MailAdapter {
  const apiBase = (env["E2E_MAIL_API"]?.trim() || DEFAULT_MAIL_API).replace(/\/+$/, "");
  const inbox = env["E2E_MAIL_INBOX"]?.trim() || DEFAULT_MAIL_INBOX;
  let host = "localhost";
  try {
    host = new URL(apiBase).hostname;
  } catch { /* the adapter reports the bad URL on use */ }
  const smtp = parseSmtpTarget(env["E2E_MAIL_SMTP"] ?? "", host) ?? { host, port: DEFAULT_MAIL_SMTP_PORT };
  return new GreenMailAdapter({ apiBase, inbox, smtp });
}

// ── MIME (just enough to read a test message's headers and text) ────────────

export interface ParsedMime {
  /** Lower-cased header names; encoded words decoded. */
  headers: Record<string, string>;
  text: string;
}

function decodeBytes(bytes: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}

function decodeQuotedPrintable(input: string): Buffer {
  const softBreaksRemoved = input.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < softBreaksRemoved.length; i += 1) {
    const char = softBreaksRemoved[i]!;
    const hex = softBreaksRemoved.slice(i + 1, i + 3);
    if (char === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      for (const byte of Buffer.from(char, "utf8")) bytes.push(byte);
    }
  }
  return Buffer.from(bytes);
}

/** RFC 2047 encoded words: =?utf-8?B?…?= and =?utf-8?Q?…?=. */
export function decodeEncodedWords(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_whole, charset: string, encoding: string, payload: string) => {
      const bytes = encoding.toUpperCase() === "B"
        ? Buffer.from(payload, "base64")
        : decodeQuotedPrintable(payload.replace(/_/g, " "));
      return decodeBytes(bytes, charset.toLowerCase());
    });
}

function parseContentType(value: string | undefined): { type: string; params: Record<string, string> } {
  const [typePart, ...paramParts] = (value ?? "text/plain").split(";");
  const params: Record<string, string> = {};
  for (const part of paramParts) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    params[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim().replace(/^"(.*)"$/, "$1");
  }
  return { type: (typePart ?? "text/plain").trim().toLowerCase(), params };
}

export function parseMimeMessage(raw: string): ParsedMime {
  const normalized = raw.replace(/\r\n/g, "\n");
  const split = normalized.indexOf("\n\n");
  const headerBlock = split === -1 ? normalized : normalized.slice(0, split);
  const body = split === -1 ? "" : normalized.slice(split + 2);
  const headers: Record<string, string> = {};
  let lastKey: string | null = null;
  for (const line of headerBlock.split("\n")) {
    if (/^[ \t]/.test(line) && lastKey) {
      headers[lastKey] = `${headers[lastKey]} ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    lastKey = line.slice(0, colon).trim().toLowerCase();
    headers[lastKey] = line.slice(colon + 1).trim();
  }
  for (const key of Object.keys(headers)) headers[key] = decodeEncodedWords(headers[key]!);

  const contentType = parseContentType(headers["content-type"]);
  if (contentType.type.startsWith("multipart/") && contentType.params["boundary"]) {
    const boundary = `--${contentType.params["boundary"]}`;
    const parts = body.split(boundary).slice(1);
    const plain: string[] = [];
    const html: string[] = [];
    for (const part of parts) {
      if (part.startsWith("--")) break;
      const parsed = parseMimeMessage(part.replace(/^\n/, ""));
      const partType = parseContentType(parsed.headers["content-type"]).type;
      // Attachments (application/*, image/*, …) are not the message's text.
      if (partType === "text/html") html.push(parsed.text);
      else if ((partType.startsWith("text/") || partType.startsWith("multipart/")) && parsed.text) plain.push(parsed.text);
    }
    return { headers, text: (plain.length > 0 ? plain : html).join("\n").trim() };
  }

  const encoding = (headers["content-transfer-encoding"] ?? "").toLowerCase();
  const charset = (contentType.params["charset"] ?? "utf-8").toLowerCase();
  const bytes = encoding === "base64"
    ? Buffer.from(body.replace(/\s+/g, ""), "base64")
    : encoding === "quoted-printable"
      ? decodeQuotedPrintable(body)
      : Buffer.from(body, "utf8");
  let text = decodeBytes(bytes, charset);
  if (contentType.type === "text/html") text = text.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
  return { headers, text: text.trim() };
}
