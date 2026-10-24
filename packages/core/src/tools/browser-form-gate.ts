/**
 * A VALUE THE USER CHOSE STAYS IN ITS FIELD.
 *
 * When a form refuses a value the user gave, the browser agent's prompt says to report the refusal
 * and never to resubmit with a choice of its own (agent/delegation-user-words.ts REFUSED_CHOICE_RULE
 * says the same in the user's-words block). In the E2E runs of 2026-10-22 it still typed 1200 into
 * the quantity field as asked, submitted, read "Menge (1–999)", typed 999 into the same field and
 * submitted again, and reported the reference the page then gave (2 of 3 attempts). The prompt
 * could not hold it; this does.
 *
 * Per run, the value typed or selected into each field is kept, with whether it is the user's own
 * (it occurs in the words the user typed this turn, ToolContext.turnUserWords). A later value for
 * the same field (same snapshot ref, or the same label) is refused when the field holds the user's
 * value and the new one is not the user's. Not refused: a field the agent filled itself, the same
 * value in another format ("1.200" for "1200", compared by digits), and an alternative the user
 * named ("Express, sonst Standard"), which is the user's own too.
 *
 * A radio button is chosen by a click, which carries no value: in the E2E run of 2026-10-23 the page
 * refused Express for freight goods, and the agent clicked Standard and submitted again. Before a
 * click the page is asked what it would change (RADIO_CHOICE_FUNCTION, through browser_evaluate):
 * a click that moves a radio group off the option the user named, to one the user did not name, is
 * refused the same way.
 */
import type { TurnUserWords } from "../agent/delegation-user-words.js";

interface FieldValue {
  value: string;
  fromUser: boolean;
}

interface RunFields {
  byRef: Map<string, FieldValue>;
  byLabel: Map<string, FieldValue>;
}

/** Runs kept at once; the oldest goes first. A run's fields matter only while it is running. */
const MAX_RUNS = 200;
const runs = new Map<string, RunFields>();

