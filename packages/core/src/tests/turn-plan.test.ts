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

  it("keeps what a step declares it must hand back, and drops a value that is not one", () => {
    // DelegationDeliverable: execute_plan hands it to delegate_to_agent, so a plan's build step is
    // judged as a build and its research step is not. Each step's task carries the turn's objective,
    // so the verb test over it read every step of a build plan as the build.
    const plan = normalizeTurnPlan({
      objective: "Build the CPSA-F learning site from the syllabus.",
      steps: [
        { id: "s1", description: "Gather the syllabus topics", agent: "researcher", deliverable: "answer" },
        { id: "s2", description: "Build the site", agent: "web_coder", deliverable: "File", dependsOn: ["s1"] },
        { id: "s3", description: "Review it", agent: "quality_supervisor", deliverable: "website" },
      ],
    });
    expect(plan.steps.map((step) => step.deliverable)).toEqual(["answer", "file", undefined]);
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

  it("survives a plan whose step results exceed the store's cap, instead of vanishing", async () => {
    // The store caps the value with a HARD SLICE and loadTurnPlan JSON.parses what comes back, so a
    // plan one character over does not return truncated — it does not return at all, and a turn in
    // the middle of its own plan is told no plan was ever recorded. Step results are the only
    // unbounded part, and exactly what a resumed call needs, so they are what gets shed.
    const huge = "x".repeat(20_000);
    await persistTurnPlan("plan-root", {
      objective: "do the thing",
      acceptanceCriteria: [],
      stopConditions: [],
      riskTier: "low",
      wide: false,
      createdAt: new Date(0).toISOString(),
      steps: [
        { id: "s1", description: "research", kind: "delegate" },
        { id: "s2", description: "write", kind: "delegate" },
      ],
      outcomes: [
        { id: "s1", status: "done", result: huge },
        { id: "s2", status: "done", result: huge },
      ],
    });

    const loaded = await loadTurnPlan("plan-root");
    expect(loaded).not.toBeNull();                       // the whole plan used to disappear here
    expect(loaded?.steps.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(loaded?.outcomes?.every((o) => o.status === "done")).toBe(true);
  });

  it("keeps a plan readable even when its own steps overflow the store", async () => {
    // The last rung used to return without measuring, so an oversized plan was still written over
    // the cap and read back as null — while record_plan reported success. toolArgs is the field the
    // model fills with free content, and was the only unclamped one in the normalizer.
    await persistTurnPlan("plan-root", {
      objective: "write the report",
      acceptanceCriteria: [],
      stopConditions: [],
      riskTier: "low",
      wide: false,
      createdAt: new Date(0).toISOString(),
      steps: Array.from({ length: 8 }, (_, i) => ({
        id: `s${i}`,
        description: "x".repeat(600),
        kind: "direct" as const,
        tool: "write_file",
        toolArgs: { content: "y".repeat(20_000) },
      })),
      outcomes: Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, status: "done" as const, result: "z".repeat(9_000) })),
    });

    const loaded = await loadTurnPlan("plan-root");
    expect(loaded).not.toBeNull();
    expect(loaded?.objective).toBe("write the report");
    expect(loaded?.steps.length).toBeGreaterThan(0);
  });

  it("drops a toolArgs blob too large to store, and says so on the step", () => {
    const plan = normalizeTurnPlan({
      objective: "write it",
      steps: [{ id: "s1", description: "save the report", kind: "direct", tool: "write_file", toolArgs: { content: "x".repeat(20_000) } }],
    });
    expect(plan.steps[0]?.toolArgs).toBeUndefined();
    expect(plan.steps[0]?.description).toMatch(/toolArgs omitted/);
  });

  it("hands back a step whose arguments could not be stored, instead of running it with none", async () => {
    // Dropping toolArgs alone leaves a step that still NAMES a tool, and the executor would then
    // dispatch it with an empty argument object — write_file with no path, http_request with no url.
    await persistTurnPlan("plan-root", {
      objective: "write the reports",
      acceptanceCriteria: [],
      stopConditions: [],
      riskTier: "low",
      wide: false,
      createdAt: new Date(0).toISOString(),
      steps: Array.from({ length: 10 }, (_, i) => ({
        id: `s${i}`,
        description: "save a report",
        kind: "direct" as const,
        tool: "write_file",
        toolArgs: { content: "x".repeat(3_800) },
      })),
    });

    const loaded = await loadTurnPlan("plan-root");
    expect(loaded).not.toBeNull();
    expect(loaded?.steps[0]?.toolArgs).toBeUndefined();
    expect(loaded?.steps[0]?.tool).toBeUndefined();          // ...so nothing dispatches it
    expect(loaded?.steps[0]?.description).toMatch(/run this step yourself/);
  });

  it("sheds cumulatively — arguments go on top of results, not instead of them", async () => {
    // The argless copy used to be rebuilt from the ORIGINAL plan, putting every full result back, so
    // a plan that would have fitted with results AND arguments shed had its whole execution record
    // deleted instead — and a resumed call then re-dispatched every completed step.
    await persistTurnPlan("plan-root", {
      objective: "o",
      acceptanceCriteria: [],
      stopConditions: [],
      riskTier: "low",
      wide: false,
      createdAt: new Date(0).toISOString(),
      // Sized so the result budgets alone can never fit it: the arguments are over the cap by
      // themselves, so the argless rung is the one that decides, and it is built on the shed copy.
      steps: Array.from({ length: 10 }, (_, i) => ({
        id: `s${i}`,
        description: "step",
        kind: "direct" as const,
        tool: "write_file",
        toolArgs: { content: "a".repeat(3_800) },
      })),
      outcomes: Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, status: "done" as const, result: "r".repeat(9_000) })),
    });

    const loaded = await loadTurnPlan("plan-root");
    expect(loaded?.outcomes).toHaveLength(10);              // the record survived
    expect(loaded?.outcomes?.every((o) => o.status === "done")).toBe(true);
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

  it("refuses a plan with no steps, instead of recording an empty one", async () => {
    // Not hypothetical: a live run against the local model recorded
    // {objective: "typo guard", steps: []}. It logged "Turn plan recorded", answered "Now execute
    // it", and left the turn with a persisted plan whose every count is zero — which riskGatedQA
    // then judges against and decidePlanContinuation then measures.
    const result = await getTool("record_plan")!.execute(
      { objective: "typo guard", steps: [] },
      { sessionId: "record-plan-empty", workspacePath: "/w" } as never,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/at least one step/);

    const { loadTurnPlan } = await import("../agent/turn-plan.js");
    expect(await loadTurnPlan("record-plan-empty")).toBeNull();   // and nothing was persisted
  });

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
    expect(output).not.toMatch(/no workflow/);
  });
});

