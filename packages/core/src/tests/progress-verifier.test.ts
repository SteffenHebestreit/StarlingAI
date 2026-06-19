import { describe, expect, it } from "vitest";
import {
  isHardStall,
  buildProgressJudgePrompt,
  parseProgressVerdict,
  PROGRESS_CHECK_INTERVAL_MS,
  STALL_LIMIT,
} from "../agent/progress-verifier.js";

/**
 * Progress verifier — the oversight half of max-effort silent-unbounded mode.
 * These cover the deterministic structural guard and the fail-open verdict
 * parser; the (default-off) semantic judge call itself is exercised live.
 */
describe("progress-verifier — structural stall guard", () => {
  it("is a stall when neither completion tokens nor tool calls advanced", () => {
    expect(isHardStall({ completionTokens: 5000, toolCalls: 3 }, { completionTokens: 5000, toolCalls: 3 })).toBe(true);
  });
  it("is NOT a stall when new completion tokens were produced (run is alive)", () => {
    expect(isHardStall({ completionTokens: 5000, toolCalls: 3 }, { completionTokens: 5200, toolCalls: 3 })).toBe(false);
  });
  it("is NOT a stall when a new tool call was made (run is alive)", () => {
    expect(isHardStall({ completionTokens: 5000, toolCalls: 3 }, { completionTokens: 5000, toolCalls: 4 })).toBe(false);
  });
  it("treats a counter that went backwards as no-progress (defensive)", () => {
    expect(isHardStall({ completionTokens: 5000, toolCalls: 3 }, { completionTokens: 4000, toolCalls: 2 })).toBe(true);
  });
  it("ships sane window/limit constants", () => {
    expect(PROGRESS_CHECK_INTERVAL_MS).toBeGreaterThanOrEqual(60_000);
    expect(STALL_LIMIT).toBeGreaterThanOrEqual(2);
  });
});

describe("progress-verifier — judge prompt", () => {
  it("includes the objective, recent activity, and acceptance criteria", () => {
    const msgs = buildProgressJudgePrompt({
      objective: "Write a 5-section market report on EU heat pumps.",
      acceptanceCriteria: ["all 5 sections present", "sources cited"],
      recentActivity: "Latest output: ## Section 1 …\n\nRecent tool calls: web_search, web_fetch",
    });
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[0]!.content).toMatch(/strict json/i);
    const user = String(msgs[1]!.content);
    expect(user).toContain("EU heat pumps");
    expect(user).toContain("all 5 sections present");
    expect(user).toContain("web_search");
  });
  it("omits the criteria block when none are given", () => {
    const msgs = buildProgressJudgePrompt({ objective: "Do the thing.", recentActivity: "working…" });
    expect(String(msgs[1]!.content)).not.toMatch(/done correctly/i);
  });
});

describe("progress-verifier — verdict parser (fail-open)", () => {
  it("reads a clean drifting verdict with its reason", () => {
    const r = parseProgressVerdict('{"verdict":"drifting","reason":"keeps re-summarising the same section"}');
    expect(r.verdict).toBe("drifting");
    expect(r.reason).toContain("re-summarising");
  });
  it("reads a drifting verdict embedded in surrounding prose", () => {
    const r = parseProgressVerdict('Here is my assessment:\n{"verdict":"drifting","reason":"wrong topic"}\nThanks.');
    expect(r.verdict).toBe("drifting");
  });
  it("reads an on_track verdict", () => {
    expect(parseProgressVerdict('{"verdict":"on_track","reason":"steadily drafting sections"}').verdict).toBe("on_track");
  });
  it("defaults to on_track for empty / undefined / non-JSON replies (never stops a healthy run)", () => {
    expect(parseProgressVerdict(undefined).verdict).toBe("on_track");
    expect(parseProgressVerdict("").verdict).toBe("on_track");
    expect(parseProgressVerdict("the agent seems fine to me").verdict).toBe("on_track");
  });
  it("defaults to on_track for malformed JSON (fail-open, no throw)", () => {
    expect(parseProgressVerdict('{"verdict":"drifting", reason:').verdict).toBe("on_track");
  });
  it("treats an unknown verdict value as on_track (only explicit drifting stops a run)", () => {
    expect(parseProgressVerdict('{"verdict":"confused"}').verdict).toBe("on_track");
  });
});
