import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRODUCT } from "../product/index.js";

/**
 * A caller with no credential learns nothing about which scenes, jobs and approvals exist.
 *
 * POST /api/scenes/:name/run and POST /api/jobs/:name/run looked the name up before they checked
 * the caller, so with no token and no key an unknown name answered 404 "Scene not found: x" and a
 * real one 401: anyone could list the scene and job names by trying them. The approval callbacks
 * did the same with an approval id: 404 for an unknown id, 403 for a real one with a wrong secret.
 * And a key or secret as long as the real one but with a character outside ASCII made the
 * constant-time comparison throw, a 500 that only a real name gave. Now a caller who presents no
 * valid credential gets one answer for a name that exists and one that does not: 401 on the run
 * routes, the not-found answer on the approval callbacks (the per-approval secret is their only
 * credential). A signed-in caller still gets 404 for an unknown name, and the webhook keys and
 * approval secrets still work. These run against the whole gateway, on loopback.
 *
 * The same answer was not enough while the run routes still looked the name up to read its webhook
 * key: a stored job is parsed and validated, an unknown name is one store miss, and that gap (about
 * 30 us on loopback) told the names apart by timing the 401. Any `?key=` forced the lookup. So the
 * run routes now decide on a token or a key without looking the name up at all, which the lookups
 * recorded below show.
 */
const SCENE_KEY = "scene-webhook-key-0123456789";
const JOB_KEY = "job-webhook-key-0123456789ab";
const STORED_SCENE_KEY = "stored-scene-key-0123456789";
const STORED_JOB_KEY = "stored-job-key-0123456789abc";
const APPROVAL_SECRET = "approval-secret-0123456789abcdef";
const UNKNOWN_APPROVAL = "00000000-0000-4000-8000-000000000000";
const ENV_SCENE_KEY_VAR = "ANON_PROBE_SCENE_KEY";
const ENV_KEYS = ["SAI_CONFIG_PATH", "SAI_MASTER_KEY", "SAI_CRED_STORE", "SAI_AUDIT_LOG", "SAI_JOB_WAKE_DISABLED", ENV_SCENE_KEY_VAR];

/** Every per-name scene/job lookup and credential-store read the gateway makes, in order. */
const lookups = vi.hoisted(() => [] as string[]);
vi.mock("../credentials/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../credentials/store.js")>();
  return { ...actual, getCredential: (name: string) => (lookups.push(`getCredential ${name}`), actual.getCredential(name)) };
});
vi.mock("../credentials/scenes.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../credentials/scenes.js")>();
  return { ...actual, getScene: (name: string) => (lookups.push(`getScene ${name}`), actual.getScene(name)) };
});
vi.mock("../credentials/jobs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../credentials/jobs.js")>();
  return { ...actual, getJobDefinition: (name: string) => (lookups.push(`getJobDefinition ${name}`), actual.getJobDefinition(name)) };
});

let tempDir = "";
let configFile = "";
let baseUrl = "";
let stopGateway: () => Promise<void> = async () => {};
let mods: {
  auth: typeof import("../gateway/auth.js");
  approvals: typeof import("../approval/store.js");
  jobs: typeof import("../agent/jobs.js");
  config: typeof import("../config/loader.js");
  scenes: typeof import("../credentials/scenes.js");
  jobDefinitions: typeof import("../credentials/jobs.js");
};

