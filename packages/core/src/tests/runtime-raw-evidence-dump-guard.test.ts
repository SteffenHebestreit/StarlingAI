import { describe, expect, it } from "vitest";
import {
  looksLikeRawToolEvidenceDump,
  looksLikeRawSharedFactsDump,
  looksLikeRawWorkspaceToolDump,
  looksLikeArtifactCreationRequest,
  looksLikeInlinedArtifactFabrication,
  looksLikeInlinedAppDocument,
} from "../agent/runtime.js";

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

  // audit 49372c7a: a hardware-BOM turn (synthesis_required_tool_call_rejected) shipped the
  // parallel_delegate evidence block verbatim as the final answer — it LED with a doubled
  // agent-label echo "[researcher]:\n[researcher]: Based on the curated findings …" and was
  // truncated mid-source. None of the prior markers matched, so the dump shipped.
  it("flags an answer that LEADS with an agent-label echo ([researcher]: …)", () => {
    const labelEcho =
      "[researcher]:\n[researcher]: Based on the curated findings, here is the technical blueprint for "
      + "your portable, high-quality audio recording device. 1. Microphone Selection & Array Configuration. "
      + "Recommendation: The Infineon IM73A135V01 is an excellent choice due to its ultra-flat profile and "
      + "ruggedness. Dimensions: 4mm x 3mm x 1.2mm (Source: https://www.infineon.com/dgdl/Infineon-IM73A135";
    expect(looksLikeRawToolEvidenceDump(labelEcho)).toBe(true);
  });

  it("flags a single bold agent-label echo (**[mission_coordinator]**: …)", () => {
    const boldEcho =
      "**[mission_coordinator]**: Based on the curated findings from official datasheets and technical "
      + "documentation, here is the concrete evidence regarding the components, interface specifications, and "
      + "architectural requirements for your portable, waterproof, OTA-synced audio device build. The mic is analog.";
    expect(looksLikeRawToolEvidenceDump(boldEcho)).toBe(true);
  });

  it("does NOT flag a synthesized answer that opens with a markdown list or heading", () => {
    // Real answers open with prose, a heading, or a bullet — never "[agent]:".
    const list =
      "- Der Infineon IM73A135V01 ist ein analoges differenzielles MEMS-Mikrofon (Quelle: infineon.com).\n"
      + "- Er benötigt einen externen ADC; für rein digitale MCUs ist ein PDM-zu-I²S-Wandler nötig.\n"
      + "- Versorgungsspannung: 3,3 V. Insgesamt ein robuster Baustein für tragbare Aufnahmegeräte mit hoher Qualität.";
    expect(looksLikeRawToolEvidenceDump(list)).toBe(false);
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

// looksLikeInlinedAppDocument is the never-legit-inline signal the revived inline-artifact
// fabrication guard (inlineArtifactFabricationGuard) fires on. Because that guard dropped the
// bilingual `wantsArtifact` keyword scope-gate, the answer-side signal MUST be precise on its
// own: a full HTML application document is never a legitimate inline answer, but a large
// non-HTML code fence CAN be ("show me the reference implementation"), so — unlike the broader
// looksLikeInlinedArtifactFabrication — this predicate must ignore big non-HTML fences.
describe("looksLikeInlinedAppDocument — full HTML app document only (no keyword gate)", () => {
  it("flags a full HTML document (fenced, bare, and truncated-mid-CSS)", () => {
    const fenced = "Hier ist die App:\n\n```html\n<!DOCTYPE html>\n<html><head><style>"
      + ".x{color:red}".repeat(200) + "</style></head><body><div id=\"app\"></div></body></html>\n```";
    expect(looksLikeInlinedAppDocument(fenced)).toBe(true);
    const bare = "<!DOCTYPE html>\n<html>\n<body>\n" + "<section>content</section>\n".repeat(80) + "</body>\n</html>";
    expect(looksLikeInlinedAppDocument(bare)).toBe(true);
    // Truncated by the completion cap (no closing </html>): the fenced-doctype clause still fires.
    const truncated = "```html\n<!DOCTYPE html>\n<html><head><style>" + ".y{margin:0}".repeat(200) + "</style></head><body>";
    expect(looksLikeInlinedAppDocument(truncated)).toBe(true);
  });

  it("does NOT flag a large non-HTML code fence (a legit reference-code answer)", () => {
    const bigJsFence = "Here's a reference implementation:\n\n```ts\n"
      + "export function score(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0);\n}\n".repeat(60)
      + "```";
    expect(bigJsFence.length).toBeGreaterThan(1500);
    expect(looksLikeInlinedAppDocument(bigJsFence)).toBe(false);
    // The broader sibling WOULD flag this big fence — which is exactly why the keyword-gate-free
    // guard uses the app-document predicate instead.
    expect(looksLikeInlinedArtifactFabrication(bigJsFence)).toBe(true);
  });

  it("does NOT flag the honest curated-facts fallback or a short reply", () => {
    expect(looksLikeInlinedAppDocument(
      "Ich konnte die Datei nicht bauen. Belegte Fakten:\n- Der Zwinger wurde ab 1709 erbaut (Quelle: britannica.com).",
    )).toBe(false);
    expect(looksLikeInlinedAppDocument("Öffne die Datei dresden/index.html im Browser.")).toBe(false);
  });
});

// Raw-dump evidence backstop (Fix 4 — audit bcb417e4). When a research turn runs out of
// time and forceSynthesis returns nothing useful, the "use evidence over synthesis" path
// will pick the terminalEvidenceBackstop as the final answer. The OLD code only guarded
// against the shared-facts shape (looksLikeRawSharedFactsDump), so a raw delegate-evidence
// blob (raw web search block, recovered page chrome, raw workspace/catalog read output)
// was shipped verbatim. The new code disables the backstop when ANY of three raw-dump
// detectors trips, letting the later `looksLikeRawToolEvidenceDump` guard replace the
// final candidate with the honest research-gathered fallback. This block tests the
// three detectors in combination, mirroring the `evidenceLooksRaw` expression.
describe("raw-dump evidence backstop (audit bcb417e4) — combined detector", () => {
  const evidenceLooksRaw = (s: string) =>
    looksLikeRawSharedFactsDump(s)
    || looksLikeRawToolEvidenceDump(s)
    || looksLikeRawWorkspaceToolDump(s);

  it("flags a shared-facts dump (- auto_xxx: ... bullets)", () => {
    const sharedFacts =
      "- auto_researcher_web_search_abc: Infineon IM73A135V01 is an analog differential MEMS mic\n"
      + "- auto_researcher_web_search_def: The Bosch BMI270 IMU runs on I²C at address 0x68\n"
      + "- auto_researcher_web_search_ghi: Power consumption under load: 0.95 mA at 3.3 V";
    expect(looksLikeRawSharedFactsDump(sharedFacts)).toBe(true);
    expect(evidenceLooksRaw(sharedFacts)).toBe(true);
  });

  it("flags a read_shared_facts heading-style dump", () => {
    const readShared =
      "- read_shared_facts: ## Shared Session Facts (3) "
      + "**auto_mic_specs**: analog differential, **auto_pdm_supported**: false, "
      + "**auto_supply_voltage**: 3.3 V";
    expect(evidenceLooksRaw(readShared)).toBe(true);
  });

  it("flags a raw web-search + page-chrome dump (not detected as shared-facts)", () => {
    // This is the audit bcb417e4 shape: the delegate's "evidence" is a raw web search
    // block. looksLikeRawSharedFactsDump returns false (no auto_ prefix), but
    // looksLikeRawToolEvidenceDump returns true (leading "Web Search Results for:").
    const delegateRaw =
      "Web Search Results for: \"CES 2026 MEMS microphone Infineon\" (via duckduckgo) "
      + "Infineon IM73A135V01 Datasheet https://www.infineon.com/dgdl/Infineon-IM73A135V01-DataSheet-v01_00-EN.pdf "
      + "Content from: https://www.infineon.com/ IM73A135V01 - High performance analog "
      + "differential MEMS microphone Jump to content Skip to main content move to sidebar "
      + "Create account Log in Personal tools Donate";
    expect(looksLikeRawSharedFactsDump(delegateRaw)).toBe(false);
    expect(looksLikeRawToolEvidenceDump(delegateRaw)).toBe(true);
    expect(evidenceLooksRaw(delegateRaw)).toBe(true);
  });

  it("flags a raw workspace/catalog read dump (not detected as shared-facts or tool-dump)", () => {
    // A delegate whose only output is a read_file dump of the .starlingai catalog
    // scaffolding. Looks like neither shared-facts nor web-search chrome to the first
    // two detectors, but matches looksLikeRawWorkspaceToolDump.
    const workspaceDump =
      "#### Tool Calls\n"
      + "read_file  F:/StarlingAI/.starlingai/ agent_outcomes.ndjson  README.md  agents/ 10-core-agents.jsonc 21-orchestration.jsonc\n"
      + "list_files  agents/ config/ docs/";
    expect(looksLikeRawSharedFactsDump(workspaceDump)).toBe(false);
    expect(looksLikeRawToolEvidenceDump(workspaceDump)).toBe(false);
    expect(looksLikeRawWorkspaceToolDump(workspaceDump)).toBe(true);
    expect(evidenceLooksRaw(workspaceDump)).toBe(true);
  });

  it("does NOT flag a curated, sourced findings blob (delegate did the synthesis work)", () => {
    const curated =
      "## Findings\n"
      + "- The Infineon IM73A135V01 is an **analog differential** MEMS microphone "
      + "(https://www.infineon.com/dgdl/Infineon-IM73A135V01-DataSheet-v01_00-EN.pdf, S.1).\n"
      + "- It does NOT expose a digital (PDM/I²S) interface. The analog differential output "
      + "requires an external ADC; for digital-only MCUs an external PDM-to-I²S chip is needed.\n"
      + "- Supply voltage: 3.3 V, sensitivity: -38 dBV/Pa (typical).";
    expect(evidenceLooksRaw(curated)).toBe(false);
  });

  it("does NOT flag a short empty-evidence case", () => {
    // If the backstop evidence is empty/null the runtime never reaches this code path,
    // but the combined predicate should still be a no-op for empty input — guarding
    // against a refactor that passes terminalEvidenceBackstop.evidence unconditionally.
    expect(evidenceLooksRaw("")).toBe(false);
    expect(evidenceLooksRaw("   \n  ")).toBe(false);
  });
});
