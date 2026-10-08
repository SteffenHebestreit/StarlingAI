import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import * as configLoader from "../config/loader.js";
import { appendOutcome } from "../agent/outcomes.js";
import { createToken, resetAuthStateForTests } from "../gateway/auth.js";
import { registerSubAgentRoutes } from "../gateway/sub-agent-routes.js";
import { runWithRequestContext } from "../runtime/request-context.js";
import { safeUserSegment } from "../runtime/user-scope.js";

/**
 * GET /api/agents/outcomes hands no account another account's lesson text (found in review,
 * 2026-10-08).
 *
 * The route reads the deployment's outcome ledger, one file for every account, and returned each
 * agent's latest lesson to any signed-in account. A lesson is text an agent wrote on some account's
 * task, and Alice's names what her task was about. Under multi-user auth the counts still cover the
 * deployment, and the latest lesson is the caller's own.
 */
const ALICE_LESSON = "for a custody case in Hamburg, search the bar association's family-law register first";
const BOB_LESSON = "the harbour operator's site lists the ferry times";
const LEGACY_LESSON = "cite the local rent index in a tenancy complaint";

const dirs: string[] = [];

function withConfig(workspacePath: string, authEnabled: boolean): void {
  const real = configLoader.getConfig();
  vi.spyOn(configLoader, "getConfig").mockReturnValue({ ...real, workspacePath, auth: { ...real.auth, enabled: authEnabled } } as typeof real);
}

/** A deployment ledger with three runs of the researcher: Bob's, then Alice's, then one written
 *  before entries carried an account, each with its lesson. */
function seed(): string {
  const shared = mkdtempSync(join(tmpdir(), "agent-outcomes-route-"));
  dirs.push(shared);
  const run = (minute: number, lesson: string, account?: string) => appendOutcome(shared, {
    ts: `2026-10-08T12:0${minute}:00.000Z`,
    agent: "researcher",
    task: "a delegated task",
    outcome: "success",
    iterations: 3,
    totalTokens: 1200,
    lesson,
    ...(account ? { account } : {}),
  });
  run(1, BOB_LESSON, safeUserSegment("bob"));
  run(2, ALICE_LESSON, safeUserSegment("alice"));
  run(3, LEGACY_LESSON);
  return shared;
}

/** The route as the gateway serves it: every /api request runs in its user's request context. */
async function outcomesAs(userId: string | undefined): Promise<{ text: string; agents: Array<Record<string, unknown>> }> {
  const app = new Hono();
  app.use("/api/*", (_c, next) => runWithRequestContext({ userId }, () => next()));
  registerSubAgentRoutes(app);
  const token = await createToken(userId ?? "bootstrap", { role: "viewer" });
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

  it("under multi-user auth, reports the deployment's counts with the caller's own latest lesson", async () => {
    withConfig(seed(), true);

    const { text, agents } = await outcomesAs("bob");

    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ name: "researcher", calls: 3, success: 3, avgIterations: 3, latestLesson: BOB_LESSON });
    expect(text).not.toContain(ALICE_LESSON);
    expect(text).not.toContain(LEGACY_LESSON);
  });

  it("under multi-user auth with no user in the request, reports the counts without a lesson", async () => {
    withConfig(seed(), true);

    const { text, agents } = await outcomesAs(undefined);

    expect(agents[0]).toMatchObject({ name: "researcher", calls: 3 });
    expect(agents[0]).not.toHaveProperty("latestLesson");
    for (const lesson of [ALICE_LESSON, BOB_LESSON, LEGACY_LESSON]) expect(text).not.toContain(lesson);
  });

  it("with one operator, still reports each agent's latest lesson: the ledger is theirs", async () => {
    withConfig(seed(), false);

    const { agents } = await outcomesAs("bob");

    expect(agents[0]).toMatchObject({ name: "researcher", calls: 3, latestLesson: LEGACY_LESSON });
  });
});
