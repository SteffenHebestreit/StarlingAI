import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../tools/registry.js";
import type { SubAgentRunOptions, SubAgentRunResult } from "../agent/sub-agent.js";

/**
 * AN AGENT THAT READS ONLY UPLOADS IS NOT ROUTED A STEP WITH NO FILE TO READ.
 *
 * E2E 2026-10-12, core-ix-workflow-scene-research-brief (f08cee40): verified_research_brief's step
 * turn had nothing attached. It delegated "Fetch and read the website http://www.nordlicht-werkzeuge.test/
 * …" naming no agent, routed as "web browsing and website content extraction", and the ranking put
 * document_intake (0.8471) ahead of researcher (0.8553) after the rerank. document_intake listed an
 * empty folder for 29 s before the step went to researcher. A workflow step's turn carries no turn
 * trigger, so none of the gates that read the step's web address held the router.
 *
 * The gate reads the routing taxonomy's input facet, not the agent's name: a routed candidate whose
 * only input is an upload is dropped when the conversation has no attachment and the task names no
 * workspace file, as long as another candidate is left.
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

/** Labels under `routingGenerated`, the key workspace/agents/59-routing.generated.jsonc gives the deployed agents. */
const label = (mode: string, surface: string, input: string) =>
  ({ mode, domain: ["research"], riskTier: "read_only", executionShape: "single_agent", surface: [surface], inputModality: [input] });

const AGENTS = {
  researcher: { tools: ["web_search", "web_fetch", "url_inspect", "write_file", "share_finding"], routingGenerated: label("GATHER", "external_network", "url") },
  document_intake: { tools: ["extract_file_content", "read_file", "list_files", "spreadsheet_read", "write_file", "share_finding"], routingGenerated: label("GATHER", "workspace", "file_upload") },
  evidence_analyst: { tools: ["read_file", "read_shared_facts", "share_finding", "write_file"], routingGenerated: label("GATHER", "workspace", "text") },
  summarizer: { tools: ["read_file", "read_shared_facts", "write_file"], routingGenerated: label("PRODUCE", "workspace", "text") },
} as const;
const SCENE_AGENTS = ["document_intake", "researcher", "evidence_analyst", "summarizer"];

/** The live step's delegation, verbatim but for its deliverable: a mocked run writes no file, so "file" would fail every run. */
const LIVE_CALL = {
  task: "Fetch and read the website http://www.nordlicht-werkzeuge.test/ and identify all relevant pages containing information about: 1) Gründungsjahr (founding year), 2) Zahl der Mitarbeitenden (number of employees), 3) Lagerstandorte (warehouse locations), 4) Umfang des Sortiments (product range scope). For each piece of information, record the exact URL where it was found. Also navigate to any linked pages that seem relevant (e.g., Über uns, Kontakt, Sortiment, etc.) and extract all factual data from those pages as well.",
  deliverable: "answer",
  routingQuery: "web browsing and website content extraction",
};
/** The live ranking: the upload reader first after the rerank, researcher a hair above it on score. */
const LIVE_RANKING = [
  { name: "document_intake", score: 0.8471 },
  { name: "researcher", score: 0.8553 },
  { name: "summarizer", score: 0.8039 },
  { name: "evidence_analyst", score: 0.837 },
];

