import { describe, expect, it } from "vitest";
import { buildFactsFirstSynthesisMessages } from "../agent/sub-agent.js";

/**
 * Facts-first synthesis (audit 1dc806bf): the forced-synthesis passes used to
 * feed the model the full ~20K-token raw history, which the slow 35B failed to
 * synthesize ("produced no final response" even unbounded). The fix builds the
 * synthesis prompt from the compact CURATED FINDINGS instead. This locks the
 * prompt shape: task + findings as the source material, with anti-fabrication
 * and no-tools instructions.
 */
describe("buildFactsFirstSynthesisMessages", () => {
  const task = "Design a portable ESP32 audio recorder with the IM73A135V01 mic and give a BOM.";
  const findings = "- IM73A135V01: Infineon analog MEMS mic, 73 dB(A) SNR, IP57 (Source: infineon.com)\n- ESP32-S3 has two I2S peripherals (Source: docs.espressif.com)";

  it("puts the task and curated findings into the prompt as the source material", () => {
    const msgs = buildFactsFirstSynthesisMessages(task, findings);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[1]!.role).toBe("user");
    const user = String(msgs[1]!.content);
    expect(user).toContain(task);
    expect(user).toContain("IM73A135V01: Infineon analog MEMS mic");
    expect(user).toContain("docs.espressif.com");
    expect(user).toMatch(/CURATED FINDINGS/i);
  });

  it("instructs the model to write the answer, not call tools, and not fabricate", () => {
    const sys = String(buildFactsFirstSynthesisMessages(task, findings)[0]!.content);
    expect(sys).toMatch(/final answer/i);
    expect(sys).toMatch(/do NOT call any tools/i);
    expect(sys).toMatch(/never invent|unverified/i);
    // Anti-conflation: don't transfer a spec from one component to another.
    expect(sys).toMatch(/never carry a spec from one component/i);
  });

  it("does NOT carry raw conversation history (the input the 35B chokes on)", () => {
    // The whole point: the synthesis input is task + findings only.
    const msgs = buildFactsFirstSynthesisMessages(task, findings);
    const joined = msgs.map((m) => String(m.content)).join("\n");
    expect(joined).not.toContain("Web Search Results for:");
    expect(joined).not.toContain("Page state");
  });
});
