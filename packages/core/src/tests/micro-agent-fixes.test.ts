import { describe, expect, it } from "vitest";
import { classifyFrontDesk, parseReceptionistConfidence } from "../agent/receptionist.js";
import { awaitQuorum } from "../agent/delegation-quorum.js";
import {
  shouldCheckSubAgentDisagreement,
  parseDisagreementVerdict,
  buildDisagreementCheckMessages,
  renderDisagreementMarker,
} from "../agent/sub-agent-disagreement.js";

// ── Fix 5: receptionist confidence-attempt ────────────────────────────────────

describe("parseReceptionistConfidence (fail-safe)", () => {
  it("accepts only an explicit high-confidence, non-empty, sentinel-free answer", () => {
    const v = parseReceptionistConfidence("Paris is the capital of France.\nCONFIDENCE: high");
    expect(v.confident).toBe(true);
    expect(v.answer).toBe("Paris is the capital of France.");
  });
  it("escalates on low / medium / unsure", () => {
    expect(parseReceptionistConfidence("Hmm, maybe.\nCONFIDENCE: low").confident).toBe(false);
    expect(parseReceptionistConfidence("It depends.\nCONFIDENCE: medium").confident).toBe(false);
  });
  it("escalates on the escalate sentinel", () => {
    expect(parseReceptionistConfidence("<ESCALATE>").confident).toBe(false);
  });
  it("escalates when the confidence marker is missing (no self-report = do not trust)", () => {
    expect(parseReceptionistConfidence("Some confident-sounding but unverified answer.").confident).toBe(false);
  });
});

describe("classifyFrontDesk confidence-attempt gate", () => {
  const directQ = "Explain the difference between TCP and UDP and when each is typically the better choice.";
  it("escalates a >12-word direct question in smalltalk mode but accepts it in confidence-attempt mode", () => {
    expect(classifyFrontDesk(directQ).fastLane).toBe(false); // not-short-conversational
    expect(classifyFrontDesk(directQ, { confidenceAttempt: true }).fastLane).toBe(true);
  });
  // De-lexicalization (cleanup/lean-base): this asserted that a user-own-facts
  // turn sets a guidance flag and escalates the Stage-0 gate even in
  // confidence-attempt mode. The userOwnFacts keyword classifier was deleted (flag
  // defaults OFF), so buildDynamicTurnGuidance no longer flags "what's my
  // background…" and the gate no longer escalates it as "task-intent". The
  // behavior this asserted is gone by design, so the test was removed. (The
  // confidence-attempt mode itself is now disabled in config — commit 50f867c.)
  it("escalates a question longer than the confidence ceiling without a micro-call", () => {
    const long = "a ".repeat(300) + "?";
    const g = classifyFrontDesk(long, { confidenceAttempt: true, confidenceMaxChars: 400 });
    expect(g.fastLane).toBe(false);
    expect((g as { reason: string }).reason).toBe("too-long-for-attempt");
  });
});

// ── Fix 6: quorum drain ───────────────────────────────────────────────────────

type R = { ok: boolean; id: number };
const opts = (k: number, setTimeoutFn: (cb: () => void, ms: number) => void) => ({
  k,
  graceMs: 5,
  isSuccess: (r: R) => r.ok,
  onError: (): R => ({ ok: false, id: -1 }),
  onAbandon: (): R => ({ ok: false, id: -2 }),
  setTimeoutFn,
});
const immediate = (cb: () => void): void => { cb(); };

describe("awaitQuorum", () => {
  it("returns on a K-of-N success quorum and ABANDONS (aborts) the straggler", async () => {
    let stragglerAborted = false;
    const runners = [
      () => Promise.resolve<R>({ ok: true, id: 1 }),
      () => Promise.resolve<R>({ ok: true, id: 2 }),
      (signal: AbortSignal) => new Promise<R>(() => { signal.addEventListener("abort", () => { stragglerAborted = true; }); }),
    ];
    const results = await awaitQuorum<R>(runners, opts(2, immediate));
    expect(results[0]!.ok).toBe(true);
    expect(results[1]!.ok).toBe(true);
    expect(results[2]!.id).toBe(-2); // abandoned placeholder
    expect(stragglerAborted).toBe(true);
  });

  it("returns all results when every slice succeeds (no abandon)", async () => {
    const runners = [0, 1, 2].map((id) => () => Promise.resolve<R>({ ok: true, id }));
    const results = await awaitQuorum<R>(runners, opts(2, immediate));
    expect(results.map((r) => r.id).sort()).toEqual([0, 1, 2]);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("waits for ALL when fewer than K succeed (no premature abandon)", async () => {
    const runners = [
      () => Promise.resolve<R>({ ok: true, id: 1 }),
      () => Promise.reject(new Error("boom")),
      () => Promise.reject(new Error("boom")),
    ];
    const results = await awaitQuorum<R>(runners, opts(2, immediate));
    expect(results[0]!.ok).toBe(true);
    expect(results[1]!.id).toBe(-1); // onError, not onAbandon
    expect(results[2]!.id).toBe(-1);
  });
});

// ── Fix 6: disagreement-as-signal ─────────────────────────────────────────────

describe("disagreement-as-signal helpers", () => {
  it("only checks when enabled AND >=2 slices succeeded", () => {
    expect(shouldCheckSubAgentDisagreement({ enabled: true, succeeded: 2 })).toBe(true);
    expect(shouldCheckSubAgentDisagreement({ enabled: true, succeeded: 1 })).toBe(false);
    expect(shouldCheckSubAgentDisagreement({ enabled: false, succeeded: 3 })).toBe(false);
  });
  it("parses AGREE / DISAGREE verdicts (case-insensitive, with detail)", () => {
    expect(parseDisagreementVerdict("AGREE").disagree).toBe(false);
    const d = parseDisagreementVerdict("DISAGREE: output 1 quotes $40, output 2 quotes $55");
    expect(d.disagree).toBe(true);
    expect(d.detail).toMatch(/\$40.*\$55/);
    expect(parseDisagreementVerdict("disagree: prices differ").disagree).toBe(true);
  });
  it("builds a 2-message check carrying the slice outputs", () => {
    const msgs = buildDisagreementCheckMessages([{ label: "a", text: "x" }, { label: "b", text: "y" }]);
    expect(msgs).toHaveLength(2);
    expect(msgs[1]!.content).toMatch(/a[\s\S]*b/);
  });
  it("renders a marker that names the conflict", () => {
    expect(renderDisagreementMarker("prices differ")).toMatch(/DISAGREEMENT[\s\S]*prices differ/);
  });
});
