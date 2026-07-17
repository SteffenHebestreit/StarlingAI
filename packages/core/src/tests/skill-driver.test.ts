import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSkill, listSkills, recordSkillOutcome, recordSkillHoldoutOutcome, setSkillPinned, skillLift, writeSkill } from "../skills/store.js";
import { isPromotionEligible, runSkillImprovementSweep } from "../skills/driver.js";
import { getScene } from "../credentials/scenes.js";

// LRN-404 tests: skillLibrary config overrides (holdout gate) + an in-memory
// scene store so promotion/rollback runs without the credential store.
const testState = vi.hoisted(() => ({
  skillLibraryOverrides: {} as Record<string, unknown>,
  scenes: new Map<string, { description: string; task: string }>(),
}));

vi.mock("../config/loader.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../config/loader.js")>();
  return {
    ...original,
    getConfig: () => {
      const config = original.getConfig();
      return { ...config, skillLibrary: { ...config.skillLibrary, ...testState.skillLibraryOverrides } };
    },
  };
});

vi.mock("../credentials/scenes.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../credentials/scenes.js")>();
  return {
    ...original,
    getScene: (name: string) => testState.scenes.get(name),
    saveScene: (name: string, input: { description: string; task: string }) => { testState.scenes.set(name, input); },
    deleteScene: (name: string) => { testState.scenes.delete(name); },
  };
});

