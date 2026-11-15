import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRODUCT } from "../product/index.js";
import { testAccount } from "./support/test-account.js";
import type { ToolContext, ToolResult } from "../tools/registry.js";
import type { TurnSender } from "../runtime/request-context.js";

/**
 * Approver roles for per-call approvals (guardrails/tool-tiers.ts ToolApprovalPolicy).
 *
 * A per-call approval went only to the requester's own socket, so the person who asked approved
 * their own call and nobody else could: a requester approved the export a reviewer was meant to
 * sign off, and the reviewer never saw the request. A tool can now name the roles that may grant
 * its approval. The person who sent the message keeps their own approval card when the policy
 * admits the role they hold now and the chat is theirs; any other call (a role the policy does not
 * admit, someone else's chat, a second person required, --auto, a callback that answers by itself)
 * waits in the approval store for a signed-in approver, who alone can list and decide it, and holds
 * the run's clocks while it waits. These run against the whole gateway, on loopback, with a test
 * extension declaring two such tools.
 */
const APPROVER_ROLE = "approver_role";
const REQUESTER_ROLE = "requester_role";
const EXPORT_TOOL = "approval_test_export";
const RELEASE_TOOL = "approval_test_release";
const ENV_KEYS = ["SAI_CONFIG_PATH", "SAI_MASTER_KEY", "SAI_CRED_STORE", "SAI_AUDIT_LOG", "SAI_JOB_WAKE_DISABLED", "SAI_EXTENSIONS_DIR"];

/** What each test tool's handler saw: how its call was approved. */
const handled: Array<{ tool: string; approval: ToolContext["approval"] }> = [];

function testExtension() {
  const execute = (tool: string) => async (_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
    handled.push({ tool, approval: ctx.approval });
    return { success: true, output: `${tool} done` };
  };
  return {
    name: "approval-test",
    version: "1.0.0",
    tools: [
      {
        name: EXPORT_TOOL,
        description: "Export a record once an approver has signed it off",
        parameters: { type: "object", properties: { record: { type: "string" } } },
        tier: 3,
        requiresPerCallApproval: true,
        approval: { approverRoles: [APPROVER_ROLE] },
        execute: execute(EXPORT_TOOL),
      },
      {
        name: RELEASE_TOOL,
        description: "Release a record; a second person must approve",
        parameters: { type: "object", properties: { record: { type: "string" } } },
        tier: 3,
        requiresPerCallApproval: true,
        approval: { approverRoles: [APPROVER_ROLE], distinctApprover: true },
        execute: execute(RELEASE_TOOL),
      },
    ],
    roles: [
      // Ranked below operator on purpose: an approver role is listed, not ranked.
      { name: APPROVER_ROLE, description: "May sign off exports", rank: 30 },
      { name: REQUESTER_ROLE, description: "Asks for exports", rank: 10 },
    ],
  };
}

let tempDir = "";
let baseUrl = "";
let stopGateway: () => Promise<void> = async () => {};
let mods: {
  auth: typeof import("../gateway/auth.js");
  approvals: typeof import("../approval/store.js");
  routed: typeof import("../approval/routed.js");
  registry: typeof import("../tools/registry.js");
  requestContext: typeof import("../runtime/request-context.js");
  notifications: typeof import("../runtime/notifications.js");
  config: typeof import("../config/loader.js");
  jobs: typeof import("../agent/jobs.js");
  audit: typeof import("../audit/logger.js");
  broker: typeof import("../agent/user-input-broker.js");
};

