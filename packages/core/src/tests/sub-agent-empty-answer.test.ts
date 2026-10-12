import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SwarmState, ToolContext } from "../tools/registry.js";
import type { TurnPlan } from "../agent/turn-plan.js";

const completeMock = vi.fn();

vi.mock("../providers/lmstudio.js", async (importActual) => ({
  ...(await importActual<typeof import("../providers/lmstudio.js")>()),
  LMStudioProvider: class {
    async complete(messages: unknown, tools: unknown, signal?: AbortSignal) {
      return completeMock(messages, tools, signal);
    }
  },
}));

/**
 * A RUN THAT ANSWERED WITH NOTHING DID NOT DO ITS STEP.
 *
 * E2E core-build-site-company-facts (session d20e3c0a, 2026-10-12): browser_agent was handed
 * "Firmenwebsite http://www.nordlicht-werkzeuge.test/ lesen und nach Gründungsjahr sowie
 * Mitarbeiterzahl durchsuchen", called no tool, and answered in two characters after 0 iterations.
 * The run reported success, execute_plan counted the step done, and the reply told the user the site
 * had been visited and held no such data. Such a run now fails; a short answer from a run that did
 * work, or one to a question nobody asked it to look anything up for, does not.
 */
type Message = { role: string; content?: string | null };
const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const call = (id: string, name: string, args: Record<string, unknown>) =>
  ({ content: "", tool_calls: [{ id, name, arguments: args }], usage, finishReason: "tool_calls" });
const answer = (content: string) => ({ content, tool_calls: [], usage, finishReason: "stop" });
const toolResultsIn = (messages: Message[]) => messages.filter((m) => m.role === "tool").length;

const SITE = "http://www.nordlicht-werkzeuge.test/";
const E2E_STEP = `Firmenwebsite ${SITE} lesen und nach Gründungsjahr sowie Mitarbeiterzahl durchsuchen.`;
/** What the page says, so a short answer after reading it is backed by what the run read. */
const PAGE_TEXT = "Nordlicht Werkzeuge GmbH — gegründet 1998 in Kiel. Heute 42 Mitarbeiterinnen und Mitarbeiter.";
/** A reader the way browser_agent ships: browser tools, and write_file and edit_file to keep notes. */
const BROWSER_TOOLS = ["web_search", "browser_navigate", "browser_snapshot", "write_file", "edit_file"];
/** No tool that reaches outside the workspace. */
const NOTE_TOOLS = ["read_file", "write_file", "edit_file"];
const YES_NO_QUESTION = "Ist 17 eine Primzahl? Antworte nur mit Ja oder Nein.";

describe("emptyAnswerWithoutWork", () => {
  const run = (over: Partial<{ toolCount: number; artifactCount: number; availableTools: string[]; task: string }> = {}) => ({
    toolCount: 0,
    artifactCount: 0,
    availableTools: BROWSER_TOOLS,
    task: E2E_STEP,
    ...over,
  });

  it("reads a two-character answer from a gatherer that called nothing as near-empty", async () => {
    const { emptyAnswerWithoutWork } = await import("../agent/sub-agent.js");
    expect(emptyAnswerWithoutWork("OK", run())).toBe("near_empty");
    expect(emptyAnswerWithoutWork("  ..\n", run())).toBe("near_empty");
  });

  it("reads the same answer as an answer once the run called a tool or left an artifact", async () => {
    const { emptyAnswerWithoutWork } = await import("../agent/sub-agent.js");
    expect(emptyAnswerWithoutWork("OK", run({ toolCount: 1 }))).toBeUndefined();
    expect(emptyAnswerWithoutWork("OK", run({ artifactCount: 1 }))).toBeUndefined();
  });

  it("reads a one-word answer as an answer when nothing asked the run to gather", async () => {
    const { emptyAnswerWithoutWork } = await import("../agent/sub-agent.js");
    for (const reply of ["Ja", "Nein", "Yes", "17"]) {
      expect(emptyAnswerWithoutWork(reply, run({ availableTools: NOTE_TOOLS, task: YES_NO_QUESTION })), reply).toBeUndefined();
    }
  });

  it("reads a near-empty answer as one when the task names a web address, whatever the run holds", async () => {
    const { emptyAnswerWithoutWork } = await import("../agent/sub-agent.js");
    expect(emptyAnswerWithoutWork("OK", run({ availableTools: NOTE_TOOLS }))).toBe("near_empty");
    // A gatherer handed a task with no address was still picked to look something up.
    expect(emptyAnswerWithoutWork("Ja", run({ task: YES_NO_QUESTION }))).toBe("near_empty");
  });

  it("reads an empty answer as empty from any run, and an answer at the floor as an answer", async () => {
    const { emptyAnswerWithoutWork, NEAR_EMPTY_ANSWER_CHARS } = await import("../agent/sub-agent.js");
    for (const empty of ["", "   ", "Sub-agent produced no final response.", "<final_answer status=\"success\"></final_answer>"]) {
      expect(emptyAnswerWithoutWork(empty, run({ availableTools: NOTE_TOOLS, task: YES_NO_QUESTION })), empty).toBe("empty");
    }
    expect(emptyAnswerWithoutWork("x".repeat(NEAR_EMPTY_ANSWER_CHARS), run())).toBeUndefined();
    expect(emptyAnswerWithoutWork("x".repeat(NEAR_EMPTY_ANSWER_CHARS - 1), run())).toBe("near_empty");
  });
});

