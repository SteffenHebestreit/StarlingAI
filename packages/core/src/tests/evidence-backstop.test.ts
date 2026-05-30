import { describe, expect, it } from "vitest";
import {
  isJunkEvidenceValue,
  chooseBetterRecoveryEvidence,
  formatSourceSensitiveEvidenceBackstop,
  getSharedFactsEvidenceForFinalSynthesis,
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