const USERS = {
  patty: testAccount("patty", REQUESTER_ROLE),
  alice: testAccount("alice", APPROVER_ROLE),
  amir: testAccount("amir", APPROVER_ROLE),
  otto: testAccount("otto", "operator"),
  vera: testAccount("vera", "viewer"),
};
type User = keyof typeof USERS;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "starlingai-approver-policy-"));
  const configDir = join(tempDir, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "10-test.json"), JSON.stringify({
    gateway: { jwtSecret: "j".repeat(40) },
    workspacePath: tempDir,
    auth: { enabled: true, users: Object.values(USERS).map((user) => user.record) },
  }), "utf8");
  // The loader discovers the directory; the manifest comes through the importer seam.
  const extensionsDir = join(tempDir, "extensions");
  mkdirSync(join(extensionsDir, "approval-test"), { recursive: true });
  writeFileSync(join(extensionsDir, "approval-test", "index.mjs"), "// discovery marker\n", "utf8");
  process.env["SAI_CONFIG_PATH"] = configDir;
  process.env["SAI_MASTER_KEY"] = "m".repeat(32);
  process.env["SAI_CRED_STORE"] = join(tempDir, PRODUCT.stateDirName, "credentials.enc");
  process.env["SAI_AUDIT_LOG"] = join(tempDir, "audit.jsonl");
  process.env["SAI_JOB_WAKE_DISABLED"] = "1";
  process.env["SAI_EXTENSIONS_DIR"] = extensionsDir;
  vi.resetModules();
  // Sequential imports: these modules import each other.
  const loader = await import("../extension/loader.js");
  loader.setExtensionImporterForTests(async () => ({ default: testExtension() }));
  const loaded = await loader.loadCoreExtensions();
  expect(loaded).toMatchObject({ loaded: 1, failed: 0 });
  const { createGateway } = await import("../gateway/index.js");
  mods = {
    auth: await import("../gateway/auth.js"),
    approvals: await import("../approval/store.js"),
    routed: await import("../approval/routed.js"),
    registry: await import("../tools/registry.js"),
    requestContext: await import("../runtime/request-context.js"),
    notifications: await import("../runtime/notifications.js"),
    config: await import("../config/loader.js"),
    jobs: await import("../agent/jobs.js"),
    audit: await import("../audit/logger.js"),
    broker: await import("../agent/user-input-broker.js"),
  };

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
  const bound = server?.address() as AddressInfo;
  expect(bound.address).toBe("127.0.0.1");
  baseUrl = `http://127.0.0.1:${bound.port}`;
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

afterEach(() => {
  handled.length = 0;
  vi.useRealTimers();
  // Nothing a test left pending carries into the next one.
  for (const entry of mods.approvals.listPendingApprovals()) mods.approvals.cancelPendingApproval(entry.id);
});

async function token(user: User): Promise<string> {
  return mods.auth.createToken(user, USERS[user].claims);
}

async function pendingFor(user: User): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`${baseUrl}/api/approvals/pending`, { headers: { Authorization: `Bearer ${await token(user)}` } });
  expect(response.status).toBe(200);
  return await response.json() as Array<Record<string, unknown>>;
}

