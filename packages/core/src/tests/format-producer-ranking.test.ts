/**
 * search_agents ranks the agents that can WRITE a requested file format first (E2E session
 * fa8bb08b, core-build-artifact-docx).
 *
 * The user asked for "ein Word-Dokument (.docx)". The orchestrator searched twice ("generate Word
 * document .docx file create document artifact", then the same words reordered) and both times got
 * document_intake first at high confidence (0.852 / 0.872) with "NEXT ACTION: Call
 * delegate_to_agent(document_intake) NOW". document_intake extracts uploaded files and holds no .docx
 * writer; it wrote a python-docx script it could not run, then HTML, and the turn delivered no
 * document. paper_author (#2, 0.850) and content_writer (#5, 0.822) both hold generate_docx.
 *
 * Re-measured against the live embedding model after the catalog wording change (8bb09d8), the top
 * four did not move: the ranking needs a capability key, the same shape as the research reorder.
 * The search_agents tests below replay that ranking: same five agents, same order, same scores.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentCfgProducesFormats,
  reorderByFormatProducer,
  requestedOutputFormats,
  type AgentRoutingCandidate,
} from "../tools/agent-routing.js";

// Tool lists verbatim from the deployed shards (workspace/agents/*.jsonc at 6cd93a6).
const TOOLS = {
  document_intake: [
    "extract_file_content", "extract_notebook", "extract_email", "extract_calendar", "transcribe_audio",
    "transcribe_video", "analyze_image", "read_file", "list_files", "list_pdf_form_fields", "pdf_fill",
    "spreadsheet_read", "spreadsheet_write", "workspace_search", "read_shared_facts", "share_finding",
    "write_file", "edit_file",
  ],
  paper_author: [
    "search_agents", "delegate_to_agent", "read_shared_facts", "read_file", "write_file", "edit_file",
    "generate_document", "generate_pdf", "generate_docx", "regex_test", "datetime_arithmetic",
  ],
  tool_developer: [
    "tool_dev_start", "tool_dev_test", "tool_dev_submit", "read_file", "write_file", "edit_file",
    "list_files", "workspace_search", "read_shared_facts", "share_finding",
  ],
  image_creator: [
    "generate_image", "transform_image", "analyze_image", "generate_svg", "generate_qr_code", "read_file",
    "write_file", "edit_file", "read_shared_facts", "share_finding",
  ],
  content_writer: [
    "read_file", "write_file", "edit_file", "list_files", "workspace_search", "glob_files", "grep_files",
    "generate_document", "generate_website", "generate_presentation", "generate_docx", "generate_pptx",
    "render_pdf", "bundle_artifact_zip", "read_shared_facts", "share_finding",
  ],
  report_writer_agent: [
    "read_shared_facts", "pentest_report", "generate_document", "generate_pdf", "write_file", "edit_file", "read_file",
  ],
  coder: ["read_file", "write_file", "edit_file", "run_script", "shell_exec"],
};

const candidates = (...names: string[]): AgentRoutingCandidate[] =>
  names.map((name, i) => ({ name, score: 0.85 - i * 0.01, confidence: "high" } as AgentRoutingCandidate));

describe("which formats a routing query asks to have made", () => {
  it("reads a bare extension in a query that asks for a deliverable", () => {
    expect(requestedOutputFormats("generate Word document .docx file create document artifact", [])).toEqual(["docx"]);
    expect(requestedOutputFormats("Erstelle ein Word-Dokument (.docx) „Sicherheitsunterweisung Werkstatt“", [])).toEqual(["docx"]);
    expect(requestedOutputFormats("create the quarterly deck as .pptx and a one-page handout as .pdf", [])).toEqual(["pptx", "pdf"]);
  });

  it("asks for nothing when the query names no extension", () => {
    expect(requestedOutputFormats("generate Word document create document artifact", [])).toEqual([]);
    // A word that merely starts like an extension is not one.
    expect(requestedOutputFormats("create a report on the .pdfium renderer", [])).toEqual([]);
  });

  it("reads an extension on a file name as a file, not a format to make", () => {
    // From eval/intent: the named file is the one the user already has, and each query also
    // matches the deliverable test ("draft", "Mach", "add").
    expect(requestedOutputFormats("Read my thesis draft (thesis.pdf) and tell me whether the structure is logical.", [])).toEqual([]);
    expect(requestedOutputFormats("Mach aus meinem Bericht (bericht.docx) eine Präsentation für die Geschäftsführung.", [])).toEqual([]);
    expect(requestedOutputFormats("Sum up the totals in costs.xlsx and add the amount as a reminder in my calendar for Friday.", [])).toEqual([]);
  });

  it("asks for nothing when the query asks for no deliverable", () => {
    // Reading a format is document_intake's job, and it keeps its place.
    expect(requestedOutputFormats("extract the text from .docx uploads", [])).toEqual([]);
  });

  it("leaves a research query to the research reorder", () => {
    // The evidence is gathered first and the file made after. A writer ranked above the
    // researcher wrote pricing reports from memory (session 00b3675d).
    const query = "Research current subscription prices of the major AI coding tools and write a .docx report";
    expect(requestedOutputFormats(query, [])).toEqual([]);
  });

  it("drops a format the user handed over: that file is the input", () => {
    const query = "summarise the uploaded report (.pdf) and write the summary as a .docx";
    expect(requestedOutputFormats(query, [{ filename: "report.pdf" }])).toEqual(["docx"]);
    expect(requestedOutputFormats(query, [{ relativePath: "uploads/abc/report.pdf" }])).toEqual(["docx"]);
    // A file named without its extension is still recognised by its content type.
    expect(requestedOutputFormats(query, [{ filename: "Bericht", contentType: "application/pdf" }])).toEqual(["docx"]);
    expect(requestedOutputFormats(query, [{ filename: "notes.txt" }])).toEqual(["pdf", "docx"]);
  });
});

describe("who can make a format", () => {
  it("credits the producer tool, not a generic file writer", () => {
    expect(agentCfgProducesFormats({ tools: TOOLS.document_intake }, ["docx"])).toBe(false);
    expect(agentCfgProducesFormats({ tools: TOOLS.paper_author }, ["docx"])).toBe(true);
    expect(agentCfgProducesFormats({ tools: TOOLS.content_writer }, ["docx"])).toBe(true);
    expect(agentCfgProducesFormats({ tools: TOOLS.content_writer }, ["pdf"])).toBe(true); // render_pdf
    expect(agentCfgProducesFormats({ tools: TOOLS.content_writer }, ["xlsx"])).toBe(false);
    expect(agentCfgProducesFormats({ tools: TOOLS.document_intake }, ["xlsx"])).toBe(true); // spreadsheet_write
  });

  it("does not credit pdf_fill, which only fills a PDF someone handed over", () => {
    expect(agentCfgProducesFormats({ tools: TOOLS.document_intake }, ["pdf"])).toBe(false);
  });

  it("needs every requested format", () => {
    expect(agentCfgProducesFormats({ tools: TOOLS.paper_author }, ["docx", "pdf"])).toBe(true);
    expect(agentCfgProducesFormats({ tools: TOOLS.report_writer_agent }, ["docx", "pdf"])).toBe(false);
  });

  it("credits a sandbox code runner and an agent that inherits every tool", () => {
    expect(agentCfgProducesFormats({ tools: TOOLS.coder }, ["docx", "pptx", "xlsx", "pdf"])).toBe(true);
    expect(agentCfgProducesFormats({ tools: ["mcp__code_sandbox__run_python"] }, ["docx"])).toBe(true);
    expect(agentCfgProducesFormats({}, ["docx"])).toBe(true);
  });

  it("does not vouch for an agent it has no config for", () => {
    expect(agentCfgProducesFormats(undefined, ["docx"])).toBe(false);
  });
});

describe("the reorder", () => {
  const canMakeDocx = (name: string): boolean =>
    agentCfgProducesFormats({ tools: TOOLS[name as keyof typeof TOOLS] }, ["docx"]);

  it("puts the producers first in their own order and drops nobody", () => {
    const ranked = candidates("document_intake", "paper_author", "tool_developer", "image_creator", "content_writer");
    expect(reorderByFormatProducer(ranked, canMakeDocx).map((c) => c.name))
      .toEqual(["paper_author", "content_writer", "document_intake", "tool_developer", "image_creator"]);
  });

  it("returns the list itself when none or all can make the format", () => {
    const none = candidates("document_intake", "tool_developer");
    const all = candidates("paper_author", "content_writer");
    expect(reorderByFormatProducer(none, canMakeDocx)).toBe(none);
    expect(reorderByFormatProducer(all, canMakeDocx)).toBe(all);
  });
});

// ── search_agents, end to end ─────────────────────────────────────────────────

const cosFor = (routingScore: number): number => routingScore * 2 - 1;
const vectorAt = (cos: number): Float32Array => new Float32Array([cos, Math.sqrt(Math.max(0, 1 - cos * cos))]);

/** The session's ranking for "generate Word document .docx file create document artifact". */
const SESSION_RANKING: Record<string, number> = {
  document_intake: 0.852,
  paper_author: 0.850,
  tool_developer: 0.846,
  image_creator: 0.838,
  content_writer: 0.822,
};

