import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTrajectoryDigest,
  digestStepIds,
  distillAndPersist,
  parseDistilledSkill,
  parseSkillUpdateProposal,
  shouldDistill,
  type DistillTurnInput,
} from "../skills/distiller.js";
import { getSkill, listSkillHistory, listSkills, writeSkill } from "../skills/store.js";
import type { SwarmState } from "../tools/registry.js";

function swarmStateFixture(): SwarmState {
  return {
    objective: "build a cited research report",
    startedAt: "2026-05-20T10:00:00.000Z",
    updatedAt: "2026-05-20T10:05:00.000Z",
    tasks: {
      t1: {
        id: "t1",
        title: "Gather sources",
        status: "completed",
        dependsOn: [],
        selectedAgent: "researcher",
        attempts: [{ agentName: "researcher", status: "completed", startedAt: "x", toolNames: ["web_search", "web_fetch"] }],
      },
      t2: {
        id: "t2",
        title: "Verify citations",
        status: "completed",
        dependsOn: ["t1"],
        selectedAgent: "source_verifier",
        attempts: [{ agentName: "source_verifier", status: "completed", startedAt: "x", toolNames: ["share_evidence"] }],
      },
    },
  };
}

function turnInput(workspacePath: string, overrides: Partial<DistillTurnInput> = {}): DistillTurnInput {
  return {
    workspacePath,
    sessionId: "sess-1",
    objective: "Write me a cited research report on protocol X",
    finalAnswer: "Here is a thorough, source-backed report covering the protocol with verified citations and analysis spanning several sections.",
    delegationCount: 3,
    sharedFindings: ["Protocol X uses HMAC for delegation", "Spec published 2025"],
    swarmState: swarmStateFixture(),
    ...overrides,
  };
}

describe("skill distiller — gating", () => {
  const ws = "/tmp/unused";

  it("requires autoAuthor and enabled", () => {
    const input = turnInput(ws);
    expect(shouldDistill(input, { enabled: true, autoAuthor: true, minStepsToAuthor: 3 })).toBe(true);
    expect(shouldDistill(input, { enabled: false, autoAuthor: true, minStepsToAuthor: 3 })).toBe(false);
    expect(shouldDistill(input, { enabled: true, autoAuthor: false, minStepsToAuthor: 3 })).toBe(false);
  });

  it("requires enough delegations and a substantive answer", () => {
    expect(shouldDistill(turnInput(ws, { delegationCount: 1 }), { enabled: true, autoAuthor: true, minStepsToAuthor: 3 })).toBe(false);
    expect(shouldDistill(turnInput(ws, { finalAnswer: "ok" }), { enabled: true, autoAuthor: true, minStepsToAuthor: 3 })).toBe(false);
  });
});

