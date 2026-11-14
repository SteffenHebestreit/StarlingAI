import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../tools/registry.js";
import type { SubAgentRunOptions, SubAgentRunResult } from "../agent/sub-agent.js";
import { OUT_OF_REACH_GUIDANCE, buildSubAgentToolInventory } from "../agent/sub-agent-prompt-guidance.js";

/**
 * A SPECIALIST WITH NO WAY TO THE FACTS A TASK NEEDS HANDS THE TASK BACK.
 *
 * Session 5b77edf9: mail_agent, handed a weather lookup, said it had no internet access and then
 * estimated the forecast "from typical November data". The estimate carried figures, so the
 * delegation counted as a success, the estimate was shared as a finding, and the coordinator
 * went on from there. Three cases had a line in the tool inventory (a run with web tools, one
 * that can search for specialists, one that can delegate); the fourth, a run with neither, had none.
 * Measured on the live model with mail_agent's real prompt: tasks outside its reach handed back
 * 0 of 9 before and 9 of 9 with the line, an invented figure in 6 of 9 before and in none.
 */
describe("the tool inventory of a run with no web tool, no way to delegate and nothing to build", () => {
  it("tells it to hand a task back that needs facts it would have to look up", () => {
    const inventory = buildSubAgentToolInventory(["mail_search", "mail_read", "read_file"]);

    expect(inventory).toContain(OUT_OF_REACH_GUIDANCE);
    // The run's own verdict, in the form the delegation reads (parseFinalAnswerTag).
    expect(OUT_OF_REACH_GUIDANCE).toContain('<final_answer status="failure">');
    expect(OUT_OF_REACH_GUIDANCE).toContain("do not answer from memory and do not estimate");
    // And what stays its own work: general knowledge, and a search of its own that finds nothing.
    expect(OUT_OF_REACH_GUIDANCE).toContain("general knowledge is yours");
    expect(OUT_OF_REACH_GUIDANCE).toContain("finds nothing");
  });

  it("leaves every run that can look things up, or hand the task on, the line it had", () => {
    for (const tools of [
      ["web_search", "web_fetch"],
      ["web_fetch", "read_file"],
      ["search_agents", "delegate_to_agent"],
      ["search_agents"],
      ["delegate_to_agent", "share_finding"],
      ["swarm_delegate"],
    ]) {
      expect(buildSubAgentToolInventory(tools), tools.join(",")).not.toContain(OUT_OF_REACH_GUIDANCE);
    }
    // Nor a run that builds artifacts: content_writer returned the tag for a text it was asked to
    // give "as plain text, no file" (3 of 3 on the live model). The routing gates keep a builder
    // from tasks that need gathering.
    for (const tools of [["generate_document", "write_file"], ["generate_chart_html", "read_file"], ["generate_image"], ["read_file", "verify_page", "edit_file"]]) {
      expect(buildSubAgentToolInventory(tools), tools.join(",")).not.toContain(OUT_OF_REACH_GUIDANCE);
    }
    // Saving notes is not building: write_file and edit_file alone do not make a builder.
    expect(buildSubAgentToolInventory(["read_file", "write_file", "edit_file", "mail_search"])).toContain(OUT_OF_REACH_GUIDANCE);
    // A run with no tools at all has its own inventory.
    expect(buildSubAgentToolInventory([])).not.toContain(OUT_OF_REACH_GUIDANCE);
    expect(buildSubAgentToolInventory(undefined)).not.toContain(OUT_OF_REACH_GUIDANCE);
  });
});

const runner = vi.hoisted(() => vi.fn());
vi.mock("../agent/sub-agent.js", () => ({
  runSubAgent: vi.fn(async () => "no spec"),
  runSubAgentWithStats: runner,
}));

describe("a specialist that hands its task back", () => {
  let tempDir = "";
  const HANDED_BACK = '<final_answer status="failure">The task needs a current weather forecast from the web, and my tools reach only the mailbox.</final_answer>';

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "sai-out-of-reach-"));
    writeFileSync(join(tempDir, "starlingai.json"), JSON.stringify({
      workspacePath: tempDir,
      agents: { defaults: { model: { primary: "mock-model" } }, ephemeralGeneration: { enabled: false } },
      subAgents: {
        mail_agent: { description: "Reads and writes mail.", systemPrompt: "Mail.", tools: ["mail_search", "mail_read"], maxIterations: 4 },
        researcher: { description: "Finds sources on the web.", systemPrompt: "Research.", tools: ["web_search", "web_fetch"], maxIterations: 4 },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = join(tempDir, "starlingai.json");
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
    runner.mockImplementation(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => ({
      output: args.agentName === "mail_agent" ? HANDED_BACK : "Bremen, this afternoon: 9 °C, light rain. Source: https://wetter.example/bremen",
      stats: {
        agentName: args.agentName, sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`, promptChars: 0, userContentChars: 0,
        toolCount: args.agentName === "mail_agent" ? 0 : 1, toolNames: args.agentName === "mail_agent" ? [] : ["web_fetch"], iterations: 1,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, maxIterations: 4, model: "mock", capabilities: [],
        terminalState: "completed", outcome: args.agentName === "mail_agent" ? "failure" : "success",
      },
    }));
  });

  afterEach(async () => {
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env["SAI_CONFIG_PATH"];
    runner.mockReset();
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
    await (await import("../swarm/memory.js")).resetSharedMemoryForTests();
  });

  const delegate = async (args: Record<string, unknown>) => {
    const { getTool } = await import("../tools/registry.js");
    await import("../tools/sub-agent.js");
    return getTool("delegate_to_agent")!.execute(
      { task: "What will the weather be in Bremen this afternoon? Give the temperature and the chance of rain.", deliverable: "answer", ...args },
      { sessionId: `s-${Math.random().toString(36).slice(2, 8)}`, workspacePath: tempDir } as ToolContext,
    );
  };

  it("fails the delegation with its sentence as the reason, and no estimate is kept", async () => {
    const result = await delegate({ agentName: "mail_agent" });

    expect(result.success).toBe(false);
    expect(result.metadata).toMatchObject({ delegationSucceeded: false, attemptedAgents: ["mail_agent"] });
    expect(result.error).toContain("my tools reach only the mailbox");
    // The tag itself is the run's verdict, not part of what the caller reads.
    expect(result.error).not.toContain("<final_answer");
  }, 30_000);

  it("lets the next agent the caller named take the task", async () => {
    const result = await delegate({ agentName: "mail_agent", fallbackAgents: ["researcher"] });

    expect(runner.mock.calls.map((call) => (call[0] as SubAgentRunOptions).agentName)).toEqual(["mail_agent", "researcher"]);
    expect(result.success).toBe(true);
    expect(result.metadata).toMatchObject({ agentName: "researcher", attemptedAgents: ["mail_agent", "researcher"] });
    expect(result.output).toContain("9 °C");
  }, 30_000);
});
