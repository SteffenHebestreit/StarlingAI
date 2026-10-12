import { describe, expect, it } from "vitest";
import type { TurnPlan } from "../agent/turn-plan.js";
import {
  PLAN_STEP_CRITERIA_LABEL,
  PLAN_STEP_OBJECTIVE_LABEL,
  PLAN_STEP_STOP_CONDITIONS_LABEL,
  PLAN_STEP_UPSTREAM_RESULTS_LABEL,
  planStepTurnContextStart,
  withoutPlanStepTurnContext,
} from "../agent/plan-step-task.js";
import {
  STAGED_BUILD_TASK_CHAR_THRESHOLD,
  isStagedArtifactBuildRun,
  stagedBuildTaskChars,
  taskOwnWordChars,
} from "../agent/sub-agent-prompt-guidance.js";
import { delegationAsksForFile } from "../tools/delegation-artifact-classification.js";
import { buildStepTask } from "../tools/plan-executor.js";
import { loadWorkspaceAgents } from "./support/workspace-shards.js";

/**
 * A PLAN STEP IS MEASURED ON WHAT THE STEP SAYS.
 *
 * buildStepTask hands every dispatched step the turn's objective, the results it depends on, the
 * turn's acceptance criteria and its stop conditions, after the step's own line. In E2E
 * core-build-site-company-facts (session d20e3c0a, 2026-10-12) that carried a 124-character browser
 * step to 604 characters, past the staged-build threshold of 600: browser_agent holds write_file and
 * edit_file, was told to write a file skeleton first, and answered in two characters without
 * opening the page. The size and verb decisions now read the step's own text.
 */

/** browser_agent as the workspace ships it: write_file and edit_file beside its browser tools. */
const BROWSER_AGENT_TOOLS = loadWorkspaceAgents<{ tools?: string[] }>()["browser_agent"]?.tools ?? [];

/** The plan of session d20e3c0a, from the record_plan call's arguments. */
const E2E_STEP_DESCRIPTION = "Firmenwebsite http://www.nordlicht-werkzeuge.test/ lesen und nach Gründungsjahr sowie Mitarbeiterzahl durchsuchen.";
const E2E_PLAN: TurnPlan = {
  objective: "Gründungsdatum und Mitarbeiterzahl der Nordlicht Werkzeuge GmbH von der angegebenen Website ermitteln.",
  steps: [{ id: "s1", kind: "delegate", agent: "web_crawler", description: E2E_STEP_DESCRIPTION }],
  acceptanceCriteria: [
    "Gründungsjahr der Nordlicht Werkzeuge GmbH angegeben",
    "Anzahl der Mitarbeiterinnen und Mitarbeiter angegeben",
  ],
  stopConditions: [
    "Website erreichbar und relevante Informationen gefunden",
    "Website nicht erreichbar — dann klar kommunizieren, dass keine Daten verfügbar sind",
  ],
  riskTier: "high",
  wide: false,
  createdAt: new Date(0).toISOString(),
};
/** The size sub_agent_staged_build_detected reported for that run. */
const E2E_TASK_CHARS = 604;

