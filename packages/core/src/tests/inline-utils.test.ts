import { beforeAll, describe, expect, it } from "vitest";
import { getTool, type ToolHandler } from "../tools/registry.js";
import "../tools/inline-utils.js"; // registers the Tier-0 inline tools

function tool(name: string): ToolHandler {
  const t = getTool(name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
}

describe("inline-utils Tier-0 tools", () => {
  beforeAll(() => { void import("../tools/inline-utils.js"); });

  describe("datetime_arithmetic", () => {
    const dt = () => tool("datetime_arithmetic");
    it("adds a duration", async () => {
      const r = await dt().execute({ operation: "add", base: "2026-01-01T00:00:00.000Z", duration: "5d" }, {} as never);
      expect(r.success).toBe(true);
      expect(r.output).toBe("2026-01-06T00:00:00.000Z");
    });
    it("subtracts a duration", async () => {
      const r = await dt().execute({ operation: "subtract", base: "2026-01-10T00:00:00.000Z", duration: "2 days" }, {} as never);
      expect(r.output).toBe("2026-01-08T00:00:00.000Z");
    });
    it("computes a diff in days", async () => {
      const r = await dt().execute({ operation: "diff", base: "2026-01-01T00:00:00.000Z", target: "2026-01-08T00:00:00.000Z", unit: "days" }, {} as never);
      expect(r.output).toBe("7 days");
      expect(r.metadata?.["value"]).toBe(7);
    });
    it("is calendar-aware for months", async () => {
      const r = await dt().execute({ operation: "add", base: "2026-01-15T00:00:00.000Z", duration: "1 mo" }, {} as never);
      expect(r.output.startsWith("2026-02-15")).toBe(true);
    });
    it("formats/parses a date", async () => {
      const r = await dt().execute({ operation: "format", base: "2026-03-04T05:06:07.000Z" }, {} as never);
      expect(r.success).toBe(true);
      expect(r.output).toBe("2026-03-04T05:06:07.000Z");
    });
    it("rejects unknown operation, bad base, bad duration", async () => {
      expect((await dt().execute({ operation: "nope" }, {} as never)).success).toBe(false);
      expect((await dt().execute({ operation: "add", base: "not-a-date", duration: "5d" }, {} as never)).success).toBe(false);
      expect((await dt().execute({ operation: "add", base: "2026-01-01T00:00:00Z", duration: "5 lightyears" }, {} as never)).success).toBe(false);
    });
  });

  describe("json_query", () => {
    const jq = () => tool("json_query");
    const doc = { users: [{ name: "Ann", "first.name": "A" }, { name: "Bo" }] };
    it("walks dot + index paths (string input)", async () => {
      const r = await jq().execute({ json: JSON.stringify(doc), path: "users[0].name" }, {} as never);
      expect(r.success).toBe(true);
      expect(r.output).toBe("Ann");
    });
    it("accepts an already-parsed object", async () => {
      const r = await jq().execute({ json: doc, path: "users[-1].name" }, {} as never);
      expect(r.output).toBe("Bo");
    });
    it("splat returns the array elements as-is (trailing path is ignored)", async () => {
      const r = await jq().execute({ json: doc, path: "users[*]" }, {} as never);
      expect(JSON.parse(r.output)).toEqual(doc.users);
    });
    it("supports quoted bracket keys with dots", async () => {
      const r = await jq().execute({ json: doc, path: 'users[0]["first.name"]' }, {} as never);
      expect(r.output).toBe("A");
    });
    it("returns the whole doc for '$'", async () => {
      const r = await jq().execute({ json: doc, path: "$" }, {} as never);
      expect(JSON.parse(r.output)).toEqual(doc);
    });
    it("fails on invalid JSON and on splat over a non-array", async () => {
      expect((await jq().execute({ json: "{bad", path: "$" }, {} as never)).success).toBe(false);
      expect((await jq().execute({ json: doc, path: "users[0][*]" }, {} as never)).success).toBe(false);
    });
  });

  describe("regex_test", () => {
    const rt = () => tool("regex_test");
    it("returns matches with capture groups + offsets", async () => {
      const r = await rt().execute({ pattern: "(\\d+)-(\\d+)", text: "a 12-34 b 56-78" }, {} as never);
      expect(r.success).toBe(true);
      const matches = r.metadata?.["matches"] as Array<{ match: string; groups: string[] }>;
      expect(matches).toHaveLength(2);
      expect(matches[0]!.groups).toEqual(["12", "34"]);
    });
    it("reports no matches cleanly", async () => {
      const r = await rt().execute({ pattern: "zzz", text: "abc" }, {} as never);
      expect(r.output).toBe("No matches.");
      expect(r.metadata?.["matchCount"]).toBe(0);
    });
    it("does not infinite-loop on a zero-width pattern", async () => {
      const r = await rt().execute({ pattern: "a*", text: "aaa", maxMatches: 10 }, {} as never);
      expect(r.success).toBe(true);
    });
    it("fails on missing pattern and on invalid regex", async () => {
      expect((await rt().execute({ pattern: "", text: "x" }, {} as never)).success).toBe(false);
      expect((await rt().execute({ pattern: "(", text: "x" }, {} as never)).success).toBe(false);
    });
  });

  describe("text_diff", () => {
    const td = () => tool("text_diff");
    it("reports identical text", async () => {
      const r = await td().execute({ before: "a\nb", after: "a\nb" }, {} as never);
      expect(r.output).toBe("(no differences)");
      expect(r.metadata?.["identical"]).toBe(true);
    });
    it("counts added and deleted lines", async () => {
      const r = await td().execute({ before: "a\nb\nc", after: "a\nB\nc" }, {} as never);
      expect(r.metadata?.["added"]).toBe(1);
      expect(r.metadata?.["deleted"]).toBe(1);
      expect(r.output).toContain("+ B");
      expect(r.output).toContain("- b");
    });
  });

  describe("hash_compute", () => {
    const hc = () => tool("hash_compute");
    it("computes a known sha256 digest", async () => {
      const r = await hc().execute({ text: "abc", algorithm: "sha256" }, {} as never);
      expect(r.output).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    });
    it("computes a known md5 digest", async () => {
      const r = await hc().execute({ text: "abc", algorithm: "md5" }, {} as never);
      expect(r.output).toBe("900150983cd24fb0d6963f7d28e17f72");
    });
    it("truncates the digest when asked", async () => {
      const r = await hc().execute({ text: "abc", truncate: 8 }, {} as never);
      expect(r.output).toBe("ba7816bf");
      expect(r.metadata?.["truncated"]).toBe(true);
    });
    it("fails on an unknown algorithm", async () => {
      expect((await hc().execute({ text: "abc", algorithm: "notahash" }, {} as never)).success).toBe(false);
    });
  });

  it("registers url_inspect", () => {
    expect(getTool("url_inspect")).toBeDefined();
  });
});
