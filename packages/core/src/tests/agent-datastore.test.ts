import { describe, expect, it } from "vitest";
import { getTool, type ToolContext, type ToolHandler } from "../tools/registry.js";
import "../tools/agent-datastore.js"; // registers agent_store_* tools

const ctx = { sessionId: "ds-test" } as unknown as ToolContext;
const t = (name: string): ToolHandler => {
  const h = getTool(name);
  if (!h) throw new Error(`tool ${name} not registered`);
  return h;
};
const NS = "agent-kv"; // routes to the in-memory fallback when no redis/postgres

describe("agent-datastore tools", () => {
  describe("validation (no backend needed)", () => {
    it("write rejects missing namespace / key, oversized key / value", async () => {
      const w = t("agent_store_write");
      expect((await w.execute({ key: "k", value: "v" }, ctx)).success).toBe(false);
      expect((await w.execute({ namespace: NS, value: "v" }, ctx)).success).toBe(false);
      expect((await w.execute({ namespace: NS, key: "x".repeat(513), value: "v" }, ctx)).success).toBe(false);
      expect((await w.execute({ namespace: NS, key: "k", value: "x".repeat(1_048_577) }, ctx)).success).toBe(false);
    });
    it("read rejects missing namespace; delete rejects missing namespace/key", async () => {
      expect((await t("agent_store_read").execute({}, ctx)).success).toBe(false);
      expect((await t("agent_store_delete").execute({ namespace: NS }, ctx)).success).toBe(false);
      expect((await t("agent_store_delete").execute({ key: "k" }, ctx)).success).toBe(false);
    });
  });

  describe("round-trip via the in-memory fallback", () => {
    it("write → read(exact) → query(prefix) → delete → read(gone)", async () => {
      const base = `rt:${Date.now()}:`;
      const key = `${base}one`;

      const wrote = await t("agent_store_write").execute({ namespace: NS, key, value: "hello-world" }, ctx);
      expect(wrote.success).toBe(true);
      expect(wrote.metadata?.["valueLength"]).toBe(11);

      const read = await t("agent_store_read").execute({ namespace: NS, key }, ctx);
      expect(read.success).toBe(true);
      expect(read.output).toBe("hello-world");
      expect(read.metadata?.["found"]).toBe(true);

      await t("agent_store_write").execute({ namespace: NS, key: `${base}two`, value: "second" }, ctx);
      const query = await t("agent_store_read").execute({ namespace: NS, keyPrefix: base }, ctx);
      expect(query.success).toBe(true);
      expect(query.metadata?.["count"]).toBe(2);

      const del = await t("agent_store_delete").execute({ namespace: NS, key }, ctx);
      expect(del.success).toBe(true);
      expect(del.metadata?.["deleted"]).toBe(true);

      const gone = await t("agent_store_read").execute({ namespace: NS, key }, ctx);
      expect(gone.metadata?.["found"]).toBe(false);
    });

    it("reading a missing key reports not-found without error", async () => {
      const r = await t("agent_store_read").execute({ namespace: NS, key: `missing:${Date.now()}` }, ctx);
      expect(r.success).toBe(true);
      expect(r.metadata?.["found"]).toBe(false);
    });
  });
});
