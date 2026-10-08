import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRODUCT } from "../product/index.js";

/**
 * An account sees and acts on its own scene and job runs only (found in review, 2026-10-08).
 *
 * The job store holds every account's runs, each with the user it ran as and the answer it gave.
 * GET /api/scenes/jobs and /:jobId returned all of them, raw user id included, to any signed-in
 * account, and any account could cancel or delete any of them. Under multi-user auth a non-admin
 * now lists, reads, cancels and deletes the runs made as themselves, without the user id; an admin
 * does all of it for every run. These run against the whole gateway.
 */
const tempDirs: string[] = [];
const ENV_KEYS = ["SAI_CONFIG_PATH", "SAI_MASTER_KEY", "SAI_CRED_STORE", "SAI_AUDIT_LOG", "SAI_JWT_SECRET"];

afterEach(async () => {
  const audit = await import("../audit/logger.js");
  await audit.flushAuditLog();
  (await import("../config/loader.js")).resetConfigForTests();
  (await import("../gateway/auth.js")).resetAuthStateForTests();
  await (await import("../agent/jobs.js")).resetJobsForTests();
  for (const key of ENV_KEYS) delete process.env[key];
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

async function bootGateway(authEnabled: boolean) {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-scene-job-access-"));
  tempDirs.push(tempDir);
  const configDir = join(tempDir, "config");
  mkdirSync(configDir, { recursive: true });
  const port = 35_000 + Math.floor(Math.random() * 2_000);
  writeFileSync(join(configDir, "10-test.json"), JSON.stringify({
    gateway: { port, jwtSecret: "j".repeat(40) },
    workspacePath: tempDir,
    ...(authEnabled ? { auth: { enabled: true } } : {}),
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configDir;
  process.env["SAI_MASTER_KEY"] = "m".repeat(32);
  process.env["SAI_CRED_STORE"] = join(tempDir, PRODUCT.stateDirName, "credentials.enc");
  process.env["SAI_AUDIT_LOG"] = join(tempDir, "audit.jsonl");
  vi.resetModules();
  // Sequential imports: these modules import each other.
  const { createGateway } = await import("../gateway/index.js");
  const auth = await import("../gateway/auth.js");
  const jobs = await import("../agent/jobs.js");
  const gateway = createGateway();
  await gateway.start();
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    const healthy = await fetch(`${baseUrl}/healthz`).then((response) => response.ok, () => false);
    if (healthy) break;
    if (Date.now() > deadline) throw new Error("gateway did not start");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const send = async (user: string, role: string, method: string, path: string) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await auth.createToken(user, { role })}` },
    });
    return { status: response.status, text: await response.text() };
  };
  /** One run each for Alice and Bob, a finished one for Alice, and one a webhook started. */
  const seed = async () => {
    const run = (sceneName: string, userId: string) => jobs.createJob({ sceneName, userId, task: `${sceneName} task`, turnTimeoutMs: 30_000 });
    const alice = await run("alice_scene", "alice");
    const aliceDone = await run("alice_finished_scene", "alice");
    await jobs.cancelJob(aliceDone.id);
    const bob = await run("bob_scene", "bob");
    const webhook = await run("webhook_scene", "scene:webhook_scene");
    return { alice, aliceDone, bob, webhook };
  };
  return { send, seed, jobs, stop: () => gateway.stop() };
}

describe("scene and job runs and the account that made them", () => {
  it("under multi-user auth, an account lists, reads, cancels and deletes only its own runs, without the user they ran as", async () => {
    const gw = await bootGateway(true);
    try {
      const { alice, aliceDone, bob } = await gw.seed();

      const listed = await gw.send("bob", "operator", "GET", "/api/scenes/jobs?limit=50");
      expect(listed.status).toBe(200);
      const jobs = (JSON.parse(listed.text) as { jobs: Array<Record<string, unknown>> }).jobs;
      expect(jobs.map((job) => job["id"])).toEqual([bob.id]);
      expect(listed.text).not.toContain("alice");
      expect(listed.text).not.toContain("\"userId\"");
      // Chosen before the limit: the webhook's run is newer than Bob's, and is not his.
      const newest = await gw.send("bob", "operator", "GET", "/api/scenes/jobs?limit=1");
      expect((JSON.parse(newest.text) as { jobs: Array<Record<string, unknown>> }).jobs.map((job) => job["id"])).toEqual([bob.id]);

      const own = await gw.send("bob", "operator", "GET", `/api/scenes/jobs/${bob.id}`);
      expect(own.status).toBe(200);
      expect(own.text).not.toContain("\"userId\"");
      expect((await gw.send("bob", "operator", "GET", `/api/scenes/jobs/${alice.id}`)).status).toBe(404);

      expect((await gw.send("bob", "operator", "POST", `/api/scenes/jobs/${alice.id}/cancel`)).status).toBe(404);
      expect((await gw.jobs.getJob(alice.id))?.status).not.toMatch(/cancel/);
      expect((await gw.send("bob", "operator", "DELETE", `/api/scenes/jobs/${aliceDone.id}`)).status).toBe(404);
      expect(await gw.jobs.getJob(aliceDone.id)).toBeDefined();

      const cancelled = await gw.send("bob", "operator", "POST", `/api/scenes/jobs/${bob.id}/cancel`);
      expect(cancelled.status).toBe(200);
      expect(cancelled.text).not.toContain("\"userId\"");
    } finally {
      await gw.stop();
    }
  }, 60_000);

  it("under multi-user auth, an admin sees and acts on every run, with the user it ran as", async () => {
    const gw = await bootGateway(true);
    try {
      const { alice, aliceDone, bob, webhook } = await gw.seed();

      const listed = await gw.send("carol", "admin", "GET", "/api/scenes/jobs?limit=50");
      const jobs = (JSON.parse(listed.text) as { jobs: Array<Record<string, unknown>> }).jobs;
      expect(jobs.map((job) => job["id"]).sort()).toEqual([alice.id, aliceDone.id, bob.id, webhook.id].sort());
      expect(jobs.find((job) => job["id"] === alice.id)).toMatchObject({ userId: "alice" });

      expect((await gw.send("carol", "admin", "DELETE", `/api/scenes/jobs/${aliceDone.id}`)).status).toBe(200);
      expect((await gw.send("carol", "admin", "POST", `/api/scenes/jobs/${alice.id}/cancel`)).status).toBe(200);
    } finally {
      await gw.stop();
    }
  }, 60_000);

  it("with one operator, lists every run with the user it ran as, as before", async () => {
    const gw = await bootGateway(false);
    try {
      const { alice, bob } = await gw.seed();

      const listed = await gw.send("admin", "operator", "GET", "/api/scenes/jobs?limit=50");
      const jobs = (JSON.parse(listed.text) as { jobs: Array<Record<string, unknown>> }).jobs;
      expect(jobs).toHaveLength(4);
      expect(jobs.find((job) => job["id"] === alice.id)).toMatchObject({ userId: "alice" });
      expect((await gw.send("admin", "operator", "GET", `/api/scenes/jobs/${bob.id}`)).text).toContain("\"userId\":\"bob\"");
    } finally {
      await gw.stop();
    }
  }, 60_000);
});
