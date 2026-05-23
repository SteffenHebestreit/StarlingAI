import { Hono } from "hono";
import { z } from "zod";
import * as dav from "./dav-client.js";
import type { MailAccountConfig } from "./types.js";
import { getAccount } from "./account-access.js";

const AddressBookSchema = z.object({
  accountId: z.string().min(1),
  addressBookUrl: z.string().min(1),
});

const SearchContactsSchema = AddressBookSchema.extend({
  query: z.string().optional(),
});

const CreateContactSchema = AddressBookSchema.extend({
  uid: z.string().optional(),
  fullName: z.string().min(1),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  emails: z.array(z.string()).optional(),
  phones: z.array(z.string()).optional(),
  organization: z.string().optional(),
  title: z.string().optional(),
  notes: z.string().optional(),
  birthday: z.string().optional(),
});

const UpdateContactSchema = z.object({
  accountId: z.string().min(1),
  contactUrl: z.string().min(1),
  etag: z.string().min(1),
  uid: z.string().optional(),
  fullName: z.string().min(1),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  emails: z.array(z.string()).optional(),
  phones: z.array(z.string()).optional(),
  organization: z.string().optional(),
  title: z.string().optional(),
  notes: z.string().optional(),
  birthday: z.string().optional(),
});

const DeleteContactSchema = z.object({
  accountId: z.string().min(1),
  contactUrl: z.string().min(1),
  etag: z.string().min(1),
});

export function contactsRoutes(accounts: MailAccountConfig[]) {
  const app = new Hono();

  // List address books for an account
  app.get("/api/contacts/:accountId/addressbooks", async (c) => {
    const account = getAccount(accounts, c.req.param("accountId"), c.req.header("x-sai-user"));
    if (!account.carddav) {
      return c.json({ error: "Account has no CardDAV configuration" }, 422);
    }
    const books = await dav.listAddressBooks(account.carddav);
    return c.json(books);
  });

  // Search/list contacts in an address book
  app.post("/api/contacts/list", async (c) => {
    const body = SearchContactsSchema.parse(await c.req.json());
    const account = getAccount(accounts, body.accountId, c.req.header("x-sai-user"));
    if (!account.carddav) {
      return c.json({ error: "Account has no CardDAV configuration" }, 422);
    }
    const contacts = await dav.listContacts(account.carddav, body.addressBookUrl, body.query);
    return c.json(contacts);
  });

  // Create a new contact
  app.post("/api/contacts", async (c) => {
    const body = CreateContactSchema.parse(await c.req.json());
    const account = getAccount(accounts, body.accountId, c.req.header("x-sai-user"));
    if (!account.carddav) {
      return c.json({ error: "Account has no CardDAV configuration" }, 422);
    }
    const uid = await dav.createContact(account.carddav, body.addressBookUrl, body);
    return c.json({ uid }, 201);
  });

  // Update an existing contact
  app.put("/api/contacts", async (c) => {
    const body = UpdateContactSchema.parse(await c.req.json());
    const account = getAccount(accounts, body.accountId, c.req.header("x-sai-user"));
    if (!account.carddav) {
      return c.json({ error: "Account has no CardDAV configuration" }, 422);
    }
    await dav.updateContact(account.carddav, body.contactUrl, body.etag, body);
    return c.json({ ok: true });
  });

  // Delete a contact
  app.delete("/api/contacts", async (c) => {
    const body = DeleteContactSchema.parse(await c.req.json());
    const account = getAccount(accounts, body.accountId, c.req.header("x-sai-user"));
    if (!account.carddav) {
      return c.json({ error: "Account has no CardDAV configuration" }, 422);
    }
    await dav.deleteContact(account.carddav, body.contactUrl, body.etag);
    return c.json({ ok: true });
  });

  return app;
}
