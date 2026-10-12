import { describe, expect, it, vi } from "vitest";
import {
  runQaDeliveryLoop, parseQaVerdict, verdictHasEvidence, type QaDeliveryDeps, qaRequiresEvidence,
  buildQaImproveInstruction, buildCriteriaVerifyInstruction, currentAnswerBlock, qaFlawsForAudit,
  answerFitsRepair, answerRepairMaxChars, QA_DISCLOSURE_RULE, QA_ACTION_HONESTY_RULE,
} from "../agent/qa-delivery-loop.js";
import { BUILTIN_EFFORT_PROFILES, runWithEffortContext } from "../runtime/effort-context.js";

const CRITERIA = ["names a winner", "cites sources"];

function deps(over: Partial<QaDeliveryDeps>): QaDeliveryDeps {
  return {
    check: async () => ({ pass: true }),
    improve: async (a) => a + " (improved)",
    maxRounds: 2,
    ...over,
  };
}

describe("runQaDeliveryLoop", () => {
  it("ships immediately with no criteria (nothing to check)", async () => {
    const check = vi.fn();
    const r = await runQaDeliveryLoop("answer", [], deps({ check }));
    expect(r).toEqual({ answer: "answer", rounds: 0, passed: true, status: "unverified", escalated: false, unverified: false });
    expect(check).not.toHaveBeenCalled();
  });

  it("ships immediately when the first check passes (no improvement round)", async () => {
    const improve = vi.fn();
    const r = await runQaDeliveryLoop("good", CRITERIA, deps({ check: async () => ({ pass: true }), improve }));
    expect(r.rounds).toBe(0);
    expect(r.passed).toBe(true);
    expect(r.answer).toBe("good");
    expect(improve).not.toHaveBeenCalled();
  });

  it("loops back to improve on failure, then ships once it passes", async () => {
    let calls = 0;
    const r = await runQaDeliveryLoop("v0", CRITERIA, deps({
      check: async () => ({ pass: ++calls > 1, flaws: "missing sources" }), // fail 1st, pass 2nd
      improve: async () => "v1-fixed",
      maxRounds: 3,
    }));
    expect(r.rounds).toBe(1);
    expect(r.passed).toBe(true);
    expect(r.answer).toBe("v1-fixed");
  });

  it("stops at maxRounds and ships the best-so-far answer", async () => {
    const r = await runQaDeliveryLoop("v0", CRITERIA, deps({
      check: async () => ({ pass: false, flaws: "still wrong" }),
      improve: async (a) => a + "+",
      maxRounds: 2,
    }));
    expect(r.rounds).toBe(2);
    expect(r.answer).toBe("v0++"); // two improvement passes applied
  });

  it("does NOT spend an extra check call on the exhausted budget (check runs exactly maxRounds times)", async () => {
    const check = vi.fn(async () => ({ pass: false, flaws: "still wrong" }));
    const r = await runQaDeliveryLoop("v0", CRITERIA, deps({ check, improve: async (a) => a + "+", maxRounds: 2 }));
    expect(check).toHaveBeenCalledTimes(2); // one per round, no wasted post-loop verification call
    expect(r.passed).toBe(false); // never got a confirming PASS within budget
  });

  it("fails OPEN: a thrown check ships the current answer as unverified under strict mode (never blocks delivery)", async () => {
    const r = await runQaDeliveryLoop("answer", CRITERIA, deps({ check: async () => { throw new Error("model down"); }, strict: true }));
    expect(r.passed).toBe(false);        // nobody judged it — it ships, but it did not pass
    expect(r.noVerdict).toBe(true);
    expect(r.answer).toBe("answer");
    expect(r.status).toBe("unverified");
    expect(r.unverified).toBe(true);
  });

  it("fails OPEN: a thrown check ships uncaveated in legacy mode, but the status stays truthful", async () => {
    const r = await runQaDeliveryLoop("answer", CRITERIA, deps({ check: async () => { throw new Error("model down"); } }));
    expect(r.passed).toBe(false);
    expect(r.noVerdict).toBe(true);
    expect(r.status).toBe("unverified"); // truth for scorecards
    expect(r.unverified).toBe(false);    // legacy policy: no caveat without qaStrictVerdicts
  });

  it("stops and ships the prior answer when improvement yields nothing", async () => {
    const r = await runQaDeliveryLoop("v0", CRITERIA, deps({
      check: async () => ({ pass: false, flaws: "x" }),
      improve: async () => "",
      maxRounds: 3,
    }));
    expect(r.answer).toBe("v0");
    expect(r.passed).toBe(false);
    expect(r.escalated).toBe(false);
  });
});

