import { describe, expect, it } from "vitest";
import {
  deduplicateRunnableDelegations,
  normalizeDelegationBodyForDedup,
} from "../tools/sub-agent.js";

/**
 * audit 49372c7a: a source-sensitive turn fanned out 4 parallel "slices" that each carried
 * the FULL original request + an identical generic focus line, differing only by a
 * "SLICE n/4" marker and the (routing-only) routingQuery. All four redundantly researched
 * everything; on the single GPU the turn took ~17 min. deduplicateRunnableDelegations
 * collapses duplicate body+context tasks before dispatch so one piece of work runs once.
 */
const SLICE = (n: number) =>
  "WEB RESEARCH TASK — gather fresh sourced evidence from official primary sources.\n"
  + "Research the request below: use web_search and web_fetch to open the most authoritative sources.\n"
  + `SOURCE-SENSITIVE DELEGATION SLICE ${n}/4:\n`
  + "The user's original request below is the only canonical task. Search identifiers exactly as given.\n"
  + "Original user request:\nich möchte ein sehr portables, batterie powered aufnahmegerät bauen mit einem mic array (IM73A135V01) und esp32 ota sync, usb-c laden, wasserdicht.\n"
  + "Focus for this slice (generic only; still confirm every concrete claim from a source):\n"
  + "- gather and confirm every concrete fact this slice needs from authoritative sources.";

describe("normalizeDelegationBodyForDedup", () => {
  it("makes slices that differ only by SLICE marker / focus compare equal", () => {
    expect(normalizeDelegationBodyForDedup(SLICE(1))).toBe(normalizeDelegationBodyForDedup(SLICE(4)));
  });

  it("keeps genuinely distinct bodies distinct", () => {
    const a = normalizeDelegationBodyForDedup("Research the MEMS microphone IM73A135V01 datasheet specs and SNR.");
    const b = normalizeDelegationBodyForDedup("Research USB-C LiPo charging modules and wireless Qi receivers.");
    expect(a).not.toBe(b);
  });
});

describe("deduplicateRunnableDelegations", () => {
  it("collapses the audit-49372c7a same-agent identical slices (3x researcher -> 1), keeps the coordinator", () => {
    const tasks = [
      { agentName: "researcher", task: SLICE(1) },
      { agentName: "researcher", task: SLICE(2) },
      { agentName: "researcher", task: SLICE(3) },
      { agentName: "mission_coordinator", task: SLICE(4) },
    ];
    const { kept, removed } = deduplicateRunnableDelegations(tasks);
    // 3 identical "researcher" slices collapse to 1; the different-agent coordinator is kept.
    expect(kept).toHaveLength(2);
    expect(removed).toBe(2);
    expect(kept.map((k) => k.agentName)).toEqual(["researcher", "mission_coordinator"]);
  });

  it("KEEPS identical bodies on DIFFERENT agents (legitimate capped decomposition)", () => {
    // This is the source-sensitive cap shape the runtime tests rely on: distinct agents,
    // identical canonical body — different specialists may surface different findings.
    const tasks = [
      { agentName: "researcher_a", task: SLICE(1) },
      { agentName: "researcher_b", task: SLICE(2) },
      { agentName: "researcher_c", task: SLICE(3) },
    ];
    const { kept, removed } = deduplicateRunnableDelegations(tasks);
    expect(kept).toHaveLength(3);
    expect(removed).toBe(0);
  });

  it("collapses pure duplicates (same agent, identical body)", () => {
    const tasks = [
      { agentName: "researcher", task: SLICE(1) },
      { agentName: "researcher", task: SLICE(2) },
    ];
    const { kept, removed } = deduplicateRunnableDelegations(tasks);
    expect(kept).toHaveLength(1);
    expect(removed).toBe(1);
  });

  it("collapses NEAR-duplicates that differ by a word or two (audit d20a9a5e)", () => {
    // The slow 35B paraphrased its own copy: "and we can make a sync button" vs
    // "and and make a sync button". Exact-match dedup missed it, so the 2nd researcher
    // slice survived to routing and got bid-redirected to image_sourcer (~11 min wasted).
    const base =
      "WEB RESEARCH TASK — gather fresh sourced evidence from official primary sources.\n"
      + "SOURCE-SENSITIVE DELEGATION SLICE 1/2:\nOriginal user request:\n"
      + "ich möchte ein sehr portables batterie powered aufnahmegerät bauen mit einem mic array IM73A135V01 "
      + "und esp32 ota sync usb-c laden wasserdicht. we can have a record button so the device dont have to be "
      + "powered on the whole time AND_SYNC make a sync button which brings it into the sync mode.";
    const variantA = { agentName: "researcher", task: base.replace("AND_SYNC", "and we can") };
    const variantB = { agentName: "researcher", task: base.replace("AND_SYNC", "and") };
    const { kept, removed } = deduplicateRunnableDelegations([variantA, variantB]);
    expect(kept).toHaveLength(1);
    expect(removed).toBe(1);
  });

  it("preserves a genuine multi-topic decomposition (distinct bodies)", () => {
    const tasks = [
      { agentName: "researcher", task: "Research the MEMS microphone IM73A135V01 datasheet specs, SNR, package, interface and confirm each from official sources." },
      { agentName: "researcher", task: "Research ESP32-S3 low-power audio recording, I2S/PDM pins, deep-sleep current and confirm each from official sources." },
      { agentName: "researcher", task: "Research USB-C LiPo charging modules, protection ICs and Qi wireless receivers and confirm each from official sources." },
    ];
    const { kept, removed } = deduplicateRunnableDelegations(tasks);
    expect(kept).toHaveLength(3);
    expect(removed).toBe(0);
  });

  it("treats same body but DIFFERENT context as distinct", () => {
    const body = "Analyze the attached dataset and report the three largest anomalies with their row indices and magnitudes for review.";
    const tasks = [
      { agentName: "coder", task: body, context: "dataset: north-region sales Q1" },
      { agentName: "coder", task: body, context: "dataset: south-region sales Q1" },
    ];
    const { kept, removed } = deduplicateRunnableDelegations(tasks);
    expect(kept).toHaveLength(2);
    expect(removed).toBe(0);
  });

  it("never merges trivially-short bodies (below the substance threshold)", () => {
    const tasks = [
      { agentName: "researcher", task: "weather Berlin" },
      { agentName: "researcher", task: "weather Berlin" },
    ];
    const { kept, removed } = deduplicateRunnableDelegations(tasks);
    expect(kept).toHaveLength(2);
    expect(removed).toBe(0);
  });
});
