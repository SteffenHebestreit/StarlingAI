import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../tools/registry.js";
import type { SubAgentRunOptions, SubAgentRunResult } from "../agent/sub-agent.js";
import type { TurnPlan } from "../agent/turn-plan.js";

/**
 * A PLAN STEP NAMING AN AGENT THAT CANNOT GATHER IS REDIRECTED BY STRUCTURE, NOT BY ITS WORDS.
 *
 * E2E 2026-10-07: on a turn the up-front judge flagged as needing outside facts, the orchestrator's
 * plan named web_coder — which cannot read a web page — for "Die Website … abrufen und … durchsuchen".
 * The research gate in executeDelegationWithFallback is the one place that replaces such an agent,
 * and it fired only on an English verb+noun shape: the English twin (dee3be85) went to researcher,
 * the three German runs (2f31f387, 9ddd881f, f4fdf38e) ran web_coder and answered "not available".
 * The gate now also arms on the judge's verdict, for an agent confined to the workspace that works
 * only from the text it is handed, while nothing this turn has reached outside the workspace.
 */
const runner = vi.hoisted(() => vi.fn());
const audit = vi.hoisted(() => vi.fn());

vi.mock("../agent/sub-agent.js", () => ({
  runSubAgent: vi.fn(async (args: SubAgentRunOptions) => ((await runner(args)) as SubAgentRunResult).output),
  runSubAgentWithStats: runner,
}));
vi.mock("../audit/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../audit/logger.js")>();
  return {
    ...actual,
    logAudit: (...args: Parameters<typeof actual.logAudit>) => { audit(...args); return actual.logAudit(...args); },
  };
});

const statsFor = (args: SubAgentRunOptions): SubAgentRunResult["stats"] => ({
  agentName: args.agentName,
  sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
  promptChars: 0,
  userContentChars: 0,
  toolCount: 1,
  toolNames: ["read_file"],
  iterations: 1,
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  maxIterations: 5,
  model: "mock",
  capabilities: [],
  terminalState: "completed",
  outcome: "success",
});

/**
 * Taxonomy labels as workspace/agents/59-routing.generated.jsonc gives the deployed agents: under
 * `routingGenerated`, the key every one of them carries. An authored `routing` block here would let
 * a predicate that read only that key pass these tests while it classified no deployed agent at all.
 */
const label = (mode: string, surface: string, input: string) =>
  ({ mode, domain: ["software"], riskTier: "read_only", executionShape: "single_agent", surface: [surface], inputModality: [input] });

const AGENTS = {
  researcher: { tools: ["web_search", "web_fetch", "url_inspect"], routingGenerated: label("GATHER", "external_network", "url") },
  browser_agent: { tools: ["browser_navigate", "browser_snapshot"], routingGenerated: label("ACT", "browser", "url") },
  web_coder: { tools: ["read_file", "write_file", "generate_website", "verify_page", "read_shared_facts", "share_finding"], routingGenerated: label("PRODUCE", "workspace", "text") },
  content_writer: { tools: ["read_file", "write_file", "generate_document", "read_shared_facts", "share_finding"], routingGenerated: label("PRODUCE", "workspace", "text") },
  mail_agent: { tools: ["mail_search", "mail_read", "read_shared_facts", "share_finding"], routingGenerated: label("ACT", "user_channel", "live_system") },
  code_analyst: { tools: ["read_file", "grep_files", "read_shared_facts", "share_finding"], routingGenerated: label("GATHER", "workspace", "codebase") },
  vision_browser_analyst: { tools: ["browser_snapshot", "browser_screenshot", "read_shared_facts", "share_finding", "write_file", "edit_file"], routingGenerated: label("GATHER", "browser", "image") },
} as const;

/** The live 2f31f387 plan, verbatim. */
const GERMAN_STEP = "Die Website http://www.nordlicht-werkzeuge.test/ abrufen und nach Informationen zu Gründungsjahr und Mitarbeiterzahl durchsuchen.";
const GERMAN_OBJECTIVE = "Gründungsdatum und Mitarbeiterzahl der Nordlicht Werkzeuge GmbH aus der Firmenwebsite ermitteln.";

