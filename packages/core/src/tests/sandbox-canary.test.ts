/**
 * The sandbox canary (observability/health-checks.ts checkSandbox) and the E2E harness's reading of
 * it (e2e/services.ts).
 *
 * From July until 9f7e61f the docker-socket proxy dropped the output of every attached `docker run`:
 * shell_exec and run_script answered "(no output)" for every command, /api/health/subsystems checked
 * reachability only, and the harness assumed the sandbox up. The coder of session 3c0c5ce1
 * (2026-10-07) spent seven blind calls and then made its figures up. Driven through the registered
 * shell_exec handler with only docker itself mocked, at node:child_process.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubsystemCheck } from "../observability/health-checks.js";
import type { HttpResult, GatewayClient } from "../e2e/gateway-client.js";
import type { ToolHandler } from "../tools/registry.js";

/** `docker <args>` as shell_exec awaits it (execFile, promisified): resolves { stdout, stderr } or rejects. */
const docker = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const execFile = vi.fn();
  // What util.promisify(execFile) returns — the shape node's own execFile has.
  (execFile as unknown as Record<PropertyKey, unknown>)[Symbol.for("nodejs.util.promisify.custom")] = docker;
  return { ...actual, execFile };
});

/** A working sandbox: each `printf '%s-%s\n' a b` in the command prints "a-b" on its own stream. */
function dockerPrints(args: string[]): { stdout: string; stderr: string } {
  const streams = { stdout: "", stderr: "" };
  for (const match of String(args.at(-1)).matchAll(/printf '%s-%s\\n' ([\w-]+) ([\w-]+)( >&2)?/g)) {
    streams[match[3] ? "stderr" : "stdout"] += `${match[1]}-${match[2]}\n`;
  }
  return streams;
}

/** How execFile rejects for a command that failed: the message repeats the whole command line. */
function dockerFails(args: string[], code: number | string, stderr = "", stdout = ""): Error {
  return Object.assign(new Error(`Command failed: docker ${args.join(" ")}\n${stderr}`), { code, stdout, stderr });
}

const workspace = mkdtempSync(join(tmpdir(), "sai-sandbox-canary-"));

type HealthChecks = typeof import("../observability/health-checks.js");
type CacheWarmer = typeof import("../agent/cache-warmer.js");
let health: HealthChecks;
let turns: CacheWarmer;

beforeAll(async () => {
  writeFileSync(join(workspace, "starlingai.json"), JSON.stringify({ workspacePath: workspace }), "utf8");
  process.env["SAI_CONFIG_PATH"] = join(workspace, "starlingai.json");
  (await import("../config/loader.js")).resetConfigForTests();
  await import("../tools/shell.js");
  health = await import("../observability/health-checks.js");
  turns = await import("../agent/cache-warmer.js");
});

afterAll(async () => {
  delete process.env["SAI_CONFIG_PATH"];
  (await import("../config/loader.js")).resetConfigForTests();
  rmSync(workspace, { recursive: true, force: true });
});

