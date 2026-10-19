/**
 * One arm of a lab run: a harness to run a task on. The base arm is the deployment's harness as
 * loaded; a candidate arm lays its prompts over it (config/loader.ts applyLabPromptOverlay).
 *
 * Every attempt runs in a fresh scratch workspace, which is also config.workspacePath while it
 * runs: the outcome ledger, the per-agent performance note read back into the prompt, sessions'
 * files and generated/ all live there, so nothing one attempt leaves behind reaches the next, and
 * the reference run's outcomes never show up in a probe's prompt.
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { applyLabPromptOverlay, getConfig } from "../config/loader.js";

export interface LabArm {
  /** "base", or a candidate's id. */
  name: string;
  /** Replaces agents.mainAssistant.customInstructions in this arm. */
  mainAssistantInstructions?: string;
  /** Replaces these sub-agents' systemPrompt in this arm. */
  subAgentPrompts?: Record<string, string>;
}

export const BASE_ARM: LabArm = { name: "base" };

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
