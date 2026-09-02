import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { withPromotedAgents, writePromotedAgents } from "../agent/promoted-agents.js";

const AGENT = {
  description: "Reads invoices and extracts totals.",
  capabilities: ["invoice extraction"],
  tags: ["finance"],
  tools: ["read_file"],
  maxIterations: 4,
};

/**
 * Promoted agents were merged into routing at query time but never into the embedding index, so
 * a promoted agent could win keyword routing and still never appear as a semantic candidate.
 */
describe("the semantic agent index covers promoted agents", () => {
  const root = mkdtempSync(join(tmpdir(), "promoted-index-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("merges the promoted catalog under the configured one", () => {
    writePromotedAgents(root, {
      invoice_reader: AGENT as never,
      researcher: { ...AGENT, description: "promoted copy" } as never,
    });
    const merged = withPromotedAgents({ researcher: { ...AGENT, description: "configured copy" } as never }, root);
    expect(Object.keys(merged).sort()).toEqual(["invoice_reader", "researcher"]);
    expect(merged["researcher"]?.description).toBe("configured copy");   // a configured name wins a clash
  });

  it("is the configured catalog alone when nothing was promoted", () => {
    const empty = mkdtempSync(join(tmpdir(), "promoted-none-"));
    try {
      expect(Object.keys(withPromotedAgents({ researcher: AGENT as never }, empty))).toEqual(["researcher"]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
