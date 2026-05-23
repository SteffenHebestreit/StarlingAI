import { Hono } from "hono";
import { z } from "zod";
import * as dav from "./dav-client.js";
import type { MailAccountConfig } from "./types.js";
import { getAccount } from "./account-access.js";

const CalendarUrlSchema = z.object({
  accountId: z.string().min(1),
  calendarUrl: z.string().min(1),
});

const ListEventsSchema = CalendarUrlSchema.extend({
  start: z.string().min(1),
  end: z.string().min(1),
});

const CreateEventSchema = CalendarUrlSchema.extend({
  uid: z.string().optional(),
  title: z.string().min(1),
  start: z.string().min(1),
  end: z.string().min(1),
  allDay: z.boolean().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  status: z.string().optional(),
  attendees: z.array(z.string()).optional(),
  rrule: z.string().optional(),
});

const UpdateEventSchema = z.object({
  accountId: z.string().min(1),
  eventUrl: z.string().min(1),
  etag: z.string().min(1),
  uid: z.string().optional(),
  title: z.string().min(1),
  start: z.string().min(1),
  end: z.string().min(1),
  allDay: z.boolean().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  status: z.string().optional(),
  attendees: z.array(z.string()).optional(),
  rrule: z.string().optional(),
});

const DeleteEventSchema = z.object({
  accountId: z.string().min(1),
  eventUrl: z.string().min(1),
  etag: z.string().min(1),
});

export function calendarRoutes(accounts: MailAccountConfig[]) {
  const app = new Hono();

  // List calendars for an account
  app.get("/api/calendar/:accountId/calendars", async (c) => {
    const account = getAccount(accounts, c.req.param("accountId"), c.req.header("x-sai-user"));
    if (!account.caldav) {
      return c.json({ error: "Account has no CalDAV configuration" }, 422);
    }
    const calendars = await dav.listCalendars(account.caldav);
    return c.json(calendars);
  });

  // List events in a calendar within a date range
  app.post("/api/calendar/events/list", async (c) => {
    const body = ListEventsSchema.parse(await c.req.json());
    const account = getAccount(accounts, body.accountId, c.req.header("x-sai-user"));
    if (!account.caldav) {
      return c.json({ error: "Account has no CalDAV configuration" }, 422);
    }
    const events = await dav.listEvents(account.caldav, body.calendarUrl, body.start, body.end);
    return c.json(events);
  });

  // Create a new calendar event
  app.post("/api/calendar/events", async (c) => {
    const body = CreateEventSchema.parse(await c.req.json());
    const account = getAccount(accounts, body.accountId, c.req.header("x-sai-user"));
    if (!account.caldav) {
      return c.json({ error: "Account has no CalDAV configuration" }, 422);
    }
    const uid = await dav.createEvent(account.caldav, body.calendarUrl, body);
    return c.json({ uid }, 201);
  });

  // Update an existing calendar event
  app.put("/api/calendar/events", async (c) => {
    const body = UpdateEventSchema.parse(await c.req.json());
    const account = getAccount(accounts, body.accountId, c.req.header("x-sai-user"));
    if (!account.caldav) {
      return c.json({ error: "Account has no CalDAV configuration" }, 422);
    }
    await dav.updateEvent(account.caldav, body.eventUrl, body.etag, body);
    return c.json({ ok: true });
  });

  // Delete a calendar event
  app.delete("/api/calendar/events", async (c) => {
    const body = DeleteEventSchema.parse(await c.req.json());
    const account = getAccount(accounts, body.accountId, c.req.header("x-sai-user"));
    if (!account.caldav) {
      return c.json({ error: "Account has no CalDAV configuration" }, 422);
    }
    await dav.deleteEvent(account.caldav, body.eventUrl, body.etag);
    return c.json({ ok: true });
  });

  return app;
}
