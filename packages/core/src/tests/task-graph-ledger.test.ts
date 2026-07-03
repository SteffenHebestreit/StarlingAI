import { afterEach, describe, expect, it } from "vitest";
import {
  computeTaskGraphNodeKey,
  parseTaskGraphLedger,
  upsertTaskGraphLedgerEntry,
  readTaskGraphLedger,
  recordCompletedTaskGraphNode,
  LEDGER_MAX_ENTRIES,
  LEDGER_OUTPUT_MAX,
  type TaskGraphLedger,
} from "../swarm/task-graph-ledger.js";
import { resetSharedMemoryForTests } from "../swarm/memory.js";

/**
 * Durable task-graph ledger (orchestration.durableTaskGraph). A turn that dies mid-graph
 * loses every completed node; the ledger lets a re-issued graph in the same session reuse
 * hash-matching completed nodes instead of re-running them.
 */
describe("task-graph ledger — node key (pure)", () => {
  it("is deterministic and dependency-order-insensitive", () => {
    const a = computeTaskGraphNodeKey({ id: "n2", task: "research X", dependsOn: ["n1", "n0"] });
    const b = computeTaskGraphNodeKey({ id: "n2", task: "research X", dependsOn: ["n0", "n1"] });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("changes when the task text, id, or dependency SET changes (re-plan invalidates reuse)", () => {
    const base = computeTaskGraphNodeKey({ id: "n1", task: "build the site" });
    expect(computeTaskGraphNodeKey({ id: "n1", task: "build the site v2" })).not.toBe(base);
    expect(computeTaskGraphNodeKey({ id: "n1b", task: "build the site" })).not.toBe(base);
    expect(computeTaskGraphNodeKey({ id: "n1", task: "build the site", dependsOn: ["n0"] })).not.toBe(base);
  });
});

describe("task-graph ledger — parse tolerance (pure)", () => {
  it("yields an empty ledger for null/corrupt/wrong-shape blobs, never throwing", () => {
    expect(parseTaskGraphLedger(null)).toEqual({});
    expect(parseTaskGraphLedger("not json {")).toEqual({});
    expect(parseTaskGraphLedger(JSON.stringify([1, 2]))).toEqual({});
    // entries missing required fields are dropped, valid ones kept
    const mixed = parseTaskGraphLedger(JSON.stringify({
      good: { nodeId: "n1", output: "done", completedAt: "2026-07-03T00:00:00Z" },
      bad: { output: 42 },
    }));
    expect(Object.keys(mixed)).toEqual(["good"]);
  });
});

describe("task-graph ledger — upsert caps (pure)", () => {
  it("truncates oversized outputs and caps artifacts", () => {
    const next = upsertTaskGraphLedgerEntry({}, "k1", {
      nodeId: "n1",
      output: "x".repeat(LEDGER_OUTPUT_MAX + 500),
      completedAt: "2026-07-03T00:00:00Z",
      artifacts: Array.from({ length: 9 }, (_, i) => ({ filename: `f${i}` })),
    });
    expect(next["k1"]!.output.length).toBe(LEDGER_OUTPUT_MAX);
    expect(next["k1"]!.artifacts!.length).toBeLessThanOrEqual(4);
  });

  it("evicts the OLDEST entries beyond the cap", () => {
    let ledger: TaskGraphLedger = {};
    for (let i = 0; i < LEDGER_MAX_ENTRIES + 3; i++) {
      ledger = upsertTaskGraphLedgerEntry(ledger, `k${i}`, {
        nodeId: `n${i}`,
        output: "done",
        completedAt: `2026-07-03T00:00:${String(i).padStart(2, "0")}Z`,
      });
    }
    expect(Object.keys(ledger).length).toBe(LEDGER_MAX_ENTRIES);
    expect(ledger["k0"]).toBeUndefined();  // oldest evicted
    expect(ledger[`k${LEDGER_MAX_ENTRIES + 2}`]).toBeDefined(); // newest kept
  });
});

describe("task-graph ledger — session storage round-trip (in-process fallback)", () => {
  afterEach(async () => {
    await resetSharedMemoryForTests();
  });

  it("records a completed node and reads it back for the same session only", async () => {
    await recordCompletedTaskGraphNode("sess-graph-1", "key-a", {
      nodeId: "research",
      output: "verified findings body",
      completedAt: "2026-07-03T10:00:00Z",
      artifacts: [{ filename: "report.md", relativePath: "out/report.md" }],
    });
    const ledger = await readTaskGraphLedger("sess-graph-1");
    expect(ledger["key-a"]?.output).toBe("verified findings body");
    expect(ledger["key-a"]?.artifacts?.[0]?.["filename"]).toBe("report.md");
    // Session-scoped: another session sees nothing.
    expect(await readTaskGraphLedger("sess-graph-2")).toEqual({});
  });

  it("accumulates entries across writes (a second completed node joins the first)", async () => {
    await recordCompletedTaskGraphNode("sess-graph-3", "key-1", { nodeId: "n1", output: "one", completedAt: "2026-07-03T10:00:00Z" });
    await recordCompletedTaskGraphNode("sess-graph-3", "key-2", { nodeId: "n2", output: "two", completedAt: "2026-07-03T10:01:00Z" });
    const ledger = await readTaskGraphLedger("sess-graph-3");
    expect(Object.keys(ledger).sort()).toEqual(["key-1", "key-2"]);
  });
});
