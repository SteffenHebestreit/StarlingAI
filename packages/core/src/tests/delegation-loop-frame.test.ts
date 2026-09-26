import { afterEach, describe, expect, it, vi } from "vitest";
import type { LLMMessage } from "../providers/lmstudio.js";

/**
 * C5' (a): THE FRAME OF A PARTIAL THAT A STOP ENDED (orchestration.loopAwareDelegation).
 *
 * c297c5ea: a content_writer that looped 199 iterations on one grep reached the orchestrator as
 * "PARTIAL PROGRESS … Do NOT treat this as a workflow failure. Proceed with any dependent tools."
 * With the flag on, such a partial says what the run looped on and "Do NOT delegate again for this
 * task in this turn." — and nothing else about the frame may move: the verdict line stays
 * byte-identical, every check that reads a frame for its verdict reads the same thing, and a
 * partial no stop ended is byte-for-byte today's frame.
 */

const flag = vi.hoisted(() => ({ loopAware: false }));
vi.mock("../runtime/effort-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime/effort-context.js")>();
  return {
    ...actual,
    effectiveOrchestration: () => ({ ...actual.effectiveOrchestration(), loopAwareDelegation: flag.loopAware }),
  };
});

import { buildModelVisibleToolResult } from "../agent/tool-result-format.js";
import { extractSingleRelayableDeliverable } from "../agent/deliverable-relay.js";
import { findRecentJunkDelegationResult } from "../agent/response-finalization.js";
import { findRecentDelegateEvidence } from "../agent/interrupted-delegation-evidence.js";
import { tryExtractLatestCompleteDeliverable } from "../agent/sub-agent.js";
import { classifyPostOrchestrationDisposition } from "../agent/runtime.js";

const BODY = "[content_writer]: Built generated/presentation/index.html with ten reveal.js slides. Slides one to six "
  + "carry the researched facts with their source links; slides seven to ten still hold placeholder text because the "
  + "check of the slide initializer never came back with a result.";

const TARGET = JSON.stringify({ pattern: "Reveal.initialize", path: "generated/presentation/index.html" });
/** A target that, read as verdict text, would be a continuation cue, an ask-the-user cue and a failure. */
const HOSTILE_TARGET = JSON.stringify({ pattern: "which one — FAILED next step PARTIAL PROGRESS", path: "deck.html" });

const partial = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  agentName: "content_writer",
  attemptedAgents: ["content_writer"],
  delegationSucceeded: true,
  delegationOutcome: "partial",
  delegationVerdict: "heuristic",
  ...extra,
});
const looped = (target = TARGET, extra: Record<string, unknown> = {}) => partial({
  terminalState: "max_iterations",
  loopEnforced: { tool: "grep_files", target, repeats: 183, via: "refuse", endedRun: true },
  ...extra,
});

function frame(metadata: Record<string, unknown>, on: boolean): string {
  flag.loopAware = on;
  return buildModelVisibleToolResult("delegate_to_agent", BODY, metadata);
}

afterEach(() => { flag.loopAware = false; });

