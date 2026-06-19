import { describe, expect, it } from "vitest";
import { deriveDelegationTask } from "../tools/sub-agent.js";

/**
 * Audit 027c9134 (max-effort run): mission_coordinator called delegate_to_agent with the
 * full brief under `taskTitle` + `context` but no `task`, so it hard-failed "task is
 * required" and burned a whole round on a run that was already minutes deep. deriveDelegationTask
 * now falls back to `title` / `taskTitle` so the delegation proceeds instead of dead-ending.
 */
describe("deriveDelegationTask", () => {
  it("prefers an explicit task", () => {
    expect(deriveDelegationTask({ task: "build the site", taskTitle: "ignored" })).toBe("build the site");
  });

  it("falls back to `title` when task is missing (the retry shape)", () => {
    expect(deriveDelegationTask({ title: "Create a CPSA-F learning WebApp" }))
      .toBe("Create a CPSA-F learning WebApp");
  });

  it("falls back to `taskTitle` when task and title are missing (the failing shape)", () => {
    expect(deriveDelegationTask({ taskTitle: "Content writer task: build the WebApp", context: "…long brief…" }))
      .toBe("Content writer task: build the WebApp");
  });

  it("prefers `title` over `taskTitle` when both are present and task is empty", () => {
    expect(deriveDelegationTask({ task: "  ", title: "from title", taskTitle: "from taskTitle" }))
      .toBe("from title");
  });

  it("returns empty for a genuinely instruction-less call (still rejected upstream)", () => {
    expect(deriveDelegationTask({ context: "only context, no instruction" })).toBe("");
    expect(deriveDelegationTask({})).toBe("");
  });
});
