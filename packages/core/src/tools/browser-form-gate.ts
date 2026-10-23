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

export function resetBrowserFormGateForTests(): void {
  runs.clear();
}
