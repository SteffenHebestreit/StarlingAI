import { describe, expect, it } from "vitest";
import {
  shouldCheckDeliverableConsistency,
  collectUserStatements,
  buildDeliverableConsistencyCheckMessages,
  buildDeliverableConsistencyRepairInstruction,
  DELIVERABLE_CONSISTENCY_CRITERION,
  DELIVERABLE_CONSISTENCY_MIN_CHARS,
} from "../agent/deliverable-consistency.js";
import { parseQaVerdict, runQaDeliveryLoop } from "../agent/qa-delivery-loop.js";

/**
 * Deliverable self-consistency gate (audit 17f53ed0): a plan-less price quote recommended
 * 10k for ~10 weeks while itself citing a 90–120 €/h market rate (≈37 €/h) — internally
 * contradictory, no plan, so the acceptance-criteria QA gates never ran. The pure pieces
 * (trigger, prompts, parser interplay) are verifiable without a provider.
 */
const longAnswer = "x".repeat(DELIVERABLE_CONSISTENCY_MIN_CHARS);

describe("shouldCheckDeliverableConsistency", () => {
  const base = { enabled: true, aborted: false, finalResponse: longAnswer, acceptanceCriteriaQaRan: false, delegationCount: 1 };

  it("fires for a substantive plan-less deliverable synthesized from real work", () => {
    expect(shouldCheckDeliverableConsistency(base)).toBe(true);
  });

  it("is OFF by default (flag disabled)", () => {
    expect(shouldCheckDeliverableConsistency({ ...base, enabled: false })).toBe(false);
  });

  it("skips when an acceptance-criteria QA already ran (no double slow-model cost)", () => {
    expect(shouldCheckDeliverableConsistency({ ...base, acceptanceCriteriaQaRan: true })).toBe(false);
  });

  it("skips a turn that did no delegation (long pure-chat / refusal / clarification — not a synthesized deliverable)", () => {
    expect(shouldCheckDeliverableConsistency({ ...base, delegationCount: 0 })).toBe(false);
  });

  it("skips a short answer (not a real deliverable) and an aborted turn", () => {
    expect(shouldCheckDeliverableConsistency({ ...base, finalResponse: "ok, done." })).toBe(false);
    expect(shouldCheckDeliverableConsistency({ ...base, aborted: true })).toBe(false);
  });
});

describe("collectUserStatements", () => {
  it("collects user-role messages newest-last, ignoring assistant/tool and non-string content", () => {
    const history = [
      { role: "user", content: "10 Wochen für max 12k" },
      { role: "assistant", content: "here is the quote" },
      { role: "tool", content: "evidence" },
      { role: "user", content: "marktüblich ~90€/h" },
      { role: "user", content: { not: "a string" } },
    ];
    const out = collectUserStatements(history, 2000);
    expect(out).toBe("10 Wochen für max 12k\n---\nmarktüblich ~90€/h");
  });

  it("caps to the tail (most recent) at maxChars", () => {
    const history = [{ role: "user", content: "A".repeat(50) }, { role: "user", content: "B".repeat(50) }];
    const out = collectUserStatements(history, 30);
    expect(out.length).toBe(30);
    expect(out.endsWith("B")).toBe(true); // kept the most recent tail
  });
});

