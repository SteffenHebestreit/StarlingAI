import { createDAVClient } from "tsdav";
import { randomUUID } from "node:crypto";
import type {
  DavCredentials,
  CalendarInfo,
  CalendarEvent,
  CalendarEventInput,
  AddressBookInfo,
  Contact,
  ContactInput,
} from "./types.js";

// ─── Client factory ────────────────────────────────────────────────────────────

async function makeCaldavClient(creds: DavCredentials) {
  return createDAVClient({
    serverUrl: creds.serverUrl,
    credentials: { username: creds.username, password: creds.password },
    authMethod: "Basic",
    defaultAccountType: "caldav",
  });
}

async function makeCarddavClient(creds: DavCredentials) {
  return createDAVClient({
    serverUrl: creds.serverUrl,
    credentials: { username: creds.username, password: creds.password },
    authMethod: "Basic",
    defaultAccountType: "carddav",
  });
}

// ─── ICS utilities ─────────────────────────────────────────────────────────────

function escapeIcs(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

function foldIcsLine(line: string): string {
  if (line.length <= 75) return line;
  let result = "";
  while (line.length > 75) {
    result += line.slice(0, 75) + "\r\n ";
    line = line.slice(75);
  }
  return result + line;
}

function unescapeIcs(s: string): string {
  return s.replace(/\\n/g, "\n").replace(/\\;/g, ";").replace(/\\,/g, ",").replace(/\\\\/g, "\\");
}

function unfoldIcs(raw: string): string {
  return raw.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
}

/** Convert an ISO 8601 datetime string to RFC 5545 basic format for tsdav timeRange */
function toCalDavDate(iso: string): string {
  const d = new Date(iso);
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const mo = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const da = d.getUTCDate().toString().padStart(2, "0");
  const h = d.getUTCHours().toString().padStart(2, "0");
  const mi = d.getUTCMinutes().toString().padStart(2, "0");
  const s = d.getUTCSeconds().toString().padStart(2, "0");
  return `${y}${mo}${da}T${h}${mi}${s}Z`;
}

/** Format an ISO datetime as ICS date or datetime string */
function formatIcsDate(iso: string, allDay: boolean): string {
  const d = new Date(iso);
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const mo = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const da = d.getUTCDate().toString().padStart(2, "0");
  if (allDay) return `${y}${mo}${da}`;
  const h = d.getUTCHours().toString().padStart(2, "0");
  const mi = d.getUTCMinutes().toString().padStart(2, "0");
  const s = d.getUTCSeconds().toString().padStart(2, "0");
  return `${y}${mo}${da}T${h}${mi}${s}Z`;
}

/** Parse an ICS date or datetime value to ISO string */
function parseIcsDtValue(value: string): { iso: string; allDay: boolean } {
  const v = value.trim();
  // Pure date: YYYYMMDD (8 digits, no T)
  if (/^\d{8}$/.test(v)) {
    return { iso: `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`, allDay: true };
  }
  // Datetime: YYYYMMDDTHHmmss[Z]
  const y = v.slice(0, 4);
  const mo = v.slice(4, 6);
  const da = v.slice(6, 8);
  const h = v.slice(9, 11);
  const mi = v.slice(11, 13);
  const s = v.slice(13, 15) || "00";
  return { iso: `${y}-${mo}-${da}T${h}:${mi}:${s}Z`, allDay: false };
}

/** Extract all blocks of a given type from an ICS/vCard string */
function extractVBlocks(raw: string, blockName: string): Array<Record<string, string>> {
  const unfolded = unfoldIcs(raw);
  const lines = unfolded.split(/\r?\n/);
  const results: Array<Record<string, string>> = [];
  let current: Record<string, string> | null = null;

  for (const line of lines) {
    if (line === `BEGIN:${blockName}`) {
      current = {};
    } else if (line === `END:${blockName}`) {
      if (current) {
        results.push(current);
        current = null;
      }
    } else if (current) {
      const colonIdx = line.indexOf(":");
      if (colonIdx < 0) continue;
      const fullKey = line.slice(0, colonIdx);
      const value = line.slice(colonIdx + 1);
      const baseKey = fullKey.split(";")[0]!.toUpperCase();
      // First occurrence wins for simple props; attendees/emails/tels accumulate
      if (!(baseKey in current)) {
        current[baseKey] = value;
      }
      // Accumulate multi-value properties
      if (baseKey === "ATTENDEE" || baseKey === "EMAIL" || baseKey === "TEL") {
        const existing = current[`_${baseKey}S`] ?? "";
        current[`_${baseKey}S`] = existing ? `${existing}\n${value}` : value;
      }
    }
  }

  return results;
}

function parseIcsEvent(data: string, url: string, etag: string): CalendarEvent | null {
  const vevents = extractVBlocks(data, "VEVENT");
  if (vevents.length === 0) return null;
  const p = vevents[0]!;

  const dtStart = p["DTSTART"] ? parseIcsDtValue(p["DTSTART"]) : null;
  const dtEnd = p["DTEND"] ? parseIcsDtValue(p["DTEND"]) : null;

  // Attendees stored both in "ATTENDEE" (first only) and "_ATTENDEES"
  const attendeeRaw = p["_ATTENDEES"] ?? p["ATTENDEE"] ?? "";
  const attendees = attendeeRaw
    .split("\n")
    .filter(Boolean)
    .map((v) => {
      const m = /mailto:([^\s;]+)/i.exec(v);
      return m ? m[1]! : v;
    });

  return {
    uid: p["UID"] ?? "",
    url,
    etag,
    title: unescapeIcs(p["SUMMARY"] ?? ""),
    start: dtStart?.iso ?? "",
    end: dtEnd?.iso ?? dtStart?.iso ?? "",
    allDay: dtStart?.allDay ?? false,
    description: unescapeIcs(p["DESCRIPTION"] ?? ""),
    location: unescapeIcs(p["LOCATION"] ?? ""),
    status: p["STATUS"] ?? "CONFIRMED",
    attendees,
    rrule: p["RRULE"],
  };
}

function buildICalString(ev: CalendarEventInput): string {
  const uid = ev.uid ?? `${randomUUID()}@starlingai`;
  const now = formatIcsDate(new Date().toISOString(), false);
  const allDay = ev.allDay ?? false;
  const dtStart = formatIcsDate(ev.start, allDay);
  const dtEnd = formatIcsDate(ev.end, allDay);

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//StarlingAI//StarlingAI//EN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${now}`,
    allDay ? `DTSTART;VALUE=DATE:${dtStart}` : `DTSTART:${dtStart}`,
    allDay ? `DTEND;VALUE=DATE:${dtEnd}` : `DTEND:${dtEnd}`,
    foldIcsLine(`SUMMARY:${escapeIcs(ev.title)}`),
  ];
  if (ev.description) lines.push(foldIcsLine(`DESCRIPTION:${escapeIcs(ev.description)}`));
  if (ev.location) lines.push(foldIcsLine(`LOCATION:${escapeIcs(ev.location)}`));
  if (ev.status) lines.push(`STATUS:${ev.status.toUpperCase()}`);
  if (ev.rrule) lines.push(`RRULE:${ev.rrule}`);
  for (const att of ev.attendees ?? []) {
    lines.push(foldIcsLine(`ATTENDEE;RSVP=TRUE:mailto:${att}`));
  }
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

// ─── vCard utilities ───────────────────────────────────────────────────────────

function escapeVCard(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

function unescapeVCard(s: string): string {
  return s.replace(/\\n/g, "\n").replace(/\\,/g, ",").replace(/\\\\/g, "\\");
}

function parseVCardContact(data: string, url: string, etag: string): Contact | null {
  const vcards = extractVBlocks(data, "VCARD");
  if (vcards.length === 0) return null;
  const p = vcards[0]!;

  // N: last;first;middle;prefix;suffix
  const nParts = (p["N"] ?? "").split(";");
  const lastName = unescapeVCard(nParts[0] ?? "").trim();
  const firstName = unescapeVCard(nParts[1] ?? "").trim();

  // Emails: accumulated in _EMAILS, or single in EMAIL
  const emailRaw = p["_EMAILS"] ?? p["EMAIL"] ?? "";
  const emails = emailRaw
    .split("\n")
    .filter(Boolean)
    .map((v) => unescapeVCard(v.trim()));

  // Phones
  const telRaw = p["_TELS"] ?? p["TEL"] ?? "";
  const phones = telRaw
    .split("\n")
    .filter(Boolean)
    .map((v) => unescapeVCard(v.trim()));

  // ORG: org;department (take first component)
  const orgParts = (p["ORG"] ?? "").split(";");
  const organization = unescapeVCard(orgParts[0] ?? "").trim() || undefined;

  // BDAY: YYYYMMDD or YYYY-MM-DD
  let birthday = p["BDAY"]?.trim();
  if (birthday && /^\d{8}$/.test(birthday)) {
    birthday = `${birthday.slice(0, 4)}-${birthday.slice(4, 6)}-${birthday.slice(6, 8)}`;
  }

  return {
    uid: p["UID"] ?? "",
    url,
    etag,
    fullName: unescapeVCard(p["FN"] ?? ""),
    firstName: firstName || undefined,
    lastName: lastName || undefined,
    emails,
    phones,
    organization,
    title: unescapeVCard(p["TITLE"] ?? "").trim() || undefined,
    notes: unescapeVCard(p["NOTE"] ?? "").trim() || undefined,
    birthday: birthday || undefined,
  };
}

function buildVCard(c: ContactInput): string {
  const uid = c.uid ?? `${randomUUID()}@starlingai`;
  const lines: string[] = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${escapeVCard(c.fullName)}`,
    `N:${escapeVCard(c.lastName ?? "")};${escapeVCard(c.firstName ?? "")};;;`,
    `UID:${uid}`,
  ];
  for (const email of c.emails ?? []) {
    lines.push(`EMAIL;TYPE=INTERNET:${escapeVCard(email)}`);
  }
  for (const phone of c.phones ?? []) {
    lines.push(`TEL;TYPE=VOICE:${escapeVCard(phone)}`);
  }
  if (c.organization) lines.push(`ORG:${escapeVCard(c.organization)}`);
  if (c.title) lines.push(`TITLE:${escapeVCard(c.title)}`);
  if (c.notes) lines.push(`NOTE:${escapeVCard(c.notes)}`);
  if (c.birthday) {
    const bday = c.birthday.replace(/-/g, "");
    lines.push(`BDAY:${bday}`);
  }
  lines.push("END:VCARD");
  return lines.join("\r\n") + "\r\n";
}

// ─── URL normalization ─────────────────────────────────────────────────────────

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "").toLowerCase();
}

function normalizeDisplayName(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    const first = Object.values(raw as Record<string, unknown>)[0];
    return first != null ? String(first) : "";
  }
  return "";
}

// ─── CalDAV operations ─────────────────────────────────────────────────────────

export async function listCalendars(creds: DavCredentials): Promise<CalendarInfo[]> {
  const client = await makeCaldavClient(creds);
  const calendars = await client.fetchCalendars();
  return calendars.map((cal) => ({
    url: cal.url,
    displayName: normalizeDisplayName(cal.displayName),
    description: normalizeDisplayName(cal.description) ?? "",
    color: typeof cal.calendarColor === "string" ? cal.calendarColor : undefined,
    timezone: typeof cal.timezone === "string" ? cal.timezone : undefined,
  }));
}

export async function listEvents(
  creds: DavCredentials,
  calendarUrl: string,
  start: string,
  end: string,
): Promise<CalendarEvent[]> {
  const client = await makeCaldavClient(creds);
  const calendars = await client.fetchCalendars();
  const calendar = calendars.find((cal) => normalizeUrl(cal.url) === normalizeUrl(calendarUrl));
  if (!calendar) throw new Error(`Calendar not found: ${calendarUrl}`);

  const objects = await client.fetchCalendarObjects({
    calendar,
    timeRange: { start: toCalDavDate(start), end: toCalDavDate(end) },
  });

  const events: CalendarEvent[] = [];
  for (const obj of objects) {
    if (!obj.data) continue;
    const event = parseIcsEvent(String(obj.data), obj.url, obj.etag ?? "");
    if (event) events.push(event);
  }
  return events;
}

export async function createEvent(
  creds: DavCredentials,
  calendarUrl: string,
  ev: CalendarEventInput,
): Promise<string> {
  const uid = ev.uid ?? `${randomUUID()}@starlingai`;
  const ical = buildICalString({ ...ev, uid });
  const client = await makeCaldavClient(creds);
  const calendars = await client.fetchCalendars();
  const calendar = calendars.find((cal) => normalizeUrl(cal.url) === normalizeUrl(calendarUrl));
  if (!calendar) throw new Error(`Calendar not found: ${calendarUrl}`);

  await client.createCalendarObject({
    calendar,
    iCalString: ical,
    filename: `${uid}.ics`,
  });
  return uid;
}

export async function updateEvent(
  creds: DavCredentials,
  eventUrl: string,
  etag: string,
  ev: CalendarEventInput,
): Promise<void> {
  const ical = buildICalString(ev);
  const client = await makeCaldavClient(creds);
  await client.updateCalendarObject({
    calendarObject: { url: eventUrl, etag, data: ical },
  });
}

export async function deleteEvent(
  creds: DavCredentials,
  eventUrl: string,
  etag: string,
): Promise<void> {
  const client = await makeCaldavClient(creds);
  await client.deleteCalendarObject({
    calendarObject: { url: eventUrl, etag },
  });
}

// ─── CardDAV operations ────────────────────────────────────────────────────────

export async function listAddressBooks(creds: DavCredentials): Promise<AddressBookInfo[]> {
  const client = await makeCarddavClient(creds);
  const books = await client.fetchAddressBooks();
  return books.map((book) => ({
    url: book.url,
    displayName: normalizeDisplayName(book.displayName),
    description: normalizeDisplayName(book.description) ?? "",
  }));
}

export async function listContacts(
  creds: DavCredentials,
  addressBookUrl: string,
  query?: string,
): Promise<Contact[]> {
  const client = await makeCarddavClient(creds);
  const books = await client.fetchAddressBooks();
  const addressBook = books.find((book) => normalizeUrl(book.url) === normalizeUrl(addressBookUrl));
  if (!addressBook) throw new Error(`Address book not found: ${addressBookUrl}`);

  const vcards = await client.fetchVCards({ addressBook });
  const contacts: Contact[] = [];

  for (const vc of vcards) {
    if (!vc.data) continue;
    const contact = parseVCardContact(String(vc.data), vc.url, vc.etag ?? "");
    if (!contact) continue;
    if (query) {
      const q = query.toLowerCase();
      const matches =
        contact.fullName.toLowerCase().includes(q) ||
        contact.emails.some((e) => e.toLowerCase().includes(q)) ||
        (contact.organization ?? "").toLowerCase().includes(q) ||
        (contact.firstName ?? "").toLowerCase().includes(q) ||
        (contact.lastName ?? "").toLowerCase().includes(q);
      if (!matches) continue;
    }
    contacts.push(contact);
  }
  return contacts;
}

export async function createContact(
  creds: DavCredentials,
  addressBookUrl: string,
  c: ContactInput,
): Promise<string> {
  const uid = c.uid ?? `${randomUUID()}@starlingai`;
  const vcard = buildVCard({ ...c, uid });
  const client = await makeCarddavClient(creds);
  const books = await client.fetchAddressBooks();
  const addressBook = books.find((book) => normalizeUrl(book.url) === normalizeUrl(addressBookUrl));
  if (!addressBook) throw new Error(`Address book not found: ${addressBookUrl}`);

  await client.createVCard({
    addressBook,
    vCardString: vcard,
    filename: `${uid}.vcf`,
  });
  return uid;
}

export async function updateContact(
  creds: DavCredentials,
  contactUrl: string,
  etag: string,
  c: ContactInput,
): Promise<void> {
  const vcard = buildVCard(c);
  const client = await makeCarddavClient(creds);
  await client.updateVCard({
    vCard: { url: contactUrl, etag, data: vcard },
  });
}

export async function deleteContact(
  creds: DavCredentials,
  contactUrl: string,
  etag: string,
): Promise<void> {
  const client = await makeCarddavClient(creds);
  await client.deleteVCard({
    vCard: { url: contactUrl, etag },
  });
}
