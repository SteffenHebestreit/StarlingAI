import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INCIDENT,
  INCIDENT_ARTIFACT,
  INCIDENT_EXECUTIONS,
  MASKED_REPLY,
  incidentToolFailures,
} from "./support/figure-provenance-incident.js";

/**
 * THE TURN READS A DELEGATED RUN'S RECORD (E2E 2026-10-07).
 *
 * The coder's sandbox runs all failed or printed nothing, it stated two figures anyway, and the
 * single-deliverable relay shipped them to the user. The run now masks such figures and says so in
 * its record (specialistExecutions). The turn reads that record from the metadata: it does not
 * relay the run, does not continue a plan on top of it, asks for an honest answer instead of "the
 * orchestration is COMPLETE", and scores the turn partial.
 */

const streamMock = vi.hoisted(() => vi.fn());
const completeMock = vi.hoisted(() => vi.fn(async () => ({
  content: "synthesized",
  tool_calls: [],
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  finishReason: "stop",
})));
const logAuditMock = vi.hoisted(() => vi.fn());
/** What the stubbed delegate_to_agent returns, the queued results first; everything else is the real registry. */
type DelegationResult = { success: boolean; output: string; metadata: Record<string, unknown> };
const delegation = vi.hoisted(() => ({ result: null as null | DelegationResult, queue: [] as DelegationResult[] }));
/** The plan loadTurnPlan hands the turn, when a test records one. */
const recordedPlan = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("../providers/index.js", () => {
  const provider = {
    checkHealth: async () => ({ healthy: true }),
    verifyToolCallSupport: async () => true,
    complete: (...args: unknown[]) => completeMock(...(args as [])),
    stream: (...args: unknown[]) => streamMock(...(args as [])),
    embed: async () => [],
    isHealthy: () => true,
  };
  return {
    applyActiveModelPreset: (model: unknown) => model,
    getChatProvider: () => provider,
    getChatProviderWithOverride: () => provider,
    getChatProviderForTier: () => null,
    createChatProvider: () => provider,
    tierModelDefaults: (tier: string) => (tier === "routing" ? { enableThinking: false, reasoningEffort: "none" } : {}),
  };
});

vi.mock("../guardrails/rate-limiter.js", () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })) }));
vi.mock("../guardrails/input.js", () => ({
  checkInput: vi.fn(() => ({ allowed: true, detectedPatterns: [] })),
  checkToolOutput: vi.fn(() => ({ allowed: true })),
}));
vi.mock("../guardrails/moderation.js", () => ({
  moderateInputText: vi.fn(async () => null),
  moderateToolResultText: vi.fn(async () => null),
}));
vi.mock("../guardrails/output.js", () => ({ scanOutput: vi.fn((text: string) => ({ safe: true, redacted: text })) }));
vi.mock("../audit/logger.js", () => ({ logAudit: logAuditMock }));

vi.mock("../tools/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools/registry.js")>();
  return {
    ...actual,
    executeTool: vi.fn(async (name: string, args: Record<string, unknown>, ctx: never, meta?: never) => {
      const stubbed = name === "delegate_to_agent" ? (delegation.queue.shift() ?? delegation.result) : null;
      return stubbed ?? actual.executeTool(name, args, ctx, meta);
    }),
  };
});

vi.mock("../agent/turn-plan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agent/turn-plan.js")>();
  return { ...actual, loadTurnPlan: vi.fn(async () => recordedPlan.current) };
});

