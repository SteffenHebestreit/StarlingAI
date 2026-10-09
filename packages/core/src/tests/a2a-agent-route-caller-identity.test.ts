import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PRODUCT } from "../product/index.js";
import type { SubAgentRunOptions } from "../agent/sub-agent.js";

/**
 * The legacy A2A route runs a caller's task as that caller (found in review, 2026-10-08).
 *
 * POST /a2a/agents/:name ran the sub-agent with no user, after checking only that the token was
 * signed. Under multi-user auth a run with no user stores a memory the caller asked to keep as
 * their own ('user' scope) to the shared workspace instead, where every other account's Critical
 * Memory, graph inspector and graph_query read it; and a deleted account's token kept running any
 * agent here for the rest of its lifetime. The route now resolves the caller against the user store
 * and runs the task as that account, both on the run's tools (userId) and on the request context
 * the run's own memory reads take their account from. With one operator, the run is as before.
 *
 * The run also worked in the shared workspace root, where a memory stored with the default
 * 'workspace' scope is read by every account just the same; it now works in the caller's own root,
 * as the caller's chat runs do. These run against the whole gateway.
 */
const runs = vi.hoisted(() => [] as Array<{ userId: string | undefined; contextUserId: string | undefined; workspacePath: string }>);

vi.mock("../agent/sub-agent.js", async (importActual) => {
  // The request context of the module instance the gateway itself loaded (the factory runs on the
  // first import after each vi.resetModules), so the user read below is the one the route set.
  const { currentUserId } = await import("../runtime/request-context.js");
  return {
    ...(await importActual<typeof import("../agent/sub-agent.js")>()),
    runSubAgent: async (opts: SubAgentRunOptions): Promise<string> => {
      runs.push({ userId: opts.userId, contextUserId: currentUserId(), workspacePath: opts.workspacePath });
      return "The ferries leave at 07:40.";
    },
  };
});

const tempDirs: string[] = [];
const ENV_KEYS = ["SAI_CONFIG_PATH", "SAI_MASTER_KEY", "SAI_CRED_STORE", "SAI_AUDIT_LOG", "SAI_JWT_SECRET"];

const account = (username: string) => ({
  username, role: "operator", passwordHash: "scrypt$placeholder-hash-not-used-here", createdAt: "2026-10-08T00:00:00Z",
});

afterEach(async () => {
  runs.length = 0;
  const audit = await import("../audit/logger.js");
  await audit.flushAuditLog();
  (await import("../config/loader.js")).resetConfigForTests();
  (await import("../gateway/auth.js")).resetAuthStateForTests();
  for (const key of ENV_KEYS) delete process.env[key];
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

async function bootGateway(authEnabled: boolean) {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-a2a-agent-caller-"));
  tempDirs.push(tempDir);
  const configDir = join(tempDir, "config");
  mkdirSync(configDir, { recursive: true });
  const port = 39_000 + Math.floor(Math.random() * 2_000);
  writeFileSync(join(configDir, "10-test.json"), JSON.stringify({
    gateway: { port, jwtSecret: "j".repeat(40) },
    workspacePath: tempDir,
    ...(authEnabled ? { auth: { enabled: true, users: [account("alice"), account("bob")] } } : {}),
    subAgents: { researcher: { description: "Finds sources.", systemPrompt: "Research.", maxIterations: 2 } },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configDir;
  process.env["SAI_MASTER_KEY"] = "m".repeat(32);
  process.env["SAI_CRED_STORE"] = join(tempDir, PRODUCT.stateDirName, "credentials.enc");
  process.env["SAI_AUDIT_LOG"] = join(tempDir, "audit.jsonl");
  vi.resetModules();
  // Sequential imports: these modules import each other.
  const { createGateway } = await import("../gateway/index.js");
  const auth = await import("../gateway/auth.js");
  const gateway = createGateway();
  await gateway.start();
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    const healthy = await fetch(`${baseUrl}/healthz`).then((response) => response.ok, () => false);
    if (healthy) break;
    if (Date.now() > deadline) throw new Error("gateway did not start");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  /** tasks/send to the researcher with a token signed for `user`. */
  const send = async (user: string): Promise<Response> => fetch(`${baseUrl}/a2a/agents/researcher`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${await auth.createToken(user, { role: "operator" })}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tasks/send", params: { task: "Remember that I prefer the early ferry." } }),
  });
  const { workspacePath } = (await import("../config/loader.js")).getConfig();
  return { send, workspacePath, stop: () => gateway.stop() };
}

describe("the legacy A2A route and the account a task runs as", () => {
  it("under multi-user auth, runs the task as the caller, on its tools, on the request context and in its own root", async () => {
    const gw = await bootGateway(true);
    try {
      const response = await gw.send("alice");
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("07:40");
      const { safeUserSegment } = await import("../runtime/user-scope.js");
      expect(runs).toEqual([{
        userId: "alice",
        contextUserId: "alice",
        workspacePath: resolve(gw.workspacePath, "users", safeUserSegment("alice")),
      }]);
    } finally {
      await gw.stop();
    }
  }, 60_000);

  it("under multi-user auth, refuses a signed token whose account is no longer in the user store", async () => {
    const gw = await bootGateway(true);
    try {
      const response = await gw.send("mallory");
      expect(response.status).toBe(401);
      expect(runs).toHaveLength(0);
    } finally {
      await gw.stop();
    }
  }, 60_000);

  it("with one operator, runs the task with no user, as before", async () => {
    const gw = await bootGateway(false);
    try {
      const response = await gw.send("alice");
      expect(response.status).toBe(200);
      expect(runs).toEqual([{ userId: undefined, contextUserId: undefined, workspacePath: gw.workspacePath }]);
    } finally {
      await gw.stop();
    }
  }, 60_000);
});
