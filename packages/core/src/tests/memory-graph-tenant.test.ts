import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryRecord } from "../memory/service.js";

/**
 * WORKSPACE MEMORY STAYS WITH ITS ACCOUNT IN THE GRAPH (found 2026-10-07).
 *
 * Under multi-user auth a workspace-scope record is stored in its writer's own root,
 * <workspace>/users/<segment>/, but its graph node carried no tenant, and the "Critical Memory"
 * block every turn injects returned every account's workspace decisions and preferences.
 */
const { isGraphDbAvailable, runCypher, toPlainRecords } = vi.hoisted(() => ({
  isGraphDbAvailable: vi.fn(() => true),
  runCypher: vi.fn(async (_query: string, _params?: Record<string, unknown>) => ({}) as unknown),
  toPlainRecords: vi.fn(() => [] as Record<string, unknown>[]),
}));
vi.mock("../db/neo4j.js", () => ({ isGraphDbAvailable, runCypher, toPlainRecords }));

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem-1", scope: "workspace", kind: "preference", ownerType: "workspace", ownerId: "workspace",
    subject: "Tee", content: "Bevorzugt Polarstern-Rooibos.", tags: [], source: "test",
    createdAt: "2026-10-07T00:00:00Z", updatedAt: "2026-10-07T00:00:00Z", ...overrides,
  };
}

// One config file for the whole file: the loader fixes its path at first import, so the tests
// rewrite the file and reload it rather than re-importing every module.
const tempDir = mkdtempSync(join(tmpdir(), "starlingai-graph-tenant-"));
const configPath = join(tempDir, "starlingai.json");
process.env["SAI_CONFIG_PATH"] = configPath;

describe("workspace-scope graph nodes are partitioned by account", () => {
  async function load(authEnabled: boolean) {
    writeFileSync(configPath, JSON.stringify({
      auth: authEnabled
        ? { enabled: true, users: [{ username: "alice", passwordHash: "scrypt$placeholder-hash-not-used-here", role: "operator", createdAt: "2026-10-07T00:00:00Z" }] }
        : { enabled: false },
    }), "utf8");
    // Sequential: these modules import each other, and parallel first imports can deadlock.
    const loader = await import("../config/loader.js");
    const context = await import("../runtime/request-context.js");
    const scope = await import("../runtime/user-scope.js");
    const graph = await import("../memory/graph-service.js");
    loader.resetConfigForTests();
    loader.loadConfig();
    return { graph, context, scope };
  }

  const mergeParams = () => runCypher.mock.calls
    .filter(([query]) => String(query).includes("MERGE (m:MemoryRecord"))
    .map(([, params]) => params as Record<string, unknown>);

  beforeEach(() => {
    isGraphDbAvailable.mockReturnValue(true);
    runCypher.mockReset().mockResolvedValue({});
    toPlainRecords.mockReset().mockReturnValue([]);
  });

  afterAll(async () => {
    (await import("../config/loader.js")).resetConfigForTests();
    delete process.env["SAI_CONFIG_PATH"];
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("tags a workspace node with the account whose root stores it, or as shared", async () => {
    const { graph, scope } = await load(true);
    const alice = scope.safeUserSegment("alice");
    await graph.upsertMemoryToGraph(record(), undefined, undefined, null, join("/workspace", "users", alice, ".starlingai", "memory"));
    await graph.upsertMemoryToGraph(record({ id: "mem-2" }), undefined, undefined, null, "C:\\workspace\\.starlingai\\memory");
    expect(mergeParams().map((p) => p["tenant"])).toEqual([alice, graph.SHARED_WORKSPACE_TENANT]);
  });

  it("injects only the reader's own and the shared workspace preferences", async () => {
    const { graph, context, scope } = await load(true);
    toPlainRecords.mockReturnValue([{ id: "mem-1", kind: "preference", content: "Bevorzugt Polarstern-Rooibos." }]);
    await context.runWithRequestContext({ userId: "alice" }, () => graph.graphL0Layer());
    await context.runWithRequestContext({ userId: "bob" }, () => graph.graphL0Layer());

    const reads = runCypher.mock.calls.filter(([query]) => String(query).includes("['decision', 'preference']"));
    // One query per reader: a cached block is never served across accounts.
    expect(reads).toHaveLength(2);
    const [aliceRead, bobRead] = reads.map(([query, params]) => ({ query: String(query), params: params as Record<string, unknown> }));
    expect(aliceRead!.params["workspaceTenant"]).toBe(scope.safeUserSegment("alice"));
    expect(bobRead!.params["workspaceTenant"]).toBe(scope.safeUserSegment("bob"));
    expect(aliceRead!.params["sharedTenant"]).toBe(graph.SHARED_WORKSPACE_TENANT);
    // The workspace branch of the filter is gated on the tenant, not open to every node.
    expect(aliceRead!.query.replace(/\s+/g, " ")).toContain(
      "m.scope = 'workspace' AND ($workspaceTenant IS NULL OR m.tenant = $workspaceTenant OR m.tenant = $sharedTenant)",
    );
  });

  it("leaves a single-operator install unpartitioned", async () => {
    const { graph, context } = await load(false);
    await graph.upsertMemoryToGraph(record(), undefined, undefined, null, join("/workspace", ".starlingai", "memory"));
    await context.runWithRequestContext({ userId: "alice" }, () => graph.graphL0Layer());
    expect(mergeParams()[0]!["tenant"]).toBeNull();
    const read = runCypher.mock.calls.find(([query]) => String(query).includes("['decision', 'preference']"));
    expect((read![1] as Record<string, unknown>)["workspaceTenant"]).toBeNull();
  });
});
