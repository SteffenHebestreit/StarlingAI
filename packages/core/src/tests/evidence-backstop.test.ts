import { describe, expect, it } from "vitest";
import {
  isJunkEvidenceValue,
  chooseBetterRecoveryEvidence,
  formatSourceSensitiveEvidenceBackstop,
  getSharedFactsEvidenceForFinalSynthesis,
  answerNeedsEvidenceAnchoringRepair,
  hasRecentSourceSensitivePartialDelegation,
  looksLikeComposedGuideRequest,
  looksLikeArtifactCreationRequest,
  selectAutoBuildBuilderAgent,
  shouldSuppressRelayForUnbuiltApp,
  stripLeadingDelegateLabelEcho,
  looksLikeRawToolEvidenceDump,
  stripLargeCodeFences,
  looksLikeInlinedAppDocument,
  extractInlineHtmlDocument,
  looksLikeCompleteHtmlDocument,
} from "../agent/runtime.js";
import { writeSharedFact } from "../swarm/memory.js";
import { looksEvidenceAnchored, sharesEvidenceVocabulary } from "../agent/evidence-anchoring.js";

/**
 * Source-sensitive evidence backstop (May 2026 regression).
 * A live session verified "IM73A135V01 = analog, NOT I2S, SNR 73 dB" into shared
 * facts, but the final answer shipped raw %PDF bytes + "200 OK … application/pdf"
 * because the backstop sorted facts alphabetically (auto_* dumps first), never
 * filtered binary/HTTP junk, and scored a long raw dump above the concise
 * verified finding. These guard that the swarm's curated findings win.
 */
const CURATED = "Infineon IM73A135V01: Analog differential output MEMS mic, NOT PDM. SNR 73 dB(A), AOP 124 dB, IP57. Interface: analog (requires external ADC for ESP32-S3).";
const PDF_JUNK = "%PDF-1.7 %ï¿½ 204 0 obj <</Linearized 1/L 155767/O 207>> endobj xref 204 39 0000000016 00000 n 0000001522 00000 n 0000001712 00000 n";
const HTTP_JUNK = "200 OK final: https://www.infineon.com/assets/row/public/documents/24/49/infineon-im73a135-datasheet-en.pdf?fileId=8ac7 content-type: application/pdf last-modified: Tue, 14 Jan 2025 19:20:13 GMT";

describe("evidence backstop — junk detection", () => {
  it("flags raw PDF bytes and bare HTTP-probe lines as junk", () => {
    expect(isJunkEvidenceValue(PDF_JUNK)).toBe(true);
    expect(isJunkEvidenceValue(HTTP_JUNK)).toBe(true);
    expect(isJunkEvidenceValue("")).toBe(true);
  });
  it("keeps real prose evidence (the verified finding)", () => {
    expect(isJunkEvidenceValue(CURATED)).toBe(false);
  });
});

describe("evidence backstop — chooser prefers curated over a long junk dump", () => {
  it("returns the concise curated shared facts over a longer raw-junk delegate dump", () => {
    // Delegate "evidence" is mostly raw junk but much longer (would win on length).
    const delegateEvidence = { evidence: [PDF_JUNK, HTTP_JUNK, PDF_JUNK, HTTP_JUNK].join("\n"), itemCount: 4 };
    const sharedFactsEvidence = { evidence: `- ${CURATED}`, itemCount: 1 };
    const chosen = chooseBetterRecoveryEvidence(delegateEvidence, sharedFactsEvidence);
    expect(chosen?.evidence).toContain("NOT PDM");
  });
});

/**
 * Audit da8fc547: a hardware-build request ("give me product suggestions + a layout how to
 * connect everything + a cost plan + KiCad help") gathered datasheet facts, but auto-build
 * never fired (the verb+file-noun classifier didn't match) and the backstop shipped raw
 * reflow-oven temperatures instead of the researcher's build guide. These guard the two
 * fixes: the composed-guide classifier that widens the auto-build trigger, and stripping the
 * [agent]: relay echo so the clean delegate synthesis survives as a backstop.
 */
