import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ToolContext, ToolHandler } from "../tools/registry.js";

// Stub only the network call; keep ok/fail/formatMailServiceError real.
const { callMailService } = vi.hoisted(() => ({ callMailService: vi.fn() }));
vi.mock("../tools/mail-service-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools/mail-service-client.js")>();
  return { ...actual, callMailService };
});

const { getTool } = await import("../tools/registry.js");
await import("../tools/calendar.js"); // registers calendar_* tools

const ctx = {} as unknown as ToolContext;
const t = (name: string): ToolHandler => {
  const h = getTool(name);
  if (!h) throw new Error(`tool ${name} not registered`);
  return h;
};

describe("calendar tools", () => {
  beforeEach(() => callMailService.mockReset());

  it("validates required args before any network call", async () => {
    expect((await t("calendar_list_calendars").execute({}, ctx)).success).toBe(false);
    expect((await t("calendar_list_events").execute({ accountId: "a", calendarUrl: "u" }, ctx)).success).toBe(false); // missing start/end
    expect((await t("calendar_create_event").execute({ accountId: "a", calendarUrl: "u", title: "x" }, ctx)).success).toBe(false); // missing start/end
    expect((await t("calendar_update_event").execute({ accountId: "a", eventUrl: "u" }, ctx)).success).toBe(false); // missing etag
    expect((await t("calendar_delete_event").execute({ accountId: "a", eventUrl: "u" }, ctx)).success).toBe(false); // missing etag
    expect(callMailService).not.toHaveBeenCalled();
  });

  it("lists calendars on a 200 response", async () => {
    callMailService.mockResolvedValue({ status: 200, body: [{ displayName: "Work", url: "https://dav/cal/1", color: "#fff" }] });
    const r = await t("calendar_list_calendars").execute({ accountId: "acc1" }, ctx);
    expect(r.success).toBe(true);
    expect(r.metadata?.["calendars"]).toHaveLength(1);
  });

  it("reports an empty event range without error", async () => {
    callMailService.mockResolvedValue({ status: 200, body: [] });
    const r = await t("calendar_list_events").execute(
      { accountId: "a", calendarUrl: "u", start: "2026-01-01", end: "2026-01-31" },
      ctx,
    );
    expect(r.success).toBe(true);
    expect(r.output).toContain("No events found");
  });

  it("surfaces a >=400 response as a failure", async () => {
    callMailService.mockResolvedValue({ status: 403, error: "forbidden" });
    const r = await t("calendar_list_calendars").execute({ accountId: "a" }, ctx);
    expect(r.success).toBe(false);
  });

  it("creates an event and returns the new UID", async () => {
    callMailService.mockResolvedValue({ status: 200, body: { uid: "evt-9" } });
    const r = await t("calendar_create_event").execute(
      { accountId: "a", calendarUrl: "u", title: "Standup", start: "2026-01-01T09:00:00Z", end: "2026-01-01T09:15:00Z" },
      ctx,
    );
    expect(r.success).toBe(true);
    expect(r.output).toContain("evt-9");
  });
});
