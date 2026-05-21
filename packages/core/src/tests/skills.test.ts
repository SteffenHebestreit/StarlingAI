import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getSkill,
  listSkills,
  parseSkillFile,
  recordSkillOutcome,
  recordSkillOutcomeAsync,
  setSkillStatus,
  skillSuccessRate,
  SkillCredentialError,
  writeSkill,
} from "../skills/store.js";
import { formatSkillGuidance, searchSkills } from "../skills/service.js";

describe("skill library store", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function workspace(): string {
    const dir = mkdtempSync(join(tmpdir(), "starlingai-skills-"));
    dirs.push(dir);
    return dir;
  }

  it("round-trips a skill through SKILL.md + meta", () => {
    const ws = workspace();
    const created = writeSkill(ws, {
      name: "Source-Grounded Research Packet",
      description: "Produce a cited report grounded in verified sources.",
      whenToUse: "When the user asks for a cited report or paper.",
      procedure: "1. Delegate to researcher to gather evidence.\n2. Verify with source_verifier.\n3. Draft with paper_author.",
      tags: ["research", "citations"],
      agents: ["researcher", "source_verifier", "paper_author"],
      tools: ["web_search", "share_evidence"],
      origin: "agent",
    });

    expect(created.frontmatter.slug).toBe("source-grounded-research-packet");
    expect(created.frontmatter.version).toBe(1);
    expect(created.frontmatter.status).toBe("draft");

    const loaded = getSkill(ws, created.frontmatter.slug);
    expect(loaded).not.toBeNull();
    expect(loaded?.frontmatter.name).toBe("Source-Grounded Research Packet");
    expect(loaded?.frontmatter.agents).toEqual(["researcher", "source_verifier", "paper_author"]);
    expect(loaded?.body).toContain("source_verifier");
    expect(loaded?.meta.origin).toBe("agent");
  });

  it("bumps version on content change but preserves outcome stats", () => {
    const ws = workspace();
    const slug = writeSkill(ws, {
      name: "Nightly Backup Runbook",
      description: "Run the nightly backup.",
      procedure: "Step 1. snapshot. Step 2. upload.",
    }).frontmatter.slug;

    recordSkillOutcome(ws, slug, "success");
    recordSkillOutcome(ws, slug, "success");

    const updated = writeSkill(ws, {
      name: "Nightly Backup Runbook",
      description: "Run the nightly backup with verification.",
      procedure: "Step 1. snapshot. Step 2. upload. Step 3. verify checksum.",
    });

    expect(updated.frontmatter.version).toBe(2);
    expect(updated.meta.uses).toBe(2);
    expect(updated.meta.successes).toBe(2);

    // Re-writing identical content does not bump the version.
    const same = writeSkill(ws, {
      name: "Nightly Backup Runbook",
      description: "Run the nightly backup with verification.",
      procedure: "Step 1. snapshot. Step 2. upload. Step 3. verify checksum.",
    });
    expect(same.frontmatter.version).toBe(2);
  });

  it("graduates a draft to active after its first success", () => {
    const ws = workspace();
    const slug = writeSkill(ws, {
      name: "Triage Ops Alert",
      description: "Diagnose a failing service.",
      procedure: "Check journalctl, then restart the unit if safe.",
    }).frontmatter.slug;

    expect(getSkill(ws, slug)?.frontmatter.status).toBe("draft");
    recordSkillOutcome(ws, slug, "success");
    expect(getSkill(ws, slug)?.frontmatter.status).toBe("active");
    expect(skillSuccessRate(getSkill(ws, slug)!.meta)).toBe(1);
  });

  it("records outcomes asynchronously and graduates a draft on first success", async () => {
    const ws = workspace();
    const slug = writeSkill(ws, {
      name: "Async Outcome Skill",
      description: "Verify async outcome recording.",
      procedure: "Do the steps that should be tracked asynchronously here.",
    }).frontmatter.slug;

    await recordSkillOutcomeAsync(ws, slug, "success");
    let loaded = getSkill(ws, slug)!;
    expect(loaded.meta.uses).toBe(1);
    expect(loaded.meta.successes).toBe(1);
    expect(loaded.frontmatter.status).toBe("active"); // graduated

    await recordSkillOutcomeAsync(ws, slug, "failure");
    loaded = getSkill(ws, slug)!;
    expect(loaded.meta.uses).toBe(2);
    expect(loaded.meta.failures).toBe(1);
    expect(skillSuccessRate(loaded.meta)).toBe(0.5);
  });

  it("rejects credential-shaped content", () => {
    const ws = workspace();
    expect(() =>
      writeSkill(ws, {
        name: "Bad Skill",
        description: "Logs into the portal.",
        procedure: "Use password=hunter2 to log in to the admin panel and proceed.",
      }),
    ).toThrow(SkillCredentialError);
    expect(listSkills(ws)).toHaveLength(0);
  });

  it("parses an externally authored minimal SKILL.md", () => {
    const raw = ["---", "name: External Skill", "description: Does a useful thing", "---", "", "Body with the actual steps."].join("\n");
    const { frontmatter, body } = parseSkillFile(raw, "external-skill");
    expect(frontmatter.name).toBe("External Skill");
    expect(frontmatter.slug).toBe("external-skill");
    expect(frontmatter.version).toBe(1);
    expect(frontmatter.status).toBe("active");
    expect(frontmatter.whenToUse).toBe("Does a useful thing");
    expect(body).toContain("actual steps");
  });
});

