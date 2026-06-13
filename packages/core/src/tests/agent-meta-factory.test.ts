import { describe, expect, it } from "vitest";
import { agentCfgIsMetaFactory } from "../tools/sub-agent.js";

// agentCfgIsMetaFactory is the signal routeAgentCandidates and the autonomous
// bidding step use to keep meta/factory agents out of UNDIRECTED selection
// (audit c33e65dd: a plain research question auto-routed to agent_factory, which
// then tried to mint a bespoke agent and crashed). A meta/factory agent is one
// that holds create_ephemeral_agent — it should only ever be invoked by an
// explicit agentName, never auto-picked for ordinary work.
describe("agentCfgIsMetaFactory", () => {
  it("flags an agent that holds create_ephemeral_agent", () => {
    expect(agentCfgIsMetaFactory({
      tools: ["list_agents", "delegate_to_agent", "create_ephemeral_agent", "read_shared_facts"],
    })).toBe(true);
  });

  it("does not flag an ordinary specialist", () => {
    expect(agentCfgIsMetaFactory({ tools: ["web_search", "web_fetch"] })).toBe(false);
  });

  it("does not flag a coordinator that only delegates", () => {
    expect(agentCfgIsMetaFactory({ tools: ["delegate_to_agent", "parallel_delegate", "read_shared_facts"] })).toBe(false);
  });

  it("treats a missing/empty tool list as non-factory", () => {
    expect(agentCfgIsMetaFactory(undefined)).toBe(false);
    expect(agentCfgIsMetaFactory({})).toBe(false);
    expect(agentCfgIsMetaFactory({ tools: [] })).toBe(false);
  });
});
