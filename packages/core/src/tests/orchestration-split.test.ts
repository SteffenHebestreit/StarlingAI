import { describe, expect, it } from "vitest";
import { splitOrchestrationModule } from "../agent/session.js";

const full = [
  "You are the assistant.",
  "",
  "## Core Principles",
  "- be honest",
  "",
  "## Swarm Rules",
  "- delegate to specialists",
  "",
  "## Tool Use Discipline",
  "- use tools deliberately",
  "",
  "## Orchestration Strategy",
  "- search then delegate",
  "",
  "## Proactive Memory",
  "- remember durable facts",
  "",
  "## Security",
  "- never leak secrets",
].join("\n");

describe("splitOrchestrationModule", () => {
  it("lifts the Swarm Rules -> Proactive Memory span into the module; lean base keeps the rest", () => {
    const { leanBase, orchestrationModule } = splitOrchestrationModule(full);
    expect(orchestrationModule).toMatch(/## Swarm Rules/);
    expect(orchestrationModule).toMatch(/## Orchestration Strategy/);
    expect(orchestrationModule).not.toMatch(/## Proactive Memory/); // exclusive upper bound
    expect(leanBase).toMatch(/## Core Principles/);
    expect(leanBase).toMatch(/## Proactive Memory/);
    expect(leanBase).toMatch(/## Security/);
    expect(leanBase).not.toMatch(/## Swarm Rules/);
    expect(leanBase).not.toMatch(/## Orchestration Strategy/);
  });

  it("returns the prompt unchanged + null module when the markers are absent (custom prompt)", () => {
    const custom = "A custom prompt with no swarm markers at all.";
    const { leanBase, orchestrationModule } = splitOrchestrationModule(custom);
    expect(leanBase).toBe(custom);
    expect(orchestrationModule).toBeNull();
  });

  it("is deterministic + idempotent — the warm-keeper's lean base byte-matches the runtime's", () => {
    const a = splitOrchestrationModule(full).leanBase;
    const b = splitOrchestrationModule(full).leanBase;
    expect(a).toBe(b);
    // Re-splitting the lean base is a no-op (no Swarm Rules left) — so warming the lean base
    // can never drift from the live lean base the runtime sends.
    const re = splitOrchestrationModule(a);
    expect(re.orchestrationModule).toBeNull();
    expect(re.leanBase).toBe(a);
  });
});
