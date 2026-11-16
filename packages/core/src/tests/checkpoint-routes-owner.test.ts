import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { PRODUCT } from "../product/index.js";
import type { Identity } from "../runtime/accounts.js";
import { testAccount } from "./support/test-account.js";

/**
 * The Swarm dashboard's checkpoint routes and the account a checkpoint belongs to (found in review,
 * 2026-11-14).
 *
 * A checkpoint holds a delegated run's task, its progress note, a summary of the work so far and
 * the agent's saved state. GET /api/checkpoints listed every account's to any caller that signed in
 * (a patient read a checkpoint another account's run had written, with the details of its task),
 * and resume and complete acted on any task id. Under multi-user auth a checkpoint is now the
 * account's its run executed as (the owner the run stamps on it), else, for one that names no owner,
 * the session's it was started from (callerMayUseSession). Another account's reads as not found,
 * and an admin sees every one. With auth off every caller sees all of them, as before.
 */
const SESSION_STORE_DIR = vi.hoisted(() => {
  // The session store resolves its path when the module loads; a temp one, not the source tree's.
  const { mkdtempSync: mk } = require("node:fs") as typeof import("node:fs");
  const { tmpdir: tmp } = require("node:os") as typeof import("node:os");
  const { join: j } = require("node:path") as typeof import("node:path");
  const dir = mk(j(tmp(), "checkpoint-routes-sessions-"));
  process.env["SAI_SESSION_STORE"] = j(dir, "sessions.json");
  return dir;
});

const dirs: string[] = [];

afterEach(async () => {
  const session = await import("../agent/session.js");
  for (const active of session.getAllSessions()) session.endSession(active.id);
  delete process.env["SAI_CONFIG_PATH"];
  (await import("../config/loader.js")).resetConfigForTests();
  (await import("../gateway/auth.js")).resetAuthStateForTests();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

afterAll(() => {
  delete process.env["SAI_SESSION_STORE"];
  rmSync(SESSION_STORE_DIR, { recursive: true, force: true });
});

const ROSTER = { alice: "operator", bob: "operator", carol: "admin" } as const;
type Who = keyof typeof ROSTER;

/** Alice's and Bob's chats, each with a paused checkpoint of a run delegated from it. */
async function deployment(authEnabled: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "checkpoint-routes-"));
  dirs.push(dir);
  writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
    workspacePath: dir,
    gateway: { jwtSecret: "c".repeat(40) },
    ...(authEnabled ? { auth: { enabled: true, users: Object.entries(ROSTER).map(([name, role]) => testAccount(name, role).record) } } : {}),
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
  vi.resetModules();
  const [{ registerCheckpointRoutes }, auth, session, checkpoints] = await Promise.all([
    import("../gateway/checkpoint-routes.js"),
    import("../gateway/auth.js"),
    import("../agent/session.js"),
    import("../swarm/checkpoints.js"),
  ]);
  const app = new Hono();
  registerCheckpointRoutes(app);

  /** Who `who`'s chats and runs belong to: the name with the account id (no account with auth off). */
  const identityOf = (who: Who): Identity => ({ userId: who, ...(authEnabled ? { account: testAccount(who).id } : {}) });
  // Each chat as the socket opens it.
  const chatOf = (who: Who) => session.createSession({ channel: "webchat", ...identityOf(who) }).id;
  /**
   * A paused checkpoint of a run that worked in `parentSessionId`. `owner` is who the run executed
   * as, which sub-agent.ts stamps on the checkpoint it opens; none for one written before that.
   */
  const pausedCheckpoint = (parentSessionId: string, task: string, owner?: Identity) => {
    const created = checkpoints.createCheckpoint({ agentName: "researcher", parentSessionId, task, ...(owner ? { owner } : {}) });
    checkpoints.pauseCheckpoint(created.taskId, { progressNote: `${task}: halfway`, conversationSummary: "notes", elapsedMs: 1_000, iterationsCompleted: 1 });
    return created.taskId;
  };
  /** A paused checkpoint of a specialist run delegated from `who`'s chat: `sub:<chat>:<agent>:<stamp>`.
   *  A chat's turn, and so its runs, execute as the chat's owner. */
  const pausedCheckpointOf = (who: Who, task: string) => pausedCheckpoint(`sub:${chatOf(who)}:researcher:1731571200000`, task, identityOf(who));
  const alices = pausedCheckpointOf("alice", "summarise Alice's lab results");
  const bobs = pausedCheckpointOf("bob", "draft Bob's referral letter");

  const request = async (who: Who, method: string, path: string): Promise<Response> => {
    const claims = authEnabled ? testAccount(who, ROSTER[who]).claims : { role: ROSTER[who] };
    return app.request(path, { method, headers: { Authorization: `Bearer ${await auth.createToken(who, claims)}` } });
  };
  const listedBy = async (who: Who): Promise<string[]> => {
    const response = await request(who, "GET", "/api/checkpoints");
    expect(response.status).toBe(200);
    return ((await response.json()) as { checkpoints: Array<{ taskId: string }> }).checkpoints.map((cp) => cp.taskId).sort();
  };
  return { dir, request, listedBy, alices, bobs, checkpoints, session, identityOf, chatOf, pausedCheckpoint };
}

