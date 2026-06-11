import { describe, expect, it } from "vitest";
import {
  collapseRepeatedMarkdownSections,
  collapseRepeatedLines,
  extractSingleRelayableDeliverable,
  looksLikeTruncatedCodeDeliverable,
  filterForcedOrchestrationTools,
  looksLikeDegenerateRepetition,
  looksLikeDegenerateLineRepetition,
  stripLeadingReasoningPreamble,
} from "../agent/runtime.js";
import { fetchResultIsNonProductive, tryExtractLatestCompleteDeliverable } from "../agent/sub-agent.js";

// Mirrors audit 9fd16384: the slow model looped one section ~17× with a single
// genuinely-unique section interleaved.
const LOOPED_SECTION = [
  "The Infineon IM73A135V01 is a confirmed viable candidate for your flat, high-quality requirement.",
  "*   Type: Analog XENSIV MEMS Microphone (Analog, not Digital I2S)",
  "*   Part Number: IM73A135V01",
  "*   Manufacturer: Infineon Technologies AG",
  "*   File Size: 2478.37 Kbytes",
  "*   Source URL: https://www.alldatasheet.com/datasheet-pdf/download/1388108/INFINEON/IM73A135V01.html",
].join("\n");
const UNIQUE_SECTION = [
  "*   ESP32-S3 Cores: 2x Xtensa LX7 @ 240 MHz (Source: https://example.com/esp32)",
  "*   Memory: 384 KB ROM, 512 KB SRAM",
  "*   Audio Interfaces: 2x I2S",
].join("\n");
function degenerateDeliverable(repeats: number): string {
  const parts: string[] = [];
  for (let i = 1; i <= repeats; i++) {
    parts.push(`### ${i}. Microphone Selection: Infineon IM73A135V01\n${LOOPED_SECTION}`);
    if (i === 1) parts.push(`### 2. ESP32-S3 Processor\n${UNIQUE_SECTION}`);
  }
  return parts.join("\n\n");
}

// A realistic, structured, >800-char specialist deliverable.
const DELIVERABLE = [
  "## Recommendation",
  "The **ESP32-C61** is the best pick for OTA sync plus deep-sleep efficiency.",
  "",
  "## Key specs",
  "| Field | Value |",
  "| --- | --- |",
  "| Deep sleep | 0.01 mA |",
  "| Wi-Fi | Wi-Fi 6 |",
  "| BLE | 5.3 |",
  "| Package | QFN |",
  "",
  "## Bill of materials",
  "- MEMS microphone: Infineon IM73A135V01 (analog differential output, IP57 dust/water rated, 4x3x1.2 mm package)",
  "- MCU: ESP32-C61-WROOM module with Wi-Fi 6 and BLE 5.3 for dual OTA paths (large file transfer + low-power signalling)",
  "- ADC: TI PCM1804 (24-bit, multi-channel, I2S output) to digitise the differential microphone outputs for the ESP32",
  "- Battery: 503048 LiPo pouch cell (~500 mAh) chosen for a slim portable profile with adequate recording runtime",
  "- USB-C charger: TP4056 linear charger module paired with an IP5306 power-path controller for run-while-charging",
  "- Wireless charging: Adafruit 1901 (BQ51013B driver) Qi receiver, 4.8-5.2 V output at 500 mA, 48x32x0.5 mm coil",
  "",
  "## Waterproofing",
  "- Enclosure: IP67 ABS/PC shell with a silicone perimeter gasket and conformal-coated PCB",
  "- Mic ports: ePTFE acoustic vents that pass sound while blocking water and dust ingress",
  "- Charging: rely on Qi plus magnetic pogo-pin contacts so no exposed USB-C port breaks the seal",
  "",
  "## Transcription quality improvements",
  "- Record at 48 kHz / 24-bit and apply adaptive beamforming across the 5-mic circular array",
  "- Add voice-activity detection on the ULP coprocessor so it only records on speech",
  "- Keep a 2-4 second pre-roll buffer so the start of speech is never clipped on button press",
].join("\n");

function wrapDelegate(deliverable: string, opts: { state?: string } = {}): string {
  const state = opts.state ?? "TASK COMPLETED.";
  return [
    `Delegated result from mission_coordinator — ${state}`,
    "IMPORTANT: Present the full content below VERBATIM to the user. Reproduce EVERY row, bullet, table entry, heading, name, number, and source exactly as shown.",
    "Observed evidence:",
    deliverable,
  ].join("\n");
}

