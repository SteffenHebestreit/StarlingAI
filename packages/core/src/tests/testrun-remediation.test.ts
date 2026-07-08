/**
 * Remediation for the bad multi-deliverable run (audit 763394da):
 *  #1 plan-driven continuation (a 3-deliverable plan must not ship only step 1)
 *  #2 honest retrieval signal + verification-mention (a cited paper written from
 *     memory must not read as "verified"), + the caveat guard.
 * Covers the config-free pure logic; the runtime wiring is typecheck-covered.
 */
import { describe, it, expect } from "vitest";
import {
  decidePlanContinuation,
  renderPlanContinuationDirective,
  type TurnPlan,
} from "../agent/turn-plan.js";
import {
  metadataShowsExternalRetrieval,
  toolNameIsExternalRetrieval,
  mentionsSourceVerification,
} from "../agent/citation-honesty.js";
import { resolveWorkflowScope } from "../tools/workflow-catalog.js";

function plan(nSteps: number): TurnPlan {
  return {
    objective: "obj",
    steps: Array.from({ length: nSteps }, (_, i) => ({ id: `s${i + 1}`, description: `step ${i + 1}`, kind: "delegate" as const })),
    acceptanceCriteria: [],
    stopConditions: [],
    riskTier: "high",
    wide: false,
    createdAt: "2026-07-08T00:00:00.000Z",
  };
}
const base = { delegationCap: 5, lastDelegationSucceeded: true, enabled: true };

describe("#1 decidePlanContinuation", () => {
  it("continues a 4-step plan after the first delegation (the Zwinger failure)", () => {
    const d = decidePlanContinuation({ ...base, plan: plan(4), executedDelegations: 1 });
    expect(d.continue).toBe(true);
    expect(d.done).toBe(1);
    expect(d.total).toBe(4);
  });
  it("stops once every planned step has run", () => {
    expect(decidePlanContinuation({ ...base, plan: plan(4), executedDelegations: 4 }).continue).toBe(false);
    expect(decidePlanContinuation({ ...base, plan: plan(3), executedDelegations: 3 }).continue).toBe(false);
  });
  it("never continues a single-deliverable plan (synthesize as before)", () => {
    expect(decidePlanContinuation({ ...base, plan: plan(1), executedDelegations: 0 }).continue).toBe(false);
  });
  it("respects the per-turn delegate cap (loop backstop)", () => {
    expect(decidePlanContinuation({ ...base, plan: plan(8), executedDelegations: 5, delegationCap: 5 }).continue).toBe(false);
  });
  it("only extends on SUCCESS — a failed last delegation never continues", () => {
    expect(decidePlanContinuation({ ...base, plan: plan(4), executedDelegations: 1, lastDelegationSucceeded: false }).continue).toBe(false);
  });
  it("is identity when disabled or plan-less", () => {
    expect(decidePlanContinuation({ ...base, plan: plan(4), executedDelegations: 1, enabled: false }).continue).toBe(false);
    expect(decidePlanContinuation({ ...base, plan: null, executedDelegations: 1 }).continue).toBe(false);
  });
  it("renders a directive naming the remaining work", () => {
    const dir = renderPlanContinuationDirective(plan(4), 1, 4);
    expect(dir).toContain("CONTINUE PLAN");
    expect(dir).toContain("completed 1 of them");
    expect(dir).toContain("step 4"); // the plan is rendered so the model can pick the next step
  });
});

