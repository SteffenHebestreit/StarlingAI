import { registerTool, type ToolResult } from "./registry.js";
import { callMailService, formatMailServiceError, ok, fail } from "./mail-service-client.js";

// ─── calendar_list_calendars ───────────────────────────────────────────────────

registerTool({
  name: "calendar_list_calendars",
  description: "List all CalDAV calendars for a configured mail account. Returns calendar URLs, names, and descriptions.",
  embeddingDescription: "List available calendars, show configured calendars. Verfügbare Kalender anzeigen, Kalenderliste abrufen, Kalender auflisten.",
  parameters: {
    type: "object",
    properties: {
      accountId: { type: "string", description: "Mail account ID that has CalDAV configured." },
    },
    required: ["accountId"],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const accountId = String(args["accountId"] ?? "").trim();
    if (!accountId) return fail("accountId is required");

    type CalendarInfo = { url: string; displayName: string; description: string; color?: string };
    const response = await callMailService<CalendarInfo[]>(`/api/calendar/${encodeURIComponent(accountId)}/calendars`);
    if (response.status >= 400) return fail(formatMailServiceError(response));

    const calendars = response.body ?? [];
    if (calendars.length === 0) return ok("No calendars found.", { accountId, calendars });

    const output = calendars.map((cal) =>
      `- ${cal.displayName || "(unnamed)"}\n  URL: ${cal.url}${cal.description ? `\n  Description: ${cal.description}` : ""}${cal.color ? `\n  Color: ${cal.color}` : ""}`
    ).join("\n");
    return ok(output, { accountId, calendars });
  },
});

// ─── calendar_list_events ─────────────────────────────────────────────────────

registerTool({
  name: "calendar_list_events",
  description: "List calendar events within a date range. Returns event details including UID, URL, etag, title, start/end times, attendees, and recurrence rules.",
  embeddingDescription: "List, show, view upcoming meetings, appointments, events, schedule. Termine anzeigen, Besprechungen auflisten, Kalendereinträge abrufen, Zeitplan ansehen. What's on my calendar.",
  parameters: {
    type: "object",
    properties: {
      accountId: { type: "string", description: "Mail account ID." },
      calendarUrl: { type: "string", description: "Calendar URL from calendar_list_calendars." },
      start: { type: "string", description: "Start of range as ISO 8601 datetime or date, e.g. '2024-06-01T00:00:00Z'." },
      end: { type: "string", description: "End of range as ISO 8601 datetime or date, e.g. '2024-06-30T23:59:59Z'." },
    },
    required: ["accountId", "calendarUrl", "start", "end"],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const accountId = String(args["accountId"] ?? "").trim();
    const calendarUrl = String(args["calendarUrl"] ?? "").trim();
    const start = String(args["start"] ?? "").trim();
    const end = String(args["end"] ?? "").trim();
    if (!accountId) return fail("accountId is required");
    if (!calendarUrl) return fail("calendarUrl is required");
    if (!start || !end) return fail("start and end are required");

    type CalendarEvent = {
      uid: string; url: string; etag: string; title: string;
      start: string; end: string; allDay: boolean;
      description: string; location: string; status: string;
      attendees: string[]; rrule?: string;
    };
    const response = await callMailService<CalendarEvent[]>("/api/calendar/events/list", {
      method: "POST",
      body: JSON.stringify({ accountId, calendarUrl, start, end }),
    });
    if (response.status >= 400) return fail(formatMailServiceError(response));

    const events = response.body ?? [];
    if (events.length === 0) return ok("No events found in the specified range.", { accountId, calendarUrl, start, end, events: [] });

    const output = events.map((ev) => {
      const time = ev.allDay ? ev.start : `${ev.start} → ${ev.end}`;
      const lines = [`- [${ev.status}] ${ev.title} (${time})`, `  UID: ${ev.uid}`, `  URL: ${ev.url}`, `  Etag: ${ev.etag}`];
      if (ev.description) lines.push(`  Description: ${ev.description.slice(0, 120)}`);
      if (ev.location) lines.push(`  Location: ${ev.location}`);
      if (ev.attendees.length > 0) lines.push(`  Attendees: ${ev.attendees.join(", ")}`);
      if (ev.rrule) lines.push(`  RRULE: ${ev.rrule}`);
      return lines.join("\n");
    }).join("\n");
    return ok(output, { accountId, calendarUrl, events });
  },
});

// ─── calendar_create_event ────────────────────────────────────────────────────

