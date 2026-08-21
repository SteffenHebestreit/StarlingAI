import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_SYNTHESIS_RESERVE_FRACTION,
  SUB_AGENT_MIN_DELEGATION_MS,
  resolveDelegationCeilingMs,
  resolveDelegationDeadlineMs,
  resolveSoftDeadlineOffsetMs,
  resolveTimeRemainingMs,
  resolveTurnBudgetMs,
} from "../agent/sub-agent-turn-budget.js";
import type { SubAgentRunOptions, SubAgentRunResult } from "../agent/sub-agent.js";

/**
 * Defect 3 of run 3959f3ac: a sub-agent ate the whole parent turn.
 *
 * Measured, and used as the fixture throughout this file:
 *   1,800,000 ms  gateway turn budget (config/gateway/10-gateway.jsonc turnTimeoutMs)
 *     180,000 ms  the orchestrator's own work before it delegated
 *   1,500,000 ms  backend_coder's declared turnTimeoutMs (workspace/agents/10-core-agents.jsonc)
 *   1,615,806 ms  what it ACTUALLY ran — 90% of the turn. The extra 115,806 ms past its own
 *                 deadline is salvage + timeout synthesis + artifact collection, which happen
 *                 outside the child's budget and inside the parent's.
 * The orchestrator was left ~3 min, was cut mid-synthesis (finishReason "aborted_synthesized",
 * turn_timeout_recovered{recoveredAssistantText:false}), and the five files the child had written
 * were never delivered.
 */
const TURN_MS = 1_800_000;
const SPENT_BEFORE_DELEGATING_MS = 180_000;
const REMAINING_AT_DELEGATION_MS = TURN_MS - SPENT_BEFORE_DELEGATING_MS; // 1,620,000
const AGENT_DECLARED_MS = 1_500_000;
const OBSERVED_RUN_MS = 1_615_806;
const OBSERVED_OVERSHOOT_MS = OBSERVED_RUN_MS - AGENT_DECLARED_MS; // 115,806
const RESERVE_MS = 240_000; // config/gateway/40-orchestration.jsonc — derivation is in that file

/** What the runner (agent/sub-agent.ts) resolves from the ceiling this module hands down. */
const armedBudget = (ceilingMs: number | undefined): number | undefined =>
  resolveTurnBudgetMs({ callerCeilingMs: ceilingMs, agentTurnTimeout: AGENT_DECLARED_MS });