describe("looksLikeComposedGuideRequest — widen auto-build to composed-guide asks", () => {
  it("matches the ESP32 hardware build-guide request that names no file", () => {
    const msg = "I want to build a portable recorder. Maybe the IM73A135V01? can you give me product suggestions as well as a layout how to connect everything together. Ja ich brauche hilfe mit dem KiCad-Schema und dem Gehäuse. Es wäre aber auch hilfreich einen kostenplan zu haben";
    expect(looksLikeComposedGuideRequest(msg)).toBe(true);
    // The verb+file-noun classifier does NOT match it — that's the gap this backstops.
    expect(looksLikeArtifactCreationRequest(msg)).toBe(false);
  });
  it("matches explicit build-guide / BOM / cost-plan asks (EN + DE)", () => {
    expect(looksLikeComposedGuideRequest("give me a step-by-step build guide and a bill of materials")).toBe(true);
    expect(looksLikeComposedGuideRequest("erstelle eine Stückliste und einen Kostenplan")).toBe(true);
  });
  it("does not fire on a plain factual question that merely mentions a noun", () => {
    expect(looksLikeComposedGuideRequest("what is the wiring color code for cat6?")).toBe(false);
    expect(looksLikeComposedGuideRequest("explain how a schematic capture tool works")).toBe(false);
    expect(looksLikeComposedGuideRequest("what's the weather in Berlin today?")).toBe(false);
  });
});

/**
 * Regression: session b07a8a22 (2026-06-09). A composite "research a question
 * catalog AND THEN build a WebApp" turn researched (11 sourced findings) but
 * shipped only a research summary that *promised* a code draft — the WebApp was
 * never built. Root cause: the auto-build-after-research backstop is gated on
 * looksLikeArtifactCreationRequest, whose artifact-noun set had website/webpage
 * but NO "app"/"webapp"/"web app" — so "Erstelle dann eine WebApp" did not match
 * and the build step never ran. "app" is a universal build deliverable; the gap
 * is filled (EN + DE), not overfit to this case.
 */
describe("looksLikeArtifactCreationRequest — recognizes app / WebApp deliverables", () => {
  it("matches the German research-then-build-a-WebApp request", () => {
    expect(
      looksLikeArtifactCreationRequest(
        "Recherchiere einen Fragekatalog der mich auf die Prüfung vorbereiten kann\nErstelle dann eine WebApp zum Lernen für diese Zertifizierung",
      ),
    ).toBe(true);
  });
  it("matches app variants (EN + DE), verb-gated", () => {
    expect(looksLikeArtifactCreationRequest("build a web app for tracking habits")).toBe(true);
    expect(looksLikeArtifactCreationRequest("create a learning app with a quiz")).toBe(true);
    expect(looksLikeArtifactCreationRequest("baue eine Web-App")).toBe(true);
    expect(looksLikeArtifactCreationRequest("erstelle eine Anwendung zum Lernen")).toBe(true);
  });
  it("stays verb-gated — a plain mention of an app is not a build request", () => {
    expect(looksLikeArtifactCreationRequest("which app is best for note-taking?")).toBe(false);
    expect(looksLikeArtifactCreationRequest("what does this app do?")).toBe(false);
  });
});

/**
 * Regression: session b3b52be4 (2026-06-09). The auto-build fired (good) but went
 * to content_writer, which has no interactive-app tool — it narrated the whole
 * "WebApp zum Lernen" as a 21k-token markdown completion (toolCount:1, only
 * read_shared_facts), timed out, and wrote NO file. An interactive app must route
 * to web_coder (incremental multi-file front-end); a served/dynamic app to
 * backend_coder; static pages/decks/docs stay with content_writer.
 */
