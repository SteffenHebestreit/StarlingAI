import { registerTool, type ToolResult } from "./registry.js";
import { callMailService, formatMailServiceError, ok, fail } from "./mail-service-client.js";

// ─── contacts_list_address_books ──────────────────────────────────────────────

registerTool({
  name: "contacts_list_address_books",
  description: "List all CardDAV address books for a configured mail account.",
  parameters: {
    type: "object",
    properties: {
      accountId: { type: "string", description: "Mail account ID that has CardDAV configured." },
    },
    required: ["accountId"],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const accountId = String(args["accountId"] ?? "").trim();
    if (!accountId) return fail("accountId is required");

    type AddressBookInfo = { url: string; displayName: string; description: string };
    const response = await callMailService<AddressBookInfo[]>(`/api/contacts/${encodeURIComponent(accountId)}/addressbooks`);
    if (response.status >= 400) return fail(formatMailServiceError(response));

    const books = response.body ?? [];
    if (books.length === 0) return ok("No address books found.", { accountId, addressBooks: [] });

    const output = books.map((book) =>
      `- ${book.displayName || "(unnamed)"}\n  URL: ${book.url}${book.description ? `\n  Description: ${book.description}` : ""}`
    ).join("\n");
    return ok(output, { accountId, addressBooks: books });
  },
});

// ─── contacts_search ──────────────────────────────────────────────────────────

registerTool({
  name: "contacts_search",
  description: "Search or list contacts in a CardDAV address book. Filters by name, email, or organization when a query is provided.",
  embeddingDescription: "Search, find, look up a contact, person, phone number, email in address book. Kontakt suchen, Adressbuch durchsuchen, Telefonnummer finden, Person nachschlagen.",
  parameters: {
    type: "object",
    properties: {
      accountId: { type: "string", description: "Mail account ID." },
      addressBookUrl: { type: "string", description: "Address book URL from contacts_list_address_books." },
      query: { type: "string", description: "Search query to filter by name, email, or organization. Omit to list all contacts." },
    },
    required: ["accountId", "addressBookUrl"],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const accountId = String(args["accountId"] ?? "").trim();
    const addressBookUrl = String(args["addressBookUrl"] ?? "").trim();
    if (!accountId) return fail("accountId is required");
    if (!addressBookUrl) return fail("addressBookUrl is required");

    type Contact = {
      uid: string; url: string; etag: string; fullName: string;
      firstName?: string; lastName?: string; emails: string[]; phones: string[];
      organization?: string; title?: string; notes?: string; birthday?: string;
    };
    const response = await callMailService<Contact[]>("/api/contacts/list", {
      method: "POST",
      body: JSON.stringify({
        accountId,
        addressBookUrl,
        query: args["query"] ? String(args["query"]) : undefined,
      }),
    });
    if (response.status >= 400) return fail(formatMailServiceError(response));

    const contacts = response.body ?? [];
    if (contacts.length === 0) return ok("No contacts found.", { accountId, addressBookUrl, contacts: [] });

    const output = contacts.map((c) => {
      const lines = [`- ${c.fullName}`];
      if (c.emails.length > 0) lines.push(`  Email: ${c.emails.join(", ")}`);
      if (c.phones.length > 0) lines.push(`  Phone: ${c.phones.join(", ")}`);
      if (c.organization) lines.push(`  Org: ${c.organization}${c.title ? ` — ${c.title}` : ""}`);
      lines.push(`  URL: ${c.url}`, `  Etag: ${c.etag}`);
      return lines.join("\n");
    }).join("\n");
    return ok(output, { accountId, addressBookUrl, contacts });
  },
});

// ─── contacts_create ──────────────────────────────────────────────────────────

