import { describe, expect, it } from "vitest";
import { buildModelVisibleToolResult, isExplicitDelegationSuccess, looksLikeDelegatedFailureEvidence } from "../agent/tool-result-format.js";
import { classifyPostOrchestrationDisposition } from "../agent/runtime.js";

// A specialist that ended its loop normally while asking for data it never got.
const NEEDS_DATA = "Task cannot be completed: the workspace holds no Q3 revenue source data. "
  + "Please provide the structured JSON data to proceed, or point me at the file.";
// A finished deliverable whose prose mentions a failed attempt along the way.
const REPORT = "The first attempt failed to reach the vendor site, so I used the cached datasheet. "
  + "Findings: the sensor draws 12 mA at 3.3 V; the interface is I2C; the datasheet revision is 1.4.";

/** What tools/sub-agent.ts mints on every normally-ending delegation — a default, not a verdict. */
const HEURISTIC = {
  agentName: "researcher",
  delegationSucceeded: true,
  delegationOutcome: "success",
  delegationVerdict: "heuristic",
  terminalState: "completed",
};
/** The sub-agent closed with `<final_answer status="success">`. */
const EXPLICIT = { ...HEURISTIC, delegationVerdict: "explicit" };

const disposition = (content: string, metadata: Record<string, unknown>) =>
  classifyPostOrchestrationDisposition([{ role: "tool", tool_call_id: "call_1", content, metadata }] as never);

describe("delegation verdicts — only an explicit one beats the prose sniff", () => {
  it("a heuristic 'success' does not silence the needs-data / blocker signatures", () => {
    // The default verdict is a five-phrase regex over the first 300 characters; it says nothing
    // about whether the task was done. Trusting it reframed this as TASK COMPLETED.
    const framed = buildModelVisibleToolResult("delegate_to_agent", NEEDS_DATA, HEURISTIC);
    expect(framed).toMatch(/TASK FAILED/);
    expect(disposition(framed, HEURISTIC)).toBe("failure");
  });

  it("an explicit success verdict is trusted over a mention of a failed attempt", () => {
    const framed = buildModelVisibleToolResult("delegate_to_agent", REPORT, EXPLICIT);
    expect(framed).toMatch(/TASK COMPLETED/);
    expect(framed).not.toMatch(/TASK FAILED/);
    expect(disposition(framed, EXPLICIT)).not.toBe("failure");
  });

  it("the frame and the post-orchestration classifier apply the same rule", () => {
    for (const metadata of [HEURISTIC, EXPLICIT, { agentName: "researcher", delegationSucceeded: true }, { ...HEURISTIC, delegationEvidence: true }]) {
      const framed = buildModelVisibleToolResult("delegate_to_agent", REPORT, metadata);
      expect(disposition(framed, metadata) === "failure").toBe(/TASK FAILED/.test(framed));
    }
  });

  it("does not let an explicit success cover a structural failure the runtime cannot see", () => {
    // The verdict was minted by the same run that produced the placeholder / the container error.
    for (const text of ["Sub-agent produced no final response.", "Sub-agent 'coder' container error: unknown"]) {
      expect(buildModelVisibleToolResult("delegate_to_agent", text, { ...EXPLICIT, agentName: "coder" })).toMatch(/TASK FAILED/);
    }
  });

  // 2026-10-05: generic failure vocabulary is as often the SUBJECT of a good answer as a report
  // of failure. It no longer marks a result failed when the result carries concrete evidence; a
  // statement about the TASK ("task cannot be completed, please provide …") still does.
  // The evidence that sets a failure WORD aside is judged upstream, where the task is known
  // (tools/sub-agent.ts → metadata.delegationEvidence). From the text alone, figures echoed from the
  // task looked like evidence (review 2026-10-05: "No results found for the 2 A / 5 V charger query").
  it("a failure word inside an answer with its OWN evidence is not a failure; a task blocker still is", () => {
    const WITH_EVIDENCE = { ...HEURISTIC, delegationEvidence: true };
    expect(looksLikeDelegatedFailureEvidence(REPORT, { ownEvidence: true })).toBe(false);
    expect(buildModelVisibleToolResult("delegate_to_agent", REPORT, WITH_EVIDENCE)).toMatch(/TASK COMPLETED/);
    expect(disposition(buildModelVisibleToolResult("delegate_to_agent", REPORT, WITH_EVIDENCE), WITH_EVIDENCE)).not.toBe("failure");
    // Without the upstream verdict the text alone decides, as before: echoed figures are no rescue.
    expect(looksLikeDelegatedFailureEvidence(REPORT)).toBe(true);
    expect(looksLikeDelegatedFailureEvidence("No results found for the 2 A / 5 V charger query.")).toBe(true);
    // A blocker and an opening "Error:" are failures even with evidence.
    expect(looksLikeDelegatedFailureEvidence(NEEDS_DATA, { ownEvidence: true })).toBe(true);
    expect(looksLikeDelegatedFailureEvidence("Error: the page returned 3 KB of markup and no table.", { ownEvidence: true })).toBe(true);
  });

  it("reads the verdict's source, not the defaulted outcome", () => {
    expect(isExplicitDelegationSuccess(HEURISTIC)).toBe(false);
    expect(isExplicitDelegationSuccess(EXPLICIT)).toBe(true);
    expect(isExplicitDelegationSuccess({ ...EXPLICIT, delegationOutcome: "partial" })).toBe(false);
    expect(isExplicitDelegationSuccess(undefined)).toBe(false);
  });
});
