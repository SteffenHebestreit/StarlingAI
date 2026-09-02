import { registerTool } from "./registry.js";

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
          "How long to wait for the user's answer in milliseconds. Defaults to 120000 (2 minutes).",
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

    const timeoutMs =
      typeof args["timeoutMs"] === "number" && args["timeoutMs"] > 0
        ? args["timeoutMs"]
        : 120_000;

    const answer = (await context.inputCallback(question, choices?.length ? choices : undefined, timeoutMs)).trim();

    return {
      success: true,
      output: answer || NO_ANSWER_OUTPUT,
    };
  },
});
