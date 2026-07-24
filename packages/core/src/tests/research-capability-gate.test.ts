import { describe, expect, it } from "vitest";
import {
  isWebReachingToolName,
  isWebGatheringToolName,
  agentCfgIsResearchCapable,
  taskRequiresExternalResearch,
  requiredExecutionCapabilities,
  filterCandidatesByExecutionCapability,
  explicitAgentsCoverTaskExecution,
} from "../tools/sub-agent.js";
import { reorderByResearchCapability } from "../tools/agent-routing.js";
import type { AgentRoutingCandidate } from "../tools/agent-routing.js";

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

  it("flags product/model/tool SELECTION & comparison research (live session d4eca79c)", () => {
    // The exact repro that fabricated hardware specs with zero web_search: a research
    // verb + a product/model noun, no workspace marker. "models"/"benchmarks"/"gpu"/
    // "software"/"library" now count as external-web nouns.
    expect(taskRequiresExternalResearch("research the best open weights model for image creation on our hardware")).toBe(true);
    expect(taskRequiresExternalResearch("compare the top open-source image generation models and their benchmarks")).toBe(true);
    expect(taskRequiresExternalResearch("find the best GPU for local LLM inference")).toBe(true);
    expect(taskRequiresExternalResearch("recommend a good charting library")).toBe(true);
  });

  it("still leaves creation and internal tasks inactive after the noun broadening", () => {
    // "generate"/"draw"/"build" are not research verbs, so a creation task stays false
    // even when it mentions a model/image.
    expect(taskRequiresExternalResearch("generate the best possible image of a sunset")).toBe(false);
    expect(taskRequiresExternalResearch("build a data model for the app")).toBe(false);
    // research verb + product noun, but a workspace/code marker vetoes it.
    expect(taskRequiresExternalResearch("find the models module in our codebase")).toBe(false);
  });
});

/**
 * Topic-over-intent reorder (live session d4eca79c). A "research the best image MODEL"
 * query embeds near its SUBJECT, so image_creator (a pure generator, no web tools) topped
 * search_agents at 0.87 confidence and the orchestrator never reached the researcher.
 * reorderByResearchCapability puts research-capable candidates first for a research query
 * and flags when the whole ranking is research-incapable so the caller can surface the
 * researcher. Pure — tested here with an injected capability predicate.
 */
describe("research-capability reorder (topic-over-intent)", () => {
  const c = (name: string): AgentRoutingCandidate => ({ name } as AgentRoutingCandidate);
  const capable = new Set(["researcher", "browser_agent", "mission_coordinator"]);
  const isCapable = (name: string) => capable.has(name);

  it("demotes a generator below a research-capable peer for a research query", () => {
    const { results, needsFallback } = reorderByResearchCapability(
      [c("image_creator"), c("researcher"), c("chart_designer")], true, isCapable,
    );
    expect(results.map((r) => r.name)).toEqual(["researcher", "image_creator", "chart_designer"]);
    expect(needsFallback).toBe(false);
  });

  it("flags needsFallback when the whole ranking is research-incapable", () => {
    const { results, needsFallback } = reorderByResearchCapability(
      [c("image_creator"), c("image_sourcer"), c("prompt_optimizer")], true, isCapable,
    );
    expect(needsFallback).toBe(true);
    // Order preserved — the caller prepends the researcher fallback.
    expect(results.map((r) => r.name)).toEqual(["image_creator", "image_sourcer", "prompt_optimizer"]);
  });

  it("leaves a non-research query and an already-capable ranking untouched", () => {
    const set = [c("image_creator"), c("researcher")];
    expect(reorderByResearchCapability(set, false, isCapable).results).toBe(set); // non-research → unchanged reference
    const allCapable = reorderByResearchCapability([c("researcher"), c("browser_agent")], true, isCapable);
    expect(allCapable.needsFallback).toBe(false);
    expect(allCapable.results.map((r) => r.name)).toEqual(["researcher", "browser_agent"]);
  });

  it("never dead-ends on an empty set", () => {
    expect(reorderByResearchCapability([], true, isCapable)).toEqual({ results: [], needsFallback: false });
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

/**
 * Explicit-delegation execution guard (regression: session 8815a45e, 2026-07-02). An explicit
 * delegate_to_agent(computer_use_agent) for an interactive login was HIJACKED to `researcher` by
 * the research-capability redirect, because the German task text ("...auf der Website
 * freelancermap.de anmelden... sicheren Credential-Lookup...") tripped taskRequiresExternalResearch
 * — "Website" is an external web noun and "Lookup" matches the look\s*up verb. The tool-less
 * researcher then returned a first-person "I cannot do this with my tools" refusal that was relayed
 * verbatim to the user. The guard withholds the redirect when the explicitly-named agent genuinely
 * covers the task's execution capability, so a real login goes to the browser/computer specialist.
 */
describe("explicit-delegation execution guard (research-redirect false positive)", () => {
  const tools: Record<string, { tools?: string[] }> = {
    computer_use_agent: { tools: ["computer_list_nodes", "computer_type_credential", "get_site_credentials"] },
    browser_agent: { tools: ["browser_navigate", "site_fill_credentials", "get_site_credentials"] },
    researcher: { tools: ["web_search", "web_fetch", "url_inspect"] },
    content_writer: { tools: ["generate_presentation", "generate_document", "write_file"] },
  };
  const lookup = (name: string) => tools[name];
  // The exact failing shape: an interactive login whose wording trips the web-research classifier.
  const loginTask =
    "Melde dich auf der Website freelancermap.de mit einem vorhandenen Account an. Navigiere zur Login-Seite und nutze den sicheren Credential-Lookup, dann fülle die Login-Felder aus und sende das Formular ab.";

  it("confirms the false positive: the login task text trips taskRequiresExternalResearch", () => {
    expect(taskRequiresExternalResearch(loginTask)).toBe(true); // "Website" + "Lookup"
    expect(requiredExecutionCapabilities(loginTask)).toContain("browser_interaction"); // "Login"
  });

  it("covers the login for an explicit browser/computer specialist → redirect withheld", () => {
    expect(explicitAgentsCoverTaskExecution(["computer_use_agent"], loginTask, lookup)).toBe(true);
    expect(explicitAgentsCoverTaskExecution(["browser_agent"], loginTask, lookup)).toBe(true);
  });

  it("does NOT cover it for a research-only / writer agent (anti-fabrication redirect still fires)", () => {
    expect(explicitAgentsCoverTaskExecution(["researcher"], loginTask, lookup)).toBe(false);
    expect(explicitAgentsCoverTaskExecution(["content_writer"], loginTask, lookup)).toBe(false);
  });

  it("returns false when the task needs no execution capability, so it never widens the redirect", () => {
    expect(explicitAgentsCoverTaskExecution(["computer_use_agent"], "research the best providers online with pricing", lookup)).toBe(false);
    expect(explicitAgentsCoverTaskExecution([], loginTask, lookup)).toBe(false);
  });
});
