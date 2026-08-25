import { afterEach, describe, expect, it } from "vitest";
import {
  normalizeTurnPlan,
  countParallelWidth,
  classifyTurnRisk,
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
    expect(plan.steps[2]!.kind).toBe("delegate"); // omitted kind defaults to delegate
    expect(plan.steps[2]!.id).toBe("s3");          // auto-assigned id
    expect(plan.acceptanceCriteria).toEqual(["names a winner", "cites sources"]);
    expect(plan.riskTier).toBe("high");           // case-normalized
    expect(plan.wide).toBe(false);                // only 2 in the parallel group
    expect(typeof plan.createdAt).toBe("string");
  });

  it("unwraps a { plan: {…} } envelope the model commonly emits (previously failed every planned turn)", () => {
    const plan = normalizeTurnPlan({
      plan: {
        objective: "Build the tutorial site.",
        steps: [{ description: "delegate to content_writer", kind: "delegate", agent: "content_writer" }],
        acceptanceCriteria: ["all sections present"],
        riskTier: "low",
      },
    });
    expect(plan.objective).toBe("Build the tutorial site.");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({ kind: "delegate", agent: "content_writer" });
    expect(plan.acceptanceCriteria).toEqual(["all sections present"]);
  });

  it("reads snake_case aliases for acceptance_criteria / stop_conditions / risk_tier (audit e5754140: recorded acceptanceCriteria:0)", () => {
    // The local model emits snake_case keys; reading only camelCase silently
    // dropped the criteria, which gated OUT both riskGatedQA and qaDeliveryLoop.
    const plan = normalizeTurnPlan({
      objective: "Design the device.",
      steps: [
        { description: "core design", tag: "reuse", agent_name: "mission_coordinator", parallel_group: 1 },
        { description: "case design", tag: "delegate", agent_name: "mission_coordinator", parallel_group: 1 },
      ],
      acceptance_criteria: ["part numbers cited", "wiring diagram included", "power budget given"],
      stop_conditions: ["all components specified"],
      risk_tier: "high",
    });
    expect(plan.acceptanceCriteria).toEqual(["part numbers cited", "wiring diagram included", "power budget given"]);
    expect(plan.stopConditions).toEqual(["all components specified"]);
    expect(plan.riskTier).toBe("high");
    expect(plan.steps[0]).toMatchObject({ kind: "reuse", agent: "mission_coordinator", parallelGroup: 1 }); // `tag` alias read
    expect(plan.steps[1]!.kind).toBe("delegate");
  });

  it("reads a step's `desc` alias inside a {plan:{…}} envelope (audit 8d480f5d turn 1: 3-step plan recorded as stepCount:0)", () => {
    // The model wrapped the plan AND keyed each step's text as `desc` (not
    // `description`); the envelope unwrapped fine but every step read an empty
    // description and was dropped → stepCount:0, losing the planned fan-out.
    const plan = normalizeTurnPlan({
      plan: {
        objective: "Design a portable audio recorder.",
        steps: [
          { tag: "delegate", agentName: "mission_coordinator", parallelGroup: "A", desc: "Research MEMS mics + power" },
          { tag: "delegate", agentName: "mission_coordinator", parallelGroup: "B", desc: "Research SD/OTA + waterproofing" },
          { tag: "delegate", agentName: "mission_coordinator", parallelGroup: "C", desc: "Synthesise BOM + schematic" },
        ],
        acceptance_criteria: ["BOM with part numbers", "circuit diagram"],
      },
    });
    expect(plan.steps).toHaveLength(3); // not 0 — `desc` is now read
    expect(plan.steps[0]).toMatchObject({ kind: "delegate", agent: "mission_coordinator", description: "Research MEMS mics + power" });
    expect(plan.acceptanceCriteria).toHaveLength(2);
  });

  it("coerces a bulleted-STRING `steps` into steps (audit df65c23a turn 2: steps as a string → stepCount:0)", () => {
    // The local model emitted `steps` as one newline-bulleted string instead of an
    // array, so a lone delegate step was dropped (stepCount:0), gating out plan QA.
    const plan = normalizeTurnPlan({
      objective: "Tutorial-Website erstellen",
      steps:
        "- delegate_to_agent(agentName='content_writer', task='Erstelle die Tutorial-Website')\n"
        + "- delegate_to_agent(agentName='quality_supervisor', task='Review')",
      acceptanceCriteria: ["site has all sections"],
      riskTier: "low",
    });
    expect(plan.steps).toHaveLength(2); // not 0 — the string is split into steps
    expect(plan.steps[0]).toMatchObject({ kind: "delegate", agent: "content_writer" });
    expect(plan.steps[1]).toMatchObject({ kind: "delegate", agent: "quality_supervisor" });
    expect(plan.acceptanceCriteria).toEqual(["site has all sections"]);
  });

  it("coerces a single-line STRING `steps` with no list marker into one step", () => {
    const plan = normalizeTurnPlan({
      objective: "Build it",
      steps: "delegate to coder to build the thing",
    });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.kind).toBe("delegate");
    expect(plan.steps[0]!.description).toContain("build the thing");
  });

  it("coerces a free-text STRING plan into the objective so it records (audit e5754140 turn 2: string plan → empty → warden stop)", () => {
    const plan = normalizeTurnPlan({
      plan: "Objective: Create a tutorial website.\nStep 1: delegate to content_writer.\nStop conditions: file written.",
      riskTier: "low",
    });
    expect(plan.objective).toContain("Create a tutorial website.");
    expect(plan.objective).not.toMatch(/^objective\s*:/i); // leading label stripped
    expect(plan.riskTier).toBe("low"); // sibling key preserved
  });

  it("does NOT unwrap when the real fields are already top-level (a flat call is untouched)", () => {
    const plan = normalizeTurnPlan({
      objective: "Top-level objective",
      steps: [{ description: "do it", kind: "direct" }],
      plan: { objective: "WRONG", steps: [] }, // stray key must not override real top-level fields
    });
    expect(plan.objective).toBe("Top-level objective");
    expect(plan.steps).toHaveLength(1);
  });

  it("gives every step a unique id — everything downstream keys steps BY id", () => {
    // The auto-mint `s${steps.length + 1}` cannot see an explicit id the model gives a LATER step,
    // so this plan produced ["s1","s1"] without repeating anything. Two steps then share one status
    // entry: the first to run marks the id done, the second is skipped as already-settled, and the
    // plan reports 2/2 completed with one deliverable never produced.
    const plan = normalizeTurnPlan({
      objective: "write the paper",
      steps: [
        { description: "gather sources", kind: "delegate", agent: "researcher" },
        { id: "s1", description: "write the paper", kind: "delegate", agent: "content_writer" },
      ],
    });
    expect(plan.steps.map((s) => s.id)).toEqual(["s2", "s1"]);
    expect(new Set(plan.steps.map((s) => s.id)).size).toBe(2);
  });

  it("renames a repeated id rather than letting two steps collapse into one", () => {
    const plan = normalizeTurnPlan({
      objective: "x",
      steps: [
        { id: "a", description: "first", kind: "delegate" },
        { id: "a", description: "second", kind: "delegate" },
      ],
    });
    expect(new Set(plan.steps.map((s) => s.id)).size).toBe(2);
    expect(plan.steps[0]?.id).toBe("a");
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

describe("turn plan — risk classification", () => {
  it("is high when the orchestrator declared the plan high-risk", () => {
    expect(classifyTurnRisk({ planRiskTier: "high" })).toBe("high");
  });
  it("is high for sourced factual claims and approval-gated actions", () => {
    expect(classifyTurnRisk({ sourceSensitive: true })).toBe("high");
    expect(classifyTurnRisk({ invokedApprovalGatedTool: true })).toBe("high");
  });
  it("is high for freshness-sensitive turns (answer is ungrounded unless retrieved)", () => {
    // audit fe496ec5: a freshness turn was classified low and skipped QA, so a
    // fabricated news bulletin shipped. Freshness now enters the grounding gate.
    expect(classifyTurnRisk({ freshnessSensitive: true })).toBe("high");
  });
  it("is low for plain chat / low-stakes single-domain work", () => {
    expect(classifyTurnRisk({})).toBe("low");
    expect(classifyTurnRisk({ planRiskTier: "low", sourceSensitive: false, invokedApprovalGatedTool: false })).toBe("low");
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
    expect(fromSub?.steps[0]?.description).toBe("step one");
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

/**
 * A reuse step is only dispatchable if it says WHICH workflow. The plan schema has always let the
 * model describe it in prose alone, and execute_plan can then do nothing but hand the step back —
 * so record_plan says so while the plan is still being written.
 */
const { getTool } = await import("../tools/registry.js");
await import("../tools/turn-plan-tool.js");

describe("record_plan — a reuse step that names no workflow", () => {
  const record = async (steps: unknown[]): Promise<string> => {
    const result = await getTool("record_plan")!.execute(
      { objective: "ship it", steps },
      { sessionId: "record-plan-note", workspacePath: "/w" } as never,
    );
    return result.output;
  };

  it("names the offending step, and points at execute_plan for the rest", async () => {
    const output = await record([
      { id: "s1", description: "gather", kind: "reuse", workflow: "research_pack" },
      { id: "s2", description: "run the usual publishing flow", kind: "reuse" },
    ]);
    expect(output).toMatch(/reuse step s2 names no workflow/);
    expect(output).not.toMatch(/s1 names no workflow/);
    expect(output).toMatch(/CALL execute_plan/);
  });

  it("says nothing when every reuse step names one", async () => {
    const output = await record([
      { id: "s1", description: "gather", kind: "reuse", workflow: "research_pack" },
    ]);
    expect(output).not.toMatch(/names no workflow/);
  });
});
