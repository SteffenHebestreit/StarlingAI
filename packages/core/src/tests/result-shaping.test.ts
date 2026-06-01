import { describe, expect, it } from "vitest";
import { extractedFindingIsLowValue, extractKeyFacts } from "../tools/result-shaping.js";

/**
 * Auto-share quality gate (May 2026). Shared facts kept filling up with raw
 * tool noise — %PDF bytes, bare HTTP-probe dumps, and login/nav boilerplate the
 * crawler dragged in — instead of the extracted "good stuff". The final
 * synthesis and the source-sensitive evidence backstop both read from shared
 * facts, so this noise actively degraded answers. extractedFindingIsLowValue
 * rejects those at the source while keeping substantive (even terse) findings.
 * Structural signals only — no topic keywords — so it generalizes across sites.
 */
describe("auto-share quality gate — extractedFindingIsLowValue", () => {
  it("rejects raw PDF / binary bytes", () => {
    expect(extractedFindingIsLowValue(
      "%PDF-1.7 %ï¿½ 204 0 obj <</Linearized 1/L 155767/O 207>> endobj xref 204 39 0000000016 00000 n 0000001522 00000 n",
    )).toBe(true);
    expect(extractedFindingIsLowValue(
      "stream x­ endstream endobj /FlateDecode /MediaBox [0 0 612 792]",
    )).toBe(true);
  });

  it("rejects bare HTTP-probe header dumps with no prose", () => {
    expect(extractedFindingIsLowValue(
      "200 OK final: https://example.com/doc.pdf?fileId=8ac7 content-type: application/pdf last-modified: Tue, 14 Jan 2025 19:20:13 GMT content-length: 155767",
    )).toBe(true);
  });

  it("rejects navigation / login / cookie boilerplate", () => {
    expect(extractedFindingIsLowValue(
      "Skip to main content Login Register Sign in My account Main menu Search the site Privacy policy "
      + "Cookie settings Newsletter subscribe Notifications Bookmarks Dashboard Logout Home",
    )).toBe(true);
  });

  it("rejects symbol / number-only blobs and empty input", () => {
    expect(extractedFindingIsLowValue("")).toBe(true);
    expect(extractedFindingIsLowValue("  \n  ")).toBe(true);
    expect(extractedFindingIsLowValue("123 456 789 | 0.0 :: -- >> << == 99% $4.20 #1")).toBe(true);
  });

  it("keeps a substantive prose finding", () => {
    expect(extractedFindingIsLowValue(
      "The Infineon IM73A135V01 is an analog differential MEMS microphone, not a digital PDM/I2S part. "
      + "It has 73 dB(A) SNR and 124 dB AOP, and requires an external ADC to interface with an ESP32-S3.",
    )).toBe(false);
  });

  it("keeps a terse spec-style finding (does not over-reject short substance)", () => {
    // A handful of real words is enough — only pure symbol/number dumps are dropped.
    expect(extractedFindingIsLowValue("SNR 73 dB(A), AOP 124 dB, analog differential output, IP57 rated."))
      .toBe(false);
  });

  it("keeps a search-results extract that contains real titles and snippets", () => {
    // extractKeyFacts output for a web_search result must survive the gate so the
    // useful breadth still reaches shared facts.
    const extracted = extractKeyFacts(
      "**Web Search Results for:** \"MEMS microphone datasheet\" (via searxng)\n"
      + "**XENSIV IM73A135 product brief — Infineon**\n"
      + "https://www.infineon.com/im73a135\n"
      + "High-performance analog MEMS microphone with 73 dB SNR for always-on voice applications.\n"
      + "**IM73A135V01 datasheet PDF**\n"
      + "https://datasheet4u.com/im73a135\n"
      + "Differential analog output, AOP 124 dB, IP57 dust and water resistant package.",
      "web_search",
    );
    expect(extractedFindingIsLowValue(extracted)).toBe(false);
  });
});
