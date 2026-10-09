import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildModelVisibleToolResult,
  knowledgeBaseWorkerReportMaxChars,
  truncateForContext,
} from "../agent/tool-result-format.js";
import { AgentSession } from "../agent/session.js";
import { getConfig } from "../config/loader.js";
import { runWithEffortContext } from "../runtime/effort-context.js";

/**
 * A KNOWLEDGE-BASE WORKER'S REPORT IS A DELEGATED RESULT (2026-10-09).
 *
 * use_knowledge_base runs the knowledge base's single-use worker agent and returns its findings
 * behind the tool's own instruction to relay them as-is. The frame had no branch for the tool, so it
 * cut the result to the generic 600 characters with the newlines collapsed, and the collapsed
 * history cut it to 500. The instruction alone takes 238 of them for the E2E knowledge base: on the
 * deployed model a worker's two-fact answer of 368 to 554 characters lost its second fact in the
 * history in three runs of three.
 */

const KB_NAME = "E2E Nordlicht Doku (core-ix)";
const PAGE_URL = "http://www.nordlicht-werkzeuge.test/dokumentation.html";
/** use_knowledge_base's output: its instruction, then the worker's report (tools/knowledge-bases.ts). */
const toolOutput = (report: string): string =>
  `Worker result (grounded in "${KB_NAME}") — relay these findings to the user as-is; do NOT add, infer, or invent any finding the worker did not report, and do NOT claim files were written that the worker did not create:\n\n${report}`;

const CHARGE_FACT = "Der Akku-Pack NW-3104 (18 V) ist mit dem Schnellladegerät NW-LG 18 in 38 Minuten von 0 % auf 80 % geladen.";
const GREASE_ROW = "| Getriebefett | alle 150 Betriebsstunden prüfen |";
/** A note the worker adds on each section it read before the one it was asked about. */
const sectionNote = (n: number): string =>
  `- Abschnitt ${n}: geprüft, enthält keine Angabe zur gefragten Ladezeit oder zum Wartungsintervall; ${"Hinweise zu Inbetriebnahme und Zubehör. ".repeat(3)}`;
/**
 * A worker's report in the shape the deployed model writes one: where it looked, then the findings
 * with their source. The charge time sits past character 600 of the tool's output and the grease
 * interval past character 2,000, the history snippet a delegation gets.
 */
const REPORT = [
  `Grundlage: Kurzanleitung Akku-Schrauber NW-AS 18 (${PAGE_URL}).`,
  "",
  "Gelesene Abschnitte:",
  ...[1, 2, 3].map(sectionNote),
  "",
  "1. **Ladezeit:**",
  CHARGE_FACT,
  "",
  ...[4, 5, 6, 7, 8, 9, 10, 11].map(sectionNote),
  "",
  "2. **Wartung:**",
  "| Teil | Intervall |",
  "| --- | --- |",
  GREASE_ROW,
  "",
  `Fundstelle: ${PAGE_URL}`,
].join("\n");
const OUTPUT = toolOutput(REPORT);
const METADATA = { kbId: "core-ix-nw-doku", grantedTools: ["search_knowledge_base", "list_knowledge_bases"], rejectedTools: [], sourceUrls: [PAGE_URL] };
const CUT_LINE_AT_END = /\[Cut to fit the context budget: the remaining (\d+) characters of this result are not shown\.\]$/;

/**
 * What the turn loop makes of a worker that could not run: the tool fails with "The knowledge-base
 * worker could not run: " and whatever the worker emitted (tools/knowledge-bases.ts), with no
 * metadata, and the loop prefixes the error with "Error: " (agent/runtime.ts). Here the worker timed
 * out while its searches kept hitting a provider's error page, which its partial transcript repeats.
 */
const FAILED_TAIL = "Letzter Stand vor dem Abbruch: keine Antwort des Modells nach 600 s.";
const FAILED = `Error: The knowledge-base worker could not run: ${[
  "Partial progress before interruption:",
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
    `- search_knowledge_base (Versuch ${n}): HTTP 502 <html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center></body></html>`),
  FAILED_TAIL,
].join("\n")}`;

let savedMaxDelegatedResultChars: number;
beforeEach(() => {
  savedMaxDelegatedResultChars = getConfig().agents.performance.maxDelegatedResultChars;
  getConfig().agents.performance.maxDelegatedResultChars = 10_000;
});
afterEach(() => {
  getConfig().agents.performance.maxDelegatedResultChars = savedMaxDelegatedResultChars;
});

