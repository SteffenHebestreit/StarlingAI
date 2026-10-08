import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRODUCT } from "../product/index.js";

/**
 * Creating, applying and answering a config-assistant proposal records and returns its request
 * text as its author's (found in review, 2026-10-08).
 *
 * The proposal and its flow entries carry the author's user-scope segment, whoever applies the
 * proposal or gives it feedback, and under multi-user auth the answer to applying or to feedback
 * carries the request text only for the author or an admin: any operator may act on any proposal,
 * and the dashboard puts the answer in its list. These run against the whole gateway, with the
 * drafting model stubbed.
 */
const SUMMARY = "Prefer German legal sources in the researcher";
const ALICE_REQUEST = "Make the researcher prefer German family-law sources for my custody case";

vi.mock("../agent/config-assistant.js", () => ({
  proposeConversationConfigChange: async () => ({
    assistantAgent: "config_assistant",
    draft: { summary: SUMMARY, configChanges: [], promptChanges: [], validations: [], tags: [] },
  }),
}));

const tempDirs: string[] = [];
const ENV_KEYS = ["SAI_CONFIG_PATH", "SAI_MUTABLE_CONFIG_PATH", "SAI_MASTER_KEY", "SAI_CRED_STORE", "SAI_AUDIT_LOG", "SAI_JWT_SECRET"];

afterEach(async () => {
  const audit = await import("../audit/logger.js");
  await audit.flushAuditLog();
  (await import("../config/loader.js")).resetConfigForTests();
  (await import("../gateway/auth.js")).resetAuthStateForTests();
  for (const key of ENV_KEYS) delete process.env[key];
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The whole gateway on a config directory, multi-user auth on or off. */
async function bootGateway(authEnabled: boolean) {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-proposal-routes-"));
  tempDirs.push(tempDir);
  const configDir = join(tempDir, "config");
  mkdirSync(configDir, { recursive: true });
  const port = 33_000 + Math.floor(Math.random() * 2_000);
  writeFileSync(join(configDir, "10-test.json"), JSON.stringify({
    gateway: { port, jwtSecret: "p".repeat(40) },
    workspacePath: tempDir,
    ...(authEnabled ? { auth: { enabled: true } } : {}),
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configDir;
  process.env["SAI_MASTER_KEY"] = "m".repeat(32);
  process.env["SAI_CRED_STORE"] = join(tempDir, PRODUCT.stateDirName, "credentials.enc");
  process.env["SAI_AUDIT_LOG"] = join(tempDir, "audit.jsonl");
  vi.resetModules();
  // Sequential imports: these modules import each other, and a second load of the set in one file
  // hung when they were imported together.
  const { createGateway } = await import("../gateway/index.js");
  const auth = await import("../gateway/auth.js");
  const { safeUserSegment } = await import("../runtime/user-scope.js");
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
  const send = async (user: string, role: string, method: string, path: string, body?: unknown) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await auth.createToken(user, { role })}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, text: await response.text() };
  };
  const stored = () => ({
    proposals: JSON.parse(readFileSync(join(tempDir, PRODUCT.stateDirName, "config_assistant_proposals.json"), "utf8")) as Array<Record<string, unknown>>,
    flow: readFileSync(join(tempDir, PRODUCT.stateDirName, "flow_memory.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>),
  });
  return { send, stored, segment: safeUserSegment, stop: () => gateway.stop() };
}

describe("config-assistant proposal routes and the request's author", () => {
  it("under multi-user auth, records the author on the proposal and every flow entry, and answers another account without the request text", async () => {
    const gw = await bootGateway(true);
    try {
      const created = await gw.send("alice", "operator", "POST", "/api/config-assistant/proposals", { request: ALICE_REQUEST });
      expect(created.status).toBe(201);
      expect(created.text).toContain(ALICE_REQUEST);
      expect(created.text).not.toContain("\"account\"");
      const id = (JSON.parse(created.text) as { proposal: { id: string } }).proposal.id;

      const feedback = await gw.send("bob", "operator", "POST", `/api/config-assistant/proposals/${id}/feedback`, { outcome: "partial" });
      expect(feedback.status).toBe(200);
      expect(feedback.text).not.toContain(ALICE_REQUEST);
      expect(feedback.text).toContain(SUMMARY);

      const applied = await gw.send("bob", "operator", "POST", `/api/config-assistant/proposals/${id}/apply`);
      expect(applied.status).toBe(200);
      expect(applied.text).not.toContain(ALICE_REQUEST);
      expect(applied.text).not.toContain("\"account\"");

      const authorFeedback = await gw.send("alice", "operator", "POST", `/api/config-assistant/proposals/${id}/feedback`, { outcome: "success" });
      expect(authorFeedback.text).toContain(ALICE_REQUEST);
      const adminFeedback = await gw.send("carol", "admin", "POST", `/api/config-assistant/proposals/${id}/feedback`, { outcome: "success" });
      expect(adminFeedback.text).toContain(ALICE_REQUEST);

      const { proposals, flow } = gw.stored();
      expect(proposals[0]).toMatchObject({ request: ALICE_REQUEST, account: gw.segment("alice") });
      expect(flow.map((entry) => entry["outcome"])).toEqual(["proposed", "partial", "applied", "success", "success"]);
      for (const entry of flow) expect(entry["account"]).toBe(gw.segment("alice"));
    } finally {
      await gw.stop();
    }
  });

  it("with one operator, records no author and answers with the proposal as it is stored", async () => {
    const gw = await bootGateway(false);
    try {
      const created = await gw.send("admin", "admin", "POST", "/api/config-assistant/proposals", { request: ALICE_REQUEST });
      expect(created.status).toBe(201);
      const id = (JSON.parse(created.text) as { proposal: { id: string } }).proposal.id;
      const feedback = await gw.send("admin", "admin", "POST", `/api/config-assistant/proposals/${id}/feedback`, { outcome: "partial" });

      const { proposals, flow } = gw.stored();
      expect(proposals[0]).not.toHaveProperty("account");
      for (const entry of flow) expect(entry).not.toHaveProperty("account");
      expect(JSON.parse(feedback.text)).toEqual({ proposal: proposals[0] });
    } finally {
      await gw.stop();
    }
  });
});
