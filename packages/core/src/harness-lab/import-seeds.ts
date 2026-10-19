/**
 * Seed tasks from the E2E scenarios: the ones a lab attempt can run as they are. A lab attempt is
 * one session of the lab's own principal, without a browser, a mailbox, a desktop, image or speech
 * service, and without anyone mid-turn; a scenario that needs any of that, or several sessions, is
 * left out with the reason. The checks come over unchanged, except the rubric judge, which the lab
 * replaces with its paired selector.
 */
import { loadScenarios } from "../e2e/loader.js";
import type { E2EScenario } from "../e2e/scenario.js";
import type { HarnessTask, LabTurn } from "./task-schema.js";

export const LAB_UNAVAILABLE_SERVICES: ReadonlySet<string> = new Set(["browser", "mail", "computer-desktop", "image", "speech"]);
const MAX_TURNS = 3;

export function scenarioToTask(scenario: E2EScenario): HarnessTask | { skip: string } {
  const missing = (scenario.requires ?? []).filter((service) => LAB_UNAVAILABLE_SERVICES.has(service));
  if (missing.length > 0) return { skip: `needs ${missing.join(", ")}, which the lab does not run` };
  if (scenario.identity && scenario.identity !== "eval") return { skip: `runs as ${scenario.identity}` };
  const turns: LabTurn[] = [];
  for (const step of scenario.steps) {
    if (step.kind === "newSession") {
      if (turns.length > 0) return { skip: "spans several sessions" };
      continue;
    }
    if (step.kind !== "turn") return { skip: `has a ${step.kind} step` };
    if (step.as && step.as !== "eval") return { skip: "has a turn as another identity" };
    if (step.attachments?.length) return { skip: "attaches files" };
    if (step.during?.length) return { skip: "acts during a turn" };
    const expect = step.expect ? { ...step.expect } : undefined;
    if (expect) delete expect.judge;
    turns.push({
      message: step.message,
      ...(step.agent ? { agent: step.agent } : {}),
      ...(step.effort ? { effort: step.effort } : {}),
      ...(step.timeoutMs ? { timeoutMs: step.timeoutMs } : {}),
      ...(expect ? { expect } : {}),
    });
  }
  if (turns.length === 0) return { skip: "has no turn" };
  if (turns.length > MAX_TURNS) return { skip: `has ${turns.length} turns (at most ${MAX_TURNS})` };
  return {
    id: `e2e.${scenario.id}`,
    title: scenario.title,
    origin: "e2e",
    source: scenario.id,
    tags: scenario.tags ?? [],
    domain: scenario.group,
    role: "both",
    requires: (scenario.requires ?? []).filter((service) => service !== "gateway" && service !== "model"),
    turns,
    ...(scenario.timeoutMs ? { timeoutMs: scenario.timeoutMs } : {}),
  };
}

export function importSeeds(scenariosDir: string, fixturesDir: string): { tasks: HarnessTask[]; skipped: Array<{ id: string; reason: string }> } {
  const loaded = loadScenarios(scenariosDir, fixturesDir);
  const tasks: HarnessTask[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const { scenario, template } of loaded.scenarios) {
    if (template) continue;
    const result = scenarioToTask(scenario);
    if ("skip" in result) skipped.push({ id: scenario.id, reason: result.skip });
    else tasks.push(result);
  }
  return { tasks, skipped };
}
