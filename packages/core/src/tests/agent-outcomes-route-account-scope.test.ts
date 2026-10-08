import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import * as configLoader from "../config/loader.js";
import { appendOutcome } from "../agent/outcomes.js";
import { createToken, resetAuthStateForTests } from "../gateway/auth.js";
import { registerSubAgentRoutes } from "../gateway/sub-agent-routes.js";

/**
 * GET /api/agents/outcomes hands no account another account's lesson text (found in review,
 * 2026-10-08).
 *
 * The route reads the deployment's outcome ledger, one file for every account, and returned each
 * agent's latest lesson to any signed-in account. A lesson is text an agent wrote on some account's
 * task, and this one names what Alice's task was about.
 */
const ALICE_LESSON = "for a custody case in Hamburg, search the bar association's family-law register first";

const dirs: string[] = [];

function withConfig(workspacePath: string, authEnabled: boolean): void {
  const real = configLoader.getConfig();
  vi.spyOn(configLoader, "getConfig").mockReturnValue({ ...real, workspacePath, auth: { ...real.auth, enabled: authEnabled } } as typeof real);
}

/** A deployment root whose ledger holds the researcher's run on Alice's task, with its lesson. */
function seed(): string {
  const shared = mkdtempSync(join(tmpdir(), "agent-outcomes-route-"));
  dirs.push(shared);
  appendOutcome(shared, {
    ts: new Date().toISOString(),
    agent: "researcher",
    task: "find a divorce lawyer in Hamburg for my custody case",
    outcome: "success",
    iterations: 3,
    totalTokens: 1200,
    lesson: ALICE_LESSON,
  });
  return shared;
}

async function outcomesAsBob(): Promise<{ text: string; agents: Array<Record<string, unknown>> }> {
  const app = new Hono();
  registerSubAgentRoutes(app);
  const token = await createToken("bob", { role: "viewer" });
  const response = await app.request("/api/agents/outcomes", { headers: { Authorization: `Bearer ${token}` } });
  expect(response.status).toBe(200);
  const text = await response.text();
  return { text, agents: (JSON.parse(text) as { agents: Array<Record<string, unknown>> }).agents };
}

describe("GET /api/agents/outcomes and the deployment's agent ledger", () => {
  beforeAll(() => {
    // A signing key of the test's own, so no token touches the operator's stored one.
    process.env["SAI_JWT_SECRET"] = "outcomes-route-test-".repeat(3);
    resetAuthStateForTests();
  });
  afterAll(() => {
    delete process.env["SAI_JWT_SECRET"];
    resetAuthStateForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("under multi-user auth, reports each agent's counts without another account's lesson", async () => {
    withConfig(seed(), true);

    const { text, agents } = await outcomesAsBob();

    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ name: "researcher", calls: 1, success: 1, avgIterations: 3 });
    expect(agents[0]).not.toHaveProperty("latestLesson");
    expect(text).not.toContain("custody");
  });

  it("with one operator, still reports each agent's latest lesson: the ledger is theirs", async () => {
    withConfig(seed(), false);

    const { agents } = await outcomesAsBob();

    expect(agents[0]).toMatchObject({ name: "researcher", latestLesson: ALICE_LESSON });
  });
});
