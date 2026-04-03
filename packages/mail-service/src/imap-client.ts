import { ImapFlow } from "imapflow";
import { GmailQueryParser } from "./query-parser.js";
import type { MailAccountConfig } from "./types.js";
import type { RawMailMessage } from "./email-parser.js";

interface MailboxInfo {
  path: string;
  name: string;
  specialUse: string | null;
  delimiter: string;
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
          const messages = await this.fetchFromMailbox(mailbox, imapQuery);
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

  private async fetchFromMailbox(mailbox: string, imapQuery: Record<string, unknown>): Promise<RawMailMessage[]> {
    const lock = await this.client!.getMailboxLock(mailbox);
    try {
      const uids = await this.client!.search(imapQuery, { uid: true });
      if (!uids || uids.length === 0) return [];
      const messages: RawMailMessage[] = [];
      for await (const message of this.client!.fetch(uids, { uid: true, envelope: true, source: true }, { uid: true })) {
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