import { describe, expect, it } from "vitest";
import { looksLikeRegurgitatedPriorAnswer } from "../agent/runtime.js";
import type { SessionHistoryMessage } from "../agent/session.js";

/**
 * Blocked-turn honesty guard (audit 43b3ec65 turn 3). After "update the
 * presentation and add the sources", every tool call was blocked
 * (skill_manage misused as a file tool) and the forced synthesis shipped a
 * verbatim copy of the turn-1 "presentation created" summary — a stale false
 * success (no edit, no sources). looksLikeRegurgitatedPriorAnswer flags a final
 * answer that re-pastes an EARLIER assistant turn so the runtime can replace it
 * with an honest status. Topic-agnostic — structural duplication only.
 */
const msg = (role: SessionHistoryMessage["role"], content: string, toolCalls = false): SessionHistoryMessage => ({
  role,
  content,
  timestamp: new Date().toISOString(),
  ...(toolCalls ? { tool_calls: [{ id: "1", type: "function", function: { name: "x", arguments: "{}" } }] } : {}),
} as SessionHistoryMessage);

const TURN1 =
  "Die HTML-Präsentation wurde erfolgreich erstellt und ist unter dresden-zwinger-presentation/index.html verfügbar. "
  + "Zusammenfassung der Umsetzung: 10 Slides gemäß Vorgabe mit allen inhaltlichen Anforderungen, reveal.js CDN v4.6.1, Gold/Weiß/Creme Farbschema mit Barock-Theme.";

describe("blocked-turn honesty guard — looksLikeRegurgitatedPriorAnswer", () => {
  const history: SessionHistoryMessage[] = [
    msg("user", "Erstelle eine Präsentation über den Zwinger."),
    msg("assistant", TURN1),
    msg("user", "validiere deine aussagen gegen online-sources"),
    msg("assistant", "Validierung der Fakten: Die Kernfakten sind durch placesofgermany.de belegt; weitere Quellen konnten nicht vollständig extrahiert werden."),
    msg("user", "dann aktualisiere die präsentation und füge die quellen mit ein"),
  ];

  it("flags a final answer that re-pastes an EARLIER turn verbatim (not just the most recent)", () => {
    // The model parroted turn 1, which is two assistant turns back.
    expect(looksLikeRegurgitatedPriorAnswer(TURN1, history)).toBe(true);
  });

  it("tolerates whitespace reflow in the regurgitation (markdown re-wrap)", () => {
    const reflowed = TURN1.replace(/ /g, "\n   ");
    expect(looksLikeRegurgitatedPriorAnswer(reflowed, history)).toBe(true);
  });

  it("does NOT flag a genuinely distinct honest answer", () => {
    const honest =
      "Ich konnte die gewünschte Änderung in diesem Schritt nicht ausführen — die benötigte Aktion stand mir nicht direkt zur Verfügung. "
      + "Bestätige bitte, dann delegiere ich die Aktualisierung der Präsentation an den passenden Spezialisten.";
    expect(looksLikeRegurgitatedPriorAnswer(honest, history)).toBe(false);
  });

  it("ignores prior assistant messages that carried tool calls (narration, not a deliverable)", () => {
    const withToolCall: SessionHistoryMessage[] = [msg("assistant", TURN1, true)];
    expect(looksLikeRegurgitatedPriorAnswer(TURN1, withToolCall)).toBe(false);
  });

  it("does not flag short answers (no 180-char prefix to coincidentally share)", () => {
    expect(looksLikeRegurgitatedPriorAnswer("Erledigt.", history)).toBe(false);
  });
});
