import { ImapFlow } from "imapflow";
import { GmailQueryParser } from "./query-parser.js";
import { log } from "./logger.js";
import type { MailAccountConfig } from "./types.js";
import type { RawMailMessage } from "./email-parser.js";

/**
 * Largest result set we will envelope-scan to order by date before picking the
 * newest N. Measured ~0.24 ms/message against a live Strato mailbox, so this cap
 * bounds the pre-pass at roughly 2-3 s — comfortably inside the 20 s tool timeout
 * even on a slow link. Past it we fall back to UID order and log that we did.
 */
const PREPASS_MAX_UIDS = 10_000;

interface MailboxInfo {
  path: string;
  name: string;
  specialUse: string | null;
  delimiter: string;
}

/** Lightweight search result built from envelope + bodyStructure, NOT full RFC822. */
export interface MailSearchSummary {
  accountId: string;
  mailbox: string;
  uid: number;
  messageId: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  attachmentCount: number;
  textPreview: string;
}

interface BodyNode {
  part?: string;
  type?: string;
  encoding?: string;
  disposition?: string;
  dispositionParameters?: Record<string, string> | null;
  parameters?: Record<string, string> | null;
  childNodes?: BodyNode[];
}

type EnvelopeAddress = { name?: string | null; address?: string | null };

/** Format envelope addresses to match the existing display form: `"Name" <addr>`
 *  (RFC-quoted display name), or just the bare address when there is no real name. */
function formatEnvelopeAddresses(addresses?: EnvelopeAddress[] | null): string {
  return (addresses ?? [])
    .map((a) => {
      const name = (a.name ?? "").trim();
      const addr = (a.address ?? "").trim();
      if (!addr) return "";
      return name && name !== addr ? `"${name}" <${addr}>` : addr;
    })
    .filter(Boolean)
    .join(", ");
}

/** Walk leaf parts of a bodyStructure tree (no childNodes). */
function bodyLeaves(node?: BodyNode | null): BodyNode[] {
  if (!node) return [];
  if (Array.isArray(node.childNodes) && node.childNodes.length > 0) {
    return node.childNodes.flatMap(bodyLeaves);
  }
  return [node];
}

/** First text/plain leaf, falling back to the first text/html leaf, for the preview. */
function firstTextLeaf(node?: BodyNode | null): BodyNode | null {
  const leaves = bodyLeaves(node);
  return (
    leaves.find((l) => (l.type ?? "").toLowerCase() === "text/plain") ??
    leaves.find((l) => (l.type ?? "").toLowerCase() === "text/html") ??
    null
  );
}

/**
 * Count attachments the way simpleParser did (verified against the live inbox):
 * any leaf with disposition=attachment OR a filename, plus every non-text /
 * non-multipart leaf (catches inline signature images AND a disposition=attachment
 * .ics, while excluding the text body parts).
 */
function countAttachmentLeaves(node?: BodyNode | null): number {
  let n = 0;
  for (const leaf of bodyLeaves(node)) {
    const type = (leaf.type ?? "").toLowerCase();
    if (type.startsWith("multipart/")) continue;
    const hasFilename = Boolean(leaf.dispositionParameters?.["filename"] ?? leaf.parameters?.["name"]);
    if ((leaf.disposition ?? "").toLowerCase() === "attachment" || hasFilename) { n += 1; continue; }
    if (type.startsWith("text/")) continue; // body part, not an attachment
    n += 1; // image/pdf/application/etc — incl. inline images
  }
  return n;
}

/** Map a MIME charset label to a Node Buffer encoding, defaulting to utf8. */
function normalizeCharset(cs?: string): BufferEncoding {
  const c = (cs ?? "").toLowerCase().replace(/[^a-z0-9]/g, ""); // "utf-8" → "utf8"
  if (c === "utf8" || c === "") return "utf8";
  if (c === "usascii" || c === "ascii") return "ascii";
  if (c === "latin1" || c === "iso88591" || c === "88591") return "latin1";
  if (c === "utf16le" || c === "ucs2" || c === "utf16") return "utf16le";
  return "utf8"; // unknown label (windows-1252, iso-8859-15, …): best-effort, no extra dep
}

