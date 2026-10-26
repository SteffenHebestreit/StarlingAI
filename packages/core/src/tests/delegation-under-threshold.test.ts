import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../tools/registry.js";
import type { SubAgentRunOptions, SubAgentRunResult } from "../agent/sub-agent.js";

/**
 * A ROUTED DELEGATION IS NEVER LEFT UNTRIED WHILE ROUTING HAD A PICK.
 *
 * E2E 2026-10-22: an update of a workspace file was routed with content_writer on top at 0.745, under
 * the deployment's skillMatchThreshold of 0.75, so nothing was queued and the task went to the
 * architect for an ephemeral agent. The architect's answer held no JSON, and the delegation failed
 * with no agent tried: "All candidate agents failed … No suitable agent completed the task."
 */
const runner = vi.hoisted(() => vi.fn());
const architect = vi.hoisted(() => vi.fn());
// The built-in architect: one completion on the default model (tools/ephemeral-agent-factory.ts).
const builtin = vi.hoisted(() => vi.fn());
const audit = vi.hoisted(() => vi.fn());
const ranking = vi.hoisted(() => ({ current: [] as Array<{ name: string; score: number }>, near: [] as Array<{ name: string; score: number }> }));

vi.mock("../agent/sub-agent.js", () => ({
  // runSubAgent is how the architect is asked for its spec; runSubAgentWithStats runs a delegation.
  runSubAgent: architect,
  runSubAgentWithStats: runner,
}));
vi.mock("../providers/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providers/index.js")>();
  return { ...actual, createChatProvider: () => ({ complete: builtin }) };
});
vi.mock("../audit/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../audit/logger.js")>();
  return {
    ...actual,
    logAudit: (...args: Parameters<typeof actual.logAudit>) => { audit(...args); return actual.logAudit(...args); },
  };
});
vi.mock("../tools/agent-routing.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools/agent-routing.js")>();
  return {
    ...actual,
    resolveAgentRouting: async (query: string, opts?: { minConfidence?: "high" | "medium" | "low"; excludeAgents?: string[] }) => ({
      query, minConfidence: opts?.minConfidence ?? "medium", mode: "hybrid" as const,
      results: ranking.current.filter((entry) => !(opts?.excludeAgents ?? []).includes(entry.name)).map((entry) => ({
        name: entry.name, description: `${entry.name} test agent`, model: "mock", confidence: "high" as const,
        score: entry.score, matchedTerms: [], capabilities: [], tags: [],
      })),
      weakCandidates: [], gated: false, trippedAgents: [], allLowConfidence: false,
      nearMisses: ranking.current.length > 0 ? [] : ranking.near.filter((entry) => !(opts?.excludeAgents ?? []).includes(entry.name)),
    }),
  };
});

const ranAgents = () => runner.mock.calls.map((call) => (call[0] as SubAgentRunOptions).agentName);
const rows = (type: string) => audit.mock.calls.filter((call) => call[0] === type).map((call) => call[1] as Record<string, unknown>);

const TASK = "Öffne die Datei generated/aktionen/herbst.html, ersetze die Hauptüberschrift durch „Herbstaktion 2026“ und speichere die Datei.";