const configShard = (sceneKey: string) => JSON.stringify({
  gateway: { jwtSecret: "j".repeat(40) },
  workspacePath: tempDir,
  scenes: { ferry_check: { description: "Checks the ferries.", task: "Check the ferry times.", webhookKey: sceneKey } },
  jobs: {
    ops_brief: {
      description: "An ops brief.",
      steps: [{ scene: "ferry_check" }],
      triggers: [{ type: "api", webhookKey: JOB_KEY }],
    },
  },
});

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "starlingai-anon-probe-"));
  const configDir = join(tempDir, "config");
  mkdirSync(configDir, { recursive: true });
  configFile = join(configDir, "10-test.json");
  writeFileSync(configFile, configShard(SCENE_KEY), "utf8");
  process.env["SAI_CONFIG_PATH"] = configDir;
  process.env["SAI_MASTER_KEY"] = "m".repeat(32);
  process.env["SAI_CRED_STORE"] = join(tempDir, PRODUCT.stateDirName, "credentials.enc");
  process.env["SAI_AUDIT_LOG"] = join(tempDir, "audit.jsonl");
  process.env["SAI_JOB_WAKE_DISABLED"] = "1";
  vi.resetModules();
  // Sequential imports: these modules import each other.
  const { createGateway } = await import("../gateway/index.js");
  const auth = await import("../gateway/auth.js");
  const approvals = await import("../approval/store.js");
  const jobs = await import("../agent/jobs.js");
  const config = await import("../config/loader.js");
  const scenes = await import("../credentials/scenes.js");
  const jobDefinitions = await import("../credentials/jobs.js");
  mods = { auth, approvals, jobs, config, scenes, jobDefinitions };
  // A scene and a job saved in the credential store, as the dashboard saves them: looking one up
  // reads and parses the store, which made a stored name slower to refuse than an unknown one.
  scenes.saveScene("stored_scene", { description: "A stored scene.", task: "Do the stored thing.", webhookKey: STORED_SCENE_KEY });
  jobDefinitions.saveJobDefinition("stored_job", {
    description: "A stored job.",
    steps: [{ scene: "ferry_check" }],
    triggers: [{ type: "api", webhookKey: STORED_JOB_KEY }],
  });

  const gateway = createGateway();
  // The gateway listens on <gateway.host>:<gateway.port> (127.0.0.1 outside Docker, 0.0.0.0 in a
  // container); the test binds loopback on a port the OS picks.
  let server: Server | undefined;
  const listen = Server.prototype.listen as (this: Server, port: number, host: string, onListening?: () => void) => Server;
  const listenSpy = vi.spyOn(Server.prototype, "listen").mockImplementation(function (this: Server, ...args: unknown[]) {
    const onListening = args.find((arg): arg is () => void => typeof arg === "function");
    server = listen.call(this, 0, "127.0.0.1", onListening);
    return server;
  } as typeof Server.prototype.listen);
  try {
    await gateway.start();
  } finally {
    listenSpy.mockRestore();
  }
  baseUrl = `http://127.0.0.1:${(server?.address() as AddressInfo).port}`;
  stopGateway = () => gateway.stop();
}, 60_000);

afterAll(async () => {
  await stopGateway();
  await (await import("../audit/logger.js")).flushAuditLog();
  mods.config.resetConfigForTests();
  mods.auth.resetAuthStateForTests();
  await mods.jobs.resetJobsForTests();
  for (const key of ENV_KEYS) delete process.env[key];
  rmSync(tempDir, { recursive: true, force: true });
});

async function call(method: string, path: string, init: { headers?: Record<string, string>; body?: unknown } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}), ...init.headers },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  return { status: response.status, body: await response.text() };
}

const operator = async () => ({ Authorization: `Bearer ${await mods.auth.createToken("operator", { role: "operator" })}` });

/** As long as the real key, so only the comparison itself can tell them apart. */
const outsideAscii = (secret: string) => encodeURIComponent("é".repeat(secret.length));

describe("the scene and job run routes, for a caller with no valid credential", () => {
  const routes = [
    { kind: "scene", known: "/api/scenes/ferry_check/run", unknown: "/api/scenes/no_such_scene/run", key: SCENE_KEY },
    { kind: "job", known: "/api/jobs/ops_brief/run", unknown: "/api/jobs/no_such_job/run", key: JOB_KEY },
  ];

  for (const route of routes) {
    it(`a ${route.kind} that exists and one that does not get the same 401`, async () => {
      const attempts: Array<{ query: string; headers?: Record<string, string> }> = [
        { query: "" },
        { query: "?key=wrong-key-but-long-enough-0000" },
        { query: `?key=${"x".repeat(route.key.length)}` },
        { query: `?key=${outsideAscii(route.key)}` },
        { query: "", headers: { Authorization: "Bearer not-a-token" } },
      ];
      for (const attempt of attempts) {
        const known = await call("POST", `${route.known}${attempt.query}`, { headers: attempt.headers });
        const unknown = await call("POST", `${route.unknown}${attempt.query}`, { headers: attempt.headers });
        expect(known, `${route.kind} ${attempt.query || JSON.stringify(attempt.headers ?? {})}`).toEqual({ status: 401, body: JSON.stringify({ error: "Unauthorized" }) });
        expect(unknown, `${route.kind} ${attempt.query || JSON.stringify(attempt.headers ?? {})}`).toEqual(known);
      }
      // One resource's key opens only that resource.
      expect(await call("POST", `${route.unknown}?key=${route.key}`)).toEqual({ status: 401, body: JSON.stringify({ error: "Unauthorized" }) });
    });
  }

  it("a signed-in caller still gets 404 for an unknown scene or job", async () => {
    const headers = await operator();
    expect(await call("POST", "/api/scenes/no_such_scene/run", { headers })).toEqual({ status: 404, body: JSON.stringify({ error: "Scene not found: no_such_scene" }) });
    expect(await call("POST", "/api/jobs/no_such_job/run", { headers })).toEqual({ status: 404, body: JSON.stringify({ error: "Job not found: no_such_job" }) });
  });

  it("the webhook keys and a signed-in caller still run them", async () => {
    for (const run of [
      call("POST", `/api/scenes/ferry_check/run?key=${SCENE_KEY}`),
      call("POST", "/api/scenes/ferry_check/run", { headers: { "X-Scene-Key": SCENE_KEY } }),
      call("POST", `/api/jobs/ops_brief/run?key=${JOB_KEY}`),
      call("POST", "/api/jobs/ops_brief/run", { headers: { "X-Job-Key": JOB_KEY } }),
      call("POST", "/api/scenes/ferry_check/run", { headers: await operator() }),
      call("POST", "/api/jobs/ops_brief/run", { headers: await operator() }),
    ]) {
      const response = await run;
      expect(response.status, response.body).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({ ok: true });
    }
  });
});

