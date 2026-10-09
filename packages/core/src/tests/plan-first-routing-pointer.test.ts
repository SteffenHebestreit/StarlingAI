/**
 * A strong routing match does not tell the model to delegate now on a turn whose tail asks for a
 * plan first (ToolContext.planFirstPending).
 *
 * Session 9991d150 (E2E new-plan-round-fold-site-facts): the PLAN FIRST nudge asked for record_plan
 * as the only call of a response, iteration 0 searched workflows and agents, and search_agents'
 * result opened with "Call delegate_to_agent(agentName="browser_agent", ...) NOW". Iteration 1 sent
 * two delegations, the second was dropped, and no plan was recorded for the plan round fold to run.
 *
 * Every site that emits the strong-match pointer is replayed here: search_agents, its retry with a
 * shortened query, its retry with a restatement, and list_agents. With the flag the pointer names
 * the agent for the plan's delegate steps; without it the line is the old one, byte for byte.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tool lists as in format-producer-ranking.test.ts, so no agent is left out for want of a tool.
const AGENTS = {
  document_intake: {
    description: "The document intake specialist.",
    capabilities: ["documents"],
    tags: ["documents"],
    tools: ["extract_file_content", "read_file", "list_files", "write_file"],
    maxIterations: 4,
  },
  paper_author: {
    description: "The paper author specialist.",
    capabilities: ["documents"],
    tags: ["documents"],
    tools: ["read_file", "write_file", "edit_file", "generate_document", "generate_docx"],
    maxIterations: 4,
  },
};

const cosFor = (routingScore: number): number => routingScore * 2 - 1;
const vectorAt = (cos: number): Float32Array => new Float32Array([cos, Math.sqrt(Math.max(0, 1 - cos * cos))]);
const PLACEMENT: Record<string, number> = { document_intake: 0.852, paper_author: 0.80 };

/** Matches both agents above the admission floor, document_intake first at high confidence. */
const QUERY = "generate Word document file create document artifact";
/** Over-specified: matches nothing, and its shortened form is retried. */
const LONG_QUERY = "generate Word document file create document artifact for the quarterly team meeting notes";
/** Matches nothing and is too short to shorten, so it is restated. */
const MISS_QUERY = "zulu yankee xray";
const RESTATEMENT = "create a document file";

const NOW_LINE = (agent: string) => `➡ NEXT ACTION: Call delegate_to_agent(agentName="${agent}", task="<your task>") NOW.`;
const PLAN_LINE = (agent: string) => `➡ NEXT ACTION: Use agentName="${agent}" for the delegate steps of your record_plan.`;

let tempDir: string | undefined;

interface Run {
  output: string;
  metadata: Record<string, unknown>;
}

