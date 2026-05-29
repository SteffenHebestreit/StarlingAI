import { afterEach, describe, expect, it } from "vitest";
import {
  appendAgentMessage,
  consumeAgentMessages,
  writeSharedFact,
  readSharedFact,
  readAllFacts,
  appendPartialResult,
  readPartialResults,
  searchPartialResults,
  formatSharedContextForPrompt,
  extractFactsFromOutput,
  searchSharedFacts,
  resetSharedMemoryForTests,
} from "../swarm/memory.js";
import {
  acquireSlot,
  releaseSlot,
  getConcurrencySnapshot,
  getGlobalConcurrencySnapshot,
  resetConcurrencyForTests,
  DEFAULT_CONCURRENCY,
} from "../swarm/concurrency.js";

describe("Collective Memory — facts store (in-process)", () => {
  afterEach(async () => { await resetSharedMemoryForTests(); });

  it("writes and reads a single fact", async () => {
    await writeSharedFact("sess-1", "api_base_url", "https://api.example.com");
    const val = await readSharedFact("sess-1", "api_base_url");
    expect(val).toBe("https://api.example.com");
  });

  it("returns null for missing key", async () => {
    const val = await readSharedFact("sess-1", "nonexistent");
    expect(val).toBeNull();
  });

  it("reads all facts for a session", async () => {
    await writeSharedFact("sess-2", "user_email", "alice@example.com");
    await writeSharedFact("sess-2", "resolved_host", "192.168.1.10");
    const facts = await readAllFacts("sess-2");
    expect(facts["user_email"]).toBe("alice@example.com");
    expect(facts["resolved_host"]).toBe("192.168.1.10");
  });

  it("isolates facts between sessions", async () => {
    await writeSharedFact("sess-A", "key", "value-A");
    await writeSharedFact("sess-B", "key", "value-B");
    expect(await readSharedFact("sess-A", "key")).toBe("value-A");
    expect(await readSharedFact("sess-B", "key")).toBe("value-B");
  });

  it("truncates values exceeding FACT_VALUE_MAX", async () => {
    const big = "x".repeat(5000);
    await writeSharedFact("sess-3", "big_key", big);
    const stored = await readSharedFact("sess-3", "big_key");
    expect(stored!.length).toBe(2000);
  });

  it("overwrites existing key", async () => {
    await writeSharedFact("sess-4", "status", "pending");
    await writeSharedFact("sess-4", "status", "done");
    expect(await readSharedFact("sess-4", "status")).toBe("done");
  });
});

describe("Collective Memory — partial results", () => {
  afterEach(async () => { await resetSharedMemoryForTests(); });

  it("appends and reads back partial results", async () => {
    await appendPartialResult({ sessionId: "sess-r1", taskId: "t1", agentName: "code_writer", content: "Here is the code.", ts: new Date().toISOString() });
    const results = await readPartialResults("sess-r1");
    expect(results).toHaveLength(1);
    expect(results[0]!.agentName).toBe("code_writer");
    expect(results[0]!.content).toBe("Here is the code.");
  });

  it("isolates results between sessions", async () => {
    await appendPartialResult({ sessionId: "sess-r2", taskId: "t1", agentName: "a1", content: "r2 result", ts: new Date().toISOString() });
    const r1 = await readPartialResults("sess-r1");
    expect(r1).toHaveLength(0);
  });

  it("returns results in insertion order", async () => {
    await appendPartialResult({ sessionId: "sess-r3", taskId: "t1", agentName: "a1", content: "first", ts: new Date().toISOString() });
    await appendPartialResult({ sessionId: "sess-r3", taskId: "t2", agentName: "a2", content: "second", ts: new Date().toISOString() });
    const results = await readPartialResults("sess-r3");
    expect(results[0]!.content).toBe("first");
    expect(results[1]!.content).toBe("second");
  });

  it("searches partial results by keyword relevance", async () => {
    await appendPartialResult({
      sessionId: "sess-r4",
      taskId: "task_a2a",
      agentName: "researcher",
      content: "A2A official specification: https://a2a-protocol.org/latest/specification/ maintained by the A2A Project.",
      ts: new Date().toISOString(),
    });
    await appendPartialResult({
      sessionId: "sess-r4",
      taskId: "task_misc",
      agentName: "researcher",
      content: "General UI notes unrelated to protocols.",
      ts: new Date().toISOString(),
    });

    const matches = await searchPartialResults("sess-r4", "A2A official specification", { maxResults: 2 });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.taskId).toBe("task_a2a");
    expect(matches[0]?.agentName).toBe("researcher");
    expect(matches[0]?.score).toBeGreaterThan(0);
  });
});