beforeEach(() => {
  health.resetSandboxCanaryForTests();
  docker.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("checkSandbox", () => {
  it("is ok when a docker run through shell_exec hands back both values, and asks no approval for it", async () => {
    docker.mockImplementation(async (_file: string, args: string[]) => dockerPrints(args));

    const check = await health.checkSandbox();

    expect(check).toMatchObject({ name: "sandbox", status: "ok" });
    expect(check.detail).toMatch(/handed back stdout and stderr \(\d+ ms\)/);
    expect(Number.isNaN(Date.parse(check.checkedAt ?? ""))).toBe(false);
    expect(docker).toHaveBeenCalledTimes(1);
    const [file, canaryArgs, options] = docker.mock.calls[0] as [string, string[], { timeout: number }];
    expect(file).toBe("docker");
    expect(canaryArgs.at(-1)).toMatch(/printf '%s-%s\\n' sai-canary-out [0-9a-f]{16}; printf '%s-%s\\n' sai-canary-err [0-9a-f]{16} >&2$/);

    // The same docker run a turn's shell_exec makes: every argument but the command itself.
    const { getTool, executeTool } = await import("../tools/registry.js");
    await getTool("shell_exec")!.execute({ command: "echo hello" }, { sessionId: "s-turn", workspacePath: workspace });
    const [, turnArgs, turnOptions] = docker.mock.calls[1] as [string, string[], { timeout: number }];
    expect(canaryArgs.slice(0, -1)).toEqual(turnArgs.slice(0, -1));
    expect(options).toEqual(turnOptions);

    // A turn's call waits for a person's approval, and with nobody to ask it is refused; the
    // canary is an internal probe and never asks.
    const viaGate = await executeTool("shell_exec", { command: "echo hello" }, { sessionId: "s-gate", workspacePath: workspace });
    expect(viaGate.error).toMatch(/requires human approval/);
    expect(docker).toHaveBeenCalledTimes(2);
  });

  it("is one of the checks /api/health/subsystems reports", async () => {
    docker.mockResolvedValue({ stdout: "", stderr: "" });

    const report = await health.runSubsystemChecks();

    expect(report.checks.find((check) => check.name === "sandbox")).toMatchObject({ status: "degraded" });
    expect(report.degraded).toBe(true);
  });

  it("is degraded when docker run exits 0 and neither stream comes back (the July proxy failure)", async () => {
    docker.mockResolvedValue({ stdout: "", stderr: "" });

    const check = await health.checkSandbox();

    expect(check.status).toBe("degraded");
    expect(check.detail).toMatch(/^output lost: docker run exited 0, but neither stdout nor stderr came back/);
    expect(check.detail).toContain('"(no output)"');
    expect(check.checkedAt).toBeDefined();
  });

  it("names the one stream that did not come back", async () => {
    docker.mockImplementation(async (_file: string, args: string[]) => ({ stdout: dockerPrints(args).stdout, stderr: "" }));
    expect((await health.checkSandbox()).detail).toMatch(/^output lost: docker run exited 0, but its stderr never came back/);

    health.resetSandboxCanaryForTests();
    docker.mockImplementation(async (_file: string, args: string[]) => ({ stdout: "", stderr: dockerPrints(args).stderr }));
    const check = await health.checkSandbox();
    expect(check.status).toBe("degraded");
    expect(check.detail).toMatch(/^output lost: docker run exited 0, but its stdout never came back/);
  });

  it("does not take the command line, echoed back, for the output", async () => {
    // A channel that reflects what it was sent: the command holds the values only in halves.
    docker.mockImplementation(async (_file: string, args: string[]) => ({ stdout: args.join(" "), stderr: String(args.at(-1)) }));
    expect((await health.checkSandbox()).status).toBe("degraded");

    // Node's error for a failed run repeats the command line; it is neither output nor detail.
    health.resetSandboxCanaryForTests();
    docker.mockImplementation(async (_file: string, args: string[]) => { throw dockerFails(args, 1); });
    const check = await health.checkSandbox();
    expect(check).toMatchObject({ status: "degraded", detail: "docker run failed: Exit code 1" });
  });

  it("is degraded, not unavailable, when docker run itself fails, with docker's words and without the command line", async () => {
    // A broken sandbox stops the tools that run code, not the gateway: the route must not turn 503.
    docker.mockImplementation(async (_file: string, args: string[]) => {
      throw dockerFails(args, 125, "docker: Error response from daemon: No such image: starlingai/sandbox:latest");
    });

    const check = await health.checkSandbox();

    expect(check.status).toBe("degraded");
    expect(check.detail).toBe("docker run failed: Exit code 125: docker: Error response from daemon: No such image: starlingai/sandbox:latest");
    expect(check.checkedAt).toBeDefined();

    // No docker CLI at all, as on a checkout without Docker.
    health.resetSandboxCanaryForTests();
    docker.mockRejectedValue(Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }));
    expect(await health.checkSandbox()).toMatchObject({ status: "degraded", detail: "docker run failed: Exit code ENOENT: spawn docker ENOENT" });
  });

  it("is not ok when both values come back but docker run reports a failure (the exit status lost)", async () => {
    // The command cannot fail once it ran, so this run lost its exit status on the way, and
    // shell_exec would hand every command back as failed.
    docker.mockImplementation(async (_file: string, args: string[]) => {
      const printed = dockerPrints(args);
      throw dockerFails(args, 125, `${printed.stderr}Error response from daemon: wait refused by the socket proxy`, printed.stdout);
    });

    const check = await health.checkSandbox();

    expect(check.status).toBe("degraded");
    expect(check.detail).toMatch(/^docker run failed: Exit code 125: sai-canary-err-[0-9a-f]{16} Error response from daemon: wait refused/);
  });

  it("never rejects when the shell_exec handler throws, so the route still answers", async () => {
    const { getTool, registerTool, unregisterTool } = await import("../tools/registry.js");
    const shell = getTool("shell_exec") as ToolHandler;
    unregisterTool("shell_exec");
    registerTool({ ...shell, execute: async () => { throw new Error("bind source missing"); } });
    try {
      expect(await health.checkSandbox()).toMatchObject({ status: "degraded", detail: "the canary could not run: bind source missing" });
    } finally {
      unregisterTool("shell_exec");
      registerTool(shell);
    }
  });

  it("starts one container per five minutes, however often and however many ask", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-08T10:00:00.000Z"));
    docker.mockResolvedValue({ stdout: "", stderr: "" });

    // The dashboard polls every 30 s per open tab: callers that arrive together share one run.
    const first = await Promise.all([health.checkSandbox(), health.checkSandbox(), health.checkSandbox()]);
    expect(docker).toHaveBeenCalledTimes(1);
    expect(new Set(first.map((check) => check.checkedAt))).toEqual(new Set(["2026-10-08T10:00:00.000Z"]));

    // A lost-output verdict is kept like any other: a broken channel does not cost a container per poll.
    vi.setSystemTime(new Date("2026-10-08T10:04:59.000Z"));
    expect(await health.checkSandbox()).toEqual(first[0]);
    expect(docker).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-10-08T10:05:00.000Z"));
    docker.mockImplementation(async (_file: string, args: string[]) => dockerPrints(args));
    const next = await health.checkSandbox();
    expect(docker).toHaveBeenCalledTimes(2);
    expect(next).toMatchObject({ status: "ok", checkedAt: "2026-10-08T10:05:00.000Z" });
  });

  it("starts no container while a turn is running", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-08T10:00:00.000Z"));
    docker.mockImplementation(async (_file: string, args: string[]) => dockerPrints(args));

    // What runTurn does first and last.
    turns.markOrchestratorActivity();
    try {
      const before = await health.checkSandbox();
      expect(before).toEqual({ name: "sandbox", status: "ok", detail: "not checked yet: the canary starts no container while a turn is running" });
      expect(docker).not.toHaveBeenCalled();
    } finally {
      turns.markOrchestratorIdle();
    }

    const measured = await health.checkSandbox();
    expect(measured).toMatchObject({ status: "ok", checkedAt: "2026-10-08T10:00:00.000Z" });
    expect(docker).toHaveBeenCalledTimes(1);

    // Past its five minutes, while a turn runs: the last verdict, said to be old, and still no container.
    vi.setSystemTime(new Date("2026-10-08T10:07:00.000Z"));
    turns.markOrchestratorActivity();
    try {
      const stale = await health.checkSandbox();
      expect(stale).toMatchObject({ status: "ok", checkedAt: "2026-10-08T10:00:00.000Z" });
      expect(stale.detail).toMatch(/\(measured 7 min ago; not re-run while a turn is running\)$/);
      expect(docker).toHaveBeenCalledTimes(1);
    } finally {
      turns.markOrchestratorIdle();
    }

    expect(await health.checkSandbox()).toMatchObject({ status: "ok", checkedAt: "2026-10-08T10:07:00.000Z" });
    expect(docker).toHaveBeenCalledTimes(2);
  });

  it("reports a deployment without shell_exec as not configured, and starts nothing", async () => {
    const { getTool, registerTool, unregisterTool } = await import("../tools/registry.js");
    const shell = getTool("shell_exec") as ToolHandler;
    unregisterTool("shell_exec");
    try {
      expect(await health.checkSandbox()).toEqual({ name: "sandbox", status: "ok", detail: "not configured (shell_exec is disabled by config)" });
      expect(docker).not.toHaveBeenCalled();
    } finally {
      registerTool(shell);
    }
  });
});

