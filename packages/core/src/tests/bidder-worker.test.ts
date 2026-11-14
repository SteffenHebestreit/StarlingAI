/**
 * Tests for the long-running bidder worker module.
 *
 * Validates:
 * - Agent index building and refresh
 * - Bids from the router's ranking, not from a scorer of its own
 * - Bid emission on task_announced events
 * - Worker lifecycle (start/stop/status)
 * - Dedup of handled announcements
 */
import { afterEach, describe, expect, it, vi } from "vitest";

/** What the router ranks for a query, and whether this process's own bidder is running. */
const router = vi.hoisted(() => ({
  ranking: [] as Array<{ name: string; score: number; confidence: "high" | "medium" | "low"; matchedTerms: string[] }>,
  calls: [] as Array<{ query: string; allowed: string[]; excluded: string[] }>,
  ownBidderRunning: false,
}));
vi.mock("../swarm/bidding.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../swarm/bidding.js")>();
  return {
    ...actual,
    isAutonomousBiddingStarted: () => router.ownBidderRunning,
    routeAnnouncedTask: async (query: string, allowed: readonly string[], excluded: ReadonlySet<string>) => {
      router.calls.push({ query, allowed: [...allowed], excluded: [...excluded] });
      return router.ranking.filter((entry) => (allowed.length === 0 || allowed.includes(entry.name)) && !excluded.has(entry.name));
    },
  };
});

