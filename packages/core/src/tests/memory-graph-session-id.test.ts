import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryRecord } from "../memory/service.js";

/**
 * THE GRAPH DOES NOT HAND ONE ACCOUNT ANOTHER'S SESSION IDS (found in review, 2026-10-08).
 *
 * MemGraph is one instance for every account. A memory write made a Session node with the session
 * id, a fact promotion did too, and every retrieval recorded the session id on a RETRIEVED edge:
 * graph_query could project them as plain strings and the graph inspector listed the Session nodes,
 * to any account. A session id is what a run names to work in that session's shared facts. Under
 * multi-user auth the graph now holds a digest of the id instead; the retrieval feedback loop finds
 * the edges by the same digest.
 */
const { isGraphDbAvailable, runCypher, toPlainRecords } = vi.hoisted(() => ({
  isGraphDbAvailable: vi.fn(() => true),
  runCypher: vi.fn(async (_query: string, _params?: Record<string, unknown>) => ({}) as unknown),
  toPlainRecords: vi.fn(() => [] as Record<string, unknown>[]),
}));
vi.mock("../db/neo4j.js", () => ({ isGraphDbAvailable, runCypher, toPlainRecords }));

const ALICE_SESSION = "4f1c2b7e-9a51-4d0e-8c3f-alice-web-session";
const BOB_SESSION = "7d3e8a20-1b64-4c9f-a2d5-bob-web-session";

const tempDir = mkdtempSync(join(tmpdir(), "starlingai-graph-session-id-"));
const configPath = join(tempDir, "starlingai.json");
process.env["SAI_CONFIG_PATH"] = configPath;

function record(): MemoryRecord {
  return {
    id: "mem-1", scope: "user", kind: "preference", ownerType: "user", ownerId: "user",
    subject: "Kanzlei", content: "Bevorzugt die Kanzlei Nordhafen.", tags: [], source: "test",
    createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z",
  };
}

/** Every value a query was sent, however deep: what the graph would store or match. */
function sentValues(): string[] {
  const values: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") values.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  for (const [, params] of runCypher.mock.calls) walk(params);
  return values;
}

/** The session parameter of each query that names a session. */
function sessionParams(): Record<string, unknown> {
  const find = (pattern: RegExp) => runCypher.mock.calls.find(([query]) => pattern.test(String(query)))?.[1]?.["sessionId"];
  return {
    produced: find(/MERGE \(s\)-\[:PRODUCED\]->\(m\)\s*$/),
    promoted: find(/m\.kind\s+= 'fact'/),
    retrieved: find(/CREATE \(a\)-\[:RETRIEVED/),
    useful: find(/SET ret\.wasUseful = true/),
    unhelpful: find(/SET ret\.wasUseful = false/),
  };
}

describe("session ids in the shared memory graph", () => {
  async function load(authEnabled: boolean) {
    writeFileSync(configPath, JSON.stringify({ auth: { enabled: authEnabled } }), "utf8");
    // Sequential: these modules import each other, and parallel first imports can deadlock.
    const loader = await import("../config/loader.js");
    const context = await import("../runtime/request-context.js");
    const graph = await import("../memory/graph-service.js");
    loader.resetConfigForTests();
    loader.loadConfig();
    return { context, graph };
  }

  /** What Alice's turn writes about her session: a memory, a promoted fact, a retrieval, and the
   *  feedback loop closing it both ways. */
  async function aliceTurn(graph: Awaited<ReturnType<typeof load>>["graph"], context: Awaited<ReturnType<typeof load>>["context"]) {
    await context.runWithRequestContext({ userId: "alice" }, async () => {
      await graph.upsertMemoryToGraph(record(), "researcher", ALICE_SESSION, null);
      await graph.graphPromoteFact("custody_lawyer", "Alice retained Kanzlei Nordhafen", "researcher", ALICE_SESSION);
      await graph.graphTrackRetrieval("mem-1", "researcher", ALICE_SESSION, 1);
      await graph.graphMarkSessionRetrievalsUseful(ALICE_SESSION);
      await graph.graphMarkSessionRetrievalsUnhelpful(ALICE_SESSION);
    });
  }

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

  it("under multi-user auth, stores no session id, and finds a session's retrievals by the digest it stored", async () => {
    const { graph, context } = await load(true);
    await aliceTurn(graph, context);

    for (const value of sentValues()) expect(value).not.toContain(ALICE_SESSION);
    const params = sessionParams();
    const digest = graph.graphSessionId(ALICE_SESSION);
    expect(digest).not.toContain(ALICE_SESSION);
    // One digest for every query that names the session: the Session node, the RETRIEVED edge,
    // and the feedback loop's match.
    expect(params).toEqual({ produced: digest, promoted: digest, retrieved: digest, useful: digest, unhelpful: digest });
    expect(graph.graphSessionId(BOB_SESSION)).not.toBe(digest);
  });

  it("with one operator, stores the session id as before", async () => {
    const { graph, context } = await load(false);
    await aliceTurn(graph, context);

    expect(sessionParams()).toEqual({
      produced: ALICE_SESSION, promoted: ALICE_SESSION, retrieved: ALICE_SESSION, useful: ALICE_SESSION, unhelpful: ALICE_SESSION,
    });
  });
});
