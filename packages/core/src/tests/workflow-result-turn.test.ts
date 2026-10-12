import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * THE TURN THAT RAN A JOB ANSWERS FROM THE JOB'S WHOLE ANSWER (E2E core-ix-workflow-job-sourced-report).
 *
 * The job ran, its answer held the four error codes asked for after its sections on maintenance and
 * warranty, and its files were attached. The model then read the answer's head only, and every
 * instruction after it asked for a SHORT summary of what was completed: [SYNTHESIS REQUIRED], and
 * the forced answer that follows once that directive has turned a tool call away. Neither asked for
 * the codes, and the gate turned away every call that could have read them. This drives the turn
 * loop with the job's result and reads the prompts it builds.
 */

const streamMock = vi.hoisted(() => vi.fn());
const completeMock = vi.hoisted(() => vi.fn(async () => ({
  content: "FORCED ANSWER: E17, E22, E31, E45; Bericht, Folien und Notizen liegen als Dateien bei.",
  tool_calls: [],
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  finishReason: "stop",
})));
const logAuditMock = vi.hoisted(() => vi.fn());
type ToolResult = { success: boolean; output: string; metadata: Record<string, unknown> };
const workflow = vi.hoisted(() => ({ result: null as null | ToolResult }));

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
      const stubbed = name === "run_workflow" ? workflow.result : null;
      return stubbed ?? actual.executeTool(name, args, ctx, meta);
    }),
  };
});

const JOB = "source_grounded_paper_packet";
const E45_ROW = "| E45 | Kommunikation mit dem Akku gestört |";
const point = (topic: string, n: number): string =>
  `- ${topic} ${n}: laut Dokumentation zu beachten; ${"Hinweise zu Inbetriebnahme, Pflege und Zubehör. ".repeat(3)}`;
/** The job's answer in the order the deployed job wrote it, the error codes last. */
const ANSWER = [
  "## Quellenbericht Akku-Schrauber NW-AS 18",
  "",
  "### Wartung",
  ...[1, 2, 3, 4, 5].map((n) => point("Wartung", n)),
  "",
  "### Garantie",
  ...[1, 2, 3, 4, 5].map((n) => point("Garantie", n)),
  "",
  "### Fehlercodes",
  "| Code | Bedeutung |",
  "| --- | --- |",
  "| E17 | Motor überhitzt |",
  "| E22 | Akku-Unterspannung |",
  "| E31 | Drehmomentsensor ohne Signal |",
  E45_ROW,
].join("\n");
const ARTIFACTS = ["generated/nw-as-18/bericht.md", "generated/nw-as-18/folien.html", "generated/nw-as-18/notizen.md"];
/** run_workflow's result for the job (tools/workflow-catalog.ts): 1/1 steps, three files attached. */
const jobResult = (answer: string): ToolResult => ({
  success: true,
  output: `Workflow ${JOB} [job] completed.\n\n${answer}`,
  metadata: {
    workflowName: JOB,
    workflowType: "job",
    blocked: false,
    toolCallsExecuted: 5,
    stepCount: 1,
    executedSteps: 1,
    artifacts: ARTIFACTS.map((outputPath) => ({ outputPath, filename: outputPath.split("/").pop() })),
  },
});
const REQUEST = "Führe den Workflow source_grounded_paper_packet für den NW-AS 18 aus und nenne mir alle Fehlercodes aus dem Bericht.";

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

const tempDirs: string[] = [];

/** One turn: the model runs the job, which answers `answer`, then does what `afterJob` streams. */
async function runTurn(answer: string, afterJob: () => AsyncGenerator<unknown>) {
  workflow.result = jobResult(answer);
  const configDir = mkdtempSync(join(tmpdir(), "sai-workflow-turn-"));
  const workspacePath = mkdtempSync(join(tmpdir(), "sai-workflow-turn-ws-"));
  tempDirs.push(configDir, workspacePath);
  writeFileSync(join(configDir, "starlingai.json"), JSON.stringify({ agents: { mainAssistant: { toolMode: "orchestration_only" } } }), "utf8");
  process.env["SAI_CONFIG_PATH"] = join(configDir, "starlingai.json");
  vi.resetModules();
  const [{ AgentSession }, runtime] = await Promise.all([import("../agent/session.js"), import("../agent/runtime.js")]);
  let call = 0;
  streamMock.mockImplementation(() => {
    call += 1;
    return call === 1 ? toolCallStream("call_job", "run_workflow", { name: JOB, workflowType: "job" }) : afterJob();
  });
  const session = new AgentSession({ channel: "test", workspacePath, systemPrompt: "You are a test agent." });
  return runtime.runTurn({ session, userMessage: REQUEST });
}

