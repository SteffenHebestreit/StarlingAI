import { describe, expect, it } from "vitest";
import {
  looksLikeRegurgitatedPriorAnswer,
  looksLikeArtifactMutationRequest,
  claimsArtifactWrittenButUnproduced,
  looksLikeFabricatedToolDeliveryLink,
  findRecentDelegateEvidence,
} from "../agent/runtime.js";
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

  // audit f6e10341: the reship had only drifted by a leading "[content_writer]:"
  // delegate tag (and a "## Zusammenfassung" header), so the byte-exact 180-prefix
  // check missed it. Containment must still catch a verbatim copy that gained a prefix.
  it("flags a verbatim reship that only gained a leading delegate-tag prefix", () => {
    expect(looksLikeRegurgitatedPriorAnswer(`[content_writer]: ${TURN1}`, history)).toBe(true);
  });

  it("flags a near-verbatim reship with reordered clauses (high token overlap, drifted head)", () => {
    const reordered =
      "Zusammenfassung der Umsetzung: 10 Slides gemäß Vorgabe mit allen inhaltlichen Anforderungen, "
      + "reveal.js CDN v4.6.1, Gold/Weiß/Creme Farbschema mit Barock-Theme. "
      + "Die HTML-Präsentation wurde erfolgreich erstellt und ist unter dresden-zwinger-presentation/index.html verfügbar.";
    expect(looksLikeRegurgitatedPriorAnswer(reordered, history)).toBe(true);
  });

  it("does NOT flag a same-topic answer that is genuinely different work (low token overlap)", () => {
    const distinct =
      "Ich habe in diesem Schritt nur die Bild-URLs als JSON gesammelt; die Folien selbst wurden noch nicht "
      + "aktualisiert. Wenn du möchtest, baue ich die Präsentation jetzt mit den Bildern neu auf — sag kurz Bescheid.";
    expect(looksLikeRegurgitatedPriorAnswer(distinct, history)).toBe(false);
  });
});

/**
 * Failed-build turn must not replay a stale prior answer (audit 9a6a8c7f turn 3).
 * The website build timed out (no artifact), and synthesis shipped the turn-1
 * IM73A135V01 guide verbatim — wrong mic, not a website. The normal regurgitation
 * guard was skipped (the turn DID orchestrate), and the false-completion guard
 * needs a written-claim the stale guide didn't make. The fix OR's the regurgitation
 * branch into the false-completion guard for an artifact request that produced nothing.
 */
describe("stale-prior-answer replay on a failed build (audit 9a6a8c7f turn 3)", () => {
  const PRIOR_GUIDE =
    "Hier ist der vollständige technische Leitfaden für dein tragbares Audio-Aufnahmegerät. "
    + "1. Mikrofon-Auswahl: IM73A135V01, analoges XENSIV MEMS, SNR 73 dB(A), IP57. "
    + "2. Audio-ADC: TI PCM1808, 6-Kanal, 24-Bit, I2S. 3. Lade-IC: TI BQ25895. Kostenplan ca. 28,70 Euro pro Einheit.";
  const history: SessionHistoryMessage[] = [
    msg("user", "Baue ein portables Aufnahmegerät mit IM73A135V01."),
    msg("assistant", PRIOR_GUIDE),
    msg("user", "Wir nehmen IM69D120V01XTSA1 als mic. Überarbeite den Plan."),
  ];

  it("classifies the website request as an artifact request (guard precondition)", () => {
    expect(looksLikeArtifactMutationRequest("Kannst du mir jetzt ein Tutorial als Website erstellen?")).toBe(true);
  });

  it("catches the stale replay via the regurgitation branch even with no false write-claim", () => {
    // The guard fires on (claim OR replay); the stale guide is a replay, not a claim.
    expect(looksLikeRegurgitatedPriorAnswer(PRIOR_GUIDE, history)).toBe(true);
  });

  it("releases an honest 'not built this turn' reply (neither a claim nor a replay)", () => {
    const honest =
      "Ich habe die Website in diesem Schritt nicht erstellt — der Build lief in die Zeitüberschreitung. "
      + "Bestätige kurz, dann lasse ich den Inhalts-Spezialisten die Seite jetzt mit generate_website bauen.";
    expect(claimsArtifactWrittenButUnproduced(honest)).toBe(false);
    expect(looksLikeRegurgitatedPriorAnswer(honest, history)).toBe(false);
  });

  // audit 52c23af8 turn 2: the inlined-tutorial answer led with this exact claim while
  // no file was produced. Locks the trigger for the last-line-of-defense honest banner.
  it("flags the inlined-website completion claim that shipped in the re-test", () => {
    expect(claimsArtifactWrittenButUnproduced(
      "## Tutorial-Website für dein Mikrofon-Array-Aufnahmegerät\n\nIch habe die Website erstellt. Hier ist der vollständige Inhalt:\n\n# Bauanleitung",
    )).toBe(true);
  });

  // audit 45d5bae9: a ZERO-tool turn fabricated a whole learn-platform and handed over
  // a fake serve URL. The decisive signal is the tool-only link; the German "gebaut" +
  // "Lernplattform/Plattform/App" claim is the secondary one (both were lexicon gaps).
  describe("zero-work fabricated-delivery signals (audit 45d5bae9)", () => {
    it("flags a fabricated served-app / workspace link", () => {
      expect(looksLikeFabricatedToolDeliveryLink("Die Plattform: [öffnen](/api/app/3807)")).toBe(true);
      expect(looksLikeFabricatedToolDeliveryLink("download: /api/workspace/file?path=x.html")).toBe(true);
      expect(looksLikeFabricatedToolDeliveryLink("see [the deck](generated/presentation/index.html)")).toBe(true);
    });
    it("does not flag ordinary prose without a tool-minted link", () => {
      expect(looksLikeFabricatedToolDeliveryLink("Eine Lernplattform könnte Quizfragen und Fortschritt zeigen.")).toBe(false);
      expect(looksLikeFabricatedToolDeliveryLink("Read more at https://www.isaqb.org/news/")).toBe(false);
    });
  });
});

