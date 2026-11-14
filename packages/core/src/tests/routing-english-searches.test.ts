import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../tools/registry.js";

/**
 * EVERY CATALOG SEARCH RUNS ON THE REQUEST IN ENGLISH (agent/routing-english.ts).
 *
 * The router (search_agents, an un-named delegation, the bidders, the discovery capsule), the
 * workflow catalog and the tool catalog each score a request against English descriptions. This
 * pins that what reaches the embedding and the word match is the English rendering, that the
 * request is still reported as it was asked, and that a catalog entry written in another language
 * is embedded in English.
 */
const GERMAN_AGENT = "Recherchiere im Netz, wie das Wetter heute Nachmittag in Bremen wird";
const ENGLISH_AGENT = "Search the web for this afternoon's weather in Bremen";
const GERMAN_WORKFLOW = "Erstelle den Wochenbericht aus den Verkaufszahlen";
const ENGLISH_WORKFLOW = "Build the weekly report from the sales figures";
const GERMAN_TOOL = "Lies den Inhalt einer Datei im Arbeitsbereich";
const ENGLISH_TOOL = "read the contents of a file in the workspace";
const GERMAN_SCENE = "Erstellt jeden Freitag den Wochenbericht aus den Verkaufszahlen.";
const ENGLISH_SCENE = "Builds the weekly report from the sales figures every Friday.";

const seen = vi.hoisted(() => ({
  /** Every text handed to an embedding, in order. */
  embedded: [] as string[],
  /** The queries the agent index was searched with. */
  agentQueries: [] as string[],
  embeddingOn: true,
  renderings: {} as Record<string, string>,
  audit: [] as Array<{ type: string; data: Record<string, unknown> }>,
}));

vi.mock("../agent/routing-english.js", () => ({
  routingEnglishEnabled: () => true,
  primeRoutingEnglish: () => undefined,
  routingEnglish: async (text: string) => {
    const raw = text.trim();
    const english = seen.renderings[raw];
    return english ? { text: english, translated: true, outcome: "translated", language: "de" } : { text: raw, translated: false, outcome: "english", language: "en" };
  },
  // A catalog entry: every German sentence of it that has a rendering is replaced.
  catalogEnglish: async (text: string) => Object.entries(seen.renderings).reduce((doc, [german, english]) => doc.split(german).join(english), text),
}));
vi.mock("../providers/embeddings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../providers/embeddings.js")>()),
  isEmbeddingAvailable: () => seen.embeddingOn,
  searchByEmbedding: async (query: string) => {
    seen.agentQueries.push(query);
    // The index holds English descriptions: only an English request is near one.
    const english = !/[äöüß]|\b(?:wie|das|den|der|im|aus)\b/i.test(query);
    return english ? [{ agentName: "researcher", description: "researcher", score: 0.6 }] : [{ agentName: "researcher", description: "researcher", score: 0.36 }];
  },
  computeQueryEmbedding: async (text: string) => { seen.embedded.push(text); return new Float32Array([1, 0]); },
  computeTextEmbeddings: async (texts: string[]) => { seen.embedded.push(...texts); return texts.map(() => new Float32Array([1, 0])); },
}));
vi.mock("../providers/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../providers/index.js")>()),
  getEmbeddingProvider: () => ({
    embed: async (texts: string[]) => { seen.embedded.push(...texts); return texts.map(() => new Float32Array([1, 0])); },
  }),
}));
vi.mock("../retrieval/reranker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../retrieval/reranker.js")>()),
  rerankCandidates: async () => null,
}));
vi.mock("../audit/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../audit/logger.js")>();
  return {
    ...actual,
    logAudit: (type: string, data: Record<string, unknown>, ...rest: unknown[]) => {
      seen.audit.push({ type, data });
      return (actual.logAudit as (...args: unknown[]) => unknown)(type, data, ...rest);
    },
  };
});

const tempDirs: string[] = [];

async function load() {
  const dir = mkdtempSync(join(tmpdir(), "sai-routing-english-searches-"));
  tempDirs.push(dir);
  const workspacePath = join(dir, "workspace");
  mkdirSync(join(workspacePath, ".starlingai"), { recursive: true });
  writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
    workspacePath,
    agents: { defaults: { model: { primary: "lmstudio/qwen", embeddingModel: "test-embedding" } } },
    orchestration: { routingEnglish: true, routingRestatementRescue: false },
    subAgents: {
      researcher: { description: "Finds sources on the web.", systemPrompt: "Research.", tools: ["web_search", "web_fetch"], maxIterations: 4 },
      mail_agent: { description: "Reads and writes mail.", systemPrompt: "Mail.", tools: ["mail_search"], maxIterations: 4 },
    },
    scenes: {
      wochenbericht: { description: GERMAN_SCENE, task: "Use data_analyst." },
    },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
  vi.resetModules();
  (await import("../config/loader.js")).resetConfigForTests();
  seen.embedded = [];
  seen.agentQueries = [];
  seen.audit = [];
  seen.embeddingOn = true;
  seen.renderings = {
    [GERMAN_AGENT]: ENGLISH_AGENT,
    [GERMAN_WORKFLOW]: ENGLISH_WORKFLOW,
    [GERMAN_TOOL]: ENGLISH_TOOL,
    [GERMAN_SCENE]: ENGLISH_SCENE,
  };
}