describe("resolveDelegationCeilingMs — a child may not outlive the parent's remaining budget", () => {
  it("keeps the audited run inside its turn (and the old static carve-out does NOT)", () => {
    const now = 1_000_000_000_000;
    const ceiling = resolveDelegationCeilingMs({
      callerBudgetMs: TURN_MS, // gateway/rpc.ts passes the WHOLE turn budget on every turn
      parentDeadlineMs: now + REMAINING_AT_DELEGATION_MS,
      nowMs: now,
      synthesisReserveMs: RESERVE_MS,
    });
    expect(ceiling).toBe(REMAINING_AT_DELEGATION_MS - RESERVE_MS); // 1,380,000
    expect(armedBudget(ceiling)).toBe(1_380_000);

    // THE defect: the child must not be able to run what it ran.
    expect(armedBudget(ceiling)!).toBeLessThan(OBSERVED_RUN_MS);

    // ...and the parent must keep enough to finish, in the WORST case where the child also
    // overshoots its own deadline by the measured 115,806 ms. One completion (124,293 ms) is what
    // the parent needs to synthesise, and one completion is what it keeps — which is why the
    // reserve is 240,000 (overshoot + completion) and not the 120,000 a "one completion" reading
    // of it would give: that would leave the parent 4,194 ms, and a reserve that cannot survive
    // the failure mode it was measured from is not a reserve.
    const parentHeadroomMs =
      TURN_MS - SPENT_BEFORE_DELEGATING_MS - armedBudget(ceiling)! - OBSERVED_OVERSHOOT_MS;
    expect(parentHeadroomMs).toBe(124_194);
    expect(parentHeadroomMs).toBeGreaterThan(SUB_AGENT_MIN_DELEGATION_MS);
    expect(TURN_MS - SPENT_BEFORE_DELEGATING_MS - 1_500_000 - OBSERVED_OVERSHOOT_MS)
      .toBeLessThan(SUB_AGENT_MIN_DELEGATION_MS); // what a 120,000 reserve would have left

    // DISCRIMINATOR 1 — the same reserve subtracted from the STATIC budget (what the code did
    // before) leaves the parent less than one model completion (124,293 ms), which is why this had
    // to become parent-RELATIVE rather than just "turn on the existing reserve knob".
    const staticCarve = resolveDelegationCeilingMs({
      callerBudgetMs: TURN_MS,
      parentDeadlineMs: undefined,
      nowMs: now,
      synthesisReserveMs: RESERVE_MS,
    });
    expect(armedBudget(staticCarve)).toBe(AGENT_DECLARED_MS);
    expect(TURN_MS - SPENT_BEFORE_DELEGATING_MS - armedBudget(staticCarve)! - OBSERVED_OVERSHOOT_MS)
      .toBeLessThan(124_293);

    // DISCRIMINATOR 2 — with the reserve at its schema default of 0 the child is armed with its
    // full declared budget and the run reproduces: revert 40-orchestration.jsonc and this is what
    // you get back.
    const noReserve = resolveDelegationCeilingMs({
      callerBudgetMs: TURN_MS,
      parentDeadlineMs: now + REMAINING_AT_DELEGATION_MS,
      nowMs: now,
      synthesisReserveMs: 0,
    });
    expect(armedBudget(noReserve)).toBe(AGENT_DECLARED_MS);
    expect(SPENT_BEFORE_DELEGATING_MS + AGENT_DECLARED_MS + OBSERVED_OVERSHOOT_MS)
      .toBeGreaterThan(TURN_MS - RESERVE_MS);
  });

  it("only ever REDUCES — a fresh turn with time to spare is left alone", () => {
    const now = 1_000_000_000_000;
    // Remaining is the whole turn and the reserve fits inside it, so the agent's own declared
    // budget still binds: a clamp must never lengthen anything.
    const ceiling = resolveDelegationCeilingMs({
      callerBudgetMs: TURN_MS,
      parentDeadlineMs: now + TURN_MS,
      nowMs: now,
      synthesisReserveMs: 90_000,
    });
    expect(ceiling).toBe(TURN_MS - 90_000);
    expect(armedBudget(ceiling)).toBe(AGENT_DECLARED_MS);
  });

  describe("degenerate parents", () => {
    it("leaves a caller with no budget alone rather than inventing one", () => {
      // Inventing a ceiling here would LENGTHEN, not shorten: resolveTurnBudgetMs treats a caller
      // ceiling as a REPLACEMENT for an agent that declares nothing, so a leaf whose adaptive
      // default is ~60 s would be handed the whole remaining turn. The runner-side clamp
      // (orchestration.clampSubAgentTimeoutToParent) covers this case instead — it applies after
      // the defaults resolve and can only reduce.
      const now = 1_000_000_000_000;
      expect(resolveDelegationCeilingMs({
        callerBudgetMs: undefined,
        parentDeadlineMs: now + REMAINING_AT_DELEGATION_MS,
        nowMs: now,
        synthesisReserveMs: RESERVE_MS,
      })).toBeUndefined();
    });

    it("passes an explicitly-unbounded caller budget through untouched", () => {
      // 0 is not "no time" — it is the max-effort profile's "as long as it needs".
      const now = 1_000_000_000_000;
      expect(resolveDelegationCeilingMs({
        callerBudgetMs: 0,
        parentDeadlineMs: now + 60_000,
        nowMs: now,
        synthesisReserveMs: RESERVE_MS,
      })).toBe(0);
    });

    it("falls back to the static carve-out when the parent stated no deadline", () => {
      expect(resolveDelegationCeilingMs({
        callerBudgetMs: 1_200_000,
        parentDeadlineMs: undefined,
        nowMs: 0,
        synthesisReserveMs: 90_000,
      })).toBe(1_110_000);
    });

    it("gives a parent that is already PAST its deadline the floor, never 0 and never negative", () => {
      const now = 1_000_000_000_000;
      const ceiling = resolveDelegationCeilingMs({
        callerBudgetMs: TURN_MS,
        parentDeadlineMs: now - 10_000, // deadline already blown
        nowMs: now,
        synthesisReserveMs: RESERVE_MS,
      });
      expect(ceiling).toBe(SUB_AGENT_MIN_DELEGATION_MS);
      // The floor is load-bearing, not cosmetic: 0 would be read by resolveTurnBudgetMs as
      // EXPLICITLY UNBOUNDED, so an exhausted parent would hand its child unlimited time — the
      // exact inversion of this fix. Assert the tri-state, not just the sign.
      expect(ceiling).not.toBe(0);
      expect(armedBudget(ceiling)).toBe(SUB_AGENT_MIN_DELEGATION_MS);
      // Under one model completion (124,293 ms measured) a child cannot open a stream and salvage
      // a partial, which is why the floor is a completion rather than a token value.
      expect(SUB_AGENT_MIN_DELEGATION_MS).toBeGreaterThanOrEqual(120_000);
    });
  });
});

