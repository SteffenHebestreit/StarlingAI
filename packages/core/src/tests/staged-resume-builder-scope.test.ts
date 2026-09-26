import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ARTIFACT_BUILDER_TOOLS,
  STAGED_BUILD_REQUIRED_TOOLS,
  UNFINISHED_STUB_MARKER,
  holdsArtifactBuilderTool,
  ownsResumeEvidence,
} from "../agent/sub-agent-prompt-guidance.js";

/**
 * A RESUME IS THE BUILDER'S JOB (C3' item 5 of the Jev/Laya adoption plan).
 *
 * c297c5ea, row 1581bae5, 02:11:10: the researcher — it holds write_file and edit_file for its
 * notes, and its research task was 839 characters, so the staged-build classifier fired — was
 * handed "FIX THE EXISTING BUILD — DO NOT START OVER" about content_writer's two broken reveal.js
 * pages, and spent two edit_file calls on a presentation it had no part in. Resume detection read
 * the conversation's artifact zone and nothing else. The same researcher, given the FRESH
 * directive at 01:22:56, had written that deck's first skeleton at 01:23 — the build was started
 * by the run that should only have researched it.
 *
 * The evidence is now scoped per file to the runs that build it (ownsResumeEvidence): a run that
 * holds a dedicated builder tool, or the agent that wrote the file last, or anybody when no writer
 * is recorded. A run for which another agent's unfinished build was set aside gets NO staged
 * directive at all. The staged-artifact-build.test.ts harness drives the real runner; the
 * provider records the system prompt it was sent.
 */

const completeMock = vi.fn();
const logAuditMock = vi.fn();

vi.mock("../providers/lmstudio.js", async (importActual) => ({
  ...(await importActual<typeof import("../providers/lmstudio.js")>()),
  LMStudioProvider: class {
    async complete(messages: unknown, tools: unknown, signal?: AbortSignal) {
      return completeMock(messages, tools, signal);
    }
  },
}));
vi.mock("../audit/logger.js", async (importActual) => ({
  ...(await importActual<typeof import("../audit/logger.js")>()),
  logAudit: (...args: unknown[]) => logAuditMock(...args),
}));

/** A research task past the staged-build threshold, like the 839-character one of 1581bae5. */
const RESEARCH_TASK = [
  "Research the opening hours, ticket prices and accessibility of a baroque palace complex for a visitor briefing.",
  "Collect the official opening hours for every season, including public-holiday exceptions and late openings.",
  "Collect the current adult, reduced and family ticket prices, and whether combined tickets exist.",
  "Record step-free routes, lifts, accessible toilets and the availability of wheelchairs on loan.",
  "Note guided-tour times and languages, and whether tours must be booked ahead.",
  "Cite the official source for each fact with its URL, and flag anything older than a year.",
  "Return a compact list of findings with sources; do not write the briefing itself.",
].join("\n");

/** researcher's shipped toolset, trimmed to what the classifiers read: no builder tool. */
const RESEARCHER_TOOLS = ["web_search", "web_fetch", "read_file", "write_file", "edit_file", "share_finding"];
/** content_writer's shape: the same file tools plus a dedicated page emitter. */
const DECK_BUILDER_TOOLS = ["read_file", "write_file", "edit_file", "grep_files", "generate_presentation"];

const BROKEN_PAGE = "<html><body><script>const started=1; const started=2;</script></body></html>";

let firstSystem = "";