describe("the run routes decide on the caller without looking the name up", () => {
  const unauthorized = { status: 401, body: JSON.stringify({ error: "Unauthorized" }) };
  const routes = [
    { kind: "scene", path: (name: string) => `/api/scenes/${name}/run`, names: ["ferry_check", "stored_scene", "no_such_scene"] },
    { kind: "job", path: (name: string) => `/api/jobs/${name}/run`, names: ["ops_brief", "stored_job", "no_such_job"] },
  ];

  for (const route of routes) {
    it(`a ${route.kind} in config, one in the store and an unknown one are refused without a lookup`, async () => {
      // The first keyed call after a store write indexes the keys of every scene and job, work that
      // does not depend on the name asked for. It runs here, so the calls below show per-call work.
      expect(await call("POST", `${route.path("warm_up")}?key=warm-up-key-00000000000`)).toEqual(unauthorized);
      const attempts: Array<{ query: string; headers?: Record<string, string> }> = [
        { query: "" },
        { query: "?key=x" },
        { query: "?key=wrong-key-but-long-enough-0000" },
        { query: "", headers: { Authorization: "Bearer not-a-token" } },
      ];
      for (const attempt of attempts) {
        for (const name of route.names) {
          lookups.length = 0;
          const label = `${name} ${attempt.query || JSON.stringify(attempt.headers ?? {})}`;
          expect(await call("POST", `${route.path(name)}${attempt.query}`, { headers: attempt.headers }), label).toEqual(unauthorized);
          expect(lookups, label).toEqual([]);
        }
      }
    });
  }

  it("a key saved, changed or removed after the keys were indexed counts at once", async () => {
    const run = (path: string, key: string) => call("POST", `${path}?key=${encodeURIComponent(key)}`);
    const status = async (path: string, key: string) => (await run(path, key)).status;
    expect(await status("/api/scenes/stored_scene/run", STORED_SCENE_KEY)).toBe(200);
    expect(await status("/api/jobs/stored_job/run", STORED_JOB_KEY)).toBe(200);

    // A job saved later, and removed again: then its key opens nothing, as for an unknown name.
    const lateKey = "late-job-key-0123456789abcd";
    mods.jobDefinitions.saveJobDefinition("late_job", { description: "A late job.", steps: [{ scene: "ferry_check" }], triggers: [{ type: "api", webhookKey: lateKey }] });
    expect(await status("/api/jobs/late_job/run", lateKey)).toBe(200);
    mods.jobDefinitions.deleteJobDefinition("late_job");
    expect(await run("/api/jobs/late_job/run", lateKey)).toEqual(unauthorized);

    // A stored scene's key changed: the old key stops working.
    const changedKey = "changed-scene-key-0123456789";
    mods.scenes.saveScene("stored_scene", { description: "A stored scene.", task: "Do the stored thing.", webhookKey: changedKey });
    expect(await run("/api/scenes/stored_scene/run", STORED_SCENE_KEY)).toEqual(unauthorized);
    expect(await status("/api/scenes/stored_scene/run", changedKey)).toBe(200);
    mods.scenes.saveScene("stored_scene", { description: "A stored scene.", task: "Do the stored thing.", webhookKey: STORED_SCENE_KEY });

    // A `$NAME` key follows the environment variable it names.
    process.env[ENV_SCENE_KEY_VAR] = "env-scene-key-0123456789abc";
    mods.scenes.saveScene("env_scene", { description: "An env scene.", task: "Do the env thing.", webhookKey: `$${ENV_SCENE_KEY_VAR}` });
    expect(await status("/api/scenes/env_scene/run", "env-scene-key-0123456789abc")).toBe(200);
    process.env[ENV_SCENE_KEY_VAR] = "env-scene-key-rotated-0123456";
    expect(await run("/api/scenes/env_scene/run", "env-scene-key-0123456789abc")).toEqual(unauthorized);
    expect(await status("/api/scenes/env_scene/run", "env-scene-key-rotated-0123456")).toBe(200);
    mods.scenes.deleteScene("env_scene");

    // A config reload with a config scene's key changed.
    const reloadedKey = "reloaded-scene-key-0123456789";
    writeFileSync(configFile, configShard(reloadedKey), "utf8");
    mods.config.resetConfigForTests();
    try {
      expect(await run("/api/scenes/ferry_check/run", SCENE_KEY)).toEqual(unauthorized);
      expect(await status("/api/scenes/ferry_check/run", reloadedKey)).toBe(200);
    } finally {
      writeFileSync(configFile, configShard(SCENE_KEY), "utf8");
      mods.config.resetConfigForTests();
    }
    expect(await status("/api/scenes/ferry_check/run", SCENE_KEY)).toBe(200);
  });
});