const COMPLETED = {
  agentName: "coder",
  taskId: "task_1",
  attemptedAgents: ["coder"],
  delegationSucceeded: true,
  delegationOutcome: "success",
  delegationVerdict: "heuristic",
  terminalState: "completed",
};
/** The incident's delegation as it comes back now: partial, masked, with the run's record. */
const MASKED_DELEGATION = {
  success: true,
  output: `[coder]: ${MASKED_REPLY}`,
  metadata: {
    ...COMPLETED,
    delegationOutcome: "partial",
    artifacts: [INCIDENT_ARTIFACT],
    specialistToolFailures: incidentToolFailures(),
    specialistExecutions: INCIDENT_EXECUTIONS,
  },
};
/** A coder whose script printed: the same table with the values it printed. */
const PRINTED_DELEGATION = {
  success: true,
  output: `[coder]: ${INCIDENT.reply.replace("8.393", "8.392").replace("7.597.648.268", "1.255.204.276")}`,
  metadata: { ...COMPLETED, specialistExecutions: { attempted: 1, failed: 0, succeededWithOutput: 1 } },
};
const HONEST_ANSWER = "Ich konnte die Zahlen nicht berechnen: generated/primes.js ist geschrieben, aber keine der sieben "
  + "Ausführungen in der Sandbox lieferte eine Ausgabe (vier endeten mit Exit-Code 1, drei gaben nichts aus).";
/** content_writer's finished report, from the same turn as the coder that masked its figures. */
const REPORT_HTML = "<!doctype html><html><head><title>Primzahlen</title></head><body><h1>Bericht</h1><p>Das Sieb des Eratosthenes.</p></body></html>";
const REPORT_DELEGATION = {
  success: true,
  output: "[content_writer]: Der Bericht ist fertig: generated/report.html mit Einleitung und Fazit.",
  metadata: {
    ...COMPLETED,
    agentName: "content_writer",
    taskId: "task_0",
    attemptedAgents: ["content_writer"],
    artifacts: [{
      filename: "report.html",
      outputPath: "generated/report.html",
      contentType: "text/html; charset=utf-8",
      previewMode: "html",
      sourceTool: "write_file",
      sourceAgent: "content_writer",
    }],
  },
};
const REPORT_THEN_COUNT_PLAN = {
  objective: "a report on the primes, and their count from a script",
  steps: [
    { id: "s1", description: "write the report", kind: "delegate", agent: "content_writer" },
    { id: "s2", description: "count the primes with a script", kind: "delegate", agent: "coder" },
  ],
  acceptanceCriteria: [],
  stopConditions: [],
  riskTier: "low",
  wide: false,
  createdAt: new Date().toISOString(),
};
const TWO_STEP_PLAN = {
  objective: "count and sum the primes, then explain the method",
  steps: [
    { id: "s1", description: "compute count and sum with a script", kind: "delegate", agent: "coder" },
    { id: "s2", description: "explain the sieve used", kind: "delegate", agent: "content_writer" },
  ],
  acceptanceCriteria: ["both numbers come from the script"],
  stopConditions: [],
  riskTier: "low",
  wide: false,
  createdAt: new Date().toISOString(),
};