describe("runQaDeliveryLoop — coordinator escalation (staged-orchestration fidelity)", () => {
  it("escalates ONLY after a cheap improve round already failed the re-check", async () => {
    const improve = vi.fn(async (a: string) => a + " (reworded)");      // round 0 (cheap)
    const escalate = vi.fn(async () => "rebuilt-by-coordinator");        // round 1 (heavy)
    const r = await runQaDeliveryLoop("v0", CRITERIA, deps({
      check: async () => ({ pass: false, flaws: "criterion 2 needs a real BOM" }), // always fails
      improve, escalate, maxRounds: 2,
    }));
    // round 0 → improve (re-word), re-check still fails → round 1 → escalate
    expect(improve).toHaveBeenCalledTimes(1);
    expect(escalate).toHaveBeenCalledTimes(1);
    expect(r.escalated).toBe(true);
    expect(r.answer).toBe("rebuilt-by-coordinator");
  });

  it("never escalates when a cheap re-synthesis round fixes the answer first", async () => {
    let calls = 0;
    const escalate = vi.fn(async () => "coordinator-output");
    const r = await runQaDeliveryLoop("v0", CRITERIA, deps({
      check: async () => ({ pass: ++calls > 1, flaws: "missing sources" }), // fail then pass
      improve: async () => "v1-fixed",
      escalate, maxRounds: 3,
    }));
    expect(escalate).not.toHaveBeenCalled();
    expect(r.escalated).toBe(false);
    expect(r.answer).toBe("v1-fixed");
  });

  it("passes the unmet criteria through to the escalation (coordinator gets the full target)", async () => {
    const escalate = vi.fn(async () => "fixed");
    await runQaDeliveryLoop("v0", CRITERIA, deps({
      check: async () => ({ pass: false, flaws: "criterion 1 unmet" }),
      improve: async (a) => a, // produces something so the loop reaches round 1
      escalate, maxRounds: 2,
    }));
    expect(escalate).toHaveBeenCalledWith("v0", "criterion 1 unmet", CRITERIA);
  });

  it("without an escalate dep, behaves exactly as the cheap improve-only loop (backward compatible)", async () => {
    const r = await runQaDeliveryLoop("v0", CRITERIA, deps({
      check: async () => ({ pass: false, flaws: "still wrong" }),
      improve: async (a) => a + "+",
      maxRounds: 2,
    }));
    expect(r.escalated).toBe(false);
    expect(r.answer).toBe("v0++"); // two improve passes, no escalation
  });

  it("escalation failing (null) ships the best answer so far, fail-open", async () => {
    const r = await runQaDeliveryLoop("v0", CRITERIA, deps({
      check: async () => ({ pass: false, flaws: "x" }),
      improve: async () => "v1",
      escalate: async () => null, // coordinator returned nothing usable
      maxRounds: 2,
    }));
    expect(r.answer).toBe("v1"); // keeps the cheap-round result rather than blocking
    expect(r.passed).toBe(false);
  });
});