describe("skill library search + guidance", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function workspace(): string {
    const dir = mkdtempSync(join(tmpdir(), "starlingai-skills-"));
    dirs.push(dir);
    return dir;
  }

  it("matches a skill by keyword and excludes archived skills", async () => {
    const ws = workspace();
    writeSkill(ws, {
      name: "Source-Grounded Research Packet",
      description: "Produce a cited report grounded in verified sources.",
      whenToUse: "When the user asks for a cited research report.",
      procedure: "Delegate to researcher, verify citations, then draft the report.",
      tags: ["research", "citations"],
    });
    const archivedSlug = writeSkill(ws, {
      name: "Legacy Research Flow",
      description: "Old research approach.",
      procedure: "Outdated steps for research that no longer apply.",
    }).frontmatter.slug;
    setSkillStatus(ws, archivedSlug, "archived");

    const matches = await searchSkills(ws, "cited research report", { limit: 5 });
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.skill.frontmatter.slug).toBe("source-grounded-research-packet");
    expect(matches.some((m) => m.skill.frontmatter.slug === archivedSlug)).toBe(false);
  });

  it("ranks a reliable skill above an unreliable one for an equal keyword match", async () => {
    const ws = workspace();
    const reliable = writeSkill(ws, {
      name: "Nightly Backup Runbook",
      description: "Run the nightly backup.",
      procedure: "Snapshot the database, then upload the archive to storage.",
    }).frontmatter.slug;
    const flaky = writeSkill(ws, {
      name: "Nightly Backup Routine",
      description: "Run the nightly backup.",
      procedure: "Snapshot the database, then upload the archive to storage.",
    }).frontmatter.slug;

    for (let i = 0; i < 5; i++) recordSkillOutcome(ws, reliable, "success");
    recordSkillOutcome(ws, flaky, "success");
    for (let i = 0; i < 4; i++) recordSkillOutcome(ws, flaky, "failure");

    const matches = await searchSkills(ws, "nightly backup", { limit: 5 });
    expect(matches[0]?.skill.frontmatter.slug).toBe(reliable);
  });

  it("formats a Learned Procedures guidance block", async () => {
    const ws = workspace();
    writeSkill(ws, {
      name: "Source-Grounded Research Packet",
      description: "Produce a cited report grounded in verified sources.",
      whenToUse: "When the user asks for a cited research report.",
      procedure: "Delegate to researcher, verify citations, then draft the report.",
      agents: ["researcher", "paper_author"],
    });

    const guidance = await formatSkillGuidance(ws, "write me a cited research report");
    expect(guidance).toContain("## Learned Procedures");
    expect(guidance).toContain("Source-Grounded Research Packet");
    expect(guidance).toContain("researcher");
  });
});
