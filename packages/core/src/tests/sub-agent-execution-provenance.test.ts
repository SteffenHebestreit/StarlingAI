import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "../tools/registry.js";
import {
  INCIDENT,
  INCIDENT_EXECUTIONS,
  INVENTED_FIGURES,
  MASKED_REPLY,
  recordedResult,
} from "./support/figure-provenance-incident.js";

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
 * A RUN WHOSE CODE NEVER COMPLETED WITH OUTPUT CANNOT HAND BACK A COMPUTED FIGURE (E2E 2026-10-07).
 *
 * The coder wrote primes.js; three of its sandbox runs failed, three printed nothing, and run_script
 * failed too. Its answer gave a table with "8.393" primes summing to "7.597.648.268", values no tool
 * had returned, and the run reported success. The run now counts its executions at the call site
 * and, while none of them completed with output, masks every figure of its answer that nothing it
 * received or executed contained, and does not report success.
 */
type Message = { role: string; content?: string | null };
type Handler = (args: Record<string, unknown>) => ToolResult;

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const call = (id: string, name: string, args: Record<string, unknown>) =>
  ({ content: "", tool_calls: [{ id, name, arguments: args }], usage, finishReason: "tool_calls" });
const answer = (content: string) => ({ content, tool_calls: [], usage, finishReason: "stop" });
const toolResultsIn = (messages: Message[]) => messages.filter((m) => m.role === "tool").length;
const systemIncludes = (messages: Message[], marker: string) =>
  messages.some((m) => m.role === "system" && String(m.content ?? "").includes(marker));
const promptText = (messages: Message[]) => messages.map((m) => String(m.content ?? "")).join("\n");
/** The trailing system message: where the loop's per-iteration nudges ride. */
const trailingNudge = (messages: Message[]) => {
  const last = messages.at(-1);
  return last?.role === "system" && messages.length > 1 ? String(last.content ?? "") : "";
};

/** A script of calls, one per iteration, then the answer. */
const scripted = (calls: Array<{ tool: string; args: Record<string, unknown> }>, finalAnswer: string) =>
  (messages: Message[]) => {
    const done = toolResultsIn(messages);
    const next = calls[done];
    return next ? call(`c${done + 1}`, next.tool, next.args) : answer(finalAnswer);
  };
/** The same script followed in call order, for a run whose trim drops tool results from the prompt. */
const inCallOrder = (calls: Array<{ tool: string; args: Record<string, unknown> }>, finalAnswer: string) => {
  let made = 0;
  return () => {
    const next = calls[made];
    made += 1;
    return next ? call(`c${made}`, next.tool, next.args) : answer(finalAnswer);
  };
};

const silent = (command: string): ToolResult =>
  ({ success: true, output: "(no output)", metadata: { command, exitCode: 0, sandboxed: true, programOutputChars: 0 } });
const failed = (stderr = ""): ToolResult => ({
  success: false,
  output: stderr,
  error: `Exit code 1: Command failed: docker run --rm --network=none starlingai/sandbox:latest sh -lc node check.js\n${stderr}`,
  metadata: { sandboxed: true, exitCode: 1, programOutputChars: stderr.trim().length },
});
const printed = (output: string): ToolResult =>
  ({ success: true, output, metadata: { exitCode: 0, sandboxed: true, programOutputChars: output.trim().length } });