/** Transfer-decode a fetched body part to text (base64 / quoted-printable / raw), applying the part charset. */
function decodeBodyPart(buf: Buffer, encoding?: string, charset?: string): string {
  const enc = (encoding ?? "").toLowerCase();
  const cs = normalizeCharset(charset);
  if (enc === "base64") return Buffer.from(buf.toString("ascii"), "base64").toString(cs);
  if (enc === "quoted-printable") {
    // Read as latin1 so every raw octet maps 1:1, strip soft line breaks, rebuild the
    // raw byte stream, then decode with the real charset. Decoding as utf8 up front
    // (the old path) mojibaked every multi-byte char (e.g. "caf=C3=A9" → garbage).
    const s = buf.toString("latin1").replace(/=\r?\n/g, "");
    const bytes: number[] = [];
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(s.substr(i + 1, 2))) {
        bytes.push(parseInt(s.substr(i + 1, 2), 16));
        i += 2;
      } else {
        bytes.push(s.charCodeAt(i) & 0xff);
      }
    }
    return Buffer.from(bytes).toString(cs);
  }
  return buf.toString(cs);
}

/** Strip tags from an html-only preview so it reads as prose. */
function previewText(raw: string, isHtml: boolean): string {
  const text = isHtml ? raw.replace(/<[^>]+>/g, " ") : raw;
  return text.replace(/\s+/g, " ").trim().slice(0, 240);
}

interface MoveResult {
  destination: string;
}

interface DeleteResult {
  deleted: boolean;
  movedToTrash: boolean;
  destination?: string;
}

interface MailboxDeleteResult {
  deleted: boolean;
  path: string;
}

export class MailAccountClient {
  private client: ImapFlow | null = null;
  private mailboxList: Array<{ path: string; name: string; specialUse?: string | null; delimiter: string }> = [];

  constructor(private readonly account: MailAccountConfig) {}

  async listMailboxes(): Promise<MailboxInfo[]> {
    await this.connect();
    try {
      return this.mailboxList.map((mailbox) => ({
        path: mailbox.path,
        name: mailbox.name,
        specialUse: mailbox.specialUse ?? null,
        delimiter: mailbox.delimiter,
      }));
    } finally {
      await this.disconnect();
    }
  }

