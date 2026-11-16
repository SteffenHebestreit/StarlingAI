import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunTurnOptions, TurnOutput } from "../agent/turn-types.js";
import type { AuthenticatedUser } from "../gateway/auth.js";
import type { ToolContext, ToolResult } from "../tools/registry.js";

const runTurnMock = vi.hoisted(() => vi.fn<(opts: RunTurnOptions) => Promise<TurnOutput>>());
/** The role the account store holds now for a signed-in caller, where a test changed it. */
const liveRoles = vi.hoisted(() => new Map<string, string>());

// The turn is stubbed: what these pin is the chat socket's side of an approval policy.
vi.mock("../agent/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent/runtime.js")>()),
  runTurn: runTurnMock,
}));

// A connection checks its caller against the store before every message; here the store's answer
// is the role a test set, else the caller as it was.
vi.mock("../gateway/auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/auth.js")>();
  return {
    ...actual,
    revalidateAuthenticatedUser: (user: AuthenticatedUser) => {
      const role = liveRoles.get(user.username);
      return role ? { ...user, role } : actual.revalidateAuthenticatedUser(user);
    },
  };
});

/**
 * Approver roles over the dashboard's WebSocket (guardrails/tool-tiers.ts ToolApprovalPolicy).
 *
 * chat.send's approval card is the one callback an approval policy accepts, and only for the
 * person who sent the message, in a chat of their own, with a role the policy admits when the call
 * is made and when the card is answered. Who asks is that person (RunTurnOptions.sender), not the
 * session's owner and the role it was created with: an admin may drive another account's chat, and
 * a role can change after the chat was created. A call the policy routes to its approvers is
 * announced to the requester as agent.approval_pending, with nothing to answer, and settled with
 * agent.approval_resolved; the requester's own approval.respond cannot decide it, and the wait holds
 * the chat's watchdog. The approvers' notification reaches only the connections whose role the
 * policy admits.
 */
const CARD_TOOL = "rpc_policy_card";
const ROUTED_TOOL = "rpc_policy_routed";
const DOCTOR_TOOL = "rpc_policy_doctor";
const SECOND_PERSON_TOOL = "rpc_policy_second_person";

