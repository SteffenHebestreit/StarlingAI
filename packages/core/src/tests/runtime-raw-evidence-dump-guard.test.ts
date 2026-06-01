import { describe, expect, it } from "vitest";
import { looksLikeRawToolEvidenceDump, looksLikeArtifactCreationRequest, looksLikeInlinedArtifactFabrication } from "../agent/runtime.js";

/**
 * Last-resort terminal guard (audit 003f5aeb). When the "create a verified reveal.js
 * presentation about Dresden" turn researched successfully but the artifact-build step
 * timed out, the failure-path evidence backstop shipped the raw web_fetch dump verbatim:
 * a search-results block stitched to the Dresden_Castle Wikipedia nav menu ("Jump to
 * content Main menu move to sidebar … Create account Log in"). looksLikeRawToolEvidenceDump
 * flags that shape so the runtime swaps it for the curated, sourced findings under an
 * honest could-not-finish message instead of dumping scraped chrome on the user.
 * Structural detection only — topic- and site-agnostic.
 */
describe("terminal junk guard — looksLikeRawToolEvidenceDump", () => {
  const navDump =
    "Web Search Results for: \"Dresden Zwinger architecture\" (via searxng) "
    + "Dresden Castle: the lavish palace of the Saxon royals - Barcelo https://www.barcelo.com/guia-turismo/dresden-castle "
    + "Content from: https://en.wikipedia.org/wiki/Dresden_Castle Dresden Castle - Wikipedia "
    + "Jump to content Main menu Main menu move to sidebar hide Navigation Main page Contents "
    + "Current events Random article About Wikipedia Contact us Search Search Appearance Donate "
    + "Create account Log in Personal tools Donate Create account Log in Contents move to sidebar hide";

  it("flags a raw search-results + scraped-chrome dump", () => {
    expect(looksLikeRawToolEvidenceDump(navDump)).toBe(true);
  });

  it("flags a recovered-evidence scaffolding dump", () => {
    const recovered =
      "Recovered evidence snippets (partial progress before interruption): "
      + "web_fetch: Content from: https://example.com/spec Skip to content Main menu move to sidebar "
      + "Home Products Support About Contact Cookie settings Privacy policy Newsletter subscribe Log in";
    expect(looksLikeRawToolEvidenceDump(recovered)).toBe(true);
  });

  it("does NOT flag a genuine synthesized answer that cites one URL", () => {
    const real =
      "Der Dresdner Zwinger ist ein barockes Bauensemble, erbaut zwischen 1709 und 1728 nach Plänen von "
      + "Matthäus Daniel Pöppelmann. Er gilt als bedeutendes Werk des Spätbarock. Eine ausführliche Darstellung "
      + "findet sich unter https://en.wikipedia.org/wiki/Zwinger mit weiteren Belegen zur Baugeschichte.";
    expect(looksLikeRawToolEvidenceDump(real)).toBe(false);
  });

  it("does NOT flag a short message that happens to mention one marker", () => {
    expect(looksLikeRawToolEvidenceDump("I couldn't log in to the portal — please check the credentials.")).toBe(false);
  });

  it("flags an answer that LEADS with a raw tool-result header even with one marker (audit 33df2aec)", () => {
    // The search-results partial led with the tool header + generic site chrome
    // ("MENU Home Travel Style All Tours") that the specific chrome phrases don't match,
    // so the >=2 rule missed it. A leading header alone is enough — answers never start so.
    const leadingSearchDump =
      "Web Search Results for: \"Katholische Hofkirche Dresden architect\" (via duckduckgo) "
      + "Katholische Hofkirche History https://travelsetu.com/guide/... The foundation stone was laid in 1738. "
      + "Tours of Distinction 1-800-426-4324 MENU Home Travel Style All Tours Land Tours Overnight Tours Blog Group Leaders";
    expect(looksLikeRawToolEvidenceDump(leadingSearchDump)).toBe(true);
  });

  it("does NOT flag a synthesized answer that references a marker phrase mid-sentence", () => {
    // Only one marker AND not leading → a real written answer, not a dump.
    const real =
      "Ich habe die Recherche abgeschlossen. Aus den durchgesehenen Web Search Results for the Zwinger ergibt "
      + "sich folgendes Gesamtbild: der Zwinger ist ein barockes Bauensemble, erbaut zwischen 1709 und 1728, und gilt "
      + "als Hauptwerk des sächsischen Barock — eine zusammenhängende Darstellung ohne weitere Rohausgabe.";
    expect(looksLikeRawToolEvidenceDump(real)).toBe(false);
  });
});