/** A turn context long enough to stage any step on its own: objective, criteria and stop conditions. */
const LONG_CONTEXT_PLAN = (description: string): TurnPlan => ({
  objective: "Für einen Lagerbericht der Nordlicht Werkzeuge GmbH (http://www.nordlicht-werkzeuge.test/) drei unabhängige Teilergebnisse ermitteln, die Bestände je Lager abgleichen und danach in einer kurzen, sachlichen Übersicht für die Geschäftsführung zusammenfassen.",
  steps: [{ id: "s2", kind: "delegate", agent: "browser_agent", description }],
  acceptanceCriteria: [
    "Alle Artikel unter Mindestbestand mit ihrem Gesamtbestand über alle drei Lager genannt",
    "Preis für 30 Stück NW-3102 mit Mengenrabatt und Versandpauschale berechnet",
    "Bedeutung von Fehlercode E22 aus der Dokumentation wörtlich wiedergegeben",
    "die drei Ergebnisse in einer kurzen Übersicht zusammengefasst",
  ],
  stopConditions: [
    "eine Seite lädt nicht — dann melden, welche, und mit den anderen weitermachen",
    "eine Angabe fehlt auf der Seite — dann ausdrücklich sagen, dass sie fehlt, statt sie zu schätzen",
  ],
  riskTier: "low",
  wide: false,
  createdAt: new Date(0).toISOString(),
});
const SHORT_STEP = "Preis für 30 Stück NW-3102 inklusive Mengenrabatt und Versand aus /preise.html ermitteln";
/** A step whose own text is a specification: the requirement lines of a single-file build. */
const LONG_STEP = [
  "Baue eine eigenständige HTML-Seite mit der Lagerübersicht der Nordlicht Werkzeuge GmbH.",
  "1) Eine Tabelle je Lager mit Artikelnummer, Name, Bestand und Mindestbestand, sortierbar nach jeder Spalte.",
  "2) Artikel unter Mindestbestand rot hervorgehoben, mit einem Filter, der nur sie zeigt.",
  "3) Eine Summenzeile je Lager und eine Gesamtsumme über alle drei Lager.",
  "4) Ein Suchfeld, das Artikelnummer und Name gleichzeitig durchsucht.",
  "5) Reines HTML mit eingebettetem CSS und JavaScript, keine externen Abhängigkeiten.",
  "6) Ein Druckknopf, der die Übersicht ohne Bedienelemente druckt.",
  "7) Datenstand oben rechts.",
].join(" ");

const stepLine = (plan: TurnPlan): string => `STEP ${plan.steps[0]!.id} — ${plan.steps[0]!.description}`;
const taskOf = (plan: TurnPlan, results: ReadonlyMap<string, string> = new Map()): string =>
  buildStepTask(plan, plan.steps[0]!, results);

describe("the turn context of a plan step", () => {
  it("is everything buildStepTask writes after the step's own line, and nothing before it", () => {
    const plan: TurnPlan = { ...LONG_CONTEXT_PLAN(SHORT_STEP), steps: [{ id: "s2", kind: "delegate", description: SHORT_STEP, dependsOn: ["s1"] }] };
    const upstream = "Preisliste gelesen.\n\nNW-3102: 12,40 € je Stück; ab 25 Stück 8 % Rabatt.";
    const task = taskOf(plan, new Map([["s1", upstream]]));
    // Every section is there, in buildStepTask's order, so the reader is tested against all four.
    const order = [PLAN_STEP_OBJECTIVE_LABEL, PLAN_STEP_UPSTREAM_RESULTS_LABEL, PLAN_STEP_CRITERIA_LABEL, PLAN_STEP_STOP_CONDITIONS_LABEL]
      .map((label) => task.indexOf(label));
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    expect(withoutPlanStepTurnContext(task)).toBe(stepLine(plan));
    expect(planStepTurnContextStart(task)).toBe(stepLine(plan).length);
  });

  it("leaves a task that is not a plan step untouched, and reads a label only where a paragraph opens", () => {
    const direct = "Read http://www.nordlicht-werkzeuge.test/ and report the founding year.";
    expect(withoutPlanStepTurnContext(direct)).toBe(direct);
    // Named inside a sentence, a label opens nothing.
    const inline = `Summarise the plan. Its ${PLAN_STEP_OBJECTIVE_LABEL} line is the one to keep.`;
    expect(withoutPlanStepTurnContext(inline)).toBe(inline);
    // A paragraph opened with CRLF line ends is still a paragraph.
    expect(withoutPlanStepTurnContext(`STEP s1 — read it\r\n\r\n${PLAN_STEP_OBJECTIVE_LABEL} x`)).toBe("STEP s1 — read it");
  });
});

