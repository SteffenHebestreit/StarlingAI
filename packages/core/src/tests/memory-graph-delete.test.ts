import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A DURABLE RECORD THAT IS DELETED LEAVES THE GRAPH TOO (found 2026-10-08).
 *
 * Deleting a record removed its file and left its MemGraph node, and the "Critical Memory" block
 * (graphL0Layer) serves a tenant's decision and preference nodes without looking at any file: after
 * the e2e harness had emptied eval's memory, two orphaned "Polarstern-Rooibos" preference nodes of
 * eval were still there to inject, one more with every run. A compaction that merges duplicates away
 * removes their files the same way.
 */
const { isGraphDbAvailable, runCypher, toPlainRecords } = vi.hoisted(() => ({
  isGraphDbAvailable: vi.fn(() => true),
  runCypher: vi.fn(async (_query: string, _params?: Record<string, unknown>) => ({}) as unknown),
  toPlainRecords: vi.fn(() => [] as Record<string, unknown>[]),
}));
vi.mock("../db/neo4j.js", () => ({ isGraphDbAvailable, runCypher, toPlainRecords }));

const tempDir = mkdtempSync(join(tmpdir(), "starlingai-graph-delete-"));
const workspacePath = join(tempDir, "workspace");
const userMemoryPath = join(tempDir, "user-memory");
mkdirSync(workspacePath, { recursive: true });
const configPath = join(tempDir, "starlingai.json");
writeFileSync(configPath, JSON.stringify({
  workspacePath,
  auth: { enabled: true, users: [{ username: "alice", passwordHash: "scrypt$placeholder-hash-not-used-here", role: "operator", createdAt: "2026-10-07T00:00:00Z" }] },
}), "utf8");
process.env["SAI_CONFIG_PATH"] = configPath;
process.env["SAI_USER_MEMORY_PATH"] = userMemoryPath;

describe("deleted durable records leave the memory graph", () => {
  async function load() {
    // Sequential: these modules import each other, and parallel first imports can deadlock.
    const loader = await import("../config/loader.js");
    const context = await import("../runtime/request-context.js");
    const memory = await import("../memory/service.js");
    const graph = await import("../memory/graph-service.js");
    loader.resetConfigForTests();
    loader.loadConfig();
    return { context, memory, graph };
  }

  /** Ids of the MemoryRecord nodes the code asked the graph to delete. */
  const graphDeletes = () => runCypher.mock.calls
    .filter(([query]) => /DETACH DELETE/.test(String(query)) && /MemoryRecord/.test(String(query)))
    .map(([, params]) => (params as Record<string, unknown>)["id"]);

  beforeEach(() => {
    isGraphDbAvailable.mockReturnValue(true);
    runCypher.mockReset().mockResolvedValue({});
    toPlainRecords.mockReset().mockReturnValue([]);
  });

  afterAll(async () => {
    (await import("../config/loader.js")).resetConfigForTests();
    delete process.env["SAI_CONFIG_PATH"];
    delete process.env["SAI_USER_MEMORY_PATH"];
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("deletes the node of a deleted record, and the Critical Memory block stops serving it at once", async () => {
    const { context, memory, graph } = await load();
    await context.runWithRequestContext({ userId: "alice" }, async () => {
      const record = memory.storeUserMemoryRecord(workspacePath, {
        key: "lieblingstee", subject: "Tee", content: "Lieblingsteesorte: Polarstern-Rooibos", kind: "preference",
      });
      toPlainRecords.mockReturnValue([{ id: record.id, kind: "preference", content: record.content }]);
      expect(await graph.graphL0Layer()).toContain("Polarstern-Rooibos");

      expect(memory.deleteUserMemoryRecord(workspacePath, "lieblingstee")).toBe(true);
      await vi.waitFor(() => expect(graphDeletes()).toEqual([record.id]));
      // The block is cached for a minute; a deleted preference must not ride on the cache.
      toPlainRecords.mockReturnValue([]);
      expect(await graph.graphL0Layer()).toBe("");
    });
  });

  it("deletes the nodes of the duplicates a compaction merges away", async () => {
    const { context, memory } = await load();
    await context.runWithRequestContext({ userId: "alice" }, async () => {
      const stored = [
        memory.storeWorkspaceMemoryRecord(workspacePath, {
          key: "quality_summary", subject: "Quality goal", content: "Prefer retrieval precision over raw memory volume.", kind: "summary",
        }),
        memory.storeWorkspaceMemoryRecord(workspacePath, {
          key: "quality_detail", subject: "Quality goal", content: "Keep durable memory focused on retrieval precision instead of accumulating every temporary note.", kind: "decision",
        }),
      ];
      expect(memory.compactWorkspaceMemoryRecords(workspacePath).removed).toBe(1);
      const kept = new Set(memory.listWorkspaceMemoryRecords(workspacePath).map((record) => record.id));
      const mergedAway = stored.map((record) => record.id).filter((id) => !kept.has(id));
      expect(mergedAway).toHaveLength(1);
      await vi.waitFor(() => expect(graphDeletes()).toEqual(mergedAway));
    });
  });
});