describe("parseQaVerdict (runtime verdict parser)", () => {
  it("reads a verdict the reviewer formatted, and marks no verdict only when there is none", () => {
    // With reasoning off the reviewer formats more; these read as "no verdict" and inflated the
    // rate the change was meant to measure (review of the thinking-off verdicts, R1).
    expect(parseQaVerdict("**PASS** — evidence: file has 3 rows")).toEqual({ status: "pass", pass: true, evidence: "file has 3 rows" });
    expect(parseQaVerdict("Verdict: PASS — evidence: the chart has 4 bars")).toEqual({ status: "pass", pass: true, evidence: "the chart has 4 bars" });
    for (const bare of ["`PASS`", "✅ PASS", "Result: PASS", "Some prose, then PASS"]) {
      expect(parseQaVerdict(bare), bare).toEqual({ status: "unverified", pass: true });
    }
    expect(parseQaVerdict("**FAIL**: no chart")).toEqual({ status: "fail", pass: false, flaws: "no chart" });
    expect(parseQaVerdict("Ergebnis: FAIL – fehlt")).toEqual({ status: "fail", pass: false, flaws: "fehlt" });
    expect(parseQaVerdict("I think it is fine")).toEqual({ status: "unverified", pass: true, noVerdict: true });
  });

  it("marks bare or non-contract PASS output as unverified", () => {
    expect(parseQaVerdict("PASS")).toEqual({ status: "unverified", pass: true });
    expect(parseQaVerdict("  pass — all criteria met  ")).toEqual({ status: "unverified", pass: true });
  });

  it("fails and extracts the flaws after FAIL:", () => {
    expect(parseQaVerdict("FAIL: missing sources; no winner named")).toEqual({
      status: "fail",
      pass: false,
      flaws: "missing sources; no winner named",
    });
  });

  it("fails even when FAIL appears mid-line, capturing from FAIL onward", () => {
    const v = parseQaVerdict("Verdict - FAIL: criterion 2 unmet");
    expect(v.pass).toBe(false);
    expect(v.flaws).toBe("criterion 2 unmet");
  });

  it("fails with a default flaw message when FAIL has no detail", () => {
    expect(parseQaVerdict("FAIL")).toEqual({ status: "fail", pass: false, flaws: "One or more acceptance criteria are unmet." });
  });

  it("fails OPEN for delivery but marks empty or malformed reviewer noise unverified — and as no verdict", () => {
    expect(parseQaVerdict("")).toEqual({ status: "unverified", pass: true, noVerdict: true });
    expect(parseQaVerdict("   \n ")).toEqual({ status: "unverified", pass: true, noVerdict: true });
    expect(parseQaVerdict("hmm, hard to say")).toEqual({ status: "unverified", pass: true, noVerdict: true });
    // A bare PASS is a verdict without its evidence, not an absent one.
    expect(parseQaVerdict("PASS").noVerdict).toBeUndefined();
    expect(parseQaVerdict("FAIL: x").noVerdict).toBeUndefined();
  });

  it("captures a PASS — evidence: <ground> justification, but a bare PASS carries none", () => {
    const withEv = parseQaVerdict("PASS — evidence: the served app returned HTTP 200 on /api/health");
    expect(withEv.pass).toBe(true);
    expect(withEv.status).toBe("pass");
    expect(withEv.evidence).toBe("the served app returned HTTP 200 on /api/health");
    expect(verdictHasEvidence(withEv)).toBe(true);
    // accepts the parenthetical and colon shapes too
    expect(parseQaVerdict("PASS (evidence: file quiz.html has a closing </html> tag)").evidence)
      .toBe("file quiz.html has a closing </html> tag");
    // a bare PASS (or unparseable pass) has no evidence and is not verified
    expect(verdictHasEvidence(parseQaVerdict("PASS"))).toBe(false);
    expect(parseQaVerdict("PASS").status).toBe("unverified");
    expect(verdictHasEvidence(parseQaVerdict("looks fine to me"))).toBe(false);
    expect(parseQaVerdict("looks fine to me").status).toBe("unverified");
    // a FAIL is unaffected by the evidence branch
    expect(parseQaVerdict("FAIL: no evidence of a winner").pass).toBe(false);
  });

  it("a leading-PASS verdict stays a PASS even when its evidence tail contains 'fail' (regression)", () => {
    // Evidence-bearing verdicts routinely mention fail/failures/failed — the parser must not
    // flip them to FAIL on a bare substring match. A leading PASS is a pass regardless of tail.
    for (const v of [
      "PASS — evidence: the test suite reported 0 failures",
      "PASS — evidence: served app returned 0 failed requests",
      "PASS — evidence: the build did not fail and all 10 questions render",
    ]) {
      const parsed = parseQaVerdict(v);
      expect(parsed.pass).toBe(true);
      expect(verdictHasEvidence(parsed)).toBe(true);
    }
    // A real FAIL (not leading with PASS) is still detected, incl. after a prefix.
    expect(parseQaVerdict("FAIL: app crashes on load").pass).toBe(false);
    expect(parseQaVerdict("Verdict - FAIL: criterion 2 unmet").pass).toBe(false);
    // "failures" without a leading PASS or a FAIL token does not false-fail, but it
    // also cannot certify the answer because it is not the strict PASS contract.
    expect(parseQaVerdict("the run had zero failures overall").pass).toBe(true);
    expect(parseQaVerdict("the run had zero failures overall").status).toBe("unverified");
  });
});

