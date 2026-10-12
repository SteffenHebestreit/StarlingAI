import { readFileSync } from "node:fs";
import { join } from "node:path";
import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import { getTool } from "../tools/registry.js";
import "../tools/document-output.js";
import { loadWorkspaceAgents, WORKSPACE_AGENTS_DIR } from "./support/workspace-shards.js";

/**
 * THE ORCHESTRATOR'S ROUTING MAP SENDS EACH ONE-SHOT ASSEMBLER'S DELIVERABLE TO THE AGENT THAT HOLDS IT.
 *
 * The "ATOMIC & SINGLE-DOMAIN ROUTING" bullets in agents.mainAssistant.customInstructions are read on
 * every orchestrator turn and say "route these directly". They sent HTML to content_writer and had no
 * chart entry, so a bar chart of numbers given in the message, asked for "als HTML-Datei", could go to
 * content_writer, which does not hold generate_chart_html and hand-wrote a 9.5 KB page (E2E
 * core-build-artifact-html-chart). This file reads the shipped shard as the loader does and pins:
 *  - one bullet routes a chart of numbers in hand to chart_designer and names generate_chart_html;
 *  - every generate_* tool a bullet names is held by an agent that bullet routes to;
 *  - the content_writer bullet for sites and decks is still there.
 * And chart_designer, the agent the chart bullet names, lists in its description and its prompt exactly
 * the chart types generate_chart_html draws: they promised area, scatter and combo charts, which the
 * tool's chart_type enum does not have.
 */

const PLATFORM_SHARD = join(WORKSPACE_AGENTS_DIR, "00-platform.jsonc");

/** The routing bullets, as the model reads them: the lines that start with "- " in that section. */
function routingBullets(): string[] {
  const shard = JSON5.parse(readFileSync(PLATFORM_SHARD, "utf8")) as { agents?: { mainAssistant?: { customInstructions?: string } } };
  const text = shard.agents?.mainAssistant?.customInstructions ?? "";
  const start = text.indexOf("ATOMIC & SINGLE-DOMAIN ROUTING");
  const end = text.indexOf("\nRoute these directly", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end).split("\n").filter((line) => line.startsWith("- "));
}

type AgentEntry = { tools?: string[]; description?: string; systemPrompt?: string };
const agents = loadWorkspaceAgents<AgentEntry>();

/** The configured agents a bullet routes to: each name that follows an arrow. */
function routedAgents(bullet: string): string[] {
  return [...bullet.matchAll(/→\s*([a-z][a-z0-9_]*)/g)].map((m) => m[1]!).filter((name) => name in agents);
}

const namedGenerators = (bullet: string): string[] => [...new Set(bullet.match(/\bgenerate_[a-z0-9_]+\b/g) ?? [])];

describe("the shipped orchestrator routing map", () => {
  it("routes a chart of numbers in hand to chart_designer, in one bullet that names generate_chart_html", () => {
    const toChart = routingBullets().filter((bullet) => routedAgents(bullet).includes("chart_designer"));
    expect(toChart).toHaveLength(1);
    expect(namedGenerators(toChart[0]!)).toContain("generate_chart_html");
    expect(agents["chart_designer"]?.tools).toContain("generate_chart_html");
  });

  it("names a generate_* tool only beside an agent that holds it", () => {
    const bullets = routingBullets();
    let checked = 0;
    for (const bullet of bullets) {
      const targets = routedAgents(bullet);
      for (const tool of namedGenerators(bullet)) {
        checked += 1;
        const holders = targets.filter((name) => (agents[name]?.tools ?? []).includes(tool));
        expect(holders, `${tool} in: ${bullet.slice(0, 120)}`).not.toEqual([]);
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("still routes sites and decks to content_writer with its assemblers", () => {
    const toWriter = routingBullets().filter((bullet) => routedAgents(bullet)[0] === "content_writer");
    expect(toWriter).toHaveLength(1);
    expect(namedGenerators(toWriter[0]!)).toEqual(expect.arrayContaining(["generate_website", "generate_presentation"]));
  });
});

describe("chart_designer names the chart types generate_chart_html draws", () => {
  const chartTypes = ((getTool("generate_chart_html")?.parameters as { properties?: { chart_type?: { enum?: string[] } } })
    ?.properties?.chart_type?.enum ?? []);
  /** The types a sentence lists, e.g. "bar, line, pie, and doughnut" -> [bar, line, pie, doughnut]. */
  const listed = (sentence: string | undefined): string[] =>
    (sentence ?? "").split(/,\s*(?:and\s+)?|\s+and\s+/).map((part) => part.trim()).filter(Boolean);

  it("in its description and its prompt, exactly the tool's types", () => {
    expect(chartTypes.length).toBeGreaterThan(0);
    const chart = agents["chart_designer"]!;
    const inDescription = /HTML charts and tables: ([^.;]*?) charts\b/.exec(chart.description ?? "")?.[1];
    const inPrompt = /generate_chart_html: it draws ([^.;]*?) charts\b/.exec(chart.systemPrompt ?? "")?.[1];
    expect(listed(inDescription).sort()).toEqual([...chartTypes].sort());
    expect(listed(inPrompt).sort()).toEqual([...chartTypes].sort());
  });
});