describe("checkpoint routes and the account a checkpoint belongs to", () => {
  it("under multi-user auth, lists to each account the checkpoints of its own chats, and every one to an admin", async () => {
    const d = await deployment(true);
    expect(await d.listedBy("alice")).toEqual([d.alices]);
    expect(await d.listedBy("bob")).toEqual([d.bobs]);
    expect(await d.listedBy("carol")).toEqual([d.alices, d.bobs].sort());

    // What the list carried: the task and progress of another account's run.
    const asBob = await (await d.request("bob", "GET", "/api/checkpoints")).text();
    expect(asBob).not.toContain("Alice's lab results");
  });

  it("under multi-user auth, resumes and completes another account's checkpoint as not found, and does neither", async () => {
    const d = await deployment(true);

    const resume = await d.request("alice", "POST", `/api/checkpoints/${d.bobs}/resume`);
    expect(resume.status).toBe(404);
    expect(d.checkpoints.getCheckpoint(d.bobs)?.status).toBe("paused");
    const complete = await d.request("alice", "POST", `/api/checkpoints/${d.bobs}/complete`);
    expect(complete.status).toBe(404);
    expect(d.checkpoints.getCheckpoint(d.bobs)).toBeDefined();
    // The reply a missing id gets, word for word.
    expect(await resume.text()).toBe(await (await d.request("alice", "POST", "/api/checkpoints/no-such-task/resume")).text());

    // Its owner may.
    const own = await d.request("bob", "POST", `/api/checkpoints/${d.bobs}/resume`);
    expect(own.status).toBe(200);
    expect(((await own.json()) as { checkpoint: { status: string } }).checkpoint.status).toBe("resumed");
    expect((await d.request("bob", "POST", `/api/checkpoints/${d.bobs}/complete`)).status).toBe(200);

    // An admin may act on any.
    expect((await d.request("carol", "POST", `/api/checkpoints/${d.alices}/resume`)).status).toBe(200);
  });

  it("under multi-user auth, keeps a run's checkpoint its account's where no chat decides: an A2A run, a job whose session was pruned", async () => {
    // Found in review, 2026-11-14: the chat a run was delegated from decided alone, so these were an
    // admin's only, though the account's own run wrote them.
    const d = await deployment(true);
    // An A2A or MCP tasks/send run works in `a2a-in:<account>:<id>`, which has no session record.
    const a2a = d.pausedCheckpoint(`a2a-in:${testAccount("alice").id}:task-1`, "Alice's A2A task", d.identityOf("alice"));
    // A scene job's runs are delegated from the job's session, which the pruner deletes an hour after
    // the job ends (gateway.sessionTtlMs), while its checkpoints are kept for 24 hours.
    const jobSession = d.session.createSession({ channel: "scene", ...d.identityOf("alice") });
    const job = d.pausedCheckpoint(`sub:${jobSession.id}:researcher:1731571200000`, "Alice's scene job", d.identityOf("alice"));
    d.session.deleteSession(jobSession.id, "pruned");

    expect(await d.listedBy("alice")).toEqual([d.alices, a2a, job].sort());
    expect(await d.listedBy("bob")).toEqual([d.bobs]);
    expect(await d.listedBy("carol")).toEqual([d.alices, d.bobs, a2a, job].sort());
    expect((await d.request("bob", "POST", `/api/checkpoints/${a2a}/resume`)).status).toBe(404);
    expect((await d.request("alice", "POST", `/api/checkpoints/${a2a}/resume`)).status).toBe(200);
    expect((await d.request("bob", "POST", `/api/checkpoints/${job}/complete`)).status).toBe(404);
    expect((await d.request("alice", "POST", `/api/checkpoints/${job}/complete`)).status).toBe(200);
  });

  it("under multi-user auth, leaves a checkpoint that names no owner to the chat it was delegated from", async () => {
    // Written before owners were stamped, or by a run that executed as nobody.
    const d = await deployment(true);
    const older = d.pausedCheckpoint(`sub:${d.chatOf("alice")}:researcher:1731571200000`, "an older run of Alice's");
    expect(await d.listedBy("alice")).toContain(older);
    expect(await d.listedBy("bob")).not.toContain(older);
    // With no chat behind it, it is an admin's.
    const unattended = d.pausedCheckpoint(`a2a-in:${randomUUID()}`, "a shared-bearer caller's task");
    expect(await d.listedBy("alice")).not.toContain(unattended);
    expect(await d.listedBy("carol")).toContain(unattended);
  });

  it("never sends whose a checkpoint is", async () => {
    // Like a notification's owner, it decides who gets the record and is no part of it.
    const d = await deployment(true);
    expect(d.checkpoints.getCheckpoint(d.alices)?.owner).toEqual(d.identityOf("alice"));
    const listed = (await (await d.request("carol", "GET", "/api/checkpoints")).json()) as { checkpoints: Array<Record<string, unknown>> };
    expect(listed.checkpoints).toHaveLength(2);
    for (const checkpoint of listed.checkpoints) expect(checkpoint).not.toHaveProperty("owner");
    const resumed = (await (await d.request("alice", "POST", `/api/checkpoints/${d.alices}/resume`)).json()) as { checkpoint: Record<string, unknown> };
    expect(resumed.checkpoint.taskId).toBe(d.alices);
    expect(resumed.checkpoint).not.toHaveProperty("owner");
  });

  it("with auth off, lists and acts on every checkpoint, as before", async () => {
    const d = await deployment(false);
    expect(await d.listedBy("alice")).toEqual([d.alices, d.bobs].sort());
    expect((await d.request("alice", "POST", `/api/checkpoints/${d.bobs}/resume`)).status).toBe(200);
  });

  it("takes a task id for a checkpoint id only, so a percent-encoded path cannot reach a file outside the checkpoints", async () => {
    // Hono decodes `%2F` in a route parameter: `..%2Fvictim` arrived as `../victim`, the store read
    // `<checkpoints>/../victim.json`, and complete deleted it. With auth off nobody's owner is checked,
    // so only the id stands between a caller and the file.
    const d = await deployment(false);
    const stateDir = join(d.dir, PRODUCT.stateDirName);
    mkdirSync(stateDir, { recursive: true });
    const victim = join(stateDir, "victim.json");
    writeFileSync(victim, JSON.stringify({ taskId: "victim", parentSessionId: "x", status: "paused", agentName: "a", agentState: {} }), "utf8");

    expect((await d.request("alice", "POST", "/api/checkpoints/..%2Fvictim/complete")).status).toBe(404);
    expect((await d.request("alice", "POST", "/api/checkpoints/..%2Fvictim/resume")).status).toBe(404);
    expect(existsSync(victim)).toBe(true);
  });
});
