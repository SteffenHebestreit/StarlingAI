import { describe, expect, it } from "vitest";
import {
  isWebReachingToolName,
  isWebGatheringToolName,
  agentCfgIsResearchCapable,
  taskRequiresExternalResearch,
  requiredExecutionCapabilities,
  filterCandidatesByExecutionCapability,
} from "../tools/sub-agent.js";

/**
 * Research-capability gate (regression: session 64b90fcc, 2026-05-29). A
 * "search online and validate" task was routed to image_creator / chart_designer
 * — generators with no web tools — which returned narrative-only non-answers.
 * The gate ensures source-sensitive tasks only go to web-capable agents.
 */
describe("research capability gate", () => {
  it("recognizes web-reaching tool names", () => {
    for (const t of ["web_search", "web_fetch", "url_inspect", "browser_navigate", "browser_snapshot"]) {
      expect(isWebReachingToolName(t)).toBe(true);
    }
    for (const t of ["generate_image", "generate_chart_html", "read_file", "share_finding"]) {
      expect(isWebReachingToolName(t)).toBe(false);
    }
  });

  it("treats generators (image_creator/chart_designer shapes) as research-incapable", () => {
    expect(agentCfgIsResearchCapable({ tools: ["generate_image", "analyze_image", "generate_svg", "read_file", "write_file"] })).toBe(false);
    expect(agentCfgIsResearchCapable({ tools: ["read_shared_facts", "metric_query", "generate_chart_html", "generate_document", "write_file"] })).toBe(false);
  });

  it("treats web/browser specialists and coordinators as research-capable", () => {
    expect(agentCfgIsResearchCapable({ tools: ["web_search", "web_fetch", "url_inspect"] })).toBe(true); // researcher
    expect(agentCfgIsResearchCapable({ tools: ["web_search", "browser_navigate", "browser_snapshot"] })).toBe(true); // browser_agent
    expect(agentCfgIsResearchCapable({ tools: ["delegate_to_agent", "parallel_delegate", "run_task_graph"] })).toBe(true); // coordinator
  });

  it("does NOT treat a url_inspect-only agent (evidence_analyst shape) as research-capable", () => {
    // url_inspect probes a known URL but cannot search or fetch page content, so an
    // agent with no web_search/web_fetch/browser_* cannot do PRIMARY research. It was
    // being handed gather tasks and dead-looping url_inspect (audit 687a224b).
    expect(isWebGatheringToolName("url_inspect")).toBe(false);
    expect(isWebGatheringToolName("web_fetch")).toBe(true);
    expect(agentCfgIsResearchCapable({
      tools: ["read_shared_facts", "read_file", "list_files", "extract_file_content", "url_inspect", "share_finding", "write_file"],
    })).toBe(false);
  });

  it("does not block agents that inherit all tools, or unknown/ephemeral agents", () => {
    expect(agentCfgIsResearchCapable({})).toBe(true); // tools undefined → inherits all
    expect(agentCfgIsResearchCapable(undefined)).toBe(true); // unknown/ephemeral
  });

  it("flags source-sensitive / search-online tasks as research-requiring", () => {
    expect(taskRequiresExternalResearch("SOURCE-SENSITIVE DELEGATION:\nThe user's original request ...")).toBe(true);
    expect(taskRequiresExternalResearch("search online and validate your answer")).toBe(true);
    expect(taskRequiresExternalResearch("Find the latest datasheet on Mouser with pricing")).toBe(true);
  });

  it("leaves ordinary generation tasks alone (gate inactive)", () => {
    expect(taskRequiresExternalResearch("Generate a chart from the numbers I gave you")).toBe(false);
    expect(taskRequiresExternalResearch("Draw a logo for the project")).toBe(false);
  });

  it("flags general web-research tasks that lack the SOURCE-SENSITIVE marker (audit 3ef67aef)", () => {
    // The exact shape that was fabricated by a web-incapable agent: a research/search
    // verb + external web nouns (URL, price, platforms, providers). De-lex: the gate is
    // English-internal — a non-English delegation task is boundary-translated first, so
    // these are the English (translated) equivalents of the original German 3ef67aef case.
    expect(taskRequiresExternalResearch(
      "Research the best available learning sources and platforms for the iSAQB CPSA-F exam. Search for providers. For each source give: name, URL, price.",
    )).toBe(true);
    expect(taskRequiresExternalResearch("find the best online courses with pricing")).toBe(true);
    expect(taskRequiresExternalResearch("search for providers and compare the prices online")).toBe(true);
  });

  it("does NOT misroute internal code/workspace lookups to the web researcher", () => {
    // verb + an external-ish noun, but a workspace/code marker vetoes the web gate.
    expect(taskRequiresExternalResearch("search the codebase for the API url in this function")).toBe(false);
    expect(taskRequiresExternalResearch("find every file that imports the website module")).toBe(false);
    // verb but no external web noun → stays inactive.
    expect(taskRequiresExternalResearch("research how the dependency injection works here")).toBe(false);
  });
});

