import { registerTool } from "./registry.js";
import { userInputBroker } from "../agent/user-input-broker.js";
import { clampUserInputTimeoutMs } from "../agent/user-input.js";

/**
 * What the model reads when the wait ended without an answer. The gateway resolves a timed-out
 * prompt with "", and an empty tool output read as an answer — the model re-asked, or answered on
 * the user's behalf. Naming the condition tells it what to do instead.
 */
export const NO_ANSWER_OUTPUT =
  "No answer arrived before the wait ended. Do not ask again this turn: continue with your best assumption, "
  + "state that assumption in the reply, and tell the user how to correct it.";

/**
 * The answer an unattended run gives ask_user. Without an input channel the tool refused every
 * call, and a model in auto mode looped on the refusal; a run that has no one to ask is told so
 * and sent on with its best assumption instead.
 */
export const UNATTENDED_ANSWER =
  "This run is unattended (auto mode): no user can answer. Continue with your best assumption, "
  + "state it explicitly in the reply, and say what should be confirmed afterwards.";

export async function unattendedInputCallback(): Promise<string> {
  return UNATTENDED_ANSWER;
}

registerTool({
  name: "ask_user",
  description:
    "Ask the user a clarifying question and wait for their answer before continuing. " +
    "Optionally provide predefined choices the user can select from — the user may also type a free-text answer. " +
    "Use this when you need information from the user to complete a task.",
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The question to ask the user.",
      },
      choices: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional list of predefined answer choices. The user may pick one or type a custom answer.",
      },
      timeoutMs: {
        type: "number",
        description:
          "How long to wait for the user's answer in milliseconds. Defaults to 120000 (2 minutes); held between 10000 and 900000.",
      },
    },
    required: ["question"],
  },
  async execute(args, context) {
    if (!context.inputCallback) {
      return {
        success: false,
        output: "",
        error: "No user input channel is available in this execution context.",
      };
    }

    const question = String(args["question"] ?? "").trim();
    if (!question) {
      return { success: false, output: "", error: "question must not be empty." };
    }

    const choices = Array.isArray(args["choices"])
      ? (args["choices"] as unknown[]).map(String).filter(Boolean)
      : undefined;

    // The model picks this number. Unbounded, a slip ("wait 2 hours") parked the whole turn and a
    // tiny one expired before anyone could read the question.
    const timeoutMs = clampUserInputTimeoutMs(args["timeoutMs"]);

    // The run clocks hold while the person reads and answers (agent/user-input-broker.ts). A Stop
    // ends the hold at once: the question itself may outlive it until its own deadline, and a hold
    // left open would freeze the next turn's clocks instead (review #17).
    const endHumanWait = userInputBroker.beginHumanWait(context.sessionId);
    context.signal?.addEventListener("abort", endHumanWait, { once: true });
    let answer: string;
    try {
      answer = (await context.inputCallback(question, choices?.length ? choices : undefined, timeoutMs)).trim();
    } finally {
      context.signal?.removeEventListener("abort", endHumanWait);
      endHumanWait();
    }
    // An answer is the user's own words too, and often the one that settles what the opening
    // message left open, so specialists delegated to after it see it. The question rides along
    // because "yes" means nothing on its own — and it is the END of a question that says what "yes"
    // or "2" answers: context comes first, the actual question and its options last. An unattended
    // run's stand-in answer is not the user's.
    if (answer && answer !== UNATTENDED_ANSWER) {
      const asked = question.length > 160 ? `…${question.slice(-159)}` : question;
      context.turnUserWords?.midTurn.push(`(asked "${asked}") ${answer}`);
    }

    return {
      success: true,
      output: answer || NO_ANSWER_OUTPUT,
    };
  },
});
