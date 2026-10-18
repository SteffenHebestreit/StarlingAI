import { simpleParser } from "mailparser";
import type { AttachmentLike } from "mailparser";
import type { ParsedAttachment, ParsedMailMessage } from "./types.js";

export interface RawMailMessage {
  accountId: string;
  mailbox: string;
  uid: number;
  envelope?: {
    subject?: string | null;
    date?: Date | null;
    messageId?: string | null;
    from?: Array<{ name?: string | null; address?: string | null }>;
    to?: Array<{ name?: string | null; address?: string | null }>;
  };
  source: Buffer;
}

function formatAddressList(addresses?: Array<{ name?: string | null; address?: string | null }>): string {
  return (addresses ?? [])
    .map((address) => `${address.name ?? ""} <${address.address ?? ""}>`.trim())
    .filter((value) => value !== "<>")
    .join(", ");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export class EmailParser {
  static async parse(rawMessage: RawMailMessage): Promise<ParsedMailMessage> {
    const parsed = await simpleParser(rawMessage.source);
    const from = parsed.from?.text || formatAddressList(rawMessage.envelope?.from) || "Unknown";
    const to = parsed.to?.text || formatAddressList(rawMessage.envelope?.to) || "Unknown";
    const cc = parsed.cc?.text || "";
    const subject = parsed.subject || rawMessage.envelope?.subject || "(No Subject)";
    const date = parsed.date || rawMessage.envelope?.date || new Date();
    let html = typeof parsed.html === "string" ? parsed.html : "";
    const textBody = parsed.text || "";
    if (!html && textBody) {
      html = `<pre style="white-space: pre-wrap; word-wrap: break-word; font-family: inherit;">${escapeHtml(textBody)}</pre>`;
    }

    return {
      accountId: rawMessage.accountId,
      mailbox: rawMessage.mailbox,
      uid: rawMessage.uid,
      messageId: parsed.messageId || rawMessage.envelope?.messageId || "",
      // simpleParser already produces these; they were being dropped when the return
      // object was assembled. Without them the reply graph is unreachable, and the
      // only substitute — grouping by subject prefix — is a per-language heuristic
      // ("Re:" vs "AW:") that shatters threads in exactly the corpora that need them.
      inReplyTo: parsed.inReplyTo || "",
      references: Array.isArray(parsed.references)
        ? parsed.references
        : (typeof parsed.references === "string" && parsed.references
            ? parsed.references.split(/\s+/).filter(Boolean)
            : []),
      from,
      to,
      cc,
      subject,
      date: date instanceof Date ? date.toISOString() : String(date),
      html,
      textBody,
      attachments: (parsed.attachments ?? []).map(describeAttachment),
    };
  }

  /**
   * One attachment with its bytes, by the 1-based index `parse` lists it under. Both parse the
   * same source with the same parser, so the numbering a reader was shown is the numbering
   * this resolves. `found` is null when the message has no attachment at that position; `count`
   * says how many it has.
   */
  static async attachment(rawMessage: RawMailMessage, index: number): Promise<{ count: number; found: { attachment: ParsedAttachment; content: Buffer } | null }> {
    const parsed = await simpleParser(rawMessage.source);
    const attachments = parsed.attachments ?? [];
    const match = attachments[index - 1];
    if (!match) return { count: attachments.length, found: null };
    const content = match.content ?? Buffer.alloc(0);
    return { count: attachments.length, found: { attachment: { ...describeAttachment(match, index - 1), size: content.length }, content } };
  }
}

function describeAttachment(attachment: AttachmentLike, position: number): ParsedAttachment {
  return {
    index: position + 1,
    filename: attachment.filename || `attachment_${position + 1}`,
    contentType: attachment.contentType || "application/octet-stream",
    size: attachment.size || 0,
    embedded: attachment.related === true,
  };
}