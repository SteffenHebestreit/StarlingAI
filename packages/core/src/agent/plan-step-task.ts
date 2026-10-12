/**
 * The turn context execute_plan appends to a dispatched step's task, and where it starts.
 *
 * buildStepTask (tools/plan-executor.ts) opens a step's task with the step itself — "STEP s1 — " and
 * the step's description — and then appends, one paragraph each, what the step serves: the turn's
 * objective, the results of the steps it depends on, the turn's acceptance criteria and its stop
 * conditions. Each of those paragraphs opens with one of the labels below. They are the plan's, not
 * the step's: the objective, criteria and stop conditions are the same on every step of the plan, and
 * the upstream results are material the step works from. A decision about what the step itself asks
 * — how long its own specification is, whether its own words ask for a file — reads the text before
 * them.
 *
 * In E2E core-build-site-company-facts (session d20e3c0a, 2026-10-12) a 124-character browser step
 * ("Firmenwebsite … lesen und nach Gründungsjahr sowie Mitarbeiterzahl durchsuchen") reached
 * browser_agent at 604 characters with them, past the staged-build threshold of 600, and was told to
 * write a file skeleton first. It answered in two characters without opening the page.
 *
 * The labels are defined here, once, so the writer and every reader agree on them. This module
 * imports nothing.
 */

/** Opens the paragraph that carries the turn's objective. */
export const PLAN_STEP_OBJECTIVE_LABEL = "OBJECTIVE (the whole turn):";
/** Opens the paragraph that carries the results of the steps this one depends on. */
export const PLAN_STEP_UPSTREAM_RESULTS_LABEL = "RESULTS THIS STEP DEPENDS ON — use them; do not re-derive or re-ask for them:";
/** Opens the paragraph that carries the turn's acceptance criteria. */
export const PLAN_STEP_CRITERIA_LABEL = "ACCEPTANCE CRITERIA for the turn:";
/** Opens the paragraph that carries the turn's stop conditions. */
export const PLAN_STEP_STOP_CONDITIONS_LABEL = "STOP CONDITIONS for the turn — stop and report when one holds:";
/** What buildStepTask writes between the step and each section, and between sections. */
export const PLAN_STEP_SECTION_SEPARATOR = "\n\n";

/** Every label that opens a section of turn context, in the order buildStepTask writes them. */
export const PLAN_STEP_TURN_CONTEXT_LABELS: readonly string[] = [
  PLAN_STEP_OBJECTIVE_LABEL,
  PLAN_STEP_UPSTREAM_RESULTS_LABEL,
  PLAN_STEP_CRITERIA_LABEL,
  PLAN_STEP_STOP_CONDITIONS_LABEL,
];

const escapeForPattern = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A label at the start of a paragraph: at the start of the text, or after a blank line (written
 * "\n\n" by buildStepTask, matched with "\r\n" too). A label inside a sentence opens nothing.
 */
const TURN_CONTEXT_START = new RegExp(
  `(?:^|\\r?\\n[ \\t]*\\r?\\n)[ \\t]*(?:${PLAN_STEP_TURN_CONTEXT_LABELS.map(escapeForPattern).join("|")})`,
);

/**
 * Where the turn context buildStepTask appended begins, or -1 when the task carries none.
 *
 * buildStepTask writes the step first and the context after it, so everything from the first
 * labelled paragraph on is context: an upstream result that itself holds a blank line, or quotes one
 * of these labels, is inside it rather than read as the step's words again.
 */
export function planStepTurnContextStart(task: string): number {
  const match = TURN_CONTEXT_START.exec(task);
  return match ? match.index : -1;
}

/**
 * The task without the turn context buildStepTask appended: what the step itself says. A task that
 * carries none — any delegation that is not a plan step — comes back unchanged.
 */
export function withoutPlanStepTurnContext(task: string): string {
  const start = planStepTurnContextStart(task);
  return start < 0 ? task : task.slice(0, start);
}
