import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TOOL_RESULT_NOTICE_OPENER,
  buildModelVisibleToolResult,
  retrievalEvidenceMaxChars,
  truncateForContext,
} from "../agent/tool-result-format.js";
import { AgentSession } from "../agent/session.js";
import { getConfig } from "../config/loader.js";

/**
 * A RETRIEVAL RESULT IS THE EVIDENCE (E2E core-ix-kb-documentation-rag, 2026-10-09).
 *
 * search_knowledge_base found the right page four times. Its excerpt opens with the crawled page's
 * title, URL and navigation, so the charge time sat at character 1,109 of the 1,887-character
 * result. The frame had no branch for the tool and cut every result to the generic 600 characters,
 * newlines collapsed, so the session history held the navigation and "[Konta..." and the answer said
 * the excerpts did not contain the charge time. The same held for every retrieval tool.
 */

const KB_NAME = "E2E Nordlicht Doku (core-ix)";
const PAGE_URL = "http://www.nordlicht-werkzeuge.test/dokumentation.html";
// What the crawler keeps of a page's header: the site's navigation, one link per line.
const PAGE_CHROME = [
  "# Dokumentation NW-AS 18 | Nordlicht Werkzeuge",
  `Source: ${PAGE_URL}`,
  ...["Startseite", "Produkte", "Akku-Werkzeuge", "Ladegeräte", "Zubehör", "Ersatzteile", "Service",
    "Downloads", "Händlersuche", "Garantie", "Reparatur", "Schulungen", "Presse", "Karriere", "Lieferstatus", "Kontakt"]
    .map((label) => `- [${label}](/${label.toLowerCase().replace(/[^a-z]+/g, "-")}.html)`),
  "",
  "## Kurzanleitung Akku-Schrauber NW-AS 18",
  "Diese Anleitung beschreibt Inbetriebnahme, Laden und Wartung des Akku-Schraubers NW-AS 18 und des Zubehörs.",
].join("\n");
const CHARGE_FACT = "Der Akku-Pack NW-3104 (18 V) ist mit dem Schnellladegerät NW-LG 18 in 38 Minuten von 0 % auf 80 % geladen.";
const TABLE = ["| Teil | Intervall |", "| --- | --- |", "| Getriebefett | 150 Betriebsstunden |"].join("\n");

/** One excerpt in search_knowledge_base's own layout (tools/knowledge-bases.ts). */
const excerpt = (rank: number, text: string): string =>
  `[${rank}] Dokumentation NW-AS 18\n${PAGE_URL}\n(score ${(9.188 - rank / 10).toFixed(3)})\n${text}`;
const kbResult = (excerpts: string[]): string =>
  `Top ${excerpts.length} excerpt(s) from "${KB_NAME}":\n\n${excerpts.join("\n\n---\n\n")}`;

const KB_RESULT = kbResult([excerpt(1, `${PAGE_CHROME}\n\n${CHARGE_FACT}\n\n${TABLE}`)]);

let savedMaxContextChars: number;
beforeEach(() => {
  savedMaxContextChars = getConfig().retrieval.documentRag.maxContextChars;
  getConfig().retrieval.documentRag.maxContextChars = 6000;
});
afterEach(() => {
  getConfig().retrieval.documentRag.maxContextChars = savedMaxContextChars;
});