describe("routing a step past an agent that reads only uploads", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "sai-upload-reader-gate-"));
    const subAgents = Object.fromEntries(Object.entries(AGENTS).map(([name, cfg]) => [name, {
      description: `${name} test agent`, systemPrompt: "Test.", maxIterations: 4, ...cfg,
    }]));
    writeFileSync(join(tempDir, "starlingai.json"), JSON.stringify({ workspacePath: tempDir, subAgents }), "utf8");
    process.env["SAI_CONFIG_PATH"] = join(tempDir, "starlingai.json");
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
    runner.mockReset();
    runner.mockImplementation(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => ({
      output: `${args.agentName}: Gegründet 1987, 146 Mitarbeitende (http://www.nordlicht-werkzeuge.test/ueber-uns).`,
      stats: statsFor(args),
    }));
    audit.mockClear();
  });

  afterEach(async () => {
    vi.doUnmock("../tools/agent-routing.js");
    delete process.env["SAI_CONFIG_PATH"];
    (await import("../agent/session.js")).resetSessionsForTests();
    (await import("../config/loader.js")).resetConfigForTests();
    await (await import("../swarm/memory.js")).resetSharedMemoryForTests();
    rmSync(tempDir, { recursive: true, force: true });
    vi.resetModules();
  });

  const ran = (): string[] => runner.mock.calls.map((call) => (call[0] as SubAgentRunOptions).agentName);
  const rows = (type: string): Array<Record<string, unknown>> =>
    audit.mock.calls.filter((call) => call[0] === type).map((call) => call[1] as Record<string, unknown>);
  /** Stands in for the embedding router: every pass returns `ranked`, minus the agents it excludes. */
  const routeAs = (ranked: ReadonlyArray<{ name: string; score: number }>) => vi.doMock("../tools/agent-routing.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../tools/agent-routing.js")>();
    return {
      ...actual,
      resolveAgentRouting: async (query: string, opts?: { minConfidence?: "high" | "medium" | "low"; excludeAgents?: string[] }) => ({
        query, minConfidence: opts?.minConfidence ?? "medium", mode: "hybrid" as const,
        results: ranked.filter((entry) => !(opts?.excludeAgents ?? []).includes(entry.name)).map((entry) => ({
          name: entry.name, description: `${entry.name} test agent`, model: "mock", confidence: "high" as const,
          score: entry.score, matchedTerms: [], capabilities: [], tags: [],
        })),
        weakCandidates: [], gated: false, trippedAgents: [], allLowConfidence: false, nearMisses: [],
      }),
    };
  });
  /** The chat a scene was started from, with the user's message and what was attached to it. */
  const chat = async (chatId: string, attachments?: Array<Record<string, unknown>>) => {
    const { createSession } = await import("../agent/session.js");
    const session = createSession({ sessionId: chatId, channel: "test", workspacePath: tempDir });
    session.addMessage({
      role: "user",
      content: "Nutze den Workflow verified_research_brief für die Nordlicht Werkzeuge GmbH.",
      ...(attachments ? { metadata: { attachments } } : {}),
    });
  };
  /** A workflow step's context: its session hangs off the chat's, and no turn trigger is set on it. */
  const stepCtx = (chatId: string): ToolContext => ({
    sessionId: `workflow:${chatId}:verified_research_brief:d65f1ecb-bad9-48c1-9437-d20459abcec5`,
    workspacePath: tempDir,
    allowedAgents: SCENE_AGENTS,
    swarmState: { objective: "t", startedAt: "", updatedAt: "", tasks: {} },
  });
  const delegate = async (args: Record<string, unknown>, ctx: ToolContext) => {
    const { getTool } = await import("../tools/registry.js");
    await import("../tools/sub-agent.js");
    return getTool("delegate_to_agent")!.execute(args, ctx);
  };

  it("routes the live step to researcher when nothing is attached and the task names no workspace file", async () => {
    routeAs(LIVE_RANKING);
    await chat("chat-nothing-attached");
    const result = await delegate(LIVE_CALL, stepCtx("chat-nothing-attached"));

    expect(result.success).toBe(true);
    expect(ran()).toEqual(["researcher"]);
    expect(rows("delegation_routing_filtered_no_user_file")).toEqual([
      expect.objectContaining({ droppedAgents: ["document_intake"] }),
    ]);
  }, 30_000);

  it("keeps the upload reader when the conversation has an attachment", async () => {
    routeAs(LIVE_RANKING);
    await chat("chat-with-upload", [{ filename: "katalog.pdf", relativePath: "uploads/chat-with-upload/katalog.pdf", contentType: "application/pdf" }]);
    await delegate({ task: "Den angehängten Katalog lesen und die Zahl der Artikel nennen.", deliverable: "answer" }, stepCtx("chat-with-upload"));

    expect(ran()).toEqual(["document_intake"]);
    expect(rows("delegation_routing_filtered_no_user_file")).toEqual([]);
  }, 30_000);

  it("keeps the upload reader when the task names a file that is in the workspace", async () => {
    routeAs(LIVE_RANKING);
    mkdirSync(join(tempDir, "uploads"), { recursive: true });
    writeFileSync(join(tempDir, "uploads", "rechnung.pdf"), "%PDF-1.4\n", "utf8");
    await chat("chat-named-file");
    await delegate({ task: "Den Text aus uploads/rechnung.pdf extrahieren und den Rechnungsbetrag nennen.", deliverable: "answer" }, stepCtx("chat-named-file"));

    expect(ran()).toEqual(["document_intake"]);
    expect(rows("delegation_routing_filtered_no_user_file")).toEqual([]);
  }, 30_000);

  it("keeps the router's order when the conversation is not one this process knows, or no other candidate is left", async () => {
    routeAs(LIVE_RANKING);
    // No session record anywhere up the chain: unknown is not "nothing attached".
    await delegate(LIVE_CALL, stepCtx("chat-not-loaded"));
    vi.doUnmock("../tools/agent-routing.js");
    vi.resetModules();
    routeAs([{ name: "document_intake", score: 0.8471 }]);
    await chat("chat-only-reader");
    await delegate(LIVE_CALL, stepCtx("chat-only-reader"));

    expect(ran()).toEqual(["document_intake", "document_intake"]);
    expect(rows("delegation_routing_filtered_no_user_file")).toEqual([]);
  }, 30_000);
});

describe("agentCfgReadsOnlyUploads", () => {
  it("is true only for a workspace-confined agent whose every input is an upload", async () => {
    const { agentCfgReadsOnlyUploads } = await import("../tools/agent-routing.js");
    expect(agentCfgReadsOnlyUploads(AGENTS.document_intake as never)).toBe(true);
    expect(agentCfgReadsOnlyUploads(AGENTS.researcher as never)).toBe(false);
    expect(agentCfgReadsOnlyUploads(AGENTS.evidence_analyst as never)).toBe(false);
    // An upload reader that can also reach outside the workspace has a source of its own.
    expect(agentCfgReadsOnlyUploads({ tools: ["web_fetch"], routingGenerated: label("GATHER", "external_network", "file_upload") } as never)).toBe(false);
    // Unclassified: never dropped on a guess.
    expect(agentCfgReadsOnlyUploads({ tools: ["read_file"] })).toBe(false);
    expect(agentCfgReadsOnlyUploads(undefined)).toBe(false);
  });
});