registerTool({
  name: "calendar_create_event",
  description: "Create a new event in a CalDAV calendar. Returns the new event UID.",
  embeddingDescription: "Create, schedule, add a meeting, appointment, event. Termin anlegen, Besprechung planen, neuen Kalendereintrag erstellen, Ereignis eintragen.",
  parameters: {
    type: "object",
    properties: {
      accountId: { type: "string", description: "Mail account ID." },
      calendarUrl: { type: "string", description: "Calendar URL from calendar_list_calendars." },
      title: { type: "string", description: "Event title/summary." },
      start: { type: "string", description: "Start datetime as ISO 8601, e.g. '2024-06-15T10:00:00Z'. Use date only 'YYYY-MM-DD' for all-day events." },
      end: { type: "string", description: "End datetime as ISO 8601. For all-day events use the day after." },
      allDay: { type: "boolean", description: "Set true for all-day events." },
      description: { type: "string", description: "Event description/notes." },
      location: { type: "string", description: "Event location." },
      status: { type: "string", description: "Event status: CONFIRMED, TENTATIVE, or CANCELLED. Defaults to CONFIRMED." },
      attendees: { type: "array", items: { type: "string" }, description: "List of attendee email addresses." },
      rrule: { type: "string", description: "Recurrence rule in RFC 5545 RRULE format, e.g. 'FREQ=WEEKLY;BYDAY=MO'." },
    },
    required: ["accountId", "calendarUrl", "title", "start", "end"],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const accountId = String(args["accountId"] ?? "").trim();
    const calendarUrl = String(args["calendarUrl"] ?? "").trim();
    if (!accountId) return fail("accountId is required");
    if (!calendarUrl) return fail("calendarUrl is required");
    if (!args["title"]) return fail("title is required");
    if (!args["start"] || !args["end"]) return fail("start and end are required");

    const response = await callMailService<{ uid: string }>("/api/calendar/events", {
      method: "POST",
      body: JSON.stringify({
        accountId,
        calendarUrl,
        title: String(args["title"]),
        start: String(args["start"]),
        end: String(args["end"]),
        allDay: args["allDay"] === true,
        description: args["description"] ? String(args["description"]) : undefined,
        location: args["location"] ? String(args["location"]) : undefined,
        status: args["status"] ? String(args["status"]) : undefined,
        attendees: Array.isArray(args["attendees"]) ? args["attendees"].map(String) : undefined,
        rrule: args["rrule"] ? String(args["rrule"]) : undefined,
      }),
    });
    if (response.status >= 400) return fail(formatMailServiceError(response));
    return ok(`Event created. UID: ${response.body?.uid}`, { uid: response.body?.uid });
  },
});

// ─── calendar_update_event ────────────────────────────────────────────────────

registerTool({
  name: "calendar_update_event",
  description: "Update an existing calendar event. Provide the URL and etag from calendar_list_events.",
  parameters: {
    type: "object",
    properties: {
      accountId: { type: "string", description: "Mail account ID." },
      eventUrl: { type: "string", description: "Event URL from calendar_list_events." },
      etag: { type: "string", description: "Event etag from calendar_list_events (for conflict detection)." },
      title: { type: "string", description: "Event title/summary." },
      start: { type: "string", description: "Start datetime as ISO 8601." },
      end: { type: "string", description: "End datetime as ISO 8601." },
      allDay: { type: "boolean", description: "Set true for all-day events." },
      description: { type: "string", description: "Event description." },
      location: { type: "string", description: "Event location." },
      status: { type: "string", description: "Event status: CONFIRMED, TENTATIVE, or CANCELLED." },
      attendees: { type: "array", items: { type: "string" }, description: "Attendee email addresses." },
      rrule: { type: "string", description: "Recurrence rule in RFC 5545 format." },
    },
    required: ["accountId", "eventUrl", "etag", "title", "start", "end"],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const accountId = String(args["accountId"] ?? "").trim();
    const eventUrl = String(args["eventUrl"] ?? "").trim();
    const etag = String(args["etag"] ?? "").trim();
    if (!accountId) return fail("accountId is required");
    if (!eventUrl) return fail("eventUrl is required");
    if (!etag) return fail("etag is required");
    if (!args["title"] || !args["start"] || !args["end"]) return fail("title, start, and end are required");

    const response = await callMailService<{ ok: boolean }>("/api/calendar/events", {
      method: "PUT",
      body: JSON.stringify({
        accountId,
        eventUrl,
        etag,
        title: String(args["title"]),
        start: String(args["start"]),
        end: String(args["end"]),
        allDay: args["allDay"] === true,
        description: args["description"] ? String(args["description"]) : undefined,
        location: args["location"] ? String(args["location"]) : undefined,
        status: args["status"] ? String(args["status"]) : undefined,
        attendees: Array.isArray(args["attendees"]) ? args["attendees"].map(String) : undefined,
        rrule: args["rrule"] ? String(args["rrule"]) : undefined,
      }),
    });
    if (response.status >= 400) return fail(formatMailServiceError(response));
    return ok("Event updated successfully.", { eventUrl });
  },
});

// ─── calendar_delete_event ────────────────────────────────────────────────────

registerTool({
  name: "calendar_delete_event",
  description: "Delete a calendar event. Provide the URL and etag from calendar_list_events.",
  parameters: {
    type: "object",
    properties: {
      accountId: { type: "string", description: "Mail account ID." },
      eventUrl: { type: "string", description: "Event URL from calendar_list_events." },
      etag: { type: "string", description: "Event etag from calendar_list_events." },
    },
    required: ["accountId", "eventUrl", "etag"],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const accountId = String(args["accountId"] ?? "").trim();
    const eventUrl = String(args["eventUrl"] ?? "").trim();
    const etag = String(args["etag"] ?? "").trim();
    if (!accountId) return fail("accountId is required");
    if (!eventUrl) return fail("eventUrl is required");
    if (!etag) return fail("etag is required");

    const response = await callMailService<{ ok: boolean }>("/api/calendar/events", {
      method: "DELETE",
      body: JSON.stringify({ accountId, eventUrl, etag }),
    });
    if (response.status >= 400) return fail(formatMailServiceError(response));
    return ok("Event deleted successfully.", { eventUrl });
  },
});
