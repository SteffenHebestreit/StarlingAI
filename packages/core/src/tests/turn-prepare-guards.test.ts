import { afterEach, describe, expect, it, vi } from "vitest";

import { checkRateLimit } from "../guardrails/rate-limiter.js";
import { getBudgetGateStatus } from "../observability/cost.js";
import type { AgentSession } from "../agent/session.js";

/**
 * Pre-turn guard phases in turn-prepare.ts:
 *  - prepareRateLimit keys the limiter on the authenticated userId (so N sessions
 *    of one account share a single request budget), falling back to the session
 *    id when auth is off.
 *  - prepareCostBudget refuses the turn with a blocked TurnOutput when the cost
 *    enforcement gate reports the hard budget is reached, and is a no-op otherwise.
 */

vi.mock("../guardrails/rate-limiter.js", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 10, resetAt: new Date() })),
}));

vi.mock("../observability/cost.js", () => ({
  getBudgetGateStatus: vi.fn(() => ({ blocked: false })),
}));

const session = (id: string, userId?: string): AgentSession =>
  ({ id, userId } as unknown as AgentSession);

describe("prepareRateLimit — subject keying", () => {
  afterEach(() => vi.clearAllMocks());

  it("keys on the authenticated userId when present (shared across sessions)", async () => {
    const { prepareRateLimit } = await import("../agent/turn-prepare.js");
    await prepareRateLimit(session("sess-1", "alice"));
    await prepareRateLimit(session("sess-2", "alice"));
    const subjects = vi.mocked(checkRateLimit).mock.calls.map((c) => c[0]);
    expect(subjects).toEqual(["alice", "alice"]);
  });

  it("falls back to the session id when there is no userId (auth off)", async () => {
    const { prepareRateLimit } = await import("../agent/turn-prepare.js");
    await prepareRateLimit(session("sess-3"));
    expect(vi.mocked(checkRateLimit).mock.calls[0]![0]).toBe("sess-3");
  });
});

describe("prepareCostBudget — hard-budget gate wrapper", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns null when the gate is not blocked", async () => {
    vi.mocked(getBudgetGateStatus).mockReturnValueOnce({ blocked: false });
    const { prepareCostBudget } = await import("../agent/turn-prepare.js");
    expect(prepareCostBudget(session("s"))).toBeNull();
  });

  it("returns a blocked TurnOutput naming the scope + amounts when over budget", async () => {
    vi.mocked(getBudgetGateStatus).mockReturnValueOnce({
      blocked: true, scope: "daily", spend: 15, budget: 10, currency: "USD",
    });
    const { prepareCostBudget } = await import("../agent/turn-prepare.js");
    const out = prepareCostBudget(session("s"));
    expect(out?.blocked).toBe(true);
    expect(out?.response).toContain("daily");
    expect(out?.response).toContain("USD 15 of 10");
    expect(out?.toolCallsExecuted).toBe(0);
  });
});
