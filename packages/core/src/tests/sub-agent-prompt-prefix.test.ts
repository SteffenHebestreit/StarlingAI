import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { composeSubAgentMessages } from "../agent/sub-agent-history.js";
import type { LLMMessage } from "../providers/lmstudio.js";

const SYSTEM = "You are the researcher. Gather evidence and cite it.";
const history: LLMMessage[] = [
  { role: "user", content: "Find the opening hours." },
  { role: "assistant", content: "Searching." },
];

const leadingRun = (messages: LLMMessage[]): string => {
  const run: string[] = [];
  for (const m of messages) {
    if (m.role !== "system") break;
    run.push(String(m.content));
  }
  return run.join("\n\n");
};

/**
 * THE SUB-AGENT'S HEAD IS A CACHE KEY TOO.
 *
 * Wave A made the orchestrator's leading system run byte-identical across a turn's iterations.
 * This loop — where most of a delegating turn's iterations actually run — kept appending its
 * budget, deadline and velocity nudges onto the system message, so the prefix was thrown away
 * whenever one appeared or vanished. Measured on a 24,731-token sub-agent context: unchanged head
 * 0.33 s; the same request with the budget warning appended to the system message 41.29 s; the
 * identical text as a trailing message 0.87 s.
 */
describe("composeSubAgentMessages — where an iteration's nudges go", () => {
  it("keeps the leading system run identical whatever the nudges are", () => {
    const quiet = composeSubAgentMessages(SYSTEM, history, []);
    const warned = composeSubAgentMessages(SYSTEM, history, ["⚠️ BUDGET WARNING: 2 iterations remain."]);
    const latched = composeSubAgentMessages(SYSTEM, history, ["⚠️ SOFT DEADLINE REACHED: wrap up."]);
    expect(leadingRun(quiet)).toBe(SYSTEM);
    expect(leadingRun(warned)).toBe(SYSTEM);          // the appearing latch
    expect(leadingRun(latched)).toBe(SYSTEM);         // and the one that replaced it
  });

  it("still delivers every nudge — after the history, as the most recent instruction", () => {
    const out = composeSubAgentMessages(SYSTEM, history, ["FIRST", "SECOND"]);
    expect(out.map((m) => m.content)).toEqual([
      SYSTEM, "Find the opening hours.", "Searching.", "FIRST\n\nSECOND",
    ]);
  });

  it("adds no trailing message when there is nothing to say", () => {
    expect(composeSubAgentMessages(SYSTEM, history, [])).toHaveLength(3);
    expect(composeSubAgentMessages(SYSTEM, history, ["", "   "])).toHaveLength(3);
  });
});

describe("the sub-agent loop no longer mutates its own head", () => {
  it("appends no nudge onto the system prompt", () => {
    const src = readFileSync(fileURLToPath(new URL("../agent/sub-agent.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/effectiveSystemPrompt\s*\+=/);
    expect(src).toContain("composeSubAgentMessages(systemPrompt, history, iterationNudges)");
    // The nudges still count against the input bound — only their position changed.
    expect(src).toContain("systemPromptChars: systemPrompt.length + nudgeMessage.length");
  });
});
