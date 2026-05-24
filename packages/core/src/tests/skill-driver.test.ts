import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSkill, listSkills, recordSkillOutcome, setSkillPinned, writeSkill } from "../skills/store.js";
import { isPromotionEligible, runSkillImprovementSweep } from "../skills/driver.js";

describe("skill improvement driver", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function workspace(): string {
    const dir = mkdtempSync(join(tmpdir(), "starlingai-skill-driver-"));
    dirs.push(dir);
    return dir;
  }

  it("retires a skill once its success rate falls below the floor", () => {
    const ws = workspace();
    const slug = writeSkill(ws, {
      name: "Flaky Procedure",
      description: "A procedure that keeps failing.",
      whenToUse: "Some niche failing case.",
      procedure: "Do the thing that rarely works in practice for this case.",
      origin: "distilled",
    }).frontmatter.slug;

    // 1 success, 5 failures → 17% over 6 uses, below the 34% default floor.
    recordSkillOutcome(ws, slug, "success");
    for (let i = 0; i < 5; i++) recordSkillOutcome(ws, slug, "failure");

    const result = runSkillImprovementSweep(ws);
    expect(result.retired).toContain(slug);
    expect(getSkill(ws, slug)?.frontmatter.status).toBe("archived");
    expect(listSkills(ws)).toHaveLength(0); // archived excluded from live listing
  });

  it("keeps a reliable skill and does not retire untested skills", () => {
    const ws = workspace();
    const reliable = writeSkill(ws, {
      name: "Reliable Procedure",
      description: "A procedure that works well.",
      whenToUse: "A common, well-understood case.",
      procedure: "Do the steps that reliably produce the right outcome here.",
      origin: "distilled",
    }).frontmatter.slug;
    const untested = writeSkill(ws, {
      name: "Brand New Procedure",
      description: "Never been used yet.",
      whenToUse: "An unrelated brand-new case.",
      procedure: "Steps that have not been exercised in any real turn so far.",
      origin: "distilled",
    }).frontmatter.slug;

    for (let i = 0; i < 6; i++) recordSkillOutcome(ws, reliable, "success");

    const result = runSkillImprovementSweep(ws);
    expect(result.retired).not.toContain(reliable);
    expect(result.retired).not.toContain(untested); // below retireMinUses → untouched
    expect(getSkill(ws, reliable)?.frontmatter.status).toBe("active");
  });

  it("archives the weaker of two near-duplicate skills", () => {
    const ws = workspace();
    const strong = writeSkill(ws, {
      name: "Nightly Database Backup Procedure",
      description: "Run and verify the nightly database backup safely.",
      whenToUse: "When the nightly database backup must run and be verified.",
      procedure: "Snapshot the database, upload the archive, verify the checksum.",
      origin: "distilled",
    }).frontmatter.slug;
    const weak = writeSkill(ws, {
      name: "Nightly Database Backup Procedure",
      description: "Run and verify the nightly database backup safely.",
      whenToUse: "When the nightly database backup must run and be verified.",
      procedure: "Snapshot the database, upload the archive, verify the checksum.",
      origin: "distilled",
      slug: "nightly-database-backup-procedure-alt",
    }).frontmatter.slug;

    for (let i = 0; i < 4; i++) recordSkillOutcome(ws, strong, "success");
    recordSkillOutcome(ws, weak, "failure");

    const result = runSkillImprovementSweep(ws);
    expect(result.merged).toContain(weak);
    expect(getSkill(ws, strong)?.frontmatter.status).toBe("active");
    expect(getSkill(ws, weak)?.frontmatter.status).toBe("archived");
  });

  it("marks a proven, frequently used skill as promotion-eligible", () => {
    const ws = workspace();
    const slug = writeSkill(ws, {
      name: "Proven Procedure",
      description: "A heavily used, reliable procedure.",
      whenToUse: "A frequent, well-trodden case.",
      procedure: "The repeatable steps that consistently succeed for this case.",
    }).frontmatter.slug;

    for (let i = 0; i < 10; i++) recordSkillOutcome(ws, slug, "success");
    const skill = getSkill(ws, slug)!;
    expect(skill.frontmatter.status).toBe("active");
    expect(isPromotionEligible(skill)).toBe(true);
  });

  it("does not auto-retire manual or pinned skills", () => {
    const ws = workspace();
    const manual = writeSkill(ws, {
      name: "Manual Procedure",
      description: "A user-authored procedure that should not be curated away.",
      whenToUse: "When the user explicitly keeps this manual procedure.",
      procedure: "Follow the manual runbook and keep it protected from automatic lifecycle changes.",
      origin: "manual",
    }).frontmatter.slug;
    const pinned = writeSkill(ws, {
      name: "Pinned Auto Procedure",
      description: "An auto-created procedure protected by pinning.",
      whenToUse: "When this pinned auto procedure applies.",
      procedure: "Follow the protected auto-created runbook.",
      origin: "distilled",
    }).frontmatter.slug;

    for (let i = 0; i < 6; i++) {
      recordSkillOutcome(ws, manual, "failure");
      recordSkillOutcome(ws, pinned, "failure");
    }
    setSkillPinned(ws, pinned, true);

    const result = runSkillImprovementSweep(ws);
    expect(result.retired).not.toContain(manual);
    expect(result.retired).not.toContain(pinned);
    expect(getSkill(ws, manual)?.frontmatter.status).toBe("draft");
    expect(getSkill(ws, pinned)?.frontmatter.status).toBe("draft");
  });
});
