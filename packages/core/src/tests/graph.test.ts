import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ToolContext, ToolHandler } from "../tools/registry.js";

// Mock the neo4j layer so the tools' guard passes and we exercise the real
// validation + Cypher-building logic without a live database.
const { isGraphDbAvailable, runCypher, toPlainRecords } = vi.hoisted(() => ({
  isGraphDbAvailable: vi.fn(() => true),
  runCypher: vi.fn(async () => ({}) as unknown),
  toPlainRecords: vi.fn(() => [] as Record<string, unknown>[]),
}));
vi.mock("../db/neo4j.js", () => ({ isGraphDbAvailable, runCypher, toPlainRecords }));

const { getTool } = await import("../tools/registry.js");
await import("../tools/graph.js"); // registers graph_* tools

const ctx = {} as unknown as ToolContext;
const t = (name: string): ToolHandler => {
  const h = getTool(name);
  if (!h) throw new Error(`tool ${name} not registered`);
  return h;
};

describe("graph tools", () => {
  beforeEach(() => {
    isGraphDbAvailable.mockReturnValue(true);
    runCypher.mockReset().mockResolvedValue({});
    toPlainRecords.mockReset().mockReturnValue([]);
  });

  it("returns the not-available result when no graph DB is configured", async () => {
    isGraphDbAvailable.mockReturnValue(false);
    const r = await t("graph_upsert_entity").execute({ label: "Person", name: "Ann" }, ctx);
    expect(r.success).toBe(false);
    expect(runCypher).not.toHaveBeenCalled();
  });

  it("graph_upsert_entity validates and then writes", async () => {
    expect((await t("graph_upsert_entity").execute({ label: "Person" }, ctx)).success).toBe(false); // no name
    toPlainRecords.mockReturnValue([{ name: "Ann", labels: ["Person"] }]);
    const ok = await t("graph_upsert_entity").execute({ label: "Person", name: "Ann", properties: { age: 30, "bad key!": "x" } }, ctx);
    expect(ok.success).toBe(true);
    expect(runCypher).toHaveBeenCalledWith(expect.stringContaining("MERGE (n:Person"), expect.anything(), { write: true });
  });

  it("graph_relate requires all endpoints", async () => {
    expect((await t("graph_relate").execute({ fromLabel: "A", fromName: "a", relationship: "R", toLabel: "B" }, ctx)).success).toBe(false);
    const ok = await t("graph_relate").execute(
      { fromLabel: "Person", fromName: "Ann", relationship: "works at", toLabel: "Company", toName: "Acme", createIfMissing: true },
      ctx,
    );
    expect(ok.success).toBe(true);
    // relationship is upper-snake sanitized and createIfMissing → MERGE on endpoints
    expect(runCypher).toHaveBeenCalledWith(expect.stringContaining("WORKS_AT"), expect.anything(), { write: true });
  });

  it("graph_query blocks write keywords and runs read queries", async () => {
    expect((await t("graph_query").execute({}, ctx)).success).toBe(false); // no cypher
    const blocked = await t("graph_query").execute({ cypher: "MATCH (n) DELETE n" }, ctx);
    expect(blocked.success).toBe(false);
    expect(blocked.error).toContain("Blocked keyword");
    expect(runCypher).not.toHaveBeenCalled();

    toPlainRecords.mockReturnValue([{ name: "Ann" }]);
    const ok = await t("graph_query").execute({ cypher: "MATCH (p:Person) RETURN p LIMIT 10" }, ctx);
    expect(ok.success).toBe(true);
    expect(runCypher).toHaveBeenCalledWith(expect.any(String), expect.anything(), { write: false });
  });

  it("graph_find_paths reports no-path and formatted paths", async () => {
    const none = await t("graph_find_paths").execute({ fromLabel: "Person", fromName: "Ann", toLabel: "Person", toName: "Bo" }, ctx);
    expect(none.success).toBe(true);
    expect(none.output).toContain("No path found");

    toPlainRecords.mockReturnValue([{ nodes: [{ name: "Ann", labels: ["Person"] }, { name: "Bo", labels: ["Person"] }], relationships: ["KNOWS"] }]);
    const found = await t("graph_find_paths").execute({ fromLabel: "Person", fromName: "Ann", toLabel: "Person", toName: "Bo" }, ctx);
    expect(found.success).toBe(true);
    expect(found.output).toContain("KNOWS");
  });

  it("graph_delete_node validates then deletes", async () => {
    expect((await t("graph_delete_node").execute({ label: "Person" }, ctx)).success).toBe(false);
    const ok = await t("graph_delete_node").execute({ label: "Person", name: "Ann" }, ctx);
    expect(ok.success).toBe(true);
    expect(runCypher).toHaveBeenCalled();
  });
});