// Auto-build-after-research (audit 33df2aec): a source-sensitive turn whose request asks
// to CREATE an artifact but where research consumed the whole turn should auto-build the
// deliverable from the gathered facts. looksLikeArtifactCreationRequest is the verb+noun
// gate that decides whether the turn is an artifact request at all.
describe("looksLikeArtifactCreationRequest — verb + artifact noun", () => {
  it("flags concrete artifact-creation requests (EN + DE)", () => {
    for (const m of [
      "Erstelle mir eine Präsentation über die Architektur von Dresden; nutze reveal.js",
      "create a reveal.js HTML presentation about the Zwinger",
      "build me a multi-page website for the launch",
      "schreibe einen ausführlichen Bericht über die Quartalszahlen",
      "generate a PDF report from the verified data",
      "baue eine Landingpage mit Quellenangaben",
    ]) {
      expect(looksLikeArtifactCreationRequest(m)).toBe(true);
    }
  });

  it("does NOT flag pure research / question requests (no artifact to build)", () => {
    for (const m of [
      "research the architecture of Dresden and confirm the construction dates",
      "was ist der Zwinger und wann wurde er gebaut?",
      "vergleiche die Baustile von Semperoper und Frauenkirche",
      "summarize the latest CVEs for nginx",
    ]) {
      expect(looksLikeArtifactCreationRequest(m)).toBe(false);
    }
  });
});

// Fabricated-inline-artifact guard (audit 453a263e): after the operator stopped a
// source-sensitive deck turn mid-research, the auto-build was blocked and synthesis pasted
// a full reveal.js HTML deck inline (fabricated, falsely "verified", no workspace file).
describe("looksLikeInlinedArtifactFabrication — inlined full deliverable", () => {
  it("flags a full HTML document inlined in a fenced block", () => {
    const deck =
      "## Präsentation: Architektur von Dresden\n\nHier ist der vollständige HTML-Code:\n\n```html\n"
      + "<!DOCTYPE html>\n<html lang=\"de\">\n<head><title>Zwinger</title></head>\n<body>\n"
      + "<div class=\"reveal\"><div class=\"slides\">" + "<section><h1>Slide</h1></section>".repeat(40)
      + "</div></div>\n</body>\n</html>\n```\n";
    expect(looksLikeInlinedArtifactFabrication(deck)).toBe(true);
  });

  it("flags a bare full HTML document (no fence)", () => {
    const doc = "<!DOCTYPE html>\n<html>\n<body>\n" + "<section>content</section>\n".repeat(80) + "</body>\n</html>";
    expect(looksLikeInlinedArtifactFabrication(doc)).toBe(true);
  });

  it("does NOT flag the honest curated-facts fallback or a short reply", () => {
    expect(looksLikeInlinedArtifactFabrication(
      "Ich konnte die Datei nicht fertigstellen. Belegte Fakten:\n- Der Zwinger wurde ab 1709 erbaut (Quelle: britannica.com).\n- Architekt: Pöppelmann.",
    )).toBe(false);
    expect(looksLikeInlinedArtifactFabrication("Die Datei wurde erstellt: dresden/index.html.")).toBe(false);
    // A small inline code snippet (e.g. a config line) is not a fabricated full artifact.
    expect(looksLikeInlinedArtifactFabrication("Run this:\n\n```bash\nnpm run build\n```")).toBe(false);
  });
});