describe("approval policies over the chat socket", () => {
  let tempDir: string;
  const handled: Array<{ tool: string; approval: ToolContext["approval"] }> = [];

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "starlingai-rpc-routed-approvals-"));
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      gateway: { jwtSecret: "t".repeat(32), turnTimeoutMs: 30_000 },
      approvals: { routedTimeoutMs: 600_000 },
      workspacePath: tempDir,
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    const [tiers, registry] = await Promise.all([import("../guardrails/tool-tiers.js"), import("../tools/registry.js")]);
    const execute = (tool: string) => async (_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
      handled.push({ tool, approval: ctx.approval });
      return { success: true, output: `${tool} done` };
    };
    // An operator may grant the first; only an admin the second, so an operator's call is routed;
    // only a doctor (a role no rank admits) the third; and an operator other than the requester the
    // fourth.
    const policies = [
      [CARD_TOOL, { approverRoles: ["operator"] }],
      [ROUTED_TOOL, { approverRoles: ["admin"] }],
      [DOCTOR_TOOL, { approverRoles: ["doctor"] }],
      [SECOND_PERSON_TOOL, { approverRoles: ["operator"], distinctApprover: true }],
    ] as const;
    for (const [name, approval] of policies) {
      tiers.registerExtensionToolTier(name, {
        tier: 3, description: name, requiresPerCallApproval: true, requiresSandbox: false,
        approval: { ...approval, approverRoles: [...approval.approverRoles] },
      }, "rpc-approval-test");
      registry.registerTool({ name, description: name, parameters: { type: "object", properties: {} }, execute: execute(name) });
    }
  });

  afterEach(async () => {
    vi.useRealTimers();
    runTurnMock.mockReset();
    liveRoles.clear();
    handled.length = 0;
    const [session, approvals, configLoader, tiers, registry, notifications] = await Promise.all([
      import("../agent/session.js"),
      import("../approval/store.js"),
      import("../config/loader.js"),
      import("../guardrails/tool-tiers.js"),
      import("../tools/registry.js"),
      import("../runtime/notifications.js"),
    ]);
    for (const entry of approvals.listPendingApprovals()) approvals.cancelPendingApproval(entry.id);
    for (const active of session.getAllSessions()) session.endSession(active.id);
    for (const tool of [CARD_TOOL, ROUTED_TOOL, DOCTOR_TOOL, SECOND_PERSON_TOOL]) registry.unregisterTool(tool);
    tiers._resetExtensionToolTiersForTests();
    notifications.resetNotificationsForTests();
    configLoader.resetConfigForTests();
    delete process.env["SAI_CONFIG_PATH"];
    rmSync(tempDir, { recursive: true, force: true });
    vi.resetModules();
  });

  type Sent = Array<Record<string, unknown>>;
  function mockWs(): { readyState: number; send(p: string): void; close(): void; sent: Sent } {
    const sent: Sent = [];
    return { readyState: 1, send(p: string) { sent.push(JSON.parse(p) as Record<string, unknown>); }, close() {}, sent };
  }

  const turnOutput = (): TurnOutput => ({
    response: "Done.",
    toolCallsExecuted: 1,
    guardrailEvents: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    blocked: false,
  });

  async function setup() {
    const [{ RpcConnection }, session, registry, approvals, routed, requestContext] = await Promise.all([
      import("../gateway/rpc.js"),
      import("../agent/session.js"),
      import("../tools/registry.js"),
      import("../approval/store.js"),
      import("../approval/routed.js"),
      import("../runtime/request-context.js"),
    ]);
    const connect = (userId: string, role: string, liveUser?: AuthenticatedUser) => {
      const ws = mockWs();
      const conn = new RpcConnection(ws as never, userId, role, liveUser);
      let n = 0;
      const call = async (method: string, params: Record<string, unknown>) => {
        const id = `${method}-${n++}`;
        await conn.handleMessage(JSON.stringify({ id, method, params }));
        return ws.sent.find((event) => event["type"] === "rpc.response" && event["id"] === id) as { ok: boolean; payload?: Record<string, unknown>; error?: string };
      };
      const eventsOf = (type: string) => ws.sent.filter((event) => event["type"] === type).map((event) => event["data"] as Record<string, unknown>);
      return { conn, call, eventsOf };
    };
    /**
     * The turn, stubbed: one call of `tool`, with the ToolContext runtime.ts builds from the session
     * (its owner and the role it was created with) and inside the request context runTurn sets up
     * from these options (the listener and the sender).
     */
    const turnCalling = (tool: string, results: ToolResult[]) => {
      runTurnMock.mockImplementationOnce(async (opts) => {
        const chat = opts.session;
        const context: ToolContext = {
          sessionId: chat.id,
          workspacePath: tempDir,
          userId: chat.userId,
          identity: chat.identity(),
          userRole: chat.userRole,
          approvalCallback: opts.autoApprove ? async () => true : opts.approvalCallback,
          autoApprove: opts.autoApprove,
          ...(opts.signal ? { signal: opts.signal } : {}),
        };
        results.push(await requestContext.runWithRequestContext({
          ...(requestContext.currentRequestContext() ?? {}),
          ...(opts.onApprovalPending ? { onApprovalPending: opts.onApprovalPending } : {}),
          ...(opts.sender ? { sender: opts.sender } : {}),
        }, () => registry.executeTool(tool, { record: "r1" }, context)));
        return turnOutput();
      });
    };
    /** The one routed entry waiting for `tool`, as the store holds it. */
    const routedEntry = async (tool: string) => {
      await vi.waitFor(() => expect(approvals.listPendingApprovals().some((entry) => entry.toolName === tool)).toBe(true));
      return approvals.getPendingApproval(approvals.listPendingApprovals().find((entry) => entry.toolName === tool)!.id)!;
    };
    return { session, approvals, routed, connect, turnCalling, routedEntry };
  }

  it("a requester the policy admits answers on the approval card chat.send gives the turn", async () => {
    const { session, connect, turnCalling } = await setup();
    const chat = session.createSession({ channel: "webchat", userId: "olga", userRole: "operator" });
    const olga = connect("olga", "operator");
    const results: ToolResult[] = [];
    turnCalling(CARD_TOOL, results);

    await olga.call("chat.send", { sessionId: chat.id, message: "export r1", requestId: "req-card" });
    await vi.waitFor(() => expect(olga.eventsOf("agent.approval_needed")).toHaveLength(1));
    const needed = olga.eventsOf("agent.approval_needed")[0]!;
    expect(needed).toMatchObject({ requestId: "req-card", toolName: CARD_TOOL });
    expect(olga.eventsOf("agent.approval_pending")).toEqual([]);

    await olga.call("approval.respond", { approvalId: needed["approvalId"], approved: true });
    await vi.waitFor(() => expect(results).toHaveLength(1));
    expect(results[0]?.success).toBe(true);
    expect(handled).toEqual([{ tool: CARD_TOOL, approval: { via: "requester", approvedBy: expect.objectContaining({ userId: "olga" }), approverRole: "operator" } }]);
  });

  it("a call routed to its approvers is announced to the requester, who cannot answer it, and settled when an approver decides", async () => {
    const { session, approvals, connect, turnCalling } = await setup();
    const chat = session.createSession({ channel: "webchat", userId: "olga", userRole: "operator" });
    const olga = connect("olga", "operator");
    const root = connect("root", "admin");
    await olga.call("notifications.subscribe", {});
    await root.call("notifications.subscribe", {});
    const results: ToolResult[] = [];
    turnCalling(ROUTED_TOOL, results);

    await olga.call("chat.send", { sessionId: chat.id, message: "release r1", requestId: "req-routed" });
    await vi.waitFor(() => expect(olga.eventsOf("agent.approval_pending")).toHaveLength(1));
    const pending = olga.eventsOf("agent.approval_pending")[0]!;
    expect(pending).toMatchObject({ requestId: "req-routed", toolName: ROUTED_TOOL, approverRoles: ["admin"], distinctApprover: false });
    expect(typeof pending["expiresAt"]).toBe("string");
    // No approval card: there is nothing for the requester to answer.
    expect(olga.eventsOf("agent.approval_needed")).toEqual([]);

    // The approvers are told; the requester's role is not one of them.
    expect(root.eventsOf("notification.event")).toEqual([expect.objectContaining({ category: "approval" })]);
    expect(root.eventsOf("notification.event")[0]).not.toHaveProperty("audienceRoles");
    expect(olga.eventsOf("notification.event")).toEqual([]);

    // The requester's own socket answer changes nothing.
    await olga.call("approval.respond", { approvalId: pending["approvalId"], approved: true });
    expect(approvals.getPendingApproval(String(pending["approvalId"]))).toBeDefined();
    expect(results).toEqual([]);

    expect(approvals.resolveApproval(String(pending["approvalId"]), true, { role: "admin", identity: { userId: "root" } })).toBe(true);
    await vi.waitFor(() => expect(results).toHaveLength(1));
    expect(results[0]?.success).toBe(true);
    expect(handled).toEqual([{ tool: ROUTED_TOOL, approval: { via: "routed", approvalId: pending["approvalId"], approvedBy: { userId: "root" }, approverRole: "admin" } }]);
    expect(olga.eventsOf("agent.approval_resolved")).toEqual([{ requestId: "req-routed", approvalId: pending["approvalId"], outcome: "approved" }]);
  });

  it("an admin driving another account's chat asks as themselves: routed, never on their card, and credited to whoever decides", async () => {
    const { session, routed, connect, turnCalling, routedEntry } = await setup();
    // Bob's chat, created while he was a doctor; the admin drives it (session access lets them).
    const chat = session.createSession({ channel: "webchat", userId: "bob", userRole: "doctor" });
    const root = connect("root", "admin");
    const results: ToolResult[] = [];
    turnCalling(DOCTOR_TOOL, results);

    await root.call("chat.send", { sessionId: chat.id, message: "export r1", requestId: "req-admin" });
    const entry = await routedEntry(DOCTOR_TOOL);
    // The admin is the one who asked, with their own role, which a doctor policy does not admit.
    expect(entry).toMatchObject({ requester: { userId: "root" }, requesterRole: "admin" });
    expect(root.eventsOf("agent.approval_needed")).toEqual([]);
    expect(root.eventsOf("agent.approval_pending")).toEqual([expect.objectContaining({ approvalId: entry.id, approverRoles: ["doctor"] })]);
    expect(routed.decideRoutedApproval(entry.id, true, { identity: { userId: "root" }, role: "admin" }))
      .toEqual({ outcome: "refused", reason: "not_approver", approverRoles: ["doctor"] });

    expect(routed.decideRoutedApproval(entry.id, true, { identity: { userId: "dora" }, role: "doctor" })).toEqual({ outcome: "decided" });
    await vi.waitFor(() => expect(results).toHaveLength(1));
    expect(results[0]?.success).toBe(true);
    // The approval is the doctor's who gave it, never the chat's owner.
    expect(handled).toEqual([{ tool: DOCTOR_TOOL, approval: { via: "routed", approvalId: entry.id, approvedBy: { userId: "dora" }, approverRole: "doctor" } }]);
  });

  it.each([
    ["in the chat", "release r1"],
    ["with --auto", "release r1 --auto"],
  ])("with a second person required, an admin who asks %s of another account cannot be that second person", async (_how, message) => {
    const { session, approvals, routed, connect, turnCalling, routedEntry } = await setup();
    const chat = session.createSession({ channel: "webchat", userId: "olga", userRole: "operator" });
    const root = connect("root", "admin");
    const results: ToolResult[] = [];
    turnCalling(SECOND_PERSON_TOOL, results);

    await root.call("chat.send", { sessionId: chat.id, message, requestId: "req-second" });
    const entry = await routedEntry(SECOND_PERSON_TOOL);
    expect(entry).toMatchObject({ requester: { userId: "root" }, requesterRole: "admin", distinctApprover: true });
    // Not listed to the admin who asked, and refused when they answer it anyway.
    expect(approvals.listPendingApprovals({ identity: { userId: "root" }, role: "admin", operatorRank: true })).toEqual([]);
    expect(routed.decideRoutedApproval(entry.id, true, { identity: { userId: "root" }, role: "admin" }))
      .toEqual({ outcome: "refused", reason: "requester", approverRoles: ["operator"] });
    expect(results).toEqual([]);

    // Another person the policy admits decides it.
    expect(routed.decideRoutedApproval(entry.id, true, { identity: { userId: "otto" }, role: "operator" })).toEqual({ outcome: "decided" });
    await vi.waitFor(() => expect(results).toHaveLength(1));
    expect(handled[0]?.approval).toMatchObject({ via: "routed", approvedBy: { userId: "otto" }, approverRole: "operator" });
  });

  it("the role the sender holds now decides, not the one their chat was created with", async () => {
    const { session, connect, turnCalling, routedEntry, approvals } = await setup();
    // Bob's chat was created while he was a doctor; he is a viewer now.
    const demoted = session.createSession({ channel: "webchat", userId: "bob", userRole: "doctor" });
    const bob = connect("bob", "viewer");
    const routedResults: ToolResult[] = [];
    turnCalling(DOCTOR_TOOL, routedResults);
    await bob.call("chat.send", { sessionId: demoted.id, message: "export r1", requestId: "req-demoted" });
    const entry = await routedEntry(DOCTOR_TOOL);
    expect(entry).toMatchObject({ requester: { userId: "bob" }, requesterRole: "viewer" });
    expect(bob.eventsOf("agent.approval_needed")).toEqual([]);
    approvals.cancelPendingApproval(entry.id);
    await vi.waitFor(() => expect(routedResults).toHaveLength(1));
    expect(routedResults[0]?.success).toBe(false);

    // Created while he was a viewer; he is a doctor now, and approves on his own card.
    const promoted = session.createSession({ channel: "webchat", userId: "bob", userRole: "viewer" });
    const doctorBob = connect("bob", "doctor");
    const cardResults: ToolResult[] = [];
    turnCalling(DOCTOR_TOOL, cardResults);
    await doctorBob.call("chat.send", { sessionId: promoted.id, message: "export r1", requestId: "req-promoted" });
    await vi.waitFor(() => expect(doctorBob.eventsOf("agent.approval_needed")).toHaveLength(1));
    await doctorBob.call("approval.respond", { approvalId: doctorBob.eventsOf("agent.approval_needed")[0]!["approvalId"], approved: true });
    await vi.waitFor(() => expect(cardResults).toHaveLength(1));
    expect(cardResults[0]?.success).toBe(true);
    expect(handled).toEqual([{ tool: DOCTOR_TOOL, approval: { via: "requester", approvedBy: { userId: "bob" }, approverRole: "doctor" } }]);
  });

  it("a requester who loses the approver role while their card is open does not grant the call", async () => {
    const { session, connect, turnCalling } = await setup();
    const bobUser: AuthenticatedUser = { username: "bob", role: "doctor", account: "acct-bob" };
    const chat = session.createSession({ channel: "webchat", userId: "bob", account: "acct-bob", userRole: "doctor" });
    const bob = connect("bob", "doctor", bobUser);
    const results: ToolResult[] = [];
    turnCalling(DOCTOR_TOOL, results);

    await bob.call("chat.send", { sessionId: chat.id, message: "export r1", requestId: "req-live" });
    await vi.waitFor(() => expect(bob.eventsOf("agent.approval_needed")).toHaveLength(1));
    // Demoted in the account store while the card is open; the socket reads it before each message.
    liveRoles.set("bob", "viewer");
    await bob.call("approval.respond", { approvalId: bob.eventsOf("agent.approval_needed")[0]!["approvalId"], approved: true });
    await vi.waitFor(() => expect(results).toHaveLength(1));
    expect(results[0]).toMatchObject({ success: false, error: "Tool 'rpc_policy_doctor' was not run: the person who approved it no longer holds doctor" });
    expect(handled).toEqual([]);
  });

  it("a routed wait holds the chat's watchdog, so approvals.routedTimeoutMs bounds it and not the turn's budget", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { session, approvals, connect, turnCalling, routedEntry } = await setup();
    const chat = session.createSession({ channel: "webchat", userId: "olga", userRole: "operator" });
    const olga = connect("olga", "operator");
    const results: ToolResult[] = [];
    turnCalling(ROUTED_TOOL, results);

    await olga.call("chat.send", { sessionId: chat.id, message: "release r1", requestId: "req-clock" });
    const entry = await routedEntry(ROUTED_TOOL);
    const pending = olga.eventsOf("agent.approval_pending")[0]!;
    expect(Date.parse(String(pending["expiresAt"])) - Date.now()).toBeGreaterThan(590_000);
    // Well past the watchdog (30 s turn + 65 s synthesis grace): still waiting for an admin.
    await vi.advanceTimersByTimeAsync(300_000);
    expect(approvals.getPendingApproval(entry.id)).toBeDefined();
    expect(olga.eventsOf("agent.approval_resolved")).toEqual([]);
    expect(results).toEqual([]);

    expect(approvals.resolveApproval(entry.id, true, { role: "admin", identity: { userId: "root" } })).toBe(true);
    await vi.waitFor(() => expect(results).toHaveLength(1));
    expect(results[0]?.success).toBe(true);
    expect(olga.eventsOf("agent.approval_resolved")).toEqual([{ requestId: "req-clock", approvalId: entry.id, outcome: "approved" }]);
  });
});