/**
 * Capability-aware routing/bidding gate (audit 14661623: a no-web generator out-bid
 * the web specialist). When a task UNAMBIGUOUSLY needs an execution tool class and both
 * capable and incapable agents were routed/bid, the gate keeps the capable ones — but it
 * never dead-ends, and always passes coordinators + tool-inheritors. Detectors are
 * high-precision so a false positive cannot drop a correct non-execution specialist.
 */
describe("execution capability gate", () => {
  const tools: Record<string, { tools?: string[] }> = {
    shell_agent: { tools: ["shell_exec", "ssh_exec", "read_file"] },
    coder: { tools: ["mcp__code_sandbox__run_ts", "mcp__code_sandbox__run_js", "read_file"] },
    browser_agent: { tools: ["web_search", "browser_navigate", "browser_click", "site_fill_credentials"] },
    researcher: { tools: ["web_search", "web_fetch", "url_inspect"] },
    content_writer: { tools: ["generate_presentation", "generate_document", "write_file"] },
    mission_coordinator: { tools: ["delegate_to_agent", "parallel_delegate", "run_task_graph"] },
    inheritor: {}, // no tools list → inherits all
  };
  const lookup = (name: string) => tools[name];

  it("detects execution classes only on high-precision signals", () => {
    expect(requiredExecutionCapabilities("ssh into the box and restart the service")).toContain("shell");
    expect(requiredExecutionCapabilities("run the command df -h on the server")).toContain("shell");
    expect(requiredExecutionCapabilities("run this TypeScript snippet and show the output")).toContain("code_exec");
    expect(requiredExecutionCapabilities("log in to the portal and submit the form")).toContain("browser_interaction");
    // False-positive guards — ambiguous verbs/nouns must NOT trip a class.
    expect(requiredExecutionCapabilities("build the website with a hero section")).toEqual([]);
    expect(requiredExecutionCapabilities("write a TypeScript function that parses dates")).toEqual([]);
    expect(requiredExecutionCapabilities("look up the spec on the official website")).toEqual([]);
    expect(requiredExecutionCapabilities("run a quick analysis of these numbers")).toEqual([]);
  });

  it("keeps the shell-capable agent over an incapable peer", () => {
    const { kept, dropped } = filterCandidatesByExecutionCapability(
      ["content_writer", "shell_agent"], "ssh into the host and check disk with df -h", lookup,
    );
    expect(kept).toEqual(["shell_agent"]);
    expect(dropped).toContain("content_writer");
  });

  it("routes a sandbox-run task to the code-capable agent", () => {
    const { kept } = filterCandidatesByExecutionCapability(
      ["content_writer", "coder"], "run this JavaScript snippet in a sandbox", lookup,
    );
    expect(kept).toEqual(["coder"]);
  });

  it("routes an interactive-site task to the browser-capable agent", () => {
    const { kept } = filterCandidatesByExecutionCapability(
      ["researcher", "browser_agent"], "log in to the supplier portal and place the order", lookup,
    );
    expect(kept).toEqual(["browser_agent"]);
  });

  it("never dead-ends: with no capable candidate it keeps the originals", () => {
    const { kept, dropped } = filterCandidatesByExecutionCapability(
      ["content_writer", "researcher"], "ssh into the box and restart the service", lookup,
    );
    expect(kept).toEqual(["content_writer", "researcher"]);
    expect(dropped).toEqual([]);
  });

  it("always passes coordinators (they can delegate) and tool-inheritors", () => {
    const coord = filterCandidatesByExecutionCapability(
      ["mission_coordinator", "content_writer"], "ssh into the host and tail the log", lookup,
    );
    expect(coord.kept).toContain("mission_coordinator");
    const inh = filterCandidatesByExecutionCapability(
      ["inheritor", "content_writer"], "ssh into the host and tail the log", lookup,
    );
    expect(inh.kept).toContain("inheritor");
  });

  it("does not filter a non-execution task or a single candidate", () => {
    expect(filterCandidatesByExecutionCapability(["content_writer", "researcher"], "write a blog post about dogs", lookup).kept)
      .toEqual(["content_writer", "researcher"]);
    expect(filterCandidatesByExecutionCapability(["content_writer"], "ssh into the box", lookup).kept)
      .toEqual(["content_writer"]);
  });
});
