/**
 * Skill self-improvement driver — the "improve during use" half of the
 * self-improvement loop. A periodic, deterministic sweep over the Skill Library that:
 *
 *   - retires skills whose recorded success rate falls below the configured
 *     floor once they have enough uses to judge (low performers stop polluting
 *     retrieval),
 *   - archives the weaker of any near-duplicate pair (keeps the catalog tight),
 *   - promotes consistently reliable, frequently used skills into first-class
 *     reusable scenes in the workflow catalog (swarm-authored → discoverable via
 *     search_workflows / run_workflow).
 *
 * Everything here is deterministic and reversible (status flips + an additive
 * scene), so it stays inside the Bounded Self-Improvement envelope: no code, no
 * privilege, no guardrail changes.
 */

import { getConfig } from "../config/loader.js";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";
import { getScene, saveScene } from "../credentials/scenes.js";
import {
  listSkills,
  setSkillStatus,
  skillSuccessRate,
  type Skill,
} from "./store.js";

const log = childLogger("skills:driver");

const DRIVER_POLL_INTERVAL_MS = 30 * 60_000; // 30 min — skills change slowly
const PROMOTE_MIN_USES = 8;
const PROMOTE_MIN_SUCCESS_RATE = 0.8;
const DUPLICATE_OVERLAP_THRESHOLD = 0.82;

let _driverInterval: ReturnType<typeof setInterval> | null = null;

export interface SkillSweepResult {
  retired: string[];
  merged: string[];
  promoted: string[];
}

export function startSkillImprovementDriver(): void {
  if (_driverInterval) return;
  _driverInterval = setInterval(() => {
    try {
      runSkillImprovementSweep(getConfig().workspacePath);
    } catch (err) {
      log.warn({ err }, "Skill improvement sweep failed");
    }
  }, DRIVER_POLL_INTERVAL_MS);
  _driverInterval.unref();
  log.info({ pollIntervalMs: DRIVER_POLL_INTERVAL_MS }, "Skill improvement driver started");
}

export function stopSkillImprovementDriver(): void {
  if (_driverInterval) {
    clearInterval(_driverInterval);
    _driverInterval = null;
  }
}

/** Run one deterministic improvement sweep. Safe to call directly (and in tests). */
export function runSkillImprovementSweep(workspacePath: string): SkillSweepResult {
  const config = getConfig().skillLibrary;
  const result: SkillSweepResult = { retired: [], merged: [], promoted: [] };
  if (!config.enabled) return result;

  // ── 1. Retire low performers ─────────────────────────────────────────────
  const live = listSkills(workspacePath); // excludes archived
  for (const skill of live) {
    if (skill.meta.uses < config.retireMinUses) continue;
    if (skillSuccessRate(skill.meta) >= config.retireBelowSuccessRate) continue;
    setSkillStatus(workspacePath, skill.frontmatter.slug, "archived");
    result.retired.push(skill.frontmatter.slug);
    logAudit("skill_retired", {
      slug: skill.frontmatter.slug,
      reason: "low_success_rate",
      successRate: Number(skillSuccessRate(skill.meta).toFixed(2)),
      uses: skill.meta.uses,
    }, { severity: "info" });
  }

  // ── 2. Archive the weaker of near-duplicate pairs ────────────────────────
  const remaining = listSkills(workspacePath);
  const archivedThisSweep = new Set(result.retired);
  for (let i = 0; i < remaining.length; i++) {
    const a = remaining[i]!;
    if (archivedThisSweep.has(a.frontmatter.slug)) continue;
    for (let j = i + 1; j < remaining.length; j++) {
      const b = remaining[j]!;
      if (archivedThisSweep.has(b.frontmatter.slug)) continue;
      if (skillOverlap(a, b) < DUPLICATE_OVERLAP_THRESHOLD) continue;

      const weaker = weakerSkill(a, b);
      setSkillStatus(workspacePath, weaker.frontmatter.slug, "archived");
      archivedThisSweep.add(weaker.frontmatter.slug);
      result.merged.push(weaker.frontmatter.slug);
      logAudit("skill_retired", {
        slug: weaker.frontmatter.slug,
        reason: "duplicate",
        keptSlug: (weaker === a ? b : a).frontmatter.slug,
      }, { severity: "info" });
    }
  }

  // ── 3. Promote proven skills to first-class scenes ───────────────────────
  if (config.autoPromoteToScene) {
    for (const skill of listSkills(workspacePath)) {
      if (archivedThisSweep.has(skill.frontmatter.slug)) continue;
      if (!isPromotionEligible(skill)) continue;
      if (getScene(skill.frontmatter.slug)) continue; // already promoted
      if (promoteSkillToScene(workspacePath, skill)) {
        result.promoted.push(skill.frontmatter.slug);
      }
    }
  }

  return result;
}

export function isPromotionEligible(skill: Skill): boolean {
  if (skill.frontmatter.status !== "active") return false;
  return skill.meta.uses >= PROMOTE_MIN_USES && skillSuccessRate(skill.meta) >= PROMOTE_MIN_SUCCESS_RATE;
}

/**
 * Materialize a skill as a store-backed scene so it becomes discoverable via
 * the workflow catalog. Best-effort: the scene store needs the credential
 * store, which may be unavailable in some contexts — failures are non-fatal.
 */
export function promoteSkillToScene(workspacePath: string, skill: Skill): boolean {
  const { frontmatter } = skill;
  const task = [
    `Apply the proven procedure "${frontmatter.name}".`,
    frontmatter.whenToUse,
    frontmatter.agents.length > 0 ? `Prefer specialists: ${frontmatter.agents.join(", ")}.` : "",
    "",
    skill.body,
  ].filter(Boolean).join("\n");

  try {
    saveScene(frontmatter.slug, {
      description: `${frontmatter.description} (auto-promoted from a reliable learned skill)`,
      task,
    });
    logAudit("skill_promoted_to_scene", {
      slug: frontmatter.slug,
      sceneName: frontmatter.slug,
      uses: skill.meta.uses,
      successRate: Number(skillSuccessRate(skill.meta).toFixed(2)),
    }, { severity: "info" });
    log.info({ slug: frontmatter.slug }, "Promoted reliable skill to a reusable scene");
    return true;
  } catch (err) {
    log.debug({ err, slug: frontmatter.slug }, "Skill→scene promotion skipped (scene store unavailable)");
    return false;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function weakerSkill(a: Skill, b: Skill): Skill {
  const rateA = skillSuccessRate(a.meta);
  const rateB = skillSuccessRate(b.meta);
  if (rateA !== rateB) return rateA < rateB ? a : b;
  if (a.meta.uses !== b.meta.uses) return a.meta.uses < b.meta.uses ? a : b;
  return a.frontmatter.version <= b.frontmatter.version ? a : b;
}

function skillOverlap(a: Skill, b: Skill): number {
  const setA = skillTokenSet(a);
  const setB = skillTokenSet(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared++;
  return shared / Math.min(setA.size, setB.size);
}

function skillTokenSet(skill: Skill): Set<string> {
  const text = `${skill.frontmatter.name} ${skill.frontmatter.description} ${skill.frontmatter.whenToUse}`;
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, " ")
      .split(/\s+/)
      .filter((token) => token.length >= 3),
  );
}
