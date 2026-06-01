import { describe, expect, it } from "vitest";
import { agentCfgCanFulfillArtifactTask, isArtifactRenderTask, taskRequiresExternalResearch } from "../tools/sub-agent.js";

// Session 2d810e7d (2026-05-28) regression: a CPSA-F "erzeuge mir eine
// vollumfängliche Lernwebsite" delegation was routed to an agent without
// any write/edit/exec/coordinator tool, which then narrated a review of
// nothing while burning the delegation budget. The pure predicate below is
// what the swarm_delegate / parallel_delegate routing path consults before
// queueing a candidate.

describe("agentCfgCanFulfillArtifactTask", () => {
  it("accepts an agent with write_file when the task asks for a deliverable", () => {
    expect(
      agentCfgCanFulfillArtifactTask(
        "erzeuge mir eine vollumfängliche Lernwebsite um die folgende Zertifizierung zu bestehen",
        { tools: ["write_file", "read_file"] },
      ),
    ).toBe(true);
  });

  it("rejects a read-only audit agent for the CPSA-F website task", () => {
    expect(
      agentCfgCanFulfillArtifactTask(
        "erzeuge mir eine vollumfängliche Lernwebsite um die folgende Zertifizierung zu bestehen",
        { tools: ["read_file", "list_files", "workspace_search"] },
      ),
    ).toBe(false);
  });

  it("accepts a coordinator that can fan out via delegate_to_agent", () => {
    expect(
      agentCfgCanFulfillArtifactTask(
        "create a multi-file static website for the certification",
        { tools: ["delegate_to_agent", "parallel_delegate"] },
      ),
    ).toBe(true);
  });

  it("accepts generate_website / generate_document tools as artifact-producing", () => {
    expect(
      agentCfgCanFulfillArtifactTask(
        "build me the full CPSA-F learning site",
        { tools: ["generate_website"] },
      ),
    ).toBe(true);
    expect(
      agentCfgCanFulfillArtifactTask(
        "schreibe einen Bericht",
        { tools: ["generate_document"] },
      ),
    ).toBe(true);
    expect(
      agentCfgCanFulfillArtifactTask(
        "create a reveal.js presentation about Dresden architecture",
        { tools: ["generate_presentation"] },
      ),
    ).toBe(true);
  });

  it("does NOT filter when the task is purely investigative", () => {
    // No write/create/erstelle keyword — no requirement, no filter.
    expect(
      agentCfgCanFulfillArtifactTask(
        "what files reference the routing heuristic?",
        { tools: ["read_file", "list_files"] },
      ),
    ).toBe(true);
    expect(
      agentCfgCanFulfillArtifactTask(
        "research today's news headlines",
        { tools: ["web_search"] },
      ),
    ).toBe(true);
  });

  it("treats an unknown agent config (undefined) as allowed", () => {
    // We do not silently filter agents we can't introspect — let the
    // downstream attempt fail loudly via the artifact-deliverable-miss
    // classifier instead.
    expect(
      agentCfgCanFulfillArtifactTask(
        "erstelle die Lernwebsite",
        undefined,
      ),
    ).toBe(true);
  });

  it("matches both English and German mutation verbs", () => {
    const readOnly = { tools: ["read_file"] };
    for (const task of [
      "create a CPSA-F study site",
      "build the multi-page website",
      "write the report",
      "implement the feature",
      "update the docs",
      "erstelle die Lernwebsite",
      "schreibe einen ausführlichen Bericht",
      "bearbeite das Dokument",
      "konfiguriere das Modell",
    ]) {
      expect(agentCfgCanFulfillArtifactTask(task, readOnly)).toBe(false);
    }
  });
});

// Audit 6b382964: a reveal.js WRITE delegation to content_writer was bounced to
// researcher by the source-sensitive research-incapable redirect (the brief carried
// "cite the official sources / use the verified URLs" wording), and researcher narrated
// but never wrote the deck. isArtifactRenderTask exempts a render/artifact delegation
// aimed at an artifact-capable agent so the writer actually runs. Structural only.
describe("isArtifactRenderTask — render delegations are not research gathers", () => {
  const writerCfg = { tools: ["read_shared_facts", "generate_presentation", "generate_website", "write_file", "share_finding"] };
  const renderTask =
    "Write a complete, self-contained reveal.js HTML presentation about Dresden architecture. "
    + "Use ONLY the verified facts in the context and cite the official source URLs on the relevant slides.";

  it("treats a reveal.js write task to an artifact-capable agent as a render step", () => {
    expect(isArtifactRenderTask(renderTask, writerCfg)).toBe(true);
  });

  it("still flags that same task as research-wording (why the redirect used to fire)", () => {
    // The brief reads as source-sensitive; the exemption is what prevents the bad redirect.
    expect(taskRequiresExternalResearch(`SOURCE-SENSITIVE DELEGATION\n${renderTask}`)).toBe(true);
  });

  it("does NOT treat a write task as a render step for a research-only agent (no write tools)", () => {
    const researcherCfg = { tools: ["web_search", "web_fetch", "read_shared_facts", "share_finding"] };
    expect(isArtifactRenderTask(renderTask, researcherCfg)).toBe(false);
  });

  it("does NOT treat a pure gather task as a render step", () => {
    expect(isArtifactRenderTask("research the Zwinger architecture and confirm the construction dates", writerCfg)).toBe(false);
  });

  it("treats a coordinator that can delegate the build as render-capable", () => {
    expect(isArtifactRenderTask(renderTask, { tools: ["delegate_to_agent", "parallel_delegate"] })).toBe(true);
  });
});
