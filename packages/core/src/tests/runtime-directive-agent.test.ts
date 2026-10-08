import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `--agent NAME` delegates the turn to that agent (RunTurnOptions.directiveAgent, found by the E2E
 * suite 2026-10-07).
 *
 * The flag only narrowed allowedAgents to the one agent, and the orchestrator answered such a turn
 * itself: code_analyst never ran on two diagnoses the suite pinned to it, and the agent evaluations
 * that pin an agent the same way were measuring the orchestrator. Until that agent has run, the
 * turn's tool call is forced and a line names the agent.
 */

const streamMock = vi.hoisted(() => vi.fn());
const completeMock = vi.hoisted(() => vi.fn(async () => ({
  content: "synthesized",
  tool_calls: [],
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  finishReason: "stop",
})));
/** The routing-tier model: none by default, as when no routing tier is configured. */
const routingTier = vi.hoisted(() => ({ complete: null as null | ((messages: Array<{ content?: unknown }>) => Promise<unknown>) }));

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
    getChatProviderForTier: (tier: string) => (tier === "routing" && routingTier.complete
      ? { ...provider, complete: (messages: Array<{ content?: unknown }>) => routingTier.complete!(messages) }
      : null),
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
/** The audit log, kept so a test can read what a row recorded. */
const auditMock = vi.hoisted(() => vi.fn());
vi.mock("../audit/logger.js", () => ({ logAudit: auditMock }));
/** What document retrieval found for this turn's attachments; empty, as without engram, by default. */
const rag = vi.hoisted(() => ({ contextBlock: "" }));
vi.mock("../retrieval/document-rag.js", () => ({
  augmentTurnWithDocuments: async () => ({ ingested: rag.contextBlock ? 1 : 0, failed: 0, contextBlock: rag.contextBlock, retrievalUnavailable: false }),
}));

/**
 * The architect fallback, stubbed: it designs and runs an ephemeral agent when routing finds no
 * agent for an undirected delegation. Reached only through a real fan-out tool (realTools).
 */
const architectRuns = vi.hoisted(() => [] as string[]);
/** What the ephemeral agent answers: a short answer, unless a test sets a long one. */
const architectAnswer = vi.hoisted(() => ({ text: "" }));
vi.mock("../tools/ephemeral-agent-factory.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tools/ephemeral-agent-factory.js")>()),
  runArchitectFallback: vi.fn(async (task: string) => {
    architectRuns.push(task);
    return { success: true, output: `[menu_planner]: ${architectAnswer.text || "Starter, main and dessert for six."}`, metadata: { agentName: "menu_planner", ephemeral: true } };
  }),
}));

/**
 * A specialist's own run, stubbed for a test that sets `specialistRuns.stubbed` (one that runs the
 * real delegate_to_agent): `ran` holds the agents that ran, in order. Otherwise the real run.
 */
const specialistRuns = vi.hoisted(() => ({ stubbed: false, ran: [] as string[] }));
vi.mock("../agent/sub-agent.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agent/sub-agent.js")>();
  return {
    ...actual,
    runSubAgentWithStats: vi.fn(async (opts: Parameters<typeof actual.runSubAgentWithStats>[0]) => {
      if (!specialistRuns.stubbed) return actual.runSubAgentWithStats(opts);
      specialistRuns.ran.push(opts.agentName);
      return {
        output: `${opts.agentName.toUpperCase()}-FINDING: int() truncates the cent in invoices.py at line 12.`,
        stats: {
          agentName: opts.agentName, sessionId: `sub:${opts.agentName}`, promptChars: 0, userContentChars: 0, toolCount: 1, toolNames: ["read_file"],
          iterations: 1, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, maxIterations: 4, model: "mock", capabilities: [],
          terminalState: "completed", outcome: "success",
        },
      } as Awaited<ReturnType<typeof actual.runSubAgentWithStats>>;
    }),
  };
});

/**
 * The specialist and the orchestration tools around it, stubbed; everything else is the real
 * registry. `delegated` holds the delegations that reached a specialist. A delegation naming an
 * agent outside the turn's grant gets the refusal delegate_to_agent gives it. A test that needs a
 * real fan-out tool puts its name in `realTools`; its children then run the real delegation path,
 * and a delegate_to_agent call the turn makes is still stubbed, unless the test puts that name in
 * `realTools` as well.
 */