describe("the approval callbacks, for a caller with no valid credential", () => {
  const pending = () => mods.approvals.createPendingApproval({ toolName: "send_mail", args: {}, timeoutMs: 60_000, secret: APPROVAL_SECRET }).id;

  it("an approval that is pending and one that is not get the same answer over the one-click link", async () => {
    const id = pending();
    try {
      for (const query of ["?approved=true", "?approved=true&secret=wrong", `?approved=true&secret=${"x".repeat(APPROVAL_SECRET.length)}`, `?approved=true&secret=${outsideAscii(APPROVAL_SECRET)}`]) {
        const known = await call("GET", `/api/approval/${id}${query}`);
        const unknown = await call("GET", `/api/approval/${UNKNOWN_APPROVAL}${query}`);
        expect(known.status, query).toBe(404);
        expect(unknown, query).toEqual(known);
      }
      expect(mods.approvals.getPendingApproval(id), "a refused call resolves nothing").toBeDefined();
    } finally {
      mods.approvals.resolveApproval(id, false);
    }
  });

  it("an approval that is pending and one that is not get the same answer on the programmatic callback", async () => {
    const id = pending();
    try {
      const attempts: Array<{ body: Record<string, unknown>; headers?: Record<string, string> }> = [
        { body: { approved: true } },
        { body: { approved: true, secret: "wrong" } },
        { body: { approved: true, secret: "é".repeat(APPROVAL_SECRET.length) } },
        { body: { approved: true }, headers: { Authorization: "Bearer not-the-secret" } },
      ];
      for (const attempt of attempts) {
        const known = await call("POST", `/api/approval/${id}`, attempt);
        const unknown = await call("POST", `/api/approval/${UNKNOWN_APPROVAL}`, attempt);
        expect(known.status, JSON.stringify(attempt)).toBe(404);
        expect(unknown, JSON.stringify(attempt)).toEqual(known);
      }
      expect(mods.approvals.getPendingApproval(id), "a refused call resolves nothing").toBeDefined();
    } finally {
      mods.approvals.resolveApproval(id, false);
    }
  });

  it("the secret and a signed-in operator still resolve an approval, and a signed-in operator gets 404 for an unknown one", async () => {
    const viaLink = pending();
    const link = await call("GET", `/api/approval/${viaLink}?approved=true&secret=${APPROVAL_SECRET}`);
    expect(link.status).toBe(200);
    expect(link.body).toContain("Approved");
    expect(mods.approvals.getPendingApproval(viaLink)).toBeUndefined();

    const viaBody = pending();
    expect(await call("POST", `/api/approval/${viaBody}`, { body: { approved: false, secret: APPROVAL_SECRET } })).toEqual({ status: 200, body: JSON.stringify({ ok: true, approved: false }) });
    const viaBearerSecret = pending();
    expect((await call("POST", `/api/approval/${viaBearerSecret}`, { body: { approved: true }, headers: { Authorization: `Bearer ${APPROVAL_SECRET}` } })).status).toBe(200);
    const viaOperator = pending();
    expect((await call("POST", `/api/approval/${viaOperator}`, { body: { approved: true }, headers: await operator() })).status).toBe(200);

    expect(await call("POST", `/api/approval/${UNKNOWN_APPROVAL}`, { body: { approved: true }, headers: await operator() }))
      .toEqual({ status: 404, body: JSON.stringify({ error: "Approval request not found or already resolved" }) });
  });
});