describe("skill improvement driver", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    testState.skillLibraryOverrides = {};
    testState.scenes.clear();
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

  it("computes lift only once both arms have enough samples", () => {
    const ws = workspace();
    const slug = writeSkill(ws, {
      name: "Sampled Procedure",
      description: "A procedure under lift measurement.",
      whenToUse: "When measuring lift.",
      procedure: "Steps under measurement.",
      origin: "distilled",
    }).frontmatter.slug;

    for (let i = 0; i < 4; i++) recordSkillOutcome(ws, slug, "success");
    // No holdout samples yet → lift indeterminate.
    expect(skillLift(getSkill(ws, slug)!.meta)).toBeNull();

    for (let i = 0; i < 3; i++) recordSkillHoldoutOutcome(ws, slug, "failure");
    // Injected 100%, held-out 0% → strong positive lift.
    expect(skillLift(getSkill(ws, slug)!.meta)).toBeCloseTo(1, 5);
  });

  it("retires a high-success skill that shows no measured lift", () => {
    const ws = workspace();
    const slug = writeSkill(ws, {
      name: "No Lift Procedure",
      description: "Succeeds whether injected or not — easy matching tasks.",
      whenToUse: "An easy case that succeeds regardless.",
      procedure: "Steps that the model would have done anyway.",
      origin: "distilled",
    }).frontmatter.slug;

    // LRN-403: retirement needs the lift CI at or below zero, not a noisy point
    // estimate. Injected 50% over 40 uses vs held-out 90% over 40 — the data
    // actively supports "injection does not help" (CI high < 0).
    for (let i = 0; i < 20; i++) recordSkillOutcome(ws, slug, "success");
    for (let i = 0; i < 20; i++) recordSkillOutcome(ws, slug, "failure");
    for (let i = 0; i < 36; i++) recordSkillHoldoutOutcome(ws, slug, "success");
    for (let i = 0; i < 4; i++) recordSkillHoldoutOutcome(ws, slug, "failure");

    const result = runSkillImprovementSweep(ws);
    expect(result.retired).toContain(slug);
    expect(getSkill(ws, slug)?.frontmatter.status).toBe("archived");
  });

  it("does NOT retire on a small-sample negative point estimate — the CI still spans zero (LRN-403)", () => {
    const ws = workspace();
    const slug = writeSkill(ws, {
      name: "Noisy Sample Procedure",
      description: "Slightly negative point estimate on tiny samples.",
      whenToUse: "When samples are too small to judge.",
      procedure: "Steps whose value is not yet measurable.",
      origin: "distilled",
    }).frontmatter.slug;

    // Injected 4/6 ≈ 67% vs held-out 5/5 = 100%: the pre-CI rule would retire
    // this (negative point estimate, ≥3 samples/arm); the CI spans zero.
    for (let i = 0; i < 4; i++) recordSkillOutcome(ws, slug, "success");
    for (let i = 0; i < 2; i++) recordSkillOutcome(ws, slug, "failure");
    for (let i = 0; i < 5; i++) recordSkillHoldoutOutcome(ws, slug, "success");

    const result = runSkillImprovementSweep(ws);
    expect(result.retired).not.toContain(slug);
    expect(getSkill(ws, slug)?.frontmatter.status).toBe("active");
  });

  it("keeps a skill with positive measured lift even at a moderate success rate", () => {
    const ws = workspace();
    const slug = writeSkill(ws, {
      name: "Helpful Procedure",
      description: "Materially improves outcomes when injected.",
      whenToUse: "A hard case that benefits from the procedure.",
      procedure: "Steps that genuinely help the model succeed.",
      origin: "distilled",
    }).frontmatter.slug;

    // Injected: 5/6 ≈ 83%. Held out: 0/4 = 0% → clear positive lift.
    for (let i = 0; i < 5; i++) recordSkillOutcome(ws, slug, "success");
    recordSkillOutcome(ws, slug, "failure");
    for (let i = 0; i < 4; i++) recordSkillHoldoutOutcome(ws, slug, "failure");

    const result = runSkillImprovementSweep(ws);
    expect(result.retired).not.toContain(slug);
    expect(getSkill(ws, slug)?.frontmatter.status).toBe("active");
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

  it("LRN-404: with holdout running, promotion needs DECISIVE positive lift, not just success rate", () => {
    testState.skillLibraryOverrides = { holdoutRate: 0.15, liftMinSamplesPerArm: 5 };
    const ws = workspace();
    const slug = writeSkill(ws, {
      name: "Candidate Procedure",
      description: "High success rate, lift not yet measured.",
      whenToUse: "A candidate awaiting lift evidence.",
      procedure: "Steps whose value must be proven against a control arm.",
      origin: "distilled",
    }).frontmatter.slug;

    for (let i = 0; i < 10; i++) recordSkillOutcome(ws, slug, "success");
    // 100% over 10 uses — but zero holdout samples: no lift evidence, no promotion.
    expect(isPromotionEligible(getSkill(ws, slug)!)).toBe(false);

    // A decisively positive lift (10/10 injected vs 0/5 held out) unlocks it.
    for (let i = 0; i < 5; i++) recordSkillHoldoutOutcome(ws, slug, "failure");
    expect(isPromotionEligible(getSkill(ws, slug)!)).toBe(true);
  });

  it("LRN-404: promotes with a rollback pointer, then AUTOMATICALLY rolls the scene back when the canary turns harmful", () => {
    testState.skillLibraryOverrides = { holdoutRate: 0.15, liftMinSamplesPerArm: 5 };
    const ws = workspace();
    const slug = writeSkill(ws, {
      name: "Canary Procedure",
      description: "Initially helpful, later measured harmful.",
      whenToUse: "The canary lifecycle under measurement.",
      procedure: "Steps that later stop helping compared to the control arm.",
      origin: "distilled",
    }).frontmatter.slug;

    // Decisively positive at first: 10/10 injected vs 0/5 held out.
    for (let i = 0; i < 10; i++) recordSkillOutcome(ws, slug, "success");
    for (let i = 0; i < 5; i++) recordSkillHoldoutOutcome(ws, slug, "failure");

    const promoted = runSkillImprovementSweep(ws);
    expect(promoted.promoted).toContain(slug);
    expect(getScene(slug)).toBeDefined();
    const afterPromotion = getSkill(ws, slug)!.meta;
    expect(afterPromotion.promotedToSceneAt).toBeTruthy();
    expect(afterPromotion.promotedAtVersion).toBeGreaterThanOrEqual(1);

    // The canary turns harmful: injected sinks to 50% over 40 (still above the
    // retirement floor) while held-out climbs to ~88% — lift CI decisively < 0.
    for (let i = 0; i < 10; i++) recordSkillOutcome(ws, slug, "success");
    for (let i = 0; i < 20; i++) recordSkillOutcome(ws, slug, "failure");
    for (let i = 0; i < 36; i++) recordSkillHoldoutOutcome(ws, slug, "success");

    const rolledBack = runSkillImprovementSweep(ws);
    expect(rolledBack.retired).toContain(slug);
    expect(rolledBack.rolledBack).toContain(slug);
    expect(getScene(slug)).toBeUndefined(); // the promoted alias is withdrawn
    const afterRollback = getSkill(ws, slug)!.meta;
    expect(afterRollback.promotedToSceneAt).toBeUndefined(); // pointer cleared
    expect(getSkill(ws, slug)?.frontmatter.status).toBe("archived");
  });
});
