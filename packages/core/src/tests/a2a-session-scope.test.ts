import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { SubAgentRunOptions, SubAgentRunResult } from "../agent/sub-agent.js";

/**
 * An A2A caller cannot run its task in another account's session (found in review, 2026-10-08).
 *
 * tasks/send took the caller's `sessionId` as the run's parent session as it came. A sub-agent run
 * reads and writes its parent's shared facts, peer messages and checkpoints, so under multi-user
 * auth a caller naming another account's session id ran inside that session. There a
 * caller-chosen id now names a session in the caller's own namespace; the task reports the id the
 * caller sent. With one operator the id is used as it comes.
 */
const runs = vi.hoisted(() => [] as Array<{ parentSessionId: string; userId?: string }>);

vi.mock("../agent/sub-agent.js", async (importActual) => ({
  ...(await importActual<typeof import("../agent/sub-agent.js")>()),
  runSubAgentWithStats: async (opts: SubAgentRunOptions): Promise<SubAgentRunResult> => {
    runs.push({ parentSessionId: opts.parentSessionId, ...(opts.userId ? { userId: opts.userId } : {}) });
    return {
      output: "The ferries leave at 07:40.",
      stats: {
        agentName: opts.agentName, sessionId: `sub:${opts.parentSessionId}:${opts.agentName}:1`, promptChars: 0, userContentChars: 0,
        toolCount: 0, toolNames: [], iterations: 1, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        maxIterations: 5, model: "mock", capabilities: [], terminalState: "completed", outcome: "success",
      },
    };
  },
}));

const BOB_SESSION = "0f2c9a4e-bob-web-session";
const dirs: string[] = [];

afterEach(async () => {
  runs.length = 0;
  delete process.env["SAI_CONFIG_PATH"];
  (await import("../config/loader.js")).resetConfigForTests();
  (await import("../gateway/auth.js")).resetAuthStateForTests();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

/** tasks/send as Alice, naming Bob's session id; returns the task the server answered with. */
async function sendAsAlice(authEnabled: boolean): Promise<{ sessionId: string }> {
  const dir = mkdtempSync(join(tmpdir(), "a2a-session-scope-"));
  dirs.push(dir);
  writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
    workspacePath: dir,
    gateway: { jwtSecret: "a".repeat(40) },
    ...(authEnabled ? { auth: { enabled: true } } : {}),
    a2a: { enabled: true, exposeAgents: [] },
    subAgents: { researcher: { description: "Finds sources.", systemPrompt: "Research.", maxIterations: 2 } },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
  vi.resetModules();
  // Sequential imports: these modules import each other.
  const { handleA2ARequest } = await import("../a2a/server.js");
  const auth = await import("../gateway/auth.js");
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tasks/send",
    params: { agentId: "researcher", sessionId: BOB_SESSION, message: { role: "user", parts: [{ type: "text", text: "When do the ferries leave?" }] } },
  });
  const req = Object.assign(Readable.from([Buffer.from(body)]), {
    method: "POST",
    url: "/a2a/v1",
    headers: { host: "starling.test", authorization: `Bearer ${await auth.createToken("alice", { role: "operator" })}` },
  }) as unknown as import("node:http").IncomingMessage;
  const captured: { body?: string } = {};
  const res = { headersSent: false, writeHead() { /* */ }, end(text?: string) { captured.body = text; } };
  await handleA2ARequest(req, res as unknown as import("node:http").ServerResponse);
  const answer = JSON.parse(captured.body ?? "{}") as { result?: { sessionId: string }; error?: unknown };
  expect(answer.error).toBeUndefined();
  return answer.result!;
}

describe("an A2A task and the session it runs in", () => {
  it("under multi-user auth, runs a caller-named session in the caller's own namespace", async () => {
    const task = await sendAsAlice(true);

    const { safeUserSegment } = await import("../runtime/user-scope.js");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.parentSessionId).not.toBe(BOB_SESSION);
    expect(runs[0]!.parentSessionId).toBe(`a2a-in:${safeUserSegment("alice")}:${BOB_SESSION}`);
    expect(runs[0]!.userId).toBe("alice");
    expect(task.sessionId).toBe(BOB_SESSION);
  });

  it("with one operator, runs in the session the caller named, as before", async () => {
    const task = await sendAsAlice(false);

    expect(runs[0]!.parentSessionId).toBe(BOB_SESSION);
    expect(task.sessionId).toBe(BOB_SESSION);
  });
});
