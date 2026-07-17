import { describe, expect, it, vi } from "vitest";
import { runQaDeliveryLoop, parseQaVerdict, verdictHasEvidence, type QaDeliveryDeps } from "../agent/qa-delivery-loop.js";

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
    expect(r.passed).toBe(true);
    expect(r.answer).toBe("answer");
    expect(r.status).toBe("unverified");
    expect(r.unverified).toBe(true);
  });

  it("fails OPEN: a thrown check ships uncaveated in legacy mode, but the status stays truthful", async () => {
    const r = await runQaDeliveryLoop("answer", CRITERIA, deps({ check: async () => { throw new Error("model down"); } }));
    expect(r.passed).toBe(true);
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

  it("fails OPEN for delivery but marks empty or malformed reviewer noise unverified", () => {
    expect(parseQaVerdict("")).toEqual({ status: "unverified", pass: true });
    expect(parseQaVerdict("hmm, hard to say")).toEqual({ status: "unverified", pass: true });
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
