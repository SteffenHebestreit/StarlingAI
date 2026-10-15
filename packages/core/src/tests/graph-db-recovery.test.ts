import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 2026-10-15: Docker restarted everything at once, the gateway's first query found MemGraph not up
 * yet, and the graph read "MemGraph offline" for hours after MemGraph answered. Every caller asks
 * isGraphDbAvailable() before querying, so once it said no, no query ran that could find it back.
 */

const { run, sessionFactory } = vi.hoisted(() => {
  const run = vi.fn();
  const sessionFactory = vi.fn(() => ({
    run,
    executeRead: (work: (tx: { run: typeof run }) => unknown) => work({ run }),
    executeWrite: (work: (tx: { run: typeof run }) => unknown) => work({ run }),
    close: vi.fn(async () => undefined),
  }));
  return { run, sessionFactory };
});

vi.mock("neo4j-driver", () => {
  const driver = vi.fn(() => ({ session: sessionFactory, close: vi.fn(async () => undefined) }));
  const neo4j = { driver, auth: { basic: vi.fn(() => ({})) }, session: { READ: "READ", WRITE: "WRITE" }, int: (value: number) => value };
  return { default: neo4j, ...neo4j };
});

describe("MemGraph found back after it was unreachable", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    process.env["MEMGRAPH_URL"] = "bolt://memgraph:7687";
    run.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env["MEMGRAPH_URL"];
  });

  it("is tried again a while after a connectivity error, and stays down while it still fails", async () => {
    const graph = await import("../db/neo4j.js");
    const unreachable = Object.assign(new Error("Failed to connect to server"), { code: "ServiceUnavailable" });

    run.mockRejectedValueOnce(unreachable);
    expect(graph.isGraphDbAvailable()).toBe(true);
    await expect(graph.runCypher("RETURN 1")).rejects.toThrow();
    expect(graph.isGraphDbAvailable()).toBe(false);

    vi.advanceTimersByTime(graph.GRAPH_RETRY_AFTER_MS - 1_000);
    expect(graph.isGraphDbAvailable()).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(graph.isGraphDbAvailable()).toBe(true);   // let through to try again

    run.mockRejectedValueOnce(unreachable);
    await expect(graph.runCypher("RETURN 1")).rejects.toThrow();
    expect(graph.isGraphDbAvailable()).toBe(false);  // still down: another wait

    vi.advanceTimersByTime(graph.GRAPH_RETRY_AFTER_MS);
    run.mockResolvedValueOnce({ records: [] });
    expect(graph.isGraphDbAvailable()).toBe(true);
    await graph.runCypher("RETURN 1");
    expect(graph.isGraphDbAvailable()).toBe(true);   // found back
  });
});