const delegated = vi.hoisted(() => [] as Array<Record<string, unknown>>);
/** What each delegate_to_agent call was handed beside its arguments (ToolContext.delegationDocuments). */
const handedDocuments = vi.hoisted(() => [] as Array<string | undefined>);
/** The tool context each delegate_to_agent call ran with: the turn's own, shared by every call. */
const delegationContexts = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const executed = vi.hoisted(() => [] as string[]);
const realTools = vi.hoisted(() => new Set<string>());
/** What a stubbed delegation that reached a specialist returns: a short finding, unless a test sets a long report. */
const specialistReport = vi.hoisted(() => ({ text: "" }));
vi.mock("../tools/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools/registry.js")>();
  return {
    ...actual,
    executeTool: vi.fn(async (name: string, args: Record<string, unknown>, ctx: { allowedAgents?: string[]; delegationDocuments?: string }, meta?: never) => {
      executed.push(name);
      if (name === "delegate_to_agent") {
        handedDocuments.push(ctx.delegationDocuments);
        delegationContexts.push(ctx as Record<string, unknown>);
      }
      if (realTools.has(name)) return actual.executeTool(name, args, ctx as never, meta);
      const agentName = String(args["agentName"] ?? "");
      if (name === "delegate_to_agent" && ctx.allowedAgents && !ctx.allowedAgents.includes(agentName)) {
        return { success: false, output: "", error: `Agent '${agentName}' is not permitted in this scene. Allowed agents: ${ctx.allowedAgents.join(", ")}` };
      }
      if (name === "delegate_to_agent" && String(args["task"] ?? "").includes("TIMES-OUT")) {
        // A run that ended without an answer, as executeDelegationWithFallback reports it: the
        // agents it attempted, and no agent the result is from.
        delegated.push(args);
        return {
          success: false,
          output: "",
          error: "Delegation for task 'Find the bug in invoices.py.' failed: No suitable agent completed the task.",
          metadata: { taskId: "task_1", attemptedAgents: [agentName], delegationSucceeded: false, delegationOutcome: "timeout_cascade", timeoutCascade: true, timedOutAgents: [agentName] },
        };
      }
      if (name === "delegate_to_agent") {
        delegated.push(args);
        return {
          success: true,
          output: specialistReport.text
            ? `[${agentName}]: ${specialistReport.text}`
            : `Delegated result from ${agentName} — TASK COMPLETED.\nObserved evidence:\nTRUNCATION-IN-INVOICES-AND-RECEIPTS`,
          metadata: { agentName, attemptedAgents: [agentName], delegationSucceeded: true, delegationOutcome: "success", terminalState: "completed" },
        };
      }
      if (name === "create_ephemeral_agent") {
        return { success: false, output: "", error: "Unknown tool(s) requested: nope.", rejectedBeforeEffect: true };
      }
      if (name === "parallel_delegate") {
        // Each slice runs its agent, reported as the tool reports it: one nested call per slice,
        // with the agents the slice's own result named.
        const slices = args["tasks"] as Array<{ agentName: string }>;
        return {
          success: true,
          output: "**[code_analyst]**:\nint() truncates the cent in invoices.py and receipts.py.",
          metadata: {
            taskCount: slices.length,
            succeeded: slices.length,
            failed: 0,
            nestedCalls: slices.map((slice) => ({ tool: "delegate_to_agent", success: true, agentName: slice.agentName, attemptedAgents: [slice.agentName] })),
          },
        };
      }
      if (name === "run_task_graph") {
        // Each node runs its agent, reported as the tool reports it: the node ids by outcome, the
        // agents each node's own result named, and each node's attempts in the swarm state.
        const nodes = args["nodes"] as Array<{ id: string; agentName: string }>;
        const startedAt = "2026-10-08T12:00:00.000Z";
        return {
          success: true,
          output: `Swarm task graph complete.\n${nodes.map((node) => `- ${node.id} [completed] ${node.agentName}`).join("\n")}`,
          metadata: {
            completed: nodes.map((node) => node.id),
            failed: [],
            blocked: [],
            nodeRuns: Object.fromEntries(nodes.map((node) => [node.id, { agentName: node.agentName, attemptedAgents: [node.agentName] }])),
            swarmState: {
              objective: "Swarm task graph",
              startedAt,
              updatedAt: startedAt,
              tasks: Object.fromEntries(nodes.map((node) => [node.id, {
                id: node.id,
                title: node.id,
                status: "completed",
                dependsOn: [],
                selectedAgent: node.agentName,
                attempts: [{ agentName: node.agentName, status: "completed", startedAt }],
              }])),
            },
          },
        };
      }
      if (name === "search_workflows") {
        return {
          success: true,
          output: "Workflow matches: code_review [scene] (0.82)",
          metadata: { workflowMatches: [{ name: "code_review", workflowType: "scene", score: 0.82, matchedTerms: ["code", "bug", "review"] }] },
        };
      }
      if (name === "run_workflow") {
        return {
          success: true,
          output: "Workflow code_review [scene] completed.\n\nThe review found that total() truncates with int(); use round(subtotal + tax, 2).",
          metadata: { workflowName: "code_review", workflowType: "scene", blocked: false, stepCount: 1, toolCallsExecuted: 3 },
        };
      }
      return actual.executeTool(name, args, ctx as never, meta);
    }),
  };
});

