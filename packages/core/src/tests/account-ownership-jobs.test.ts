import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../runtime/accounts.js";
import { testAccount, type TestAccount } from "./support/test-account.js";

/**
 * A scene or job run is its owner's by identity, not by the name it ran as (S3, ownsRecord).
 *
 * GET /api/scenes/jobs listed, and /:jobId read, cancelled and deleted, the runs whose user_id was
 * the caller's username: an account deleted and created again under the same name took over every
 * run the old one left, in memory and in Postgres. Both stores now choose by the account id (or by
 * a principal's kind and name), and the per-run check is ownsRecord.
 */

const recorded = vi.hoisted(() => [] as Array<{ sql: string; params: unknown[] }>);
vi.mock("pg", () => {
  class FakeClient {
    async query(sql: string, params: unknown[] = []) {
      recorded.push({ sql, params });
      return { rows: [], rowCount: 0 };
    }
    release() {}
  }
  class FakePool {
    async query(sql: string, params: unknown[] = []) {
      recorded.push({ sql, params });
      return { rows: [], rowCount: 0 };
    }
    async connect() { return new FakeClient(); }
    async end() {}
    on() {}
  }
  return { default: { Pool: FakePool } };
});

const dirs: string[] = [];

afterEach(async () => {
  recorded.length = 0;
  await (await import("../agent/jobs.js")).resetJobsForTests();
  delete process.env["DATABASE_URL"];
  delete process.env["SAI_CONFIG_PATH"];
  delete process.env["SAI_JOB_WAKE_DISABLED"];
  (await import("../config/loader.js")).resetConfigForTests();
  (await import("../gateway/auth.js")).resetAuthStateForTests();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

/** The same username under another id: an account deleted and created again. */
function recreated(username: string, role = "operator"): TestAccount {
  const base = testAccount(username, role);
  const id = `${username}-${"b".repeat(16)}`;
  return { id, record: { ...base.record, id }, claims: { ...base.claims, aid: id } };
}

const root = testAccount("root", "admin");
const oldAlice = testAccount("alice");
const newAlice = recreated("alice");
const OLD_ALICE: Identity = { userId: "alice", account: oldAlice.id };
const NEW_ALICE: Identity = { userId: "alice", account: newAlice.id };

/** A deployment where the old alice is gone and a new account holds her name. */
async function deployment(opts: { postgres?: boolean; authEnabled?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "starlingai-ownership-jobs-"));
  dirs.push(dir);
  writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
    workspacePath: dir,
    gateway: { jwtSecret: "j".repeat(40) },
    ...(opts.authEnabled === false ? {} : { auth: { enabled: true, users: [root.record, newAlice.record] } }),
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
  process.env["SAI_JOB_WAKE_DISABLED"] = "1";
  if (opts.postgres) process.env["DATABASE_URL"] = "postgres://user:pw@host:5432/db";
  vi.resetModules();
  const jobs = await import("../agent/jobs.js");
  const access = await import("../gateway/scene-job-access.js");
  const auth = await import("../gateway/auth.js");
  const header = async (username: string, claims: Record<string, unknown>) => `Bearer ${await auth.createToken(username, claims)}`;
  return { jobs, access, header };
}

describe("scene and job runs of a re-created account", () => {
  it("in memory: the new account lists, reads, cancels and deletes only its own runs", async () => {
    const { jobs, access, header } = await deployment();
    const old = await jobs.createJob({ sceneName: "old_scene", ...OLD_ALICE, task: "old", turnTimeoutMs: 30_000 });
    const own = await jobs.createJob({ sceneName: "own_scene", ...NEW_ALICE, task: "own", turnTimeoutMs: 30_000 });
    const legacy = await jobs.createJob({ sceneName: "legacy_scene", userId: "alice", task: "legacy", turnTimeoutMs: 30_000 });

    const viewer = await access.sceneJobViewer(await header("alice", newAlice.claims));
    expect(viewer.all).toBe(false);
    // The listing route's filter, chosen in the store before the limit.
    const listed = await jobs.listJobs({ limit: 50, owner: viewer.identity });
    expect(listed.map((job) => job.id)).toEqual([own.id]);
    // The read, cancel and delete routes' gate.
    expect(access.canSeeSceneJob(viewer, old)).toBe(false);
    expect(access.canSeeSceneJob(viewer, legacy)).toBe(false);
    expect(access.canSeeSceneJob(viewer, own)).toBe(true);

    const admin = await access.sceneJobViewer(await header("root", root.claims));
    expect(admin.all).toBe(true);
    expect(access.canSeeSceneJob(admin, old)).toBe(true);
  });

  it("in Postgres: the listing chooses by account_id, never by user_id", async () => {
    const { jobs, access, header } = await deployment({ postgres: true });
    await jobs.initSceneJobStore();
    recorded.length = 0;
    const viewer = await access.sceneJobViewer(await header("alice", newAlice.claims));
    await jobs.listJobs({ limit: 10, owner: viewer.identity });
    const select = recorded.find((call) => /SELECT \*\s+FROM scene_jobs/.test(call.sql));
    expect(select).toBeDefined();
    expect(select!.sql).toMatch(/WHERE account_id = \$1/);
    expect(select!.sql).not.toMatch(/user_id =/);
    expect(select!.params).toEqual([newAlice.id, 10]);

    // A principal's runs: its name, its kind (in the payload), and no account.
    recorded.length = 0;
    await jobs.listJobs({ limit: 10, owner: { userId: "admin", principal: "bootstrap" } });
    const principal = recorded.find((call) => /SELECT \*\s+FROM scene_jobs/.test(call.sql));
    expect(principal!.sql).toMatch(/account_id IS NULL AND user_id = \$1 AND payload->>'principal' = \$2/);
    expect(principal!.params).toEqual(["admin", "bootstrap", 10]);
    await jobs.shutdownSceneJobStore();
  });

  it("with one operator, a listing by owner is by the name, as before", async () => {
    const { jobs } = await deployment({ authEnabled: false });
    const alices = await jobs.createJob({ sceneName: "a", userId: "alice", task: "a", turnTimeoutMs: 30_000 });
    await jobs.createJob({ sceneName: "b", userId: "bob", task: "b", turnTimeoutMs: 30_000 });
    expect((await jobs.listJobs({ owner: { userId: "alice" } })).map((job) => job.id)).toEqual([alices.id]);
  });
});
