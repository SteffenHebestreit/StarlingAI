import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SubAgentRunOptions, SubAgentRunResult } from "../agent/sub-agent.js";
import { A2A_ERROR } from "../a2a/protocol.js";

/**
 * tasks/send on the public A2A surface and the account a task runs as (found in review, 2026-10-08).
 *
 * The surface accepted any unexpired signed gateway token, so under multi-user auth a deleted or
 * disabled account kept running tasks for the rest of the token's lifetime. The caller is now
 * resolved against the user store, as on /api and the legacy /a2a/agents route, and a token whose
 * account no longer resolves is refused. With one operator the token's claims stand, as before.
 *
 * Every task also ran in the shared workspace root, where a memory stored with the default
 * 'workspace' scope is the shared root's and every account reads it. A signed-in account's task now
 * runs in that account's own root and with the account on the request context, as its chat runs
 * and the legacy route's do. The shared-bearer machine caller is no account and keeps the shared root.
 */
const runs = vi.hoisted(() => [] as Array<{ userId: string | undefined; contextUserId: string | undefined; workspacePath: string }>);

vi.mock("../agent/sub-agent.js", async (importActual) => ({
  ...(await importActual<typeof import("../agent/sub-agent.js")>()),
  runSubAgentWithStats: async (opts: SubAgentRunOptions): Promise<SubAgentRunResult> => {
    // Imported at call time: the mock outlives vi.resetModules, and the request context to read
    // is the module instance the server loaded for this test.
    const { currentUserId } = await import("../runtime/request-context.js");
    runs.push({ userId: opts.userId, contextUserId: currentUserId(), workspacePath: opts.workspacePath });
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

const account = (username: string) => ({
  username, role: "operator", passwordHash: "scrypt$placeholder-hash-not-used-here", createdAt: "2026-10-08T00:00:00Z",
});

const dirs: string[] = [];

afterEach(async () => {
  runs.length = 0;
  delete process.env["SAI_CONFIG_PATH"];
  (await import("../config/loader.js")).resetConfigForTests();
  (await import("../gateway/auth.js")).resetAuthStateForTests();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

/** Load a deployment with Alice and Bob as accounts when `authEnabled`; returns its shared root. */
async function deployment(authEnabled: boolean, extra: Record<string, unknown> = {}): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "a2a-tasks-send-caller-"));
  dirs.push(dir);
  writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
    workspacePath: dir,
    gateway: { jwtSecret: "a".repeat(40) },
    ...(authEnabled ? { auth: { enabled: true, users: [account("alice"), account("bob")] } } : {}),
    a2a: { enabled: true, exposeAgents: [], ...extra },
    subAgents: { researcher: { description: "Finds sources.", systemPrompt: "Research.", maxIterations: 2 } },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
  vi.resetModules();
  return dir;
}

/** tasks/send to the researcher with `bearer`; returns the HTTP status and the JSON-RPC answer. */
async function send(bearer: string, extra: Record<string, unknown> = {}): Promise<{ status: number | undefined; answer: { result?: unknown; error?: { code: number } } }> {
  const { handleA2ARequest } = await import("../a2a/server.js");
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tasks/send",
    params: { agentId: "researcher", message: { role: "user", parts: [{ type: "text", text: "Remember that I prefer the early ferry." }] }, ...extra },
  });
  const req = Object.assign(Readable.from([Buffer.from(body)]), {
    method: "POST",
    url: "/a2a/v1",
    headers: { host: "starling.test", authorization: `Bearer ${bearer}` },
  }) as unknown as IncomingMessage;
  const captured: { status?: number; body?: string } = {};
  const res = {
    headersSent: false,
    writeHead(status: number) { captured.status = status; },
    end(text?: string) { captured.body = text; },
  };
  await handleA2ARequest(req, res as unknown as ServerResponse);
  return { status: captured.status, answer: JSON.parse(captured.body ?? "{}") as { result?: unknown; error?: { code: number } } };
}

/** A gateway token signed for `username`. */
async function tokenFor(username: string): Promise<string> {
  const auth = await import("../gateway/auth.js");
  return auth.createToken(username, { role: "operator" });
}

describe("tasks/send and the account behind its token", () => {
  it("under multi-user auth, refuses a signed token whose account is not in the user store", async () => {
    await deployment(true);

    const { status, answer } = await send(await tokenFor("mallory"));

    expect(status).toBe(401);
    expect(answer.error?.code).toBe(A2A_ERROR.UNAUTHORIZED.code);
    expect(runs).toHaveLength(0);
  });

  it("under multi-user auth, still runs a task for an account that resolves", async () => {
    await deployment(true);

    const { status, answer } = await send(await tokenFor("alice"));

    expect(status).toBe(200);
    expect(answer.error).toBeUndefined();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.userId).toBe("alice");
  });

  it("with one operator, accepts any signed token, as before", async () => {
    await deployment(false);

    const { status, answer } = await send(await tokenFor("mallory"));

    expect(status).toBe(200);
    expect(answer.error).toBeUndefined();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.userId).toBe("mallory");
  });
});

describe("tasks/send and the workspace root a task runs in", () => {
  it("under multi-user auth, runs a signed-in account's task in its own root, as that account", async () => {
    await deployment(true);

    const { status } = await send(await tokenFor("alice"));

    expect(status).toBe(200);
    const { getConfig } = await import("../config/loader.js");
    const { safeUserSegment } = await import("../runtime/user-scope.js");
    expect(runs).toEqual([{
      userId: "alice",
      contextUserId: "alice",
      workspacePath: resolve(getConfig().workspacePath, "users", safeUserSegment("alice")),
    }]);
  });

  it("under multi-user auth, keeps the shared-bearer machine caller in the shared root", async () => {
    const sharedBearer = ["peer", "bearer", "for", "tests", "only"].join("-");
    await deployment(true, { inboundBearerToken: sharedBearer });

    const { status } = await send(sharedBearer);

    expect(status).toBe(200);
    const { getConfig } = await import("../config/loader.js");
    expect(runs).toEqual([{ userId: "a2a-shared-bearer", contextUserId: undefined, workspacePath: getConfig().workspacePath }]);
  });

  it("with one operator, runs the task in the shared root with no account on the request context, as before", async () => {
    await deployment(false);

    const { status } = await send(await tokenFor("alice"));

    expect(status).toBe(200);
    const { getConfig } = await import("../config/loader.js");
    expect(runs).toEqual([{ userId: "alice", contextUserId: undefined, workspacePath: getConfig().workspacePath }]);
  });
});

describe("tasks/send and a sessionId that is not a string", () => {
  it("under multi-user auth, refuses it as invalid params and runs nothing", async () => {
    await deployment(true);

    const { status, answer } = await send(await tokenFor("bob"), { sessionId: ["ferry-plan"] });

    expect(status).toBe(200);
    expect(answer.error?.code).toBe(A2A_ERROR.INVALID_PARAMS.code);
    expect(runs).toHaveLength(0);
  });

  it("with one operator, takes it as it comes, as before", async () => {
    await deployment(false);

    const { answer } = await send(await tokenFor("bob"), { sessionId: ["ferry-plan"] });

    expect(answer.error).toBeUndefined();
    expect(runs).toHaveLength(1);
  });
});