describe("the research gate's turn trigger", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "sai-evidence-gate-"));
    const subAgents = Object.fromEntries(Object.entries(AGENTS).map(([name, cfg]) => [name, {
      description: `${name} test agent`, systemPrompt: "Test.", maxIterations: 4, ...cfg,
    }]));
    // A scene its one leaf agent runs alone (the "Use <agent> to" bootstrap), so it runs through the
    // mocked runner rather than a nested turn.
    const scenes = {
      company_facts: {
        description: "Reads a company's own website for its founding year and headcount.",
        task: "Use researcher to read the company's website and report its founding year and headcount.",
        allowedAgents: ["researcher"],
      },
    };
    writeFileSync(join(tempDir, "starlingai.json"), JSON.stringify({ workspacePath: tempDir, subAgents, scenes }), "utf8");
    process.env["SAI_CONFIG_PATH"] = join(tempDir, "starlingai.json");
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
    runner.mockReset();
    runner.mockImplementation(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => ({
      output: `${args.agentName}: done`,
      stats: statsFor(args),
    }));
    audit.mockClear();
  });

  afterEach(async () => {
    vi.doUnmock("../tools/agent-routing.js");
    delete process.env["SAI_CONFIG_PATH"];
    (await import("../config/loader.js")).resetConfigForTests();
    await (await import("../swarm/memory.js")).resetSharedMemoryForTests();
    rmSync(tempDir, { recursive: true, force: true });
    vi.resetModules();
  });

  const ran = (): string[] => runner.mock.calls.map((call) => (call[0] as SubAgentRunOptions).agentName);
  const rows = (type: string): Array<Record<string, unknown>> =>
    audit.mock.calls.filter((call) => call[0] === type).map((call) => call[1] as Record<string, unknown>);
  const turnCtx = (sessionId: string, extra: Partial<ToolContext> = {}): ToolContext => ({
    sessionId,
    workspacePath: tempDir,
    swarmState: { objective: "t", startedAt: "", updatedAt: "", tasks: {} },
    turnEvidence: { required: true },
    ...extra,
  });
  const plan = (objective: string, steps: TurnPlan["steps"]): TurnPlan => ({
    objective, steps, acceptanceCriteria: [], stopConditions: [], riskTier: "high", wide: false, createdAt: new Date(0).toISOString(),
  });
  const executePlan = async (sessionId: string, recorded: TurnPlan, ctx: ToolContext) => {
    const [{ getTool }] = await Promise.all([import("../tools/registry.js"), import("../tools/sub-agent.js"), import("../tools/plan-executor.js")]);
    await (await import("../agent/turn-plan.js")).persistTurnPlan(sessionId, recorded);
    return getTool("execute_plan")!.execute({}, ctx);
  };

  it("redirects the live German web_coder step to researcher on a turn the judge flagged", async () => {
    const result = await executePlan("s-de", plan(GERMAN_OBJECTIVE, [{ id: "s1", kind: "delegate", agent: "web_coder", description: GERMAN_STEP }]), turnCtx("s-de"));

    expect(result.success).toBe(true);
    expect(ran()).toEqual(["researcher"]);
    expect(rows("delegation_explicit_redirected_research_incapable")).toEqual([
      expect.objectContaining({ requestedAgents: ["web_coder"], redirectedTo: "researcher", trigger: "turn_evidence" }),
    ]);
    expect(rows("delegation_research_candidate_selected")).toEqual([
      expect.objectContaining({ selected: "researcher", trigger: "turn_evidence" }),
    ]);
  }, 30_000);

  it("keeps the step on web_coder when the turn carries no verdict — the trigger is the judge, not the words", async () => {
    const ctx = turnCtx("s-no-verdict");
    delete ctx.turnEvidence;
    await executePlan("s-no-verdict", plan(GERMAN_OBJECTIVE, [{ id: "s1", kind: "delegate", agent: "web_coder", description: GERMAN_STEP }]), ctx);

    expect(ran()).toEqual(["web_coder"]);
  }, 30_000);

  it("still redirects the English twin (dee3be85), and says the task's words armed it", async () => {
    await executePlan("s-en", plan(
      "Find the founding date and number of employees of Nordlicht Werkzeuge GmbH from their website.",
      [{ id: "s1", kind: "delegate", agent: "web_coder", description: "Fetch the company website and extract founding date and employee count" }],
    ), turnCtx("s-en"));

    expect(ran()).toEqual(["researcher"]);
    expect(rows("delegation_explicit_redirected_research_incapable")).toEqual([
      expect.objectContaining({ redirectedTo: "researcher", trigger: "task_text" }),
    ]);
  }, 30_000);

  it("leaves a builder alone when the plan names its own gatherer — even in the same parallel group", async () => {
    await executePlan("s-group", plan(GERMAN_OBJECTIVE, [
      { id: "s1", kind: "delegate", agent: "researcher", description: "Die Website abrufen und die Angaben belegen.", parallelGroup: 1 },
      { id: "s2", kind: "delegate", agent: "web_coder", description: "Eine Übersichtsseite mit den Angaben bauen.", parallelGroup: 1 },
    ]), turnCtx("s-group"));

    expect(ran().sort()).toEqual(["researcher", "web_coder"]);
    expect(rows("delegation_explicit_redirected_research_incapable")).toEqual([]);
  }, 30_000);

  it("leaves a builder alone when it depends on the gathering step", async () => {
    await executePlan("s-chain", plan(GERMAN_OBJECTIVE, [
      { id: "s1", kind: "delegate", agent: "researcher", description: "Die Website abrufen und die Angaben belegen." },
      { id: "s2", kind: "delegate", agent: "web_coder", description: "Eine Übersichtsseite mit den Angaben bauen.", dependsOn: ["s1"] },
    ]), turnCtx("s-chain"));

    expect(ran()).toEqual(["researcher", "web_coder"]);
  }, 30_000);

  // A build verb outside the gate's bilingual mutation list, so the render exemption cannot be what
  // keeps a builder on its step — the mechanism under test has to.
  const FRENCH_BUILD = "Construire une page de synthèse avec ces informations.";

  it("leaves a builder alone when the plan's gatherer comes LATER in plan order (the plan is the batch, not the round)", async () => {
    await executePlan("s-later", plan(GERMAN_OBJECTIVE, [
      { id: "s1", kind: "delegate", agent: "web_coder", description: FRENCH_BUILD },
      { id: "s2", kind: "delegate", agent: "researcher", description: GERMAN_STEP },
    ]), turnCtx("s-later"));

    expect(ran()).toEqual(["web_coder", "researcher"]);
  }, 30_000);

  it("leaves a builder alone when the plan reaches outside by other means: a workflow step, or a web tool it calls itself", async () => {
    await import("../tools/workflow-catalog.js");
    await executePlan("s-reuse", plan(GERMAN_OBJECTIVE, [
      { id: "s1", kind: "delegate", agent: "web_coder", description: FRENCH_BUILD },
      { id: "s2", kind: "reuse", workflow: "company_facts", description: "Die Angaben über den gespeicherten Ablauf holen.", dependsOn: ["s1"] },
    ]), turnCtx("s-reuse"));
    // A turn that may call web_fetch. No such tool is registered here, so the step fails when it is
    // reached: only its place in the plan counts.
    await executePlan("s-direct", plan(GERMAN_OBJECTIVE, [
      { id: "s1", kind: "delegate", agent: "web_coder", description: FRENCH_BUILD },
      { id: "s2", kind: "direct", tool: "web_fetch", toolArgs: { url: "http://www.nordlicht-werkzeuge.test/" }, description: "Die Website abrufen.", dependsOn: ["s1"] },
    ]), turnCtx("s-direct", { allowedTools: ["delegate_to_agent", "web_fetch"] }));

    // web_coder, then the workflow's own agent; web_coder again for the second plan.
    expect(ran()).toEqual(["web_coder", "researcher", "web_coder"]);
  }, 30_000);

  /** What a turn the judge flagged may call: its tool mode is orchestration_only, which offers no web tool and loads none. */
  const judgedTurnTools = async (): Promise<Partial<ToolContext>> => {
    const tools = await import("../agent/default-tools.js");
    const { isWebReachingToolName } = await import("../tools/agent-routing.js");
    // The premise, read from the lists themselves: the getters below leave out every tool this file
    // never registers, web_fetch included, so they cannot show it.
    expect([...tools.ALWAYS_AVAILABLE_MAIN_TOOL_NAMES, ...tools.ORCHESTRATION_TOOL_NAMES].filter(isWebReachingToolName)).toEqual([]);
    return { allowedTools: tools.getMainAssistantToolNames("orchestration_only"), loadableTools: tools.getLoadableDirectMainToolNames("orchestration_only") };
  };

  // 2f31f387 again, behind an outside step that never runs: counted as the plan's own way out, it
  // exempted every step, and web_coder kept the fetch it cannot do.
  it("redirects the step when the plan's web-tool step is one this turn may not call", async () => {
    await Promise.all([import("../tools/sub-agent.js"), import("../tools/workflow-catalog.js")]);
    const tools = await judgedTurnTools();
    const result = await executePlan("s-fetch-refused", plan(GERMAN_OBJECTIVE, [
      { id: "s1", kind: "direct", tool: "web_fetch", toolArgs: { url: "http://www.nordlicht-werkzeuge.test/" }, description: "Die Website abrufen." },
      { id: "s2", kind: "delegate", agent: "web_coder", description: GERMAN_STEP },
    ]), turnCtx("s-fetch-refused", tools));

    expect(result.output).toContain("'web_fetch' is not in this agent's allowed tool set");
    expect(ran()).toEqual(["researcher"]);
  }, 30_000);

  it("redirects the step when the plan's reuse step names no workflow, or one that does not exist", async () => {
    await Promise.all([import("../tools/sub-agent.js"), import("../tools/workflow-catalog.js")]);
    const tools = await judgedTurnTools();
    await executePlan("s-reuse-unnamed", plan(GERMAN_OBJECTIVE, [
      { id: "s1", kind: "reuse", description: "Den gespeicherten Ablauf für Firmenangaben nutzen." },
      { id: "s2", kind: "delegate", agent: "web_coder", description: GERMAN_STEP },
    ]), turnCtx("s-reuse-unnamed", tools));
    const unknown = await executePlan("s-reuse-unknown", plan(GERMAN_OBJECTIVE, [
      { id: "s1", kind: "reuse", workflow: "firmen_recherche", description: "Den gespeicherten Ablauf für Firmenangaben nutzen." },
      { id: "s2", kind: "delegate", agent: "web_coder", description: GERMAN_STEP },
    ]), turnCtx("s-reuse-unknown", tools));

    expect(unknown.output).toContain('no workflow named "firmen_recherche" exists');
    expect(ran()).toEqual(["researcher", "researcher"]);
  }, 30_000);

  /**
   * Every run writes a file, so a writer's report counts as done and the step after it runs, and
   * the researcher records what it found as a shared fact, as the real one does.
   */
  const agentsDeliver = () => runner.mockImplementation(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => ({
    output: args.agentName === "researcher" ? "researcher: done\nFACT: founding_year = 1987 (impressum)" : `${args.agentName}: done`,
    stats: { ...statsFor(args), toolNames: ["write_file"] },
  }));

  // The scheduler runs a plan by its dependsOn edges, not in the order the model listed the steps.
  // Picked in list order, the gather point was the final build here: the report ran first, exempt and
  // without evidence, and then the build was sent to research — neither deliverable was made.
  it("gathers at the first handed-text step the plan RUNS, not the first it lists", async () => {
    agentsDeliver();
    // The build is handed the report's result, the redirect's routing note included. That note's
    // wording arms the gate's English task-text trigger, which stays out only for a build that
    // renders facts already shared (the render exemption) — with or without a verdict. Hence a build
    // verb the exemption knows here, not FRENCH_BUILD.
    await executePlan("s-run-order", plan(GERMAN_OBJECTIVE, [
      { id: "s1", kind: "delegate", agent: "web_coder", description: "Eine Übersichtsseite mit den Angaben bauen.", dependsOn: ["s2"] },
      { id: "s2", kind: "delegate", agent: "content_writer", description: "Die Angaben als kurzen Bericht schreiben." },
    ]), turnCtx("s-run-order"));

    expect(ran()).toEqual(["researcher", "web_coder"]);
    expect(rows("delegation_explicit_redirected_research_incapable")).toEqual([
      expect.objectContaining({ requestedAgents: ["content_writer"], redirectedTo: "researcher", trigger: "turn_evidence" }),
    ]);
  }, 30_000);

  it("does not hold the gather point for a step waiting on the orchestrator's own work", async () => {
    agentsDeliver();
    const ctx = turnCtx("s-waiting");
    // s1 is the orchestrator's own (no tool), so s2 waits for the next execute_plan call and s3 runs
    // first. Held by s2, the gather point let the report run without evidence, and the build was then
    // sent to research when the orchestrator came back.
    await executePlan("s-waiting", plan(GERMAN_OBJECTIVE, [
      { id: "s1", kind: "direct", description: "Den Aufbau der Seite festlegen." },
      { id: "s2", kind: "delegate", agent: "web_coder", description: FRENCH_BUILD, dependsOn: ["s1"] },
      { id: "s3", kind: "delegate", agent: "content_writer", description: "Die Angaben als kurzen Bericht schreiben." },
    ]), ctx);
    const { getTool } = await import("../tools/registry.js");
    await getTool("execute_plan")!.execute({ completed: ["s1"] }, ctx);

    expect(ran()).toEqual(["researcher", "web_coder"]);
  }, 30_000);

  it("leaves a builder slice alone when a sibling slice gathers, whichever finishes its checks first", async () => {
    const { getTool } = await import("../tools/registry.js");
    await import("../tools/sub-agent.js");
    await getTool("parallel_delegate")!.execute({ tasks: [
      { agentName: "web_coder", task: FRENCH_BUILD },
      { agentName: "researcher", task: "Find the official website and its pricing page." },
    ] }, turnCtx("s-slices"));

    expect(ran().sort()).toEqual(["researcher", "web_coder"]);
  }, 30_000);

  it("never touches an agent with an outside source of its own (mailbox), or with a local source (codebase)", async () => {
    // Called by hand, not through a plan: the gate's own eligibility check is the only filter here.
    const { getTool } = await import("../tools/registry.js");
    await import("../tools/sub-agent.js");
    await getTool("delegate_to_agent")!.execute({ agentName: "mail_agent", task: GERMAN_STEP }, turnCtx("s-mail"));
    await getTool("delegate_to_agent")!.execute({ agentName: "code_analyst", task: GERMAN_STEP }, turnCtx("s-code"));

    expect(ran()).toEqual(["mail_agent", "code_analyst"]);
  }, 30_000);

  it("leaves the builder alone once the session already holds shared facts", async () => {
    await (await import("../swarm/memory.js")).writeSharedFact("s-facts", "founding_year", "1987 (impressum)");
    await executePlan("s-facts", plan(GERMAN_OBJECTIVE, [{ id: "s1", kind: "delegate", agent: "web_coder", description: FRENCH_BUILD }]), turnCtx("s-facts"));

    expect(ran()).toEqual(["web_coder"]);
  }, 30_000);

  it("redirects once per turn: the plan's first handed-text step only", async () => {
    await executePlan("s-two", plan(GERMAN_OBJECTIVE, [
      { id: "s1", kind: "delegate", agent: "web_coder", description: GERMAN_STEP },
      { id: "s2", kind: "delegate", agent: "content_writer", description: "Die Angaben als kurzen Bericht schreiben." },
    ]), turnCtx("s-two"));

    expect(ran()).toEqual(["researcher", "content_writer"]);
  }, 30_000);

  it("keeps a later delegation on its agent once the turn has engaged an outside source (no facts shared)", async () => {
    const { getTool } = await import("../tools/registry.js");
    await import("../tools/sub-agent.js");
    const ctx = turnCtx("s-latch");
    await getTool("delegate_to_agent")!.execute({ agentName: "researcher", task: "Die Website abrufen und die Angaben belegen." }, ctx);
    await getTool("delegate_to_agent")!.execute({ agentName: "web_coder", task: FRENCH_BUILD }, ctx);

    expect(ran()).toEqual(["researcher", "web_coder"]);
    expect(ctx.turnEvidence?.outsideEngaged).toBe("researcher");
  }, 30_000);

  it("keeps a later delegation on its agent once an outside agent ran as a FALLBACK (the dispatch claims the turn's outside source)", async () => {
    // web_coder fails and researcher, named only as its fallback, takes the step. The claim made
    // when a delegation is decided names the first agent asked for (web_coder), so only the claim at
    // dispatch records that researcher ran, and with no facts shared it is all that holds the next
    // builder on its step.
    let webCoderRuns = 0;
    runner.mockImplementation(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => {
      const failed = args.agentName === "web_coder" && webCoderRuns++ === 0;
      return {
        output: failed ? "web_coder: could not finish the page." : `${args.agentName}: done`,
        stats: { ...statsFor(args), toolNames: ["write_file"], ...(failed ? { outcome: "failure" as const } : {}) },
      };
    });
    const { getTool } = await import("../tools/registry.js");
    await import("../tools/sub-agent.js");
    const ctx = turnCtx("s-fallback");
    await getTool("delegate_to_agent")!.execute({ agentName: "web_coder", fallbackAgents: ["researcher"], task: FRENCH_BUILD }, ctx);
    await getTool("delegate_to_agent")!.execute({ agentName: "web_coder", task: GERMAN_STEP }, ctx);

    expect(ran()).toEqual(["web_coder", "researcher", "web_coder"]);
    expect(ctx.turnEvidence?.outsideEngaged).toBe("researcher");
  }, 30_000);

  it("redirects one of two delegations racing through the gate, never both", async () => {
    // The runtime dispatches one response's calls in order; this pins the re-read of the turn's
    // outside source after the facts read for any caller that does not.
    const { getTool } = await import("../tools/registry.js");
    await import("../tools/sub-agent.js");
    const ctx = turnCtx("s-race");
    await Promise.all([
      getTool("delegate_to_agent")!.execute({ agentName: "web_coder", task: GERMAN_STEP }, ctx),
      getTool("delegate_to_agent")!.execute({ agentName: "content_writer", task: "Die Angaben als kurzen Bericht schreiben." }, ctx),
    ]);

    expect(ran().filter((agent) => agent === "researcher")).toHaveLength(1);
    expect(rows("delegation_explicit_redirected_research_incapable")).toHaveLength(1);
  }, 30_000);

  // A catalog agent's dispatch is not the only way a turn reaches outside. A workflow's agents, and
  // an ephemeral agent (no catalog taxonomy, so it counts as reaching outside), never pass that
  // dispatch — each claims the turn's outside source itself. The mocked runs share no facts, so
  // without the claim the facts guard cannot hold the builder either.
  it("keeps a builder on its step after a workflow ran this turn", async () => {
    const { getTool } = await import("../tools/registry.js");
    await Promise.all([import("../tools/sub-agent.js"), import("../tools/workflow-catalog.js")]);
    const ctx = turnCtx("s-workflow");
    const workflow = await getTool("run_workflow")!.execute({ name: "company_facts", workflowType: "scene" }, ctx);
    await getTool("delegate_to_agent")!.execute({ agentName: "web_coder", task: FRENCH_BUILD }, ctx);

    expect(workflow.success).toBe(true);
    expect(ran()).toEqual(["researcher", "web_coder"]);
    expect(ctx.turnEvidence?.outsideEngaged).toBe("workflow:company_facts");
  }, 30_000);

  it("keeps a builder on its step after the orchestrator ran an ephemeral agent of its own", async () => {
    const { getTool } = await import("../tools/registry.js");
    await Promise.all([import("../tools/sub-agent.js"), import("../tools/ephemeral-agent-factory.js")]);
    const ctx = turnCtx("s-ephemeral");
    await getTool("create_ephemeral_agent")!.execute({
      agentName: "site_reader",
      description: "Reads one company's website.",
      systemPrompt: "You read the website and report what it states, with the page you read it on.",
      tools: ["web_search", "web_fetch"],
      task: GERMAN_STEP,
    }, ctx);
    await getTool("delegate_to_agent")!.execute({ agentName: "web_coder", task: FRENCH_BUILD }, ctx);

    expect(ran()).toEqual(["ephemeral:site_reader", "web_coder"]);
    expect(ctx.turnEvidence?.outsideEngaged).toBe("ephemeral:site_reader");
  }, 30_000);

  it("keeps a builder on its step after the architect fallback ran an ephemeral agent", async () => {
    runner.mockImplementation(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => ({
      output: args.agentName === "agent_architect"
        ? JSON.stringify({ agentName: "site_scout", description: "Reads one website.", systemPrompt: "Read the site and report.", tools: ["web_search", "web_fetch"], maxIterations: 3 })
        : `${args.agentName}: done`,
      stats: statsFor(args),
    }));
    const { getTool } = await import("../tools/registry.js");
    const [, { runArchitectFallback }] = await Promise.all([import("../tools/sub-agent.js"), import("../tools/ephemeral-agent-factory.js")]);
    const ctx = turnCtx("s-architect");
    const architect = await runArchitectFallback(GERMAN_STEP, ctx);
    await getTool("delegate_to_agent")!.execute({ agentName: "web_coder", task: FRENCH_BUILD }, ctx);

    expect(architect?.success).toBe(true);
    expect(ran()).toEqual(["agent_architect", "ephemeral:site_scout", "web_coder"]);
    expect(ctx.turnEvidence?.outsideEngaged).toBe("ephemeral:site_scout");
  }, 30_000);

  it("never dead-ends: with no research agent this turn may dispatch, the named agent keeps the step", async () => {
    const result = await executePlan("s-scoped", plan(GERMAN_OBJECTIVE, [{ id: "s1", kind: "delegate", agent: "web_coder", description: GERMAN_STEP }]),
      turnCtx("s-scoped", { allowedAgents: ["web_coder"] }));

    expect(result.metadata?.["failed"]).toBe(0);
    expect(ran()).toEqual(["web_coder"]);
    expect(rows("delegation_explicit_redirected_research_incapable")).toEqual([
      expect.objectContaining({ redirectedTo: null, trigger: "turn_evidence" }),
    ]);
  }, 30_000);

  it("applies the same rule to a delegation the orchestrator makes by hand, and to a lone parallel slice", async () => {
    const { getTool } = await import("../tools/registry.js");
    await import("../tools/sub-agent.js");
    await getTool("delegate_to_agent")!.execute({ agentName: "web_coder", task: GERMAN_STEP }, turnCtx("s-direct"));
    await getTool("parallel_delegate")!.execute({ tasks: [{ agentName: "web_coder", task: GERMAN_STEP }] }, turnCtx("s-slice"));
    await getTool("parallel_delegate")!.execute({ tasks: [
      { agentName: "researcher", task: "Die Website abrufen und die Angaben belegen." },
      { agentName: "web_coder", task: "Eine Übersichtsseite mit den Angaben bauen." },
    ] }, turnCtx("s-pair"));

    expect(ran().slice(0, 2)).toEqual(["researcher", "researcher"]);
    expect(ran().slice(2).sort()).toEqual(["researcher", "web_coder"]);
  }, 30_000);

  it("applies the plan's rule to a task graph: a lone builder node gathers, a builder beside a gathering node keeps its agent", async () => {
    const { getTool } = await import("../tools/registry.js");
    await import("../tools/sub-agent.js");
    await getTool("run_task_graph")!.execute({
      objective: GERMAN_OBJECTIVE,
      nodes: [{ id: "fetch", agentName: "web_coder", task: GERMAN_STEP }],
    }, turnCtx("s-graph-alone"));
    await getTool("run_task_graph")!.execute({
      objective: GERMAN_OBJECTIVE,
      nodes: [
        { id: "build", agentName: "web_coder", task: FRENCH_BUILD },
        { id: "fetch", agentName: "researcher", task: GERMAN_STEP, dependsOn: ["build"] },
      ],
    }, turnCtx("s-graph-pair"));

    expect(ran()).toEqual(["researcher", "web_coder", "researcher"]);
  }, 30_000);

  it("gathers at the first handed-text node a task graph STARTS, not the first it lists", async () => {
    agentsDeliver();
    const { getTool } = await import("../tools/registry.js");
    await import("../tools/sub-agent.js");
    await getTool("run_task_graph")!.execute({
      objective: GERMAN_OBJECTIVE,
      nodes: [
        { id: "build", agentName: "web_coder", task: FRENCH_BUILD, dependsOn: ["report"] },
        { id: "report", agentName: "content_writer", task: "Die Angaben als kurzen Bericht schreiben." },
      ],
    }, turnCtx("s-graph-order"));

    expect(ran()).toEqual(["researcher", "web_coder"]);
  }, 30_000);

  // ── An agent that only reads the open browser tab ──────────────────────────────────────────────
  // c172d755 (E2E 2026-10-08): search_agents ranked vision_browser_analyst first, the plan named it
  // for both site steps, and it read a page another session had left in the shared tab. It holds
  // browser_snapshot and browser_screenshot only; its taxonomy names the browser as its one surface.

  it("redirects a plan step naming the tab reader to researcher on a turn the judge flagged (c172d755)", async () => {
    await executePlan("s-tab", plan(GERMAN_OBJECTIVE, [{ id: "s1", kind: "delegate", agent: "vision_browser_analyst", description: GERMAN_STEP }]), turnCtx("s-tab"));

    expect(ran()).toEqual(["researcher"]);
    expect(rows("delegation_explicit_redirected_research_incapable")).toEqual([
      expect.objectContaining({ requestedAgents: ["vision_browser_analyst"], redirectedTo: "researcher", trigger: "turn_evidence" }),
    ]);
  }, 30_000);

  it("leaves the tab reader on its step behind browser_agent, and on a turn with no verdict", async () => {
    await executePlan("s-tab-behind", plan(GERMAN_OBJECTIVE, [
      { id: "s1", kind: "delegate", agent: "browser_agent", description: GERMAN_STEP },
      { id: "s2", kind: "delegate", agent: "vision_browser_analyst", description: "Die geöffnete Seite auslesen und die Angaben belegen.", dependsOn: ["s1"] },
    ]), turnCtx("s-tab-behind"));
    const ctx = turnCtx("s-tab-no-verdict");
    delete ctx.turnEvidence;
    await executePlan("s-tab-no-verdict", plan(GERMAN_OBJECTIVE, [{ id: "s1", kind: "delegate", agent: "vision_browser_analyst", description: GERMAN_STEP }]), ctx);

    expect(ran()).toEqual(["browser_agent", "vision_browser_analyst", "vision_browser_analyst"]);
    expect(rows("delegation_explicit_redirected_research_incapable")).toEqual([]);
  }, 30_000);

  // ── Routed delegations: no agent named, so the router's ranking picks it ──────────────────────

  /** The router's ranking for the live step (79dd29e0): the tab reader first, both gatherers right behind it. */
  const LIVE_SITE_RANKING = [
    { name: "vision_browser_analyst", score: 0.8555 },
    { name: "browser_agent", score: 0.8453 },
    { name: "researcher", score: 0.8099 },
  ];
  /** Stands in for the embedding router, which this file does not run: every pass returns `ranked`, minus the agents it excludes. */
  const routeAs = (ranked: ReadonlyArray<{ name: string; score: number }>) => vi.doMock("../tools/agent-routing.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../tools/agent-routing.js")>();
    return {
      ...actual,
      resolveAgentRouting: async (query: string, opts?: { minConfidence?: "high" | "medium" | "low"; excludeAgents?: string[] }) => ({
        query, minConfidence: opts?.minConfidence ?? "medium", mode: "hybrid" as const,
        results: ranked.filter((entry) => !(opts?.excludeAgents ?? []).includes(entry.name)).map((entry) => ({
          name: entry.name, description: `${entry.name} test agent`, model: "mock", confidence: "high" as const,
          score: entry.score, matchedTerms: [], capabilities: [], tags: [],
        })),
        weakCandidates: [], gated: false, trippedAgents: [], allLowConfidence: false, nearMisses: [],
      }),
    };
  });

  it("routes an English fetch-the-site task past the tab reader to browser_agent (the task's words arm the gate)", async () => {
    routeAs(LIVE_SITE_RANKING);
    const { getTool } = await import("../tools/registry.js");
    await import("../tools/sub-agent.js");
    const ctx = turnCtx("s-routed-en");
    delete ctx.turnEvidence;
    await getTool("delegate_to_agent")!.execute({ task: "Fetch http://www.nordlicht-werkzeuge.test/lager.html and find the stock figures on the website." }, ctx);

    expect(ran()).toEqual(["browser_agent"]);
  }, 30_000);

  /** The live 79dd29e0 step's shape: German, a URL to fetch, and an agent the catalog does not have. */
  const GERMAN_ROUTED_STEP = "Die URL http://www.nordlicht-werkzeuge.test/lager.html abrufen und den Lagerbestand aller Artikel zusammenzählen.";

  it("routes the live German step past the tab reader on a turn the judge flagged (79dd29e0)", async () => {
    routeAs(LIVE_SITE_RANKING);
    // web_crawler is not a configured agent: delegate_to_agent drops the name and the step is routed.
    const result = await executePlan("s-routed-de", plan(GERMAN_OBJECTIVE, [{ id: "s1", kind: "delegate", agent: "web_crawler", description: GERMAN_ROUTED_STEP }]), turnCtx("s-routed-de"));

    expect(result.success).toBe(true);
    expect(ran()).toEqual(["browser_agent"]);
    expect(rows("delegation_routing_filtered_research_incapable")).toEqual([
      expect.objectContaining({ droppedAgents: ["vision_browser_analyst"], redirectedTo: null, trigger: "turn_evidence" }),
    ]);
  }, 30_000);

  it("drops a routed builder for the next-ranked gatherer, and sends a step with no gatherer routed to researcher", async () => {
    const { getTool } = await import("../tools/registry.js");
    routeAs([{ name: "web_coder", score: 0.86 }, { name: "researcher", score: 0.81 }]);
    await import("../tools/sub-agent.js");
    await getTool("delegate_to_agent")!.execute({ task: GERMAN_STEP }, turnCtx("s-routed-builder"));
    vi.doUnmock("../tools/agent-routing.js");
    vi.resetModules();
    routeAs([{ name: "web_coder", score: 0.86 }, { name: "content_writer", score: 0.8 }]);
    const registry = await import("../tools/registry.js");
    await import("../tools/sub-agent.js");
    await registry.getTool("delegate_to_agent")!.execute({ task: GERMAN_STEP }, turnCtx("s-routed-writers"));

    expect(ran()).toEqual(["researcher", "researcher"]);
    expect(rows("delegation_routing_filtered_research_incapable")).toEqual([
      expect.objectContaining({ droppedAgents: ["web_coder"], redirectedTo: null, trigger: "turn_evidence" }),
      expect.objectContaining({ droppedAgents: ["web_coder", "content_writer"], redirectedTo: "researcher", trigger: "turn_evidence" }),
    ]);
  }, 30_000);

  it("keeps the gate armed for the delegation's later rounds once a routed gatherer fails", async () => {
    // browser_agent fails. Its dispatch claimed the turn's outside source, so a trigger decided
    // again on the next round would let the router hand the step to the tab reader.
    runner.mockImplementation(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => {
      const failed = args.agentName === "browser_agent";
      return {
        output: failed ? "browser_agent: the page did not load." : `${args.agentName}: done`,
        stats: { ...statsFor(args), ...(failed ? { outcome: "failure" as const } : {}) },
      };
    });
    routeAs([{ name: "vision_browser_analyst", score: 0.8555 }, { name: "browser_agent", score: 0.8453 }]);
    const { getTool } = await import("../tools/registry.js");
    await import("../tools/sub-agent.js");
    const ctx = turnCtx("s-routed-retry");
    await getTool("delegate_to_agent")!.execute({ task: GERMAN_ROUTED_STEP }, ctx);

    expect(ran()).toEqual(["browser_agent", "researcher"]);
  }, 30_000);

  it("leaves the router's pick alone with no verdict, for an agent with a source of its own, and once the turn has gathered", async () => {
    const { getTool } = await import("../tools/registry.js");
    routeAs(LIVE_SITE_RANKING);
    await import("../tools/sub-agent.js");
    const noVerdict = turnCtx("s-routed-no-verdict");
    delete noVerdict.turnEvidence;
    await getTool("delegate_to_agent")!.execute({ task: GERMAN_ROUTED_STEP }, noVerdict);
    await getTool("delegate_to_agent")!.execute({ task: GERMAN_ROUTED_STEP }, turnCtx("s-routed-engaged", { turnEvidence: { required: true, outsideEngaged: "researcher" } }));
    await (await import("../swarm/memory.js")).writeSharedFact("s-routed-facts", "lager_total", "596 (lager.html)");
    await getTool("delegate_to_agent")!.execute({ task: GERMAN_ROUTED_STEP }, turnCtx("s-routed-facts"));
    vi.doUnmock("../tools/agent-routing.js");
    vi.resetModules();
    routeAs([{ name: "mail_agent", score: 0.86 }, { name: "researcher", score: 0.81 }]);
    const registry = await import("../tools/registry.js");
    await import("../tools/sub-agent.js");
    await registry.getTool("delegate_to_agent")!.execute({ task: "Die Rechnung von Nordlicht im Postfach suchen und den Betrag nennen." }, turnCtx("s-routed-mail"));

    expect(ran()).toEqual(["vision_browser_analyst", "vision_browser_analyst", "vision_browser_analyst", "mail_agent"]);
    expect(rows("delegation_routing_filtered_research_incapable")).toEqual([]);
  }, 30_000);

  it("redirects one of two routed builder slices, not both: the first to decide claims the turn's gather", async () => {
    // Both slices route to web_coder. Each decides after its own awaits (routing, the fact read), and
    // the dispatch that used to claim the turn's outside source comes after more (lease, budget,
    // admission), so both decided first and both were sent to research: the build never ran.
    routeAs([{ name: "web_coder", score: 0.86 }, { name: "researcher", score: 0.81 }]);
    const { getTool } = await import("../tools/registry.js");
    await import("../tools/sub-agent.js");
    await getTool("parallel_delegate")!.execute({ tasks: [
      { task: FRENCH_BUILD },
      { task: "Construire une deuxième page avec ces informations." },
    ] }, turnCtx("s-routed-pair"));

    expect(ran().sort()).toEqual(["researcher", "web_coder"]);
    expect(rows("delegation_routing_filtered_research_incapable")).toEqual([
      expect.objectContaining({ droppedAgents: ["web_coder"], redirectedTo: null, trigger: "turn_evidence" }),
    ]);
  }, 30_000);

  it("leaves a routed builder slice alone when a sibling slice names its gatherer", async () => {
    routeAs([{ name: "web_coder", score: 0.86 }, { name: "researcher", score: 0.81 }]);
    const { getTool } = await import("../tools/registry.js");
    await import("../tools/sub-agent.js");
    await getTool("parallel_delegate")!.execute({ tasks: [
      { agentName: "researcher", task: "Die Website abrufen und die Angaben belegen." },
      { task: FRENCH_BUILD },
    ] }, turnCtx("s-routed-sibling"));

    expect(ran().sort()).toEqual(["researcher", "web_coder"]);
  }, 30_000);
});

