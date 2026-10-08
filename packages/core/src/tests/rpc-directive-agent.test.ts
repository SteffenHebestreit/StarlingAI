import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePromotedAgents } from "../agent/promoted-agents.js";
import type { SubAgentConfig } from "../config/schema.js";

const CODE_ANALYST = { description: "Analyzes source code and finds bugs.", capabilities: ["code analysis"], tags: ["code"], tools: ["read_file"] };

/** The agents a deployment has: configured ones (code_analyst unless given) and promoted ones. */
interface Deployment {
  subAgents?: Record<string, unknown>;
  promoted?: Record<string, unknown>;
}

/**
 * chat.send hands the turn the agent `--agent NAME` named, apart from the narrowed grant
 * (RunTurnOptions.directiveAgent, 2026-10-07): the runtime forces the delegation only for a
 * named agent, not for a scene's allowed agents.
 */
describe("chat.send --agent", () => {
  afterEach(async () => {
    vi.resetModules();
    vi.unmock("../agent/runtime.js");
    delete process.env["SAI_CONFIG_PATH"];
    (await import("../config/loader.js")).resetConfigForTests();
    const session = await import("../agent/session.js");
    for (const active of session.getAllSessions()) session.endSession(active.id);
  });

  /** chat.send with the given message, against a deployment with the given agents. */
  async function chatSend(message: string, deployment: Deployment = {}): Promise<{ runTurnMock: ReturnType<typeof vi.fn>; events: Array<Record<string, unknown>> }> {
    const tempDir = mkdtempSync(join(tmpdir(), "sai-rpc-directive-"));
    // The promoted catalog lives in the deployment's workspace, so it is this test's own.
    const workspacePath = join(tempDir, "workspace");
    mkdirSync(workspacePath, { recursive: true });
    if (deployment.promoted) writePromotedAgents(workspacePath, deployment.promoted as Record<string, SubAgentConfig>);
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      gateway: { jwtSecret: "t".repeat(32) },
      workspacePath,
      subAgents: deployment.subAgents ?? { code_analyst: CODE_ANALYST },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    // The previous test's cleanup imported the config loader again with no config path set, and the
    // loader resolves its source once, when it loads: without a fresh registry this test's agents
    // would not be read.
    vi.resetModules();

    const runTurnMock = vi.fn(() => new Promise(() => {}));
    vi.doMock("../agent/runtime.js", () => ({ runTurn: runTurnMock }));
    // Sequential: these modules import each other.
    const { RpcConnection } = await import("../gateway/rpc.js");
    const session = await import("../agent/session.js");

    const active = session.createSession({ channel: "webchat" });
    const sent: string[] = [];
    const connection = new RpcConnection({ readyState: 1, send(data: string) { sent.push(String(data)); } } as never);
    await connection.handleMessage(JSON.stringify({
      id: "req-directive",
      method: "chat.send",
      params: { sessionId: active.id, requestId: "turn-directive", message },
    }));
    return { runTurnMock, events: sent.map((data) => JSON.parse(data) as Record<string, unknown>) };
  }

  async function send(message: string, deployment: Deployment = {}): Promise<Record<string, unknown>> {
    const { runTurnMock } = await chatSend(message, deployment);
    expect(runTurnMock).toHaveBeenCalledTimes(1);
    return (runTurnMock.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]![0];
  }

  it("passes the named agent as the turn's directive and as its only allowed agent", async () => {
    const options = await send("Why does invoices.py undercharge? --agent code_analyst");
    expect(options).toMatchObject({
      userMessage: "Why does invoices.py undercharge?",
      allowedAgents: ["code_analyst"],
      directiveAgent: "code_analyst",
    });
  });

  it("names no directive when the message names no agent", async () => {
    const options = await send("Why does invoices.py undercharge?");
    expect(options).not.toHaveProperty("directiveAgent");
  });

  it("refuses a name that names no agent, saying so, instead of starting the turn", async () => {
    // The name was taken as typed: a typo was forced and dispatched, no agent of that name could
    // be routed to, and an architect-built ephemeral agent answered in its place, unannounced
    // (review of 0b5089e/a3773aa, 2026-10-08).
    const { runTurnMock, events } = await chatSend("Why does invoices.py undercharge? --agent code_analist");

    expect(runTurnMock).not.toHaveBeenCalled();
    const statuses = events.filter((event) => event["type"] === "status").map((event) => event["data"] as Record<string, unknown>);
    expect(statuses.map((status) => status["status"])).toEqual(["blocked"]);
    expect(String(statuses[0]!["response"])).toContain("code_analist");
  });

  it("accepts the name of a promoted agent", async () => {
    // An ephemeral agent that proved itself is promoted into the deployment's catalog, beside the
    // configured ones, and routing reads it from there (agent/promoted-agents.ts).
    const options = await send("Prüfe die Rechnungen auf Rundungsfehler. --agent invoice_auditor", {
      promoted: { invoice_auditor: { description: "Audits invoices for rounding errors.", capabilities: ["invoice audit"], tags: ["finance"], tools: ["read_file"] } },
    });
    expect(options).toMatchObject({ allowedAgents: ["invoice_auditor"], directiveAgent: "invoice_auditor" });
  });

  it("refuses no name while the deployment has no agents to check it against", async () => {
    // The rule delegate_to_agent applies to the names it is given: an empty catalog validates none.
    const options = await send("Why does invoices.py undercharge? --agent code_analyst", { subAgents: {} });
    expect(options).toMatchObject({ allowedAgents: ["code_analyst"], directiveAgent: "code_analyst" });
  });
});