describe("selectAutoBuildBuilderAgent — route the auto-build by deliverable type", () => {
  it("routes an interactive WebApp to web_coder", () => {
    expect(
      selectAutoBuildBuilderAgent(
        "Recherchiere einen Fragekatalog\nErstelle dann eine WebApp zum Lernen für diese Zertifizierung",
      ),
    ).toBe("web_coder");
    expect(selectAutoBuildBuilderAgent("build an interactive quiz app")).toBe("web_coder");
    expect(selectAutoBuildBuilderAgent("baue ein Dashboard")).toBe("web_coder");
  });
  it("routes a learning platform / question-catalog / multiple-choice tool to web_coder (audit 13523d73)", () => {
    // A learning platform with a question catalog and multiple-choice answers is an
    // interactive app, not a static page — it must NOT default to content_writer (which
    // narrates a giant markdown and times out, building no file).
    expect(
      selectAutoBuildBuilderAgent(
        "brauche eine Lernplattform für die Prüfung … Fragekatalog zum lernen mit den passenden multiple-choice Antworten",
      ),
    ).toBe("web_coder");
    expect(selectAutoBuildBuilderAgent("build a learning platform with flashcards")).toBe("web_coder");
  });
  it("routes a served / dynamic app to backend_coder", () => {
    expect(selectAutoBuildBuilderAgent("build and serve an Express API for the dashboard")).toBe("backend_coder");
    expect(selectAutoBuildBuilderAgent("erstelle einen Node-Server und liefere das Frontend aus")).toBe("backend_coder");
  });
  it("routes an EXTERNAL-API CONNECTOR to backend_coder — it must be served (egress), not a --network=none self-dev snippet", () => {
    expect(selectAutoBuildBuilderAgent("build a connector for the Overpass API")).toBe("backend_coder");
    expect(selectAutoBuildBuilderAgent("write an integration that queries a third-party geocoding API")).toBe("backend_coder");
    expect(selectAutoBuildBuilderAgent("create an API proxy that fetches from an external service")).toBe("backend_coder");
    // structural, not topic: a doc that merely MENTIONS a provider but asks for a report stays content_writer
    expect(selectAutoBuildBuilderAgent("write a report comparing several mapping providers")).toBe("content_writer");
  });
  it("keeps static pages, decks, and documents on content_writer", () => {
    expect(selectAutoBuildBuilderAgent("erstelle eine Landingpage über die Zertifizierung")).toBe("content_writer");
    expect(selectAutoBuildBuilderAgent("build a reveal.js presentation about Dresden")).toBe("content_writer");
    expect(selectAutoBuildBuilderAgent("schreibe einen ausführlichen Bericht mit Quellen")).toBe("content_writer");
  });
});

/**
 * Regression: session 9ad34ef9 (2026-06-10). A "research a question catalog AND build a WebApp"
 * turn ran research only, the researcher returned a clean fact-sheet + concept, and the
 * single-deliverable relay shipped THAT verbatim — short-circuiting the auto-build backstop
 * before it could build the app. The relay must be suppressed for an unbuilt app/served
 * deliverable so the turn falls through to the build step.
 */
describe("shouldSuppressRelayForUnbuiltApp — relay must not satisfy an unbuilt app request", () => {
  const webAppMsg = "Recherchiere einen Fragekatalog\nErstelle dann eine WebApp zum Lernen für diese Zertifizierung";
  it("suppresses the relay when an app was requested but nothing was built", () => {
    expect(shouldSuppressRelayForUnbuiltApp(webAppMsg, 0)).toBe(true);
    expect(shouldSuppressRelayForUnbuiltApp("build an interactive quiz app", 0)).toBe(true);
    expect(shouldSuppressRelayForUnbuiltApp("baue eine WebApp und starte sie als Server", 0)).toBe(true);
  });
  it("does NOT suppress once an artifact was actually produced this turn", () => {
    expect(shouldSuppressRelayForUnbuiltApp(webAppMsg, 1)).toBe(false);
  });
  it("does NOT suppress for plain reports / decks / research (relay still fine inline)", () => {
    expect(shouldSuppressRelayForUnbuiltApp("schreibe einen ausführlichen Bericht mit Quellen", 0)).toBe(false);
    expect(shouldSuppressRelayForUnbuiltApp("build a reveal.js presentation about Dresden", 0)).toBe(false);
    expect(shouldSuppressRelayForUnbuiltApp("recherchiere die CPSA-F Prüfungsfakten", 0)).toBe(false);
  });
});

