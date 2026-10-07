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

  async function send(message: string): Promise<Record<string, unknown>> {
    const tempDir = mkdtempSync(join(tmpdir(), "sai-rpc-directive-"));
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({ gateway: { jwtSecret: "t".repeat(32) } }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;

    const runTurnMock = vi.fn(() => new Promise(() => {}));
    vi.doMock("../agent/runtime.js", () => ({ runTurn: runTurnMock }));
    // Sequential: these modules import each other.
    const { RpcConnection } = await import("../gateway/rpc.js");
    const session = await import("../agent/session.js");

    const active = session.createSession({ channel: "webchat" });
    const connection = new RpcConnection({ readyState: 1, send() {} } as never);
    await connection.handleMessage(JSON.stringify({
      id: "req-directive",
      method: "chat.send",
      params: { sessionId: active.id, requestId: "turn-directive", message },
    }));

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
});
