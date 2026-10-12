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
 * the codes, and the gate turned away every call that could have read them.
 *
 * And a reply written from the whole answer must reach the user as written. The backstops held a
 * correct short reply to the length of the job's answer and shipped that answer, the files' text
 * among it, in its place: the coverage check, the terminal evidence bypass and the replacement of a
 * reply under 300 characters. This drives the turn loop with the job's result and a model that
 * answers from the prompt it is given.
 */

const streamMock = vi.hoisted(() => vi.fn());
const completeMock = vi.hoisted(() => vi.fn());
const logAuditMock = vi.hoisted(() => vi.fn());
type ToolResult = { success: boolean; output: string; error?: string; metadata: Record<string, unknown> };
type Message = { role: string; content?: unknown };
const workflow = vi.hoisted(() => ({ result: null as null | ToolResult, byName: {} as Record<string, ToolResult> }));

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
      const stubbed = name === "run_workflow" ? (workflow.byName[String(args["name"])] ?? workflow.result) : null;
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
/** What only the job's answer says, so a reply that carries it is the job's answer pasted. */
const PASTED = "Wartung 1: laut Dokumentation zu beachten";
const ARTIFACTS = ["generated/nw-as-18/bericht.md", "generated/nw-as-18/folien.html", "generated/nw-as-18/notizen.md"];
/** run_workflow's result for the job (tools/workflow-catalog.ts): 1/1 steps, three files attached. */
const JOB_RESULT: ToolResult = {
  success: true,
  output: `Workflow ${JOB} [job] completed.\n\n${ANSWER}`,
  metadata: {
    workflowName: JOB,
    workflowType: "job",
    blocked: false,
    toolCallsExecuted: 5,
    stepCount: 1,
    executedSteps: 1,
    artifacts: ARTIFACTS.map((outputPath) => ({ outputPath, filename: outputPath.split("/").pop() })),
  },
};
const REQUEST = "Führe den Workflow source_grounded_paper_packet für den NW-AS 18 aus und nenne mir alle Fehlercodes aus dem Bericht.";

const promptText = (messages: readonly Message[]): string => messages.map((m) => String(m.content ?? "")).join("\n");

/**
 * The model's answer, written from what its prompt shows: the error codes of every code row in it
 * and the files. A prompt that shows no code row gets an answer that names none.
 */
function answerFromPrompt(messages: readonly Message[]): string {
  // A row ends the line, or the collapsed history's "[Tool: … → …]" around the result.
  const codes = [...promptText(messages).matchAll(/^\| (E\d{2}) \| ([^|\n]+?) \|\]?$/gm)].map((m) => `${m[1]} (${m[2]})`);
  const unique = [...new Set(codes)];
  return `${unique.length > 0 ? `Fehlercodes laut Bericht: ${unique.join(", ")}.` : "Der Bericht nennt keine Fehlercodes."} `
    + "Bericht, Folien und Notizen liegen als Dateien bei.";
}
const ALL_CODES = ["E17 (Motor überhitzt)", "E22 (Akku-Unterspannung)", "E31 (Drehmomentsensor ohne Signal)", "E45 (Kommunikation mit dem Akku gestört)"];

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

/**
 * One turn: the model runs the job (or what `first` streams), then does what `afterJob` streams for
 * the prompt it is given.
 */
async function runTurn(
  afterJob: (messages: readonly Message[]) => AsyncGenerator<unknown>,
  first: () => AsyncGenerator<unknown> = () => toolCallStream("call_job", "run_workflow", { name: JOB, workflowType: "job" }),
) {
  workflow.result = JOB_RESULT;
  const configDir = mkdtempSync(join(tmpdir(), "sai-workflow-turn-"));
  const workspacePath = mkdtempSync(join(tmpdir(), "sai-workflow-turn-ws-"));
  tempDirs.push(configDir, workspacePath);
  writeFileSync(join(configDir, "starlingai.json"), JSON.stringify({ agents: { mainAssistant: { toolMode: "orchestration_only" } } }), "utf8");
  process.env["SAI_CONFIG_PATH"] = join(configDir, "starlingai.json");
  vi.resetModules();
  const [{ AgentSession }, runtime] = await Promise.all([import("../agent/session.js"), import("../agent/runtime.js")]);
  let call = 0;
  streamMock.mockImplementation((messages: readonly Message[]) => {
    call += 1;
    return call === 1 ? first() : afterJob(messages);
  });
  completeMock.mockImplementation(async (messages: readonly Message[]) => ({
    content: answerFromPrompt(messages),
    tool_calls: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    finishReason: "stop",
  }));
  const session = new AgentSession({ channel: "test", workspacePath, systemPrompt: "You are a test agent." });
  return runtime.runTurn({ session, userMessage: REQUEST });
}

/** The prompt of the model call after the job ran, as one text. */
const promptAfterJob = (): string => {
  expect(streamMock.mock.calls.length, "no model call after the job").toBeGreaterThanOrEqual(2);
  return promptText(streamMock.mock.calls[1]![0] as Message[]);
};
const audited = (event: string) => logAuditMock.mock.calls.filter(([type]) => type === event).map(([, data]) => data as Record<string, unknown>);