describe("a delegated run that answered with essentially nothing", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "sai-empty-answer-"));
    writeFileSync(join(tempDir, "starlingai.json"), JSON.stringify({
      subAgents: {
        site_reader: {
          description: "Opens web pages in a browser and reports what they show.",
          systemPrompt: "Read the page you are asked about and report what it says.",
          tools: BROWSER_TOOLS,
          maxIterations: 4,
        },
        note_taker: {
          description: "Answers short questions from what it is handed.",
          systemPrompt: "Answer the question.",
          tools: NOTE_TOOLS,
          maxIterations: 4,
        },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = join(tempDir, "starlingai.json");
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
  });

  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    completeMock.mockReset();
    (await import("../config/loader.js")).resetConfigForTests();
    await (await import("../swarm/memory.js")).resetSharedMemoryForTests();
    rmSync(tempDir, { recursive: true, force: true });
    vi.resetModules();
  });

  /** Registered after tools/sub-agent.js and tools/plan-executor.js, so these handlers are the ones that run. */
  const registerReaderTools = async () => {
    await import("../tools/sub-agent.js");
    await import("../tools/plan-executor.js");
    const { registerTool } = await import("../tools/registry.js");
    const ok = (output: string) => async () => ({ success: true, output });
    for (const name of BROWSER_TOOLS) {
      registerTool({
        name,
        description: `${name} (test stand-in).`,
        parameters: { type: "object", properties: {} },
        execute: ok(name === "browser_navigate" || name === "browser_snapshot" ? PAGE_TEXT : "ok"),
      });
    }
    registerTool({ name: "read_file", description: "Read a file.", parameters: { type: "object", properties: {} }, execute: ok("") });
  };
  /** The model answers at once, calling nothing. */
  const answersAtOnce = (text: string) => completeMock.mockImplementation(async () => answer(text));
  /** The model opens the page, then answers. */
  const readsThenAnswers = (text: string) => completeMock.mockImplementation(async (messages: Message[]) =>
    toolResultsIn(messages) === 0 ? call("n1", "browser_navigate", { url: SITE }) : answer(text));

  const runReader = async (agentName: string, task: string) => {
    const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
    return runSubAgentWithStats({ agentName, task, parentSessionId: `parent-${agentName}-${Math.random().toString(36).slice(2)}`, workspacePath: tempDir });
  };

  it("fails a gatherer's two-character answer with no tool call, and says what happened", async () => {
    await registerReaderTools();
    answersAtOnce("OK");
    const result = await runReader("site_reader", E2E_STEP);

    expect(result.stats.toolCount).toBe(0);
    expect(result.stats.outcome).toBe("failure");
    expect(result.stats.terminalState).toBe("error");
    expect(result.output).toContain("site_reader");
    expect(result.output).toContain("2 characters");
  }, 30_000);

  it("keeps a short answer the run gave after reading the page", async () => {
    await registerReaderTools();
    readsThenAnswers("1998; 42.");
    const result = await runReader("site_reader", E2E_STEP);

    expect(result.stats.toolCount).toBe(1);
    expect(result.stats.outcome).toBe("success");
    expect(result.output).toBe("1998; 42.");
  }, 30_000);

  it("keeps a one-word answer to a yes/no question from a run nobody asked to look anything up", async () => {
    await registerReaderTools();
    answersAtOnce("Ja");
    const result = await runReader("note_taker", YES_NO_QUESTION);

    expect(result.stats.outcome).toBe("success");
    expect(result.output).toBe("Ja");
  }, 30_000);

  const freshSwarmState = (): SwarmState => ({
    objective: "test",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tasks: {},
  });
  /** The plan of session d20e3c0a, with the step addressed to this suite's reader. */
  const companyFactsPlan = (): TurnPlan => ({
    objective: "Gründungsdatum und Mitarbeiterzahl der Nordlicht Werkzeuge GmbH von der angegebenen Website ermitteln.",
    steps: [{ id: "s1", kind: "delegate", agent: "site_reader", description: E2E_STEP }],
    acceptanceCriteria: ["Gründungsjahr der Nordlicht Werkzeuge GmbH angegeben", "Anzahl der Mitarbeiterinnen und Mitarbeiter angegeben"],
    stopConditions: [
      "Website erreichbar und relevante Informationen gefunden",
      "Website nicht erreichbar — dann klar kommunizieren, dass keine Daten verfügbar sind",
    ],
    riskTier: "high",
    wide: false,
    createdAt: new Date(0).toISOString(),
  });
  const executePlan = async (sessionId: string) => {
    const { persistTurnPlan } = await import("../agent/turn-plan.js");
    await persistTurnPlan(sessionId, companyFactsPlan());
    const { getTool } = await import("../tools/registry.js");
    const ctx: ToolContext = { sessionId, workspacePath: tempDir, swarmState: freshSwarmState() };
    return getTool("execute_plan")!.execute({}, ctx);
  };

  it("REGRESSION d20e3c0a — execute_plan counts the step failed, and done once the run read the page", async () => {
    await registerReaderTools();
    answersAtOnce("OK");
    const failed = await executePlan("s-empty-answer-plan");
    expect(failed.metadata?.["failed"]).toBe(1);
    expect(failed.metadata?.["done"]).toBe(0);
    expect(failed.output).toContain("2 characters");

    readsThenAnswers("Gegründet 1998, 42 Mitarbeitende.");
    const done = await executePlan("s-read-page-plan");
    expect(done.metadata?.["done"]).toBe(1);
    expect(done.metadata?.["failed"]).toBe(0);
    expect(done.output).toContain("1998");
  }, 60_000);
});