/** The prompt of the model call after the job ran, as one text. */
const promptAfterJob = (): string => {
  expect(streamMock.mock.calls.length, "no model call after the job").toBeGreaterThanOrEqual(2);
  return (streamMock.mock.calls[1]![0] as Array<{ content?: unknown }>).map((m) => String(m.content ?? "")).join("\n");
};
const audited = (event: string) => logAuditMock.mock.calls.filter(([type]) => type === event).map(([, data]) => data as Record<string, unknown>);

describe("the turn that ran a job whose files are attached", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    streamMock.mockReset();
    completeMock.mockClear();
    logAuditMock.mockReset();
    workflow.result = null;
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("writes its answer from the job's whole answer, and is asked for what the request asked", async () => {
    await runTurn(ANSWER, () => answerStream("Fehlercodes laut Bericht: E17, E22, E31 und E45. Bericht, Folien und Notizen liegen als Dateien bei."));
    const prompt = promptAfterJob();
    expect(prompt).toContain(E45_ROW);
    expect(prompt).not.toContain("snippet summarized for prior-turn history");
    expect(prompt).toContain("Write the final answer in the reply language");
    expect(prompt).toContain("give what the request asked for from the evidence below, list EVERY artifact path below with a one-line description");
    expect(prompt).toContain("[SYNTHESIS REQUIRED]");
    expect(prompt).toContain("give what the request asked for from the evidence above, list each attached file with a one-line description");
    expect(prompt).not.toMatch(/SHORT final|state what was completed/);
  }, 60_000);

  // A job that built its files and answered briefly. A longer answer, over the terminal evidence
  // backstop's floor of 800 characters or four list items, is shipped as the reply in place of
  // this call (shouldBypassTerminalSynthesisWithEvidence).
  it("and so is the forced answer once the directive has turned a tool call away", async () => {
    const brief = "Bericht, Folien und Notizen zum NW-AS 18 liegen vor. Fehlercodes laut Fehlercode-Tabelle: "
      + "E17 Motor überhitzt, E22 Akku-Unterspannung, E31 Drehmomentsensor ohne Signal, E45 Kommunikation mit dem Akku gestört.";
    await runTurn(brief, () => toolCallStream("call_again", "delegate_to_agent", { agentName: "researcher", task: "Fehlercodes des NW-AS 18 nachschlagen" }));
    expect(audited("guardrail_flagged").map((data) => data["type"])).toContain("tool_calls_after_synthesis_required");
    const forced = completeMock.mock.calls.map((args) => (args as unknown as [Array<{ role: string; content?: unknown }>])[0]);
    const terminal = forced.find((messages) => String(messages[messages.length - 1]?.content ?? "").includes("THE WORK IS COMPLETE"));
    expect(terminal, "no forced answer after the rejected call").toBeDefined();
    const instruction = String(terminal![terminal!.length - 1]!.content);
    expect(instruction).toContain("WRITE THE FINAL ANSWER NOW");
    expect(instruction).toContain("do NOT paste the files' contents");
    expect(instruction).toContain("(1) gives what the request asked for from the evidence above, (2) lists every attached file with a one-line description");
    expect(instruction).not.toMatch(/SHORT|states what was completed/);
    // ...from the job's answer, which the collapsed history it reads carries.
    expect(terminal!.map((m) => String(m.content ?? "")).join("\n")).toContain("E45 Kommunikation mit dem Akku gestört");
  }, 60_000);
});
