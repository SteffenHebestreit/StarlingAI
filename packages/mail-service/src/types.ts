export interface MailAccountAuthConfig {
  user: string;
  pass: string;
}

export interface MailImapConfig extends MailAccountAuthConfig {
  host: string;
  port: number;
  secure: boolean;
}

export interface MailSmtpConfig extends MailAccountAuthConfig {
  host: string;
  port: number;
  secure: boolean;
  from?: string;
}

export interface MailAccountConfig {
  id: string;
  address: string;
  displayName?: string;
  imap: MailImapConfig;
  smtp: MailSmtpConfig;
}

export interface MessageRef {
  accountId: string;
  mailbox: string;
  uid: number;
}

export interface ParsedAttachment {
  filename: string;
  contentType: string;
  size: number;
}

export interface ParsedMailMessage extends MessageRef {
  messageId: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  html: string;
  textBody: string;
  attachments: ParsedAttachment[];
}

export interface MailSummary extends MessageRef {
  messageId: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  attachmentCount: number;
  categories: string[];
  note?: string;
  textPreview: string;
}

export interface DraftRecord {
  id: string;
  accountId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  textBody: string;
  htmlBody?: string;
  replyTo?: MessageRef;
  status: "draft" | "sent";
  createdAt: string;
  updatedAt: string;
  sentAt?: string;
}

export interface CategoryRecord extends MessageRef {
  category: string;
  note?: string;
  updatedAt: string;
}

export interface MailServiceState {
  drafts: Record<string, DraftRecord>;
  categories: Record<string, CategoryRecord>;
}