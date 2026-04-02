import { afterEach, describe, expect, it } from "vitest";
import { announceAgentCapability, getAgentCapabilitySnapshot, resetAgentCapabilityRegistryForTests } from "../swarm/capabilities.js";
import { resetSwarmBusForTests } from "../swarm/bus.js";

describe("Swarm capability announcements", () => {
  afterEach(() => {
    resetAgentCapabilityRegistryForTests();
    resetSwarmBusForTests();
  });

  it("records and returns capability announcements", () => {
    announceAgentCapability({
      sessionId: "sess-1",
      agentName: "coder",
      domain: "coding",
      capabilities: ["typescript", "refactoring"],
      tags: ["code", "repo"],
      availability: "busy",
      activeTaskId: "task-1",
      source: "runtime",
    });

    const snapshot = getAgentCapabilitySnapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({
      agentName: "coder",
      domain: "coding",
      availability: "busy",
      activeTaskId: "task-1",
      source: "runtime",
    });
    expect(snapshot[0]?.capabilities).toContain("typescript");
    expect(snapshot[0]?.stale).toBe(false);
  });

  it("updates an existing agent announcement in place", () => {
    announceAgentCapability({ agentName: "researcher", capabilities: ["search"], availability: "busy" });
    announceAgentCapability({ agentName: "researcher", capabilities: ["search", "synthesis"], availability: "idle" });

    const snapshot = getAgentCapabilitySnapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]?.availability).toBe("idle");
    expect(snapshot[0]?.capabilities).toContain("synthesis");
  });
});