registerTool({
  name: "contacts_create",
  description: "Create a new contact in a CardDAV address book. Returns the new contact UID.",
  parameters: {
    type: "object",
    properties: {
      accountId: { type: "string", description: "Mail account ID." },
      addressBookUrl: { type: "string", description: "Address book URL from contacts_list_address_books." },
      fullName: { type: "string", description: "Full display name (required)." },
      firstName: { type: "string", description: "First/given name." },
      lastName: { type: "string", description: "Last/family name." },
      emails: { type: "array", items: { type: "string" }, description: "Email addresses." },
      phones: { type: "array", items: { type: "string" }, description: "Phone numbers." },
      organization: { type: "string", description: "Organization or company name." },
      title: { type: "string", description: "Job title." },
      notes: { type: "string", description: "Notes/remarks." },
      birthday: { type: "string", description: "Birthday as YYYY-MM-DD." },
    },
    required: ["accountId", "addressBookUrl", "fullName"],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const accountId = String(args["accountId"] ?? "").trim();
    const addressBookUrl = String(args["addressBookUrl"] ?? "").trim();
    if (!accountId) return fail("accountId is required");
    if (!addressBookUrl) return fail("addressBookUrl is required");
    if (!args["fullName"]) return fail("fullName is required");

    const response = await callMailService<{ uid: string }>("/api/contacts", {
      method: "POST",
      body: JSON.stringify({
        accountId,
        addressBookUrl,
        fullName: String(args["fullName"]),
        firstName: args["firstName"] ? String(args["firstName"]) : undefined,
        lastName: args["lastName"] ? String(args["lastName"]) : undefined,
        emails: Array.isArray(args["emails"]) ? args["emails"].map(String) : undefined,
        phones: Array.isArray(args["phones"]) ? args["phones"].map(String) : undefined,
        organization: args["organization"] ? String(args["organization"]) : undefined,
        title: args["title"] ? String(args["title"]) : undefined,
        notes: args["notes"] ? String(args["notes"]) : undefined,
        birthday: args["birthday"] ? String(args["birthday"]) : undefined,
      }),
    });
    if (response.status >= 400) return fail(formatMailServiceError(response));
    return ok(`Contact created. UID: ${response.body?.uid}`, { uid: response.body?.uid });
  },
});

// ─── contacts_update ──────────────────────────────────────────────────────────

registerTool({
  name: "contacts_update",
  description: "Update an existing contact. Provide the URL and etag from contacts_search.",
  parameters: {
    type: "object",
    properties: {
      accountId: { type: "string", description: "Mail account ID." },
      contactUrl: { type: "string", description: "Contact URL from contacts_search." },
      etag: { type: "string", description: "Contact etag from contacts_search (for conflict detection)." },
      fullName: { type: "string", description: "Full display name." },
      firstName: { type: "string", description: "First/given name." },
      lastName: { type: "string", description: "Last/family name." },
      emails: { type: "array", items: { type: "string" }, description: "Email addresses." },
      phones: { type: "array", items: { type: "string" }, description: "Phone numbers." },
      organization: { type: "string", description: "Organization name." },
      title: { type: "string", description: "Job title." },
      notes: { type: "string", description: "Notes/remarks." },
      birthday: { type: "string", description: "Birthday as YYYY-MM-DD." },
    },
    required: ["accountId", "contactUrl", "etag", "fullName"],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const accountId = String(args["accountId"] ?? "").trim();
    const contactUrl = String(args["contactUrl"] ?? "").trim();
    const etag = String(args["etag"] ?? "").trim();
    if (!accountId) return fail("accountId is required");
    if (!contactUrl) return fail("contactUrl is required");
    if (!etag) return fail("etag is required");
    if (!args["fullName"]) return fail("fullName is required");

    const response = await callMailService<{ ok: boolean }>("/api/contacts", {
      method: "PUT",
      body: JSON.stringify({
        accountId,
        contactUrl,
        etag,
        fullName: String(args["fullName"]),
        firstName: args["firstName"] ? String(args["firstName"]) : undefined,
        lastName: args["lastName"] ? String(args["lastName"]) : undefined,
        emails: Array.isArray(args["emails"]) ? args["emails"].map(String) : undefined,
        phones: Array.isArray(args["phones"]) ? args["phones"].map(String) : undefined,
        organization: args["organization"] ? String(args["organization"]) : undefined,
        title: args["title"] ? String(args["title"]) : undefined,
        notes: args["notes"] ? String(args["notes"]) : undefined,
        birthday: args["birthday"] ? String(args["birthday"]) : undefined,
      }),
    });
    if (response.status >= 400) return fail(formatMailServiceError(response));
    return ok("Contact updated successfully.", { contactUrl });
  },
});

// ─── contacts_delete ──────────────────────────────────────────────────────────

registerTool({
  name: "contacts_delete",
  description: "Delete a contact from a CardDAV address book. Provide the URL and etag from contacts_search.",
  parameters: {
    type: "object",
    properties: {
      accountId: { type: "string", description: "Mail account ID." },
      contactUrl: { type: "string", description: "Contact URL from contacts_search." },
      etag: { type: "string", description: "Contact etag from contacts_search." },
    },
    required: ["accountId", "contactUrl", "etag"],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const accountId = String(args["accountId"] ?? "").trim();
    const contactUrl = String(args["contactUrl"] ?? "").trim();
    const etag = String(args["etag"] ?? "").trim();
    if (!accountId) return fail("accountId is required");
    if (!contactUrl) return fail("contactUrl is required");
    if (!etag) return fail("etag is required");

    const response = await callMailService<{ ok: boolean }>("/api/contacts", {
      method: "DELETE",
      body: JSON.stringify({ accountId, contactUrl, etag }),
    });
    if (response.status >= 400) return fail(formatMailServiceError(response));
    return ok("Contact deleted successfully.", { contactUrl });
  },
});
