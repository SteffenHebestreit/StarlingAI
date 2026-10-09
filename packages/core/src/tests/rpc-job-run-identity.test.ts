import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A job queued from chat runs as the signed-in user, like one queued over REST (found in review,
 * 2026-10-08).
 *
 * The chat `/job <name>` command queued every run as `job:<name>`. The run then acted with no
 * user's per-user resources, and the jobs listing, scoped to the caller under multi-user auth
 * (gateway/scene-job-access.ts), never showed the user the run they had started.
 */
const dirs: string[] = [];

afterEach(async () => {
  delete process.env["SAI_CONFIG_PATH"];
  (await import("../config/loader.js")).resetConfigForTests();
  await (await import("../agent/jobs.js")).resetJobsForTests();
  const session = await import("../agent/session.js");
  for (const active of session.getAllSessions()) session.endSession(active.id);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

/** Queues the ferry job from chat over a connection signed in as `userId` (none: no user), and
 *  returns the user the queued run was made as. */
async function queueFromChat(userId: string | undefined): Promise<string | undefined> {
  const dir = mkdtempSync(join(tmpdir(), "rpc-job-identity-"));
  dirs.push(dir);
  writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
    workspacePath: dir,
    gateway: { jwtSecret: "t".repeat(32) },
    scenes: { ferry_check: { description: "Checks the ferries.", task: "Check the Hamburg ferry times." } },
    jobs: { ferry_job: { description: "Checks the ferries.", steps: [{ scene: "ferry_check" }] } },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
  process.env["SAI_JOB_WAKE_DISABLED"] = "1";
  vi.resetModules();
  // Sequential: these modules import each other.
  const { RpcConnection } = await import("../gateway/rpc.js");
  const session = await import("../agent/session.js");
  const jobs = await import("../agent/jobs.js");
  try {
    const active = session.createSession({ channel: "webchat", ...(userId ? { userId } : {}) });
    const connection = new RpcConnection({ readyState: 1, send() {} } as never, userId, userId ? "operator" : undefined);
    await connection.handleMessage(JSON.stringify({
      id: "req-job",
      method: "chat.send",
      params: { sessionId: active.id, requestId: "turn-job", message: "/job ferry_job" },
    }));
    const queued = await jobs.listJobs();
    expect(queued).toHaveLength(1);
    return queued[0]!.userId;
  } finally {
    delete process.env["SAI_JOB_WAKE_DISABLED"];
  }
}

describe("chat /job and the user the run is made as", () => {
  it("queues the run as the connection's signed-in user", async () => {
    expect(await queueFromChat("bob")).toBe("bob");
  });

  it("queues it as the job itself on a connection with no user, as before", async () => {
    expect(await queueFromChat(undefined)).toBe("job:ferry_job");
  });
});