describe("cost center 2 — single-deliverable relay", () => {
  it("relays a single clean, complete deliverable verbatim", () => {
    const messages = [{ role: "tool", content: wrapDelegate(DELIVERABLE) }];
    const relayed = extractSingleRelayableDeliverable(messages, 1);
    expect(relayed).not.toBeNull();
    expect(relayed!.startsWith("## Recommendation")).toBe(true);
    expect(relayed).toContain("ESP32-C61");
    expect(relayed).toContain("| Deep sleep | 0.01 mA |");
  });

  it("does not relay when more than one delegation ran this turn", () => {
    const messages = [{ role: "tool", content: wrapDelegate(DELIVERABLE) }];
    expect(extractSingleRelayableDeliverable(messages, 2)).toBeNull();
  });

  it("does not relay a PARTIAL or FAILED delegation", () => {
    expect(extractSingleRelayableDeliverable([{ role: "tool", content: wrapDelegate(DELIVERABLE, { state: "PARTIAL PROGRESS." }) }], 1)).toBeNull();
    expect(extractSingleRelayableDeliverable([{ role: "tool", content: wrapDelegate(DELIVERABLE, { state: "TASK FAILED." }) }], 1)).toBeNull();
  });

  it("does not relay when two delegate results are present in the batch", () => {
    const messages = [
      { role: "tool", content: wrapDelegate(DELIVERABLE) },
      { role: "tool", content: wrapDelegate(DELIVERABLE) },
    ];
    expect(extractSingleRelayableDeliverable(messages, 1)).toBeNull();
  });

  it("does not relay short or unstructured evidence", () => {
    const short = wrapDelegate("Yes, the part works fine.");
    expect(extractSingleRelayableDeliverable([{ role: "tool", content: short }], 1)).toBeNull();
  });

  it("strips a leading meta-reasoning preamble before relaying", () => {
    const withPreamble = "Now I have comprehensive evidence. Let me synthesize a complete answer.\n\n---\n\n" + DELIVERABLE;
    const relayed = extractSingleRelayableDeliverable([{ role: "tool", content: wrapDelegate(withPreamble) }], 1);
    expect(relayed).not.toBeNull();
    expect(relayed!.startsWith("## Recommendation")).toBe(true);
    expect(relayed).not.toContain("Let me synthesize");
  });

  // audit 61683c52: a single "research THEN build a WebApp" task went to researcher,
  // which improvised the build, ran out of budget at the soft deadline, and emitted a
  // structured answer that OPENS a ```html fence and is cut off mid-string (the closing
  // fence never arrives). That truncated blob must NOT be relayed as a finished deliverable.
  it("does not relay a deliverable with an unterminated code fence (truncated build)", () => {
    const truncated = [
      "## CPSA-F Lernplattform",
      "Hier ist die WebApp basierend auf dem iSAQB Curriculum 2025.1.",
      "- Themenbasierte Fragen",
      "- Prüfungsmodus",
      "## Code der WebApp",
      "```html",
      "<!DOCTYPE html><html><head><title>CPSA-F</title></head><body>",
      "<script>const questionBank = [{ text: \"Was ist das primäre Ziel?\",",
      "explanation: \"Das Singleton-Muster begrenzt die Instanziierung einer Klasse auf",
    ].join("\n");
    expect(extractSingleRelayableDeliverable([{ role: "tool", content: wrapDelegate(truncated) }], 1)).toBeNull();
  });

  it("looksLikeTruncatedCodeDeliverable: odd fences truncated, even fences complete", () => {
    expect(looksLikeTruncatedCodeDeliverable("intro\n```js\ncode here\n```\ndone")).toBe(false);
    expect(looksLikeTruncatedCodeDeliverable("intro\n```html\n<div>cut off mid build")).toBe(true);
    expect(looksLikeTruncatedCodeDeliverable("no code at all, just prose")).toBe(false);
  });
});

