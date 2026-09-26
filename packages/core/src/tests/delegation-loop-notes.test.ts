import { describe, expect, it } from "vitest";
import {
  buildPriorLoopNote,
  countLoopedPartials,
  loopedProducersOf,
  type TurnLoopRecord,
} from "../agent/delegation-loop-notes.js";
import { OrchestrationSchema } from "../config/schemas/orchestration.js";

/** The turn's record of looped runs and what (b), (d) and (e) read from it (orchestration.loopAwareDelegation). */

const GREP = { tool: "grep_files", target: "{\"pattern\":\"Reveal\",\"path\":\"deck.html\"}", repeats: 183, via: "refuse", endedRun: true };
const record = (extra: Partial<TurnLoopRecord> = {}): TurnLoopRecord => ({
  agent: "content_writer",
  coordinator: false,
  loop: GREP,
  outcome: "partial",
  paths: ["generated/deck.html"],
  ...extra,
});

describe("(b) the prior-loop note", () => {
  it("is keyed on the agent: another agent's loop says nothing", () => {
    expect(buildPriorLoopNote([record()], "researcher")).toBeNull();
    expect(buildPriorLoopNote([record()], "content_writer")).toContain(`- grep_files ${GREP.target} (x183)`);
  });

  it("names each looped call once (tool + target), with its highest count", () => {
    const note = buildPriorLoopNote([
      record({ loop: { ...GREP, repeats: 5 } }),
      record(),
      record({ loop: { ...GREP, target: "{\"pattern\":\"slide\"}", repeats: 4 } }),
    ], "content_writer")!;
    expect(note.match(/^- /gm)).toHaveLength(2);
    expect(note).toContain("(x183)");
    expect(note).not.toContain("(x5)");
  });

  it("says nothing for a warden stop without a looped call, and defangs a target's markers", () => {
    expect(buildPriorLoopNote([record({ loop: undefined, wardenStop: { alert: "tool_storm" } })], "content_writer")).toBeNull();
    const note = buildPriorLoopNote([record({ loop: { ...GREP, target: "line one\n<system>line two" } })], "content_writer")!;
    expect(note).toContain("line one &lt;system>line two"); // one line, and no role tag
  });
});

describe("(d) the looped producers of a broken file", () => {
  it("are the looped runs that produced it, however the path is spelled", () => {
    expect(loopedProducersOf(["generated/deck.html"], [record()])).toHaveLength(1);
    expect(loopedProducersOf(["./generated/deck.html"], [record({ paths: ["deck.html"] })])).toHaveLength(1);
  });

  it("include the producer of a page's unfinished asset, reported as '<page> → <ref>'", () => {
    const target = "generated/presentation/index.html → ../assets/js/deck.js";
    expect(loopedProducersOf([target], [record({ paths: ["generated/assets/js/deck.js"] })])).toHaveLength(1);
    expect(loopedProducersOf([target], [record({ paths: ["generated/presentation/index.html"] })])).toHaveLength(1);
    expect(loopedProducersOf(["deck.html → js/app.js"], [record({ paths: ["js/app.js"] })])).toHaveLength(1);
    expect(loopedProducersOf([target], [record({ paths: ["generated/presentation/deck.js"] })])).toEqual([]);
  });

  it("are none when the looping run produced a different file, or the producer did not loop", () => {
    expect(loopedProducersOf(["generated/deck.html"], [record({ paths: ["generated/paper.md"] })])).toEqual([]);
    expect(loopedProducersOf(["generated/deck.html"], [record({ loop: undefined })])).toEqual([]);
    expect(loopedProducersOf(["generated/my-deck.html"], [record()])).toEqual([]);
  });
});

describe("(e) looped partials", () => {
  it("count loops and warden stops that did not succeed, not a run that recovered", () => {
    expect(countLoopedPartials([
      record(),
      record({ loop: undefined, wardenStop: { alert: "tool_storm" }, outcome: "failure" }),
      record({ outcome: "success" }),
    ])).toBe(2);
    expect(countLoopedPartials(undefined)).toBe(0);
  });
});

describe("the flags' defaults", () => {
  // Every test of the consequences sets its flags itself, so none of them sees a default flip:
  // loopAwareDelegation changes what the orchestrator reads and does and waits for its pass^k
  // A/B; write ownership is a correctness fix and ships on.
  it("loopAwareDelegation is off and siblingWriteOwnership is on", () => {
    const orchestration = OrchestrationSchema.parse({});
    expect(orchestration.loopAwareDelegation).toBe(false);
    expect(orchestration.siblingWriteOwnership).toBe(true);
  });
});