  async search(query: string, mailboxes: string[] = ["INBOX"], limit = 50): Promise<RawMailMessage[]> {
    await this.connect();
    try {
      const { imapQueries, mailboxHints } = GmailQueryParser.parse(query);
      const resolvedHints = this.resolveMailboxHints(mailboxHints);
      const allMailboxes = [...new Set([...mailboxes, ...resolvedHints])];
      const results: RawMailMessage[] = [];
      const seen = new Set<string>();

      for (const imapQuery of imapQueries) {
        for (const mailbox of allMailboxes) {
          const messages = await this.fetchFromMailbox(mailbox, imapQuery, limit);
          for (const message of messages) {
            const dedupeKey = message.envelope?.messageId || `${message.mailbox}:${message.uid}`;
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);
            results.push(message);
          }
        }
      }

      results.sort((left, right) => {
        const leftDate = left.envelope?.date ? new Date(left.envelope.date).getTime() : 0;
        const rightDate = right.envelope?.date ? new Date(right.envelope.date).getTime() : 0;
        return rightDate - leftDate;
      });

      return results.slice(0, limit);
    } finally {
      await this.disconnect();
    }
  }

  /**
   * Lightweight search for listings: fetch envelope + bodyStructure (+ only the
   * first text part for a preview) instead of the full RFC822 source. A real
   * inbox message can be MULTIPLE MEGABYTES of inline images/attachments; the
   * previous path downloaded all of it just to keep envelope fields + a 240-char
   * preview, which timed out the tool on heavy threads. envelope/bodyStructure are
   * tiny, and the text body is tens of KB at most.
   */
  async searchSummaries(query: string, mailboxes: string[] = ["INBOX"], limit = 50): Promise<MailSearchSummary[]> {
    await this.connect();
    try {
      const { imapQueries, mailboxHints } = GmailQueryParser.parse(query);
      const resolvedHints = this.resolveMailboxHints(mailboxHints);
      const allMailboxes = [...new Set([...mailboxes, ...resolvedHints])];
      const results: MailSearchSummary[] = [];
      const seen = new Set<string>();
      for (const imapQuery of imapQueries) {
        for (const mailbox of allMailboxes) {
          for (const summary of await this.fetchSummariesFromMailbox(mailbox, imapQuery, limit)) {
            const dedupeKey = summary.messageId || `${summary.mailbox}:${summary.uid}`;
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);
            results.push(summary);
          }
        }
      }
      results.sort((left, right) => new Date(right.date).getTime() - new Date(left.date).getTime());
      return results.slice(0, limit);
    } finally {
      await this.disconnect();
    }
  }

  /**
   * Pick the `limit` genuinely newest UIDs.
   *
   * Tail-slicing the UID list assumes UID order == date order, which is only true
   * while messages arrive and are never moved: a bulk move assigns NEW (high) UIDs
   * to OLD messages, so in Archive/All-Mail the tail can be the oldest mail in the
   * box. Measured on a real 544-message Strato INBOX, UID order already did NOT
   * match date order.
   *
   * So when the result set is larger than the limit we do an envelope-only pre-pass
   * and sort by the actual date. Envelopes are cheap — ~0.24 ms/message measured
   * (544 messages in 132 ms), versus the full-source fetch this is selecting for.
   * Above PREPASS_MAX_UIDS the pre-pass itself would start to matter against the
   * 20 s tool timeout, so we keep the old heuristic there and say so in the log.
   */
  private async selectNewestUids(uids: number[], limit: number): Promise<number[]> {
    if (uids.length <= limit) return uids;
    if (uids.length > PREPASS_MAX_UIDS) {
      log.warn(
        { candidates: uids.length, limit, cap: PREPASS_MAX_UIDS },
        "result set too large for a date-ordered pre-pass — falling back to UID order, which is wrong for mailboxes that received bulk moves",
      );
      return uids.slice(-limit);
    }

    const dated: Array<{ uid: number; time: number }> = [];
    for await (const message of this.client!.fetch(uids, { uid: true, envelope: true }, { uid: true })) {
      const raw = (message.envelope as { date?: unknown } | undefined)?.date;
      const time = raw ? new Date(raw as string).getTime() : Number.NaN;
      // A missing/unparsable Date header sorts oldest rather than winning the
      // window on a NaN comparison.
      dated.push({ uid: message.uid, time: Number.isFinite(time) ? time : 0 });
    }
    if (dated.length === 0) return uids.slice(-limit);

    dated.sort((a, b) => a.time - b.time);
    // Back to ascending UID order: callers and IMAP FETCH both expect that.
    return dated.slice(-limit).map((d) => d.uid).sort((a, b) => a - b);
  }

  private async fetchSummariesFromMailbox(mailbox: string, imapQuery: Record<string, unknown>, limit = 50): Promise<MailSearchSummary[]> {
    const lock = await this.client!.getMailboxLock(mailbox);
    try {
      const uids = await this.client!.search(imapQuery, { uid: true });
      if (!uids || uids.length === 0) return [];
      const recentUids = await this.selectNewestUids(uids, limit);

      // Pass 1 — envelope + bodyStructure only (no source): from/to/cc/subject/date,
      // attachment count, and which part holds the text body.
      interface Meta { uid: number; envelope: Record<string, unknown> | undefined; attachmentCount: number; textPart?: string; textEncoding?: string; textCharset?: string; textIsHtml: boolean }
      const metas: Meta[] = [];
      for await (const message of this.client!.fetch(recentUids, { uid: true, envelope: true, bodyStructure: true }, { uid: true })) {
        const leaf = firstTextLeaf(message.bodyStructure as unknown as BodyNode);
        metas.push({
          uid: message.uid,
          envelope: message.envelope as unknown as Record<string, unknown> | undefined,
          attachmentCount: countAttachmentLeaves(message.bodyStructure as unknown as BodyNode),
          textPart: leaf?.part,
          textEncoding: leaf?.encoding,
          textCharset: leaf?.parameters?.["charset"] ?? undefined,
          textIsHtml: (leaf?.type ?? "").toLowerCase() === "text/html",
        });
      }

      // Pass 2 — fetch ONLY the (small) text parts for previews, in one batched
      // fetch over the union of distinct part ids. Skips every attachment.
      const distinctParts = [...new Set(metas.map((m) => m.textPart).filter((p): p is string => Boolean(p)))];
      const previewByUid = new Map<number, string>();
      if (distinctParts.length > 0) {
        for await (const message of this.client!.fetch(recentUids, { uid: true, bodyParts: distinctParts }, { uid: true })) {
          const meta = metas.find((m) => m.uid === message.uid);
          if (!meta?.textPart) continue;
          const buf = message.bodyParts?.get(meta.textPart);
          if (buf) previewByUid.set(message.uid, previewText(decodeBodyPart(buf, meta.textEncoding, meta.textCharset), meta.textIsHtml));
        }
      }

      return metas.map((meta): MailSearchSummary => {
        const env = (meta.envelope ?? {}) as { subject?: string | null; date?: unknown; messageId?: string | null; from?: EnvelopeAddress[] | null; to?: EnvelopeAddress[] | null; cc?: EnvelopeAddress[] | null };
        const date = env.date ? new Date(env.date as string) : new Date();
        return {
          accountId: this.account.id,
          mailbox,
          uid: meta.uid,
          messageId: env.messageId ?? "",
          from: formatEnvelopeAddresses(env.from) || "Unknown",
          to: formatEnvelopeAddresses(env.to) || "Unknown",
          cc: formatEnvelopeAddresses(env.cc),
          subject: env.subject ?? "(No Subject)",
          date: Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString(),
          attachmentCount: meta.attachmentCount,
          textPreview: previewByUid.get(meta.uid) ?? "",
        };
      });
    } finally {
      lock.release();
    }
  }

  async readMessage(mailbox: string, uid: number): Promise<RawMailMessage | null> {
    await this.connect();
    try {
      const lock = await this.client!.getMailboxLock(mailbox);
      try {
        for await (const message of this.client!.fetch(String(uid), { uid: true, envelope: true, source: true }, { uid: true })) {
          return {
            accountId: this.account.id,
            mailbox,
            uid: message.uid,
            envelope: message.envelope
              ? {
                  subject: message.envelope.subject ?? undefined,
                  date: message.envelope.date ?? undefined,
                  messageId: message.envelope.messageId ?? undefined,
                  from: message.envelope.from?.map((entry) => ({ name: entry.name ?? undefined, address: entry.address ?? undefined })),
                  to: message.envelope.to?.map((entry) => ({ name: entry.name ?? undefined, address: entry.address ?? undefined })),
                }
              : undefined,
            source: message.source as Buffer,
          };
        }
        return null;
      } finally {
        lock.release();
      }
    } finally {
      await this.disconnect();
    }
  }

  async createMailbox(path: string): Promise<MailboxInfo> {
    await this.connect();
    try {
      const existing = this.findMailbox(path);
      if (existing) {
        return {
          path: existing.path,
          name: existing.name,
          specialUse: existing.specialUse ?? null,
          delimiter: existing.delimiter,
        };
      }

      const created = await this.client!.mailboxCreate(path);
      this.mailboxList = await this.client!.list();
      const mailbox = this.findMailbox(created.path) ?? this.findMailbox(path);
      return {
        path: mailbox?.path ?? created.path,
        name: mailbox?.name ?? created.path.split(mailbox?.delimiter ?? "/").pop() ?? created.path,
        specialUse: mailbox?.specialUse ?? null,
        delimiter: mailbox?.delimiter ?? "/",
      };
    } finally {
      await this.disconnect();
    }
  }

  async deleteMailbox(path: string): Promise<MailboxDeleteResult> {
    await this.connect();
    try {
      const deleted = await this.client!.mailboxDelete(path);
      return {
        deleted: true,
        path: deleted.path,
      };
    } finally {
      await this.disconnect();
    }
  }

  async moveMessage(mailbox: string, uid: number, destinationMailbox: string): Promise<MoveResult> {
    await this.connect();
    try {
      const lock = await this.client!.getMailboxLock(mailbox);
      try {
        const result = await this.client!.messageMove([uid], destinationMailbox, { uid: true });
        return { destination: result && typeof result === "object" && "path" in result ? String(result.path) : destinationMailbox };
      } finally {
        lock.release();
      }
    } finally {
      await this.disconnect();
    }
  }

  async deleteMessage(mailbox: string, uid: number, permanent = false): Promise<DeleteResult> {
    await this.connect();
    try {
      const lock = await this.client!.getMailboxLock(mailbox);
      try {
        const trashMailbox = permanent ? null : this.findMailboxByRole("trash");
        if (trashMailbox && trashMailbox !== mailbox) {
          const result = await this.client!.messageMove([uid], trashMailbox, { uid: true });
          return {
            deleted: true,
            movedToTrash: true,
            destination: result && typeof result === "object" && "path" in result ? String(result.path) : trashMailbox,
          };
        }

        await this.client!.messageDelete([uid], { uid: true });
        return { deleted: true, movedToTrash: false };
      } finally {
        lock.release();
      }
    } finally {
      await this.disconnect();
    }
  }

  private async connect(): Promise<void> {
    if (this.client) return;
    this.client = new ImapFlow({
      host: this.account.imap.host,
      port: this.account.imap.port,
      secure: this.account.imap.secure,
      auth: {
        user: this.account.imap.user,
        pass: this.account.imap.pass,
      },
      logger: false,
    });
    await this.client.connect();
    this.mailboxList = await this.client.list();
  }

  private async disconnect(): Promise<void> {
    if (!this.client) return;
    await this.client.logout().catch(() => undefined);
    this.client = null;
    this.mailboxList = [];
  }

  private resolveMailboxHints(hints: string[]): string[] {
    return hints
      .map((hint) => this.findMailboxByRole(hint) ?? hint)
      .filter((value, index, array) => array.indexOf(value) === index);
  }

  private findMailbox(path: string): { path: string; name: string; specialUse?: string | null; delimiter: string } | null {
    const normalized = path.toLowerCase();
    return this.mailboxList.find((entry) => entry.path.toLowerCase() === normalized || entry.name.toLowerCase() === normalized) ?? null;
  }

  private findMailboxByRole(role: string): string | null {
    const specialUseMap: Record<string, string> = {
      sent: "\\Sent",
      drafts: "\\Drafts",
      trash: "\\Trash",
      junk: "\\Junk",
      archive: "\\Archive",
      all: "\\All",
    };
    const specialUse = specialUseMap[role.toLowerCase()];
    if (specialUse) {
      const mailbox = this.mailboxList.find((entry) => entry.specialUse === specialUse);
      if (mailbox) return mailbox.path;
    }

    const variants: Record<string, string[]> = {
      sent: ["sent", "sent items", "sent messages", "sent mail", "gesendet", "gesendete objekte", "gesendete elemente"],
      drafts: ["drafts", "draft", "entwürfe"],
      trash: ["trash", "deleted", "deleted items", "papierkorb"],
      junk: ["junk", "spam", "junk-e-mail"],
      archive: ["archive", "archiv"],
      inbox: ["inbox"],
    };
    const candidates = variants[role.toLowerCase()] ?? [role.toLowerCase()];
    for (const candidate of candidates) {
      const mailbox = this.mailboxList.find((entry) => entry.name.toLowerCase() === candidate || entry.path.toLowerCase() === candidate);
      if (mailbox) return mailbox.path;
    }
    return null;
  }

  private async fetchFromMailbox(mailbox: string, imapQuery: Record<string, unknown>, limit = 50): Promise<RawMailMessage[]> {
    const lock = await this.client!.getMailboxLock(mailbox);
    try {
      const uids = await this.client!.search(imapQuery, { uid: true });
      if (!uids || uids.length === 0) return [];
      // Only fetch the most recent `limit` messages. Without this cap a broad
      // query (e.g. an empty "ALL" search) fetched the FULL raw source of EVERY
      // message in the mailbox, hanging past the 20s tool timeout on a real inbox
      // (session d251793b: mail_search aborted twice while mail_list_unread —
      // which matches few messages — stayed fast). Which messages are "newest" is
      // decided by date, not UID tail — see selectNewestUids.
      const recentUids = await this.selectNewestUids(uids, limit);
      const messages: RawMailMessage[] = [];
      for await (const message of this.client!.fetch(recentUids, { uid: true, envelope: true, source: true }, { uid: true })) {
        messages.push({
          accountId: this.account.id,
          mailbox,
          uid: message.uid,
          envelope: message.envelope
            ? {
                subject: message.envelope.subject ?? undefined,
                date: message.envelope.date ?? undefined,
                messageId: message.envelope.messageId ?? undefined,
                from: message.envelope.from?.map((entry) => ({ name: entry.name ?? undefined, address: entry.address ?? undefined })),
                to: message.envelope.to?.map((entry) => ({ name: entry.name ?? undefined, address: entry.address ?? undefined })),
              }
            : undefined,
          source: message.source as Buffer,
        });
      }
      return messages;
    } finally {
      lock.release();
    }
  }
}