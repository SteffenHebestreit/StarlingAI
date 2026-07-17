/**
 * Child-process worker for the two-process lease contention integration test
 * (DST-102 acceptance gate). Races tryAcquireTaskLease over N shared scopes
 * against the REDIS_URL backend and reports one PROOF_RESULT:<json> line.
 * Spawned by task-lease.redis.integration.test.ts — not a test file itself.
 */
import { tryAcquireTaskLease } from "../../swarm/locks.js";

const workerId = process.argv[2] ?? "w";
const rounds = Number(process.argv[3] ?? "40");
const runId = process.argv[4] ?? "dev";

const acquired: number[] = [];
let contended = 0;
for (let i = 0; i < rounds; i += 1) {
  const result = await tryAcquireTaskLease({
    sessionId: `lease-race-${runId}`,
    taskId: `round_${i}`,
    taskSignature: `lease race ${runId} round ${i}`,
    workspacePath: "/integration",
    userId: "ci",
  }, 30_000);
  if (result.status === "acquired") {
    if (result.lease.backend !== "redis") {
      console.log(`PROOF_RESULT:${JSON.stringify({ workerId, error: `non-redis backend: ${result.lease.backend}` })}`);
      process.exit(2);
    }
    acquired.push(i);
  } else if (result.status === "contended") {
    contended += 1;
  } else {
    console.log(`PROOF_RESULT:${JSON.stringify({ workerId, error: `unavailable: ${result.reason}` })}`);
    process.exit(2);
  }
}
console.log(`PROOF_RESULT:${JSON.stringify({ workerId, rounds, acquiredCount: acquired.length, contended, acquired })}`);
process.exit(0);
