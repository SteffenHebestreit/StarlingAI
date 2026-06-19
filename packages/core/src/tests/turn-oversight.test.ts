import { describe, expect, it } from "vitest";
import {
  classifyTurnProgress,
  buildTurnOversightPrompt,
  parseTurnOversightVerdict,
  type TurnProgressSample,
} from "../agent/turn-oversight.js";

/**
 * Max-effort turn oversight (the user's "don't limit the agents at max, but trigger an
 * oversight agent that checks progress/stuck and intervenes"). The structural signal and
 * the verdict parser are pure + fail-open, so they are verifiable without a running turn.
 */
const base: TurnProgressSample = { completionTokens: 100, toolCalls: 4, delegations: 2, artifacts: 1, delegationFailures: 1 };

describe("classifyTurnProgress", () => {
  it("is progressing when a new artifact landed (even if everything else is flat)", () => {
    expect(classifyTurnProgress(base, { ...base, artifacts: base.artifacts + 1 })).toBe("progressing");
  });

  it("is progressing on new completion tokens", () => {
    expect(classifyTurnProgress(base, { ...base, completionTokens: base.completionTokens + 50 })).toBe("progressing");
  });

  it("is progressing on a new tool call", () => {
    expect(classifyTurnProgress(base, { ...base, toolCalls: base.toolCalls + 1 })).toBe("progressing");
  });

  it("is churning when it delegated again AND failed again with no new artifact", () => {
    // The dying-build retry loop: more delegations, more failures, no deliverable — even
    // though the orchestrator narrated (tokens moved), there's still nothing on disk.
    const cur = { ...base, delegations: base.delegations + 1, delegationFailures: base.delegationFailures + 1, completionTokens: base.completionTokens + 200 };
    expect(classifyTurnProgress(base, cur)).toBe("churning");
  });

  it("is NOT churning when a delegation succeeded (artifact grew) despite a new failure", () => {
    const cur = { ...base, delegations: base.delegations + 1, delegationFailures: base.delegationFailures + 1, artifacts: base.artifacts + 1 };
    expect(classifyTurnProgress(base, cur)).toBe("progressing");
  });

  it("treats a lone new delegation WITHOUT a new failure as progress, not churn", () => {
    expect(classifyTurnProgress(base, { ...base, delegations: base.delegations + 1, toolCalls: base.toolCalls + 1 })).toBe("progressing");
  });

  it("is stalled when nothing moved at all", () => {
    expect(classifyTurnProgress(base, { ...base })).toBe("stalled");
  });

  it("reads a counter reset as no-progress (stalled), not progress", () => {
    expect(classifyTurnProgress(base, { completionTokens: 0, toolCalls: 0, delegations: 0, artifacts: 0, delegationFailures: 0 })).toBe("stalled");
  });
});

describe("parseTurnOversightVerdict", () => {
  it("defaults to on_track for empty / unparseable replies (fail-open)", () => {
    expect(parseTurnOversightVerdict("").verdict).toBe("on_track");
    expect(parseTurnOversightVerdict(undefined).verdict).toBe("on_track");
    expect(parseTurnOversightVerdict("the run looks fine to me").verdict).toBe("on_track");
  });

  it("reads a redirect with a directive", () => {
    const r = parseTurnOversightVerdict('{"verdict":"redirect","directive":"Resume generated/index.html by appending the missing script, do not regenerate.","reason":"build keeps dying on one giant write"}');
    expect(r.verdict).toBe("redirect");
    expect(r.directive).toContain("Resume generated/index.html");
    expect(r.reason).toContain("giant write");
  });

  it("reads a stuck verdict with a directive", () => {
    const r = parseTurnOversightVerdict('{"verdict":"stuck","directive":"Stop retrying and deliver the research summary you already have."}');
    expect(r.verdict).toBe("stuck");
    expect(r.directive).toContain("deliver the research summary");
  });

  it("tolerates prose around the JSON object", () => {
    const r = parseTurnOversightVerdict('Here is my call: {"verdict":"redirect","directive":"chunk the build"} — hope that helps');
    expect(r.verdict).toBe("redirect");
    expect(r.directive).toBe("chunk the build");
  });

  it("downgrades a redirect/stuck with NO directive to on_track (nothing actionable)", () => {
    expect(parseTurnOversightVerdict('{"verdict":"redirect","directive":"","reason":"meh"}').verdict).toBe("on_track");
    expect(parseTurnOversightVerdict('{"verdict":"stuck"}').verdict).toBe("on_track");
  });

  it("ignores an on_track verdict's stray directive", () => {
    const r = parseTurnOversightVerdict('{"verdict":"on_track","directive":"keep going","reason":"progressing"}');
    expect(r.verdict).toBe("on_track");
    expect(r.directive).toBe("");
  });

  it("clamps an over-long directive", () => {
    const long = "x".repeat(2000);
    const r = parseTurnOversightVerdict(`{"verdict":"redirect","directive":"${long}"}`);
    expect(r.directive.length).toBeLessThanOrEqual(600);
  });
});

describe("buildTurnOversightPrompt", () => {
  it("includes objective, acceptance criteria, artifact state, and the failure", () => {
    const msgs = buildTurnOversightPrompt({
      objective: "Build a CPSA-F learning WebApp",
      acceptanceCriteria: ["50 questions", "runs offline"],
      recentActivity: "delegated content_writer ×3",
      artifactState: "generated/index.html (appears truncated/incomplete)",
      lastFailure: "Sub-agent error: TypeError: terminated",
      signal: "churning",
    });
    const user = msgs.find((m) => m.role === "user")!.content as string;
    expect(user).toContain("Build a CPSA-F learning WebApp");
    expect(user).toContain("50 questions");
    expect(user).toContain("appears truncated/incomplete");
    expect(user).toContain("TypeError: terminated");
  });

  it("describes the churning vs stalled signal differently in the system prompt", () => {
    const sysOf = (signal: "churning" | "stalled") =>
      buildTurnOversightPrompt({ objective: "x", recentActivity: "y", artifactState: "z", signal })
        .find((m) => m.role === "system")!.content as string;
    expect(sysOf("churning")).toContain("re-delegating");
    expect(sysOf("stalled")).toContain("no forward progress");
  });

  it("asks for strict JSON and biases toward on_track", () => {
    const sys = buildTurnOversightPrompt({ objective: "x", recentActivity: "y", artifactState: "z", signal: "stalled" })
      .find((m) => m.role === "system")!.content as string;
    expect(sys).toContain("STRICT JSON");
    expect(sys.toLowerCase()).toContain("on_track");
  });
});
