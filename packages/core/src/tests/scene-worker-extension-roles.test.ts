import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testAccount } from "./support/test-account.js";

/**
 * THE STANDALONE SCENE WORKER KNOWS THE ROLES THE CORE EXTENSIONS DECLARE, AND NOTHING ELSE OF THEM.
 *
 * Under multi-user auth a role that neither core nor a loaded extension declares signs nobody in
 * (gateway/auth.ts declaredRole), and the scene worker runs a queued job with its owner's role as
 * the auth layer holds it (agent/scene-worker.ts). The standalone worker (scene-worker-main.ts)
 * loads no extension, so there every extension's role was one that nobody declares: each job and
 * scheduled run of a builtin account holding one failed as one of an account that no longer signs
 * in, and its schedules were removed after their refused runs (before roles failed closed, those
 * jobs ran as operator). The worker now declares the extensions' roles when it starts, exactly when
 * the gateway's loader would declare them.
 *
 * It registers their credential backend too (authProvider): with one, the gateway looks every
 * account up in that store and nowhere else (gateway/auth.ts resolveCaller), and a worker without it
 * looked the owners up in the builtin roster instead, where an extension store's accounts are not.
 * Nothing else of them: no tool, hook, policy, route or boot.
 */

// The extension loader's error lines, recorded.
const loaderErrors = vi.hoisted(() => [] as Array<{ fields: Record<string, unknown>; message: string }>);
vi.mock("../logger.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../logger.js")>();
  return {
    ...original,
    childLogger: (name: string, meta?: Record<string, unknown>) => {
      const logger = original.childLogger(name, meta);
      if (name !== "extension-loader") return logger;
      return new Proxy(logger, {
        get(target, property, receiver) {
          if (property === "error") {
            return (fields: unknown, message?: unknown) => {
              loaderErrors.push({ fields: (fields ?? {}) as Record<string, unknown>, message: String(message ?? "") });
            };
          }
          return Reflect.get(target, property, receiver);
        },
      });
    },
  };
});

const ROLES_NOT_DECLARED = "core extension failed to load — its roles are not declared in this process";
const PRAXIS_ROLES = [
  { name: "doctor", description: "a physician", rank: 80 },
  { name: "patient", description: "a patient", rank: 10 },
];
const LOOKUP_TOOL = {
  name: "praxis_lookup",
  description: "Looks a patient up.",
  parameters: { type: "object", properties: {} },
  tier: 0,
  execute: async () => ({ success: true, output: "" }),
};
const praxisBoot = vi.fn();

/** The fork extension "praxis", with every part a gateway would register; `extra` changes it. */
function praxisManifest(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "praxis",
    version: "1.0.0",
    roles: PRAXIS_ROLES,
    tools: [LOOKUP_TOOL],
    authProvider: { verifyCredentials: async () => null, getUserById: () => null },
    authorizeToolCall: () => "refused by praxis",
    authorizeAgentRun: () => "refused by praxis",
    guardrails: { checkInput: () => ({ allowed: false, reason: "praxis" }) },
    routePolicies: [{ pattern: "/api/praxis/*", roles: ["doctor"] }],
    rpcPolicies: [{ method: "chat.send", roles: ["patient"] }],
    boot: praxisBoot,
    ...extra,
  };
}

const dora = testAccount("dora", "doctor");
const pat = testAccount("pat", "patient");
// A role nobody declares: a typo of "doctor".
const tom = testAccount("tom", "docter");

const ENV_KEYS = ["SAI_CONFIG_PATH", "SAI_EXTENSIONS_DIR", "SAI_JOB_WAKE_DISABLED", "SAI_SESSION_STORE", "SAI_AUDIT_LOG"] as const;
const savedEnv = new Map<string, string | undefined>();
const dirs: string[] = [];
/** The role each turn's session held, by the session's user. */
let turnRoles: Record<string, string | undefined> = {};

