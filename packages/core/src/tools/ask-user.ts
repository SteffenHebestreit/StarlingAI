import { registerTool } from "./registry.js";

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

    const answer = await context.inputCallback(question, choices?.length ? choices : undefined, timeoutMs);

    return {
      success: true,
      output: answer,
    };
  },
});
