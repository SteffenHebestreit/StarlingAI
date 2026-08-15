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

export interface DavCredentials {
  serverUrl: string;
  username: string;
  password: string;
}

export interface MailAccountConfig {
  id: string;
  address: string;
  displayName?: string;
  /** Usernames permitted to use this account. Empty/unset = shared (all users). */
  allowedUsers?: string[];
  imap: MailImapConfig;
  smtp: MailSmtpConfig;
  caldav?: DavCredentials;
  carddav?: DavCredentials;
}

export interface CalendarInfo {
  url: string;
  displayName: string;
  description: string;
  color?: string;
  timezone?: string;
}

export interface CalendarEvent {
  uid: string;
  url: string;
  etag: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  description: string;
  location: string;
  status: string;
  attendees: string[];
  rrule?: string;
}

export interface CalendarEventInput {
  uid?: string;
  title: string;
  start: string;
  end: string;
  allDay?: boolean;
  description?: string;
  location?: string;
  status?: string;
  attendees?: string[];
  rrule?: string;
}

export interface AddressBookInfo {
  url: string;
  displayName: string;
  description: string;
}

export interface Contact {
  uid: string;
  url: string;
  etag: string;
  fullName: string;
  firstName?: string;
  lastName?: string;
  emails: string[];
  phones: string[];
  organization?: string;
  title?: string;
  notes?: string;
  birthday?: string;
}

export interface ContactInput {
  uid?: string;
  fullName: string;
  firstName?: string;
  lastName?: string;
  emails?: string[];
  phones?: string[];
  organization?: string;
  title?: string;
  notes?: string;
  birthday?: string;
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
  /** RFC 5322 In-Reply-To, when present. Empty string when the sender omitted it. */
  inReplyTo: string;
  /** RFC 5322 References chain, oldest first. The exact, language-independent thread spine. */
  references: string[];
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