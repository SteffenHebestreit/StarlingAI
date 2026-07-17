import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getMissionBudgetSnapshot,
  releaseMissionBudget,
  reserveMissionBudget,
  reconcileMissionBudget,
  resetMissionBudgetForTests,
} from "../swarm/mission-budget.js";
import { getConfig } from "../config/loader.js";

// Pin the budget config for deterministic limits (schema defaults are unlimited).
vi.mock("../config/loader.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../config/loader.js")>();
  return {
    ...original,
    getConfig: vi.fn(() => ({
      ...original.getConfig(),
      mission: {
        store: "off",
        budget: {
          mode: "enforce",
          maxTotalTokens: 10_000,
          maxToolCalls: 20,
          maxActiveTimeMs: 0, // unlimited dimension
          childReserveTokens: 4_000,
          childReserveToolCalls: 8,
          childReserveActiveTimeMs: 60_000,
        },
      },
    })),
  };
});

const RESERVE = { tokens: 4_000, toolCalls: 8, activeTimeMs: 60_000 };

describe("mission budget envelope (BUD-203, local ledger)", () => {
  afterEach(async () => {
    await resetMissionBudgetForTests();
    vi.mocked(getConfig).mockClear();
  });

  it("grants reservations while the envelope fits and refuses when it would overflow", async () => {
    const first = await reserveMissionBudget("m1", RESERVE);   // 4k/10k tokens, 8/20 calls
    const second = await reserveMissionBudget("m1", RESERVE);  // 8k/10k, 16/20
    const third = await reserveMissionBudget("m1", RESERVE);   // would be 12k/10k → refuse
    expect(first.granted).toBe(true);
    expect(second.granted).toBe(true);
    expect(third.granted).toBe(false);
    if (!third.granted) expect(third.exceeded).toContain("tokens");
  });

  it("an unlimited dimension (limit 0) never refuses", async () => {
    const huge = await reserveMissionBudget("m2", { tokens: 0, toolCalls: 0, activeTimeMs: 10_000_000 });
    expect(huge.granted).toBe(true);
  });

  it("reconcile frees the reservation and records actual spend", async () => {
    const reserve = await reserveMissionBudget("m3", RESERVE);
    expect(reserve.granted).toBe(true);
    if (!reserve.granted) return;
    await reconcileMissionBudget(reserve.reservation, { tokens: 1_500, toolCalls: 3, activeTimeMs: 20_000 });
    const snapshot = await getMissionBudgetSnapshot("m3");
    expect(snapshot.reserved).toEqual({ tokens: 0, toolCalls: 0, activeTimeMs: 0 });
    expect(snapshot.spent).toEqual({ tokens: 1_500, toolCalls: 3, activeTimeMs: 20_000 });
    // Freed headroom is reusable: 1.5k spent → two more 4k reserves fit under 10k.
    expect((await reserveMissionBudget("m3", RESERVE)).granted).toBe(true);
    expect((await reserveMissionBudget("m3", RESERVE)).granted).toBe(true);
    expect((await reserveMissionBudget("m3", RESERVE)).granted).toBe(false);
  });

  it("release cancels a reservation without spending, and reconcile is idempotent", async () => {
    const reserve = await reserveMissionBudget("m4", RESERVE);
    expect(reserve.granted).toBe(true);
    if (!reserve.granted) return;
    await releaseMissionBudget(reserve.reservation);
    await releaseMissionBudget(reserve.reservation); // second resolve is a no-op
    const snapshot = await getMissionBudgetSnapshot("m4");
    expect(snapshot.reserved.tokens).toBe(0);
    expect(snapshot.spent.tokens).toBe(0);
  });

  it("budgets are per mission — one mission's exhaustion never affects another", async () => {
    await reserveMissionBudget("m5", RESERVE);
    await reserveMissionBudget("m5", RESERVE);
    expect((await reserveMissionBudget("m5", RESERVE)).granted).toBe(false);
    expect((await reserveMissionBudget("m6", RESERVE)).granted).toBe(true);
  });
});