describe("runQaDeliveryLoop — no-PASS-without-evidence invariant (qaEvidenceRequired)", () => {
  it("marks a PASS lacking evidence as unverified but STILL ships it (fail-open preserved)", async () => {
    const r = await runQaDeliveryLoop("the answer", CRITERIA, deps({
      check: async () => ({ pass: true }), // bare pass, no evidence
      requireEvidence: true,
    }));
    expect(r.passed).toBe(true);        // never blocks delivery
    expect(r.answer).toBe("the answer"); // ships unchanged
    expect(r.unverified).toBe(true);     // but flagged for a caveat
  });

  it("an evidence-backed PASS is trusted (not unverified)", async () => {
    const r = await runQaDeliveryLoop("the answer", CRITERIA, deps({
      check: async () => ({ pass: true, evidence: "web_fetch returned the 2026 spec table with all 5 rows" }),
      requireEvidence: true,
    }));
    expect(r.passed).toBe(true);
    expect(r.unverified).toBe(false);
    expect(r.evidence).toBe("web_fetch returned the 2026 spec table with all 5 rows");
  });

  it("legacy mode: a bare PASS ships uncaveated, but its status is never a verified pass", async () => {
    const r = await runQaDeliveryLoop("the answer", CRITERIA, deps({
      check: async () => ({ pass: true }),
    }));
    expect(r.passed).toBe(true);
    expect(r.status).toBe("unverified"); // the truthful tri-state is unconditional
    expect(r.unverified).toBe(false);    // the caveat is gated on qaStrictVerdicts
  });

  it("strict mode (qaStrictVerdicts): a bare PASS ships WITH the unverified caveat", async () => {
    const r = await runQaDeliveryLoop("the answer", CRITERIA, deps({
      check: async () => ({ pass: true }),
      strict: true,
    }));
    expect(r.passed).toBe(true);
    expect(r.status).toBe("unverified");
    expect(r.unverified).toBe(true);
  });

  it("never marks a FAIL→improve→pass path unverified when the final pass has evidence", async () => {
    let calls = 0;
    const r = await runQaDeliveryLoop("v0", CRITERIA, deps({
      check: async () => (++calls > 1 ? { pass: true, evidence: "artifact written to /out/report.md (4.2KB)" } : { pass: false, flaws: "thin" }),
      improve: async () => "v1",
      requireEvidence: true,
      maxRounds: 3,
    }));
    expect(r.answer).toBe("v1");
    expect(r.passed).toBe(true);
    expect(r.unverified).toBe(false);
  });
});

/**
 * An empty verdict is NO verdict. The owner measured the 35B with reasoning on (2026-09-25): on
 * some classifications it spent ~600 thinking tokens and returned empty content. parseQaVerdict
 * kept that fail-open (pass:true, status unverified), and the loop then returned passed:true —
 * which the audit row flow_verification_passed carried as a pass nobody gave.
 */