describe("a plan step is staged on its own text, not on the turn's", () => {
  it("REGRESSION d20e3c0a — the company-facts step is 604 chars and is not staged for browser_agent", () => {
    expect(BROWSER_AGENT_TOOLS).toEqual(expect.arrayContaining(["write_file", "edit_file", "browser_navigate"]));
    const task = taskOf(E2E_PLAN);
    // The precondition that fired in the run: the task as the runner received it.
    expect(task.length).toBe(E2E_TASK_CHARS);
    expect(task.length).toBeGreaterThan(STAGED_BUILD_TASK_CHAR_THRESHOLD);

    expect(stagedBuildTaskChars(BROWSER_AGENT_TOOLS, task)).toBe(stepLine(E2E_PLAN).length);
    expect(isStagedArtifactBuildRun(BROWSER_AGENT_TOOLS, task)).toBe(false);
  });

  it("does not stage a short step under a long objective, criteria and stop conditions", () => {
    const plan = LONG_CONTEXT_PLAN(SHORT_STEP);
    const task = taskOf(plan);
    expect(task.length).toBeGreaterThan(STAGED_BUILD_TASK_CHAR_THRESHOLD + 300);
    expect(taskOwnWordChars(task)).toBe(stepLine(plan).length);
    for (const tools of [["write_file", "edit_file"], BROWSER_AGENT_TOOLS]) {
      expect(isStagedArtifactBuildRun(tools, task)).toBe(false);
    }
  });

  it("does not count the results the step depends on either: they are material it reads", () => {
    const plan: TurnPlan = { ...LONG_CONTEXT_PLAN(SHORT_STEP), steps: [{ id: "s2", kind: "delegate", description: SHORT_STEP, dependsOn: ["s1"] }] };
    const task = taskOf(plan, new Map([["s1", "Preisliste: ".concat("NW-3102 12,40 €; ".repeat(60))]]));
    expect(task).toContain(PLAN_STEP_UPSTREAM_RESULTS_LABEL);
    expect(taskOwnWordChars(task)).toBe(stepLine(plan).length);
    expect(isStagedArtifactBuildRun(["write_file", "edit_file"], task)).toBe(false);
  });

  it("still stages a step whose own text is a specification", () => {
    const plan = LONG_CONTEXT_PLAN(LONG_STEP);
    const task = taskOf(plan);
    expect(stepLine(plan).length).toBeGreaterThan(STAGED_BUILD_TASK_CHAR_THRESHOLD);
    expect(taskOwnWordChars(task)).toBe(stepLine(plan).length);
    expect(isStagedArtifactBuildRun(["write_file", "edit_file"], task)).toBe(true);
    expect(isStagedArtifactBuildRun(BROWSER_AGENT_TOOLS, task)).toBe(true);
  });

  it("keeps measuring a run that holds a builder tool on the whole task, turn context included", () => {
    // A builder is staged on everything it is handed (stagedBuildTaskChars): a build plan's
    // objective and criteria are the requirements of the page it builds.
    const task = taskOf(LONG_CONTEXT_PLAN(SHORT_STEP));
    const builderTools = ["write_file", "edit_file", "verify_page"];
    expect(stagedBuildTaskChars(builderTools, task)).toBe(task.trim().length);
    expect(isStagedArtifactBuildRun(builderTools, task)).toBe(true);
  });
});

describe("whether a plan step asks for a file is read off the step's own words", () => {
  it("does not read the objective's build verb into a lookup step, and still reads the build step's own", () => {
    const plan: TurnPlan = {
      ...LONG_CONTEXT_PLAN(SHORT_STEP),
      objective: "Erstelle eine Lernwebsite über die Lagerhaltung der Nordlicht Werkzeuge GmbH.",
    };
    const lookup = taskOf(plan);
    // The verb test found the objective's "Erstelle" and read the lookup as a build.
    expect(lookup).toContain("Erstelle");
    expect(delegationAsksForFile(lookup, undefined)).toBe(false);

    const build = taskOf({ ...plan, steps: [{ id: "s3", kind: "delegate", description: "Baue die Lernwebsite aus den Ergebnissen" }] });
    expect(delegationAsksForFile(build, undefined)).toBe(true);
    // A declaration decides as before, whatever the words.
    expect(delegationAsksForFile(lookup, "file")).toBe(true);
    expect(delegationAsksForFile(build, "answer")).toBe(false);
  });

  it("does not read a verb in an upstream result into the step", () => {
    const plan: TurnPlan = { ...LONG_CONTEXT_PLAN(SHORT_STEP), objective: "Lagerbericht", acceptanceCriteria: [], stopConditions: [], steps: [{ id: "s2", kind: "delegate", description: SHORT_STEP, dependsOn: ["s1"] }] };
    const task = taskOf(plan, new Map([["s1", "Die Firma hat 2024 ein drittes Lager hinzugefügt und die Preise zum 1.10. update."]]));
    expect(delegationAsksForFile(task, undefined)).toBe(false);
  });
});