describe("a routed pick under the threshold", () => {
  let tempDir = "";
  const writeConfig = async (ephemeralEnabled: boolean, architect = true, architectAgentName: string | undefined = "agent_architect") => {
    writeFileSync(join(tempDir, "starlingai.json"), JSON.stringify({
      workspacePath: tempDir,
      agents: {
        defaults: { model: { primary: "mock-model" } },
        ephemeralGeneration: { enabled: ephemeralEnabled, skillMatchThreshold: 0.75, ...(architectAgentName ? { architectAgentName } : {}) },
      },
      subAgents: {
        content_writer: { description: "Writes documents.", systemPrompt: "Test.", tools: ["read_file", "write_file", "edit_file"], maxIterations: 4 },
        web_coder: { description: "Builds web pages.", systemPrompt: "Test.", tools: ["read_file", "write_file", "edit_file"], maxIterations: 4 },
        ...(architect ? { agent_architect: { description: "Designs ephemeral agents.", systemPrompt: "Return the agent spec as JSON.", tools: [], maxIterations: 1 } } : {}),
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = join(tempDir, "starlingai.json");
    // The loader fixes its config source when first imported.
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
  };
  const delegate = async (sessionId: string, scope: Partial<ToolContext> = {}) => {
    const { getTool } = await import("../tools/registry.js");
    await import("../tools/sub-agent.js");
    return getTool("delegate_to_agent")!.execute({ task: TASK, deliverable: "file" }, { sessionId, workspacePath: tempDir, ...scope } as ToolContext);
  };

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "sai-under-threshold-"));
    ranking.current = [{ name: "content_writer", score: 0.745 }, { name: "web_coder", score: 0.724 }];
    ranking.near = [];
    runner.mockImplementation(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => ({
      output: "Die Hauptüberschrift wurde ersetzt.",
      artifacts: [{ outputPath: "generated/aktionen/herbst.html", sourceTool: "edit_file" }],
      stats: {
        agentName: args.agentName, sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`, promptChars: 0, userContentChars: 0,
        toolCount: 1, toolNames: ["edit_file"], iterations: 1, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        maxIterations: 4, model: "mock", capabilities: [], terminalState: "completed", outcome: "success",
      },
    }));
    (await import("../config/loader.js")).resetConfigForTests();
  });

  afterEach(async () => {
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env["SAI_CONFIG_PATH"];
    runner.mockReset();
    architect.mockReset();
    builtin.mockReset();
    audit.mockReset();
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
    await (await import("../swarm/memory.js")).resetSharedMemoryForTests();
  });

  it("runs when the architect answers with no spec", async () => {
    await writeConfig(true);
    architect.mockResolvedValue("I would design a file editor agent for this.");
    const result = await delegate("under-threshold-no-spec");

    expect(architect).toHaveBeenCalledTimes(1);
    expect(ranAgents()).toEqual(["content_writer"]);
    expect(result.success).toBe(true);
    expect(rows("delegation_routing_under_threshold_run")).toEqual([
      expect.objectContaining({ agent: "content_writer", score: 0.745, skillMatchThreshold: 0.75 }),
    ]);
  }, 30_000);

  it("runs when ephemeral generation is off", async () => {
    await writeConfig(false);
    const result = await delegate("under-threshold-generation-off");

    expect(architect).not.toHaveBeenCalled();
    expect(ranAgents()).toEqual(["content_writer"]);
    expect(result.success).toBe(true);
  }, 30_000);

  // The deployment's architect agent was removed from the roster on 2026-06-19 while
  // ephemeralGeneration stayed on, and every fallback since made no agent. The catalog is where a
  // deployment starts: with no architect in it, the built-in one designs the agent.
  const HEADING_EDITOR = { agentName: "heading_editor", description: "Edits one heading.", systemPrompt: "Edit the heading.", tools: ["read_file", "edit_file"], maxIterations: 3 };

  it("has the built-in architect design the agent when the deployment configures none", async () => {
    await writeConfig(true, false, undefined);
    builtin.mockResolvedValue({ content: JSON.stringify(HEADING_EDITOR) });
    await delegate("under-threshold-builtin-architect");

    expect(architect).not.toHaveBeenCalled();
    expect(builtin).toHaveBeenCalledTimes(1);
    const [messages, , , options] = builtin.mock.calls[0] as [Array<{ content: string }>, unknown, unknown, { responseFormat?: { name: string } }];
    expect(messages[0]!.content).toContain("Herbstaktion 2026");
    expect(options.responseFormat?.name).toBe("ephemeral_agent_spec");
    expect(ranAgents()).not.toContain("content_writer");
    expect(ranAgents().some((name) => name.includes("heading_editor"))).toBe(true);
    expect(rows("delegation_routing_under_threshold_run")).toEqual([]);
  }, 30_000);

  it("uses the built-in architect, and says so, when the configured one is not in the catalog", async () => {
    await writeConfig(true, false);
    builtin.mockResolvedValue({ content: JSON.stringify(HEADING_EDITOR) });
    await delegate("under-threshold-architect-missing");

    expect(architect).not.toHaveBeenCalled();
    expect(builtin).toHaveBeenCalledTimes(1);
    expect(rows("guardrail_flagged")).toContainEqual(expect.objectContaining({ type: "architect_agent_missing", architectAgentName: "agent_architect", using: "built-in" }));
  }, 30_000);

  it("runs the routed pick when the built-in architect makes no spec", async () => {
    await writeConfig(true, false, undefined);
    builtin.mockResolvedValue({ content: "I would design a file editor agent for this." });
    const result = await delegate("under-threshold-builtin-no-spec");

    expect(builtin).toHaveBeenCalledTimes(1);
    expect(ranAgents()).toEqual(["content_writer"]);
    expect(result.success).toBe(true);
    expect(rows("architect_fallback_failed")).toEqual([expect.objectContaining({ reason: "builtin_architect_error" })]);
  }, 30_000);

  // E2E 2026-10-22: inside the verified_research_brief scene the router ranked none of the scene's
  // agents; its near misses were source_verifier (0.714) and evidence_analyst (0.700).
  it("runs a scene's nearest agent when the router ranked none of them", async () => {
    await writeConfig(true, false);
    ranking.current = [];
    ranking.near = [{ name: "web_coder", score: 0.714 }, { name: "content_writer", score: 0.7 }];
    const result = await delegate("under-threshold-scene-near-miss", { allowedAgents: ["content_writer", "web_coder"] });

    expect(ranAgents()).toEqual(["web_coder"]);
    expect(result.success).toBe(true);
    expect(rows("delegation_routing_under_threshold_run")).toEqual([expect.objectContaining({ agent: "web_coder", score: 0.714 })]);
  }, 30_000);

  it("inside a scene runs the scene's agent before asking the architect", async () => {
    // 2026-10-26: with the built-in architect working, a scene's near-miss researcher was replaced by
    // an ephemeral agent the scene's author never chose.
    await writeConfig(true, false, undefined);
    builtin.mockResolvedValue({ content: JSON.stringify(HEADING_EDITOR) });
    ranking.current = [];
    ranking.near = [{ name: "web_coder", score: 0.714 }];
    const result = await delegate("under-threshold-scene-first", { allowedAgents: ["content_writer", "web_coder"] });

    expect(ranAgents()).toEqual(["web_coder"]);
    expect(builtin).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  }, 30_000);

  it("leaves a near miss outside a scene as it was: no agent", async () => {
    await writeConfig(true, false);
    ranking.current = [];
    ranking.near = [{ name: "web_coder", score: 0.714 }];
    const result = await delegate("under-threshold-open-near-miss");

    expect(ranAgents()).toEqual([]);
    expect(result.success).toBe(false);
  }, 30_000);

  it("leaves the task to the ephemeral agent the architect makes", async () => {
    await writeConfig(true);
    architect.mockResolvedValue(JSON.stringify({
      agentName: "heading_editor", description: "Edits one heading.", systemPrompt: "Edit the heading.", tools: ["read_file", "edit_file"], maxIterations: 3,
    }));
    await delegate("under-threshold-ephemeral");

    expect(architect).toHaveBeenCalledTimes(1);
    expect(ranAgents()).not.toContain("content_writer");
    expect(rows("delegation_routing_under_threshold_run")).toEqual([]);
  }, 30_000);
});