describe("stripLeadingDelegateLabelEcho — recover a clean delegate guide from a relay echo", () => {
  const labeled = "[researcher]:\n[researcher]: Based on the curated findings, here is the complete technical guide for building your portable, high-quality microphone array device. 1. Microphone Selection & Opinion: IM73A135V01 is an analog MEMS mic (SNR 73 dB(A), IP57) that needs an external ADC, while the INMP441 is a digital I2S mic that connects directly to the ESP32-S3.";
  it("strips single and doubled [agent]: labels so the synthesis underneath is clean", () => {
    const cleaned = stripLeadingDelegateLabelEcho(labeled);
    expect(cleaned.startsWith("Based on the curated findings")).toBe(true);
    // The echo made the original trip the raw-dump guard; the cleaned text no longer does.
    expect(looksLikeRawToolEvidenceDump(labeled)).toBe(true);
    expect(looksLikeRawToolEvidenceDump(cleaned)).toBe(false);
  });
  it("leaves already-clean prose untouched", () => {
    const clean = "Based on the curated findings, here is the complete technical guide.";
    expect(stripLeadingDelegateLabelEcho(clean)).toBe(clean);
  });
});

describe("evidence backstop — display strips junk lines", () => {
  it("drops PDF/HTTP junk lines but keeps the verified finding", () => {
    const evidence = [`- ${CURATED}`, `- ${PDF_JUNK}`, `- ${HTTP_JUNK}`].join("\n");
    const out = formatSourceSensitiveEvidenceBackstop(evidence);
    expect(out).toContain("SNR 73 dB");
    expect(out).not.toContain("%PDF-1.7");
    expect(out).not.toContain("application/pdf");
  });
});

describe("evidence backstop — shared-facts gathering prioritizes curated findings", () => {
  const sid = `evidence-backstop-test-${Date.now()}`;

  it("surfaces the curated share_finding and drops auto_* raw dumps", async () => {
    // Seed the way the live session did: curated finding + several raw auto dumps
    // whose keys sort alphabetically BEFORE the curated key.
    await writeSharedFact(sid, "auto_researcher_url_inspect_aaa", HTTP_JUNK);
    await writeSharedFact(sid, "auto_researcher_web_fetch_bbb", PDF_JUNK);
    await writeSharedFact(sid, "im73a135v01_verified_specs", CURATED);

    const result = await getSharedFactsEvidenceForFinalSynthesis(sid);
    expect(result).not.toBeNull();
    expect(result!.evidence).toContain("NOT PDM");
    expect(result!.evidence).not.toContain("%PDF-1.7");
    expect(result!.evidence).not.toContain("application/pdf");
  });
});

describe("evidence backstop — partial-delegation trigger (audit 1ba15cb5)", () => {
  // A coordinator that synthesizes after its inner researchers time out returns
  // outcome "partial" with terminalState "completed". The old gate only fired for
  // partial+timeout/max_iterations/cancelled, so partial+completed slipped through:
  // the backstop never re-grounded the answer, and a confident "digital PDM" reply
  // shipped that contradicted the verified "analog" shared finding.
  const delegateMsg = (outcome: string, terminalState: string) => ([{
    role: "tool",
    content: "Delegated result from mission_coordinator — PARTIAL PROGRESS.\nObserved evidence: ...",
    metadata: { agentName: "mission_coordinator", delegationOutcome: outcome, terminalState, delegationSucceeded: true },
  }]);

  it("fires for a partial outcome even when terminalState is 'completed'", () => {
    expect(hasRecentSourceSensitivePartialDelegation(delegateMsg("partial", "completed"))).toBe(true);
  });

  it("still fires for partial+timeout and for failure (no regression)", () => {
    expect(hasRecentSourceSensitivePartialDelegation(delegateMsg("partial", "timeout"))).toBe(true);
    expect(hasRecentSourceSensitivePartialDelegation(delegateMsg("failure", "error"))).toBe(true);
  });

  it("does not fire for a fully successful delegation", () => {
    expect(hasRecentSourceSensitivePartialDelegation(delegateMsg("success", "completed"))).toBe(false);
  });
});