// ── the E2E harness ──────────────────────────────────────────────────────────

describe("the E2E harness's sandbox service", () => {
  let gateway: http.Server;
  let gatewayUrl = "";

  beforeAll(async () => {
    gateway = http.createServer((req, res) => {
      res.writeHead(req.url === "/healthz" ? 200 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    });
    await new Promise<void>((resolveListen) => gateway.listen(0, "127.0.0.1", resolveListen));
    gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolveClose) => gateway.close(() => resolveClose()));
  });

  /** GET /api/health/subsystems as the gateway answers it: the checks, through JSON. */
  function subsystems(checks: SubsystemCheck[]): HttpResult {
    const healthy = checks.every((check) => check.status !== "unavailable");
    const body = JSON.stringify({ healthy, degraded: checks.some((check) => check.status === "degraded"), checks });
    return { status: healthy ? 200 : 503, ok: healthy, text: body, json: JSON.parse(body) as unknown };
  }

  const MODEL_OK: SubsystemCheck = { name: "primary_model", status: "ok", detail: "fake endpoint reachable (200)" };

  async function sandboxService(answer: HttpResult) {
    const { ServiceProber } = await import("../e2e/services.js");
    const [state] = await new ServiceProber({ gatewayUrl, authedGet: async () => answer }).check(["sandbox"]);
    return state!;
  }

  it("is up on a verdict the canary measured, and down on lost output, unmeasured or missing verdicts", async () => {
    docker.mockImplementation(async (_file: string, args: string[]) => dockerPrints(args));
    const working = await sandboxService(subsystems([MODEL_OK, await health.checkSandbox()]));
    expect(working.up).toBe(true);
    expect(working.assumed).toBeUndefined();
    expect(working.detail).toMatch(/^sandbox: ok — a docker run through shell_exec handed back stdout and stderr/);

    health.resetSandboxCanaryForTests();
    docker.mockResolvedValue({ stdout: "", stderr: "" });
    const lost = await sandboxService(subsystems([MODEL_OK, await health.checkSandbox()]));
    expect(lost.up).toBe(false);
    expect(lost.detail).toMatch(/^sandbox: degraded — output lost: docker run exited 0, but neither stdout nor stderr came back/);

    // Nothing measured: "ok" to the gateway, not enough for a scenario.
    health.resetSandboxCanaryForTests();
    turns.markOrchestratorActivity();
    try {
      const unmeasured = await sandboxService(subsystems([MODEL_OK, await health.checkSandbox()]));
      expect(unmeasured).toEqual({ service: "sandbox", up: false, detail: "sandbox: ok — not checked yet: the canary starts no container while a turn is running" });
    } finally {
      turns.markOrchestratorIdle();
    }
    const unconfigured = await sandboxService(subsystems([MODEL_OK, { name: "sandbox", status: "ok", detail: "not configured (shell_exec is disabled by config)" }]));
    expect(unconfigured.up).toBe(false);

    // A gateway too old to have the canary.
    expect(await sandboxService(subsystems([MODEL_OK]))).toEqual({ service: "sandbox", up: false, detail: 'GET /api/health/subsystems reports no "sandbox" check' });
  });

  it("skips every scenario that needs the sandbox, with the canary's reason, when output is lost", async () => {
    const [{ ServiceProber }, { runScenarios }, { loadScenarios }, { resolveE2EPaths }] = await Promise.all([
      import("../e2e/services.js"),
      import("../e2e/runner.js"),
      import("../e2e/loader.js"),
      import("../e2e/paths.js"),
    ]);
    const paths = resolveE2EPaths();
    const needSandbox = loadScenarios(paths.scenariosDir, paths.fixturesDir).scenarios
      .filter((entry) => !entry.template && (entry.scenario.requires ?? []).includes("sandbox"));
    expect(needSandbox.length).toBeGreaterThan(0);

    docker.mockResolvedValue({ stdout: "", stderr: "" });
    const answer = subsystems([MODEL_OK, await health.checkSandbox()]);
    const prober = new ServiceProber({ gatewayUrl, authedGet: async () => answer, mail: null });
    // A skipped scenario never reaches the client.
    const results = await runScenarios(needSandbox, { client: undefined as unknown as GatewayClient, prober, fixturesDir: paths.fixturesDir });

    for (const result of results) {
      expect(result.status, result.id).toBe("skipped");
      expect(result.skipReason, result.id).toMatch(/^sandbox down \(sandbox: degraded — output lost: docker run exited 0, but neither stdout nor stderr came back/);
    }
  });
});