function toolCallStream(id: string, name: string, args: Record<string, unknown>) {
  return (async function* () {
    yield { type: "tool_call_start", toolCallId: id, toolName: name };
    yield { type: "tool_call_delta", toolCallId: id, argumentsDelta: JSON.stringify(args) };
    yield { type: "done", finishReason: "tool_calls", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  })();
}

function answerStream(text: string) {
  return (async function* () {
    yield { type: "text_delta", content: text };
    yield { type: "done", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  })();
}

/** Every message the given provider.stream call was sent, as one text. */
const promptOf = (callIndex: number): string =>
  ((streamMock.mock.calls[callIndex]?.[0] ?? []) as Array<{ content?: unknown }>)
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n");

const tempDirs: string[] = [];

/** A turn whose model delegates each of `delegations` in turn, then answers HONEST_ANSWER. A
 *  delegation naming `tool` calls that tool with `args` instead (execute_plan, for one). */
async function runTurnWith(
  orchestration: Record<string, unknown>,
  delegations: Array<{ id: string; agentName: string; task: string; tool?: string; args?: Record<string, unknown> }>,
) {
  const configDir = mkdtempSync(join(tmpdir(), "sai-figure-turn-"));
  const workspacePath = mkdtempSync(join(tmpdir(), "sai-figure-turn-ws-"));
  tempDirs.push(configDir, workspacePath);
  writeFileSync(join(configDir, "starlingai.json"), JSON.stringify({
    agents: { mainAssistant: { toolMode: "orchestration_only" } },
    orchestration,
  }), "utf8");
  // The files the agents wrote are on disk, as they were.
  mkdirSync(join(workspacePath, "generated"), { recursive: true });
  writeFileSync(join(workspacePath, "generated", "primes.js"), String(INCIDENT.calls[0]!.args["content"]), "utf8");
  writeFileSync(join(workspacePath, "generated", "report.html"), REPORT_HTML, "utf8");
  process.env["SAI_CONFIG_PATH"] = join(configDir, "starlingai.json");
  vi.resetModules();
  // The plan tools register on import, as register-builtins does in the gateway.
  await import("../tools/turn-plan-tool.js");
  const [{ AgentSession }, { runTurn }] = await Promise.all([
    import("../agent/session.js"),
    import("../agent/runtime.js"),
  ]);

  let call = 0;
  streamMock.mockImplementation(() => {
    const next = delegations[call];
    call += 1;
    return next
      ? toolCallStream(next.id, next.tool ?? "delegate_to_agent", next.args ?? { agentName: next.agentName, task: next.task })
      : answerStream(HONEST_ANSWER);
  });

  const session = new AgentSession({ channel: "test", workspacePath, systemPrompt: "You are a test agent." });
  const turn = await runTurn({ session, userMessage: INCIDENT.userMessage });
  return { session, turn };
}

async function runIncidentTurn(result: typeof MASKED_DELEGATION | typeof PRINTED_DELEGATION, orchestration: Record<string, unknown> = {}) {
  delegation.result = result;
  return runTurnWith(orchestration, [{ id: "call_coder", agentName: "coder", task: INCIDENT.task }]);
}

const synthesisDirectives = (session: { getHistory(): ReadonlyArray<{ role: string; content?: unknown }> }): string[] => session.getHistory()
  .filter((message) => message.role === "system" && String(message.content ?? "").startsWith("[SYNTHESIS REQUIRED]"))
  .map((message) => String(message.content));

const auditTypes = () => logAuditMock.mock.calls
  .filter(([event]) => event === "guardrail_flagged")
  .map(([, data]) => (data as Record<string, unknown>)["type"]);

describe("a turn whose delegated run masked figures no tool returned", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    streamMock.mockReset();
    completeMock.mockClear();
    logAuditMock.mockReset();
    delegation.result = null;
    delegation.queue = [];
    recordedPlan.current = null;
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("is not relayed: it is synthesized under an honest directive and scored partial", async () => {
    const { session, turn } = await runIncidentTurn(MASKED_DELEGATION);

    expect(streamMock).toHaveBeenCalledTimes(2);
    expect(turn.performance?.finishReason).not.toBe("single_deliverable_relayed");
    expect(turn.response).toContain("konnte die Zahlen nicht berechnen");
    const directives = session.getHistory()
      .filter((message) => message.role === "system" && String(message.content ?? "").startsWith("[SYNTHESIS REQUIRED]"))
      .map((message) => String(message.content));
    expect(directives).toHaveLength(1);
    expect(directives[0]).toContain("The delegated run of coder stated figures that no tool returned");
    expect(directives[0]).toContain("generated/primes.js");
    expect(directives[0]).not.toContain("is COMPLETE");
    expect(promptOf(1)).toContain("The delegated run of coder stated figures that no tool returned");
    expect(turn.qualityScorecard).toMatchObject({ outcomeStatus: "partial", partialOrFailureReason: "delegated_figures_unobserved" });
    expect(logAuditMock).toHaveBeenCalledWith(
      "guardrail_flagged",
      expect.objectContaining({ type: "delegated_figures_unobserved", agents: ["coder"], unobservedFigures: 2 }),
      expect.anything(),
    );
  });

  it("is named as the masked run's files only; another agent's finished file stays a deliverable", async () => {
    // In review, content_writer finished generated/report.html, then the coder masked its figures,
    // and the directive told the orchestrator to present both files as the coder's, written but
    // not run successfully.
    recordedPlan.current = REPORT_THEN_COUNT_PLAN;
    delegation.queue = [REPORT_DELEGATION, MASKED_DELEGATION];
    const { session } = await runTurnWith({ planDrivenContinuation: true }, [
      { id: "call_writer", agentName: "content_writer", task: "Schreibe den Bericht über die Primzahlen." },
      { id: "call_coder", agentName: "coder", task: INCIDENT.task },
    ]);

    const directives = synthesisDirectives(session);
    expect(directives).toHaveLength(1);
    expect(directives[0]).toContain("The delegated run of coder stated figures that no tool returned");
    expect(directives[0]).toContain("name the files it wrote (generated/primes.js) as written but not run successfully");
    expect(directives[0]).toContain("The turn's other deliverables are attached to this message as files (generated/report.html)");
  });

  it("is not a plan step the next one may build on", async () => {
    recordedPlan.current = TWO_STEP_PLAN;
    await runIncidentTurn(MASKED_DELEGATION, { planDrivenContinuation: true });

    expect(promptOf(1)).not.toContain("[CONTINUE PLAN]");
    expect(auditTypes()).not.toContain("plan_driven_continuation");
  });

  it("control: the same plan continues after a run whose script printed", async () => {
    recordedPlan.current = TWO_STEP_PLAN;
    await runIncidentTurn(PRINTED_DELEGATION, { planDrivenContinuation: true });

    expect(promptOf(1)).toContain("[CONTINUE PLAN]");
    expect(auditTypes()).toContain("plan_driven_continuation");
  });

  describe("inside execute_plan", () => {
    // In review execute_plan carried no record: the masked coder step was recorded done, its text
    // went to the next step as the result it depended on, and the turn scored itself complete
    // under "Copy the exact names, numbers, values … from the evidence".
    const REPORT_COUNT_EXPLAIN = {
      ...REPORT_THEN_COUNT_PLAN,
      steps: [
        ...REPORT_THEN_COUNT_PLAN.steps,
        { id: "s3", description: "explain the count", kind: "delegate", agent: "content_writer", dependsOn: ["s2"] },
      ],
      // Recorded in this turn: execute_plan refuses a plan older than the turn.
      createdAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const executePlan = [{ id: "call_plan", agentName: "", task: "", tool: "execute_plan", args: {} }];

    it("names the masked step's run and its file only, and its dependent never runs on it", async () => {
      recordedPlan.current = REPORT_COUNT_EXPLAIN;
      delegation.queue = [REPORT_DELEGATION, MASKED_DELEGATION, REPORT_DELEGATION];
      const { session, turn } = await runTurnWith({}, executePlan);

      // s1 and s2 ran; s3 depended on the masked count and did not.
      expect(delegation.queue).toHaveLength(1);
      const directives = synthesisDirectives(session);
      expect(directives).toHaveLength(1);
      expect(directives[0]).toContain("The delegated run of coder stated figures that no tool returned");
      expect(directives[0]).toContain("name the files it wrote (generated/primes.js) as written but not run successfully");
      expect(directives[0]).toContain("The turn's other deliverables are attached to this message as files (generated/report.html)");
      expect(turn.qualityScorecard).toMatchObject({ outcomeStatus: "partial", partialOrFailureReason: "delegated_figures_unobserved" });
    });

    it("control: a plan whose coder printed synthesizes as before", async () => {
      recordedPlan.current = REPORT_COUNT_EXPLAIN;
      delegation.queue = [REPORT_DELEGATION, PRINTED_DELEGATION, REPORT_DELEGATION];
      const { session, turn } = await runTurnWith({}, executePlan);

      expect(delegation.queue).toHaveLength(0);
      const directives = synthesisDirectives(session);
      expect(directives.join("\n")).not.toContain("stated figures that no tool returned");
      expect(turn.qualityScorecard?.partialOrFailureReason).not.toBe("delegated_figures_unobserved");
      expect(auditTypes()).not.toContain("delegated_figures_unobserved");
    });
  });

  it("control: a run whose script printed is relayed as before", async () => {
    const { turn } = await runIncidentTurn(PRINTED_DELEGATION);

    expect(streamMock).toHaveBeenCalledTimes(1);
    expect(turn.performance?.finishReason).toBe("single_deliverable_relayed");
    expect(turn.response).toContain("1.255.204.276");
    expect(auditTypes()).not.toContain("delegated_figures_unobserved");
  });
});
