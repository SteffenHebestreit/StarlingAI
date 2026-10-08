import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * THE SLEEP-TIME SWEEP KEEPS THE ACCOUNT OF A NODE IT MERGES INTO (found in review, 2026-10-08).
 *
 * Under multi-user auth the sweep compacts each account's user-memory bucket in a context that names
 * the bucket and not the user. The record two near-duplicates merged into was stored again, and its
 * graph node's tenant was set to null: the account lost its own preference from the Critical Memory
 * block, the graph inspector and graph_query, which read a user node only for its own user.
 *
 * The graph here is a map of MemoryRecord nodes that applies the upsert's MERGE and SET the way the
 * database does, so the test reads the tenant the node is left with, whatever the query looks like.
 */
const { nodes, isGraphDbAvailable, runCypher, toPlainRecords } = vi.hoisted(() => {
  const nodes = new Map<string, Record<string, unknown>>();
  /** One SET item's value: a parameter, a property of the node, a number, or coalesce() of those. */
  const evaluate = (expression: string, node: Record<string, unknown>, params: Record<string, unknown>): unknown => {
    const text = expression.trim();
    const coalesce = /^coalesce\((.+),\s*(.+)\)$/.exec(text);
    if (coalesce) return evaluate(coalesce[1]!, node, params) ?? evaluate(coalesce[2]!, node, params);
    if (text.startsWith("$")) return params[text.slice(1)] ?? null;
    if (text.startsWith("m.")) return node[text.slice(2)] ?? null;
    if (/^[0-9.]+$/.test(text)) return Number(text);
    throw new Error(`the test graph cannot evaluate ${text}`);
  };
  const runCypher = vi.fn(async (query: string, params: Record<string, unknown> = {}) => {
    if (/MATCH \(m:MemoryRecord \{id: \$id\}\) DETACH DELETE m/.test(query)) {
      nodes.delete(String(params["id"]));
      return {};
    }
    const upsert = /MERGE \(m:MemoryRecord \{id: \$id\}\)\s+SET ([\s\S]+)$/.exec(query.trim());
    if (upsert) {
      const id = String(params["id"]);
      const before = nodes.get(id) ?? { id };
      // SET items are evaluated against the node as the MERGE found it.
      const after = { ...before };
      for (const item of upsert[1]!.split(/,\s*\n/)) {
        const assignment = /^m\.(\w+)\s*=\s*([\s\S]+)$/.exec(item.trim());
        if (!assignment) throw new Error(`the test graph cannot apply ${item}`);
        after[assignment[1]!] = evaluate(assignment[2]!, before, params);
      }
      nodes.set(id, after);
    }
    return {};
  });
  return {
    nodes,
    isGraphDbAvailable: vi.fn(() => true),
    runCypher,
    toPlainRecords: vi.fn(() => [] as Record<string, unknown>[]),
  };
});
vi.mock("../db/neo4j.js", () => ({ isGraphDbAvailable, runCypher, toPlainRecords }));

const tempDir = mkdtempSync(join(tmpdir(), "starlingai-graph-sweep-"));
const workspacePath = join(tempDir, "workspace");
mkdirSync(workspacePath, { recursive: true });
const configPath = join(tempDir, "starlingai.json");
process.env["SAI_CONFIG_PATH"] = configPath;
process.env["SAI_USER_MEMORY_PATH"] = join(tempDir, "user-memory");

describe("the sleep-time sweep and the account of a merged memory node", () => {
  async function load(authEnabled: boolean) {
    writeFileSync(configPath, JSON.stringify({
      workspacePath,
      auth: authEnabled
        ? { enabled: true, users: [{ username: "alice", passwordHash: "scrypt$placeholder-hash-not-used-here", role: "operator", createdAt: "2026-10-08T00:00:00Z" }] }
        : { enabled: false },
    }), "utf8");
    // Sequential: these modules import each other, and parallel first imports can deadlock.
    const loader = await import("../config/loader.js");
    const context = await import("../runtime/request-context.js");
    const memory = await import("../memory/service.js");
    const driver = await import("../memory/driver.js");
    const graph = await import("../memory/graph-service.js");
    loader.resetConfigForTests();
    loader.loadConfig();
    memory._clearDurableMemoryCaches();
    return { context, memory, driver, graph };
  }

  /** Two near-duplicate preferences of Alice's, stored as Alice; the ids of their nodes. */
  async function seedAlice(context: Awaited<ReturnType<typeof load>>["context"], memory: Awaited<ReturnType<typeof load>>["memory"]) {
    return context.runWithRequestContext({ userId: "alice" }, async () => [
      memory.storeUserMemoryRecord(workspacePath, {
        key: "quality_summary", subject: "Quality goal", content: "Prefer retrieval precision over raw memory volume.", kind: "preference",
      }).id,
      memory.storeUserMemoryRecord(workspacePath, {
        key: "quality_detail", subject: "Quality goal", content: "Keep durable memory focused on retrieval precision instead of accumulating every temporary note.", kind: "preference",
      }).id,
    ]);
  }

  beforeEach(() => {
    nodes.clear();
    isGraphDbAvailable.mockReturnValue(true);
    runCypher.mockClear();
    rmSync(join(tempDir, "user-memory"), { recursive: true, force: true });
  });

  afterAll(async () => {
    (await import("../config/loader.js")).resetConfigForTests();
    delete process.env["SAI_CONFIG_PATH"];
    delete process.env["SAI_USER_MEMORY_PATH"];
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("under multi-user auth, the node the duplicates merge into stays the account's own", async () => {
    const { context, memory, driver, graph } = await load(true);
    const ids = await seedAlice(context, memory);
    expect(ids.map((id) => nodes.get(id)?.["tenant"])).toEqual(["alice", "alice"]);

    // The sweep runs with no request context, as its interval does.
    const swept = await driver.runMemoryConsolidationSweep(workspacePath);
    expect(swept).toMatchObject({ merged: 1, removed: 1 });

    await vi.waitFor(() => expect(nodes.size).toBe(1));
    const [survivor] = [...nodes.values()];
    expect(ids).toContain(survivor!["id"]);
    expect(survivor!["tenant"]).toBe("alice");
    // Readable by its account under the rule of the graph inspector and graph_query.
    const aliceReader = context.runWithRequestContext({ userId: "alice" }, () => graph.graphMemoryReader())!;
    expect(graph.isGraphMemoryReadable(["MemoryRecord"], survivor!, aliceReader)).toBe(true);
  });

  it("with one operator, the sweep's write leaves the node without a tenant, as before", async () => {
    const { context, memory, driver } = await load(false);
    await seedAlice(context, memory);

    expect((await driver.runMemoryConsolidationSweep(workspacePath)).merged).toBe(1);

    await vi.waitFor(() => expect(nodes.size).toBe(1));
    expect([...nodes.values()][0]!["tenant"]).toBeNull();
  });
});