async function run(params: {
  agent: string;
  tools: string[];
  workspace: string;
  parentSessionId: string;
  /** Recorded as the file's last writer before the run, as an earlier run in the conversation would. */
  writers?: Array<{ file: string; agent: string }>;
}): Promise<void> {
  const configPath = join(params.workspace, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({
    orchestration: { stagedArtifactBuilds: true, stagedArtifactBuildDirective: true },
    subAgents: {
      [params.agent]: {
        description: `${params.agent} test agent`,
        systemPrompt: "You do your job.",
        tools: params.tools,
        maxIterations: 6,
        turnTimeoutMs: 60_000,
      },
    },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configPath;
  vi.resetModules();
  (await import("../config/loader.js")).resetConfigForTests();
  completeMock.mockImplementation((messages: Array<{ role: string; content: string }>) => {
    firstSystem = messages.find((m) => m.role === "system")?.content ?? "";
    return { content: "Done.", tool_calls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "stop" };
  });
  const subAgent = await import("../agent/sub-agent.js");
  for (const w of params.writers ?? []) subAgent.noteArtifactWriter(params.parentSessionId, join(params.workspace, w.file), w.agent);
  await subAgent.runSubAgentWithStats({
    agentName: params.agent,
    task: RESEARCH_TASK,
    parentSessionId: params.parentSessionId,
    workspacePath: params.workspace,
  });
}

function stagedRow(): Record<string, unknown> | undefined {
  return logAuditMock.mock.calls.find((args) => args[0] === "sub_agent_staged_build_detected")?.[1] as Record<string, unknown> | undefined;
}

describe("resume evidence belongs to the runs that build the artifact", () => {
  let workspace: string | undefined;
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    completeMock.mockReset();
    logAuditMock.mockReset();
    if (workspace) { rmSync(workspace, { recursive: true, force: true }); workspace = undefined; }
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
    const swarmMemory = await import("../swarm/memory.js");
    await swarmMemory.resetSharedMemoryForTests();
  });

  const seedBrokenDeck = (): string => {
    workspace = mkdtempSync(join(tmpdir(), "sai-resume-scope-"));
    mkdirSync(join(workspace, "generated", "presentation"), { recursive: true });
    writeFileSync(join(workspace, "generated", "presentation", "index.html"), BROKEN_PAGE, "utf8");
    return workspace;
  };

  it("REGRESSION 1581bae5 — a researcher is not handed content_writer's broken deck, nor told to build one", async () => {
    expect(RESEARCH_TASK.trim().length).toBeGreaterThan(600);
    const ws = seedBrokenDeck();
    await run({
      agent: "researcher", tools: RESEARCHER_TOOLS, workspace: ws, parentSessionId: "parent-audited",
      writers: [{ file: "generated/presentation/index.html", agent: "content_writer" }],
    });
    expect(firstSystem, "the run never reached the model").toContain("You do your job.");
    expect(firstSystem).not.toContain("FIX THE EXISTING BUILD");
    expect(firstSystem).not.toContain("RESUME AN EXISTING BUILD");
    // Nor the fresh skeleton directive: that is how the same researcher wrote the deck at 01:23.
    expect(firstSystem).not.toContain("STAGED BUILD");
    expect(stagedRow()).toMatchObject({ agentName: "researcher", mode: "withheld", directiveInjected: false });
  }, 60_000);

  it("REGRESSION 1581bae5 as it was recorded: the deck came from generate_presentation, which reports its DIRECTORY", async () => {
    // The page the researcher was sent to fix in c297c5ea was never edit_file'd by content_writer:
    // generate_presentation wrote it, and its metadata names the output directory, not index.html.
    // A writer record keyed only by the exact file left that page with no writer — everybody's —
    // so the researcher would still have been handed "FIX THE EXISTING BUILD" for it.
    const ws = seedBrokenDeck();
    await run({
      agent: "researcher", tools: RESEARCHER_TOOLS, workspace: ws, parentSessionId: "parent-audited-dir",
      writers: [{ file: "generated/presentation", agent: "content_writer" }],
    });
    expect(firstSystem, "the run never reached the model").toContain("You do your job.");
    expect(firstSystem).not.toContain("FIX THE EXISTING BUILD");
    expect(stagedRow()).toMatchObject({ agentName: "researcher", mode: "withheld", directiveInjected: false });
  }, 60_000);

  /**
   * End to end, one module instance for both runs (the writer record lives in sub-agent.ts):
   * content_writer builds the deck with the real generate_presentation under `builderParent`, the
   * page is broken afterwards (in c297c5ea: "Reveal is not defined"), and the researcher
   * dispatched next under `researcherParent` with a long task must be left out of the repair.
   */
  async function deckThenResearcher(builderParent: string, researcherParent: string, conversation: string): Promise<void> {
    workspace = mkdtempSync(join(tmpdir(), "sai-resume-scope-"));
    const configPath = join(workspace, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      orchestration: { stagedArtifactBuilds: true, stagedArtifactBuildDirective: true },
      subAgents: {
        content_writer: { description: "w", systemPrompt: "You do your job.", tools: DECK_BUILDER_TOOLS, maxIterations: 4, turnTimeoutMs: 60_000 },
        researcher: { description: "r", systemPrompt: "You do your job.", tools: RESEARCHER_TOOLS, maxIterations: 4, turnTimeoutMs: 60_000 },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
    await import("../tools/register-builtins.js");
    let deckCalls = 0;
    completeMock.mockImplementation((messages: Array<{ role: string; content: string }>, tools: Array<{ name: string }>) => {
      firstSystem = messages.find((m) => m.role === "system")?.content ?? "";
      if (tools.some((t) => t.name === "generate_presentation") && deckCalls === 0) {
        deckCalls += 1;
        return {
          content: "",
          tool_calls: [{ id: "d1", name: "generate_presentation", arguments: { outputDir: "presentation", title: "Deck", slides: [{ title: "One", content: "Body." }] } }],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          finishReason: "tool_calls",
        };
      }
      return { content: "Done.", tool_calls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "stop" };
    });
    const subAgent = await import("../agent/sub-agent.js");
    await subAgent.runSubAgentWithStats({ agentName: "content_writer", task: "Build the deck.", parentSessionId: builderParent, workspacePath: workspace });
    const index = join(workspace, "generated", "presentation", "index.html");
    expect(deckCalls, "the builder never called generate_presentation").toBe(1);
    expect(subAgent.artifactLastWriter(conversation, index)).toBe("content_writer");

    writeFileSync(index, BROKEN_PAGE, "utf8");
    logAuditMock.mockReset();
    await subAgent.runSubAgentWithStats({ agentName: "researcher", task: RESEARCH_TASK, parentSessionId: researcherParent, workspacePath: workspace });
    expect(firstSystem).not.toContain("FIX THE EXISTING BUILD");
    expect(stagedRow()).toMatchObject({ agentName: "researcher", mode: "withheld" });
  }

  it("records a directory emitter's output for the files under it: generate_presentation, then the researcher", async () => {
    await deckThenResearcher("parent-e2e-deck", "parent-e2e-deck", "parent-e2e-deck");
  }, 60_000);

  it("one conversation across a workflow and a coordinator: c297c5ea's deck was built inside a scene", async () => {
    // content_writer's generate_presentation ran under the sourced_presentation workflow
    // (workflow:<conversation>:<scene>:<uuid>, tools/workflow-catalog.ts), the researcher of
    // 1581bae5 under mission_coordinator (sub:<conversation>:mission_coordinator:<ts>). Keyed by the
    // nearest `sub:` root, the two runs' records lived in two maps and the researcher saw no writer.
    await deckThenResearcher(
      "workflow:conv-audited:sourced_presentation:3f0c2a51-0000-4000-8000-000000000001",
      "sub:conv-audited:mission_coordinator:1790386000001",
      "conv-audited",
    );
  }, 60_000);

  it("the builder of that deck still gets the repair (control: same disk, same writer record)", async () => {
    const ws = seedBrokenDeck();
    await run({
      agent: "content_writer", tools: DECK_BUILDER_TOOLS, workspace: ws, parentSessionId: "parent-builder",
      writers: [{ file: "generated/presentation/index.html", agent: "content_writer" }],
    });
    expect(firstSystem).toContain("FIX THE EXISTING BUILD");
    expect(firstSystem).toContain("already been declared");
    expect(stagedRow()).toMatchObject({ mode: "resume", directiveInjected: true });
  }, 60_000);

  it("a builder may finish another agent's skeleton — content_writer resuming the researcher's markers at 01:29", async () => {
    workspace = mkdtempSync(join(tmpdir(), "sai-resume-scope-"));
    mkdirSync(join(workspace, "generated"), { recursive: true });
    writeFileSync(join(workspace, "generated", "deck.html"), `<script>throw new Error("${UNFINISHED_STUB_MARKER}: slides");</script>`, "utf8");
    await run({
      agent: "content_writer", tools: DECK_BUILDER_TOOLS, workspace, parentSessionId: "parent-handoff",
      writers: [{ file: "generated/deck.html", agent: "researcher" }],
    });
    expect(firstSystem).toContain("RESUME AN EXISTING BUILD");
    expect(firstSystem).toContain("generated/deck.html");
  }, 60_000);

  it("a write/edit-only agent keeps the resume of the build it wrote last itself", async () => {
    workspace = mkdtempSync(join(tmpdir(), "sai-resume-scope-"));
    mkdirSync(join(workspace, "generated"), { recursive: true });
    writeFileSync(join(workspace, "generated", "notes.html"), `<script>throw new Error("${UNFINISHED_STUB_MARKER}: part2");</script>`, "utf8");
    await run({
      agent: "researcher", tools: RESEARCHER_TOOLS, workspace, parentSessionId: "parent-own",
      writers: [{ file: "generated/notes.html", agent: "researcher" }],
    });
    expect(firstSystem).toContain("RESUME AN EXISTING BUILD");
  }, 60_000);

  it("an artifact with no recorded writer stays everybody's (a restart, a container run): the old behaviour", async () => {
    workspace = mkdtempSync(join(tmpdir(), "sai-resume-scope-"));
    mkdirSync(join(workspace, "generated"), { recursive: true });
    writeFileSync(join(workspace, "generated", "game.html"), `<script>throw new Error("${UNFINISHED_STUB_MARKER}: core");</script>`, "utf8");
    await run({ agent: "researcher", tools: RESEARCHER_TOOLS, workspace, parentSessionId: "parent-unknown" });
    expect(firstSystem).toContain("RESUME AN EXISTING BUILD");
  }, 60_000);

  it("records the run's own writes: after a write_file the agent is that file's last writer", async () => {
    workspace = mkdtempSync(join(tmpdir(), "sai-resume-scope-"));
    await import("../tools/register-builtins.js");
    let call = 0;
    const configPath = join(workspace, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      subAgents: { researcher: { description: "r", systemPrompt: "You do your job.", tools: RESEARCHER_TOOLS, maxIterations: 4, turnTimeoutMs: 60_000 } },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
    await import("../tools/register-builtins.js");
    completeMock.mockImplementation(() => {
      call += 1;
      return call === 1
        ? { content: "", tool_calls: [{ id: "c1", name: "write_file", arguments: { path: "Findings.md", content: "sources" } }], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "tool_calls" }
        : { content: "Done.", tool_calls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "stop" };
    });
    const subAgent = await import("../agent/sub-agent.js");
    await subAgent.runSubAgentWithStats({ agentName: "researcher", task: "Write your findings to Findings.md.", parentSessionId: "parent-writes", workspacePath: workspace });
    // write_file roots the file under generated/; the record is keyed by that resolved path,
    // which is the path the resume scanners walk (and, on Windows, case-insensitively).
    expect(subAgent.artifactLastWriter("parent-writes", join(workspace, "generated", "Findings.md"))).toBe("researcher");
    if (process.platform === "win32") {
      expect(subAgent.artifactLastWriter("parent-writes", join(workspace, "generated", "findings.md"))).toBe("researcher");
    }
    expect(subAgent.artifactLastWriter("another-conversation", join(workspace, "generated", "Findings.md"))).toBeUndefined();
  }, 60_000);
});

describe("M0: sub_agent_head names the head a run sends", () => {
  let workspace: string | undefined;
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    completeMock.mockReset();
    logAuditMock.mockReset();
    if (workspace) { rmSync(workspace, { recursive: true, force: true }); workspace = undefined; }
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
  });

  it("hashes the system message and the tool block exactly as the provider received them", async () => {
    workspace = mkdtempSync(join(tmpdir(), "sai-head-row-"));
    let sentSystem = "";
    let sentTools: Array<{ name: string; description?: string; parameters?: unknown }> = [];
    await run({ agent: "researcher", tools: RESEARCHER_TOOLS, workspace, parentSessionId: "parent-head-row" });
    // run() wired completeMock to record the system prompt only; re-run with a recorder for tools too.
    completeMock.mockImplementation((messages: Array<{ role: string; content: string }>, tools: typeof sentTools) => {
      sentSystem = messages.find((m) => m.role === "system")?.content ?? "";
      sentTools = tools;
      return { content: "Done.", tool_calls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "stop" };
    });
    logAuditMock.mockReset();
    const subAgent = await import("../agent/sub-agent.js");
    await subAgent.runSubAgentWithStats({ agentName: "researcher", task: "Find one source.", parentSessionId: "parent-head-row-2", workspacePath: workspace });
    const row = logAuditMock.mock.calls.find((args) => args[0] === "sub_agent_head")?.[1] as Record<string, unknown> | undefined;
    expect(row, "no sub_agent_head row").toBeDefined();
    const { promptHeadSignature } = await import("../providers/prompt-head.js");
    const expected = promptHeadSignature(sentSystem.trim(), sentTools);
    expect(row).toMatchObject({ agentName: "researcher", headHash: expected.headHash, toolsHash: expected.toolsHash, systemHash: expected.systemHash, toolCount: sentTools.length, stagedDirective: "none" });
    expect(row!["headTokensEst"]).toBeGreaterThan(0);
  }, 60_000);
});

describe("artifactLastWriter — the most recent write that covered the file", () => {
  it("a directory record covers the files under it, and the later of a file and a directory record wins", async () => {
    const { noteArtifactWriter, artifactLastWriter } = await import("../agent/sub-agent.js");
    const ws = join(tmpdir(), "sai-writer-order");
    const dirPath = join(ws, "generated", "presentation");
    const index = join(dirPath, "index.html");
    // The directory emitter first, then an edit of one page: the edit is the last write of that page.
    noteArtifactWriter("conv-order-1", dirPath, "content_writer");
    noteArtifactWriter("conv-order-1", index, "researcher");
    expect(artifactLastWriter("conv-order-1", index)).toBe("researcher");
    expect(artifactLastWriter("conv-order-1", join(dirPath, "notes.md"))).toBe("content_writer");
    // The other way round: the page was written, then the emitter regenerated the whole directory.
    noteArtifactWriter("conv-order-2", index, "researcher");
    noteArtifactWriter("conv-order-2", dirPath, "content_writer");
    expect(artifactLastWriter("conv-order-2", index)).toBe("content_writer");
    // A sibling whose name merely starts with the directory's is not under it.
    noteArtifactWriter("conv-order-3", join(ws, "generated", "pres"), "content_writer");
    expect(artifactLastWriter("conv-order-3", index)).toBeUndefined();
  });
});

describe("ownsResumeEvidence — the rule itself", () => {
  it("lets a dedicated builder finish any artifact, and a file tools-only agent only its own or an unrecorded one", () => {
    expect(ownsResumeEvidence({ agentName: "content_writer", toolNames: DECK_BUILDER_TOOLS, lastWriter: "researcher" })).toBe(true);
    expect(ownsResumeEvidence({ agentName: "researcher", toolNames: RESEARCHER_TOOLS, lastWriter: "content_writer" })).toBe(false);
    expect(ownsResumeEvidence({ agentName: "researcher", toolNames: RESEARCHER_TOOLS, lastWriter: "researcher" })).toBe(true);
    expect(ownsResumeEvidence({ agentName: "researcher", toolNames: RESEARCHER_TOOLS, lastWriter: undefined })).toBe(true);
  });

  it("does not count the generic file tools as building: they are how every specialist saves notes", () => {
    for (const tool of STAGED_BUILD_REQUIRED_TOOLS) expect(ARTIFACT_BUILDER_TOOLS.has(tool)).toBe(false);
    expect(holdsArtifactBuilderTool(["write_file", "edit_file", "read_file"])).toBe(false);
    expect(holdsArtifactBuilderTool(["write_file", "edit_file", "verify_page"])).toBe(true);
    expect(holdsArtifactBuilderTool(undefined)).toBe(false);
  });
});