describe("capability predicates behind the turn trigger", () => {
  it("reads reach from the routing taxonomy and never classifies what it cannot read", async () => {
    const { agentCfgReachesOutsideWorkspace, agentCfgWorksOnlyFromHandedText } = await import("../tools/agent-routing.js");
    expect(agentCfgWorksOnlyFromHandedText(AGENTS.web_coder as never)).toBe(true);
    expect(agentCfgWorksOnlyFromHandedText(AGENTS.content_writer as never)).toBe(true);
    expect(agentCfgReachesOutsideWorkspace(AGENTS.mail_agent as never)).toBe(true);
    expect(agentCfgWorksOnlyFromHandedText(AGENTS.mail_agent as never)).toBe(false);
    expect(agentCfgReachesOutsideWorkspace(AGENTS.code_analyst as never)).toBe(false);
    expect(agentCfgWorksOnlyFromHandedText(AGENTS.code_analyst as never)).toBe(false);
    expect(agentCfgReachesOutsideWorkspace(AGENTS.researcher as never)).toBe(true);
    // The tab reader: a browser surface, and nothing that opens a page.
    expect(agentCfgReachesOutsideWorkspace(AGENTS.vision_browser_analyst as never)).toBe(false);
    expect(agentCfgWorksOnlyFromHandedText(AGENTS.vision_browser_analyst as never)).toBe(true);
    expect(agentCfgReachesOutsideWorkspace(AGENTS.browser_agent as never)).toBe(true);
    expect(agentCfgWorksOnlyFromHandedText(AGENTS.browser_agent as never)).toBe(false);
    // A browser surface beside an outside source of its own still reaches out.
    expect(agentCfgReachesOutsideWorkspace({ ...AGENTS.vision_browser_analyst, routingGenerated: { ...label("GATHER", "browser", "image"), surface: ["browser", "user_channel"] } } as never)).toBe(true);
    // No taxonomy, no tool list, or no config at all: treated as reaching out — never redirected.
    expect(agentCfgReachesOutsideWorkspace({ tools: ["write_file"] })).toBe(true);
    expect(agentCfgReachesOutsideWorkspace({})).toBe(true);
    expect(agentCfgReachesOutsideWorkspace(undefined)).toBe(true);
    // A promoted agent is read raw, without the schema's defaults: a routing block with no surface.
    const rawPromoted = { tools: ["write_file"], routing: { mode: "PRODUCE", domain: ["software"], riskTier: "read_only", executionShape: "single_agent" } };
    expect(agentCfgReachesOutsideWorkspace(rawPromoted as never)).toBe(true);
    expect(agentCfgWorksOnlyFromHandedText(rawPromoted as never)).toBe(false);
  });

  it("picks one gather point per batch, and none when a member can reach outside", async () => {
    const { evidenceGatherPoint } = await import("../tools/agent-routing.js");
    // An unknown name reads back undefined, which is the case the last assertion pins.
    const lookup = (name: string) => AGENTS[name as keyof typeof AGENTS] as never;
    expect(evidenceGatherPoint(["web_coder"], lookup)).toBe(0);
    expect(evidenceGatherPoint(["web_coder", "content_writer"], lookup)).toBe(0);
    expect(evidenceGatherPoint(["code_analyst", "web_coder"], lookup)).toBe(1);
    expect(evidenceGatherPoint(["researcher", "web_coder"], lookup)).toBe(-1);
    expect(evidenceGatherPoint(["mail_agent", "web_coder"], lookup)).toBe(-1);
    expect(evidenceGatherPoint(["vision_browser_analyst"], lookup)).toBe(0);
    expect(evidenceGatherPoint(["browser_agent", "vision_browser_analyst"], lookup)).toBe(-1);
    expect(evidenceGatherPoint([undefined, "web_coder"], lookup)).toBe(-1); // routed step: routing decides
    expect(evidenceGatherPoint(["web_researcher"], lookup)).toBe(-1); // unknown name: routing decides
  });

  it("hands the verdict only to the orchestrator's own turn", async () => {
    const { turnEvidenceRequirement } = await import("../agent/turn-setup.js");
    expect(turnEvidenceRequirement({ upfrontSourceSensitive: true, channel: "eval", workflowDepth: 0 })).toEqual({ required: true });
    expect(turnEvidenceRequirement({ upfrontSourceSensitive: false, channel: "eval", workflowDepth: 0 })).toBeUndefined();
    expect(turnEvidenceRequirement({ upfrontSourceSensitive: true, channel: "workflow", workflowDepth: 0 })).toBeUndefined();
    // A queued scene or job (the scene worker's own turn, scheduled tasks included): no workflow
    // stack, but the workflow's author named its agents all the same.
    expect(turnEvidenceRequirement({ upfrontSourceSensitive: true, channel: "scene", workflowDepth: 0 })).toBeUndefined();
    expect(turnEvidenceRequirement({ upfrontSourceSensitive: true, channel: "eval", workflowDepth: 1 })).toBeUndefined();
    expect(turnEvidenceRequirement({ upfrontSourceSensitive: true, channel: "cli", workflowDepth: 0, directiveAgent: "web_coder" })).toBeUndefined();
  });
});