describe("the model-visible frame of a knowledge-base worker's report", () => {
  it("keeps a finding that sits past character 600, newlines and table rows intact", () => {
    // The fixture has the shape that lost the fact, or this proves nothing about the 600-character
    // cut: the fact lies past character 600 even with the whitespace collapsed.
    expect(OUTPUT.indexOf("38 Minuten")).toBeGreaterThan(600);
    expect(truncateForContext(OUTPUT, 600)).not.toContain("38 Minuten");
    expect(OUTPUT.length).toBeLessThan(10_000);

    const visible = buildModelVisibleToolResult("use_knowledge_base", OUTPUT, METADATA);
    expect(visible).toContain(CHARGE_FACT);
    expect(visible).toContain(GREASE_ROW);
    // Within the budget the model reads exactly what the tool returned, its relay instruction first.
    expect(visible).toBe(OUTPUT);
  });

  it("holds a report over budget to it, keeping its head and saying how much is missing", () => {
    getConfig().agents.performance.maxDelegatedResultChars = 2_000;
    expect(OUTPUT.indexOf(GREASE_ROW)).toBeGreaterThan(2_000);

    const visible = buildModelVisibleToolResult("use_knowledge_base", OUTPUT, METADATA);
    expect(visible.length).toBeLessThanOrEqual(2_000);
    expect(visible.startsWith(`Worker result (grounded in "${KB_NAME}") — relay these findings`)).toBe(true);
    expect(visible).toContain(CHARGE_FACT);
    expect(visible).not.toContain(GREASE_ROW);
    const cut = CUT_LINE_AT_END.exec(visible);
    expect(cut, "no cut line at the end of the bounded report").not.toBeNull();
    const kept = visible.slice(0, cut!.index).trimEnd();
    expect(OUTPUT.startsWith(kept)).toBe(true);
    expect(Number(cut![1])).toBe(OUTPUT.length - kept.length);
  });

  it("keeps the turn loop's note after the cut line", () => {
    // A repeated call with the same arguments is served from the turn's cache with this note, and
    // the note exists to stop that repeat.
    getConfig().agents.performance.maxDelegatedResultChars = 2_000;
    const cachedNote = "\n\n[Note: This is a cached result — you already called 'use_knowledge_base' with identical arguments earlier in this turn. "
      + "Do NOT call it again. Use this result and move to a different step.]";
    const visible = buildModelVisibleToolResult("use_knowledge_base", `${OUTPUT}${cachedNote}`, METADATA, { runtimeNote: cachedNote });
    expect(visible.length).toBeLessThanOrEqual(2_000);
    expect(visible).toContain(CHARGE_FACT);
    expect(visible.endsWith(`characters of this result are not shown.]${cachedNote}`)).toBe(true);
  });

  it("takes the budget of a delegated result relayed verbatim, effort-scaled like delegate_to_agent's", () => {
    getConfig().agents.performance.maxDelegatedResultChars = 7_777;
    expect(knowledgeBaseWorkerReportMaxChars()).toBe(7_777);
    // The low effort tier relays at most 6,000 characters of a delegated result.
    const long = toolOutput(`${REPORT}\n\n${"Weitere Hinweise zur Wartung des Zubehörs. ".repeat(80)}SCHLUSS`);
    expect(long.length).toBeGreaterThan(6_000);
    expect(long.length).toBeLessThan(7_777);
    expect(buildModelVisibleToolResult("use_knowledge_base", long, METADATA)).toBe(long);
    const low = runWithEffortContext("low", () => buildModelVisibleToolResult("use_knowledge_base", long, METADATA));
    expect(low.length).toBeLessThanOrEqual(6_000);
    expect(low).not.toContain("SCHLUSS");
    expect(low).toMatch(CUT_LINE_AT_END);
  });

  it("does not draw on the turn's retrieval budget", () => {
    const shown = { chars: 0 };
    buildModelVisibleToolResult("use_knowledge_base", OUTPUT, METADATA, { retrievalShown: shown });
    expect(shown.chars).toBe(0);
  });

  it("keeps a worker that could not run on the 600-character fallback, byte for byte", () => {
    // Within a report's budget, so only telling a failure from a report keeps it at 600.
    expect(FAILED.length).toBeGreaterThan(600);
    expect(FAILED.length).toBeLessThan(knowledgeBaseWorkerReportMaxChars());
    expect(FAILED.indexOf(FAILED_TAIL)).toBeGreaterThan(600);

    const visible = buildModelVisibleToolResult("use_knowledge_base", FAILED, undefined);
    expect(visible).toBe(truncateForContext(FAILED, 600));
    expect(visible).not.toContain(FAILED_TAIL);
  });
});