describe("the code a delegated run executed, and the figures it states", () => {
  let tempDir = "";
  let shared: Array<Record<string, unknown>> = [];

  const writeConfig = (contextWindow?: number) => {
    const coderTools = [
      "write_file", "read_file", "list_files", "grep_files", "shell_exec", "run_script",
      "share_finding", "share_evidence", "read_shared_facts", "git_commit",
    ];
    writeFileSync(join(tempDir, "starlingai.json"), JSON.stringify({
      // The outcomes ledger is written under the deployment's workspace (agent/outcomes.ts).
      workspacePath: tempDir,
      subAgents: {
        coder: {
          description: "Writes and runs code in the sandbox.",
          systemPrompt: "CODER-KQ Write the script, run it in the sandbox and report what it printed.",
          tools: coderTools,
          maxIterations: 10,
        },
        short_coder: {
          description: "Writes and runs code in the sandbox, briefly.",
          systemPrompt: "SHORT-KQ Run the script in the sandbox and report what it printed.",
          tools: coderTools,
          maxIterations: 4,
        },
        one_shot_coder: {
          description: "Runs a batch of checks in the sandbox.",
          systemPrompt: "ONE-SHOT-KQ Run the checks in the sandbox and report what they printed.",
          tools: ["shell_exec"],
          maxIterations: 1,
        },
        facts_coder: {
          description: "Runs one script in the sandbox and reports.",
          systemPrompt: "FACTS-KQ Run the script in the sandbox and report what it printed.",
          tools: ["shell_exec", "share_finding"],
          maxIterations: 1,
        },
        lean_coder: {
          description: "Reads notes and runs code in the sandbox.",
          systemPrompt: "LEAN-KQ Read the notes, run the check and report.",
          tools: ["read_file", "shell_exec"],
          maxIterations: 6,
          ...(contextWindow ? { model: { contextWindow } } : {}),
        },
        build_lead: {
          description: "Coordinates code work.",
          systemPrompt: "LEAD-KQ Hand the computation to the coder.",
          tools: ["delegate_to_agent", "share_finding"],
          maxIterations: 4,
        },
        notes_lead: {
          description: "Coordinates a code check and reads notes.",
          systemPrompt: "NOTES-LEAD-KQ Have the coder check the code, read the notes and summarize.",
          tools: ["delegate_to_agent", "read_file"],
          maxIterations: 4,
        },
      },
    }), "utf8");
  };

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "sai-execution-provenance-"));
    shared = [];
    writeConfig();
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

  /** Fake tools, registered after the real ones have loaded, so none of them replaces a fake mid-run.
   *  `realShare` keeps the real share_finding, which formats what it stores and echoes it. */
  const registerTools = async (handlers: Record<string, Handler>, { realShare = false } = {}) => {
    await import("../tools/sub-agent.js");
    await Promise.all([
      import("../tools/filesystem.js"),
      import("../tools/code-navigation.js"),
      import("../tools/shell.js"),
      import("../tools/git.js"),
      import("../tools/memory.js"),
    ]);
    const { registerTool } = await import("../tools/registry.js");
    const all: Record<string, Handler> = {
      ...(realShare ? {} : {
        share_finding: (args: Record<string, unknown>) => {
          shared.push(args);
          return { success: true, output: `Finding "${String(args["key"])}" shared.` };
        },
      }),
      git_commit: () => ({ success: true, output: "[main 4f3c2a1] add primes script\n 1 file changed, 23 insertions(+)", metadata: { sandboxed: true } }),
      ...handlers,
    };
    for (const [name, execute] of Object.entries(all)) {
      registerTool({
        name,
        description: `Fake ${name}.`,
        parameters: { type: "object", properties: {} },
        async execute(args) {
          return execute(args);
        },
      });
    }
  };

  /** The recorded results of the incident, by tool and arguments. */
  const incidentTools = (): Record<string, Handler> => ({
    write_file: (args) => recordedResult("write_file", args),
    list_files: (args) => recordedResult("list_files", args),
    shell_exec: (args) => recordedResult("shell_exec", args),
    run_script: (args) => recordedResult("run_script", args),
  });

  const runAgent = async (agentName: string, task: string, parentSessionId: string) => {
    const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
    return runSubAgentWithStats({
      agentName,
      task,
      parentSessionId,
      workspacePath: tempDir,
      approvalCallback: async () => true,
    });
  };

  const captureAudit = async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const { subscribeToAudit } = await import("../audit/logger.js");
    const unsubscribe = subscribeToAudit((event) => {
      events.push({ type: event.type, data: event.data as Record<string, unknown> });
    });
    return { events, unsubscribe };
  };

  it("(a) the incident replayed: its two invented figures are masked and the run is partial", async () => {
    await registerTools(incidentTools());
    // Read when each call is made: the history's messages are rewritten in place later on.
    const nudges: string[] = [];
    completeMock.mockImplementation(async (messages: Message[]) => {
      nudges.push(trailingNudge(messages));
      return scripted(INCIDENT.calls, INCIDENT.reply)(messages);
    });
    const audit = await captureAudit();

    try {
      const result = await runAgent("coder", INCIDENT.task, "parent-provenance-incident");

      // The replay is the incident: every recorded call ran, and the reply came back after them.
      expect(completeMock).toHaveBeenCalledTimes(INCIDENT.calls.length + 1);
      // The ninth call and the forced tenth were told what the executions did, not "synthesize".
      expect(nudges[8]).toContain("None of your 6 code executions has completed with output yet (3 failed, 3 printed nothing)");
      expect(nudges[9]).toContain("None of your 7 code executions completed with output (4 failed, 3 printed nothing)");
      expect(result.output).toBe(MASKED_REPLY);
      for (const figure of INVENTED_FIGURES) expect(result.output).not.toContain(figure);
      expect(result.output).toContain("[100000, 200000]");
      expect(result.stats.outcome).toBe("partial");
      expect(result.executions).toEqual(INCIDENT_EXECUTIONS);
      // What it did write is still reported.
      expect(result.artifacts?.some((artifact) => artifact["outputPath"] === "generated/primes.js")).toBe(true);
      const flagged = audit.events.find((event) => event.type === "guardrail_flagged"
        && event.data["type"] === "sub_agent_unobserved_figures_masked");
      expect(flagged?.data).toMatchObject({ agentName: "coder", site: "final_answer", masked: 2, attempted: 7, failed: 4 });
      const completed = audit.events.find((event) => event.type === "sub_agent_completed" && event.data["agentName"] === "coder");
      expect(completed?.data["executions"]).toEqual(INCIDENT_EXECUTIONS);
      expect(completed?.data["outcome"]).toBe("partial");
      // The outcomes ledger, which routing and memory feedback read, gets the same verdict.
      const { readRecentOutcomes } = await import("../agent/outcomes.js");
      expect(readRecentOutcomes(tempDir).at(-1)).toMatchObject({ agent: "coder", outcome: "partial" });
      // Each sandbox call's audit row says how it ended and what it printed: the E2E check reads it.
      const done = (toolCallId: string) => audit.events.find((event) => event.type === "sub_agent_tool_call"
        && event.data["phase"] === "done" && event.data["toolCallId"] === toolCallId);
      expect(done("c2")?.data["metadata"]).toMatchObject({ exitCode: 1, programOutputChars: 0 });
      expect(done("c6")?.data["metadata"]).toMatchObject({ exitCode: 0, programOutputChars: 0 });
    } finally {
      audit.unsubscribe();
    }
  }, 60_000);

  it("(b) counts every execution, past the six failed calls the run hands back", async () => {
    const runs = [
      ...["node a.js", "node b.js", "node c.js", "node d.js"].map((command) => ({ tool: "shell_exec", args: { command } })),
      ...["a.js", "b.js", "c.js", "d.js"].map((path) => ({ tool: "run_script", args: { path } })),
    ];
    await registerTools({ shell_exec: () => failed(), run_script: () => failed() });
    completeMock.mockImplementation(async (messages: Message[]) => scripted(runs, "Keine Ausführung lief durch.")(messages));

    const result = await runAgent("coder", "Run the four scripts.", "parent-provenance-uncapped");

    expect(result.toolFailures).toHaveLength(6);
    expect(result.executions).toEqual({ attempted: 8, failed: 8, succeededWithOutput: 0 });
  }, 60_000);

  it("(c) a git call is not an execution: its output cannot stand in for a computation", async () => {
    await registerTools({ shell_exec: () => failed() });
    completeMock.mockImplementation(async (messages: Message[]) => scripted([
      { tool: "git_commit", args: { message: "add primes script" } },
      { tool: "shell_exec", args: { command: "node primes.js" } },
    ], "Die Summe ist 1255204276.")(messages));

    const result = await runAgent("coder", "Commit the script, run it and give the sum.", "parent-provenance-git");

    expect(result.executions).toEqual({ attempted: 1, failed: 1, succeededWithOutput: 0, unobservedFigures: 1 });
    expect(result.output).toBe("Die Summe ist [not observed].");
  }, 60_000);

  it("(d) a figure shared while no execution has completed with output reaches the store masked", async () => {
    await registerTools({ shell_exec: () => failed() });
    completeMock.mockImplementation(async (messages: Message[]) => scripted([
      { tool: "shell_exec", args: { command: "node primes.js" } },
      { tool: "share_finding", args: { key: "prime_count", value: "8393" } },
    ], "Das Skript lief nicht.")(messages));

    const result = await runAgent("coder", INCIDENT.task, "parent-provenance-share");

    expect(shared).toEqual([{ key: "prime_count", value: "[not observed]" }]);
    expect(result.executions?.unobservedFigures).toBe(1);
    expect(result.stats.outcome).not.toBe("success");
  }, 60_000);

  describe("(e) the last two nudges say what the executions did instead of 'synthesize what you gathered'", () => {
    const runShort = async (firstResult: ToolResult) => {
      await registerTools({
        shell_exec: (args) => (args["command"] === "mkdir -p out" ? firstResult : failed()),
        run_script: () => failed(),
      });
      // Read when each call is made: the history's messages are rewritten in place later on.
      const nudges: string[] = [];
      completeMock.mockImplementation(async (messages: Message[]) => {
        nudges.push(trailingNudge(messages));
        return scripted([
          { tool: "shell_exec", args: { command: "mkdir -p out" } },
          { tool: "shell_exec", args: { command: "node primes.js" } },
          { tool: "run_script", args: { path: "primes.js" } },
        ], "Nichts lief durch.")(messages);
      });
      await runAgent("short_coder", "Run primes.js and report the count.", "parent-provenance-nudges");
      expect(nudges).toHaveLength(4);
      return { budgetWarning: nudges[2]!, finalIteration: nudges[3]! };
    };

    it("while none completed with output", async () => {
      const { budgetWarning, finalIteration } = await runShort(silent("mkdir -p out"));
      expect(finalIteration).toContain("FINAL ITERATION");
      expect(finalIteration).toContain("None of your 3 code executions completed with output (2 failed, 1 printed nothing)");
      expect(finalIteration).not.toContain("Synthesize everything you have gathered");
      expect(budgetWarning).toContain("BUDGET WARNING");
      expect(budgetWarning).toContain("None of your 2 code executions has completed with output yet (1 failed, 1 printed nothing)");
      expect(budgetWarning).not.toContain("You have already gathered substantial content");
    }, 60_000);

    it("control: an execution that printed keeps both original texts", async () => {
      const { budgetWarning, finalIteration } = await runShort(printed("created out/"));
      expect(finalIteration).toContain("Synthesize everything you have gathered");
      expect(finalIteration).not.toContain("None of your");
      expect(budgetWarning).toContain("You have already gathered substantial content");
      expect(budgetWarning).not.toContain("None of your");
    }, 60_000);

    it("control: a coordinator that ran no code itself keeps both original texts", async () => {
      // Its record adds up its coder's, whose one grep matched nothing (exit 1), and nothing was
      // masked. Told "None of your 1 code execution…", it was invited to delegate again, and its
      // final nudge lost "include ALL content … verbatim" for the notes it had read.
      await registerTools({
        shell_exec: () => failed(),
        read_file: (args) => ({ success: true, output: `Inhalt von ${String(args["path"])}: Die API antwortet mit Status ok.` }),
      });
      const nudges: string[] = [];
      completeMock.mockImplementation(async (messages: Message[]) => {
        if (!systemIncludes(messages, "NOTES-LEAD-KQ")) {
          return scripted([{ tool: "shell_exec", args: { command: "grep -n TODO src/app.js" } }], "Keine TODO-Einträge gefunden.")(messages);
        }
        nudges.push(trailingNudge(messages));
        return scripted([
          { tool: "delegate_to_agent", args: { agentName: "coder", task: "Suche TODO in src/app.js." } },
          { tool: "read_file", args: { path: "notes/api.md" } },
          { tool: "read_file", args: { path: "notes/status.md" } },
        ], "Zusammenfassung der Notizen.")(messages);
      });

      const result = await runAgent("notes_lead", "Fasse die Notizen zusammen und prüfe die TODOs.", "parent-provenance-lead-nudges");

      expect(result.executions).toEqual({ attempted: 1, failed: 1, succeededWithOutput: 0 });
      expect(nudges).toHaveLength(4);
      expect(nudges[2]).toContain("You have already gathered substantial content");
      expect(nudges[2]).not.toContain("None of your");
      expect(nudges[3]).toContain("Synthesize everything you have gathered");
      expect(nudges[3]).not.toContain("None of your");
    }, 60_000);
  });

  it("(f) a figure the run read early still counts after the trim removed it from the history", async () => {
    // Small window: the read result fits on the second call, and once it is stale and the long
    // stack trace has arrived the trim drops or digests it.
    writeConfig(TRIM_CONTEXT_WINDOW);
    (await import("../config/loader.js")).resetConfigForTests();
    // 4711 sits past the digest's 1,200-character head and before its 400-character tail.
    const notes = [
      "Projektnotizen zur Sandbox.",
      ...Array.from({ length: 30 }, () => "Eine Zeile ohne Zahlen, damit die Notiz lang genug ist."),
      "Kennzahl: 4711",
      ...Array.from({ length: 14 }, () => "Noch eine Zeile ohne Zahlen am Ende der Notiz."),
    ].join("\n");
    const stackTrace = Array.from({ length: 90 }, () => "    at Object.<anonymous> (/workspace/check.js) node internal module loader").join("\n");
    await registerTools({
      read_file: () => ({ success: true, output: notes }),
      shell_exec: (args) => (args["command"] === "node check.js" ? failed(stackTrace) : silent(String(args["command"]))),
    });
    const finalAnswer = "Laut notes.txt ist die Kennzahl 4711; berechnet wurde nichts, keine Ausführung lieferte eine Ausgabe.";
    const next = inCallOrder([
      { tool: "read_file", args: { path: "notes.txt" } },
      { tool: "shell_exec", args: { command: "node check.js" } },
      { tool: "shell_exec", args: { command: "node check.js --quiet" } },
    ], finalAnswer);
    // Read when each call is made: the trim rewrites the history's messages in place.
    const prompts: string[] = [];
    completeMock.mockImplementation(async (messages: Message[]) => {
      prompts.push(promptText(messages));
      return next();
    });

    const result = await runAgent("lean_coder", "Read notes.txt, then run check.js.", "parent-provenance-trim");

    // The precondition, or this proves nothing: the model read 4711, and the trim later removed it.
    expect(prompts).toHaveLength(4);
    expect(prompts[1]).toContain("Kennzahl: 4711");
    expect(prompts[3]).not.toContain("4711");
    expect(result.executions).toEqual({ attempted: 2, failed: 1, succeededWithOutput: 0 });
    expect(result.output).toBe(finalAnswer);
  }, 60_000);

  describe("(g) controls: what no figure check may touch", () => {
    it("a run whose script printed keeps its figures in any grouping and succeeds", async () => {
      await registerTools({ shell_exec: () => printed("Anzahl der Primzahlen: 8392\nSumme der Primzahlen:   1255204276") });
      const finalAnswer = "Es gibt 8.392 Primzahlen zwischen 100.000 und 200.000; ihre Summe ist 1.255.204.276.";
      completeMock.mockImplementation(async (messages: Message[]) => scripted([
        { tool: "shell_exec", args: { command: "node primes.js" } },
      ], finalAnswer)(messages));

      const result = await runAgent("coder", INCIDENT.task, "parent-provenance-printed");

      expect(result.output).toBe(finalAnswer);
      expect(result.stats.outcome).toBe("success");
    }, 60_000);

    it("a silent run whose answer states no figure is left as it was", async () => {
      await registerTools({ shell_exec: (args) => silent(String(args["command"])) });
      const finalAnswer = "Der Ordner out ist angelegt.";
      completeMock.mockImplementation(async (messages: Message[]) => scripted([
        { tool: "shell_exec", args: { command: "mkdir -p out" } },
      ], finalAnswer)(messages));

      const result = await runAgent("coder", "Create the folder out.", "parent-provenance-mkdir");

      expect(result.output).toBe(finalAnswer);
      expect(result.stats.outcome).toBe("success");
    }, 60_000);

    it("an honest report quotes the command and the exit code it saw", async () => {
      await registerTools({ ...incidentTools() });
      const finalAnswer = "Das Skript primes.js lief nicht: run_script endete mit Exit code 1, und `ls /usr/bin/ | head -50` gab nichts aus. "
        + "Ich nenne deshalb keine Zahlen.";
      completeMock.mockImplementation(async (messages: Message[]) => scripted([
        { tool: "shell_exec", args: { command: "ls /usr/bin/ | head -50" } },
        { tool: "run_script", args: { path: "primes.js" } },
      ], finalAnswer)(messages));

      const result = await runAgent("coder", INCIDENT.task, "parent-provenance-honest");

      expect(result.output).toBe(finalAnswer);
      expect(result.executions?.unobservedFigures).toBeUndefined();
    }, 60_000);
  });

  it("(h) a coordinator whose specialist masked figures did not succeed either", async () => {
    await registerTools(incidentTools());
    completeMock.mockImplementation(async (messages: Message[]) => {
      if (!systemIncludes(messages, "LEAD-KQ")) return scripted(INCIDENT.calls, INCIDENT.reply)(messages);
      return toolResultsIn(messages) === 0
        ? call("d1", "delegate_to_agent", { agentName: "coder", task: INCIDENT.task })
        : answer("Der Coder hat primes.js geschrieben, aber keine Ausführung lieferte ein Ergebnis.");
    });

    const result = await runAgent("build_lead", INCIDENT.task, "parent-provenance-coordinator");

    expect(result.executions?.unobservedFigures).toBe(2);
    expect(result.stats.outcome).toBe("partial");
  }, 60_000);

  describe("(h) a coordinator that holds no sandbox tool", () => {
    // Its coder's figures came back masked, and it filled them in from its own head: in review,
    // build_lead answered "8392 … 1255204276" over a coder whose only execution had failed, and
    // nothing masked its answer or its share, because it held no tool that runs code.
    it("is masked against what it received, in its answer and in what it shares", async () => {
      await registerTools(incidentTools());
      completeMock.mockImplementation(async (messages: Message[]) => {
        if (!systemIncludes(messages, "LEAD-KQ")) return scripted(INCIDENT.calls, INCIDENT.reply)(messages);
        return scripted([
          { tool: "delegate_to_agent", args: { agentName: "coder", task: INCIDENT.task } },
          { tool: "share_finding", args: { key: "prime_sum", value: "1255204276" } },
        ], "Ergebnis: Es gibt 8392 Primzahlen, ihre Summe ist 1255204276.")(messages);
      });

      const result = await runAgent("build_lead", INCIDENT.task, "parent-provenance-coordinator-own");

      expect(result.output).toBe("Ergebnis: Es gibt [not observed] Primzahlen, ihre Summe ist [not observed].");
      expect(shared).toEqual([{ key: "prime_sum", value: "[not observed]" }]);
      // The coder's two, the share's one and the answer's two.
      expect(result.executions).toEqual({ ...INCIDENT_EXECUTIONS, unobservedFigures: 5 });
      expect(result.stats.outcome).toBe("partial");
    }, 60_000);

    it("control: what its coder's script printed it restates as it was", async () => {
      await registerTools({ shell_exec: () => printed("Anzahl der Primzahlen: 8392\nSumme der Primzahlen:   1255204276") });
      const leadAnswer = "Ergebnis: Es gibt 8.392 Primzahlen, ihre Summe ist 1.255.204.276.";
      completeMock.mockImplementation(async (messages: Message[]) => {
        if (!systemIncludes(messages, "LEAD-KQ")) {
          return scripted([{ tool: "shell_exec", args: { command: "node primes.js" } }], "Es gibt 8392 Primzahlen, Summe 1255204276.")(messages);
        }
        return scripted([{ tool: "delegate_to_agent", args: { agentName: "coder", task: INCIDENT.task } }], leadAnswer)(messages);
      });

      const result = await runAgent("build_lead", INCIDENT.task, "parent-provenance-coordinator-printed");

      expect(result.output).toBe(leadAnswer);
      expect(result.executions).toEqual({ attempted: 1, failed: 0, succeededWithOutput: 1 });
      expect(result.stats.outcome).toBe("success");
    }, 60_000);
  });

  it("(i) a figure a productive run states that no input contained is measured, never masked", async () => {
    // The partial-output case the mask leaves alone: a script printed, so the gate is closed, and
    // the audit counts what the mask would have caught, so the gate can be widened with data.
    await registerTools({ shell_exec: () => printed("Anzahl der Primzahlen: 8392\nSumme der Primzahlen:   1255204276") });
    const finalAnswer = "Es gibt 8.392 Primzahlen; ihre Summe ist 1.255.204.276, die größte von ihnen ist 199.999.";
    completeMock.mockImplementation(async (messages: Message[]) => scripted([
      { tool: "shell_exec", args: { command: "node primes.js" } },
    ], finalAnswer)(messages));
    const audit = await captureAudit();

    try {
      const result = await runAgent("coder", INCIDENT.task, "parent-provenance-shadow");

      expect(result.output).toBe(finalAnswer);
      expect(result.stats.outcome).toBe("success");
      expect(result.executions).toEqual({ attempted: 1, failed: 0, succeededWithOutput: 1 });
      const completed = audit.events.find((event) => event.type === "sub_agent_completed" && event.data["agentName"] === "coder");
      expect(completed?.data["shadowUnobservedFigures"]).toBe(1);
      expect(audit.events.some((event) => event.type === "guardrail_flagged"
        && event.data["type"] === "sub_agent_unobserved_figures_masked")).toBe(false);
    } finally {
      audit.unsubscribe();
    }
  }, 60_000);

  it("(j) the runtime's own account of an interrupted run keeps its figures", async () => {
    // The model answered nothing twice, so the run hands back the scaffold the runtime builds from
    // what is on disk. Its byte count came from the file system, not from the model.
    mkdirSync(join(tempDir, "generated"), { recursive: true });
    writeFileSync(join(tempDir, "generated", "primes.js"), "x".repeat(1187), "utf8");
    await registerTools({
      write_file: () => ({
        success: true,
        output: "File written: generated/primes.js",
        metadata: { filename: "primes.js", outputPath: "generated/primes.js", contentType: "text/javascript; charset=utf-8", previewMode: "text" },
      }),
      shell_exec: () => failed(),
    });
    completeMock.mockImplementation(async (messages: Message[]) => scripted([
      { tool: "write_file", args: { path: "primes.js", content: "console.log(count)" } },
      { tool: "shell_exec", args: { command: "node primes.js" } },
    ], "")(messages));

    const result = await runAgent("coder", INCIDENT.task, "parent-provenance-scaffold");

    expect(result.output).toContain("generated/primes.js (1187 bytes on disk)");
    expect(result.output).not.toContain("[not observed]");
    expect(result.stats.outcome).toBe("partial");
    expect(result.executions).toEqual({ attempted: 1, failed: 1, succeededWithOutput: 0 });
  }, 60_000);

  describe("(l) what the run wrote, handed back to it, is not evidence for it", () => {
    // The sandbox is broken: the coder writes its "result" into results.md from its head, its one
    // execution fails, and it reads the file back. The write's arguments were never evidence; the
    // read hands the same figure back, and it was counted as one the run had received.
    const RESULTS = "# Ergebnis\nAnzahl der Primzahlen: 8393\n";
    const writeResults = { tool: "write_file", args: { path: "results.md", content: RESULTS } };
    const writeTool = (args: Record<string, unknown>): ToolResult => ({
      success: true,
      output: `File written: generated/${String(args["path"])} (${String(args["content"]).length} chars)`,
      metadata: { filename: String(args["path"]), outputPath: `generated/${String(args["path"])}`, contentType: "text/markdown", previewMode: "text" },
    });

    const runReadBack = async (readCall: { tool: string; args: Record<string, unknown> }, handlers: Record<string, Handler>) => {
      await registerTools({ write_file: writeTool, shell_exec: () => failed(), ...handlers });
      completeMock.mockImplementation(async (messages: Message[]) => scripted([
        writeResults,
        { tool: "shell_exec", args: { command: "node primes.js" } },
        readCall,
      ], "Es gibt 8393 Primzahlen.")(messages));
      return runAgent("coder", INCIDENT.task, "parent-provenance-read-back");
    };

    it("read_file of the file it wrote", async () => {
      const result = await runReadBack({ tool: "read_file", args: { path: "results.md" } }, {
        read_file: () => ({ success: true, output: RESULTS }),
      });

      expect(result.output).toBe("Es gibt [not observed] Primzahlen.");
      expect(result.executions).toEqual({ attempted: 1, failed: 1, succeededWithOutput: 0, unobservedFigures: 1 });
      expect(result.stats.outcome).toBe("partial");
    }, 60_000);

    it("grep_files over it", async () => {
      const result = await runReadBack({ tool: "grep_files", args: { pattern: "Anzahl" } }, {
        grep_files: () => ({ success: true, output: "generated/results.md:2\n> 2\tAnzahl der Primzahlen: 8393" }),
      });

      expect(result.output).toBe("Es gibt [not observed] Primzahlen.");
      expect(result.executions?.unobservedFigures).toBe(1);
    }, 60_000);

    it("control: a file its program wrote is evidence", async () => {
      // The program redirected what it printed, so the execution itself printed nothing; the file
      // holds what the program computed, not what the run wrote.
      await registerTools({
        write_file: writeTool,
        shell_exec: (args) => silent(String(args["command"])),
        read_file: () => ({ success: true, output: "Anzahl der Primzahlen: 8392\n" }),
      });
      completeMock.mockImplementation(async (messages: Message[]) => scripted([
        { tool: "write_file", args: { path: "primes.js", content: "console.log(count)" } },
        { tool: "shell_exec", args: { command: "node primes.js > out.txt" } },
        { tool: "read_file", args: { path: "out.txt" } },
      ], "Es gibt 8392 Primzahlen.")(messages));

      const result = await runAgent("coder", INCIDENT.task, "parent-provenance-program-file");

      expect(result.output).toBe("Es gibt 8392 Primzahlen.");
      expect(result.executions).toEqual({ attempted: 1, failed: 0, succeededWithOutput: 0 });
    }, 60_000);
  });

  describe("(m) what the run shared, with the real share_finding", () => {
    const sharedFacts = async (root: string) => (await import("../swarm/memory.js")).readAllFacts(root);

    it("a figure shared before its first execution does not come back as evidence", async () => {
      // The gate is still closed when it shares, so the value is stored as given. Its echo, the
      // shared-findings refresh and read_shared_facts then hand the figure back to the run.
      await registerTools({ shell_exec: () => failed() }, { realShare: true });
      completeMock.mockImplementation(async (messages: Message[]) => scripted([
        { tool: "share_finding", args: { key: "prime_count", value: "8393" } },
        { tool: "shell_exec", args: { command: "node primes.js" } },
        { tool: "read_shared_facts", args: {} },
      ], "Es gibt 8393 Primzahlen.")(messages));

      const result = await runAgent("coder", INCIDENT.task, "parent-provenance-share-first");

      // The precondition: the run did read its own figure back, three ways.
      const prompts = completeMock.mock.calls.map(([messages]) => promptText(messages as Message[]));
      expect(prompts.at(-1)).toContain("'prime_count' = \"8393\"");
      expect(prompts.at(-1)).toContain("- prime_count: 8393");
      expect(prompts.at(-1)).toContain("**prime_count**: 8393");
      expect(result.output).toBe("Es gibt [not observed] Primzahlen.");
      expect(result.executions?.unobservedFigures).toBe(1);
      expect(result.stats.outcome).toBe("partial");
    }, 60_000);

    it("every free-text field of a share made while no execution completed is masked", async () => {
      await registerTools({ shell_exec: () => failed() }, { realShare: true });
      completeMock.mockImplementation(async (messages: Message[]) => scripted([
        { tool: "shell_exec", args: { command: "node primes.js" } },
        {
          tool: "share_finding",
          args: {
            key: "prime_count",
            value: "Primzahlen im Bereich",
            notes: "Anzahl 8393",
            sourceTitle: "Lauf vom 4711",
            sourceUrl: "https://example.test/runs/4712",
          },
        },
      ], "Es gibt 8393 Primzahlen.")(messages));

      const result = await runAgent("coder", INCIDENT.task, "parent-provenance-share-notes");

      const stored = (await sharedFacts("parent-provenance-share-notes"))["prime_count"];
      expect(stored).toContain("notes: Anzahl [not observed]");
      expect(stored).toContain("source_title: Lauf vom [not observed]");
      // The key and the URL identify the finding and its source; they are left as given.
      expect(stored).toContain("source_url: https://example.test/runs/4712");
      expect(stored).not.toContain("8393");
      expect(result.output).toBe("Es gibt [not observed] Primzahlen.");
      expect(result.executions?.unobservedFigures).toBe(3);
    }, 60_000);

    it("share_evidence publishes to the same store and is held to the same rule", async () => {
      await registerTools({ shell_exec: () => failed() }, { realShare: true });
      completeMock.mockImplementation(async (messages: Message[]) => scripted([
        { tool: "shell_exec", args: { command: "node primes.js" } },
        {
          tool: "share_evidence",
          args: {
            key: "prime_count",
            value: "8393 Primzahlen",
            claim: "Im Bereich liegen 8393 Primzahlen.",
            sourceTitle: "primes.js",
            sourceUrl: "https://example.test/runs/4712",
            evidenceType: "derived",
            accuracyScore: 0.5,
            trustworthinessScore: 0.5,
            corroborationScore: 0.5,
            validationStatus: "unverified",
          },
        },
      ], "Das Skript lief nicht.")(messages));

      const result = await runAgent("coder", INCIDENT.task, "parent-provenance-share-evidence");

      const stored = (await sharedFacts("parent-provenance-share-evidence"))["prime_count"];
      expect(stored).toContain("claim: Im Bereich liegen [not observed] Primzahlen.");
      expect(stored).not.toContain("8393");
      expect(result.executions?.unobservedFigures).toBe(2);
    }, 60_000);
  });

  describe("(n) the facts-first synthesis prompt is something the run received", () => {
    // Once the session's shared findings pass 400 characters, the grace, soft-deadline and
    // max-iterations syntheses replace the history with them (buildFactsFirstSynthesisMessages).
    // The snapshot the run started with holds at most 12 of them, so a later one reaches the
    // model only through this prompt.
    const FILLER = "Eine lange Notiz eines anderen Agenten ohne jede Zahl, nur damit die Momentaufnahme im Auftrag voll ist "
      + "und weitere Funde nicht mehr hineinpassen, wie bei einer langen Sitzung mit vielen geteilten Funden.";
    const seedFacts = async (root: string) => {
      const { writeSharedFact } = await import("../swarm/memory.js");
      for (const letter of "abcdefghijkl") await writeSharedFact(root, `${letter}_note`, FILLER);
      await writeSharedFact(root, "zz_population", "Berlin hatte laut Statistikamt 3850809 Einwohner.");
    };
    const runFactsFirst = async (root: string, calls: Array<{ name: string; arguments: Record<string, unknown> }>, finalAnswer: string) => {
      await seedFacts(root);
      await registerTools({ shell_exec: () => failed() }, { realShare: true });
      const prompts: string[] = [];
      completeMock.mockImplementation(async (messages: Message[]) => {
        prompts.push(promptText(messages));
        if (prompts.length > 1) return answer(finalAnswer);
        return { content: "", tool_calls: calls.map((entry, index) => ({ id: `c${index + 1}`, ...entry })), usage, finishReason: "tool_calls" };
      });
      const result = await runAgent("facts_coder", "Zaehle die Primzahlen.", root);
      // The precondition: the synthesis took the facts-first path.
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain("CURATED FINDINGS");
      return { result, prompts };
    };

    it("a teammate's figure it was given there is not masked", async () => {
      const finalAnswer = "Die Primzahlen konnte ich nicht berechnen, das Skript lief nicht. Aus den Funden: Berlin hatte 3850809 Einwohner.";
      const { result, prompts } = await runFactsFirst("parent-provenance-facts-first", [
        { name: "shell_exec", arguments: { command: "node primes.js" } },
      ], finalAnswer);

      expect(prompts[0]).not.toContain("3850809");
      expect(prompts[1]).toContain("3850809");
      expect(result.output).toBe(finalAnswer);
      expect(result.executions).toEqual({ attempted: 1, failed: 1, succeededWithOutput: 0 });
    }, 60_000);

    it("a figure the run shared itself stays its own claim there", async () => {
      const { result, prompts } = await runFactsFirst("parent-provenance-facts-first-own", [
        { name: "share_finding", arguments: { key: "prime_count", value: "8393" } },
        { name: "shell_exec", arguments: { command: "node primes.js" } },
      ], "Es gibt 8393 Primzahlen.");

      expect(prompts[1]).toContain("- 8393");
      expect(result.output).toBe("Es gibt [not observed] Primzahlen.");
      expect(result.executions?.unobservedFigures).toBe(1);
    }, 60_000);
  });

  it("(k) a figure the runtime's forced-answer instruction gave the run is one it received", async () => {
    // Ten checks in the run's only iteration, all failing; the synthesis comes back empty, and the
    // rescue tells the model how many tool calls it made. The count it repeats is not made up.
    const commands = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map((name) => `node ${name}.js`);
    await registerTools({ shell_exec: () => failed() });
    completeMock.mockImplementation(async (messages: Message[]) => {
      const nudge = trailingNudge(messages);
      const rescue = /from (\d+) tool calls/.exec(nudge);
      if (rescue) return answer(`Keine der ${rescue[1]} Ausführungen lieferte eine Ausgabe.`);
      if (nudge.includes("exhausted your tool-call budget")) return answer("");
      return {
        content: "",
        tool_calls: commands.map((command, index) => ({ id: `c${index + 1}`, name: "shell_exec", arguments: { command } })),
        usage,
        finishReason: "tool_calls",
      };
    });

    const result = await runAgent("one_shot_coder", "Run the ten checks.", "parent-provenance-rescue");

    expect(completeMock).toHaveBeenCalledTimes(3);
    expect(result.output).toBe("Keine der 10 Ausführungen lieferte eine Ausgabe.");
    expect(result.executions?.unobservedFigures).toBeUndefined();
  }, 60_000);
});

/** Sized so the read result fits on the second call and the history no longer does on the fourth. */
const TRIM_CONTEXT_WINDOW = 3600;
