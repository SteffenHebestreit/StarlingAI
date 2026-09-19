/**
 * Routing fusion — the decision core.
 *
 * Two things are pinned here above all else:
 *   1. the facets never move a candidate across its family floor, in either direction, and
 *   2. every branch rule fires for the reason it claims, checked by flipping exactly one
 *      input and watching the branch change.
 *
 * Several cases below are replays of incidents: the e1151d8 floor regression, the deck-job
 * hijack of a hardware question, the over-planning of a small compound request, and the
 * forced delegation of a question about a pasted document.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FUSION_TUNING,
  fuseRouting,
  needsCoordination,
  workflowDispatchable,
  type RoutingCandidate,
  type ScoredCandidate,
} from "../agent/routing-fusion.js";
import type { ResolvedTaxonomy } from "../agent/routing-taxonomy.js";
import type { TriageVerdict } from "../agent/triage.js";

const AGENT_FLOOR = 0.72;

function taxonomy(partial: Partial<ResolvedTaxonomy> = {}): ResolvedTaxonomy {
  return {
    mode: "GATHER",
    domain: ["research"],
    deliverable: ["evidence"],
    completes: ["evidence"],
    inputModality: ["url"],
    riskTier: "read_only",
    executionShape: "single_agent",
    surface: ["external_network"],
    source: "generated",
    ...partial,
  };
}

function agent(name: string, score: number, tax: Partial<ResolvedTaxonomy> = {}): RoutingCandidate {
  return { name, family: "agent", score, floor: AGENT_FLOOR, taxonomy: taxonomy(tax) };
}

function workflow(name: string, score: number, tax: Partial<ResolvedTaxonomy> = {}): RoutingCandidate {
  return {
    name, family: "workflow", score, floor: 0.775, paramsSatisfied: true,
    taxonomy: taxonomy({ executionShape: "workflow", ...tax }),
  };
}

function verdict(partial: Partial<TriageVerdict> = {}): TriageVerdict {
  return {
    mode: "GATHER",
    domain: ["research"],
    deliverable: "evidence",
    multi: false,
    parts: [],
    alone: true,
    sourceSensitive: true,
    decision: "single_agent",
    missing: [],
    queryEn: "",
    language: "en",
    confidence: 0.9,
    ...partial,
  };
}

describe("the floor invariant", () => {
  it("never admits a below-floor candidate, however well its labels agree", () => {
    // This is the e1151d8 shape from the other side: if the facets could rescue a
    // sub-floor entry, a small model's label would be able to reopen a gate that a
    // production outage taught us to respect.
    const decision = fuseRouting({
      candidates: [{ ...agent("researcher", 0.7059), taxonomy: taxonomy() }],
      verdict: verdict({ confidence: 1 }),
    });
    expect(decision.shortlist).toEqual([]);
    expect(decision.branch).toBe("general");
    expect(decision.reasons[0]).toContain("no candidate cleared its floor");
  });

  it("never evicts an above-floor candidate, however badly its labels disagree", () => {
    // Disagreement on ALL THREE facets — mode, domain AND deliverable. Getting this fixture
    // right matters: an earlier version shared the deliverable with the request and so still
    // earned a bonus, which would have made this assertion pass for the wrong reason.
    const decision = fuseRouting({
      candidates: [agent("researcher", 0.9, { mode: "ACT", domain: ["comms"], deliverable: ["message"] })],
      verdict: verdict({ mode: "GATHER", domain: ["research"], deliverable: "evidence", confidence: 1 }),
    });
    expect(decision.shortlist.map((candidate) => candidate.name)).toEqual(["researcher"]);
    // It stays, it just earns nothing.
    expect(decision.shortlist[0]!.fusedFit).toBeCloseTo(decision.shortlist[0]!.fit, 6);
    expect(decision.agreementClass).toBe("none");
  });

  it("caps the bonus, so a perfect label cannot outrank a much better embedding match", () => {
    const decision = fuseRouting({
      candidates: [
        agent("strong_but_mislabelled", 0.95, { mode: "ACT", domain: ["comms"] }),
        agent("weak_but_labelled", 0.73),
      ],
      verdict: verdict({ confidence: 1 }),
    });
    expect(decision.shortlist[0]!.name).toBe("strong_but_mislabelled");
    // DISCRIMINANCE: raise maxBonus far beyond its cap and the order flips — which is
    // exactly what the cap exists to prevent.
    const uncapped = fuseRouting({
      candidates: [
        agent("strong_but_mislabelled", 0.95, { mode: "ACT", domain: ["comms"] }),
        agent("weak_but_labelled", 0.73),
      ],
      verdict: verdict({ confidence: 1 }),
      tuning: { ...DEFAULT_FUSION_TUNING, domainBonus: 0.9, maxBonus: 0.9 },
    });
    expect(uncapped.shortlist[0]!.name).toBe("weak_but_labelled");
  });

  it("scales the bonus by the classifier's own confidence", () => {
    const confident = fuseRouting({ candidates: [agent("a", 0.8)], verdict: verdict({ confidence: 1 }) });
    const unsure = fuseRouting({ candidates: [agent("a", 0.8)], verdict: verdict({ confidence: 0.2 }) });
    expect(confident.shortlist[0]!.fusedFit).toBeGreaterThan(unsure.shortlist[0]!.fusedFit);
    expect(unsure.shortlist[0]!.fusedFit).toBeGreaterThan(unsure.shortlist[0]!.fit);
  });

  it("ranks on fit, so families with different floors compare fairly", () => {
    // 0.80 for an agent (floor 0.72) is 0.29 of its headroom; 0.80 for a workflow
    // (floor 0.775) is only 0.11 of its own. Raw scores would call them equal.
    const decision = fuseRouting({
      candidates: [agent("agent_a", 0.80), workflow("wf_a", 0.80)],
      verdict: null,
    });
    expect(decision.shortlist[0]!.name).toBe("agent_a");
    expect(decision.shortlist[0]!.fit).toBeGreaterThan(decision.shortlist[1]!.fit);
  });
});

describe("adaptive K", () => {
  it("collapses to one candidate when the leader is decisive", () => {
    const decision = fuseRouting({
      candidates: [agent("a", 0.99), agent("b", 0.73)],
      verdict: null,
    });
    expect(decision.k).toBe(1);
  });

  it("keeps the cluster when the field is flat", () => {
    const decision = fuseRouting({
      candidates: [agent("a", 0.80), agent("b", 0.79), agent("c", 0.785), agent("d", 0.78)],
      verdict: null,
    });
    expect(decision.k).toBeGreaterThan(2);
    expect(decision.shortlist).toHaveLength(decision.k);
  });

  it("widens for a multi-part request so the coordinator sees enough to cover it", () => {
    const flat = [agent("a", 0.80), agent("b", 0.795), agent("c", 0.79), agent("d", 0.785), agent("e", 0.78), agent("f", 0.775), agent("g", 0.77)];
    const single = fuseRouting({ candidates: flat, verdict: verdict() });
    const multi = fuseRouting({ candidates: flat, verdict: verdict({ multi: true, parts: ["one", "two"] }) });
    expect(multi.k).toBeGreaterThan(single.k);
  });
});

describe("branch rules", () => {
  it("rule 2: an explicit agent directive outranks every other signal", () => {
    const decision = fuseRouting({
      candidates: [agent("researcher", 0.95)],
      verdict: verdict({ decision: "coordinate", multi: true, parts: ["a", "b"] }),
      flags: { directiveAgent: "shell_agent" },
    });
    expect(decision.branch).toBe("directive");
    expect(decision.target).toBe("shell_agent");
  });

  it("rule 3: a question about pasted content is answered, not delegated to re-fetch it", () => {
    // The incident this replays: a user pastes a config and asks for an explanation, and
    // the turn delegates to inspect the live system it was just shown.
    const decision = fuseRouting({
      candidates: [agent("shell_agent", 0.9, { mode: "ACT", domain: ["infra_ops"] })],
      verdict: verdict({ mode: "GATHER", sourceSensitive: true, decision: "single_agent" }),
      flags: { inlineAnalyticalContent: true },
    });
    expect(decision.branch).toBe("answer_direct");
    // And it must not arm forced research: the evidence is in the turn.
    expect(decision.sourceSensitive).toBe(false);
  });

  it("rule 3: a document-grounded turn is not forced into a web lookup", () => {
    const decision = fuseRouting({
      candidates: [agent("researcher", 0.9)],
      verdict: verdict({ sourceSensitive: true }),
      flags: { documentGrounded: true },
    });
    expect(decision.branch).toBe("answer_direct");
    expect(decision.sourceSensitive).toBe(false);
  });

  it("rule 4: a conceptual question is answered even when an agent embeds close to its subject", () => {
    // DISCRIMINANCE for rule ORDER: with single_agent evaluated first, this returns
    // single_agent and the turn is forced to delegate a question needing no tool.
    const decision = fuseRouting({
      candidates: [agent("researcher", 0.93)],
      verdict: verdict({ decision: "answer_direct", sourceSensitive: false, mode: "GATHER" }),
    });
    expect(decision.branch).toBe("answer_direct");
  });

  it("rule 4 yields to a URL in the request: that is a fetch, not a direct answer", () => {
    const decision = fuseRouting({
      candidates: [agent("researcher", 0.93)],
      verdict: verdict({ decision: "answer_direct", sourceSensitive: false }),
      flags: { hasUrl: true },
    });
    expect(decision.branch).not.toBe("answer_direct");
  });

  it("rule 5: a workflow runs only when its deliverable is what was asked for", () => {
    const deckJob = workflow("sourced_presentation", 0.9, { mode: "PRODUCE", domain: ["authoring"], deliverable: ["deck"] });
    // The 7839e153 incident: a hardware DESIGN question, no deck requested, routed into a
    // twelve-slide deck job. The classifier cannot save us here — it is catalog-blind, so
    // its "workflow" vote is not evidence about THIS workflow.
    const hijack = fuseRouting({
      candidates: [deckJob],
      verdict: verdict({ mode: "PRODUCE", domain: ["software"], deliverable: "prose_doc", decision: "workflow" }),
    });
    expect(hijack.branch).not.toBe("workflow");

    const genuine = fuseRouting({
      candidates: [deckJob],
      verdict: verdict({ mode: "PRODUCE", domain: ["authoring"], deliverable: "deck", decision: "workflow" }),
    });
    expect(genuine.branch).toBe("workflow");
    expect(genuine.target).toBe("sourced_presentation");
  });

  it("rule 5: a side-effecting workflow is never dispatched mechanically", () => {
    const broadcast = workflow("multi_channel_broadcast", 0.95, {
      mode: "ACT", domain: ["comms"], deliverable: ["message"],
      riskTier: "external_send", surface: ["user_channel"],
    });
    const decision = fuseRouting({
      candidates: [broadcast],
      verdict: verdict({ mode: "ACT", domain: ["comms"], deliverable: "message", decision: "workflow" }),
    });
    expect(decision.branch).not.toBe("workflow");
    expect(workflowDispatchable({ ...broadcast, fit: 1, fusedFit: 1, agreement: 1 } as ScoredCandidate, verdict({ mode: "ACT", deliverable: "message" })).reason)
      .toContain("external side effects");
  });

  it("rule 6: coordinates when the work spans two domains", () => {
    const decision = fuseRouting({
      candidates: [agent("researcher", 0.9), agent("content_writer", 0.88, { mode: "PRODUCE", domain: ["authoring"] })],
      verdict: verdict({ domain: ["research", "authoring"], multi: true, parts: ["research it", "write it up"] }),
    });
    expect(decision.branch).toBe("coordinate");
    expect(decision.reasons[0]).toContain("spans 2 domains");
  });

  it("rule 6: does NOT coordinate a multi-part request whose parts land on one specialist", () => {
    // Over-planning is the expensive failure: a coordinator costs two orchestrator calls
    // and a plan. Two clauses for the same specialist is a list, not a mission.
    const decision = fuseRouting({
      candidates: [agent("researcher", 0.95)],
      verdict: verdict({ multi: true, parts: ["find A", "and also find B"], domain: ["research"] }),
    });
    expect(decision.branch).toBe("single_agent");
    expect(needsCoordination(verdict({ multi: true, parts: ["a", "b"] }), decision.shortlist).coordinate).toBe(false);
  });

  it("rule 6: a coordinator-shaped best match coordinates", () => {
    const decision = fuseRouting({
      candidates: [agent("mission_coordinator", 0.9, { mode: "ORCHESTRATE", domain: ["cross_domain"], executionShape: "needs_coordination", deliverable: ["none"], completes: [] })],
      verdict: verdict(),
    });
    expect(decision.branch).toBe("coordinate");
    expect(decision.target).toBe("mission_coordinator");
  });

  it("rule 7: dispatches one specialist when the labels and the scores agree", () => {
    const decision = fuseRouting({
      candidates: [agent("researcher", 0.95), agent("summarizer", 0.74, { mode: "PRODUCE", domain: ["authoring"] })],
      verdict: verdict(),
    });
    expect(decision.branch).toBe("single_agent");
    expect(decision.target).toBe("researcher");
    expect(decision.agreementClass).toBe("strong");
  });

  it("rule 7: refuses to dispatch on an English-restatement-only match", () => {
    // The restatement comes from the same model that produced the labels. Letting it both
    // retrieve the candidate and vouch for it counts one signal twice.
    const decision = fuseRouting({
      candidates: [{ ...agent("researcher", 0.95), admittedByRawQuery: false }],
      verdict: verdict(),
    });
    expect(decision.branch).not.toBe("single_agent");
    expect(decision.branch).toBe("general");
  });

  it("rule 7: refuses to dispatch when the modes are incompatible", () => {
    const decision = fuseRouting({
      candidates: [agent("mail_agent", 0.95, { mode: "ACT", domain: ["comms"] })],
      verdict: verdict({ mode: "GATHER", domain: ["comms"] }),
    });
    expect(decision.branch).toBe("general");
  });

  it("rule 7: refuses when the classifier says one unit cannot finish it", () => {
    const decision = fuseRouting({
      candidates: [agent("researcher", 0.95)],
      verdict: verdict({ alone: false }),
    });
    expect(decision.branch).toBe("general");
  });

  it("rule 8: asks once, and only when someone is there to answer", () => {
    const missing = verdict({ decision: "clarify", missing: ["which environment"], confidence: 0.8, alone: false });
    const asked = fuseRouting({ candidates: [agent("shell_agent", 0.74)], verdict: missing });
    expect(asked.branch).toBe("clarify");

    // --auto: nobody is there. Proceeding on an assumption beats dead-ending on a question.
    expect(fuseRouting({ candidates: [agent("shell_agent", 0.74)], verdict: missing, flags: { autonomous: true } }).branch)
      .not.toBe("clarify");
    // Never twice in a row.
    expect(fuseRouting({ candidates: [agent("shell_agent", 0.74)], verdict: missing, flags: { afterClarify: true } }).branch)
      .not.toBe("clarify");
    // And not when a specialist clearly covers it anyway.
    expect(fuseRouting({ candidates: [agent("shell_agent", 0.95)], verdict: missing }).branch).not.toBe("clarify");
  });

  it("rule 1: no verdict means today's behaviour, not a new one", () => {
    const decision = fuseRouting({ candidates: [agent("researcher", 0.95)], verdict: null });
    expect(decision.branch).toBe("legacy");
    expect(decision.agreementClass).toBe("unknown");
    // The shortlist is still computed — it is a useful hint even unlabelled.
    expect(decision.shortlist).toHaveLength(1);
  });

  it("always yields a branch — no input combination dead-ends", () => {
    const inputs = [
      { candidates: [], verdict: null },
      { candidates: [], verdict: verdict() },
      { candidates: [agent("a", 0.73)], verdict: verdict({ mode: "converse", domain: [], decision: "answer_direct", sourceSensitive: false }) },
      { candidates: [workflow("w", 0.9)], verdict: verdict({ decision: "clarify", missing: [] }) },
    ];
    for (const input of inputs) {
      const decision = fuseRouting(input);
      expect(decision.branch).toBeTruthy();
      expect(decision.reasons.length).toBeGreaterThan(0);
    }
  });
});

describe("agreement class", () => {
  it("reports how far the two signals actually agree, for shadow mining", () => {
    const strong = fuseRouting({ candidates: [agent("researcher", 0.9)], verdict: verdict() });
    expect(strong.agreementClass).toBe("strong");

    const none = fuseRouting({
      candidates: [agent("researcher", 0.9, { mode: "ACT", domain: ["comms"], deliverable: ["message"] })],
      verdict: verdict({ mode: "GATHER", domain: ["research"], deliverable: "evidence" }),
    });
    expect(none.agreementClass).toBe("none");
  });
});