async function decide(user: User | null, approvalId: string, approved: boolean, extra: Record<string, unknown> = {}) {
  const response = await fetch(`${baseUrl}/api/approval/${encodeURIComponent(approvalId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(user ? { Authorization: `Bearer ${await token(user)}` } : {}) },
    body: JSON.stringify({ approved, ...extra }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

/** The ToolContext of a chat turn in `user`'s chat (its owner and stored role), with that chat's approval card. */
function chatContext(user: User, card: ToolContext["approvalCallback"], extra: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: `chat-${user}`,
    workspacePath: tempDir,
    userId: user,
    identity: { userId: user, account: USERS[user].id },
    userRole: USERS[user].claims["role"] as string,
    approvalCallback: card,
    ...extra,
  };
}

/** The person who sent a chat's message, as chat.send gives the turn (RequestContext.sender). */
function senderOf(user: User, role = USERS[user].claims["role"] as string): () => TurnSender {
  return () => ({ identity: { userId: user, account: USERS[user].id }, role });
}

/** A call in `user`'s chat turn: the ToolContext runtime.ts builds, sent by `sender` (by default the chat's owner). */
function chatCall(
  user: User,
  tool: string,
  args: Record<string, unknown>,
  card: ToolContext["approvalCallback"],
  extra: Partial<ToolContext> = {},
  sender: () => TurnSender = senderOf(user),
): Promise<ToolResult> {
  return mods.requestContext.runWithRequestContext({ sender }, () => mods.registry.executeTool(tool, args, chatContext(user, card, extra)));
}

/** The one routed entry waiting for `tool`, once the call has put it there. */
async function routedEntry(tool: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const entry = mods.approvals.listPendingApprovals().find((pending) => pending.toolName === tool && pending.kind === "routed");
    if (entry) return entry;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`no routed approval for ${tool}`);
}

describe("a tool whose approval policy names its approvers", () => {
  it("a requester the policy admits approves on their own card, as before", async () => {
    const card = vi.fn(async () => true);
    const result = await chatCall("alice", EXPORT_TOOL, { record: "r1" }, mods.routed.requesterApprovalCallback(card));

    expect(result.success).toBe(true);
    // The card is asked as every approval callback is, with whether the call is a scene's
    // humanInLoopSteps step (approval-bypass-fixes): it is not.
    expect(card).toHaveBeenCalledWith(EXPORT_TOOL, { record: "r1" }, { humanInLoopStep: false });
    expect(mods.approvals.listPendingApprovals()).toEqual([]);
    expect(handled).toEqual([{
      tool: EXPORT_TOOL,
      approval: { via: "requester", approvedBy: { userId: "alice", account: USERS.alice.id }, approverRole: APPROVER_ROLE },
    }]);
  });

  it("a requester it does not admit waits for an approver: only an approver sees and decides it, and the tool learns who", async () => {
    const audited: Array<{ type: string; data: Record<string, unknown> }> = [];
    const stopAudit = mods.audit.subscribeToAudit((event) => {
      if (event.type.startsWith("approval_routed_")) audited.push({ type: event.type, data: event.data });
    });
    onTestFinished(stopAudit);
    // The requester's own card would say yes: it is never asked.
    const card = vi.fn(async () => true);
    const pendingEvents: unknown[] = [];
    const outcomes: string[] = [];
    const call = chatCall("patty", EXPORT_TOOL, { record: "r2" }, mods.routed.requesterApprovalCallback(card), {
      onApprovalPending: (event) => {
        pendingEvents.push(event);
        return (outcome) => { outcomes.push(outcome); };
      },
    });
    const entry = await routedEntry(EXPORT_TOOL);
    expect(card).not.toHaveBeenCalled();
    expect(pendingEvents).toEqual([expect.objectContaining({ approvalId: entry.id, toolName: EXPORT_TOOL, approverRoles: [APPROVER_ROLE] })]);
    // The approvers are told, and only they (audienceRoles never leaves the gateway).
    const notice = mods.notifications.listRecentNotifications(1)[0]!;
    expect(notice).toMatchObject({ category: "approval", audienceRoles: [APPROVER_ROLE] });
    expect(mods.notifications.notificationForCaller(notice, undefined, { role: APPROVER_ROLE })).toMatchObject({ category: "approval" });
    expect(mods.notifications.notificationForCaller(notice, undefined, { role: APPROVER_ROLE })).not.toHaveProperty("audienceRoles");
    expect(mods.notifications.notificationForCaller(notice, undefined, { role: "operator" })).toBeUndefined();
    expect(mods.notifications.notificationForCaller(notice, undefined, { role: REQUESTER_ROLE })).toBeUndefined();
    expect(mods.notifications.notificationForCaller(notice, undefined)).toBeUndefined();

    // Listed for the approver, with who asked and with what; not for the requester or an operator.
    expect(await pendingFor("alice")).toEqual([expect.objectContaining({
      id: entry.id, kind: "routed", toolName: EXPORT_TOOL, args: { record: "r2" },
      requester: "patty", requesterRole: REQUESTER_ROLE, approverRoles: [APPROVER_ROLE],
    })]);
    expect(JSON.stringify(await pendingFor("alice"))).not.toContain("chat-patty");
    expect(await pendingFor("patty")).toEqual([]);
    expect(await pendingFor("otto")).toEqual([]);

    // Nobody but an approver decides it: not the requester, not an operator, not without a session,
    // not with the one-click link (it has no secret to check).
    expect(await decide("patty", entry.id, true)).toEqual({ status: 403, body: { error: `Requires role: ${APPROVER_ROLE}` } });
    expect(await decide("otto", entry.id, true)).toEqual({ status: 403, body: { error: `Requires role: ${APPROVER_ROLE}` } });
    expect((await decide(null, entry.id, true)).status).toBe(404);
    expect((await decide(null, entry.id, true, { secret: "" })).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/approval/${entry.id}?approved=true`)).status).toBe(404);
    expect(mods.approvals.getPendingApproval(entry.id)).toBeDefined();
    expect(handled).toEqual([]);

    expect(await decide("alice", entry.id, true)).toEqual({ status: 200, body: { ok: true, approved: true } });
    const result = await call;
    expect(result.success).toBe(true);
    expect(handled).toEqual([{
      tool: EXPORT_TOOL,
      approval: { via: "routed", approvalId: entry.id, approvedBy: { userId: "alice", account: USERS.alice.id }, approverRole: APPROVER_ROLE },
    }]);
    expect(outcomes).toEqual(["approved"]);
    expect(mods.approvals.getPendingApproval(entry.id)).toBeUndefined();

    // The audit names the request, who asked and who decided, never the call's arguments.
    expect(audited).toEqual([
      {
        type: "approval_routed_requested",
        data: { tool: EXPORT_TOOL, approvalId: entry.id, approverRoles: [APPROVER_ROLE], requester: "patty", requesterRole: REQUESTER_ROLE, distinctApprover: false },
      },
      {
        type: "approval_routed_resolved",
        data: { tool: EXPORT_TOOL, approvalId: entry.id, approved: true, outcome: "approved", decidedBy: "alice", role: APPROVER_ROLE },
      },
    ]);
    expect(JSON.stringify(audited)).not.toContain("r2");
  });

  it("an approver's denial is the user's no, which the model is told not to work around", async () => {
    const call = chatCall("patty", EXPORT_TOOL, { record: "r3" }, mods.routed.requesterApprovalCallback(async () => true));
    const entry = await routedEntry(EXPORT_TOOL);
    expect((await decide("amir", entry.id, false)).status).toBe(200);
    const result = await call;
    expect(result.success).toBe(false);
    expect(result.error).toContain("denied by user");
    expect(result.error).toContain("Do not ask for it again");
    expect(handled).toEqual([]);
  });

  it("with a second person required, even an approver's own call waits for another approver", async () => {
    const card = vi.fn(async () => true);
    const call = chatCall("alice", RELEASE_TOOL, { record: "r4" }, mods.routed.requesterApprovalCallback(card));
    const entry = await routedEntry(RELEASE_TOOL);
    expect(card).not.toHaveBeenCalled();
    expect(entry).toMatchObject({ distinctApprover: true, requester: "alice" });

    // Not listed for the requester, listed for the other approver.
    expect(await pendingFor("alice")).toEqual([]);
    expect(await pendingFor("amir")).toEqual([expect.objectContaining({ id: entry.id, distinctApprover: true })]);
    expect(await decide("alice", entry.id, true)).toEqual({ status: 403, body: { error: "A second person must approve this request" } });
    expect(mods.approvals.getPendingApproval(entry.id)).toBeDefined();

    expect((await decide("amir", entry.id, true)).status).toBe(200);
    expect((await call).success).toBe(true);
    expect(handled[0]?.approval).toMatchObject({ via: "routed", approvedBy: { userId: "amir" }, approverRole: APPROVER_ROLE });
  });

  const answersYes = async (): Promise<boolean> => true;
  it.each<[string, Partial<ToolContext>]>([
    ["--auto (the runtime's callback that answers yes, with autoApprove)", { autoApprove: true, approvalCallback: answersYes }],
    ["the legacy A2A route's autoApprove (a bare callback that answers yes)", { approvalCallback: answersYes }],
    ["--auto with the requester's own card still bound", { autoApprove: true }],
  ])("%s never grants it, even for an approver: the call waits for an approver", async (_how, overrides) => {
    const card = vi.fn(async () => true);
    const call = chatCall("alice", EXPORT_TOOL, { record: "r5" }, mods.routed.requesterApprovalCallback(card), overrides);
    const entry = await routedEntry(EXPORT_TOOL);
    expect(card).not.toHaveBeenCalled();
    expect(handled).toEqual([]);
    expect((await decide("amir", entry.id, true)).status).toBe(200);
    expect((await call).success).toBe(true);
    expect(handled[0]?.approval).toMatchObject({ via: "routed", approvedBy: { userId: "amir" } });
  });

  it("a scene's approval channel does not stand in for the requester's card", async () => {
    const channel = vi.fn(async () => true);
    const call = chatCall("alice", EXPORT_TOOL, { record: "r6" }, channel);
    const entry = await routedEntry(EXPORT_TOOL);
    expect(channel).not.toHaveBeenCalled();
    mods.approvals.cancelPendingApproval(entry.id);
    expect((await call).success).toBe(false);
  });

  it("nobody deciding before the timeout denies the call", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const call = chatCall("patty", EXPORT_TOOL, { record: "r7" }, mods.routed.requesterApprovalCallback(async () => true));
    // The entry is created on the call's first await; nothing else runs in between.
    await vi.waitFor(() => expect(mods.approvals.listPendingApprovals().some((p) => p.toolName === EXPORT_TOOL)).toBe(true));
    await vi.advanceTimersByTimeAsync(mods.config.getConfig().gateway.approvalTimeoutMs + 1);
    const result = await call;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^Tool 'approval_test_export' approval timed out \(no approver_role responded within 5 min\)/);
    expect(handled).toEqual([]);
    expect(mods.approvals.listPendingApprovals()).toEqual([]);
  });

  it("approvals.routedTimeoutMs sets how long a routed call waits, apart from the requester's own card", async () => {
    mods.config.updateConfig((raw) => { raw["approvals"] = { routedTimeoutMs: 120_000 }; });
    try {
      expect(mods.config.getConfig().approvals.routedTimeoutMs).toBe(120_000);
      expect(mods.config.getConfig().gateway.approvalTimeoutMs).not.toBe(120_000);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const call = chatCall("patty", EXPORT_TOOL, { record: "r7b" }, mods.routed.requesterApprovalCallback(async () => true));
      await vi.waitFor(() => expect(mods.approvals.listPendingApprovals().some((p) => p.toolName === EXPORT_TOOL)).toBe(true));
      const entry = mods.approvals.listPendingApprovals().find((p) => p.toolName === EXPORT_TOOL)!;
      await vi.advanceTimersByTimeAsync(119_000);
      expect(mods.approvals.getPendingApproval(entry.id)).toBeDefined();
      await vi.advanceTimersByTimeAsync(1_001);
      const result = await call;
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/^Tool 'approval_test_export' approval timed out \(no approver_role responded within 2 min\)/);
      expect(handled).toEqual([]);
    } finally {
      vi.useRealTimers();
      mods.config.updateConfig((raw) => { delete raw["approvals"]; });
    }
    expect(mods.config.getConfig().approvals.routedTimeoutMs).toBeUndefined();
  });

  it("a stopped turn withdraws its request", async () => {
    const controller = new AbortController();
    const call = chatCall("patty", EXPORT_TOOL, { record: "r8" }, mods.routed.requesterApprovalCallback(async () => true), { signal: controller.signal });
    const entry = await routedEntry(EXPORT_TOOL);
    controller.abort();
    const result = await call;
    expect(result.success).toBe(false);
    expect(result.error).toContain("withdrawn");
    expect(mods.approvals.getPendingApproval(entry.id)).toBeUndefined();
    expect((await decide("alice", entry.id, true)).status).toBe(404);
    expect(handled).toEqual([]);
  });

  it("inside a sub-agent, whose context carries no role, the requester is the person who sent the chat's message", async () => {
    // A specialist's ToolContext: the chat owner's identity, the parent's card by reference, no
    // userRole. The request context is the chat turn's, inherited by the specialist.
    const subAgentContext = (user: User, card: ToolContext["approvalCallback"]): ToolContext => ({
      sessionId: `sub:chat-${user}:specialist:1`,
      workspacePath: tempDir,
      userId: user,
      identity: { userId: user, account: USERS[user].id },
      approvalCallback: card,
    });
    const card = vi.fn(async () => true);
    const admitted = mods.requestContext.runWithRequestContext({ sender: senderOf("alice") }, () =>
      mods.registry.executeTool(EXPORT_TOOL, { record: "r9" }, subAgentContext("alice", mods.routed.requesterApprovalCallback(card))));
    await vi.waitFor(() => expect(card).toHaveBeenCalledTimes(1));
    expect((await admitted).success).toBe(true);
    expect(handled[0]?.approval).toMatchObject({ via: "requester", approvedBy: { userId: "alice" }, approverRole: APPROVER_ROLE });

    // From a sender the policy does not admit, or one whose role is not known, it is routed.
    for (const sender of [senderOf("patty"), () => ({ identity: { userId: "patty", account: USERS.patty.id } })]) {
      const routedCard = vi.fn(async () => true);
      const call = mods.requestContext.runWithRequestContext({ sender }, () =>
        mods.registry.executeTool(EXPORT_TOOL, { record: "r10" }, subAgentContext("patty", mods.routed.requesterApprovalCallback(routedCard))));
      const entry = await routedEntry(EXPORT_TOOL);
      expect(routedCard).not.toHaveBeenCalled();
      expect(entry).toMatchObject({ requester: "patty" });
      mods.approvals.cancelPendingApproval(entry.id);
      expect((await call).success).toBe(false);
    }

    // A run nobody sent a message for (a job's or an A2A run's specialist) asks no card at all; its
    // entry records the role its work carries (RequestContext.callerRole).
    const jobCard = vi.fn(async () => true);
    const call = mods.requestContext.runWithRequestContext({ callerRole: APPROVER_ROLE }, () =>
      mods.registry.executeTool(EXPORT_TOOL, { record: "r10b" }, subAgentContext("alice", mods.routed.requesterApprovalCallback(jobCard))));
    const entry = await routedEntry(EXPORT_TOOL);
    expect(jobCard).not.toHaveBeenCalled();
    expect(entry).toMatchObject({ requester: "alice", requesterRole: APPROVER_ROLE });
    mods.approvals.cancelPendingApproval(entry.id);
    expect((await call).success).toBe(false);
  });

  it("the requester is the person who sent the message, as they are now, not the chat's owner or its stored role", async () => {
    // Alice's chat (stored with her approver role), driven by an operator the policy does not admit:
    // the operator asks, and their call is routed.
    const aliceCard = vi.fn(async () => true);
    const byOperator = chatCall("alice", EXPORT_TOOL, { record: "r13" }, mods.routed.requesterApprovalCallback(aliceCard), {}, senderOf("otto"));
    const operatorEntry = await routedEntry(EXPORT_TOOL);
    expect(aliceCard).not.toHaveBeenCalled();
    expect(mods.approvals.getPendingApproval(operatorEntry.id))
      .toMatchObject({ requester: { userId: "otto", account: USERS.otto.id }, requesterRole: "operator" });
    mods.approvals.cancelPendingApproval(operatorEntry.id);
    expect((await byOperator).success).toBe(false);

    // Patty's chat, driven by an approver: not their own chat, so not their card either. They are
    // the one who asked, and with a second person required they may not decide it.
    const pattyCard = vi.fn(async () => true);
    const byApprover = chatCall("patty", RELEASE_TOOL, { record: "r14" }, mods.routed.requesterApprovalCallback(pattyCard), {}, senderOf("alice"));
    const approverEntry = await routedEntry(RELEASE_TOOL);
    expect(pattyCard).not.toHaveBeenCalled();
    expect(mods.approvals.getPendingApproval(approverEntry.id))
      .toMatchObject({ requester: { userId: "alice", account: USERS.alice.id }, requesterRole: APPROVER_ROLE });
    expect(await decide("alice", approverEntry.id, true)).toEqual({ status: 403, body: { error: "A second person must approve this request" } });
    expect((await decide("amir", approverEntry.id, true)).status).toBe(200);
    expect((await byApprover).success).toBe(true);
    expect(handled).toEqual([{ tool: RELEASE_TOOL, approval: expect.objectContaining({ via: "routed", approvedBy: { userId: "amir", account: USERS.amir.id } }) }]);

    // A chat's card with nobody named as its sender is never asked: there is nobody to credit.
    const unsentCard = vi.fn(async () => true);
    const unsent = mods.registry.executeTool(EXPORT_TOOL, { record: "r15" }, chatContext("alice", mods.routed.requesterApprovalCallback(unsentCard)));
    const unsentEntry = await routedEntry(EXPORT_TOOL);
    expect(unsentCard).not.toHaveBeenCalled();
    mods.approvals.cancelPendingApproval(unsentEntry.id);
    expect((await unsent).success).toBe(false);
  });

  it("a requester whose role changed while their card was open does not grant the call", async () => {
    let role = APPROVER_ROLE;
    const sender = () => ({ identity: { userId: "alice", account: USERS.alice.id }, role });
    const card = vi.fn(async () => {
      role = REQUESTER_ROLE;
      return true;
    });
    const result = await chatCall("alice", EXPORT_TOOL, { record: "r16" }, mods.routed.requesterApprovalCallback(card), {}, sender);
    expect(card).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: false, error: `Tool '${EXPORT_TOOL}' was not run: the person who approved it no longer holds ${APPROVER_ROLE}` });
    expect(handled).toEqual([]);
  });

  it("a routed wait holds the run's clocks, a specialist's too, and credits them its length", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const credited: number[] = [];
    const chatClocks = mods.broker.trackHumanWaits("chat-patty", (waitedMs) => { credited.push(waitedMs); });
    onTestFinished(() => chatClocks.dispose());
    const call = chatCall("patty", EXPORT_TOOL, { record: "r17" }, mods.routed.requesterApprovalCallback(async () => true), {
      sessionId: "sub:chat-patty:specialist:1",
    });
    await vi.waitFor(() => expect(mods.approvals.listPendingApprovals().some((p) => p.toolName === EXPORT_TOOL)).toBe(true));
    const entry = mods.approvals.listPendingApprovals().find((p) => p.toolName === EXPORT_TOOL)!;
    expect(chatClocks.isWaiting()).toBe(true);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(mods.routed.decideRoutedApproval(entry.id, true, { identity: { userId: "alice", account: USERS.alice.id }, role: APPROVER_ROLE }))
      .toEqual({ outcome: "decided" });
    expect((await call).success).toBe(true);
    expect(chatClocks.isWaiting()).toBe(false);
    expect(credited).toHaveLength(1);
    expect(credited[0]).toBeGreaterThanOrEqual(120_000);
  });

  it("a call made from inside an approved handler, with its context, does not inherit that approval", async () => {
    const tiers = await import("../guardrails/tool-tiers.js");
    const seen: Array<ToolContext["approval"]> = [];
    tiers.registerExtensionToolTier("approval_test_plain", { tier: 0, description: "x", requiresPerCallApproval: false, requiresSandbox: false }, "approval-test");
    mods.registry.registerTool({
      name: "approval_test_plain",
      description: "x",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => { seen.push(ctx.approval); return { success: true, output: "" }; },
    });
    try {
      const handlerContext: ToolContext = {
        ...chatContext("patty", undefined),
        approval: { via: "routed", approvalId: "a-1", approvedBy: { userId: "alice" }, approverRole: APPROVER_ROLE },
      };
      expect((await mods.registry.executeTool("approval_test_plain", {}, handlerContext)).success).toBe(true);
      expect(seen).toEqual([undefined]);
    } finally {
      mods.registry.unregisterTool("approval_test_plain");
    }
  });
});

