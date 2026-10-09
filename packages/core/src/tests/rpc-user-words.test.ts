import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunTurnOptions, TurnOutput } from "../agent/turn-types.js";

const runTurnMock = vi.hoisted(() => vi.fn<(opts: RunTurnOptions) => Promise<TurnOutput>>());

// The turn is stubbed: what these pin is what the gateway hands it as the words the person typed.
vi.mock("../agent/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent/runtime.js")>()),
  runTurn: runTurnMock,
}));

/**
 * THE WORDS A PERSON TYPED, AS THE WEB CHAT SENDS THEM WITH AN ATTACHMENT.
 *
 * The bubble text is "📎 <files>", a line break, and the typed text. The gateway takes the inline
 * flags (--auto, --effort, …) out of it as it does out of the message, and the flag's pattern also
 * took the whitespace in front of the flag: a flag typed first took the line break, the typed words
 * joined the attachment line, and the turn was handed no words at all.
 */
describe("rpc chat.send — the person's typed words on an attachment turn", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "starlingai-rpc-user-words-"));
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
    vi.resetModules();
  });

  /** Sends one chat message from the web chat and returns the options the turn was started with. */
  async function send(params: { message: string; displayContent: string }): Promise<RunTurnOptions> {
    const [{ RpcConnection }, session] = await Promise.all([import("../gateway/rpc.js"), import("../agent/session.js")]);
    const chat = session.createSession({ channel: "webchat", userId: "alice" });
    runTurnMock.mockResolvedValue({
      response: "Done.",
      toolCallsExecuted: 0,
      guardrailEvents: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      blocked: false,
    });
    const connection = new RpcConnection({ readyState: 1, send: () => {} } as never, "alice", "operator");
    await connection.handleMessage(JSON.stringify({ id: "send-1", method: "chat.send", params: { sessionId: chat.id, requestId: "req-1", ...params } }));
    await vi.waitFor(() => expect(runTurnMock).toHaveBeenCalledTimes(1));
    return runTurnMock.mock.calls[0]![0];
  }

  it("keeps the typed words when a flag opens them under a document", async () => {
    const typed = "Erstelle daraus eine Präsentation mit zehn Folien";
    const opts = await send({ message: `--auto ${typed}`, displayContent: `📎 notes.md\n--auto ${typed}` });
    expect(opts.autoApprove).toBe(true);
    expect(opts.userWords).toBe(typed);
  });

  it("keeps the typed words when a flag opens them under a picture", async () => {
    const typed = "Was bedeutet das Schild für mich als Radfahrer?";
    const analysis = "Image analysis (schild.jpg):\n\nThe image shows a blue road sign with a white bicycle on it.";
    const opts = await send({ message: `${analysis}\n\n--effort high ${typed}`, displayContent: `📎 schild.jpg\n--effort high ${typed}` });
    expect(opts.effortTier).toBe("high");
    expect(opts.userWords).toBe(typed);
  });

  it("takes a flag out of the typed words wherever it stands", async () => {
    const opts = await send({
      message: "Erstelle daraus --auto zehn Folien\n--timeout 600",
      displayContent: "📎 notes.md\nErstelle daraus --auto zehn Folien\n--timeout 600",
    });
    expect(opts.userWords).toBe("Erstelle daraus zehn Folien");
  });
});