describe("the collapsed history the turn's prompts are built from", () => {
  /** The turn loop stores the framed result with the tool's metadata (agent/turn-tool-execution.ts). */
  function sessionWithWorker(tool: string, output: string, metadata: Record<string, unknown> | undefined) {
    const session = new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "You are a test agent." });
    session.addMessage({ role: "user", content: "Wie lange lädt der Akku-Pack NW-3104 bis 80 %, und wann wird das Getriebefett geprüft?" });
    session.addMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_kbw", type: "function", function: { name: tool, arguments: JSON.stringify({ knowledge_base: "core-ix-nw-doku", task: "Ladezeit NW-3104 und Getriebefett-Intervall NW-AS 18" }) } }],
    } as never);
    session.addMessage({ role: "tool", tool_call_id: "call_kbw", content: buildModelVisibleToolResult(tool, output, metadata), metadata } as never);
    return session;
  }
  /** The generic 500-character snippet of the framed failure, marker and all. */
  const genericFailureSnippet = (): string => {
    const framed = buildModelVisibleToolResult("use_knowledge_base", FAILED, undefined);
    expect(framed.length).toBeGreaterThan(500);
    return `${framed.substring(0, 500)} [snippet summarized for prior-turn history; full result preserved in the original tool call above, ${framed.length} chars total]`;
  };
  const collapsedText = (session: AgentSession) => session.getCollapsedHistory().map((m) => String(m.content)).join("\n");

  it("keeps this turn's report whole, the finding past the delegation snippet's 2,000 characters included", () => {
    // Both main-loop iterations and the forced synthesis read this view, not the tool message.
    expect(OUTPUT.indexOf(GREASE_ROW)).toBeGreaterThan(2_000);
    const collapsed = collapsedText(sessionWithWorker("use_knowledge_base", OUTPUT, METADATA));
    expect(collapsed).toContain(CHARGE_FACT);
    expect(collapsed).toContain(GREASE_ROW);
    expect(collapsed).not.toContain("snippet summarized for prior-turn history");
  });

  it("holds it to the delegation snippet once the turn is over", () => {
    const session = sessionWithWorker("use_knowledge_base", OUTPUT, METADATA);
    session.addMessage({ role: "assistant", content: "38 Minuten; Getriebefett alle 150 Betriebsstunden." });
    session.addMessage({ role: "user", content: "Und die Vollladung?" });
    const collapsed = collapsedText(session);
    // The 2,000 a delegated result keeps, not the generic 500: the charge time sits between them.
    expect(OUTPUT.indexOf(CHARGE_FACT)).toBeGreaterThan(500);
    expect(OUTPUT.indexOf(CHARGE_FACT) + CHARGE_FACT.length).toBeLessThan(2_000);
    expect(collapsed).toContain(CHARGE_FACT);
    expect(collapsed).not.toContain(GREASE_ROW);
    expect(collapsed).toContain(`snippet summarized for prior-turn history; full result preserved in the original tool call above, ${OUTPUT.length} chars total`);
  });

  it("leaves another tool's result of this turn at the generic snippet", () => {
    const collapsed = collapsedText(sessionWithWorker("web_fetch", OUTPUT, METADATA));
    expect(collapsed).not.toContain("38 Minuten");
    expect(collapsed).toContain("snippet summarized for prior-turn history");
  });

  it("keeps a worker that could not run at the generic snippet on the turn that made the call", () => {
    const collapsed = collapsedText(sessionWithWorker("use_knowledge_base", FAILED, undefined));
    expect(collapsed).toContain(genericFailureSnippet());
  });

  it("and on the turns after it, where a report gets the delegation snippet", () => {
    const session = sessionWithWorker("use_knowledge_base", FAILED, undefined);
    session.addMessage({ role: "assistant", content: "Die Wissensdatenbank war nicht erreichbar." });
    session.addMessage({ role: "user", content: "Versuch es noch einmal." });
    expect(collapsedText(session)).toContain(genericFailureSnippet());
  });
});