function deployment(users: Array<Record<string, unknown>>): void {
  const dir = mkdtempSync(join(tmpdir(), "sai-worker-ext-roles-"));
  dirs.push(dir);
  writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
    workspacePath: dir,
    gateway: { jwtSecret: "w".repeat(40), turnTimeoutMs: 30_000 },
    agents: { defaultContainerized: false },
    auth: { enabled: true, provider: "builtin", users },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
  // The job sessions and the loader's audit events stay in this deployment's directory.
  process.env["SAI_SESSION_STORE"] = join(dir, "sessions.json");
  process.env["SAI_AUDIT_LOG"] = join(dir, "audit.jsonl");
}

type Loader = typeof import("../extension/loader.js");

/** An extensions directory holding "praxis", whose module `importer` stands in for. */
function useExtensions(loader: Loader, importer: () => Promise<{ default?: unknown }>): void {
  const dir = mkdtempSync(join(tmpdir(), "sai-worker-ext-roles-ext-"));
  dirs.push(dir);
  mkdirSync(join(dir, "praxis"));
  writeFileSync(join(dir, "praxis", "index.mjs"), "// discovery marker: the importer is injected\n");
  process.env["SAI_EXTENSIONS_DIR"] = dir;
  loader.setExtensionImporterForTests(importer);
}

const manifestImporter = (extra: Record<string, unknown> = {}) => async () => ({ default: praxisManifest(extra) });

/** What the standalone worker's start reaches beyond the job queue, stubbed; runTurn records the session's role. */
function stubWorkerBoot(): void {
  vi.doMock("dotenv/config", () => ({}));
  const stub = (path: string, names: string[]) => vi.doMock(path, async (importActual) => ({
    ...(await importActual<Record<string, unknown>>()),
    ...Object.fromEntries(names.map((name) => [name, vi.fn(async () => {})])),
  }));
  stub("../audit/postgres.js", ["initPostgresAudit"]);
  stub("../providers/index.js", ["initProviders"]);
  stub("../mcp/registry.js", ["initMcpServers", "shutdownMcpServers"]);
  stub("../channels/runtime.js", ["syncAllChannels", "stopManagedChannels"]);
  stub("../swarm/bus.js", ["startSwarmBus", "stopSwarmBus"]);
  stub("../swarm/bidding.js", ["startAutonomousBidding", "stopAutonomousBidding"]);
  stub("../observability/event-loop-monitor.js", ["startEventLoopMonitor", "stopEventLoopMonitor"]);
  stub("../observability/provider-activity-monitor.js", ["startProviderActivityMonitor", "stopProviderActivityMonitor"]);
  stub("../observability/recovery-metrics.js", ["startRecoveryMetrics", "stopRecoveryMetrics"]);
  vi.doMock("../agent/runtime.js", async (importActual) => ({
    ...(await importActual<typeof import("../agent/runtime.js")>()),
    runTurn: vi.fn(async (opts: { session: { userId?: string; userRole?: string } }) => {
      turnRoles[String(opts.session.userId)] = opts.session.userRole;
      return { response: "ran", toolCallsExecuted: 0, guardrailEvents: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, blocked: false };
    }),
  }));
}

const STUBBED = [
  "dotenv/config",
  "../audit/postgres.js",
  "../providers/index.js",
  "../mcp/registry.js",
  "../channels/runtime.js",
  "../swarm/bus.js",
  "../swarm/bidding.js",
  "../observability/event-loop-monitor.js",
  "../observability/provider-activity-monitor.js",
  "../observability/recovery-metrics.js",
  "../agent/runtime.js",
];

