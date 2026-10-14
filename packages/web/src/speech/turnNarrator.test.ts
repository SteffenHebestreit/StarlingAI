import { describe, expect, it } from "vitest";
import { milestoneOf, TurnNarrator, type NarratedStep } from "./turnNarrator";

const tool = (id: string, name: string): NarratedStep => ({ id, kind: "tool", name });
const note = (id: string, name: string): NarratedStep => ({ id, kind: "note", name });

/** Observes once a second from `from` to `to` (inclusive), returning what was said and when. */
function run(narrator: TurnNarrator, from: number, to: number, stepsAt: (second: number) => NarratedStep[], waitingAt?: (second: number) => { key: string; approval: boolean } | null) {
  const said: Array<{ at: number; cue: unknown }> = [];
  for (let second = from; second <= to; second += 1) {
    const cue = narrator.observe({ now: second * 1_000, steps: stepsAt(second), waitingFor: waitingAt?.(second) ?? null });
    if (cue) said.push({ at: second, cue });
  }
  return said;
}

describe("milestoneOf", () => {
  it("names the kind of work a step is", () => {
    expect(milestoneOf(tool("1", "web_search"))).toBe("searching");
    expect(milestoneOf(tool("1", "playwright__browser_click"))).toBe("browsing");
    expect(milestoneOf(tool("1", "browser_axe_audit"))).toBe("checking");
    expect(milestoneOf(tool("1", "delegate_to_agent"))).toBe("delegating");
    expect(milestoneOf(tool("1", "kubectl_get"))).toBe("running");
    expect(milestoneOf(tool("1", "generate_image"))).toBe("creating");
    expect(milestoneOf(note("1", "synthesizing"))).toBe("composing");
    expect(milestoneOf(note("1", "routing"))).toBeUndefined();
    expect(milestoneOf(tool("1", "session_status"))).toBeUndefined();
  });
});

describe("TurnNarrator", () => {
  it("says nothing during a quick turn", () => {
    const narrator = new TurnNarrator(0);
    expect(run(narrator, 0, 5, () => [tool("a", "web_search")])).toEqual([]);
  });

  it("names the first kind of work once the turn has run a few seconds", () => {
    const narrator = new TurnNarrator(0);
    const said = run(narrator, 0, 7, (second) => (second >= 2 ? [tool("a", "web_search")] : []));
    expect(said).toEqual([{ at: 6, cue: { kind: "milestone", milestone: "searching" } }]);
  });

  it("keeps twenty seconds between lines and names a kind of work once", () => {
    const narrator = new TurnNarrator(0);
    const steps = (second: number) => [
      ...(second >= 2 ? [tool("a", "web_search")] : []),
      ...(second >= 10 ? [tool("b", "delegate_to_agent")] : []),
      ...(second >= 12 ? [tool("c", "web_search")] : []),
    ];
    const said = run(narrator, 0, 40, steps);
    expect(said).toEqual([
      { at: 6, cue: { kind: "milestone", milestone: "searching" } },
      { at: 26, cue: { kind: "milestone", milestone: "delegating" } },
    ]);
  });

  it("drops a kind of work that was noticed too long ago to be news", () => {
    const narrator = new TurnNarrator(0);
    const steps = (second: number) => [
      ...(second >= 2 ? [tool("a", "web_search")] : []),
      ...(second >= 7 ? [tool("b", "web_fetch")] : []),
    ];
    // "reading" is noticed at 7 s, the gap opens at 26 s: 19 s later, still news.
    expect(run(narrator, 0, 26, steps).map((entry) => entry.at)).toEqual([6, 26]);
    const late = new TurnNarrator(0, { minGapMs: 25_000 });
    // With a 25 s gap it would come at 31 s, 24 s after it was noticed: dropped.
    expect(run(late, 0, 31, steps).map((entry) => entry.at)).toEqual([6]);
  });

  it("says it is still working after a silence, then less often, and at most a few times", () => {
    const narrator = new TurnNarrator(0, { maxReminders: 3 });
    const said = run(narrator, 0, 300, () => []);
    expect(said).toEqual([
      { at: 30, cue: { kind: "stillWorking", long: false } },
      { at: 90, cue: { kind: "stillWorking", long: false } },
      { at: 150, cue: { kind: "stillWorking", long: true } },
    ]);
  });

  it("calls the user at once for a question, once per question, and counts the silence from the answer", () => {
    const narrator = new TurnNarrator(0);
    const waiting = (second: number) =>
      second >= 1 && second < 20 ? { key: "approval:1", approval: true }
        : second >= 40 && second < 45 ? { key: "ask:2", approval: false }
          : null;
    const said = run(narrator, 0, 75, () => [], waiting);
    expect(said).toEqual([
      { at: 1, cue: { kind: "needsInput", approval: true } },
      // Answered at 20 s: the reminder waits 30 s from there.
      { at: 40, cue: { kind: "needsInput", approval: false } },
      { at: 75, cue: { kind: "stillWorking", long: false } },
    ]);
  });
});
