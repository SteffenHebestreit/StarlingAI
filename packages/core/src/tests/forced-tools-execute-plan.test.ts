import { describe, expect, it } from "vitest";
import { filterForcedOrchestrationTools } from "../agent/runtime.js";

const TOOLS = [
  { name: "execute_plan" },
  { name: "record_plan" },
  { name: "memory_store" },
  { name: "delegate_to_agent" },
];
const names = (plan?: { planRecorded: boolean }) => filterForcedOrchestrationTools(TOOLS, plan).map((t) => t.name);

/**
 * A forced orchestration iteration keeps only the tools that advance the turn. execute_plan
 * advances a planned turn the most — but it can only run a plan that exists, and record_plan
 * was hidden on every forced iteration, so on a first forced iteration execute_plan was a
 * guaranteed "No plan recorded". record_plan is offered exactly once: while no plan exists.
 */
describe("forced orchestration iteration — plan tools", () => {
  it("with no plan yet, offers record_plan once and withholds execute_plan", () => {
    expect(names({ planRecorded: false })).toEqual(["record_plan", "delegate_to_agent"]);
  });

  it("with a plan recorded, offers execute_plan and withholds record_plan", () => {
    expect(names({ planRecorded: true })).toEqual(["execute_plan", "delegate_to_agent"]);
  });

  it("without plan knowledge, keeps execute_plan and still drops the no-op escape hatches", () => {
    expect(names()).toEqual(["execute_plan", "delegate_to_agent"]);
  });
});
