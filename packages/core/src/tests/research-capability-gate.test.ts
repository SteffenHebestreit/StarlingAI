import { describe, expect, it } from "vitest";
import {
  isWebReachingToolName,
  agentCfgIsResearchCapable,
  taskRequiresExternalResearch,
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
});
