import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mutable config the mock returns — tests reassign per case.
interface MockConfig {
  effort?: { default?: string; profiles?: Record<string, Record<string, unknown>> };
  orchestration?: Record<string, unknown>;
  agents?: { maxToolIterations?: number; performance?: Record<string, number> };
}
let mockConfig: MockConfig;

vi.mock("../config/loader.js", () => ({
  getConfig: () => mockConfig,
}));

import {
  resolveEffortProfile,
  resolveEffortTier,
  runWithEffortContext,
  currentEffortProfile,
  currentEffortTier,
  effectiveOrchestration,
  effectiveMaxDelegatedResultChars,
  effectiveOrchestratorMaxToolIterations,
  BUILTIN_EFFORT_PROFILES,
} from "../runtime/effort-context.js";

const BASE_ORCHESTRATION = {
  maxParallelSlices: 2,
  maxDelegationDepth: 3,
  riskGatedQA: true,
  qaEvidenceAnchoring: true,
  finalResponseQaGate: true,
  autoResearchOnRefusal: true,
  autoBuildAfterResearch: true,
  oversight: true,
};

beforeEach(() => {
  mockConfig = {
    effort: { default: "medium", profiles: {} },
    orchestration: { ...BASE_ORCHESTRATION },
    agents: {
      maxToolIterations: 20,
      performance: { maxDelegatedResultChars: 10_000, orchestratorTurnSloMs: 120_000, subAgentTurnSloMs: 60_000 },
    },
  };
});
afterEach(() => vi.clearAllMocks());

describe("resolveEffortProfile — built-in tiers", () => {
  it("medium is the identity overlay (no overrides)", () => {
    expect(resolveEffortProfile("medium")).toEqual({});
  });

  it("high pushes reasoning + a long timeout but keeps the quality gates", () => {
    const p = resolveEffortProfile("high");
    expect(p.enableThinking).toBe(true);
    expect(p.reasoningEffort).toBe("high");
    expect(p.turnTimeoutMs).toBe(1_200_000);
    expect(p.maxDelegatedResultChars).toBe(40_000);
    expect(p.promptAddendum && p.promptAddendum.length).toBeGreaterThan(0);
    // gates untouched (undefined → inherit config)
    expect(p.riskGatedQA).toBeUndefined();
    expect(p.qaEvidenceAnchoring).toBeUndefined();
    expect(p.oversight).toBeUndefined();
  });

  it("max is unbounded and relaxes the quality gates", () => {
    const p = resolveEffortProfile("max");
    expect(p.turnTimeoutMs).toBe(0); // unlimited
    expect(p.riskGatedQA).toBe(false);
    expect(p.qaEvidenceAnchoring).toBe(false);
    expect(p.finalResponseQaGate).toBe(false);
    expect(p.autoResearchOnRefusal).toBe(false);
    expect(p.oversight).toBe(false);
    // autoBuildAfterResearch stays on — it produces the deliverable
    expect(p.autoBuildAfterResearch).not.toBe(false);
    expect(p.promptAddendum && p.promptAddendum.length).toBeGreaterThan(0);
  });

  it("low tightens caps and disables extended reasoning", () => {
    const p = resolveEffortProfile("low");
    expect(p.enableThinking).toBe(false);
    expect(p.reasoningEffort).toBe("low");
    expect(p.turnTimeoutMs).toBe(120_000);
    expect(p.toolCapMultiplier).toBeLessThan(1);
  });

  it("an undefined tier resolves to the configured default", () => {
    mockConfig.effort!.default = "high";
    expect(resolveEffortProfile(undefined)).toEqual(BUILTIN_EFFORT_PROFILES.high);
  });
});

describe("resolveEffortProfile — config override merge", () => {
  it("overlays config profile fields onto the built-in without clobbering unspecified ones", () => {
    mockConfig.effort!.profiles = { high: { turnTimeoutMs: 999, maxDelegatedResultChars: undefined } };
    const p = resolveEffortProfile("high");
    expect(p.turnTimeoutMs).toBe(999); // overridden
    expect(p.enableThinking).toBe(true); // built-in retained
    expect(p.maxDelegatedResultChars).toBe(40_000); // undefined override did NOT clobber
  });

  it("can turn a built-in gate back on at max via config", () => {
    mockConfig.effort!.profiles = { max: { riskGatedQA: true } };
    expect(resolveEffortProfile("max").riskGatedQA).toBe(true);
  });
});

