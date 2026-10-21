import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LearnedTurn } from "../agent/user-correction.js";

/**
 * The person's next message as feedback on the turn before it: a correction turns that turn's recorded
 * skill successes into failures (skillLibrary.userCorrectionSignal). Invented content throughout.
 */
const state = vi.hoisted(() => ({ enabled: true, verdict: "CORRECTS" as string, judged: [] as string[] }));

vi.mock("../config/loader.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../config/loader.js")>();
  return {
    ...original,
    getConfig: () => {
      const config = original.getConfig();
      return { ...config, skillLibrary: { ...config.skillLibrary, userCorrectionSignal: state.enabled } };
    },
  };
});
vi.mock("../skills/store.js", () => ({
  recordSkillOutcomeAsync: vi.fn(async () => undefined),
  recordSkillHoldoutOutcomeAsync: vi.fn(async () => undefined),
  reviseSkillSuccessToFailureAsync: vi.fn(async () => undefined),
}));
// The decision layer as a turn runs it, reduced to its incumbent: the routing tier's verdict.
vi.mock("../decisions/incumbent-readout.js", () => ({
  decideWithReadout: async (request: { incumbent: (signal: AbortSignal) => Promise<unknown> }) => ({
    value: await request.incumbent(new AbortController().signal),
    decidedBy: "incumbent",
  }),
}));
vi.mock("../audit/logger.js", () => ({ logAudit: vi.fn() }));

const {
  applyCorrection, checkPreviousTurnCorrection, CORRECTION_MAX_AGE_MS, parseCorrectionVerdict,
  rememberLearnedTurn, resetUserCorrectionForTests, takeLearnedTurn,
} = await import("../agent/user-correction.js");
const { recordSkillHoldoutOutcomeAsync, recordSkillOutcomeAsync, reviseSkillSuccessToFailureAsync } = await import("../skills/store.js");
const { logAudit } = await import("../audit/logger.js");

const complete = vi.fn(async (messages: Array<{ content: string }>) => {
  state.judged.push(messages[1]!.content);
  return { content: state.verdict, tool_calls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop" };
});
const provider = { complete } as never;

const turn = (over: Partial<LearnedTurn> = {}): LearnedTurn => ({
  at: Date.now(),
  workspacePath: "/tmp/ws",
  injectedSkillSlugs: ["hotel-search"],
  heldOutSkillSlugs: ["travel-planner"],
  recorded: "success",
  answer: "Here are three hotels near the station in Utrecht.",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  resetUserCorrectionForTests();
  state.enabled = true;
  state.verdict = "CORRECTS";
  state.judged.length = 0;
});
afterEach(() => resetUserCorrectionForTests());

describe("the remembered turn", () => {
  it("answers the session's next message once, and not after hours", () => {
    rememberLearnedTurn("s1", turn());
    expect(takeLearnedTurn("s1")).toMatchObject({ injectedSkillSlugs: ["hotel-search"] });
    expect(takeLearnedTurn("s1")).toBeUndefined();
    rememberLearnedTurn("s2", turn({ at: 0 }));
    expect(takeLearnedTurn("s2", CORRECTION_MAX_AGE_MS + 1)).toBeUndefined();
  });

  it("is forgotten when a later turn recorded no skills", () => {
    rememberLearnedTurn("s1", turn());
    rememberLearnedTurn("s1", null);
    expect(takeLearnedTurn("s1")).toBeUndefined();
  });
});

describe("the verdict", () => {
  it.each([
    ["CORRECTS", true],
    ["continues", false],
    ["Verdict: CORRECTS.", true],
    ["I am not sure.", undefined],
    ["", undefined],
  ])("%j → %s", (content, verdict) => {
    expect(parseCorrectionVerdict(content)).toBe(verdict);
  });
});

describe("what a correction changes", () => {
  it("turns recorded successes into failures, injected and held out", async () => {
    expect(await applyCorrection(turn())).toEqual({ revised: 2, recorded: 0 });
    expect(reviseSkillSuccessToFailureAsync).toHaveBeenCalledWith("/tmp/ws", "hotel-search");
    expect(reviseSkillSuccessToFailureAsync).toHaveBeenCalledWith("/tmp/ws", "travel-planner", true);
    expect(recordSkillOutcomeAsync).not.toHaveBeenCalled();
  });

  it("records a failure for a turn nothing judged", async () => {
    expect(await applyCorrection(turn({ recorded: null }))).toEqual({ revised: 0, recorded: 2 });
    expect(recordSkillOutcomeAsync).toHaveBeenCalledWith("/tmp/ws", "hotel-search", "failure");
    expect(recordSkillHoldoutOutcomeAsync).toHaveBeenCalledWith("/tmp/ws", "travel-planner", "failure");
    expect(reviseSkillSuccessToFailureAsync).not.toHaveBeenCalled();
  });

  it("leaves a turn that already failed as it is", async () => {
    expect(await applyCorrection(turn({ recorded: "failure" }))).toEqual({ revised: 0, recorded: 0 });
    expect(recordSkillOutcomeAsync).not.toHaveBeenCalled();
    expect(reviseSkillSuccessToFailureAsync).not.toHaveBeenCalled();
  });
});

describe("the check at the start of a turn", () => {
  const check = (over: Partial<Parameters<typeof checkPreviousTurnCorrection>[0]> = {}) => checkPreviousTurnCorrection({
    sessionId: "s1", channel: "web", userMessage: "I asked for Leiden, not Utrecht.", provider: () => provider, ...over,
  });

  it("judges the message against the previous answer and revises what that turn recorded", async () => {
    rememberLearnedTurn("s1", turn());
    await check();
    expect(state.judged[0]).toContain("Here are three hotels near the station in Utrecht.");
    expect(state.judged[0]).toContain("I asked for Leiden, not Utrecht.");
    expect(reviseSkillSuccessToFailureAsync).toHaveBeenCalledWith("/tmp/ws", "hotel-search");
    expect(logAudit).toHaveBeenCalledWith("user_correction_detected", expect.objectContaining({ previousOutcome: "success", revised: 2 }), expect.objectContaining({ sessionId: "s1" }));
  });

  it("changes nothing when the message continues", async () => {
    state.verdict = "CONTINUES";
    rememberLearnedTurn("s1", turn());
    await check({ userMessage: "Which one is cheapest?" });
    expect(reviseSkillSuccessToFailureAsync).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("asks nothing while the signal is off, for eval traffic, or with no turn to answer", async () => {
    state.enabled = false;
    rememberLearnedTurn("s1", turn());
    expect(check()).toBeUndefined();
    state.enabled = true;
    expect(check({ channel: "eval" })).toBeUndefined();
    expect(check({ sessionId: "s-unknown" })).toBeUndefined();
    rememberLearnedTurn("s1", turn({ recorded: "failure" }));
    expect(check()).toBeUndefined();
    expect(complete).not.toHaveBeenCalled();
  });
});