describe("the turn that ran a job whose files are attached", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    streamMock.mockReset();
    completeMock.mockReset();
    logAuditMock.mockReset();
    workflow.result = null;
    workflow.byName = {};
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("writes its answer from the job's whole answer, and the reply is that answer, not the job's", async () => {
    const turn = await runTurn((messages) => answerStream(answerFromPrompt(messages)));
    const prompt = promptAfterJob();
    expect(prompt).toContain(E45_ROW);
    expect(prompt).not.toContain("snippet summarized for prior-turn history");
    expect(prompt).toContain("Write the final answer in the reply language");
    expect(prompt).toContain("answer any question the request asked, with the specific facts from the evidence below; list each attached file below with a one-line description; when the files themselves are what was asked for, keep the reply to that list");
    expect(prompt).toContain("[SYNTHESIS REQUIRED]");
    expect(prompt).toContain("answer any question the request asked, with the specific facts from the evidence above; list each attached file with a one-line description; when the files themselves are what was asked for, keep the reply to that list");
    expect(prompt).not.toMatch(/SHORT final|state what was completed|give what the request asked for/);
    // The reply names every code, and the coverage check did not hold it to the job's answer.
    for (const code of ALL_CODES) expect(turn.response).toContain(code);
    expect(turn.response).not.toContain(PASTED);
    expect(audited("coverage_shortfall_resynthesis")).toEqual([]);
  }, 60_000);

  it("and so is the forced answer once the directive has turned a tool call away", async () => {
    const turn = await runTurn(() => toolCallStream("call_again", "delegate_to_agent", { agentName: "researcher", task: "Fehlercodes des NW-AS 18 nachschlagen" }));
    expect(audited("guardrail_flagged").map((data) => data["type"])).toContain("tool_calls_after_synthesis_required");
    // The instruction written for this turn runs: the job's answer is over the evidence backstop's
    // floor, and the bypass shipped it as the reply in its place.
    const forced = completeMock.mock.calls.map((args) => (args as unknown as [Message[]])[0]);
    const terminal = forced.find((messages) => String(messages[messages.length - 1]?.content ?? "").includes("THE WORK IS COMPLETE"));
    expect(terminal, "no forced answer after the rejected call").toBeDefined();
    const instruction = String(terminal![terminal!.length - 1]!.content);
    expect(instruction).toContain("WRITE THE FINAL ANSWER NOW");
    expect(instruction).toContain("answer any question the request asked, with the specific facts from the evidence above; list each attached file with a one-line description (");
    expect(instruction).toContain("); when the files themselves are what was asked for, keep the reply to that list; note anything marked incomplete. Do NOT paste the files' contents into the chat. Nothing more.");
    expect(instruction).not.toMatch(/SHORT|states what was completed|gives what the request asked for/);
    // ...from the job's whole answer, which the collapsed history it reads carries.
    expect(promptText(terminal!)).toContain(E45_ROW);
    // Its reply is under 300 characters, which on this turn is the file list it was asked for, not
    // an underpowered synthesis to replace with the job's answer.
    const reply = answerFromPrompt(terminal!);
    expect(reply.length).toBeLessThan(300);
    for (const code of ALL_CODES) expect(turn.response).toContain(code);
    expect(turn.response).not.toContain(PASTED);
  }, 60_000);

  it("shows a retry what the blocked run before it left of the turn's budget", async () => {
    // The job is blocked and the model runs another one. The second answer fits a budget of its own
    // (10,000 characters by default), not what the first frame left of it.
    const RETRY = "source_grounded_paper_packet_wartung";
    const blockedOutput = `Workflow ${JOB} [job] blocked.\n\n${ANSWER}`;
    workflow.byName[JOB] = { success: false, output: blockedOutput, error: blockedOutput, metadata: { ...JOB_RESULT.metadata, blocked: true, artifacts: [] } };
    const retryAnswer = `ZWEITER LAUF: Wartungsplan\n\n${Array.from({ length: 40 }, (_, n) => point("Plan", n + 1)).join("\n")}`;
    expect(retryAnswer.length).toBeGreaterThan(7_000);
    expect(retryAnswer.length).toBeLessThan(9_000);
    workflow.byName[RETRY] = { ...JOB_RESULT, output: `Workflow ${RETRY} [job] completed.\n\n${retryAnswer}`, metadata: { ...JOB_RESULT.metadata, workflowName: RETRY } };
    let after = 0;
    await runTurn((messages) => {
      after += 1;
      return after === 1
        ? toolCallStream("call_retry", "run_workflow", { name: RETRY, workflowType: "job" })
        : answerStream(answerFromPrompt(messages));
    });
    expect(streamMock.mock.calls.length, "no model call after the retry").toBeGreaterThanOrEqual(3);
    const prompt = promptText(streamMock.mock.calls[2]![0] as Message[]);
    expect(prompt).toContain(E45_ROW);
    expect(prompt).toContain("ZWEITER LAUF: Wartungsplan");
    expect(prompt).not.toContain(point("Plan", 40).trim());
    expect(prompt).toMatch(/\[Cut to fit the context budget: [^\]]* characters [^\]]*not shown[^\]]*\]/);
  }, 60_000);
});
