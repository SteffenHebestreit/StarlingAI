import { afterEach, describe, expect, it } from "vitest";
import {
  normalizeTurnPlan,
  countParallelWidth,
  persistTurnPlan,
  loadTurnPlan,
  clearTurnPlanForSession,
  renderTurnPlan,
  type TurnPlan,
} from "../agent/turn-plan.js";

/**
 * First-class turn plan (Phase 2): coercion of loose tool args into a validated
 * plan, planned-width detection, and persist/retrieve through the reserved
 * per-session slot (scoped to the root session so sub-agents read the same plan).
 */
describe("turn plan — normalization", () => {
  it("coerces loose args, defaults step kind to delegate, and clamps sizes", () => {
    const plan = normalizeTurnPlan({
      objective: "Compare three recorders and recommend one.",
      steps: [
        { id: "s1", description: "Find candidates", kind: "reuse" },
        { description: "Research specs", kind: "delegate", agent: "researcher", parallelGroup: 1 },
        { description: "Research pricing", agent: "researcher", parallelGroup: 1 }, // kind omitted → delegate
        { description: "" }, // dropped (no description)
        "garbage", // dropped (not an object)
      ],
      acceptanceCriteria: ["names a winner", "cites sources"],
      riskTier: "HIGH",
    });

    expect(plan.objective).toContain("Compare three recorders");
    expect(plan.steps).toHaveLength(3);
    expect(plan.steps[0]).toMatchObject({ id: "s1", kind: "reuse" });
    expect(plan.steps[1]).toMatchObject({ kind: "delegate", agent: "researcher", parallelGroup: 1 });
    expect(plan.steps[2].kind).toBe("delegate"); // omitted kind defaults to delegate
    expect(plan.steps[2].id).toBe("s3");          // auto-assigned id
    expect(plan.acceptanceCriteria).toEqual(["names a winner", "cites sources"]);
    expect(plan.riskTier).toBe("high");           // case-normalized
    expect(plan.wide).toBe(false);                // only 2 in the parallel group
    expect(typeof plan.createdAt).toBe("string");
  });

  it("marks a plan wide when more than two steps share a parallel group", () => {
    const plan = normalizeTurnPlan({
      objective: "Wide fan-out",
      steps: [
        { description: "a", kind: "delegate", parallelGroup: 1 },
        { description: "b", kind: "delegate", parallelGroup: 1 },
        { description: "c", kind: "delegate", parallelGroup: 1 },
      ],
    });
    expect(countParallelWidth(plan.steps)).toBe(3);
    expect(plan.wide).toBe(true);
  });

  it("falls back to an empty-but-valid plan for junk input (never throws)", () => {
    const plan = normalizeTurnPlan({});
    expect(plan.steps).toEqual([]);
    expect(plan.acceptanceCriteria).toEqual([]);
    expect(plan.riskTier).toBe("low");
  });
});

describe("turn plan — persistence (root-session scoped)", () => {
  afterEach(async () => {
    await clearTurnPlanForSession("plan-root");
  });

  it("round-trips a plan and is readable from a nested sub-session id", async () => {
    const plan: TurnPlan = {
      objective: "do the thing",
      steps: [{ id: "s1", description: "step one", kind: "direct" }],
      acceptanceCriteria: ["done correctly"],
      stopConditions: [],
      riskTier: "low",
      wide: false,
      createdAt: new Date().toISOString(),
    };
    await persistTurnPlan("plan-root", plan);

    // Orchestrator (root) sees it…
    const fromRoot = await loadTurnPlan("plan-root");
    expect(fromRoot?.objective).toBe("do the thing");
    // …and so does a sub-agent two hops deep (same root bucket).
    const fromSub = await loadTurnPlan("sub:sub:plan-root:mission_coordinator:111:researcher:222");
    expect(fromSub?.objective).toBe("do the thing");
    expect(fromSub?.steps[0].description).toBe("step one");
  });

  it("returns null when no plan was recorded", async () => {
    expect(await loadTurnPlan("plan-root")).toBeNull();
  });

  it("renders a compact human-readable view", () => {
    const plan = normalizeTurnPlan({
      objective: "ship it",
      steps: [{ id: "s1", description: "build", kind: "delegate", agent: "coder" }],
      acceptanceCriteria: ["tests pass"],
    });
    const rendered = renderTurnPlan(plan);
    expect(rendered).toContain("Objective: ship it");
    expect(rendered).toContain("[s1] build");
    expect(rendered).toContain("coder");
    expect(rendered).toContain("tests pass");
  });
});
