import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRODUCT } from "../product/index.js";
import type { SubAgentRunOptions } from "../agent/sub-agent.js";
import type { ApprovalCallback } from "../tools/registry.js";

/**
 * The legacy A2A route (POST /a2a/agents/:name) turned the body field `autoApprove: true` into the
 * approval callback `async () => true`, and that answered a scene's humanInLoopSteps too. A
 * coordinator the route runs (mission_coordinator, web_task_coordinator) has run_workflow, which
 * hands the caller's callback to the scene's turn: the scene's step ran with nobody asked, the
 * bypass `--auto` no longer has. The route's callback now answers as `--auto` does: every approval
 * except a step, which it refuses (there is nobody to ask on this route).
 *
 * These run against the whole gateway, on loopback; runSubAgent is stubbed and hands back the run's
 * options, as the route built them.
 */
const runs = vi.hoisted(() => [] as SubAgentRunOptions[]);

vi.mock("../agent/sub-agent.js", async (importActual) => ({
  ...(await importActual<typeof import("../agent/sub-agent.js")>()),
  runSubAgent: async (opts: SubAgentRunOptions): Promise<string> => {
    runs.push(opts);
    return "done";
  },
}));

/** A scene step in the test: a tool that needs no approval by its tier. */
const STEP_TOOL = "list_capability_gaps";
/** A tool that asks for approval by its tier (requiresPerCallApproval) and is no step. */
const TIER_TOOL = "schedule_remove";

const tempDirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
const ENV_KEYS = ["SAI_CONFIG_PATH", "SAI_MASTER_KEY", "SAI_CRED_STORE", "SAI_AUDIT_LOG", "SAI_JOB_WAKE_DISABLED"];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  runs.length = 0;
  await (await import("../audit/logger.js")).flushAuditLog();
  (await import("../config/loader.js")).resetConfigForTests();
  (await import("../gateway/auth.js")).resetAuthStateForTests();
  for (const key of ENV_KEYS) delete process.env[key];
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
});

/** The gateway on 127.0.0.1 (one operator, auth off), and tasks/send to its researcher. */
async function bootGateway() {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-a2a-legacy-auto-"));
  tempDirs.push(tempDir);
  const configDir = join(tempDir, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "10-test.json"), JSON.stringify({
    gateway: { jwtSecret: "j".repeat(40) },
    workspacePath: tempDir,
    subAgents: { researcher: { description: "Finds sources.", systemPrompt: "Research.", maxIterations: 2 } },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configDir;
  process.env["SAI_MASTER_KEY"] = "m".repeat(32);
  process.env["SAI_CRED_STORE"] = join(tempDir, PRODUCT.stateDirName, "credentials.enc");
  process.env["SAI_AUDIT_LOG"] = join(tempDir, "audit.jsonl");
  process.env["SAI_JOB_WAKE_DISABLED"] = "1";
  vi.resetModules();
  // Sequential imports: these modules import each other.
  const { createGateway } = await import("../gateway/index.js");
  const auth = await import("../gateway/auth.js");
  const registry = await import("../tools/registry.js");
  const gateway = createGateway();

  // The gateway listens on <gateway.host>:<gateway.port> (127.0.0.1 outside Docker, 0.0.0.0 in a
  // container); the test binds loopback on a port the OS picks.
  let server: Server | undefined;
  const listen = Server.prototype.listen as (this: Server, port: number, host: string, onListening?: () => void) => Server;
  vi.spyOn(Server.prototype, "listen").mockImplementation(function (this: Server, ...args: unknown[]) {
    const onListening = args.find((arg): arg is () => void => typeof arg === "function");
    server = listen.call(this, 0, "127.0.0.1", onListening);
    return server;
  } as typeof Server.prototype.listen);
  await gateway.start();
  cleanups.push(() => gateway.stop());
  const baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;

  /** tasks/send to the researcher, with or without autoApprove; the options the run was given. */
  const send = async (params: Record<string, unknown>): Promise<SubAgentRunOptions> => {
    const response = await fetch(`${baseUrl}/a2a/agents/researcher`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${await auth.createToken("otto", { role: "operator" })}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tasks/send", params: { task: "Run the prescribe workflow.", ...params } }),
    });
    expect(response.status).toBe(200);
    expect(runs).toHaveLength(1);
    return runs.splice(0)[0]!;
  };
  return { send, registry, tempDir };
}

describe("the legacy A2A route's autoApprove and a scene's humanInLoopSteps", () => {
  it("answers the run's other approvals itself, and refuses a step instead of approving it", async () => {
    const gw = await bootGateway();
    const run = await gw.send({ autoApprove: true });
    const approvalCallback = run.approvalCallback as ApprovalCallback;
    expect(typeof approvalCallback).toBe("function");

    // What autoApprove is for, as before: a tool that asks by its tier, marked or asked directly.
    await expect(approvalCallback(TIER_TOOL, { id: "sched-1" }, { humanInLoopStep: false })).resolves.toBe(true);
    await expect(approvalCallback(TIER_TOOL, { id: "sched-1" })).resolves.toBe(true);
    // A step executeTool marks as one, as it does in the scene turn run_workflow starts.
    await expect(approvalCallback(STEP_TOOL, {}, { humanInLoopStep: true })).rejects.toThrow(/requires human approval/);
  }, 60_000);

  // As the scene's turn inside a run_workflow call meets it: the run's callback, and the scene's
  // steps on the tool context (workflow-catalog.ts merges them into humanInLoopSteps).
  it("keeps a step from running when the run's tools call it with the scene's steps on their context", async () => {
    const gw = await bootGateway();
    const run = await gw.send({ autoApprove: true });
    const ran: string[] = [];
    for (const name of [STEP_TOOL, TIER_TOOL]) {
      gw.registry.registerTool({
        name,
        description: `Test stub of ${name}.`,
        parameters: { type: "object", properties: {} },
        async execute() {
          ran.push(name);
          return { success: true, output: `${name} ran` };
        },
      });
    }
    const context = {
      sessionId: "a2a-legacy-scene-turn",
      workspacePath: gw.tempDir,
      approvalCallback: run.approvalCallback,
      humanInLoopSteps: [STEP_TOOL],
    };

    const step = await gw.registry.executeTool(STEP_TOOL, {}, context);
    const tier = await gw.registry.executeTool(TIER_TOOL, { id: "sched-1" }, context);

    expect(step.success).toBe(false);
    expect(step.error).toContain(`Tool '${STEP_TOOL}' requires human approval`);
    expect(tier.success).toBe(true);
    expect(ran).toEqual([TIER_TOOL]);
  }, 60_000);

  it("gives a run without autoApprove no approval callback, as before", async () => {
    const gw = await bootGateway();
    const run = await gw.send({});
    expect(run.approvalCallback).toBeUndefined();
  }, 60_000);
});
