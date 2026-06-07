import { describe, expect, it } from "vitest";
import {
  isJunkEvidenceValue,
  chooseBetterRecoveryEvidence,
  formatSourceSensitiveEvidenceBackstop,
  getSharedFactsEvidenceForFinalSynthesis,
  answerNeedsEvidenceAnchoringRepair,
  hasRecentSourceSensitivePartialDelegation,
} from "../agent/runtime.js";
import { writeSharedFact } from "../swarm/memory.js";

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