describe("skill distiller — parsing", () => {
  const ids = new Set(["S1", "S2", "F1"]);
  const proposal = (extra: Record<string, unknown> = {}): string => [
    "Here is the skill:",
    "```json",
    JSON.stringify({
      name: "Cited Research Report",
      description: "Produce a source-backed report.",
      whenToUse: "When a cited report is requested.",
      procedure: "1. researcher gathers sources. 2. source_verifier validates. 3. author drafts.",
      tags: ["research"],
      agents: ["researcher", "source_verifier"],
      tools: ["web_search"],
      evidence: { steps: ["S2"], why: "Verifying the citations before drafting kept invented sources out." },
      confidence: "high",
      ...extra,
    }),
    "```",
  ].join("\n");

  it("parses a fenced JSON proposal that rests on the run's steps", () => {
    const parsed = parseDistilledSkill(proposal(), ids);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.skill.name).toBe("Cited Research Report");
    expect(parsed.skill.agents).toContain("source_verifier");
    expect(parsed.skill.evidence).toEqual({ steps: ["S2"], why: expect.stringContaining("citations"), confidence: "high" });
  });

  it("accepts bracketed or lower-case ids and drops the ones the run does not have", () => {
    const parsed = parseDistilledSkill(proposal({ evidence: { steps: ["[s1]", "S9", "F1"], why: "Both steps." } }), ids);
    expect(parsed.ok && parsed.skill.evidence.steps).toEqual(["S1", "F1"]);
  });

  it("declines a proposal that cites no step of the run", () => {
    expect(parseDistilledSkill(proposal({ evidence: undefined }), ids)).toEqual({ ok: false, reason: "no_evidence" });
    expect(parseDistilledSkill(proposal({ evidence: { steps: ["S7"], why: "A step that never ran." } }), ids))
      .toEqual({ ok: false, reason: "no_evidence" });
    expect(parseDistilledSkill(proposal({ evidence: { steps: ["S1"], why: "" } }), ids))
      .toEqual({ ok: false, reason: "no_evidence" });
  });

  it("declines low or unrated confidence", () => {
    expect(parseDistilledSkill(proposal({ confidence: "low" }), ids)).toEqual({ ok: false, reason: "low_confidence" });
    expect(parseDistilledSkill(proposal({ confidence: undefined }), ids)).toEqual({ ok: false, reason: "low_confidence" });
    expect(parseDistilledSkill(proposal({ confidence: "Medium" }), ids).ok).toBe(true);
  });

  it("tells a skip from malformed output", () => {
    expect(parseDistilledSkill('{"skip": true}', ids)).toEqual({ ok: false, reason: "skip" });
    expect(parseDistilledSkill('{"name": "x"}', ids)).toEqual({ ok: false, reason: "malformed" });
    expect(parseDistilledSkill("no json here", ids)).toEqual({ ok: false, reason: "malformed" });
  });

  it("parses targeted update proposals only with evidence", () => {
    const parsed = parseSkillUpdateProposal(JSON.stringify({
      action: "patch",
      oldString: "2. Publish.",
      newString: "2. Smoke test.\n3. Publish.",
      evidence: { steps: ["S1"], why: "The smoke test caught the broken build." },
      confidence: "medium",
    }), ids);
    expect(parsed.ok && parsed.proposal.action).toBe("patch");
    if (parsed.ok && parsed.proposal.action === "patch") expect(parsed.proposal.oldString).toBe("2. Publish.");
    expect(parseSkillUpdateProposal('{"action":"skip","reason":"covered"}', ids)).toEqual({
      ok: true, proposal: { action: "skip", reason: "covered" },
    });
    expect(parseSkillUpdateProposal(JSON.stringify({ action: "patch", oldString: "a", newString: "b" }), ids))
      .toEqual({ ok: false, reason: "no_evidence" });
  });
});

describe("skill distiller — digest", () => {
  it("summarizes delegations and evidence as numbered steps", () => {
    const digest = buildTrajectoryDigest(turnInput("/tmp/unused"));
    expect(digest).toContain("[S1] Gather sources → researcher");
    expect(digest).toContain("web_search");
    expect(digest).toContain("Evidence gathered");
    expect(digest).toContain("[F2] Spec published 2025");
    expect([...digestStepIds(digest!)]).toEqual(["S1", "S2", "F1", "F2"]);
  });

  it("returns null when there is nothing to learn from", () => {
    const digest = buildTrajectoryDigest({
      workspacePath: "/tmp/unused",
      sessionId: "s",
      objective: "o",
      finalAnswer: "a",
      delegationCount: 0,
      sharedFindings: [],
      swarmState: undefined,
    });
    expect(digest).toBeNull();
  });
});

