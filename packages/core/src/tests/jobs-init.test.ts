/**
 * The job and mission tables carry the account a row belongs to by its immutable id, next to the
 * username in user_id (which a re-created account shares). The column is created by each store's
 * own init, on every boot, so the account migration only ever fills it in: it never changes a
 * table under a running gateway. Recorded SQL against a fake pool; no database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const recorded = vi.hoisted(() => [] as string[]);

vi.mock("pg", () => {
  class FakeClient {
    async query(sql: string) {
      recorded.push(sql);
      return { rows: [], rowCount: 0 };
    }
    release() {}
  }
  class FakePool {
    async query(sql: string) {
      recorded.push(sql);
      return { rows: [], rowCount: 0 };
    }
    async connect() {
      return new FakeClient();
    }
    async end() {}
  }
  return { default: { Pool: FakePool } };
});

/** Every statement recorded, one per line, whitespace folded. */
const statements = (): string[] => recorded.flatMap((sql) => sql.split(";")).map((sql) => sql.replace(/\s+/g, " ").trim()).filter(Boolean);

beforeEach(() => {
  recorded.length = 0;
  process.env["DATABASE_URL"] = "postgres://user:pw@host:5432/db";
  vi.resetModules();
});

afterEach(() => {
  delete process.env["DATABASE_URL"];
});

describe("account_id in the job and mission tables", () => {
  it("scene_jobs init adds the column and its index", async () => {
    const jobs = await import("../agent/jobs.js");
    await jobs.initSceneJobStore();
    const all = statements();
    expect(all).toContain("ALTER TABLE scene_jobs ADD COLUMN IF NOT EXISTS account_id TEXT");
    expect(all).toContain("CREATE INDEX IF NOT EXISTS idx_scene_jobs_account ON scene_jobs (account_id)");
    // After the table exists, before the store serves anything.
    const created = all.findIndex((sql) => sql.startsWith("CREATE TABLE IF NOT EXISTS scene_jobs"));
    const added = all.indexOf("ALTER TABLE scene_jobs ADD COLUMN IF NOT EXISTS account_id TEXT");
    const recovery = all.findIndex((sql) => sql.startsWith("UPDATE scene_jobs"));
    expect(created).toBeGreaterThanOrEqual(0);
    expect(added).toBeGreaterThan(created);
    expect(recovery).toBeGreaterThan(added);
    await jobs.shutdownSceneJobStore();
  });

  it("missions init adds the column and its index, inside the locked DDL transaction", async () => {
    const missions = await import("../swarm/mission-store.js");
    await missions.getMissionStore();
    const all = statements();
    const lock = all.indexOf("SELECT pg_advisory_xact_lock(7264510001)");
    const added = all.indexOf("ALTER TABLE missions ADD COLUMN IF NOT EXISTS account_id TEXT");
    const indexed = all.indexOf("CREATE INDEX IF NOT EXISTS idx_missions_account ON missions (account_id)");
    const commit = all.indexOf("COMMIT");
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(added).toBeGreaterThan(lock);
    expect(indexed).toBeGreaterThan(added);
    expect(commit).toBeGreaterThan(indexed);
    await missions.resetMissionStoreForTests();
  });
});
