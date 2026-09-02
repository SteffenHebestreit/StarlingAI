import { describe, expect, it } from "vitest";
import { NO_ANSWER_OUTPUT, unattendedInputCallback } from "../tools/ask-user.js";
import { getTool } from "../tools/registry.js";
import { DELEGATION_WAIT_TOOL_NAMES, STATE_DEPENDENT_TOOL_NAMES } from "../agent/turn-tool-contribution.js";

describe("ask_user — a question is not a pure function of its arguments", () => {
  it("names the no-answer condition instead of returning an empty output", async () => {
    // The gateway resolves a timed-out prompt with "".
    const result = await getTool("ask_user")!.execute({ question: "Which region?" }, { inputCallback: async () => "" } as never);
    expect(result.success).toBe(true);
    expect(result.output).toBe(NO_ANSWER_OUTPUT);
    expect(result.output.length).toBeGreaterThan(40);
  });

  it("returns the user's answer untouched when one arrives", async () => {
    const result = await getTool("ask_user")!.execute({ question: "Which region?" }, { inputCallback: async () => "Bavaria" } as never);
    expect(result.output).toBe("Bavaria");
  });

  it("answers itself when the run is unattended", async () => {
    expect((await unattendedInputCallback()).length).toBeGreaterThan(40);
  });

  it("is exempt from the identical-arguments cache and from the turn budget while it waits", () => {
    expect(STATE_DEPENDENT_TOOL_NAMES.has("ask_user")).toBe(true);
    expect(DELEGATION_WAIT_TOOL_NAMES.has("ask_user")).toBe(true);
    expect(STATE_DEPENDENT_TOOL_NAMES.has("request_human_assist")).toBe(true);
    expect(DELEGATION_WAIT_TOOL_NAMES.has("request_human_assist")).toBe(true);
  });
});
