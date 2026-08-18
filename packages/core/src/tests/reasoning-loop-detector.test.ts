import { describe, expect, it } from "vitest";
import {
  detectReasoningLoop,
  REASONING_LOOP_MIN_SHINGLES,
  REASONING_LOOP_REPEAT_RATIO,
} from "../agent/progress-verifier.js";

/**
 * THE POLICY CHANGE: content decides whether a generation is stopped, length does not.
 *
 * A character budget cannot tell a model working hard from a model stuck, and run db88fa5b
 * showed the error in both directions at once — an operator grant waived the budget and one
 * iteration then spent 80,810 characters to move a single <div>, while a legitimate long
 * think would have been killed at 45,000 for being long. This detector replaces the proxy
 * with the thing itself: is the model re-treading ground?
 *
 * The fixtures below are the two shapes that must never be confused. Both are long; only one
 * is pathological. Every assertion is about that distinction and nothing else.
 */

/** Reasoning that ADVANCES: each step says something the previous step did not. */
function progressiveReasoning(steps: number): string {
  const out: string[] = [];
  for (let i = 0; i < steps; i++) {
    out.push(
      `Step ${i}: the board is ${10 + i} wide, so index ${i} maps to column ${i % 10} and row `
      + `${Math.floor(i / 10)}. That means the collision test at offset ${i * 3} needs the `
      + `kick table entry ${i % 4}, which differs from the previous case because the pivot `
      + `moved by ${i} units and the wall bound is now ${320 - i}. Next I need the spawn `
      + `offset for piece ${String.fromCharCode(65 + (i % 7))} at rotation ${i % 4}.`,
    );
  }
  return out.join("\n");
}

/** Reasoning that CIRCLES: the same derivation, re-stated with trivial variation. */
function loopingReasoning(cycles: number): string {
  const out: string[] = [];
  for (let i = 0; i < cycles; i++) {
    out.push(
      "Wait, let me reconsider the rotation. The SRS kick table for the J piece has five "
      + "offsets and I need to apply them in order, testing each against the board bounds "
      + "before accepting the rotation. Actually, let me reconsider the rotation. The SRS "
      + "kick table for the J piece has five offsets and I need to apply them in order.",
    );
  }
  return out.join("\n");
}

describe("detectReasoningLoop — the model is circling, not merely thinking", () => {
  it("does NOT flag long reasoning that keeps saying new things", () => {
    // THE ONE THAT MATTERS MOST. The user's rule is "if the thinking is not misleading or
    // looping then it is fine" — so a false positive here is the expensive mistake, not a
    // missed detection. This text is far past any old character budget and must pass clean.
    const text = progressiveReasoning(400);
    expect(text.length).toBeGreaterThan(45_000);

    const verdict = detectReasoningLoop(text);
    expect(verdict.shingles).toBeGreaterThanOrEqual(REASONING_LOOP_MIN_SHINGLES);
    expect(verdict.looping, `repeatRatio was ${verdict.repeatRatio}`).toBe(false);
    expect(verdict.repeatRatio).toBeLessThan(REASONING_LOOP_REPEAT_RATIO);
  });

  it("FLAGS reasoning that re-derives the same thing over and over", () => {
    const verdict = detectReasoningLoop(loopingReasoning(60));
    expect(verdict.looping, `repeatRatio was ${verdict.repeatRatio}`).toBe(true);
    expect(verdict.repeatRatio).toBeGreaterThanOrEqual(REASONING_LOOP_REPEAT_RATIO);
  });

  it("separates the two shapes by a wide margin, not a hair", () => {
    // A threshold is only meaningful if the populations are actually apart. If this margin
    // ever collapses, the constant is fitting noise and needs real logged data, not a nudge.
    const healthy = detectReasoningLoop(progressiveReasoning(400)).repeatRatio;
    const stuck = detectReasoningLoop(loopingReasoning(60)).repeatRatio;
    expect(stuck - healthy).toBeGreaterThan(0.4);
  });

  it("stays silent on a short window — too little text to judge", () => {
    // Sampling starts early in a stream; an opening paragraph must never read as a loop.
    const verdict = detectReasoningLoop("Let me think about the board geometry for a moment.");
    expect(verdict.looping).toBe(false);
    expect(verdict.shingles).toBeLessThan(REASONING_LOOP_MIN_SHINGLES);
  });

  it("judges the RECENT tail, so early repetition does not condemn a recovered run", () => {
    // A model that circled briefly and then broke out is working. Only the window counts.
    const recovered = loopingReasoning(60) + progressiveReasoning(400);
    expect(detectReasoningLoop(recovered).looping).toBe(false);
  });

  it("is language-independent — no phrase list, no English assumption", () => {
    // The tasks in this deployment arrive in German as often as English. Repetition is
    // structural, so the same circling in German must trip the same way.
    const german = Array.from({ length: 60 }, () =>
      "Moment, ich überdenke die Rotation noch einmal. Die SRS-Kicktabelle für das J-Stück "
      + "hat fünf Offsets und ich muss sie der Reihe nach gegen die Spielfeldgrenzen prüfen, "
      + "bevor ich die Drehung akzeptiere. Also, ich überdenke die Rotation noch einmal.",
    ).join("\n");
    expect(detectReasoningLoop(german).looping).toBe(true);
  });
});
