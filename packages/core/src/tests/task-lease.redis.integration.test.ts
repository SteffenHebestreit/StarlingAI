/**
 * DST-102 acceptance gate: two-PROCESS lease contention on real Redis.
 * Runs only when REDIS_URL is set (CI provides a redis service container;
 * locally: run inside the gateway container or point REDIS_URL at one).
 * Mirrors the ad-hoc proof recorded in docs/adr/ADR-002 (2026-07-16).
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isTaskLeaseCurrent,
  publishTaskLeaseResult,
  readTaskLeaseResult,
  renewTaskLease,
  resetLocksForTests,
  startTaskLeaseHeartbeat,
  tryAcquireTaskLease,
} from "../swarm/locks.js";

const REDIS_URL = process.env["REDIS_URL"];
const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER = resolve(__dirname, "helpers", "lease-race-worker.ts");
const TSX = resolve(__dirname, "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
const pause = (ms: number) => new Promise<void>((resolveFn) => setTimeout(resolveFn, ms));

interface WorkerResult { workerId: string; rounds?: number; acquiredCount?: number; contended?: number; acquired?: number[]; error?: string }

function runWorker(workerId: string, rounds: number, runId: string): Promise<WorkerResult> {
  return new Promise((resolveFn, reject) => {
    execFile(
      process.execPath,
      [TSX, WORKER, workerId, String(rounds), runId],
      { cwd: resolve(__dirname, "..", ".."), env: process.env, timeout: 90_000 },
      (error, stdout) => {
        const line = stdout.split("\n").find((l) => l.startsWith("PROOF_RESULT:"));
        if (!line) return reject(error ?? new Error(`worker ${workerId} produced no PROOF_RESULT (stdout: ${stdout.slice(-400)})`));
        resolveFn(JSON.parse(line.slice("PROOF_RESULT:".length)) as WorkerResult);
      },
    );
  });
}

describe.skipIf(!REDIS_URL)("task lease — real Redis integration (DST-102 gate)", () => {
  afterEach(async () => {
    await resetLocksForTests();
  });

  it("two OS processes contending on the same scopes: exactly one winner per round", async () => {
    const runId = `${Date.now()}`;
    const rounds = 40;
    const [a, b] = await Promise.all([runWorker("A", rounds, runId), runWorker("B", rounds, runId)]);
    expect(a.error).toBeUndefined();
    expect(b.error).toBeUndefined();
    const setA = new Set(a.acquired ?? []);
    const overlap = (b.acquired ?? []).filter((round) => setA.has(round));
    expect(overlap).toEqual([]); // no round executed twice
    expect((a.acquiredCount ?? 0) + (b.acquiredCount ?? 0)).toBe(rounds); // every round executed once
    expect(new Set([...(a.acquired ?? []), ...(b.acquired ?? [])]).size).toBe(rounds);
  }, 120_000);

  it("renewal holds ownership past the TTL; expiry allows fenced takeover; stale owner is rejected", async () => {
    const scope = {
      sessionId: `lease-semantics-${Date.now()}`,
      taskId: "t1",
      taskSignature: "redis semantics check",
      workspacePath: "/integration",
      userId: "ci",
    };
    const first = await tryAcquireTaskLease(scope, 2_000);
    expect(first.status).toBe("acquired");
    if (first.status !== "acquired") return;
    expect(first.lease.backend).toBe("redis");

    const heartbeat = startTaskLeaseHeartbeat(first.lease, { ttlMs: 2_000, intervalMs: 500 });
    await pause(3_000);
    expect(heartbeat.lost).toBe(false);
    expect(await isTaskLeaseCurrent(first.lease)).toBe(true);
    expect((await tryAcquireTaskLease(scope, 2_000)).status).toBe("contended");
    await heartbeat.stop();

    await pause(2_500); // let it expire without renewal
    const second = await tryAcquireTaskLease(scope, 2_000);
    expect(second.status).toBe("acquired");
    if (second.status !== "acquired") return;
    expect(second.lease.fencingToken).toBeGreaterThan(first.lease.fencingToken);
    expect(await isTaskLeaseCurrent(first.lease)).toBe(false);
    expect(await renewTaskLease(first.lease, 2_000)).toBe(false);

    // DST-103 on real Redis: the stale owner's publish is refused; the takeover
    // owner's result is what followers read.
    expect(await publishTaskLeaseResult(first.lease, {
      status: "completed", output: "stale", agentName: "zombie", finishedAt: new Date().toISOString(),
    })).toBe(false);
    expect(await publishTaskLeaseResult(second.lease, {
      status: "completed", output: "authoritative", agentName: "successor", finishedAt: new Date().toISOString(),
    })).toBe(true);
    expect((await readTaskLeaseResult(scope))?.output).toBe("authoritative");
  }, 60_000);
});
