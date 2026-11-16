import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A channel request (Slack, an outbound webhook) waits in the approval store for its callback. The
 * run that asked raced the wait against its abort signal and stopped waiting, but left the request
 * pending until the channel's timeout (10 minutes by default, up to 24 hours per scene): its link
 * still offered the buttons, the dashboard still listed it with its arguments, and an approval then
 * was answered "Approved" and audited as granted for a call that had already been refused. The scene
 * worker's job callback (sceneChannelApprovalCallback, aborted when the job is cancelled) did the
 * same. A run that stops now withdraws its request.
 *
 * The channel is an outbound webhook served by a stub on 127.0.0.1.
 */

interface ChannelCall { toolName: string; approvalId: string }

async function startOutboundStub(): Promise<{ url: string; calls: ChannelCall[]; close: () => Promise<void> }> {
  const calls: ChannelCall[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    req.on("end", () => {
      calls.push(JSON.parse(body) as ChannelCall);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
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

describe("a stopped run withdraws its channel request", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    delete process.env["SAI_CONFIG_PATH"];
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
  });

  async function load() {
    const stub = await startOutboundStub();
    cleanups.push(() => stub.close());
    const dir = mkdtempSync(join(tmpdir(), "sai-approval-withdraw-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
    writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
      workspacePath: dir,
      gateway: { jwtSecret: "t".repeat(32), publicUrl: "http://127.0.0.1:9" },
      approvalChannels: {
        physician: { type: "outbound_webhook", url: stub.url, secret: "outbound-secret-0123456789", timeoutMs: 60_000 },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
    vi.resetModules();
    const approvals = await import("../approval/index.js");
    const store = await import("../approval/store.js");
    cleanups.push(() => { for (const entry of store.listPendingApprovals()) store.resolveApproval(entry.id, false); });
    return { stub, approvals, store };
  }

  it("withdraws the request of a scene worker's job when the job is cancelled", async () => {
    const { stub, approvals, store } = await load();
    const job = new AbortController();
    // As agent/scene-worker.ts builds it: the job's controller, and a durable-decision key.
    const viaChannel = approvals.sceneChannelApprovalCallback(
      { name: "prescribe", approvalChannel: "physician", humanInLoopSteps: ["create_prescription"] },
      { idempotencyKey: (toolName) => `job-1:step0:${toolName}`, signal: job.signal },
    )!;

    const decision = viaChannel("create_prescription", { drug: "ibuprofen" });
    await vi.waitFor(() => expect(stub.calls).toHaveLength(1));
    const { approvalId } = stub.calls[0]!;
    expect(store.getPendingApproval(approvalId)).toMatchObject({ toolName: "create_prescription", sceneName: "prescribe" });

    job.abort();

    await expect(decision).resolves.toBe(false);
    expect(store.getPendingApproval(approvalId)).toBeUndefined();
    expect(store.listPendingApprovals()).toEqual([]);
    expect(store.resolveApproval(approvalId, true), "a late approval found the request pending").toBe(false);
  });

  it("still waits for the decision while the run goes on", async () => {
    const { stub, approvals, store } = await load();
    const run = new AbortController();

    const decision = approvals.requestApprovalViaChannel("physician", "create_prescription", {}, "prescribe", undefined, undefined, run.signal);
    await vi.waitFor(() => expect(stub.calls).toHaveLength(1));
    expect(store.resolveApproval(stub.calls[0]!.approvalId, true)).toBe(true);

    await expect(decision).resolves.toBe(true);
    // Stopping the run after the decision withdraws nothing and changes nothing.
    run.abort();
    expect(store.listPendingApprovals()).toEqual([]);
  });

  it("asks nobody for a run that has already stopped", async () => {
    const { stub, approvals, store } = await load();
    const run = new AbortController();
    run.abort();

    await expect(approvals.requestApprovalViaChannel("physician", "create_prescription", {}, "prescribe", undefined, undefined, run.signal)).resolves.toBe(false);
    expect(store.listPendingApprovals()).toEqual([]);
    expect(stub.calls).toEqual([]);
  });
});