describe("runQaDeliveryLoop — an empty verdict is no verdict, never a pass", () => {
  for (const reply of ["", "  \n", "I need to think about the criteria first"]) {
    it(`records ${JSON.stringify(reply)} as no verdict, ships the answer, and asks for no rewrite`, async () => {
      const improve = vi.fn(async () => "rewritten");
      const r = await runQaDeliveryLoop("the answer", CRITERIA, deps({ check: async () => parseQaVerdict(reply), improve }));
      expect(r.answer).toBe("the answer");  // fail-open: delivery is not blocked
      expect(r.passed).toBe(false);
      expect(r.status).toBe("unverified");
      expect(r.noVerdict).toBe(true);
      expect(improve).not.toHaveBeenCalled(); // no flaws were named, so there is nothing to fix
    });
  }

  it("caveats it under strict verdicts, as it did before", async () => {
    const r = await runQaDeliveryLoop("the answer", CRITERIA, deps({ check: async () => parseQaVerdict(""), strict: true, requireEvidence: true }));
    expect(r.unverified).toBe(true);
    expect(r.passed).toBe(false);
  });

  it("leaves a bare PASS a pass (legacy), and an evidence-backed PASS verified", async () => {
    const bare = await runQaDeliveryLoop("a", CRITERIA, deps({ check: async () => parseQaVerdict("PASS") }));
    expect(bare.passed).toBe(true);
    expect(bare.noVerdict).toBeUndefined();
    const backed = await runQaDeliveryLoop("a", CRITERIA, deps({ check: async () => parseQaVerdict("PASS — evidence: file has 3 rows") }));
    expect(backed.passed).toBe(true);
    expect(backed.status).toBe("pass");
    expect(backed.noVerdict).toBeUndefined();
  });
});

/**
 * Strict verdicts must ASK for what they refuse to trust.
 *
 * Measured on the deployment (2026-09-08, same prompt, 4 runs per arm). Strict on, evidence not
 * requested: 3 of 4 answers shipped the "the QA check did NOT confirm this answer against
 * concrete evidence" caveat, and every one of those verdicts was `status=unverified, rounds=0`
 * — the reviewer was told to "reply exactly: PASS", said PASS, and was downgraded for obeying.
 * One of the caveated answers carried exact versions, release dates and two source URLs from 33
 * gathering calls. Strict on WITH evidence requested: 0 of 4 caveated — two evidence-backed
 * passes, and one real FAIL whose two repair rounds replaced a fabricated Redis release with an
 * honest "not provided in current evidence".
 */
describe("qaRequiresEvidence — strict implies the evidence request", () => {
  it("asks for evidence whenever strict verdicts are on", () => {
    expect(qaRequiresEvidence({ qaStrictVerdicts: true })).toBe(true);
  });

  it("still honours the two flags that already implied it", () => {
    expect(qaRequiresEvidence({ requireEvidence: true })).toBe(true);
    expect(qaRequiresEvidence({ qaToolJudge: true })).toBe(true);
  });

  it("asks for nothing when no flag demands it — the legacy path is unchanged", () => {
    expect(qaRequiresEvidence({})).toBe(false);
    expect(qaRequiresEvidence({ requireEvidence: false, qaToolJudge: false, qaStrictVerdicts: false })).toBe(false);
  });

  it("never lets strict run without the request — the combination that caveats every pass", () => {
    // The defect, stated as an invariant: there is no flag combination in which the loop
    // downgrades a bare PASS while the reviewer was never asked to supply a ground.
    for (const requireEvidence of [true, false]) {
      for (const qaToolJudge of [true, false]) {
        const flags = { requireEvidence, qaToolJudge, qaStrictVerdicts: true };
        expect(qaRequiresEvidence(flags)).toBe(true);
      }
    }
  });
});

/**
 * The repairs see the answer they repair.
 *
 * E2E core-ix-browser-order-form-express-refused: both QA rounds failed, and every shipped reply was
 * the improve step's rewrite. That rewrite ran through forceSynthesis, which reads the session's
 * history, and the draft is not in it until the turn ships: it got the flaws and not the answer, and
 * one rewrite turned the browser agent's disclosure (it had changed the shipping) into "no
 * automatic change was made". Only the coordinator escalation passed the answer; these pin that
 * every repair instruction does, in the escalation's form.
 */
