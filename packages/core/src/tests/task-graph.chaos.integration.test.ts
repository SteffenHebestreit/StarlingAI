/**
 * EVL-402 chaos pack: GRF-206 crash detection across a REAL process boundary.
 *
 * A separate OS process runs a task graph against real Redis and is killed
 * mid-flight (exit 137, no cleanup); THIS process — a different "gateway" —
 * must detect the interruption and classify completed vs pending work.
 * Self-skips without REDIS_URL (CI provides a Redis service container).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REDIS_URL = process.env["REDIS_URL"];
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const TSX = resolve(__dirname, "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
const WORKER = resolve(__dirname, "helpers", "chaos-graph-worker.ts");

vi.mock("../config/loader.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../config/loader.js")>();
  return {
    ...original,
    getConfig: () => {
      const config = original.getConfig();
      return { ...config, mission: { ...config.mission, durableTaskGraph: "shadow" } };
    },
  };
});

function runChaosWorker(mode: "crash" | "clean", sessionId: string): Promise<string> {
  return new Promise((resolveFn, reject) => {
    execFile(
      process.execPath,
      [TSX, WORKER, mode, sessionId],
      { cwd: resolve(__dirname, "..", ".."), env: process.env, timeout: 60_000 },
      (_error, stdout) => {
        // crash mode exits 137 by design — the marker line is the contract.
        const line = stdout.split("\n").find((l) => l.startsWith("CHAOS_RESULT:"));
        if (!line) return reject(new Error(`chaos worker produced no CHAOS_RESULT (stdout tail: ${stdout.slice(-300)})`));
        resolveFn(line.slice("CHAOS_RESULT:".length).trim());
      },
    );
  });
}

async function redisCleanup(sessionId: string): Promise<void> {
  const ioredis = (await import("ioredis")) as unknown as { default: new (url: string) => { del: (...keys: string[]) => Promise<number>; srem: (key: string, member: string) => Promise<number>; quit: () => Promise<unknown> } };
  const client = new ioredis.default(REDIS_URL!);
  try {
    await client.del(`starlingai:mem:${sessionId}:graphdefs`, `starlingai:mem:${sessionId}:graphnodes`);
    await client.srem("starlingai:graphdef-sessions", sessionId);
  } finally {
    await client.quit();
  }
}

describe.skipIf(!REDIS_URL)("task-graph chaos: kill mid-graph, detect at next boot (GRF-206 × EVL-402)", () => {
  const sessions: string[] = [];
  afterEach(async () => {
    for (const sid of sessions.splice(0)) await redisCleanup(sid).catch(() => {});
  });

  it("a process killed mid-graph leaves the definition; a DIFFERENT process detects and classifies it", async () => {
    const sessionId = `chaos-${randomUUID().slice(0, 8)}`;
    sessions.push(sessionId);

    const outcome = await runChaosWorker("crash", sessionId);
    expect(outcome).toBe("crashed_mid_graph");

    // THIS process plays "next boot": the scanner must see the wreck.
    const { scanForInterruptedTaskGraphs } = await import("../swarm/graph-restart.js");
    const candidates = await scanForInterruptedTaskGraphs();
    const mine = candidates.find((c) => c.sessionId === sessionId);
    expect(mine).toBeDefined();
    expect(mine).toMatchObject({
      graphId: `graph_chaos_${sessionId}`,
      totalNodes: 3,
      completedNodeIds: ["research"],           // durably completed before the kill — reused, never re-run
      pendingNodeIds: ["build", "verify"],      // owed by a resume, operator-review-gated
    });
  }, 90_000);

  it("a process that completes CLEANLY leaves nothing for the scanner", async () => {
    const sessionId = `chaos-${randomUUID().slice(0, 8)}`;
    sessions.push(sessionId);

    const outcome = await runChaosWorker("clean", sessionId);
    expect(outcome).toBe("clean_complete");

    const { scanForInterruptedTaskGraphs } = await import("../swarm/graph-restart.js");
    const candidates = await scanForInterruptedTaskGraphs();
    expect(candidates.find((c) => c.sessionId === sessionId)).toBeUndefined();
  }, 90_000);
});