describe("resolveEffortTier", () => {
  it("accepts the known tiers, case-insensitively", () => {
    expect(resolveEffortTier("low")).toBe("low");
    expect(resolveEffortTier("HIGH")).toBe("high");
    expect(resolveEffortTier(" Max ")).toBe("max");
  });
  it("rejects unknown / non-string values", () => {
    expect(resolveEffortTier("turbo")).toBeUndefined();
    expect(resolveEffortTier(42)).toBeUndefined();
    expect(resolveEffortTier(undefined)).toBeUndefined();
  });
});

describe("turn-scoped overlay", () => {
  it("currentEffortProfile/Tier are undefined outside a context", () => {
    expect(currentEffortProfile()).toBeUndefined();
    expect(currentEffortTier()).toBeUndefined();
  });

  it("effectiveOrchestration returns base config when no context is active", () => {
    expect(effectiveOrchestration()).toEqual(BASE_ORCHESTRATION);
  });

  it("medium overlay leaves orchestration unchanged (baseline invariant)", () => {
    runWithEffortContext("medium", () => {
      expect(effectiveOrchestration()).toEqual(BASE_ORCHESTRATION);
      expect(currentEffortTier()).toBe("medium");
    });
  });

  it("max overlay turns the quality gates off", () => {
    runWithEffortContext("max", () => {
      const o = effectiveOrchestration();
      expect(o.riskGatedQA).toBe(false);
      expect(o.qaEvidenceAnchoring).toBe(false);
      expect(o.oversight).toBe(false);
      expect(o.maxDelegationDepth).toBe(6); // raised
    });
  });

  it("effectiveMaxDelegatedResultChars follows the active tier, else config", () => {
    expect(effectiveMaxDelegatedResultChars()).toBe(10_000);
    runWithEffortContext("high", () => {
      expect(effectiveMaxDelegatedResultChars()).toBe(40_000);
    });
  });

  it("effectiveOrchestratorMaxToolIterations is undefined unless a tier sets it", () => {
    expect(effectiveOrchestratorMaxToolIterations()).toBeUndefined();
    runWithEffortContext("high", () => {
      expect(effectiveOrchestratorMaxToolIterations()).toBe(40);
    });
  });

  it("a tier orchestratorMaxToolIterations of 0 resolves to unbounded", () => {
    mockConfig.effort!.profiles = { high: { orchestratorMaxToolIterations: 0 } };
    runWithEffortContext("high", () => {
      expect(effectiveOrchestratorMaxToolIterations()).toBe(Number.MAX_SAFE_INTEGER);
    });
  });
});

describe("orchestration overlay — turn-scoped A/B arms", () => {
  it("applies the overlay inside the scope and leaves global config untouched outside", async () => {
    const { effectiveOrchestration, runWithOrchestrationOverride } = await import("../runtime/effort-context.js");

    const before = effectiveOrchestration().qaToolJudge;
    const inside = runWithOrchestrationOverride({ qaToolJudge: !before }, () => effectiveOrchestration().qaToolJudge);
    const after = effectiveOrchestration().qaToolJudge;

    expect(inside).toBe(!before);
    expect(after).toBe(before); // scope closed — no global mutation
  });

  it("an empty or absent override is a straight pass-through", async () => {
    const { effectiveOrchestration, runWithOrchestrationOverride } = await import("../runtime/effort-context.js");
    const base = effectiveOrchestration().qaToolJudge;
    expect(runWithOrchestrationOverride(undefined, () => effectiveOrchestration().qaToolJudge)).toBe(base);
    expect(runWithOrchestrationOverride({}, () => effectiveOrchestration().qaToolJudge)).toBe(base);
  });

  it("survives an inner effort-context scope — the arm stays armed", async () => {
    const { effectiveOrchestration, runWithOrchestrationOverride, runWithEffortContext } =
      await import("../runtime/effort-context.js");

    const before = effectiveOrchestration().qaToolJudge;
    const seen = runWithOrchestrationOverride({ qaToolJudge: !before }, () =>
      // A turn sets its effort tier inside the arm; dropping the overlay here would
      // silently disarm the thing being measured.
      runWithEffortContext("high", () => effectiveOrchestration().qaToolJudge));

    expect(seen).toBe(!before);
  });
});
