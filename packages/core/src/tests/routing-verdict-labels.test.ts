/**
 * Routing-tier verdict calls carry their own label in the provider audit row. Unlabelled, each read
 * as the caller's own call — main_turn or sub_agent — so a decision's cost could not be told from
 * the work around it (review of the thinking-off verdicts, D4). The label is read where the real
 * provider reads it: the request context at the moment `complete` runs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { currentCallAttribution, runWithRequestContext } from "../runtime/request-context.js";

const seen = vi.hoisted(() => ({ attributions: [] as Array<Record<string, unknown>>, reply: "" }));

vi.mock("../providers/index.js", () => ({
  getChatProviderForTier: () => ({
    complete: async () => {
      seen.attributions.push({ ...currentCallAttribution().data });
      return { content: seen.reply, tool_calls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop" };
    },
  }),
}));

const { checkSubAgentDisagreement } = await import("../agent/sub-agent-disagreement.js");
const { assessOversightGoalMet } = await import("../agent/sub-agent.js");

describe("routing-tier verdict labels", () => {
  beforeEach(() => {
    seen.attributions.length = 0;
  });

  it("labels the disagreement check inside a worker's context", async () => {
    seen.reply = "AGREE";
    await runWithRequestContext({ agentName: "researcher", callSite: "sub_agent" }, () =>
      checkSubAgentDisagreement([{ label: "a", text: "x" }, { label: "b", text: "y" }]));
    expect(seen.attributions).toEqual([{ agentName: "disagreement_check", callSite: "routing_tier" }]);
  });

  it("labels the goal-met oversight inside a worker's context", async () => {
    seen.reply = "CONTINUE";
    await runWithRequestContext({ agentName: "researcher", callSite: "sub_agent" }, () =>
      assessOversightGoalMet(["the table lists three offers"], "one offer found"));
    expect(seen.attributions).toEqual([{ agentName: "goal_met_oversight", callSite: "routing_tier" }]);
  });
});