describe("degenerate-repetition guard (audit 9fd16384)", () => {
  it("detects a deliverable dominated by repeated sections", () => {
    expect(looksLikeDegenerateRepetition(degenerateDeliverable(17))).toBe(true);
  });

  it("does not flag a clean multi-section answer", () => {
    const clean = [
      "### 1. Microphone\nThe IM73A135V01 is analog. Source: https://example.com/a",
      "### 2. MCU\nESP32-S3 with two I2S buses. Source: https://example.com/b",
      "### 3. Power\nTP4056 USB-C charger plus a LiPo cell. Source: https://example.com/c",
      "### 4. Enclosure\nIP67 shell with ePTFE vents. Source: https://example.com/d",
    ].join("\n\n");
    expect(looksLikeDegenerateRepetition(clean)).toBe(false);
    expect(collapseRepeatedMarkdownSections(clean)).toBe(clean);
  });

  it("collapses repeated sections to first occurrence + the unique one", () => {
    const collapsed = collapseRepeatedMarkdownSections(degenerateDeliverable(17));
    // One mic section + the unique ESP32 section survive.
    expect((collapsed.match(/Microphone Selection: Infineon IM73A135V01/g) ?? []).length).toBe(1);
    expect(collapsed).toContain("ESP32-S3 Processor");
    expect(collapsed.length).toBeLessThan(degenerateDeliverable(17).length / 3);
    expect(looksLikeDegenerateRepetition(collapsed)).toBe(false);
  });

  it("makes the relay REFUSE a degenerate deliverable (falls through to synthesis)", () => {
    const wrapped = wrapDelegate(degenerateDeliverable(17));
    expect(extractSingleRelayableDeliverable([{ role: "tool", content: wrapped }], 1)).toBeNull();
  });

  it("still relays a clean single deliverable", () => {
    expect(extractSingleRelayableDeliverable([{ role: "tool", content: wrapDelegate(DELIVERABLE) }], 1)).not.toBeNull();
  });
});

describe("line-level degenerate-repetition guard (audit 9a6a8c7f turn 2)", () => {
  // The slow 35B answered "Überarbeite den Plan" directly and looped one bold
  // paragraph ~15× with NO intervening headings — so the section-level detector saw
  // one unique block and shipped 11 KB of "… Nein." verbatim.
  function pdmLoop(repeats: number): string {
    const head = [
      "### 1. Mikrofon-Spezifikation (IM69D120V01XTSA1)",
      "- **Typ:** Digitales MEMS-Mikrofon (PDM).",
      "- **Schnittstelle:** PDM (1-Bit, 1,54 MHz typisch).",
      "",
      "### 2. Kritische Änderung",
      "Da das Mikrofon ein digitales PDM-Signal ausgibt, brauchst du keinen externen Sigma-Delta-ADC mehr.",
      "",
    ];
    const loop: string[] = [];
    for (let i = 0; i < repeats; i++) {
      loop.push("**Korrekte Komponente:** Der **TI PCM1808** ist ein ADC. Für PDM brauchst du einen **PDM-zu-I2S-Converter** wie den **TI PCM1864**? Nein.");
      loop.push("");
      loop.push("**Realistische Lösung:** Der **ESP32-S3** hat keine PDM-Eingänge. Du musst externe PDM-Decoder verwenden, z.B. den **TI PCM1808** nicht. Stattdessen: **MAX11300**? Nein.");
      loop.push("");
    }
    return [...head, ...loop].join("\n");
  }

  it("detects a paragraph-level loop the section detector misses", () => {
    expect(looksLikeDegenerateLineRepetition(pdmLoop(15))).toBe(true);
    expect(looksLikeDegenerateRepetition(pdmLoop(15))).toBe(true);
  });

  it("collapses the loop to one copy of each unique paragraph and is no longer degenerate", () => {
    const collapsed = collapseRepeatedMarkdownSections(pdmLoop(15));
    expect((collapsed.match(/Korrekte Komponente/g) ?? []).length).toBe(1);
    expect((collapsed.match(/Realistische Lösung/g) ?? []).length).toBe(1);
    expect(collapsed).toContain("Mikrofon-Spezifikation"); // genuine head content survives
    expect(collapsed.length).toBeLessThan(pdmLoop(15).length / 3);
    expect(looksLikeDegenerateRepetition(collapsed)).toBe(false);
  });

  it("leaves a clean, non-repeating answer untouched", () => {
    const clean = [
      "## Recommendation",
      "Switch to the digital PDM microphone and drop the external ADC entirely.",
      "The ESP32-S3 reads PDM directly on its I2S peripheral, so the BOM loses one chip.",
      "Power stays on the BQ25895; the waterproofing and enclosure plan are unchanged.",
      "Next: confirm the PDM clock budget and update the KiCad net for the I2S pins.",
    ].join("\n");
    expect(looksLikeDegenerateLineRepetition(clean)).toBe(false);
    expect(collapseRepeatedLines(clean)).toBe(clean);
  });
});