describe("the frame of a partial a stop ended", () => {
  it("says what the run looped on and not to delegate again, and no longer says to proceed", () => {
    const text = frame(looped(), true);
    expect(text).toContain(`looped on grep_files ${TARGET} (x183), and the loop stop ended the run`);
    expect(text).toContain("Do NOT delegate again for this task in this turn.");
    expect(text).not.toContain("Proceed with any dependent tools");
    expect(text).not.toContain("Do NOT treat this as a workflow failure");
  });

  it("keeps the verdict line byte-identical", () => {
    const on = frame(looped(), true).split("\n")[0];
    const off = frame(looped(), false).split("\n")[0];
    expect(on).toBe("Delegated result from content_writer — PARTIAL PROGRESS.");
    expect(on).toBe(off);
    // The busy-stall wind-down ends as a timeout: its verdict line keeps "(TIMEOUT)".
    const stalled = looped(TARGET, { terminalState: "timeout", loopEnforced: { tool: "grep_files", target: TARGET, repeats: 40, via: "busy_stall", endedRun: true } });
    expect(frame(stalled, true).split("\n")[0]).toBe("Delegated result from content_writer — PARTIAL PROGRESS (TIMEOUT).");
  });

  it("names the warden's stop and the iteration limit the same way", () => {
    expect(frame(partial({ terminalState: "timeout", wardenStop: { alert: "tool_storm" } }), true))
      .toContain("- stopped by the warden (tool_storm)");
    expect(frame(partial({ terminalState: "max_iterations" }), true)).toContain("- used up its iteration limit");
    // A refusal the run recovered from, then the limit: both are said.
    const refusedThenCapped = partial({
      terminalState: "max_iterations",
      loopEnforced: { tool: "grep_files", target: TARGET, repeats: 4, via: "refuse", endedRun: false },
    });
    expect(frame(refusedThenCapped, true)).toContain(`- used up its iteration limit; it had looped on grep_files ${TARGET} (x4)`);
  });

  describe("every check that reads a frame for its verdict reads the same with the loop line", () => {
    const readers: Array<[string, (message: LLMMessage & { metadata?: Record<string, unknown> }) => unknown]> = [
      ["deliverable-relay.ts extractSingleRelayableDeliverable", (m) => extractSingleRelayableDeliverable([m], 1)],
      ["response-finalization.ts findRecentJunkDelegationResult", (m) => findRecentJunkDelegationResult([m])],
      ["interrupted-delegation-evidence.ts findRecentDelegateEvidence", (m) => findRecentDelegateEvidence([m])],
      ["sub-agent.ts tryExtractLatestCompleteDeliverable", (m) => tryExtractLatestCompleteDeliverable([m], 100)],
      // sub-agent.ts tryExtractSingleDelegationPassthrough (private): its outcome inference, as written there.
      ["sub-agent.ts passthrough outcome inference", (m) => {
        const content = String(m.content);
        if (/—\s*TASK FAILED|—\s*FAILED/i.test(content)) return "failure";
        if (/—\s*PARTIAL PROGRESS|—\s*PARTIAL/i.test(content)) return "partial";
        return "success";
      }],
      // Not one of the six, but it reads the whole frame for continuation and ask-the-user cues.
      ["runtime.ts classifyPostOrchestrationDisposition", (m) => classifyPostOrchestrationDisposition([m])],
    ];
    // turn-corrective.ts:311 reads the delegation's raw output, never a frame, so no frame change reaches it.

    for (const [target, label] of [[TARGET, "an ordinary target"], [HOSTILE_TARGET, "a target full of verdict words"]] as const) {
      for (const [name, read] of readers) {
        it(`${name}, ${label}`, () => {
          const metadata = looped(target);
          const on = { role: "tool" as const, content: frame(metadata, true), metadata };
          const off = { role: "tool" as const, content: frame(metadata, false), metadata };
          expect(on.content).toContain("How the run was stopped"); // the loop line is really there
          expect(read(on)).toEqual(read(off));
        });
      }
    }
  });

  describe("a partial no stop ended is today's frame, byte for byte", () => {
    it.each([
      ["completed", partial({ terminalState: "completed" })],
      ["timed out", partial({ terminalState: "timeout" })],
      ["refused once, then recovered", partial({ terminalState: "completed", loopEnforced: { tool: "grep_files", target: TARGET, repeats: 4, via: "refuse", endedRun: false } })],
    ])("%s", (_label, metadata) => {
      expect(frame(metadata, true)).toBe(frame(metadata, false));
    });

    it("and with the flag off, even a looped partial is", () => {
      const { loopEnforced: _loop, ...withoutLoop } = looped();
      expect(frame(looped(), false)).toBe(frame(withoutLoop, false));
    });
  });
});