describe("Collective Memory — direct agent messages", () => {
  afterEach(async () => { await resetSharedMemoryForTests(); });

  it("queues and consumes direct messages for the target agent", async () => {
    await appendAgentMessage({
      sessionId: "sess-msg",
      id: "m1",
      fromAgent: "researcher",
      toAgent: "coder",
      content: "Use the v2 API route",
      ts: new Date().toISOString(),
    });

    const messages = await consumeAgentMessages("sess-msg", "coder");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.fromAgent).toBe("researcher");
    expect(messages[0]?.content).toContain("v2 API");

    const consumedAgain = await consumeAgentMessages("sess-msg", "coder");
    expect(consumedAgain).toHaveLength(0);
  });

  it("does not deliver a direct message to the wrong agent", async () => {
    await appendAgentMessage({
      sessionId: "sess-msg-2",
      id: "m2",
      fromAgent: "planner",
      toAgent: "tester",
      content: "Verify the happy path first",
      ts: new Date().toISOString(),
    });

    const wrongTarget = await consumeAgentMessages("sess-msg-2", "coder");
    expect(wrongTarget).toHaveLength(0);

    const rightTarget = await consumeAgentMessages("sess-msg-2", "tester");
    expect(rightTarget).toHaveLength(1);
  });
});

describe("Collective Memory — fact extraction and prompt formatting", () => {
  afterEach(async () => { await resetSharedMemoryForTests(); });

  it("extracts FACT: lines from agent output", () => {
    const output = `
I researched the API and found the following:
FACT: api_version = v2.1
FACT: rate_limit = 100 requests per minute
The endpoint accepts JSON.
    `.trim();
    const facts = extractFactsFromOutput(output);
    expect(facts["api_version"]).toBe("v2.1");
    expect(facts["rate_limit"]).toBe("100 requests per minute");
  });

  it("ignores non-FACT lines", () => {
    const output = "No facts here. Just plain text.";
    expect(Object.keys(extractFactsFromOutput(output))).toHaveLength(0);
  });

  it("normalizes keys to snake_case", () => {
    const output = "FACT: API Base URL = https://example.com";
    const facts = extractFactsFromOutput(output);
    expect(facts["api_base_url"]).toBe("https://example.com");
  });

  it("formats shared context for prompt when data exists", async () => {
    await writeSharedFact("sess-fmt", "api_key", "abc123");
    await appendPartialResult({ sessionId: "sess-fmt", taskId: "t1", agentName: "researcher", content: "Found the docs at example.com/docs", ts: new Date().toISOString() });
    await appendAgentMessage({ sessionId: "sess-fmt", id: "m3", fromAgent: "planner", toAgent: "coder", content: "Focus on the config diff only", ts: new Date().toISOString() });

    const prompt = await formatSharedContextForPrompt("sess-fmt", { agentName: "coder" });
    expect(prompt).toContain("Direct Messages");
    expect(prompt).toContain("Focus on the config diff only");
    expect(prompt).toContain("Shared Facts");
    expect(prompt).toContain("api_key");
    expect(prompt).toContain("abc123");
    expect(prompt).toContain("Partial Results");
    expect(prompt).toContain("researcher");
  });

  it("returns empty string when no shared data", async () => {
    const prompt = await formatSharedContextForPrompt("sess-empty");
    expect(prompt).toBe("");
  });

  it("supports semantic shared-fact search when embeddings are available", async () => {
    await writeSharedFact("sess-search", "api_base_url", "https://api.example.com/v2");
    await writeSharedFact("sess-search", "customer_email", "alice@example.com");

    const provider = {
      embed: async (texts: string[]) => {
        if (texts.length === 1) return [new Float32Array([1, 0])];
        return [new Float32Array([1, 0]), new Float32Array([0, 1])];
      },
    } as unknown as import("../providers/lmstudio.js").LMStudioProvider;

    const matches = await searchSharedFacts("sess-search", "API endpoint", {
      provider,
      embeddingModel: "lmstudio/qwen-embed",
      maxResults: 2,
    });

    expect(matches[0]?.key).toBe("api_base_url");
    expect(matches[0]?.score).toBeGreaterThan(matches[1]?.score ?? -1);
  });

  it("falls back to keyword matching when embeddings are unavailable", async () => {
    await writeSharedFact("sess-keyword", "api_base_url", "https://api.example.com/v2");
    await writeSharedFact("sess-keyword", "customer_email", "alice@example.com");

    const matches = await searchSharedFacts("sess-keyword", "api base", { maxResults: 2 });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.key).toBe("api_base_url");
  });
});

