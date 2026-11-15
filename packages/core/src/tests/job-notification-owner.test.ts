import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testAccount } from "./support/test-account.js";

/**
 * Job notifications and who receives them (found in review, 2026-11-14).
 *
 * A job's notifications ("Job failed" with its error text, "Approval required", completed,
 * cancelled) carried no owner, so they went to every signed-in socket: a viewer, and every other
 * account, received an account's "Job failed" with the error, the job id and the session id. Now a
 * job that runs as an account notifies that account alone, and under multi-user auth a notification
 * with no owner goes to operators and above only. With auth off every socket gets every
 * notification, as before.
 */
const SESSION_STORE_DIR = vi.hoisted(() => {
  // The session store resolves its path when the module loads; a temp one, not the source tree's.
  const { mkdtempSync: mk } = require("node:fs") as typeof import("node:fs");
  const { tmpdir: tmp } = require("node:os") as typeof import("node:os");
  const { join: j } = require("node:path") as typeof import("node:path");
  const dir = mk(j(tmp(), "job-notification-sessions-"));
  process.env["SAI_SESSION_STORE"] = j(dir, "sessions.json");
  return dir;
});

const dirs: string[] = [];

afterEach(async () => {
  try {
    await (await import("../agent/scene-worker.js")).stopSceneJobWorker();
  } catch { /* not started */ }
  await (await import("../agent/jobs.js")).resetJobsForTests();
  (await import("../runtime/notifications.js")).resetNotificationsForTests();
  const session = await import("../agent/session.js");
  for (const active of session.getAllSessions()) session.endSession(active.id);
  delete process.env["SAI_CONFIG_PATH"];
  (await import("../config/loader.js")).resetConfigForTests();
  (await import("../gateway/auth.js")).resetAuthStateForTests();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.doUnmock("../agent/runtime.js");
  vi.doUnmock("../approval/index.js");
  vi.resetModules();
});

afterAll(() => {
  delete process.env["SAI_SESSION_STORE"];
  rmSync(SESSION_STORE_DIR, { recursive: true, force: true });
});

const ROSTER = { alice: "operator", bob: "operator", vera: "viewer", carol: "admin" } as const;
type Who = keyof typeof ROSTER;
const ALICE = { userId: "alice", account: testAccount("alice").id };

function configure(authEnabled: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "job-notification-"));
  dirs.push(dir);
  writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
    workspacePath: dir,
    gateway: { jwtSecret: "n".repeat(40), turnTimeoutMs: 30_000 },
    ...(authEnabled ? { auth: { enabled: true, users: Object.entries(ROSTER).map(([name, role]) => testAccount(name, role).record) } } : {}),
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
  vi.resetModules();
  return dir;
}

/** Every notification published from now on, owner included (it never leaves the gateway). */
async function captureNotifications() {
  const { subscribeToNotifications } = await import("../runtime/notifications.js");
  const published: Array<{ title: string; owner?: unknown }> = [];
  subscribeToNotifications((notification) => { published.push(notification); });
  return published;
}

