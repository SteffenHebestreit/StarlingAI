import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalCallback } from "../tools/registry.js";

/**
 * `/run <scene>` in the chat copied the scene's task, allowedAgents and humanInLoopSteps and left
 * out its approvalChannel, so the scene's steps were approved by whoever typed /run, at their own
 * socket. A REST, webhook or job run of the same scene asks the channel (agent/scene-worker.ts).
 * Now the chat run asks the channel for the scene's steps too, and its other approvals still come
 * to the socket.
 *
 * The channel is a webhook served by a stub on 127.0.0.1: a sync webhook (the answer comes in the
 * response), or an outbound webhook (the answer comes later, on the approval callback). runTurn is
 * mocked: the test calls the approval callback the gateway hands it, as executeTool would.
 */

interface ChannelCall { toolName: string; args: Record<string, unknown>; sceneName?: string; approvalId?: string }

interface ChannelStub {
  url: string;
  calls: ChannelCall[];
  /** Answer the requests now, or hold them until release() (a person who has not decided yet). */
  hold: boolean;
  release: () => void;
  close: () => Promise<void>;
}

async function startChannelStub(approved: boolean): Promise<ChannelStub> {
  const calls: ChannelCall[] = [];
  const held: ServerResponse[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    req.on("end", () => {
      calls.push(JSON.parse(body) as ChannelCall);
      if (stub.hold) { held.push(res); return; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ approved }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const stub: ChannelStub = {
    url: `http://127.0.0.1:${port}/approve`,
    calls,
    hold: false,
    release: () => { for (const res of held.splice(0)) res.destroy(); },
    close: () => new Promise<void>((resolve) => {
      stub.release();
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
  return stub;
}

const STEP_TOOL = "create_prescription";
const OTHER_TOOL = "http_request";

type Sent = Array<{ type: string; data?: Record<string, unknown> }>;

describe("/run asks the scene's approvalChannel for its humanInLoopSteps", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.resetModules();
    vi.doUnmock("../agent/runtime.js");
    delete process.env["SAI_CONFIG_PATH"];
    (await import("../config/loader.js")).resetConfigForTests();
    const session = await import("../agent/session.js");
    for (const active of session.getAllSessions()) session.endSession(active.id);
  });

  /** A gateway connection whose config has the scene and the stub channel; `/run` started on it. */
  async function startRun(opts: {
    channel: ChannelStub;
    sceneHasChannel: boolean;
    message?: string;
    /** An outbound webhook: the request waits in the approval store for its callback. */
    outbound?: boolean;
    /** An outbound webhook, with the durable decision cache on (orchestration.durableApprovals). */
    outboundWithDurableDecisions?: boolean;
    /** Runs on the gateway as it was before a restart: on a module graph of its own, then dropped. */
    beforeRestart?: () => Promise<void>;
  }) {
    const dir = mkdtempSync(join(tmpdir(), "sai-rpc-run-approval-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
    writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
      workspacePath: dir,
      gateway: { jwtSecret: "t".repeat(32), turnTimeoutMs: 600_000, publicUrl: "http://127.0.0.1:9" },
      ...(opts.outboundWithDurableDecisions ? { orchestration: { durableApprovals: true } } : {}),
      approvalChannels: {
        physician: opts.outbound || opts.outboundWithDurableDecisions
          ? { type: "outbound_webhook", url: opts.channel.url, secret: "outbound-secret-0123456789", timeoutMs: 60_000 }
          : { type: "sync_webhook", url: opts.channel.url, timeoutMs: 10_000 },
      },
      scenes: {
        prescribe: {
          description: "Prescribe a drug",
          task: "Prescribe {{drug}} for the patient.",
          humanInLoopSteps: [STEP_TOOL],
          ...(opts.sceneHasChannel ? { approvalChannel: "physician" } : {}),
        },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
    if (opts.beforeRestart) {
      vi.resetModules();
      await opts.beforeRestart();
    }
    vi.resetModules();

    let turn: Record<string, unknown> | undefined;
    vi.doMock("../agent/runtime.js", () => ({
      runTurn: vi.fn((turnOpts: Record<string, unknown>) => {
        turn = turnOpts;
        return new Promise(() => {});
      }),
      buildTimeoutDeliveryMessage: vi.fn(() => ({ response: "timed out", recoveredAssistantText: false })),
    }));

    const sent: Sent = [];
    const ws = { readyState: 1, send(payload: string) { sent.push(JSON.parse(payload) as Sent[number]); } };
    const [{ RpcConnection }, session] = await Promise.all([import("../gateway/rpc.js"), import("../agent/session.js")]);
    const active = session.createSession({ channel: "webchat" });
    const connection = new RpcConnection(ws as never);
    const requestId = "run-1";
    await connection.handleMessage(JSON.stringify({
      id: "req-1",
      method: "chat.send",
      params: { sessionId: active.id, requestId, message: opts.message ?? "/run prescribe drug=ibuprofen" },
    }));
    cleanups.push(() => { void connection.handleMessage(JSON.stringify({ id: "req-stop", method: "chat.cancel", params: { requestId } })); });
    await vi.waitFor(() => expect(turn).toBeDefined());
    expect(turn!["humanInLoopSteps"]).toEqual([STEP_TOOL]);
    return { connection, sent, requestId, turn: turn!, approvalCallback: turn!["approvalCallback"] as ApprovalCallback };
  }

  const approvalCards = (sent: Sent) => sent.filter((event) => event.type === "agent.approval_needed");
  /** A decision the test may leave open when an assertion fails first: stopping the run settles it. */
  const askedSomewhere = (decision: Promise<boolean>): Promise<boolean> => {
    decision.catch(() => undefined);
    return decision;
  };

  it("sends the scene's step to its channel, not to the socket that typed /run", async () => {
    const channel = await startChannelStub(true);
    cleanups.push(() => channel.close());
    const { sent, requestId, approvalCallback } = await startRun({ channel, sceneHasChannel: true });

    const decision = askedSomewhere(approvalCallback(STEP_TOOL, { drug: "ibuprofen" }, { humanInLoopStep: true }));
    await vi.waitFor(() => expect(channel.calls.length + approvalCards(sent).length).toBeGreaterThan(0));

    expect(approvalCards(sent)).toEqual([]);
    expect(channel.calls).toEqual([expect.objectContaining({ toolName: STEP_TOOL, args: { drug: "ibuprofen" }, sceneName: "prescribe" })]);
    await expect(decision).resolves.toBe(true);
    expect(sent).toContainEqual({ type: "status", data: { requestId, status: "guardrail", message: "Approval requested via physician" } });
  });

  it("takes the channel's denial as the answer", async () => {
    const channel = await startChannelStub(false);
    cleanups.push(() => channel.close());
    const { sent, approvalCallback } = await startRun({ channel, sceneHasChannel: true });

    const decision = askedSomewhere(approvalCallback(STEP_TOOL, { drug: "ibuprofen" }, { humanInLoopStep: true }));
    await vi.waitFor(() => expect(channel.calls.length + approvalCards(sent).length).toBeGreaterThan(0));

    expect(approvalCards(sent)).toEqual([]);
    expect(channel.calls).toHaveLength(1);
    await expect(decision).resolves.toBe(false);
  });

  it("still asks the socket for a tool that is not one of the scene's steps", async () => {
    const channel = await startChannelStub(true);
    cleanups.push(() => channel.close());
    const { connection, sent, approvalCallback } = await startRun({ channel, sceneHasChannel: true });

    const decision = approvalCallback(OTHER_TOOL, { url: "https://example.com" }, { humanInLoopStep: false });
    await vi.waitFor(() => expect(approvalCards(sent)).toHaveLength(1));
    const approvalId = approvalCards(sent)[0]!.data!["approvalId"];
    await connection.handleMessage(JSON.stringify({ id: "req-2", method: "approval.respond", params: { approvalId, approved: true } }));

    await expect(decision).resolves.toBe(true);
    expect(channel.calls).toEqual([]);
  });

  it("stops waiting for the channel when the run is stopped", async () => {
    const channel = await startChannelStub(true);
    channel.hold = true;
    cleanups.push(() => channel.close());
    const { connection, sent, requestId, approvalCallback } = await startRun({ channel, sceneHasChannel: true });

    const decision = askedSomewhere(approvalCallback(STEP_TOOL, { drug: "ibuprofen" }, { humanInLoopStep: true }));
    await vi.waitFor(() => expect(channel.calls.length + approvalCards(sent).length).toBeGreaterThan(0));
    expect(channel.calls).toHaveLength(1);
    await connection.handleMessage(JSON.stringify({ id: "req-3", method: "chat.cancel", params: { requestId } }));

    await expect(decision).resolves.toBe(false);
  });

  // A request an outbound webhook (or Slack) sent waits in the approval store. A stopped run left it
  // there until the channel's timeout: its link still offered the buttons, the dashboard still
  // listed it, and an approval then was answered "Approved" and audited as granted for a call that
  // had been refused when the turn stopped. Stopping the run now withdraws it.
  it("withdraws the channel's request when the run is stopped, so a late approval finds nothing", async () => {
    const channel = await startChannelStub(true);
    cleanups.push(() => channel.close());
    const { connection, requestId, approvalCallback } = await startRun({ channel, sceneHasChannel: true, outbound: true });
    const store = await import("../approval/store.js");

    const decision = askedSomewhere(approvalCallback(STEP_TOOL, { drug: "ibuprofen" }, { humanInLoopStep: true }));
    await vi.waitFor(() => expect(channel.calls).toHaveLength(1));
    const approvalId = channel.calls[0]!.approvalId!;
    expect(store.listPendingApprovals()).toEqual([expect.objectContaining({ id: approvalId, toolName: STEP_TOOL, sceneName: "prescribe" })]);
    await connection.handleMessage(JSON.stringify({ id: "req-4", method: "chat.cancel", params: { requestId } }));

    await expect(decision).resolves.toBe(false);
    expect(store.listPendingApprovals()).toEqual([]);
    expect(store.resolveApproval(approvalId, true), "the physician's late approval found the request pending").toBe(false);
  });

  it("keeps a scene without an approvalChannel on the socket, as before", async () => {
    const channel = await startChannelStub(true);
    cleanups.push(() => channel.close());
    const { sent, approvalCallback } = await startRun({ channel, sceneHasChannel: false });

    void askedSomewhere(approvalCallback(STEP_TOOL, { drug: "ibuprofen" }, { humanInLoopStep: true }));
    await vi.waitFor(() => expect(approvalCards(sent)).toHaveLength(1));
    expect(approvalCards(sent)[0]!.data).toMatchObject({ toolName: STEP_TOOL });
    expect(channel.calls).toEqual([]);
  });

  // The turn is --auto (runTurn wraps this callback; auto-approve-human-in-loop.test.ts shows that
  // it hands a step on, marked): the step still reaches the channel, never the typist's --auto.
  it("sends the step of a `/run <scene> --auto` to the channel too", async () => {
    const channel = await startChannelStub(true);
    cleanups.push(() => channel.close());
    const { sent, turn, approvalCallback } = await startRun({ channel, sceneHasChannel: true, message: "/run prescribe drug=ibuprofen --auto" });
    expect(turn["autoApprove"]).toBe(true);

    const decision = askedSomewhere(approvalCallback(STEP_TOOL, { drug: "ibuprofen" }, { humanInLoopStep: true }));
    await vi.waitFor(() => expect(channel.calls.length + approvalCards(sent).length).toBeGreaterThan(0));

    expect(approvalCards(sent)).toEqual([]);
    expect(channel.calls).toEqual([expect.objectContaining({ toolName: STEP_TOOL, sceneName: "prescribe" })]);
    await expect(decision).resolves.toBe(true);
  });

  // With orchestration.durableApprovals a grant is cached under the request's key and reused, once,
  // after a restart. The requestId of chat.send is the client's: a key built from it would let the
  // client send the same /run under the same id after a restart and have the step approved with
  // nobody asked. A chat turn does not resume after a restart, so its requests carry no key.
  it("never answers a /run step from a grant made before a restart under the same requestId", async () => {
    const channel = await startChannelStub(true);
    cleanups.push(() => channel.close());
    const args = { drug: "ibuprofen" };
    const { approvalCallback } = await startRun({
      channel,
      sceneHasChannel: true,
      outboundWithDurableDecisions: true,
      beforeRestart: async () => {
        const durable = await import("../approval/durable-store.js");
        durable.recordApprovalDecision(durable.buildApprovalIdempotencyKey("run-1", STEP_TOOL, args), true, STEP_TOOL);
      },
    });

    let settled: boolean | undefined;
    const decision = askedSomewhere(approvalCallback(STEP_TOOL, args, { humanInLoopStep: true }));
    void decision.then((approved) => { settled = approved; }, () => undefined);
    await vi.waitFor(() => expect(channel.calls.length > 0 || settled !== undefined).toBe(true));

    expect(settled, "a grant cached before the restart answered the step").toBeUndefined();
    expect(channel.calls).toEqual([expect.objectContaining({ toolName: STEP_TOOL, args, sceneName: "prescribe" })]);
    // The physician answers on the approval callback.
    (await import("../approval/store.js")).resolveApproval(channel.calls[0]!.approvalId!, false);
    await expect(decision).resolves.toBe(false);
  });
});