const words = (text: string) => text.toLowerCase().normalize("NFKC").replace(/\s+/g, " ").trim();
const label = (element: unknown) => (typeof element === "string" ? words(element) : "");
/** The digits of a value that is a number in any format (1200, 1.200, 1 200, 1,200.00), else null. */
const numberDigits = (value: string): string | null =>
  /^[\s\d.,'’+-]+$/.test(value) && /\d/.test(value) ? value.replace(/\D/g, "").replace(/^0+(?=\d)/, "") : null;

function userText(userWords: TurnUserWords | undefined): string {
  return userWords ? [userWords.opening, ...userWords.midTurn].join("\n") : "";
}

/** Whether `value` is in the user's words: as a number in any format, else as text. */
export function valueIsUsers(value: string, userWords: TurnUserWords | undefined): boolean {
  const text = userText(userWords);
  if (!text.trim() || !value.trim()) return false;
  const digits = numberDigits(value);
  if (digits !== null) {
    const numbers = text.match(/\d[\d.,'’\s]*\d|\d/g) ?? [];
    return numbers.some((number) => number.replace(/\D/g, "").replace(/^0+(?=\d)/, "") === digits);
  }
  return words(text).includes(words(value));
}

function sameValue(a: string, b: string): boolean {
  const da = numberDigits(a);
  const db = numberDigits(b);
  return da !== null && db !== null ? da === db : words(a) === words(b);
}

function fieldsOf(runId: string): RunFields {
  let fields = runs.get(runId);
  if (!fields) {
    fields = { byRef: new Map(), byLabel: new Map() };
    runs.set(runId, fields);
    if (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value!);
  }
  return fields;
}

/**
 * Checks a value about to go into a field and records it when it may. Returns the refusal to give
 * the agent, or null to go ahead.
 */
export function checkFieldValue(input: {
  runId: string;
  ref?: unknown;
  element?: unknown;
  value: string;
  userWords: TurnUserWords | undefined;
}): string | null {
  const fields = fieldsOf(input.runId);
  const ref = typeof input.ref === "string" && input.ref.trim() ? input.ref.trim() : "";
  const name = label(input.element);
  const held = (ref ? fields.byRef.get(ref) : undefined) ?? (name ? fields.byLabel.get(name) : undefined);
  const fromUser = valueIsUsers(input.value, input.userWords);
  if (held && held.fromUser && !fromUser && !sameValue(held.value, input.value)) {
    const field = typeof input.element === "string" && input.element.trim() ? input.element.trim() : ref || "this field";
    return `Not entered: ${field} holds "${held.value}", the value the user gave, and "${input.value}" is not one the user gave. `
      + "Do not replace a value the user chose to get the form through: report what the page said about it and leave the choice to the user. "
      + "(A field you missed, or the same value in the format the page asks for, is fine.)";
  }
  const entry = { value: input.value, fromUser };
  if (ref) fields.byRef.set(ref, entry);
  if (name) fields.byLabel.set(name, entry);
  return null;
}

/**
 * Runs on a click's target in the page (browser_evaluate) before the click. For a radio button, or the
 * label of one, the names of its group's checked option and of its own: label text, the label up to
 * its first line break or parenthesis, aria-label and value. Null for anything else.
 */
export const RADIO_CHOICE_FUNCTION = `(element) => {
  const input = element instanceof HTMLInputElement ? element : (element.control || (element.querySelector && element.querySelector("input")));
  if (!input || input.type !== "radio" || !input.name) return null;
  const scope = input.form || document;
  const group = Array.from(scope.querySelectorAll("input[type=radio]")).filter((radio) => radio.name === input.name);
  const names = (radio) => {
    const text = radio.labels && radio.labels[0] ? radio.labels[0].innerText : "";
    return [text, text.split(/[\\n(]/)[0], radio.getAttribute("aria-label") || "", radio.value || ""].map((name) => name.trim()).filter(Boolean);
  };
  const checked = group.find((radio) => radio.checked);
  return { group: input.name, checked: checked ? names(checked) : [], target: names(input), targetChecked: input.checked };
}`;

export interface RadioChoice {
  group: string;
  /** Names of the option checked now; empty when none is. */
  checked: string[];
  /** Names of the option the click would check. */
  target: string[];
  targetChecked: boolean;
}

/** The RadioChoice in a browser_evaluate answer (a "### Result" section holding its JSON), or null. */
export function parseRadioChoice(answer: string): RadioChoice | null {
  const result = answer.match(/### Result\s*\n([\s\S]*?)(?:\n###|$)/)?.[1]?.trim();
  if (!result) return null;
  try {
    const value = JSON.parse(result) as Partial<RadioChoice> | null;
    if (!value || typeof value.group !== "string" || !Array.isArray(value.checked) || !Array.isArray(value.target)) return null;
    const names = (list: unknown[]) => list.filter((name): name is string => typeof name === "string");
    return { group: value.group, checked: names(value.checked), target: names(value.target), targetChecked: value.targetChecked === true };
  } catch {
    return null;
  }
}

/** An option is the user's when one of its names is in the user's words. A name under 3 characters says nothing. */
const optionIsUsers = (names: readonly string[], userWords: TurnUserWords | undefined) =>
  names.some((name) => name.trim().length >= 3 && valueIsUsers(name, userWords));

/** Checks a click by what it would change in a radio group. Returns the refusal to give the agent, or null. */
export function checkRadioClick(input: { choice: RadioChoice | null; userWords: TurnUserWords | undefined }): string | null {
  const choice = input.choice;
  if (!choice || choice.targetChecked || choice.checked.length === 0) return null;
  if (!optionIsUsers(choice.checked, input.userWords) || optionIsUsers(choice.target, input.userWords)) return null;
  return `Not clicked: "${choice.checked[0]}" is selected in ${choice.group}, the option the user chose, and "${choice.target[0]}" is not one the user chose. `
    + "Do not replace a choice the user made to get the form through: report what the page said about it and leave the choice to the user.";
}

export function resetBrowserFormGateForTests(): void {
  runs.clear();
}
