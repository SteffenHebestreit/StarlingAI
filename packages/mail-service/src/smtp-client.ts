import nodemailer from "nodemailer";
import type { DraftRecord, MailAccountConfig } from "./types.js";

export async function sendDraft(account: MailAccountConfig, draft: DraftRecord): Promise<void> {
  const transporter = nodemailer.createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    auth: {
      user: account.smtp.user,
      pass: account.smtp.pass,
    },
  });

  await transporter.sendMail({
    from: account.smtp.from ?? account.address,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    text: draft.textBody,
    html: draft.htmlBody,
    inReplyTo: draft.replyTo ? `${draft.replyTo.accountId}:${draft.replyTo.mailbox}:${draft.replyTo.uid}` : undefined,
  });
}