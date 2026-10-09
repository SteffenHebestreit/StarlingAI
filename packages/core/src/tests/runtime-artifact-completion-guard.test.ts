import { describe, expect, it } from "vitest";
import {
  claimsArtifactWrittenButUnproduced,
  looksLikeArtifactMutationRequest,
} from "../agent/runtime.js";

/**
 * False-completion honesty guard (audit 14661623 turn 2). The user asked to add
 * verified images to the existing deck; the run executed ONE image search, never
 * rebuilt the deck (delegationCount 1, zero build), yet the answer claimed "Die
 * Bilder wurden eingefügt … URLs überprüft". The runtime only ships that claim
 * when an artifact was actually produced this turn; these two structural detectors
 * gate the guard. Topic-agnostic + bilingual.
 */
describe("looksLikeArtifactMutationRequest", () => {
  it("matches an explicit create request (delegates to the create detector)", () => {
    expect(looksLikeArtifactMutationRequest(
      "Erstelle mir eine Präsentation über die Architektur von Dresden als HTML-Website mit reveal.js",
    )).toBe(true);
  });

  it("matches a MODIFY/insert request that the create detector misses", () => {
    // The real turn-2 message: verb 'füge … ein' + noun 'Präsentation'.
    expect(looksLikeArtifactMutationRequest(
      "dann suche jetzt noch bilder; verifiziere diese und füge sie in die präsentation ein\nDer rest der präsentation muss nicht geändert werden",
    )).toBe(true);
    expect(looksLikeArtifactMutationRequest("update the deck with the new figures")).toBe(true);
    expect(looksLikeArtifactMutationRequest("bitte aktualisiere die website mit den neuen Zahlen")).toBe(true);
  });

  it("does not match a report-only or chitchat turn", () => {
    expect(looksLikeArtifactMutationRequest("Was steht eigentlich auf Folie 3 der Präsentation?")).toBe(false);
    expect(looksLikeArtifactMutationRequest("how are you today?")).toBe(false);
    expect(looksLikeArtifactMutationRequest("erkläre mir den barocken Baustil")).toBe(false);
  });
});

// Found 2026-10-07 by the e2e guard scenarios: an ASCII \b never sits before a leading umlaut, and
// a "nicht" inside a file name read as the clause's negation.
describe("German edge cases of the false-completion guard", () => {
  it("treats requests that open with an umlaut verb as artifact changes", () => {
    expect(looksLikeArtifactMutationRequest("Ändere die Präsentation unter generated/deck.html")).toBe(true);
    expect(looksLikeArtifactMutationRequest("Überarbeite den Bericht als PDF")).toBe(true);
  });

  it("does not take a file name's 'nicht' for a negated claim", () => {
    expect(claimsArtifactWrittenButUnproduced("Ich habe generated/angebot-nicht-final.html aktualisiert.")).toBe(true);
    // A real negation still is one.
    expect(claimsArtifactWrittenButUnproduced("Ich habe generated/angebot.html nicht aktualisiert.")).toBe(false);
  });
});