describe("the owner of a job's notifications", () => {
  it("is the account the job runs as, for every notification of its life; a run that names no account has none", async () => {
    configure(false);
    const jobs = await import("../agent/jobs.js");
    const published = await captureNotifications();
    const job = (name: string, owner: Record<string, unknown>) => jobs.createJob({ sceneName: name, task: "t", turnTimeoutMs: 30_000, ...owner });

    const failing = await job("lab_import", ALICE);
    await jobs.failJob(failing.id, "the lab server answered 503 for patient 4711");
    const finishing = await job("digest", ALICE);
    await jobs.completeJob(finishing.id, { response: "done", toolCallsExecuted: 0, blocked: false });
    const cancelled = await job("export", ALICE);
    await jobs.cancelJob(cancelled.id);
    const stopped = await job("sync", ALICE);
    await jobs.markJobCancelled(stopped.id, "the worker stopped");
    expect(published.map((n) => n.title)).toEqual(["Job failed", "Job completed", "Job cancelled", "Job cancelled"]);
    for (const notification of published) expect(notification.owner, notification.title).toEqual(ALICE);

    published.length = 0;
    const triggered = await job("webhook_scene", { userId: "scene:webhook_scene", principal: "synthetic" });
    await jobs.failJob(triggered.id, "boom");
    expect(published).toHaveLength(1);
    expect(published[0]).not.toHaveProperty("owner");
  });

  it("is the account the job runs as for the scene worker's approval request", async () => {
    configure(false);
    vi.doMock("../approval/index.js", async (importActual) => ({
      ...(await importActual<typeof import("../approval/index.js")>()),
      requestApprovalViaChannel: async () => true,
    }));
    vi.doMock("../agent/runtime.js", async (importActual) => ({
      ...(await importActual<typeof import("../agent/runtime.js")>()),
      runTurn: async (opts: { approvalCallback?: (tool: string, args: Record<string, unknown>) => Promise<boolean> }) => {
        await opts.approvalCallback?.("send_letter", { to: "the referring clinic" });
        return { response: "sent", toolCallsExecuted: 1, guardrailEvents: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, blocked: false };
      },
    }));
    const jobs = await import("../agent/jobs.js");
    const worker = await import("../agent/scene-worker.js");
    const published = await captureNotifications();

    const job = await jobs.createJob({
      sceneName: "referral_scene", task: "send the referral", turnTimeoutMs: 30_000,
      humanInLoopSteps: ["send_letter"], approvalChannel: "dashboard", ...ALICE,
    });
    expect(await worker.runSceneJobWorkerTick()).toBe(true);
    for (const deadline = Date.now() + 10_000; (await jobs.getJob(job.id))?.status !== "completed";) {
      if (Date.now() > deadline) throw new Error(`job stayed ${(await jobs.getJob(job.id))?.status}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const approval = published.find((n) => n.title === "Approval required");
    expect(approval).toBeDefined();
    expect(approval!.owner).toEqual(ALICE);
  });
});

describe("who receives a notification over the socket", () => {
  /** A signed-in socket per account, as the gateway opens it, and the notifications each received. */
  async function sockets(authEnabled: boolean) {
    configure(authEnabled);
    const [{ RpcConnection }, auth] = await Promise.all([import("../gateway/rpc.js"), import("../gateway/auth.js")]);
    const received = {} as Record<Who, string[]>;
    for (const who of Object.keys(ROSTER) as Who[]) {
      received[who] = [];
      const ws = {
        readyState: 1,
        send(raw: string) {
          const frame = JSON.parse(raw) as { type: string; data?: { title?: string } };
          if (frame.type === "notification.event") received[who].push(String(frame.data?.title));
        },
      };
      let conn: InstanceType<typeof RpcConnection>;
      if (authEnabled) {
        const user = await auth.authenticatedUserFromToken(await auth.createToken(who, testAccount(who, ROSTER[who]).claims));
        if (!user) throw new Error(`${who} did not sign in`);
        conn = new RpcConnection(ws as never, user.username, user.role, user);
      } else {
        conn = new RpcConnection(ws as never, who, ROSTER[who]);
      }
      await conn.handleMessage(JSON.stringify({ id: "sub", method: "notifications.subscribe", params: {} }));
    }
    return received;
  }

  it("under multi-user auth, sends an account's job notification to that account alone", async () => {
    const received = await sockets(true);
    const jobs = await import("../agent/jobs.js");
    const job = await jobs.createJob({ sceneName: "lab_import", task: "t", turnTimeoutMs: 30_000, ...ALICE });
    await jobs.failJob(job.id, "the lab server answered 503 for patient 4711");

    expect(received.alice).toEqual(["Job failed"]);
    expect(received.bob).toEqual([]);
    expect(received.vera).toEqual([]);
    expect(received.carol).toEqual([]);
  });

  it("under multi-user auth, sends a notification with no owner to operators and above, not to a viewer", async () => {
    const received = await sockets(true);
    const { publishNotification } = await import("../runtime/notifications.js");
    publishNotification({ title: "Job failed", message: "webhook_scene failed. boom", level: "error", jobId: "job-1", sessionId: "s-1" });

    expect(received.alice).toEqual(["Job failed"]);
    expect(received.bob).toEqual(["Job failed"]);
    expect(received.carol).toEqual(["Job failed"]);
    expect(received.vera).toEqual([]);
  });

  it("with auth off, sends every notification to every socket, as before", async () => {
    const received = await sockets(false);
    const { publishNotification } = await import("../runtime/notifications.js");
    publishNotification({ title: "Job failed", message: "webhook_scene failed. boom", level: "error" });
    publishNotification({ title: "Follow-up: x", message: "m", owner: ALICE });

    for (const who of Object.keys(ROSTER) as Who[]) expect(received[who], who).toEqual(["Job failed", "Follow-up: x"]);
  });
});