describe("resolveDelegationDeadlineMs — nesting compounds the reserve", () => {
  const now = 1_000_000_000_000;

  it("gives every level of a depth-3 chain its own synthesis headroom", () => {
    const turnDeadline = now + REMAINING_AT_DELEGATION_MS;

    // Depth 1: the orchestrator delegates.
    const d1 = resolveDelegationDeadlineMs({
      parentDeadlineMs: turnDeadline, nowMs: now, synthesisReserveMs: RESERVE_MS,
    })!;
    expect(d1).toBe(turnDeadline - RESERVE_MS);

    // Depth 2: that child (which received d1 as its own _turnDeadlineMs) delegates 300 s later.
    const t2 = now + 300_000;
    const d2 = resolveDelegationDeadlineMs({
      parentDeadlineMs: d1, nowMs: t2, synthesisReserveMs: RESERVE_MS,
    })!;
    expect(d2).toBe(d1 - RESERVE_MS);

    // Depth 3: 640,000 ms remain. A flat 240,000 would be 37.5% of it, so the fractional bound
    // (MAX_SYNTHESIS_RESERVE_FRACTION) takes over and the level carves a quarter instead. That is
    // the inversion: the chain converges on a WORKING budget for the deepest child rather than
    // subtracting its way down to the floor, while still ending strictly inside its own parent.
    const t3 = t2 + 200_000;
    const remainingAtD3 = d2 - t3;
    const d3 = resolveDelegationDeadlineMs({
      parentDeadlineMs: d2, nowMs: t3, synthesisReserveMs: RESERVE_MS,
    })!;
    expect(remainingAtD3).toBe(640_000);
    expect(d3 - t3).toBe(remainingAtD3 * (1 - MAX_SYNTHESIS_RESERVE_FRACTION)); // 480,000
    // The flat subtraction would have handed this level 160,000 ms less.
    expect(d3 - t3).toBeGreaterThan(remainingAtD3 - RESERVE_MS);
    expect(d3 - t3).toBeGreaterThan(SUB_AGENT_MIN_DELEGATION_MS);

    // Monotonically non-increasing: no depth can be granted more time than the level above it,
    // so no amount of nesting pushes the subtree past the turn's own deadline.
    expect(d3).toBeLessThan(d2);
    expect(d2).toBeLessThan(d1);
    expect(d1).toBeLessThan(turnDeadline);

    // DISCRIMINATOR — propagating the parent deadline UNCHANGED (what agent/sub-agent.ts does, and
    // what this call site did before) gives every level the same instant, so the intermediate
    // coordinator ends at exactly the moment its child does and has nothing left to synthesize in.
    const unchanged = resolveDelegationDeadlineMs({
      parentDeadlineMs: turnDeadline, nowMs: t2, synthesisReserveMs: 0,
    });
    expect(unchanged).toBe(turnDeadline);
  });

  it("never moves a deadline OUTWARD, even when the parent is nearly or fully spent", () => {
    // The floor belongs to the budget, not to the deadline: a deadline is the one number that must
    // never move in the permissive direction.
    expect(resolveDelegationDeadlineMs({
      parentDeadlineMs: now + 30_000, nowMs: now, synthesisReserveMs: RESERVE_MS,
    })).toBe(now + 30_000);
    expect(resolveDelegationDeadlineMs({
      parentDeadlineMs: now - 10_000, nowMs: now, synthesisReserveMs: RESERVE_MS,
    })).toBe(now - 10_000);
    expect(resolveDelegationDeadlineMs({
      parentDeadlineMs: undefined, nowMs: now, synthesisReserveMs: RESERVE_MS,
    })).toBeUndefined();
  });

  it("keeps the E18 soft wrap-up nudge inside the deadline it is warning about", () => {
    const turnDeadline = now + REMAINING_AT_DELEGATION_MS;
    const ceiling = resolveDelegationCeilingMs({
      callerBudgetMs: TURN_MS, parentDeadlineMs: turnDeadline, nowMs: now, synthesisReserveMs: RESERVE_MS,
    });
    const deadline = resolveDelegationDeadlineMs({
      parentDeadlineMs: turnDeadline, nowMs: now, synthesisReserveMs: RESERVE_MS,
    })!;
    const soft = now + resolveSoftDeadlineOffsetMs(ceiling, AGENT_DECLARED_MS);
    // 70% of 1,380,000, floored — fires with ~414 s of work left. (965,999 not 966,000: the
    // product is 965,999.9999… in IEEE 754 and resolveSoftDeadlineOffsetMs floors it.)
    expect(soft).toBeLessThan(deadline);
    expect(soft - now).toBe(965_999);
  });
});