describe("cost center 1 — forced-orchestration tool allowlist (audit be828e39 + record_plan probe)", () => {
  it("keeps ONLY orchestration tools so a forced call must advance the turn", () => {
    const tools = [
      { name: "memory_store" },
      { name: "recall_context" },
      { name: "memory_search" },
      { name: "get_swarm_state" },
      { name: "record_plan" }, // the new escape hatch — must NOT satisfy the force
      { name: "delegate_to_agent" },
      { name: "parallel_delegate" },
      { name: "search_agents" },
      { name: "run_workflow" },
    ];
    const kept = filterForcedOrchestrationTools(tools).map((t) => t.name);
    expect(kept).toEqual(["delegate_to_agent", "parallel_delegate", "search_agents", "run_workflow"]);
    // The no-op tools the model looped on (memory_store, record_plan) are gone.
    expect(kept).not.toContain("memory_store");
    expect(kept).not.toContain("record_plan");
  });

  it("is an allowlist: a brand-new no-op tool is excluded by default", () => {
    const kept = filterForcedOrchestrationTools([
      { name: "some_future_noop_tool" },
      { name: "delegate_to_agent" },
    ]).map((t) => t.name);
    expect(kept).toEqual(["delegate_to_agent"]);
  });
});

describe("stripLeadingReasoningPreamble", () => {
  it("removes a meta lead-in followed by a horizontal rule", () => {
    expect(stripLeadingReasoningPreamble("Let me synthesize the findings.\n\n---\n\n## Title\nbody")).toBe("## Title\nbody");
  });
  it("removes a meta lead-in directly before a heading", () => {
    expect(stripLeadingReasoningPreamble("Based on the curated findings:\n\n## Title\nbody")).toBe("## Title\nbody");
  });
  it("leaves already-clean content untouched", () => {
    expect(stripLeadingReasoningPreamble("## Title\nbody")).toBe("## Title\nbody");
    expect(stripLeadingReasoningPreamble("| a | b |\n| - | - |")).toBe("| a | b |\n| - | - |");
  });
  it("does not strip genuine prose that merely starts a sentence", () => {
    const prose = "The recommended approach is to use a circular array. It maximises coverage.";
    expect(stripLeadingReasoningPreamble(prose)).toBe(prose);
  });
});

describe("lever #2 — relay the latest complete deliverable even after research ran", () => {
  const history = (...contents: string[]) => contents.map((content) => ({ role: "tool" as const, content }));

  it("returns the most-recent complete author deliverable when research delegations also ran", () => {
    const research = "Delegated result from researcher — TASK COMPLETED.\nObserved evidence:\n" + "ROUND evidence line. ".repeat(120);
    const authored = wrapDelegate(DELIVERABLE);
    const latest = tryExtractLatestCompleteDeliverable(history(research, authored), 800);
    expect(latest).not.toBeNull();
    expect(latest!.content).toBe(authored);
  });

  it("skips a PARTIAL or FAILED most-recent delegation", () => {
    const ok = wrapDelegate(DELIVERABLE);
    const partial = wrapDelegate(DELIVERABLE, { state: "PARTIAL PROGRESS." });
    // Most-recent is partial → it is skipped, and the earlier complete one is returned.
    const latest = tryExtractLatestCompleteDeliverable(history(ok, partial), 800);
    expect(latest).not.toBeNull();
    expect(latest!.content).toBe(ok);
    // Only a failed delegation present → nothing to relay.
    expect(tryExtractLatestCompleteDeliverable(history(wrapDelegate(DELIVERABLE, { state: "TASK FAILED." })), 800)).toBeNull();
  });

  it("ignores non-delegation tool output and short bodies", () => {
    expect(tryExtractLatestCompleteDeliverable(history("Content from: https://x  short page body"), 800)).toBeNull();
    expect(tryExtractLatestCompleteDeliverable(history(wrapDelegate("too short")), 800)).toBeNull();
  });
});

describe("cost center 3 — non-productive fetch detection", () => {
  it("flags failed fetches (404 / error)", () => {
    expect(fetchResultIsNonProductive(false, "404 Not Found final: https://x/y.pdf")).toBe(true);
  });
  it("flags successful-but-unextractable PDFs and error pages", () => {
    expect(fetchResultIsNonProductive(true, "Content from: https://x/y.pdf This URL is a PDF document and its text could not be extracted here.")).toBe(true);
    expect(fetchResultIsNonProductive(true, "Content from: https://x # Page Not Found | Infineon Technologies ...")).toBe(true);
    expect(fetchResultIsNonProductive(true, "429 Too Many Requests")).toBe(true);
  });
  it("flags near-empty successful fetches", () => {
    expect(fetchResultIsNonProductive(true, "ok")).toBe(true);
  });
  it("treats a real fetched page as productive", () => {
    const real = "Content from: https://www.adafruit.com/product/1901 Universal Qi Wireless Receiver Module. Output 4.8-5.2V at 500mA, coil 40x29mm, 93% peak efficiency. Datasheet specs and wiring details follow in the body of the page.";
    expect(fetchResultIsNonProductive(true, real)).toBe(false);
  });
});
