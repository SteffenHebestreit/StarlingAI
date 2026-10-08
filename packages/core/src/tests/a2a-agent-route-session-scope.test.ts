import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRODUCT } from "../product/index.js";
import type { SubAgentRunOptions } from "../agent/sub-agent.js";

/**
 * A caller of the legacy A2A route cannot run its task in another account's session (found in
 * review, 2026-10-08).
 *
 * POST /a2a/agents/:name took the caller's `sessionId` as the run's parent session as it came. A
 * sub-agent run reads and writes its parent's shared facts, peer messages and checkpoints, so under
 * multi-user auth a caller naming another account's session id ran inside that session. tasks/send
 * on the public A2A surface was fixed for the same hole (a2a-session-scope.test.ts); this route now
 * puts a caller-chosen id in the caller's own namespace the same way, and an id it mints is no
 * timestamp. With one operator, both as before. These run against the whole gateway.
 */
const runs = vi.hoisted(() => [] as Array<{ parentSessionId: string }>);

vi.mock("../agent/sub-agent.js", async (importActual) => ({
  ...(await importActual<typeof import("../agent/sub-agent.js")>()),
  runSubAgent: async (opts: SubAgentRunOptions): Promise<string> => {
    runs.push({ parentSessionId: opts.parentSessionId });
    return "The ferries leave at 07:40.";
  },
}));

const BOB_SESSION = "0f2c9a4e-bob-web-session";
const tempDirs: string[] = [];
const ENV_KEYS = ["SAI_CONFIG_PATH", "SAI_MASTER_KEY", "SAI_CRED_STORE", "SAI_AUDIT_LOG", "SAI_JWT_SECRET"];

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
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-a2a-agent-route-"));
  tempDirs.push(tempDir);
  const configDir = join(tempDir, "config");
  mkdirSync(configDir, { recursive: true });
  const port = 37_000 + Math.floor(Math.random() * 2_000);
  writeFileSync(join(configDir, "10-test.json"), JSON.stringify({
    gateway: { port, jwtSecret: "j".repeat(40) },
    workspacePath: tempDir,
    ...(authEnabled ? { auth: { enabled: true } } : {}),
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
  /** tasks/send to the researcher as `user`, naming `sessionId` when given; the run's parent session. */
  const send = async (user: string, sessionId?: string): Promise<string> => {
    const response = await fetch(`${baseUrl}/a2a/agents/researcher`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${await auth.createToken(user, { role: "operator" })}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tasks/send", params: { task: "When do the ferries leave?", ...(sessionId ? { sessionId } : {}) } }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("07:40");
    expect(runs).toHaveLength(1);
    return runs.splice(0)[0]!.parentSessionId;
  };
  return { send, stop: () => gateway.stop() };
}

describe("the legacy A2A route and the session a task runs in", () => {
  it("under multi-user auth, runs a caller-named session in the caller's own namespace and mints no timestamp", async () => {
    const gw = await bootGateway(true);
    try {
      const { safeUserSegment } = await import("../runtime/user-scope.js");
      const named = await gw.send("alice", BOB_SESSION);
      expect(named).not.toBe(BOB_SESSION);
      expect(named).toBe(`a2a-in:${safeUserSegment("alice")}:${BOB_SESSION}`);

      const minted = await gw.send("alice");
      expect(minted).toMatch(/^a2a:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    } finally {
      await gw.stop();
    }
  }, 60_000);

  it("with one operator, runs in the session the caller named, as before", async () => {
    const gw = await bootGateway(false);
    try {
      expect(await gw.send("alice", BOB_SESSION)).toBe(BOB_SESSION);
      expect(await gw.send("alice")).toMatch(/^a2a:\d+$/);
    } finally {
      await gw.stop();
    }
  }, 60_000);
});