// ── Wiring: the resolver is only worth anything if the delegation site uses it ────────────────
// The pure helpers above had passing tests while the clamp that used them stayed inert behind a
// default-off flag. So assert on what the RUNNER is actually handed.
const runSubAgentMock = vi.fn(async ({ agentName }: SubAgentRunOptions) => `${agentName}: done`);
const runSubAgentWithStatsMock = vi.fn(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => ({
  output: `${args.agentName}: done`,
  stats: {
    agentName: args.agentName,
    sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
    promptChars: 0,
    userContentChars: 0,
    toolCount: 1,
    toolNames: ["write_file"],
    iterations: 1,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    maxIterations: 5,
    model: "mock",
    capabilities: [],
    terminalState: "completed" as const,
    outcome: "success" as const,
  },
}));

vi.mock("../agent/sub-agent.js", () => ({
  runSubAgent: runSubAgentMock,
  runSubAgentWithStats: runSubAgentWithStatsMock,
}));

describe("delegate_to_agent hands the runner a parent-relative budget", () => {
  beforeEach(() => {
    runSubAgentMock.mockClear();
    runSubAgentWithStatsMock.mockClear();
  });

  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
    await (await import("../swarm/memory.js")).resetSharedMemoryForTests();
  });

  /** Delegate once under a turn that has already burned `spentMs`, and return what the runner got. */
  const delegateUnderTurn = async (
    spentMs: number,
    orchestration: Record<string, unknown>,
  ): Promise<SubAgentRunOptions> => {
    const tempDir = mkdtempSync(join(tmpdir(), "sai-delegation-budget-"));
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      orchestration,
      subAgents: {
        budget_probe: {
          description: "Budget probe agent",
          systemPrompt: "You build files.",
          tools: ["write_file", "edit_file"],
          maxIterations: 5,
          turnTimeoutMs: AGENT_DECLARED_MS,
        },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);
    await getTool("delegate_to_agent")!.execute(
      { agentName: "budget_probe", task: "Build the app" },
      {
        sessionId: "session-delegation-budget",
        workspacePath: "/workspace",
        // Exactly what gateway/rpc.ts + agent/runtime.ts put on the ToolContext: the STATIC turn
        // budget, and the absolute deadline armed at turn start.
        turnTimeoutOverrideMs: TURN_MS,
        _turnDeadlineMs: Date.now() + (TURN_MS - spentMs),
      },
    );
    expect(runSubAgentWithStatsMock).toHaveBeenCalledTimes(1);
    return runSubAgentWithStatsMock.mock.calls[0]![0];
  };

  it("arms the audited agent at 1,380,000 ms, not the 1,615,806 ms it ran", async () => {
    const args = await delegateUnderTurn(SPENT_BEFORE_DELEGATING_MS, {
      subAgentSynthesisReserveMs: RESERVE_MS,
    });

    // Date.now() advances a few ms between arming the fixture deadline and the delegation, so the
    // ceiling lands just under the ideal 1,200,000 — never above it.
    expect(args.turnTimeoutOverrideMs).toBeLessThanOrEqual(1_380_000);
    expect(args.turnTimeoutOverrideMs).toBeGreaterThan(1_375_000);
    expect(armedBudget(args.turnTimeoutOverrideMs)!).toBeLessThan(OBSERVED_RUN_MS);

    // The deadline handed down is tightened by the same reserve, so the child's OWN delegations
    // inherit a deadline that already excludes this level's headroom.
    expect(args._turnDeadlineMs).toBeLessThanOrEqual(Date.now() + 1_380_000);
    expect(args._turnDeadlineMs).toBeGreaterThan(Date.now() + 1_375_000);
    // ...and the wrap-up nudge lands inside it.
    expect(args.softDeadlineMs).toBeLessThan(args._turnDeadlineMs!);
  });

  it("DISCRIMINATOR: reverting the reserve to its schema default reproduces the run", async () => {
    // Same turn, same agent, reserve 0 (what config/gateway/40-orchestration.jsonc carried before
    // this change) → the child is armed with its full declared budget again, and 180,000 +
    // 1,500,000 + the measured 115,806 ms overshoot overruns the 1,800,000 ms turn's synthesis.
    const args = await delegateUnderTurn(SPENT_BEFORE_DELEGATING_MS, {
      subAgentSynthesisReserveMs: 0,
    });
    expect(armedBudget(args.turnTimeoutOverrideMs)).toBe(AGENT_DECLARED_MS);
  });

  it("clamps to what is LEFT, not to what was configured, late in a turn", async () => {
    // 25 of the 30 minutes are gone: the old code still offered this agent its full 1,500,000 ms.
    const args = await delegateUnderTurn(1_500_000, { subAgentSynthesisReserveMs: RESERVE_MS });
    // 300,000 ms remain. A flat 240,000 reserve would leave 60,000 — under the floor — so the old
    // rule collapsed the child to SUB_AGENT_MIN_DELEGATION_MS. The fractional bound carves 75,000
    // instead and the child keeps 225,000: nearly twice as much, from a parent that genuinely has
    // little left to give. Still bounded, still never 0 (which resolveTurnBudgetMs reads as
    // unbounded), still below what the parent has.
    expect(args.turnTimeoutOverrideMs).toBe(300_000 * (1 - MAX_SYNTHESIS_RESERVE_FRACTION));
    expect(args.turnTimeoutOverrideMs!).toBeGreaterThan(SUB_AGENT_MIN_DELEGATION_MS);
    expect(args.turnTimeoutOverrideMs).not.toBe(0);
  });
});

