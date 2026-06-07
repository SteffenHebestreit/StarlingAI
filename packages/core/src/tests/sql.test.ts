import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ToolContext, ToolHandler } from "../tools/registry.js";

// Fake pg Pool: returns a fixed row set, or throws a credential-bearing error
// for a "BOOM" query so we can assert the URL is redacted from the message.
const { query } = vi.hoisted(() => ({
  query: vi.fn(async (q: { text: string }) => {
    if (q.text.includes("BOOM")) {
      throw new Error("connect ECONNREFUSED postgres://user:secret@host:5432/db");
    }
    return { fields: [{ name: "id" }, { name: "name" }], rows: [[1, "Ann"]] };
  }),
}));
class FakePool {
  query = query;
  async end() {}
}
vi.mock("pg", () => ({ default: { Pool: FakePool } }));

const { getTool } = await import("../tools/registry.js");
await import("../tools/sql.js"); // registers sql_query

const ctx = { sessionId: "sql-test" } as unknown as ToolContext;
const sql = (): ToolHandler => {
  const h = getTool("sql_query");
  if (!h) throw new Error("sql_query not registered");
  return h;
};

beforeAll(() => {
  process.env["SAI_DB_TEST_URL"] = "postgres://user:pw@host:5432/db";
  process.env["SAI_DB_BADSCHEME_URL"] = "sqlite://nope";
});
afterAll(() => {
  delete process.env["SAI_DB_TEST_URL"];
  delete process.env["SAI_DB_BADSCHEME_URL"];
});

describe("sql_query", () => {
  it("validates connection + sql presence", async () => {
    expect((await sql().execute({ sql: "SELECT 1" }, ctx)).success).toBe(false);
    expect((await sql().execute({ connection: "test" }, ctx)).success).toBe(false);
  });

  it("refuses inline connection strings (credential safety)", async () => {
    const r = await sql().execute({ connection: "postgres://u:p@h/db", sql: "SELECT 1" }, ctx);
    expect(r.success).toBe(false);
    expect(r.error).toContain("Inline connection strings are not allowed");
  });

  it("rejects a malformed alias and an unconfigured alias", async () => {
    const bad = await sql().execute({ connection: "1bad", sql: "SELECT 1" }, ctx);
    expect(bad.error).toContain("Invalid alias");
    const unknown = await sql().execute({ connection: "missingalias", sql: "SELECT 1" }, ctx);
    expect(unknown.error).toContain("No connection configured");
  });

  it("rejects an unsupported dialect resolved from env", async () => {
    const r = await sql().execute({ connection: "badscheme", sql: "SELECT 1" }, ctx);
    expect(r.success).toBe(false);
    expect(r.error).toContain("Unsupported dialect");
  });

  it("runs a postgres query and tabulates the rows", async () => {
    const r = await sql().execute({ connection: "test", sql: "SELECT id, name FROM users", params: [] }, ctx);
    expect(r.success).toBe(true);
    expect(r.metadata?.["dialect"]).toBe("postgres");
    expect(r.metadata?.["rowCount"]).toBe(1);
    expect(r.metadata?.["columns"]).toEqual(["id", "name"]);
    expect(r.output).toContain("Ann");
  });

  it("redacts credentials from a driver error message", async () => {
    const r = await sql().execute({ connection: "test", sql: "SELECT BOOM" }, ctx);
    expect(r.success).toBe(false);
    expect(r.error).toContain("[redacted]");
    expect(r.error).not.toContain("secret");
  });
});