describe("#2 external-retrieval signal (honest research detection)", () => {
  it("a write-only content_writer delegation is NOT retrieval (the exact fooling case)", () => {
    // content_writer's bytesByTool from audit 763394da — no web/browser tool.
    const meta = { bytesByTool: { read_shared_facts: 47, generate_document: 26, write_file: 54, share_finding: 185 } };
    expect(metadataShowsExternalRetrieval(meta)).toBe(false);
  });
  it("a researcher delegation that used web tools IS retrieval", () => {
    expect(metadataShowsExternalRetrieval({ bytesByTool: { web_search: 900, web_fetch: 4200, share_finding: 50 } })).toBe(true);
    expect(metadataShowsExternalRetrieval({ bytesByTool: { "browser_navigate": 10 } })).toBe(true);
    expect(metadataShowsExternalRetrieval({ toolsUsed: ["read_file", "url_inspect"] })).toBe(true);
  });
  it("orchestrator-level web tool names are retrieval; write/render tools are not", () => {
    expect(toolNameIsExternalRetrieval("web_fetch")).toBe(true);
    expect(toolNameIsExternalRetrieval("browser_snapshot")).toBe(true);
    expect(toolNameIsExternalRetrieval("search_knowledge_base")).toBe(true);
    expect(toolNameIsExternalRetrieval("generate_document")).toBe(false);
    expect(toolNameIsExternalRetrieval("write_file")).toBe(false);
    expect(toolNameIsExternalRetrieval("delegate_to_agent")).toBe(false);
  });
  it("handles absent/garbage metadata", () => {
    expect(metadataShowsExternalRetrieval(null)).toBe(false);
    expect(metadataShowsExternalRetrieval({})).toBe(false);
    expect(metadataShowsExternalRetrieval("nope")).toBe(false);
  });
});

describe("#2 mentionsSourceVerification (the verification demand/claim)", () => {
  it("catches the Zwinger request + the paper's false 'verified sources' framing", () => {
    expect(mentionsSourceVerification("Verifiziere deine Inhalte gegen online-quellen und referenziere diese.")).toBe(true);
    expect(mentionsSourceVerification("Vollständige Quellenliste mit 10 verifizierten Quellen.")).toBe(true);
    expect(mentionsSourceVerification("Please cite your sources and verify them.")).toBe(true);
  });
  it("does not fire on a plain non-sourced request", () => {
    expect(mentionsSourceVerification("Schreib mir ein kurzes Gedicht über den Herbst.")).toBe(false);
    expect(mentionsSourceVerification("Refactor this function to use a map.")).toBe(false);
  });
});

describe("nested-workflow scope (audit 470bf200 — the sourced_presentation image-step crash)", () => {
  const cfg = { image_sourcer: {}, researcher: {}, content_writer: {}, mission_coordinator: {} } as Record<string, unknown>;
  it("honors a step's declared agent when the nested parent scope excludes it (was a hard crash)", () => {
    // deep_research scene scope (no image_sourcer) nested a job step declaring image_sourcer.
    const r = resolveWorkflowScope(["mission_coordinator", "researcher", "paper_author"], ["image_sourcer"], cfg);
    expect(r.invalidDeclaration).toBe(false);
    expect(r.widened).toBe(true);
    expect(r.agents).toEqual(["image_sourcer"]);
  });
  it("normal intersection is unchanged when it is non-empty (no widening)", () => {
    const r = resolveWorkflowScope(["researcher", "image_sourcer"], ["image_sourcer"], cfg);
    expect(r.widened).toBe(false);
    expect(r.agents).toEqual(["image_sourcer"]);
  });
  it("top-level (no parent scope) passes the declared agents through untouched", () => {
    const r = resolveWorkflowScope(undefined, ["image_sourcer"], cfg);
    expect(r.widened).toBe(false);
    expect(r.agents).toEqual(["image_sourcer"]);
  });
  it("flags a real config error: a step declaring only NON-configured agents", () => {
    const r = resolveWorkflowScope(["researcher"], ["ghost_agent"], cfg);
    expect(r.invalidDeclaration).toBe(true);
    expect(r.agents).toEqual([]);
  });
  it("widening keeps only the config-valid subset of declared agents", () => {
    const r = resolveWorkflowScope(["researcher"], ["image_sourcer", "ghost_agent"], cfg);
    expect(r.widened).toBe(true);
    expect(r.agents).toEqual(["image_sourcer"]);
  });
});