// ── The shipped config, not a synthetic one ───────────────────────────────────────────────────
describe("config/gateway/40-orchestration.jsonc actually enables the fix", () => {
  // Every behavioural test above supplies the reserve by hand, so all of them stay green while the
  // shipped value is 0 — which is precisely how a mechanism ships inert. Read the file operators
  // actually get.
  const shard = JSON5.parse(readFileSync(
    fileURLToPath(new URL("../../../../config/gateway/40-orchestration.jsonc", import.meta.url)),
    "utf8",
  )) as { orchestration: Record<string, unknown> };

  it("sets the synthesis reserve to the value derived from run 3959f3ac", () => {
    expect(shard.orchestration["subAgentSynthesisReserveMs"]).toBe(RESERVE_MS);
  });

  it("enables the runner-side clamp that covers the nested / no-caller-budget cases", () => {
    expect(shard.orchestration["clampSubAgentTimeoutToParent"]).toBe(true);
  });

  it("survives the schema the loader validates it with", async () => {
    // The reserve is bounded (0..600,000) — a shard value the schema rejects makes the whole
    // deployment fail to boot, which is a worse outcome than the defect it fixes.
    const { OrchestrationSchema } = await import("../config/schemas/orchestration.js");
    const parsed = OrchestrationSchema.parse(shard.orchestration);
    expect(parsed.subAgentSynthesisReserveMs).toBe(RESERVE_MS);
    expect(parsed.clampSubAgentTimeoutToParent).toBe(true);
  });
});