const agentConfig = (name: keyof typeof TOOLS) => ({
  description: `The ${name.replace(/_/g, " ")} specialist.`,
  capabilities: ["documents"],
  tags: ["documents"],
  tools: TOOLS[name],
  maxIterations: 4,
});

const AGENTS = {
  document_intake: agentConfig("document_intake"),
  paper_author: agentConfig("paper_author"),
  tool_developer: agentConfig("tool_developer"),
  image_creator: agentConfig("image_creator"),
  content_writer: agentConfig("content_writer"),
};

const DOCX_QUERY = "generate Word document .docx file create document artifact";

let tempDir: string | undefined;

interface SearchRun {
  output: string;
  metadata: Record<string, unknown>;
  auditRow: Record<string, unknown> | undefined;
}

async function searchAgents(
  query: string,
  opts: {
    placement?: Record<string, number>;
    sessionMessages?: Array<{ role: "user" | "assistant"; content: string; metadata?: Record<string, unknown> }>;
  } = {},
): Promise<SearchRun> {
  const placement = opts.placement ?? SESSION_RANKING;
  vi.resetModules();
  tempDir = mkdtempSync(join(tmpdir(), "starlingai-format-producer-"));
  const configPath = join(tempDir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({
    agents: { defaults: { model: { primary: "lmstudio/qwen", embeddingModel: "lmstudio/embed" } } },
    subAgents: AGENTS,
    // The live reranker answered HTTP 500 on that run, so the embedding order stood.
    retrieval: { reranker: { enabled: false } },
    orchestration: { routingRestatementRescue: false },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configPath;
  process.env["SAI_EMBEDDING_CACHE"] = join(tempDir, "embedding-cache.json");
  // The session store resolves its path when the module loads; a temp one, not the source tree's.
  process.env["SAI_SESSION_STORE"] = join(tempDir, "sessions.json");

  const provider = {
    embed: vi.fn(async (texts: string[]) => texts.map((text) => {
      if (!text.startsWith("Agent:")) return vectorAt(1);
      const name = text.split("\n")[0]!.slice("Agent: ".length).trim();
      return vectorAt(cosFor(placement[name] ?? 0.30));
    })),
  };
  vi.doMock("../providers/index.js", async () => ({
    ...(await vi.importActual<Record<string, unknown>>("../providers/index.js")),
    getEmbeddingProvider: () => provider,
  }));
  const logAudit = vi.fn();
  vi.doMock("../audit/logger.js", async () => ({
    ...(await vi.importActual<Record<string, unknown>>("../audit/logger.js")),
    logAudit,
  }));

  const { buildAgentIndex, resetEmbeddingSearchStateForTests } = await import("../providers/embeddings.js");
  resetEmbeddingSearchStateForTests();
  await buildAgentIndex(AGENTS as never, provider as never, "lmstudio/embed");

  const [{ getTool }, { createSession }] = await Promise.all([
    import("../tools/registry.js"),
    import("../agent/session.js"),
    import("../tools/sub-agent.js"),
  ]);
  const session = createSession({ sessionId: `format-producer-${Date.now()}-${Math.random()}`, channel: "webchat" });
  for (const message of opts.sessionMessages ?? []) session.addMessage(message);

  const tool = getTool("search_agents");
  if (!tool) throw new Error("search_agents tool is not registered");
  const result = await tool.execute({ query }, { sessionId: session.id, workspacePath: "/workspace" });
  const auditRow = logAudit.mock.calls.find((call) => call[0] === "agent_routing_evaluated")?.[1] as Record<string, unknown> | undefined;
  return { output: result.output, metadata: (result.metadata ?? {}) as Record<string, unknown>, auditRow };
}

const listedOrder = (output: string): string[] => [...output.matchAll(/^\*\*([a-z_]+)\*\*/gm)].map((m) => m[1]!);

describe("search_agents and a request to make a .docx", () => {
  beforeEach(() => {
    delete process.env["SAI_CONFIG_PATH"];
    delete process.env["SAI_EMBEDDING_CACHE"];
    delete process.env["SAI_SESSION_STORE"];
  });
  afterEach(async () => {
    vi.doUnmock("../providers/index.js");
    vi.doUnmock("../audit/logger.js");
    delete process.env["SAI_CONFIG_PATH"];
    delete process.env["SAI_EMBEDDING_CACHE"];
    delete process.env["SAI_SESSION_STORE"];
    if (tempDir) { rmSync(tempDir, { recursive: true, force: true }); tempDir = undefined; }
    vi.resetModules();
    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
  });

  it("replays session fa8bb08b: a .docx writer goes first and gets the NEXT ACTION, document_intake stays listed", async () => {
    const run = await searchAgents(DOCX_QUERY);

    expect(run.metadata["topResult"]).toBe("paper_author");
    expect(run.output.split("\n")[0]).toBe(
      '➡ NEXT ACTION: Call delegate_to_agent(agentName="paper_author", task="<your task>") NOW. Do NOT call search_agents again.',
    );
    // Ordering only: all five are still offered, document_intake right after the two writers.
    expect(listedOrder(run.output)).toEqual(["paper_author", "content_writer", "document_intake", "tool_developer", "image_creator"]);
    expect(run.metadata["suggestedFallbackAgents"]).toEqual(["content_writer", "document_intake", "tool_developer"]);
    expect(run.metadata["outputFormats"]).toEqual(["docx"]);
    expect(run.metadata["topCanProduceOutputFormats"]).toBe(true);
    // The audit row is how the next E2E run shows whether this fired.
    expect(run.auditRow?.["topResult"]).toBe("paper_author");
    expect(run.auditRow?.["outputFormats"]).toEqual(["docx"]);
  });

  it("does the same for the orchestrator's second query", async () => {
    const run = await searchAgents("create Word document .docx file generate document artifact");
    expect(run.metadata["topResult"]).toBe("paper_author");
  });

  it("points at nobody imperatively when no candidate can write the format", async () => {
    // The two writers fall under the admission floor: only non-producers are offered.
    const run = await searchAgents(DOCX_QUERY, {
      placement: { document_intake: 0.852, tool_developer: 0.846, image_creator: 0.838, paper_author: 0.60, content_writer: 0.60 },
    });

    expect(run.metadata["topResult"]).toBe("document_intake");
    expect(run.output).not.toContain("NEXT ACTION");
    expect(run.output.split("\n")[0]).toMatch(/^ℹ Best available match is document_intake \(high confidence, score 0\.85\) — review the candidate list below/);
    expect(run.metadata["topCanProduceOutputFormats"]).toBe(false);
  });

  it("leaves the ranking alone when the user handed over a .docx in this session", async () => {
    const run = await searchAgents(DOCX_QUERY, {
      sessionMessages: [{ role: "user", content: "Mach daraus ein neues Dokument", metadata: { attachments: [{ filename: "Unterweisung.docx" }] } }],
    });

    expect(run.metadata["topResult"]).toBe("document_intake");
    expect(run.output.split("\n")[0]).toContain('delegate_to_agent(agentName="document_intake"');
    expect(run.metadata).not.toHaveProperty("outputFormats");
  });

  it("does not count a .docx the swarm produced as one the user handed over", async () => {
    const run = await searchAgents(DOCX_QUERY, {
      sessionMessages: [
        { role: "user", content: "Erstelle eine Unterweisung" },
        { role: "assistant", content: "Fertig.", metadata: { attachments: [{ filename: "Unterweisung.docx", sourceTool: "generate_docx" }] } },
      ],
    });

    expect(run.metadata["topResult"]).toBe("paper_author");
  });

  it("changes nothing for a query that names no format (discriminance control)", async () => {
    // Identical catalog, identical scores; only the ".docx" token is gone.
    const run = await searchAgents("generate Word document file create document artifact");

    expect(run.metadata["topResult"]).toBe("document_intake");
    expect(run.output.split("\n")[0]).toBe(
      '➡ NEXT ACTION: Call delegate_to_agent(agentName="document_intake", task="<your task>") NOW. Do NOT call search_agents again.',
    );
    expect(listedOrder(run.output)).toEqual(["document_intake", "paper_author", "tool_developer", "image_creator", "content_writer"]);
    expect(run.metadata).not.toHaveProperty("outputFormats");
    expect(run.auditRow).not.toHaveProperty("outputFormats");
  });
});