describe("evidence backstop — answer anchoring decision (qaEvidenceAnchoring gate)", () => {
  const EVIDENCE = `- ${CURATED}`;

  // A training-data answer about the topic that references NONE of the verified
  // tokens (no Infineon, no part number, no analog/differential/ESP32 specifics) —
  // exactly the "answered from memory while verified facts sit unused" failure.
  const UNANCHORED =
    "Small acoustic sensors are widely used in consumer electronics like phones and laptops. "
    + "Connecting one to a hobby board generally involves wiring its data line to a digital input "
    + "and reading samples in firmware. Pick a component with solid signal quality for your build "
    + "and follow the reference design from the vendor's documentation.";

  // An answer grounded in the gathered findings — names the part, manufacturer, and specs.
  const ANCHORED =
    "The Infineon IM73A135V01 is an analog differential MEMS microphone with 73 dB(A) SNR. "
    + "Because it is analog, not a PDM or I2S digital part, it requires an external ADC to interface "
    + "with an ESP32-S3 — route the analog output through the ADC and sample it in firmware.";

  it("flags a substantial source-sensitive answer that ignores the verified findings", () => {
    expect(answerNeedsEvidenceAnchoringRepair(UNANCHORED, EVIDENCE)).toBe(true);
  });

  it("passes an answer that is grounded in the findings", () => {
    expect(answerNeedsEvidenceAnchoringRepair(ANCHORED, EVIDENCE)).toBe(false);
  });

  it("does not fire when there is no usable evidence", () => {
    expect(answerNeedsEvidenceAnchoringRepair(UNANCHORED, "")).toBe(false);
    expect(answerNeedsEvidenceAnchoringRepair(UNANCHORED, null)).toBe(false);
    expect(answerNeedsEvidenceAnchoringRepair(UNANCHORED, "Partial progress before interruption: none")).toBe(false);
  });

  it("ignores short answers (a brief 'it depends' needs no anchoring repair)", () => {
    expect(answerNeedsEvidenceAnchoringRepair("It depends on your exact build constraints.", EVIDENCE)).toBe(false);
  });
});

/**
 * Spec-token consistency (the original bug). The shared-vocabulary check
 * alone passed a draft that named the right part but flipped a key spec
 * (the live session shipped "I²S-Digital" against evidence that says
 * "analog differential"). The anchor now ALSO requires every spec-shaped
 * token in the draft to either appear in the evidence, or be mutually
 * negated in both texts. These three tests pin that contract: one
 * positive case (the consistent answer), one flipped-spec case (the
 * original bug), and one contrastive-phrasing case (the legitimate
 * "not I²S" answer is still considered anchored).
 */
describe("evidence backstop — spec-token consistency", () => {
  const HARDWARE_EVIDENCE = [
    "Infineon IM73A135V01: Analog differential output MEMS mic, NOT PDM. SNR 73 dB(A), AOP 124 dB, IP57.",
    "Interface: analog (requires external ADC for ESP32-S3).",
  ].join(" ");

  it("flags a draft that names the part but flips a key spec (the original bug)", () => {
    // The original failure mode: a draft that shares part number + SNR
    // tokens with the evidence but invents an I²S-Digital interface the
    // evidence does not claim. "i2s-digital" is a spec-shaped token
    // (digit + letter, hyphen) that appears in the draft and is NOT in
    // the evidence and is NOT negated in the draft → anchor fails.
    const FLAWED = "The Infineon IM73A135V01 is an I2S-Digital MEMS mic with 73 dB(A) SNR and IP57 rating. It comes in a 4.0 x 3.0 x 1.2 mm LGA package with a sealed acoustic port. Use it directly with the ESP32-S3 over the I2S peripheral and feed its digital output straight into the chip's PDM input.";
    expect(answerNeedsEvidenceAnchoringRepair(FLAWED, HARDWARE_EVIDENCE)).toBe(true);
  });

  it("accepts a draft that mirrors the evidence claims", () => {
    const CONSISTENT = "The Infineon IM73A135V01 is an analog differential MEMS microphone with 73 dB(A) SNR. It needs an external ADC to work with an ESP32-S3.";
    expect(answerNeedsEvidenceAnchoringRepair(CONSISTENT, HARDWARE_EVIDENCE)).toBe(false);
  });

  it("accepts a contrastive phrasing where both draft and evidence deny the same term", () => {
    // "not a PDM or I2S digital part" / evidence "NOT PDM" — the spec
    // tokens I2S appears in the draft only inside a negation, and the
    // evidence is also a negation of PDM. The both-negated path lets
    // the anchor pass.
    const CONTRASTIVE = "The Infineon IM73A135V01 is an analog differential MEMS microphone with 73 dB(A) SNR. Because it is analog, not a PDM or I2S digital part, it requires an external ADC to interface with an ESP32-S3 — route the analog output through the ADC and sample it in firmware.";
    expect(answerNeedsEvidenceAnchoringRepair(CONTRASTIVE, HARDWARE_EVIDENCE)).toBe(false);
  });
});

