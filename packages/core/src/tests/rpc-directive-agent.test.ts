import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  /** chat.send with the given message, against a deployment that has the agent code_analyst. */
  async function chatSend(message: string): Promise<{ runTurnMock: ReturnType<typeof vi.fn>; events: Array<Record<string, unknown>> }> {
    const tempDir = mkdtempSync(join(tmpdir(), "sai-rpc-directive-"));
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      gateway: { jwtSecret: "t".repeat(32) },
      subAgents: { code_analyst: { description: "Analyzes source code and finds bugs.", capabilities: ["code analysis"], tags: ["code"], tools: ["read_file"] } },
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

  async function send(message: string): Promise<Record<string, unknown>> {
    const { runTurnMock } = await chatSend(message);
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
});