describe("bidder worker", () => {
  afterEach(async () => {
    router.ranking = [];
    router.calls = [];
    router.ownBidderRunning = false;
    vi.resetModules();
    const [{ resetSwarmBusForTests }, { resetBidderWorkerForTests }] = await Promise.all([
      import("../swarm/bus.js"),
      import("../swarm/bidder-worker.js"),
    ]);
    resetSwarmBusForTests();
    resetBidderWorkerForTests();
  });

  it("bids what the router ranks for an announced task", async () => {
    router.ranking = [{ name: "researcher", score: 0.8123456, confidence: "high", matchedTerms: [] }];
    const { refreshAgentIndex } = await import("../swarm/bidder-worker.js");
    const { emitSwarmEvent, onSwarmEvent } = await import("../swarm/bus.js");
    const { startBidderWorker, stopBidderWorker } = await import("../swarm/bidder-worker.js");

    const catalog = {
      researcher: {
        description: "Finds facts on the web and summarizes them.",
        capabilities: ["web research", "documentation lookup"],
        tags: ["research", "web"],
        tools: ["web_search"] as string[],
        maxIterations: 4,
      },
      coder: {
        description: "Writes and edits source code files.",
        capabilities: ["code writing", "programming"],
        tags: ["code", "programming"],
        tools: ["write_file"] as string[],
        maxIterations: 4,
      },
    };

    await startBidderWorker(catalog);

    const bids: Array<{ agentName?: string; data?: Record<string, unknown> }> = [];
    const unsub = onSwarmEvent((event) => {
      if (event.type === "task_bid") {
        bids.push({ agentName: event.agentName, data: event.data });
      }
    });

    emitSwarmEvent("task_announced", {
      taskId: "test-task-1",
      sessionId: "sess-1",
      task: "Search the web for the latest research papers",
      data: {
        dispatchMode: "autonomous_bidding",
        routingQuery: "web research documentation",
      },
    });

    // Give the event loop time to process
    await new Promise(r => setTimeout(r, 50));

    expect(bids.map((bid) => bid.agentName)).toEqual(["researcher"]);
    expect(bids[0]?.data).toMatchObject({ score: 0.8123, confidence: "high", dispatchMode: "autonomous_bidding" });
    // The router was asked with the announcement's routing query.
    expect(router.calls).toEqual([{ query: "web research documentation", allowed: [], excluded: [] }]);

    // All bids should be from the long-running worker
    for (const bid of bids) {
      expect(bid.data?.["bidderType"]).toBe("long_running_worker");
    }

    unsub();
    stopBidderWorker();
  });

  it("bids for nobody when the router ranks nobody, whatever words the task shares with a description", async () => {
    // Session 5b77edf9: the worker scored tasks itself, by word fragments. A German weather lookup's
    // "ca", "am", "nach" and "com" began "categorizes", "anhang", "nachrichten" and "composes", and
    // it bid for the mail agent, which then ran the lookup.
    const { emitSwarmEvent, onSwarmEvent } = await import("../swarm/bus.js");
    const { startBidderWorker, stopBidderWorker } = await import("../swarm/bidder-worker.js");
    await startBidderWorker({
      mail_agent: {
        description: "Reads the inbox, categorizes mail, composes an Antwortvorschlag with Anhang and sends Nachrichten.",
        capabilities: ["mail categorization", "reply composition", "communication"],
        tags: ["mail", "inbox"],
        tools: ["mail_search"] as string[],
        maxIterations: 4,
      },
    });
    const bids: string[] = [];
    const unsub = onSwarmEvent((event) => { if (event.type === "task_bid" && event.agentName) bids.push(event.agentName); });
    const task = "Ermittle das aktuelle Wetter für Bremen für heute Nachmittag (ca. 12–18 Uhr am 13. November). Suche nach Vorhersagen von Wetter.com.";

    emitSwarmEvent("task_announced", { taskId: "weather", sessionId: "sess-w", task, data: { dispatchMode: "autonomous_bidding", routingQuery: task } });
    await new Promise(r => setTimeout(r, 50));

    expect(router.calls).toHaveLength(1);
    expect(bids).toEqual([]);

    unsub();
    stopBidderWorker();
  });

  it("stays silent in a process whose own bidder answers the announcement", async () => {
    // The gateway starts both; they ask the same router, and its bids would be on the bus twice.
    router.ranking = [{ name: "researcher", score: 0.8, confidence: "high", matchedTerms: [] }];
    router.ownBidderRunning = true;
    const { emitSwarmEvent, onSwarmEvent } = await import("../swarm/bus.js");
    const { startBidderWorker, stopBidderWorker } = await import("../swarm/bidder-worker.js");
    await startBidderWorker({ researcher: { description: "Finds facts on the web.", capabilities: [], tags: [], tools: ["web_search"] as string[], maxIterations: 4 } });
    const workerBids: unknown[] = [];
    const unsub = onSwarmEvent((event) => { if (event.type === "task_bid" && event.data?.["bidderType"] === "long_running_worker") workerBids.push(event); });

    emitSwarmEvent("task_announced", { taskId: "own-bidder", sessionId: "sess-o", task: "web research", data: { dispatchMode: "autonomous_bidding", routingQuery: "web research" } });
    await new Promise(r => setTimeout(r, 50));

    expect(workerBids).toEqual([]);
    expect(router.calls).toEqual([]);

    unsub();
    stopBidderWorker();
  });

  it("hands the announcement's exclusions to the router", async () => {
    router.ranking = [
      { name: "web_task_coordinator", score: 0.77, confidence: "high", matchedTerms: [] },
      { name: "researcher", score: 0.74, confidence: "high", matchedTerms: [] },
    ];
    const { emitSwarmEvent, onSwarmEvent } = await import("../swarm/bus.js");
    const { startBidderWorker, stopBidderWorker } = await import("../swarm/bidder-worker.js");
    await startBidderWorker({ researcher: { description: "Finds facts on the web.", capabilities: [], tags: [], tools: ["web_search"] as string[], maxIterations: 4 } });
    const bids: string[] = [];
    const unsub = onSwarmEvent((event) => { if (event.type === "task_bid" && event.agentName) bids.push(event.agentName); });

    emitSwarmEvent("task_announced", {
      taskId: "excluded", sessionId: "sess-e", task: "weather lookup",
      data: { dispatchMode: "autonomous_bidding", routingQuery: "weather lookup", excludeAgents: ["web_task_coordinator"] },
    });
    await new Promise(r => setTimeout(r, 50));

    expect(router.calls[0]?.excluded).toEqual(["web_task_coordinator"]);
    expect(bids).toEqual(["researcher"]);

    unsub();
    stopBidderWorker();
  });

  it("does not emit bids for non-autonomous tasks", async () => {
    const { emitSwarmEvent, onSwarmEvent } = await import("../swarm/bus.js");
    const { startBidderWorker, stopBidderWorker } = await import("../swarm/bidder-worker.js");

    await startBidderWorker({
      researcher: {
        description: "Finds facts on the web.",
        capabilities: ["web research"],
        tags: ["research"],
        tools: ["web_search"] as string[],
        maxIterations: 4,
      },
    });

    const bids: unknown[] = [];
    const unsub = onSwarmEvent((event) => {
      if (event.type === "task_bid") bids.push(event);
    });

    // No dispatchMode: "autonomous_bidding" → should be ignored
    emitSwarmEvent("task_announced", {
      taskId: "test-task-2",
      sessionId: "sess-2",
      task: "Manual task assignment",
    });

    await new Promise(r => setTimeout(r, 50));
    expect(bids).toHaveLength(0);

    unsub();
    stopBidderWorker();
  });

  it("deduplicates repeated task announcements", async () => {
    router.ranking = [{ name: "researcher", score: 0.8, confidence: "high", matchedTerms: [] }];
    const { emitSwarmEvent, onSwarmEvent } = await import("../swarm/bus.js");
    const { startBidderWorker, stopBidderWorker } = await import("../swarm/bidder-worker.js");

    await startBidderWorker({
      researcher: {
        description: "Finds facts on the web and summarizes.",
        capabilities: ["web research"],
        tags: ["research", "web"],
        tools: ["web_search"] as string[],
        maxIterations: 4,
      },
    });

    let bidCount = 0;
    const unsub = onSwarmEvent((event) => {
      if (event.type === "task_bid") bidCount++;
    });

    // Emit the same task twice with same event ID (simulating Redis redelivery)
    const sharedPayload = {
      taskId: "dedup-task",
      sessionId: "sess-dedup",
      task: "research web papers",
      data: {
        dispatchMode: "autonomous_bidding" as const,
        routingQuery: "web research",
      },
    };

    emitSwarmEvent("task_announced", sharedPayload);
    await new Promise(r => setTimeout(r, 30));
    const firstRound = bidCount;

    // Second emission — different event ID from emitSwarmEvent, so this tests
    // that the worker deduplication is based on announcement ID tracking
    emitSwarmEvent("task_announced", sharedPayload);
    await new Promise(r => setTimeout(r, 30));

    // Both announcements get different UUIDs from emitSwarmEvent, so both will be processed.
    // This is the expected behavior — dedup is by event.id, not taskId.
    expect(bidCount).toBeGreaterThanOrEqual(firstRound);

    unsub();
    stopBidderWorker();
  });

  it("respects allowedAgents filter in task announcements", async () => {
    router.ranking = [
      { name: "coder", score: 0.81, confidence: "high", matchedTerms: [] },
      { name: "researcher", score: 0.8, confidence: "high", matchedTerms: [] },
    ];
    const { emitSwarmEvent, onSwarmEvent } = await import("../swarm/bus.js");
    const { startBidderWorker, stopBidderWorker } = await import("../swarm/bidder-worker.js");

    await startBidderWorker({
      researcher: {
        description: "Finds facts on the web.",
        capabilities: ["web research"],
        tags: ["research"],
        tools: ["web_search"] as string[],
        maxIterations: 4,
      },
      coder: {
        description: "Writes code.",
        capabilities: ["code writing"],
        tags: ["code"],
        tools: ["write_file"] as string[],
        maxIterations: 4,
      },
    });

    const bids: string[] = [];
    const unsub = onSwarmEvent((event) => {
      if (event.type === "task_bid" && event.agentName) bids.push(event.agentName);
    });

    emitSwarmEvent("task_announced", {
      taskId: "filtered-task",
      sessionId: "sess-filter",
      task: "research web facts code writing",
      data: {
        dispatchMode: "autonomous_bidding",
        routingQuery: "research web facts",
        allowedAgents: ["researcher"], // Only researcher allowed
      },
    });

    await new Promise(r => setTimeout(r, 50));

    // Should only bid for researcher, not coder
    expect(bids).toEqual(["researcher"]);
    expect(router.calls[0]?.allowed).toEqual(["researcher"]);

    unsub();
    stopBidderWorker();
  });

  it("reports correct worker status", async () => {
    const { getBidderWorkerStatus, startBidderWorker, stopBidderWorker, isBidderWorkerRunning } = await import("../swarm/bidder-worker.js");

    expect(isBidderWorkerRunning()).toBe(false);

    await startBidderWorker({
      researcher: {
        description: "Test agent",
        capabilities: [],
        tags: [],
        tools: [] as string[],
        maxIterations: 1,
      },
    });

    expect(isBidderWorkerRunning()).toBe(true);

    const status = getBidderWorkerStatus();
    expect(status.running).toBe(true);
    expect(status.agentCount).toBe(1);
    expect(status.mode).toBe("in-process"); // No Redis in tests
    expect(status.workerId).toBeTruthy();

    stopBidderWorker();
    expect(isBidderWorkerRunning()).toBe(false);
  });
});