/**
 * Terminal-evidence scoping (audit 2f4f5fe6 / Fable-5 session c852de4a). The
 * forced terminal synthesis picks the richest recent delegate result as its
 * backstop via `length + items*200`. Without scopeToCurrentTurn the scan reaches
 * BACK across turns, so a prior turn's rich news digest outscores the current
 * turn's sparse result and is force-relayed verbatim as the answer to an
 * unrelated question. The terminal call now passes { scopeToCurrentTurn: true }.
 */
describe("findRecentDelegateEvidence — terminal scoping ignores prior-turn deliverables", () => {
  const TURN1_NEWS =
    "Delegated result from web_task_coordinator — TASK COMPLETED.\n"
    + "Observed evidence:\n"
    + "## Top-News des Tages — 17. Juni 2026\n"
    + "- Iran: Außenminister fordert Rückzug aus dem Libanon vor einem Friedensabkommen.\n"
    + "- Deutschland: Die Stasi-Unterlagen-Behörde wird nach knapp 30 Jahren geschlossen.\n"
    + "- Großbritannien: Ein Social-Media-Verbot für Personen unter 16 Jahren wird eingeführt.\n"
    + "- Sport: Lionel Messi erzielt einen Hattrick und egalisiert Kloses WM-Torrekord.\n"
    + "- Technologie: Neue EU-Regulierung für KI-Dienste angekündigt; Konsultation läuft.\n"
    + "| Quelle | Link |\n| LiveMint | livemint.com |\n| ABP Live | abplive.com |\n"
    + "| FAZ | faz.net |\n| Die Welt | welt.de |\n| Yahoo News | yahoo.com |\n| news.de | news.de |";

  const TURN2_FABLE =
    "Delegated result from researcher — PARTIAL PROGRESS.\n"
    + "Observed evidence:\n"
    + "Keine Quellen für \"Fable 5\" als LLM/KI-Modell gefunden — die Suche lieferte nur "
    + "Ergebnisse zum Videospiel Fable von Playground Games. Bitte den Suchbegriff präzisieren.";

  const history: SessionHistoryMessage[] = [
    msg("user", "kannst du mir die heutigen news zusammenstellen?"),
    msg("assistant", "", true),
    msg("tool", TURN1_NEWS),
    // current turn starts here
    msg("user", "fable 5 — als LLM gemeint, nicht das spiel"),
    msg("assistant", "", true),
    msg("tool", TURN2_FABLE),
  ];

  it("UNSCOPED: a richer prior-turn deliverable wins (the bug)", () => {
    const ev = findRecentDelegateEvidence(history);
    expect(ev?.evidence).toContain("Top-News");
    expect(ev?.evidence).not.toContain("Fable 5");
  });

  it("scopeToCurrentTurn: returns only THIS turn's evidence, never the stale digest (the fix)", () => {
    const ev = findRecentDelegateEvidence(history, { scopeToCurrentTurn: true });
    expect(ev?.evidence).toContain("Fable 5");
    expect(ev?.evidence).not.toContain("Top-News");
  });
});