describe("repair instructions carry the answer they repair", () => {
  const DISCLOSURE = "Hinweis: Die Seite hat Express für Speditionsware abgelehnt; der Browser-Agent hat daraufhin auf "
    + "Standardversand umgestellt und erneut abgeschickt.";
  const ANSWER = `Die Bestellung wurde abgeschickt, Referenz NW-B-2106-2-S.\n\n${DISCLOSURE}`;

  it("the QA improve step gets the flaws and the answer, disclosure included", () => {
    const instruction = buildQaImproveInstruction(ANSWER, "the reply does not say the user's express choice was refused") ?? "";
    expect(instruction).toContain("QA REVIEW found");
    expect(instruction).toContain("the reply does not say the user's express choice was refused");
    expect(instruction).toContain(`Current answer to improve:\n${ANSWER}`);
    expect(instruction).toContain(DISCLOSURE);
    // What to return comes after the answer, so the instruction is the last thing the call reads.
    expect(instruction.indexOf("Return the COMPLETE corrected answer")).toBeGreaterThan(instruction.indexOf(DISCLOSURE));
  });

  it("riskGatedQA's one-shot verification gets the criteria and the answer, labelled neutrally: it is to return it unchanged", () => {
    const instruction = buildCriteriaVerifyInstruction(ANSWER, ["reports what the page showed after submit"]) ?? "";
    expect(instruction).toContain("1. reports what the page showed after submit");
    expect(instruction).toContain(`Your answer:\n${ANSWER}`);
    expect(instruction).not.toContain("Current answer to improve");
    expect(instruction).toContain(DISCLOSURE);
    expect(instruction.indexOf("return the SAME answer")).toBeGreaterThan(instruction.indexOf(DISCLOSURE));
  });

  it("both repairs are told to keep a note of a refusal or a deviation (E2E 2026-10-12: a repair dropped it)", () => {
    for (const instruction of [
      buildQaImproveInstruction(ANSWER, "it adds an unrequested note to the verbatim page text") ?? "",
      buildCriteriaVerifyInstruction(ANSWER, ["documents the page's output word for word"]) ?? "",
    ]) {
      expect(instruction).toContain(QA_DISCLOSURE_RULE);
    }
  });

  it("both repairs are told that a flaw in what was done cannot be rewritten away (E2E 2026-10-12: a repair denied a resubmission)", () => {
    for (const instruction of [
      buildQaImproveInstruction(ANSWER, "Quantity was changed from 1200 to 999 without user consent") ?? "",
      buildCriteriaVerifyInstruction(ANSWER, ["the form is submitted with the requested quantity"]) ?? "",
    ]) {
      expect(instruction).toContain(QA_ACTION_HONESTY_RULE);
    }
  });

  it("passes the answer in the coordinator escalation's form, and marks a cut", () => {
    expect(currentAnswerBlock(ANSWER)).toBe(`\n\nCurrent answer to improve:\n${ANSWER}`);
    expect(currentAnswerBlock("a".repeat(50) + "TAIL", undefined, 50))
      .toBe(`\n\nCurrent answer to improve:\n${"a".repeat(50)}\n[… 4 more characters not shown]`);
  });

  it("hands over the whole answer up to the delegated-result budget of the turn's effort, not a fixed 6,000", () => {
    const answer = `${"Absatz. ".repeat(1_125)}TAIL-OF-A-9K-ANSWER`;   // 9,019 characters
    for (const tier of ["low", "high"] as const) {
      expect(runWithEffortContext(tier, () => answerRepairMaxChars())).toBe(BUILTIN_EFFORT_PROFILES[tier].maxDelegatedResultChars);
    }
    const high = runWithEffortContext("high", () => buildQaImproveInstruction(answer, "f")) ?? "";
    expect(high).toContain(`Current answer to improve:\n${answer}`);
    expect(high).not.toContain("more characters not shown");
  });

  it("skips a cheap rewrite of an answer that does not fit, rather than hand it the head and ship a shortened answer", () => {
    // A rewrite asked for the COMPLETE answer that saw only the head returns the head: the improve
    // step's shrink guard rejects only a stub, and the verification accepts half the length.
    const answer = `${"a".repeat(50)}TAIL`;
    expect(buildQaImproveInstruction(answer, "f", 50)).toBeNull();
    expect(buildCriteriaVerifyInstruction(answer, ["c"], 50)).toBeNull();
    expect(answerFitsRepair(answer, 50)).toBe(false);
    // The control: at the bound it runs, with the whole answer.
    expect(buildQaImproveInstruction(answer, "f", 54)).toContain(answer);
    expect(buildCriteriaVerifyInstruction(answer, ["c"], 54)).toContain(answer);
    // Under the low effort tier (6,000) a 9,000-character answer is not rewritten at all.
    expect(runWithEffortContext("low", () => buildQaImproveInstruction("x".repeat(9_000), "f"))).toBeNull();
  });
});

