import { describe, expect, it } from "vitest";
import { agentLabel, humanizeName, languageOfTurn, toolLabel, turnLanguage, turnText } from "./turnText";
import { stepOutcome, stepSubject, stepTitle, type TurnStep } from "./turnSteps";
import { awaitingStepHint, awaitingStepTitle } from "./userInputs";

const step = (name: string, extra: Partial<TurnStep> = {}): TurnStep =>
  ({ id: name, kind: "tool", name, depth: 0, status: "done", startedAt: 0, ...extra });

describe("turn language", () => {
  it("is German for German and English for everything else", () => {
    expect(["de", "de-DE", "German", "en", "pl", undefined, null, ""].map(turnLanguage))
      .toEqual(["de", "de", "de", "en", "en", "en", "en", "en"]);
  });
});

describe("the language of a turn", () => {
  const answer = (content: string, language?: string) => ({ id: content, role: "assistant", content, ...(language ? { language } : {}) });

  it("is its request's, else the latest answer's, else English", () => {
    expect(languageOfTurn("Wie ist das Wetter heute in Berlin?", [])).toBe("de");
    expect(languageOfTurn("ok", [answer("Das ist die Antwort für dich, sie ist hier.")])).toBe("de");
    expect(languageOfTurn("ok", [answer("Here is the answer for you."), answer("…", "de")])).toBe("de");
    expect(languageOfTurn("ok", [])).toBe("en");
  });

  it("never reads the live bubble as an answer", () => {
    expect(languageOfTurn("ok", [answer("Here is the answer for you."), { id: "streaming", role: "assistant", content: "", language: "de" }])).toBe("en");
  });
});

describe("names in words", () => {
  it("names a known tool in the turn's language, an MCP-prefixed one too", () => {
    expect(toolLabel("web_search", "de")).toBe("Websuche");
    expect(toolLabel("web_search", "en")).toBe("Web search");
    expect(toolLabel("playwright__browser_click", "de")).toBe("Im Browser klicken");
  });

  it("turns an unknown tool or a specialist into words rather than a function name", () => {
    expect(toolLabel("kubectl_rollout_restart", "en")).toBe("Kubectl rollout restart");
    expect(agentLabel("content_writer")).toBe("Content writer");
    expect(humanizeName("webTaskCoordinator")).toBe("Web task coordinator");
  });
});

// A German request was answered under rows reading "Delegated to researcher", "web_search" and
// "Completed 3 tool calls. Latest: web_fetch.".
describe("the step stream in German", () => {
  it("titles and outcomes", () => {
    expect(stepTitle(step("delegate_to_agent", { args: { agentName: "content_writer" } }), "de")).toBe("An Content writer übergeben");
    expect(stepTitle(step("web_search", { args: { query: "Wetter Berlin" } }), "de")).toBe("Websuche");
    expect(stepTitle(step("record_plan", { args: { steps: [1, 2, 3] } }), "de")).toBe("3 Schritte geplant");
    expect(stepOutcome(step("execute_plan", { metadata: { done: 2, steps: 3, failed: 1 } }), "de")).toBe("2/3 erledigt · 1 fehlgeschlagen");
    expect(stepOutcome(step("web_search", { status: "stopped" }), "de")).toBe("kein Ergebnis gemeldet");
    expect(stepOutcome(step("delegate_to_agent", { metadata: { artifacts: [{ filename: "a" }, { filename: "b" }] } }), "de")).toBe("2 Dateien");
  });

  it("keeps the English wording English", () => {
    expect(stepTitle(step("delegate_to_agent", { args: { agentName: "researcher" } }))).toBe("Delegated to Researcher");
    expect(stepTitle(step("record_plan", { args: { steps: [1] } }))).toBe("Planned 1 step");
    expect(stepOutcome(step("execute_plan", { metadata: { done: 3, steps: 3 } }))).toBe("3/3 done");
  });

  it("shows what a named tool worked on, and nothing extra beside a worded title", () => {
    expect(stepSubject(step("web_search", { args: { query: "Wetter Berlin" } }))).toBe("Wetter Berlin");
    expect(stepSubject(step("delegate_to_agent", { args: { agentName: "researcher", task: "x" } }))).toBeUndefined();
  });

  it("a step waiting on the user", () => {
    expect(awaitingStepTitle("ask_user", "de")).toBe("Wartet auf deine Antwort");
    expect(awaitingStepHint(undefined, 0, "de")).toBe("wartet auf dich");
    expect(awaitingStepHint(undefined, 0)).toBe("waiting for you");
  });
});

describe("the live line", () => {
  it("names the tool that runs, and the plan's counts, in the turn's language", () => {
    expect(turnText.runningTool("de", "web_fetch")).toBe("Webseite lesen …");
    expect(turnText.plan("de", { running: 2, pending: 0, done: 1, partial: 0, failed: 0 })).toBe("Plan: 2 laufen · 1 erledigt");
    expect(turnText.plan("en", { running: 0, pending: 0, done: 0, partial: 0, failed: 0 })).toBeNull();
  });

  it("says what a silent specialist is doing", () => {
    expect(turnText.heartbeat("de", "composing", 4000)).toBe("schreibt … (4.000 Zeichen)");
    expect(turnText.heartbeat("en", "composing", 4000)).toBe("writing… (4,000 chars)");
    expect(turnText.heartbeat("de", "steering")).toBe("hat deine Nachricht aufgenommen");
    expect(turnText.heartbeat("en", "planning")).toBe("planning the next step…");
  });
});
