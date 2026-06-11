import { describe, expect, it } from "vitest";
import {
  looksLikeRegurgitatedPriorAnswer,
  looksLikeArtifactMutationRequest,
  claimsArtifactWrittenButUnproduced,
  looksLikeFabricatedToolDeliveryLink,
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