describe("buildDeliverableConsistencyCheckMessages", () => {
  it("audits internal + user-stated consistency and asks for a PASS/FAIL verdict (parseQaVerdict-compatible)", () => {
    const msgs = buildDeliverableConsistencyCheckMessages(
      "Empfehlung: 10.000 € für 10 Wochen. Marktüblich sind 90–120 €/h.",
      "10 Wochen für max 12k\n---\nmarktüblich ~90€/h",
    );
    const sys = msgs.find((m) => m.role === "system")!.content as string;
    const user = msgs.find((m) => m.role === "user")!.content as string;
    expect(sys).toMatch(/consistency auditor/i);
    expect(sys).toMatch(/do NOT rewrite|do not rewrite/i);
    expect(sys).toMatch(/arithmetic/i); // checks rate × time = total
    expect(user).toContain("90–120 €/h"); // the deliverable is included
    expect(user).toContain("10 Wochen für max 12k"); // the user's stated facts are included
    expect(user).toContain("PASS");
    expect(user).toMatch(/FAIL:/);
    // Red-team fix A: legitimate tiers/phases/line-items and EU number formats are not contradictions.
    expect(sys).toMatch(/tiers, options, phases, line items, or scenarios are NOT contradictions/);
    expect(sys).toMatch(/SUM correctly/);
    expect(sys).toMatch(/8\.000–12\.000 € is ONE range/);
    // The verdict vocabulary round-trips through the existing parser.
    expect(parseQaVerdict("PASS").pass).toBe(true);
    expect(parseQaVerdict("FAIL: recommends 10k for ~10 weeks at a stated 90-120€/h rate (≈37€/h)").pass).toBe(false);
  });

  it("handles no user-stated facts (internal-only audit)", () => {
    const user = buildDeliverableConsistencyCheckMessages("Some deliverable.", "").find((m) => m.role === "user")!.content as string;
    expect(user).toMatch(/INTERNAL contradictions only/i);
  });
});

describe("buildDeliverableConsistencyRepairInstruction", () => {
  it("fixes ONLY the named contradictions and recomputes dependent totals", () => {
    const instr = buildDeliverableConsistencyRepairInstruction("10k for 10 weeks contradicts the stated 90€/h rate");
    expect(instr).toContain("10k for 10 weeks contradicts the stated 90€/h rate");
    expect(instr).toMatch(/Fix ONLY these/);
    expect(instr).toMatch(/Recompute any dependent totals/i);
    expect(instr).toMatch(/Do NOT invent/i);
    // Red-team fix B: a false-fire must not collapse legitimate structure/caveats.
    expect(instr).toMatch(/Do NOT collapse tiers, options, phases, or line-item breakdowns/);
    expect(instr).toMatch(/do NOT remove caveats/);
  });
});

describe("consistency gate wiring (runQaDeliveryLoop with the consistency criterion)", () => {
  const bad = "Empfehlung: 10.000 € für 10 Wochen Arbeit (Marktrate 90–120 €/h).";
  const fixed = "Empfehlung: ~36.000 € für 10 Wochen Arbeit bei 90 €/h (40h/Woche).".padEnd(bad.length, " ");
  const mkDeps = (counter: { n: number }) => ({
    check: async (a: string) => {
      counter.n += 1;
      // The contradictory answer fails; the repaired one is consistent.
      return a.includes("10.000") ? parseQaVerdict("FAIL: 10k for 10 weeks at 90€/h implies ~37€/h") : parseQaVerdict("PASS");
    },
    improve: async () => fixed,
  });

  it("at the default 1 round: repairs the inconsistency and ships the fix (no extra re-check call)", async () => {
    const c = { n: 0 };
    const result = await runQaDeliveryLoop(bad, [DELIVERABLE_CONSISTENCY_CRITERION], { ...mkDeps(c), maxRounds: 1 });
    expect(result.answer).toBe(fixed); // the corrected, consistent answer ships
    expect(c.n).toBe(1); // one check, then repair — budget spent, no confirming re-check
  });

  it("with a second round, re-checks the repair and confirms PASS", async () => {
    const c = { n: 0 };
    const result = await runQaDeliveryLoop(bad, [DELIVERABLE_CONSISTENCY_CRITERION], { ...mkDeps(c), maxRounds: 2 });
    expect(result.answer).toBe(fixed);
    expect(result.passed).toBe(true);
    expect(c.n).toBe(2); // checked → failed → improved → re-checked → passed
  });

  it("fails OPEN (ships the original) when the check throws", async () => {
    const result = await runQaDeliveryLoop("an answer", [DELIVERABLE_CONSISTENCY_CRITERION], {
      check: async () => { throw new Error("verdict model down"); },
      improve: async () => "should not be used",
      maxRounds: 1,
    });
    expect(result.answer).toBe("an answer");
    expect(result.passed).toBe(true);
  });
});
