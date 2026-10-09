import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * AN AGENT LEFT WITH NO USABLE TOOL IS NOT ROUTED.
 *
 * E2E 2026-10-08 (guards-list-files-on-a-file): the processmem MCP server was unreachable
 * (getaddrinfo ENOTFOUND), so none of process_memory_keeper's ten mcp__processmem__ tools was
 * registered. A sub-agent run keeps only registered tools without saying so, and routing filtered
 * only circuit-broken agents: discovery routed "Schreibe die Textdatei generated/e2e-guards/
 * inventur.txt …" to process_memory_keeper alone (0.7267, high). It ran with read_shared_facts and
 * share_finding, called share_finding, was counted a success, and the file was never written.
 */

/**
 * The processmem server as the E2E stack saw it: every connect fails. syncMcpServers is the gateway's
 * own connect pass; a process that never runs it (routing:canary, routing:eval) has no bridged tool
 * whatever state the server is in.
 */
const connectMcpServer = vi.hoisted(() => vi.fn(async (name: string) => { throw new Error(`getaddrinfo ENOTFOUND ${name}`); }));
vi.mock("../mcp/client.js", () => ({ connectMcpServer, cleanupConfiguredDockerMcpContainers: async () => undefined }));

const audit = vi.hoisted(() => vi.fn());
vi.mock("../audit/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../audit/logger.js")>();
  return { ...actual, logAudit: (...args: Parameters<typeof actual.logAudit>) => { audit(...args); return actual.logAudit(...args); } };
});

/** process_memory_keeper's declared tools, verbatim from the local 60-processmem shard. */
const PROCESSMEM_TOOLS = [
  "mcp__processmem__open_process", "mcp__processmem__transition_process", "mcp__processmem__attach_subprocess",
  "mcp__processmem__record_entry", "mcp__processmem__attach_entry", "mcp__processmem__find_processes",
  "mcp__processmem__define_aspect", "mcp__processmem__note_aspect_mention", "mcp__processmem__link_entries",
  "mcp__processmem__ingest_message", "read_shared_facts", "share_finding",
];

const AGENTS = {
  process_memory_keeper: {
    description: "Keeps long-running matters in ProcessMem: correspondence, disputes, cases and their timeline.",
    capabilities: ["matter tracking"], tags: ["matter"], tools: PROCESSMEM_TOOLS, maxIterations: 4,
  },
  browser_agent: {
    description: "Opens websites in a live browser, clicks through pages and captures page evidence.",
    capabilities: ["browser automation"], tags: ["browser"],
    tools: ["web_search", "browser_navigate", "browser_click", "browser_snapshot", "read_shared_facts", "share_finding"], maxIterations: 4,
  },
  researcher: {
    description: "Researches public facts on the web and verifies them against their sources.",
    capabilities: ["research"], tags: ["research"],
    tools: ["web_search", "web_fetch", "url_inspect", "read_shared_facts", "share_finding"], maxIterations: 4,
  },
};

/** One query that every agent above matches by keyword, so each one's absence is the filter's doing. */
const QUERY = "correspondence dispute matter timeline website browser research sources";

let tempDir: string | undefined;

