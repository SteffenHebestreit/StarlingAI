import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalCallback, ToolContext } from "../tools/registry.js";

/**
 * run_workflow handed a scene's turn the caller's approval callback whenever there was one, so a
 * scene that names an approvalChannel had its humanInLoopSteps approved by whoever asked for the
 * workflow: in a chat, the assistant's run_workflow (one of its default tools) sent the step's
 * approval card to the person who typed "run the prescribe workflow", the bypass a chat `/run` of
 * the same scene no longer has. Now the scene's steps go to its channel, as on a REST, webhook, job
 * or `/run` run, and the caller still answers every other approval. The steps of a job's step go to
 * that step's scene's channel the same way.
 *
 * The channel is a webhook served by a stub on 127.0.0.1. runTurn and runSubAgentWithStats are
 * mocked: they ask the approval callback run_workflow hands them, as executeTool would (a scene step
 * marked as one).
 */

interface ChannelCall { toolName: string; args: Record<string, unknown>; sceneName?: string; approvalId?: string }

interface ChannelStub {
  url: string;
  calls: ChannelCall[];
  close: () => Promise<void>;
}

/** A sync webhook that answers `approved`, or an outbound webhook (it only records the request). */
async function startChannelStub(approved: boolean): Promise<ChannelStub> {
  const calls: ChannelCall[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    req.on("end", () => {
      calls.push(JSON.parse(body) as ChannelCall);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ approved }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/approve`,
    calls,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

const STEP_TOOL = "create_prescription";
const OTHER_TOOL = "http_request";
const STEP_ARGS = { drug: "ibuprofen" };
const OTHER_ARGS = { url: "https://example.com" };

describe("run_workflow asks a scene's approvalChannel for its humanInLoopSteps", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    delete process.env["SAI_CONFIG_PATH"];
    vi.doUnmock("../agent/runtime.js");
    vi.doUnmock("../agent/sub-agent.js");
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
  });

  /**
   * run_workflow on a config with the stub as the `physician` channel. Every run the workflow starts
   * asks for the scene step and then for another tool; `decisions` records the answers.
   */
  async function loadRunWorkflow(channel: ChannelStub, opts: { outbound?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "sai-run-workflow-approval-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
    const prescribe = { allowedAgents: ["pharmacist"], humanInLoopSteps: [STEP_TOOL] };
    const review = { allowedAgents: ["pharmacist", "reviewer"], humanInLoopSteps: [STEP_TOOL] };
    writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
      workspacePath: dir,
      gateway: { jwtSecret: "t".repeat(32), publicUrl: "http://127.0.0.1:9" },
      agents: { defaults: { model: { primary: "lmstudio/qwen/qwen3.5-9b" } } },
      approvalChannels: {
        physician: opts.outbound
          ? { type: "outbound_webhook", url: channel.url, secret: "outbound-secret-0123456789", timeoutMs: 60_000 }
          : { type: "sync_webhook", url: channel.url, timeoutMs: 10_000 },
      },
      scenes: {
        // One leaf agent: run_workflow runs it directly (runSubAgentWithStats).
        prescribe: { description: "Prescribe a drug.", task: "Use pharmacist to prescribe ibuprofen.", ...prescribe, approvalChannel: "physician" },
        // Two agents: run_workflow orchestrates them (runTurn).
        prescribe_review: { description: "Prescribe and review.", task: "Have the pharmacist prescribe ibuprofen and the reviewer check it.", ...review, approvalChannel: "physician" },
        prescribe_unrouted: { description: "Prescribe without a channel.", task: "Use pharmacist to prescribe ibuprofen.", ...prescribe },
      },
      jobs: {
        prescribe_job: { description: "Prescribe as a job.", steps: [{ scene: "prescribe", label: "Prescribe" }] },
        review_job: { description: "Prescribe and review as a job.", steps: [{ scene: "prescribe_review", label: "Prescribe and review" }] },
      },
      subAgents: {
        pharmacist: { description: "Prescribes drugs.", tools: ["read_file"], maxIterations: 4 },
        reviewer: { description: "Reviews prescriptions.", tools: ["read_file"], maxIterations: 4 },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
    vi.resetModules();

    const decisions: Array<{ tool: string; approved: boolean | string }> = [];
    const askBoth = async (approvalCallback: ApprovalCallback | undefined): Promise<void> => {
      for (const [tool, args, humanInLoopStep] of [[STEP_TOOL, STEP_ARGS, true], [OTHER_TOOL, OTHER_ARGS, false]] as const) {
        if (!approvalCallback) { decisions.push({ tool, approved: "no callback" }); continue; }
        decisions.push({ tool, approved: await approvalCallback(tool, { ...args }, { humanInLoopStep }).catch((err: Error) => err.message) });
      }
    };
    const runTurn = vi.fn(async (turn: { approvalCallback?: ApprovalCallback }) => {
      await askBoth(turn.approvalCallback);
      return { response: "done", toolCallsExecuted: 1, guardrailEvents: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, blocked: false };
    });
    const runSubAgentWithStats = vi.fn(async (run: { agentName: string; approvalCallback?: ApprovalCallback }) => {
      await askBoth(run.approvalCallback);
      return {
        output: "done",
        stats: {
          agentName: run.agentName, sessionId: `sub:workflow:${run.agentName}:test`, promptChars: 0, userContentChars: 0,
          toolCount: 1, toolNames: [STEP_TOOL], iterations: 1, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          maxIterations: 4, model: "lmstudio/qwen/qwen3.5-9b", capabilities: [], outcome: "success", terminalState: "completed",
        },
        artifacts: [],
      };
    });
    vi.doMock("../agent/runtime.js", () => ({
      collectTurnArtifactAttachments: () => [],
      classifyPostOrchestrationDisposition: () => "synthesize",
      runTurn,
    }));
    vi.doMock("../agent/sub-agent.js", () => ({ runSubAgentWithStats }));

    const registry = await import("../tools/registry.js");
    await import("../tools/workflow-catalog.js");
    const tool = registry.getTool("run_workflow")!;
    const run = (args: { name: string; workflowType: "scene" | "job" }, ctx: Partial<ToolContext>) =>
      tool.execute(args, { sessionId: `workflow-${args.name}`, workspacePath: dir, ...ctx });
    return { run, decisions, runTurn, runSubAgentWithStats };
  }

  it.each([
    ["a scene its one agent runs directly", "prescribe", "scene", "runSubAgentWithStats", "prescribe"],
    ["a scene it orchestrates", "prescribe_review", "scene", "runTurn", "prescribe_review"],
    ["a job step its one agent runs directly", "prescribe_job", "job", "runSubAgentWithStats", "prescribe"],
    ["a job step it orchestrates", "review_job", "job", "runTurn", "prescribe_review"],
  ] as const)("sends the scene step of %s to the channel, and the other tool to the caller", async (_label, name, workflowType, runner, sceneName) => {
    // The channel denies and the caller approves, so each answer shows who gave it.
    const channel = await startChannelStub(false);
    cleanups.push(() => channel.close());
    const workflow = await loadRunWorkflow(channel);
    const caller = vi.fn<ApprovalCallback>(async () => true);

    await workflow.run({ name, workflowType }, { approvalCallback: caller });

    expect(workflow[runner]).toHaveBeenCalledTimes(1);
    expect(channel.calls).toEqual([expect.objectContaining({ toolName: STEP_TOOL, args: STEP_ARGS, sceneName })]);
    expect(caller.mock.calls).toEqual([[OTHER_TOOL, OTHER_ARGS, { humanInLoopStep: false }]]);
    expect(workflow.decisions).toEqual([{ tool: STEP_TOOL, approved: false }, { tool: OTHER_TOOL, approved: true }]);
  });

  it("keeps the steps of a scene without an approvalChannel with the caller, as before", async () => {
    const channel = await startChannelStub(false);
    cleanups.push(() => channel.close());
    const workflow = await loadRunWorkflow(channel);
    const caller = vi.fn<ApprovalCallback>(async () => true);

    await workflow.run({ name: "prescribe_unrouted", workflowType: "scene" }, { approvalCallback: caller });

    expect(channel.calls).toEqual([]);
    expect(caller.mock.calls.map(([tool, , request]) => [tool, request])).toEqual([
      [STEP_TOOL, { humanInLoopStep: true }],
      [OTHER_TOOL, { humanInLoopStep: false }],
    ]);
    expect(workflow.decisions).toEqual([{ tool: STEP_TOOL, approved: true }, { tool: OTHER_TOOL, approved: true }]);
  });

  // The turn that called run_workflow is stopped while the physician has not answered: the request
  // is withdrawn, so its link and the dashboard no longer offer a decision that changes nothing.
  it("withdraws the channel's request when the calling turn is stopped", async () => {
    const channel = await startChannelStub(true);
    cleanups.push(() => channel.close());
    const workflow = await loadRunWorkflow(channel, { outbound: true });
    const store = await import("../approval/store.js");
    const caller = vi.fn<ApprovalCallback>(async () => true);
    const turn = new AbortController();

    const result = workflow.run({ name: "prescribe", workflowType: "scene" }, { approvalCallback: caller, signal: turn.signal });
    await vi.waitFor(() => expect(channel.calls).toHaveLength(1));
    const approvalId = channel.calls[0]!.approvalId!;
    expect(store.getPendingApproval(approvalId)).toMatchObject({ toolName: STEP_TOOL, sceneName: "prescribe" });

    turn.abort();
    await result;

    expect(workflow.decisions[0]).toEqual({ tool: STEP_TOOL, approved: false });
    expect(store.getPendingApproval(approvalId)).toBeUndefined();
    expect(store.resolveApproval(approvalId, true), "a late approval found the request still pending").toBe(false);
  });
});