async function runRoutingTool(
  toolName: "search_agents" | "list_agents",
  query: string,
  planFirstPending: boolean | undefined,
): Promise<Run> {
  vi.resetModules();
  tempDir = mkdtempSync(join(tmpdir(), "starlingai-plan-pointer-"));
  const configPath = join(tempDir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({
    agents: { defaults: { model: { primary: "lmstudio/qwen", embeddingModel: "lmstudio/embed" } } },
    subAgents: AGENTS,
    retrieval: { reranker: { enabled: false } },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configPath;
  process.env["SAI_EMBEDDING_CACHE"] = join(tempDir, "embedding-cache.json");
  process.env["SAI_SESSION_STORE"] = join(tempDir, "sessions.json");

  // The two queries that miss point away from every agent; anything else points at them.
  const provider = {
    embed: vi.fn(async (texts: string[]) => texts.map((text) => {
      if (text.startsWith("Agent:")) {
        const name = text.split("\n")[0]!.slice("Agent: ".length).trim();
        return vectorAt(cosFor(PLACEMENT[name] ?? 0.30));
      }
      return [LONG_QUERY, MISS_QUERY].some((miss) => text.includes(miss)) ? vectorAt(-1) : vectorAt(1);
    })),
  };
  vi.doMock("../providers/index.js", async () => ({
    ...(await vi.importActual<Record<string, unknown>>("../providers/index.js")),
    getEmbeddingProvider: () => provider,
  }));
  // The restatement comes from the routing tier; here it is fixed and routed like the real one.
  vi.doMock("../agent/routing-restatement.js", async () => ({
    ...(await vi.importActual<Record<string, unknown>>("../agent/routing-restatement.js")),
    attemptRestatementRescue: async <T>(_raw: string, options: { resolve: (q: string) => Promise<T>; admitted: (r: T) => boolean }) => {
      const resolution = await options.resolve(RESTATEMENT);
      return options.admitted(resolution) ? { restatement: RESTATEMENT, resolution } : null;
    },
  }));
  vi.doMock("../audit/logger.js", async () => ({
    ...(await vi.importActual<Record<string, unknown>>("../audit/logger.js")),
    logAudit: vi.fn(),
  }));

  const { buildAgentIndex, resetEmbeddingSearchStateForTests } = await import("../providers/embeddings.js");
  resetEmbeddingSearchStateForTests();
  await buildAgentIndex(AGENTS as never, provider as never, "lmstudio/embed");

  const [{ getTool }, { createSession }] = await Promise.all([
    import("../tools/registry.js"),
    import("../agent/session.js"),
    import("../tools/sub-agent.js"),
  ]);
  const session = createSession({ sessionId: `plan-pointer-${Date.now()}-${Math.random()}`, channel: "webchat" });
  const tool = getTool(toolName);
  if (!tool) throw new Error(`${toolName} is not registered`);
  const result = await tool.execute({ query }, {
    sessionId: session.id,
    workspacePath: "/workspace",
    ...(planFirstPending === undefined ? {} : { planFirstPending }),
  });
  return { output: result.output, metadata: (result.metadata ?? {}) as Record<string, unknown> };
}

const firstLine = (run: Run): string => run.output.split("\n")[0]!;

describe("the strong-match pointer on a turn that plans first", () => {
  beforeEach(() => {
    delete process.env["SAI_CONFIG_PATH"];
    delete process.env["SAI_EMBEDDING_CACHE"];
    delete process.env["SAI_SESSION_STORE"];
  });
  afterEach(async () => {
    vi.doUnmock("../providers/index.js");
    vi.doUnmock("../agent/routing-restatement.js");
    vi.doUnmock("../audit/logger.js");
    delete process.env["SAI_CONFIG_PATH"];
    delete process.env["SAI_EMBEDDING_CACHE"];
    delete process.env["SAI_SESSION_STORE"];
    if (tempDir) { rmSync(tempDir, { recursive: true, force: true }); tempDir = undefined; }
    vi.resetModules();
    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
  });

  it("search_agents names the agent for the plan's delegate steps", async () => {
    const run = await runRoutingTool("search_agents", QUERY, true);
    expect(run.metadata["topResult"]).toBe("document_intake");
    expect(run.metadata["topResultConfidence"]).toBe("high");
    expect(firstLine(run)).toBe(`${PLAN_LINE("document_intake")} Do NOT call search_agents again.`);
    expect(run.output).not.toContain("NOW");
  });

  it("search_agents keeps the old line on any other turn", async () => {
    for (const flag of [undefined, false]) {
      const run = await runRoutingTool("search_agents", QUERY, flag);
      expect(firstLine(run), String(flag)).toBe(`${NOW_LINE("document_intake")} Do NOT call search_agents again.`);
    }
  });

  it("its retry with a shortened query does the same", async () => {
    const planned = await runRoutingTool("search_agents", LONG_QUERY, true);
    expect(planned.metadata["retryAfterEmpty"]).toBe(true);
    const agent = String(planned.metadata["topResult"]);
    expect(firstLine(planned)).toBe(`${PLAN_LINE(agent)} Do NOT call search_agents again.`);

    const plain = await runRoutingTool("search_agents", LONG_QUERY, undefined);
    expect(plain.metadata["retryAfterEmpty"]).toBe(true);
    expect(firstLine(plain)).toBe(`${NOW_LINE(String(plain.metadata["topResult"]))} Do NOT call search_agents again.`);
  });

  it("its retry with a restatement does the same", async () => {
    const planned = await runRoutingTool("search_agents", MISS_QUERY, true);
    expect(planned.metadata["restatementRescue"]).toBe(true);
    expect(firstLine(planned)).toBe(`${PLAN_LINE(String(planned.metadata["topResult"]))} Do NOT call search_agents again.`);

    const plain = await runRoutingTool("search_agents", MISS_QUERY, undefined);
    expect(plain.metadata["restatementRescue"]).toBe(true);
    expect(firstLine(plain)).toBe(`${NOW_LINE(String(plain.metadata["topResult"]))} Do NOT call search_agents again.`);
  });

  it("list_agents does the same", async () => {
    const planned = await runRoutingTool("list_agents", QUERY, true);
    expect(planned.metadata["topResult"]).toBe("document_intake");
    expect(firstLine(planned)).toBe(PLAN_LINE("document_intake"));

    const plain = await runRoutingTool("list_agents", QUERY, undefined);
    expect(firstLine(plain)).toBe(NOW_LINE("document_intake"));
  });
});