describe("record_plan — a direct step names a tool the caller has", () => {
  // E2E 2026-10-22: an orchestration-only turn planned read_file and edit_file as direct steps. The
  // folded run refused both, the plan counted as a failed delegation, and the warden stopped the turn
  // after the next one.
  const orchestrator = { sessionId: "record-plan-reach", workspacePath: "/w", allowedTools: ["delegate_to_agent", "record_plan"], loadableTools: ["web_search"] };

  it("refuses the plan, names each such step, and records nothing", async () => {
    const result = await getTool("record_plan")!.execute({
      objective: "update the heading",
      steps: [
        { id: "s1", description: "read the page", kind: "direct", tool: "read_file", toolArgs: { path: "a.html" } },
        { id: "s2", description: "look it up", kind: "direct", tool: "web_search", toolArgs: { query: "x" } },
        { id: "s3", description: "change it", kind: "direct", tool: "edit_file", toolArgs: { path: "a.html" } },
      ],
    }, orchestrator as never);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/s1 \(read_file\), s3 \(edit_file\)/);
    expect(result.error).not.toMatch(/web_search/);
    expect(result.error).toMatch(/"delegate" step/);

    const { loadTurnPlan } = await import("../agent/turn-plan.js");
    expect(await loadTurnPlan("record-plan-reach")).toBeNull();
  });

  it("records a plan whose direct steps it can call, or that are its own reasoning", async () => {
    const result = await getTool("record_plan")!.execute({
      objective: "look it up",
      steps: [
        { id: "s1", description: "search", kind: "direct", tool: "web_search", toolArgs: { query: "x" } },
        { id: "s2", description: "decide the framing", kind: "direct" },
        { id: "s3", description: "edit the page", kind: "delegate" },
      ],
    }, { ...orchestrator, sessionId: "record-plan-reach-ok" } as never);
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
  });
});

describe("record_plan — a plan that cannot make the change the turn asked for", () => {
  // E2E 2026-10-22: asked to update a heading in a file, an orchestration-only turn planned "read
  // the file" and "replace the heading" as its own reasoning steps, declared both done without a
  // call, and was held to the final answer with nothing looked at.
  const UPDATE = "Aktualisiere die Datei generated/aktionen/herbst.html: Die Hauptüberschrift soll „Herbstaktion 2026“ lauten.";
  const OWN_STEPS = [
    { id: "s1", description: "Die Datei lesen und die Überschrift finden", kind: "direct" },
    { id: "s2", description: "Die Überschrift ersetzen", kind: "direct" },
  ];
  const turn = async (opening: string) => {
    const { createSession } = await import("../agent/session.js");
    const session = createSession({ channel: "test", workspacePath: "/w", systemPrompt: "You are a test agent." });
    session.addMessage({ role: "user", content: opening });
    return session;
  };
  const record = (sessionId: string, steps: unknown[]) =>
    getTool("record_plan")!.execute({ objective: "update the heading", steps }, { sessionId, workspacePath: "/w" } as never);

  afterEach(async () => { (await import("../agent/session.js")).resetSessionsForTests(); });

  it("refuses a plan of the orchestrator's own steps only, and records nothing", async () => {
    const session = await turn(UPDATE);
    const result = await record(session.id, OWN_STEPS);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no step of this plan can do that/);
    expect(result.error).toMatch(/"delegate" step/);
    const { loadTurnPlan } = await import("../agent/turn-plan.js");
    expect(await loadTurnPlan(session.id)).toBeNull();
  });

  it("records it with a step that can make the change", async () => {
    const session = await turn(UPDATE);
    const result = await record(session.id, [...OWN_STEPS, { id: "s3", description: "Die Datei ändern", kind: "delegate" }]);
    expect(result.error).toBeUndefined();
  });

  it("records it on a turn that asked for no change, or once the change was produced", async () => {
    const asking = await turn("Was steht in der Hauptüberschrift von generated/aktionen/herbst.html?");
    expect((await record(asking.id, OWN_STEPS)).error).toBeUndefined();

    const changed = await turn(UPDATE);
    changed.addMessage({ role: "assistant", content: "", tool_calls: [{ id: "d1", type: "function", function: { name: "delegate_to_agent", arguments: "{}" } }] });
    changed.addMessage({ role: "tool", tool_call_id: "d1", content: "Delegated result from web_coder — TASK COMPLETED.", metadata: { artifacts: [{ outputPath: "generated/aktionen/herbst.html", filename: "herbst.html" }] } });
    expect((await record(changed.id, OWN_STEPS)).error).toBeUndefined();
  });
});
