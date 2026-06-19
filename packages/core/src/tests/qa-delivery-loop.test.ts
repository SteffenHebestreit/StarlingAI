import { describe, expect, it, vi } from "vitest";
import { runQaDeliveryLoop, parseQaVerdict, type QaDeliveryDeps } from "../agent/qa-delivery-loop.js";

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
    expect(r).toEqual({ answer: "answer", rounds: 0, passed: true });
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

  it("fails OPEN: a thrown check ships the current answer (never blocks delivery)", async () => {
    const r = await runQaDeliveryLoop("answer", CRITERIA, deps({ check: async () => { throw new Error("model down"); } }));
    expect(r.passed).toBe(true);
    expect(r.answer).toBe("answer");
  });

  it("stops and ships the prior answer when improvement yields nothing", async () => {
    const r = await runQaDeliveryLoop("v0", CRITERIA, deps({
      check: async () => ({ pass: false, flaws: "x" }),
      improve: async () => "",
      maxRounds: 3,
    }));
    expect(r.answer).toBe("v0");
    expect(r.passed).toBe(false);
  });
});

describe("parseQaVerdict (runtime verdict parser)", () => {
  it("passes on a clean PASS", () => {
    expect(parseQaVerdict("PASS")).toEqual({ pass: true });
    expect(parseQaVerdict("  pass — all criteria met  ")).toEqual({ pass: true });
  });

  it("fails and extracts the flaws after FAIL:", () => {
    expect(parseQaVerdict("FAIL: missing sources; no winner named")).toEqual({
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
    expect(parseQaVerdict("FAIL")).toEqual({ pass: false, flaws: "One or more acceptance criteria are unmet." });
  });

  it("fails OPEN (passes) on empty or unparseable reviewer noise", () => {
    expect(parseQaVerdict("")).toEqual({ pass: true });
    expect(parseQaVerdict("hmm, hard to say")).toEqual({ pass: true });
  });
});
