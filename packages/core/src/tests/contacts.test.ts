import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ToolContext, ToolHandler } from "../tools/registry.js";

// Stub only the network call; keep ok/fail/formatMailServiceError real.
const { callMailService } = vi.hoisted(() => ({ callMailService: vi.fn() }));
vi.mock("../tools/mail-service-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools/mail-service-client.js")>();
  return { ...actual, callMailService };
});

const { getTool } = await import("../tools/registry.js");
await import("../tools/contacts.js"); // registers contacts_* tools

const ctx = {} as unknown as ToolContext;
const t = (name: string): ToolHandler => {
  const h = getTool(name);
  if (!h) throw new Error(`tool ${name} not registered`);
  return h;
};

describe("contacts tools", () => {
  beforeEach(() => callMailService.mockReset());

  it("validates required args before any network call", async () => {
    expect((await t("contacts_list_address_books").execute({}, ctx)).success).toBe(false);
    expect((await t("contacts_search").execute({ accountId: "a" }, ctx)).success).toBe(false); // missing addressBookUrl
    expect((await t("contacts_create").execute({ accountId: "a", addressBookUrl: "u" }, ctx)).success).toBe(false); // missing fullName
    expect((await t("contacts_update").execute({ accountId: "a", contactUrl: "u" }, ctx)).success).toBe(false); // missing etag
    expect((await t("contacts_delete").execute({ accountId: "a", contactUrl: "u" }, ctx)).success).toBe(false); // missing etag
    expect(callMailService).not.toHaveBeenCalled();
  });

  it("lists address books on a 200 response", async () => {
    callMailService.mockResolvedValue({ status: 200, body: [{ displayName: "Personal", url: "https://dav/ab/1", description: "" }] });
    const r = await t("contacts_list_address_books").execute({ accountId: "acc1" }, ctx);
    expect(r.success).toBe(true);
    expect(r.metadata?.["addressBooks"]).toHaveLength(1);
    expect(callMailService).toHaveBeenCalledTimes(1);
  });

  it("surfaces a >=400 response as a failure", async () => {
    callMailService.mockResolvedValue({ status: 500, error: "boom" });
    const r = await t("contacts_search").execute({ accountId: "a", addressBookUrl: "u", query: "x" }, ctx);
    expect(r.success).toBe(false);
  });

  it("creates a contact and returns the new UID", async () => {
    callMailService.mockResolvedValue({ status: 200, body: { uid: "uid-123" } });
    const r = await t("contacts_create").execute({ accountId: "a", addressBookUrl: "u", fullName: "Jane Doe", email: "j@x.com" }, ctx);
    expect(r.success).toBe(true);
    expect(r.output).toContain("uid-123");
  });
});
