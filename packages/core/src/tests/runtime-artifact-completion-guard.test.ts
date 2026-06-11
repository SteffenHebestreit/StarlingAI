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
});
