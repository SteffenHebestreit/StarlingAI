import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunTurnOptions, TurnOutput } from "../agent/turn-types.js";

const runTurnMock = vi.hoisted(() => vi.fn<(opts: RunTurnOptions) => Promise<TurnOutput>>());

// The turn is stubbed: what this pins is what the RPC bridge does with a progress message.
vi.mock("../agent/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent/runtime.js")>()),
  runTurn: runTurnMock,
}));

/**
 * A progress message (agent/turn-progress.ts) reaches the page that started the turn as
 * `agent.progress`, before the answer, under the id the transcript gives it: a page that reads the
 * transcript later, after a reload or from another tab, finds the same message and keeps one copy.
 */
describe("rpc chat.send and progress messages", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "starlingai-rpc-progress-"));
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({ gateway: { jwtSecret: "t".repeat(32), turnTimeoutMs: 30_000 } }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
  });

  afterEach(async () => {
    runTurnMock.mockReset();
    const [session, configLoader] = await Promise.all([import("../agent/session.js"), import("../config/loader.js")]);
    for (const active of session.getAllSessions()) session.endSession(active.id);
    configLoader.resetConfigForTests();
    delete process.env["SAI_CONFIG_PATH"];
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("sends each one live, before the final status, under its transcript id", async () => {
    const [{ RpcConnection }, session] = await Promise.all([import("../gateway/rpc.js"), import("../agent/session.js")]);
    const chat = session.createSession({ channel: "webchat" });
    const sent: Array<Record<string, unknown>> = [];
    const conn = new RpcConnection({ readyState: 1, send(p: string) { sent.push(JSON.parse(p) as Record<string, unknown>); } } as never);

    const { runWithRequestContext } = await import("../runtime/request-context.js");
    // As runTurn does: the turn runs under its chat.send request id, which every write is stamped with.
    runTurnMock.mockImplementation(async (opts) => runWithRequestContext({ chatRequestId: opts.requestId }, () => {
      opts.session.addMessage({ role: "user", content: "chart and report" });
      expect(opts.onProgressMessage).toBeTypeOf("function");
      opts.onProgressMessage!(opts.session.addProgressMessage({ kind: "plan", text: "Here's my plan:\n1. Chart" }));
      opts.session.addMessage({ role: "assistant", content: "Done." });
      return { response: "Done.", toolCallsExecuted: 0, guardrailEvents: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, blocked: false };
    }));

    await conn.handleMessage(JSON.stringify({ id: "send-1", method: "chat.send", params: { sessionId: chat.id, message: "chart and report", requestId: "req-1" } }));
    await vi.waitFor(() => expect(sent.some((event) => event["type"] === "status" && (event["data"] as Record<string, unknown>)["status"] === "ok")).toBe(true));

    const progressAt = sent.findIndex((event) => event["type"] === "agent.progress");
    const okAt = sent.findIndex((event) => event["type"] === "status" && (event["data"] as Record<string, unknown>)["status"] === "ok");
    expect(progressAt).toBeGreaterThanOrEqual(0);
    expect(progressAt).toBeLessThan(okAt);
    const data = sent[progressAt]!["data"] as Record<string, unknown>;
    expect(data).toMatchObject({ requestId: "req-1", kind: "plan", text: "Here's my plan:\n1. Chart" });

    const transcript = session.getSessionTranscript(chat.id)?.transcript ?? [];
    const kept = transcript.find((entry) => entry.progress);
    expect(kept?.id).toBe(data["id"]);
    expect(kept?.requestId).toBe("req-1");
  });
});