/**
 * What the verdicts asked to fix is recorded. In E2E core-ix-browser-order-form-express-refused
 * both rounds failed and the reply was a repair, and the verdicts' text was logged nowhere.
 */
describe("the failing verdicts' flaws", () => {
  it("come back with the result, each round's in order — whatever the loop ends on", async () => {
    let n = 0;
    const exhausted = await runQaDeliveryLoop("v0", CRITERIA, deps({
      check: async () => ({ pass: false, flaws: `round ${++n} flaw` }),
      maxRounds: 2,
    }));
    expect(exhausted.flaws).toEqual(["round 1 flaw", "round 2 flaw"]);

    n = 0;
    const passedLater = await runQaDeliveryLoop("v0", CRITERIA, deps({
      check: async () => (++n === 1 ? { pass: false, flaws: "missing sources" } : { pass: true, evidence: "cites rfc 9110" }),
      maxRounds: 3,
    }));
    expect(passedLater.passed).toBe(true);
    expect(passedLater.flaws).toEqual(["missing sources"]);

    const repairFailed = await runQaDeliveryLoop("v0", CRITERIA, deps({
      check: async () => ({ pass: false, flaws: "no winner named" }),
      improve: async () => null,
    }));
    expect(repairFailed.flaws).toEqual(["no winner named"]);
  });

  it("are absent when no verdict failed", async () => {
    const r = await runQaDeliveryLoop("good", CRITERIA, deps({ check: async () => ({ pass: true }) }));
    expect(r).not.toHaveProperty("flaws");
  });

  it("go into the audit row clipped to 300 characters, the cut marked, and not at all when there are none", () => {
    const long = "f".repeat(500);
    expect(qaFlawsForAudit([long, "short"])).toEqual({ qaFlaws: [`${"f".repeat(300)}…`, "short"] });
    expect(qaFlawsForAudit(undefined)).toEqual({});
    expect(qaFlawsForAudit([])).toEqual({});
  });

  // Assembled at run time, so the repository holds no key-shaped literal: the OpenAI key shape the
  // output scanner knows (sk- and 20 or more letters and digits), 33 characters.
  const fakeKey = (): string => ["s", "k", "-", "Zq9".repeat(10)].join("");

  it("redacts a secret before clipping, so one straddling the cut leaves no head behind for the scan to miss", () => {
    // Glued to the text before it, so no word boundary rescues it: clipped first, the row kept
    // "sk-Zq9Zq9", which is shorter than the pattern logAudit's own scan would have matched.
    const key = fakeKey();
    const flaw = `${"w".repeat(290)}=${key} and more`;   // the key spans characters 291 to 324
    const [entry] = qaFlawsForAudit([flaw]).qaFlaws ?? [];
    expect(entry).toBeDefined();
    expect(entry).not.toContain(key.slice(0, 6));
    expect(entry!.length).toBeLessThanOrEqual(301);
  });

  it("cuts on a word boundary, so a token no pattern knows is kept whole or dropped", () => {
    const token = `zz${"Q".repeat(30)}`;
    const flaw = `${"word ".repeat(58)}${token} tail`;   // the token spans characters 290 to 321
    const [entry] = qaFlawsForAudit([flaw]).qaFlaws ?? [];
    expect(entry).toBe(`${"word ".repeat(58).trimEnd()}…`);
  });
});