/** Routes over `agents` in a fresh process. `connectMcp` runs the gateway's MCP connect pass first, as every serving process does. */
async function routeWith(agents: Record<string, unknown>, extraConfig: Record<string, unknown> = {}, { connectMcp = true } = {}) {
  vi.resetModules();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = mkdtempSync(join(tmpdir(), "starlingai-toolless-"));
  const configPath = join(tempDir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({
    workspacePath: tempDir,
    agents: { defaults: { model: { primary: "lmstudio/qwen" } } },
    subAgents: agents,
    retrieval: { reranker: { enabled: false } },
    mcp: { servers: { processmem: { transport: "http", url: "http://processmem:8080/mcp" } } },
    ...extraConfig,
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configPath;
  if (connectMcp) await (await import("../mcp/registry.js")).syncMcpServers();
  const [{ resolveAgentRouting }, registry] = await Promise.all([
    import("../tools/agent-routing.js"),
    import("../tools/registry.js"),
  ]);
  const route = async () => {
    const resolution = await resolveAgentRouting(QUERY, { minConfidence: "low" });
    return { resolution, names: [...resolution.results, ...resolution.weakCandidates].map((candidate) => candidate.name) };
  };
  return { route, registry };
}

afterEach(async () => {
  connectMcpServer.mockClear();
  audit.mockClear();
  vi.unstubAllGlobals();
  delete process.env["SAI_CONFIG_PATH"];
  (await import("../config/loader.js")).resetConfigForTests();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
  vi.resetModules();
});

describe("routing an agent whose tools are all unusable", () => {
  it("leaves out process_memory_keeper while its MCP server is unreachable, and says so", async () => {
    const { route } = await routeWith(AGENTS);
    const { resolution, names } = await route();

    expect(names).not.toContain("process_memory_keeper");
    expect(resolution.toollessAgents).toEqual(["process_memory_keeper"]);
    // Their built-in tools are not registered in this process either: a module registers them on
    // import, so their absence here says nothing about the deployment.
    expect(names).toEqual(expect.arrayContaining(["browser_agent", "researcher"]));
  });

  it("keeps it in a process that never connected its MCP servers, such as the routing CLIs", async () => {
    const { route } = await routeWith(AGENTS, {}, { connectMcp: false });
    const { resolution, names } = await route();

    expect(connectMcpServer).not.toHaveBeenCalled();
    expect(names).toEqual(expect.arrayContaining(["process_memory_keeper", "browser_agent", "researcher"]));
    expect("toollessAgents" in resolution).toBe(false);
  });

  it("routes it again once one of its MCP tools is registered", async () => {
    const { route, registry } = await routeWith(AGENTS);
    registry.registerTool({
      name: "mcp__processmem__record_entry",
      description: "[MCP:processmem] Record an entry.",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ success: true, output: "" }),
    });
    try {
      const { resolution, names } = await route();
      expect(names).toContain("process_memory_keeper");
      expect(resolution.toollessAgents).toBeUndefined();
    } finally {
      registry.unregisterTool("mcp__processmem__record_entry");
    }
  });

  it("leaves out an agent whose every tool config disables, and keeps one with only the bookkeeping pair or the full set", async () => {
    const { route } = await routeWith({
      ...AGENTS,
      matter_scanner: {
        description: "Scans the dispute matter's hosts.", capabilities: ["scan"], tags: ["dispute"],
        tools: ["nmap_scan", "nikto_scan", "share_finding"], maxIterations: 4,
      },
      matter_reader: {
        description: "Reads the shared correspondence findings of a matter.", capabilities: ["read"], tags: ["matter"],
        tools: ["read_shared_facts", "share_finding"], maxIterations: 4,
      },
      matter_generalist: {
        description: "Handles any dispute matter with the full tool set.", capabilities: ["general"], tags: ["matter"], maxIterations: 4,
      },
    }, { tools: { disabledGroups: ["pentest"] } });
    const { resolution, names } = await route();

    expect(resolution.toollessAgents?.sort()).toEqual(["matter_scanner", "process_memory_keeper"]);
    expect(names).toEqual(expect.arrayContaining(["matter_reader", "matter_generalist", "browser_agent", "researcher"]));
  });

  it("does not exclude anything when every agent has a usable tool, and adds no field to the result", async () => {
    const { route } = await routeWith({ browser_agent: AGENTS.browser_agent, researcher: AGENTS.researcher });
    const { resolution } = await route();

    expect("toollessAgents" in resolution).toBe(false);
  });
});

describe("search_agents", () => {
  /** The agent_routing_evaluated row search_agents writes for its own query. */
  const searchRow = async () => {
    const { getTool } = await import("../tools/registry.js");
    await import("../tools/sub-agent.js");
    await getTool("search_agents")!.execute({ query: QUERY, minConfidence: "low" }, { sessionId: "s-search", workspacePath: tempDir! });
    const row = audit.mock.calls.find((call) => call[0] === "agent_routing_evaluated" && (call[1] as Record<string, unknown>)["query"] === QUERY);
    audit.mockClear();
    return row?.[1] as Record<string, unknown> | undefined;
  };

  it("says on its routing row which agents it left out for want of a tool, and adds no field when there were none", async () => {
    // No model endpoint: a restatement retry fails at once instead of reaching for one.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    await routeWith(AGENTS);
    expect(await searchRow()).toEqual(expect.objectContaining({ toollessAgents: ["process_memory_keeper"], trippedAgents: [] }));

    await routeWith({ browser_agent: AGENTS.browser_agent, researcher: AGENTS.researcher });
    const clean = await searchRow();
    expect(clean).toBeDefined();
    expect(clean && "toollessAgents" in clean).toBe(false);
  }, 30_000);
});

describe("the predicate", () => {
  it("counts only tools this process cannot offer, beyond the bookkeeping pair", async () => {
    await routeWith(AGENTS);
    const { agentCfgHasNoUsableTools } = await import("../tools/agent-routing.js");
    expect(agentCfgHasNoUsableTools({ tools: PROCESSMEM_TOOLS })).toBe(true);
    // A name no process can register (no tier, not bridged) leaves its holder with nothing too.
    expect(agentCfgHasNoUsableTools({ tools: ["fetch_the_page", "share_finding"] })).toBe(true);
    // One usable domain tool is enough.
    expect(agentCfgHasNoUsableTools({ tools: [...PROCESSMEM_TOOLS, "write_file"] })).toBe(false);
    expect(agentCfgHasNoUsableTools({ tools: ["read_shared_facts", "share_finding"] })).toBe(false);
    expect(agentCfgHasNoUsableTools({ tools: [] })).toBe(false);
    expect(agentCfgHasNoUsableTools({})).toBe(false);
    expect(agentCfgHasNoUsableTools(undefined)).toBe(false);
  });

  it("counts a bridged MCP tool as unusable only once this process has tried to connect its servers", async () => {
    await routeWith(AGENTS, {}, { connectMcp: false });
    const { agentCfgHasNoUsableTools } = await import("../tools/agent-routing.js");
    expect(agentCfgHasNoUsableTools({ tools: PROCESSMEM_TOOLS })).toBe(false);
    // A name nothing registers is unusable in any process, connected or not.
    expect(agentCfgHasNoUsableTools({ tools: ["fetch_the_page", "share_finding"] })).toBe(true);
    await (await import("../mcp/registry.js")).syncMcpServers();
    expect(agentCfgHasNoUsableTools({ tools: PROCESSMEM_TOOLS })).toBe(true);
  });
});