/** A response that calls one tool; `args` as a string is sent as the raw argument text. */
function toolStream(name: string, args: Record<string, unknown> | string) {
  return (async function* () {
    yield { type: "tool_call_start", toolCallId: `call_${name}`, toolName: name };
    yield { type: "tool_call_delta", toolCallId: `call_${name}`, argumentsDelta: typeof args === "string" ? args : JSON.stringify(args) };
    yield { type: "done", finishReason: "tool_calls", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  })();
}

function delegateStream() {
  return toolStream("delegate_to_agent", { agentName: "code_analyst", task: "Find the bug in invoices.py." });
}

function answerStream(text: string) {
  return (async function* () {
    yield { type: "text_delta", content: text };
    yield { type: "done", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  })();
}

/**
 * A long, structured deliverable: its delegation result is framed "Present the full content below
 * VERBATIM", and a turn whose one delegation returned it relays it as the answer.
 */
function longReport(title: string, subject: string): string {
  return [
    `# ${title}`,
    "",
    ...["Overview", "Findings", "Details"].flatMap((section, s) => [
      `## ${section}`,
      ...Array.from({ length: 8 }, (_v, i) => `- ${section} item ${s * 8 + i + 1}: ${subject}, item ${s * 8 + i + 1} written out in full.`),
      "",
    ]),
  ].join("\n");
}

const CODE_ANALYST = {
  description: "Analyzes source code and finds bugs.",
  capabilities: ["code analysis"],
  tags: ["code"],
  tools: ["read_file"],
  maxIterations: 4,
};

async function loadRuntime(extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sai-directive-"));
  writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
    agents: { mainAssistant: { toolMode: "orchestration_only" } },
    ...extra,
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
  vi.resetModules();
  const { AgentSession } = await import("../agent/session.js");
  const { runTurn } = await import("../agent/runtime.js");
  return { AgentSession, runTurn };
}

/** Every message the given provider.stream call was sent, as one text. */
const promptOf = (callIndex: number): string =>
  ((streamMock.mock.calls[callIndex]?.[0] ?? []) as Array<{ content?: unknown }>)
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n");
/** The tool choice the given provider.stream call was made with. */
const toolChoiceOf = (callIndex: number): unknown =>
  (streamMock.mock.calls[callIndex]?.[3] as { toolChoice?: unknown } | undefined)?.toolChoice;
/** The tool-call prefill the given provider.stream call asked for. */
const prefillOf = (callIndex: number): unknown =>
  (streamMock.mock.calls[callIndex]?.[3] as { prefillToolCall?: unknown } | undefined)?.prefillToolCall;

const MESSAGE = "Why does invoices.py undercharge by a cent? def total(subtotal, tax): return int(subtotal + tax)";
const DIRECTIVE_LINE = 'directed this request to the agent "code_analyst"';
const ANSWER = "Both files truncate with int(); round instead. MODEL-ANSWER";

describe("a turn the user directed to one agent", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    streamMock.mockReset();
    completeMock.mockClear();
    delegated.length = 0;
    handedDocuments.length = 0;
    delegationContexts.length = 0;
    auditMock.mockClear();
    executed.length = 0;
    rag.contextBlock = "";
    routingTier.complete = null;
    realTools.clear();
    architectRuns.length = 0;
    architectAnswer.text = "";
    specialistReport.text = "";
    specialistRuns.stubbed = false;
    specialistRuns.ran.length = 0;
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
  });

  it("forces the delegation to that agent, then answers freely from its result", async () => {
    const { AgentSession, runTurn } = await loadRuntime();
    let call = 0;
    streamMock.mockImplementation(() => {
      call += 1;
      return call === 1 ? delegateStream() : answerStream("Both files truncate with int(); round instead.");
    });

    const session = new AgentSession({ channel: "test", workspacePath: mkdtempSync(join(tmpdir(), "sai-directive-ws-")), systemPrompt: "You are a test agent." });
    await runTurn({ session, userMessage: MESSAGE, allowedAgents: ["code_analyst"], directiveAgent: "code_analyst" });

    expect(toolChoiceOf(0)).toBe("required");
    expect(promptOf(0)).toContain(DIRECTIVE_LINE);
    // The call has one right answer, so the prefill names it: under "required" alone the local
    // model wrote 13,000 characters of prose here (2026-10-07). No agentName is prefilled — the
    // tool requires only `task`, and the grammar puts required parameters first.
    expect(prefillOf(0)).toEqual({ tool: "delegate_to_agent" });
    expect(delegated).toHaveLength(1);
    // Delegated: the answer is the model's own again.
    expect(toolChoiceOf(1)).toBeUndefined();
    expect(prefillOf(1)).toBeUndefined();
    expect(promptOf(1)).not.toContain(DIRECTIVE_LINE);
  });

  it("dispatches the delegation itself when the model answers in prose anyway", async () => {
    // Live, the local model wrote 13,000 characters of prose under `tool_choice: required`, and the
    // turn shipped them (E2E, 2026-10-07).
    const { AgentSession, runTurn } = await loadRuntime();
    let call = 0;
    streamMock.mockImplementation(() => {
      call += 1;
      return call === 1
        ? answerStream("int() truncates; use round(). I answered this myself instead of delegating.")
        : answerStream("Both files truncate with int(); round instead.");
    });

    const session = new AgentSession({ channel: "test", workspacePath: mkdtempSync(join(tmpdir(), "sai-directive-ws-")), systemPrompt: "You are a test agent." });
    const result = await runTurn({ session, userMessage: MESSAGE, allowedAgents: ["code_analyst"], directiveAgent: "code_analyst" });

    expect(delegated).toHaveLength(1);
    expect(delegated[0]).toMatchObject({ agentName: "code_analyst", task: MESSAGE });
    // A first turn without attachments has nothing to add to the request.
    expect(delegated[0]).not.toHaveProperty("context");
    expect(result.response).not.toContain("I answered this myself");
  });

  it("streams none of the prose it replaces with the delegation", async () => {
    // The prose was held back while the response might still call a tool, then flushed to the
    // user when none came: a draft the turn discarded a moment later (review of a3773aa, 2026-10-08).
    const { AgentSession, runTurn } = await loadRuntime();
    let call = 0;
    streamMock.mockImplementation(() => {
      call += 1;
      return call === 1
        ? answerStream("DRAFT: int() truncates; use round(). I answered this myself instead of delegating.")
        : answerStream("Both files truncate with int(); round instead.");
    });
    const streamed: string[] = [];

    const session = new AgentSession({ channel: "test", workspacePath: mkdtempSync(join(tmpdir(), "sai-directive-ws-")), systemPrompt: "You are a test agent." });
    await runTurn({ session, userMessage: MESSAGE, allowedAgents: ["code_analyst"], directiveAgent: "code_analyst", onChunk: (text) => streamed.push(text) });

    expect(delegated).toHaveLength(1);
    expect(streamed.join("")).not.toContain("DRAFT");
  });

  // The dispatch handed the agent the bare request, and a specialist starts from its task and
  // context alone (review of a3773aa, 2026-10-08).
  it("hands the named agent the excerpts of the attached file the orchestrator was shown", async () => {
    // The upload reaches the turn only as the orchestrator's [DOCUMENT CONTEXT] message, and its
    // path is never given to the model (E2E core-build-data-csv-total).
    rag.contextBlock = ["umsatz-q3-2026.csv", "Monat;Gebiet;Umsatz", "Jul;Nord;18432", "Aug;Nord;18011", "Sep;West;15400"].join("\n");
    const { AgentSession, runTurn } = await loadRuntime();
    let call = 0;
    streamMock.mockImplementation(() => {
      call += 1;
      return call === 1 ? answerStream("Der Gesamtumsatz beträgt 51843 EUR.") : answerStream(ANSWER);
    });

    const session = new AgentSession({ channel: "test", workspacePath: mkdtempSync(join(tmpdir(), "sai-directive-ws-")), systemPrompt: "You are a test agent." });
    await runTurn({
      session,
      userMessage: "Im Anhang ist umsatz-q3-2026.csv. Wie hoch ist der Gesamtumsatz des Quartals?",
      userAttachments: [{ filename: "umsatz-q3-2026.csv", path: "uploads/s/1-umsatz-q3-2026.csv", mimeType: "text/csv", size: 300 }] as never,
      allowedAgents: ["data_analyst"],
      directiveAgent: "data_analyst",
    });

    expect(delegated).toHaveLength(1);
    expect(delegated[0]).toMatchObject({ agentName: "data_analyst" });
    expect(handedDocuments[0]).toContain("Jul;Nord;18432");
  });

  it("keeps the attached file's excerpts out of the dispatched call, so they do not outlive the turn", async () => {
    // The excerpts went into the dispatched call's `context` argument, and the call is kept: in the
    // session history and the audited tool_call_requested row. The [DOCUMENT CONTEXT] note they came
    // from is pruned at the next turn so a document does not outlive the turn it was attached to,
    // and the arguments still held a CSV's rows after the next turn (review of bf095a1, 2026-10-08).
    const ROW = "Jul;Nord;18432";
    rag.contextBlock = ["umsatz-q3-2026.csv", "Monat;Gebiet;Umsatz", ROW, "Aug;Nord;18011"].join("\n");
    const { AgentSession, runTurn } = await loadRuntime();
    let call = 0;
    streamMock.mockImplementation(() => {
      call += 1;
      return call === 1 ? answerStream("Der Gesamtumsatz beträgt 36443 EUR.") : answerStream(ANSWER);
    });

    const session = new AgentSession({ channel: "test", workspacePath: mkdtempSync(join(tmpdir(), "sai-directive-ws-")), systemPrompt: "You are a test agent." });
    await runTurn({
      session,
      userMessage: "Im Anhang ist umsatz-q3-2026.csv. Wie hoch ist der Gesamtumsatz des Quartals?",
      userAttachments: [{ filename: "umsatz-q3-2026.csv", path: "uploads/s/1-umsatz-q3-2026.csv", mimeType: "text/csv", size: 300 }] as never,
      allowedAgents: ["data_analyst"],
      directiveAgent: "data_analyst",
    });
    // The next turn, without the attachment, prunes the note.
    rag.contextBlock = "";
    streamMock.mockImplementation(() => answerStream("Gern geschehen."));
    await runTurn({ session, userMessage: "Danke!" });

    // The agent was handed the excerpts, beside the call, and for that call alone: the turn's tool
    // context no longer holds them, so a later delegation of the turn (the corrective build reuses
    // that context) is not handed them as well.
    expect(handedDocuments[0]).toContain(ROW);
    expect(delegationContexts[0]).not.toHaveProperty("delegationDocuments");
    const history = session.getHistory();
    expect(history.some((message) => message.role === "system" && String(message.content ?? "").startsWith("[DOCUMENT CONTEXT]"))).toBe(false);
    const recordedArguments = history
      .flatMap((message) => (message.role === "assistant" ? message.tool_calls ?? [] : []))
      .map((toolCall) => toolCall.function.arguments);
    expect(recordedArguments.some((args) => args.includes("data_analyst"))).toBe(true);
    expect(recordedArguments.join("\n")).not.toContain(ROW);
    const auditedArguments = auditMock.mock.calls
      .filter(([event]) => event === "tool_call_requested")
      .map(([, details]) => JSON.stringify((details as { args?: unknown }).args));
    expect(auditedArguments).toHaveLength(1);
    expect(auditedArguments.join("\n")).not.toContain(ROW);
  });

  it("hands the named agent the exchange a follow-up refers back to", async () => {
    const { AgentSession, runTurn } = await loadRuntime();
    let call = 0;
    streamMock.mockImplementation(() => {
      call += 1;
      return call === 1 ? answerStream("Use round(subtotal + tax, 2) instead of int().") : answerStream(ANSWER);
    });

    const session = new AgentSession({ channel: "test", workspacePath: mkdtempSync(join(tmpdir(), "sai-directive-ws-")), systemPrompt: "You are a test agent." });
    session.addMessage({ role: "user", content: MESSAGE });
    session.addMessage({ role: "assistant", content: "total() truncates the cents with int(): 10.999 becomes 10." });
    await runTurn({ session, userMessage: "Und wie behebe ich das?", allowedAgents: ["code_analyst"], directiveAgent: "code_analyst" });

    expect(delegated).toHaveLength(1);
    expect(delegated[0]).toMatchObject({ agentName: "code_analyst", task: "Und wie behebe ich das?" });
    const context = String(delegated[0]!["context"]);
    expect(context).toContain("def total(subtotal, tax)");
    expect(context).toContain("10.999 becomes 10");
  });

  describe("with the receptionist's fast lane on", () => {
    const GREETING = "Hallo, stell dich kurz vor";
    const FRONT_DESK = "Hallo! Ich bin dein Assistent. FRONT-DESK";
    /** A routing-tier model that, as the front desk, answers the greeting itself. */
    function frontDeskAnswers(): void {
      routingTier.complete = async (messages) => ({
        content: String(messages[0]?.content ?? "").includes("<ESCALATE>") ? FRONT_DESK : "VERDICT: no",
        tool_calls: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        finishReason: "stop",
      });
    }

    it("answers small talk at the front desk when no agent is named", async () => {
      // The control: this setup does reach the fast lane.
      frontDeskAnswers();
      const { AgentSession, runTurn } = await loadRuntime({ receptionist: { enabled: true } });
      streamMock.mockImplementation(() => answerStream(ANSWER));

      const session = new AgentSession({ channel: "test", workspacePath: mkdtempSync(join(tmpdir(), "sai-directive-ws-")), systemPrompt: "You are a test agent." });
      const result = await runTurn({ session, userMessage: GREETING });

      expect(result.performance?.finishReason).toBe("receptionist_fast_lane");
      expect(result.response).toContain("FRONT-DESK");
    });

    it("leaves a turn directed to an agent to that agent, small talk or not", async () => {
      // The fast lane decided before the directive was read, so "Hallo, stell dich kurz vor
      // --agent researcher" got the front desk's greeting and researcher never ran (review of
      // 0b5089e, 2026-10-08). A pinned evaluation with a greeting-shaped case measured the front desk.
      frontDeskAnswers();
      const { AgentSession, runTurn } = await loadRuntime({ receptionist: { enabled: true } });
      streamMock.mockImplementation(() => answerStream(ANSWER));

      const session = new AgentSession({ channel: "test", workspacePath: mkdtempSync(join(tmpdir(), "sai-directive-ws-")), systemPrompt: "You are a test agent." });
      const result = await runTurn({ session, userMessage: GREETING, allowedAgents: ["researcher"], directiveAgent: "researcher" });

      expect(result.performance?.finishReason).not.toBe("receptionist_fast_lane");
      expect(result.response).not.toContain("FRONT-DESK");
      expect(delegated).toEqual([expect.objectContaining({ agentName: "researcher" })]);
    });
  });

  it("forces nothing when the agents are only narrowed (a scene's grant)", async () => {
    const { AgentSession, runTurn } = await loadRuntime();
    streamMock.mockImplementation(() => answerStream("int() truncates; use round()."));

    const session = new AgentSession({ channel: "test", workspacePath: mkdtempSync(join(tmpdir(), "sai-directive-ws-")), systemPrompt: "You are a test agent." });
    await runTurn({ session, userMessage: MESSAGE, allowedAgents: ["code_analyst"] });

    expect(toolChoiceOf(0)).toBeUndefined();
    expect(promptOf(0)).not.toContain(DIRECTIVE_LINE);
  });

  // The directive used to be released by the delegation tally, which is kept on the REQUEST: a call
  // that never reached the named agent released it, and a call that did reach it without counting
  // (the agent's name called as a tool) left it pending (review of 0b5089e/a3773aa, 2026-10-08).
  it.each([
    ["the delegation's arguments could not be parsed", () => toolStream("delegate_to_agent", "<<not json>>")],
    ["a delegation to another agent was refused", () => toolStream("delegate_to_agent", { agentName: "coder", task: "Find the bug in invoices.py." })],
    ["an ephemeral agent was turned away before it ran", () => toolStream("create_ephemeral_agent", { agentName: "x", systemPrompt: "s", tools: ["nope"], task: "Find the bug." })],
  ])("stays directed when %s", async (_label, firstResponse) => {
    const { AgentSession, runTurn } = await loadRuntime();
    let call = 0;
    streamMock.mockImplementation(() => {
      call += 1;
      return call === 1 ? firstResponse() : answerStream("I answered this myself: int() truncates; use round().");
    });

    const session = new AgentSession({ channel: "test", workspacePath: mkdtempSync(join(tmpdir(), "sai-directive-ws-")), systemPrompt: "You are a test agent." });
    await runTurn({ session, userMessage: MESSAGE, allowedAgents: ["code_analyst"], directiveAgent: "code_analyst" });

    expect(toolChoiceOf(1)).toBe("required");
    expect(promptOf(1)).toContain(DIRECTIVE_LINE);
    expect(delegated).toHaveLength(1);
    expect(delegated[0]).toMatchObject({ agentName: "code_analyst", task: MESSAGE });
  });

  it("is released once the named agent ran, even when the model called it by name as a tool", async () => {
    const { AgentSession, runTurn } = await loadRuntime({ subAgents: { code_analyst: CODE_ANALYST } });
    let call = 0;
    streamMock.mockImplementation(() => {
      call += 1;
      return call === 1 ? toolStream("code_analyst", { task: "Find the bug in invoices.py." }) : answerStream(ANSWER);
    });

    const session = new AgentSession({ channel: "test", workspacePath: mkdtempSync(join(tmpdir(), "sai-directive-ws-")), systemPrompt: "You are a test agent." });
    const result = await runTurn({ session, userMessage: MESSAGE, allowedAgents: ["code_analyst"], directiveAgent: "code_analyst" });

    expect(delegated).toHaveLength(1);
    expect(toolChoiceOf(1)).toBeUndefined();
    expect(promptOf(1)).not.toContain(DIRECTIVE_LINE);
    expect(result.response).toContain("MODEL-ANSWER");
  });

  it("is released by a run of the named agent that failed: the agent ran", async () => {
    // A run that ended without an answer (every attempt timed out) reports the agents it attempted
    // and no agent it is from. The agent did run; dispatching it again would repeat the run that
    // just timed out.
    const { AgentSession, runTurn } = await loadRuntime();
    let call = 0;
    streamMock.mockImplementation(() => {
      call += 1;
      return call === 1
        ? toolStream("delegate_to_agent", { agentName: "code_analyst", task: "Find the bug in invoices.py. TIMES-OUT" })
        : answerStream(ANSWER);
    });

    const session = new AgentSession({ channel: "test", workspacePath: mkdtempSync(join(tmpdir(), "sai-directive-ws-")), systemPrompt: "You are a test agent." });
    await runTurn({ session, userMessage: MESSAGE, allowedAgents: ["code_analyst"], directiveAgent: "code_analyst" });

    expect(delegated).toHaveLength(1);
    expect(toolChoiceOf(1)).toBeUndefined();
    expect(promptOf(1)).not.toContain(DIRECTIVE_LINE);
  });

  it("is released once a fan-out reported a delegation of the named agent", async () => {
    // A tool that reports the calls it made (parallel_delegate, execute_plan) reports with each the
    // agents that call's own result named.
    const { AgentSession, runTurn } = await loadRuntime();
    let call = 0;
    streamMock.mockImplementation(() => {
      call += 1;
      return call === 1
        ? toolStream("parallel_delegate", { tasks: [{ agentName: "code_analyst", task: "Find the bug in invoices.py." }] })
        : answerStream(ANSWER);
    });

    const session = new AgentSession({ channel: "test", workspacePath: mkdtempSync(join(tmpdir(), "sai-directive-ws-")), systemPrompt: "You are a test agent." });
    const result = await runTurn({ session, userMessage: MESSAGE, allowedAgents: ["code_analyst"], directiveAgent: "code_analyst" });

    expect(executed).toEqual(["parallel_delegate"]);
    expect(toolChoiceOf(1)).toBeUndefined();
    expect(promptOf(1)).not.toContain(DIRECTIVE_LINE);
    expect(result.response).toContain("MODEL-ANSWER");
  });

  it("is released once a task graph's node ran the named agent", async () => {
    // A task graph's result names no agent of its own; its nodes' attempts are in the swarm state it
    // reports. The release read only delegate_to_agent's and swarm_delegate's results, so after a
    // graph had run the agent the turn stayed directed to it: the next iteration was forced, and the
    // model's answer was replaced by a second run of the same agent (review of 6955e34, 2026-10-08).
    const { AgentSession, runTurn } = await loadRuntime();
    let call = 0;
    streamMock.mockImplementation(() => {
      call += 1;
      return call === 1
        ? toolStream("run_task_graph", { nodes: [{ id: "find_bug", agentName: "code_analyst", task: "Find the bug in invoices.py." }] })
        : answerStream(ANSWER);
    });

    const session = new AgentSession({ channel: "test", workspacePath: mkdtempSync(join(tmpdir(), "sai-directive-ws-")), systemPrompt: "You are a test agent." });
    const result = await runTurn({ session, userMessage: MESSAGE, allowedAgents: ["code_analyst"], directiveAgent: "code_analyst" });

    expect(executed).toEqual(["run_task_graph"]);
    expect(toolChoiceOf(1)).toBeUndefined();
    expect(promptOf(1)).not.toContain(DIRECTIVE_LINE);
    expect(result.response).toContain("MODEL-ANSWER");
  });

  it("stays directed when a fan-out slice that named no agent was answered by an ephemeral agent", async () => {
    // A slice that names no agent is routed within the turn's grant, and when routing finds no
    // match the architect fallback, which no grant binds, answers with an ephemeral agent. The
    // release counted every nested delegation that succeeded as the named agent's, so the
    // orchestrator's own answer shipped and code_analyst never ran (review of 6955e34, 2026-10-08).
    realTools.add("parallel_delegate");
    const { AgentSession, runTurn } = await loadRuntime({ subAgents: { code_analyst: CODE_ANALYST } });
    let call = 0;
    streamMock.mockImplementation(() => {
      call += 1;
      if (call === 1) return toolStream("parallel_delegate", { tasks: [{ task: "Plan a vegan dinner menu for six guests" }] });
      return answerStream(call === 2 ? "I answered this myself. ORCHESTRATOR-ANSWER" : ANSWER);
    });

    const session = new AgentSession({ channel: "test", workspacePath: mkdtempSync(join(tmpdir(), "sai-directive-ws-")), systemPrompt: "You are a test agent." });
    const result = await runTurn({ session, userMessage: MESSAGE, allowedAgents: ["code_analyst"], directiveAgent: "code_analyst" });

    expect(architectRuns).toHaveLength(1);
    expect(toolChoiceOf(1)).toBe("required");
    expect(promptOf(1)).toContain(DIRECTIVE_LINE);
    expect(delegated).toEqual([expect.objectContaining({ agentName: "code_analyst" })]);
    expect(result.response).not.toContain("I answered this myself");
  });

  it("runs the named agent though an ephemeral agent already answered the same request", async () => {
    // The model's first call delegated the user's request word for word and named no agent; routing
    // within the grant found no match and an ephemeral agent answered. The runtime's own dispatch to
    // code_analyst carries the same request, and signature reuse served it the ephemeral agent's
    // answer: code_analyst never ran, the turn stayed directed, the next dispatch hit the reuse
    // limit, and the turn ended in a delegation failure (integration review, 2026-10-08).
    const VEGAN = "Plan a vegan dinner menu for six guests";
    realTools.add("delegate_to_agent");
    specialistRuns.stubbed = true;
    const { AgentSession, runTurn } = await loadRuntime({ subAgents: { code_analyst: CODE_ANALYST } });
    let call = 0;
    streamMock.mockImplementation(() => {
      call += 1;
      return call === 1 ? toolStream("delegate_to_agent", { task: VEGAN }) : answerStream(ANSWER);
    });

    const session = new AgentSession({ channel: "test", workspacePath: mkdtempSync(join(tmpdir(), "sai-directive-ws-")), systemPrompt: "You are a test agent." });
    const result = await runTurn({ session, userMessage: VEGAN, allowedAgents: ["code_analyst"], directiveAgent: "code_analyst" });

    expect(architectRuns).toHaveLength(1);
    expect(specialistRuns.ran).toEqual(["code_analyst"]);
    expect(result.performance?.finishReason).not.toBe("delegation_failures_terminal");
    expect(result.response).toContain("MODEL-ANSWER");
  });

  it("does not relay an ephemeral agent's long deliverable before the named agent ran", async () => {
    // A delegation that named no agent was routed within the grant, found no match, and the
    // architect fallback's ephemeral agent answered with a long deliverable. The single-deliverable
    // relay shipped it as the turn's answer, scored complete, and code_analyst never ran: the forced
    // iteration that would have delegated to it never came (integration review, 2026-10-08).
    realTools.add("swarm_delegate");
    architectAnswer.text = longReport("Vegan dinner for six", "a dish of lentils, herbs and roasted vegetables");
    const { AgentSession, runTurn } = await loadRuntime({ subAgents: { code_analyst: CODE_ANALYST } });
    let call = 0;
    streamMock.mockImplementation(() => {
      call += 1;
      return call === 1 ? toolStream("swarm_delegate", { task: "Plan a vegan dinner menu for six guests" }) : answerStream(ANSWER);
    });

    const session = new AgentSession({ channel: "test", workspacePath: mkdtempSync(join(tmpdir(), "sai-directive-ws-")), systemPrompt: "You are a test agent." });
    const result = await runTurn({ session, userMessage: MESSAGE, allowedAgents: ["code_analyst"], directiveAgent: "code_analyst" });

    expect(architectRuns).toHaveLength(1);
    expect(result.performance?.finishReason).not.toBe("single_deliverable_relayed");
    expect(toolChoiceOf(1)).toBe("required");
    expect(promptOf(1)).toContain(DIRECTIVE_LINE);
    expect(delegated).toEqual([expect.objectContaining({ agentName: "code_analyst" })]);
  });

  it("still relays the named agent's own long deliverable", async () => {
    // The control. The agent the user named returned the deliverable in this round, so the turn
    // ends with it; read from the directive as it stood before the round's tools ran, the relay
    // was held here as well.
    specialistReport.text = longReport("Why invoices.py undercharges", "int() truncates the cent in total()");
    const { AgentSession, runTurn } = await loadRuntime();
    let call = 0;
    streamMock.mockImplementation(() => {
      call += 1;
      return call === 1 ? delegateStream() : answerStream(ANSWER);
    });

    const session = new AgentSession({ channel: "test", workspacePath: mkdtempSync(join(tmpdir(), "sai-directive-ws-")), systemPrompt: "You are a test agent." });
    const result = await runTurn({ session, userMessage: MESSAGE, allowedAgents: ["code_analyst"], directiveAgent: "code_analyst" });

    expect(delegated).toHaveLength(1);
    expect(result.performance?.finishReason).toBe("single_deliverable_relayed");
    expect(streamMock).toHaveBeenCalledTimes(1);
    expect(result.response).toContain("int() truncates the cent in total()");
  });

  it("stays directed when a task graph's node was turned away, though the turn before ran the agent under its id", async () => {
    // The turn's swarm state is seeded with the previous turn's tasks, attempts included, and a node
    // whose id repeats one of them keeps that task's attempts. Node n1 was turned away this turn
    // (a research task redirected to an agent outside the grant) and still showed code_analyst's
    // attempt from the turn before: the directive was released, the orchestrator's answer shipped,
    // and code_analyst never ran (review of faeee22, 2026-10-08).
    realTools.add("run_task_graph");
    const { AgentSession, runTurn } = await loadRuntime({
      subAgents: {
        code_analyst: CODE_ANALYST,
        researcher: { description: "Researches the web.", capabilities: ["web research"], tags: ["research"], tools: ["web_search", "web_fetch"], maxIterations: 4 },
      },
    });
    let call = 0;
    streamMock.mockImplementation(() => {
      call += 1;
      if (call === 1) {
        return toolStream("run_task_graph", { nodes: [{ id: "n1", agentName: "code_analyst", task: "Search online for the best PDF libraries and compare their pricing" }] });
      }
      return answerStream(call === 2 ? "I answered this myself. ORCHESTRATOR-ANSWER" : ANSWER);
    });

    const session = new AgentSession({ channel: "test", workspacePath: mkdtempSync(join(tmpdir(), "sai-directive-ws-")), systemPrompt: "You are a test agent." });
    session.addMessage({ role: "user", content: MESSAGE });
    session.addMessage({
      role: "assistant",
      content: "total() truncates with int(); round(subtotal + tax, 2) fixes it.",
      metadata: {
        swarmState: {
          objective: "previous turn",
          startedAt: "2026-10-07T10:00:00.000Z",
          updatedAt: "2026-10-07T10:01:00.000Z",
          tasks: {
            n1: {
              id: "n1", title: "n1", status: "completed", dependsOn: [], signature: "previous-signature",
              output: "total() truncates with int()", selectedAgent: "code_analyst",
              attempts: [{ agentName: "code_analyst", status: "completed", startedAt: "2026-10-07T10:00:05.000Z", finishedAt: "2026-10-07T10:00:50.000Z" }],
            },
          },
        },
      },
    });
    const result = await runTurn({ session, userMessage: "Which PDF library should invoices.py use?", allowedAgents: ["code_analyst"], directiveAgent: "code_analyst" });

    expect(executed[0]).toBe("run_task_graph");
    expect(toolChoiceOf(1)).toBe("required");
    expect(promptOf(1)).toContain(DIRECTIVE_LINE);
    expect(delegated).toEqual([expect.objectContaining({ agentName: "code_analyst" })]);
    expect(result.response).not.toContain("I answered this myself");
  });

  it("delegates to the named agent after a workflow ran, and answers from both", async () => {
    // run_workflow adds nothing to the delegation tally, so after a completed workflow the
    // directive stayed pending next to the [SYNTHESIS REQUIRED] note: the model's answer was
    // replaced by the delegation, the synthesis-required guard rejected that, and the turn shipped a
    // forced "RESEARCH INCOMPLETE" partial answer while code_analyst never ran.
    const { AgentSession, runTurn } = await loadRuntime();
    let call = 0;
    streamMock.mockImplementation(() => {
      call += 1;
      return call === 1 ? toolStream("run_workflow", { name: "code_review", workflowType: "scene" }) : answerStream(ANSWER);
    });

    const session = new AgentSession({ channel: "test", workspacePath: mkdtempSync(join(tmpdir(), "sai-directive-ws-")), systemPrompt: "You are a test agent." });
    const result = await runTurn({ session, userMessage: MESSAGE, allowedAgents: ["code_analyst"], directiveAgent: "code_analyst" });

    expect(executed).toContain("run_workflow");
    expect(delegated).toHaveLength(1);
    expect(delegated[0]).toMatchObject({ agentName: "code_analyst" });
    expect(result.performance?.finishReason).not.toBe("synthesis_required_tool_call_rejected");
    expect(result.response).toContain("MODEL-ANSWER");
  });

  it("lets the named agent, called by its own name as a tool, through after a workflow ran", async () => {
    // The synthesis-required guard reads the response as the model wrote it. A call of the agent by
    // its own name becomes the delegation to it only when it runs, after the guard, so the guard has
    // to know that name as the directed delegation too.
    const { AgentSession, runTurn } = await loadRuntime({ subAgents: { code_analyst: CODE_ANALYST } });
    let call = 0;
    streamMock.mockImplementation(() => {
      call += 1;
      if (call === 1) return toolStream("run_workflow", { name: "code_review", workflowType: "scene" });
      if (call === 2) return toolStream("code_analyst", { task: "Find the bug in invoices.py." });
      return answerStream(ANSWER);
    });

    const session = new AgentSession({ channel: "test", workspacePath: mkdtempSync(join(tmpdir(), "sai-directive-ws-")), systemPrompt: "You are a test agent." });
    const result = await runTurn({ session, userMessage: MESSAGE, allowedAgents: ["code_analyst"], directiveAgent: "code_analyst" });

    expect(delegated).toEqual([expect.objectContaining({ agentName: "code_analyst" })]);
    expect(result.performance?.finishReason).not.toBe("synthesis_required_tool_call_rejected");
    expect(result.response).toContain("MODEL-ANSWER");
  });

  it("runs the delegation to the named agent instead of the workflow a catalog search matched", async () => {
    // The workflow-run nudge dropped the directed delegation once and then rewrote it into the
    // matched workflow, so the turn ran a workflow nobody asked for before the named agent.
    const { AgentSession, runTurn } = await loadRuntime();
    let call = 0;
    streamMock.mockImplementation(() => {
      call += 1;
      if (call === 1) return toolStream("search_workflows", { query: "code bug review" });
      if (call === 2) return delegateStream();
      return answerStream(ANSWER);
    });

    const session = new AgentSession({ channel: "test", workspacePath: mkdtempSync(join(tmpdir(), "sai-directive-ws-")), systemPrompt: "You are a test agent." });
    const result = await runTurn({ session, userMessage: MESSAGE, allowedAgents: ["code_analyst"], directiveAgent: "code_analyst" });

    expect(executed).not.toContain("run_workflow");
    expect(delegated).toHaveLength(1);
    expect(result.response).toContain("MODEL-ANSWER");
  });

  describe("when the request matches a job's catalog triggers", () => {
    // The user named the agent; a catalog match is the runtime's guess (review of 6955e34, 2026-10-08).
    const DECK_REQUEST = "Create a cited slide deck about Dresden with real photos and sources";
    const CATALOG_JOB = {
      subAgents: { content_writer: { description: "Writes documents and decks.", capabilities: ["writing"], tags: ["write"], tools: ["write_file"], maxIterations: 4 } },
      scenes: { deck_slides: { description: "Build the slides.", task: "Build slides about {{topic}}." } },
      jobs: {
        sourced_presentation: {
          description: "Build a source-backed presentation package with verified images.",
          steps: [{ scene: "deck_slides" }],
          catalogTriggers: {
            requiresActionVerb: true,
            patterns: [{ all: ["\\b(?:presentations?|slide[\\s-]?decks?|slides?)\\b", "\\b(?:images?|photos?)\\b", "\\b(?:sources?|cited?|research)\\b"] }],
          },
        },
      },
    };

    async function runDeckTurn(): Promise<void> {
      const { AgentSession, runTurn } = await loadRuntime(CATALOG_JOB);
      let call = 0;
      streamMock.mockImplementation(() => {
        call += 1;
        return call === 1
          ? toolStream("delegate_to_agent", { agentName: "content_writer", task: "Build the Dresden deck." })
          : answerStream(ANSWER);
      });
      const session = new AgentSession({ channel: "test", workspacePath: mkdtempSync(join(tmpdir(), "sai-directive-ws-")), systemPrompt: "You are a test agent." });
      await runTurn({ session, userMessage: DECK_REQUEST, allowedAgents: ["content_writer"], directiveAgent: "content_writer" });
    }

    it("runs the delegation to the named agent as the model asked for it", async () => {
      // The workflow-catalog check dropped the directed delegation and told the model "Do NOT jump
      // straight to delegate_to_agent ... call run_workflow now" beside the line that names the
      // agent, so a model that followed it ran the matched job before the agent.
      await runDeckTurn();

      expect(executed[0]).toBe("delegate_to_agent");
      expect(delegated[0]).toMatchObject({ agentName: "content_writer", task: "Build the Dresden deck." });
      expect(promptOf(1)).not.toContain("Do NOT jump straight to delegate_to_agent");
    });

    it("answers from the named agent's result without a catalog check on top", async () => {
      // Once the agent had run, the answer from its result was rejected as "A tool-free answer is
      // invalid for this turn", with an order to call run_workflow: a model that obeyed ran the
      // matched job after the agent the user had named.
      await runDeckTurn();

      expect(streamMock).toHaveBeenCalledTimes(2);
      expect(promptOf(1)).not.toContain("A tool-free answer is invalid");
      expect(executed).toEqual(["delegate_to_agent"]);
    });
  });
});