/**
 * Recovery-synthesis gate (audit f7928f57): the source-sensitive recovery
 * synthesis is prompt-constrained to evidence-only with explicit unverified
 * marking. It must NOT be discarded (→ raw tool-dump fallback) just because it
 * hedges a requested-but-unverified spec token. sharesEvidenceVocabulary is the
 * lighter gate it uses; looksEvidenceAnchored stays strict for the model's own draft.
 */
describe("sharesEvidenceVocabulary — recovery-synthesis gate", () => {
  const EVIDENCE = "Infineon IM73A135V01: analog differential MEMS microphone, IP57 dust/water resistant, requires an external ADC for the ESP32 (Source: https://www.alldatasheet.com/datasheet-pdf/view/1388108/INFINEON/IM73A135V01.html).";
  // A correctly-hedged partial: verified facts from the evidence + clearly-flagged
  // unverified parts that name tokens (bq25895, pcm1808) the thin evidence lacks.
  const HEDGED_PARTIAL = "Verifiziert: Das IM73A135V01 ist ein analoges MEMS-Mikrofon mit IP57 und benoetigt einen externen ADC fuer den ESP32 (Quelle: alldatasheet.com). Noch nicht belegt: konkrete Lade-IC-Spezifikationen (z. B. bq25895) und das genaue pcm1808-Interface bleiben unverifiziert. Naechster Schritt: die offiziellen Datenblaetter pruefen.";

  it("strict anchoring REJECTS the hedged partial (its unverified tokens aren't in evidence)", () => {
    expect(looksEvidenceAnchored(HEDGED_PARTIAL, EVIDENCE)).toBe(false);
  });

  it("the lighter gate ACCEPTS it because it demonstrably used the evidence", () => {
    expect(sharesEvidenceVocabulary(HEDGED_PARTIAL, EVIDENCE)).toBe(true);
  });

  it("still rejects a synthesis that shares nothing with the evidence", () => {
    const UNRELATED = "Hier ist eine allgemeine Anleitung zum Backen eines Schokoladenkuchens mit Mehl, Zucker und Eiern, die ueberhaupt nichts mit dem gesammelten Beleg zu tun hat und keine einzige Quelle nennt.";
    expect(sharesEvidenceVocabulary(UNRELATED, EVIDENCE)).toBe(false);
  });
});

/**
 * stripLargeCodeFences (audit ce8e2128): the corrective build wrote the app as a real
 * downloadable file, but the chat confirmation pasted a multi-KB inline code block — a
 * DIFFERENT, fabricated version than the file actually built. The artifact is already an
 * attachment, so a large fenced block in the confirmation is pure noise. Strip blocks
 * >=1500 chars; keep short snippets and surrounding prose.
 */
describe("stripLargeCodeFences — corrective-build confirmation cleanup", () => {
  const bigHtml = "```html\n" + "<div>x</div>\n".repeat(200) + "```";

  it("removes a large fenced code block and leaves a marker", () => {
    const msg = `Die Datei wurde erstellt: index.html.\n\n${bigHtml}\n\nViel Erfolg!`;
    const out = stripLargeCodeFences(msg);
    expect(out).not.toContain("<div>x</div>");
    expect(out).toContain("index.html");
    expect(out).toContain("Viel Erfolg!");
    expect(out.toLowerCase()).toContain("attached file");
  });

  it("keeps a short snippet untouched", () => {
    const msg = "Run it with:\n\n```bash\nopen index.html\n```\n\nDone.";
    const out = stripLargeCodeFences(msg);
    expect(out).toContain("open index.html");
    expect(out).toContain("```bash");
  });

  it("returns prose-only messages unchanged (trimmed)", () => {
    expect(stripLargeCodeFences("Just a confirmation, no code.")).toBe("Just a confirmation, no code.");
  });
});

