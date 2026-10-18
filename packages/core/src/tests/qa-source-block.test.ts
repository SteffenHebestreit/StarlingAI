import { describe, expect, it } from "vitest";
import { buildQaVerdictInstruction, QA_DISCLOSURE_VERDICT_RULE } from "../agent/qa-delivery-loop.js";
import { formatQaSourceBlock, QA_SOURCE_FOOTER, QA_SOURCE_HEADER, type SourceHistoryMessage } from "../agent/qa-source-block.js";
import { PLAN_CLOSING_ALL_RAN, PLAN_RESULTS_HEADING } from "../agent/runtime-evidence-dump.js";

const call = (id: string, name: string) => ({ role: "assistant", content: null, tool_calls: [{ id, function: { name } }] });
const result = (id: string, content: string, metadata?: Record<string, unknown>): SourceHistoryMessage => ({
  role: "tool", tool_call_id: id, content, ...(metadata ? { metadata } : {}),
});
const MAIL = "Reisekosten Workshop Hamburg (02.10.2026): ausfüllen und zurücksenden; Anhang Reisekosten.pdf (403 KB), vermutlich das Reisekostenformular.";
const delegated = (agent: string, evidence: string) => [
  `Delegated result from ${agent} — TASK COMPLETED.`,
  "IMPORTANT: Relay ALL specific details from the evidence below (names, numbers, values) in your answer.",
  "Observed evidence:",
  `[${agent}]: ${evidence}`,
].join("\n");

describe("formatQaSourceBlock", () => {
  it("carries the specialist's evidence without the relay frame, under the header and footer", () => {
    const block = formatQaSourceBlock([
      { role: "user", content: "fasse die mails zusammen" },
      call("d1", "delegate_to_agent"),
      result("d1", delegated("mail_agent", MAIL), { agentName: "mail_agent" }),
    ]);
    expect(block).toBe([QA_SOURCE_HEADER, `[mail_agent]\n${MAIL}`, QA_SOURCE_FOOTER].join("\n"));
  });

  it("takes a plan's step results and none of the executor's instructions", () => {
    const report = `Plan recorded (1 step) and EXECUTED.\n\nCOMPLETED:\n  - s1 (delegate) Mails lesen\n\n${PLAN_RESULTS_HEADING}\n\n[s1] Mails lesen\n[mail_agent]: ${MAIL}\n\n${PLAN_CLOSING_ALL_RAN}`;
    const block = formatQaSourceBlock([
      { role: "user", content: "fasse die mails zusammen" },
      call("p1", "record_plan"),
      result("p1", report, { planExecution: true, reportedResultIds: ["s1"] }),
    ]);
    expect(block).toContain(MAIL);
    expect(block).not.toContain("EXECUTED");
    expect(block).not.toContain(PLAN_CLOSING_ALL_RAN);
  });

  it("leaves out an earlier turn, routing tools and a plan with no results", () => {
    const block = formatQaSourceBlock([
      { role: "user", content: "erste frage" },
      call("old", "delegate_to_agent"),
      result("old", delegated("researcher", "an earlier turn's finding")),
      { role: "user", content: "zweite frage" },
      call("s", "search_agents"),
      result("s", "Agents matching: mail_agent, document_intake"),
      call("p", "record_plan"),
      result("p", "Plan recorded (1 step, risk: low)."),
      call("d", "delegate_to_agent"),
      result("d", delegated("mail_agent", MAIL), { agentName: "mail_agent" }),
    ]);
    expect(block).toContain(MAIL);
    expect(block).not.toContain("an earlier turn's finding");
    expect(block).not.toContain("Agents matching");
    expect(block).not.toContain("Plan recorded");
  });

  it("is empty when the turn's tools returned nothing, and when the results do not fit the budget", () => {
    expect(formatQaSourceBlock([{ role: "user", content: "hallo" }])).toBe("");
    const turn = [
      { role: "user", content: "fasse zusammen" },
      call("d1", "delegate_to_agent"),
      result("d1", delegated("mail_agent", MAIL), { agentName: "mail_agent" }),
    ];
    // A reviewer shown half the source would read every fact from the other half as invented.
    expect(formatQaSourceBlock(turn, { maxChars: 40 })).toBe("");
    expect(formatQaSourceBlock(turn, { maxChars: 4_000 })).not.toBe("");
  });
});

describe("the QA verdict eval's scenarios", () => {
  it("each yield a source block the verdict can check the answers against", async () => {
    const { QA_VERDICT_EVAL_SCENARIOS } = await import("../agent/qa-verdict-eval-scenarios.js");
    expect(QA_VERDICT_EVAL_SCENARIOS.length).toBeGreaterThanOrEqual(6);
    for (const scenario of QA_VERDICT_EVAL_SCENARIOS) {
      const block = formatQaSourceBlock(scenario.history);
      expect(block, scenario.name).toContain(QA_SOURCE_HEADER);
      expect(block, scenario.name).not.toContain("Relay ALL specific details");
      expect(block, scenario.name).not.toContain(PLAN_CLOSING_ALL_RAN);
      for (const answer of Object.values(scenario.answers)) expect(answer!.length, scenario.name).toBeGreaterThan(10);
    }
  });
});

describe("buildQaVerdictInstruction", () => {
  const input = { criteria: ["names both mails", "is correct"], answer: "ANSWER TEXT", requireEvidence: true, turnRecordBlock: "\nTURN RECORD" };

  it("without a source is the instruction the runtime sent before it was extracted", () => {
    // The inline instruction from runtime.ts runQaDeliveryGate's check, as it stood at b5475756.
    const before = [
      "You are a strict QA reviewer. Judge ONLY whether the ANSWER below satisfies EVERY acceptance criterion for the user's task. Do not rewrite it.",
      "Acceptance criteria:",
      "1. names both mails",
      "2. is correct",
      "\nTURN RECORD",
      "",
      "ANSWER:",
      "ANSWER TEXT",
      "",
      "Reply on a SINGLE line. If every criterion is fully met and the answer is internally consistent, reply exactly: PASS — evidence: <one concrete verifiable fact from the answer's tool results / artifacts that proves the criteria are met>. A PASS with no such concrete evidence will NOT be trusted.",
      "Also FAIL when the answer reveals work OUTSIDE the task's declared scope (unrequested changes, drive-by refactors, 'improvements' nobody asked for) or shows debug leftovers in the deliverable (debug prints, placeholder text, commented-out scraps) — name the out-of-scope item or leftover.",
      QA_DISCLOSURE_VERDICT_RULE,
      "Otherwise reply: FAIL: <one concise sentence naming each unmet criterion / concrete flaw>.",
    ].join("\n");
    expect(buildQaVerdictInstruction(input)).toBe(before);
  });

  it("puts the source after the answer, before the verdict rules", () => {
    const text = buildQaVerdictInstruction({ ...input, sourceBlock: "SOURCE BLOCK" });
    expect(text.indexOf("SOURCE BLOCK")).toBeGreaterThan(text.indexOf("ANSWER TEXT"));
    expect(text.indexOf("SOURCE BLOCK")).toBeLessThan(text.indexOf("Reply on a SINGLE line"));
  });
});