afterEach(async () => {
  delete process.env["SAI_CONFIG_PATH"];
  vi.resetModules();
  (await import("../config/loader.js")).resetConfigForTests();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the agent router", () => {
  it("searches the index with the request in English, and reports the request as it was asked", async () => {
    await load();
    const { resolveAgentRouting, logRoutingEvaluated } = await import("../tools/agent-routing.js");

    const resolution = await resolveAgentRouting(GERMAN_AGENT);

    expect(seen.agentQueries).toEqual([ENGLISH_AGENT]);
    // Admitted: the English request is near the researcher's description, the German one is not.
    expect(resolution.results.map((entry) => entry.name)).toEqual(["researcher"]);
    expect(resolution.query).toBe(GERMAN_AGENT);
    expect(resolution.routedQuery).toBe(ENGLISH_AGENT);
    expect(resolution.queryLanguage).toBe("de");

    logRoutingEvaluated({ surface: "delegation", query: GERMAN_AGENT, resolution });
    expect(seen.audit.find((row) => row.type === "agent_routing_evaluated")?.data).toMatchObject({
      query: GERMAN_AGENT, routedQuery: ENGLISH_AGENT, queryLanguage: "de",
    });
  });

  it("is what admits the agent: the same request searched as written is admitted nobody", async () => {
    await load();
    seen.renderings = {};
    const { resolveAgentRouting } = await import("../tools/agent-routing.js");

    const resolution = await resolveAgentRouting(GERMAN_AGENT);

    expect(seen.agentQueries).toEqual([GERMAN_AGENT]);
    expect(resolution.results).toEqual([]);
    expect(resolution.routedQuery).toBeUndefined();
  });

  it("adds nothing to a request that was searched as written", async () => {
    await load();
    const { resolveAgentRouting } = await import("../tools/agent-routing.js");

    const resolution = await resolveAgentRouting(ENGLISH_AGENT);

    expect(seen.agentQueries).toEqual([ENGLISH_AGENT]);
    expect(resolution.query).toBe(ENGLISH_AGENT);
    expect("routedQuery" in resolution).toBe(false);
    expect("queryLanguage" in resolution).toBe(false);
  });
});

describe("the workflow catalog", () => {
  it("embeds the request and a scene described in German in English", async () => {
    await load();
    const { searchWorkflowCandidates } = await import("../tools/workflow-catalog.js");

    const found = await searchWorkflowCandidates(GERMAN_WORKFLOW);

    expect(found.map((entry) => entry.name)).toContain("wochenbericht");
    expect(seen.embedded).toContain(`Workflow query: ${ENGLISH_WORKFLOW}`);
    const sceneDocument = seen.embedded.find((text) => text.includes("Workflow Name: wochenbericht"));
    expect(sceneDocument).toContain(`Description: ${ENGLISH_SCENE}`);
    // Nothing German reached the embedding.
    expect(seen.embedded.join("\n")).not.toContain("Wochenbericht aus den Verkaufszahlen");
  });

  it("matches the request's words against the catalog in English too", async () => {
    await load();
    const { searchWorkflowCandidates } = await import("../tools/workflow-catalog.js");

    const found = await searchWorkflowCandidates(GERMAN_WORKFLOW);
    // The scene's name is one German word; "weekly report" is nowhere in its entry. Whatever it
    // matched, it matched from the English request: none of the German request's words is a term.
    const terms = found.find((entry) => entry.name === "wochenbericht")?.matchedTerms ?? [];
    expect(terms.join(" ")).not.toMatch(/erstelle|verkaufszahlen/i);
  });
});

describe("the tool catalog", () => {
  const ctx = { sessionId: "s-tools", workspacePath: "/workspace" } as ToolContext;

  it("searches the tools with the query in English, and names the query as it was asked", async () => {
    await load();
    const { getTool } = await import("../tools/registry.js");
    await import("../tools/sub-agent.js");
    await import("../tools/filesystem.js");

    const result = await getTool("search_tools")!.execute({ query: GERMAN_TOOL, topN: 3 }, ctx);

    expect(result.success).toBe(true);
    expect(seen.embedded).toContain(ENGLISH_TOOL);
    expect(seen.embedded).not.toContain(GERMAN_TOOL);
    expect(String(result.output)).toContain(`Tools matching "${GERMAN_TOOL}"`);
  }, 30_000);

  it("searches them with the query as written when there is no rendering", async () => {
    // The control: the query reaches the embedding either way; which words it carries is the point.
    await load();
    seen.renderings = {};
    const { getTool } = await import("../tools/registry.js");
    await import("../tools/sub-agent.js");
    await import("../tools/filesystem.js");

    await getTool("search_tools")!.execute({ query: GERMAN_TOOL, topN: 3 }, ctx);

    expect(seen.embedded).toContain(GERMAN_TOOL);
    expect(seen.embedded).not.toContain(ENGLISH_TOOL);
  }, 30_000);

  it("ranks a sub-agent's tools against its task in English", async () => {
    await load();
    const { rerankToolsForTask, getToolsAsLLMDefs } = await import("../tools/registry.js");
    await import("../tools/filesystem.js");
    const defs = getToolsAsLLMDefs().filter((def) => ["read_file", "write_file", "list_files"].includes(def.name));
    expect(defs.length).toBeGreaterThanOrEqual(2);

    await rerankToolsForTask(defs, GERMAN_TOOL);

    expect(seen.embedded).toContain(ENGLISH_TOOL);
    expect(seen.embedded).not.toContain(GERMAN_TOOL);
  }, 30_000);
});