/**
 * THE BUDGET IS NOT THE WALL ANY MORE.
 *
 * af2cea9 turned the turn deadline into a liveness probe that re-arms while the run is still
 * producing, so a healthy run routinely lives past its own turnTimeoutMs. Anything still
 * subtracting elapsed time from the STATIC budget reads "no time left" for that entire
 * extended lifetime — which is what the tool-stripping TIME BUDGET CRITICAL branch did,
 * taking a working run's tools away on every iteration and never giving them back.
 */
describe("resolveTimeRemainingMs — measured against the wall that moves", () => {
  const START = 1_000_000;

  it("uses the static budget while no deadline has been deferred", () => {
    expect(resolveTimeRemainingMs({
      turnTimeoutMs: 600_000, runStartedAt: START, effectiveDeadlineAt: undefined, nowMs: START + 100_000,
    })).toBe(500_000);
  });

  it("follows the re-armed deadline once the run has been deferred past its budget", () => {
    // 10 s past a 600 s budget, with the deadline re-armed 300 s out: the run has 300 s, not 0.
    const deferredTo = START + 610_000 + 300_000;
    expect(resolveTimeRemainingMs({
      turnTimeoutMs: 600_000, runStartedAt: START, effectiveDeadlineAt: deferredTo, nowMs: START + 610_000,
    })).toBe(300_000);
    // The old expression is what the branch used to see, and it is the bug:
    expect(Math.max(0, 600_000 - 610_000)).toBe(0);
  });

  it("still reaches zero for a run that genuinely runs out", () => {
    expect(resolveTimeRemainingMs({
      turnTimeoutMs: 600_000, runStartedAt: START, effectiveDeadlineAt: START + 600_000, nowMs: START + 700_000,
    })).toBe(0);
  });

  it("is undefined for an unbounded run rather than zero", () => {
    expect(resolveTimeRemainingMs({ turnTimeoutMs: undefined, runStartedAt: START, nowMs: START + 9_000_000 })).toBeUndefined();
    expect(resolveTimeRemainingMs({ turnTimeoutMs: 0, runStartedAt: START, nowMs: START })).toBeUndefined();
  });
});
