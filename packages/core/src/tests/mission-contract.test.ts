/**
 * MIS-202 slice 1: mission contracts — root creation, child narrowing, and the
 * no-silent-widening invariant (widening requests are clamped AND reported).
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  getContract,
  getOrCreateRootContract,
  narrowContract,
  resetMissionContractsForTests,
  type MissionContract,
} from "../swarm/mission-contract.js";

function root(overrides: Parameters<typeof getOrCreateRootContract>[1] = {}): MissionContract {
  return getOrCreateRootContract(`root-${Math.random().toString(36).slice(2)}`, overrides);
}

describe("mission contracts (MIS-202)", () => {
  afterEach(() => resetMissionContractsForTests());

  it("root creation is idempotent per root session", () => {
    const a = getOrCreateRootContract("s1", { objective: "first" });
    const b = getOrCreateRootContract("s1", { objective: "second call ignored" });
    expect(b.contractId).toBe(a.contractId);
    expect(b.objective).toBe("first");
    expect(a.depth).toBe(0);
  });

  it("narrowing intersects agent/tool grants; in-bounds requests carry no clamps", () => {
    const parent = root({ allowedAgents: ["researcher", "coder"], allowedTools: ["read_file", "web_search"] });
    const { contract, clamped } = narrowContract(parent, { allowedAgents: ["coder"], allowedTools: ["read_file"] });
    expect(clamped).toEqual([]);
    expect(contract.allowedAgents).toEqual(["coder"]);
    expect(contract.allowedTools).toEqual(["read_file"]);
    expect(contract.parentContractId).toBe(parent.contractId);
    expect(contract.depth).toBe(1);
  });

  it("NO SILENT WIDENING: an out-of-bounds agent request is clamped to the intersection and reported", () => {
    const parent = root({ allowedAgents: ["researcher"] });
    const { contract, clamped } = narrowContract(parent, { allowedAgents: ["researcher", "deployer"] });
    expect(contract.allowedAgents).toEqual(["researcher"]);
    expect(clamped).toHaveLength(1);
    expect(clamped[0]).toMatchObject({ field: "allowedAgents", requested: "deployer" });
  });

  it("an unrestricted parent grants any child restriction; child of a restricted parent cannot escape to unrestricted", () => {
    const open = root({});
    const { contract: restricted, clamped: none } = narrowContract(open, { allowedAgents: ["coder"] });
    expect(none).toEqual([]);
    expect(restricted.allowedAgents).toEqual(["coder"]);
    // Omitting allowedAgents inherits the PARENT's restriction, not "unrestricted".
    const { contract: grandchild } = narrowContract(restricted, {});
    expect(grandchild.allowedAgents).toEqual(["coder"]);
  });

  it("effect reversibility can only narrow; a widening request is clamped and reported", () => {
    const parent = root({ effectPolicy: { maxReversibility: "idempotent" } });
    const { contract: narrower, clamped: ok } = narrowContract(parent, { effectPolicy: { maxReversibility: "pure" } });
    expect(ok).toEqual([]);
    expect(narrower.effectPolicy.maxReversibility).toBe("pure");
    const { contract: clampedChild, clamped } = narrowContract(parent, { effectPolicy: { maxReversibility: "irreversible" } });
    expect(clampedChild.effectPolicy.maxReversibility).toBe("idempotent");
    expect(clamped[0]).toMatchObject({ field: "effectPolicy.maxReversibility", requested: "irreversible", granted: "idempotent" });
  });

  it("deadlines only tighten: a later requested deadline is clamped to the parent's", () => {
    const parentDeadline = "2026-07-17T12:00:00.000Z";
    const parent = root({ deadlineAt: parentDeadline });
    const { contract: sooner, clamped: none } = narrowContract(parent, { deadlineAt: "2026-07-17T11:00:00.000Z" });
    expect(none).toEqual([]);
    expect(sooner.deadlineAt).toBe("2026-07-17T11:00:00.000Z");
    const { contract: later, clamped } = narrowContract(parent, { deadlineAt: "2026-07-17T13:00:00.000Z" });
    expect(later.deadlineAt).toBe(parentDeadline);
    expect(clamped[0]?.field).toBe("deadlineAt");
  });

  it("budget dims take the min under 0-means-unlimited; requesting unlimited under a bounded parent is a clamp", () => {
    const parent = root({ budget: { tokens: 10_000, toolCalls: 0, activeTimeMs: 60_000 } });
    const { contract, clamped } = narrowContract(parent, {
      budget: { tokens: 0, toolCalls: 15, activeTimeMs: 30_000 },
    });
    expect(contract.budget).toEqual({ tokens: 10_000, toolCalls: 15, activeTimeMs: 30_000 });
    expect(clamped).toHaveLength(1);
    expect(clamped[0]).toMatchObject({ field: "budget.tokens", requested: "unlimited", granted: "10000" });
    // Over-asking a bounded dim clamps too.
    const { contract: over, clamped: overClamps } = narrowContract(parent, { budget: { tokens: 50_000 } });
    expect(over.budget.tokens).toBe(10_000);
    expect(overClamps[0]?.field).toBe("budget.tokens");
  });

  it("stop conditions are UNION (a child can add stops, never remove the parent's)", () => {
    const parent = root({ stopConditions: ["deadline reached"] });
    const { contract } = narrowContract(parent, { stopConditions: ["budget exhausted"] });
    expect(contract.stopConditions.sort()).toEqual(["budget exhausted", "deadline reached"]);
  });

  it("contracts are retrievable by id for attempt-linkage replay", () => {
    const parent = root({ objective: "o" });
    const { contract } = narrowContract(parent, {});
    expect(getContract(contract.contractId)?.parentContractId).toBe(parent.contractId);
  });
});
