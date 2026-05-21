import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTrajectoryDigest,
  distillAndPersist,
  parseDistilledSkill,
  shouldDistill,
  type DistillTurnInput,
} from "../skills/distiller.js";
import { listSkills, writeSkill } from "../skills/store.js";
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
  it("parses a fenced JSON proposal", () => {
    const raw = [
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
      }),
      "```",
    ].join("\n");
    const parsed = parseDistilledSkill(raw);
    expect(parsed?.name).toBe("Cited Research Report");
    expect(parsed?.agents).toContain("source_verifier");
  });

  it("returns null on skip and on missing fields", () => {
    expect(parseDistilledSkill('{"skip": true}')).toBeNull();
    expect(parseDistilledSkill('{"name": "x"}')).toBeNull();
    expect(parseDistilledSkill("no json here")).toBeNull();
  });
});

describe("skill distiller — digest", () => {
  it("summarizes delegations and evidence", () => {
    const digest = buildTrajectoryDigest(turnInput("/tmp/unused"));
    expect(digest).toContain("Gather sources → researcher");
    expect(digest).toContain("web_search");
    expect(digest).toContain("Evidence gathered");
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

  it("writes a distilled draft skill from a successful trajectory", async () => {
    const ws = workspace();
    const fakeComplete = async (): Promise<string> =>
      "```json\n" + JSON.stringify({
        name: "Cited Research Report",
        description: "Produce a source-backed report grounded in verified citations.",
        whenToUse: "When the user asks for a cited research report.",
        procedure: "1. Delegate to researcher for sources. 2. source_verifier validates. 3. Draft and synthesize.",
        tags: ["research", "citations"],
        agents: ["researcher", "source_verifier"],
        tools: ["web_search", "share_evidence"],
      }) + "\n```";

    const result = await distillAndPersist(
      turnInput(ws, { objective: "Write a cited research report about HMAC delegation protocols" }),
      fakeComplete,
    );

    expect(result?.name).toBe("Cited Research Report");
    const skills = listSkills(ws);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.meta.origin).toBe("distilled");
    expect(skills[0]?.frontmatter.status).toBe("draft");
  });

  it("skips distillation when an existing skill already covers the shape", async () => {
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
    expect(called).toBe(false); // deduped before the LLM call
    expect(listSkills(ws)).toHaveLength(1);
  });
});