describe("claimsArtifactWrittenButUnproduced", () => {
  it("flags the turn-2 false 'images inserted' claim", () => {
    const answer = [
      "Bilder gefunden und verifiziert",
      "Ich habe validierte Bild-URLs recherchiert und diese direkt in die Präsentation eingefügt.",
      "Die Bilder wurden in die entsprechenden Slides eingefügt.",
      "Alle URLs wurden auf Verfügbarkeit überprüft und sind aktuell funktionsfähig.",
    ].join("\n");
    expect(claimsArtifactWrittenButUnproduced(answer)).toBe(true);
  });

  it("flags an English 'I updated the presentation' claim", () => {
    expect(claimsArtifactWrittenButUnproduced(
      "Done — I updated the presentation and embedded the four images on the relevant slides.",
    )).toBe(true);
  });

  it("does NOT flag a negated, honest 'not modified' report (clause-scoped negation)", () => {
    expect(claimsArtifactWrittenButUnproduced(
      "Ich habe die Präsentation in diesem Schritt **nicht** geändert — ich habe nur Bild-URLs gesammelt.",
    )).toBe(false);
    expect(claimsArtifactWrittenButUnproduced(
      "I did not modify the deck this turn; I could not write the file. Here is what I gathered instead.",
    )).toBe(false);
  });

  it("does NOT flag a plain informational answer with no completion claim", () => {
    expect(claimsArtifactWrittenButUnproduced(
      "Der Zwinger wurde zwischen 1710 und 1728 von Pöppelmann errichtet; Permoser schuf die Skulpturen.",
    )).toBe(false);
    expect(claimsArtifactWrittenButUnproduced("")).toBe(false);
  });

  // Audit 1ac79471 turn 1: a ZERO-tool answer fabricated a delivered platform with
  // exactly these phrasings — "gebaut", "ist … verfügbar", and "Öffne die Datei
  // `<name>.html`" — and the old verb list missed all three.
  it("flags the 'gebaut' completion claim with a platform noun", () => {
    expect(claimsArtifactWrittenButUnproduced(
      "Ich habe eine **interaktive Lernplattform** für dich gebaut, die folgende Features hat.",
    )).toBe(true);
  });

  it("flags an availability claim ('ist jetzt verfügbar') without a completion verb", () => {
    expect(claimsArtifactWrittenButUnproduced(
      "Die Plattform ist jetzt als **interaktive HTML-Seite** verfügbar.",
    )).toBe(true);
    expect(claimsArtifactWrittenButUnproduced(
      "The app is now ready in your workspace.",
    )).toBe(true);
  });

  it("flags an 'open the named file' delivery instruction", () => {
    expect(claimsArtifactWrittenButUnproduced(
      "Öffne die Datei `cpsaf-learning-platform.html` in deinem Browser und leg los!",
    )).toBe(true);
  });

  it("does NOT flag an honest OFFER to build ('bin bereit, … zu erstellen')", () => {
    expect(claimsArtifactWrittenButUnproduced(
      "Ich bin bereit, die Datei zu erstellen — soll ich die Lernplattform jetzt bauen?",
    )).toBe(false);
    expect(claimsArtifactWrittenButUnproduced(
      "Soll ich die interaktive Lernplattform direkt als Web-App bauen?",
    )).toBe(false);
  });

  // Session 24826c33: a zero-tool answer to "Schau mal ob ich neue Emails habe" advised
  // opening the user's OWN mail program — and was suppressed as a fabricated delivery
  // ("öffne … browser" plus `\bapp\b` matching inside the hyphenated "E-Mail-App"),
  // then rerouted into a nonsensical corrective build. Advice imperatives pointing the
  // user at their own programs are not delivery claims; only a FILE object counts.
  describe("user-advice imperatives are not delivery claims (session 24826c33)", () => {
    it("does NOT flag 'öffne die E-Mail-App in deinem Browser' advice", () => {
      expect(claimsArtifactWrittenButUnproduced(
        "Ich habe keinen Zugriff auf dein E-Mail-Konto. Öffne die E-Mail-App in deinem Browser, um neue Nachrichten zu prüfen.",
      )).toBe(false);
    });
    it("does NOT flag 'open webmail in your browser' advice", () => {
      expect(claimsArtifactWrittenButUnproduced(
        "I cannot access your inbox. Open webmail in your browser to check for new messages.",
      )).toBe(false);
    });
    it("still flags 'open the file' delivery instructions anchored to a file object", () => {
      expect(claimsArtifactWrittenButUnproduced(
        "Öffne die Datei `lernplattform.html` in deinem Browser und leg los!",
      )).toBe(true);
      expect(claimsArtifactWrittenButUnproduced(
        "Open the file quiz.html in your browser to start.",
      )).toBe(true);
    });
  });

  // Verified 2026-10-05: a correct, tool-free answer to "PDF vs PDF/A?" said fonts are embedded
  // in the document — completion verb + artifact noun in one clause — and the zero-work guard
  // replaced it with the canned "nothing was built" denial. A claim needs claim GRAMMAR.
  describe("generic prose about embedding/creating is not a claim (2026-10-05)", () => {
    it("does NOT flag a present-tense explanation of how a format works", () => {
      for (const answer of [
        "Bei PDF/A werden alle Schriften in das Dokument eingebettet, damit es in Jahrzehnten noch identisch aussieht.",
        "In PDF/A, all fonts are embedded in the file, so it renders the same decades later.",
        "Ich empfehle PDF/A, weil dort alle Schriften eingebettet sind.",
        "PDF/A files are ready for long-term archiving.",
        "Open the file in Acrobat and check the font list.",
      ]) {
        expect(claimsArtifactWrittenButUnproduced(answer), answer).toBe(false);
      }
    });

    it("still flags each claim grammar", () => {
      for (const claim of [
        "Die Präsentation wurde erstellt und liegt im Workspace.",
        "The deck has been updated with the new figures.",
        "Die Präsentation ist jetzt aktualisiert.",
        "✅ Präsentation aktualisiert",
      ]) {
        expect(claimsArtifactWrittenButUnproduced(claim), claim).toBe(true);
      }
    });

    it("a pointer at a file that EXISTS is a reference, not a fabricated delivery", () => {
      const fileExists = (ref: string) => ref === "reports/q3.pdf";
      expect(claimsArtifactWrittenButUnproduced("Öffne reports/q3.pdf in deinem Browser.", { fileExists })).toBe(false);
      expect(claimsArtifactWrittenButUnproduced("Öffne reports/q4.pdf in deinem Browser.", { fileExists })).toBe(true);
      // A first-person completion claim stays false-by-construction: nothing was written THIS turn.
      expect(claimsArtifactWrittenButUnproduced("Ich habe reports/q3.pdf erstellt.", { fileExists })).toBe(true);
    });
  });

  // Adversarial review 2026-10-05 of the grammar fix above: an existing file excused real claims,
  // and several claim shapes were missed outright. Nothing was written this turn in any of these.
  describe("claims the grammar fix missed (review 2026-10-05)", () => {
    const exists = (ref: string) => ref === "output/deck.html" || ref === "report.pdf" || ref === "generated/deck.html";

    it("an existing file excuses only a PURE pointer, never completion grammar or a completion adjective", () => {
      for (const claim of [
        "Die Präsentation wurde unter output/deck.html aktualisiert.",
        "Die Präsentation wurde aktualisiert und liegt unter output/deck.html.",
        "The deck was saved as output/deck.html.",
        "Saved to report.pdf.",
        "Open output/deck.html to see the updated presentation.",
        "Updated: output/deck.html",
        "✅ Präsentation aktualisiert → output/deck.html",
        "You can find the updated deck at output/deck.html.",
        "Der Bericht steht jetzt als report.pdf bereit.",
      ]) {
        expect(claimsArtifactWrittenButUnproduced(claim, { fileExists: exists }), claim).toBe(true);
      }
      // Pure pointers at real files stay excused — also inside the conventional generated/ folder,
      // whose name is not the verb "generated".
      expect(claimsArtifactWrittenButUnproduced("Die Präsentation liegt jetzt unter generated/deck.html.", { fileExists: exists })).toBe(false);
      expect(claimsArtifactWrittenButUnproduced("Download it here: output/deck.html", { fileExists: exists })).toBe(false);
    });

    it("flags the shapes that were missed even when the file does not exist", () => {
      for (const claim of [
        "Here is the updated presentation: output/deck.html",
        "Hier ist die aktualisierte Präsentation: output/deck.html",
        "Your report is ready: report.pdf",
        "Die aktualisierte Präsentation findest du unter output/deck.html.",
        "You can find the updated deck at output/deck.html.",
        "Your report is ready at report.pdf",
        "Updated the deck with the new images.",
        "Added the images to the deck.",
        "Created report.pdf with the summary.",
        "Your deck is updated.",
        "Fertig – die Präsentation ist aktualisiert.",
        "Die Präsentation ist fertig.",
        "✅ Präsentation aktualisiert → output/deck.html",
        "Download it here: output/deck.html",
        "Ich habe die Präsentation aktualisiert, soll ich sie auch als PDF exportieren?",
      ]) {
        expect(claimsArtifactWrittenButUnproduced(claim), claim).toBe(true);
      }
    });

    it("advice, examples, the user's own files and adjective uses are not claims", () => {
      for (const prose of [
        "Save it as report.pdf and attach it to the mail.",
        "A good file name would be, for example, report-q3.pdf.",
        "Open your report.pdf and check page 3.",
        "Embedded fonts are required in PDF/A.",
        "PDF/A files are ready for long-term archiving.",
      ]) {
        expect(claimsArtifactWrittenButUnproduced(prose), prose).toBe(false);
      }
    });
  });
});

describe("answerReferencedFileExists — whole path segments (review 2026-10-05)", () => {
  it("a bare file name does not borrow the existence of a deeper recorded path", async () => {
    const { answerReferencedFileExists } = await import("../agent/turn-finalize-guards.js");
    const session = {
      getWorkspacePath: () => "/nonexistent-workspace-for-test",
      getHistory: () => [{ role: "tool", metadata: { outputPath: "apps/old/index.html" } }],
    };
    const exists = answerReferencedFileExists(session as never);
    expect(exists("index.html")).toBe(false);
    expect(exists("old/index.html")).toBe(true);
    expect(exists("apps/old/index.html")).toBe(true);
    expect(exists("pold/index.html")).toBe(false);
  });
});