describe("Swarm Concurrency — semaphore", () => {
  afterEach(() => { resetConcurrencyForTests(); });

  it("allows up to maxConcurrent simultaneous slots", async () => {
    await acquireSlot("agent-x", 2);
    await acquireSlot("agent-x", 2);
    const snap = getConcurrencySnapshot();
    const s = snap.find(s => s.agentName === "agent-x")!;
    expect(s.active).toBe(2);
    expect(s.queued).toBe(0);
    expect(s.totalAcquisitions).toBe(2);
    expect(s.avgWaitMs).toBe(0);
  });

  it("queues additional requests when at capacity", async () => {
    await acquireSlot("agent-y", 1);

    let resolved = false;
    const pending = acquireSlot("agent-y", 1).then(() => { resolved = true; });

    // Let the event loop tick once — should remain queued
    await new Promise(r => setImmediate(r));
    expect(resolved).toBe(false);

    const snap = getConcurrencySnapshot().find(s => s.agentName === "agent-y")!;
    expect(snap.active).toBe(1);
    expect(snap.queued).toBe(1);
    expect(snap.oldestQueuedMs).toBeGreaterThanOrEqual(0);

    releaseSlot("agent-y");
    await pending;
    expect(resolved).toBe(true);

    const updated = getConcurrencySnapshot().find(s => s.agentName === "agent-y")!;
    expect(updated.queuedAcquisitions).toBe(1);
    expect(updated.lastWaitMs).toBeGreaterThanOrEqual(0);
    expect(updated.maxWaitMs).toBeGreaterThanOrEqual(updated.lastWaitMs);
  });

  it("releases slots and unblocks next waiter", async () => {
    await acquireSlot("agent-z", 1);
    const p = acquireSlot("agent-z", 1);
    releaseSlot("agent-z");
    await p; // should resolve without deadlock
    const snap = getConcurrencySnapshot().find(s => s.agentName === "agent-z")!;
    expect(snap.active).toBe(1);
    expect(snap.queued).toBe(0);
  });

  it("tracks utilization correctly", async () => {
    await acquireSlot("agent-u", 4);
    await acquireSlot("agent-u", 4);
    const snap = getConcurrencySnapshot().find(s => s.agentName === "agent-u")!;
    expect(snap.utilization).toBe(0.5);
  });

  it("tracks average wait time across queued acquisitions", async () => {
    await acquireSlot("agent-w", 1);

    const first = acquireSlot("agent-w", 1);
    await new Promise(r => setTimeout(r, 15));
    releaseSlot("agent-w");
    await first;

    const second = acquireSlot("agent-w", 1);
    await new Promise(r => setTimeout(r, 10));
    releaseSlot("agent-w");
    await second;

    const snap = getConcurrencySnapshot().find(s => s.agentName === "agent-w")!;
    expect(snap.queuedAcquisitions).toBe(2);
    expect(snap.avgWaitMs).toBeGreaterThan(0);
    expect(snap.maxWaitMs).toBeGreaterThanOrEqual(snap.avgWaitMs);
  });

  it("uses DEFAULT_CONCURRENCY when maxConcurrent not specified", () => {
    expect(DEFAULT_CONCURRENCY).toBe(3);
  });

  it("counts every acquired slot against the shared global ceiling", async () => {
    await acquireSlot("agent-a", 5);
    await acquireSlot("agent-b", 5);
    await acquireSlot("agent-c", 5);
    const g = getGlobalConcurrencySnapshot();
    expect(g.active).toBe(3);
  });

  it("queues across agent types once the global ceiling is reached", async () => {
    process.env["STARLINGAI_MAX_GLOBAL_CONCURRENCY"] = "2";
    resetConcurrencyForTests();
    try {
      await acquireSlot("type-1", 10);
      await acquireSlot("type-2", 10);

      let resolved = false;
      const pending = acquireSlot("type-3", 10).then(() => { resolved = true; });
      await new Promise((r) => setImmediate(r));
      // Per-agent caps are wide open (10), but the global ceiling of 2 is full,
      // so a third distinct agent type must wait.
      expect(resolved).toBe(false);
      expect(getGlobalConcurrencySnapshot().active).toBe(2);

      releaseSlot("type-1");
      await pending;
      expect(resolved).toBe(true);
      expect(getGlobalConcurrencySnapshot().active).toBe(2);
    } finally {
      delete process.env["STARLINGAI_MAX_GLOBAL_CONCURRENCY"];
      resetConcurrencyForTests();
    }
  });
});