/**
 * looksLikeInlinedAppDocument (audit 3b7d59a8): a zero-tool turn that hand-writes the
 * WHOLE app as an inline HTML document (usually truncated at the completion cap) must be
 * rerouted into a real build. Precision matters: a large fenced *snippet* can be a
 * legitimate inline answer — only full-document markers qualify, and truncated dumps
 * (no closing tag, unclosed fence) must still match.
 */
describe("looksLikeInlinedAppDocument — full inline app document detection", () => {
  it("matches a fenced full HTML document even when truncated mid-stream", () => {
    const truncated = "Kopiere den Code:\n\n```html\n<!DOCTYPE html>\n<html lang=\"de\">\n<head><style>\n"
      + ".x { padding: 1px; }\n".repeat(100)
      + ".pagination {\n  display: flex"; // no closing fence, no </html>
    expect(looksLikeInlinedAppDocument(truncated)).toBe(true);
  });

  it("matches a complete unfenced HTML document", () => {
    const doc = "<!DOCTYPE html>\n<html><body>" + "<p>x</p>".repeat(300) + "</body></html>";
    expect(looksLikeInlinedAppDocument(doc)).toBe(true);
  });

  it("does NOT match a large fenced code SNIPPET (legitimate inline answer)", () => {
    const snippet = "Here is the Express example you asked for:\n\n```js\n"
      + "app.get('/route', handler);\n".repeat(120)
      + "```";
    expect(looksLikeInlinedAppDocument(snippet)).toBe(false);
  });

  it("does NOT match short answers", () => {
    expect(looksLikeInlinedAppDocument("```html\n<!DOCTYPE html><html></html>\n```")).toBe(false);
  });
});

/**
 * extractInlineHtmlDocument (audit 0ac7d3fc): the corrective builder "succeeded" with
 * zero artifacts — its timeout synthesis pasted the complete 15KB app into its RESULT
 * text. The runtime harvests that document and writes the file itself instead of
 * failing the turn.
 */
describe("extractInlineHtmlDocument — harvest a full app from builder result text", () => {
  const body = "<head><style>.q{padding:2px}</style></head><body>"
    + "<div class=\"q\">Frage</div>".repeat(80)
    + "<script>let i=0;</script></body>";

  it("extracts a fenced complete document and cuts cleanly after </html>", () => {
    const result = "Die App ist fertig.\n\n```html\n<!DOCTYPE html>\n<html lang=\"de\">" + body + "</html>\n```\n\nViel Erfolg!";
    const doc = extractInlineHtmlDocument(result);
    expect(doc).not.toBeNull();
    expect(doc!.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(doc!.endsWith("</html>")).toBe(true);
    expect(doc).not.toContain("Viel Erfolg");
    expect(looksLikeCompleteHtmlDocument(doc!)).toBe(true);
  });

  it("extracts an unfenced raw document from mixed prose", () => {
    const result = "Hier ist die Lernplattform:\n\n<!DOCTYPE html>\n<html>" + body + "</html>";
    const doc = extractInlineHtmlDocument(result);
    expect(doc).not.toBeNull();
    expect(doc!.endsWith("</html>")).toBe(true);
  });

  it("returns a TRUNCATED document too, flagged incomplete by looksLikeCompleteHtmlDocument", () => {
    const truncated = "```html\n<!DOCTYPE html>\n<html><head><style>\n" + ".x{margin:1px}\n".repeat(150) + ".y{display:fl";
    const doc = extractInlineHtmlDocument(truncated);
    expect(doc).not.toBeNull();
    expect(looksLikeCompleteHtmlDocument(doc!)).toBe(false);
  });

  it("returns null for short results and for prose without a document", () => {
    expect(extractInlineHtmlDocument("Done. The file index.html was written.")).toBeNull();
    expect(extractInlineHtmlDocument("```html\n<!DOCTYPE html><html></html>\n```")).toBeNull();
    expect(extractInlineHtmlDocument("Long report without any markup. " + "Lorem ipsum dolor. ".repeat(200))).toBeNull();
  });
});