describe("skill distiller — persist", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function workspace(): string {
    const dir = mkdtempSync(join(tmpdir(), "starlingai-distill-"));
    dirs.push(dir);
    return dir;
  }

  const reportSkill = (extra: Record<string, unknown> = {}): string =>
    "```json\n" + JSON.stringify({
      name: "Cited Research Report",
      description: "Produce a source-backed report grounded in verified citations.",
      whenToUse: "When the user asks for a cited research report.",
      procedure: "1. Delegate to researcher for sources. 2. source_verifier validates. 3. Draft and synthesize.",
      tags: ["research", "citations"],
      agents: ["researcher", "source_verifier"],
      tools: ["web_search", "share_evidence"],
      evidence: { steps: ["S1", "S2"], why: "Sources were verified before the draft was written." },
      confidence: "high",
      ...extra,
    }) + "\n```";

  it("writes a distilled draft skill from a successful trajectory, with the evidence it rests on", async () => {
    const ws = workspace();
    let prompt = "";
    const result = await distillAndPersist(
      turnInput(ws, { objective: "Write a cited research report about HMAC delegation protocols", outcomeBasis: "qa_pass" }),
      async (p) => { prompt = p; return reportSkill(); },
    );

    expect(prompt).toContain("A QA review checked the final answer");
    expect(prompt).toContain("[S1] Gather sources");
    expect(result?.name).toBe("Cited Research Report");
    const skills = listSkills(ws);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.meta.origin).toBe("distilled");
    expect(skills[0]?.frontmatter.status).toBe("draft");
    expect(skills[0]?.meta.learnedFrom).toEqual({
      basis: "qa_pass",
      steps: ["S1", "S2"],
      why: "Sources were verified before the draft was written.",
      confidence: "high",
    });
  });

  it("writes nothing when the proposal cites no step of the run or rates itself low", async () => {
    const ws = workspace();
    const noEvidence = await distillAndPersist(
      turnInput(ws, { objective: "Write a cited research report about delegation token rotation" }),
      async () => reportSkill({ evidence: { steps: ["S5"], why: "A step the run never had." } }),
    );
    const lowConfidence = await distillAndPersist(
      turnInput(ws, { objective: "Write a cited research report about federation handshakes" }),
      async () => reportSkill({ confidence: "low" }),
    );
    expect(noEvidence).toBeNull();
    expect(lowConfidence).toBeNull();
    expect(listSkills(ws)).toHaveLength(0);
  });

  it("refuses evidence text that carries a credential, like any other skill content", async () => {
    const ws = workspace();
    const credentialShaped = ["api", "_key"].join("") + "=" + "x".repeat(16);
    const result = await distillAndPersist(
      turnInput(ws, { objective: "Write a cited research report about signed webhook payloads" }),
      async () => reportSkill({ evidence: { steps: ["S1"], why: `It worked once ${credentialShaped} was set.` } }),
    );
    expect(result).toBeNull();
    expect(listSkills(ws)).toHaveLength(0);
  });

  it("asks for an update instead of creating a duplicate when an existing skill covers the shape", async () => {
    const ws = workspace();
    writeSkill(ws, {
      name: "Nightly Database Backup Procedure",
      description: "Run and verify the nightly database backup.",
      whenToUse: "When a nightly database backup must run.",
      procedure: "Snapshot the database, upload the archive, and verify the checksum afterwards.",
    });

    let called = false;
    const fakeComplete = async (): Promise<string> => {
      called = true;
      return '{"skip": true}';
    };

    const result = await distillAndPersist(
      turnInput(ws, { objective: "run the nightly database backup procedure and verify it" }),
      fakeComplete,
    );

    expect(result).toBeNull();
    expect(called).toBe(true); // patch/skip decision happens through the update prompt
    expect(listSkills(ws)).toHaveLength(1);
  });

  it("patches a loaded skill before authoring a new one", async () => {
    const ws = workspace();
    const slug = writeSkill(ws, {
      name: "Gateway Maintenance Runbook",
      description: "Safely update StarlingAI gateway maintenance flows.",
      whenToUse: "When a maintenance request changes runtime or scene behavior.",
      procedure: "1. Inspect the canonical config/code owner.\n2. Apply the edit.\n3. Run focused validation.",
      origin: "distilled",
    }).frontmatter.slug;

    const patch = {
      action: "patch",
      oldString: "1. Inspect the canonical config/code owner.\n2. Apply the edit.\n3. Run focused validation.",
      newString: "1. Inspect the canonical config/code owner.\n2. Apply the edit.\n3. Run focused validation.\n4. Verify the deployed container/runtime actually contains the changed code.",
    };

    // Without evidence the patch is declined and the skill stays as it was.
    await distillAndPersist(
      turnInput(ws, { objective: "update the gateway maintenance runbook for the new shard layout", loadedSkillSlugs: [slug] }),
      async () => JSON.stringify(patch),
    );
    expect(getSkill(ws, slug)!.frontmatter.version).toBe(1);

    const result = await distillAndPersist(
      turnInput(ws, {
        objective: "update the gateway maintenance scene and verify the deployed runtime",
        loadedSkillSlugs: [slug],
        outcomeBasis: "qa_pass",
      }),
      async () => JSON.stringify({
        ...patch,
        evidence: { steps: ["S2"], why: "Verification caught a stale container." },
        confidence: "medium",
      }),
    );

    expect(result).toBeNull();
    expect(listSkills(ws)).toHaveLength(1);
    const patched = getSkill(ws, slug)!;
    expect(patched.frontmatter.version).toBe(2);
    expect(patched.body).toContain("deployed container/runtime");
    expect(patched.meta.patches).toBe(1);
    expect(listSkillHistory(ws, slug).at(-1)?.summary).toBe(
      "Patched from session sess-1 (qa_pass; S2): Verification caught a stale container.",
    );
  });
});