describe("what each caller sees and decides in the approval store", () => {
  it("a viewer sees nothing; an operator the channel approvals; an approver the routed ones it may decide", async () => {
    const channel = mods.approvals.createPendingApproval({ toolName: "http_request", args: { url: "https://example.test" }, timeoutMs: 60_000, sceneName: "nightly" });
    const call = chatCall("patty", EXPORT_TOOL, { record: "r11" }, mods.routed.requesterApprovalCallback(async () => true));
    const routed = await routedEntry(EXPORT_TOOL);

    expect(await pendingFor("vera")).toEqual([]);
    expect((await pendingFor("otto")).map((entry) => entry.id)).toEqual([channel.id]);
    expect((await pendingFor("alice")).map((entry) => entry.id)).toEqual([routed.id]);
    expect(await pendingFor("otto")).toEqual([expect.objectContaining({ kind: "channel", sceneName: "nightly" })]);

    // A channel approval is decided as before: an operator's session resolves it, a viewer's is refused
    // by the mutation gate, and so is an approver ranked below operator.
    expect((await decide("vera", channel.id, true)).status).toBe(403);
    expect((await decide("alice", channel.id, true)).status).toBe(403);
    expect(await decide("otto", channel.id, true)).toEqual({ status: 200, body: { ok: true, approved: true } });
    await expect(channel.promise).resolves.toBe(true);
    // An id that names nothing pending is not found, whoever asks: it changes nothing.
    for (const user of ["vera", "alice", "otto"] as const) {
      expect(await decide(user, channel.id, true)).toEqual({ status: 404, body: { error: "Approval request not found or already resolved" } });
    }

    mods.approvals.cancelPendingApproval(routed.id);
    expect((await call).success).toBe(false);
  });

  it("a routed entry granted without a signed-in approver does not run the tool", async () => {
    const call = chatCall("patty", EXPORT_TOOL, { record: "r12" }, mods.routed.requesterApprovalCallback(async () => true));
    const entry = await routedEntry(EXPORT_TOOL);
    // An in-process resolve with no decider (no path does this today) is not an approval.
    mods.approvals.resolveApproval(entry.id, true);
    expect((await call).success).toBe(false);
    expect(handled).toEqual([]);
  });
});

