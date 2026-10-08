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
    // The fetch is refused before it runs (outside this turn's tools): only its place in the plan counts.
    await executePlan("s-direct", plan(GERMAN_OBJECTIVE, [
      { id: "s1", kind: "delegate", agent: "web_coder", description: FRENCH_BUILD },
      { id: "s2", kind: "direct", tool: "web_fetch", toolArgs: { url: "http://www.nordlicht-werkzeuge.test/" }, description: "Die Website abrufen.", dependsOn: ["s1"] },
    ]), turnCtx("s-direct", { allowedTools: ["delegate_to_agent"] }));

    // web_coder, then the workflow's own agent; web_coder again for the second plan.
    expect(ran()).toEqual(["web_coder", "researcher", "web_coder"]);
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
    expect(evidenceGatherPoint([undefined, "web_coder"], lookup)).toBe(-1); // routed step: routing decides
    expect(evidenceGatherPoint(["web_researcher"], lookup)).toBe(-1); // unknown name: routing decides
  });

  it("hands the verdict only to the orchestrator's own turn", async () => {
    const { turnEvidenceRequirement } = await import("../agent/turn-setup.js");
    expect(turnEvidenceRequirement({ upfrontSourceSensitive: true, channel: "eval", workflowDepth: 0 })).toEqual({ required: true });
    expect(turnEvidenceRequirement({ upfrontSourceSensitive: false, channel: "eval", workflowDepth: 0 })).toBeUndefined();
    expect(turnEvidenceRequirement({ upfrontSourceSensitive: true, channel: "workflow", workflowDepth: 0 })).toBeUndefined();
    expect(turnEvidenceRequirement({ upfrontSourceSensitive: true, channel: "eval", workflowDepth: 1 })).toBeUndefined();
    expect(turnEvidenceRequirement({ upfrontSourceSensitive: true, channel: "cli", workflowDepth: 0, directiveAgent: "web_coder" })).toBeUndefined();
  });
});