describe("the model-visible frame of a retrieval result", () => {
  it("keeps a search_knowledge_base passage that sits past character 600, newlines and table rows intact", () => {
    // The fixture has the incident's shape, or this proves nothing about the 600-character cut: the
    // fact lies past character 600 even with the whitespace collapsed.
    expect(KB_RESULT.indexOf("38 Minuten")).toBeGreaterThan(600);
    expect(truncateForContext(KB_RESULT, 600)).not.toContain("38 Minuten");

    const visible = buildModelVisibleToolResult("search_knowledge_base", KB_RESULT, { hits: 1, kbId: "core-ix-nw-doku", sourceUrls: [PAGE_URL] });
    expect(visible).toContain(CHARGE_FACT);
    expect(visible).toContain(TABLE);
    // Within the budget the model reads exactly what the tool returned.
    expect(visible).toBe(KB_RESULT);
  });

  it.each(["search_documents", "rag_search", "memory_search", "recall_context"])("keeps %s's passages the same way", (tool) => {
    expect(buildModelVisibleToolResult(tool, KB_RESULT, { hits: 1 })).toBe(KB_RESULT);
  });

  it("leaves every other tool on the 600-character fallback, byte for byte", () => {
    for (const tool of ["web_fetch", "list_documents", "list_knowledge_bases", "use_knowledge_base", "search_sessions", "memory_store"]) {
      const visible = buildModelVisibleToolResult(tool, KB_RESULT, { hits: 1 });
      expect(visible, tool).toBe(truncateForContext(KB_RESULT, 600));
      expect(visible, tool).not.toContain("38 Minuten");
    }
  });

  it("holds a long result to the retrieval budget, keeping the best-ranked excerpts and saying how much is missing", () => {
    getConfig().retrieval.documentRag.maxContextChars = 2_000;
    const filler = (n: number) => `Abschnitt ${n}: ${"Wartungshinweis ".repeat(40)}`;
    const long = kbResult([excerpt(1, CHARGE_FACT), excerpt(2, filler(2)), excerpt(3, filler(3)), excerpt(4, `${filler(4)} LETZTER-AUSZUG`)]);
    expect(long.length).toBeGreaterThan(2_000);

    const visible = buildModelVisibleToolResult("search_knowledge_base", long, { hits: 4 });
    expect(visible.length).toBeLessThanOrEqual(2_000);
    expect(visible).toContain(CHARGE_FACT);
    expect(visible).not.toContain("LETZTER-AUSZUG");
    // The line names exactly what was left out, so the model knows the result is incomplete.
    const cut = /\[Cut to fit the context budget: the remaining (\d+) characters of this result are not shown\.\]$/.exec(visible);
    expect(cut, "no cut line at the end of the bounded result").not.toBeNull();
    const kept = visible.slice(0, cut!.index).trimEnd();
    expect(long.startsWith(kept)).toBe(true);
    expect(Number(cut![1])).toBe(long.length - kept.length);
  });

  it("keeps the turn loop's notice when it cuts a long result", () => {
    getConfig().retrieval.documentRag.maxContextChars = 2_000;
    const notice = `${TOOL_RESULT_NOTICE_OPENER}search_knowledge_base has returned identical output 3 times in a row. `
      + "You are stuck in a loop. Do NOT call this tool again. Summarise what you have found so far and report it to the user, or try a clearly different approach.]";
    const long = kbResult([excerpt(1, CHARGE_FACT), excerpt(2, "Wartungshinweis ".repeat(200))]) + notice;

    const visible = buildModelVisibleToolResult("search_knowledge_base", long, { hits: 2 });
    expect(visible.length).toBeLessThanOrEqual(2_000);
    expect(visible).toContain(CHARGE_FACT);
    expect(visible.endsWith(notice)).toBe(true);
    expect(visible).toMatch(/\[Cut to fit the context budget: the remaining \d+ characters of this result are not shown\.\]\n\n\[System notice: /);
  });

  it("takes its budget from retrieval.documentRag.maxContextChars, and the schema default when the config has none", () => {
    getConfig().retrieval.documentRag.maxContextChars = 4_321;
    expect(retrievalEvidenceMaxChars()).toBe(4_321);
    (getConfig().retrieval.documentRag as { maxContextChars?: number }).maxContextChars = undefined;
    expect(retrievalEvidenceMaxChars()).toBe(6_000);
  });
});

describe("the collapsed history the turn's prompts are built from", () => {
  function sessionWithSearch(tool: string, result: string) {
    const session = new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "You are a test agent." });
    session.addMessage({ role: "user", content: "Wie lange lädt der Akku-Pack NW-3104 bis 80 %?" });
    session.addMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_kb", type: "function", function: { name: tool, arguments: JSON.stringify({ knowledge_base: "core-ix-nw-doku", query: "NW-3104 Ladezeit" }) } }],
    } as never);
    session.addMessage({ role: "tool", tool_call_id: "call_kb", content: buildModelVisibleToolResult(tool, result, { hits: 1 }) } as never);
    return session;
  }
  const collapsedText = (session: AgentSession) => session.getCollapsedHistory().map((m) => String(m.content)).join("\n");

  it("keeps this turn's search_knowledge_base result whole, the passage past character 500 included", () => {
    // Both main-loop iterations and the forced synthesis read this view, not the tool message.
    const collapsed = collapsedText(sessionWithSearch("search_knowledge_base", KB_RESULT));
    expect(collapsed).toContain(CHARGE_FACT);
    expect(collapsed).toContain(TABLE);
    expect(collapsed).not.toContain("snippet summarized for prior-turn history");
  });

  it("holds it to the generic snippet once the turn is over", () => {
    const session = sessionWithSearch("search_knowledge_base", KB_RESULT);
    session.addMessage({ role: "assistant", content: "38 Minuten." });
    session.addMessage({ role: "user", content: "Und das Getriebefett?" });
    const collapsed = collapsedText(session);
    expect(collapsed).not.toContain(CHARGE_FACT);
    expect(collapsed).toContain("snippet summarized for prior-turn history");
  });

  it("leaves another tool's result of this turn at the generic snippet", () => {
    // web_fetch's frame is the 600-character fallback; the snippet then cuts it to 500.
    const collapsed = collapsedText(sessionWithSearch("web_fetch", KB_RESULT));
    expect(collapsed).not.toContain("38 Minuten");
    expect(collapsed).toContain("snippet summarized for prior-turn history");
  });
});