/** Waits until the job is completed or failed. */
async function settled(jobs: typeof import("../agent/jobs.js"), jobId: string) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const current = await jobs.getJob(jobId);
    if (current && (current.status === "completed" || current.status === "failed")) return current;
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not finish`);
    await new Promise((done) => setTimeout(done, 20));
  }
}

const signalListeners = { SIGINT: [] as Array<(...args: unknown[]) => void>, SIGTERM: [] as Array<(...args: unknown[]) => void> };

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  delete process.env["SAI_JOB_WAKE_DISABLED"];
  signalListeners.SIGINT = process.listeners("SIGINT") as Array<(...args: unknown[]) => void>;
  signalListeners.SIGTERM = process.listeners("SIGTERM") as Array<(...args: unknown[]) => void>;
  vi.resetModules();
  turnRoles = {};
  loaderErrors.length = 0;
  praxisBoot.mockReset();
});

afterEach(async () => {
  try {
    await (await import("../agent/scene-worker.js")).stopSceneJobWorker();
    await (await import("../agent/jobs.js")).resetJobsForTests();
    (await import("../extension/loader.js")).setExtensionImporterForTests(null);
    (await import("../config/loader.js")).resetConfigForTests();
  } catch {
    // module instances of a test that failed early
  }
  // The standalone worker's start listens for SIGINT and SIGTERM to shut down; those are its own.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    for (const listener of process.listeners(signal)) {
      if (!signalListeners[signal].includes(listener as (...args: unknown[]) => void)) process.off(signal, listener);
    }
  }
  for (const path of STUBBED) vi.doUnmock(path);
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

describe("the standalone scene worker", () => {
  it("runs a job of a builtin account holding an extension's role with that role, and still refuses one nobody declares", { timeout: 60_000 }, async () => {
    deployment([dora.record, pat.record, tom.record]);
    stubWorkerBoot();
    // Builtin accounts: the extension declares roles and no credential backend of its own.
    useExtensions(await import("../extension/loader.js"), manifestImporter({ authProvider: undefined }));

    await (await import("../scene-worker-main.js")).main();
    const [jobs, scene, extension] = await Promise.all([
      import("../agent/jobs.js"),
      import("../agent/scene-worker.js"),
      import("../extension/index.js"),
    ]);
    const queue = (userId: string, account: string, requestedByRole: string) =>
      jobs.createJob({ sceneName: "nightly", task: "Summarise the day.", turnTimeoutMs: 30_000, userId, account, requestedByRole });
    const [doraQueued, patQueued, tomQueued] = [await queue("dora", dora.id, "doctor"), await queue("pat", pat.id, "patient"), await queue("tom", tom.id, "docter")] as const;
    const [doraJob, patJob, tomJob] = await Promise.all([settled(jobs, doraQueued.id), settled(jobs, patQueued.id), settled(jobs, tomQueued.id)]);

    // Before, both failed: "The account that queued this job no longer signs in, …"
    expect(doraJob, doraJob.error).toMatchObject({ status: "completed" });
    expect(patJob, patJob.error).toMatchObject({ status: "completed" });
    expect(tomJob).toMatchObject({ status: "failed", error: scene.OWNER_SIGNED_OUT_JOB_REFUSAL });
    expect(turnRoles).toEqual({ dora: "doctor", pat: "patient" });
    // Only the roles: the extension itself is not loaded here.
    expect(extension.listLoadedExtensions()).toEqual([]);
    expect(extension.getExtensionAuthProvider()).toBeNull();
    expect(praxisBoot).not.toHaveBeenCalled();
    expect(loaderErrors).toEqual([]);
  });

  it("an extension that does not load there declares no role there: its accounts' jobs fail, and the worker logs why", { timeout: 60_000 }, async () => {
    deployment([dora.record]);
    stubWorkerBoot();
    useExtensions(await import("../extension/loader.js"), manifestImporter({ tools: [{ ...LOOKUP_TOOL, name: "Praxis Lookup" }] }));

    await (await import("../scene-worker-main.js")).main();
    const [jobs, scene] = await Promise.all([import("../agent/jobs.js"), import("../agent/scene-worker.js")]);
    const job = await jobs.createJob({ sceneName: "nightly", task: "Summarise the day.", turnTimeoutMs: 30_000, userId: "dora", account: dora.id, requestedByRole: "doctor" });

    expect(await settled(jobs, job.id)).toMatchObject({ status: "failed", error: scene.OWNER_SIGNED_OUT_JOB_REFUSAL });
    expect(turnRoles).toEqual({});
    expect(loaderErrors).toEqual([expect.objectContaining({ message: ROLES_NOT_DECLARED, fields: expect.objectContaining({ extension: "praxis" }) })]);
  });

  /** praxis with a credential backend that holds `users` (by id), and throws for the id "u-boom". */
  const storeImporter = (users: Record<string, { username: string; role: string }>) => manifestImporter({
    authProvider: {
      verifyCredentials: async () => null,
      getUserById: (id: string) => {
        if (id === "u-boom") throw new Error("praxis store: not connected");
        const user = users[id];
        return user ? { id, ...user } : null;
      },
    },
  });

  it("runs a job of an account in the extension's credential store with the role the store holds now, and fails one it no longer holds", { timeout: 60_000 }, async () => {
    deployment([]);
    stubWorkerBoot();
    // nora was a patient when she queued it, and is a doctor in the store now.
    useExtensions(await import("../extension/loader.js"), storeImporter({ "u-nora": { username: "nora", role: "doctor" } }));

    await (await import("../scene-worker-main.js")).main();
    const [jobs, scene, extension, accounts] = await Promise.all([
      import("../agent/jobs.js"),
      import("../agent/scene-worker.js"),
      import("../extension/index.js"),
      import("../runtime/accounts.js"),
    ]);
    const queue = (id: string, requestedByRole: string) =>
      jobs.createJob({ sceneName: "nightly", task: "Summarise the day.", turnTimeoutMs: 30_000, userId: id, account: accounts.extensionAccountId(id), requestedByRole });
    const [noraQueued, goneQueued] = [await queue("u-nora", "patient"), await queue("u-gone", "doctor")] as const;
    const [noraJob, goneJob] = await Promise.all([settled(jobs, noraQueued.id), settled(jobs, goneQueued.id)]);

    // Before, both failed: the worker looked them up in the builtin roster, which is empty here.
    expect(noraJob, noraJob.error).toMatchObject({ status: "completed" });
    expect(goneJob).toMatchObject({ status: "failed", error: scene.OWNER_SIGNED_OUT_JOB_REFUSAL });
    expect(turnRoles).toEqual({ "u-nora": "doctor" });
    expect(extension.getExtensionAuthProvider()).not.toBeNull();
    // The backend only: the extension itself is not loaded, and its boot does not run.
    expect(extension.listLoadedExtensions()).toEqual([]);
    expect(praxisBoot).not.toHaveBeenCalled();
    expect(loaderErrors).toEqual([]);
  });

  it("a credential backend that throws fails that job with the reason, and the worker goes on to the next", { timeout: 60_000 }, async () => {
    deployment([]);
    stubWorkerBoot();
    useExtensions(await import("../extension/loader.js"), storeImporter({ "u-nora": { username: "nora", role: "doctor" } }));

    await (await import("../scene-worker-main.js")).main();
    const [jobs, accounts] = await Promise.all([import("../agent/jobs.js"), import("../runtime/accounts.js")]);
    const queue = (id: string) =>
      jobs.createJob({ sceneName: "nightly", task: "Summarise the day.", turnTimeoutMs: 30_000, userId: id, account: accounts.extensionAccountId(id), requestedByRole: "doctor" });
    const [boomQueued, noraQueued] = [await queue("u-boom"), await queue("u-nora")] as const;
    const [boomJob, noraJob] = await Promise.all([settled(jobs, boomQueued.id), settled(jobs, noraQueued.id)]);

    expect(boomJob).toMatchObject({
      status: "failed",
      error: "The account that queued this job could not be looked up: praxis store: not connected",
    });
    expect(noraJob, noraJob.error).toMatchObject({ status: "completed" });
    expect(turnRoles).toEqual({ "u-nora": "doctor" });
  });
});

describe("registerCoreExtensionRoles", () => {
  it("declares the extensions' roles and registers their credential backend, and nothing else of them", async () => {
    deployment([]);
    const loader = await import("../extension/loader.js");
    useExtensions(loader, manifestImporter());

    expect(await loader.registerCoreExtensionRoles()).toMatchObject({ registered: 1, failed: 0, authProvider: "praxis" });

    const [extension, auth, registry, tiers, routePolicies, rpcPolicy] = await Promise.all([
      import("../extension/index.js"),
      import("../gateway/auth.js"),
      import("../tools/registry.js"),
      import("../guardrails/tool-tiers.js"),
      import("../gateway/route-policies.js"),
      import("../gateway/rpc-policy.js"),
    ]);
    expect(auth.declaredRole("doctor")).toBe("doctor");
    expect(auth.roleRank("doctor")).toBe(80);
    expect(auth.roleRank("patient")).toBe(10);
    // The store every account of the process is looked up in, as the gateway's loader registers it.
    expect(extension.getExtensionAuthProvider()).not.toBeNull();
    // Not loaded: no record, tool, tier, hook, policy or boot.
    expect(extension.listLoadedExtensions()).toEqual([]);
    expect(registry.getTool("praxis_lookup")).toBeUndefined();
    expect(tiers.isCompileTimeMappedTool("praxis_lookup")).toBe(false);
    expect(extension.getExtensionGuardrailHooks()).toEqual([]);
    expect(extension.getExtensionAgentRunAuthorizers()).toEqual([]);
    expect(routePolicies.findRoutePolicy("GET", "/api/praxis/records")).toBeNull();
    expect(rpcPolicy.authorizeRpc("chat.send", "patient", true).allowed).toBe(false);
    expect(praxisBoot).not.toHaveBeenCalled();
  });

  const variants: Array<[string, () => Promise<{ default?: unknown }>, boolean]> = [
    ["a valid manifest", manifestImporter(), true],
    ["an invalid tool name", manifestImporter({ tools: [{ ...LOOKUP_TOOL, name: "Praxis Lookup" }] }), false],
    ["a role name the loader refuses", manifestImporter({ roles: [...PRAXIS_ROLES, { name: "Nurse", description: "a nurse", rank: 40 }] }), false],
    ["a tool that shadows a built-in", manifestImporter({ tools: [LOOKUP_TOOL, { ...LOOKUP_TOOL, name: "read_file" }] }), false],
    // The loader leaves a malformed tool out before it would see the name, and loads the rest.
    ["a malformed tool named like a built-in", manifestImporter({ tools: [LOOKUP_TOOL, { ...LOOKUP_TOOL, name: "read_file", refuse: "no" }] }), true],
    ["a module that throws when it is imported", async () => { throw new Error("praxis: its database driver is missing"); }, false],
  ];

  it.each(variants)("declares the roles exactly when the gateway's loader does: %s", async (_label, importer, declared) => {
    deployment([]);
    let loader = await import("../extension/loader.js");
    useExtensions(loader, importer);
    await loader.loadCoreExtensions();
    const inGateway = (await import("../extension/index.js")).getExtensionRole("doctor") !== undefined;

    // A process of its own, as the standalone worker is.
    vi.resetModules();
    loaderErrors.length = 0;
    loader = await import("../extension/loader.js");
    loader.setExtensionImporterForTests(importer);
    const result = await loader.registerCoreExtensionRoles();
    const inWorker = (await import("../extension/index.js")).getExtensionRole("doctor") !== undefined;

    expect({ inGateway, inWorker }).toEqual({ inGateway: declared, inWorker: declared });
    expect(result).toMatchObject(declared ? { registered: 1, failed: 0 } : { registered: 0, failed: 1 });
    expect(loaderErrors).toEqual(declared ? [] : [expect.objectContaining({ message: ROLES_NOT_DECLARED, fields: expect.objectContaining({ extension: "praxis" }) })]);
  });
});
