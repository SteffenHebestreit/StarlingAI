import { describe, expect, it } from "vitest";
import { agentCfgIsResearchCapable, isWebGatheringToolName, isWebReachingToolName } from "../tools/agent-routing.js";
import { shouldAcceptPartialDelegation } from "../tools/delegation-artifact-classification.js";
import { comparablePageUrl, readsLiveState, summarizeToolAuditMetadata, webTableCallAllowedAfterEvidenceStrip } from "../agent/sub-agent.js";
import { buildSubAgentToolInventory } from "../agent/sub-agent-prompt-guidance.js";

/**
 * Where the web_table name must be known (design section 5): it reaches the web, it does not
 * gather (it reads no page without a table), a research run that used it is a partial success
 * like one that used web_fetch, its audit metadata survives the summary, and after the evidence
 * strip it may compute over pages already read and nothing else.
 */
describe("web_table classification", () => {
  it("reaches the web but does not gather: an agent holding only web_table is not research-capable", () => {
    expect(isWebReachingToolName("web_table")).toBe(true);
    expect(isWebGatheringToolName("web_table")).toBe(false);
    expect(agentCfgIsResearchCapable({ tools: ["web_table", "share_finding"] })).toBe(false);
    expect(agentCfgIsResearchCapable({ tools: ["web_table", "web_fetch"] })).toBe(true);
  });

  it("accepts a partial research run that used web_table like one that used web_fetch", () => {
    const stats = (toolNames: string[]) => ({ toolCount: 2, toolNames, outcome: "partial" });
    expect(shouldAcceptPartialDelegation("researcher", "Wie viele Artikel kosten unter 50 €?", stats(["web_table", "share_finding"]))).toBe(true);
    expect(shouldAcceptPartialDelegation("researcher", "Wie viele Artikel kosten unter 50 €?", stats(["share_finding", "share_finding"]))).toBe(false);
  });

  it("keeps the webTable metadata in the tool audit and still drops unknown keys", () => {
    const webTable = { source: "url", urls: ["http://x.test/a"], aggregates: { "sum(4 Südtal)": "596" } };
    expect(summarizeToolAuditMetadata({ webTable, table: "t1", someOtherKey: 1 })).toEqual({ webTable });
    expect(summarizeToolAuditMetadata({ table: "t1" })).toBeUndefined();
  });

  it("after the evidence strip, allows a computation over pages already read and nothing else", () => {
    const read = new Set([comparablePageUrl("http://Shop.test:80/a.html"), comparablePageUrl("http://shop.test/b.html")]);
    // Extraction (no aggregates, where or group_by) fetches without computing: refused.
    expect(webTableCallAllowedAfterEvidenceStrip({ url: "http://shop.test/a.html" }, read)).toBe(false);
    // Computing over read pages, fragments and host case aside, and given as a JSON string: allowed.
    expect(webTableCallAllowedAfterEvidenceStrip({ url: "http://shop.test/a.html#t", aggregates: ["sum"], column: "Preis" }, read)).toBe(true);
    expect(webTableCallAllowedAfterEvidenceStrip({ url: "[\"http://shop.test/a.html\", \"http://shop.test/b.html\"]", where: "[{\"column\":\"Preis\",\"op\":\"<\",\"value\":50}]" }, read)).toBe(true);
    expect(webTableCallAllowedAfterEvidenceStrip({ url: "http://shop.test/a.html", group_by: "Kategorie" }, read)).toBe(true);
    // One page not read yet: refused, whole call.
    expect(webTableCallAllowedAfterEvidenceStrip({ url: ["http://shop.test/a.html", "http://shop.test/c.html"], aggregates: ["count"] }, read)).toBe(false);
    expect(webTableCallAllowedAfterEvidenceStrip({ aggregates: ["count"] }, read)).toBe(false);
    // The open tab is a page the agent opened itself.
    expect(webTableCallAllowedAfterEvidenceStrip({ source: "tab", aggregates: ["count"] }, read)).toBe(true);
  });

  it("treats a read of the browser tab as live state, a read of URLs as not", () => {
    expect(readsLiveState("web_table", { source: "tab" })).toBe(true);
    expect(readsLiveState("web_table", { url: "http://shop.test/a.html" })).toBe(false);
    expect(readsLiveState("browser_snapshot", {})).toBe(true);
    expect(readsLiveState("web_fetch", { url: "http://shop.test/a.html" })).toBe(false);
  });

  // pass^k-relevant: the one model-facing line besides the tool's own description.
  it("adds one inventory line in a run that holds web_table, and leaves every other inventory as it was", () => {
    const without = buildSubAgentToolInventory(["web_search", "web_fetch", "share_finding"]);
    expect(without).toBe([
      "TOOL INVENTORY",
      "You may use only these tools in this run: web_search, web_fetch, share_finding",
      "The runtime provides the real tool schemas separately. Use those exact tool definitions for names and parameters. Do not invent or paraphrase tool names.",
      "When the task depends on current, external, or source-sensitive facts, validate them with up-to-date web evidence whenever feasible instead of relying only on prior knowledge.",
    ].join("\n"));
    const line = "Take a total, count, minimum or maximum over a web table's rows from web_table instead of adding up or counting rows yourself; for a table spread over several pages, give it every page's URL.";
    const withTable = buildSubAgentToolInventory(["web_search", "web_fetch", "web_table", "share_finding"]);
    expect(withTable.split("\n").filter((entry) => entry === line)).toHaveLength(1);
    expect(withTable.replace(`\n${line}`, "")).toBe(without.replace("web_fetch, share_finding", "web_fetch, web_table, share_finding"));
    expect(buildSubAgentToolInventory(["browser_navigate", "web_table"])).toContain(line);
  });
});