describe("declaring an approval policy", () => {
  let badExtensions = 0;

  it("is refused on a tool that does not ask for approval on every call, or that names no approver", async () => {
    const tiers = await import("../guardrails/tool-tiers.js");
    expect(() => tiers.registerExtensionToolTier("approval_test_bad", {
      tier: 2, description: "x", requiresPerCallApproval: false, requiresSandbox: false, approval: { approverRoles: [APPROVER_ROLE] },
    }, "approval-test")).toThrow(/requiresPerCallApproval/);
    expect(() => tiers.registerExtensionToolTier("approval_test_bad", {
      tier: 2, description: "x", requiresPerCallApproval: true, requiresSandbox: false, approval: { approverRoles: [] },
    }, "approval-test")).toThrow(/approver role/);
    expect(tiers.getToolTier(EXPORT_TOOL).approval).toEqual({ approverRoles: [APPROVER_ROLE] });
    expect(tiers.getToolTier(RELEASE_TOOL).approval).toEqual({ approverRoles: [APPROVER_ROLE], distinctApprover: true });
    expect(Object.isFrozen(tiers.getToolTier(EXPORT_TOOL).approval?.approverRoles)).toBe(true);
  });

  it.each([
    ["without requiresPerCallApproval", { approval: { approverRoles: [APPROVER_ROLE] } }],
    ["with no approver role", { requiresPerCallApproval: true, approval: { approverRoles: [] } }],
    ["with a malformed role", { requiresPerCallApproval: true, approval: { approverRoles: ["Not A Role"] } }],
    ["with a non-boolean distinctApprover", { requiresPerCallApproval: true, approval: { approverRoles: [APPROVER_ROLE], distinctApprover: "yes" } }],
  ])("the loader leaves out a tool that declares one %s, and loads the rest of its extension with its roles", async (_how, fields) => {
    // Failing the load dropped the extension's roles, and a role nobody declares signs in as
    // operator: a typo in one approval policy raised a fork's lowest role. Each case loads an
    // extension of its own, which stays loaded.
    const n = ++badExtensions;
    const name = `approval-bad-${n}`;
    const dir = join(tempDir, `extensions-bad-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "index.mjs"), "// discovery marker\n", "utf8");
    const loader = await import("../extension/loader.js");
    const tool = { description: "x", parameters: {}, tier: 3, execute: async () => ({ success: true, output: "" }) };
    loader.setExtensionImporterForTests(async () => ({
      default: {
        name,
        version: "1.0.0",
        roles: [{ name: `approval_bad_role_${n}`, description: "a fork's lowest role", rank: 10 }],
        tools: [{ name: `approval_bad_tool_${n}`, ...tool, ...fields }, { name: `approval_bad_other_${n}`, ...tool }],
      },
    }));
    process.env["SAI_EXTENSIONS_DIR"] = dir;
    try {
      expect(await loader.loadCoreExtensions()).toMatchObject({ loaded: 1, failed: 0 });
      expect(mods.registry.getTool(`approval_bad_tool_${n}`)).toBeUndefined();
      expect(mods.registry.getTool(`approval_bad_other_${n}`)).toBeDefined();
      expect(mods.auth.normalizeRole(`approval_bad_role_${n}`)).toBe(`approval_bad_role_${n}`);
    } finally {
      process.env["SAI_EXTENSIONS_DIR"] = join(tempDir, "extensions");
      loader.setExtensionImporterForTests(null);
    }
  });
});
