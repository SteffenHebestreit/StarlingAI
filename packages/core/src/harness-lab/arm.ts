/**
 * One arm of a lab run: a harness to run a task on. The base arm is the deployment's harness as
 * loaded; a candidate arm lays its prompts over it (config/loader.ts applyLabPromptOverlay).
 *
 * Every attempt runs in a fresh scratch workspace, which is also config.workspacePath while it
 * runs: the outcome ledger, the per-agent performance note read back into the prompt, sessions'
 * files and generated/ all live there, so nothing one attempt leaves behind reaches the next, and
 * the reference run's outcomes never show up in a probe's prompt.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { applyLabPromptOverlay, getConfig } from "../config/loader.js";
import { skillsDir, writeSkill } from "../skills/store.js";

/** A skill a candidate adds: written into its scratch workspace only, never the live library. */
export interface LabSkill {
  name: string;
  whenToUse: string;
  procedure: string;
}

export interface LabArm {
  /** "base", or a candidate's id. */
  name: string;
  /** Replaces agents.mainAssistant.customInstructions in this arm. */
  mainAssistantInstructions?: string;
  /** Replaces these sub-agents' systemPrompt in this arm. */
  subAgentPrompts?: Record<string, string>;
  /** Skills this arm adds on top of the deployment's (see setSkillSnapshot). */
  skills?: LabSkill[];
}

/**
 * The deployment's skill library, copied once when the lab starts: every attempt's workspace gets
 * this copy, so the base arm runs with the skills a live turn would find, and no attempt's skill
 * statistics or a candidate's added skill ever reach the live library.
 */
let _skillSnapshot: string | null = null;

export function setSkillSnapshot(dir: string | null): void {
  _skillSnapshot = dir;
}

/** Copy the live skill library into `snapshotDir`; returns it, or null when there is none. */
export function snapshotSkills(liveWorkspacePath: string, snapshotDir: string): string | null {
  const live = skillsDir(liveWorkspacePath);
  if (!existsSync(live)) return null;
  rmSync(snapshotDir, { recursive: true, force: true });
  cpSync(live, snapshotDir, { recursive: true });
  return snapshotDir;
}

export const BASE_ARM: LabArm = { name: "base" };

/** No prompt of this arm differs from the deployment's (its skills, if any, are written per attempt). */
export function isBaseArm(arm: LabArm): boolean {
  return arm.mainAssistantInstructions === undefined && Object.keys(arm.subAgentPrompts ?? {}).length === 0;
}

/** A path segment from a free-form name. */
function segment(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "arm";
}

/**
 * Run `fn` with `arm` in force, in a fresh scratch workspace under `scratchRoot`, and put the
 * config back afterwards, however `fn` ends.
 */
export async function withArm<T>(arm: LabArm, scratchRoot: string, attemptKey: string, fn: (workspacePath: string) => Promise<T>): Promise<T> {
  const workspacePath = join(scratchRoot, `${segment(arm.name)}-${segment(attemptKey)}`);
  rmSync(workspacePath, { recursive: true, force: true });
  mkdirSync(join(workspacePath, "generated"), { recursive: true });
  if (_skillSnapshot) cpSync(_skillSnapshot, skillsDir(workspacePath), { recursive: true });
  for (const skill of arm.skills ?? []) {
    writeSkill(workspacePath, {
      name: skill.name,
      description: skill.whenToUse,
      whenToUse: skill.whenToUse,
      procedure: skill.procedure,
      // Active, as the skill would be once a person adds it from the report.
      status: "active",
      origin: "agent",
    });
  }
  const config = getConfig();
  const previousWorkspace = config.workspacePath;
  const restore = isBaseArm(arm)
    ? () => undefined
    : applyLabPromptOverlay({
      ...(arm.mainAssistantInstructions !== undefined ? { mainAssistantInstructions: arm.mainAssistantInstructions } : {}),
      ...(arm.subAgentPrompts ? { subAgentPrompts: arm.subAgentPrompts } : {}),
    });
  config.workspacePath = workspacePath;
  try {
    return await fn(workspacePath);
  } finally {
    // The overlay first: a reload while it was in force laid it over a new config object, and
    // restore only knows that one.
    restore();
    getConfig().workspacePath = previousWorkspace;
  }
}
