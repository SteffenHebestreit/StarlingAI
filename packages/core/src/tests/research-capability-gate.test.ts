import { describe, expect, it } from "vitest";
import {
  isWebReachingToolName,
  isWebGatheringToolName,
  agentCfgIsResearchCapable,
  taskRequiresExternalResearch,
  taskRequiresWebMediaSourcing,
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
});

/**
 * Web-media SOURCING gate (audit f6e10341): "add images with verified URLs" was
 * routed to chart_designer — a generator with no web tools — which fabricated
 * plausible-but-dead Wikimedia URLs. Sourcing/verifying EXISTING web images is a
 * gather task and must be treated as research-requiring (→ image_sourcer), while
 * GENERATING new visuals stays with image_creator/chart_designer. Kept general:
 * keys on "obtain & verify existing web media", not on any one host/example.
 */
describe("web media sourcing gate", () => {
  it("flags tasks that FIND/SOURCE existing images (EN + DE)", () => {
    expect(taskRequiresWebMediaSourcing("find a free-license photo of the venue")).toBe(true);
    expect(taskRequiresWebMediaSourcing("source images for the four sections")).toBe(true);
    expect(taskRequiresWebMediaSourcing("search for a picture of the product")).toBe(true);
    expect(taskRequiresWebMediaSourcing("suche verifizierte Bild-URLs für die Folien")).toBe(true);
    expect(taskRequiresWebMediaSourcing("finde echte, lizenzfreie Fotos")).toBe(true);
  });

  it("flags tasks that VERIFY/embed images with real URLs (no sourcing verb needed)", () => {
    expect(taskRequiresWebMediaSourcing("add images with verified URLs to the deck")).toBe(true);
    expect(taskRequiresWebMediaSourcing("use real photos from Wikimedia Commons")).toBe(true);
    expect(taskRequiresWebMediaSourcing("check that the image URLs are reachable and load")).toBe(true);
    expect(taskRequiresWebMediaSourcing("get working public-domain photos online")).toBe(true);
  });

  it("does NOT flag pure image GENERATION tasks", () => {
    expect(taskRequiresWebMediaSourcing("create an image of a sunset over mountains")).toBe(false);
    expect(taskRequiresWebMediaSourcing("generate a hero image for the landing page")).toBe(false);
    expect(taskRequiresWebMediaSourcing("draw a picture of a robot")).toBe(false);
    expect(taskRequiresWebMediaSourcing("erzeuge ein Bild eines Sonnenuntergangs")).toBe(false);
    // "with images" alone (decorative, no sourcing verb / web qualifier) stays generative.
    expect(taskRequiresWebMediaSourcing("build a presentation with images and charts")).toBe(false);
  });

  it("does NOT flag local-media tasks (workspace/attached) without a web qualifier", () => {
    expect(taskRequiresWebMediaSourcing("find the images already in the workspace folder")).toBe(false);
    expect(taskRequiresWebMediaSourcing("describe the attached photos")).toBe(false);
    // …but a local mention WITH a web/verify qualifier still counts as web sourcing.
    expect(taskRequiresWebMediaSourcing("verify the image URLs and download them to the workspace")).toBe(true);
  });

  it("does NOT flag non-media tasks", () => {
    expect(taskRequiresWebMediaSourcing("find the latest revenue figures")).toBe(false);
    expect(taskRequiresWebMediaSourcing("search the web for the spec")).toBe(false);
  });

  it("makes the research gate fire for media-sourcing (so generators get redirected)", () => {
    expect(taskRequiresExternalResearch("find verified image URLs for the presentation")).toBe(true);
    expect(taskRequiresExternalResearch("add images with verified URLs to the deck")).toBe(true);
    // pure generation must NOT trip the research gate
    expect(taskRequiresExternalResearch("generate a hero image for the landing page")).toBe(false);
  });
});
